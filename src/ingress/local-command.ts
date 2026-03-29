import { appendResponsesQrouterMetadata } from '../observability/qrouter.js';

type InterceptedLocalCommand = {
  commandName: string;
  commandText: string;
};

type LocalCommandReplyArgs = {
  requestId: string;
  model?: string | null;
  commandName: string;
  commandText: string;
};

const KNOWN_OPENCLAW_COMMANDS = new Set([
  'help',
  'commands',
  'skill',
  'status',
  'allowlist',
  'approve',
  'context',
  'btw',
  'export-session',
  'export',
  'tts',
  'agent',
  'agents',
  'session',
  'sessions',
  'focus',
  'unfocus',
  'kill',
  'steer',
  'tell',
  'config',
  'mcp',
  'plugins',
  'restart',
  'activation',
  'send',
  'reset',
  'new',
  'compact',
  'think',
  'thinking',
  't',
  'verbose',
  'v',
  'fast',
  'reasoning',
  'reason',
  'elevated',
  'elev',
  'exec',
  'model',
  'models',
  'bash',
  'subagents',
  'acp',
  'whoami',
  'id',
  'settings',
  'exit',
  'quit',
]);

function resolveReplyModel(model: string | null | undefined): string {
  return typeof model === 'string' && model.trim().length > 0 ? model : 'qrouter-local-command';
}

function toUnixTimestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = content.flatMap((part) => {
    if (typeof part === 'string') {
      return [part];
    }

    if (
      part &&
      typeof part === 'object' &&
      'text' in part &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      return [String((part as { text: string }).text)];
    }

    return [];
  });

  return parts.join('\n');
}

function detectSlashCommandFromText(text: string): InterceptedLocalCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const [head] = trimmed.split(/\s+/, 1);
  const commandName = head.slice(1).toLowerCase();
  if (!commandName) {
    return null;
  }

  if (
    !KNOWN_OPENCLAW_COMMANDS.has(commandName) &&
    !commandName.startsWith('dock-') &&
    !commandName.startsWith('dock_')
  ) {
    return null;
  }

  return {
    commandName,
    commandText: head,
  };
}

function resolveCommandHint(commandName: string): string {
  if (commandName === 'agents' || commandName === 'agent') {
    return '该命令需要由 OpenClaw 本地会话管理层处理，Q-router 无法直接列出或切换 agent。';
  }

  if (commandName === 'sessions' || commandName === 'session') {
    return '该命令需要由 OpenClaw 本地会话管理层处理，Q-router 无法直接列出或切换 session。';
  }

  if (commandName === 'model' || commandName === 'models') {
    return '该命令用于 OpenClaw 本地模型切换/选择，不应转发到上游模型。';
  }

  return '这类 slash command 应由 OpenClaw 本地或 Gateway 处理，不应转发到上游模型。';
}

function buildLocalCommandMessage(args: LocalCommandReplyArgs): string {
  return `检测到 OpenClaw/CLI 命令 ${args.commandText}。${resolveCommandHint(args.commandName)} Q-router 已在本地拦截该命令，请在 OpenClaw 界面直接执行；如果你想让模型解释这个命令，请改用自然语言提问。请求号：${args.requestId}`;
}

export function detectChatLocalCommand(messages: unknown): InterceptedLocalCommand | null {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') {
      continue;
    }

    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== 'user') {
      continue;
    }

    const detected = detectSlashCommandFromText(extractTextContent(record.content));
    if (detected) {
      return detected;
    }
  }

  return null;
}

export function detectResponsesLocalCommand(input: unknown): InterceptedLocalCommand | null {
  if (typeof input === 'string') {
    return detectSlashCommandFromText(input);
  }

  if (!Array.isArray(input)) {
    return null;
  }

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as {
      type?: unknown;
      role?: unknown;
      text?: unknown;
      content?: unknown;
    };

    if (record.type === 'input_text' && typeof record.text === 'string') {
      const detected = detectSlashCommandFromText(record.text);
      if (detected) {
        return detected;
      }
    }

    if (record.role !== 'user') {
      continue;
    }

    const detected = detectSlashCommandFromText(extractTextContent(record.content));
    if (detected) {
      return detected;
    }
  }

  return null;
}

function buildChatCompletionBase(args: LocalCommandReplyArgs) {
  const model = resolveReplyModel(args.model);
  const id = `chatcmpl_qrouter_command_${args.requestId.replace(/-/g, '')}`;
  const content = buildLocalCommandMessage(args);

  return {
    id,
    created: toUnixTimestampSeconds(),
    model,
    content,
  };
}

export function buildLocalCommandChatCompletion(args: LocalCommandReplyArgs) {
  const base = buildChatCompletionBase(args);
  return {
    id: base.id,
    object: 'chat.completion',
    created: base.created,
    model: base.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: base.content,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

export function buildLocalCommandChatCompletionStream(args: LocalCommandReplyArgs): string {
  const base = buildChatCompletionBase(args);
  return [
    `data: ${JSON.stringify({
      id: base.id,
      object: 'chat.completion.chunk',
      created: base.created,
      model: base.model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: base.content,
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: base.id,
      object: 'chat.completion.chunk',
      created: base.created,
      model: base.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function buildResponsesBase(args: LocalCommandReplyArgs) {
  const model = resolveReplyModel(args.model);
  const responseId = `resp_qrouter_command_${args.requestId.replace(/-/g, '')}`;
  const messageId = `msg_qrouter_command_${args.requestId.replace(/-/g, '')}`;
  const createdAt = toUnixTimestampSeconds();
  const text = buildLocalCommandMessage(args);

  return {
    responseId,
    messageId,
    createdAt,
    model,
    text,
  };
}

export function buildLocalCommandResponsesPayload(args: LocalCommandReplyArgs) {
  const base = buildResponsesBase(args);
  return appendResponsesQrouterMetadata({
    id: base.responseId,
    object: 'response',
    created_at: base.createdAt,
    status: 'completed',
    model: base.model,
    error: null,
    incomplete_details: null,
    output: [
      {
        id: base.messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: base.text,
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ],
    metadata: {
      qrouter_local_command: true,
      request_id: args.requestId,
      command_name: args.commandName,
      command_text: args.commandText,
    },
    usage: {
      input_tokens: 0,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens: 0,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: 0,
    },
  }, {
    requestId: args.requestId,
    endpoint: 'responses',
    finalClassification: 'local_command',
    attempts: 0,
    requestedModel: args.model ?? null,
    upstreamModel: args.model ?? null,
    failoverUsed: false,
    localCommand: true,
  });
}

export function buildLocalCommandResponsesStream(args: LocalCommandReplyArgs): string {
  const base = buildResponsesBase(args);
  const payload = buildLocalCommandResponsesPayload(args);
  return [
    `data: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: base.responseId,
        object: 'response',
        created_at: base.createdAt,
        status: 'in_progress',
        model: base.model,
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: 'response.output_text.delta',
      item_id: base.messageId,
      delta: base.text,
    })}\n\n`,
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: payload,
    })}\n\n`,
  ].join('');
}
