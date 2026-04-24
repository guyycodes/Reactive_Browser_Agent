# browser_agent

Tier-1 IT triage agent that controls a real browser. Unified dev-container + Docker Compose project; every service sits on a shared `agent-net` bridge network and is built from this repo.

See [`docs/MASTER_PLAN.md`](./docs/MASTER_PLAN.md) for the full roadmap.

## Layout

```
browser_agent/
├── .devcontainer/
│   └── devcontainer.json        # dockerComposeFile mode, attaches to `agent`
├── docker-compose.yml           # all services, agent-net network
├── .env.example
├── docs/
│   └── MASTER_PLAN.md
└── services/
    ├── agent/                   # Mastra + Playwright MCP (Node 20, TS) — this dev container
    ├── rag/                     # FastAPI + Qdrant embedder (copied from docs_pipeline_311)
    └── browser-viewer/          # socat + noVNC bridge (copied from agent_sidecar_311)
```

## Services (on `agent-net`)

| Service           | Role                                          | Host port(s)        | Internal DNS     |
|-------------------|-----------------------------------------------|---------------------|------------------|
| `agent`           | Mastra workflows + Playwright MCP + HTTP/WS   | `3001`, `9229`      | `agent`          |
| `rag`             | FastAPI embedder (e5-large-v2, 1024-dim)      | `3009`              | `rag`            |
| `qdrant`          | Vector DB                                     | `6333`, `6334`      | `qdrant`         |
| `postgres`        | Structured state (events, reviews, selectors) | `5432`              | `postgres`       |
| `browser-viewer`  | noVNC bridge → agent's Chromium over `:5900`  | `6080`              | `browser-viewer` |

A `services-healthcheck` aggregator gates on `qdrant + postgres + rag` so tooling / CI has a single readiness signal.

## Bring it up

```bash
cp .env.example .env                # fill in keys
docker compose build                # first build is slow: pulls Playwright deps + spaCy model
docker compose up -d
docker compose ps
```

Or use the dev container: **Reopen in Container** → VS Code attaches to `agent`, compose brings up the rest.

## Ports exposed to the host

- `http://localhost:3001` — agent HTTP/WS (coming in Week 1)
- `http://localhost:3009/monitor` — RAG status
- `http://localhost:6080` — noVNC viewer (watch the agent's browser live)
- `http://localhost:6333/dashboard` — Qdrant dashboard
- `postgresql://agent:agent@localhost:5432/agent`

## Current status

**Phase 0 — Infrastructure & RAG foundation: complete and end-to-end verified.**

### Infrastructure

- [x] Services copied from `Embedding_Pipline` and rewired for `agent-net` (`docs_pipeline_311` → `services/rag`, `agent_sidecar_311` → `services/browser-viewer`)
- [x] `services/agent/` built: Node 20.20.2, Playwright 1.59.1 (Chromium installed), Xvfb + x11vnc + fluxbox + tini + socat on PATH
- [x] `docker-compose.yml` declares `agent-net` (bridge, `172.28.0.0/16`) and 6 services with typed volumes + healthchecks
- [x] Dev container converted to `dockerComposeFile` mode, attaches to `agent` service
- [x] Healthchecks fixed for images without `wget`/`curl` (qdrant uses bash `/dev/tcp`, rag uses python `urllib`)
- [x] `ARCHITECTURE.md`, `docs/MASTER_PLAN.md`, `STARTUP_PROCESS.md` authored

### RAG pipeline (fully operational)

- [x] HF model forward-compat patch pushed to your Hugging Face repo (`guymorganb/e5-large-v2-4096-lsg-patched` — `**kwargs` on forward() signatures for transformers 4.40+, defensive `position_embedding_type`)
- [x] Dependency pins landed: `transformers>=4.46,<5`, `torch>=2.6,<2.8`, `qdrant-client<1.13`, `huggingface-hub<1.0`
- [x] Cross-volume file moves fixed (`os.rename` → `shutil.move` in the cleaner)
- [x] FileQueue self-bootstraps the `html/`, `pdf/`, `docx/`, `other/`, `temp/` subdirs on first run
- [x] **Per-document vector stores via UUID filename convention** (see below)
- [x] UUID point IDs — multiple chunks in one collection no longer overwrite each other
- [x] Collection-creation race fix (module-level lock + 409 tolerance) for concurrent upserts
- [x] Test fixtures committed at `services/rag/test_fixtures/runbooks/`
- [x] End-to-end smoke verified: 6 files dropped concurrently → 1 shared collection with 3 points + 3 fresh collections with 1 point each. Zero data loss.

### RAG collection semantics (important to know)

Drop a file into `/app/src/util/dirty_documents/<ext>/`. The queue inspects the filename:

| Filename pattern | Behavior |
|---|---|
| `anything.html` (no UUID) | A fresh UUID is auto-appended. Creates a new Qdrant collection named by that UUID. |
| `anything_<uuid4>.html` | Routes to collection `<uuid4>`. Created if missing, **appended** if it already exists. |
| Two files with the same `<uuid4>` in their names | Both land in that collection. |

You control "new store vs. append" entirely through the filename. Query via `POST rag:3009/docs/models/qa` with `{"query": "...", "collection_name": "<uuid>"}`.

### Agent service — Week 1A ✅ complete

All three commits landed and verified end-to-end:

- **Commit 1 — transport + DB** ✅ (envelope, bus, WS stream, Postgres schema, 38 tests)
- **Commit 2 — LLM + Mastra + workflow** ✅ (Anthropic streamMapper, 8-step Mastra workflow, AsyncLocalStorage run context, 6 more tests → 44 total)
- **Commit 3 — reviewer UI** ✅ (`services/test-webapp/` Next.js 14 app with live `/agent/review/[runId]` page)

Verification (last full-stack bring-up):

- `npm run check` in `services/agent` → `tsc --noEmit` zero errors, vitest **44/44** passing in ~320 ms
- `npm run typecheck` + `next build` in `services/test-webapp` → clean; routes `/` + `/agent/review/[runId]`
- `docker compose up -d --wait` → **7 services healthy**: agent, test-webapp, rag, qdrant, postgres, browser-viewer, services-healthcheck
- Both test-webapp routes return `HTTP 200`; agent container alive on Node 20.20.2
- Reject-path orphan `tool.started` from Commit 2 dropped; timeline-span invariant restored

Known follow-ups (tracked, not blocking Week 1B):

- Bump `services/test-webapp/package.json` `next` from `14.2.15` → `14.2.35` (same minor range; accumulates 14 CVE fixes). Run `npm install --save-exact next@14.2.35` then rebuild the container.
- Add a lockfile to `services/test-webapp/` so the Dockerfile can use `npm ci` instead of `npm install` (reproducible builds).
- The `plan` step still infers `destructive` from a substring regex — Week 2 replaces with skill-card declared properties.
- No screenshot rendering in the reviewer UI Should test manually — ✅ landed in Commit 6c (see Week 1B below): `/static/runs/:runId/:filename` Hono route + Next.js `/api/static/...` rewrite + inline `<img>` thumbnails in the step-card timeline.

### Week 1B — in progress

Commits landed so far (exit criterion still pending Commits 6 + 7):

- **Commit 4 — test-webapp admin surface** ✅ (Next.js 14.2.35, `/login` + `/users` + `/users/:id/reset-password` + `/status`, seeded users with stable `data-testid` selectors, session-gated `(auth)` route group; reviewer UI at `/agent/review/[runId]` unchanged)
- **Commit 5-prep — RAG response shape** ✅ (`query_model.qa_search_with_hits` + `deep_semantic_search_with_hits` add structured `hits[{id, score, text, source, chunk_id}]` alongside existing `docs[]`; back-compat wrappers preserve `List[str]` for the CLI configurator)
- **Commit 5-prep addendum — 404 regression fix** ✅ (`except HTTPException: raise` added above the generic 500 handler in both `/qa` + `/semantic`; nonexistent-collection now returns clean HTTP 404, not 500)
- **Commit 5a — `rag.ts` HTTP client** ✅ (`services/agent/src/mastra/tools/rag.ts` with Zod-validated responses, `p-retry@6.2.1` exponential backoff with 90 s AbortSignal deadline, 404 → empty-envelope translation, 6 behavioural + 1 contract-stability vitest = **51/51 total**)
- **Commit 5b — real `retrieveStep`** ✅ (canned body replaced; emits 6 real envelope frames per run — two `tool.started → rag.retrieved → tool.completed` triplets, one per shared collection; `hitCount` derived from `result.hits.length` so sentinel-doc paths correctly report 0; `tool.failed` replaces the success triplet on any `RagClientError` / `RagSchemaError` with soft-failure fallthrough to `planStep`)
- **Commit 6a — Playwright MCP client wrapper** ✅ (`services/agent/src/mastra/tools/playwrightMcp.ts` on raw `@modelcontextprotocol/sdk@^1.29.0` + `@playwright/mcp@0.0.70`, stdio transport, `BrowserSession` with navigate/snapshot/click/fillForm/takeScreenshot/consoleMessages/close, tree-kill cleanup on session.close to prevent Chromium-orphan PPID=1 leaks, injectable `clientFactory`/`transportFactory`/`killProcessTreeImpl` for unit-testable spawn args)
- **Commit 6b — real `dryRunStep` + `executeStep`** ✅ (canned bodies replaced; `RunContext.browser` carries the session from dry_run to execute; dryRunStep logs in as `theo@example.com`, searches Jane, clicks through to detail; executeStep clicks the destructive reset + checkbox + submit + parses the success toast; six absolute-path screenshots land at `/workspace/.playwright-videos/<runId>/<seq>.png`; `findRefByAccessibleName` + `findRefForRole` resolve Playwright MCP's accessibility-tree refs by role-filtered substring match)
- **Commit 6c — reviewer UI screenshot rendering** ✅ (per-run `--user-data-dir` so back-to-back runs don't bleed session cookies; `/static/runs/:runId/:filename` Hono route with four-layer defense — Zod UUID runId, filename whitelist regex, extension whitelist, `path.resolve` containment — serving from the `playwright-videos` volume with `Cache-Control: private, max-age=3600`; Next.js `/api/static/...` rewrite keeps the reviewer same-origin; `FrameRow` renders inline thumbnail `<img>` tags for every `browser.screenshot` frame with click-through to full size; step-card headers gained `role="button"` / `tabIndex={0}` / Enter+Space keyboard handlers for a11y)

Verified last smoke: `POST /triage` against the live stack produces the full end-to-end timeline — classify → retrieve (real RAG with 3 runbook hits, skills 404→empty) → plan (Sonnet thinking stream) → dry_run (real Playwright: login → users → search jane → view) → review_gate → approve → execute (real reset flow → success toast) → verify → log_and_notify → `run.completed status=ok`. Six PNGs land on disk; reviewer UI renders them inline as thumbnails; zero orphan Chromium subprocesses; zero span-invariant violations; `request_id` round-tripped from rag into the envelope; Jane's status flips `locked → active` with a fresh `last-password-reset` timestamp.

Commits landed in the 7a series (reviewer UX):

- **Commit 7a.i — single-image screenshot rail** ✅ (pinned "live view" rail at top-right of the reviewer page; showed the most recent `browser.screenshot` frame at 480 × auto; built on a grid sidebar with CSS `position: sticky; align-self: start` + a `scroll-margin-top` anchor. Subsequently absorbed into 7a.ii's feed — no standalone rail code remains.)
- **Commit 7a.ii — behavior-feed IA refactor** ✅ (pivoted from "spotlight view" to "brain feed." Split the reviewer page into a two-column grid: LEFT `.review-outcomes-col` renders one compact `<StepOutcome>` row per workflow step distilled from `step.completed.output` — what each step *decided*; RIGHT `.review-feed-col` renders a chronological `<BehaviorFeed>` of every `llm.*` / `tool.*` / `rag.retrieved` / `browser.*` frame with inline step dividers — what the agent *actually did, frame-by-frame*. Auto-scroll with stick-to-bottom + 3 s idle gesture. Orphan-`rag.retrieved` fallback renders as a standalone `feed-tool.pending` card when no paired-up `rag.*` tool span is open. No agent-side changes; pure UI.)
- **Commit 7a.iii — fixed-viewport shell + resizable divider + top-third scroll anchor** ✅ (promoted `<main>` to a flex-column `height: 100vh; overflow: hidden` shell so page body never scrolls; both columns became independent `overflow-y: auto` scroll containers. Hand-rolled grid-driven resizable divider between columns via a CSS `--left-pct` custom property; clamp `[20, 80]`; `localStorage` persistence under key `"reviewLeftPct"`; `setPointerCapture` drag + ArrowLeft/Right ±2 % keyboard support + ARIA `role="separator"`. Initial top-third scroll anchor implemented via `padding-bottom: 66vh` on `.behavior-feed` (superseded in 7a.v by a cleaner `scrollIntoView({block: "start"}) + scroll-margin-top` technique).)
- **Commit 7a.iv — implicit post-action screenshots** ✅ (agent-side only. `services/agent/src/mastra/tools/playwrightMcp.ts` wraps `session.click` and `session.fillForm` so after a successful MCP call returns, a follow-up `takeScreenshot("${mcpToolName}:after")` fires via a TDZ-safe closure-local `doTakeScreenshot()` helper that's shared with the public `takeScreenshot` method. Failures in the post-action hook become `logger.debug` — never poison a successful click. Bumps PNG count per happy-path run from 6 → ~12–15 and makes the behavior feed refresh at ~1 frame per user-visible browser action during `execute`. Test count 86 → **87** — existing `[8]` fillForm test amended for the +1 screenshot call, new `[12]` asserts the `:after` label convention and absolute-path filename contract.)
- **Commit 7a.v — agentic polish (closes the 7a series)** ✅ (five interacting features landed together: (1) scroll-anchor upgrade — deleted `padding-bottom: 66vh`, added `.behavior-feed > * { scroll-margin-top: 33vh }`, replaced `scrollTop = scrollHeight` with `lastElementChild?.scrollIntoView({block: "start"})` so growing typewriter text fills downward from a stable anchor line regardless of frame height. (2) Typewriter on `llm.text.delta` — 60 cps fixed-rate char pump with catchup scaling when >50 chars behind the wire; flushes on `llm.message.completed`; blinking `▊` caret while streaming. (3) Thinking bubble fade — on `llm.message.completed`, the purple thinking block collapses to a pill `[Sonnet] thought for 7.2s · click to expand` via a CSS grid `1fr → 0fr` transition (200 ms); click-to-expand, click-"collapse" inside expanded to re-collapse. (4) Tool-card pulse — CSS `@keyframes toolPulse` emits a breathing accent-blue `box-shadow` around `.feed-tool.pending .marker` using `rgba(var(--accent-rgb), ...)` (the token added in 7a.iii earns its keep); stops automatically when the card flips to `.ok` / `.err`. (5) Active-step autoscroll in the LEFT column — on each new `step.started` transition, the matching `.step-outcome` row auto-scrolls into view with `block: "nearest"`; gated by the same 3 s-idle rule as the feed but with a separate `lastOutcomesInteractionAt` ref so interactions in one column don't bail the other.)

Upcoming (7b-series scope revised after Commit 7a.v smoke uncovered an Anthropic 500 in `verify`):

- **Commit 7a-docs-sync** ✅ (this commit — sync README / ARCHITECTURE §2.7 / STARTUP_PROCESS §1.6 / MASTER_PLAN to reflect the 7a-series landed state + the revised 7b scope).
- **Commit 7b.i — circuit breaker + Anthropic wrap + listener fix** ⏳ (new reusable primitive at `services/agent/src/lib/circuit.ts`: named-instance registry, three-state machine (closed → open → half-open) with sliding failure window + cooldown + single-probe recovery, structured pager-ready `event: circuit_breaker.state_change` log trail, composed retry-on-5xx with exponential backoff inside `execute()`. First consumer: `services/agent/src/llm/streamMapper.ts` routes the Anthropic SDK streaming call through `getCircuit("anthropic")` — every `classify` / `plan` / `verify` call and every future ReAct iteration becomes resilient to transient API flake automatically. Second fix-in-flight: `setMaxListeners(32, opts.signal)` in `launchBrowser` to silence the `MaxListenersExceededWarning` that 7a.iv's denser screenshot cadence reliably trips. Target test count: 87 → ~97. No refactor of `rag.ts` (it already has its own `p-retry` setup) and no MCP-call wrapping (different failure mode, deferred).
- **Commit 7b.ii — `createReActStep` runner + `retrieveStep` refactor** ⏳ (the original 7b scope, now landing on top of the hardened LLM layer. Reusable `createReActStep({ id, goal, tools, maxIterations })` Mastra step factory that runs a think → tool → observe → think loop using the existing `streamMessage` + existing tool wrappers. New envelope variants `react.iteration.started` + `react.iteration.completed` so the reviewer UI can render each iteration as a nested row under the parent step card. First application: `retrieveStep` goes from "fire two identical RAG queries blindly" to "look at the classification, decide what to actually ask, query, observe, re-query if hits are weak." Gates stay exactly where they are — ReAct just makes pre-gate reasoning richer and legible. See `docs/MASTER_PLAN.md` §4.1.
- **Commit 7b-docs-sync** ⏳ (closes the 7b series; same 5c / 6c-4 / 7a-docs precedent — README / ARCHITECTURE / STARTUP_PROCESS / MASTER_PLAN sync after 7b.ii lands).
- **Week 1B exit criterion (current):** `POST /triage` with a password-reset ticket produces an end-to-end **agentic-feeling** reviewer experience — visibly streaming ReAct iterations on `retrieve` (thought → RAG call → observation → next thought), every browser action during `execute` emits a screenshot that refreshes the behavior feed at ~1 Hz, thinking blocks fade to one-line summaries on completion with click-to-expand, typewriter reveals output text char-by-char, Jane's password actually resets, and transient Anthropic 500s no longer kill the run. Live VNC browser feed is **deliberately deferred** to a post-Week-5 stretch ("Commit 10c") — the behavior feed delivers ~95 % of the "watch the agent work" product value at ~5 % the infrastructure cost. `browser-viewer` service stays compose-wired but idle so reactivation is cheap if we ever need it.

Committed in Commit 1:

- [x] `services/agent/package.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`, `.dockerignore`
- [x] `src/env.ts` — Zod-validated env, fails loud at boot
- [x] `src/logger.ts` — pino with API-key redaction
- [x] `src/events/envelope.ts` — 24-variant Zod discriminated union, `MAX_FRAME_BYTES=16 KiB`, `seq: null` for transport frames
- [x] `src/events/bus.ts` — per-run ring buffer, monotonic seq, idempotent decisions, synthetic `run.failed` on envelope violation, waiter ordering for Mastra suspend/resume bridge
- [x] `src/events/stream.ts` — origin allowlist + hello-first handshake + log-and-continue ConflictError semantics
- [x] `src/events/persist.ts` — append every frame to Postgres `events` table (fire-and-forget with error log)
- [x] `src/db/{client,schema,migrate}.ts` + `migrations/0001_init.sql` — `runs`, `events`, `reviews` tables; `UNIQUE(idempotency_key)` enforced at the DB layer
- [x] `src/index.ts` — Hono + `@hono/node-ws` + graceful shutdown
- [x] `src/http/{health,triage,runs}.ts` — stubs; triage currently emits a canned `run.started → run.completed` so the pipe can be smoke-tested end-to-end without any LLM calls
- [x] `test/{envelope,bus,origin}.test.ts` — 38 unit tests covering envelope parsing, bus behaviour, origin normalisation
- [x] `.env.example` — `ANTHROPIC_API_KEY`, model pins, `SHARED_*_UUID` real values, `ALLOWED_WS_ORIGINS` with both `localhost` and `127.0.0.1` variants

Pending (Commit 2 + 3):

- [ ] `src/llm/` — Anthropic SDK pinned to a version supporting extended thinking, SSE → envelope stream mapper with proactive chunking
- [ ] `src/mastra/` — Mastra instance, 8-step workflow, step emitter, tool wrappers for RAG + Playwright MCP
- [ ] `http/triage.ts` replaces canned body with the real workflow
- [ ] `services/test-webapp/` review page at `/agent/review/:runId`
- [ ] Week 1B — real Playwright against `test-webapp` + one hardcoded skill

### Action items outstanding

- [ ] **Rotate the Hugging Face token** that was previously committed to `.env.example` as a literal value. Token is now scrubbed in the file but sat on disk in cleartext; revoke on HF Settings → Access Tokens before the folder is ever `git init`'d or shared.
- [ ] Week 2+ — see [`docs/MASTER_PLAN.md`](./docs/MASTER_PLAN.md)
