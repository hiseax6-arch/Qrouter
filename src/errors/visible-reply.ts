import type { UpstreamFailureDetails } from './terminal-payload.js';
import { appendResponsesQrouterMetadata } from '../observability/qrouter.js';

type VisibleFailureArgs = {
  requestId: string;
  attempts: number;
  model?: string | null;
  finalErrorClass: string;
  upstreamStatus?: number | null;
  upstreamError?: UpstreamFailureDetails | null;
  fallbackChainExhausted?: boolean;
};

function resolveVisibleModel(model: string | null | undefined): string {
  return typeof model === 'string' && model.trim().length > 0 ? model : 'qrouter-fallback';
}

function extractUpstreamHint(args: VisibleFailureArgs): string | null {
  const message = args.upstreamError?.message?.trim();
  if (!message) {
    return null;
  }

  if (args.upstreamStatus && args.upstreamStatus >= 500) {
    return null;
  }

  if (args.finalErrorClass === 'timeout' || args.finalErrorClass === 'connection_error') {
    return null;
  }

  return message;
}

function resolveVisibleReason(args: VisibleFailureArgs): string {
  if (args.finalErrorClass === 'http_429' || args.upstreamStatus === 429) {
    return extractUpstreamHint(args)
      ? `上游模型当前限流或额度已耗尽：${extractUpstreamHint(args)}`
      : '上游模型当前限流或额度已耗尽';
  }

  if (args.finalErrorClass === 'timeout') {
    return '上游模型请求超时';
  }

  if (args.finalErrorClass === 'connection_error') {
    return '上游模型连接失败';
  }

  if (args.finalErrorClass === 'empty_success') {
    return '上游模型返回了空响应';
  }

  if (args.finalErrorClass === 'upstream_non_json' || args.finalErrorClass === 'malformed_success') {
    return '上游模型返回了异常格式响应';
  }

  if (args.finalErrorClass === 'missing_stream_body') {
    return '上游模型流式响应异常中断';
  }

  if (args.upstreamStatus === 400) {
    return extractUpstreamHint(args)
      ? `请求参数不被上游接受（HTTP 400）：${extractUpstreamHint(args)}`
      : '请求参数不被上游接受（HTTP 400）';
  }

  if (args.upstreamStatus === 401) {
    return extractUpstreamHint(args)
      ? `上游鉴权失败（HTTP 401）：${extractUpstreamHint(args)}`
      : '上游鉴权失败（HTTP 401）';
  }

  if (args.upstreamStatus === 403) {
    return extractUpstreamHint(args)
      ? `上游拒绝当前请求（HTTP 403）：${extractUpstreamHint(args)}`
      : '上游拒绝当前请求（HTTP 403）';
  }

  if (args.upstreamStatus === 404) {
    return extractUpstreamHint(args)
      ? `上游模型或接口不存在（HTTP 404）：${extractUpstreamHint(args)}`
      : '上游模型或接口不存在（HTTP 404）';
  }

  if (args.upstreamStatus === 408) {
    return '上游请求超时（HTTP 408）';
  }

  if (args.upstreamStatus === 409) {
    return extractUpstreamHint(args)
      ? `上游请求冲突（HTTP 409）：${extractUpstreamHint(args)}`
      : '上游请求冲突（HTTP 409）';
  }

  if (args.upstreamStatus === 422) {
    return extractUpstreamHint(args)
      ? `上游无法处理当前请求（HTTP 422）：${extractUpstreamHint(args)}`
      : '上游无法处理当前请求（HTTP 422）';
  }

  if (args.upstreamStatus && args.upstreamStatus >= 500) {
    return `上游模型服务暂时不可用（HTTP ${args.upstreamStatus}）`;
  }

  if (args.upstreamStatus && args.upstreamStatus >= 400) {
    return extractUpstreamHint(args)
      ? `上游模型返回错误（HTTP ${args.upstreamStatus}）：${extractUpstreamHint(args)}`
      : `上游模型返回错误（HTTP ${args.upstreamStatus}）`;
  }

  if (args.upstreamError?.message) {
    return `上游模型异常：${args.upstreamError.message}`;
  }

  return '上游模型暂时不可用';
}

function buildVisibleMessage(args: VisibleFailureArgs): string {
  const reason = resolveVisibleReason(args);
  const retriesUsed = Math.max(args.attempts - 1, 0);
  if (args.fallbackChainExhausted) {
    return `${reason}，已依次重试并轮询模型库后仍失败，当前没有可连通模型。请求号：${args.requestId}`;
  }
  const retryPhrase = retriesUsed > 0 ? `已自动重试 ${retriesUsed} 次后仍失败。` : '本次请求未成功。';
  return `${reason}，${retryPhrase}请稍后重试，或切换到备用模型。请求号：${args.requestId}`;
}

function toUnixTimestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildVisibleChatCompletionBase(args: VisibleFailureArgs) {
  const model = resolveVisibleModel(args.model);
  const id = `chatcmpl_qrouter_visible_${args.requestId.replace(/-/g, '')}`;
  const content = buildVisibleMessage(args);

  return {
    id,
    created: toUnixTimestampSeconds(),
    model,
    content,
  };
}

export function buildVisibleChatCompletion(args: VisibleFailureArgs) {
  const base = buildVisibleChatCompletionBase(args);
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

export function buildVisibleChatCompletionStream(args: VisibleFailureArgs): string {
  const base = buildVisibleChatCompletionBase(args);
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

function buildVisibleResponsesBase(args: VisibleFailureArgs) {
  const model = resolveVisibleModel(args.model);
  const responseId = `resp_qrouter_visible_${args.requestId.replace(/-/g, '')}`;
  const messageId = `msg_qrouter_visible_${args.requestId.replace(/-/g, '')}`;
  const createdAt = toUnixTimestampSeconds();
  const text = buildVisibleMessage(args);

  return {
    responseId,
    messageId,
    createdAt,
    model,
    text,
  };
}

export function buildVisibleResponsesPayload(args: VisibleFailureArgs) {
  const base = buildVisibleResponsesBase(args);
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
      qrouter_visible_error: true,
      request_id: args.requestId,
      final_error_class: args.finalErrorClass,
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
    finalClassification: args.finalErrorClass,
    attempts: args.attempts,
    requestedModel: args.model ?? null,
    upstreamModel: args.model ?? null,
    failoverUsed: false,
    visibleError: true,
  });
}

export function buildVisibleResponsesStream(args: VisibleFailureArgs): string {
  const base = buildVisibleResponsesBase(args);
  const payload = buildVisibleResponsesPayload(args);
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
