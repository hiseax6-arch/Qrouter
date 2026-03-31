# Q-router

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

Q-router is a local OpenAI-compatible gateway for OpenClaw. OpenClaw already has built-in routing, but Q-router provides a more flexible and independently evolvable routing layer for users who need custom retry, failover, failback, and upstream control without being tightly coupled to OpenClaw release changes.

## Core Capabilities
- Improves OpenClaw output stability when upstream providers are rate-limited, unstable, or inconsistent
- Automatically retries transient upstream failures before returning a bad result to OpenClaw
- Fails over to backup routes when a model or provider becomes unreliable
- Fails back to the primary route after recovery, so temporary degradation does not become permanent drift
- Rejects empty-success or malformed upstream responses to prevent blank assistant outputs
- Keeps routing explicit across multiple upstream model providers instead of relying on opaque provider-side switching
- Stores local request traces in JSONL and SQLite for debugging unstable outputs and incident review

## Who It Is For
Q-router is a good fit if you:
- run OpenClaw or similar tools locally
- need to route across multiple model sources
- often rely on free-tier or unstable third-party APIs
- want stronger control over retries, fallback chains, and route behavior
- need local traces for debugging upstream failures

## Who It Is Not For
Q-router may be unnecessary if you:
- only use one stable provider
- do not need routing control or fallback behavior
- do not care about empty-response filtering or local debug traces

## Why Q-router if OpenClaw already has routing?
OpenClaw already provides built-in routing, but Q-router is useful when you want a routing and stability layer that can evolve independently. It gives you finer-grained control over retry policy, fallback and failback behavior, upstream experiments, and machine-local routing rules without waiting for OpenClaw release changes.

## Recommended Free / Low-Cost API Sources
If you are getting started with Q-router, these upstream sources are commonly useful:

### OpenRouter
- Broad model selection
- Good for quickly testing multiple providers through one endpoint
- Useful when you want fast experimentation with free or low-cost models
- Availability and quotas may vary by model

### ModelScope (魔塔社区)
- Useful for China-based users or users who prefer domestic-accessible model endpoints
- Suitable for trying multiple open models with community-oriented access
- A practical option when you want an additional upstream source beyond OpenRouter

Q-router is especially useful when combining these kinds of upstreams, because free or community endpoints are often rate-limited, unstable, or inconsistent in response quality.

## Typical Use Cases
- Aggregating multiple free or low-cost model APIs behind one local endpoint
- Stabilizing unstable upstream providers with retry + fallback + failback
- Keeping OpenClaw model routing fully local and explicit
- Debugging intermittent empty or malformed upstream responses

## Repo Layout
- `src/`: server, ingress, routing, upstream client, traces, tests
- `config/router.example.json`: committed public template config
- `config/router.local.example.json`: minimal secret placeholder example for machine-local private overrides
- `config/model-mappings.json`: explicit route aliases and thinking mappings
- `docs/`: architecture, config, operations, routing audit notes, and error handling
- `examples/openclaw.qingfu-router.json5`: example OpenClaw integration patch

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Provide provider secrets with environment variables:
   ```bash
   export Q_OPENROUTER_API_KEY=replace-me
   export Q_CODEX_API_KEY=replace-me
   export Q_MODELSCOPE_API_KEY=replace-me
   ```
3. Optionally create a local private override file:
   ```bash
   cp config/router.example.json config/router.local.json
   ```
4. Start the router:
   ```bash
   npm run dev
   ```
5. Verify effective config:
   ```bash
   curl http://127.0.0.1:4318/health
   curl http://127.0.0.1:4318/debug/routes
   ```

The public repository tracks `config/router.example.json` only. Copy it to `config/router.local.json` (or `config/router.json`) before running Q-router. When present, `config/router.local.json` is merged on top of `config/router.json`. That file is gitignored and intended for private machine-specific settings.

## How Config Works
Q-router splits model configuration into two layers:

1. `provider` layer in your local `config/router.local.json` (usually copied from `config/router.example.json`) or `config/router.json`
   - defines upstream API type, base URL, auth mode, API key env var, and the list of real upstream models
2. `route` layer in `config/model-mappings.json`
   - defines which request aliases map to which provider/model pair
   - can also define fallback aliases and pool strategies

In practice:
- `api` decides upstream protocol:
  - `openai-completions` -> `<baseUrl>/chat/completions`
  - `openai-responses` -> `<baseUrl>/responses`
- `baseUrl` is the upstream root URL
- `apiKeyEnv` is the preferred way to bind secrets
- `routes[*].aliases` are caller-facing model names
- `routes[*].provider` + `routes[*].model` decide actual upstream target
- `routes[*].fallbacks` define candidate order after primary retry budget is exhausted
- `routes[*].failbackAfterMs` lets a `sticky-failover` route return to its primary member after cooldown

Config lookup order:
1. `Q_ROUTER_CONFIG_PATH`
2. `config/router.local.json`
3. `config/router.json`

If `config/router.local.json` exists, it is merged on top of the base config and is the recommended place for machine-local provider overrides.

## Why Not Direct Provider Access
Direct provider calls are simple, but you lose:
- unified retry orchestration
- explicit fallback/failover/failback control
- empty-success filtering
- unified local traces across providers

## Error Handling
Q-router classifies common upstream failure classes and decides whether to retry, fail over, or return a terminal error. For retryable classes that still exhaust all attempts, it returns an explicit downstream-visible hint instead of ambiguous blank success.

See:
- `docs/error-handling.md`
- `docs/operations.md`

## Commands
- `npm run dev`: start in watch mode
- `npm run build`: compile TypeScript into `dist/`
- `npm start`: run the built server
- `npm test`: run the full test suite
- `npm run preview:openclaw`: preview the OpenClaw integration patch

## Docs
- `docs/architecture.md`
- `docs/config.md`
- `docs/operations.md`
- `docs/error-handling.md`
- `docs/model-routing-audit.md`
