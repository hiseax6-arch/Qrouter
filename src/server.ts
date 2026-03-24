import Fastify from 'fastify';
import { createChatCompletionsHandler, type RetryPolicy } from './ingress/chat-completions.js';
import { createNoopTraceStore, createTraceStore, resolveTracePaths, type TraceStore } from './traces/store.js';
import { createFetchUpstream, type FetchUpstream } from './upstream/client.js';

export type BuildAppOptions = {
  fetchUpstream?: FetchUpstream;
  retryPolicy?: RetryPolicy;
  traceStore?: TraceStore;
};

const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: () => 0,
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify();

  const baseUrl = process.env.QINGFU_UPSTREAM_BASE_URL;
  const apiKey = process.env.QINGFU_UPSTREAM_API_KEY;
  const timeoutMs = Number(process.env.QINGFU_UPSTREAM_TIMEOUT_MS ?? 45000);

  const fetchUpstream =
    options.fetchUpstream ??
    (baseUrl
      ? createFetchUpstream(baseUrl, apiKey, timeoutMs)
      : (async () => {
          throw new Error('QINGFU_UPSTREAM_BASE_URL is required when no fetchUpstream override is provided.');
        }));

  const traceStore =
    options.traceStore ??
    (process.env.QINGFU_DISABLE_TRACES === '1'
      ? createNoopTraceStore()
      : createTraceStore(resolveTracePaths()));

  app.addHook('onClose', async () => {
    traceStore.close();
  });

  app.post(
    '/v1/chat/completions',
    createChatCompletionsHandler({
      fetchUpstream,
      retryPolicy: options.retryPolicy ?? defaultRetryPolicy,
      traceStore,
    }),
  );

  return app;
}

async function main() {
  const app = buildApp();
  const port = Number(process.env.QINGFU_ROUTER_PORT ?? 4318);
  const host = process.env.QINGFU_ROUTER_HOST ?? '127.0.0.1';
  await app.listen({ host, port });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
