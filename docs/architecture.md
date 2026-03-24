# Qingfu Router Architecture

## Purpose
Qingfu Router is a local OpenAI-compatible gateway inserted in front of the real upstream model provider used by OpenClaw. Its v1 purpose is narrow and deliberate:

- preserve the requested model identity (notably `gpt-5.4`),
- retry on the **same provider + same model**, and
- prevent **empty-success / pseudo-success** from being returned to OpenClaw as a normal completion.

## Problem Statement
The target failure mode is not a simple timeout. The observed incident shape is:

1. upstream appears to complete,
2. resulting assistant output is effectively empty,
3. the turn may still look like a normal stop instead of an error,
4. OpenClaw then has no deliverable final reply,
5. gateway/channel side shows `queuedFinal=false, replies=0`.

The router exists to break that chain at the boundary before OpenClaw accepts the upstream result as success.

## Design Principles
- **Semantic success before transport success**: HTTP 2xx or normal stream termination is not enough.
- **Same-path retries only**: v1 does not auto-switch provider or model.
- **No OpenClaw core patches**: integration happens through provider `baseUrl`.
- **Transparent retry only before commit**: once meaningful output is sent downstream, no silent retry.
- **Durable forensics**: intermittent empty-reply bugs require traceable evidence.

## System Context
```text
OpenClaw agent
   -> qingfu-router (local OpenAI-compatible gateway)
      -> real upstream provider/base URL
         -> qingfu-router evaluates + retries if needed
            -> OpenClaw receives either semantic success or explicit failure
```

## Main Components
### 1. Ingress Layer
Accepts OpenAI-compatible requests from OpenClaw.

Responsibilities:
- route `POST /v1/chat/completions`,
- optionally route `/v1/responses` later if required,
- validate request shape,
- normalize request into internal types,
- assign local request ID.

### 2. Policy Layer
Applies v1 rules.

Responsibilities:
- same-provider same-model retry only,
- attempt budget,
- deadline budget,
- retryability classification,
- backoff selection.

### 3. Upstream Client
Handles outbound calls.

Responsibilities:
- forward request to real upstream base URL,
- preserve required headers/auth,
- attach local correlation/idempotency headers where useful,
- support non-streaming and streaming calls.

### 4. Response Evaluator
The core defense layer.

Responsibilities:
- classify `semantic_success`, `empty_success`, `retryable_failure`, `terminal_failure`,
- reject pseudo-success responses,
- detect meaningful text / tool call / refusal / allowed structured payload,
- decide whether a retry is safe.

### 5. Streaming Bridge
Handles the most delicate path.

Responsibilities:
- keep a **pre-commit buffer**,
- wait for first meaningful semantic signal,
- commit only after real content/tool-call/refusal exists,
- retry if the stream ends empty before commit,
- avoid duplicate or divergent downstream output.

### 6. Trace Layer
Provides durable evidence.

Responsibilities:
- JSONL event logging,
- SQLite request summary storage,
- request/attempt timeline reconstruction,
- aggregation by model / upstream / failure class.

## Semantic Success Model
A result counts as success only if at least one of the following is true:
- non-empty assistant text,
- valid tool/function call,
- explicit non-empty refusal/safety payload,
- explicitly allowed non-empty structured payload.

If the upstream appears to succeed but none of those are present, the result is classified as **empty-success** and is treated as retryable failure.

## Request Lifecycle
### States
- `received`
- `validated`
- `attempting[n]`
- `awaiting_upstream`
- `pre_commit_buffering` (streaming only)
- `semantic_success`
- `committed`
- `retryable_failure`
- `terminal_failure`
- `completed`

### Invariants
- Never emit a downstream success before semantic success.
- Never transparent-retry after commit.
- Never convert exhausted empty-success into blank success.
- Every attempt must be traceable by request ID and attempt number.

## Retry Model
### Retryable before semantic success
- timeout,
- connection error,
- early EOF,
- HTTP 408,
- HTTP 429,
- HTTP 5xx,
- empty-success,
- malformed 2xx success payload.

### Non-retryable
- HTTP 400 / 401 / 403 / 404 / 422,
- invalid model / invalid auth / unsupported parameter,
- explicit non-empty refusal.

### Default budget
- max attempts: 3 total,
- same provider, same model every time,
- total deadline budget still applies.

## Streaming Commit Strategy
### Why pre-commit buffering exists
If we forward tokens immediately and the upstream later turns out to be empty/broken, we cannot safely retry without risking duplicate or inconsistent output.

### Strategy
- Buffer initial stream events locally.
- Inspect for meaningful text/tool-call/refusal.
- Commit only when a semantic signal appears.
- If stream ends before that point, mark as empty-success and retry.

## Observability
### JSONL traces
Used for raw chronological event streams.

Suggested event types:
- request received,
- attempt started,
- upstream headers received,
- semantic success observed,
- retry scheduled,
- terminal failure,
- response committed.

### SQLite summaries
Used for indexed diagnosis.

Suggested dimensions:
- request id,
- model,
- upstream,
- stream flag,
- attempts,
- final classification,
- committed yes/no,
- first meaningful output yes/no.

## Integration Boundary with OpenClaw
- OpenClaw should point one dedicated provider entry at qingfu-router via `baseUrl`.
- Router hides the real upstream details behind its own config.
- Rollout should start with one narrow model path.
- Rollback should only require restoring the original provider/base URL.

## v1 Scope Boundary
### Included
- `chat/completions` first,
- targeted empty-success detection,
- same-path retries,
- explicit exhausted-failure payload,
- JSONL + SQLite traces.

### Deferred
- auto provider switching,
- advanced traffic shaping,
- dashboard/control plane,
- broad multi-agent rollout,
- full OpenAI-native `/v1/responses` parity unless proven necessary.

## Open Questions
1. Does the exact `gpt-5.4` OpenClaw path require `/v1/responses`, or can we complete v1 on `chat/completions`?
2. What exact tool-call delta should count as “meaningful” for stream commit?
3. What final error payload shape best helps OpenClaw surface exhausted empty-success clearly?

## Build Order Recommendation
1. `chat/completions` non-streaming path
2. semantic classifier
3. retry controller
4. streaming pre-commit buffer
5. JSONL traces
6. SQLite summaries
7. optional `/v1/responses` compatibility if required
