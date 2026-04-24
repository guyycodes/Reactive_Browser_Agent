# browser_agent

Tier-1 IT triage agent that controls a real browser. Unified dev-container + Docker Compose project; every service sits on a shared `agent-net` bridge network and is built from this repo.

See [`docs/MASTER_PLAN.md`](./docs/MASTER_PLAN.md) for the full roadmap.

## Layout

```
browser_agent/
├── .devcontainer/
│   └── devcontainer.json        # dockerComposeFile mode, attaches to `agent`
├── docker-compose.yml           # all services, agent-net network
├── .env.example                 # template — copy to .env, fill in keys
├── ARCHITECTURE.md               # topology + services + reviewer UI IA
├── STARTUP_PROCESS.md            # boot + smoke + publish runbook
├── docs/
│   ├── MASTER_PLAN.md           # roadmap + progress table + forensic audit
│   └── Architecture.txt         # agent-code visual (beginner-friendly)
└── services/
    ├── agent/                   # Mastra + Playwright MCP (Node 20, TS) — THIS dev container
    ├── rag/                     # FastAPI + Qdrant embedder (copied from docs_pipeline_311)
    ├── test-webapp/             # Next.js 14 — reviewer UI + Playwright target
    └── browser-viewer/          # socat + noVNC bridge (compose-wired but idle)
```

## Services (on `agent-net`)

| Service           | Role                                          | Host port(s)        | Internal DNS     |
|-------------------|-----------------------------------------------|---------------------|------------------|
| `agent`           | Mastra workflows + Playwright MCP + HTTP/WS   | `3001`, `9229`      | `agent`          |
| `test-webapp`     | Reviewer UI (`/agent/review/[runId]`) + Playwright target | `3000`  | `test-webapp`    |
| `rag`             | FastAPI embedder (e5-large-v2, 1024-dim)      | `3009`              | `rag`            |
| `qdrant`          | Vector DB                                     | `6333`, `6334`      | `qdrant`         |
| `postgres`        | Structured state (events, reviews, runs)      | `5432`              | `postgres`       |
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

- `http://localhost:3000` — test-webapp (reviewer UI at `/agent/review/[runId]` + Playwright target at `/login`, `/users`, ...)
- `http://localhost:3001` — agent HTTP/WS (`POST /triage`, `GET /runs/:id`, `POST /runs/:id/review`, `WS /stream/:runId`, `GET /static/runs/:runId/:filename`)
- `http://localhost:3009/monitor` — RAG status
- `http://localhost:6080` — noVNC viewer (parked — browser-viewer service is idle by default)
- `http://localhost:6333/dashboard` — Qdrant dashboard
- `postgresql://agent:agent@localhost:5432/agent`

## Current status

**Week 1B complete — 7b.iii.b series closed. 150/150 tests green, 16 test files, tsc clean. End-to-end two-gate human-in-the-loop workflow live.** Week 2 (skill cards + RAG wiring) not started.

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

All Week-1A follow-ups have since landed: next bumped to `14.2.35`, test-webapp lockfile committed, `destructive` regex replaced by LLM-declared + structured `PlanSchema.actions[]` in 7b.ii hotfixes, screenshot rendering live since Commit 6c.

### Week 1B ✅ complete

Commits landed — the full chain from canned stubs to end-to-end human-in-the-loop agentic workflow:

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

Commits landed in the 7b series (reliability + ReAct + Block 1 + two-gate human-in-the-loop):

- **Commit 7a-docs-sync** ✅ (synced docs after the 7a series).
- **Commit 7b.i — circuit breaker + Anthropic wrap + listener fix** ✅ (`services/agent/src/lib/circuit.ts` — named-instance registry, three-state machine closed/open/half-open with sliding failure window + cooldown + single-probe recovery, pager-ready `event: circuit_breaker.state_change` log trail. First consumer: `streamMapper.ts` routes every Anthropic SDK streaming call through `getCircuit("anthropic")`. Also lands `setMaxListeners(32, opts.signal)` in `launchBrowser`. Test count 87 → **98**.)
- **Commit 7b.ii — `createReActStep` runner + `retrieveStep` refactor** ✅ (reusable `createReActStep({ id, goal, tools, maxIterations })` Mastra step factory at `src/mastra/lib/reactRunner.ts`. Two new envelope variants `react.iteration.started` / `react.iteration.completed` with optional `reactIterationId` tagging on every `llm.*` / `tool.*` / `rag.retrieved` / `browser.*` frame inside an iteration → reviewer UI nests them under a collapsible row. First application: `retrieveStep` now runs think → targeted RAG → observe → refine. Test count 98 → **110**.)
- **Commit 7b.ii hotfixes 1-4** ✅ (ticket plumbed onto RunContext, `RetrievalSchema.hits` carries real preview text, structured `PlanSchema` with `actions[]` + LLM-declared `destructive` + `requiresContext` replaces regex heuristics, `z.preprocess(null → undefined)` on scalar schema fields. Dead code pruned. Test count 110 → **115**.)
- **Commit 7b.iii.a — Block 1 iteration controller** ✅ (plain-TS orchestrator at `src/mastra/lib/blockController.ts` wrapping classify/retrieve/plan/dry_run in a pass loop with `BLOCK1_MAX_PASSES = 3`, observation carry-forward, new envelope variants `block.iteration.started` / `block.iteration.completed`, `BlockResultSchema` on `DryRunSchema.blockResult` for the exhausted path. Test count 115 → **130**.)
- **Commit 7b.iii.b-bus-extension** ✅ (EventBus per-(runId, stepId) decision slots — unblocks the two-gate architecture. New `publishClientDecisionForStep` + `awaitDecisionForStep`; old `publishClientDecision` / `awaitDecision` preserved as back-compat shims defaulting `stepId = "review_gate"`. Slot-consumption state machine with pre-delivery + stale-discard + per-slot idempotency. `GateStepIdSchema = z.enum(["review_gate", "human_verify_gate"])` narrows the wire. Test count 135 → **141** (+6 scoped + 1 cross-slot idempotency regression guard).)
- **Commit 7b.iii.b-pre-exec-refine + 2-hotfix-1** ✅ (`runReviewGateStep` refine loop — Edit with notes re-runs Block 1 with `seedObservations`, emits `block.backtrack.triggered { fromStep: "review_gate" }`, cap `MAX_PRE_GATE_REFINES = 2`. Hotfix-1 fixed Bug A Scope 1 — moved `dry_run` out of blockController's inner cognitive `withRunContext` spread because `runDryRunStep` mutates `ctx.browser` and the spread was trapping the mutation. Test count 141 → **148**.)
- **Commit 7b.iii.b-pre-exec-edit-ui + hotfix-1 + amend-1 + hotfix-2** ✅ (reviewer UI ReviewPanel three-mode state machine — default / edit / submitting / escape hatch. Three follow-up hotfixes: hotfix-1 fixed memo-unmount-on-edit (Bug 1) + Playwright MCP profile-lock collision (Bug B); amend-1 narrowed the terminal guard to `run.completed` only (Bug 3A interaction); hotfix-2 threaded observations via `runBlock1(..., { seedObservations })` instead of a `withRunContext` spread, fixing Bug A at Scopes 2 + 3 (refine loop + parked humanVerifyGateStep). 148 unchanged.)
- **Commit 7b.iii.b-human-verify-gate** ✅ (post-exec gate un-parked + inserted into workflow chain. Piece B synthetic `block1 step.started/completed` frames wrap every refine/backtrack `runBlock1` call → LEFT column reads latest via `findLast`. Piece C post-exec ReviewPanel variant (Reject + Approve only; Edit deliberately hidden — wedge-prevention rationale in docblock). Piece D `FeedBacktrackBanner` component with pre-exec / post-exec copy branches. Piece A.5 Bug 3A mitigation (drop `thinking` from `runPlanStep`'s step.completed.output — UI reads from `llm.thinking.delta` stream, never the step payload). Test count 148 → **150**. Smoke verified across 4 live UI runs: approve-only / edit-refine / post-exec-reject-backtrack / post-exec-budget-exhaust — all clean, Jane DB resets verified, all 4 forensic fingerprints zero.)
- **Commit 7b.iii.b-docs-sync** ✅ (this commit — `runContext.ts` CTX SPREAD INVARIANT docblock + updated stale `priorObservations` comment; `MASTER_PLAN.md` progress table expansion + `### 7b.iii.b series — forensic audit` table (Bug A / B / 4 / 3A fingerprints with "Bug A hid Bug B hid Bug 4; Bug 3A orthogonal" causal narrative) + `### Week-2 polish queue` (11 tracked items); `ARCHITECTURE.md` §2.1 rewritten for 9-step + 2-gate reality; §2.7 for post-exec ReviewPanel variant + FeedBacktrackBanner + three-mode state + `findLast` LEFT-column refresh; `STARTUP_PROCESS.md` §1.6 header updated, new §1.6.5 Edit-refine walkthrough, §1.6.6 post-exec gate walkthrough, §1.6.7 forensic acceptance guards with SQL cross-checks. Plus new `docs/Architecture.txt` — 868-line agent-code-scoped visual + beginner primer. No code / no test changes. 150/150 unchanged.)

**Week 1B exit criterion — met.** `POST /triage` with a password-reset ticket produces end-to-end two-gate human-in-the-loop agentic flow: visibly streaming ReAct iterations on retrieve, per-browser-action screenshots during execute/dry_run, thinking bubble fade + typewriter reveal, pre-exec Edit re-plans via refine loop, post-exec Reject triggers full backtrack via `block.backtrack.triggered { fromStep: "human_verify_gate" }`, both gates cap correctly, Jane's password actually resets (DB-verified), transient Anthropic 500s no longer kill runs. Live VNC browser feed deferred to post-Week-5 stretch ("Commit 10c").

### Up next — Week 2

Skill cards + RAG wiring. See [`docs/MASTER_PLAN.md`](./docs/MASTER_PLAN.md) — the Week-2 polish queue at the bottom of the progress table lists 11 specific tracked items (rag.ts→circuit-breaker unify, verifyStep hard-fail on stepsRun===0, planStep last-fence parser fix, `--warn-rgb` token, MaxListeners cleanup, env-var overrides for the backtrack caps, override-and-proceed on exhausted blockResult, etc.) plus the main scope: Zod skill-card schema at `src/schemas/skill-card.ts`, skill card + runbook YAML authoring under `kb/`, `scripts/embed-skill-cards.ts`, apply `createReActStep` to `classify` + `verify`, refactor hardcoded Jane reset flow → skill-card-driven executeStep.

**Exit criterion:** agent handles `reset_user_password` AND `unlock_account` with ZERO code changes between them — skill-card lookup alone.

### Action items outstanding

- [ ] **Rotate the Hugging Face token** that was previously committed to `.env.example` as a literal value. Token is now scrubbed in the file but sat on disk in cleartext; revoke on HF Settings → Access Tokens before the folder is ever pushed publicly.
- [ ] Week 2+ — see [`docs/MASTER_PLAN.md`](./docs/MASTER_PLAN.md) for the full progress table, forensic audit, and polish queue.
