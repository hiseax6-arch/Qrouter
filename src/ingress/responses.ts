import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  buildRetryExhaustedFailure,
  buildTerminalFailure,
  parseUpstreamErrorDetails,
} from '../errors/terminal-payload.js';
import {
  buildAllowedModelCandidates,
  resolveRequestedModelAlias,
} from './model-normalization.js';
import { buildContextLimitErrorPayload, checkContextLimit } from './context-limit.js';
import type { CompiledRoute } from '../routing/routes.js';
import { nowTraceTimestamp, type TraceStore } from '../traces/store.js';
import type { FetchUpstream } from '../upstream/client.js';

export type ResponsesDeps = {
  fetchUpstream: FetchUpstream;
  traceStore: TraceStore;
  allowedModels?: Set<string>;
  routes?: CompiledRoute[];
  providers?: Record<string, import('../config/router.js').RouterProviderConfig>;
};

type ResponsesRequestBody = {
  model?: string;
  stream?: boolean;
};

type UpstreamErrorDetails = {
  type?: string;
  code?: string;
  message?: string;
  bodySnippet?: string;
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

async function resolveUpstreamErrorDetails(
  upstream: Awaited<ReturnType<FetchUpstream>>,
): Promise<UpstreamErrorDetails | null> {
  if (!upstream.bodyText) {
    return null;
  }

  try {
    return parseUpstreamErrorDetails(await upstream.bodyText());
  } catch {
    return null;
  }
}

function shouldRetryStatus(status: number, errorDetails: UpstreamErrorDetails | null): boolean {
  if (status === 429 || status >= 500) {
    return true;
  }

  if (status !== 403 || !errorDetails) {
    return false;
  }

  const retrySignals = [
    errorDetails.type,
    errorDetails.code,
    errorDetails.message,
    errorDetails.bodySnippet,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.toLowerCase());

  return retrySignals.some((value) =>
    value.includes('usage_limit_reached') ||
    value.includes('usage limit has been reached') ||
    value.includes('rate_limit') ||
    value.includes('rate limit') ||
    value.includes('temporarily unavailable') ||
    value.includes('temporarily_unavailable') ||
    value.includes('auth_unavailable') ||
    value.includes('quota'),
  );
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
        ...(typeof (body as Record<string, unknown>).thinking === 'string'
          ? { thinking: (body as Record<string, unknown>).thinking }
          : {}),
        ...(typeof (body as Record<string, unknown>).reasoning_effort === 'string'
          ? { reasoning_effort: (body as Record<string, unknown>).reasoning_effort }
          : {}),
      }),
    );

    if (
      deps.allowedModels &&
      deps.allowedModels.size > 0 &&
      !buildAllowedModelCandidates(model, rawRequestedModel).some((candidate) =>
        deps.allowedModels?.has(candidate),
      )
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

    const contextLimitHit = deps.providers
      ? checkContextLimit({
          body: body as Record<string, unknown>,
          providers: deps.providers,
          routes: deps.routes,
          endpoint: 'responses',
        })
      : null;
    if (contextLimitHit) {
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'responses_request_rejected', {
          model,
          ...(rawRequestedModel && rawRequestedModel !== model ? { rawRequestedModel } : {}),
          stream,
          classification: 'context_window_exceeded',
          estimatedInputTokens: contextLimitHit.estimatedInputTokens,
          contextWindow: contextLimitHit.contextWindow,
          ...(contextLimitHit.providerId ? { providerId: contextLimitHit.providerId } : {}),
          ...(contextLimitHit.routeId ? { routeId: contextLimitHit.routeId } : {}),
        }),
      );
      return reply.code(400).send(
        buildContextLimitErrorPayload({
          requestId,
          ...contextLimitHit,
        }),
      );
    }

    const upstream = await deps.fetchUpstream({
      body,
      requestId,
      attempt: 1,
    });
    const upstreamError =
      upstream.status >= 400 ? await resolveUpstreamErrorDetails(upstream) : null;

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
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'responses_upstream_error', {
          model,
          stream,
          status: upstream.status,
          retryable: shouldRetryStatus(upstream.status, upstreamError),
          ...(upstream.providerId ? { providerId: upstream.providerId } : {}),
          ...(upstream.routeId ? { routeId: upstream.routeId } : {}),
          ...(upstream.upstreamUrl ? { upstreamUrl: upstream.upstreamUrl } : {}),
          ...(upstreamError?.type ? { upstreamErrorType: upstreamError.type } : {}),
          ...(upstreamError?.code ? { upstreamErrorCode: upstreamError.code } : {}),
          ...(upstreamError?.message ? { upstreamErrorMessage: upstreamError.message } : {}),
          ...(upstreamError?.bodySnippet ? { upstreamBodySnippet: upstreamError.bodySnippet } : {}),
        }),
      );
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

      if (shouldRetryStatus(upstream.status, upstreamError)) {
        return reply.code(502).send(
          buildRetryExhaustedFailure({
            requestId,
            attempts: 1,
            finalErrorClass: `http_${upstream.status}`,
            upstreamStatus: upstream.status,
            upstreamError,
          }),
        );
      }

      return reply.code(upstream.status).send(
        buildTerminalFailure({
          requestId,
          attempts: 1,
          finalErrorClass: `http_${upstream.status}`,
          upstreamStatus: upstream.status,
          upstreamError,
        }),
      );
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
      reply.header(
        'content-type',
        upstream.headers['content-type'] ?? 'text/event-stream; charset=utf-8',
      );
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

    // Handle non-JSON upstream responses (e.g., Cloudflare error pages, 403/502 HTML)
    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch (jsonErr) {
      const upstreamText = await (upstream.bodyText?.() ?? Promise.resolve('Unknown error'));
      const errorMsg = `Upstream returned non-JSON response (status ${upstream.status}): ${upstreamText.slice(0, 500)}`;
      deps.traceStore.appendEvent({
        timestamp: new Date().toISOString(),
        requestId,
        event: 'request_failed',
        model,
        stream,
        classification: 'upstream_non_json',
      });
      return reply.code(502).send({
        error: {
          message: errorMsg,
          type: 'upstream_non_json',
          status: upstream.status,
        },
      });
    }
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
