# Progress Log

## Session: 2026-03-24

### Phase 1: Requirements & Discovery
- **Status:** complete
- **Started:** 2026-03-24 09:09 Asia/Shanghai
- **Completed:** 2026-03-24 09:13 Asia/Shanghai
- Actions taken:
  - Read the `planning-with-files` skill instructions.
  - Created a dedicated project directory for the router project.
  - Read the planning templates for `task_plan.md`, `findings.md`, and `progress.md`.
  - Initialized all three planning files with the current project goal, phases, and constraints.
  - Seeded the findings file with current confirmed preferences: OpenAI-compatible local gateway, same-provider same-model retry, and OpenClaw `baseUrl` integration focus.
  - Read relevant OpenClaw provider docs to confirm integration precedent and transport defaults.
  - Captured that `openai-codex/*` defaults to `transport: auto` (WebSocket-first, SSE fallback) and that OpenClaw already supports local OpenAI-compatible proxies via `OPENAI_BASE_URL`.
  - Confirmed from docs that direct OpenAI Responses-specific features are special-cased, while OpenClaw can also work through an OpenAI-compatible `/v1/chat/completions` proxy path (e.g. LiteLLM).
- Files created/modified:
  - `task_plan.md` (created)
  - `findings.md` (created)
  - `progress.md` (created)

### Phase 2: Interface & Architecture Design
- **Status:** complete
- **Started:** 2026-03-24 09:13 Asia/Shanghai
- **Completed:** 2026-03-24 10:43 Asia/Shanghai
- Actions taken:
  - Expanded `task_plan.md` from a high-level outline into an executable engineering plan.
  - Added success criteria, non-goals, architecture draft, deliverables, and more detailed phase breakdown.
  - Elevated `/v1/chat/completions` to the leading v1 ingress candidate while explicitly keeping `/v1/responses` as a compatibility question to validate later.
  - Added a targeted retry policy section designed specifically around the empty-reply failure mode.
  - Wrote down the semantic success gate, empty-success classification, retryable/non-retryable taxonomy, streaming pre-commit buffer strategy, retry budget, and explicit failure surfacing rules.
  - Added request/response state machine detail, persistence/observability decision, OpenClaw integration strategy, rollout path, rollback path, and a draft config shape.
  - Cleaned and rewrote `task_plan.md` after iterative edits introduced structural duplication.
  - Added implementation module boundaries so the eventual codebase has clear ownership lines.
  - Added pseudocode for the semantic classifier, retry attempt loop, and streaming pre-commit buffer.
  - Added a targeted verification matrix centered on pseudo-success / empty-reply incidents.
  - Created implementation-facing documentation skeletons for architecture, config, and operations so the design can be carried forward without re-deriving core decisions.
- Files created/modified:
  - `task_plan.md` (expanded multiple times)
  - `findings.md` (updated)
  - `progress.md` (updated)
  - `docs/architecture.md` (created)
  - `docs/config.md` (created)
  - `docs/operations.md` (created)

### Phase 3: Prototype Implementation
- **Status:** complete
- **Started:** 2026-03-24 10:43 Asia/Shanghai
- **Completed:** 2026-03-24 11:01 Asia/Shanghai
- Actions taken:
  - Locked the v1 implementation stack to Node.js + TypeScript + Fastify + `fetch`/`undici` + `better-sqlite3`.
  - Started Batch 1 in the isolated worktree using TDD.
  - Added the initial project scaffold: `package.json`, `tsconfig.json`, and the first source/test directories.
  - Wrote failing tests first for the semantic classifier and `/v1/chat/completions` retry behavior.
  - Verified the red phase by confirming tests failed because the target modules did not exist yet.
  - Implemented the first non-streaming path: classifier, terminal empty-success payload, upstream client, chat-completions handler, and Fastify server bootstrap.
  - Added the streaming pre-commit path so empty pre-commit SSE streams are retried before anything is forwarded downstream.
  - Added durable forensics with JSONL event logs and SQLite request summaries.
  - Verified green with `npm test` (2 files / 8 tests passing) and `npm run build`.
  - Fixed one TypeScript follow-up issue by adding the missing `role` field to semantic carriers and installing `@types/better-sqlite3`.
- Files created/modified:
  - `package.json` (created in worktree)
  - `package-lock.json` (created in worktree)
  - `tsconfig.json` (created in worktree)
  - `src/server.ts` (created in worktree)
  - `src/ingress/chat-completions.ts` (created in worktree)
  - `src/upstream/client.ts` (created in worktree)
  - `src/domain/classify.ts` (created in worktree)
  - `src/errors/terminal-payload.ts` (created in worktree)
  - `src/traces/store.ts` (created in worktree)
  - `src/tests/classifier.test.ts` (created in worktree)
  - `src/tests/integration.test.ts` (created in worktree)

### Phase 4: Optional Responses Compatibility
- **Status:** complete
- **Started:** 2026-03-24 11:19 Asia/Shanghai
- **Completed:** 2026-03-24 11:23 Asia/Shanghai
- Actions taken:
  - Verified from the live OpenClaw config that the current production-like provider id `codex` uses `api: "openai-responses"` with model `gpt-5.4`.
  - Verified from OpenClaw docs/config schema that a custom provider can instead use `api: "openai-completions"` with a dedicated `baseUrl` and model catalog.
  - Concluded that qingfu-router does **not** need `/v1/responses` in v1 as long as we introduce a new dedicated provider entry (`qingfuCodex`) instead of mutating the live `codex` provider in place.
  - Corrected the config doc to use the real OpenClaw API adapter label `openai-completions`.
  - Documented the defer decision: `/v1/responses` remains out of scope for v1 unless a later integration step proves it is necessary.
- Files created/modified:
  - `task_plan.md` (Phase 4 marked complete)
  - `findings.md` (updated with provider-API decision)
  - `progress.md` (rewritten cleanly and updated)
  - `docs/config.md` (corrected provider API + added compatibility decision section)

### Phase 5: OpenClaw Integration
- **Status:** complete
- **Started:** 2026-03-24 11:25 Asia/Shanghai
- **Completed:** 2026-03-24 11:40 Asia/Shanghai
- Actions taken:
  - Added `src/integration/openclaw-config.ts` to generate a dedicated `qingfuCodex` provider integration patch without overwriting the live `codex` provider.
  - Added `src/integration/preview.ts` so the integration can be previewed directly against a real OpenClaw config file.
  - Added `src/tests/openclaw-config.test.ts` to verify the integration helper preserves the existing provider while introducing `qingfuCodex/gpt-5.4` cleanly.
  - Added `examples/openclaw.qingfu-router.json5` as a concrete config snippet for the router-backed provider.
  - Rewrote `docs/config.md` so the OpenClaw integration section matches the actual implementation and uses `api: "openai-completions"`.
  - Added rollback support in the integration helper so the candidate config can be returned cleanly to `codex/gpt-5.4`.
  - Added exact changed-path derivation for both apply and rollback flows.
  - Rewrote `docs/operations.md` to include narrow rollout, exact config diff, rollback preview, and rollback path checklist.
  - Verified the narrow integration path by running the preview helper against the real `/home/seax/.openclaw/openclaw.json` and confirming the rendered summary:
    - `primary: "qingfuCodex/gpt-5.4"`
    - `fallbacks: ["codex/gpt-5.4"]`
    - `providerApi: "openai-completions"`
    - `providerBaseUrl: "http://127.0.0.1:4318/v1"`
  - Verified the rollback path by previewing the reverse transition and confirming:
    - `primary: "codex/gpt-5.4"`
    - `fallbacks: []`
    - `providerApi: null`
    - `providerBaseUrl: null`
  - Added repeatable preview scripts to `package.json`.
- Files created/modified:
  - `src/integration/openclaw-config.ts` (created and expanded in worktree)
  - `src/integration/preview.ts` (created and expanded in worktree)
  - `src/tests/openclaw-config.test.ts` (created and expanded in worktree)
  - `examples/openclaw.qingfu-router.json5` (created in worktree)
  - `docs/config.md` (rewritten to match Phase 5 implementation)
  - `docs/operations.md` (rewritten with rollout/rollback runbook)
  - `package.json` (added preview scripts)
  - `task_plan.md` (Phase 5 marked complete)
  - `findings.md` (updated with rollback evidence)
  - `progress.md` (updated)

### Phase 6: Verification & Hardening
- **Status:** complete
- **Started:** 2026-03-24 11:45 Asia/Shanghai
- **Completed:** 2026-03-24 13:30 Asia/Shanghai
- Actions taken:
  - Reviewed the current integration and ingress tests against the Phase 6 checklist.
  - Confirmed normal semantic success already had direct integration-test coverage.
  - Confirmed empty-success retry already had direct integration-test coverage for both retry-success and retry-exhausted paths.
  - Added explicit timeout classification logic so timeout-like thrown errors no longer collapse into generic `connection_error`.
  - Added abort-based upstream timeout support in `createFetchUpstream(...)` with `QINGFU_UPSTREAM_TIMEOUT_MS` support.
  - Added a focused timeout recovery integration test that proves a timeout-classified first attempt can retry and later succeed.
  - Added `verify:phase6` npm script for repeatable verification of the Phase 6 integration surface.
  - Debugged and fixed implementation mistakes discovered during verification:
    - a stray duplicated fragment in `chat-completions.ts` introduced during edit surgery,
    - a missing helper definition for `classifyThrownUpstreamError(...)` in the source path.
  - Added a post-commit streaming failure test that proves the router does not retry or double-send after commit and instead emits an explicit SSE error event.
  - Added a timeout exhaustion test that proves retryable failures surface as explicit `upstream_retry_exhausted` responses with sufficient trace evidence.
  - Verified that JSONL and SQLite traces are sufficient to reconstruct attempts, retry reasons, commit state, and final outcome for both success and failure cases.
  - Re-ran the full verification set after fixes until test/build were green.
- Files created/modified:
  - `src/ingress/chat-completions.ts` (timeout classification + cleanup fixes)
  - `src/upstream/client.ts` (abort-based timeout support)
  - `src/server.ts` (wired `QINGFU_UPSTREAM_TIMEOUT_MS` into upstream client creation)
  - `src/tests/integration.test.ts` (expanded to cover timeout retry, post-commit interruption, and exhaustion diagnostics)
  - `package.json` (added `verify:phase6`)
  - `task_plan.md` (Phase 6 marked complete)
  - `findings.md` (updated with final Phase 6 evidence)
  - `progress.md` (updated)
  - `docs/config.md` (documented `QINGFU_UPSTREAM_TIMEOUT_MS`)
  - `docs/operations.md` (aligned failure-class terminology with the implementation)

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Project folder init | `mkdir -p /home/seax/.openclaw/workspace/projects/qingfu-router` | Directory exists | Directory created successfully | ✓ |
| Planning templates read | Skill template paths | Templates readable | All 3 templates read successfully | ✓ |
| Task plan continuity | Re-read after multiple edits | Single coherent plan | Plan cleaned and unified | ✓ |
| Classifier red test | Empty/Tool-call chat completion payloads | Fail because classifier module missing | Failed on missing `src/domain/classify.ts` as expected | ✓ |
| Integration red test | `POST /v1/chat/completions` route tests | Fail because server module missing | Failed on missing `src/server.ts` as expected | ✓ |
| Batch 1 green test | `npm test` | All new tests pass | 2 files / 4 tests passed | ✓ |
| Streaming + traces green test | `npm test` after Batch 2 additions | New streaming/traces tests pass | 2 files / 8 tests passed | ✓ |
| TypeScript build | `npm run build` | Compile cleanly | `tsc -p tsconfig.json` passed | ✓ |
| Phase 4 provider compatibility review | Live config + docs/schema review | Decide whether `/v1/responses` is required for v1 | Determined v1 can stay on `chat/completions` by using dedicated provider `qingfuCodex` with `api: "openai-completions"` | ✓ |
| OpenClaw integration helper test | `src/tests/openclaw-config.test.ts` | Preserve live provider + add dedicated router provider cleanly | 6 tests passed | ✓ |
| Narrow integration preview | `npx tsx src/integration/preview.ts /home/seax/.openclaw/openclaw.json` | Render one safe candidate config path for the real installation | Preview produced `qingfuCodex/gpt-5.4` with fallback to `codex/gpt-5.4` | ✓ |
| Rollback preview | `npx tsx src/integration/preview.ts /home/seax/.openclaw/openclaw.json rollback` | Show clean return path back to direct upstream | Preview restored `codex/gpt-5.4` and removed `qingfuCodex` provider from candidate state | ✓ |
| Full Phase 6 suite | `npm test` | All verification/hardening scenarios pass together | 3 files / 17 tests passed | ✓ |
| Full build after Phase 6 completion | `npm run build` | Compile cleanly after Phase 6 hardening | `tsc -p tsconfig.json` passed | ✓ |
| Focused Phase 6 verification | `npm run verify:phase6` | Integration/config checks remain green through final Phase 6 scenarios | 2 files / 13 tests passed | ✓ |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-03-24 09:09 | None | 1 | Initialization clean |
| 2026-03-24 09:35 | `task_plan.md` became structurally duplicated during iterative edits | 1 | Rewrote the file as one clean canonical version |
| 2026-03-24 09:53 | `progress.md` contained repeated tail content from iterative updates | 1 | Rewrote `progress.md` as a clean canonical log |
| 2026-03-24 10:17 | Cannot follow `using-git-worktrees` because `/home/seax/.openclaw/workspace/projects/qingfu-router` is not a Git repository | 1 | Stopped before implementation and escalated to user for direction |
| 2026-03-24 11:00 | TypeScript build failed after Batch 2 due to missing `role` in semantic carrier type and missing `better-sqlite3` declarations | 1 | Added the missing field and installed `@types/better-sqlite3`, then re-ran tests/build successfully |
| 2026-03-24 11:21 | Config doc draft used the wrong provider API label (`openai-chat-completions`) | 1 | Corrected to `openai-completions` and aligned the Phase 4 decision around a dedicated provider entry |
| 2026-03-24 11:38 | `openclaw-config.test.ts` had invalid property access syntax during rollback test expansion | 1 | Fixed the bracket access expression and re-ran tests/build/preview successfully |
| 2026-03-24 11:48 | `chat-completions.ts` contained stray duplicated fragments after an edit, causing parse failures during verification | 1 | Removed the duplicated fragment and re-ran the suite |
| 2026-03-24 11:49 | Timeout test exposed missing source helper wiring (`classifyThrownUpstreamError is not defined`) | 1 | Added the helper in the correct scope, re-ran src-level reproduction, then re-ran tests/build successfully |

## Session: 2026-03-28

### Phase 7: Delivery / Routing Audit
- **Status:** complete
- **Started:** 2026-03-28 15:00 Asia/Shanghai
- **Completed:** 2026-03-28 15:31 Asia/Shanghai
- Actions taken:
  - Re-read the real Q-router repository instead of the earlier docs-only knowledge-base folder.
  - Traced the routing chain from ingress model alias normalization to provider selection, upstream URL construction, auth header generation, and thinking rewrite.
  - Verified current runtime behavior with focused routing/config tests.
  - Wrote `docs/model-routing-audit.md` to capture the current mapping table and prioritized improvement plan.
- Files created/modified:
  - `docs/model-routing-audit.md` (created)
  - `findings.md` (updated with routing-audit conclusions)
  - `progress.md` (updated)

### Phase 8: Backward-Compatible Routing Refactor
- **Status:** complete
- **Started:** 2026-03-28 15:32 Asia/Shanghai
- **Completed:** 2026-03-28 16:03 Asia/Shanghai
- Actions taken:
  - Added explicit `routes` support while preserving the old `providers + models.allow` config path.
  - Added `apiKeyEnv` support for provider secrets and kept the old derived env naming as fallback.
  - Added compatibility support for legacy `QINGFU_*` env names without removing the current `Q_*` names.
  - Introduced a compiled routing layer and wired it into server startup, provider-aware fetch, and `LR/ms` alias handling.
  - Added `GET /debug/routes` for effective route inspection and non-blocking config warnings.
  - Updated config/operations docs to describe the new compatibility surface.
  - Kept the checked-in runtime config unchanged so the currently running instance does not require migration.
- Files created/modified:
  - `src/config/router.ts`
  - `src/routing/routes.ts` (created)
  - `src/server.ts`
  - `src/upstream/client.ts`
  - `src/ingress/chat-completions.ts`
  - `src/ingress/responses.ts`
  - `src/traces/store.ts`
  - `src/tests/router-config.test.ts`
  - `src/tests/provider-routing.test.ts`
  - `docs/config.md`
  - `docs/operations.md`
  - `findings.md`
  - `progress.md`

## Additional Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Routing/config audit verification | `npm test -- src/tests/provider-routing.test.ts src/tests/router-config.test.ts` | Current provider routing, auth, think rewrite, and alias behavior still pass | 25 tests passed | ✓ |
| Backward-compatible refactor verification | `npm test -- src/tests/router-config.test.ts src/tests/provider-routing.test.ts` | Old routing behavior remains green and new `routes` / `apiKeyEnv` features work | 29 tests passed | ✓ |
| Full regression suite after refactor | `npm test` | No regression across classifier, integration, routing, and OpenClaw config helpers | 50 tests passed | ✓ |
| Build after refactor | `npm run build` | Compile cleanly after route-layer changes | `tsc -p tsconfig.json` passed | ✓ |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Audit and backward-compatible refactor complete |
| Where am I going? | User handoff and any requested config migration or cleanup work |
| What's the goal? | Keep the current Q-router stable while making routing and secret binding more explicit |
| What have I learned? | The safest path was additive: introduce explicit routes and key binding without forcing immediate config migration |
| What have I done? | Completed the audit, implemented the compatibility refactor, updated docs, and re-ran the full suite |

---
*Update after completing each phase or encountering errors*
