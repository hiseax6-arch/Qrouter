# Q-router Model Routing Audit

## Scope
This note audits the current Q-router code structure and summarizes how downstream model IDs are mapped to upstream provider IDs, URLs, credentials, and thinking/reasoning settings.

The audit is based on:
- `config/router.json`
- `src/config/router.ts`
- `src/server.ts`
- `src/ingress/*`
- `src/upstream/client.ts`
- `src/integration/openclaw-config.ts`
- `src/tests/provider-routing.test.ts`
- `src/tests/router-config.test.ts`

## Structure Overview

### Config source
- `config/router.json`
  - static provider definitions
  - model allow-list
  - thinking rewrite rules
  - trace directory

### Runtime config loader
- `src/config/router.ts`
  - loads `config/router.json`
  - overlays env vars
  - resolves provider API keys with provider-specific env names such as `Q_CODEX_API_KEY`

### Ingress layer
- `src/server.ts`
  - mounts `POST /v1/chat/completions`
  - mounts `POST /v1/responses`
  - creates provider-aware upstream fetchers

- `src/ingress/model-normalization.ts`
  - normalizes `LR/...` aliases
  - can canonicalize bare `ms` to `LR/ms` if allowed

- `src/ingress/chat-completions.ts`
  - validates the allow-list
  - contains the special `LR/ms` round-robin logic
  - records model / provider / upstream URL / thinking rewrite trace data

- `src/ingress/responses.ts`
  - validates the allow-list
  - passes `/v1/responses` requests to a provider-aware passthrough path

### Upstream layer
- `src/upstream/client.ts`
  - selects the provider from the requested model
  - rewrites thinking / reasoning fields
  - converts `chat/completions` payloads into `responses` payloads for `openai-responses` providers
  - builds upstream URL and auth headers

### OpenClaw integration helper
- `src/integration/openclaw-config.ts`
  - adds a downstream OpenClaw provider alias `qingfuCodex/gpt-5.4`
  - points OpenClaw at the local Q-router base URL

## Current Mapping Chain

### Main runtime path
1. OpenClaw sends `model`.
2. `resolveRequestedModelAlias(...)` may rewrite it to an `LR/...` alias.
3. `chat-completions.ts` may further rewrite `LR/ms` into one concrete ModelScope model.
4. `resolveProviderSelection(...)` matches the resulting model against `providers[*].models[*].id`.
5. `rewriteThinking(...)` may rewrite `thinking` or `reasoning_effort`.
6. The selected provider decides:
   - upstream API shape (`openai-completions` vs `openai-responses`)
   - upstream URL suffix (`/chat/completions` vs `/responses`)
   - auth header style
   - final upstream model ID

## Downstream -> Upstream Mapping Table

| Downstream request model | Entry normalization | Provider | Upstream API | Upstream URL | API key source | Final upstream model | Thinking / thinklevel behavior |
|---|---|---|---|---|---|---|---|
| `LR/gpt-5.4` | `LR/` stripped during provider match and upstream call | `codex` | `openai-responses` | `https://codex.0u0o.com/v1/responses` | `Q_CODEX_API_KEY`, else `providers.codex.apiKey` | `gpt-5.4` | `thinking` / `reasoning_effort` is rewritten to `reasoning.effort`; current config keeps custom remaps disabled, so `low` stays `low` unless `mappingsEnabled` is turned on |
| `gpt-5.4` | implicitly matched to `codex` because `providers.codex.models[].id = gpt-5.4` | `codex` | `openai-responses` | `https://codex.0u0o.com/v1/responses` | `Q_CODEX_API_KEY`, else `providers.codex.apiKey` | `gpt-5.4` | same as above |
| `codex/gpt-5.4` | explicit provider-prefixed alias | `codex` | `openai-responses` | `https://codex.0u0o.com/v1/responses` | `Q_CODEX_API_KEY`, else `providers.codex.apiKey` | `gpt-5.4` | same as above |
| `LR/stepfun/step-3.5-flash:free` | `LR/` stripped before upstream call | `openrouter` | `openai-completions` | `https://openrouter.ai/api/v1/chat/completions` | `Q_OPENROUTER_API_KEY`, else `providers.openrouter.apiKey`, else fallback `Q_UPSTREAM_API_KEY` | `stepfun/step-3.5-flash:free` | no route-specific rewrite rule; if a caller sends `thinking` today, the generic rewrite code can still turn it into `reasoning.effort` before sending upstream |
| `stepfun/step-3.5-flash:free` | direct implicit match | `openrouter` | `openai-completions` | `https://openrouter.ai/api/v1/chat/completions` | `Q_OPENROUTER_API_KEY`, else `providers.openrouter.apiKey`, else fallback `Q_UPSTREAM_API_KEY` | `stepfun/step-3.5-flash:free` | same as above |
| `arcee-ai/trinity-large-preview:free` | direct implicit match | `openrouter` | `openai-completions` | `https://openrouter.ai/api/v1/chat/completions` | `Q_OPENROUTER_API_KEY`, else `providers.openrouter.apiKey`, else fallback `Q_UPSTREAM_API_KEY` | `arcee-ai/trinity-large-preview:free` | same as above |
| `MiniMax/MiniMax-M2.5` | direct implicit match | `modelscope` | `openai-completions` | `https://api-inference.modelscope.cn/v1/chat/completions` | `Q_MODELSCOPE_API_KEY`, else `providers.modelscope.apiKey` | `MiniMax/MiniMax-M2.5` | no explicit rewrite rule; generic rewrite still applies if caller sends `thinking` |
| `ZhipuAI/GLM-5` | direct implicit match | `modelscope` | `openai-completions` | `https://api-inference.modelscope.cn/v1/chat/completions` | `Q_MODELSCOPE_API_KEY`, else `providers.modelscope.apiKey` | `ZhipuAI/GLM-5` | same as above |
| `Qwen/Qwen3-235B-A22B` | direct implicit match | `modelscope` | `openai-completions` | `https://api-inference.modelscope.cn/v1/chat/completions` | `Q_MODELSCOPE_API_KEY`, else `providers.modelscope.apiKey` | `Qwen/Qwen3-235B-A22B` | same as above |
| `moonshotai/Kimi-K2.5` | direct implicit match | `modelscope` | `openai-completions` | `https://api-inference.modelscope.cn/v1/chat/completions` | `Q_MODELSCOPE_API_KEY`, else `providers.modelscope.apiKey` | `moonshotai/Kimi-K2.5` | same as above |
| `LR/ms` | special-cased in `chat-completions.ts`; rewritten to one ModelScope pool member using round robin | `modelscope` | `openai-completions` | `https://api-inference.modelscope.cn/v1/chat/completions` | `Q_MODELSCOPE_API_KEY`, else `providers.modelscope.apiKey` | one of `MiniMax/MiniMax-M2.5`, `ZhipuAI/GLM-5`, `Qwen/Qwen3-235B-A22B`, `moonshotai/Kimi-K2.5` | no explicit think mapping |
| `ms` | canonicalized to `LR/ms` when `models.allow` contains `LR/ms`, then handled as above | `modelscope` | `openai-completions` | `https://api-inference.modelscope.cn/v1/chat/completions` | `Q_MODELSCOPE_API_KEY`, else `providers.modelscope.apiKey` | same round-robin pool member | no explicit think mapping |

## Downstream OpenClaw Alias Mapping

The integration helper adds one extra downstream alias on the OpenClaw side:

| OpenClaw model path | OpenClaw provider entry | Local Q-router URL | Q-router internal model | Final upstream |
|---|---|---|---|---|
| `qingfuCodex/gpt-5.4` | generated by `applyQingfuRouterIntegration(...)` | `http://127.0.0.1:4318/v1` | request body model remains `gpt-5.4` inside Q-router | `codex -> /responses -> gpt-5.4` |

## Where ID / URL / KEY / THINKLEVEL Are Actually Resolved

### Model ID
- downstream allow-list:
  - `config/router.json -> models.allow`
- downstream alias normalization:
  - `src/ingress/model-normalization.ts`
- provider selection:
  - `src/upstream/client.ts -> resolveProviderSelection(...)`
- final upstream model:
  - `selection.upstreamModel`
  - plus special `LR/ms` rewrite in `src/ingress/chat-completions.ts`

### URL
- provider base URL:
  - `config/router.json -> providers.<provider>.baseUrl`
- endpoint suffix:
  - `/chat/completions` for `openai-completions`
  - `/responses` for `openai-responses`
- fallback upstream:
  - `config/router.json -> upstream.baseUrl`
  - used only when no provider match exists

### KEY
- provider-specific env lookup:
  - `Q_<PROVIDER_ID>_API_KEY`
- provider inline config fallback:
  - `providers.<provider>.apiKey`
- special openrouter fallback:
  - if provider is `openrouter`, it can also fall back to `Q_UPSTREAM_API_KEY`

### Thinklevel / reasoning
- request fields accepted today:
  - `thinking`
  - `reasoning_effort`
  - `reasoning.effort`
- rewrite logic:
  - `src/upstream/client.ts -> rewriteThinking(...)`
- current effective config:
  - `thinking.defaultMode = pass-through`
  - `thinking.mappingsEnabled = false`
  - stored custom rule for `gpt-5.4`: `low -> xhigh`, but currently inactive

## Key Findings

### 1. Routing data is split across three places
- `providers.*.models[*].id`
- `models.allow`
- hardcoded aliases inside ingress code, especially `LR/ms`

This means the same routing fact is represented multiple times, and the code must infer relationships that should be explicit.

### 2. Provider selection can be implicit and order-dependent
`resolveProviderSelection(...)` prefers explicit provider-prefixed aliases, but otherwise falls back to the first implicit match it encounters. If two providers ever expose the same model ID, the winner depends on config object iteration order.

### 3. `LR/ms` is not config-driven
`LR/ms` is implemented in `chat-completions.ts` with a hardcoded model pool and retry rotation policy. It is not declared in `config/router.json` as a real route.

### 4. Thinking rewrite is provider-agnostic even though the need is provider-specific
`rewriteThinking(...)` runs before the code branches by provider API. That makes sense for `codex` / `openai-responses`, but it also means `thinking` may be rewritten into `reasoning.effort` for ordinary `openai-completions` providers.

### 5. Auth config is overloaded
Auth behavior is inferred from `auth` plus `authHeader`. The same `auth: "api-key"` can produce either:
- `Authorization: Bearer ...`
- `x-api-key: ...`

That works, but the schema does not state the wire contract directly.

### 6. Secret handling is unsafe in the current checked-in config
`config/router.json` currently contains provider API keys inline. Even if this repository is local-only today, this is the highest-risk part of the current setup.

### 7. Naming is inconsistent
The repository mixes:
- `Q-router`
- `qingfu-router`
- `Q_ROUTER_*`
- `QINGFU_*`
- `.qingfu-router`
- `.Q-router`
- `x-qingfu-request-id`

This affects code, docs, trace directories, and OpenClaw integration helpers.

## Improvement Plan

### Priority 0: Remove secrets and make config fail-safe
1. Remove inline `apiKey` values from `config/router.json`.
2. Add an explicit `apiKeyEnv` field per provider instead of deriving env names from provider IDs.
3. Fail fast at startup when a required secret is missing.
4. Add a startup warning if a config file still contains raw API keys.

Suggested shape:

```json
{
  "providers": {
    "codex": {
      "api": "openai-responses",
      "baseUrl": "https://codex.0u0o.com/v1",
      "apiKeyEnv": "Q_CODEX_API_KEY"
    }
  }
}
```

### Priority 1: Replace implicit routing with an explicit route table
Move model exposure into a first-class `routes` section.

Suggested shape:

```json
{
  "routes": [
    {
      "id": "gpt54",
      "aliases": ["LR/gpt-5.4", "gpt-5.4", "codex/gpt-5.4"],
      "providerId": "codex",
      "upstreamModel": "gpt-5.4",
      "ingress": ["chat.completions", "responses"],
      "reasoningPolicy": "codex-default"
    }
  ]
}
```

Benefits:
- one source of truth for downstream aliases
- no more duplicated `models.allow`
- duplicate alias validation becomes possible
- provider selection no longer depends on object order

### Priority 1: Turn `LR/ms` into a declarative load-balancing route
Replace the hardcoded pool in `chat-completions.ts` with a config-driven route group:

```json
{
  "routes": [
    {
      "id": "ms",
      "aliases": ["LR/ms", "ms"],
      "providerId": "modelscope",
      "strategy": "round_robin",
      "members": [
        "MiniMax/MiniMax-M2.5",
        "ZhipuAI/GLM-5",
        "Qwen/Qwen3-235B-A22B",
        "moonshotai/Kimi-K2.5"
      ]
    }
  ]
}
```

Benefits:
- routing policy becomes inspectable
- retry rotation becomes data, not hidden code
- future pool changes do not require source edits

### Priority 1: Scope thinklevel rewrite to the route or provider
Introduce an explicit reasoning policy per route:
- `pass_through`
- `thinking_to_reasoning_effort`
- `rewrite_low_to_xhigh`

Only apply the policy when the selected route declares it. Do not run the generic rewrite for every provider.

### Priority 2: Make auth transport explicit
Replace `auth` + `authHeader` with a direct wire-level schema such as:

```json
{
  "auth": {
    "type": "bearer"
  }
}
```

or:

```json
{
  "auth": {
    "type": "header",
    "headerName": "x-api-key"
  }
}
```

Benefits:
- less branching logic
- easier onboarding for new providers
- docs and runtime behavior match directly

### Priority 2: Unify naming and operator surface
Pick one namespace and keep it everywhere. For example:
- project name: `Q-router`
- env vars: `Q_ROUTER_*`
- trace dir: `.q-router`
- request header: `x-q-router-request-id`
- OpenClaw alias/provider names: `qrouterCodex` or another neutral name

Keep compatibility aliases for one migration window if needed.

### Priority 2: Add a route-debug endpoint and startup validation
Add:
- `GET /debug/routes`
  - show resolved alias -> provider -> upstream URL -> upstream model -> auth mode -> reasoning policy
  - redact secrets

Add startup validation for:
- duplicate downstream aliases
- missing provider references
- missing required API keys
- allow-list entries that do not map to any route
- route entries unreachable by any ingress path

## Recommended Refactor Sequence
1. Secret removal and `apiKeyEnv`.
2. Route table introduction with backward-compatible derivation from old config.
3. Move `models.allow` generation behind the route table.
4. Migrate `LR/ms` to declarative strategy config.
5. Split reasoning policy by route/provider.
6. Rename the mixed `qingfu` surface to a single `q-router` namespace.
7. Add `/debug/routes` and startup validation.

## Verification Status
The current behavior described above is backed by the existing test suite:
- `src/tests/router-config.test.ts`
- `src/tests/provider-routing.test.ts`

Verified locally during this audit:
- `25` tests passed across routing/config coverage
- command run: `npm test -- src/tests/provider-routing.test.ts src/tests/router-config.test.ts`
