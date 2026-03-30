import type { RouterProviderConfig, RouterRouteConfig, RouterRuntimeConfig } from '../config/router.js';

export const LEGACY_MODELSCOPE_ROUTE_ALIASES = ['LR/ms', 'ms'] as const;
export const LEGACY_MODELSCOPE_MODEL_POOL = [
  'MiniMax/MiniMax-M2.5',
  'ZhipuAI/GLM-5',
  'Qwen/Qwen3-235B-A22B',
  'moonshotai/Kimi-K2.5',
] as const;

export type CompiledRoute = {
  id: string;
  source: 'explicit' | 'legacy';
  providerId: string;
  aliases: string[];
  fallbackAliases?: string[];
  strategy: 'direct' | 'round-robin' | 'sticky-failover';
  upstreamModel?: string;
  members?: string[];
  failbackAfterMs?: number;
};

export type CompiledRoutingTable = {
  routes: CompiledRoute[];
  warnings: string[];
};

export type RouteSelection = {
  route: CompiledRoute;
  providerId: string;
  upstreamModel: string;
};

export type RoundRobinRouteSelection = {
  route: CompiledRoute;
  providerId: string;
  upstreamModel: string;
  memberIndex: number;
};

const DEFAULT_STICKY_FAILBACK_AFTER_MS = 300_000;

const roundRobinRouteOffsets = new Map<string, number>();
const stickyFailoverRouteOffsets = new Map<string, { memberIndex: number; changedAt: number }>();

function stripLrPrefix(model: string): string {
  return model.startsWith('LR/') ? model.slice(3) : model;
}

function stripProviderPrefix(modelId: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function withProviderPrefix(providerId: string, modelId: string): string {
  return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
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

function defaultRouteFallbackAlias(route: CompiledRoute): string | null {
  return route.aliases[0] ?? null;
}

function withDefaultFallbackAliases(routes: CompiledRoute[]): CompiledRoute[] {
  const canonicalAliases = routes.map((route) => ({
    routeId: route.id,
    alias: defaultRouteFallbackAlias(route),
  }));

  return routes.map((route) => {
    const automaticFallbacks = canonicalAliases
      .filter((candidate) => candidate.routeId !== route.id)
      .map((candidate) => candidate.alias);

    return {
      ...route,
      fallbackAliases: uniqueStrings([
        ...(route.fallbackAliases ?? []),
        ...automaticFallbacks,
      ]).filter((alias) => !route.aliases.includes(alias)),
    };
  });
}

function defaultExplicitRouteId(route: RouterRouteConfig, index: number): string {
  if (route.id) {
    return route.id;
  }

  const strategy = route.strategy ?? 'direct';
  if (strategy === 'round-robin') {
    return `${route.provider}:round-robin:${index}`;
  }
  if (strategy === 'sticky-failover') {
    return `${route.provider}:sticky-failover:${index}`;
  }

  return `${route.provider}:${route.model ?? index}`;
}

function buildExplicitRoute(route: RouterRouteConfig, index: number): CompiledRoute {
  const strategy = route.strategy ?? 'direct';
  const model = route.model ? stripProviderPrefix(route.model, route.provider) : undefined;

  if (strategy === 'round-robin' || strategy === 'sticky-failover') {
    return {
      id: defaultExplicitRouteId(route, index),
      source: 'explicit',
      providerId: route.provider,
      aliases: uniqueStrings(route.aliases ?? []),
      fallbackAliases: uniqueStrings(route.fallbacks ?? []),
      strategy,
      members: uniqueStrings((route.members ?? []).map((member) => stripProviderPrefix(member, route.provider))),
      ...(typeof route.failbackAfterMs === 'number' ? { failbackAfterMs: route.failbackAfterMs } : {}),
    };
  }

  return {
    id: defaultExplicitRouteId(route, index),
    source: 'explicit',
    providerId: route.provider,
    aliases: uniqueStrings([
      ...(route.aliases ?? []),
      model,
      model ? withProviderPrefix(route.provider, model) : undefined,
    ]),
    fallbackAliases: uniqueStrings(route.fallbacks ?? []),
    strategy,
    upstreamModel: model,
    ...(typeof route.failbackAfterMs === 'number' ? { failbackAfterMs: route.failbackAfterMs } : {}),
  };
}

function buildLegacyRoutes(
  providers: Record<string, RouterProviderConfig>,
  allowList: string[],
): CompiledRoute[] {
  const routes: CompiledRoute[] = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    for (const modelEntry of provider.models ?? []) {
      const configuredModel = modelEntry.id;
      const upstreamModel = stripProviderPrefix(configuredModel, providerId);
      const allowAliases = allowList.filter((allowed) => {
        const normalized = stripLrPrefix(allowed);
        return (
          allowed === configuredModel ||
          allowed === upstreamModel ||
          normalized === configuredModel ||
          normalized === upstreamModel
        );
      });

      routes.push({
        id: `${providerId}:${upstreamModel}`,
        source: 'legacy',
        providerId,
        aliases: uniqueStrings([
          configuredModel,
          upstreamModel,
          withProviderPrefix(providerId, configuredModel),
          withProviderPrefix(providerId, upstreamModel),
          ...allowAliases,
        ]),
        fallbackAliases: [],
        strategy: 'direct',
        upstreamModel,
      });
    }
  }

  if (allowList.includes('LR/ms')) {
    const modelscopeProvider = providers.modelscope;
    const availableMembers = new Set((modelscopeProvider?.models ?? []).map((entry) => entry.id));
    const members = LEGACY_MODELSCOPE_MODEL_POOL.filter((member) => availableMembers.has(member));
    if (members.length > 0) {
      routes.push({
        id: 'legacy:modelscope:ms',
        source: 'legacy',
        providerId: 'modelscope',
        aliases: [...LEGACY_MODELSCOPE_ROUTE_ALIASES],
        fallbackAliases: [],
        strategy: 'sticky-failover',
        members: [...members],
      });
    }
  }

  return routes;
}

export function compileRoutingTable(config: Pick<RouterRuntimeConfig, 'providers' | 'routes' | 'models'>): CompiledRoutingTable {
  const explicitRoutes = config.routes ?? [];
  const warnings: string[] = [];
  const routes = withDefaultFallbackAliases(
    explicitRoutes.length > 0
      ? explicitRoutes.map((route, index) => buildExplicitRoute(route, index))
      : buildLegacyRoutes(config.providers, config.models.allow),
  );

  const aliasOwners = new Map<string, string[]>();
  for (const route of routes) {
    if (!(route.providerId in config.providers)) {
      warnings.push(`Route "${route.id}" references missing provider "${route.providerId}".`);
    }

    if (route.strategy === 'direct' && !route.upstreamModel) {
      warnings.push(`Route "${route.id}" is missing upstreamModel.`);
    }

    if ((route.strategy === 'round-robin' || route.strategy === 'sticky-failover') && (!route.members || route.members.length === 0)) {
      warnings.push(`Route "${route.id}" has no multi-model members.`);
    }

    for (const alias of route.aliases) {
      const owners = aliasOwners.get(alias) ?? [];
      owners.push(route.id);
      aliasOwners.set(alias, owners);
    }
  }

  for (const [alias, owners] of aliasOwners.entries()) {
    if (owners.length > 1) {
      warnings.push(`Alias "${alias}" is claimed by multiple routes: ${owners.join(', ')}.`);
    }
  }

  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider.apiKeySource === 'inline-config') {
      warnings.push(`Provider "${providerId}" uses inline apiKey in config; prefer apiKeyEnv or environment variables.`);
    }
  }

  return {
    routes,
    warnings,
  };
}

export function resolveRoute(model: unknown, routes: readonly CompiledRoute[]): CompiledRoute | null {
  if (typeof model !== 'string' || model.length === 0) {
    return null;
  }

  const candidates = uniqueStrings([model, stripLrPrefix(model)]);
  for (const candidate of candidates) {
    const route = routes.find((entry) => entry.aliases.includes(candidate));
    if (route) {
      return route;
    }
  }

  return null;
}

export function resolveDirectRoute(model: unknown, routes: readonly CompiledRoute[]): RouteSelection | null {
  const route = resolveRoute(model, routes);
  if (!route || route.strategy !== 'direct' || !route.upstreamModel) {
    return null;
  }

  return {
    route,
    providerId: route.providerId,
    upstreamModel: route.upstreamModel,
  };
}

export function selectRoundRobinRoute(model: unknown, routes: readonly CompiledRoute[]): RoundRobinRouteSelection | null {
  const route = resolveRoute(model, routes);
  if (!route || route.strategy !== 'round-robin' || !route.members || route.members.length === 0) {
    return null;
  }

  const currentOffset = roundRobinRouteOffsets.get(route.id) ?? 0;
  const memberIndex = currentOffset % route.members.length;
  roundRobinRouteOffsets.set(route.id, (memberIndex + 1) % route.members.length);

  return {
    route,
    providerId: route.providerId,
    upstreamModel: route.members[memberIndex],
    memberIndex,
  };
}

export function selectStickyFailoverRoute(
  model: unknown,
  routes: readonly CompiledRoute[],
): RoundRobinRouteSelection | null {
  const route = resolveRoute(model, routes);
  if (!route || route.strategy !== 'sticky-failover' || !route.members || route.members.length === 0) {
    return null;
  }

  const state = stickyFailoverRouteOffsets.get(route.id);
  const failbackAfterMs = route.failbackAfterMs ?? DEFAULT_STICKY_FAILBACK_AFTER_MS;
  const shouldFailback =
    !!state
    && state.memberIndex !== 0
    && failbackAfterMs >= 0
    && (Date.now() - state.changedAt) >= failbackAfterMs;
  const memberIndex = shouldFailback
    ? 0
    : (state?.memberIndex ?? 0) % route.members.length;

  if (shouldFailback) {
    stickyFailoverRouteOffsets.set(route.id, {
      memberIndex: 0,
      changedAt: Date.now(),
    });
  }

  return {
    route,
    providerId: route.providerId,
    upstreamModel: route.members[memberIndex],
    memberIndex,
  };
}

export function rotateRoundRobinRoute(
  route: CompiledRoute,
  currentMemberIndex: number,
): RoundRobinRouteSelection | null {
  if (route.strategy !== 'round-robin' || !route.members || route.members.length === 0) {
    return null;
  }

  const memberIndex = (currentMemberIndex + 1) % route.members.length;
  return {
    route,
    providerId: route.providerId,
    upstreamModel: route.members[memberIndex],
    memberIndex,
  };
}

export function advanceStickyFailoverRoute(
  route: CompiledRoute,
  currentMemberIndex: number,
): RoundRobinRouteSelection | null {
  if (route.strategy !== 'sticky-failover' || !route.members || route.members.length === 0) {
    return null;
  }

  const memberIndex = (currentMemberIndex + 1) % route.members.length;
  stickyFailoverRouteOffsets.set(route.id, {
    memberIndex,
    changedAt: Date.now(),
  });

  return {
    route,
    providerId: route.providerId,
    upstreamModel: route.members[memberIndex],
    memberIndex,
  };
}

export function setStickyFailoverRouteMember(
  route: CompiledRoute,
  memberIndex: number,
): void {
  if (route.strategy !== 'sticky-failover' || !route.members || route.members.length === 0) {
    return;
  }

  stickyFailoverRouteOffsets.set(route.id, {
    memberIndex: memberIndex % route.members.length,
    changedAt: Date.now(),
  });
}

export function resetRoutingState(): void {
  roundRobinRouteOffsets.clear();
  stickyFailoverRouteOffsets.clear();
}

export function describeProviderAuth(provider: RouterProviderConfig): string {
  if (!provider.apiKey) {
    return 'none';
  }

  if (provider.authHeader === false && provider.auth === 'api-key') {
    return 'x-api-key';
  }

  if (provider.auth === 'token' || provider.auth === 'oauth' || provider.authHeader === true) {
    return 'bearer';
  }

  if (provider.auth === 'api-key') {
    return 'x-api-key';
  }

  return 'bearer';
}
