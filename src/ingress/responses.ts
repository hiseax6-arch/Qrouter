import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  buildAllowedModelCandidates,
  resolveRequestedModelAlias,
} from './model-normalization.js';
import type { CompiledRoute } from '../routing/routes.js';
import { nowTraceTimestamp, type TraceStore } from '../traces/store.js';
import type { FetchUpstream } from '../upstream/client.js';

export type ResponsesDeps = {
  fetchUpstream: FetchUpstream;
  traceStore: TraceStore;
  allowedModels?: Set<string>;
  routes?: CompiledRoute[];
};

type ResponsesRequestBody = {
  model?: string;
  stream?: boolean;
};

function isStreamingRequest(body: ResponsesRequestBody): boolean {
  return body.stream === true;
}

function buildTraceEvent(requestId: string, event: string, data: Record<string, unknown>) {
  return {
    timestamp: nowTraceTimestamp(),
    requestId,
    event,
    ...data,
  };
}

async function readUpstreamErrorPayload(upstream: Awaited<ReturnType<FetchUpstream>>): Promise<unknown> {
  try {
    return await upstream.json();
  } catch {
    if (upstream.bodyText) {
      try {
        const bodyText = await upstream.bodyText();
        return {
          error: {
            message: bodyText || 'Upstream returned a non-JSON error body.',
            type: 'upstream_error',
          },
        };
      } catch {
        // ignore
      }
    }

    return {
      error: {
        message: 'Upstream request failed.',
        type: 'upstream_error',
      },
    };
  }
}

export function createResponsesHandler(deps: ResponsesDeps) {
  return async function handleResponses(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const requestId = randomUUID();
    const body = (request.body ?? {}) as ResponsesRequestBody;
    const rawRequestedModel = body.model ?? null;
    const model = resolveRequestedModelAlias(rawRequestedModel, deps.allowedModels);
    if (model && model !== rawRequestedModel) {
      body.model = model;
    }
    const stream = isStreamingRequest(body);

    deps.traceStore.appendEvent(
      buildTraceEvent(requestId, 'responses_request_received', {
        model,
        ...(rawRequestedModel && rawRequestedModel !== model ? { rawRequestedModel } : {}),
        stream,
        ...(typeof (body as Record<string, unknown>).thinking === 'string' ? { thinking: (body as Record<string, unknown>).thinking } : {}),
        ...(typeof (body as Record<string, unknown>).reasoning_effort === 'string' ? { reasoning_effort: (body as Record<string, unknown>).reasoning_effort } : {}),
      }),
    );

    if (
      deps.allowedModels &&
      deps.allowedModels.size > 0 &&
      !buildAllowedModelCandidates(model, rawRequestedModel).some((candidate) => deps.allowedModels?.has(candidate))
    ) {
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'responses_request_rejected', {
          model,
          ...(rawRequestedModel && rawRequestedModel !== model ? { rawRequestedModel } : {}),
          stream,
          classification: 'model_not_allowed',
        }),
      );
      return reply.code(400).send({
        error: {
          type: 'model_not_allowed',
          message: 'Model is not configured in Q-router.',
          model,
        },
      });
    }

    const upstream = await deps.fetchUpstream({
      body,
      requestId,
      attempt: 1,
    });

    deps.traceStore.appendEvent(
      buildTraceEvent(requestId, 'responses_upstream_response', {
        model,
        stream,
        status: upstream.status,
        ...(upstream.providerId ? { providerId: upstream.providerId } : {}),
        ...(upstream.routeId ? { routeId: upstream.routeId } : {}),
        ...(upstream.upstreamUrl ? { upstreamUrl: upstream.upstreamUrl } : {}),
        ...(upstream.thinkingTrace ?? {}),
      }),
    );

    if (upstream.status < 200 || upstream.status >= 300) {
      const errorPayload = await readUpstreamErrorPayload(upstream);
      deps.traceStore.recordSummary({
        requestId,
        model,
        stream,
        attempts: 1,
        finalClassification: `http_${upstream.status}`,
        committed: false,
        lastStatus: upstream.status,
        errorClass: `http_${upstream.status}`,
        createdAt: nowTraceTimestamp(),
      });
      return reply.code(upstream.status).send(errorPayload);
    }

    if (stream) {
      if (!upstream.textStream) {
        deps.traceStore.recordSummary({
          requestId,
          model,
          stream,
          attempts: 1,
          finalClassification: 'missing_stream_body',
          committed: false,
          lastStatus: upstream.status,
          errorClass: 'missing_stream_body',
          createdAt: nowTraceTimestamp(),
        });
        return reply.code(502).send({
          error: {
            message: 'Upstream stream was requested but no stream body was returned.',
            type: 'missing_stream_body',
            request_id: requestId,
          },
        });
      }

      const downstream = new PassThrough();
      reply.header('content-type', upstream.headers['content-type'] ?? 'text/event-stream; charset=utf-8');
      reply.header('cache-control', 'no-cache');
      reply.send(downstream);

      try {
        for await (const chunk of upstream.textStream) {
          downstream.write(chunk);
        }
        deps.traceStore.recordSummary({
          requestId,
          model,
          stream,
          attempts: 1,
          finalClassification: 'semantic_success',
          committed: true,
          lastStatus: upstream.status,
          errorClass: null,
          createdAt: nowTraceTimestamp(),
        });
      } catch {
        deps.traceStore.recordSummary({
          requestId,
          model,
          stream,
          attempts: 1,
          finalClassification: 'stream_interrupted_after_commit',
          committed: true,
          lastStatus: upstream.status,
          errorClass: 'stream_interrupted_after_commit',
          createdAt: nowTraceTimestamp(),
        });
      } finally {
        downstream.end();
      }

      return reply;
    }

    const payload = await upstream.json();
    deps.traceStore.recordSummary({
      requestId,
      model,
      stream,
      attempts: 1,
      finalClassification: 'semantic_success',
      committed: false,
      lastStatus: upstream.status,
      errorClass: null,
      createdAt: nowTraceTimestamp(),
    });
    return reply.code(upstream.status).send(payload);
  };
}
