import Fastify from 'fastify';
import { loadRouterRuntimeConfig, type RouterRuntimeConfig } from './config/router.js';
import { createChatCompletionsHandler, type RetryPolicy } from './ingress/chat-completions.js';
import { createNoopTraceStore, createTraceStore, resolveTracePaths, type TraceStore } from './traces/store.js';
import { createFetchUpstream, createProviderAwareFetch, type FetchUpstream } from './upstream/client.js';

export type BuildAppOptions = {
  fetchUpstream?: FetchUpstream;
  retryPolicy?: RetryPolicy;
  traceStore?: TraceStore;
  routerConfig?: RouterRuntimeConfig;
};

const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: () => 0,
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify();
  const routerConfig = options.routerConfig ?? loadRouterRuntimeConfig();

  const fetchUpstream =
    options.fetchUpstream ??
    (Object.keys(routerConfig.providers).length > 0
      ? createProviderAwareFetch(routerConfig.providers, {
          baseUrl: routerConfig.upstream.baseUrl,
          apiKey: routerConfig.upstream.apiKey,
          timeoutMs: routerConfig.upstream.timeoutMs,
        })
      : routerConfig.upstream.baseUrl
        ? createFetchUpstream(
            routerConfig.upstream.baseUrl,
            routerConfig.upstream.apiKey,
            routerConfig.upstream.timeoutMs,
          )
        : (async () => {
            throw new Error('Q_UPSTREAM_BASE_URL is required when no fetchUpstream override is provided.');
          }));

  const traceStore =
    options.traceStore ??
    (process.env.Q_DISABLE_TRACES === '1'
      ? createNoopTraceStore()
      : createTraceStore(
          resolveTracePaths({
            dir: routerConfig.traces.dir,
            jsonlPath: routerConfig.traces.jsonlPath,
            sqlitePath: routerConfig.traces.sqlitePath,
          }),
        ));

  app.addHook('onClose', async () => {
    traceStore.close();
  });

  const allowedModels =
    options.routerConfig || !options.fetchUpstream
      ? new Set(routerConfig.models.allow)
      : undefined;

  app.get('/health', async () => ({
    status: 'ok',
    pid: process.pid,
    cwd: process.cwd(),
    configPath: routerConfig.configPath,
    server: routerConfig.server,
    providers: Object.keys(routerConfig.providers),
    modelsAllowCount: routerConfig.models.allow.length,
    traces: routerConfig.traces,
  }));

  app.post(
    '/v1/chat/completions',
    createChatCompletionsHandler({
      fetchUpstream,
      retryPolicy: options.retryPolicy ?? defaultRetryPolicy,
      traceStore,
      allowedModels,
    }),
  );

  return app;
}

async function main() {
  const routerConfig = loadRouterRuntimeConfig();
  const app = buildApp({ routerConfig });
  await app.listen({ host: routerConfig.server.host, port: routerConfig.server.port });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
