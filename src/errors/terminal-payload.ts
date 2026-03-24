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
}) {
  return {
    error: {
      message: 'Upstream request failed after retries.',
      type: 'upstream_retry_exhausted',
      request_id: args.requestId,
      attempts: args.attempts,
      final_error_class: args.finalErrorClass,
    },
  };
}

export function buildTerminalFailure(args: {
  requestId: string;
  attempts: number;
  finalErrorClass: string;
}) {
  return {
    error: {
      message: 'Upstream returned a non-retryable error.',
      type: 'upstream_terminal_error',
      request_id: args.requestId,
      attempts: args.attempts,
      final_error_class: args.finalErrorClass,
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
