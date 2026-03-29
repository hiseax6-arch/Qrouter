function toUnixTimestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function resolveStreamChunkModel(model: string | null | undefined): string {
  return typeof model === 'string' && model.trim().length > 0 ? model : 'qrouter-failover';
}

export function buildFailoverNotice(args: {
  requestedModel?: string | null;
  activeModel: string;
}): string {
  const requestedModel = typeof args.requestedModel === 'string' ? args.requestedModel.trim() : '';
  const requestedLabel =
    requestedModel && requestedModel !== args.activeModel ? `${requestedModel} 的主模型` : '当前主模型';

  return `\n\n[Q-router 提示] ${requestedLabel}已触发轻量级熔断，本次回复已自动切换到候选模型：${args.activeModel}。`;
}

export function appendFailoverNoticeToChatPayload(payload: unknown, notice: string | null): unknown {
  if (!notice || !payload || typeof payload !== 'object') {
    return payload;
  }

  const record = payload as { choices?: unknown[] };
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    return payload;
  }

  let changed = false;
  const nextChoices = record.choices.map((choice, index) => {
    if (index !== 0 || !choice || typeof choice !== 'object') {
      return choice;
    }

    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== 'object') {
      return choice;
    }

    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      changed = true;
      return {
        ...(choice as Record<string, unknown>),
        message: {
          ...(message as Record<string, unknown>),
          content: `${content}${notice}`,
        },
      };
    }

    if (Array.isArray(content)) {
      changed = true;
      return {
        ...(choice as Record<string, unknown>),
        message: {
          ...(message as Record<string, unknown>),
          content: [
            ...content,
            {
              type: 'text',
              text: notice.trimStart(),
            },
          ],
        },
      };
    }

    return choice;
  });

  if (!changed) {
    return payload;
  }

  return {
    ...(payload as Record<string, unknown>),
    choices: nextChoices,
  };
}

export function buildFailoverNoticeChatStreamChunk(args: {
  requestId: string;
  responseId?: string | null;
  model?: string | null;
  created?: number | null;
  notice: string;
}) {
  return `data: ${JSON.stringify({
    id: args.responseId ?? `chatcmpl_qrouter_failover_${args.requestId.replace(/-/g, '')}`,
    object: 'chat.completion.chunk',
    created:
      typeof args.created === 'number' && Number.isFinite(args.created)
        ? args.created
        : toUnixTimestampSeconds(),
    model: resolveStreamChunkModel(args.model),
    choices: [
      {
        index: 0,
        delta: {
          content: args.notice,
        },
      },
    ],
  })}\n\n`;
}
