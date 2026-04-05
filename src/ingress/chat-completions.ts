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
  buildTerminalFailure,
  buildStreamErrorEvent,
  parseUpstreamErrorDetails,
  type UpstreamFailureDetails,
} from '../errors/terminal-payload.js';
import {
  buildVisibleChatCompletion,
  buildVisibleChatCompletionStream,
} from '../errors/visible-reply.js';
import {
  buildLocalCommandChatCompletion,
  buildLocalCommandChatCompletionStream,
  detectChatLocalCommand,
} from './local-command.js';
import {
  appendFailoverNoticeToChatPayload,
  buildFailoverNotice,
  buildFailoverNoticeChatStreamChunk,
  messagesContainFailoverNotice,
} from './failover-notice.js';
import {
  buildAllowedModelCandidates,
  resolveRequestedModelAlias,
} from './model-normalization.js';
import { buildContextLimitErrorPayload, checkContextLimit } from './context-limit.js';
import type { CompiledRoute } from '../routing/routes.js';
import {
  resolveDirectRoute,
  selectRoundRobinRoute,
  selectStickyFailoverRoute,
  setStickyFailoverRouteMember,
} from '../routing/routes.js';
import { applyQrouterObservabilityHeaders } from '../observability/qrouter.js';
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
  qrouter?: {
    noFallback?: boolean;
    strictPrimary?: boolean;
  };
};

type StreamProbeResult =
  | {
      kind: 'semantic_success';
      bufferedChunks: string[];
      iterator: AsyncIterator<string>;
      reason: string;
    }
  | { kind: 'empty_success'; bufferedChunks: string[]; reason: 'no_semantic_payload' };

type UpstreamErrorDetails = UpstreamFailureDetails;

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

function shouldAdvanceTerminalCandidate(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function isStreamingRequest(body: ChatCompletionsRequestBody): boolean {
  return body.stream === true;
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return undefined;
}

function extractRequestRoutingControls(
  request: FastifyRequest,
  body: Record<string, unknown>,
): { disableFallback: boolean } {
  const qrouter = body.qrouter && typeof body.qrouter === 'object'
    ? body.qrouter as Record<string, unknown>
    : null;
  const headerNoFallback = request.headers['x-qrouter-no-fallback'];
  const headerStrictPrimary = request.headers['x-qrouter-strict-primary'];

  delete body.qrouter;

  const disableFallback =
    parseBooleanFlag(qrouter?.noFallback)
    ?? parseBooleanFlag(qrouter?.strictPrimary)
    ?? parseBooleanFlag(Array.isArray(headerNoFallback) ? headerNoFallback[0] : headerNoFallback)
    ?? parseBooleanFlag(Array.isArray(headerStrictPrimary) ? headerStrictPrimary[0] : headerStrictPrimary)
    ?? false;

  return { disableFallback };
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
  trailingNotice?: string | null;
  fallbackModel?: string | null;
  onTrailingNoticeAppended?: () => void;
}) {
  const downstream = new PassThrough();
  let lineBuffer = '';
  let trailingNoticeAppended = false;
  let responseId: string | null = null;
  let responseModel: string | null = args.fallbackModel ?? null;
  let responseCreated: number | null = null;
  args.reply.header('content-type', args.contentType);
  args.reply.header('cache-control', 'no-cache');
  args.reply.send(downstream);

  const emitTrailingNotice = () => {
    if (trailingNoticeAppended || !args.trailingNotice) {
      return;
    }

    downstream.write(
      buildFailoverNoticeChatStreamChunk({
        requestId: args.requestId,
        responseId,
        model: responseModel,
        created: responseCreated,
        notice: args.trailingNotice,
      }),
    );
    trailingNoticeAppended = true;
    args.onTrailingNoticeAppended?.();
  };

  const consumeChunk = (chunk: string, trackUsage: boolean) => {
    lineBuffer += chunk;

    while (true) {
      const newlineIndex = lineBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      const line = rawLine.trim();

      if (!line.startsWith('data:')) {
        downstream.write(`${rawLine}\n`);
        continue;
      }

      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        emitTrailingNotice();
        downstream.write(`${rawLine}\n`);
        continue;
      }

      if (!data) {
        downstream.write(`${rawLine}\n`);
        continue;
      }

      try {
        const parsed = JSON.parse(data) as {
          id?: unknown;
          model?: unknown;
          created?: unknown;
          choices?: Array<{ finish_reason?: unknown }>;
        };
        if (typeof parsed.id === 'string' && parsed.id.length > 0) {
          responseId = parsed.id;
        }
        if (typeof parsed.model === 'string' && parsed.model.length > 0) {
          responseModel = parsed.model;
        }
        if (typeof parsed.created === 'number' && Number.isFinite(parsed.created)) {
          responseCreated = parsed.created;
        }

        const tokenUsage = trackUsage ? extractTokenUsageFromPayload(parsed) : null;
        if (tokenUsage) {
          args.onUsage?.(tokenUsage);
        }

        const hasFinishReason = Array.isArray(parsed.choices)
          && parsed.choices.some((choice) => Boolean(choice?.finish_reason));
        if (hasFinishReason) {
          emitTrailingNotice();
        }
      } catch {
        // Preserve malformed data frames without rewriting them.
      }

      downstream.write(`${rawLine}\n`);
    }
  };

  for (const chunk of args.bufferedChunks) {
    consumeChunk(chunk, false);
  }

  try {
    while (true) {
      const next = await args.iterator.next();
      if (next.done) {
        break;
      }
      consumeChunk(next.value, true);
    }
    if (lineBuffer.length > 0) {
      downstream.write(lineBuffer);
      lineBuffer = '';
    }
    emitTrailingNotice();
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
    const requestRoutingControls = extractRequestRoutingControls(request, body as Record<string, unknown>);
    const historyAlreadyContainsFailoverNotice = messagesContainFailoverNotice(body.messages);
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
    let directRouteSelection = multiRoute
      ? null
      : resolveDirectRoute(requestedModel, deps.routes ?? []);
    const primaryRoute = multiRoute ?? directRouteSelection?.route ?? null;
    let fallbackActivated = false;
    let failoverNoticeActivated = false;
    const fallbackAliases = [...(primaryRoute?.fallbackAliases ?? [])];
    let fallbackAliasCursor = 0;
    let fallbackChainExhausted = false;

    const stream = isStreamingRequest(body);
    let committed = false;
    let lastStatus: number | null = null;
    let finalClassification = 'unknown';
    let errorClass: string | null = null;
    let attemptsUsed = 0;
    let candidateAttempt = 0;
    let cumulativeTokenUsage: TokenUsage | null = null;
    let lastUpstreamError: UpstreamErrorDetails | null = null;
    const visibleResponseModel = rawRequestedModel ?? requestedModel ?? model;
    let lastProviderId: string | null = multiRoute?.providerId
      ?? directRouteSelection?.providerId
      ?? null;
    let lastRouteId: string | null = multiRoute?.id
      ?? directRouteSelection?.route.id
      ?? null;
    let lastUpstreamModel: string | null = directRouteSelection?.upstreamModel
      ?? (typeof model === 'string' && model.length > 0 ? model : null);
    let currentMultiRouteTriedMembers = new Set<number>();

    function applyRouteTarget(alias: string | null): boolean {
      if (typeof alias !== 'string' || alias.length === 0) {
        return false;
      }

      const nextMultiRouteSelection =
        selectRoundRobinRoute(alias, deps.routes ?? [])
        ?? selectStickyFailoverRoute(alias, deps.routes ?? []);
      if (nextMultiRouteSelection) {
        multiRoute = nextMultiRouteSelection.route;
        multiRouteMemberIndex = nextMultiRouteSelection.memberIndex;
        directRouteSelection = null;
        model = nextMultiRouteSelection.upstreamModel;
        body.model = model;
        lastProviderId = nextMultiRouteSelection.providerId;
        lastRouteId = nextMultiRouteSelection.route.id;
        lastUpstreamModel = model;
        return true;
      }

      const nextDirectRouteSelection = resolveDirectRoute(alias, deps.routes ?? []);
      if (!nextDirectRouteSelection) {
        return false;
      }

      multiRoute = null;
      multiRouteMemberIndex = null;
      directRouteSelection = nextDirectRouteSelection;
      model = nextDirectRouteSelection.upstreamModel;
      body.model = model;
      lastProviderId = nextDirectRouteSelection.providerId;
      lastRouteId = nextDirectRouteSelection.route.id;
      lastUpstreamModel = nextDirectRouteSelection.upstreamModel;
      return true;
    }

    function resetCurrentRouteMemberTracking() {
      currentMultiRouteTriedMembers = new Set<number>();
      if (multiRouteMemberIndex !== null) {
        currentMultiRouteTriedMembers.add(multiRouteMemberIndex);
      }
    }

    function advanceCurrentMultiRouteMember(nextAttempt: number, reason: string): boolean {
      if (!multiRoute || multiRouteMemberIndex === null || !multiRoute.members || multiRoute.members.length === 0) {
        return false;
      }

      let nextMemberIndex: number | null = null;
      for (let offset = 1; offset < multiRoute.members.length; offset += 1) {
        const candidateIndex = (multiRouteMemberIndex + offset) % multiRoute.members.length;
        if (!currentMultiRouteTriedMembers.has(candidateIndex)) {
          nextMemberIndex = candidateIndex;
          break;
        }
      }

      if (nextMemberIndex === null) {
        return false;
      }

      const previousModel = model;
      multiRouteMemberIndex = nextMemberIndex;
      model = multiRoute.members[nextMemberIndex];
      body.model = model;
      lastProviderId = multiRoute.providerId;
      lastRouteId = multiRoute.id;
      lastUpstreamModel = model;
      currentMultiRouteTriedMembers.add(nextMemberIndex);
      if (multiRoute.strategy === 'sticky-failover') {
        setStickyFailoverRouteMember(multiRoute, nextMemberIndex);
      }

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
      failoverNoticeActivated = true;
      return true;
    }

    function maybeActivateFallbackForNextAttempt(nextAttempt: number, reason: string): boolean {
      if (candidateAttempt < deps.retryPolicy.maxAttempts) {
        return false;
      }

      if (requestRoutingControls.disableFallback) {
        deps.traceStore.appendEvent(
          buildTraceEvent(requestId, 'fallback_skipped_by_policy', {
            attempt: nextAttempt - 1,
            requestedModel,
            routeId: primaryRoute?.id,
            model,
            stream,
          }),
        );
        return false;
      }

      if (advanceCurrentMultiRouteMember(nextAttempt, reason)) {
        candidateAttempt = 0;
        return true;
      }

      while (fallbackAliasCursor < fallbackAliases.length) {
        const fallbackAlias = fallbackAliases[fallbackAliasCursor++];
        const previousModel = model;
        if (!applyRouteTarget(fallbackAlias)) {
          continue;
        }

        fallbackActivated = true;
        failoverNoticeActivated = true;
        candidateAttempt = 0;
        resetCurrentRouteMemberTracking();
        deps.traceStore.appendEvent(
          buildTraceEvent(requestId, 'fallback_route_activated', {
            attempt: nextAttempt,
            requestedModel,
            routeId: primaryRoute?.id,
            fallbackAlias,
            previousModel,
            model,
            stream,
            classification: reason,
          }),
        );
        return true;
      }

      fallbackChainExhausted = true;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'fallback_chain_exhausted', {
          attempt: nextAttempt - 1,
          requestedModel,
          routeId: primaryRoute?.id,
          model,
          stream,
          classification: reason,
        }),
      );
      return false;
    }

    function maybeAdvanceTerminalCandidate(nextAttempt: number, reason: string): boolean {
      if (requestRoutingControls.disableFallback) {
        return false;
      }

      if (advanceCurrentMultiRouteMember(nextAttempt, reason)) {
        candidateAttempt = 0;
        return true;
      }

      while (fallbackAliasCursor < fallbackAliases.length) {
        const fallbackAlias = fallbackAliases[fallbackAliasCursor++];
        const previousModel = model;
        if (!applyRouteTarget(fallbackAlias)) {
          continue;
        }

        fallbackActivated = true;
        failoverNoticeActivated = true;
        candidateAttempt = 0;
        resetCurrentRouteMemberTracking();
        deps.traceStore.appendEvent(
          buildTraceEvent(requestId, 'fallback_route_activated', {
            attempt: nextAttempt,
            requestedModel,
            routeId: primaryRoute?.id,
            fallbackAlias,
            previousModel,
            model,
            stream,
            classification: reason,
          }),
        );
        return true;
      }

      fallbackChainExhausted = true;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'fallback_chain_exhausted', {
          attempt: nextAttempt - 1,
          requestedModel,
          routeId: primaryRoute?.id,
          model,
          stream,
          classification: reason,
        }),
      );
      return false;
    }

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
        failoverFrom: observability.failoverFrom,
        failoverTo: observability.failoverTo,
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

    function returnLocalCommandReply(command: ReturnType<typeof detectChatLocalCommand>) {
      if (!command) {
        throw new Error('local command reply requires a detected command');
      }

      committed = true;
      finalClassification = 'local_command';
      errorClass = null;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'local_command_handled', {
          attempt: 0,
          model,
          stream,
          classification: finalClassification,
          commandName: command.commandName,
          commandText: command.commandText,
        }),
      );
      recordSummary(0);
      appendRequestCompleted(0);
      applyQrouterObservabilityHeaders(reply, buildObservability(0, finalClassification));

      if (stream) {
        reply.header('content-type', 'text/event-stream; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.code(200).send(
          buildLocalCommandChatCompletionStream({
            requestId,
            model: visibleResponseModel,
            commandName: command.commandName,
            commandText: command.commandText,
          }),
        );
      }

      return reply.code(200).send(
        buildLocalCommandChatCompletion({
          requestId,
          model: visibleResponseModel,
          commandName: command.commandName,
          commandText: command.commandText,
        }),
      );
    }

    function resolveFailoverNotice() {
      if (
        typeof model !== 'string'
        || model.length === 0
      ) {
        return null;
      }

      if (!failoverNoticeActivated || historyAlreadyContainsFailoverNotice) {
        return null;
      }

      return buildFailoverNotice({
        requestedModel: visibleResponseModel,
        activeModel: model,
      });
    }

    function resolveFailoverState() {
      if (
        fallbackActivated
      ) {
        return {
          used: true,
          from: primaryRoute?.strategy === 'direct'
            ? primaryRoute.upstreamModel ?? null
            : primaryRoute?.members?.[0] ?? null,
          to: lastUpstreamModel ?? (typeof model === 'string' ? model : null),
        };
      }

      if (
        !multiRoute
        || multiRoute.strategy !== 'sticky-failover'
        || multiRouteMemberIndex === null
        || multiRouteMemberIndex <= 0
      ) {
        return {
          used: false,
          from: null,
          to: null,
        };
      }

      return {
        used: true,
        from: multiRoute.members?.[0] ?? null,
        to: lastUpstreamModel ?? (typeof model === 'string' ? model : null),
      };
    }

    function buildObservability(attempts: number, classification = finalClassification) {
      const failover = resolveFailoverState();
      return {
        requestId,
        endpoint: 'chat.completions' as const,
        finalClassification: classification,
        attempts,
        requestedModel: visibleResponseModel ?? null,
        upstreamModel: lastUpstreamModel,
        providerId: lastProviderId,
        routeId: lastRouteId,
        failoverUsed: failover.used,
        failoverFrom: failover.from,
        failoverTo: failover.to,
      };
    }

    resetCurrentRouteMemberTracking();

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

    const localCommand = detectChatLocalCommand(body.messages);
    if (localCommand) {
      return returnLocalCommandReply(localCommand);
    }

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
      finalClassification = 'context_window_exceeded';
      errorClass = finalClassification;
      lastProviderId = contextLimitHit.providerId ?? lastProviderId;
      lastRouteId = contextLimitHit.routeId ?? lastRouteId;
      lastUpstreamModel = contextLimitHit.normalizedModel;
      applyQrouterObservabilityHeaders(reply, buildObservability(0));
      return reply.code(400).send(buildContextLimitErrorPayload({
        requestId,
        ...contextLimitHit,
      }));
    }

    function returnVisibleFailureReply(attempt: number) {
      committed = true;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'visible_failure_returned', {
          attempt,
          model,
          stream,
          classification: finalClassification,
          ...(lastStatus ? { upstreamStatus: lastStatus } : {}),
          ...(lastUpstreamError?.type ? { upstreamErrorType: lastUpstreamError.type } : {}),
        }),
      );
      recordSummary(attempt);
      appendRequestCompleted(attempt);
      applyQrouterObservabilityHeaders(reply, buildObservability(attempt));

      if (stream) {
        reply.header('content-type', 'text/event-stream; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.code(200).send(
          buildVisibleChatCompletionStream({
            requestId,
            attempts: attempt,
            model: visibleResponseModel,
            finalErrorClass: finalClassification,
            upstreamStatus: lastStatus,
            upstreamError: lastUpstreamError,
            fallbackChainExhausted,
          }),
        );
      }

      return reply.code(200).send(
        buildVisibleChatCompletion({
          requestId,
          attempts: attempt,
          model: visibleResponseModel,
          finalErrorClass: finalClassification,
          upstreamStatus: lastStatus,
          upstreamError: lastUpstreamError,
          fallbackChainExhausted,
        }),
      );
    }

    function returnTerminalFailureReply(attempt: number) {
      if (lastStatus === 401) {
        return returnVisibleFailureReply(attempt);
      }
      committed = false;
      deps.traceStore.appendEvent(
        buildTraceEvent(requestId, 'terminal_failure_returned', {
          attempt,
          model,
          stream,
          classification: finalClassification,
          ...(lastStatus ? { upstreamStatus: lastStatus } : {}),
          ...(lastUpstreamError?.type ? { upstreamErrorType: lastUpstreamError.type } : {}),
        }),
      );
      recordSummary(attempt);
      appendRequestCompleted(attempt);
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

    while (true) {
      const attempt = attemptsUsed + 1;
      attemptsUsed = attempt;
      candidateAttempt += 1;
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
        lastProviderId = multiRoute?.providerId ?? upstream.providerId ?? lastProviderId;
        lastRouteId = multiRoute?.id ?? upstream.routeId ?? lastRouteId;
        lastUpstreamModel = multiRoute
          ? (typeof model === 'string' && model.length > 0 ? model : lastUpstreamModel)
          : (directRouteSelection?.upstreamModel ?? lastUpstreamModel);

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
                applyQrouterObservabilityHeaders(reply, buildObservability(attempt));

                await forwardCommittedStream({
                  reply,
                  contentType:
                    upstream.headers['content-type'] ?? 'text/event-stream; charset=utf-8',
                  bufferedChunks: probe.bufferedChunks,
                  iterator: probe.iterator,
                  requestId,
                  attempts: attempt,
                  trailingNotice: resolveFailoverNotice(),
                  fallbackModel: model,
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
                  onTrailingNoticeAppended: () => {
                    deps.traceStore.appendEvent(
                      buildTraceEvent(requestId, 'candidate_failover_notice_appended', {
                        attempt,
                        model,
                        stream,
                        routeId: multiRoute?.id,
                        requestedModel: visibleResponseModel,
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
            } catch {
              const upstreamText = await (upstream.bodyText?.() ?? Promise.resolve('Unknown error'));
              lastUpstreamError = {
                type: 'upstream_non_json',
                message: `Upstream returned non-JSON response (status ${upstream.status})`,
                bodySnippet: upstreamText.slice(0, 400),
              };
              finalClassification = 'upstream_non_json';
              errorClass = 'upstream_non_json';
              deps.traceStore.appendEvent(
                buildTraceEvent(requestId, 'retry_scheduled', {
                  attempt,
                  model,
                  stream,
                  classification: 'upstream_non_json',
                }),
              );

              if (candidateAttempt < deps.retryPolicy.maxAttempts) {
                await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
                continue;
              }

              if (maybeActivateFallbackForNextAttempt(attempt + 1, finalClassification)) {
                await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
                continue;
              }

              return returnVisibleFailureReply(attempt);
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
              const payloadWithFailoverNotice = appendFailoverNoticeToChatPayload(
                payload,
                resolveFailoverNotice(),
              );
              if (payloadWithFailoverNotice !== payload) {
                deps.traceStore.appendEvent(
                  buildTraceEvent(requestId, 'candidate_failover_notice_appended', {
                    attempt,
                    model,
                    stream,
                    routeId: multiRoute?.id,
                    requestedModel: visibleResponseModel,
                  }),
                );
              }
              applyQrouterObservabilityHeaders(reply, buildObservability(attempt));
              return reply.code(200).send(payloadWithFailoverNotice);
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

          if (candidateAttempt < deps.retryPolicy.maxAttempts) {
            await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
            continue;
          }

          if (maybeActivateFallbackForNextAttempt(attempt + 1, finalClassification)) {
            await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
            continue;
          }

          return returnVisibleFailureReply(attempt);
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

          if (candidateAttempt < deps.retryPolicy.maxAttempts) {
            await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
            continue;
          }

          if (maybeActivateFallbackForNextAttempt(attempt + 1, finalClassification)) {
            await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
            continue;
          }

          return returnVisibleFailureReply(attempt);
        }

        finalClassification = `http_${upstream.status}`;
        errorClass = finalClassification;
        if (shouldAdvanceTerminalCandidate(upstream.status) && maybeAdvanceTerminalCandidate(attempt + 1, finalClassification)) {
          continue;
        }
        return returnTerminalFailureReply(attempt);
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

        if (candidateAttempt < deps.retryPolicy.maxAttempts) {
          await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
          continue;
        }

        if (maybeActivateFallbackForNextAttempt(attempt + 1, finalClassification)) {
          await sleep(deps.retryPolicy.backoffMs(candidateAttempt, finalClassification));
          continue;
        }

        return returnVisibleFailureReply(attempt);
      }
    }
  };
}
