export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type TokenUsageRecord = Record<string, unknown>;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readUsageField(usage: TokenUsageRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(usage[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

export function extractTokenUsageFromPayload(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const usageRecord = usage as TokenUsageRecord;
  const promptTokens = readUsageField(usageRecord, [
    'prompt_tokens',
    'input_tokens',
    'promptTokens',
    'inputTokens',
  ]);
  const completionTokens = readUsageField(usageRecord, [
    'completion_tokens',
    'output_tokens',
    'completionTokens',
    'outputTokens',
  ]);
  const totalTokens = readUsageField(usageRecord, ['total_tokens', 'totalTokens']);

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }

  const normalizedPromptTokens = promptTokens ?? 0;
  const normalizedCompletionTokens = completionTokens ?? 0;
  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: totalTokens ?? normalizedPromptTokens + normalizedCompletionTokens,
  };
}

export function mergeTokenUsage(current: TokenUsage | null, next: TokenUsage | null): TokenUsage | null {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }

  return {
    promptTokens: Math.max(current.promptTokens, next.promptTokens),
    completionTokens: Math.max(current.completionTokens, next.completionTokens),
    totalTokens: Math.max(current.totalTokens, next.totalTokens),
  };
}

export function sumTokenUsage(current: TokenUsage | null, next: TokenUsage | null): TokenUsage | null {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }

  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
  };
}

export function toChatCompletionUsage(usage: TokenUsage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}
