export type OpenClawConfigLike = {
  env?: Record<string, unknown>;
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
      models?: Record<string, unknown>;
    };
  };
  models?: {
    providers?: Record<string, unknown>;
  };
};

export type QingfuIntegrationOptions = {
  routerBaseUrl?: string;
  routerApiKeyEnvVar?: string;
  upstreamModelId?: string;
  providerId?: string;
  preserveCurrentPrimaryAsFallback?: boolean;
  cleanupRouterEnvVarOnRollback?: boolean;
};

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getNextPrimary(options: QingfuIntegrationOptions = {}): string {
  const providerId = options.providerId ?? 'qingfuCodex';
  const upstreamModelId = options.upstreamModelId ?? 'gpt-5.4';
  return `${providerId}/${upstreamModelId}`;
}

export function applyQingfuRouterIntegration(
  input: OpenClawConfigLike,
  options: QingfuIntegrationOptions = {},
): OpenClawConfigLike {
  const providerId = options.providerId ?? 'qingfuCodex';
  const upstreamModelId = options.upstreamModelId ?? 'gpt-5.4';
  const routerBaseUrl = options.routerBaseUrl ?? 'http://127.0.0.1:4318/v1';
  const routerApiKeyEnvVar = options.routerApiKeyEnvVar ?? 'Q_ROUTER_API_KEY';
  const next = cloneConfig(input ?? {});

  next.env = { ...(next.env ?? {}) };
  if (!(routerApiKeyEnvVar in next.env)) {
    next.env[routerApiKeyEnvVar] = 'local-dev-key';
  }

  next.models = { ...(next.models ?? {}) };
  const providers = { ...((next.models.providers as Record<string, unknown> | undefined) ?? {}) };
  providers[providerId] = {
    api: 'openai-completions',
    auth: 'api-key',
    apiKey: `\${${routerApiKeyEnvVar}}`,
    authHeader: true,
    baseUrl: routerBaseUrl,
    models: [{ id: upstreamModelId, name: 'GPT-5.4 via Qingfu Router' }],
  };
  next.models.providers = providers;

  next.agents = { ...(next.agents ?? {}) };
  next.agents.defaults = { ...(next.agents.defaults ?? {}) };
  const currentPrimary = next.agents.defaults.model?.primary;
  const nextPrimary = getNextPrimary(options);
  const fallbacks = [...(next.agents.defaults.model?.fallbacks ?? [])];

  if (
    options.preserveCurrentPrimaryAsFallback !== false &&
    typeof currentPrimary === 'string' &&
    currentPrimary.length > 0 &&
    currentPrimary !== nextPrimary &&
    !fallbacks.includes(currentPrimary)
  ) {
    fallbacks.unshift(currentPrimary);
  }

  next.agents.defaults.model = {
    ...(next.agents.defaults.model ?? {}),
    primary: nextPrimary,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };

  next.agents.defaults.models = {
    ...(next.agents.defaults.models ?? {}),
    [nextPrimary]: {
      alias: 'GPT-5.4 via Qingfu Router',
    },
  };

  return next;
}

export function rollbackQingfuRouterIntegration(
  input: OpenClawConfigLike,
  options: QingfuIntegrationOptions = {},
): OpenClawConfigLike {
  const providerId = options.providerId ?? 'qingfuCodex';
  const routerApiKeyEnvVar = options.routerApiKeyEnvVar ?? 'Q_ROUTER_API_KEY';
  const nextPrimary = getNextPrimary(options);
  const next = cloneConfig(input ?? {});

  if (next.models?.providers && typeof next.models.providers === 'object') {
    const providers = { ...(next.models.providers as Record<string, unknown>) };
    delete providers[providerId];
    next.models = { ...(next.models ?? {}), providers };
  }

  const defaults = next.agents?.defaults;
  const modelConfig = defaults?.model;
  if (modelConfig) {
    const fallbacks = [...(modelConfig.fallbacks ?? [])].filter((entry) => entry !== nextPrimary);
    const currentPrimary = modelConfig.primary;
    let restoredPrimary = currentPrimary;

    if (currentPrimary === nextPrimary) {
      restoredPrimary = fallbacks[0] ?? undefined;
    }

    const remainingFallbacks = fallbacks.filter((entry) => entry !== restoredPrimary);

    next.agents = { ...(next.agents ?? {}) };
    next.agents.defaults = { ...(next.agents?.defaults ?? {}) };
    next.agents.defaults.model = {
      ...(next.agents.defaults.model ?? {}),
      ...(restoredPrimary ? { primary: restoredPrimary } : {}),
      ...(remainingFallbacks.length > 0 ? { fallbacks: remainingFallbacks } : { fallbacks: [] }),
    };
  }

  if (next.agents?.defaults?.models && typeof next.agents.defaults.models === 'object') {
    const models = { ...(next.agents.defaults.models as Record<string, unknown>) };
    delete models[nextPrimary];
    next.agents.defaults.models = models;
  }

  if (options.cleanupRouterEnvVarOnRollback && next.env) {
    const env = { ...next.env };
    delete env[routerApiKeyEnvVar];
    next.env = env;
  }

  return next;
}

export function summarizeQingfuIntegration(config: OpenClawConfigLike, providerId = 'qingfuCodex') {
  const provider = (config.models?.providers as Record<string, any> | undefined)?.[providerId] ?? null;
  return {
    primary: config.agents?.defaults?.model?.primary ?? null,
    fallbacks: config.agents?.defaults?.model?.fallbacks ?? [],
    providerId,
    providerApi: provider?.api ?? null,
    providerBaseUrl: provider?.baseUrl ?? null,
    providerModelIds: Array.isArray(provider?.models)
      ? provider.models.map((m: any) => m?.id).filter(Boolean)
      : [],
  };
}

export function diffQingfuIntegrationPaths(
  before: OpenClawConfigLike,
  after: OpenClawConfigLike,
  providerId = 'qingfuCodex',
) {
  const changed: string[] = [];
  const beforePrimary = before.agents?.defaults?.model?.primary ?? null;
  const afterPrimary = after.agents?.defaults?.model?.primary ?? null;
  if (beforePrimary !== afterPrimary) {
    changed.push('agents.defaults.model.primary');
  }

  const beforeFallbacks = JSON.stringify(before.agents?.defaults?.model?.fallbacks ?? []);
  const afterFallbacks = JSON.stringify(after.agents?.defaults?.model?.fallbacks ?? []);
  if (beforeFallbacks !== afterFallbacks) {
    changed.push('agents.defaults.model.fallbacks');
  }

  const beforeProvider = (before.models?.providers as Record<string, unknown> | undefined)?.[providerId];
  const afterProvider = (after.models?.providers as Record<string, unknown> | undefined)?.[providerId];
  if (JSON.stringify(beforeProvider ?? null) !== JSON.stringify(afterProvider ?? null)) {
    changed.push(`models.providers.${providerId}`);
  }

  const beforeAlias = (before.agents?.defaults?.models as Record<string, unknown> | undefined)?.[`${providerId}/gpt-5.4`];
  const afterAlias = (after.agents?.defaults?.models as Record<string, unknown> | undefined)?.[`${providerId}/gpt-5.4`];
  if (JSON.stringify(beforeAlias ?? null) !== JSON.stringify(afterAlias ?? null)) {
    changed.push(`agents.defaults.models.${providerId}/gpt-5.4`);
  }

  const beforeEnv = before.env?.Q_ROUTER_API_KEY ?? null;
  const afterEnv = after.env?.Q_ROUTER_API_KEY ?? null;
  if (beforeEnv !== afterEnv) {
    changed.push('env.Q_ROUTER_API_KEY');
  }

  return changed;
}
