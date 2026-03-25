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
  apiKey?: string;
  headers?: Record<string, string>;
  models?: RouterModelEntry[];
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

export type RouterRuntimeConfig = {
  configPath: string;
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

function resolveProviderApiKey(
  providerId: string,
  providerConfig: RouterProviderConfig,
  fallbackUpstreamApiKey?: string,
): string | undefined {
  const normalizedId = providerId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const envKey = `Q_${normalizedId}_API_KEY`;
  return process.env[envKey] ?? providerConfig.apiKey ?? (providerId === 'openrouter' ? fallbackUpstreamApiKey : undefined);
}

function resolveProjectRelativeConfigPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '../../config/router.json');
}

export function resolveRouterConfigPath(): string {
  const explicit = process.env.Q_ROUTER_CONFIG_PATH;
  if (explicit) {
    return resolve(explicit);
  }

  const cwdCandidate = resolve(process.cwd(), 'config/router.json');
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  return resolveProjectRelativeConfigPath();
}

function readRouterFileConfig(configPath: string): RouterFileConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(readFileSync(configPath, 'utf8')) as RouterFileConfig;
}

export function loadRouterRuntimeConfig(): RouterRuntimeConfig {
  const configPath = resolveRouterConfigPath();
  const fileConfig = readRouterFileConfig(configPath);

  const serverHost = process.env.Q_ROUTER_HOST ?? fileConfig.server?.host ?? '127.0.0.1';
  const serverPort = parseNumber(process.env.Q_ROUTER_PORT, fileConfig.server?.port ?? 4318);
  const upstreamBaseUrl = process.env.Q_UPSTREAM_BASE_URL ?? fileConfig.upstream?.baseUrl;
  const upstreamApiKey = process.env.Q_UPSTREAM_API_KEY;
  const upstreamTimeoutMs = parseNumber(
    process.env.Q_UPSTREAM_TIMEOUT_MS,
    fileConfig.upstream?.timeoutMs ?? 45_000,
  );

  const providers = Object.fromEntries(
    Object.entries(fileConfig.providers ?? {}).map(([providerId, providerConfig]) => [
      providerId,
      {
        ...providerConfig,
        apiKey: resolveProviderApiKey(providerId, providerConfig, upstreamApiKey),
      },
    ]),
  );

  return {
    configPath,
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
    models: {
      allow: fileConfig.models?.allow ?? [],
    },
    thinking: {
      defaultMode: fileConfig.thinking?.defaultMode ?? 'pass-through',
      mappings: fileConfig.thinking?.mappings ?? [],
    },
    traces: {
      dir: process.env.Q_TRACE_DIR ?? fileConfig.traces?.dir,
      jsonlPath: process.env.Q_TRACE_JSONL_PATH ?? fileConfig.traces?.jsonlPath,
      sqlitePath: process.env.Q_TRACE_SQLITE_PATH ?? fileConfig.traces?.sqlitePath,
    },
  };
}
