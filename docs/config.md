# Qingfu Router Configuration

## Purpose
This document defines the intended configuration surface for qingfu-router and the minimal OpenClaw-side config needed to insert it.

## Configuration Principles
- Keep OpenClaw config changes **small and reversible**.
- Keep real upstream credentials/base URLs inside router config where possible.
- Make retry behavior explicit and inspectable.
- Make observability configurable but enabled by default in development.

## Router Config Layers
### 1. Environment variables
Good for secrets and deployment-specific values.

Suggested env vars:
- `QINGFU_ROUTER_PORT`
- `QINGFU_ROUTER_HOST`
- `QINGFU_ROUTER_API_KEY` (optional local guard)
- `QINGFU_UPSTREAM_BASE_URL`
- `QINGFU_UPSTREAM_API_KEY`
- `QINGFU_TRACE_DIR`
- `QINGFU_SQLITE_PATH`

### 2. Local config file
Good for stable, non-secret policy settings.

Suggested file path:
- `config/router.json`
- or `config/router.json5`

Suggested contents:
- endpoint enablement,
- retry counts,
- backoff policy,
- timeout budgets,
- trace toggles,
- model routing defaults.

## Proposed Router Config Shape (Draft)
```json5
{
  server: {
    host: "127.0.0.1",
    port: 4318,
    apiKey: "${QINGFU_ROUTER_API_KEY}"
  },
  upstream: {
    baseUrl: "${QINGFU_UPSTREAM_BASE_URL}",
    apiKey: "${QINGFU_UPSTREAM_API_KEY}",
    timeoutMs: 45000
  },
  retry: {
    maxAttempts: 3,
    emptySuccessFastRetryMs: [200, 600],
    timeoutBackoffMs: [800, 1600],
    http5xxBackoffMs: [500, 1500],
    respectRetryAfter: true,
    deadlineBudgetMs: 60000
  },
  semantics: {
    treatWhitespaceOnlyAsEmpty: true,
    acceptToolCallsAsSuccess: true,
    acceptRefusalAsSuccess: true,
    acceptedStructuredPayloadKinds: []
  },
  traces: {
    jsonlDir: "${QINGFU_TRACE_DIR}",
    sqlitePath: "${QINGFU_SQLITE_PATH}",
    logRequestBodies: false,
    logResponseBodies: false
  }
}
```

## Semantic Policy Knobs
### Empty-success policy
Controls what counts as pseudo-success.

Suggested controls:
- whitespace-only text => empty,
- no text + no tool calls + no refusal => empty,
- optionally allow specific structured payload kinds later.

### Stream commit policy
Controls how cautious streaming is before first commit.

Suggested controls:
- minimum non-whitespace text required for commit,
- tool-call delta acceptance rule,
- refusal acceptance rule,
- max pre-commit buffer size.

## Retry Policy Knobs
Suggested configurable values:
- `maxAttempts`
- `deadlineBudgetMs`
- per-class backoff windows
- whether to retry on malformed 2xx payloads
- whether to respect upstream `Retry-After`

## OpenClaw Integration Config
### Strategy
Use a dedicated provider entry pointing at qingfu-router.

### Draft shape
```json5
{
  env: {
    QINGFU_ROUTER_API_KEY: "local-dev-key"
  },
  models: {
    providers: {
      qingfuCodex: {
        api: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:4318/v1",
        envKey: "QINGFU_ROUTER_API_KEY"
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "qingfuCodex/gpt-5.4" }
    }
  }
}
```

> Final schema may need adjustment after validating the exact OpenClaw provider format used in this installation.

## Rollout Strategy
### Narrow rollout
- create dedicated provider entry,
- point only one target model path at qingfu-router,
- verify behavior before broader adoption.

### Expansion later
- add more models,
- add more agents,
- optionally add provider-specific policy overrides.

## Rollback Strategy
### OpenClaw rollback
- restore the original provider/baseUrl,
- reload or restart affected runtime if required,
- keep qingfu-router traces for analysis.

### Router rollback
- stop the router service,
- revert config-only routing changes,
- leave SQLite/JSONL intact for postmortem.

## Secrets Handling
- Do not hardcode upstream secrets in OpenClaw model definitions.
- Prefer env vars for upstream API keys.
- Keep local router auth optional for local-only development, but document it from day one.

## Recommended Initial Defaults
- host: `127.0.0.1`
- port: `4318`
- max attempts: `3`
- traces: enabled
- request/response body logging: off by default
- endpoint support: `chat/completions` first

## Validation Checklist
- Router starts and listens on the expected host/port.
- OpenClaw provider entry points to router `baseUrl`.
- Requested model string remains `gpt-5.4`.
- Empty-success responses are retried.
- Exhausted empty-success becomes explicit failure, not blank success.
- Rollback to original upstream path is documented and tested.
