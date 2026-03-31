export type SemanticClassification =
  | { kind: 'semantic_success'; reason: 'text' | 'tool_call' | 'refusal' | 'audio' }
  | { kind: 'empty_success'; reason: 'no_semantic_payload'; retryable: true };

type ChatCompletionSemanticCarrier = {
  role?: string;
  content?: unknown;
  refusal?: unknown;
  tool_calls?: Array<unknown>;
  audio?: {
    data?: unknown;
    format?: unknown;
    voice?: unknown;
    transcript?: unknown;
  } | null;
};

type ChatCompletionChoice = {
  message?: ChatCompletionSemanticCarrier;
  delta?: ChatCompletionSemanticCarrier;
};

type ChatCompletionResponseLike = {
  choices?: Array<ChatCompletionChoice>;
};

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasTextContent(content: unknown): boolean {
  if (hasNonEmptyString(content)) {
    return true;
  }

  if (Array.isArray(content)) {
    return content.some((part) => {
      if (typeof part === 'string') {
        return part.trim().length > 0;
      }

      if (part && typeof part === 'object' && 'text' in part) {
        return hasNonEmptyString((part as { text?: unknown }).text);
      }

      return false;
    });
  }

  return false;
}

function hasAudioPayload(audio: ChatCompletionSemanticCarrier['audio']): boolean {
  if (!audio || typeof audio !== 'object') {
    return false;
  }

  return hasNonEmptyString(audio.data)
    || hasNonEmptyString(audio.transcript)
    || hasNonEmptyString(audio.format)
    || hasNonEmptyString(audio.voice);
}

function classifySemanticCarrier(
  carrier?: ChatCompletionSemanticCarrier,
): SemanticClassification | null {
  if (!carrier) {
    return null;
  }

  if (Array.isArray(carrier.tool_calls) && carrier.tool_calls.length > 0) {
    return { kind: 'semantic_success', reason: 'tool_call' };
  }

  if (hasTextContent(carrier.content)) {
    return { kind: 'semantic_success', reason: 'text' };
  }

  if (hasAudioPayload(carrier.audio)) {
    return { kind: 'semantic_success', reason: 'audio' };
  }

  if (hasNonEmptyString(carrier.refusal)) {
    return { kind: 'semantic_success', reason: 'refusal' };
  }

  return null;
}

export function classifyChatCompletionResult(
  response: ChatCompletionResponseLike,
): SemanticClassification {
  const choices = Array.isArray(response.choices) ? response.choices : [];

  for (const choice of choices) {
    const classification = classifySemanticCarrier(choice?.message);
    if (classification) {
      return classification;
    }
  }

  return {
    kind: 'empty_success',
    reason: 'no_semantic_payload',
    retryable: true,
  };
}

export function classifyChatCompletionChunk(
  chunk: ChatCompletionResponseLike,
): SemanticClassification {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];

  for (const choice of choices) {
    const classification = classifySemanticCarrier(choice?.delta);
    if (classification) {
      return classification;
    }
  }

  return {
    kind: 'empty_success',
    reason: 'no_semantic_payload',
    retryable: true,
  };
}
