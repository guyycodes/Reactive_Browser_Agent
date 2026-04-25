# Architecture

Unified, self-contained dev environment for a tier-1 IT triage **browser-controlling agent**. Every service is built from this repo, attached to a single Docker bridge network (`agent-net`), and wired with healthchecks so startup order is deterministic.

Companion docs: [`README.md`](./README.md) (quickstart) · [`docs/MASTER_PLAN.md`](./docs/MASTER_PLAN.md) (roadmap).

> **Status: Phase 0 verified end-to-end.** All six services come up healthy on `agent-net`. Full RAG ingestion loop proven: drop HTML files → clean → chunk → embed (e5-large-v2, 1024-dim) → upsert into Qdrant. Verified last smoke: 6 files dropped concurrently produced exactly one shared collection with 3 points (same-UUID files appended) plus three fresh collections with 1 point each (untagged files got auto-generated UUIDs). Zero data loss under concurrency.

---

## 1. Topology

```
                     Reviewer's web browser (host)
                           │           │
                           │ HTTP      │ WebSocket  (direct — test-webapp is NOT on this path;
                           │ GET /     │            the Next.js page's client JS opens this
                           │           │            connection itself)
                           ▼           ▼
┌────────────────────── host ports ─────────────────────────────────────┐
│  :3000    :3001  :9229   :3009   :6333 :6334   :5432    :6080         │
│   │         │      │       │       │    │        │        │           │
│   ▼         ▼      ▼       ▼       ▼    ▼        ▼        ▼           │
│  ┌────────────────────── agent-net (172.28.0.0/16) ─────────────────┐ │
│  │                                                                  │ │
│  │  ┌─────────────────┐                                             │ │
│  │  │ test-webapp     │ :3000   Next.js 14 app, two roles:          │ │
│  │  │                 │         • /agent/review/[runId]             │ │
│  │  │                 │            (reviewer UI — Week 1A)          │ │
│  │  │                 │         • /login, /users, /status, ...      │ │
│  │  │                 │            (Playwright target — Week 1B)    │ │
│  │  └────▲────────────┘                                             │ │
│  │       │ HTTP (Week 1B: agent's Chromium navigates to             │ │
│  │       │       test-webapp:3000/users/... to drive the target)    │ │
│  │       │                                                          │ │
│  │  ┌────┴───────────────────────────────────────────┐              │ │
│  │  │  agent     (THIS dev container)                │              │ │
│  │  │  ────────────────────────────────────────────  │              │ │
│  │  │  Node 20  •  Mastra workflows                  │              │ │
│  │  │  Playwright MCP  •  Chromium (headed, Xvfb)    │              │ │
│  │  │  x11vnc  :5900 (internal only)                 │              │ │
│  │  │  HTTP/WS :3001 • node inspect :9229            │              │ │
│  │  └──┬──────────┬──────────────┬──────────┬────────┘              │ │
│  │     │ HTTP     │ SQL          │ HTTP     │ vnc                   │ │
│  │     ▼          ▼              ▼          ▼                       │ │
│  │  ┌──────┐  ┌────────┐  ┌──────────┐   ┌──────────────┐           │ │
│  │  │ rag  │  │postgres│  │ qdrant   │   │browser-viewer│ :6080     │ │
│  │  │:3009 │  │ :5432  │  │ :6333    │   │ socat 5900 → │           │ │
│  │  │      │  │ runs • │  │ :6334    │   │ agent:5900   │           │ │
│  │  │FastAP│  │events •│  │          │   │ noVNC proxy  │           │ │
│  │  │I +   │  │reviews │  │ collec-  │   │ :6080→:5900  │           │ │
│  │  │e5-   │  │        │  │ tions    │   └──────────────┘           │ │
│  │  │large │  └────────┘  │ (UUID-   │                              │ │
│  │  │-v2   │       ▲      │  named,  │                              │ │
│  │  │      │       │      │  append  │                              │ │
│  │  │1024d │       │      │  per doc)│                              │ │
│  │  └──┬───┘       │      └────▲─────┘                              │ │
│  │     │           │           │                                    │ │
│  │     │ upsert    │           │ search                             │ │
│  │     └───────────┼───────────┘                                    │ │
│  │                 │                                                │ │
│  │  ┌──────────────┴───────────────────────────────┐                │ │
│  │  │ services-healthcheck (busybox aggregator)    │                │ │
│  │  │ healthy when: qdrant ∧ postgres ∧ rag        │                │ │
│  │  └──────────────────────────────────────────────┘                │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘

Data-path legend:
  Browser → test-webapp        : HTTP (loads the reviewer page)
  Browser → agent              : WebSocket (streams the envelope timeline; test-webapp NOT involved)
  agent → test-webapp          : HTTP from agent's internal Chromium (Week 1B Playwright driver)
  agent → rag / postgres / qdrant : HTTP / SQL
  agent → browser-viewer       : VNC (so operator can watch the agent's Chromium live at :6080)
```

Only the agent service (Playwright + Mastra) will ever speak to the outside internet (LLM API, target web apps). All inter-service traffic stays on `agent-net`.

---

## 2. Services

### 2.1 `agent` — the dev-container target

| Attribute | Value |
|---|---|
| Build | `services/agent/Dockerfile` |
| Base image | `node:20-bookworm` |
| System installs | Playwright (+ Chromium), Xvfb, x11vnc, fluxbox, tini, socat, python3, build-essential, git |
| Runtime deps | `@mastra/core ^1.26.0` (workflow engine), `@anthropic-ai/sdk 0.90.0` (LLM client, **pinned exact** — supports extended thinking on the streaming API), `hono ^4.6.12` + `@hono/node-server ^1.13.7` + `@hono/node-ws ^1.1.1` (HTTP + WebSocket), `drizzle-orm ^0.36.4` + `postgres ^3.4.5` (event log + review state), `p-retry ^6.2.1` (exponential backoff for the `rag` HTTP client — used inside `src/mastra/tools/rag.ts` to ride out the `agent → rag` `service_started`-not-`service_healthy` window with a 90 s `AbortSignal`-enforced deadline), `pino ^9.5.0` (structured logging), `zod ^3.25.0` (schema validation) |
| Non-root user | `agent` (uid 1001) |
| Workdir | `/workspace` (bind mount of repo root) |
| Host ports | `3001` (HTTP/WS), `9229` (node inspect) |
| Internal ports | `5900` (x11vnc, agent-net only) |
| Environment | `RAG_URL=http://rag:3009`, `QDRANT_URL=http://qdrant:6333`, `PG_URL=postgres://agent:agent@postgres:5432/agent`, `ANTHROPIC_API_KEY=...` (from `.env`), `ANTHROPIC_MODEL_HAIKU/SONNET/OPUS` (model pins), `SHARED_RUNBOOKS_UUID / SHARED_SKILLS_UUID / SHARED_SELECTORS_UUID` (Qdrant routing UUIDs), `ALLOWED_WS_ORIGINS` (WS origin allowlist), `DISPLAY=:99` |
| Dockerfile CMD | `sleep infinity` — VS Code attaches via `.devcontainer`. To run the real service inside the container: `docker exec -it agent bash -lc 'cd /workspace/services/agent && npm install && npm run dev'`. Production entrypoint (boot migrations + Hono server + graceful shutdown) is `node dist/index.js`; the agent Dockerfile will be bumped to use it as the default CMD when Week 1B lands alongside the compose `test-webapp` service. |
| HTTP surface | `POST /triage` (body: `{ticketId, subject, submittedBy?, targetUrl?}` — `targetUrl` added in week2e, http/https only, bad scheme → HTTP 400), `GET /runs/:id`, `POST /runs/:id/review`, `GET /healthz` (peer reachability: qdrant + rag + postgres), `GET /static/runs/:runId/:filename` (serves per-run screenshots from the `playwright-videos` volume — see Commit 6c) |
| WS surface | `/stream/:runId` (origin allowlist enforced pre-upgrade; resume-from-seq supported; heartbeat `seq: null`) |

**Why this shape:** the container is simultaneously the dev container (VS Code `Reopen in Container` attaches here) and the production agent host. Same image, two lifecycles. The headed-browser support is baked in so "watch the agent work" via noVNC is a switch, not a refactor.

**Workflow reality (current, post-week2d series + week2e):** `src/mastra/workflows/triage.ts` registers a **10-step** `triage-and-execute` workflow with **TWO human gates** (pre-exec + post-exec) + the new `materialize_skill_card` step (week2d Part 3b) between the pre-exec gate and executeStep. The chain:

```
block1Step  →  reviewGateStep  →  materializeSkillCardStep  →  executeStep  →  verifyStep  →  humanVerifyGateStep  →  logAndNotifyStep
(pre-gate     (PRE-EXEC GATE)    (week2d Part 3b)                                              (POST-EXEC GATE)
 wrapper)
```

**Skill-card role reframing (week2d Part 0 SCAFFOLD vs ARTIFACT primitive):** pre-authored skill cards in `kb/skill_cards/<app>/<skill>.yml` are no longer runtime walkers — they are **SCAFFOLDS** (intent shape + destructive boundaries + postcondition declarations). `runDryRunStep` is an agentic ReAct loop exploring the target app freely; on approve, `runMaterializeSkillCardStep` converts the agent's actionTrace + boundaryReached into an ephemeral **ARTIFACT** `Skill` stored on `ctx.tempSkillCard` + persisted to Postgres (`materialized_skills` table with `<host>_<scaffold>_<uuid>` naming convention per week2d Part 3b). `executeStep` walks the ephemeral artifact via `executeSkillCardSteps`. `runVerifyStep` compares structured postconditions against the final DOM (week2d Part 3c — no more `/verified/i` regex; evidence cites specific `[ref=eN]` DOM tokens). Divergence between scaffold's declared destructive element and the agent's observed one (`boundaryReached.scaffoldMatch === false`) is surfaced as a reviewer-visible banner at review_gate (week2d Part 4).

**Dynamic URL injection (week2e):** `POST /triage` accepts optional `targetUrl` (http/https only). Plan step's prompt includes a TARGET URL RESOLUTION block (Path A+): Sonnet echoes ticket URL or adopts reviewer-observation corrections into `plan.targetUrl` as a discrete audit-logged field update. Downstream `runDryRunStep.baseUrl = plan.targetUrl ?? scaffold.base_url` — scaffold origin stays authoritative when no ticket override is in play.

Where `block1Step` is itself a composite (a plain-TS iteration controller in `src/mastra/lib/blockController.ts`) that internally runs `classify → retrieve → plan → dry_run` in a pass loop up to `BLOCK1_MAX_PASSES = 3` before emitting its output. **See MASTER_PLAN §4 for typed per-step IO; see MASTER_PLAN §4.1 for the ReAct-inside-cognitive-steps shape.**

- **Real LLM steps (Commit 2):** `classify` (Haiku), `plan` (Sonnet, extended thinking at 8192 budget tokens), `verify` (Sonnet, thinking disabled) all make real Anthropic streaming calls routed through a circuit breaker (Commit 7b.i).
- **Real RAG step (Commit 5b + 7b.ii refactor):** `retrieve` runs inside the `createReActStep` ReAct runner (7b.ii) — think → targeted RAG for runbooks → observe hit scores → refine query if weak → also pull skill cards. Emits `react.iteration.started` / `react.iteration.completed` frames; each `rag.retrieved` frame inside carries a `reactIterationId` for UI nesting. Missing Qdrant collection (HTTP 404) → empty-hits envelope + `hitCount: 0` (planning with no context is legitimate). `RagClientError` / `RagSchemaError` → `tool.failed` with soft fallthrough.
- **Real browser steps (Commit 6 + 7a.iv + week2b-skill-cards-runtime):** `dry_run` + `execute` drive `@playwright/mcp@0.0.70` in headless Chromium via `src/mastra/tools/playwrightMcp.ts`. Each run gets its own `--user-data-dir`; screenshots land at absolute paths `/workspace/.playwright-videos/<runId>/<seq>.png`; 7a.iv's implicit post-action screenshots fire `takeScreenshot("${mcpToolName}:after")` after every click / fillForm. `runDryRunStep` pre-closes `ctx.browser` before each `launchBrowser` call (7b.iii.b-pre-exec-edit-ui-hotfix-1) so intra-Block-1 multi-pass retries and refine/backtrack re-invocations don't collide on Playwright MCP's per-run profile lock. `runExecuteStep` (week2b-skill-cards-runtime) probes session liveness at entry: live → reuse + resume at first destructive step (preserves the Week-1B session-carry-over optimization for happy-path UX and no-op-execute on read-only skills); dead (e.g., review_gate timeout) → pre-close + fresh launch + run full skill card. See CTX SPREAD INVARIANT in `runContext.ts` for the browser-field lifecycle docblock.
- **Block 1 iteration controller (7b.iii.a):** `blockController.ts:runBlock1` orchestrates classify/retrieve/plan/dry_run with observation carry-forward. **DESIGN INVARIANT #2 (spread-mutation scope):** classify/retrieve/plan run inside an inner `withRunContext({ ...ctx, priorObservations: [...observations] }, fn)` spread (safe — those three only READ from ctx); dry_run runs in the OUTER ctx scope because `runDryRunStep` MUTATES `ctx.browser = session` (Bug A fix, 7b.iii.b-2-hotfix-1). On exhaust (`passedLast: false`), the controller populates `DryRunSchema.blockResult` and the reviewer UI renders an "exhausted" banner with the approve button disabled.
- **Pre-exec human gate (`review_gate`, Commits 2 + 7b.iii.b-pre-exec-refine + pre-exec-edit-ui + Week-2a gate-decision-model):** suspends on `bus.awaitDecisionForStep(runId, "review_gate")` (per-stepId bus decisions, 7b.iii.b-bus-extension). **Four decision paths (Week-2a gate-decision-model):**
  - `approve` → proceed to executeStep (unchanged).
  - `reject` → **refine loop** with auto-generated directive seed observation ("Try a fundamentally different approach — different skill card, different action sequence, or different assumption about the ticket's goal"). Pre-Week-2a `reject` was the skip-cascade; Week-2a reframed it to mean "replan without reviewer notes" so the surface stays productive instead of terminating. Shares `MAX_PRE_GATE_REFINES` budget with `edit`.
  - `edit` with `patch.notes` → **refine loop** with reviewer's notes: synthesize `Pre-exec refine N: reviewer note: <note>` observation, emit `block.backtrack.triggered { fromStep: "review_gate", backtrackCount: N }`, re-run Block 1 with the note threaded through `runBlock1(..., { seedObservations: ... })` (Bug A Scope 2 fix, hotfix-2 — NO `withRunContext` spread here; see CTX SPREAD INVARIANT in `runContext.ts`), re-emit `review.requested`, re-await. Synthetic `block1 step.started/completed` frames wrap each refine's Block 1 call so the LEFT column re-renders the refined plan via `StepOutcome`'s `findLast` read path (Piece B of commit 4). Same mechanism now serves the `reject` directive path above.
  - `terminate` → **skip-cascade** to `logAndNotifyStep` with `status: rejected`. This is the mechanism that was previously labeled `reject` pre-Week-2a; repurposed under the clearer name in the gate-decision-model commit. `runReviewGateStep` returns `decision: "terminate"` which flows through `executeStep.skipped → verifyStep.skipped → humanVerifyGateStep` (which short-circuits via hotfix-1's entry skip-guard — see Post-exec bullet below) → `logAndNotifyStep`'s skipped-derivation emits `status: rejected`.
  - Cap `MAX_PRE_GATE_REFINES = 2` is shared across `edit` + `reject` (3 total refine cycles per run). 3rd refine trip returns `decision: "terminate"` from the cap-trip path — same skip-cascade as explicit reviewer terminate.
- **Execute → Verify (week2d Part 3b + 3c):** post-week2d, `executeStep` reads `ctx.tempSkillCard` (written by `runMaterializeSkillCardStep` from the agent's actionTrace + appended destructive click from `boundaryReached.element`) instead of `loadSkill(plan.skillCardIds[0])`. `baseUrl` comes from `MaterializeSchema.baseUrl` (forwarded from materialize; resolved as `plan.targetUrl ?? scaffold.base_url` per week2e). Liveness-probe dispatch unchanged from week2b. `runVerifyStep` redesigned (week2d Part 3c): hard-fail guard on `stepsRun === 0 && !skipped` BEFORE any LLM call (closes polish #2 — Sonnet `/verified/i` hallucination surface); structured Sonnet JSON-judge over `ctx.tempSkillCard.postconditions` + fresh browser snapshot → `{success, evidence[]}` with specific DOM-ref citations (e.g. `[ref=e98] 'Password reset successful'`, `[ref=e104] 'Temp-KLL486'`). Fallback path when no postconditions OR no browser session: degrade to `success=(stepsRun>0)` with degradation-reason evidence.

- **Materialize step (week2d Part 3b):** `runMaterializeSkillCardStep(dryRun, review)` converts agent's `DryRunSchema.actionTrace` + `boundaryReached` into ephemeral `Skill`. Critical mental model: `boundary_reached` fires BEFORE the destructive click, so actionTrace contains ONLY non-destructive pre-destructive steps. The materializer APPENDS a synthesized destructive click step from `boundaryReached.element` as the final step — naive 1-to-1 mapping would produce a zero-destructive-step skill that `executeSkillCardSteps(resumeAtFirstDestructive: true)` would no-op on. `substituteInputsInArgs` rewrites verbatim literals matching `plan.inputs` values to `{{ inputs.X }}` placeholders for template portability. `stripEphemeralRef` drops snapshot-scoped refs from click args (executor re-resolves at dispatch). Ephemeral `Skill` stored on `ctx.tempSkillCard` + persisted to Postgres `materialized_skills` table (week2d Part 3b-persist) with convention name `<host>_<scaffold>_<uuid4>` — the UUID doubles as future Qdrant collection name for auto-scaffold-generation (week3+). Skip-cascade path emits `MINIMAL_SKIPPED_SKILL` sentinel so `MaterializeSchema` stays required-shape; `runExecuteStep` checks `review.approved === false` before reading the skill.
- **Post-exec human gate (`human_verify_gate`, Commit 4 + Week-2a gate-decision-model + hotfix-1):** suspends on `bus.awaitDecisionForStep(runId, "human_verify_gate")`. **Four decision paths (Week-2a gate-decision-model):**
  - `approve` (or `edit` — server treats edit ≡ approve, UI deliberately hides Edit to prevent a wedge state; see ChatBar docblock) → happy path; run terminates via logAndNotifyStep with `status: ok`.
  - `reject` → **backtrack loop:** `buildBacktrackContext(currentVerify, reviewerNote, backtrackCount)` produces a 4-5 entry observation array (header matching `/Backtrack \d+/` + reviewer note + stepsRun + success + evidence), emit `block.backtrack.triggered { fromStep: "human_verify_gate", backtrackCount: N }`, re-run the FULL pre-notify chain (block1 → reviewGate → execute → verify) with observations seeded.
  - `terminate` → returns `{ success: false, skipped: true }` verbatim; `logAndNotifyStep`'s skipped-derivation emits `status: rejected`. Symmetric with pre-exec terminate. Does NOT enter the backtrack loop — the reviewer explicitly wants to stop, not iterate.
  - Cap `MAX_BACKTRACKS = 2`. Cap trip (3rd reject): returns `{ success: false, skipped: true }` — **same skip-derivation path as explicit terminate**, so budget exhaust ends the run with `status: rejected` (NOT `status: failed`). Finding 2 fix from Commit A — pre-fix the cap-trip return omitted `skipped: true` which fell through to `status: failed`, wrongly implying workflow-layer fault when it was aggregated reviewer rejection. See `MASTER_PLAN.md` Week-2a progress row for Commit A for the semantic rationale.
  - **Entry skip-guard (Week-2a gate-decision-model-hotfix-1):** if upstream `VerifySchema.skipped === true` (pre-exec Terminate cascade from `executeStep.skipped → verifyStep.skipped`), the gate's entry skip-guard at `triage.ts:1976-1978` short-circuits — the post-exec gate does NOT open, no `review.requested{post_exec}` emits, skipped `VerifySchema` flows through verbatim to `logAndNotifyStep`. Pre-hotfix, P4 smoke observed the post-exec gate opening anyway, requiring a redundant second terminate to close the run.
- **Bus extension (7b.iii.b-bus-extension):** the single-slot-per-run decision model was replaced with per-(runId, stepId) slots. Back-compat shims (`awaitDecision` / `publishClientDecision`) default `stepId = "review_gate"` so pre-7b.iii.b curl scripts keep working. `GateStepIdSchema = z.enum(["review_gate", "human_verify_gate"])` narrows both the WS `review.decide` client frame and the `POST /runs/:id/review` HTTP body. See `src/events/bus.ts:StepGateState` for the slot-consumption state machine.
- **Reviewer-UI screenshot serving (Commit 6c):** `GET /static/runs/:runId/:filename` serves bytes from the `playwright-videos` volume with four-layer path defense. Test-webapp's Next.js `rewrites()` proxies `/api/static/...` → `http://agent:3001/static/...` (same-origin to `:3000`).
- **CTX SPREAD INVARIANT (7b.iii.b commit 5, authoritative in `runContext.ts`):** `withRunContext({ ...ctx, <override> }, fn)` creates a NEW spread object. Mutations to `getRunContext().<field>` inside `fn` land on the spread and are LOST on scope unwind. Read-only-safe-to-spread fields: `runId`, `bus`, `ticket`, `priorObservations`. **DO NOT spread around** a scope that mutates `browser` (specifically: NEVER wrap `runBlock1` in `withRunContext({ ...ctx, priorObservations: ... }, fn)` — thread observations via `runBlock1(..., { seedObservations: ... })` instead). Historic failures: Bug A at three scope boundaries (blockController inner spread — 2-hotfix-1; runReviewGateStep outer refine spread — pre-exec-edit-ui-hotfix-2; humanVerifyGateStep outer backtrack spread — same hotfix, in-comment). Audit recipe: `rg 'withRunContext\(\{\s*\.\.\.' services/agent`.

### 2.2 `rag` — existing embedder, reused over HTTP + extended for per-document collections

| Attribute | Value |
|---|---|
| Build | `services/rag/dockerfile` (from `docs_pipeline_311`, patched — see below) |
| Base image | `python:3.11-slim` |
| Model | `guymorganb/e5-large-v2-4096-lsg-patched` (1024-dim, 4096 max tokens) — **forward-compat patches pushed to HF** |
| Framework | FastAPI + uvicorn on `0.0.0.0:3009` |
| Host port | `3009` |
| HF cache | named volume `hf-cache` at `/root/.cache/huggingface` (survives rebuilds) |
| Watch dirs | `rag-dirty-docs` volume → `/app/src/util/dirty_documents` (self-bootstrapping subdirs) |
| Healthcheck | python `urllib` probe to `GET /monitor` (180s start period to cover model warmup; slim image has no `wget`/`curl`) |

**Key endpoints used by the agent:**

- `POST /docs/upload/documents` — file ingest (chunk + embed + upsert)
- `POST /docs/models/qa` — QA retrieval, body `{ query, collection_name }`
- `POST /docs/models/semantic` — deep semantic retrieval
- `GET /monitor` — queue + thread + model status (used for healthcheck)

**Collection routing is controlled by the filename**, not a query parameter:

| Filename dropped | Qdrant collection |
|---|---|
| `foo.html` (no UUID) | new collection named with a fresh UUID |
| `foo_<uuid4>.html` | collection `<uuid4>` — created if missing, appended if existing |

This avoids needing a `?collection=` upstream controller patch and works identically for the upload endpoint and for direct filesystem drops.

**Patches applied during Phase 0** (all committed to `services/rag/`):

1. `config.yml`: `qdrant.host: localhost → qdrant`, `device: mps → cpu` — run in compose.
2. `src/util/document_cleaning_pipline.py`: `os.rename → shutil.move` for the three post-clean file moves — works when `dirty_documents/` and `clean_docs/` live on different Docker volumes (different filesystems).
3. `src/util/queue.py`: auto-create `html/ pdf/ docx/ other/ temp/` on init; tag untagged filenames with a UUID4 before staging into `temp/`; preserve any UUID4 already present.
4. `src/model/embedding_model.py`: extract the collection-name UUID from the cleaner's renamed original in the same `clean_docs/<ts>/` directory; UUID point IDs so multiple chunks in one collection never overwrite each other.
5. `src/vector_store/qdrant_config.py`: module-level `threading.Lock` around `ensure_qdrant_collection`; tolerate 409 Conflict as success. Fixes concurrent-create race that was silently dropping upserts.
6. `requirements.txt`: version pins for `transformers`, `torch`, `qdrant-client`, `huggingface-hub` (see §8 below for specifics).
7. **HF model repo** (`guymorganb/e5-large-v2-4096-lsg-patched`): `**kwargs` added to `LSGBertEmbeddings.forward`, `LSGSelfAttention.forward`, `LSGBertEncoder.forward`, `LSGBertModel.forward`; defensive `position_embedding_type` default in `LSGBertEmbeddings.__init__`. Forward-compat with transformers 4.40+; pushed upstream, not carried in this repo.

Test fixtures live at `services/rag/test_fixtures/runbooks/` (three HTML runbooks used to exercise the pipeline end-to-end).

### 2.3 `qdrant` — vector store

| Attribute | Value |
|---|---|
| Image | `qdrant/qdrant:latest` |
| Host ports | `6333` (HTTP + dashboard), `6334` (gRPC) |
| Storage | named volume `qdrant-data` at `/qdrant/storage` |
| Collection model | **one collection per uploaded document (or per shared-UUID group)**, UUID-named. Appends supported — no fixed collection names like `document_vectors` / `skill_cards` anymore. Convention is driven entirely by the filename dropped into `rag-dirty-docs` (see §2.2). |
| Vector config | 1024 dim, Cosine distance (matches the e5-large-v2 embedder) |
| Healthcheck | bash `/dev/tcp` HTTP probe to `/readyz` (image has no `curl`/`wget`/`nc`) |

Dashboard: `http://localhost:6333/dashboard`.

### 2.4 `postgres` — structured state

| Attribute | Value |
|---|---|
| Image | `postgres:16` |
| Host port | `5432` |
| DSN | `postgres://agent:agent@localhost:5432/agent` |
| Storage | named volume `postgres-data` at `/var/lib/postgresql/data` |
| Healthcheck | `pg_isready -U agent -d agent` |
| Future schemas | `events` (workflow trace), `reviews` (pending/decided), `selectors` (app, skill, semantic_element, current_selector, last_verified_at), `runs` |

### 2.5 `browser-viewer` — noVNC bridge

| Attribute | Value |
|---|---|
| Build | `services/browser-viewer/dockerfile` (copied from `agent_sidecar_311`) |
| Base image | `ubuntu:22.04` |
| Installs | socat, noVNC 1.4.0, websockify 0.11.0, python3 |
| Host port | `6080` (noVNC web UI) |
| Internal bridge | `socat tcp-listen:5900 → tcp-connect:agent:5900` |
| Patched from original | `main.py`: `forward_host="langgraph-api" → "agent"` |

Open `http://localhost:6080` to watch the agent's Chromium session live. Before the agent has Xvfb + x11vnc running (Week 1), this will connect-refuse — that's expected.

### 2.6 `services-healthcheck` — aggregator

Busybox container that starts only after `qdrant ∧ postgres ∧ rag` are all `service_healthy`. Gives tooling/CI a single wait-target:

```bash
# Wait for the whole stack to be up
docker compose up -d --wait services-healthcheck
```

### 2.7 `test-webapp` — reviewer UI (Week 1A) + Playwright target (Week 1B)

| Attribute | Value |
|---|---|
| Build | `services/test-webapp/Dockerfile` (multi-stage, Next.js `output: "standalone"`) |
| Base image | `node:20-alpine` (builder + runner) |
| Framework | Next.js 14 App Router + React 18 (no Tailwind, no extra libs — single-page UI) |
| Host port | `3000` |
| Non-root user | `uid 1001` |
| Final image | ~120 MB on `linux/arm64` |
| Routes now | `/` landing with curl hint; `/agent/review/[runId]` — **live reviewer page**, opens WS to `ws://agent:3001/stream/:runId`, renders a two-column grid (outcomes + behavior feed, see below), sticky approve/reject panel with idempotency keys on the `review.decide` WS frame; `/login`, `/users`, `/users/[id]`, `/users/[id]/reset-password`, `/status` — the target surface Playwright drives (Commit 4) |
| Server-side rewrite | `next.config.mjs:rewrites()` → `/api/static/runs/:runId/:filename` proxies to `http://agent:3001/static/runs/:runId/:filename` over `agent-net`. Keeps the browser same-origin to `:3000` (CORS-free); the agent's `/static` response carries `Cache-Control: private, max-age=3600` which passes through verbatim so reviewers pay for the bytes once per hour. |
| Post-1A non-goals still open | No Postgres replay (in-memory ring buffer only — Week 4), no auth (Origin allowlist already covers `localhost:3000` — Week 3), no multi-run dashboard. |

**Reviewer UI information architecture (Commit 7a series — landed):**

The `/agent/review/[runId]` page is a **fixed-viewport flex-column shell** (`.review-page { height: 100vh; overflow: hidden }`) — the page body itself never scrolls. Inside the shell, a two-column grid splits the reasoning surface from the action trail, with a hand-rolled resizable divider between them:

```
┌─ .review-page (100vh, overflow:hidden) ───────────────────────────────┐
│  header + ConnectionStrip                                             │
│  ┌─ .review-layout (grid: --left-pct 8px 1fr) ──────────────────────┐ │
│  │ ┌─ .review-outcomes-col ──┐ ║ ┌─ .review-feed-col ─────────────┐ │ │
│  │ │ <StepOutcome classify/> │ ║ │ .behavior-feed (overflow:auto) │ │ │
│  │ │ <StepOutcome retrieve/> │ ║ │   — CLASSIFY —                 │ │ │
│  │ │ <StepOutcome plan/>     │ ║ │   [haiku] … ✓ 782ms            │ │ │
│  │ │ <StepOutcome dry_run/>  │ ║ │   — RETRIEVE —                 │ │ │
│  │ │ <StepOutcome …/>  (×8)  │ ║ │   → rag.retrieveRunbooks ✓ 3h  │ │ │
│  │ │                         │ ║ │   → rag.retrieveSkills ✓ 0h    │ │ │
│  │ │  (independent scroll)   │ ║ │   — PLAN —                     │ │ │
│  │ │                         │ ║ │   [sonnet] thinking… ▊         │ │ │
│  │ └─────────────────────────┘ ║ │   (typewriter reveal, caret)   │ │ │
│  │                             ║ │   [sonnet] thought for 12.4s … │ │ │
│  │                             ║ │     (click to expand)          │ │ │
│  │                             ║ │   — DRY_RUN —                  │ │ │
│  │                             ║ │   → browser_navigate           │ │ │
│  │                             ║ │   → browser_click ✓ 40ms       │ │ │
│  │                             ║ │   [thumb: after-reset 320×180] │ │ │
│  │                             ║ │   (… scroll-anchor at 33vh)    │ │ │
│  │                             ║ └────────────────────────────────┘ │ │
│  │    ↑ 20–80% via drag/kbd ────║ divider (grid track, 8px)         │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  ChatBar — pinned to bottom of LEFT column via flex-column + gap.      │
│    4 modes: [idle: textarea only] [decision-required: Approve/Reject/  │
│    Edit + Terminate link] [submitting: accent border + auto-exit]      │
│    [terminal: muted border, all disabled]. Post-exec hides Edit;       │
│    exhausted disables Approve. Terminate is always-available via       │
│    two-step confirm (3s arm-window).                                   │
└────────────────────────────────────────────────────────────────────────┘
```

- **LEFT (`.review-outcomes-col`)** — one `<StepOutcome>` row per MASTER_PLAN §4 step. Content is distilled from `step.completed.output` (strongly-typed per-step shapes from `src/mastra/workflows/triage.ts`): `classify → category · urgency · conf=X`, `retrieve → N runbook hits · M skill hits`, `plan → N-step plan · ⚠ destructive + first 3 lines with gradient fade, click-to-expand`, `dry_run → domMatches: ✓/✗ + anomaly count`, `review_gate → awaiting | approved by X | rejected by Y`, `execute → N steps run`, `verify → ✓ success + evidence snippet`, `log_and_notify → status · note`. Left-column border accent tracks step status (`--muted` pending → `--accent` running → `--ok` completed → `--warn` awaiting → `--err` failed, with pulsing dot on active). On each new `step.started` transition, the matching row auto-scrolls into view via `block: "nearest"` if the reviewer hasn't interacted with the outcomes column in the last 3 s.

- **RIGHT (`.review-feed-col` → `.behavior-feed`)** — a chronological `<BehaviorFeed>` of every `llm.*` / `tool.*` / `rag.retrieved` / `browser.nav` / `browser.screenshot` / `browser.console` frame, with inline step dividers (`— CLASSIFY —` / `— ✓ CLASSIFY · 782ms —`). Projection is a pure function (`projectFeedItems(frames)`) that walks the frame stream and groups deltas into per-message LLM bubbles, pairs `tool.started` / `tool.completed` / `tool.failed` by `invocationId`, nests `rag.retrieved` hits under open `rag.*` tool spans (or renders as a standalone orphan card if no pair is open — a defensive UI branch for envelope-ordering edge cases). LLM bubbles render thinking deltas in the existing purple `.thinking-block` style while streaming; on `llm.message.completed` they collapse via a CSS grid `1fr → 0fr` transition (200 ms) to a pill summary `[sonnet] thought for 12.4s · click to expand`. Output text is revealed via a 60 cps typewriter hook with catchup scaling (so Sonnet's token-burst pattern doesn't leave the visible text drifting more than ~1 s behind the wire), ending in a blinking `▊` caret while `.typing` is active. Pending `.feed-tool` markers get a 1.5 s breathing-accent `box-shadow` pulse via `rgba(var(--accent-rgb), ...)`, automatically stopped when the card flips to `.ok` / `.err`. Screenshots render as inline 320 × 180 thumbnails via the `/api/static/runs/:runId/:filename` rewrite (reuses the Commit 6c path-resolution code).

- **Scroll anchor** — `scrollIntoView({block: "start"})` called on the feed's `lastElementChild` when a new frame arrives, combined with `.behavior-feed > * { scroll-margin-top: 33vh }`. Every feed item anchors its top at ~1/3 from the viewport top regardless of its own height — typewriter-growing bubbles and thinking-bubble collapses both preserve visual stability because the anchor point is deterministic, not content-dependent. The stuck-to-bottom gesture (auto-scroll pauses when reviewer scrolls up, resumes 3 s after the last manual interaction) rides on top.

- **Resizable divider** — a grid-driven `8 px` track between the two columns, with a 1-px centered hairline visual. Drag via `setPointerCapture` (so the drag stays live when the cursor leaves the hitbox); keyboard via `ArrowLeft` / `ArrowRight` ±2 %. Ratio clamped `[20, 80]` and persisted to `localStorage` under `"reviewLeftPct"`. ARIA `role="separator" aria-orientation="vertical" aria-valuenow/min/max`. The `--left-pct` CSS custom property set as an inline style on `.review-layout` drives `grid-template-columns: var(--left-pct, 42%) 8px 1fr` so the divider's position is a pure render.

- **ChatBar (Week-2a series — persistent 4-decision decision surface)** — replaces the prior `<ReviewPanel>` three-mode component. Lives INSIDE `.review-outcomes-col` (LEFT column flex-column, bottom-pinned), NOT outside the grid, so it inherits `--left-pct` from the divider and matches column width. The `<ChatBar>` component is a state machine driven by `pendingReview` memo + `isRunTerminal` + internal `terminateArmedAt` state. Four modes + four decisions:

  - **Modes** (compound state):
    - `idle` — no `pendingReview`, run still live. Textarea enabled, all action buttons disabled. Idle state has NO Edit affordance — per the idle-state semantic, Edit submission without an open gate has no gate slot to resolve.
    - `decision-required` — `pendingReview !== null`. Accent border + `@keyframes toolPulse` breathing pulse (reuses 7a.v keyframe). Submit button label branches on `pendingReview.reviewHint`; textarea content becomes the `patch.notes` payload on Edit.
    - `submitting` — just-clicked Edit with non-empty notes; accent border + opacity dim. `planId`-delta `useEffect` auto-exits to `decision-required` (or `idle` if the run ended) when the fresh `review.requested` arrives.
    - `terminal` — `run.completed` observed. Muted border; all controls disabled.

  - **Four decisions** (Week-2a gate-decision-model):
    - **Approve** — primary green button. Commits `decision: "approve"` to the current gate's slot. Disabled on `blockResult.passedLast === false` (exhausted — Reject only per Week-2 polish queue item 9 "override-and-proceed").
    - **Reject** — primary red button. Commits `decision: "reject"`. Pre-week2a Reject cascaded to skip (now owned by Terminate); week2a reframed Reject to mean "this plan is wrong, try a different approach" — routes into `runReviewGateStep`'s refine loop with an auto-generated directive seed observation ("Try a fundamentally different approach — different skill card, different action sequence, or different assumption about the ticket's goal"). Shares `MAX_PRE_GATE_REFINES` budget with Edit.
    - **Edit** — primary accent button. Enabled only when textarea has non-empty trimmed content (`canSubmitEdit` guard). Commits `decision: "edit"` + `patch.notes: <textarea>`. Routes into the refine loop with reviewer's notes threaded via `runBlock1(..., { seedObservations })`. Cmd+Enter keyboard shortcut binds to the Submit action for power-users. On post-exec gates, Edit is DELIBERATELY HIDDEN — `humanVerifyGateStep` treats `edit ≡ approve` server-side, so exposing Edit would both confuse reviewers and wedge the `submitting`-mode state machine. ChatBar docblock flags this; future contributors must change the server semantic before re-enabling Edit on post-exec.
    - **Terminate** — secondary text-link, visually de-emphasized beneath the three primary buttons. `canTerminate` is a SEPARATE guard from `canDecide` — terminate is available even on exhausted blocks and on post-exec gates where approve might be the wrong path. **Two-step confirmation** via `TERMINATE_CONFIRM_MS = 3_000`: first click arms the link ("Really terminate? (click again within 3s to confirm)"); second click within the window commits `decision: "terminate"`; auto-reverts to unarmed if the window elapses. Routes into `runReviewGateStep`'s terminate short-circuit (pre-exec) or `humanVerifyGateStep`'s terminate branch setting `skipped: true` (post-exec) — both paths land at `logAndNotifyStep` with `status: rejected` via the skip-cascade.

  - **Exhausted banner** (`blockResult.passedLast === false`): rendered above the ChatBar, per-pass reasons as chips. Approve becomes disabled; Reject + Terminate remain available. Override-and-proceed is Week-2 polish queue item 9.

  - **Post-exec variant** (`reviewHint === "post_exec"`): copy branches to "Post-execution review" with body pointing at `execute:*` screenshots in the feed; Reject and Approve buttons only; Edit hidden (see above); Terminate available.

- **FeedBacktrackBanner (Commit 4)** — full-width feed row rendered on every `block.backtrack.triggered` frame. Copy branches on `fromStep`:

  - `"review_gate"` → pre-exec refine banner, accent-blue tinted, "Pre-exec refine requested by reviewer" subtitle.
  - `"human_verify_gate"` → post-exec backtrack banner, warn-yellow tinted, "Post-exec reject — re-entering full pre-notify chain" subtitle.

  The reviewer's note (if present in `carriedContext`) is surfaced as a highlighted quote block; the remaining prior-attempt summary entries (`Prior attempt's execute.stepsRun: ...`, `Prior attempt's verify.success: ...`, etc.) roll up as a single dim "Carrying N observations forward" line. Visually a level ABOVE the step dividers — reviewers see the cognitive-pass boundary before the new Block 1 pass frames start streaming.

- **LEFT-column refresh on refine/backtrack (Commit 4, Piece B + D.2)** — both `runReviewGateStep`'s refine loop and `humanVerifyGateStep`'s backtrack loop wrap their `runBlock1` call in synthetic `block1 step.started` + `step.completed` frames (Mastra's own stepEmitter only fires block1 frames for the INITIAL `block1Step.execute`; refine/backtrack bypass the Mastra engine and must emit their own). `<StepOutcome>` reads `frames.findLast((f) => f.type === "step.completed")` so multiple step.completed frames for the same step (classify/retrieve/plan/dry_run re-run across refines AND synthetic block1 frames) → LEFT column reflects the currently-pending plan, not the stale initial. Regression-guarded by `reviewGateRefine.test.ts [6]` (asserts exactly 1 synthetic step.started + 1 synthetic step.completed per refine with distinct planId, and `started.length === completed.length` for pair-balance so a future maintainer can't strip the synthetic step.started as "redundant").

- **Implicit post-action screenshots (Commit 7a.iv, agent-side)** — `services/agent/src/mastra/tools/playwrightMcp.ts` wraps `session.click` and `session.fillForm` so each successful MCP call produces a follow-up `takeScreenshot("${mcpToolName}:after")` via a closure-local `doTakeScreenshot()` helper. The `session.takeScreenshot` public method is a thin delegation to the same helper. Screenshot failures in the hook become `logger.debug` (never poison a successful user action). Bumps PNG count per happy-path run from 6 → ~12–15; makes the behavior feed refresh at ~1 frame per user-visible browser action during `execute`.

The Week-1A reviewer page is the single end-to-end human surface for the agent stream. Week 1B expanded this same app to be both the reviewer surface AND the Playwright target (one browser tab, one URL). Commit 4 closed the Week-1B loop: the reviewer can now **guide the agent via Edit at pre-exec** (thread a note into the next Block 1 pass) AND **trigger a full backtrack via Reject at post-exec** (re-run the entire block1 → reviewGate → execute → verify chain with carried observations).

---

## 3. Network & ports

### Network

```yaml
agent-net:
  driver: bridge
  subnet: 172.28.0.0/16
  gateway: 172.28.0.1
```

Service DNS is the service name (e.g. `http://rag:3009`, `postgres:5432`, `qdrant:6333`).

### Published ports

| Host | Container | Service | Purpose |
|---|---|---|---|
| 3000 | 3000 | test-webapp | Reviewer UI + Playwright target |
| 3001 | 3001 | agent | HTTP/WS API (Mastra) |
| 9229 | 9229 | agent | Node `--inspect` for remote debugging |
| 3009 | 3009 | rag | FastAPI |
| 6333 | 6333 | qdrant | HTTP + dashboard |
| 6334 | 6334 | qdrant | gRPC |
| 5432 | 5432 | postgres | Client access |
| 6080 | 6080 | browser-viewer | noVNC web UI |

### Kept internal (not host-published)

- `agent:5900` (x11vnc) — only reachable from `browser-viewer` on `agent-net`

---

## 4. Volumes

| Volume | Mounted in | Purpose | Wipe-safe? |
|---|---|---|---|
| `qdrant-data` | `qdrant:/qdrant/storage` | Vector store data | No — stores runbooks/skills |
| `postgres-data` | `postgres:/var/lib/postgresql/data` | Relational state | No — stores event log |
| `hf-cache` | `rag:/root/.cache/huggingface` | HF model weights (~1–2 GB) | Yes, but rebuild cost is ~10 min |
| `rag-dirty-docs` | `rag:/app/src/util/dirty_documents` | Drop zone for auto-ingest | Yes |
| `rag-clean-docs` | `rag:/app/src/util/clean_docs` | Pipeline intermediate | Yes |
| `agent-node-modules` | `agent:/workspace/node_modules` | Faster dev-container boots | Yes |
| `playwright-videos` | `agent:/workspace/.playwright-videos` | Session recordings (audit trail) | Depends — audit retention |

Bind mount: repo root → `agent:/workspace` (source of truth for code edits from the host).

---

## 5. Startup order (via `depends_on: condition: service_healthy`)

```
  qdrant                 postgres
      │                     │
      └─ healthy ──┐        │ healthy
                  ▼         ▼
                 rag ◀──────┘
                  │ healthy
                  ▼
               agent ────▶ browser-viewer
                  │
                  ▼
         services-healthcheck  (aggregate gate)
```

- `rag` waits for `qdrant` healthy.
- `agent` waits for `qdrant` + `postgres` healthy and `rag` **started** (not `healthy`, to keep dev loops snappy — the embedder warmup can add 30–60 s and we don't want to block the agent container on it).
- `browser-viewer` waits for `agent` started.

**Consequence for the Week-1 Hono server:** any agent-side HTTP client that talks to `http://rag:3009` must **retry with exponential backoff** on connect/5xx during the first ~90 s of agent startup. The embedder's FastAPI comes up quickly, but the model warmup can briefly leave `/docs/models/qa` returning errors. Bake this into the RAG client; don't hard-fail the agent's `/healthz` on a cold `rag`.

---

## 6. Security posture (baked into the container shape)

- **Non-root browser** — `agent` runs as `uid 1001 (agent)` inside the container.
- **Network-scoped secrets** — `postgres` credentials and the LLM API key live only in `.env` / compose env; never written into images.
- **Origin-pinning** (Week 3) — Playwright launch args will restrict navigation to the skill card's `base_url` allowlist; out-of-allowlist nav is a hard error.
- **Credential boundary** — target-app creds are read by Playwright directly via env; LLM prompts never receive them.
- **Audit trail** — `playwright-videos` volume captures every run; retained per compliance policy.
- **Rate limits on destructive actions** — enforced in the agent service before the review gate (Week 3).

---

## 7. First-run expectations (observed on ARM Mac)

`docker compose build` from a clean machine (measured during Phase 0 bring-up):

| Service | Time | Notes |
|---|---|---|
| `qdrant`, `postgres` | seconds | Official images, pull only |
| `browser-viewer` | ~1 min | Ubuntu + socat + noVNC + websockify |
| `rag` | ~7 min | pip resolve + install (torch, transformers, spaCy) + image export |
| `agent` | ~5 min | Playwright Chromium + Xvfb/x11vnc/fluxbox + Node deps |

Image size note: the `rag` pip install pulls ~2 GB of NVIDIA CUDA wheels alongside `torch` on aarch64. These are unused on CPU-only Macs but make the image portable across amd64/arm64 deployment targets (e.g. ACA / AKS nodes) that might actually have GPUs later. A previous experiment pinning torch to the CPU-only index saved disk but trading portability was judged not worth it; default install stands.

`docker compose up -d`:

- `rag` first boot spends ~30–60 s downloading and warming `e5-large-v2-4096-lsg-patched` (with the HF-side forward-compat patches) into the `hf-cache` volume. Subsequent boots skip the download.
- `qdrant` creates collections on first write. Each dropped file (or same-UUID group of files) creates or appends to its own UUID-named collection — see §2.2.

---

## 8. Verified state

Last bring-up produced the following (all healthchecks green):

```text
SERVICE                STATUS                    PORTS
agent                  Up                        3001, 9229
services-healthcheck   Up (healthy)              —
browser-viewer         Up                        6080
postgres               Up (healthy)              5432
qdrant                 Up (healthy)              6333, 6334
rag                    Up (healthy)              3009
```

Functional probes performed:

| Service | Probe | Result |
|---|---|---|
| qdrant | `GET /readyz` via bash `/dev/tcp` | `HTTP/1.0 200 OK` |
| qdrant | `GET /collections` from host | `{"collections":[]}` (expected — empty until first ingest) |
| postgres | `pg_isready -U agent -d agent` | `accepting connections` |
| rag | `GET /monitor` | `{"cleaning_consumers_count":2,"embedding_consumers_count":2,"file_queue_size":0,"clean_doc_queue_size":0,"model_in_use":"guymorganb/e5-large-v2-4096-lsg-patched"}` |
| rag | model warmup (logs) | `Embedding model 'guymorganb/e5-large-v2-4096-lsg-patched' warmed up and cached.` |
| browser-viewer | `GET /vnc.html` | `HTTP 200` |
| agent | `node --version` | `v20.20.2` |
| agent | `npx playwright --version` | `1.59.1` |
| agent | `which xvfb-run x11vnc fluxbox` | all present on PATH |
| services-healthcheck | aggregate gate | `healthy` (fires once `qdrant ∧ postgres ∧ rag` healthy) |

### Healthcheck patches applied during bring-up

Two images on the stack ship without `wget`/`curl`. The healthchecks were switched to use tools guaranteed to exist in each image:

- **qdrant** — uses bash `/dev/tcp` to probe `GET /readyz`. (Verified: `qdrant` image has `/usr/bin/bash` and nothing else useful.)
- **rag** — uses `python -c "import urllib.request..."` to probe `GET /monitor`. (Python is the runtime of the container.)

Both are committed in `docker-compose.yml`.

### RAG end-to-end smoke (concurrent, 6-file drop)

Verification run that sealed Phase 0. Script generates one shared UUID, tags 3 files with it (paralleled), drops 3 untagged files (paralleled), waits for the pipeline.

| Dropped filename | Got tagged with | Collection |
|---|---|---|
| `pr_${SHARED}.html` | `${SHARED}` (preserved) | `${SHARED}` |
| `ua_${SHARED}.html` | `${SHARED}` (preserved) | `${SHARED}` |
| `ss_${SHARED}.html` | `${SHARED}` (preserved) | `${SHARED}` |
| `pr_copy.html` | auto-generated | 1st fresh UUID |
| `ua_copy.html` | auto-generated | 2nd fresh UUID |
| `ss_copy.html` | auto-generated | 3rd fresh UUID |

Final Qdrant state: **4 collections, 6 points total — distribution `3 + 1 + 1 + 1`.** Two cleaner threads + two embedder threads running in parallel, zero 409 errors in the logs, zero lost upserts. This validates both the per-document collection semantic and the concurrency fix.

### Dependency pins in `services/rag/requirements.txt`

Unpinned versions caused three separate compat breaks during bring-up. The locked window is:

```
transformers>=4.46,<5       # 5.x removes attributes the LSG model depends on; <4.46 missing CVE check wanted below
torch>=2.6,<2.8             # 2.6+ required by transformers 4.46+ CVE-2025-32434 torch.load safety
qdrant-client<1.13          # 1.13+ removed .search() used by the QA controller
huggingface-hub<1.0         # v1 broke several transformers 4.x call sites
tokenizers<0.22             # matches the pinned transformers range
```

---

## 9. Roadmap anchor

This architecture document describes **Phase 0** — unified project scaffolding with healthy infrastructure AND a fully-functional RAG layer. `docs/MASTER_PLAN.md` describes how the remaining phases layer onto this topology:

| Phase | Adds | Touches |
|---|---|---|
| Pre-Week-1 | Streaming LLM thoughts into the agent loop (reference code from prior project to be merged) | `services/agent/` |
| Week 1 | `services/test-webapp/` (Next.js stub) + Mastra + Playwright MCP + Hono HTTP server in `agent` | `services/agent/`, `services/test-webapp/`, `docker-compose.yml` |
| Week 2 | Skill-card schema + runbook ingestion scripts — no `rag` upstream patch needed (UUID-filename convention already handles per-collection routing) | `kb/`, `scripts/`, `services/agent/` |
| Week 3 | Full 8-step workflow + review gates + real headed-browser boot script | `services/agent/`, `postgres` schema |
| Week 4 | Eval harness + session replay + `/metrics` | `services/agent/`, `scripts/` |

Each new service is a new folder under `services/`; each new volume/network change is a compose diff. The boundaries here are deliberate so nothing needs to move later.
