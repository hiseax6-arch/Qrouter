export type UpstreamFailureDetails = {
  type?: string;
  code?: string;
  message?: string;
  bodySnippet?: string;
};

function truncateForTrace(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}

export function parseUpstreamErrorDetails(bodyText: string): UpstreamFailureDetails | null {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }

  let type: string | undefined;
  let code: string | undefined;
  let message: string | undefined;

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { type?: unknown; code?: unknown; message?: unknown };
      type?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const source =
      parsed.error && typeof parsed.error === 'object'
        ? parsed.error
        : parsed;
    type = typeof source.type === 'string' ? source.type : undefined;
    code = typeof source.code === 'string' ? source.code : undefined;
    message = typeof source.message === 'string' ? source.message : undefined;
  } catch {
    // Keep a text snippet for non-JSON upstream failures.
  }

  const bodySnippet = truncateForTrace(trimmed, 400);
  if (!type && !code && !message && !bodySnippet) {
    return null;
  }

  return {
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(bodySnippet ? { bodySnippet } : {}),
  };
}

function extractHintMessage(args: {
  upstreamStatus?: number | null;
  upstreamError?: UpstreamFailureDetails | null;
}): string | null {
  const message = args.upstreamError?.message?.trim();
  if (!message) {
    return null;
  }

  if (args.upstreamStatus && args.upstreamStatus >= 500) {
    return null;
  }

  return message;
}

function buildStatusAwareMessage(args: {
  upstreamStatus?: number | null;
  upstreamError?: UpstreamFailureDetails | null;
}): string {
  const hint = extractHintMessage(args);
  const status = args.upstreamStatus ?? null;

  if (status === 400) {
    return hint ? `请求参数不被上游接受（HTTP 400）：${hint}` : '请求参数不被上游接受（HTTP 400）';
  }

  if (status === 401) {
    return hint ? `上游鉴权失败（HTTP 401）：${hint}` : '上游鉴权失败（HTTP 401）';
  }

  if (status === 403) {
    return hint ? `上游拒绝当前请求（HTTP 403）：${hint}` : '上游拒绝当前请求（HTTP 403）';
  }

  if (status === 404) {
    return hint ? `上游模型或接口不存在（HTTP 404）：${hint}` : '上游模型或接口不存在（HTTP 404）';
  }

  if (status === 408) {
    return '上游请求超时（HTTP 408）';
  }

  if (status === 409) {
    return hint ? `上游请求冲突（HTTP 409）：${hint}` : '上游请求冲突（HTTP 409）';
  }

  if (status === 422) {
    return hint ? `上游无法处理当前请求（HTTP 422）：${hint}` : '上游无法处理当前请求（HTTP 422）';
  }

  if (status === 429) {
    return hint ? `上游服务商限流或额度耗尽（429）：${hint}` : '上游服务商限流或额度耗尽，请稍后重试或切换模型。';
  }

  if (status && status >= 500) {
    return `上游模型服务暂时不可用（HTTP ${status}）`;
  }

  if (hint) {
    return status ? `上游模型返回错误（HTTP ${status}）：${hint}` : `上游模型异常：${hint}`;
  }

  if (status) {
    return `上游模型返回错误（HTTP ${status}）`;
  }

  return '上游返回不可恢复错误。';
}

export function buildEmptySuccessFailure(args: {
  requestId: string;
  attempts: number;
}) {
  return {
    error: {
      message: 'Upstream response exhausted retries without semantic success.',
      type: 'upstream_empty_success',
      request_id: args.requestId,
      attempts: args.attempts,
      final_error_class: 'empty_success',
    },
  };
}

export function buildRetryExhaustedFailure(args: {
  requestId: string;
  attempts: number;
  finalErrorClass: string;
  upstreamStatus?: number | null;
  upstreamError?: UpstreamFailureDetails | null;
}) {
  const isProvider429 = args.finalErrorClass === 'http_429' || args.upstreamStatus === 429;

  const message = isProvider429
    ? args.upstreamError?.message
      ? `上游服务商限流或额度耗尽（429）：${args.upstreamError.message}`
      : '上游服务商限流或额度耗尽，请稍后重试或切换模型。'
    : args.upstreamError?.message
      ? `Upstream ${args.upstreamStatus ?? 'error'}: ${args.upstreamError.message}`
      : 'Upstream request failed after retries.';

  return {
    error: {
      message,
      type: isProvider429 ? 'provider_rate_limited' : 'upstream_retry_exhausted',
      request_id: args.requestId,
      attempts: args.attempts,
      final_error_class: args.finalErrorClass,
      ...(args.upstreamStatus ? { upstream_status: args.upstreamStatus } : {}),
      ...(args.upstreamError
        ? {
            upstream_error: {
              ...(args.upstreamError.type ? { type: args.upstreamError.type } : {}),
              ...(args.upstreamError.code ? { code: args.upstreamError.code } : {}),
              ...(args.upstreamError.message ? { message: args.upstreamError.message } : {}),
              ...(args.upstreamError.bodySnippet ? { body_snippet: args.upstreamError.bodySnippet } : {}),
            },
          }
        : {}),
    },
  };
}

export function buildTerminalFailure(args: {
  requestId: string;
  attempts: number;
  finalErrorClass: string;
  upstreamStatus?: number | null;
  upstreamError?: UpstreamFailureDetails | null;
}) {
  const message = buildStatusAwareMessage({
    upstreamStatus: args.upstreamStatus,
    upstreamError: args.upstreamError,
  });

  return {
    error: {
      message,
      type: 'upstream_terminal_error',
      request_id: args.requestId,
      attempts: args.attempts,
      final_error_class: args.finalErrorClass,
      ...(args.upstreamStatus ? { upstream_status: args.upstreamStatus } : {}),
      ...(args.upstreamError
        ? {
            upstream_error: {
              ...(args.upstreamError.type ? { type: args.upstreamError.type } : {}),
              ...(args.upstreamError.code ? { code: args.upstreamError.code } : {}),
              ...(args.upstreamError.message ? { message: args.upstreamError.message } : {}),
              ...(args.upstreamError.bodySnippet ? { body_snippet: args.upstreamError.bodySnippet } : {}),
            },
          }
        : {}),
    },
  };
}

export function buildStreamErrorEvent(args: {
  requestId: string;
  attempts: number;
  finalErrorClass: string;
}) {
  return `event: error\ndata: ${JSON.stringify({
    error: {
      message: 'Upstream stream failed after downstream commit.',
      type: 'upstream_stream_interrupted',
      request_id: args.requestId,
      attempts: args.attempts,
      final_error_class: args.finalErrorClass,
    },
  })}\n\n`;
}
