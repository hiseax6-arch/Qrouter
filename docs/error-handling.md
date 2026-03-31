# Q-router Error Handling Matrix

This document explains how Q-router reacts to common upstream failure classes, what it returns downstream, and what operators should expect during incident review.

## Design goals
- improve OpenClaw output stability instead of returning ambiguous failures,
- make retry / failover behavior explicit,
- keep downstream-visible hints understandable,
- preserve detailed diagnostics in traces without overexposing raw upstream internals.

## Error matrix

| Upstream status / class | Typical meaning | Q-router behavior | Downstream response | Visible hint style |
| --- | --- | --- | --- | --- |
| `400` | Bad request / unsupported request shape | No retry, no failover by default | Terminal HTTP error | `请求参数不被上游接受（HTTP 400）` |
| `401` | Invalid upstream credential | No retry, no failover by default | Terminal HTTP error | `上游鉴权失败（HTTP 401）` |
| `403` | Forbidden / plan or permission denied | No retry unless body matches retryable temporary-quota pattern | Terminal HTTP error or retry path | `上游拒绝当前请求（HTTP 403）` |
| `404` | Model or endpoint missing | No retry, no failover by default | Terminal HTTP error | `上游模型或接口不存在（HTTP 404）` |
| `408` | Request timeout from upstream HTTP layer | Retryable | Visible assistant failure after exhaustion or fallback route | `上游请求超时（HTTP 408）` |
| `409` | Upstream conflict / temporary state mismatch | No retry by default | Terminal HTTP error | `上游请求冲突（HTTP 409）` |
| `422` | Request understood but cannot be processed | No retry by default | Terminal HTTP error | `上游无法处理当前请求（HTTP 422）` |
| `429` | Rate limit / quota exhausted | Retryable, then failover/fallback if configured | Visible assistant failure after exhaustion | `上游模型当前限流或额度已耗尽` |
| `5xx` | Upstream service unavailable / internal failure | Retryable, then failover/fallback if configured | Visible assistant failure after exhaustion | `上游模型服务暂时不可用（HTTP 5xx）` |
| `timeout` | Connection or request timeout before valid response | Retryable, then failover/fallback if configured | Visible assistant failure after exhaustion | `上游模型请求超时` |
| `connection_error` | DNS / TCP / TLS / socket failure | Retryable, then failover/fallback if configured | Visible assistant failure after exhaustion | `上游模型连接失败` |
| `empty_success` | 2xx but semantically empty output | Retryable, then failover/fallback if configured | Visible assistant failure after exhaustion | `上游模型返回了空响应` |
| `upstream_non_json` / `malformed_success` | 2xx but invalid or malformed success payload | Retryable, then failover/fallback if configured | Visible assistant failure after exhaustion | `上游模型返回了异常格式响应` |
| `missing_stream_body` | Claimed stream path but no actual stream body | Retryable, then failover/fallback if configured | Visible assistant failure after exhaustion | `上游模型流式响应异常中断` |
| `stream_interrupted_after_commit` | Stream broke after downstream commit | No transparent retry after commit | SSE error event / trace evidence | `upstream_stream_interrupted` event, not blank success |

## Downstream policy

### 1. Retryable classes
These classes are treated as retryable:
- `429`
- `5xx`
- `timeout`
- `connection_error`
- `empty_success`
- `upstream_non_json`
- `malformed_success`
- `missing_stream_body`
- selected temporary `403` quota-like cases

If retry budget is not exhausted, Q-router retries the same candidate first. After candidate retry budget is exhausted, it may activate fallback / failover if allowed.

### 2. Non-retryable client-side classes
These usually return terminal HTTP errors directly to downstream:
- `400`
- `401`
- ordinary `403`
- `404`
- `409`
- `422`

Reason: these usually indicate caller configuration, auth, permission, or request-shape issues rather than transient upstream instability.

### 3. Visible assistant failures
When all retryable attempts and fallback candidates are exhausted, Q-router returns a visible assistant-style failure for chat / responses endpoints instead of returning an ambiguous blank success.

Typical visible wording includes:
- retry already happened,
- fallback chain may already be exhausted,
- request ID is included for operator lookup.

### 4. Post-commit failures
If the stream already committed meaningful downstream output, Q-router does not transparently retry. Instead it:
- preserves trace evidence,
- emits explicit interruption signal for stream consumers,
- avoids double-send or hidden replay.

## Operator guidance
During incident review, answer these questions:
1. Was the class retryable?
2. Did Q-router retry the same candidate?
3. Did it activate fallback or failover?
4. Did the request end as visible failure, terminal error, or semantic success?
5. Was there downstream commit before interruption?

## Recommendation for downstream integrators
Downstream systems such as OpenClaw should treat Q-router visible failures as user-facing fallback messages with operator-friendly request IDs, not as silent success.
