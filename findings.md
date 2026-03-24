# Findings & Decisions

## Requirements
- Build this project using the `planning-with-files` skill/workflow.
- The preferred integration shape is **B. OpenAI-compatible local gateway**.
- The router should preserve `gpt-5.4` as the main path.
- Retry policy preference is **same provider, same model, in-place retry**.
- The immediate priority is solving **how the gateway is implemented and how it connects into OpenClaw**.
- Agent scope is intentionally deferred for now.

## Research Findings
- `planning-with-files` requires project-local `task_plan.md`, `findings.md`, and `progress.md` as durable working memory.
- OpenClaw documentation confirms many providers can be inserted through `models.providers.<id>.baseUrl`, including OpenAI-compatible backends and proxies.
- OpenClaw docs include examples of pointing OpenClaw at OpenAI-compatible local/proxy endpoints via custom provider `baseUrl`.
- For this project, a local router inserted through `baseUrl` is a lower-coupling approach than building directly against OpenClaw plugin hooks first.
- The `Free-Token-Router` repo reviewed earlier is only a weak reference: useful for retry/state ideas, but not a real OpenClaw-compatible routing gateway design.
- `docs/providers/openai.md` confirms `openai/*` and `openai-codex/*` default to transport `auto`, meaning **WebSocket-first with SSE fallback** in OpenClaw.
- The same OpenAI doc shows transport can be forced per model via `agents.defaults.models.<provider/model>.params.transport` (`sse`, `websocket`, or `auto`).
- `docs/providers/claude-max-api-proxy.md` provides a direct precedent for OpenClaw integration by pointing `OPENAI_BASE_URL` at a local OpenAI-compatible endpoint (`http://localhost:3456/v1`) and then selecting an `openai/...` model.
- That proxy example strengthens the gateway approach: OpenClaw can consume a local OpenAI-compatible service without any OpenClaw core modifications.
- `docs/providers/openai.md` also shows some features are specific to **direct OpenAI Responses models** on `api.openai.com` (for example server-side compaction injection), which implies a local proxy may not need to replicate every OpenAI-native behavior for v1.
- `docs/providers/litellm.md` states OpenClaw connects to LiteLLM through the OpenAI-compatible **`/v1/chat/completions`** endpoint and says all OpenClaw features work through it. This is strong evidence that a `chat/completions`-first local gateway is a viable initial integration target.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Dedicated project folder under `workspace/projects/qingfu-router` | Keeps planning files and implementation isolated from the general workspace |
| OpenAI-compatible gateway as first implementation target | Most direct path to OpenClaw integration without core source edits |
| Preserve model/provider identity during retries | Matches user preference and keeps semantics stable while diagnosing reliability |
| Treat provider switching as out of scope for v1 | User explicitly prefers retrying `gpt-5.4` rather than auto-switching providers |
| Add a semantic success gate before returning any upstream “success” to OpenClaw | Directly targets the observed empty-reply pathology where a turn can finish as empty but still look successful |
| Treat empty-success as retryable failure | This is the core targeted defense against `content: []` / `stopReason: stop` / `replies=0` style incidents |
| Use a pre-commit buffer for streaming | Allows transparent retries only before any meaningful content/tool call has been forwarded downstream |
| Count valid tool/function calls as semantic success | Prevents accidental retry after the model has already produced a meaningful structured action |
| Use a request/response state machine with explicit `pre_commit_buffering`, `semantic_success`, and `terminal_failure` states | Makes the empty-reply defense implementable instead of hand-wavy |
| Use JSONL + SQLite for v1 observability | Intermittent no-reply bugs need durable forensic traces and queryable summaries |
| Roll out via a dedicated OpenClaw provider entry with easy rollback | Keeps the integration reversible and low-risk |
| Separate implementation into ingress / domain / upstream / traces / errors modules | Keeps the empty-success logic centralized instead of smeared through HTTP handlers |
| Put semantic success classification in a dedicated domain classifier | This is the heart of the bug defense and needs isolated tests |
| Add a targeted verification matrix for pseudo-success and pre-commit failures | Prevents the design from only testing ordinary timeout/HTTP cases |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| None yet | Initial planning setup completed without blockers |

## Resources
- Skill: `/home/seax/.openclaw/skills/planning-with-files/SKILL.md`
- Project dir: `/home/seax/.openclaw/workspace/projects/qingfu-router`
- OpenClaw docs root: `/home/seax/.nvm/versions/node/v25.6.0/lib/node_modules/openclaw/docs`
- Relevant docs discovered during initial scan:
  - `docs/providers/openai.md`
  - `docs/providers/litellm.md`
  - `docs/providers/vllm.md`
  - `docs/providers/claude-max-api-proxy.md`
  - `docs/providers/sglang.md`
  - `docs/providers/openrouter.md`

## Visual/Browser Findings
- None yet.

---
*Update this file after every 2 view/browser/search operations*
*This prevents visual information from being lost*
