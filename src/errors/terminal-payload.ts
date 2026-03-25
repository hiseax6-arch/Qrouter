type UpstreamFailureDetails = {
  type?: string;
  code?: string;
  message?: string;
  bodySnippet?: string;
};

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
  const message = args.upstreamError?.message
    ? `Upstream ${args.upstreamStatus ?? 'error'}: ${args.upstreamError.message}`
    : 'Upstream request failed after retries.';

  return {
    error: {
      message,
      type: 'upstream_retry_exhausted',
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
  const message = args.upstreamError?.message
    ? `Upstream ${args.upstreamStatus ?? 'error'}: ${args.upstreamError.message}`
    : 'Upstream returned a non-retryable error.';

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
