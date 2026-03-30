# Q-router

Q-router is a local OpenAI-compatible gateway for OpenClaw. It sits between OpenClaw and upstream providers, keeps model routing explicit, and prevents empty or malformed upstream "success" payloads from being returned as normal completions.

## What It Does
- forwards `chat/completions` and provider-aware `responses` traffic
- retries transient failures before commit
- rejects empty-success responses instead of returning blank assistant output
- keeps request traces in JSONL and SQLite for incident review
- exposes effective route metadata through `/health` and `/debug/routes`

## Repo Layout
- `src/`: server, ingress, routing, upstream client, traces, tests
- `config/router.json`: committed, secret-free baseline config
- `config/router.local.example.json`: sample for machine-local private overrides
- `config/model-mappings.json`: explicit route aliases and thinking mappings
- `docs/`: architecture, config, operations, and routing audit notes
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
   cp config/router.local.example.json config/router.local.json
   ```
4. Start the router:
   ```bash
   npm run dev
   ```
5. Verify the effective config:
   ```bash
   curl http://127.0.0.1:4318/health
   curl http://127.0.0.1:4318/debug/routes
   ```

When present, `config/router.local.json` is merged on top of `config/router.json`. That file is gitignored and intended for private machine-specific settings.

## How Config Works
Q-router splits model configuration into two layers:

1. `provider` layer in `config/router.json` or `config/router.local.json`
   - defines the upstream API type, base URL, auth mode, API key env var, and the list of real upstream models
2. `route` layer in `config/model-mappings.json`
   - defines which request aliases map to which provider/model pair
   - can also define fallback aliases and pool strategies

In practice:
- `api` decides the upstream protocol:
  - `openai-completions` -> `<baseUrl>/chat/completions`
  - `openai-responses` -> `<baseUrl>/responses`
- `baseUrl` is the upstream root URL
- `apiKeyEnv` is the preferred way to bind secrets
- `routes[*].aliases` are the model names callers use
- `routes[*].provider` + `routes[*].model` decide the actual upstream target
- `routes[*].fallbacks` defines the preferred candidate order after the primary route exhausts its retry budget
- `routes[*].failbackAfterMs` lets a `sticky-failover` route return to its primary member after a cooldown

Config lookup order:
1. `Q_ROUTER_CONFIG_PATH`
2. `config/router.local.json`
3. `config/router.json`

If `config/router.local.json` exists, it is merged on top of the base config and is the recommended place for machine-local provider overrides.

Fallback behavior:
- each candidate model gets its own retry budget
- when one candidate exhausts its budget, Q-router moves to the next alias in `fallbacks`
- newly added routes are automatically appended to the default fallback chain if you do not specify a full list manually
- `sticky-failover` routes remember the active member across requests, but now support timed failback to the first member

If a request must never leave the originally requested model, send either:

```json
{
  "qrouter": {
    "noFallback": true
  }
}
```

or the header:

```bash
-H 'x-qrouter-no-fallback: true'
```

## Add A Model
This is the full flow for adding one new OpenAI-compatible `chat/completions` model named `foo-1` from a new provider.

### 1. Add the provider
Create or update `config/router.local.json`:

```json
{
  "providers": {
    "myprovider": {
      "api": "openai-completions",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "Q_MYPROVIDER_API_KEY",
      "auth": "api-key",
      "authHeader": true,
      "models": [
        {
          "id": "foo-1",
          "name": "Foo 1",
          "contextWindow": 128000,
          "maxTokens": 16000
        }
      ]
    }
  }
}
```

### 2. Add the route alias
Update `config/model-mappings.json`:

```json
{
  "routes": [
    {
      "id": "myprovider-foo-1",
      "provider": "myprovider",
      "aliases": [
        "LR/foo-1",
        "foo-1",
        "myprovider/foo-1"
      ],
      "model": "foo-1"
    }
  ]
}
```

If you want automatic fallback, add `fallbacks`:

```json
{
  "id": "myprovider-foo-1",
  "provider": "myprovider",
  "aliases": ["LR/foo-1", "foo-1", "myprovider/foo-1"],
  "fallbacks": ["LR/stepfun/step-3.5-flash:free"],
  "model": "foo-1"
}
```

If the route is a sticky pool and you want it to return to its primary member after a cooldown, add `failbackAfterMs`:

```json
{
  "id": "myprovider-pool",
  "provider": "myprovider",
  "aliases": ["LR/foo-pool"],
  "strategy": "sticky-failover",
  "members": ["foo-1", "foo-1-mini"],
  "failbackAfterMs": 300000
}
```

### 3. Export the API key
```bash
export Q_MYPROVIDER_API_KEY=replace-me
```

### 4. Restart the router
```bash
npm run dev
```

### 5. Verify the effective route
```bash
curl http://127.0.0.1:4318/debug/routes
```

You should see:
- `providerId: "myprovider"`
- `providerApi: "openai-completions"`
- `upstreamEndpoint: "https://api.example.com/v1/chat/completions"`
- aliases including `LR/foo-1` and `foo-1`

### 6. Send a test request
```bash
curl http://127.0.0.1:4318/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "foo-1",
    "messages": [
      { "role": "user", "content": "Say hello." }
    ]
  }'
```

To force this request to stay on the originally requested model only:

```bash
curl http://127.0.0.1:4318/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-qrouter-no-fallback: true' \
  -d '{
    "model": "foo-1",
    "messages": [
      { "role": "user", "content": "Say hello." }
    ]
  }'
```

If the provider uses the OpenAI Responses API instead, keep the same route pattern but change the provider config:

```json
{
  "providers": {
    "myresponses": {
      "api": "openai-responses",
      "baseUrl": "https://responses.example.com/v1",
      "apiKeyEnv": "Q_MYRESPONSES_API_KEY",
      "auth": "api-key",
      "authHeader": true,
      "models": [
        {
          "id": "bar-1",
          "name": "Bar 1"
        }
      ]
    }
  }
}
```

The matching route still looks the same:

```json
{
  "id": "myresponses-bar-1",
  "provider": "myresponses",
  "aliases": ["LR/bar-1", "bar-1", "myresponses/bar-1"],
  "model": "bar-1"
}
```

Q-router will then send that route to `<baseUrl>/responses` automatically.

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
- `docs/model-routing-audit.md`
