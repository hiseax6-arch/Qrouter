import type { RouterProviderConfig, RouterThinkingConfig } from '../config/router.js';
import {
  extractTokenUsageFromPayload,
  toChatCompletionUsage,
  type TokenUsage,
} from '../domain/token-usage.js';
import type { CompiledRoute } from '../routing/routes.js';
import { resolveDirectRoute } from '../routing/routes.js';

type ThinkingTrace = {
  inboundThinking?: string;
  inboundReasoningEffort?: string;
  inboundReasoningEffortObject?: string;
  outboundThinking?: string;
  outboundReasoningEffort?: string;
  outboundReasoningEffortObject?: string;
};

function getReasoningEffort(body: Record<string, unknown>): string | undefined {
  if (body.reasoning && typeof body.reasoning === 'object') {
    const effort = (body.reasoning as { effort?: unknown }).effort;
    if (typeof effort === 'string') {
      return effort;
    }
  }
  return undefined;
}

function buildThinkingTrace(
  inbound: Record<string, unknown>,
  outbound: Record<string, unknown>,
): ThinkingTrace {
  const inboundReasoningEffortObject = getReasoningEffort(inbound);
  const outboundReasoningEffortObject = getReasoningEffort(outbound);

  return {
    ...(typeof inbound.thinking === 'string' ? { inboundThinking: inbound.thinking } : {}),
    ...(typeof inbound.reasoning_effort === 'string' ? { inboundReasoningEffort: inbound.reasoning_effort } : {}),
    ...(inboundReasoningEffortObject ? { inboundReasoningEffortObject } : {}),
    ...(typeof outbound.thinking === 'string' ? { outboundThinking: outbound.thinking } : {}),
    ...(typeof outbound.reasoning_effort === 'string' ? { outboundReasoningEffort: outbound.reasoning_effort } : {}),
    ...(outboundReasoningEffortObject ? { outboundReasoningEffortObject } : {}),
  };
}

const textDecoder = new TextDecoder();

export type UpstreamResponse = {
  status: number;
  headers: Record<string, string>;
  json(): Promise<unknown>;
  textStream?: AsyncIterable<string>;
  usage?(): Promise<TokenUsage | null>;
  bodyText?(): Promise<string>;
  providerId?: string;
  routeId?: string;
  upstreamUrl?: string;
  thinkingTrace?: ThinkingTrace;
};

export type FetchUpstreamArgs = {
  body: unknown;
  requestId: string;
  attempt: number;
};

export type FetchUpstream = (
  args: FetchUpstreamArgs,
) => Promise<UpstreamResponse>;

type ProviderSelection = {
  providerId: string;
  provider: RouterProviderConfig;
  requestModel: string;
  upstreamModel: string;
  routeId?: string;
};

type FallbackUpstreamConfig = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
};

function hasNonEmptyTextPart(content: unknown): boolean {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((part) => {
    if (typeof part === 'string') {
      return part.trim().length > 0;
    }

    if (
      part &&
      typeof part === 'object' &&
      'text' in part &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      return String((part as { text: string }).text).trim().length > 0;
    }

    return false;
  });
}

function rewriteThinking(
  body: Record<string, unknown>,
  thinkingConfig: RouterThinkingConfig | undefined,
): { body: Record<string, unknown>; trace: ThinkingTrace } {
  const requestModel = typeof body.model === 'string' ? body.model : undefined;
  const inboundThinking = typeof body.thinking === 'string' ? body.thinking : undefined;
  const inboundReasoningEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
  const requestThinking = inboundThinking ?? inboundReasoningEffort;

  if (!requestModel || !requestThinking) {
    return { body, trace: buildThinkingTrace(body, body) };
  }

  const normalizedModel = stripLrPrefix(requestModel) ?? requestModel;

  if (thinkingConfig && thinkingConfig.defaultMode === 'pass-through' && thinkingConfig.mappingsEnabled !== false) {
    for (const rule of thinkingConfig.mappings ?? []) {
      const matches = rule.match ?? [];
      const hit = matches.includes(requestModel) || matches.includes(normalizedModel);
      if (!hit) {
        continue;
      }
      if (rule.when?.thinking && rule.when.thinking !== requestThinking) {
        continue;
      }

      const nextBody = { ...body };
      delete nextBody.thinking;
      delete nextBody.reasoning_effort;

      if (rule.rewrite?.reasoning && typeof rule.rewrite.reasoning === 'object') {
        const rewritten = {
          ...nextBody,
          reasoning: rule.rewrite.reasoning,
        };
        return { body: rewritten, trace: buildThinkingTrace(body, rewritten) };
      }

      if (rule.rewrite?.thinking && rule.rewrite.thinking !== requestThinking) {
        const rewritten = {
          ...nextBody,
          reasoning: { effort: rule.rewrite.thinking },
        };
        return { body: rewritten, trace: buildThinkingTrace(body, rewritten) };
      }

      const rewritten = {
        ...nextBody,
        reasoning: { effort: requestThinking },
      };
      return { body: rewritten, trace: buildThinkingTrace(body, rewritten) };
    }
  }

  if (inboundThinking) {
    const rewritten: Record<string, unknown> = {
      ...body,
      reasoning: {
        ...(body.reasoning && typeof body.reasoning === 'object' ? body.reasoning as Record<string, unknown> : {}),
        effort: requestThinking,
      },
    };
    delete rewritten.thinking;
    delete rewritten.reasoning_effort;
    return { body: rewritten, trace: buildThinkingTrace(body, rewritten) };
  }

  if (inboundReasoningEffort) {
    const nextBody = { ...body };
    delete nextBody.reasoning_effort;
    if (!nextBody.reasoning || typeof nextBody.reasoning !== 'object') {
      const rewritten = {
        ...nextBody,
        reasoning: { effort: requestThinking },
      };
      return { body: rewritten, trace: buildThinkingTrace(body, rewritten) };
    }
    return { body: nextBody, trace: buildThinkingTrace(body, nextBody) };
  }

  return { body, trace: buildThinkingTrace(body, body) };
}

async function* readableStreamToTextChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        yield textDecoder.decode(value, { stream: true });
      }
    }

    const finalChunk = textDecoder.decode();
    if (finalChunk) {
      yield finalChunk;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* sanitizeResponsesSseStream(
  textStream: AsyncIterable<string>,
): AsyncIterable<string> {
  let lineBuffer = '';

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

      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data) {
        continue;
      }

      yield `data: ${data}\n\n`;
    }
  }

  const trailing = lineBuffer.replace(/\r$/, '').trim();
  if (trailing.startsWith('data:')) {
    const data = trailing.slice(5).trim();
    if (data) {
      yield `data: ${data}\n\n`;
    }
  }
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function stripLrPrefix(model: unknown): string | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }

  return model.startsWith('LR/') ? model.slice(3) : model;
}

function stripProviderPrefix(modelId: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function withProviderPrefix(providerId: string, modelId: string): string {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

function resolveProviderSelection(
  model: unknown,
  providers: Record<string, RouterProviderConfig>,
): ProviderSelection | null {
  if (typeof model !== 'string') {
    return null;
  }

  const rawRequestModel = model;
  const requestModel = stripLrPrefix(model) ?? model;
  let implicitMatch: ProviderSelection | null = null;

  for (const [providerId, provider] of Object.entries(providers)) {
    for (const modelEntry of provider.models ?? []) {
      const configuredModel = modelEntry.id;
      const upstreamModel = stripProviderPrefix(configuredModel, providerId);
      const explicitAliases = new Set([
        withProviderPrefix(providerId, configuredModel),
        withProviderPrefix(providerId, upstreamModel),
      ]);
      if (explicitAliases.has(rawRequestModel) || explicitAliases.has(requestModel)) {
        return {
          providerId,
          provider,
          requestModel,
          upstreamModel,
        };
      }

      if (
        !implicitMatch &&
        (
          rawRequestModel === configuredModel ||
          rawRequestModel === upstreamModel ||
          requestModel === configuredModel ||
          requestModel === upstreamModel
        )
      ) {
        implicitMatch = {
          providerId,
          provider,
          requestModel,
          upstreamModel,
        };
      }
    }
  }

  return implicitMatch;
}

function buildRequestHeaders(
  provider: RouterProviderConfig,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-qingfu-request-id': requestId,
    ...(provider.headers ?? {}),
  };

  if (!provider.apiKey) {
    return headers;
  }

  const authHeaders =
    provider.authHeader === true || provider.auth === 'token' || provider.auth === 'oauth'
      ? { authorization: `Bearer ${provider.apiKey}` }
      : provider.auth === 'api-key'
        ? { 'x-api-key': provider.apiKey }
        : { authorization: `Bearer ${provider.apiKey}` };

  for (const [key, value] of Object.entries(authHeaders)) {
    const existingKey = Object.keys(headers).find(
      (headerName) => headerName.toLowerCase() === key.toLowerCase(),
    );
    if (!existingKey) {
      headers[key] = value;
    }
  }

  return headers;
}

function createAbortController(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

function normalizeResponseInputContent(
  role: string,
  content: unknown,
): Array<{ type: 'input_text' | 'output_text'; text: string }> {
  const contentType: 'input_text' | 'output_text' = role === 'assistant' ? 'output_text' : 'input_text';

  if (typeof content === 'string') {
    return [{ type: contentType, text: content }];
  }

  if (Array.isArray(content)) {
    const parts = content
      .flatMap((part) => {
        if (typeof part === 'string') {
          return [{ type: contentType, text: part }];
        }
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return [{ type: contentType, text: String((part as { text: string }).text) }];
        }
        return [];
      });

    return parts.length > 0 ? parts : [{ type: contentType, text: JSON.stringify(content) }];
  }

  return [{ type: contentType, text: String(content ?? '') }];
}

function normalizeResponsesRole(role: unknown): 'assistant' | 'system' | 'developer' | 'user' {
  if (role === 'assistant' || role === 'system' || role === 'developer' || role === 'user') {
    return role;
  }

  return 'user';
}

function normalizeResponsesTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    const record = tool as Record<string, unknown>;
    if (record.type !== 'function' || !record.function || typeof record.function !== 'object') {
      return tool;
    }

    const fn = record.function as Record<string, unknown>;
    return {
      type: 'function',
      ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
    };
  });
}

function extractMessageTextForMerge(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content.flatMap((part) => {
      if (typeof part === 'string') {
        return [part];
      }

      if (
        part
        && typeof part === 'object'
        && 'text' in part
        && typeof (part as { text?: unknown }).text === 'string'
      ) {
        return [String((part as { text: string }).text)];
      }

      return [];
    });

    return textParts.join('\n');
  }

  if (
    content
    && typeof content === 'object'
    && 'text' in content
    && typeof (content as { text?: unknown }).text === 'string'
  ) {
    return String((content as { text: string }).text);
  }

  return String(content ?? '');
}

function applySystemMessageHandling(
  messages: unknown,
  provider: RouterProviderConfig,
): unknown {
  if (provider.systemMessageHandling !== 'merge-to-first-user' || !Array.isArray(messages)) {
    return messages;
  }

  const systemMessages = messages.filter((message) =>
    message
    && typeof message === 'object'
    && (message as Record<string, unknown>).role === 'system',
  ) as Array<Record<string, unknown>>;

  if (systemMessages.length === 0) {
    return messages;
  }

  const mergedSystemText = systemMessages
    .map((message) => extractMessageTextForMerge(message.content))
    .filter((text) => text.trim().length > 0)
    .join('\n\n');

  const nonSystemMessages = messages.filter((message) =>
    !message
    || typeof message !== 'object'
    || (message as Record<string, unknown>).role !== 'system',
  ) as Array<Record<string, unknown>>;

  if (mergedSystemText.length === 0) {
    return nonSystemMessages;
  }

  const firstUserIndex = nonSystemMessages.findIndex((message) => message.role === 'user');
  if (firstUserIndex === -1) {
    return [
      {
        role: 'user',
        content: mergedSystemText,
      },
      ...nonSystemMessages,
    ];
  }

  const firstUserMessage = nonSystemMessages[firstUserIndex];
  const firstUserContent = firstUserMessage.content;
  const mergedUserContent =
    typeof firstUserContent === 'string'
      ? `${mergedSystemText}\n\n${firstUserContent}`
      : Array.isArray(firstUserContent)
        ? [{ type: 'text', text: mergedSystemText }, ...firstUserContent]
        : mergedSystemText;

  return nonSystemMessages.map((message, index) =>
    index === firstUserIndex
      ? {
          ...message,
          content: mergedUserContent,
        }
      : message,
  );
}

type ResponsesMessageInputItem = {
  type: 'message';
  role: 'assistant' | 'system' | 'developer' | 'user';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
};

type ResponsesFunctionCallItem = {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
};

type ResponsesFunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

function buildResponsesInput(messages: unknown): Array<
  ResponsesMessageInputItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem
> | string {
  if (!Array.isArray(messages)) {
    return '';
  }

  const items: Array<ResponsesMessageInputItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem> = [];

  for (const message of messages.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')) {
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      });
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      if (hasNonEmptyTextPart(message.content)) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: normalizeResponseInputContent('assistant', message.content),
        });
      }

      for (const toolCall of message.tool_calls.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')) {
        items.push({
          type: 'function_call',
          call_id: typeof toolCall.id === 'string' ? toolCall.id : '',
          name:
            toolCall.function &&
            typeof toolCall.function === 'object' &&
            typeof (toolCall.function as Record<string, unknown>).name === 'string'
              ? String((toolCall.function as Record<string, unknown>).name)
              : '',
          arguments:
            toolCall.function &&
            typeof toolCall.function === 'object' &&
            typeof (toolCall.function as Record<string, unknown>).arguments === 'string'
              ? String((toolCall.function as Record<string, unknown>).arguments)
              : '',
        });
      }
      continue;
    }

    const role = normalizeResponsesRole(message.role);
    items.push({
      type: 'message',
      role,
      content: normalizeResponseInputContent(role, message.content),
    });
  }

  return items;
}

function extractResponsesOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const record = payload as {
    output_text?: unknown;
    output?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>;
  };

  if (typeof record.output_text === 'string') {
    return record.output_text;
  }

  const parts: string[] = [];
  for (const item of record.output ?? []) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (item.type !== 'message' && item.role !== 'assistant') {
      continue;
    }

    for (const part of item.content ?? []) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      if (typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }

  return parts.join('');
}

function extractResponsesToolCalls(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return [] as Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }

  const record = payload as {
    output?: Array<{
      type?: string;
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
  };

  return (record.output ?? [])
    .filter((item) => item && typeof item === 'object' && item.type === 'function_call')
    .map((item) => ({
      id: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? ''),
      type: 'function' as const,
      function: {
        name: typeof item.name === 'string' ? item.name : '',
        arguments: typeof item.arguments === 'string' ? item.arguments : '',
      },
    }));
}

function adaptResponsesPayloadToChatCompletions(payload: unknown, model: string) {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { id?: string };
  const content = extractResponsesOutputText(payload);
  const toolCalls = extractResponsesToolCalls(payload);
  const usage = extractTokenUsageFromPayload(payload);

  return {
    id: record.id ?? 'resp-adapted',
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    ...(usage ? { usage: toChatCompletionUsage(usage) } : {}),
  };
}

async function* adaptResponsesPayloadToChatCompletionsStream(
  payloadPromise: Promise<unknown>,
  model: string,
): AsyncIterable<string> {
  const payload = await payloadPromise;
  const adapted = adaptResponsesPayloadToChatCompletions(payload, model) as {
    id: string;
    choices: Array<{
      message: {
        content?: string;
        tool_calls?: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason?: string;
    }>;
  };

  const content = adapted.choices[0]?.message?.content ?? '';
  const toolCalls = adapted.choices[0]?.message?.tool_calls ?? [];
  const finishReason = adapted.choices[0]?.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');

  if (content) {
    yield `data: ${JSON.stringify({
      id: adapted.id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { content } }],
    })}\n\n`;
  }

  if (toolCalls.length > 0) {
    yield `data: ${JSON.stringify({
      id: adapted.id,
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((toolCall, index) => ({
              index,
              ...toolCall,
            })),
          },
        },
      ],
    })}\n\n`;
  }

  yield `data: ${JSON.stringify({
    id: adapted.id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`;
  yield 'data: [DONE]\n\n';
}

type ResponsesFunctionCallState = {
  id: string;
  name: string;
  arguments: string;
  outputIndex: number;
};

async function* adaptResponsesSseToChatCompletionsStream(
  textStream: AsyncIterable<string>,
  model: string,
): AsyncIterable<string> {
  let lineBuffer = '';
  let responseId = 'resp-adapted';
  let emittedToolCall = false;
  const functionCalls = new Map<string, ResponsesFunctionCallState>();
  const functionCallAliases = new Map<string, string>();

  const resolveFunctionCallKey = (key: string) => {
    let current = key;
    const seen = new Set<string>();
    while (current && functionCallAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = functionCallAliases.get(current) ?? current;
    }
    return current;
  };

  const mergeFunctionCallStates = (
    primary: ResponsesFunctionCallState,
    secondary: ResponsesFunctionCallState,
  ): ResponsesFunctionCallState => ({
    id: primary.id || secondary.id,
    name: primary.name || secondary.name,
    arguments: primary.arguments || secondary.arguments,
    outputIndex: primary.outputIndex ?? secondary.outputIndex,
  });

  const linkFunctionCallAlias = (alias: string, canonicalKey: string) => {
    if (!alias || !canonicalKey) {
      return;
    }

    const resolvedAlias = resolveFunctionCallKey(alias);
    const resolvedCanonical = resolveFunctionCallKey(canonicalKey);

    if (resolvedAlias === resolvedCanonical) {
      if (alias !== resolvedCanonical) {
        functionCallAliases.set(alias, resolvedCanonical);
      }
      return;
    }

    const aliasState = functionCalls.get(resolvedAlias);
    const canonicalState = functionCalls.get(resolvedCanonical);
    if (aliasState) {
      functionCalls.set(
        resolvedCanonical,
        canonicalState ? mergeFunctionCallStates(canonicalState, aliasState) : aliasState,
      );
      functionCalls.delete(resolvedAlias);
    }

    functionCallAliases.set(alias, resolvedCanonical);
    if (resolvedAlias !== alias) {
      functionCallAliases.set(resolvedAlias, resolvedCanonical);
    }
  };

  const ensureFunctionCall = (key: string, seed?: Partial<ResponsesFunctionCallState>) => {
    const resolvedKey = resolveFunctionCallKey(key);
    const current = functionCalls.get(resolvedKey) ?? {
      id: resolvedKey,
      name: '',
      arguments: '',
      outputIndex: 0,
    };
    const next = {
      ...current,
      ...(seed ?? {}),
    };
    functionCalls.set(resolvedKey, next);
    if (resolvedKey !== key) {
      functionCallAliases.set(key, resolvedKey);
    }
    return next;
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

      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = typeof parsed.type === 'string' ? parsed.type : '';
      if (eventType === 'response.created') {
        const candidateId = (parsed.response && typeof parsed.response === 'object')
          ? (parsed.response as { id?: unknown }).id
          : undefined;
        if (typeof candidateId === 'string' && candidateId) {
          responseId = candidateId;
        }
        continue;
      }

      if (eventType === 'response.output_text.delta') {
        const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
        if (!delta) {
          continue;
        }
        yield `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: delta } }],
        })}\n\n`;
        continue;
      }

      if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
        const item = parsed.item && typeof parsed.item === 'object'
          ? parsed.item as Record<string, unknown>
          : null;
        if (item?.type === 'function_call') {
          const itemId = typeof item.id === 'string'
            ? item.id
            : typeof parsed.item_id === 'string'
              ? parsed.item_id
              : '';
          const callId = typeof item.call_id === 'string'
            ? item.call_id
            : '';
          const key = itemId || callId;
          if (callId && itemId) {
            linkFunctionCallAlias(callId, itemId);
          }
          if (key) {
            ensureFunctionCall(key, {
              id: callId || key,
              name: typeof item.name === 'string' ? item.name : '',
              arguments: typeof item.arguments === 'string' ? item.arguments : '',
              outputIndex: typeof parsed.output_index === 'number' ? parsed.output_index : 0,
            });
          } else {
            const fallbackKey = typeof item.call_id === 'string'
              ? item.call_id
              : typeof item.id === 'string'
                ? item.id
                : typeof parsed.item_id === 'string'
                  ? parsed.item_id
                  : '';
            if (fallbackKey) {
              ensureFunctionCall(fallbackKey, {
                id: typeof item.call_id === 'string' ? item.call_id : fallbackKey,
                name: typeof item.name === 'string' ? item.name : '',
                arguments: typeof item.arguments === 'string' ? item.arguments : '',
                outputIndex: typeof parsed.output_index === 'number' ? parsed.output_index : 0,
              });
            }
          }
        }
        continue;
      }

      if (eventType === 'response.function_call_arguments.delta') {
        const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : '';
        const callId = typeof parsed.call_id === 'string' ? parsed.call_id : '';
        if (callId && itemId) {
          linkFunctionCallAlias(callId, itemId);
        }
        const key = resolveFunctionCallKey(itemId || callId);
        if (!key) {
          continue;
        }
        const current = ensureFunctionCall(key, {
          outputIndex: typeof parsed.output_index === 'number' ? parsed.output_index : 0,
        });
        if (typeof parsed.delta === 'string') {
          current.arguments += parsed.delta;
          functionCalls.set(resolveFunctionCallKey(key), current);
        }
        continue;
      }

      if (eventType === 'response.function_call_arguments.done') {
        const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : '';
        const callId = typeof parsed.call_id === 'string' ? parsed.call_id : '';
        if (callId && itemId) {
          linkFunctionCallAlias(callId, itemId);
        }
        const key = resolveFunctionCallKey(itemId || callId);
        if (!key) {
          continue;
        }
        const current = ensureFunctionCall(key, {
          outputIndex: typeof parsed.output_index === 'number' ? parsed.output_index : 0,
        });
        if (typeof parsed.arguments === 'string') {
          current.arguments = parsed.arguments;
          functionCalls.set(resolveFunctionCallKey(key), current);
        }
        emittedToolCall = true;
        yield `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: current.outputIndex,
                id: current.id,
                type: 'function',
                function: {
                  name: current.name,
                  arguments: current.arguments,
                },
              }],
            },
          }],
        })}\n\n`;
        continue;
      }

      if (eventType === 'response.completed') {
        yield `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: {}, finish_reason: emittedToolCall ? 'tool_calls' : 'stop' }],
        })}\n\n`;
        yield 'data: [DONE]\n\n';
      }
    }
  }
}

async function fetchJsonUpstream(args: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): Promise<Response> {
  const { controller, timeout } = createAbortController(args.timeoutMs);

  try {
    return await fetch(args.url, {
      method: 'POST',
      headers: args.headers,
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createLazyPayloadLoader(response: Response): () => Promise<unknown> {
  let payloadPromise: Promise<unknown> | undefined;
  return () => {
    if (!payloadPromise) {
      payloadPromise = response.json().catch((err) => {
        // When upstream returns non-JSON (e.g., Cloudflare error page),
        // return a structured error instead of crashing the process.
        return {
          error: {
            message: `Upstream returned non-JSON response: ${err.message}`,
            type: 'upstream_non_json',
            status: response.status,
          },
        };
      });
    }
    return payloadPromise;
  };
}

function createLazyTextLoader(response: Response): () => Promise<string> {
  let textPromise: Promise<string> | undefined;
  return () => {
    if (!textPromise) {
      textPromise = response.text();
    }
    return textPromise;
  };
}

function createOpenAICompletionsFetch(provider: RouterProviderConfig, timeoutMs: number): FetchUpstream {
  if (!provider.baseUrl) {
    throw new Error('Provider baseUrl is required for openai-completions upstreams.');
  }

  const baseUrl = provider.baseUrl;

  return async ({ body, requestId }) => {
    const requestBody = body as Record<string, unknown>;
    const upstreamUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const upstreamBody = {
      ...requestBody,
      model: stripLrPrefix(requestBody.model),
    };

    const response = await fetchJsonUpstream({
      url: upstreamUrl,
      headers: buildRequestHeaders(provider, requestId),
      body: upstreamBody,
      timeoutMs,
    });
    const loadPayload = createLazyPayloadLoader(response.clone());
    const loadBodyText = createLazyTextLoader(response.clone());
    const streaming = streamRequested(requestBody);

    return {
      status: response.status,
      headers: responseHeadersToRecord(response.headers),
      json: async () => loadPayload(),
      textStream: response.body ? readableStreamToTextChunks(response.body) : undefined,
      usage: streaming ? undefined : async () => extractTokenUsageFromPayload(await loadPayload()),
      bodyText: async () => loadBodyText(),
      upstreamUrl,
    };
  };
}

function createOpenAIResponsesFetch(provider: RouterProviderConfig, timeoutMs: number): FetchUpstream {
  if (!provider.baseUrl) {
    throw new Error('Provider baseUrl is required for openai-responses upstreams.');
  }

  const baseUrl = provider.baseUrl;

  return async ({ body, requestId }) => {
    const requestBody = body as Record<string, unknown>;
    const model = stripLrPrefix(requestBody.model) ?? '';
    const normalizedTools = normalizeResponsesTools(requestBody.tools);
    const normalizedMessages = applySystemMessageHandling(requestBody.messages, provider);
    const upstreamUrl = `${baseUrl.replace(/\/$/, '')}/responses`;
    const streaming = streamRequested(requestBody);
    const upstreamBody = {
      model,
      input: buildResponsesInput(normalizedMessages),
      stream: streaming,
      ...(normalizedTools ? { tools: normalizedTools } : {}),
      ...(requestBody.tool_choice !== undefined ? { tool_choice: requestBody.tool_choice } : {}),
      ...(requestBody.parallel_tool_calls !== undefined ? { parallel_tool_calls: requestBody.parallel_tool_calls } : {}),
      ...(requestBody.reasoning && typeof requestBody.reasoning === 'object' ? { reasoning: requestBody.reasoning } : {}),
      ...(typeof requestBody.thinking === 'string' ? { thinking: requestBody.thinking } : {}),
    };

    const response = await fetchJsonUpstream({
      url: upstreamUrl,
      headers: buildRequestHeaders(provider, requestId),
      body: upstreamBody,
      timeoutMs,
    });

    const loadPayload = createLazyPayloadLoader(response.clone());
    const loadBodyText = createLazyTextLoader(response.clone());
    const contentType = response.headers.get('content-type') ?? '';
    const headers = streaming
      ? { 'content-type': 'text/event-stream; charset=utf-8' }
      : { 'content-type': 'application/json; charset=utf-8' };

    return {
      status: response.status,
      headers,
      json: async () => adaptResponsesPayloadToChatCompletions(await loadPayload(), model),
      textStream: streaming
        ? (response.body && contentType.toLowerCase().includes('text/event-stream')
            ? adaptResponsesSseToChatCompletionsStream(readableStreamToTextChunks(response.body), model)
            : adaptResponsesPayloadToChatCompletionsStream(loadPayload(), model))
        : undefined,
      usage: streaming ? undefined : async () => extractTokenUsageFromPayload(await loadPayload()),
      bodyText: async () => loadBodyText(),
      upstreamUrl,
    };
  };
}

function createOpenAIResponsesPassthroughFetch(provider: RouterProviderConfig, timeoutMs: number): FetchUpstream {
  if (!provider.baseUrl) {
    throw new Error('Provider baseUrl is required for openai-responses upstreams.');
  }

  const baseUrl = provider.baseUrl;

  return async ({ body, requestId }) => {
    const requestBody = body as Record<string, unknown>;
    const upstreamUrl = `${baseUrl.replace(/\/$/, '')}/responses`;

    const response = await fetchJsonUpstream({
      url: upstreamUrl,
      headers: buildRequestHeaders(provider, requestId),
      body: requestBody,
      timeoutMs,
    });

    const loadPayload = createLazyPayloadLoader(response.clone());
    const loadBodyText = createLazyTextLoader(response.clone());

    return {
      status: response.status,
      headers: streamRequested(requestBody)
        ? { 'content-type': 'text/event-stream; charset=utf-8' }
        : responseHeadersToRecord(response.headers),
      json: async () => loadPayload(),
      textStream: streamRequested(requestBody) && response.body
        ? sanitizeResponsesSseStream(readableStreamToTextChunks(response.body))
        : undefined,
      bodyText: async () => loadBodyText(),
      upstreamUrl,
    };
  };
}

function streamRequested(body: Record<string, unknown>): boolean {
  return body.stream === true;
}

export function createFetchUpstream(baseUrl: string, apiKey?: string, timeoutMs = 45_000): FetchUpstream {
  return createOpenAICompletionsFetch(
    {
      baseUrl,
      apiKey,
    },
    timeoutMs,
  );
}

export function createProviderAwareFetch(
  providers: Record<string, RouterProviderConfig>,
  fallback: FallbackUpstreamConfig,
  thinkingConfig?: RouterThinkingConfig,
  routes?: CompiledRoute[],
): FetchUpstream {
  const fallbackFetch = fallback.baseUrl
    ? createFetchUpstream(fallback.baseUrl, fallback.apiKey, fallback.timeoutMs)
    : null;

  return async (args) => {
    const requestedModel = (args.body as Record<string, unknown>)?.model;
    const directRoute = routes ? resolveDirectRoute(requestedModel, routes) : null;
    const directRouteProvider = directRoute ? providers[directRoute.providerId] : undefined;
    const selection =
      directRoute && directRouteProvider
        ? {
            providerId: directRoute.providerId,
            provider: directRouteProvider,
            requestModel: typeof requestedModel === 'string' ? requestedModel : String(directRoute.upstreamModel),
            upstreamModel: directRoute.upstreamModel,
            routeId: directRoute.route.id,
          }
        : resolveProviderSelection(requestedModel, providers);
    if (!selection) {
      if (fallbackFetch) {
        return fallbackFetch(args);
      }
      throw new Error(`No upstream provider configured for model: ${String((args.body as Record<string, unknown>)?.model ?? 'unknown')}`);
    }

    const provider = selection.provider;
    const rewriteResult = rewriteThinking(args.body as Record<string, unknown>, thinkingConfig);
    const upstreamBody = {
      ...rewriteResult.body,
      model: selection.upstreamModel,
    };
    const finalThinkingTrace = buildThinkingTrace(args.body as Record<string, unknown>, upstreamBody);

    if (provider.api === 'openai-responses') {
      const upstream = await createOpenAIResponsesFetch(provider, fallback.timeoutMs)({
        ...args,
        body: upstreamBody,
      });
      return {
        ...upstream,
        providerId: selection.providerId,
        routeId: selection.routeId,
        thinkingTrace: finalThinkingTrace,
      };
    }

    const upstream = await createOpenAICompletionsFetch(provider, fallback.timeoutMs)({
      ...args,
      body: upstreamBody,
    });
    return {
      ...upstream,
      providerId: selection.providerId,
      routeId: selection.routeId,
      thinkingTrace: finalThinkingTrace,
    };
  };
}

export function createProviderAwareResponsesPassthrough(
  providers: Record<string, RouterProviderConfig>,
  fallback: FallbackUpstreamConfig,
  thinkingConfig?: RouterThinkingConfig,
  routes?: CompiledRoute[],
): FetchUpstream {
  const fallbackFetch = fallback.baseUrl
    ? createOpenAIResponsesPassthroughFetch(
        {
          api: 'openai-responses',
          baseUrl: fallback.baseUrl,
          apiKey: fallback.apiKey,
        },
        fallback.timeoutMs,
      )
    : null;

  return async (args) => {
    const requestedModel = (args.body as Record<string, unknown>)?.model;
    const directRoute = routes ? resolveDirectRoute(requestedModel, routes) : null;
    const directRouteProvider = directRoute ? providers[directRoute.providerId] : undefined;
    const selection =
      directRoute && directRouteProvider
        ? {
            providerId: directRoute.providerId,
            provider: directRouteProvider,
            requestModel: typeof requestedModel === 'string' ? requestedModel : String(directRoute.upstreamModel),
            upstreamModel: directRoute.upstreamModel,
            routeId: directRoute.route.id,
          }
        : resolveProviderSelection(requestedModel, providers);
    if (!selection) {
      if (fallbackFetch) {
        return fallbackFetch(args);
      }
      throw new Error(`No upstream provider configured for model: ${String((args.body as Record<string, unknown>)?.model ?? 'unknown')}`);
    }

    const provider = selection.provider;
    if (provider.api && provider.api !== 'openai-responses') {
      throw new Error(`Provider ${selection.providerId} does not support /v1/responses passthrough.`);
    }

    const rewriteResult = rewriteThinking(args.body as Record<string, unknown>, thinkingConfig);
    const upstreamBody = {
      ...rewriteResult.body,
      model: selection.upstreamModel,
    };
    const finalThinkingTrace = buildThinkingTrace(args.body as Record<string, unknown>, upstreamBody);

    const upstream = await createOpenAIResponsesPassthroughFetch(provider, fallback.timeoutMs)({
      ...args,
      body: upstreamBody,
    });
    return {
      ...upstream,
      providerId: selection.providerId,
      routeId: selection.routeId,
      thinkingTrace: finalThinkingTrace,
    };
  };
}
