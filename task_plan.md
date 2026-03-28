# Task Plan: Qingfu Router for OpenClaw

## Goal
Design and implement a local OpenAI-compatible gateway for OpenClaw that keeps `gpt-5.4` as the primary path, performs same-provider same-model in-place retries, and integrates through `baseUrl` configuration rather than OpenClaw source patches.

## Current Phase
Phase 8

## Success Criteria
- OpenClaw can send model traffic to the local router via config-only changes.
- The router preserves the requested model identity (`gpt-5.4`) and does not automatically switch provider/model in v1.
- The router retries on empty-success / timeout / transient transport failures using the **same provider and same model**.
- The router prevents the specific observed symptom chain: upstream looks successful -> assistant payload is empty -> OpenClaw records a normal stop -> channel sees `queuedFinal=false, replies=0`.
- When retries are exhausted, the router surfaces an explicit failure instead of returning a silent/empty success.
- At least one OpenClaw integration path is verified end-to-end.

## Non-Goals (v1)
- Automatic provider switching or cost-based routing.
- Deep coupling to OpenClaw plugin hooks or transcript internals.
- Full parity with every OpenAI-native feature (for example direct OpenAI-only server-side compaction behavior).
- Broad multi-agent rollout policy; initial rollout details can come later.
- Fancy control plane / dashboard before the core retry path is stable.

## Root Problem Statement
### Observed failure we are designing against
The target bug is not a plain timeout or plain HTTP failure. The observed pattern is more dangerous:
1. upstream/provider turn appears to complete,
2. resulting assistant payload is effectively empty (`content: []`, whitespace-only, or no meaningful structured output),
3. turn can still be treated as a normal stop rather than an error,
4. OpenClaw then has no deliverable final reply,
5. gateway/channel layer reports `queuedFinal=false, replies=0`.

### Design implication
The router must apply a **semantic success gate** before returning any upstream “success” to OpenClaw. HTTP success or stream completion alone is not enough.

## Phases

### Phase 1: Requirements & Discovery
- [x] Capture user intent and constraints
- [x] Choose integration shape at a high level
- [x] Create planning files and seed initial findings
- [x] Confirm OpenClaw can consume local OpenAI-compatible proxies through `baseUrl`
- [x] Confirm transport defaults relevant to `openai-codex/*` (`auto` = WebSocket-first, SSE fallback)
- [x] Confirm OpenClaw has precedent for working through `/v1/chat/completions`-based proxies (e.g. LiteLLM)
- **Status:** complete

### Phase 2: Interface & Architecture Design
- [x] Decide v1 ingress scope: `/v1/chat/completions` first, with `/v1/responses` deferred or adapted only if proven necessary
- [x] Define the router modules: ingress API, upstream client, response evaluator, retry controller, config loader, observability/logging
- [x] Define request metadata preserved end-to-end (model, stream flag, headers, timeout, request id)
- [x] Define retry trigger taxonomy: timeout, connection error, HTTP 5xx, HTTP 429, empty-success, malformed success
- [x] Define retry stop conditions and explicit error surfacing rules
- [x] Decide persistence model for request history / health traces
- [x] Define request/response state machine and stream commit semantics
- [x] Define OpenClaw integration and rollback plan
- [x] Draft supporting docs skeletons: `docs/architecture.md`, `docs/config.md`, `docs/operations.md`
- **Status:** in_progress

### Phase 3: Prototype Implementation
- [x] Create project structure for the local gateway
- [x] Implement `POST /v1/chat/completions`
- [x] Implement upstream forwarding to the real provider/base URL
- [x] Implement same-provider same-model retry logic
- [x] Implement explicit empty-success detection for non-streaming responses
- [x] Implement streaming handling and pre-commit buffer strategy
- [x] Return explicit structured errors when retries are exhausted
- [x] Add structured attempt logging / trace persistence
- **Status:** complete

### Phase 4: Optional Responses Compatibility
- [x] Determine whether the target OpenClaw path truly requires `/v1/responses` for the chosen `gpt-5.4` configuration
- [x] Decide v1 will not implement `/v1/responses`; instead, use a dedicated router provider configured with `api: "openai-completions"` for `qingfuCodex/gpt-5.4`
- [x] Document why `chat/completions` is sufficient for v1 and defer responses support
- **Status:** complete

### Phase 5: OpenClaw Integration
- [x] Add a dedicated OpenClaw provider entry pointing at the local router via `baseUrl`
- [x] Map `gpt-5.4` traffic to that provider cleanly
- [x] Verify a narrow integration path with one OpenClaw target configuration
- [x] Verify rollback path back to direct upstream
- [x] Document the exact config diff / rollback path
- **Status:** complete

### Phase 6: Verification & Hardening
- [x] Validate normal success path
- [x] Validate timeout retry path
- [x] Validate empty-success retry path
- [x] Validate streaming pre-commit / no-double-send behavior
- [x] Validate explicit failure after retry exhaustion
- [x] Validate logs/diagnostics are sufficient to explain what happened per request
- **Status:** complete

### Phase 7: Delivery
- [x] Summarize architecture, assumptions, and constraints
- [x] Hand over implementation and config instructions
- [x] List follow-up enhancements (provider switching, per-agent policies, health scoring, dashboard)
- [x] Add a dedicated routing audit for model/provider/id/url/key/thinklevel mapping
- **Status:** complete

### Phase 8: Backward-Compatible Structure Improvements
- [x] Add explicit `routes` support without breaking legacy config
- [x] Add explicit provider `apiKeyEnv` support
- [x] Add compatibility handling for legacy `QINGFU_*` env names
- [x] Add effective route introspection endpoint
- [x] Verify old behavior stays green through full tests
- **Status:** complete

## Architecture Draft
1. **Ingress Layer**
   - Accept OpenAI-compatible requests from OpenClaw.
   - Preserve streaming vs non-streaming behavior.
   - Assign a local request ID for diagnostics.
2. **Policy Layer**
   - Apply v1 policy: same provider, same model, in-place retry only.
   - Attach retry counters and deadline budget.
3. **Upstream Client**
   - Forward to the real upstream provider/base URL.
   - Preserve headers/auth required by the upstream.
4. **Response Evaluator**
   - Classify result as success / retryable failure / terminal failure.
   - Detect “empty success” before returning it to OpenClaw.
5. **Retry Controller**
   - Run bounded retries with backoff.
   - Stop after max attempts or deadline budget.
6. **Observability Layer**
   - Emit structured logs per attempt.
   - Persist enough trace data to explain intermittent empty-reply incidents after the fact.

## Semantic Success Gate (v1)
A response counts as **success** only if at least one of the following is true:
- non-empty assistant text exists after trimming whitespace,
- at least one valid tool/function call is present,
- an explicit non-empty refusal/safety response is present,
- another explicitly allowed structured output type is present and non-empty.

A response counts as **empty-success / pseudo-success** if all of the following are true:
- transport completed normally or returned HTTP 2xx,
- no explicit upstream error was returned,
- no meaningful text, tool call, refusal, or allowed structured payload exists.

**Rule:** empty-success is treated as **retryable failure**, not success.

## Retry Decision Rules (Targeted to Empty Replies)
### Class A — Immediate retryable failures
Retry automatically when any of the following occurs **before semantic success is established**:
- connection error / connection reset / EOF before usable payload,
- request timeout / upstream timeout,
- HTTP 408,
- HTTP 429 (respect `Retry-After` if present),
- HTTP 500 / 502 / 503 / 504,
- completed response with empty-success signature,
- malformed success payload (2xx but missing required message structure).

### Class B — Do not auto-retry
Do **not** auto-retry when the upstream clearly returns a caller/config problem:
- HTTP 400 / 401 / 403 / 404 / 422,
- invalid model / invalid auth / permission denied / unsupported parameter,
- explicit policy refusal that is semantically non-empty.

### Class C — Retry only if still pre-commit
These are retryable only if the router has **not yet committed meaningful output downstream**:
- streaming connection breaks before any meaningful token/tool-call arrives,
- stream ends with only whitespace / metadata and no semantic payload,
- stream completes with usage/finish markers but no meaningful assistant payload.

If meaningful output has already been forwarded downstream, do **not** transparent-retry; instead surface an explicit upstream/truncated failure.

## Streaming Commit Strategy
### Problem
For streaming, the router cannot safely retry after it has already forwarded real content to OpenClaw; that would risk duplicate or divergent outputs.

### Strategy
Use a **pre-commit buffer**:
1. Open upstream stream.
2. Buffer early events locally.
3. Watch for the first meaningful semantic signal:
   - non-whitespace text delta,
   - tool/function-call delta sufficient to prove a real structured action,
   - explicit refusal content.
4. Only after that signal appears does the router **commit** and begin forwarding buffered events to OpenClaw.
5. If the stream ends before commit, classify as empty-success and retry.

This directly targets the observed “completed but empty” failure mode.

## Non-Streaming Success Evaluation
For `chat/completions` non-streaming responses, treat as success only if at least one choice contains:
- non-empty `message.content`, or
- non-empty `tool_calls`, or
- explicit refusal/non-empty structured payload.

Otherwise classify as empty-success and retry.

For `/v1/responses` compatibility (if later required), the analogous rule is:
- success only when `output` contains meaningful message text, function call content, refusal, or another explicitly whitelisted non-empty output item.

## Request / Response State Machine
### Request lifecycle states
1. **received**
   - request accepted by qingfu-router,
   - local request ID assigned,
   - incoming metadata normalized.
2. **validated**
   - required request shape checked,
   - stream/non-stream mode decided,
   - upstream target resolved.
3. **attempting[n]**
   - nth upstream attempt started.
4. **awaiting_upstream**
   - waiting for headers/body/stream events.
5. **pre_commit_buffering** (streaming only)
   - collecting initial deltas,
   - no downstream bytes committed yet.
6. **semantic_success**
   - meaningful payload observed.
7. **committed**
   - downstream response/stream is now live to OpenClaw.
8. **retryable_failure**
   - timeout / empty-success / transient HTTP/network failure before commit.
9. **terminal_failure**
   - retries exhausted or non-retryable failure.
10. **completed**
   - response successfully returned.

### Allowed transitions
- `received -> validated -> attempting[1] -> awaiting_upstream`
- non-streaming success: `awaiting_upstream -> semantic_success -> committed -> completed`
- streaming success: `awaiting_upstream -> pre_commit_buffering -> semantic_success -> committed -> completed`
- retry path: `awaiting_upstream/pre_commit_buffering -> retryable_failure -> attempting[n+1]`
- final failure: `awaiting_upstream/pre_commit_buffering -> retryable_failure -> terminal_failure`
- direct failure: `validated/awaiting_upstream -> terminal_failure`

### Critical invariants
- Never emit a 2xx success downstream unless semantic success is established.
- Never transparent-retry after commit.
- Never downgrade exhausted empty-success into a blank normal completion.
- Every attempt must be traceable by request ID + attempt number.

## Retry Budget & Backoff
### Default attempt policy (v1)
- total attempts: **3** (initial try + 2 retries),
- same provider, same model on every attempt,
- bounded by total request deadline budget.

### Backoff guidance
- empty-success: short jittered retry (fast retry; likely transient upstream no-op),
- timeout / connection error: moderate backoff,
- 429: respect `Retry-After`, otherwise exponential backoff with cap,
- 5xx: exponential backoff with jitter.

### Stop retrying when
- semantic success is established,
- max attempts reached,
- deadline budget exhausted,
- non-retryable status/error is returned.

## Idempotency / Side-Effect Safety
- Retries are only transparent while still **pre-commit**.
- If a valid tool/function call has already been observed, that counts as semantic success and should not be retried as “empty”.
- The router should attach a local request ID and attempt number to logs for each upstream attempt.
- If supported by the upstream, send an idempotency/correlation header so repeated attempts can be traced.

## Observability / Persistence Decision
### Decision
Use **two layers** in v1:
1. **structured JSONL logs** for full attempt/event detail,
2. **small SQLite trace DB** for indexed request summaries.

### Rationale
- Empty-reply bugs are intermittent and forensic by nature; in-memory only is too weak.
- JSONL is easiest for raw chronological debugging.
- SQLite is better for answering: “how often did `empty_success` happen for model X today?”
- This is still light enough for v1 and far cheaper than building a full dashboard/control plane.

### Minimum trace fields
- request_id
- started_at / finished_at
- endpoint (`chat.completions` / `responses`)
- stream flag
- requested model
- upstream base URL / provider label
- attempt count
- final classification (`success`, `empty_success_exhausted`, `timeout_exhausted`, etc.)
- final HTTP status / transport error
- committed flag
- first meaningful output seen (yes/no)

## Failure Surfacing Rules
When retries are exhausted, the router must return an **explicit failure** instead of a blank success.
That failure payload should include enough structured detail for diagnosis:
- local request id,
- attempt count,
- final error class (`empty_success`, `timeout`, `http_429`, `http_5xx`, `connection_error`, etc.),
- upstream status code when available.

## OpenClaw Integration Shape (v1)
### Integration principle
- Do **not** patch OpenClaw core.
- Insert qingfu-router through `baseUrl` on a dedicated provider entry.
- Keep rollout reversible by limiting config changes to one provider/model path first.

### Initial narrow integration target
- Preferred first target: OpenAI-compatible `chat/completions` path.
- If the exact `gpt-5.4` configuration path proves to require `/v1/responses`, add a minimal compatibility layer in Phase 4 instead of bloating v1 prematurely.

### Provider layout strategy
- Define a dedicated provider alias for the router, e.g. `qingfu-openai` or `qingfu-codex`.
- Point that provider’s `baseUrl` at the local router, e.g. `http://127.0.0.1:4318/v1`.
- Preserve the requested model string (`gpt-5.4`) unless translation is technically required.
- Keep auth/base URL for the real upstream inside router config, not scattered across OpenClaw model definitions.

### Rollout path
1. add dedicated provider entry,
2. bind one target model path to it,
3. verify only one narrow OpenClaw flow,
4. expand later if stable.

### Rollback path
1. stop routing new traffic to qingfu-router by restoring the old provider/baseUrl,
2. restart/reload the affected OpenClaw runtime if needed,
3. leave router logs/traces intact for postmortem,
4. no OpenClaw source revert required.

## Example OpenClaw Config Shape (Draft)
```json5
{
  env: {
    QINGFU_ROUTER_API_KEY: "local-dev-key",
  },
  models: {
    providers: {
      qingfuCodex: {
        api: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:4318/v1",
        envKey: "QINGFU_ROUTER_API_KEY",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "qingfuCodex/gpt-5.4" },
    },
  },
}
```

> Final provider API shape may need adjustment once the exact OpenClaw provider schema is validated during implementation.

## Implementation Module Boundaries (v1)
### Proposed project structure
```text
qingfu-router/
├── src/
│   ├── server.ts                  # HTTP bootstrap / routing / lifecycle
│   ├── config/
│   │   ├── schema.ts              # env + file config schema
│   │   └── load.ts                # config loading / defaults
│   ├── ingress/
│   │   ├── chat-completions.ts    # POST /v1/chat/completions handler
│   │   └── responses.ts           # optional /v1/responses compatibility layer
│   ├── domain/
│   │   ├── types.ts               # internal request/attempt/result types
│   │   ├── classify.ts            # semantic success / empty-success classifier
│   │   ├── retry-policy.ts        # retryability + backoff decisions
│   │   └── state-machine.ts       # lifecycle transitions + invariants
│   ├── upstream/
│   │   ├── client.ts              # outbound HTTP client
│   │   ├── stream.ts              # streaming bridge + pre-commit buffer
│   │   └── headers.ts             # auth / correlation / passthrough headers
│   ├── traces/
│   │   ├── jsonl.ts               # append-only structured event logs
│   │   ├── sqlite.ts              # request summary storage
│   │   └── sink.ts                # trace writing abstraction
│   ├── errors/
│   │   ├── http.ts                # error normalization
│   │   └── terminal-payload.ts    # explicit exhausted-failure responses
│   └── tests/
│       ├── classifier.test.ts
│       ├── retry-policy.test.ts
│       ├── stream-buffer.test.ts
│       └── integration.test.ts
└── docs/
    ├── architecture.md
    ├── config.md
    └── operations.md
```

### Module responsibilities
- `ingress/*`: validate OpenAI-compatible request shapes and normalize them into internal request objects.
- `domain/classify.ts`: decide `semantic_success`, `empty_success`, `retryable_failure`, `terminal_failure`.
- `domain/retry-policy.ts`: encode targeted retry rules for the empty-reply problem.
- `upstream/stream.ts`: enforce pre-commit buffering and prevent downstream duplicate/partial replay.
- `traces/*`: make every attempt reconstructable after the fact.
- `errors/terminal-payload.ts`: ensure exhausted failures are explicit, never blank.

## Pseudocode — Core Empty-Success Classifier
```ts
function classifySemanticResult(result: UpstreamResult): SemanticClassification {
  if (result.explicitError) {
    return { kind: "error", retryable: isRetryableError(result.explicitError) };
  }

  if (result.hasValidToolCall) {
    return { kind: "semantic_success", reason: "tool_call" };
  }

  if (hasNonEmptyText(result.textFragments)) {
    return { kind: "semantic_success", reason: "text" };
  }

  if (hasNonEmptyRefusal(result.refusal)) {
    return { kind: "semantic_success", reason: "refusal" };
  }

  if (hasWhitelistedStructuredPayload(result.structuredPayload)) {
    return { kind: "semantic_success", reason: "structured_payload" };
  }

  if (result.transportCompleted && !result.explicitError) {
    return { kind: "empty_success", retryable: true };
  }

  return { kind: "error", retryable: false, reason: "unclassified" };
}
```

## Pseudocode — Attempt Loop
```ts
async function executeWithRetries(req: NormalizedRequest): Promise<FinalOutcome> {
  const ctx = createRequestContext(req);

  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
    traceAttemptStarted(ctx, attempt);

    const upstream = await callUpstream(req, ctx, attempt);
    const outcome = await evaluateOutcome(req, upstream, ctx, attempt);

    if (outcome.kind === "semantic_success") {
      traceSuccess(ctx, attempt, outcome);
      return buildSuccessResponse(outcome);
    }

    if (!outcome.retryable || attempt === ctx.maxAttempts || deadlineExceeded(ctx)) {
      traceTerminalFailure(ctx, attempt, outcome);
      return buildExplicitFailure(outcome, ctx, attempt);
    }

    await sleep(computeBackoff(outcome, attempt));
    traceRetryScheduled(ctx, attempt, outcome);
  }

  return buildExplicitFailure({ kind: "error", reason: "retry_loop_exhausted" }, ctx, ctx.maxAttempts);
}
```

## Pseudocode — Streaming Pre-Commit Buffer
```ts
async function handleStreamingAttempt(stream: UpstreamStream, ctx: RequestContext) {
  const buffer: StreamEvent[] = [];
  let committed = false;
  let seenMeaningful = false;

  for await (const event of stream) {
    const signal = inspectStreamEvent(event);

    if (!committed) {
      buffer.push(event);

      if (signal.meaningfulText || signal.meaningfulToolCall || signal.meaningfulRefusal) {
        seenMeaningful = true;
        committed = true;
        flushBufferedEvents(buffer);
        continue;
      }
    } else {
      forwardEvent(event);
    }
  }

  if (!committed && !seenMeaningful) {
    return { kind: "empty_success", retryable: true };
  }

  return { kind: "semantic_success", committed: true };
}
```

## Verification Matrix (Targeted)
| Scenario | Upstream shape | Expected router behavior | Why it matters |
|----------|----------------|--------------------------|----------------|
| Non-stream 200 with empty `message.content` and no tool call | 2xx pseudo-success | Retry | Direct match to observed empty-reply pathology |
| Non-stream 200 with whitespace-only content | 2xx pseudo-success | Retry | Prevent blank/space-only false successes |
| Non-stream 200 with valid tool call only | Structured success | Return success | Avoid retrying meaningful tool actions |
| Stream closes before first meaningful delta | Early close | Retry | Covers empty streamed completions |
| Stream sends only metadata/usage then ends | Pseudo-success | Retry | Matches “completed but empty” shape |
| Stream emits real text then fails | Post-commit failure | Surface explicit error, no transparent retry | Prevent duplicate/divergent downstream output |
| HTTP 429 with `Retry-After` | Transient HTTP failure | Retry after advised delay | Respect upstream throttling |
| HTTP 401/403 | Config/auth failure | Fail immediately | Non-retryable caller/config issue |
| Timeout before commit | Transport failure | Retry | Common transient failure |
| Empty-success on all attempts | Repeated pseudo-success | Return explicit exhausted failure | Must never devolve into blank success |

## Deliverables
- Project source for the local router.
- Example OpenClaw config for local `baseUrl` integration.
- Verification notes showing retry behavior.
- Rollback instructions to return OpenClaw directly to the original upstream.

## Key Questions
1. Is `/v1/chat/completions` sufficient for the target OpenClaw path if we configure the provider appropriately, or must we support `/v1/responses` in v1?
2. For streaming calls, what exact signal should count as “meaningful tool-call delta” for commit?
3. What exact OpenClaw provider schema should be used for the dedicated router entry during integration?
4. Which error payload shape best helps OpenClaw surface exhausted empty-success failures clearly?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use the `planning-with-files` workflow in a dedicated project folder | Keeps project memory durable and recoverable across sessions |
| Start with an OpenAI-compatible local gateway shape instead of an OpenClaw plugin | Lowest OpenClaw coupling; easiest to insert via `baseUrl`; avoids core patches |
| Prioritize same-provider same-model in-place retry for `gpt-5.4` | User explicitly prefers preserving `gpt-5.4` rather than automatic provider switching |
| Defer agent scoping details until the gateway implementation/integration path is clear | User said the gateway implementation and OpenClaw integration are more important than initial agent targeting |
| Treat `/v1/chat/completions` as the leading v1 ingress candidate | OpenClaw docs show working proxy precedent through chat completions; it is the simplest integration target |
| Treat `/v1/responses` as a compatibility question, not an assumed day-one requirement | Some OpenAI-native features are direct-OpenAI-specific; v1 should stay minimal unless responses support is proven necessary |
| Add a semantic success gate before returning any upstream “success” to OpenClaw | Directly targets the observed empty-reply pathology where a turn can finish as empty but still look successful |
| Treat empty-success as retryable failure | This is the core targeted defense against `content: []` / `stopReason: stop` / `replies=0` style incidents |
| Use a pre-commit buffer for streaming | Allows transparent retries only before any meaningful content/tool call has been forwarded downstream |
| Count valid tool/function calls as semantic success | Prevents accidental retry after the model has already produced a meaningful structured action |
| Use JSONL + SQLite for v1 observability | Intermittent empty-reply bugs need durable forensic evidence, not just in-memory counters |
| Keep rollout reversible via a dedicated provider entry | Makes it easy to test and back out without touching OpenClaw core |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Task plan became structurally duplicated during iterative edits | 1 | Rewrote the file cleanly as a single canonical plan |
| `using-git-worktrees` cannot be executed because the project directory is not a Git repository | 1 | Paused before implementation and requested user direction |

## Notes
- Project directory: `/home/seax/.openclaw/workspace/projects/qingfu-router`
- Use `findings.md` for external/documentation observations; avoid putting untrusted material into this plan file.
- The current plan favors the narrowest reversible path: config-only OpenClaw integration plus bounded retry behavior.
- The router’s core value is not “retry everything”; it is “refuse to treat semantic emptiness as success”.
- Re-read this file before major design decisions.
