import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  classifyChatCompletionChunk,
  classifyChatCompletionResult,
} from '../domain/classify.js';
import {
  extractTokenUsageFromPayload,
  mergeTokenUsage,
  sumTokenUsage,
  type TokenUsage,
} from '../domain/token-usage.js';
import {
  buildEmptySuccessFailure,
  buildRetryExhaustedFailure,
  buildStreamErrorEvent,
  buildTerminalFailure,
  parseUpstreamErrorDetails,
} from '../errors/terminal-payload.js';
import {
  buildAllowedModelCandidates,
  resolveRequestedModelAlias,
} from './model-normalization.js';
import { buildContextLimitErrorPayload, checkContextLimit } from './context-limit.js';
import type { CompiledRoute } from '../routing/routes.js';
import {
  advanceStickyFailoverRoute,
  rotateRoundRobinRoute,
  selectRoundRobinRoute,
  selectStickyFailoverRoute,
} from '../routing/routes.js';
import { nowTraceTimestamp, type TraceStore } from '../traces/store.js';
import type { FetchUpstream, UpstreamResponse } from '../upstream/client.js';

export type RetryPolicy = {
  maxAttempts: number;
  backoffMs: (attempt: number, reason: string) => number;
};

export type ChatCompletionsDeps = {
  fetchUpstream: FetchUpstream;
  retryPolicy: RetryPolicy;
  traceStore: TraceStore;
  allowedModels?: Set<string>;
  routes?: CompiledRoute[];
  providers?: Record<string, import('../config/router.js').RouterProviderConfig>;
};

type ChatCompletionsRequestBody = {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
};

type StreamProbeResult =
  | {
      kind: 'semantic_success';
      bufferedChunks: string[];
      iterator: AsyncIterator<string>;
      reason: string;
    }
  | { kind: 'empty_success'; bufferedChunks: string[]; reason: 'no_semantic_payload' };

type UpstreamErrorDetails = {
  type?: string;
  code?: string;
  message?: string;
  bodySnippet?: string;
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveUpstreamErrorDetails(upstream: UpstreamResponse): Promise<UpstreamErrorDetails | null> {
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

function isStreamingRequest(body: ChatCompletionsRequestBody): boolean {
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

function buildTokenUsageFields(tokenUsage: TokenUsage | null): Record<string, number> {
  if (!tokenUsage) {
    return {};
  }

  return {
    promptTokens: tokenUsage.promptTokens,
    completionTokens: tokenUsage.completionTokens,
    totalTokens: tokenUsage.totalTokens,
  };
}

async function resolveAttemptTokenUsage(args: {
  upstream: UpstreamResponse;
  payload?: unknown;
  observedUsage?: TokenUsage | null;
}): Promise<TokenUsage | null> {
  let tokenUsage = mergeTokenUsage(
    args.observedUsage ?? null,
    args.payload === undefined ? null : extractTokenUsageFromPayload(args.payload),
  );

  if (!args.upstream.usage) {
    return tokenUsage;
  }

  try {
    return mergeTokenUsage(tokenUsage, await args.upstream.usage());
  } catch {
    return tokenUsage;
  }
}

async function probeStreamingPreCommit(
  textStream: AsyncIterable<string>,
  onUsage?: (usage: TokenUsage) => void,
): Promise<StreamProbeResult> {
  const iterator = textStream[Symbol.asyncIterator]();
  const bufferedChunks: string[] = [];
  let lineBuffer = '';

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return {
        kind: 'empty_success',
        bufferedChunks,
        reason: 'no_semantic_payload',
      };
    }

    const chunk = next.value;
    bufferedChunks.push(chunk);
    lineBuffer += chunk;

    while (true) {
      const newlineIndex = lineBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = lineBuffer.slice(0, newlineIndex);
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      const line = rawLine.trim();

      if (!line.startsWith('data:')) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        const tokenUsage = extractTokenUsageFromPayload(parsed);
        if (tokenUsage) {
          onUsage?.(tokenUsage);
        }
        const classification = classifyChatCompletionChunk(parsed);
        if (classification.kind === 'semantic_success') {
          return {
            kind: 'semantic_success',
            bufferedChunks,
            iterator,
            reason: classification.reason,
          };
        }
      } catch {
        // Ignore incomplete/non-JSON lines and keep buffering.
      }
    }
  }
}

async function forwardCommittedStream(args: {
  reply: FastifyReply;
  contentType: string;
  bufferedChunks: string[];
  iterator: AsyncIterator<string>;
  onPostCommitError: (errorClass: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  requestId: string;
  attempts: number;
}) {
  const downstream = new PassThrough();
  let lineBuffer = '';
  args.reply.header('content-type', args.contentType);
  args.reply.header('cache-control', 'no-cache');
  args.reply.send(downstream);

  for (const chunk of args.bufferedChunks) {
    downstream.write(chunk);
  }

  try {
    while (true) {
      const next = await args.iterator.next();
      if (next.done) {
        break;
      }
      lineBuffer += next.value;
      while (true) {
        const newlineIndex = lineBuffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const rawLine = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        const line = rawLine.trim();
        if (!line.startsWith('data:')) {
          continue;
        }

        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const tokenUsage = extractTokenUsageFromPayload(parsed);
          if (tokenUsage) {
            args.onUsage?.(tokenUsage);
          }
        } catch {
          // Ignore malformed chunks and keep bridging the stream.
        }
      }
      downstream.write(next.value);
    }
  } catch {
    args.onPostCommitError('stream_interrupted_after_commit');
    downstream.write(
      buildStreamErrorEvent({
        requestId: args.requestId,
        attempts: args.attempts,
        finalErrorClass: 'stream_interrupted_after_commit',
      }),
    );
  } finally {
    downstream.end();
  }
}

export function createChatCompletionsHandler(deps: ChatCompletionsDeps) {
  return async function handleChatCompletions(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const requestId = randomUUID();
    const body = (request.body ?? {}) as ChatCompletionsRequestBody;
    const rawRequestedModel = body.model ?? null;
    const requestedModel = resolveRequestedModelAlias(rawRequestedModel, deps.allowedModels);
    if (requestedModel && requestedModel !== rawRequestedModel) {
      body.model = requestedModel;
    }
    let model = requestedModel;
    let multiRoute: CompiledRoute | null = null;
    let multiRouteMemberIndex: number | null = null;

    const multiRouteSelection =
      selectRoundRobinRoute(requestedModel, deps.routes ?? [])
      ?? selectStickyFailoverRoute(requestedModel, deps.routes ?? []);
    if (multiRouteSelection) {
      multiRoute = multiRouteSelection.route;
      multiRouteMemberIndex = multiRouteSelection.memberIndex;
      body.model = multiRouteSelection.upstreamModel;
      model = multiRouteSelection.upstreamModel;
    }

    const stream = isStreamingRequest(body);

    function advanceAliasFallback(nextAttempt: number, reason: string) {
      if (!multiRoute || multiRouteMemberIndex === null || multiRoute.strategy !== 'round-robin') {
        return;
      }

      const nextSelection = rotateRoundRobinRoute(multiRoute, multiRouteMemberIndex);
      if (!nextSelection) {
        return;
      }

      const previousModel = model;
      multiRouteMemberIndex = nextSelection.memberIndex;
      model = nextSelection.upstreamModel;
      body.model = model;

      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'alias_model_rotated', {
          attempt: nextAttempt,
          requestedModel,
          routeId: multiRoute.id,
          previousModel,
          model,
          stream,
          classification: reason,
        }),
      );
    }

    function advanceStickyAliasAfterFailure(attempt: number, reason: string) {
      if (!multiRoute || multiRouteMemberIndex === null || multiRoute.strategy !== 'sticky-failover') {
        return;
      }

      const previousModel = model;
      const nextSelection = advanceStickyFailoverRoute(multiRoute, multiRouteMemberIndex);
      if (!nextSelection) {
        return;
      }

      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'alias_model_rotated', {
          attempt,
          requestedModel,
          routeId: multiRoute.id,
          previousModel,
          model: nextSelection.upstreamModel,
          stream,
          classification: reason,
        }),
      );
    }

    deps.traceStore.appendEvent(
      buildTraceEvent(requestId, 'request_received', {
        model,
        ...(rawRequestedModel && rawRequestedModel !== requestedModel ? { rawRequestedModel } : {}),
        ...(requestedModel && requestedModel !== model ? { requestedModel } : {}),
        stream,
        ...(typeof (body as Record<string, unknown>).thinking === 'string' ? { thinking: (body as Record<string, unknown>).thinking } : {}),
        ...(typeof (body as Record<string, unknown>).reasoning_effort === 'string' ? { reasoning_effort: (body as Record<string, unknown>).reasoning_effort } : {}),
        ...(((body as Record<string, unknown>).reasoning && typeof (body as Record<string, unknown>).reasoning === 'object' && typeof ((body as Record<string, unknown>).reasoning as { effort?: unknown }).effort === 'string')
          ? { reasoning_effort_object: ((body as Record<string, unknown>).reasoning as { effort: string }).effort }
          : {}),
      }),
    );

    const allowedModelsToCheck = buildAllowedModelCandidates(
      model,
      requestedModel,
      rawRequestedModel,
    );
    if (
      deps.allowedModels &&
      deps.allowedModels.size > 0 &&
      !allowedModelsToCheck.some((candidate) => deps.allowedModels?.has(candidate))
    ) {
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'request_rejected', {
          model,
          ...(rawRequestedModel && rawRequestedModel !== requestedModel ? { rawRequestedModel } : {}),
          ...(requestedModel && requestedModel !== model ? { requestedModel } : {}),
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
          endpoint: 'chat.completions',
        })
      : null;
    if (contextLimitHit) {
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'request_rejected', {
          model,
          ...(rawRequestedModel && rawRequestedModel !== requestedModel ? { rawRequestedModel } : {}),
          ...(requestedModel && requestedModel !== model ? { requestedModel } : {}),
          stream,
          classification: 'context_window_exceeded',
          estimatedInputTokens: contextLimitHit.estimatedInputTokens,
          contextWindow: contextLimitHit.contextWindow,
          ...(contextLimitHit.providerId ? { providerId: contextLimitHit.providerId } : {}),
          ...(contextLimitHit.routeId ? { routeId: contextLimitHit.routeId } : {}),
        }),
      );
      return reply.code(400).send(buildContextLimitErrorPayload({
        requestId,
        ...contextLimitHit,
      }));
    }

    let committed = false;
    let lastStatus: number | null = null;
    let finalClassification = 'unknown';
    let errorClass: string | null = null;
    let attemptsUsed = 0;
    let cumulativeTokenUsage: TokenUsage | null = null;
    let lastUpstreamError: UpstreamErrorDetails | null = null;

    function recordSummary(attempts: number) {
      deps.traceStore.recordSummary({
        requestId,
        model,
        stream,
        attempts,
        finalClassification,
        committed,
        lastStatus,
        errorClass,
        tokenUsage: cumulativeTokenUsage,
        createdAt: nowTraceTimestamp(),
      });
    }

    function appendRequestCompleted(attempt: number) {
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'request_completed', {
          attempt,
          model,
          stream,
          classification: finalClassification,
          committed,
          ...buildTokenUsageFields(cumulativeTokenUsage),
        }),
      );
    }

    for (let attempt = 1; attempt <= deps.retryPolicy.maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'attempt_started', {
          attempt,
          model,
          stream,
        }),
      );

      try {
        const upstream = await deps.fetchUpstream({ body, requestId, attempt });
        lastStatus = upstream.status;
        lastUpstreamError = upstream.status >= 400
          ? await resolveUpstreamErrorDetails(upstream)
          : null;

        deps.traceStore.appendEvent(
          buildTraceEvent(requestId, 'upstream_response', {
            attempt,
            model,
            stream,
            status: upstream.status,
            ...(upstream.providerId ? { providerId: upstream.providerId } : {}),
            ...(upstream.routeId ? { routeId: upstream.routeId } : {}),
            ...(upstream.upstreamUrl ? { upstreamUrl: upstream.upstreamUrl } : {}),
          }),
        );

        if (upstream.thinkingTrace) {
          deps.traceStore.appendEvent(
            buildTraceEvent(requestId, 'payload_rewritten', {
              attempt,
              model,
              stream,
              ...(upstream.providerId ? { providerId: upstream.providerId } : {}),
              ...(upstream.routeId ? { routeId: upstream.routeId } : {}),
              ...(upstream.upstreamUrl ? { upstreamUrl: upstream.upstreamUrl } : {}),
              ...upstream.thinkingTrace,
            }),
          );
        }

        if (lastUpstreamError) {
          deps.traceStore.appendEvent(
            buildTraceEvent(requestId, 'upstream_error', {
              attempt,
              model,
              stream,
              status: upstream.status,
              retryable: shouldRetryStatus(upstream.status, lastUpstreamError),
              ...(upstream.providerId ? { providerId: upstream.providerId } : {}),
              ...(upstream.routeId ? { routeId: upstream.routeId } : {}),
              ...(upstream.upstreamUrl ? { upstreamUrl: upstream.upstreamUrl } : {}),
              ...(lastUpstreamError.type ? { upstreamErrorType: lastUpstreamError.type } : {}),
              ...(lastUpstreamError.code ? { upstreamErrorCode: lastUpstreamError.code } : {}),
              ...(lastUpstreamError.message ? { upstreamErrorMessage: lastUpstreamError.message } : {}),
              ...(lastUpstreamError.bodySnippet ? { upstreamBodySnippet: lastUpstreamError.bodySnippet } : {}),
            }),
          );
        }

        if (upstream.status >= 200 && upstream.status < 300) {
          let attemptTokenUsage: TokenUsage | null = null;
          if (stream) {
            if (!upstream.textStream) {
              finalClassification = 'malformed_success';
              errorClass = 'malformed_success';
            } else {
              const probe = await probeStreamingPreCommit(upstream.textStream, (usage) => {
                attemptTokenUsage = mergeTokenUsage(attemptTokenUsage, usage);
              });

              if (probe.kind === 'semantic_success') {
                committed = true;
                finalClassification = 'semantic_success';
                deps.traceStore.appendEvent(
                  buildTraceEvent(requestId, 'semantic_success', {
                    attempt,
                    model,
                    stream,
                    classification: probe.reason,
                    committed: true,
                  }),
                );

                await forwardCommittedStream({
                  reply,
                  contentType:
                    upstream.headers['content-type'] ?? 'text/event-stream; charset=utf-8',
                  bufferedChunks: probe.bufferedChunks,
                  iterator: probe.iterator,
                  requestId,
                  attempts: attempt,
                  onUsage: (usage) => {
                    attemptTokenUsage = mergeTokenUsage(attemptTokenUsage, usage);
                  },
                  onPostCommitError: (postCommitErrorClass) => {
                    finalClassification = 'post_commit_interrupted';
                    errorClass = postCommitErrorClass;
                    deps.traceStore.appendEvent(
                      buildTraceEvent(requestId, 'post_commit_error', {
                        attempt,
                        model,
                        stream,
                        classification: postCommitErrorClass,
                      }),
                    );
                  },
                });

                attemptTokenUsage = await resolveAttemptTokenUsage({
                  upstream,
                  observedUsage: attemptTokenUsage,
                });
                cumulativeTokenUsage = sumTokenUsage(cumulativeTokenUsage, attemptTokenUsage);
                recordSummary(attempt);
                appendRequestCompleted(attempt);
                return reply;
              }

              attemptTokenUsage = await resolveAttemptTokenUsage({
                upstream,
                observedUsage: attemptTokenUsage,
              });
              cumulativeTokenUsage = sumTokenUsage(cumulativeTokenUsage, attemptTokenUsage);
              finalClassification = 'empty_success';
              errorClass = 'empty_success';
              deps.traceStore.appendEvent(
                buildTraceEvent(requestId, 'retry_scheduled', {
                  attempt,
                  model,
                  stream,
                  classification: 'empty_success',
                }),
              );
            }
          } else {
            // Handle non-JSON upstream responses (e.g., Cloudflare error pages, 403/502 HTML)
            let payload: unknown;
            try {
              payload = await upstream.json();
            } catch (jsonErr) {
              const upstreamText = await (upstream.bodyText?.() ?? Promise.resolve('Unknown error'));
              const errorMsg = `Upstream returned non-JSON response (status ${upstream.status}): ${upstreamText.slice(0, 500)}`;
              deps.traceStore.appendEvent(
                buildTraceEvent(requestId, 'request_failed', {
                  attempt,
                  model,
                  stream,
                  classification: 'upstream_non_json',
                }),
              );
              return reply.code(502).send(
                buildTerminalFailure({
                  requestId,
                  attempts: attempt,
                  finalErrorClass: 'upstream_non_json',
                  upstreamStatus: upstream.status,
                  upstreamError: {
                    type: 'upstream_non_json',
                    message: errorMsg,
                    bodySnippet: upstreamText.slice(0, 200),
                  },
                }),
              );
            }
            attemptTokenUsage = await resolveAttemptTokenUsage({
              upstream,
              payload,
            });
            cumulativeTokenUsage = sumTokenUsage(cumulativeTokenUsage, attemptTokenUsage);
            const classification = classifyChatCompletionResult(
              payload as Parameters<typeof classifyChatCompletionResult>[0],
            );

            if (classification.kind === 'semantic_success') {
              finalClassification = 'semantic_success';
              deps.traceStore.appendEvent(
                buildTraceEvent(requestId, 'semantic_success', {
                  attempt,
                  model,
                  stream,
                  classification: classification.reason,
                  committed: false,
                }),
              );
              recordSummary(attempt);
              appendRequestCompleted(attempt);
              return reply.code(200).send(payload);
            }

            finalClassification = 'empty_success';
            errorClass = 'empty_success';
            deps.traceStore.appendEvent(
              buildTraceEvent(requestId, 'retry_scheduled', {
                attempt,
                model,
                stream,
                classification: classification.kind,
              }),
            );
          }

          if (attempt < deps.retryPolicy.maxAttempts) {
            advanceAliasFallback(attempt + 1, finalClassification);
            await sleep(deps.retryPolicy.backoffMs(attempt, finalClassification));
            continue;
          }

          advanceStickyAliasAfterFailure(attempt, finalClassification);
          recordSummary(attempt);
          appendRequestCompleted(attempt);
          return reply.code(502).send(
            buildEmptySuccessFailure({
              requestId,
              attempts: attempt,
            }),
          );
        }

        if (shouldRetryStatus(upstream.status, lastUpstreamError)) {
          finalClassification = `http_${upstream.status}`;
          errorClass = finalClassification;
          deps.traceStore.appendEvent(
            buildTraceEvent(requestId, 'retry_scheduled', {
              attempt,
              model,
              stream,
              classification: finalClassification,
            }),
          );

          if (attempt < deps.retryPolicy.maxAttempts) {
            advanceAliasFallback(attempt + 1, finalClassification);
            await sleep(deps.retryPolicy.backoffMs(attempt, finalClassification));
            continue;
          }

          advanceStickyAliasAfterFailure(attempt, finalClassification);
          recordSummary(attempt);
          appendRequestCompleted(attempt);
          return reply.code(502).send(
            buildRetryExhaustedFailure({
              requestId,
              attempts: attempt,
              finalErrorClass: finalClassification,
              upstreamStatus: lastStatus,
              upstreamError: lastUpstreamError,
            }),
          );
        }

        finalClassification = `http_${upstream.status}`;
        errorClass = finalClassification;
        advanceStickyAliasAfterFailure(attempt, finalClassification);
        recordSummary(attempt);
        appendRequestCompleted(attempt);
        return reply.code(upstream.status).send(
          buildTerminalFailure({
            requestId,
            attempts: attempt,
            finalErrorClass: finalClassification,
            upstreamStatus: lastStatus,
            upstreamError: lastUpstreamError,
          }),
        );
      } catch (error) {
        finalClassification = classifyThrownUpstreamError(error);
        errorClass = finalClassification;
        deps.traceStore.appendEvent(
          buildTraceEvent(requestId, 'retry_scheduled', {
            attempt,
            model,
            stream,
            classification: finalClassification,
          }),
        );

        if (attempt < deps.retryPolicy.maxAttempts) {
          advanceAliasFallback(attempt + 1, finalClassification);
          await sleep(deps.retryPolicy.backoffMs(attempt, finalClassification));
          continue;
        }

        advanceStickyAliasAfterFailure(attempt, finalClassification);
        recordSummary(attempt);
        appendRequestCompleted(attempt);
        return reply.code(502).send(
          buildRetryExhaustedFailure({
            requestId,
            attempts: attempt,
            finalErrorClass: finalClassification,
            upstreamStatus: lastStatus,
            upstreamError: lastUpstreamError,
          }),
        );
      }
    }

    recordSummary(attemptsUsed);
    appendRequestCompleted(attemptsUsed);
    return reply.code(500).send({
      error: {
        message: 'Router exhausted control flow unexpectedly.',
        type: 'router_internal_error',
        request_id: requestId,
        attempts: attemptsUsed,
        final_error_class: finalClassification,
      },
    });
  };
}
