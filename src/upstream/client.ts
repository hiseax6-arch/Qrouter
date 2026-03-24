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

export function createFetchUpstream(baseUrl: string, apiKey?: string, timeoutMs = 45_000): FetchUpstream {
  return async ({ body, requestId }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-qingfu-request-id': requestId,
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const cloned = response.clone();

    return {
      status: response.status,
      headers: responseHeadersToRecord(response.headers),
      json: async () => cloned.json(),
      textStream: response.body
        ? readableStreamToTextChunks(response.body)
        : undefined,
    };
  };
}
