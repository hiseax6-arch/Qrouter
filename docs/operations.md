# Qingfu Router Operations

## Purpose
This document is the operator runbook for starting, verifying, troubleshooting, and rolling back qingfu-router.

## Operating Goals
- keep the router easy to start/stop,
- make empty-reply incidents diagnosable,
- keep rollout reversible,
- avoid masking upstream failures as blank success.

## Initial Runbook
### Start
Expected future command shape (draft):
```bash
npm run build
npm start
# or
node dist/server.js
```

### Verify listener
Check that the router is reachable on the configured host/port, e.g. `127.0.0.1:4318`.

### Verify effective routing
Inspect:
- `GET /health`
- `GET /debug/routes`

`/debug/routes` is the quickest way to confirm which aliases, providers, upstream endpoints, auth modes, and route strategies are currently active.

### Verify OpenClaw path
- confirm the dedicated provider entry points at qingfu-router,
- send one narrow test request through that provider path,
- confirm traces show the request.

## Health Signals
### Healthy request
A healthy request should produce:
- one request id,
- one or more attempt records,
- semantic success classification,
- committed downstream response,
- no exhausted failure.

### Suspicious request
A suspicious request includes any of:
- repeated `empty_success`,
- repeated timeouts on same model,
- repeated `alias_model_rotated` events for `LR/ms`,
- unexpected route/provider resolution in `/debug/routes`,
- post-commit upstream failures,
- no traces for a request that should have passed through router.

## Empty-Reply Incident Runbook
### Symptom
OpenClaw/gateway side suggests a model turn completed but no actual user-facing reply was delivered.

### What to check
1. Look up the router request ID by time window.
2. Inspect attempt history in JSONL.
3. Inspect final summary in SQLite.
4. Determine classification:
   - `semantic_success`
   - `empty_success_exhausted`
   - `timeout_exhausted`
   - `http_429_exhausted`
   - `terminal_client_error`
5. Confirm whether the request ever committed downstream.

### Desired outcome
For the target bug class, the router should show either:
- a successful retry after empty-success, or
- an explicit exhausted failure.

It should **not** show a blank success.

## Streaming Incident Runbook
### Symptom
A streaming request appears to produce nothing, or appears truncated.

### What to check
- whether pre-commit buffering ever observed meaningful output,
- whether commit happened,
- whether the stream closed before commit,
- whether the router retried or surfaced explicit failure.

### Key rule
If commit already happened, no transparent retry should have occurred.

## Logging & Trace Locations
### JSONL
Expected use:
- chronological raw event review,
- per-attempt timing,
- transition inspection.

### SQLite
Expected use:
- summary lookup by request id,
- counts by model or failure class,
- daily incident review.

### Daily token stats
Use:
- `GET /stats/tokens/daily`
- optional query params: `date=YYYY-MM-DD`, `model=<model-id>`, `limit=<n>`

Returned dimensions:
- date
- model
- requestCount
- promptTokens
- completionTokens
- totalTokens

For `LR/ms`, token usage is attributed to the concrete ModelScope backend selected for that request attempt.

## Failure Classes to Expect
- `empty_success`
- `timeout`
- `connection_error`
- `http_429`
- `http_5xx`
- `terminal_client_error`
- `post_commit_interrupted`
- post-commit error detail: `stream_interrupted_after_commit`

## Operator Questions During Incident Review
- Did the router see the request at all?
- How many attempts were made?
- Was the failure retryable?
- Did semantic success ever occur?
- Did commit happen before failure?
- Was final outcome explicit or ambiguous?

## Rollout Runbook
### Narrow rollout
1. start router locally,
2. preview the candidate OpenClaw patch:
   ```bash
   npm run preview:openclaw -- /home/seax/.openclaw/openclaw.json
   ```
3. add the dedicated provider entry `qingfuCodex` with `api: "openai-completions"`,
4. set primary model to `qingfuCodex/gpt-5.4`,
5. preserve `codex/gpt-5.4` as fallback,
6. send one controlled request,
7. verify traces,
8. verify OpenClaw receives either semantic success or explicit failure.

## Exact Config Diff (Narrow Rollout)
### Paths changed by apply step
- `env.Q_ROUTER_API_KEY`
- `models.providers.qingfuCodex`
- `agents.defaults.model.primary`
- `agents.defaults.model.fallbacks`
- `agents.defaults.models.qingfuCodex/gpt-5.4`

### Resulting target state
- `primary = "qingfuCodex/gpt-5.4"`
- `fallbacks = ["codex/gpt-5.4"]`
- `models.providers.qingfuCodex.api = "openai-completions"`
- `models.providers.qingfuCodex.baseUrl = "http://127.0.0.1:4318/v1"`

## Rollback Runbook
### Immediate rollback
1. preview the rollback candidate:
   ```bash
   npm run preview:openclaw -- /home/seax/.openclaw/openclaw.json rollback
   ```
2. restore `agents.defaults.model.primary` to `codex/gpt-5.4`,
3. remove `codex/gpt-5.4` from fallback position if it was only inserted for qingfu-router rollout,
4. remove `models.providers.qingfuCodex`,
5. remove `agents.defaults.models["qingfuCodex/gpt-5.4"]`,
6. optionally remove `env.Q_ROUTER_API_KEY` if it was added only for this rollout,
7. reload or restart the affected runtime if needed,
8. confirm new requests no longer hit qingfu-router,
9. preserve trace artifacts for postmortem.

### Paths changed by rollback step
- `agents.defaults.model.primary`
- `agents.defaults.model.fallbacks`
- `models.providers.qingfuCodex`
- `agents.defaults.models.qingfuCodex/gpt-5.4`
- optional: `env.Q_ROUTER_API_KEY`

## Pre-Release Test Checklist
- non-stream success works,
- empty 2xx non-stream gets retried,
- whitespace-only non-stream gets retried,
- tool-call-only success is accepted,
- stream closes before commit and gets retried,
- stream with real content commits once,
- exhausted empty-success returns explicit failure,
- `LR/ms` rotates across the configured ModelScope backends,
- retryable `LR/ms` failures rotate to the next ModelScope backend before exhausting,
- apply/rollback config preview matches the intended diff,
- rollback path works cleanly.

## Future Operations Enhancements
- small operator CLI for trace lookup,
- daily summary queries from SQLite,
- health endpoint,
- lightweight dashboard once core path is stable.
