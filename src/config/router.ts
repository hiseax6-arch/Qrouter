import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RouterModelEntry = {
  id: string;
  name: string;
  provider?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextWindow?: number;
  maxTokens?: number;
};

export type RouterProviderConfig = {
  api?: string;
  baseUrl?: string;
  auth?: string;
  authHeader?: boolean;
  apiKeyEnv?: string;
  apiKey?: string;
  apiKeySource?: string;
  headers?: Record<string, string>;
  models?: RouterModelEntry[];
  systemMessageHandling?: 'merge-to-first-user';
};

export type RouterRouteConfig = {
  id?: string;
  provider: string;
  aliases?: string[];
  fallbacks?: string[];
  model?: string;
  strategy?: 'direct' | 'round-robin' | 'sticky-failover';
  members?: string[];
  failbackAfterMs?: number;
  implicitAliases?: boolean;
};

export type ThinkingRewriteRule = {
  match?: string[];
  when?: {
    thinking?: string;
  };
  rewrite?: {
    thinking?: string;
    reasoning?: {
      effort?: string;
    };
  };
};

export type RouterThinkingConfig = {
  defaultMode?: 'pass-through';
  mappingsEnabled?: boolean;
  mappings?: ThinkingRewriteRule[];
};

export type RouterFileConfig = {
  server?: {
    host?: string;
    port?: number;
  };
  upstream?: {
    baseUrl?: string;
    timeoutMs?: number;
  };
  providers?: Record<string, RouterProviderConfig>;
  routes?: RouterRouteConfig[];
  models?: {
    allow?: string[];
  };
  thinking?: RouterThinkingConfig;
  traces?: {
    dir?: string;
    jsonlPath?: string;
    sqlitePath?: string;
  };
};

export type RouterMappingsFileConfig =
  | {
      routes?: RouterRouteConfig[];
      thinking?: RouterThinkingConfig;
    }
  | RouterRouteConfig[];

export type RouterRuntimeConfig = {
  configPath: string;
  routeMappingsPath?: string;
  server: {
    host: string;
    port: number;
  };
  upstream: {
    baseUrl?: string;
    apiKey?: string;
    timeoutMs: number;
  };
  providers: Record<string, RouterProviderConfig>;
  routes: RouterRouteConfig[];
  models: {
    allow: string[];
  };
  thinking: RouterThinkingConfig;
  traces: {
    dir?: string;
    jsonlPath?: string;
    sqlitePath?: string;
  };
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstDefinedEnv(...names: Array<string | undefined>): { value?: string; source?: string } {
  for (const name of names) {
    if (!name) {
      continue;
    }
    if (process.env[name] !== undefined) {
      return {
        value: process.env[name],
        source: name,
      };
    }
  }

  return {};
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    items.push(value);
  }

  return items;
}

function mergeProviderConfigs(
  baseProviders: Record<string, RouterProviderConfig> | undefined,
  overrideProviders: Record<string, RouterProviderConfig> | undefined,
): Record<string, RouterProviderConfig> | undefined {
  if (!baseProviders && !overrideProviders) {
    return undefined;
  }

  const providerIds = new Set([
    ...Object.keys(baseProviders ?? {}),
    ...Object.keys(overrideProviders ?? {}),
  ]);

  return Object.fromEntries(
    [...providerIds].map((providerId) => {
      const base = baseProviders?.[providerId];
      const override = overrideProviders?.[providerId];

      return [
        providerId,
        {
          ...(base ?? {}),
          ...(override ?? {}),
          headers: {
            ...(base?.headers ?? {}),
            ...(override?.headers ?? {}),
          },
          models: override?.models ?? base?.models,
        },
      ];
    }),
  );
}

function mergeThinkingConfig(
  baseThinking: RouterThinkingConfig | undefined,
  overrideThinking: RouterThinkingConfig | undefined,
): RouterThinkingConfig | undefined {
  if (!baseThinking && !overrideThinking) {
    return undefined;
  }

  return {
    ...(baseThinking ?? {}),
    ...(overrideThinking ?? {}),
    mappings: overrideThinking?.mappings ?? baseThinking?.mappings,
  };
}

function mergeRouterFileConfig(base: RouterFileConfig, override: RouterFileConfig): RouterFileConfig {
  return {
    ...base,
    ...override,
    server: {
      ...(base.server ?? {}),
      ...(override.server ?? {}),
    },
    upstream: {
      ...(base.upstream ?? {}),
      ...(override.upstream ?? {}),
    },
    providers: mergeProviderConfigs(base.providers, override.providers),
    routes: override.routes ?? base.routes,
    models: {
      ...(base.models ?? {}),
      ...(override.models ?? {}),
      allow: override.models?.allow ?? base.models?.allow,
    },
    thinking: mergeThinkingConfig(base.thinking, override.thinking),
    traces: {
      ...(base.traces ?? {}),
      ...(override.traces ?? {}),
    },
  };
}

function resolveProviderApiKey(
  providerId: string,
  providerConfig: RouterProviderConfig,
  fallbackUpstream: { apiKey?: string; apiKeySource?: string },
): { apiKey?: string; apiKeySource?: string } {
  const normalizedId = providerId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const envKey = `Q_${normalizedId}_API_KEY`;
  const envOverride = firstDefinedEnv(providerConfig.apiKeyEnv, envKey);
  if (envOverride.value !== undefined) {
    return {
      apiKey: envOverride.value,
      apiKeySource: envOverride.source ? `env:${envOverride.source}` : 'env',
    };
  }

  if (providerConfig.apiKey !== undefined) {
    return {
      apiKey: providerConfig.apiKey,
      apiKeySource: 'inline-config',
    };
  }

  if (providerId === 'openrouter' && fallbackUpstream.apiKey !== undefined) {
    return {
      apiKey: fallbackUpstream.apiKey,
      apiKeySource: fallbackUpstream.apiKeySource ?? 'upstream-fallback',
    };
  }

  return {};
}

function resolveProjectRelativeConfigPath(fileName = 'router.json'): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, `../../config/${fileName}`);
}

function resolveProjectRelativeMappingsPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '../../config/model-mappings.json');
}

export function resolveRouterConfigPath(): string {
  const explicit = firstDefinedEnv('Q_ROUTER_CONFIG_PATH', 'QINGFU_ROUTER_CONFIG_PATH').value;
  if (explicit) {
    return resolve(explicit);
  }

  const candidates = [
    resolve(process.cwd(), 'config/router.local.json'),
    resolve(process.cwd(), 'config/router.json'),
    resolveProjectRelativeConfigPath('router.local.json'),
    resolveProjectRelativeConfigPath('router.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return resolveProjectRelativeConfigPath('router.json');
}

export function resolveRouterMappingsPath(configPath = resolveRouterConfigPath()): string | undefined {
  const explicit = firstDefinedEnv('Q_ROUTER_MAPPINGS_PATH', 'QINGFU_ROUTER_MAPPINGS_PATH').value;
  if (explicit) {
    return resolve(explicit);
  }

  const cwdCandidate = resolve(process.cwd(), 'config/model-mappings.json');
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const siblingCandidate = resolve(dirname(configPath), 'model-mappings.json');
  if (existsSync(siblingCandidate)) {
    return siblingCandidate;
  }

  const projectConfigPath = resolveProjectRelativeConfigPath();
  if (resolve(configPath) === projectConfigPath) {
    const projectCandidate = resolveProjectRelativeMappingsPath();
    if (existsSync(projectCandidate)) {
      return projectCandidate;
    }
  }

  return undefined;
}

function readRouterFileConfig(configPath: string): RouterFileConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const primaryConfig = JSON.parse(readFileSync(configPath, 'utf8')) as RouterFileConfig;
  const localConfigPath = resolve(dirname(configPath), 'router.local.json');
  const baseConfigPath = resolve(dirname(configPath), 'router.json');

  if (
    resolve(configPath) === localConfigPath &&
    existsSync(baseConfigPath)
  ) {
    const baseConfig = JSON.parse(readFileSync(baseConfigPath, 'utf8')) as RouterFileConfig;
    return mergeRouterFileConfig(baseConfig, primaryConfig);
  }

  return primaryConfig;
}

function readRouterMappingsFileConfig(
  mappingsPath: string | undefined,
): { routes: RouterRouteConfig[]; thinking?: RouterThinkingConfig; path?: string } {
  if (!mappingsPath || !existsSync(mappingsPath)) {
    return {
      routes: [],
    };
  }

  const parsed = JSON.parse(readFileSync(mappingsPath, 'utf8')) as RouterMappingsFileConfig;
  const routes = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.routes)
      ? parsed.routes
      : [];
  const thinking =
    !Array.isArray(parsed) &&
    parsed.thinking &&
    typeof parsed.thinking === 'object'
      ? parsed.thinking
      : undefined;

  return {
    routes,
    ...(thinking ? { thinking } : {}),
    path: mappingsPath,
  };
}

export function loadRouterRuntimeConfig(): RouterRuntimeConfig {
  const configPath = resolveRouterConfigPath();
  const fileConfig = readRouterFileConfig(configPath);
  const mappingsConfig = readRouterMappingsFileConfig(resolveRouterMappingsPath(configPath));
  const configuredRoutes =
    Array.isArray(fileConfig.routes) && fileConfig.routes.length > 0
      ? fileConfig.routes
      : mappingsConfig.routes;
  const configuredAllow = fileConfig.models?.allow ?? [];
  const mappingsThinking = mappingsConfig.thinking;

  const serverHost = firstDefinedEnv('Q_ROUTER_HOST', 'QINGFU_ROUTER_HOST').value ?? fileConfig.server?.host ?? '127.0.0.1';
  const serverPort = parseNumber(
    firstDefinedEnv('Q_ROUTER_PORT', 'QINGFU_ROUTER_PORT').value,
    fileConfig.server?.port ?? 4318,
  );
  const upstreamBaseUrl = firstDefinedEnv('Q_UPSTREAM_BASE_URL', 'QINGFU_UPSTREAM_BASE_URL').value ?? fileConfig.upstream?.baseUrl;
  const upstreamApiKeyEnv = firstDefinedEnv('Q_UPSTREAM_API_KEY', 'QINGFU_UPSTREAM_API_KEY');
  const upstreamApiKey = upstreamApiKeyEnv.value;
  const upstreamTimeoutMs = parseNumber(
    firstDefinedEnv('Q_UPSTREAM_TIMEOUT_MS', 'QINGFU_UPSTREAM_TIMEOUT_MS').value,
    fileConfig.upstream?.timeoutMs ?? 45_000,
  );

  const providers = Object.fromEntries(
    Object.entries(fileConfig.providers ?? {}).map(([providerId, providerConfig]) => [
      providerId,
      (() => {
        const resolvedApiKey = resolveProviderApiKey(providerId, providerConfig, {
          apiKey: upstreamApiKey,
          apiKeySource: upstreamApiKeyEnv.source ? `env:${upstreamApiKeyEnv.source}` : undefined,
        });
        return {
          ...providerConfig,
          apiKey: resolvedApiKey.apiKey,
          apiKeySource: resolvedApiKey.apiKeySource,
        };
      })(),
    ]),
  );

  return {
    configPath,
    ...(mappingsConfig.path ? { routeMappingsPath: mappingsConfig.path } : {}),
    server: {
      host: serverHost,
      port: serverPort,
    },
    upstream: {
      baseUrl: upstreamBaseUrl,
      apiKey: upstreamApiKey,
      timeoutMs: upstreamTimeoutMs,
    },
    providers,
    routes: configuredRoutes,
    models: {
      allow:
        configuredAllow.length > 0
          ? configuredAllow
          : uniqueStrings(configuredRoutes.flatMap((route) => route.aliases ?? [])),
    },
    thinking: {
      defaultMode: mappingsThinking?.defaultMode ?? fileConfig.thinking?.defaultMode ?? 'pass-through',
      mappingsEnabled: mappingsThinking?.mappingsEnabled ?? fileConfig.thinking?.mappingsEnabled ?? true,
      mappings: mappingsThinking?.mappings ?? fileConfig.thinking?.mappings ?? [],
    },
    traces: {
      dir: firstDefinedEnv('Q_TRACE_DIR', 'QINGFU_TRACE_DIR').value ?? fileConfig.traces?.dir,
      jsonlPath: firstDefinedEnv('Q_TRACE_JSONL_PATH', 'QINGFU_TRACE_JSONL_PATH').value ?? fileConfig.traces?.jsonlPath,
      sqlitePath: firstDefinedEnv('Q_TRACE_SQLITE_PATH', 'QINGFU_TRACE_SQLITE_PATH').value ?? fileConfig.traces?.sqlitePath,
    },
  };
}
