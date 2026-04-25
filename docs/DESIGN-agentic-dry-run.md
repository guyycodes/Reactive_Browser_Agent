# DESIGN — Agentic Dry-Run + Materialized Skill Cards (week2d)

**Status**: Design-phase RFC (Part 0). No code in this document.

**Scope**: Architectural pivot from skill-card-driven `runDryRunStep` + skill-card-driven `runExecuteStep` (week2b-runtime) to **agentic exploration dry-run with ephemeral skill-card materialization**. Verify is redesigned as structured postcondition comparison (no ReAct).

**Prerequisites**: week2c-react-classify committed (ReAct primitive validated on cognitive steps). Reader should be familiar with `Architecture.txt §5` (ReAct pattern), `§9.5` (apply-ReAct-to-existing-step recipe), and `services/agent/src/mastra/runContext.ts` (CTX SPREAD INVARIANT).

**Non-goals**: see §12.

---

## 1. Executive summary

Today's `runDryRunStep` deterministically walks a pre-authored skill card's non-destructive prefix (`preflight: true`). `runExecuteStep` deterministically walks the full skill card. `runVerifyStep` runs a one-shot Sonnet check with a `/verified/i` regex test (the hallucination surface).

**The pivot**: reframe pre-authored skill cards from **runtime walkers** to **safety scaffolds + planning artifacts**. `dry_run` becomes an agentic ReAct loop that explores freely with browser tools, honoring the scaffold's destructive boundary. On approve, a new `materialize_skill_card` step converts the agent's actual action trace into an ephemeral `Skill` object. `execute` deterministically walks that ephemeral card. `verify` runs a structured comparison of execute's observed state against the ephemeral card's postconditions (no ReAct).

**Why this is the right shape**:
- ReAct belongs where **exploration is the task** (dry_run), not where **confirmation is the task** (verify).
- The divergence between scaffold (what we expected) and materialized card (what the agent actually did) IS the auditability signal the reviewer evaluates at `review_gate`.
- Pre-authored skill cards retain all their architectural value (intent shape, destructive boundaries, postcondition declarations) without the brittleness of strict walker semantics against evolving UIs.

---

## 2. The core reframing — SKILL CARDS: SCAFFOLD vs ARTIFACT

This is a conceptual primitive on par with `CTX SPREAD INVARIANT`. Future onboarding material in `Architecture.txt §12` will codify it.

| Role | Source | When read | When written | Authoritative for |
|---|---|---|---|---|
| **SCAFFOLD** | `kb/skill_cards/<app>/<skill>.yml` (pre-authored, versioned with code) | `plan` step — picks a scaffold matching the classified intent | Authored by humans / design-partner pilots | Destructive boundaries + declared inputs + expected postconditions + intent shape |
| **ARTIFACT** | `RunContext.tempSkillCard` (in-memory, per-run) | `execute`, `verify`, `review_gate`'s reviewer UI | `materialize_skill_card` step, from agent's dry_run action trace | What was ACTUALLY done; deterministic execute walker; postcondition basis |

Divergence between the two is the **auditability signal**. The reviewer gate renders both side-by-side; significant divergence prompts `reject` / `edit-refine` instead of `approve`.

**What STAYS from week2b-runtime**:
- Skill-card schema (`src/schemas/skill-card.ts`) — unchanged; temp cards conform to the same Zod schema.
- `loadSkill()` + `loadAllSkills()` — used by plan for scaffold selection.
- `executeSkillCardSteps(... preflight: false)` — used by `execute` to walk the temp card.
- `kb/skill_cards/test-webapp/*.yml` — become scaffolds. Still validated by `validate:skill-cards`, still embedded to RAG by `embed:skill-cards`.

**What CHANGES from week2b-runtime**:
- `executeSkillCardSteps(... preflight: true)` in `runDryRunStep` — removed. Replaced by ReAct loop.
- `runDryRunStep`'s body — rewritten as a `createReActStep` invocation.
- `runVerifyStep`'s body — rewritten as structured comparison (no ReAct, no `/verified/i` regex).
- New step `materialize_skill_card` between `review_gate` (approve path) and `executeStep`.
- New field `RunContext.tempSkillCard?: Skill`.
- New fields `PlanSchema.inputs: Record<string, string>` + `DryRunSchema.actionTrace: DryRunAction[]`.

---

## 3. Architecture — new workflow shape

### 3.1 Workflow chain

```
┌─────────────────────────────────────── Block 1 (cognitive) ──────────────────────────────────────┐
│                                                                                                   │
│    classify [ReAct]  →  retrieve [ReAct]  →  plan [one-shot]  →  dry_run [ReAct: AGENTIC]        │
│                                                                                                   │
│    classify ReAct decides category (optionally via retrieveCategoryHints)                         │
│    retrieve ReAct decides which runbooks/skill-card SCAFFOLDS match intent                        │
│    plan one-shot emits {skillCardIds[scaffold], inputs, outlineSteps}                             │
│    dry_run ReAct AGENTIC explores the target app with browser tools                               │
│                      observes DOM, honors scaffold's destructive boundary,                        │
│                      emits boundary_reached tool call at the destructive step                     │
│                      produces actionTrace[] — the sequence of browser ops it took                 │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                                ╔═══════════════════════════════════╗
                                ║  review_gate (PRE-EXEC GATE)      ║
                                ║  reviewer sees:                   ║
                                ║    - scaffold (expected)          ║
                                ║    - actionTrace (actual)         ║
                                ║    - boundary_reached target      ║
                                ║    - divergence highlighted       ║
                                ║  4-decision: approve/reject/edit/terminate   ║
                                ╚═══════════════════════════════════╝
                                                │ approve
                                                ▼
                        ┌───────────────────────────────────────────┐
                        │ materialize_skill_card (NEW STEP)         │
                        │                                           │
                        │ Input:  DryRunSchema (actionTrace + plan) │
                        │         PlanSchema.inputs                 │
                        │         SCAFFOLD (loaded from plan.skillCardIds[0]) │
                        │                                           │
                        │ Output: MaterializeSchema                 │
                        │         { skill: Skill,                   │
                        │           divergence?: { expected,        │
                        │                         actual,           │
                        │                         reason? } }       │
                        │                                           │
                        │ Writes ctx.tempSkillCard = skill          │
                        └───────────────────────────────────────────┘
                                                │
                                                ▼
                                ┌────────────────────────────┐
                                │ executeStep                │
                                │  walks ctx.tempSkillCard   │
                                │  via executeSkillCardSteps │
                                │  (preflight: false)        │
                                └────────────────────────────┘
                                                │
                                                ▼
                                ┌────────────────────────────┐
                                │ verifyStep (REDESIGNED)    │
                                │  structured comparison:    │
                                │   - if stepsRun===0 +      │
                                │     !skipped → hard-fail   │
                                │   - LLM-judge on:          │
                                │      postconditions[] from │
                                │        ctx.tempSkillCard   │
                                │      final DOM snapshot    │
                                │   - produces VerifySchema  │
                                │     {success, evidence[]}  │
                                └────────────────────────────┘
                                                │
                                                ▼
                                ╔═══════════════════════════════════╗
                                ║ human_verify_gate (POST-EXEC)     ║
                                ║  4-decision as today              ║
                                ╚═══════════════════════════════════╝
                                                │
                                                ▼
                                          logAndNotifyStep
```

### 3.2 What's the difference from today?

| Step | Today (week2b-runtime) | New (week2d) |
|---|---|---|
| `dry_run` | Skill-card walker with `preflight: true` | **ReAct AGENTIC** with browser tools + `boundary_reached` |
| `review_gate` | Renders plan + scaffold | Renders plan + scaffold + actionTrace + divergence |
| (new) `materialize_skill_card` | — | Agent trace → ephemeral `Skill` in `ctx.tempSkillCard` |
| `execute` | Loads pre-authored skill from disk via `loadSkill()` | Reads `ctx.tempSkillCard` (in-memory) |
| `verify` | One-shot Sonnet `/verified/i` regex test | Hard-fail guard + structured LLM-judge on postconditions[] |

---

## 4. Sequence diagram — happy path

Reset-password ticket for Jane, no scaffold/UI divergence:

```
Reviewer → POST /triage
         │
         ▼
    classify ReAct
       │ → output: {category: "account_management", urgency: "high",
       │           targetApps: ["test-webapp"], confidence: 0.92}
       ▼
    retrieve ReAct
       │ → output: {runbookHits: 3, skillHits: 5, hits: {...}}
       ▼
    plan (one-shot Sonnet + thinking)
       │ → output: {
       │     planId: "...",
       │     skillCardIds: ["reset_password"],          ← scaffold selection
       │     inputs: { email: "jane@example.com" },    ← NEW: extracted from ticket
       │     outlineSteps: ["Sign in as admin", ...],
       │     destructive: true,
       │     actions: [...],
       │   }
       ▼
    dry_run ReAct AGENTIC  (maxIterations: 15)
       │ scaffold = loadSkill("reset_password")
       │ Sonnet sees: ticket + scaffold.steps (as a HINT) + browser tools registry
       │
       │ iter 0: navigate /login
       │ iter 1: fillForm {Email: "jane@example.com", Password: "demo"}
       │ iter 2: click "Sign in"
       │ iter 3: snapshot (verify signed in → /users)
       │ iter 4: fillForm {Search: "jane"}
       │ iter 5: click "Search" button
       │ iter 6: click "jane@example.com link" (view row)
       │ iter 7: click "Reset password link"
       │ iter 8: click "I confirm checkbox"
       │ iter 9: boundary_reached { element: "Reset password button",
       │                            reason: "Destructive — this click resets Jane's password",
       │                            scaffoldMatch: true }
       │       → ReAct loop terminates; dry_run returns
       │
       │ output: DryRunSchema {
       │   domMatches: true,          ← boundary_reached fired; no anomalies
       │   anomalies: [],
       │   actionTrace: [
       │     { tool: "navigate", args: {url: "/login"} },
       │     { tool: "fillForm", args: {fields: [{name:"Email",value:"jane@example.com"}, ...]} },
       │     { tool: "click",    args: {element: "Sign in"} },
       │     { tool: "snapshot", args: {} },
       │     ... (9 steps) ...
       │     { tool: "click",    args: {element: "Reset password button"}, destructive: true },
       │   ],
       │   boundaryReached: { element: "Reset password button", scaffoldMatch: true },
       │   plan: PlanSchema,
       │ }
       ▼
    review_gate
       │ Reviewer UI shows:
       │   - Scaffold (reset_password.yml): 11 steps, destructive at step 9
       │   - ActionTrace: 9 non-destructive + 1 destructive = 10 steps
       │   - boundary_reached.scaffoldMatch: true  → no divergence banner
       │   - 4-decision (approve/reject/edit/terminate)
       │ Reviewer clicks APPROVE
       ▼
    materialize_skill_card
       │ Input: dry_run.actionTrace + plan.inputs + scaffold (from plan.skillCardIds[0])
       │
       │ Template substitution:
       │   for each actionTrace entry:
       │     for each string-valued arg:
       │       if arg value matches plan.inputs["email"] → replace with "{{ inputs.email }}"
       │
       │ Materialized Skill:
       │   name: "reset_password_materialized"   ← derived from scaffold.name + "_materialized"
       │   destructive: true                      ← from plan.destructive
       │   inputs:
       │     email: { type: "email", required: true }   ← derived from plan.inputs keys
       │   preconditions: [scaffold.preconditions]       ← inherited from scaffold
       │   postconditions: [scaffold.postconditions]     ← inherited from scaffold
       │   steps: [ ... materialized from actionTrace with template substitution ... ]
       │
       │ output: MaterializeSchema {
       │   skill: Skill,
       │   divergence: null,           ← scaffoldMatch was true
       │ }
       │
       │ Side effect: ctx.tempSkillCard = skill
       ▼
    executeStep
       │ session = ctx.browser (via liveness probe from week2b-runtime — unchanged)
       │ executeSkillCardSteps(ctx.tempSkillCard, {
       │   preflight: false,
       │   resumeAtFirstDestructive: true,    ← session-reuse (week2b-runtime)
       │   session,
       │   baseUrl: <from plan or env>,
       │   ctx: { inputs: plan.inputs }
       │ })
       │ → stepsRun: 2 (destructive click + implicit takeScreenshot)
       ▼
    verifyStep (redesigned)
       │ if stepsRun === 0 && !skipped → hard-fail (polish-queue #2)
       │ else:
       │   postconditions = ctx.tempSkillCard.postconditions
       │   finalSnapshot = (await ctx.browser.snapshot()).text
       │   prompt = "Given postconditions: [...], final DOM: <text>,
       │             return JSON {success: boolean, evidence: string[]}"
       │   result = streamMessage({... single call ...})
       │   parsed = tryParseJson(result.text)
       │   return { success: parsed.success, evidence: parsed.evidence, ... }
       ▼
    human_verify_gate → approve → logAndNotifyStep → run.completed { status: ok }
```

> **Backtrack-loop note.** On post-exec REJECT (backtrack), `humanVerifyGateStep`'s
> direct-invocation loop re-runs the full pre-notify chain with carried observations.
> Under week2d that chain expands to include `runMaterializeSkillCardStep` between
> `runReviewGateStep` and `runExecuteStep` — each backtrack iteration produces a fresh
> `actionTrace` → fresh materialize → fresh `ctx.tempSkillCard` → fresh execute walk.
> Wiring detail in §7 Part 3.

## 4.1 Sequence diagram — divergence path

Agent finds "Update credentials" button where scaffold expected "Reset password button":

```
    dry_run ReAct AGENTIC
       │ ... iter 0-8 same as happy path ...
       │ iter 9: snapshot — looks for "Reset password button" per scaffold
       │       → NOT FOUND. Agent sees "Update credentials" in the same slot.
       │ iter 10: boundary_reached {
       │     element: "Update credentials button",
       │     reason: "This button's position + icon match the destructive step
       │              the scaffold expected at 'Reset password button'. UI has been updated.",
       │     scaffoldMatch: false   ← DIVERGENCE FLAG
       │   }
       ▼
    review_gate
       │ Reviewer UI shows DIVERGENCE BANNER (warn-yellow):
       │   "Agent found 'Update credentials' where scaffold expected
       │    'Reset password button'. Verify the action is equivalent."
       │ Reviewer can:
       │   (a) APPROVE — accepts agent's finding; materialize uses "Update credentials"
       │   (b) EDIT-REFINE — note: "UI name is 'Update credentials'" feeds back; Block 1 re-runs
       │   (c) REJECT → refine without note
       │   (d) TERMINATE → skip-cascade
       ▼

Note: EDIT-REFINE and REJECT here use the EXISTING Week-2a refine-loop
mechanism (reviewer's note → `runBlock1(..., { seedObservations: [...] })`);
no new pathway. Block 1's refine loop is divergence-agnostic — it just
re-runs with the note. Whether the refined dry_run produces divergence
again depends on what the agent finds on the next exploration. Same cap
applies: `MAX_PRE_GATE_REFINES = 2` (shared edit+reject budget).

    (on approve) materialize_skill_card
       │ divergence: {
       │   expected: "Reset password button",    ← from scaffold
       │   actual: "Update credentials button",  ← from boundary_reached
       │   reason: "UI has been updated.",
       │ }
       │ Materialized skill uses "Update credentials button" for the destructive step.
       │ divergence is emitted in step.completed.output for audit trail.
       ▼
    ... execute + verify ... (unchanged)
```

## 4.2 Sequence diagram — graceful exhaustion

Agent hits `DRY_RUN_MAX_ITERATIONS` (15) without emitting `boundary_reached`:

```
    dry_run ReAct AGENTIC
       │ iter 0-14: 15 iterations elapsed; agent still exploring, no boundary_reached
       │ runDryRunStep observes iteration cap hit
       │
       │ output: DryRunSchema {
       │   domMatches: false,
       │   anomalies: ["Exhausted 15 iterations without identifying a destructive boundary"],
       │   actionTrace: [...14 partial entries...],
       │   boundaryReached: null,
       │   plan: PlanSchema,
       │ }
       ▼
    review_gate
       │ UI shows: exhaustion banner; actionTrace (partial); anomalies
       │ Reviewer can:
       │   (b) EDIT-REFINE — reviewer adds note like "the Reset button is in the
       │                     ⋮ overflow menu on this app", Block 1 re-runs
       │   (c) REJECT — directive refine: "try a different exploration approach"
       │   (d) TERMINATE
       │ APPROVE is blocked because the destructive step is not in actionTrace
       │ (no execute possible without a terminal destructive step)
```

---

## 5. Schema changes

### 5.1 `PlanSchema` — add `inputs` field

```typescript
// Today (week2b-runtime)
PlanSchema {
  planId: string;
  actionCount: number;
  destructive: boolean;
  skillCardIds: string[];
  planText: string;
  thinking: string;                 // "" since 7b.iii.b-4
  classification: ClassificationSchema;
  actions: PlanActionSchema[];
  requiresContext: boolean;
  missingContext?: string[];
}

// New (week2d)
PlanSchema {
  // ...all existing fields preserved...
  inputs: Record<string, string>;   // NEW: extracted from ticket, drives materializer templating
}
```

**Plan step responsibility change**: extract template-substitution keys from the ticket + name them against the selected scaffold's `SkillSchema.inputs` declaration. Plan's LLM prompt is updated to include "emit `inputs` field with the ticket-derived values that map to the scaffold's declared inputs."

Extraction rules (plan's prompt guidance):
- Scaffold declares `inputs: { email: {...}, ticket_id: {...} }`
- Plan scans ticket subject + body + submittedBy for email-shaped strings, UUID-shaped ticket IDs, etc.
- First-match-wins. On ambiguity, the LLM picks.
- Absent-but-required inputs → `plan.requiresContext = true` (existing escape hatch); scaffold's declared-required-but-not-found becomes a `missingContext` entry.

### 5.2 `DryRunSchema` — add `actionTrace` + `boundaryReached`

```typescript
// Today
DryRunSchema {
  domMatches: boolean;
  anomalies: string[];
  plan: PlanSchema;
  blockResult?: BlockResultSchema;
}

// New
DryRunSchema {
  // ...all existing fields preserved...
  actionTrace: DryRunAction[];            // NEW: sequence of agent browser ops
  boundaryReached: BoundaryReached | null; // NEW: the identified destructive step (or null on exhaust)
}

DryRunAction {
  tool: "navigate" | "snapshot" | "click" | "fillForm" | "takeScreenshot";
  args: Record<string, unknown>;        // raw args as passed to the tool
  destructive?: boolean;                 // only set on the boundaryReached entry (true)
  screenshotPath?: string;               // for click/fillForm post-action screenshots
}

BoundaryReached {
  element: string;                       // agent's name for the destructive element
  reason: string;                        // agent's explanation
  scaffoldMatch: boolean;                // did this match the scaffold's declared destructive step?
  iteration: number;                     // which ReAct iteration emitted it
}
```

### 5.3 `MaterializeSchema` (NEW)

```typescript
MaterializeSchema {
  skill: Skill;                          // the ephemeral card — conforms to SkillSchema
  divergence: Divergence | null;
  dryRun: DryRunSchema;                  // forward for execute + downstream audit
}

Divergence {
  expected: string;                      // scaffold's destructive step element name
  actual: string;                        // boundary_reached.element
  reason: string;                        // boundary_reached.reason
}
```

### 5.4 `RunContext.tempSkillCard` (NEW field)

```typescript
RunContext {
  runId: string;
  bus: EventBus;
  browser?: BrowserSession;
  ticket?: { ... };
  priorObservations?: string[];
  tempSkillCard?: Skill;                 // NEW: written once by materialize_skill_card,
                                          //      read by execute + verify downstream
}
```

### 5.5 `ExecuteSchema` — unchanged

Execute continues to emit `{ stepsRun, skipped, review }`. What changes is its INPUT source: reads `ctx.tempSkillCard` instead of `loadSkill(inputData.dryRun.plan.skillCardIds[0])`.

### 5.6 `VerifySchema` — unchanged

Verify continues to emit `{ success, skipped, evidence, execute }`. What changes is its internals: no `/verified/i` regex; instead, structured LLM-judge prompt comparing execute's state against `ctx.tempSkillCard.postconditions`.

### 5.7 `SkillSchema` — unchanged

Temp cards conform to the existing schema. Validated at materialize_skill_card via the existing Zod schema.

---

## 6. New envelope variants — NONE

Per Concern 1 resolution: browser tool observation summaries flow through **existing** frames:
- `browser.screenshot` frames carry screenshot paths (week1B)
- `react.iteration.completed.observationSummary` carries DOM excerpts (week2b-foundation + verbosity)
- `tool.started` / `tool.completed` / `tool.failed` from BrowserSession wrapper (existing)
- `boundary_reached` is a `react.iteration.completed` with `toolUsed: "boundary_reached"` + specific `observationSummary` shape — no new variant needed

No envelope schema changes in any part. `envelope.test.ts` doesn't need modification.

---

## 7. Implementation plan — 5 parts

### Part 0 — this design RFC (current)
Docs-only. Lands as `docs/DESIGN-agentic-dry-run.md` + MASTER_PLAN progress-table row "Week 2d — Agentic dry-run (design locked)."

### Part 1 — Browser ReactTools registry
**New file**: `services/agent/src/mastra/tools/reactBrowserTools.ts` — wraps each `BrowserSession` method as a `ReactTool` with schema, validator, invoke, summarize.

**Registry shape** (5 browser tools + 1 boundary signal):

| Tool name (Anthropic) | Business frame name | Wraps |
|---|---|---|
| `browser_navigate` | `browser.nav` | `session.navigate(url)` |
| `browser_snapshot` | `browser.snapshot` (existing) | `session.snapshot()` |
| `browser_click` | `browser.click` (via session wrapper) | `session.click({element, ref})` |
| `browser_fillForm` | `browser.fill_form` (via session wrapper) | `session.fillForm(fields[])` |
| `browser_takeScreenshot` | `browser.screenshot` (existing) | `session.takeScreenshot(label)` |
| `boundary_reached` | (synthetic — no existing frame) | no-op; records termination signal |

**Augmented summarize shape for stateful tools** (Concern 1):

For `click` / `fillForm`:
```typescript
// return value from invoke:
{
  element: string,                // the element acted on
  postSnapshotExcerpt: string,    // first 3 meaningful lines of post-action snapshot
  screenshotPath: string,         // path returned from implicit post-action takeScreenshot
}

// summarize:
summarize: (output) => {
  const { element, postSnapshotExcerpt, screenshotPath } = output;
  return `clicked/filled ${element}. DOM now shows:\n${postSnapshotExcerpt.slice(0, 240)}…\n(screenshot: ${screenshotPath.split("/").pop()})`;
}
```

For read-only tools (`navigate`, `snapshot`, `takeScreenshot`): summarize returns just the snapshot excerpt or "navigated to <url>" / "captured screenshot <label>".

**`boundary_reached` tool**:
```typescript
{
  name: "boundary_reached",
  description:
    "Call this tool the moment you identify the destructive step that would mutate server state " +
    "(e.g., the final 'Reset password' confirm button). Do NOT click the destructive element. " +
    "After this call, dry_run completes and review_gate opens for human approval.",
  inputSchema: {
    element: { type: "string", description: "The element name/ref as it appears on today's UI." },
    reason: { type: "string", description: "Why you believe this is destructive." },
    scaffoldMatch: { type: "boolean", description: "Does this match the scaffold's declared destructive step? Optional — omit if unsure." }
  },
  validator: BoundaryReachedInputSchema,
  invoke: async (input, ctx) => {
    // no-op — the runner observes the tool call and terminates the loop
    return { acknowledged: true, ...input };
  },
  summarize: (output) => `boundary_reached: ${output.element} (scaffoldMatch: ${output.scaffoldMatch})`
}
```

The runner needs a small addition: if `toolUse.name === "boundary_reached"`, after invoking, set a "terminate after this iteration" flag. Runner checks the flag in the next-iteration decision.

**Tests** (new file `test/reactBrowserTools.test.ts`):
- Each tool's invoke dispatches correctly via a stub session
- Augmented summarize shape for stateful tools
- `boundary_reached` invoke returns acknowledged + preserves input
- stepId attribution on frames (hotfix-1 non-regression — frames tag to ctx.stepId)

**Scope**: ~150 LoC production + ~200 LoC tests. No change to `runDryRunStep` yet — registry lands in isolation.

### Part 2 — `runDryRunStep` rewrite + schema extension
**File**: `triage.ts`.

- `runDryRunStep` rewritten as a `createReActStep` invocation consuming Part 1's browser registry.
- `dryRunStepConfig: CreateReActStepArgs<...>` with:
  - `tier: "sonnet"`
  - `thinkingEnabled: false`
  - `maxIterations: env.DRY_RUN_MAX_ITERATIONS ?? 15`
  - tools: Part 1's registry
  - `buildSystem`: action-verb prompt describing the agent's role + scaffold reference + destructive-boundary semantic + `boundary_reached` usage
  - `buildUserMessage`: ticket + plan.inputs + scaffold.steps (as hint, not spec)
  - `produceOutput`: aggregate iterations → `DryRunSchema` with actionTrace + boundaryReached
- Runner terminates on `boundary_reached` tool call OR iteration cap.
- Graceful exhaustion path on cap-without-boundary: returns `domMatches: false` + anomaly + actionTrace (partial) + `boundaryReached: null`.

**`DryRunSchema` changes** per §5.2.

**Tests** (new `test/dryRunReact.test.ts`):
- Happy path: stub agent emits boundary_reached on iter N → actionTrace populated correctly
- Divergence path: boundary_reached with scaffoldMatch: false → DryRunSchema preserves it
- Exhaustion: 15 iterations without boundary → anomaly populated
- stepId attribution: browser tool frames tag to step_id=dry_run

**Scope**: ~200 LoC production + ~300 LoC tests. Execute + verify still use today's paths (not yet wired to Part 2's output). Live-smokable in isolation via dedicated endpoint OR by temporarily teeing the actionTrace into logs.

### Part 3 — `materialize_skill_card` + `plan.inputs` + execute switch + verify redesign

**New step in triage.ts**:
- `materializeSkillCardStep = createStep({ id: "materialize_skill_card", ... })`
- `runMaterializeSkillCardStep(inputData: DryRunSchema)` → `MaterializeSchema`
- Body: load scaffold, walk dry_run.actionTrace, apply plan.inputs templating, construct Skill object, detect divergence, write `ctx.tempSkillCard = skill`, return MaterializeSchema.

**Plan step update**:
- `PlanSchema.inputs` added (§5.1).
- `runPlanStep` prompt updated to emit inputs field; `planOutputParser` updated to accept + validate it.

**Execute step update**:
- `runExecuteStep` reads `ctx.tempSkillCard` instead of `loadSkill(plan.skillCardIds[0])`.
- If `ctx.tempSkillCard === undefined` at entry → defensive log + skipped return. Should never happen (materialize always runs before execute on approve path) — but guards against a future upstream refactor.
- Liveness-probe + three-branch session dispatch UNCHANGED from week2b-runtime.

**Verify step redesign** per §4:
- Hard-fail guard on stepsRun===0 && !skipped (polish-queue #2 fold).
- If passes guard: read `ctx.tempSkillCard.postconditions`, take final snapshot, single structured LLM call `{postconditions, final_dom} → {success, evidence[]}`, parse JSON, return VerifySchema.
- NO ReAct. NO `/verified/i` regex.

**Workflow chain update**:
- Insert `materializeSkillCardStep` between `reviewGateStep` and `executeStep` in the Mastra `.then(...)` chain.
- Also plumb `runMaterializeSkillCardStep` into `humanVerifyGateStep`'s backtrack loop body between `runReviewGateStep` and `runExecuteStep`. The backtrack loop bypasses Mastra's engine and direct-invokes the step bodies (per the 7b.iii.b series), so the insertion is a direct code edit at `triage.ts`'s backtrack-loop site, not just a chain-declaration change. Each backtrack iteration must produce a fresh `ctx.tempSkillCard` before `runExecuteStep` reads it.
- Mirror the same sequence into `runReviewGateStep`'s pre-exec refine loop if it re-invokes executeStep directly (it does NOT today — refine loop only re-runs Block 1, then re-opens the gate. No change needed there.).

```typescript
// Indicative shape of the humanVerifyGate backtrack-loop edit (triage.ts ~L2436):
const block1Out = await runBlock1(...);
const gateOut = await runReviewGateStep(block1Out);
const materialize = await runMaterializeSkillCardStep(gateOut);  // ← NEW
const exec = await runExecuteStep(materialize);
const verify = await runVerifyStep(exec);
```

**Tests**:
- `test/materializeSkillCard.test.ts` (new):
  - Happy path: actionTrace → Skill with template substitution
  - Divergence: scaffoldMatch=false → divergence populated
  - Template substitution: verbatim-match values become `{{ inputs.X }}`; non-matches stay literal
- `test/verifyStep.test.ts` (rewritten from the shelf-drafted ReAct version):
  - Hard-fail guard path
  - Skipped cascade path
  - Structured LLM-judge path: stub streamMessage returns JSON → parsed correctly
  - Postcondition-comparison failure → success=false
- `test/planStep.test.ts` (update):
  - New test: plan extracts inputs from ticket correctly

**Scope**: ~350 LoC production + ~400 LoC tests across 3 files.

### Part 4 — Reviewer UI divergence rendering (optional within week2d, or spilled to week2e)

- LEFT column `.review-outcomes-col` gets a `<MaterializeOutcome>` row for the new step.
- RIGHT column `<BehaviorFeed>` renders divergence banner on materialize_skill_card.step.completed frames where divergence is not null.
- `ChatBar` pre-exec variant gets a "divergence detected" chip above the buttons when plan.scaffoldMatch === false or materialize.divergence !== null.
- **Exhaustion-path Approve disablement**: `ChatBar`'s `canDecide` memo disables Approve when `pendingReview.dryRunSchema.boundaryReached === null` (graceful-exhaustion path from §4.2). Mirrors the existing Week-1B `blockResult.passedLast === false` exhausted-banner pattern that already disables Approve — same UI surface, new trigger condition. Reviewer keeps Reject / Terminate available; Edit remains available (can refine with reviewer's UI-drift hint). New testid `chat-bar-exhausted-banner` reuses existing pattern; banner copy branches between "Block 1 exhausted (3 passes)" and "Dry-run exhausted (15 iterations without identifying destructive boundary)".

**Scope**: ~100 LoC across `page.tsx` + `globals.css`. Could spill to week2e UI-polish bundle.

### Part 5 — week2d-docs-sync (after smoke)

- `Architecture.txt §12` new section: "SKILL CARDS — SCAFFOLD vs ARTIFACT" (conceptual primitive callout).
- `Architecture.txt §3` workflow diagram update to show materialize_skill_card.
- `docs/PLATFORM_PIVOTS.md` update — skill-card role reframing implications for pivots.
- `docs/MASTER_PLAN.md` progress-table row per Part.
- `docs/MASTER_PLAN.md` polish-queue updates: close #2 (verifyStep hard-fail folded in Part 3); update #23 description (typed postconditions as polish, per Concern 4 resolution).
- `docs/ARCHITECTURE.md §2.1` workflow reality update.
- **Step-count terminology sweep**: search-and-replace `9-step workflow` → `10-step workflow` across `docs/ARCHITECTURE.md`, `docs/Architecture.txt`, `docs/MASTER_PLAN.md`, `docs/STARTUP_PROCESS.md`, `docs/PLATFORM_PIVOTS.md`, and any in-code docblocks. Each doc's workflow diagram gets a short note explaining the `materialize_skill_card` insertion point + its SCAFFOLD vs ARTIFACT role so readers land on the conceptual primitive from every entrypoint. Grep recipe for the docs-sync commit: `rg '9-step' docs/ services/`.

---

## 8. Tests strategy

### Coverage targets

| Part | New test files | Test count delta | Notes |
|---|---|---|---|
| 1 | `reactBrowserTools.test.ts` | +15-20 | One test per tool + augmented summarize + boundary_reached |
| 2 | `dryRunReact.test.ts` | +10-15 | Happy / divergence / exhaustion / stepId attribution |
| 3 | `materializeSkillCard.test.ts` (new) + `verifyStep.test.ts` (rewritten from shelf) + `planStep.test.ts` (updates) | +15-20 | Template subst / divergence / verify structured / plan.inputs |
| 4 | (UI — no unit tests per week2a precedent; live smoke only) | 0 | |

**Total expected**: 183 → ~230 after all parts land. tsc 0 errors maintained throughout.

### Regression guards

- stepId attribution (hotfix-1 carry-forward): all new tool dispatches in Part 1 must tag to `ctx.stepId`
- CTX SPREAD INVARIANT: `tempSkillCard` classification documented in `runContext.ts` after Part 3
- 4 forensic fingerprints = 0 across all live smokes
- Jane DB mutation cross-check on P1 (unchanged — authoritative signal)

### What does NOT need a test

- The reviewer UI divergence banner (live smoke + screenshot acceptance per week2a precedent)
- BrowserSession's existing methods (already covered by `playwrightMcp.test.ts`)
- runExecuteStep's session liveness probe (already covered by week2b-runtime; unchanged semantic)

---

## 9. Smoke plan

Each Part has a smoke gate. Parts 1 + 2 can smoke in isolation (teed output). Parts 3 onward require full-stack smoke.

### Part 1 smoke (browser tools registry)
- `npm run check` green
- Smoke is unit-tests-only (Part 1 has no consumer yet)

### Part 2 smoke (dry_run ReAct)
- Full P1 smoke (POST /triage + approve pre-exec) — focus on dry_run behavior
- Reviewer verifies:
  - Dry_run emits `react.iteration.*` frames for each browser action
  - `boundary_reached` fires at the expected step
  - `actionTrace` in DryRunSchema has N entries matching the visual flow
  - Screenshot paths resolve (feed thumbnails render)
- Non-regression: execute + verify still walk today's path (not yet wired to Part 2); run still completes status=ok

### Part 3 smoke (materialize + execute switch + verify redesign)
- Full P1/P2/P3/P4 smoke battery
- P1 (approve-only): ctx.tempSkillCard populated; execute walks it; verify passes structured check; Jane DB mutates; 4/4 forensics=0
- P2 (pre-exec edit refine): refine loop feeds reviewer note back; Block 1 re-runs; materialize runs on the new dry_run trace
- P3 (post-exec reject backtrack): backtrack loop; materialize re-runs each time
- P4 (pre-exec terminate): skip-cascade; materialize does NOT run (terminate short-circuits the approve path); verify returns skipped

### Part 4 smoke (UI — live only)
- Divergence scenario reproducible via a pre-authored skill card with intentional UI-name drift
- Reviewer UI renders divergence banner; approve → materialize captures divergence field in output

---

## 10. CTX SPREAD INVARIANT audit for `tempSkillCard`

Per Concern 3 resolution — add this entry to `runContext.ts` docblock after Part 3 lands:

```
Field mutability classification (updated post-week2d):
  Read-only-safe to spread:
    runId, bus, ticket, priorObservations, tempSkillCard.
  DO NOT spread around:
    browser (set by runDryRunStep at triage.ts:NNNN,
             consumed by runExecuteStep + runMaterializeSkillCardStep
             — same spread-mutation-loss hazard as week1B).

Lifecycle:
  - tempSkillCard is WRITTEN ONCE by runMaterializeSkillCardStep
  - READ by runExecuteStep (walks steps[])
  - READ by runVerifyStep (reads postconditions[])
  - NEVER re-written after materialize completes
  - Cleared at run end via withRunContext scope teardown

Refine-loop audit: the pre-exec refine loop runs within Block 1
(classify → retrieve → plan → dry_run). Materialize happens AFTER
review_gate. Therefore NO `withRunContext({ ...ctx, ... })` spread
wraps runExecuteStep or runVerifyStep's read of tempSkillCard.
Safe to classify as read-only-safe.
```

---

## 11. Non-goals (explicit)

The following are **NOT** in week2d scope. Mis-attributing them to this design would inflate the RFC and break cadence.

1. **Auto-scaffold-generation from repeat materializations.** If we see 100 `reset_password` runs with similar materialized shapes, we COULD cluster + emit a new scaffold. This is a week3+ evolution; the manual-author-scaffold path is fine for week2d.
2. **Typed postcondition schema.** Per Concern 4: text postconditions + LLM-judge in v1. Typed `{kind: "dom_contains", ...}` variants are polish-queue #23.
3. **Plan-step ReAct.** Plan stays one-shot — the reframing made it clear plan is a "commitment" step, not "exploration." Design-first RFC for plan ReAct is DEPRECATED; plan stays as-is architecturally.
4. **Removing `loadSkill()` / `embed-skill-cards` / the `validate-skill-cards` CLI.** Scaffolds live on disk and get embedded to RAG for plan's retrieval. The tooling stays.
5. **Live VNC `browser-viewer` iframe.** Still parked (post-Week-5 stretch per MASTER_PLAN).
6. **Multi-skill-card planning.** Plan selects ONE scaffold. Multi-scaffold composition (e.g., "unlock then reset") is week3+.
7. **`validate:skill-cards` for materialized cards.** The materialized card is validated at runtime via the Zod schema; no pre-runtime CLI check needed (and the card is ephemeral — no disk).

---

## 12. Open design details (flagged for implementation-time RFCs)

These don't block Part 0 sign-off; they'll be resolved in the Part 1/2/3 implementation RFCs with specific code shape.

1. **Plan prompt engineering for input extraction.** The prompt needs to reliably extract `{email: "jane@example.com"}` from a subject like "Reset password for jane@example.com." Expect iteration during Part 3 drafting.
2. **boundary_reached when the agent is uncertain.** If the agent sees "Save" — is it destructive or a draft save? Fallback behavior: agent emits boundary_reached with `scaffoldMatch: false, reason: "Uncertain — treating as destructive because of verbiage ambiguity"`. Reviewer makes the call.
3. **Template substitution collision handling.** What if two different inputs have the same value? (Unlikely in practice but conceivable.) First-declared wins per Q3 resolution — document this in materializer.
4. **Runner termination on boundary_reached.** Exact mechanism in reactRunner: adding a "terminate after this iteration" flag vs a side-channel observation field. Draft in Part 1 RFC. Reviewer direction (Part 0 sign-off): lean toward a general-purpose `__final?: true` return field on `ReactTool.invoke` (runner checks `result.__final === true` after invoke and flags the iteration as terminal) rather than name-specific branching on `"boundary_reached"`. Keeps the mechanism reusable for any future terminating tool (`user_intent_clarified`, etc.) without scattering name-checks in the runner. `boundary_reached.invoke` returns `{ acknowledged: true, __final: true, ...input }`.
5. **Dry_run frame feed density.** 15 iterations × ~5-6 frames per iteration = 75-90 frames per dry_run alone. UI may need a feed-noise polish pass (MASTER_PLAN polish-queue #6). Flag as risk; measure in Part 2 smoke.

---

## 13. Open questions that DO block Part 0 sign-off

**STATUS: APPROVED** — Part 0 signed off with 4 non-blocking inline clarifications folded in (see change log below). Implementation RFCs (Part 1 first) are now cleared to proceed.

**Clarification-fold change log** (post-sign-off inline updates, not new design decisions):
- §4 happy path + §7 Part 3 — explicit backtrack-loop plumbing: `runMaterializeSkillCardStep` inserted between `runReviewGateStep` and `runExecuteStep` in `humanVerifyGateStep`'s direct-invocation backtrack body. Fresh actionTrace → fresh materialize → fresh `ctx.tempSkillCard` per backtrack iteration.
- §4.1 — EDIT-REFINE / REJECT use the existing Week-2a refine-loop mechanism (`seedObservations`); Block 1 is divergence-agnostic.
- §7 Part 4 — `ChatBar.canDecide` disables Approve on graceful-exhaustion (`dryRunSchema.boundaryReached === null`), mirroring the existing `blockResult.passedLast === false` pattern. New testid `chat-bar-exhausted-banner` reused; copy branches.
- §7 Part 5 — explicit `9-step workflow` → `10-step workflow` sweep across all docs + in-code docblocks with grep recipe.
- §12 item #4 — runner termination mechanism direction: reviewer leans toward general-purpose `__final?: true` return on `ReactTool.invoke`, not name-specific branching.

All 7 Q-answers from the prior review cycle are locked:

| Q | Answer | Rationale location |
|---|---|---|
| Q1 | (b) + `boundary_reached` tool with scaffoldMatch | §3, §7 Part 1, §4.1 |
| Q2 | (ii) explicit materialize step | §3, §7 Part 3 |
| Q3 | (b) post-processed templates, plan owns inputs | §5.1, §4 happy path |
| Q4 | (i) in-memory + event-frame audit | §5.4, §10 |
| Q5 | **(b) keep pre-authored as scaffolds** | §2, entire RFC |
| Q6 | 3-commit split, no revert needed | (applier-task; resolved outside this doc) |
| Q7 | (a) unchanged + new `inputs` field | §5.1 |

All 5 concerns from the prior review are resolved:

| Concern | Resolution | Location |
|---|---|---|
| 1 — ReAct + stateful browser tools | Augmented summarize shape with DOM excerpt + screenshot path | §7 Part 1 |
| 2 — Dry_run maxIterations budget | 15 + env override + graceful exhaustion | §4.2, §7 Part 2 |
| 3 — CTX SPREAD for tempSkillCard | Read-only-safe; docblock update in Part 3 | §10 |
| 4 — Verify postcondition shape | Text + LLM-judge in v1; typed as polish-queue #23 | §7 Part 3 |
| 5 — Boundary divergence | Let-reviewer-decide via divergence field | §4.1, §5.3 |

**Sign-off required for Part 0 completion**: reviewer acknowledges all 7 Q-answers + 5 concern resolutions reflect this doc. No further design work; implementation RFC for Part 1 is next.

---

## 14. References

- `docs/Architecture.txt §5` — ReAct pattern primitive
- `docs/Architecture.txt §9.5` — Apply-ReAct recipe
- `services/agent/src/mastra/runContext.ts` — CTX SPREAD INVARIANT
- `services/agent/src/schemas/skill-card.ts` — SkillSchema (unchanged)
- `services/agent/src/mastra/lib/reactRunner.ts` — createReActStep primitive
- `services/agent/src/mastra/tools/skillCardExecutor.ts` — week2b-runtime executor (survives; used by execute)
- `services/agent/src/lib/templateEngine.ts` — template renderer (used by materializer)
- `docs/MASTER_PLAN.md` polish queue — items #2 (folded in Part 3), #23 (typed postconditions, deferred)
