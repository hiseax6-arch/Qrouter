import Fastify from 'fastify';
import { loadRouterRuntimeConfig, type RouterRuntimeConfig } from './config/router.js';
import { createChatCompletionsHandler, type RetryPolicy } from './ingress/chat-completions.js';
import { createResponsesHandler } from './ingress/responses.js';
import { compileRoutingTable, describeProviderAuth } from './routing/routes.js';
import { createNoopTraceStore, createTraceStore, resolveTracePaths, type TraceStore } from './traces/store.js';
import { createFetchUpstream, createProviderAwareFetch, createProviderAwareResponsesPassthrough, type FetchUpstream } from './upstream/client.js';

export type BuildAppOptions = {
  fetchUpstream?: FetchUpstream;
  retryPolicy?: RetryPolicy;
  traceStore?: TraceStore;
  routerConfig?: RouterRuntimeConfig;
};

const DEFAULT_RETRIES_BEFORE_VISIBLE_REPLY = 3;
const DEFAULT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: DEFAULT_RETRIES_BEFORE_VISIBLE_REPLY + 1,
  backoffMs: () => 0,
};
const emittedConfigWarnings = new Set<string>();

function parseBooleanQuery(value: unknown): boolean | undefined {
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
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return undefined;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
  });
  const routerConfig = options.routerConfig ?? loadRouterRuntimeConfig();
  const routingTable = compileRoutingTable(routerConfig);

  for (const warning of routingTable.warnings) {
    if (emittedConfigWarnings.has(warning)) {
      continue;
    }
    emittedConfigWarnings.add(warning);
    console.warn(`[Q-router] ${warning}`);
  }

  const fetchUpstream =
    options.fetchUpstream ??
    (Object.keys(routerConfig.providers).length > 0
      ? createProviderAwareFetch(routerConfig.providers, {
          baseUrl: routerConfig.upstream.baseUrl,
          apiKey: routerConfig.upstream.apiKey,
          timeoutMs: routerConfig.upstream.timeoutMs,
        }, routerConfig.thinking, routingTable.routes)
      : routerConfig.upstream.baseUrl
        ? createFetchUpstream(
            routerConfig.upstream.baseUrl,
            routerConfig.upstream.apiKey,
            routerConfig.upstream.timeoutMs,
          )
        : (async () => {
            throw new Error('Q_UPSTREAM_BASE_URL is required when no fetchUpstream override is provided.');
          }));

  const fetchResponsesUpstream =
    Object.keys(routerConfig.providers).length > 0
      ? createProviderAwareResponsesPassthrough(routerConfig.providers, {
          baseUrl: routerConfig.upstream.baseUrl,
          apiKey: routerConfig.upstream.apiKey,
          timeoutMs: routerConfig.upstream.timeoutMs,
        }, routerConfig.thinking, routingTable.routes)
      : fetchUpstream;

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

  const effectiveAllowedModels =
    routerConfig.models.allow.length > 0
      ? routerConfig.models.allow
      : routingTable.routes.flatMap((route) => route.aliases);

  const allowedModels =
    options.routerConfig || !options.fetchUpstream
      ? new Set(effectiveAllowedModels)
      : undefined;

  app.get('/health', async () => ({
    status: 'ok',
    pid: process.pid,
    cwd: process.cwd(),
    configPath: routerConfig.configPath,
    ...(routerConfig.routeMappingsPath ? { routeMappingsPath: routerConfig.routeMappingsPath } : {}),
    server: routerConfig.server,
    providers: Object.keys(routerConfig.providers),
    modelsAllowCount: routerConfig.models.allow.length,
    effectiveModelsAllowCount: effectiveAllowedModels.length,
    traces: routerConfig.traces,
    warnings: routingTable.warnings,
  }));

  app.get('/debug/routes', async () => ({
    warnings: routingTable.warnings,
    routes: routingTable.routes.map((route) => {
      const provider = routerConfig.providers[route.providerId];
      const providerBaseUrl = provider?.baseUrl?.replace(/\/$/, '') ?? null;
      return {
        id: route.id,
        source: route.source,
        strategy: route.strategy,
        aliases: route.aliases,
        ...(typeof route.failbackAfterMs === 'number' ? { failbackAfterMs: route.failbackAfterMs } : {}),
        providerId: route.providerId,
        providerApi: provider?.api ?? null,
        providerBaseUrl,
        authMode: provider ? describeProviderAuth(provider) : null,
        apiKeySource: provider?.apiKeySource ?? null,
        upstreamEndpoint:
          providerBaseUrl && provider?.api === 'openai-responses'
            ? `${providerBaseUrl}/responses`
            : providerBaseUrl
              ? `${providerBaseUrl}/chat/completions`
              : null,
        ...(route.strategy === 'direct'
          ? { upstreamModel: route.upstreamModel ?? null }
          : { members: route.members ?? [] }),
      };
    }),
  }));

  app.get('/stats/tokens/daily', async (request) => {
    const query = (request.query ?? {}) as {
      date?: string;
      model?: string;
      limit?: string | number;
    };
    const limit =
      typeof query.limit === 'number'
        ? query.limit
        : typeof query.limit === 'string' && query.limit.trim().length > 0
          ? Number(query.limit)
          : undefined;

    const items = traceStore.listDailyTokenUsage({
      ...(typeof query.date === 'string' && query.date.trim().length > 0 ? { date: query.date.trim() } : {}),
      ...(typeof query.model === 'string' && query.model.trim().length > 0 ? { model: query.model.trim() } : {}),
      ...(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });

    return {
      items,
    };
  });

  app.get('/stats/requests', async (request) => {
    const query = (request.query ?? {}) as {
      endpoint?: string;
      provider_id?: string;
      route_id?: string;
      failover_used?: string | number | boolean;
      model?: string;
      requested_model?: string;
      upstream_model?: string;
      final_classification?: string;
      committed?: string | number | boolean;
      limit?: string | number;
    };
    const limit =
      typeof query.limit === 'number'
        ? query.limit
        : typeof query.limit === 'string' && query.limit.trim().length > 0
          ? Number(query.limit)
          : undefined;

    const items = traceStore.listRequestSummaries({
      ...(typeof query.endpoint === 'string' && query.endpoint.trim().length > 0
        ? { endpoint: query.endpoint.trim() }
        : {}),
      ...(typeof query.provider_id === 'string' && query.provider_id.trim().length > 0
        ? { providerId: query.provider_id.trim() }
        : {}),
      ...(typeof query.route_id === 'string' && query.route_id.trim().length > 0
        ? { routeId: query.route_id.trim() }
        : {}),
      ...(typeof query.model === 'string' && query.model.trim().length > 0
        ? { model: query.model.trim() }
        : {}),
      ...(typeof query.requested_model === 'string' && query.requested_model.trim().length > 0
        ? { requestedModel: query.requested_model.trim() }
        : {}),
      ...(typeof query.upstream_model === 'string' && query.upstream_model.trim().length > 0
        ? { upstreamModel: query.upstream_model.trim() }
        : {}),
      ...(typeof query.final_classification === 'string' && query.final_classification.trim().length > 0
        ? { finalClassification: query.final_classification.trim() }
        : {}),
      ...(typeof parseBooleanQuery(query.failover_used) === 'boolean'
        ? { failoverUsed: parseBooleanQuery(query.failover_used) }
        : {}),
      ...(typeof parseBooleanQuery(query.committed) === 'boolean'
        ? { committed: parseBooleanQuery(query.committed) }
        : {}),
      ...(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });

    return {
      items,
    };
  });

  app.get('/stats/requests/aggregate', async (request) => {
    const query = (request.query ?? {}) as {
      endpoint?: string;
      provider_id?: string;
      route_id?: string;
      failover_used?: string | number | boolean;
      model?: string;
      requested_model?: string;
      upstream_model?: string;
      final_classification?: string;
      committed?: string | number | boolean;
      limit?: string | number;
    };
    const limit =
      typeof query.limit === 'number'
        ? query.limit
        : typeof query.limit === 'string' && query.limit.trim().length > 0
          ? Number(query.limit)
          : undefined;

    const items = traceStore.aggregateRequestSummaries({
      ...(typeof query.endpoint === 'string' && query.endpoint.trim().length > 0
        ? { endpoint: query.endpoint.trim() }
        : {}),
      ...(typeof query.provider_id === 'string' && query.provider_id.trim().length > 0
        ? { providerId: query.provider_id.trim() }
        : {}),
      ...(typeof query.route_id === 'string' && query.route_id.trim().length > 0
        ? { routeId: query.route_id.trim() }
        : {}),
      ...(typeof query.model === 'string' && query.model.trim().length > 0
        ? { model: query.model.trim() }
        : {}),
      ...(typeof query.requested_model === 'string' && query.requested_model.trim().length > 0
        ? { requestedModel: query.requested_model.trim() }
        : {}),
      ...(typeof query.upstream_model === 'string' && query.upstream_model.trim().length > 0
        ? { upstreamModel: query.upstream_model.trim() }
        : {}),
      ...(typeof query.final_classification === 'string' && query.final_classification.trim().length > 0
        ? { finalClassification: query.final_classification.trim() }
        : {}),
      ...(typeof parseBooleanQuery(query.failover_used) === 'boolean'
        ? { failoverUsed: parseBooleanQuery(query.failover_used) }
        : {}),
      ...(typeof parseBooleanQuery(query.committed) === 'boolean'
        ? { committed: parseBooleanQuery(query.committed) }
        : {}),
      ...(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });

    return {
      items,
    };
  });

  app.get('/stats/routes/health', async (request) => {
    const query = (request.query ?? {}) as {
      endpoint?: string;
      provider_id?: string;
      route_id?: string;
      failover_used?: string | number | boolean;
      model?: string;
      requested_model?: string;
      upstream_model?: string;
      final_classification?: string;
      committed?: string | number | boolean;
      limit?: string | number;
    };
    const limit =
      typeof query.limit === 'number'
        ? query.limit
        : typeof query.limit === 'string' && query.limit.trim().length > 0
          ? Number(query.limit)
          : undefined;

    const items = traceStore.listRouteHealth({
      ...(typeof query.endpoint === 'string' && query.endpoint.trim().length > 0
        ? { endpoint: query.endpoint.trim() }
        : {}),
      ...(typeof query.provider_id === 'string' && query.provider_id.trim().length > 0
        ? { providerId: query.provider_id.trim() }
        : {}),
      ...(typeof query.route_id === 'string' && query.route_id.trim().length > 0
        ? { routeId: query.route_id.trim() }
        : {}),
      ...(typeof query.model === 'string' && query.model.trim().length > 0
        ? { model: query.model.trim() }
        : {}),
      ...(typeof query.requested_model === 'string' && query.requested_model.trim().length > 0
        ? { requestedModel: query.requested_model.trim() }
        : {}),
      ...(typeof query.upstream_model === 'string' && query.upstream_model.trim().length > 0
        ? { upstreamModel: query.upstream_model.trim() }
        : {}),
      ...(typeof query.final_classification === 'string' && query.final_classification.trim().length > 0
        ? { finalClassification: query.final_classification.trim() }
        : {}),
      ...(typeof parseBooleanQuery(query.failover_used) === 'boolean'
        ? { failoverUsed: parseBooleanQuery(query.failover_used) }
        : {}),
      ...(typeof parseBooleanQuery(query.committed) === 'boolean'
        ? { committed: parseBooleanQuery(query.committed) }
        : {}),
      ...(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });

    return {
      items,
    };
  });

  app.post(
    '/v1/chat/completions',
    createChatCompletionsHandler({
      fetchUpstream,
      retryPolicy: options.retryPolicy ?? defaultRetryPolicy,
      traceStore,
      allowedModels,
      routes: routingTable.routes,
      providers: routerConfig.providers,
    }),
  );

  app.post(
    '/v1/responses',
    createResponsesHandler({
      fetchUpstream: fetchResponsesUpstream,
      retryPolicy: options.retryPolicy ?? defaultRetryPolicy,
      traceStore,
      allowedModels,
      routes: routingTable.routes,
      providers: routerConfig.providers,
    }),
  );

  return app;
}

async function main() {
  // Global error handlers to prevent process crash on uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('[Q-router] Uncaught exception:', error);
    // Log and exit gracefully; systemd will restart
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Q-router] Unhandled rejection at:', promise, 'reason:', reason);
    // Log but don't exit; let the error propagate naturally
  });

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
