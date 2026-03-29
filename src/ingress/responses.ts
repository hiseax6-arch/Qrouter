import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  buildTerminalFailure,
  parseUpstreamErrorDetails,
  type UpstreamFailureDetails,
} from '../errors/terminal-payload.js';
import {
  buildVisibleResponsesPayload,
  buildVisibleResponsesStream,
} from '../errors/visible-reply.js';
import {
  buildLocalCommandResponsesPayload,
  buildLocalCommandResponsesStream,
  detectResponsesLocalCommand,
} from './local-command.js';
import {
  buildAllowedModelCandidates,
  resolveRequestedModelAlias,
} from './model-normalization.js';
import { buildContextLimitErrorPayload, checkContextLimit } from './context-limit.js';
import type { CompiledRoute } from '../routing/routes.js';
import { resolveDirectRoute } from '../routing/routes.js';
import {
  appendResponsesQrouterMetadata,
  applyQrouterObservabilityHeaders,
} from '../observability/qrouter.js';
import { nowTraceTimestamp, type TraceStore } from '../traces/store.js';
import type { FetchUpstream } from '../upstream/client.js';
import type { RetryPolicy } from './chat-completions.js';

export type ResponsesDeps = {
  fetchUpstream: FetchUpstream;
  retryPolicy: RetryPolicy;
  traceStore: TraceStore;
  allowedModels?: Set<string>;
  routes?: CompiledRoute[];
  providers?: Record<string, import('../config/router.js').RouterProviderConfig>;
};

type ResponsesRequestBody = {
  model?: string;
  stream?: boolean;
};

type UpstreamErrorDetails = UpstreamFailureDetails;

function isStreamingRequest(body: ResponsesRequestBody): boolean {
  return body.stream === true;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
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

function classifyThrownUpstreamError(error: unknown): 'timeout' | 'connection_error' {
  if (!error || typeof error !== 'object') {
    return 'connection_error';
  }

  const record = error as { name?: string; code?: string; message?: string };
  const name = String(record.name ?? '').toLowerCase();
  const code = String(record.code ?? '').toUpperCase();
  const message = String(record.message ?? '').toLowerCase();

  if (
    name.includes('timeout') ||
    name === 'aborterror' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ABORT_ERR' ||
    message.includes('timed out') ||
    message.includes('timeout')
  ) {
    return 'timeout';
  }

  return 'connection_error';
}

async function* appendQrouterMetadataToResponsesStream(
  textStream: AsyncIterable<string>,
  buildObservability: () => Parameters<typeof appendResponsesQrouterMetadata>[1],
): AsyncIterable<string> {
  let lineBuffer = '';

  const rewriteDataLine = (data: string): string => {
    if (!data || data === '[DONE]') {
      return `data: ${data}\n\n`;
    }

    try {
      const parsed = JSON.parse(data) as {
        type?: unknown;
        response?: unknown;
      };

      if (
        parsed.type === 'response.completed'
        && parsed.response
        && typeof parsed.response === 'object'
      ) {
        return `data: ${JSON.stringify({
          ...parsed,
          response: appendResponsesQrouterMetadata(parsed.response, buildObservability()),
        })}\n\n`;
      }

      return `data: ${JSON.stringify(parsed)}\n\n`;
    } catch {
      return `data: ${data}\n\n`;
    }
  };

  for await (const chunk of textStream) {
    lineBuffer += chunk;

    while (true) {
      const newlineIndex = lineBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      const trimmed = rawLine.trim();

      if (!trimmed || !trimmed.startsWith('data:')) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      yield rewriteDataLine(data);
    }
  }

  const trailing = lineBuffer.replace(/\r$/, '').trim();
  if (trailing.startsWith('data:')) {
    const data = trailing.slice(5).trim();
    yield rewriteDataLine(data);
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
    const directRouteSelection = resolveDirectRoute(model, deps.routes ?? []);
    const stream = isStreamingRequest(body);
    const visibleResponseModel = rawRequestedModel ?? model;
    let committed = false;
    let finalClassification = 'unknown';
    let errorClass: string | null = null;
    let lastStatus: number | null = null;
    let lastUpstreamError: UpstreamErrorDetails | null = null;
    let lastProviderId: string | null = directRouteSelection?.providerId ?? null;
    let lastRouteId: string | null = directRouteSelection?.route.id ?? null;
    let lastUpstreamModel: string | null = directRouteSelection?.upstreamModel ?? model ?? null;

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

    function recordSummary(attempts: number) {
      const observability = buildObservability(attempts);
      deps.traceStore.recordSummary({
        requestId,
        endpoint: observability.endpoint,
        model,
        stream,
        attempts,
        finalClassification,
        committed,
        lastStatus,
        errorClass,
        requestedModel: observability.requestedModel,
        upstreamModel: observability.upstreamModel,
        providerId: observability.providerId,
        routeId: observability.routeId,
        failoverUsed: observability.failoverUsed,
        failoverFrom: observability.failoverFrom ?? null,
        failoverTo: observability.failoverTo ?? null,
        createdAt: nowTraceTimestamp(),
      });
    }

    function buildObservability(attempts: number, classification = finalClassification) {
      return {
        requestId,
        endpoint: 'responses' as const,
        finalClassification: classification,
        attempts,
        requestedModel: visibleResponseModel ?? null,
        upstreamModel: lastUpstreamModel,
        providerId: lastProviderId,
        routeId: lastRouteId,
        failoverUsed: false,
        failoverFrom: null,
        failoverTo: null,
      };
    }

    function returnLocalCommandReply(command: ReturnType<typeof detectResponsesLocalCommand>) {
      if (!command) {
        throw new Error('local command reply requires a detected command');
      }

      committed = true;
      finalClassification = 'local_command';
      errorClass = null;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'responses_local_command_handled', {
          attempt: 0,
          model,
          stream,
          classification: finalClassification,
          commandName: command.commandName,
          commandText: command.commandText,
        }),
      );
      recordSummary(0);
      applyQrouterObservabilityHeaders(reply, buildObservability(0, finalClassification));

      if (stream) {
        reply.header('content-type', 'text/event-stream; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.code(200).send(
          buildLocalCommandResponsesStream({
            requestId,
            model: visibleResponseModel,
            commandName: command.commandName,
            commandText: command.commandText,
          }),
        );
      }

      return reply.code(200).send(
        buildLocalCommandResponsesPayload({
          requestId,
          model: visibleResponseModel,
          commandName: command.commandName,
          commandText: command.commandText,
        }),
      );
    }

    const localCommand = detectResponsesLocalCommand((body as Record<string, unknown>).input);
    if (localCommand) {
      return returnLocalCommandReply(localCommand);
    }

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
      finalClassification = 'model_not_allowed';
      errorClass = finalClassification;
      applyQrouterObservabilityHeaders(reply, buildObservability(0));
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
      finalClassification = 'context_window_exceeded';
      errorClass = finalClassification;
      lastProviderId = contextLimitHit.providerId ?? lastProviderId;
      lastRouteId = contextLimitHit.routeId ?? lastRouteId;
      lastUpstreamModel = contextLimitHit.normalizedModel;
      applyQrouterObservabilityHeaders(reply, buildObservability(0));
      return reply.code(400).send(
        buildContextLimitErrorPayload({
          requestId,
          ...contextLimitHit,
        }),
      );
    }

    function returnVisibleFailureReply(attempt: number) {
      committed = true;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'responses_visible_failure_returned', {
          attempt,
          model,
          stream,
          classification: finalClassification,
          ...(lastStatus ? { upstreamStatus: lastStatus } : {}),
          ...(lastUpstreamError?.type ? { upstreamErrorType: lastUpstreamError.type } : {}),
        }),
      );
      recordSummary(attempt);
      applyQrouterObservabilityHeaders(reply, buildObservability(attempt));

      if (stream) {
        reply.header('content-type', 'text/event-stream; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.code(200).send(
          buildVisibleResponsesStream({
            requestId,
            attempts: attempt,
            model: visibleResponseModel,
            finalErrorClass: finalClassification,
            upstreamStatus: lastStatus,
            upstreamError: lastUpstreamError,
          }),
        );
      }

      return reply.code(200).send(
        buildVisibleResponsesPayload({
          requestId,
          attempts: attempt,
          model: visibleResponseModel,
          finalErrorClass: finalClassification,
          upstreamStatus: lastStatus,
          upstreamError: lastUpstreamError,
        }),
      );
    }

    function returnTerminalFailureReply(attempt: number) {
      committed = false;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'responses_terminal_failure_returned', {
          attempt,
          model,
          stream,
          classification: finalClassification,
          ...(lastStatus ? { upstreamStatus: lastStatus } : {}),
          ...(lastUpstreamError?.type ? { upstreamErrorType: lastUpstreamError.type } : {}),
        }),
      );
      recordSummary(attempt);
      applyQrouterObservabilityHeaders(reply, buildObservability(attempt));
      return reply.code(lastStatus ?? 502).send(
        buildTerminalFailure({
          requestId,
          attempts: attempt,
          finalErrorClass: finalClassification,
          upstreamStatus: lastStatus,
          upstreamError: lastUpstreamError,
        }),
      );
    }

    for (let attempt = 1; attempt <= deps.retryPolicy.maxAttempts; attempt += 1) {
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'responses_attempt_started', {
          attempt,
          model,
          stream,
        }),
      );

      try {
        const upstream = await deps.fetchUpstream({
          body,
          requestId,
          attempt,
        });
        lastStatus = upstream.status;
        lastUpstreamError =
          upstream.status >= 400 ? await resolveUpstreamErrorDetails(upstream) : null;
        lastProviderId = upstream.providerId ?? lastProviderId;
        lastRouteId = upstream.routeId ?? lastRouteId;

        deps.traceStore.appendEvent(
          buildTraceEvent(requestId, 'responses_upstream_response', {
            attempt,
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
          const retryable = shouldRetryStatus(upstream.status, lastUpstreamError);
          finalClassification = `http_${upstream.status}`;
          errorClass = finalClassification;
          deps.traceStore.appendEvent(
            buildTraceEvent(requestId, 'responses_upstream_error', {
              attempt,
              model,
              stream,
              status: upstream.status,
              retryable,
              ...(upstream.providerId ? { providerId: upstream.providerId } : {}),
              ...(upstream.routeId ? { routeId: upstream.routeId } : {}),
              ...(upstream.upstreamUrl ? { upstreamUrl: upstream.upstreamUrl } : {}),
              ...(lastUpstreamError?.type ? { upstreamErrorType: lastUpstreamError.type } : {}),
              ...(lastUpstreamError?.code ? { upstreamErrorCode: lastUpstreamError.code } : {}),
              ...(lastUpstreamError?.message ? { upstreamErrorMessage: lastUpstreamError.message } : {}),
              ...(lastUpstreamError?.bodySnippet ? { upstreamBodySnippet: lastUpstreamError.bodySnippet } : {}),
            }),
          );

          if (retryable && attempt < deps.retryPolicy.maxAttempts) {
            deps.traceStore.appendEvent(
              buildTraceEvent(requestId, 'responses_retry_scheduled', {
                attempt,
                model,
                stream,
                classification: finalClassification,
              }),
            );
            await sleep(deps.retryPolicy.backoffMs(attempt, finalClassification));
            continue;
          }

          if (retryable) {
            return returnVisibleFailureReply(attempt);
          }

          return returnTerminalFailureReply(attempt);
        }

        if (stream) {
          if (!upstream.textStream) {
            finalClassification = 'missing_stream_body';
            errorClass = 'missing_stream_body';
            lastUpstreamError = {
              type: 'missing_stream_body',
              message: 'Upstream stream was requested but no stream body was returned.',
            };

            if (attempt < deps.retryPolicy.maxAttempts) {
              deps.traceStore.appendEvent(
                buildTraceEvent(requestId, 'responses_retry_scheduled', {
                  attempt,
                  model,
                  stream,
                  classification: finalClassification,
                }),
              );
              await sleep(deps.retryPolicy.backoffMs(attempt, finalClassification));
              continue;
            }

            return returnVisibleFailureReply(attempt);
          }

          const downstream = new PassThrough();
          applyQrouterObservabilityHeaders(reply, buildObservability(attempt, 'semantic_success'));
          reply.header(
            'content-type',
            upstream.headers['content-type'] ?? 'text/event-stream; charset=utf-8',
          );
          reply.header('cache-control', 'no-cache');
          reply.send(downstream);

          try {
            for await (const chunk of appendQrouterMetadataToResponsesStream(
              upstream.textStream,
              () => buildObservability(attempt, 'semantic_success'),
            )) {
              downstream.write(chunk);
            }
            committed = true;
            finalClassification = 'semantic_success';
            recordSummary(attempt);
          } catch {
            committed = true;
            finalClassification = 'stream_interrupted_after_commit';
            errorClass = 'stream_interrupted_after_commit';
            recordSummary(attempt);
          } finally {
            downstream.end();
          }

          return reply;
        }

        let payload: unknown;
        try {
          payload = await upstream.json();
        } catch {
          const upstreamText = await (upstream.bodyText?.() ?? Promise.resolve('Unknown error'));
          lastUpstreamError = {
            type: 'upstream_non_json',
            message: `Upstream returned non-JSON response (status ${upstream.status})`,
            bodySnippet: upstreamText.slice(0, 200),
          };
          finalClassification = 'upstream_non_json';
          errorClass = 'upstream_non_json';

          if (attempt < deps.retryPolicy.maxAttempts) {
            deps.traceStore.appendEvent(
              buildTraceEvent(requestId, 'responses_retry_scheduled', {
                attempt,
                model,
                stream,
                classification: finalClassification,
              }),
            );
            await sleep(deps.retryPolicy.backoffMs(attempt, finalClassification));
            continue;
          }

          return returnVisibleFailureReply(attempt);
        }

        if (
          payload
          && typeof payload === 'object'
          && typeof (payload as { model?: unknown }).model === 'string'
        ) {
          lastUpstreamModel = String((payload as { model: string }).model);
        }
        finalClassification = 'semantic_success';
        errorClass = null;
        recordSummary(attempt);
        const payloadWithQrouterMetadata = appendResponsesQrouterMetadata(
          payload,
          buildObservability(attempt),
        );
        applyQrouterObservabilityHeaders(reply, buildObservability(attempt));
        return reply.code(upstream.status).send(payloadWithQrouterMetadata);
      } catch (error) {
        finalClassification = classifyThrownUpstreamError(error);
        errorClass = finalClassification;
        deps.traceStore.appendEvent(
          buildTraceEvent(requestId, 'responses_retry_scheduled', {
            attempt,
            model,
            stream,
            classification: finalClassification,
          }),
        );

        if (attempt < deps.retryPolicy.maxAttempts) {
          await sleep(deps.retryPolicy.backoffMs(attempt, finalClassification));
          continue;
        }

        return returnVisibleFailureReply(attempt);
      }
    }

    finalClassification = 'router_internal_error';
    errorClass = 'router_internal_error';
    return returnVisibleFailureReply(deps.retryPolicy.maxAttempts);
  };
}
