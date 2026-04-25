# Platform Pivot Points

> **Purpose.** This document captures the architectural substrate that is **domain-neutral** versus the layers that are **domain-specific** for the current `browser_agent` codebase. It exists so that a future decision to pivot the product — into a generic human-in-the-loop editor, an LLM training/data-collection tool, or a browser-based agentic coding tool — has a concrete layer-swap map instead of a blank page.
>
> **When this doc was authored.** After Week 1B (9-step workflow + 2 human gates + pre-exec refine loop + post-exec backtrack loop) and at the gate of Week 2a (ChatBar UX refactor). The referenced commit `PLATFORM_PIVOT_POINT` is intended to be cut right after `week2a-chatbar` + `week2a-chatbar-docs-sync` land, so the substrate-with-ChatBar is the frozen revert target for any future pivot.
>
> **How to use this doc.**
> - If you want to pivot: read §3 (substrate invariants — do not touch), then the relevant variant in §5, then §6 (migration path template).
> - If you want to evaluate whether a pivot is worth it: read §7 (red lines) first.
> - If you want to keep the current IT tool and just understand the architecture: ignore this doc and read `ARCHITECTURE.md` + `Architecture.txt` instead.

---

## 1. The five-layer architecture (reference)

Per `docs/Architecture.txt §1`, the agent service has five horizontal layers. Each layer only talks to the layer immediately below it.

```
  ENTRY LAYER           — HTTP / WebSocket routing
  ORCHESTRATION LAYER   — workflow engine, Block 1 controller, ReAct runner
  TOOL LAYER            — LLM / RAG / Browser wrappers
  PRIMITIVES LAYER      — envelope schema, bus, persistence, circuit breaker, DB
  EXTERNAL WORLD        — Anthropic, rag:3009, postgres, target app, reviewer UI
```

Every pivot decision ultimately answers one question per layer: **does this layer transfer verbatim, specialize, or get rewritten?**

---

## 2. What makes a layer "substrate" vs. "domain-specific"

A layer is **substrate** if it would survive a pivot to a completely different product domain with zero or near-zero changes. A layer is **domain-specific** if its current shape encodes assumptions about IT helpdesk tickets, password resets, runbooks, or Playwright-driven web admin portals.

| Layer | Substrate or domain-specific? | Why |
|---|---|---|
| Entry | **Mostly substrate**, one domain-specific endpoint | `POST /triage` is helpdesk-shaped; everything else (`/runs/:id`, `/runs/:id/review`, WS `/stream/:runId`, `/static`, `/healthz`) is generic |
| Orchestration | **Substrate-shaped, domain-populated** | The 9-step chain is helpdesk-shaped; the engine (Mastra, Block 1 controller, ReAct runner, runContext, stepEmitter) is not |
| Tool | **Mostly domain-specific** | `rag.ts` binds runbook/skill-card collections; `playwrightMcp.ts` drives a browser. Only `streamMapper.ts` is generic |
| Primitives | **Pure substrate** | Envelope schema, bus, persist, circuit breaker, DB client — zero domain assumptions |
| External | **Split** | Anthropic + Postgres + reviewer UI are generic. `test-webapp` + `rag:3009` runbook content are domain-specific |

The implication is already the headline: **four-fifths of the codebase is substrate. The IT-helpdesk product is a specific population of the tool layer + one entry endpoint + the orchestration chain's concrete steps.** Swapping the tool-layer population changes the product without touching the engine.

---

## 3. The invariant substrate (do not touch across pivots)

These pieces stay identical across every pivot in this document. If a pivot proposal asks to modify one of them, it is an indication that the pivot is deeper than a platform-level change — probably a ground-up rebuild.

### 3.1 Primitives layer (§4 of `Architecture.txt`) — 100% invariant

| File | Invariant? | Notes |
|---|---|---|
| `src/events/envelope.ts` | ✅ | Frame types (`llm.*`, `tool.*`, `react.iteration.*`, `review.*`, `block.*`, `step.*`, `run.*`) are domain-neutral. New domains MAY add frame variants; existing variants stay |
| `src/events/bus.ts` | ✅ | Per-stepId decision slots, ring buffer, stale-discard — all product-agnostic |
| `src/events/persist.ts` | ✅ | Append-only Postgres writer, keyed by `(runId, seq)` |
| `src/lib/circuit.ts` | ✅ | Named circuit-breaker registry |
| `src/db/{schema,client,migrate}.ts` | ✅ with one caveat | `runs`, `events`, `reviews` tables are generic. Any variant-specific state (skill-card metadata, repo-path locks, dataset-export cursors) is an **additive** schema, never a modification |
| `src/env.ts`, `src/logger.ts` | ✅ | Zod-validated env + pino with API-key redaction |

### 3.2 Orchestration engine (not the workflow chain) — 100% invariant

The **engine** (generic) is invariant. The **chain** (what steps in what order) is per-variant.

| File | Invariant? | Notes |
|---|---|---|
| `src/mastra/lib/reactRunner.ts` (`createReActStep`) | ✅ | Think → tool → observe loop, tool-registry-driven |
| `src/mastra/lib/blockController.ts` (`runBlock1`) | ✅ | Retry-with-accumulated-observations pattern; generic over "which steps go inside the block" |
| `src/mastra/runContext.ts` + CTX SPREAD INVARIANT | ✅ | AsyncLocalStorage wrapper; the invariant docblock itself is load-bearing |
| `src/mastra/stepEmitter.ts` | ✅ | Generic Mastra-events → envelope-frames translator |
| `REACT_FINAL_SENTINEL` sentinel mechanism (reactRunner.ts) | ✅ | week2d Part 1 — name-agnostic early-termination primitive. Any future ReactTool can opt in via runtime cast; runner detects + strips + breaks loop. Domain-neutral. |
| SCAFFOLD vs ARTIFACT conceptual primitive (Architecture.txt §12) | ✅ | week2d Part 0 — reframes pre-authored skill cards as intent-shape hints vs ephemeral agent-traced artifacts. Domain-neutral: any domain with a "pre-authored recipe vs actually-performed sequence" split inherits the pattern. |
| REVIEWER-CONTROL VIA EDIT-REFINE primitive (Architecture.txt §13) | ✅ | week2d/2e — codifies Edit-note → seedObservations → auditable plan-field flips (inputs, targetUrl, ...). Discrete field-delta audit trail is domain-neutral; only the specific fields populated are variant-specific. |

### 3.3 Entry layer — mostly invariant

| File | Invariant? | Notes |
|---|---|---|
| `src/http/runs.ts` (`GET /runs/:id`, `POST /runs/:id/review`) | ✅ | Human-gate decision routing is domain-neutral |
| `src/http/static.ts` | ✅ | Static file serving for screenshots / artifacts |
| `src/http/health.ts` | ✅ | Liveness |
| `src/events/stream.ts` (WS `/stream/:runId`) | ✅ | WebSocket fan-out + `review.decide` routing |
| `src/index.ts` | ✅ | Hono bootstrap |

### 3.4 Reviewer UI substrate — invariant after Week 2a

Post-ChatBar commit:

| Component | Invariant? | Notes |
|---|---|---|
| ChatBar (persistent input + gate decisions) | ✅ | Jakob's-Law input + three-button + Cmd+Enter edit binding is domain-neutral |
| `pendingReview` memo + `planId`-delta auto-exit + Cancel-refine escape hatch | ✅ | Load-bearing edge cases apply to every variant |
| Left-column `StepOutcome` stream + behavior feed + typewriter + thinking-fade + tool-card pulse | ✅ | All driven by envelope frames, no domain coupling |
| FeedBacktrackBanner | ✅ | Meta-loop visualization is generic |

### 3.5 Two meta-loops — invariant

Pre-exec refine (reviewer-drives-replan via Edit) and post-exec backtrack (reviewer-drives-redo via Reject) are product-agnostic: "human can redirect the agent mid-flight" is the substrate primitive. Both ride `block.backtrack.triggered` + `runBlock1(..., { seedObservations })` regardless of variant.

---

## 4. The swap surface (per-layer, per-variant summary)

Condensed table; see §5 for the narrative per variant.

| Layer | IT Tool (current) | Generic Editor | LLM Training Tool | Vibe Coding Tool |
|---|---|---|---|---|
| Entry domain endpoint | `POST /triage` | `POST /session` or `POST /task` | `POST /rollout` or `POST /label-job` | `POST /edit-session` |
| Orchestration chain | 9 steps (classify → retrieve → plan → dry_run → review_gate → execute → verify → human_verify_gate → log_and_notify) | Generic N-step with at least one pre-exec + one post-exec gate | 9 steps but `execute` is often a no-op or a text-emit; heavy instrumentation | 9 steps with `execute` = diff-apply, `verify` = tests/typecheck, `dry_run` = preview diff |
| Tool layer — retrieval | `rag.ts` → runbook + skill-card collections | domain-specific RAG wrapper | domain-specific RAG wrapper (may be empty) | code-aware RAG (tree-sitter, symbol graph, git blame) |
| Tool layer — action | `playwrightMcp.ts` → browser driving | domain's workspace manipulator | text-only; `action` is "the agent's proposed label" | `filesystem.ts` + `lsp.ts` + `shell.ts` |
| Tool layer — verification | Playwright snapshot + Sonnet verify | domain snapshot + verify | structured-output validator | test runner + typechecker + linter |
| Skill cards (SCAFFOLDS post-week2d — see Architecture.txt §12) | IT skills (reset_password, unlock_account) | domain capability cards | optional; dataset-shape cards possible | edit primitives (refactor, add_test, rename_symbol) |
| External: target | `test-webapp` (BPO admin portal stand-in) | domain's target system | none or text-only | real repo / worktree / LSP server / shell |
| Primitives | unchanged | unchanged | unchanged + export hooks | unchanged |
| Verbage | ticket / reset / unlock / runbook / skill card / reviewer | task / operation / plan / action / reviewer | rollout / trajectory / preference / chosen / rejected / annotator | task / instruction / diff / patch / edit / reviewer |

---

## 5. Per-variant narratives

### 5.1 IT Tool — the current canonical shape

**Elevator pitch.** Tier-1 IT helpdesk triage agent for BPOs running 100+ parallel agents. Human gate on every destructive action; full audit trail; screenshot-on-action reviewer UI. Pitch is "auditability + review gates, not raw autonomy."

**What's populated.**
- Tool layer: `rag.ts` retrieves runbooks + skill cards from `rag:3009`; `playwrightMcp.ts` drives Chromium against the target BPO admin portal.
- Skill cards: `reset_password`, `unlock_account`, `lookup_user`, `check_system_status`, `update_ticket_note`.
- Orchestration chain: the 9-step workflow with IT-shaped step bodies.
- External: `test-webapp` is the stand-in target; real deployments swap in the BPO partner's staging env per `MASTER_PLAN.md §7 Week 6+`.

**Verbage.**

| Generic concept | IT tool wording |
|---|---|
| Task / intent | Ticket |
| Action taken | Resolution (reset, unlock, note-update) |
| Pre-exec gate | Review gate ("does this plan look right?") |
| Post-exec gate | Human verify gate ("did it actually work?") |
| Knowledge retrieval | Runbook / skill-card retrieval |
| Tool invocation | Playwright action / RAG query |
| Reviewer | Tier-1 reviewer / helpdesk supervisor |
| Reject (replan without notes) | Reject (applied to the refine loop; auto-generated directive seed "take a different approach") |
| Edit (replan with notes) | Edit (applied to the refine loop; reviewer's `patch.notes` threaded as seed observations) |
| Terminate (full-stop) | Terminate (skip-cascade to `run.completed{status=rejected}`; Jane's row unchanged; the "I want this to stop right now" escape hatch) |
| Agent's proposed steps | Plan (`actions[]` from `PlanSchema`) |

**Commercial shape.** Per-seat licensing to BPOs; value prop is labor arbitrage + auditability for compliance. Design-partner pilots scoped in `MASTER_PLAN.md §7 Week 6+`.

---

### 5.2 Generic Human-in-the-Loop Editor — the substrate exposed

**Elevator pitch.** The helpdesk framing stripped. You bring the domain; we give you the gate-plus-audit substrate. Orchestration engine, frame schema, reviewer UI, meta-loops, circuit breaker — all transfer. You implement the tool layer.

**What swaps.**
- Tool layer: entirely new — a pair of wrappers (one for context retrieval, one for workspace manipulation) that a domain expert writes following the `§9.1 ADD A NEW TOOL` recipe from `Architecture.txt`.
- Orchestration chain: keep the shape, swap step bodies. `classify` → "classify the user's intent into your domain taxonomy"; `retrieve` → "pull relevant context from your domain KB"; `plan` → "propose ordered domain actions"; `dry_run` → "preview in domain-safe way"; `execute` → "commit the domain mutation"; `verify` → "confirm desired end-state."
- Skill cards: domain-specific YAML; schema from `MASTER_PLAN §3.2` generalizes if you genericize `base_url` → `handle`, `steps[].{role, action, value}` → `steps[].{tool, args}`.
- Entry endpoint: `POST /session` or `POST /task` with a body schema the domain defines.
- External: whatever the domain's target system is.

**What does NOT swap.**
- Entire primitives layer, the orchestration engine (not the chain), stepEmitter, runContext, reviewer UI, reviewer WS stream, event persistence.

**Verbage.**

| Generic concept | Generic-editor wording |
|---|---|
| Task / intent | Task (plain) |
| Pre-exec gate | Pre-execution review |
| Post-exec gate | Post-execution verification |
| Knowledge retrieval | Context retrieval |
| Agent's proposed steps | Plan (unchanged) |
| Reviewer | Operator |
| Meta-loops | Refine / redo |
| Reject (replan without notes) | Reject → refine/redo without operator context |
| Edit (replan with notes) | Edit → refine/redo with operator's guidance threaded as seed context |
| Terminate (full-stop) | Terminate → skip to session end with `status=rejected` |

**Commercial shape.** Platform-as-a-framework play. Not a product sold directly; the tech you ship to partners who want auditable agent behavior in their vertical. Lower immediate revenue, higher leverage. **Not recommended as a business model unless paired with at least one opinionated vertical to prove the substrate.**

---

### 5.3 LLM Training / Data-Collection Tool

**Elevator pitch.** Every agent run is a fully-labeled trajectory. Reviewers don't approve resolutions — they score, correct, and label them as preference data. The refine loop is DPO pairs by construction: the original plan is "rejected," the post-edit plan is "chosen," the reviewer's note is the rationale.

**Product shape.** Think Scale AI / Surge AI / OpenAI's o1-tune pipeline, but with the agent's own behavior as the data source instead of prompts-from-prompt-library. The reviewer UI becomes a labeling console; the event log becomes a dataset.

**What swaps.**
- Tool layer: retrieval may stay (for RAG-in-the-loop training), but `execute` is often neutered — text-only or no-op. The "agent acts in the world" leg of the workflow downgrades to "agent proposes in a sandbox."
- Orchestration chain: same 9 steps. `execute` may become `simulate_execute` that emits a plausible observation without actually calling Playwright. `verify` becomes structured-output validation against a rubric instead of real-world DOM check.
- Skill cards: optional; a rubric / taxonomy file may replace them.
- Primitives layer: **one additive surface needed** — a `POST /export-dataset` endpoint in the entry layer that reads from the `events` table and produces (prompt, chosen, rejected, rationale) tuples, SFT-format trajectories, or whatever export shape the training pipeline wants. This is a new file (`src/http/export.ts`) and a new Postgres view, but **zero schema migration** — the data is already in `events`.
- External: add a dataset sink (HuggingFace dataset repo, an S3 bucket, whatever).

**What does NOT swap.**
- Primitives layer (no schema changes, only additive export hooks).
- Orchestration engine.
- Reviewer UI including ChatBar (the three-button + edit-with-note model is EXACTLY the preference-labeling primitive; Approve = "this trajectory is chosen," Reject = "this trajectory is rejected," Edit-with-note = "this trajectory is rejected, and here's why / what a better one looks like" = preference pair with rationale).

**Verbage.**

| Generic concept | Training-tool wording |
|---|---|
| Task / intent | Prompt / rollout seed |
| Run | Rollout / trajectory / episode |
| Agent's proposed steps | Candidate trajectory |
| Pre-exec gate | Trajectory preview review |
| Post-exec gate | Trajectory-end scoring |
| Approve | Mark chosen / accept as positive example |
| Reject (replan without notes) | Mark as negative example AND request regeneration (DPO pair-in-progress: current trajectory is "rejected," next rollout is the candidate "chosen") |
| Edit (replan with notes) | Preference pair with explicit rationale (current trajectory = rejected; annotator's note = rationale; next rollout = candidate chosen) |
| Terminate (full-stop) | Dataset closure: discard this trajectory entirely (not a training example in either direction — the annotator flagged it as unrecoverable) |
| Refine loop | Corrective rollout (next rollout conditioned on reviewer's rationale) |
| Backtrack loop | Regeneration with annotator signal |
| Reviewer | Annotator / labeler / evaluator |
| Audit log | Dataset |
| `events` table | Training corpus |
| Skill cards | Task rubric / scoring rubric |

**Commercial shape.** B2B SaaS to AI labs and ML teams. Price per labeled trajectory or per-seat for annotators. High margin if the export pipeline is clean; depends on having annotator pools (your BPO network!) as a competitive moat. **This variant is unusually leveraged because your existing BPO design-partner network is also the ideal annotator pool** — same labor, different framing.

**Specific architectural note.** The `review.decided` frame already carries everything a DPO trainer needs: the frame has `decision`, optional `patch.notes`, reviewer identity, timestamp, and is linked via `runId`/`stepId` to the full frame history. A dataset row is literally `SELECT runId, seq_start, seq_end FROM events WHERE type = 'review.decided'` plus the frame context. **The substrate is already a training-data generator; only the export endpoint is missing.**

---

### 5.4 Vibe Coding Tool — browser-based agentic code editor

**Elevator pitch.** Same substrate, but the "target app" is a repo and the "tools" are filesystem + LSP + shell. Reviewer gates on diffs instead of password-reset buttons. Edit-with-note becomes "rewrite this diff with the following guidance." Post-exec verify becomes "run the tests."

**Product shape.** Cursor meets Claude meets a web IDE. Differentiator vs. Cursor: full audit trail, explicit gates on every mutation (Cursor is more implicit), three-variant reviewer UI (ChatBar state-machine) plus the meta-loops for human-guided re-planning that Cursor's agent mode doesn't expose as first-class.

**What swaps.**
- Tool layer: complete rewrite. `rag.ts` → `codeRag.ts` (tree-sitter-chunked repo + symbol graph + git history). `playwrightMcp.ts` → split into `filesystem.ts` (read/write/diff files), `lsp.ts` (LSP client for go-to-def, find-refs, hover, rename-symbol), `shell.ts` (run tests / linter / typechecker / build). `streamMapper.ts` unchanged.
- Orchestration chain: same 9 steps, different bodies.
  - `classify` → "categorize intent into {new_feature, refactor, bug_fix, test_add, docs}"
  - `retrieve` → "pull code context, related tests, recent git history" (ReAct-friendly; symbol graph + tree-sitter chunk lookup)
  - `plan` → "propose ordered diffs with file paths + before/after"
  - `dry_run` → "apply diffs to a git worktree scratch copy; run linter + typechecker; report results"
  - `review_gate` → pre-apply diff review (same ChatBar UX, reviewer approves diff or edits it or rejects)
  - `execute` → "apply diffs to the real working tree"
  - `verify` → "run the test suite; check typecheck/lint still green"
  - `human_verify_gate` → "did this change actually solve the task?"
  - `log_and_notify` → git commit with reviewer attribution + audit trail link
- Skill cards: edit primitives — `refactor_function`, `extract_method`, `rename_symbol`, `add_test`, `update_import`, `fix_lint`. `destructive: true` on anything that touches the working tree.
- Entry endpoint: `POST /edit-session` with `{ repoPath, taskDescription, branchName }`.
- External: swap `test-webapp` for the real repo (git worktree); swap `rag:3009`'s runbook content for a code-indexing pipeline (still a Python FastAPI service, just different ingest).

**What does NOT swap.**
- Primitives layer.
- Orchestration engine.
- Reviewer UI (ChatBar transfers 100%; meta-loops transfer 100%).
- The entire "human on every destructive action" pitch — becomes MORE valuable in a coding context because nobody wants an agent silently rewriting their code.

**Verbage.**

| Generic concept | Vibe-coding wording |
|---|---|
| Task / intent | Task / instruction |
| Plan | Diff plan / change set |
| Action (atomic step) | Edit / diff hunk |
| Pre-exec gate | Diff review |
| Post-exec gate | "Did the tests pass / did the change work" review |
| Approve | Accept diff |
| Reject (replan without notes) | Reject diff → regenerate with the agent's own read of "different approach" |
| Edit (replan with notes) | "Rewrite diff with this guidance" (developer's notes threaded as seed context) |
| Terminate (full-stop) | Abandon this edit session entirely; working tree unchanged; session closes with `status=rejected` |
| Refine loop | Re-plan with reviewer guidance (= Cursor's "refine" if it had one) |
| Backtrack loop | Redo after failed verification |
| Reviewer | Developer / reviewer / pair programmer |
| Skill cards | Edit primitives / operation library |
| `execute` | Apply diff to working tree |
| `verify` | Run tests + typecheck + lint |
| Destructive flag | Working-tree-modifying flag |

**Commercial shape.** Freemium IDE-as-a-service; Teams pricing for enterprises that want audit trails on AI-assisted code changes (regulated industries, compliance-heavy orgs, agencies billing hourly with AI-tracked productivity). Competes with Cursor on "auditability + explicit gates," not on raw IDE features. Much larger TAM than IT-helpdesk-for-BPOs. **Higher execution bar** — code indexing + LSP integration is substantial work (probably Weeks 2-8 of rebuild).

---

## 6. Migration path template (generic)

If you pivot from the current IT tool to any of the three variants, the migration follows a consistent shape. This is a template — instantiate for your target variant.

### Phase 0 — Freeze the pivot point (the `PLATFORM_PIVOT_POINT` commit)

- Ensure all current invariants are green (150+ tests, clean smoke, 4 forensic fingerprints = 0).
- Ensure docs are synced (`ARCHITECTURE.md` + `Architecture.txt` + `MASTER_PLAN.md` all reflect the current IT-tool state).
- Cut the commit tagged `PLATFORM_PIVOT_POINT`. This is the generic substrate + ChatBar + meta-loops, with the IT-tool tool-layer and chain-bodies populated as the canonical reference implementation.
- Any future pivot branches from this commit (or from a descendant that explicitly preserves it).

### Phase 1 — Tool-layer rewrite

- Delete or deprecate the IT-specific tool modules: `rag.ts` (runbook semantics), `playwrightMcp.ts` (browser driving).
- Write the variant's tool modules following the `§9.1 ADD A NEW TOOL` recipe from `Architecture.txt`:
  - Accept `{ runId, bus, stepId }` in opts.
  - Emit `tool.started` / `tool.completed` / `tool.failed` frames with the existing envelope schema.
  - Throw typed errors on failure.
  - Optionally wrap unreliable externals in `getCircuit("<service-name>").execute(...)`.
- **Do not invent new frame types** for tool categories that fit an existing frame (e.g., if your tool retrieves data, emit `rag.retrieved` even if "RAG" is a misnomer for your domain — the frame type is load-bearing in the reviewer UI, and renaming it is scope creep). Only add new frame types if a genuinely new semantic category appears.

### Phase 2 — Orchestration chain body swap

- Keep `createStep` signatures and the `.then()` chain shape from `triage.ts`.
- Rewrite step bodies (`runClassifyStep`, `runRetrieveStep`, etc.) for the variant.
- Keep Block 1's retry-with-accumulated-observations pattern and its `seedObservations` pathway.
- Keep `createReActStep` as the primary reasoning primitive; decide per-step whether to apply it per `Architecture.txt §9.5`.
- Preserve the CTX SPREAD INVARIANT — all mutable `ctx.*` fields stay read-write from outer scope, NEVER inside a `withRunContext({ ...ctx, ... })` spread.

### Phase 3 — Entry-endpoint rename + schema update

- Rename `POST /triage` to the variant's endpoint (`POST /session` / `POST /rollout` / `POST /edit-session`).
- Update the request body schema.
- Keep `POST /runs/:id/review`, `GET /runs/:id`, WS `/stream/:runId`, and all other entry-layer endpoints unchanged.

### Phase 4 — Reviewer UI verbage swap

- Search-and-replace the visible copy in the reviewer UI for the variant's verbage (§5.x table).
- **Do not rename component names** (`ChatBar`, `BehaviorFeed`, `StepOutcome`, etc.) — they're domain-neutral already and internal to the codebase. Only change user-facing strings.
- Keep the ChatBar state machine + meta-loop visualization + screenshot rail (or its variant's equivalent — for the coding variant, replace screenshot rail with "diff preview rail").

### Phase 5 — Skill-card (or variant-equivalent) library

- Author 5-10 domain-specific operation/skill cards in YAML.
- Re-use the Zod schema from `MASTER_PLAN §3.2` if applicable; genericize `base_url` → `handle` if it survives at all.
- Populate `kb/` (or the variant's knowledge directory) with domain prose; run the RAG ingestion pipeline.

### Phase 6 — Evals + smoke discipline

- The 4 forensic SQL fingerprints transfer directly (they're substrate bugs, not domain bugs).
- Variant-specific forensic fingerprints may emerge; add them to `STARTUP_PROCESS §1.6.7` as discovered.
- The 5-path smoke (approve-only, pre-exec edit refine, post-exec reject backtrack, post-exec budget exhaust, pre-exec reject terminate) transfers directly. Only the "what the run actually does" is variant-specific.

### Phase 7 — Docs-sync commit

- Update `ARCHITECTURE.md` for the variant's domain.
- `Architecture.txt` only needs changes in §3 (workflow step bodies) and §8 (file index comments); §1 / §2 / §4 / §5 / §6 / §7 / §9 / §10 / §11 all transfer unchanged.
- Rewrite `MASTER_PLAN.md` progress table for the variant's roadmap.

---

## 7. Red lines / hard constraints

These are things that are not worth the pivot cost unless they're genuinely addressing business needs. Each is listed with its cost so a future decision-maker can weigh it honestly.

### 7.1 What you LOSE by pivoting away from IT

- **BPO design-partner pipeline.** Any existing conversations with BPOs assuming the IT-helpdesk framing would need to re-open or be abandoned. (LLM training variant can actually leverage this — same labor force, different framing.)
- **Compliance narrative specificity.** The IT-tool pitch is sharp because compliance-for-regulated-BPOs is a clean story. Generic / vibe-coding / training-tool pitches are more diffuse.
- **Runbook corpus investment.** Whatever runbooks you've authored are IT-specific. Not lost (they're prose) but not load-bearing in a new variant.
- **Destructive-action quotas + security posture (`MASTER_PLAN §6`).** Specifically framed for "Chromium driving an admin portal." Still applies in spirit but reshapes significantly for a coding variant (working-tree quotas? commit-size limits?).

### 7.2 What you CARRY across every variant

- Every envelope frame type.
- Bus decision slots.
- Circuit breaker.
- Event persistence and append-only audit trail.
- Reviewer UI ChatBar + behavior feed + meta-loops.
- The three-commit cadence + smoke-first discipline (this is process, not code, but it's substrate-quality).
- The CTX SPREAD INVARIANT.
- The "frames are the source of truth" discipline.
- All four forensic bug fingerprints remain useful diagnostics.

### 7.3 Hard constraints that must be re-evaluated per variant

- **Envelope 16 KiB cap.** Fine for IT / generic / training. Tight for vibe-coding — a diff payload could easily exceed 16 KiB. The substrate handles this today by persisting large artifacts to disk and referencing by path (`browser.screenshot` pattern). Same solution would apply to diffs, but it's an explicit design choice in the vibe-coding variant.
- **Per-stepId decision slots.** Today there are exactly two gates (`review_gate` + `human_verify_gate`). A variant with >2 gates or dynamically-named gates needs the `GateStepIdSchema` enum to be extended or replaced with a regex pattern. Low-cost change; worth flagging.
- **Anthropic-only LLM provider.** The streamMapper + circuit breaker assume Anthropic's SDK shape. Supporting other providers (OpenAI, Gemini, local models) is additive work behind the existing `streamMapper` interface. Well-scoped but not free.
- **Single-origin per run.** `MASTER_PLAN §6` pins Playwright to a single origin per run. A generic editor or vibe-coding variant has no "origin" concept; the security posture re-shapes around "single repo per run" or "single dataset per run."

### 7.4 Don't pivot unless

- You have a concrete design-partner or beta-user for the variant (not just intuition that the market exists).
- You've explicitly walked away from the IT-tool revenue pipeline, OR you have bandwidth to run both in parallel (unlikely solo).
- The pivot's tool-layer rewrite is scoped and costed (Phase 1 is usually 3-6 weeks of real work for any of the three variants; vibe-coding is the longest due to LSP + code indexing).

---

## 8. Pivot-decision one-pager template

When considering a pivot, fill this out before writing any code. Same RFC discipline as the `week2c-react-plan` gate.

```
Variant:              [Generic Editor | LLM Training Tool | Vibe Coding Tool]

Target audience:      [who buys this and why]

Design partner(s)
committed:            [names, or "none yet"]

Tool-layer scope:     [which tool modules get written; estimated LoC]

Orchestration chain
body swap scope:      [which step bodies change; estimated LoC]

Skill-card library:   [authored by whom, on what timeline]

Verbage pass:         [complete copy-audit plan; typically 1-2 days]

Forensic fingerprints
to retire:            [any of the 4 that no longer apply]

New forensic
fingerprints expected: [anticipated failure modes]

Primitives changes:   [MUST be "none" for this to qualify as a platform pivot
                       vs. a ground-up rebuild]

Envelope changes:     [additive only; any modification = rebuild, not pivot]

Revert path:          [git reset --hard PLATFORM_PIVOT_POINT]

Rollback criterion:   [what would make you abandon the pivot]

Recommendation:       [pivot / stay / dual-track]
```

---

## 9. Appendix — mapping from this doc to existing artifacts

| This doc's concept | Where it's codified today |
|---|---|
| Five layers | `docs/Architecture.txt §1` |
| Substrate invariants (§3) | `docs/Architecture.txt §11` (the 6 hard invariants) |
| CTX SPREAD INVARIANT | `services/agent/src/mastra/runContext.ts` docblock |
| Three-commit cadence + smoke discipline | `docs/STARTUP_PROCESS.md §1.5-1.6` + handoff briefing Meta-observations |
| Forensic SQL fingerprints (the 4 bugs) | `docs/MASTER_PLAN.md §"7b.iii.b series — forensic audit + causal narrative"` |
| Envelope schema (the frame types carrying across variants) | `services/agent/src/events/envelope.ts` |
| Reviewer UI substrate (ChatBar + feed + meta-loops) | `services/test-webapp/app/agent/review/[runId]/page.tsx` post-Week-2a |
| 9-step workflow (the chain shape each variant populates differently) | `services/agent/src/mastra/workflows/triage.ts` |

This doc does not duplicate any of the above — it reframes them through a pivot-planning lens so a future decision-maker has a map instead of a library.

---

## 10. Maintenance notes

- **When to update this doc:** only when (a) a new layer or invariant emerges that wasn't here, (b) a pivot is actively proposed and this doc informs the decision (update the relevant §5 narrative with findings), or (c) a pivot is executed and this doc needs a "POST-PIVOT" section retiring the abandoned variant.
- **When NOT to update this doc:** every time a new feature lands in the current IT tool. That goes in `MASTER_PLAN.md`.
- **Owner:** whoever is currently driving product strategy. Review annually or at every pivot-decision point, whichever is sooner.
