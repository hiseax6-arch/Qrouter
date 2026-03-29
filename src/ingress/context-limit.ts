import type { RouterProviderConfig } from '../config/router.js';
import type { CompiledRoute } from '../routing/routes.js';
import { resolveDirectRoute } from '../routing/routes.js';

type ContextLimitHit = {
  providerId?: string;
  routeId?: string;
  requestedModel: string;
  normalizedModel: string;
  contextWindow: number;
  estimatedInputTokens: number;
  message?: string;
};

type RequestLike = Record<string, unknown>;

function stripLrPrefix(model: string): string {
  return model.startsWith('LR/') ? model.slice(3) : model;
}

function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function estimateUnknown(value: unknown): number {
  if (value == null) {
    return 0;
  }
  if (typeof value === 'string') {
    return estimateTextTokens(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return estimateTextTokens(String(value));
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateUnknown(item), 0);
  }
  if (typeof value === 'object') {
    return estimateTextTokens(JSON.stringify(value));
  }
  return 0;
}

function estimateChatMessagesTokens(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }

  let total = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      total += estimateUnknown(message);
      continue;
    }

    const record = message as Record<string, unknown>;
    total += 4;
    total += estimateUnknown(record.role);
    total += estimateUnknown(record.name);
    total += estimateUnknown(record.content);
    total += estimateUnknown(record.tool_calls);
    total += estimateUnknown(record.tool_call_id);
  }

  return total;
}

function estimateResponsesInputTokens(input: unknown): number {
  if (typeof input === 'string') {
    return estimateTextTokens(input);
  }
  if (Array.isArray(input)) {
    return input.reduce((sum, item) => sum + estimateUnknown(item) + 4, 0);
  }
  return estimateUnknown(input);
}

function estimateToolsTokens(tools: unknown): number {
  if (!Array.isArray(tools)) {
    return 0;
  }
  return tools.reduce((sum, tool) => sum + estimateUnknown(tool), 0);
}

function findModelEntry(
  requestedModel: string,
  providers: Record<string, RouterProviderConfig>,
  routes?: readonly CompiledRoute[],
): {
  providerId?: string;
  routeId?: string;
  normalizedModel: string;
  contextWindow?: number;
} {
  const directRoute = routes ? resolveDirectRoute(requestedModel, routes) : null;
  if (directRoute) {
    const provider = providers[directRoute.providerId];
    const entry = provider?.models?.find((model) => model.id === directRoute.upstreamModel);
    return {
      providerId: directRoute.providerId,
      routeId: directRoute.route.id,
      normalizedModel: directRoute.upstreamModel,
      contextWindow: entry?.contextWindow,
    };
  }

  const normalizedModel = stripLrPrefix(requestedModel);
  for (const [providerId, provider] of Object.entries(providers)) {
    const entry = provider.models?.find((model) => {
      const id = model.id;
      return id === requestedModel || id === normalizedModel || `${providerId}/${id}` === requestedModel;
    });
    if (entry) {
      return {
        providerId,
        normalizedModel: stripLrPrefix(entry.id),
        contextWindow: entry.contextWindow,
      };
    }
  }

  return {
    normalizedModel,
  };
}

export function checkContextLimit(args: {
  body: RequestLike;
  providers: Record<string, RouterProviderConfig>;
  routes?: readonly CompiledRoute[];
  endpoint: 'chat.completions' | 'responses';
}): ContextLimitHit | null {
  const requestedModel = typeof args.body.model === 'string' ? args.body.model : '';
  if (!requestedModel) {
    return null;
  }

  const modelInfo = findModelEntry(requestedModel, args.providers, args.routes);
  const contextWindow = modelInfo.contextWindow;
  if (!contextWindow || contextWindow <= 0) {
    return null;
  }

  const estimatedInputTokens = args.endpoint === 'chat.completions'
    ? estimateChatMessagesTokens(args.body.messages)
      + estimateToolsTokens(args.body.tools)
    : estimateResponsesInputTokens(args.body.input)
      + estimateToolsTokens(args.body.tools);

  if (estimatedInputTokens <= contextWindow) {
    return null;
  }

  return {
    providerId: modelInfo.providerId,
    routeId: modelInfo.routeId,
    requestedModel,
    normalizedModel: modelInfo.normalizedModel,
    contextWindow,
    estimatedInputTokens,
    message: `Estimated input tokens ${estimatedInputTokens} exceed configured context window ${contextWindow} for model ${modelInfo.normalizedModel}.`,
  };
}

export function buildContextLimitErrorPayload(args: ContextLimitHit & { requestId: string }) {
  return {
    error: {
      type: 'context_window_exceeded',
      message: args.message,
      request_id: args.requestId,
      model: args.requestedModel,
      normalized_model: args.normalizedModel,
      estimated_input_tokens: args.estimatedInputTokens,
      context_window: args.contextWindow,
      ...(args.providerId ? { provider_id: args.providerId } : {}),
      ...(args.routeId ? { route_id: args.routeId } : {}),
    },
  };
}
