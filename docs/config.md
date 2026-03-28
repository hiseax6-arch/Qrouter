# Qingfu Router Configuration

## Purpose
This document defines the intended configuration surface for qingfu-router and the minimal OpenClaw-side config needed to insert it.

## Configuration Principles
- Keep OpenClaw config changes **small and reversible**.
- Keep real upstream credentials/base URLs inside router config where possible.
- Make retry behavior explicit and inspectable.
- Make observability configurable but enabled by default in development.

## Current Runtime Reality
The current code now supports two config styles:
- legacy style: `providers` + `models.allow`
- explicit style: `providers` + `routes`

Compatibility rules:
- existing `config/router.json` keeps working unchanged
- if `routes` is present and `models.allow` is omitted, the allow-list is derived from route aliases
- provider secrets can now be declared with `apiKeyEnv`
- legacy `QINGFU_*` env names are accepted as compatibility aliases, but `Q_ROUTER_*`, `Q_UPSTREAM_*`, and `Q_TRACE_*` are the primary runtime names

Example explicit route shape:
```json
{
  "providers": {
    "codex": {
      "api": "openai-responses",
      "baseUrl": "https://codex.example.test/v1",
      "apiKeyEnv": "Q_CODEX_API_KEY"
    }
  },
  "routes": [
    {
      "id": "codex-main",
      "provider": "codex",
      "aliases": ["LR/gpt-5.4", "gpt-5.4", "codex/gpt-5.4"],
      "model": "gpt-5.4"
    }
  ]
}
```

## Router Config Layers
### 1. Environment variables
Good for secrets and deployment-specific values.

Suggested env vars:
- `QINGFU_ROUTER_PORT`
- `QINGFU_ROUTER_HOST`
- `QINGFU_ROUTER_API_KEY` (optional local guard)
- `QINGFU_UPSTREAM_BASE_URL`
- `QINGFU_UPSTREAM_API_KEY`
- `QINGFU_UPSTREAM_TIMEOUT_MS`
- `QINGFU_TRACE_DIR`
- `QINGFU_TRACE_SQLITE_PATH`

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
- model routing defaults,
- thinking compatibility policy.

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
    sqlitePath: "${QINGFU_TRACE_SQLITE_PATH}",
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

## Thinking Compatibility Switch
`thinking` config now has two layers:
- `mappingsEnabled`: whether custom thinking rewrite rules are active.
- `mappings`: optional explicit rewrite rules.

Recommended behavior:
- keep `mappingsEnabled: false` if you only want compatibility translation from `thinking` -> `reasoning.effort` for Responses/Codex upstreams;
- set `mappingsEnabled: true` only when you intentionally want custom remaps such as `low -> xhigh`.

Example:
```json
{
  "thinking": {
    "defaultMode": "pass-through",
    "mappingsEnabled": false,
    "mappings": [
      {
        "match": ["LR/gpt-5.4", "gpt-5.4"],
        "when": { "thinking": "low" },
        "rewrite": { "reasoning": { "effort": "xhigh" } }
      }
    ]
  }
}
```

With the example above, the rule is stored but inactive until `mappingsEnabled` is turned on.

## Provider Auth Behavior
- `auth: "api-key"` + `authHeader: true` => send `Authorization: Bearer <apiKey>`
- `auth: "api-key"` + `authHeader: false` => send `x-api-key: <apiKey>`
- `auth: "token"` / `auth: "oauth"` => send `Authorization: Bearer <apiKey>`
- explicit entries in `headers` are preserved and are not overwritten by generated auth headers
- `apiKeyEnv` now overrides derived env lookup and is the preferred way to bind provider secrets

## Debugging Effective Routes
The router now exposes:
- `GET /debug/routes`

Use it to inspect the effective alias -> provider -> upstream endpoint -> auth mode mapping without exposing secret values.

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
        api: "openai-completions",
        auth: "api-key",
        apiKey: "${QINGFU_ROUTER_API_KEY}",
        authHeader: true,
        baseUrl: "http://127.0.0.1:4318/v1",
        models: [
          { id: "gpt-5.4", name: "GPT-5.4 via Qingfu Router" }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: {
        primary: "qingfuCodex/gpt-5.4",
        fallbacks: ["codex/gpt-5.4"]
      },
      models: {
        "qingfuCodex/gpt-5.4": {
          alias: "GPT-5.4 via Qingfu Router"
        }
      }
    }
  }
}
```

> This is intentionally a **dedicated custom provider entry**, not an in-place overwrite of the current `codex` provider.

## Responses Compatibility Decision
### Current installation reality
The current live OpenClaw provider entry `codex` is configured with:
- `api: "openai-responses"`
- `baseUrl: "https://codex.0u0o.com/v1"`
- model `gpt-5.4`

That means **if we only swapped `baseUrl` on the existing `codex` provider**, qingfu-router would indeed need a `/v1/responses` surface.

### V1 decision
V1 avoids that requirement by introducing a **new dedicated provider entry** for the router:
- provider id: `qingfuCodex`
- api: `openai-completions`
- baseUrl: local qingfu-router `/v1`
- model path: `qingfuCodex/gpt-5.4`

This keeps qingfu-router aligned with the already-implemented `/v1/chat/completions` path and makes rollout/rollback cleaner. `/v1/responses` remains explicitly deferred until a later phase proves it is worth the added compatibility cost.

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
