import type { RouterProviderConfig } from '../config/router.js';

const textDecoder = new TextDecoder();

export type UpstreamResponse = {
  status: number;
  headers: Record<string, string>;
  json(): Promise<unknown>;
  textStream?: AsyncIterable<string>;
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
};

type FallbackUpstreamConfig = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
};

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

function resolveProviderSelection(
  model: unknown,
  providers: Record<string, RouterProviderConfig>,
): ProviderSelection | null {
  const requestModel = stripLrPrefix(model);
  if (!requestModel) {
    return null;
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    for (const modelEntry of provider.models ?? []) {
      const configuredModel = modelEntry.id;
      const upstreamModel = stripProviderPrefix(configuredModel, providerId);
      if (requestModel === configuredModel || requestModel === upstreamModel) {
        return {
          providerId,
          provider,
          requestModel,
          upstreamModel,
        };
      }
    }
  }

  return null;
}

function buildRequestHeaders(
  provider: RouterProviderConfig,
  requestId: string,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-qingfu-request-id': requestId,
    ...(provider.headers ?? {}),
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
  };
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

function buildResponsesInput(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return '';
  }

  return messages
    .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === 'object')
    .map((message) => {
      const role = normalizeResponsesRole(message.role);
      return {
        type: 'message',
        role,
        content: normalizeResponseInputContent(role, message.content),
      };
    });
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

function adaptResponsesPayloadToChatCompletions(payload: unknown, model: string) {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { id?: string };
  const content = extractResponsesOutputText(payload);

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
        },
        finish_reason: 'stop',
      },
    ],
  };
}

async function* adaptResponsesPayloadToChatCompletionsStream(
  payloadPromise: Promise<unknown>,
  model: string,
): AsyncIterable<string> {
  const payload = await payloadPromise;
  const adapted = adaptResponsesPayloadToChatCompletions(payload, model) as {
    id: string;
    choices: Array<{ message: { content: string } }>;
  };

  const content = adapted.choices[0]?.message?.content ?? '';
  if (content) {
    yield `data: ${JSON.stringify({
      id: adapted.id,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { content } }],
    })}\n\n`;
  }
  yield 'data: [DONE]\n\n';
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

function createOpenAICompletionsFetch(provider: RouterProviderConfig, timeoutMs: number): FetchUpstream {
  if (!provider.baseUrl) {
    throw new Error('Provider baseUrl is required for openai-completions upstreams.');
  }

  const baseUrl = provider.baseUrl;

  return async ({ body, requestId }) => {
    const upstreamBody = {
      ...(body as Record<string, unknown>),
      model: stripLrPrefix((body as Record<string, unknown>).model),
    };

    const response = await fetchJsonUpstream({
      url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      headers: buildRequestHeaders(provider, requestId),
      body: upstreamBody,
      timeoutMs,
    });
    const cloned = response.clone();

    return {
      status: response.status,
      headers: responseHeadersToRecord(response.headers),
      json: async () => cloned.json(),
      textStream: response.body ? readableStreamToTextChunks(response.body) : undefined,
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
    const upstreamBody = {
      model,
      input: buildResponsesInput(requestBody.messages),
      stream: false,
    };

    const response = await fetchJsonUpstream({
      url: `${baseUrl.replace(/\/$/, '')}/responses`,
      headers: buildRequestHeaders(provider, requestId),
      body: upstreamBody,
      timeoutMs,
    });

    const payloadPromise = response.json();
    const headers = streamRequested(requestBody)
      ? { 'content-type': 'text/event-stream; charset=utf-8' }
      : { 'content-type': 'application/json; charset=utf-8' };

    return {
      status: response.status,
      headers,
      json: async () => adaptResponsesPayloadToChatCompletions(await payloadPromise, model),
      textStream: streamRequested(requestBody)
        ? adaptResponsesPayloadToChatCompletionsStream(payloadPromise, model)
        : undefined,
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
): FetchUpstream {
  const fallbackFetch = fallback.baseUrl
    ? createFetchUpstream(fallback.baseUrl, fallback.apiKey, fallback.timeoutMs)
    : null;

  return async (args) => {
    const selection = resolveProviderSelection((args.body as Record<string, unknown>)?.model, providers);
    if (!selection) {
      if (fallbackFetch) {
        return fallbackFetch(args);
      }
      throw new Error(`No upstream provider configured for model: ${String((args.body as Record<string, unknown>)?.model ?? 'unknown')}`);
    }

    const provider = selection.provider;
    const upstreamBody = {
      ...(args.body as Record<string, unknown>),
      model: selection.upstreamModel,
    };

    if (provider.api === 'openai-responses') {
      return createOpenAIResponsesFetch(provider, fallback.timeoutMs)({
        ...args,
        body: upstreamBody,
      });
    }

    return createOpenAICompletionsFetch(provider, fallback.timeoutMs)({
      ...args,
      body: upstreamBody,
    });
  };
}
