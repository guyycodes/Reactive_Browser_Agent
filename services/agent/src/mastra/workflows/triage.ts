import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { streamMessage } from "../../llm/streamMapper.js";
import { getRunContext, tryGetRunContext, withRunContext } from "../runContext.js";
import { logger } from "../../logger.js";
import type { StepId } from "../../events/envelope.js";
import {
  retrieveRunbooks,
  retrieveSkills,
  retrieveCategoryHints,
  RagClientError,
  RagSchemaError,
  type RagHit,
} from "../tools/rag.js";
import {
  launchBrowser,
  type BrowserSession,
} from "../tools/playwrightMcp.js";
import { buildBrowserReactTools } from "../tools/reactBrowserTools.js";
import {
  createReActStep,
  runReActIterations,
  type CreateReActStepArgs,
} from "../lib/reactRunner.js";
import { runBlock1 } from "../lib/blockController.js";
import type { Block1Deps, Block1Result } from "../lib/blockController.js";
// Week-2b-runtime — skill-card-driven execution primitives. These
// imports live at the top (not inline) so the module's dependency graph
// is visible at a glance. `findRefByAccessibleName` + `findRefForRole`
// were extracted to `tools/domRefs.ts` in-commit; re-exported below for
// external callers (test/findRef.test.ts).
import {
  findRefByAccessibleName,
  findRefForRole,
} from "../tools/domRefs.js";
import {
  executeSkillCardSteps,
  type ExecuteSkillResult,
} from "../tools/skillCardExecutor.js";
import {
  loadSkill,
  loadAllSkills,
  SkillCardNotFoundError,
  type LoadedSkill,
} from "../../lib/skillCardLoader.js";
import { SkillSchema, type Skill, type SkillCard, type SkillInput } from "../../schemas/skill-card.js";
import type { TemplateContext } from "../../lib/templateEngine.js";
import {
  buildMaterializedSkillName,
  insertMaterializedSkill,
} from "../../db/materializedSkills.js";
// Re-export the ref helpers so test/findRef.test.ts' existing imports
// from this module keep working without an import-path churn.
export { findRefByAccessibleName, findRefForRole };

/**
 * The 8-step triage-and-execute workflow (MASTER_PLAN §4).
 *
 * Commit 2 reality
 * ----------------
 * - `classify` makes a real Anthropic Haiku call (no extended thinking).
 * - `plan` makes a real Sonnet call WITH extended thinking enabled at
 *   `budget_tokens: 8192`. This is the step that produces the big visible
 *   `llm.thinking.delta` stream in the WS feed.
 * - `review_gate` suspends on a real `bus.awaitDecision(runId)` promise —
 *   `suspend()` from Mastra is NOT used in 1A; the bus is the authoritative
 *   synchronization point and lives in-process across the HTTP+WS surface.
 * - `retrieve`, `dry_run`, `execute`, `verify`, `log_and_notify` are canned:
 *   they sleep briefly and emit synthetic `tool.*` / `browser.screenshot`
 *   frames so the envelope variants are exercised end-to-end. 1B replaces
 *   the canned bodies with real Playwright MCP / RAG / DB calls.
 *
 * Why the split
 * -------------
 * The user's 1A acceptance criteria: prove the stream + suspension + replay
 * work end-to-end with real LLM reasoning at the interesting steps. Running
 * the full browser chain is 1B's job. Keeping 1A canned where it doesn't
 * need to be real is how we avoid entangling two risk surfaces.
 *
 * Rejection path
 * --------------
 * When a reviewer rejects at `review_gate`, the step returns a small output
 * that the `execute`/`verify`/`log_and_notify` steps detect and short-circuit
 * — they emit one `step.started` / `step.completed` pair with a "skipped"
 * note so the timeline reads cleanly and the client sees a clean
 * `run.completed { status: "rejected" }`. No step is cancelled mid-flight.
 */

/** ---------- Schemas ---------- */

const TicketSchema = z.object({
  ticketId: z.string().min(1),
  subject: z.string().min(1),
  submittedBy: z.string().optional(),
});

const ClassificationSchema = z.object({
  category: z.string(),
  urgency: z.enum(["low", "medium", "high"]),
  targetApps: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

/** 7b.ii-hotfix — per-hit summary carried forward from retrieveStep
 *  into planStep's prompt.
 *
 *  Preview cap — 2000 chars.
 *  Intentionally ASYMMETRIC with the envelope `RagHitSchema.preview`
 *  cap of 400 chars (see `src/events/envelope.ts`):
 *    - This schema feeds Sonnet's plan prompt. Runbook passages are
 *      naturally long-form procedural text; 400 chars cuts mid-sentence
 *      and omits the actual procedure steps. 7b.ii-hotfix-1 smoke
 *      surfaced this as Sonnet's explicit complaint "The runbook
 *      passages are truncated and don't provide the complete
 *      procedure" — a legitimate prompt-budget signal, not model noise.
 *    - The envelope frame feeds the reviewer UI's rag-hit rows where
 *      400 chars is plenty for a "what did RAG return at a glance?"
 *      scan. Widening the envelope cap would bloat every rag.retrieved
 *      frame over the wire for no UI benefit.
 *
 *  Each consumer documents its cap at the point of use (see
 *  `runRagCall`'s hitSummaries builder and `mapHitToFrame` below). */
const RagHitSummarySchema = z.object({
  score: z.number(),
  source: z.string(),
  preview: z.string().max(2000),
});
type RagHitSummary = z.infer<typeof RagHitSummarySchema>;

const RetrievalSchema = z.object({
  runbookHits: z.number().int().nonnegative(),
  skillHits: z.number().int().nonnegative(),
  /** 7b.ii-hotfix — raw hit summaries from the retrieveStep ReAct
   *  runner's last iteration per tool. Capped top-5 per corpus to keep
   *  plan-prompt budget reasonable. Previously retrieveStep returned
   *  only counts; planStep therefore couldn't see what was retrieved
   *  and Sonnet (correctly) refused to plan from that thin context. */
  hits: z.object({
    runbooks: z.array(RagHitSummarySchema).max(5),
    skills: z.array(RagHitSummarySchema).max(5),
  }),
  classification: ClassificationSchema,
});

/** 7b.ii-hotfix — one action in a structured plan. Replaces the
 *  earlier regex-over-prose step-counting + destructive-keyword
 *  inference that misclassified model refusals as "3-step destructive
 *  plan" during 7b.ii smoke. Those heuristics were removed in the
 *  7b.iii.a prep cleanup now that the structured `actions[]` +
 *  LLM-declared `destructive` fields are authoritative. `verb` enum
 *  intentionally narrow for now; Week-2 skill-card schema will
 *  authoritative-source the verb vocabulary. */
const PlanActionSchema = z.object({
  stepNumber: z.number().int().positive(),
  verb: z.enum(["navigate", "fill", "click", "verify", "notify"]),
  target: z.string().min(1),
  /** 7b.ii-hotfix-3 — accept `null` as a synonym for `undefined`. JSON
   *  has no natural "undefined"; Sonnet (and Anthropic models
   *  generally) emit `"value": null` for actions without an applicable
   *  value (navigate / click / verify / notify — anything that isn't
   *  `fill`). Under the original `z.string().optional()` shape those
   *  entries failed `safeParse` and the surrounding parsing loop
   *  silently dropped them. 7b.ii-hotfix-2 smoke surfaced this as a
   *  9-action plan rendering as "2-step plan" in the UI — same class
   *  of truth-invariant violation the earlier hotfixes targeted.
   *
   *  `z.preprocess(v → v === null ? undefined : v, z.string().optional())`
   *  keeps the parsed output type as `string | undefined`, so every
   *  downstream `action.value` consumer stays source-compatible. */
  value: z.preprocess(
    (v) => (v === null ? undefined : v),
    z.string().optional(),
  ),
  description: z.string().min(1),
});

const PlanSchema = z.object({
  // Backward-compat fields (consumed by reviewGateStep's
  // `review.requested` emission and the reviewer UI's renderPlanBody).
  // Derived at planStep output time from authoritative structured fields.
  planId: z.string().uuid(),
  actionCount: z.number().int().nonnegative(), // = actions.length
  destructive: z.boolean(), // LLM-declared (was regex-inferred pre-hotfix)
  skillCardIds: z.array(z.string()),
  planText: z.string(), // narrative prose for UI display
  thinking: z.string(),
  classification: ClassificationSchema,
  // 7b.ii-hotfix new fields.
  /** Structured per-action plan. Empty when `requiresContext === true`. */
  actions: z.array(PlanActionSchema),
  /** True when the model refused to plan because it lacked information.
   *  First-class representation of the refusal path — UI renders
   *  "🟡 needs context" instead of falsifying a step count. 7b.iii's
   *  Block 1 exit signal is `!requiresContext && actions.length > 0`. */
  requiresContext: z.boolean(),
  /** What the model said it needed (if requiresContext). Bounded so
   *  the envelope frame stays well under MAX_FRAME_BYTES.
   *
   *  7b.ii-hotfix-3 — same `null → undefined` preprocess as
   *  `PlanActionSchema.value`. Defensive depth: the model is less
   *  likely to emit `"missingContext": null` than `"value": null` (it's
   *  array-shaped, not scalar), but the one-line preprocess is cheap
   *  and matches the pattern. */
  missingContext: z.preprocess(
    (v) => (v === null ? undefined : v),
    z.array(z.string().max(200)).max(8).optional(),
  ),
  /** week2d Part 3 — template-substitution values extracted by the
   *  planner from the ticket. Populated by Part 3's plan-prompt
   *  update (3b); until then, soft-defaults to `{}`. Consumed by
   *  `runMaterializeSkillCardStep` to rewrite verbatim-match literals
   *  in the actionTrace args to `{{ inputs.X }}` placeholders on the
   *  ephemeral skill.
   *
   *  `.default({})` keeps back-compat during 3a (schema lands but plan
   *  parser doesn't yet populate). Parse soft-fallback: malformed
   *  inputs → `{}` + log.warn (see `planOutputParser`, 3b). */
  inputs: z.record(z.string()).default({}),
  /** week2e-dynamic-target-url — target URL override.
   *
   *  Resolution precedence (Path A+):
   *    1. Reviewer correction in seedObservations (e.g. "the correct
   *       URL is X") → plan prompt instructs Sonnet to re-emit here.
   *    2. `ctx.ticket.targetUrl` from `/triage` intake body.
   *    3. Scaffold's `base_url` (fallback at dry_run + materialize).
   *
   *  Making the corrected URL a discrete plan-output field (rather
   *  than implicit in Sonnet's navigation choices) gives reviewers +
   *  operators a visible, audit-logged "URL flipped from A → B at
   *  refine pass N" signal on `step.completed.output.targetUrl`.
   *  Optional — absent when the scaffold's default is authoritative. */
  targetUrl: z.string().url().optional(),
});

/** 7b.iii.a — reason codes recorded per Block 1 pass. Mirrors the
 *  envelope's `block.iteration.completed.reason` enum so the controller
 *  and the envelope schema stay in lockstep. */
const Block1ReasonSchema = z.enum([
  "exit_signal_ok",
  "plan_requires_context",
  "plan_empty_actions",
  "dry_run_mismatch",
  "max_iterations",
]);
type Block1Reason = z.infer<typeof Block1ReasonSchema>;

/** 7b.iii.a — carried on `DryRunSchema` only when Block 1 exhausted
 *  its passes. reviewGateStep forwards this to the `review.requested`
 *  envelope frame so the UI can render the "exhausted" banner +
 *  disable the approve button. Absent on happy-path outputs. */
const BlockResultSchema = z.object({
  passes: z.number().int().min(1).max(10),
  passedLast: z.boolean(),
  allReasons: z.array(Block1ReasonSchema).max(10),
});

/** week2d Part 2 — one browser action the dry_run agent actually
 *  performed. Populated from the iteration trace's `toolCall` on every
 *  non-`boundary_reached` iteration. `destructive` is never true in
 *  Part 2 (dry_run never clicks the destructive element by design —
 *  `boundary_reached` guards that); Part 3's materializer flips it
 *  true on the last action before the boundary signal. `screenshotPath`
 *  is reserved for a future widening where the iteration walker
 *  recovers the implicit 7a.iv screenshot path; Part 2 leaves it
 *  unpopulated (DOM excerpt in the runner's observation carries the
 *  state signal). */
const DryRunActionSchema = z.object({
  tool: z.enum([
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_fillForm",
    "browser_takeScreenshot",
  ]),
  args: z.record(z.unknown()),
  destructive: z.boolean().optional(),
  screenshotPath: z.string().optional(),
});

/** week2d Part 2 — the boundary signal the dry_run agent emits via
 *  `boundary_reached`. `scaffoldMatch` is nullable: true = matches
 *  scaffold's declared destructive step verbatim; false = UI drift,
 *  agent found a differently-named-but-same-intent element;
 *  null = agent omitted the field (Part 1 validator allows optional).
 *  Reviewer UI branches on this in Part 4. */
const BoundaryReachedSchema = z.object({
  element: z.string().min(1).max(200),
  reason: z.string().min(1).max(500),
  scaffoldMatch: z.boolean().nullable(),
  iteration: z.number().int().nonnegative(),
});

const DryRunSchema = z.object({
  domMatches: z.boolean(),
  anomalies: z.array(z.string()),
  plan: PlanSchema,
  /** 7b.iii.a — set only when this output came from an exhausted
   *  Block 1 pass. Absence is the happy-path signal. */
  blockResult: BlockResultSchema.optional(),
  /** week2d Part 2 — sequence of browser ops the dry_run agent
   *  actually performed. Populated on every DryRunSchema-emitting
   *  path (required field, never omitted — use `[]` when no trace). */
  actionTrace: z.array(DryRunActionSchema),
  /** week2d Part 2 — the destructive-boundary signal. `null` on
   *  exhaustion paths or when Block 1 refused before dry_run ran. */
  boundaryReached: BoundaryReachedSchema.nullable(),
});

/** week2d Part 3 — divergence between scaffold's declared destructive
 *  step and the agent's observed destructive element. Non-null only
 *  when `boundaryReached.scaffoldMatch === false` (UI drift). */
const DivergenceSchema = z.object({
  expected: z.string().min(1).max(200),
  actual: z.string().min(1).max(200),
  reason: z.string().min(1).max(500),
});


const ReviewSchema = z.object({
  // Week-2a gate-decision-model — 4-value enum matches envelope.ts
  // ReviewDecidedFrame.decision. runReviewGateStep's return value
  // in practice only produces "approve" (happy path) or "terminate"
  // (skip-cascade trigger) — "reject" and "edit" exit via the refine
  // loop which either converges to approve or exhausts to terminate.
  // Kept at 4 values for wire-contract consistency; narrowing to
  // z.enum(["approve", "terminate"]) is a Week-2 polish queue item.
  decision: z.enum(["approve", "reject", "edit", "terminate"]),
  approved: z.boolean(),
  dryRun: DryRunSchema,
});

/** week2d Part 3 — output of `runMaterializeSkillCardStep` (Mastra step).
 *  `skill` is the ephemeral materialized card (conforms to existing
 *  `SkillSchema`). `baseUrl` is forwarded from the scaffold so
 *  `runExecuteStep` doesn't need to re-load (resolution of §11 #1).
 *  `divergence` surfaces the scaffold-vs-actual destructive element
 *  mismatch. `dryRun` carries forward for audit. `review` is threaded
 *  from `reviewGateStep` so `runExecuteStep` can still detect the
 *  skip-cascade path via `review.approved === false`.
 *
 *  week2d Part 3b — `skillId` (UUID4) and `skillName` (convention
 *  identifier `<host>_<scaffold>_<uuid>`) are produced by the
 *  materializer and persisted to `materialized_skills`. `skillId`
 *  doubles as the Qdrant collection UUID for future vector-DB
 *  ingestion (embedding work deferred per reviewer). */
const MaterializeSchema = z.object({
  skill: SkillSchema,
  skillId: z.string().uuid(),
  skillName: z.string().min(1).max(256),
  baseUrl: z.string().url(),
  divergence: DivergenceSchema.nullable(),
  dryRun: DryRunSchema,
  review: ReviewSchema,
});

/** week2d Part 3 — placeholder skill for the skip-cascade path (when
 *  reviewGateStep returns `approved: false`). Materialize's Mastra
 *  wrapper emits this so MaterializeSchema stays required-shape;
 *  `runExecuteStep` short-circuits on `review.approved === false`
 *  before reading the skill. Valid per SkillSchema. */
const MINIMAL_SKIPPED_SKILL: Skill = {
  name: "skipped",
  description: "Placeholder for skipped execution (review rejected/terminated).",
  destructive: false,
  steps: [{ tool: "snapshot", args: {}, destructive: false }],
};

const ExecuteSchema = z.object({
  stepsRun: z.number().int().nonnegative(),
  skipped: z.boolean(),
  review: ReviewSchema,
});

const VerifySchema = z.object({
  success: z.boolean(),
  skipped: z.boolean(),
  evidence: z.array(z.string()),
  execute: ExecuteSchema,
});

const LogSchema = z.object({
  status: z.enum(["ok", "rejected", "failed"]),
  note: z.string(),
});

/** ---------- Steps ---------- */

/** 7b.iii.a — prepend prior-pass observations to a user message when
 *  the Block 1 controller populated `RunContext.priorObservations`.
 *  No-op on pass 0 (observations array empty or undefined). All three
 *  pre-gate steps (classify / retrieve / plan) call this so Sonnet
 *  sees what the previous passes tried + why they failed and can
 *  refine its next attempt. Kept as a tiny self-contained helper so
 *  the exact prefix shape is identical across all three call sites. */
function observationsPrefix(obs: string[] | undefined): string {
  if (!obs || obs.length === 0) return "";
  return (
    `Prior passes (${obs.length} observation${obs.length === 1 ? "" : "s"} carried forward):\n` +
    obs.map((o, i) => `  ${i + 1}. ${o}`).join("\n") +
    `\n\n`
  );
}

// Commit week2c-react-classify — classifyStep reframed as a ReAct loop.
//
// Before: one-shot Haiku call returned ClassificationSchema JSON
// directly. No adaptation to the ticket content, no way for the
// classifier to consult the skill-card knowledge base when uncertain
// about the category, no visibility into the reasoning.
//
// After: a `createReActStep` instance with one tool —
// `rag_retrieveCategoryHints` — that biases skill-card retrieval
// toward a category guess (composed query `"Category: <cat>. <q>"`
// routes to SHARED_SKILLS_UUID). The model can call the tool ONCE when
// uncertain about the category, then finalize. Simpler than
// retrieveStep's two-tool shape (one tool, not a sequence), lower
// iteration budget (maxIterations=2), lower tier (haiku preserved —
// classify is a one-tool decision and Haiku handles it trivially).
//
// Output shape unchanged — ClassificationSchema. Downstream retrieveStep
// / planStep see identical input. Fallback-on-malformed-JSON behavior
// from the pre-ReAct implementation is preserved inside produceOutput.
//
// Envelope: no changes. The runner's `react.iteration.*` frames plus
// `reactIterationId` tagging of every inner frame already render in
// the reviewer UI (proven by retrieveStep's 7b.ii smoke). Tool-call
// path emits the business-level `rag.retrieveCategoryHints` dotted-
// form `tool.started` → `rag.retrieved` → `tool.completed` span via
// `runRagCall`, continuous with classify pre-ReAct observability.
//
// LLM calls inside each iteration ride `getCircuit("anthropic")` —
// transient Anthropic 500s retry automatically per iteration.
//
// Block1Deps.runClassify signature preserved: `(input) =>
// Promise<ClassificationOutput>`. The thin wrapper below forwards to
// `runReActIterations(input, undefined, classifyStepConfig)`; the
// Mastra step wrapper uses `createReActStep<TIn, TOut>(...)` which
// threads abortSignal through automatically.

const CategoryHintsInputSchema = z.object({
  category: z.string().min(1).max(64),
  query: z.string().min(1).max(500),
});

/** Anthropic `input_schema` shape (hand-written JSON Schema). Paired
 *  with `CategoryHintsInputSchema` for runtime validation. Same
 *  zod-to-json-schema deferral rationale as retrieveStep's
 *  `RAG_QUERY_INPUT_JSON_SCHEMA` — worth picking up a helper once
 *  tool count passes ~5. */
const CATEGORY_HINTS_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      description:
        "Your current best-guess category for this ticket (e.g. 'account_management', 'access_request'). The retrieval will be biased toward skill cards matching this category.",
    },
    query: {
      type: "string",
      description:
        "A focused query about what skill-card content to retrieve (e.g. 'password reset locked user'). Prefer short, specific phrases.",
    },
  },
  required: ["category", "query"],
  additionalProperties: false,
} as const;

/** week2c-react-classify — extracted classify config. Same typing
 *  rationale as `retrieveStepConfig`: explicit
 *  `CreateReActStepArgs<TIn, TOut>` typing restores callback inference
 *  that would be lost if we inlined the config directly into
 *  `createReActStep<TIn, TOut>({...})`. */
const classifyStepConfig: CreateReActStepArgs<
  z.infer<typeof TicketSchema>,
  z.infer<typeof ClassificationSchema>
> = {
  id: "classify" as const,
  inputSchema: TicketSchema,
  outputSchema: ClassificationSchema,
  tier: "haiku" as const,
  thinkingEnabled: false,
  maxIterations: 2,
  tools: {
    rag_retrieveCategoryHints: {
      // Anthropic tool-name regex (no dots) — see retrieveStep's note.
      // Business-level `tool.started` frame still uses the dotted form
      // `rag.retrieveCategoryHints` for continuity.
      name: "rag_retrieveCategoryHints",
      description:
        "Search the skill-cards knowledge base for cards matching a suspected ticket category. Use this to confirm or refine your category guess before finalizing classification. Returns hit scores, source paths, and short previews.",
      inputSchema: CATEGORY_HINTS_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      validator: CategoryHintsInputSchema,
      invoke: async (input: unknown, ctx) => {
        const { category, query } = input as { category: string; query: string };
        return runRagCall({
          name: "rag.retrieveCategoryHints",
          stepId: ctx.stepId,
          collection: env("SHARED_SKILLS_UUID"),
          query,
          abortSignal: ctx.signal ?? new AbortController().signal,
          invoke: (signal) => retrieveCategoryHints(category, query, { signal }),
        });
      },
      // Lever A (week2c-react-claude-verbosity) — content-bearing
      // summary so Sonnet's next iteration has real evidence to cite
      // instead of speculating. Top-3 hits, 80-char previews to stay
      // under the 400-char frame-side slice. Noun "category-hint".
      summarize: (output: unknown) => {
        const { hitCount, hits } = output as {
          hitCount: number;
          hits: Array<{ score: number; source: string; preview: string }>;
        };
        if (hitCount === 0) return "0 category-hints";
        const top = hits
          .slice(0, 3)
          .map(
            (h) =>
              `  ${h.score.toFixed(2)} ${h.source.split("/").pop() ?? h.source} — ${h.preview.slice(0, 80).replace(/\s+/g, " ")}…`,
          )
          .join("\n");
        return `${hitCount} category-hint${hitCount === 1 ? "" : "s"}:\n${top}`;
      },
    },
  },
  // Lever B (week2c-react-claude-verbosity) — terse action-verb form
  // with hard output constraints + explicit no-preamble clause.
  // Haiku tends to wrap JSON in ```json fences even when told "JSON
  // only", so the fence-ban is called out explicitly.
  buildSystem: () =>
    "Classify IT helpdesk tickets. Call `rag_retrieveCategoryHints` ONCE if category is unclear; otherwise finalize immediately. " +
    'Output: JSON with keys `category` (string), `urgency` ("low"|"medium"|"high"), `targetApps` (string[]), `confidence` (0..1). ' +
    "No preamble. No narration. No markdown fences. Respond with ONLY the JSON object.",
  // Same pattern + rationale as retrieveStep's buildUserMessage (see
  // comment above that callback at triage.ts:482-490): called from
  // inside `runReActIterations` under a `withRunContext({ ...ctx,
  // bus: taggedBus })` scope, so `getRunContext()` sees accumulated
  // `priorObservations`. `tryGetRunContext` null-safe so any future
  // direct-test of this callback outside a run-context scope degrades
  // gracefully to the pass-0 behavior.
  buildUserMessage: (input: z.infer<typeof TicketSchema>) => {
    const ctx = tryGetRunContext();
    return (
      observationsPrefix(ctx?.priorObservations) +
      `Ticket ID: ${input.ticketId}\n` +
      `Subject: ${input.subject}\n` +
      (input.submittedBy ? `Submitted by: ${input.submittedBy}\n` : "")
    );
  },
  produceOutput: (iterations, _input) => {
    // Final iteration is the last one with `final: true`. If the
    // iteration cap exhausted without an explicit final, fall back to
    // the last iteration's `thought` — still contains whatever JSON
    // the model was producing. This mirrors the pre-ReAct fallback-
    // defaults behavior: we never propagate a hard failure up; the
    // workflow keeps moving and downstream steps observe the
    // confidence score.
    const finalIter =
      iterations.find((it) => it.final) ?? iterations[iterations.length - 1];
    const rawText = finalIter?.thought ?? "";
    const parsed = tryParseJson<Record<string, unknown>>(rawText);
    const validated = ClassificationSchema.safeParse({
      category: String(parsed?.category ?? "uncategorized"),
      urgency: pickUrgency(parsed?.urgency),
      targetApps: Array.isArray(parsed?.targetApps)
        ? parsed.targetApps.map(String)
        : [],
      confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0.3,
    });
    if (!validated.success) {
      logger.warn(
        { issues: validated.error.issues },
        "[classify] fallback defaults",
      );
      return {
        category: "uncategorized",
        urgency: "low" as const,
        targetApps: [],
        confidence: 0.3,
      };
    }
    return validated.data;
  },
};

const classifyStep = createReActStep<
  z.infer<typeof TicketSchema>,
  z.infer<typeof ClassificationSchema>
>(classifyStepConfig);

/** Extracted classify body so the Block 1 controller can invoke it
 *  directly (outside Mastra's step-execution machinery). Thin wrapper
 *  around `runReActIterations` — same pattern as `runRetrieveStep`'s
 *  relationship to `retrieveStepConfig`. `abortSignal` is optional so
 *  `Block1Deps.runClassify` (signature: `(input) => Promise<...>`)
 *  continues to type-check without modification. */
export async function runClassifyStep(
  inputData: z.infer<typeof TicketSchema>,
  abortSignal?: AbortSignal,
): Promise<z.infer<typeof ClassificationSchema>> {
  return runReActIterations(inputData, abortSignal, classifyStepConfig);
}

// Commit 7b.ii — retrieveStep reframed as a ReAct loop.
//
// Before 7b.ii: the step fired two identical RAG queries blindly and
// returned whatever hits came back. No adaptation to the classification,
// no refinement on weak hits, no visibility into the reasoning.
//
// After 7b.ii: the step is a `createReActStep` instance with a two-tool
// registry (`rag_retrieveRunbooks` + `rag_retrieveSkills`). Each
// iteration, Sonnet decides what to query for based on the classification
// + a summary of prior iterations' observations, calls one of the tools
// via Anthropic's native tool-use protocol, and observes the hit count +
// summary. After up to 3 iterations (or when the model declines further
// tool calls), the runner's `produceOutput` aggregates the per-tool
// last-call hit counts into the existing `RetrievalSchema` shape so
// downstream steps (planStep et al.) see identical input to before.
//
// The existing `runRagCall` helper (below) is preserved verbatim — the
// ReactTool `invoke` closures wrap it so the reviewer UI's business-level
// `tool.started → rag.retrieved → tool.completed` spans continue to emit
// exactly as they did in 5b/6c/7a.iv. The only new frames are the
// `react.iteration.*` dividers bracketing each iteration, plus the
// `reactIterationId` field carried by every frame emitted inside an
// iteration (which the reviewer UI uses to visually nest them).
//
// LLM calls inside each iteration ride through the
// `getCircuit("anthropic")` breaker introduced in 7b.i — a transient
// Anthropic 500 mid-iteration retries automatically and does not fail
// the run.

const RagQueryInputSchema = z.object({
  query: z.string().min(1).max(500),
});

/** Anthropic `input_schema` shape (hand-written JSON Schema). Paired
 *  with `RagQueryInputSchema` for runtime validation. Week-2 cleanup:
 *  introduce `zod-to-json-schema` when tool count grows past ~5 so we
 *  stop hand-writing duplicate schemas. */
const RAG_QUERY_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "A focused query describing what runbook or skill-card content to retrieve. Prefer short, specific phrases.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** 7b.iii.a — extracted retrieveStep config so `runRetrieveStep` can
 *  reuse it to invoke the ReAct runner directly from the Block 1
 *  controller (outside Mastra's step-execution machinery). The
 *  controller calls `runReActIterations(input, abortSignal, retrieveStepConfig)`
 *  and emits its own step.started/completed frames around the call.
 *  Same pattern as `runClassifyStep` / `runPlanStep`.
 *
 *  Explicit `CreateReActStepArgs<TIn, TOut>` typing is required: when
 *  the config object is inlined directly into `createReActStep<TIn, TOut>({...})`
 *  generic inference narrows the inner callback params; as a
 *  standalone const, we lose that inference and callbacks widen to
 *  `any`. Explicit typing restores it. */
const retrieveStepConfig: CreateReActStepArgs<
  z.infer<typeof ClassificationSchema>,
  z.infer<typeof RetrievalSchema>
> = {
  id: "retrieve" as const,
  inputSchema: ClassificationSchema,
  outputSchema: RetrievalSchema,
  tier: "sonnet" as const,
  thinkingEnabled: false, // retrieve isn't reasoning-heavy; save tokens + latency
  // Lever D (week2c-react-claude-verbosity) — cap at 2 iterations
  // (runbooks + skills), not 3. The 3rd iteration's final-text was
  // dead weight: `produceOutput` aggregates from toolCall outputs
  // only (ignores iter.toolCall === null), so the model's narrative
  // summary was never read. Removes ~10s latency per run + verbose
  // commentary from the RIGHT-column feed. Paired with the "both
  // tool calls required" clause in buildSystem below so the cap
  // reliably enforces termination after both RAG calls.
  maxIterations: 2,
  // Tool `invoke` + `summarize` are typed against `unknown` here — the
  // `ToolRegistry = Record<string, ReactTool>` shape widens the generic
  // parameters when tools are inlined. Runtime validation still applies:
  // `ReactTool.validator` (Zod) narrows `input` to the typed shape just
  // before `invoke` is called, and the `parsed.data` passed to invoke is
  // already typed correctly inside the runner. Inside these closures we
  // cast once and the rest of the body is strongly typed.
  tools: {
    rag_retrieveRunbooks: {
      // Note: Anthropic tool names must match /^[a-zA-Z0-9_-]{1,64}$/ (no
      // periods), so we use `rag_retrieveRunbooks` here. The business-level
      // `tool.started` frame emitted by runRagCall below continues to use
      // the dotted form `rag.retrieveRunbooks` for continuity with 5b/6c.
      name: "rag_retrieveRunbooks",
      description:
        "Search the runbooks knowledge base for troubleshooting resolutions. Returns hit scores, source paths, and short previews.",
      inputSchema: RAG_QUERY_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      validator: RagQueryInputSchema,
      invoke: async (input: unknown, ctx) => {
        const { query } = input as { query: string };
        return runRagCall({
          name: "rag.retrieveRunbooks",
          stepId: ctx.stepId,
          collection: env("SHARED_RUNBOOKS_UUID"),
          query,
          abortSignal: ctx.signal ?? new AbortController().signal,
          invoke: (signal) => retrieveRunbooks(query, { signal }),
        });
      },
      // Lever A (week2c-react-claude-verbosity) — content-bearing
      // summary. Same shape as rag_retrieveCategoryHints above.
      summarize: (output: unknown) => {
        const { hitCount, hits } = output as {
          hitCount: number;
          hits: Array<{ score: number; source: string; preview: string }>;
        };
        if (hitCount === 0) return "0 runbook hits";
        const top = hits
          .slice(0, 3)
          .map(
            (h) =>
              `  ${h.score.toFixed(2)} ${h.source.split("/").pop() ?? h.source} — ${h.preview.slice(0, 80).replace(/\s+/g, " ")}…`,
          )
          .join("\n");
        return `${hitCount} runbook hit${hitCount === 1 ? "" : "s"}:\n${top}`;
      },
    },
    rag_retrieveSkills: {
      name: "rag_retrieveSkills",
      description:
        "Search the skill-cards knowledge base for pre-authorized action patterns. Returns hit scores, source paths, and short previews.",
      inputSchema: RAG_QUERY_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      validator: RagQueryInputSchema,
      invoke: async (input: unknown, ctx) => {
        const { query } = input as { query: string };
        return runRagCall({
          name: "rag.retrieveSkills",
          stepId: ctx.stepId,
          collection: env("SHARED_SKILLS_UUID"),
          query,
          abortSignal: ctx.signal ?? new AbortController().signal,
          invoke: (signal) => retrieveSkills(query, { signal }),
        });
      },
      // Lever A (week2c-react-claude-verbosity) — content-bearing
      // summary. Same shape as rag_retrieveCategoryHints / Runbooks.
      summarize: (output: unknown) => {
        const { hitCount, hits } = output as {
          hitCount: number;
          hits: Array<{ score: number; source: string; preview: string }>;
        };
        if (hitCount === 0) return "0 skill-card hits";
        const top = hits
          .slice(0, 3)
          .map(
            (h) =>
              `  ${h.score.toFixed(2)} ${h.source.split("/").pop() ?? h.source} — ${h.preview.slice(0, 80).replace(/\s+/g, " ")}…`,
          )
          .join("\n");
        return `${hitCount} skill-card hit${hitCount === 1 ? "" : "s"}:\n${top}`;
      },
    },
  },
  // Lever B (week2c-react-claude-verbosity) + Lever D — terse form
  // with "both tool calls required" clause. Under Lever D
  // (maxIterations=2), the cap enforces termination after runbooks +
  // skills — no final-text iteration exists. The "do not terminate
  // early" clause prevents Sonnet from emitting final text at iter 1
  // instead of the second tool call (the edge case the ≤25-word
  // budget was originally guarding against — reframing to prohibit
  // the edge case entirely is cleaner).
  buildSystem: (c: z.infer<typeof ClassificationSchema>) =>
    `Retrieve relevant runbooks and skill cards for this classified ticket ` +
    `(category="${c.category}", urgency="${c.urgency}"` +
    (c.targetApps.length > 0 ? `, targetApps=${c.targetApps.join(", ")}` : "") +
    `). Call \`rag_retrieveRunbooks\`, then call \`rag_retrieveSkills\`. Both tool ` +
    `calls are required — do not terminate early. Refine ONCE if a top score ` +
    `is below 0.5. No preamble. No narration about iterations. No meta-commentary.`,
  // 7b.iii.a — buildUserMessage is called from inside `runReActIterations`
  // which runs inside a `withRunContext({ ...ctx, bus: taggedBus })`
  // scope (verified at reactRunner.ts:266-267). The spread preserves
  // `priorObservations` from the outer controller's context, so
  // `getRunContext()` here sees the accumulated observations on pass
  // N>0 and prepends them to the user message — same shape as
  // classifyStep and planStep. Using `tryGetRunContext` null-safe so
  // any future direct-test of this callback outside a run-context
  // scope degrades gracefully to the pass-0 behavior.
  buildUserMessage: (c: z.infer<typeof ClassificationSchema>) => {
    const ctx = tryGetRunContext();
    return (
      observationsPrefix(ctx?.priorObservations) +
      `Classification:\n${JSON.stringify(c, null, 2)}\n\n` +
      `Retrieve the most relevant runbooks AND skill cards for this ticket. Use the tools.`
    );
  },
  produceOutput: (iterations, classification) => {
    // "Last-wins per tool" — the model's final retrieval decision for
    // each collection is authoritative. A later iteration that
    // intentionally narrows and returns fewer-but-better hits is what
    // we report. If smoke shows the model aggressively narrowing to
    // zero (which would be a prompting issue), flipping to `max` here
    // is a one-line change.
    //
    // 7b.ii-hotfix — aggregate hit summaries alongside counts so
    // planStep can actually see what was retrieved. Pre-hotfix only
    // counts crossed the boundary, which caused Sonnet to correctly
    // refuse to plan for lack of substantive context.
    let runbookHits = 0;
    let skillHits = 0;
    let runbookHitSummaries: RagHitSummary[] = [];
    let skillHitSummaries: RagHitSummary[] = [];
    for (const iter of iterations) {
      const call = iter.toolCall;
      if (!call) continue;
      const out = call.output as { hitCount: number; hits: RagHitSummary[] };
      if (call.name === "rag_retrieveRunbooks") {
        runbookHits = out.hitCount;
        runbookHitSummaries = out.hits;
      } else if (call.name === "rag_retrieveSkills") {
        skillHits = out.hitCount;
        skillHitSummaries = out.hits;
      }
    }
    return {
      runbookHits,
      skillHits,
      hits: { runbooks: runbookHitSummaries, skills: skillHitSummaries },
      classification,
    };
  },
};

const retrieveStep = createReActStep<
  z.infer<typeof ClassificationSchema>,
  z.infer<typeof RetrievalSchema>
>(retrieveStepConfig);

/** 7b.iii.a — exposed so the Block 1 controller can invoke retrieve
 *  directly (outside Mastra's step-execution machinery). Same pattern
 *  as `runClassifyStep` / `runPlanStep`. Forwards the active
 *  AbortSignal into the ReAct runner, which threads it through every
 *  tool invocation and every LLM call. */
export async function runRetrieveStep(
  input: z.infer<typeof ClassificationSchema>,
  abortSignal?: AbortSignal,
): Promise<z.infer<typeof RetrievalSchema>> {
  return runReActIterations(input, abortSignal, retrieveStepConfig);
}

/** Shape the query sent to `/docs/models/qa`. The classifier's category +
 *  target apps are enough context for the runbook + skill collections; keeping
 *  the two queries identical is fine for 1B because the two collections are
 *  disjoint corpora and both retrieve against the same intent. */
function buildRetrievalQuery(c: z.infer<typeof ClassificationSchema>): string {
  const apps = c.targetApps.filter((s) => s.length > 0).join(", ");
  return apps ? `${c.category} (${apps})` : c.category;
}

/** One RAG call + its three-frame timeline span. Bookends the call with
 *  `performance.now()` so `durationMs` is wall-clock-around-the-full-retry-loop
 *  (a retry-heavy call surfaces as a slow `tool.completed` in the reviewer UI —
 *  intentional: slow retrieves are diagnostic signal, not noise to hide). */
async function runRagCall(args: {
  name:
    | "rag.retrieveRunbooks"
    | "rag.retrieveSkills"
    | "rag.retrieveCategoryHints";
  // hotfix-1 — threaded from the ReactTool's `ctx.stepId` at the call
  // site (`reactRunner.ts ReactInvokeCtx.stepId`). Pre-hotfix this was
  // hardcoded to "retrieve" at every publish site, which mis-attributed
  // classify's `rag_retrieveCategoryHints` frames to `stepId=retrieve`
  // in the events table. UI nesting via reactIterationId was unaffected
  // (it reads the runner's own dividers), but step-level `GROUP BY
  // step_id` queries returned wrong results.
  stepId: StepId;
  collection: string;
  query: string;
  abortSignal: AbortSignal;
  invoke: (signal: AbortSignal) => Promise<{ hits: RagHit[]; request_id: string }>;
}): Promise<{ hitCount: number; hits: RagHitSummary[] }> {
  const { runId, bus } = getRunContext();
  const invocationId = randomUUID();
  const startedAt = performance.now();

  bus.publish({
    runId,
    stepId: args.stepId,
    payload: {
      type: "tool.started",
      invocationId,
      name: args.name,
      args: { query: args.query, collection: args.collection },
    },
  });

  try {
    const result = await args.invoke(args.abortSignal);
    const mappedHits = result.hits.slice(0, 10).map(mapHitToFrame);

    bus.publish({
      runId,
      stepId: args.stepId,
      payload: {
        type: "rag.retrieved",
        collection: args.collection,
        query: args.query,
        hits: mappedHits,
      },
    });

    bus.publish({
      runId,
      stepId: args.stepId,
      payload: {
        type: "tool.completed",
        invocationId,
        name: args.name,
        resultSummary: {
          hits: result.hits.length,
          requestId: result.request_id,
        },
        durationMs: Math.round(performance.now() - startedAt),
      },
    });

    // 7b.ii-hotfix — also return top-5 hit summaries so retrieveStep's
    // produceOutput can surface them in RetrievalSchema.hits for
    // planStep's prompt. Preview sliced at 2000 chars (matches
    // RagHitSummarySchema.preview.max(2000) — intentionally wider than
    // the envelope frame's 400-char cap because Sonnet needs enough of
    // the runbook procedural text to reason about it; see the schema
    // comment above for the asymmetry rationale).
    const hitSummaries: RagHitSummary[] = result.hits.slice(0, 5).map((h) => ({
      score: h.score,
      source: h.source ?? "unknown",
      preview: h.text.slice(0, 2000),
    }));
    return { hitCount: result.hits.length, hits: hitSummaries };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    const isKnownRagError = err instanceof RagClientError || err instanceof RagSchemaError;
    const message = err instanceof Error ? err.message : String(err);

    bus.publish({
      runId,
      stepId: args.stepId,
      payload: {
        type: "tool.failed",
        invocationId,
        name: args.name,
        error: {
          message: isKnownRagError ? message : `[unexpected] ${message}`,
          where: args.name,
        },
      },
    });

    logger.warn(
      {
        runId,
        tool: args.name,
        collection: args.collection,
        durationMs,
        err: message,
        knownRagError: isKnownRagError,
      },
      "[retrieve] rag call failed; continuing with empty hits",
    );

    return { hitCount: 0, hits: [] };
  }
}

/** Map the tool-client's `RagHit` (Python snake_case) onto the envelope's
 *  `RagHitSchema` (camelCase, string source, nonnegative-int-ish chunkId).
 *  Defensive slice(0, 400) on preview even though the envelope schema caps
 *  there — we don't want the schema's error surface to ever be reachable from
 *  this code path. `-1` is the sentinel for "chunk index not recorded" so the
 *  reviewer UI can distinguish "position 0" from "unknown position." */
function mapHitToFrame(h: RagHit): {
  chunkId: number;
  score: number;
  preview: string;
  source: string;
} {
  return {
    chunkId: h.chunk_id ?? -1,
    score: h.score,
    // Envelope cap — 400 chars. This frame feeds the reviewer UI's
    // rag-hit rows in the behavior feed, where 400 is plenty for a
    // "what did RAG return at a glance?" summary. Intentionally tighter
    // than the plan-prompt cap (2000 chars) used by RagHitSummarySchema
    // — wire/UI display goal is compact, plan-reasoning goal is
    // sufficient-context. See RagHitSummarySchema comment for the
    // asymmetry rationale (surfaced in 7b.ii-hotfix smoke).
    preview: h.text.slice(0, 400),
    source: h.source ?? "unknown",
  };
}

/** 7b.ii-hotfix-4 — describe the agent's target application to the
 *  planning model.
 *
 *  Pre-hotfix-4 Sonnet's `missingContext` output included "URL or
 *  access method for the Internal Admin Portal" — a legitimate
 *  technical gap: the runbooks describe WHAT to do but not WHERE the
 *  portal lives, and the prompt never told the model. This helper
 *  closes that gap by pulling the target URL from env (same source
 *  the Playwright MCP driver uses) and enumerating the known routes
 *  so Sonnet can write concrete `target` strings like "reset password
 *  submit button on /users/:id/reset-password".
 *
 *  Week 1B shortcut: single target app (the test-webapp). The
 *  `_targetApps` parameter is accepted but unused — it's a hint for
 *  Week 2 when per-skill-card `base_url` declarations from the skill-
 *  card registry replace this hardcoded block. At that point this
 *  helper becomes `buildTargetAppContext(skillCards.map(c => c.app))`
 *  and pulls per-app routes from each card's schema.
 *
 *  Authentication note: credentials are deliberately NOT included in
 *  the prompt. The runtime signs in via Playwright using env-scoped
 *  creds; Sonnet plans the UI actions and the runtime handles auth.
 *  Keeping creds out of the prompt is non-negotiable security posture
 *  (MASTER_PLAN §6). */
function buildTargetAppContext(_targetApps: string[]): string {
  const url = process.env.TEST_WEBAPP_URL ?? "http://test-webapp:3000";
  return (
    `Target application: Internal Admin Portal at ${url}\n` +
    `  Known routes:\n` +
    `    ${url}/login                             — sign-in page (email + password)\n` +
    `    ${url}/users                             — user list with search\n` +
    `    ${url}/users/:id                         — user detail page\n` +
    `    ${url}/users/:id/reset-password          — destructive reset page (checkbox + confirm)\n` +
    `    ${url}/status                            — system status dashboard\n` +
    `  Authentication: sign in as admin user. Credentials provided to the agent runtime at execution time.`
  );
}

/** 7b.ii-hotfix — render top-N RAG hits for the plan prompt. Uses the
 *  full 2000-char preview from RetrievalSchema.hits[] (asymmetric with
 *  the envelope RagHitSchema's 400-char cap — see the schema comment). */
function formatHitLines(hits: RagHitSummary[], label: string): string {
  if (hits.length === 0) return `${label}: (none)`;
  return (
    `${label}:\n` +
    hits
      .map(
        (h, i) =>
          `  ${i + 1}. [${h.score.toFixed(2)}] ${h.source} — ${h.preview}`,
      )
      .join("\n")
  );
}

/** 7b.ii-hotfix — extracted planStep body so tests can drive the
 *  JSON-parse + schema-validation + requiresContext-fallback logic
 *  directly under `withRunContext` without routing through Mastra's
 *  step-execution machinery. Same pattern as `runReActIterations` in
 *  `src/mastra/lib/reactRunner.ts`. Exported for test use only. */
export async function runPlanStep(
  inputData: z.infer<typeof RetrievalSchema>,
): Promise<z.infer<typeof PlanSchema>> {
  {
    const { runId, bus, ticket, priorObservations } = getRunContext();

    // Week-2b-runtime — load the full skill-card catalog so the
    // planner's system prompt can list every card Sonnet is allowed
    // to pick. Single filesystem walk at planStep entry; result is
    // cached in-process by the loader so subsequent runs' planStep
    // calls are free. Empty catalog is acceptable (e.g., dev env with
    // kb/ empty) — Sonnet falls back to the custom-plan path.
    const allSkills = await loadAllSkills();
    const skillCatalog = buildSkillCatalog(allSkills);

    // 7b.ii-hotfix — build a prompt that actually includes the ticket
    // subject + top-5 hits per corpus. Previously Sonnet received only
    // the classification + hit counts, which (correctly) caused it to
    // refuse during 7b.ii smoke with "I don't have the specific issue
    // from the user, What the runbook hits contain...". That refusal's
    // incidental numbered list was then regex-counted as an "N-step
    // plan" and its keywords regex-flagged destructive — a double
    // truth-invariant violation. Both bugs are eliminated here via
    // (a) a prompt that includes the ticket + hit contents and (b) a
    // structured JSON output schema with a first-class requiresContext
    // refusal path.
    // 7b.ii-hotfix-4 — explicit division of labor between the three
    // actors (LLM planner / agent runtime / human reviewer).
    //
    // Pre-hotfix-4 smoke surfaced Sonnet refusing with
    // `requiresContext: true` over reviewer-responsibility items
    // ("identity verification required", "rate-limit status unknown")
    // and runtime-discoverable items ("account status unknown"). The
    // prior prompt said "if you lack enough information to produce a
    // concrete plan, return requiresContext: true" without clarifying
    // what "enough information" means relative to the workflow's
    // gate structure.
    //
    // The rewrite below:
    //   1. Names the three actors and their boundaries explicitly.
    //   2. Scopes `requiresContext: true` to TECHNICAL gaps only
    //      (missing URL, ambiguous UI target, absent procedure).
    //   3. Tells the model that runbook-mandated "verify identity",
    //      "check rate limits", etc. are `verb: "verify"` actions in
    //      the plan — the reviewer handles them at `review_gate`.
    //   4. Explicitly prohibits `requiresContext: true` for
    //      reviewer-responsibility or runtime-discoverable items.
    //
    // This is the last prompt-engineering hotfix before 7b.iii. If
    // stochastic refusals still happen >1/3 runs after this, the
    // block-level controller in 7b.iii handles them via backtracking
    // — architecture tolerates non-determinism, it doesn't try to
    // eliminate it via prompt-engineering arms race.
    const system =
      "You are the planning model for a tier-1 IT helpdesk agent. You produce a UI-action plan that the agent runtime will execute against a live browser, gated by mandatory human review.\n" +
      "\n" +
      "DIVISION OF LABOR (critical — read this carefully):\n" +
      "\n" +
      "1. YOU: translate runbook procedures into a sequence of UI actions (navigate, fill, click, verify, notify). You decide WHAT UI steps to take.\n" +
      "\n" +
      "2. The agent runtime: executes those UI actions via Playwright. It can DISCOVER live state during execution — account status, rate-limit counts, toast confirmations — by navigating and reading the DOM. You do NOT need this state upfront; your plan's `verify` actions mark the points where it should be checked.\n" +
      "\n" +
      "3. The human reviewer (mandatory, non-bypassable): approves or rejects the whole plan at `review_gate` AFTER you produce it. The reviewer is responsible for:\n" +
      "   - Requester identity verification.\n" +
      "   - Authorization and policy checks.\n" +
      "   - Runbook-mandated human-judgment gates.\n" +
      "   - Rate-limit and account-state sanity checks.\n" +
      "\n" +
      "   You do NOT do these. When a runbook says \"verify identity\" or \"require human review\", you include a `verb: \"verify\"` action at that point in the plan — the reviewer handles it at `review_gate`.\n" +
      "\n" +
      "WHEN TO RETURN `requiresContext: true`:\n" +
      "\n" +
      "Use `requiresContext: true` ONLY when you cannot construct a valid UI action sequence due to missing TECHNICAL information — e.g., the target application's URL is not provided, the UI targets are genuinely ambiguous (multiple possible buttons with no disambiguator), or the runbook procedure is entirely absent.\n" +
      "\n" +
      "Do NOT return `requiresContext: true` for:\n" +
      "- Missing requester identity → that's the reviewer's job at `review_gate`.\n" +
      "- Unknown current account status → the plan discovers this via navigation.\n" +
      "- Unknown rate-limit counts → the plan discovers this on the user detail page.\n" +
      "- Ambiguity the reviewer can resolve with a single decision at the gate.\n" +
      "\n" +
      "\nAVAILABLE SKILL CARDS:\n" +
      "Pre-authored skill cards encode tested UI-action sequences for known IT operations (password reset, account unlock, etc.). If any card matches the ticket, setting `skillCardName` to that card's name tells the runtime to dispatch the card's pre-authored steps — this is STRONGLY preferred over a custom `actions[]` plan whenever a card fits.\n" +
      "\n" +
      skillCatalog +
      "\n" +
      "If no card in the catalog fits the ticket, set `skillCardName: null` and produce a custom plan via `actions[]`. Do NOT invent skill-card names; hallucinated names trigger a planStep retry (wasted LLM budget).\n" +
      "\n" +
      "Return ONLY a JSON object matching this schema:\n" +
      "{\n" +
      '  "narrative": string,                      // short prose reasoning\n' +
      '  "skillCardName": string | null,           // name from catalog above, or null for a custom actions[] plan\n' +
      '  "actions": [{                             // [] if requiresContext=true; otherwise narrative/audit array — runtime consumes skillCardName, not this\n' +
      '    "stepNumber": 1,\n' +
      '    "verb": "navigate"|"fill"|"click"|"verify"|"notify",\n' +
      '    "target": string,                       // e.g. "email textbox on /login"\n' +
      '    "value": string | null,                 // null for actions without a value\n' +
      '    "description": string\n' +
      "  }],\n" +
      '  "destructive": boolean,                   // true iff any action is destructive (overridden by skill-card destructive flag when skillCardName is set)\n' +
      '  "requiresContext": boolean,\n' +
      '  "missingContext": string[]?,              // required if requiresContext=true\n' +
      '  "inputs": { [inputName: string]: string }, // template-substitution values extracted from the ticket (see INPUTS EXTRACTION below)\n' +
      '  "targetUrl": string | null               // optional URL override (see TARGET URL RESOLUTION below)\n' +
      "}\n" +
      "\n" +
      "INPUTS EXTRACTION (week2d Part 3):\n" +
      "\n" +
      "If you selected a skillCardName, emit `inputs` with the ticket-derived values that map to that skill card's declared inputs. The materializer uses these values to rewrite verbatim literals in the dry_run's browser action args to `{{ inputs.<key> }}` placeholders, making the materialized skill portable across inputs.\n" +
      "\n" +
      "Rules:\n" +
      "- Emit ONLY values explicitly present in the ticket subject or body. Do NOT invent values.\n" +
      "- On ambiguity: first-match-wins (whatever candidate appears first in the ticket text).\n" +
      "- If a required scaffold input is ABSENT from the ticket, set `requiresContext: true` with an explanatory entry in `missingContext`.\n" +
      "- If you selected `skillCardName: null`, emit `inputs: {}`.\n" +
      "\n" +
      "Examples:\n" +
      '- Ticket "Reset password for jane@example.com" + scaffold declares inputs: {email} → inputs: {"email": "jane@example.com"}\n' +
      '- Ticket "Unlock account u-001" + scaffold declares inputs: {user_id} → inputs: {"user_id": "u-001"}\n' +
      "\n" +
      "TARGET URL RESOLUTION (week2e-dynamic-target-url, Path A+):\n" +
      "\n" +
      "The ticket may specify a `targetUrl` that OVERRIDES the scaffold's default base_url. This lets one agent drive multiple tenants / admin portals.\n" +
      "\n" +
      "Precedence (emit the corrected URL as `targetUrl` in your JSON response):\n" +
      '1. If PRIOR PASSES block above contains a URL correction (reviewer note like "go to X", "the correct URL is Y", "use https://customer-b.example.com instead"), adopt that URL as authoritative — emit it as `targetUrl` so the change is auditable in the event log.\n' +
      "2. Else if the ticket's TARGET URL section below is present, emit that URL verbatim as `targetUrl`.\n" +
      "3. Else emit `targetUrl: null` — the scaffold's default base_url applies.\n" +
      "\n" +
      "Rules:\n" +
      "- targetUrl must be a well-formed http:// or https:// URL.\n" +
      "- Do NOT invent URLs; only emit a URL present in the ticket or in a reviewer observation.\n" +
      "- On ambiguity between multiple URL mentions in observations: most-recent-wins (the latest reviewer guidance beats earlier drafts).\n" +
      "\n" +
      "No prose outside the JSON.";

    // 7b.ii-hotfix-2 — omit the "Submitted by" line entirely when
    // `submittedBy` is undefined, matching classifyStep's existing
    // pattern. Rendering "Submitted by: (unknown)" was a template
    // artifact that Sonnet correctly flagged as a missing-context
    // signal during 7b.ii-hotfix-1 smoke.
    //
    // 7b.ii-hotfix-4 — prepend a "Target application" section with
    // the test-webapp's base URL + known routes. Pre-hotfix-4 Sonnet
    // flagged "Internal Admin Portal URL not provided" as a
    // missingContext item — legitimate gap we really did need to
    // close. `buildTargetAppContext` pulls the URL from env (same
    // source the Playwright MCP driver uses) and enumerates the
    // known routes so Sonnet can write concrete `target` strings
    // referencing `/login`, `/users/:id/reset-password`, etc.
    // 7b.iii.a — prepend prior-pass observations when invoked from
    // inside the Block 1 controller's iteration loop (pass N > 0).
    // Empty string on pass 0 or when invoked outside the controller.
    const userMsg =
      observationsPrefix(priorObservations) +
      `Ticket: ${ticket?.subject ?? "(unknown)"}\n` +
      `Ticket ID: ${ticket?.ticketId ?? "(unknown)"}\n` +
      (ticket?.submittedBy ? `Submitted by: ${ticket.submittedBy}\n` : "") +
      // week2e-dynamic-target-url — surface ticket's targetUrl so
      // plan's prompt can apply TARGET URL RESOLUTION (see system
      // prompt block). Absent when scaffold default is authoritative.
      (ticket?.targetUrl ? `TARGET URL (from ticket): ${ticket.targetUrl}\n` : "") +
      `\n` +
      `Classification: ${JSON.stringify(inputData.classification)}\n\n` +
      buildTargetAppContext(inputData.classification.targetApps) +
      "\n\n" +
      formatHitLines(inputData.hits.runbooks, "Runbook hits") +
      "\n\n" +
      formatHitLines(inputData.hits.skills, "Skill-card hits") +
      "\n\n" +
      `Produce a JSON plan per the schema.`;

    const result = await streamMessage({
      runId,
      bus,
      stepId: "plan",
      tier: "sonnet",
      maxTokens: 4096,
      thinkingEnabled: true,
      thinkingBudgetTokens: 8192,
      system,
      messages: [{ role: "user", content: userMsg }],
    });

    const planId = randomUUID();
    const parsed = tryParseJson<Record<string, unknown>>(result.text);

    // Malformed-JSON fallback: preserves the "UI shows truth" invariant
    // by landing a drift as a cleanly-marked "needs context" refusal
    // (diagnostic in missingContext). 7b.iii's Block 1 loop controller
    // will naturally retry on requiresContext=true, so drift gets free
    // recovery once the controller lands. `responsePreview` in the log
    // lets us debug "why is the model drifting off JSON" without a
    // full run replay.
    if (!parsed) {
      logger.warn(
        {
          runId,
          stepId: "plan",
          responsePreview: result.text.slice(0, 200),
        },
        "[planStep] model returned non-JSON; marking requiresContext=true",
      );
      return {
        planId,
        actionCount: 0,
        destructive: false,
        skillCardIds: [],
        planText: result.text.slice(0, 2000),
        // 7b.iii.b commit 4 (Bug 3A mitigation) — thinking is already
        // streamed via `llm.thinking.delta` frames; embedding it in
        // step.completed.output would push plan step.completed past
        // MAX_FRAME_BYTES on long-thinking Sonnet calls. UI's thinking
        // fade reads from the delta stream, not from step.completed
        // (verified: rg 'thinking' services/test-webapp shows zero
        // reads of plan.thinking from the output path). Empty string
        // keeps PlanSchema.thinking's required-string shape intact.
        thinking: "",
        classification: inputData.classification,
        actions: [],
        requiresContext: true,
        missingContext: ["model did not return valid JSON matching PlanSchema"],
        inputs: {}, // week2d Part 3 — populated for-real by the prompt update (3b)
        // week2e-dynamic-target-url — refusal path also forwards the
        // ticket's targetUrl so a refine doesn't drop the override.
        ...(ticket?.targetUrl ? { targetUrl: ticket.targetUrl } : {}),
      };
    }

    // Validate actions[] — best-effort coerce. Actions that don't match
    // PlanActionSchema (e.g., verb outside the enum, missing target)
    // are dropped silently from the output. 7b.ii-hotfix-3 added
    // per-action rejection capture so the partial-drop path has a
    // useful diagnostic log (pre-hotfix-3 the "value: null" bug was
    // completely silent — 7 of 9 actions dropped with no signal).
    const rawActions = Array.isArray(parsed.actions)
      ? (parsed.actions as unknown[])
      : [];
    const actions: z.infer<typeof PlanActionSchema>[] = [];
    const rejections: Array<{ index: number; issues: string }> = [];
    for (let i = 0; i < rawActions.length; i++) {
      const av = PlanActionSchema.safeParse(rawActions[i]);
      if (av.success) {
        actions.push(av.data);
      } else {
        rejections.push({
          index: i,
          issues: av.error.issues
            .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
            .join("; "),
        });
      }
    }

    // requiresContext logic fix (hotfix pre-apply catch): if ANY valid
    // action survived Zod, the plan is usable; otherwise flag
    // requiresContext regardless of what the model claimed. Closes the
    // gap where rawActions.length > 0 but actions.length === 0 (schema
    // drift) would previously leave requiresContext=false with an
    // empty actions[] — rendering as "0-step plan" in the UI.
    const validActionsPresent = actions.length > 0;
    const requiresContext =
      Boolean(parsed.requiresContext) || !validActionsPresent;

    // 7b.ii-hotfix-3 — partial-drop diagnostic. Pre-hotfix-3 the warn
    // log only fired when ALL raw actions failed validation; partial
    // drops (the `value: null` path that caused 7 of 9 actions to
    // silently disappear) produced zero log signal. Now we split:
    //   - rawCount > 0, validCount == 0 → full-drop warn (as before)
    //   - rawCount > validCount > 0    → partial-drop warn (new)
    // Each carries the first rejection's Zod issues so future
    // schema-drift bugs surface in logs instead of only in smoke.
    const rawCount = rawActions.length;
    const validCount = actions.length;
    if (rawCount > 0 && validCount === 0) {
      logger.warn(
        {
          runId,
          stepId: "plan",
          rawCount,
          firstRejection: rejections[0]?.issues ?? null,
          responsePreview: result.text.slice(0, 200),
        },
        "[planStep] model returned actions but none passed PlanActionSchema; marking requiresContext=true",
      );
    } else if (rawCount > validCount) {
      logger.warn(
        {
          runId,
          stepId: "plan",
          rawCount,
          validCount,
          droppedCount: rawCount - validCount,
          firstRejection: rejections[0] ?? null,
          responsePreview: result.text.slice(0, 200),
        },
        "[planStep] some actions dropped during PlanActionSchema validation",
      );
    }

    const missingContextRaw = Array.isArray(parsed.missingContext)
      ? (parsed.missingContext as unknown[])
          .map((m) => String(m).slice(0, 200))
          .slice(0, 8)
      : undefined;
    const destructive = Boolean(parsed.destructive);
    const narrative =
      typeof parsed.narrative === "string" ? parsed.narrative : "";

    // week2d Part 3 — inputs extraction with soft-fail: apply-time risk
    // mitigation per Part 3 RFC review. Malformed / non-string values →
    // default to `{}` + log.warn; does NOT fail the whole plan parse.
    let inputs: Record<string, string> = {};
    const rawInputs = parsed.inputs;
    if (rawInputs && typeof rawInputs === "object" && !Array.isArray(rawInputs)) {
      const candidate: Record<string, string> = {};
      let softFailed = false;
      for (const [k, v] of Object.entries(rawInputs as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0 && v.length <= 500) {
          candidate[k] = v;
        } else {
          softFailed = true;
        }
      }
      if (softFailed) {
        logger.warn(
          { runId, keys: Object.keys(rawInputs as Record<string, unknown>) },
          "[planStep] some inputs entries dropped during validation (non-string / empty / oversize); defaulting those keys to absent",
        );
      }
      inputs = candidate;
    } else if (rawInputs !== undefined) {
      logger.warn(
        { runId, rawInputsType: typeof rawInputs },
        "[planStep] inputs field was non-object; defaulting to {}",
      );
    }

    // week2e-dynamic-target-url — Path A+ parse with soft-fail.
    // Sonnet may emit `targetUrl` as:
    //   - a valid http(s) URL → adopt it authoritatively (overrides
    //     ticket.targetUrl if different — reviewer correction path)
    //   - null / undefined → fallback to ticket.targetUrl (if any),
    //     else scaffold's base_url downstream
    //   - malformed → log.warn + fallback (same as null)
    // We DO NOT hard-fail plan on a bad targetUrl; reviewer can
    // correct via Edit-refine.
    let resolvedTargetUrl: string | undefined;
    const rawTargetUrl = parsed.targetUrl;
    if (typeof rawTargetUrl === "string" && rawTargetUrl.length > 0) {
      if (/^https?:\/\//i.test(rawTargetUrl)) {
        try {
          new URL(rawTargetUrl); // parse-check; throws on malformed
          resolvedTargetUrl = rawTargetUrl;
        } catch {
          logger.warn(
            { runId, rawTargetUrl: rawTargetUrl.slice(0, 120) },
            "[planStep] targetUrl failed URL parse; falling back to ticket/scaffold",
          );
        }
      } else {
        logger.warn(
          { runId, rawTargetUrl: rawTargetUrl.slice(0, 120) },
          "[planStep] targetUrl must be http(s); falling back",
        );
      }
    }
    // Default to ticket's targetUrl if Sonnet didn't emit or emitted
    // something invalid.
    if (!resolvedTargetUrl && ticket?.targetUrl) {
      resolvedTargetUrl = ticket.targetUrl;
    }

    // Week-2b-runtime — skill-card resolution.
    //
    // Sonnet's JSON output is expected to include an optional
    // `skillCardName: string | null` field naming a card from the
    // catalog embedded in the system prompt (see `buildSkillCatalog`
    // below). If set to a valid name, the runtime loads that card and
    // uses its authoritative `destructive` flag + populates
    // `skillCardIds` so dry_run / execute can dispatch it via the
    // skill-card executor.
    //
    // Audit #3 (hallucinated skill name): `loadSkill` throws
    // `SkillCardNotFoundError` when Sonnet names a card that doesn't
    // exist on disk. We catch + convert to a `requiresContext: true`
    // fallback with a diagnostic `missingContext` entry so Block 1's
    // retry loop can re-run planStep on the next pass (giving Sonnet
    // a chance to pick a valid name or null). Crashing the run on a
    // stochastic LLM hallucination is NOT acceptable behavior.
    const rawSkillCardName =
      typeof parsed.skillCardName === "string" && parsed.skillCardName.trim()
        ? parsed.skillCardName.trim()
        : null;
    let resolvedSkillCardName: string | null = null;
    let resolvedDestructive = destructive;
    let skillCardResolutionError: string | null = null;

    if (rawSkillCardName) {
      try {
        const loaded = await loadSkill(rawSkillCardName);
        resolvedSkillCardName = rawSkillCardName;
        resolvedDestructive = loaded.skill.destructive;
      } catch (err) {
        if (err instanceof SkillCardNotFoundError) {
          skillCardResolutionError = `planStep picked non-existent skill-card name: ${rawSkillCardName}`;
          logger.warn(
            {
              runId,
              stepId: "plan",
              requestedSkillCardName: rawSkillCardName,
            },
            "[planStep] Sonnet picked unknown skill-card name; converting to requiresContext fallback",
          );
        } else {
          // Unknown loader error (disk failure, malformed YAML on disk
          // that sneaked past validate:skill-cards, etc.) → bubble up
          // to Mastra's exception path. Not a run-recoverable state.
          throw err;
        }
      }
    }

    // If skill-card resolution failed AND Sonnet didn't flag
    // requiresContext, we STILL want to emit requiresContext=true so
    // Block 1 retries (rather than letting dry_run bail on empty
    // skillCardIds, which is a noisier failure mode).
    const effectiveRequiresContext = requiresContext || skillCardResolutionError !== null;
    const effectiveMissingContext: string[] = [
      ...(missingContextRaw ?? []),
      ...(skillCardResolutionError ? [skillCardResolutionError] : []),
    ];

    return {
      planId,
      actionCount: actions.length, // authoritative (derived)
      destructive: resolvedDestructive, // skill-card override if resolved; else LLM-declared
      skillCardIds: resolvedSkillCardName ? [resolvedSkillCardName] : [],
      planText: narrative, // narrative prose for reviewer UI display
      // 7b.iii.b commit 4 (Bug 3A mitigation) — see refusal-path comment above.
      thinking: "",
      classification: inputData.classification,
      actions,
      requiresContext: effectiveRequiresContext,
      ...(effectiveMissingContext.length > 0
        ? { missingContext: effectiveMissingContext }
        : {}),
      inputs, // week2d Part 3 — Sonnet-emitted + soft-failed above
      // week2e-dynamic-target-url — Sonnet-emitted + ticket-fallback
      // resolved above. Omitted entirely when no URL override is in
      // play (scaffold.base_url stays authoritative downstream).
      ...(resolvedTargetUrl ? { targetUrl: resolvedTargetUrl } : {}),
    };
  }
}

const planStep = createStep({
  id: "plan",
  inputSchema: RetrievalSchema,
  outputSchema: PlanSchema,
  execute: ({ inputData }) => runPlanStep(inputData),
});

// ─────────────────────────────────────────────────────────────────
// week2d Part 2 — AGENTIC dry_run (ReAct exploration with browser tools)
// ─────────────────────────────────────────────────────────────────
//
// Replaces week2b-runtime's skill-card-walker preflight with a ReAct
// loop driven by Sonnet + Part 1's `buildBrowserReactTools()` registry.
// The agent explores the target app with browser_navigate / snapshot /
// click / fillForm / takeScreenshot and emits `boundary_reached` when
// it identifies the destructive step. The pre-authored skill card
// is reframed from a walker to a SCAFFOLD (hint; not spec) —
// `formatScaffoldHint` surfaces it in buildSystem.
//
// Preserved invariants (identical to week2b-runtime):
//   - Bug-B hotfix-1 pre-close of ctx.browser before launchBrowser.
//   - ctx.browser = session on OUTER context (CTX SPREAD INVARIANT).
//   - Empty skillCardIds → soft-failure early-out (no browser launch).
//   - SkillCardNotFoundError → soft-failure anomaly.
//
// Parallel-operation (Part 2 scope only): execute + verify still walk
// the pre-authored skill card via loadSkill(plan.skillCardIds[0]).
// Part 3 wires execute/verify to consume actionTrace via the new
// materialize_skill_card step.

/** week2d Part 2 — resolves the DRY_RUN_MAX_ITERATIONS env override.
 *  Clamped [1..50]; invalid / missing values fall through to 15. env.ts
 *  also validates at boot, so a bad value in .env fails loud before any
 *  run starts — this is the at-call-site read for clamp safety. */
function resolveDryRunMaxIterations(): number {
  const raw = process.env.DRY_RUN_MAX_ITERATIONS;
  if (!raw) return 15;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 50) return 15;
  return Math.floor(n);
}

/** Cap list lengths so a pathological skill-card author can't bloat
 *  the user message beyond the Anthropic context budget. */
const SCAFFOLD_HINT_MAX_FIELDS = 6;

/** Extract field names from a fillForm step's args. Values are
 *  intentionally omitted (scaffold-as-hint principle — the agent
 *  re-derives values from today's UI). */
function formatFillFormFields(fields: unknown): string {
  if (!Array.isArray(fields) || fields.length === 0) return "";
  const names = fields
    .map((f) => (f as { name?: string })?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .slice(0, SCAFFOLD_HINT_MAX_FIELDS);
  return names.length > 0 ? ` → [${names.join(", ")}]` : "";
}

/** Surface the scaffold's step shape as hint text — tool + element
 *  (+ fillForm field names) but NOT pre-authored args.value. Agent
 *  must re-derive today's UI values via browser_snapshot. Reviewer
 *  nudge folded in: field names help the agent avoid 1 extra
 *  iteration per fillForm spent on field discovery. */
function formatScaffoldHint(skill: Skill): string {
  return skill.steps
    .map((step, i) => {
      const idx = String(i + 1).padStart(2, " ");
      const args = step.args as Record<string, unknown> | undefined;
      const element =
        typeof args?.element === "string"
          ? args.element
          : typeof args?.url === "string"
            ? args.url
            : "";
      const fillFormHint =
        step.tool === "fillForm" ? formatFillFormFields(args?.fields) : "";
      const destMark = step.destructive
        ? " [DESTRUCTIVE — call boundary_reached here, do NOT click]"
        : "";
      const elementFmt = element ? ` → "${element}"` : "";
      return `${idx}. ${step.tool}${elementFmt}${fillFormHint}${destMark}`;
    })
    .join("\n");
}

/** week2d Part 2 — closed-over deps for the ReAct config. The
 *  scaffold + baseUrl are resolved once per dry_run invocation
 *  (outside the runner) so scaffold-loading errors fall through
 *  to a clean DryRunSchema soft-fail instead of poisoning the loop
 *  mid-iteration. */
interface DryRunDeps {
  scaffold: Skill;
  baseUrl: string;
  ticketSubject: string;
  ticketId: string;
  category: string;
  urgency: string;
  /** week2d Part 2 hotfix-1 — observations carried forward from
   *  refine/backtrack loops, threaded via runBlock1's opts.seedObservations
   *  → runDryRunStep's 3rd param. Surfaced to Sonnet in buildUserMessage
   *  so reviewer corrections (e.g., "target is leo not jane") actually
   *  alter the dry_run agent's browser exploration. Without this, the
   *  refine loop updates plan.inputs but dry_run re-walks the original
   *  ticket's flow (surfaced by live behavior-shift smoke run
   *  c43f514c-9742-438a-8dfd-14073f659df7). */
  priorObservations: string[];
}

function buildDryRunStepConfig(
  deps: DryRunDeps,
): CreateReActStepArgs<z.infer<typeof PlanSchema>, z.infer<typeof DryRunSchema>> {
  const scaffoldHint = formatScaffoldHint(deps.scaffold);
  return {
    id: "dry_run" as const,
    inputSchema: PlanSchema,
    outputSchema: DryRunSchema,
    tier: "sonnet" as const,
    thinkingEnabled: false,
    maxIterations: resolveDryRunMaxIterations(),
    tools: buildBrowserReactTools(),
    buildSystem: () =>
      `Explore ${deps.baseUrl} to accomplish this ticket. You have browser ` +
      `tools (browser_navigate, browser_snapshot, browser_click, ` +
      `browser_fillForm, browser_takeScreenshot) and a boundary_reached ` +
      `signal.\n\n` +
      `Scaffold hint (similar flow — use as reference for shape and for ` +
      `the destructive step; adapt to TODAY's UI by calling browser_snapshot ` +
      `and observing actual element names + refs):\n${scaffoldHint}\n\n` +
      `Required behaviors:\n` +
      `- Call browser_snapshot BEFORE any click or fillForm to discover refs.\n` +
      `- BEFORE calling boundary_reached, ensure any confirmation checkboxes, ` +
      `warning acknowledgments, or required form inputs on the destructive ` +
      `page are engaged (e.g. an "I confirm" checkbox must be ticked, a ` +
      `"type DELETE to confirm" input must be filled). The destructive button ` +
      `is often DISABLED until these preconditions are satisfied; if the ` +
      `button looks disabled in your snapshot (greyed out, aria-disabled, ` +
      `etc.), interact with the preconditions FIRST via click/fillForm, then ` +
      `snapshot again to confirm the button is enabled before proceeding.\n` +
      `- When you identify the destructive step (the final confirm button that ` +
      `commits the mutation), call boundary_reached — DO NOT click the ` +
      `destructive element.\n` +
      `- Pass scaffoldMatch: true if the element matches the scaffold's ` +
      `declared destructive step name; false if UI-drift produced a ` +
      `differently-named-but-same-intent element; omit if unsure.\n\n` +
      `No preamble. No narration about iterations. Act.`,
    buildUserMessage: (plan) =>
      observationsPrefix(deps.priorObservations) +
      `Ticket: ${deps.ticketSubject || "(no subject)"}\n` +
      `Ticket ID: ${deps.ticketId}\n` +
      `Category: ${deps.category}\n` +
      `Urgency: ${deps.urgency}\n` +
      `Plan inputs (authoritative — use these EXACT values for any ` +
      `credentials, target user, or template-substitution values you ` +
      `encounter during exploration; the reviewer may have corrected ` +
      `the original ticket):\n` +
      (Object.keys(plan.inputs).length > 0
        ? Object.entries(plan.inputs)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n")
        : "  (none)") +
      `\n\nPlan outline (${plan.actions.length} actions):\n` +
      plan.actions
        .slice(0, 10)
        .map((a, i) => `  ${i + 1}. ${a.verb} → ${a.target}`)
        .join("\n") +
      `\n\nBegin exploring. Snapshot first to discover the page structure.`,
    produceOutput: (iterations, plan) => {
      const actionTrace: z.infer<typeof DryRunActionSchema>[] = [];
      let boundaryReached: z.infer<typeof BoundaryReachedSchema> | null = null;

      for (const iter of iterations) {
        const call = iter.toolCall;
        if (!call) continue;

        if (call.name === "boundary_reached") {
          const out = call.output as {
            element: string;
            reason: string;
            scaffoldMatch: boolean | null;
          };
          boundaryReached = {
            element: out.element,
            reason: out.reason,
            scaffoldMatch: out.scaffoldMatch,
            iteration: iter.iteration,
          };
          continue;
        }

        if (
          call.name === "browser_navigate" ||
          call.name === "browser_snapshot" ||
          call.name === "browser_click" ||
          call.name === "browser_fillForm" ||
          call.name === "browser_takeScreenshot"
        ) {
          actionTrace.push({
            tool: call.name,
            args: call.input as Record<string, unknown>,
          });
        }
        // Unknown tool names (impossible via Part 1 registry) skipped.
      }

      const isExhausted = boundaryReached === null;
      const anomalies: string[] = isExhausted
        ? [
            `Exhausted ${iterations.length} iteration${iterations.length === 1 ? "" : "s"} ` +
              `without identifying a destructive boundary. The agent explored ` +
              `but could not confidently flag the destructive step.`,
          ]
        : [];

      return {
        domMatches: !isExhausted,
        anomalies,
        plan,
        actionTrace,
        boundaryReached,
      };
    },
  };
}

/** 7b.iii.a — extracted dryRunStep body so the Block 1 controller can
 *  invoke it directly (outside Mastra's step-execution machinery).
 *  week2d Part 2 — body rewritten to delegate to the ReAct runner
 *  after preserving the week2b-runtime session-entry invariants. */
export async function runDryRunStep(
  inputData: z.infer<typeof PlanSchema>,
  abortSignal: AbortSignal | undefined,
  priorObservations: string[] = [],
): Promise<z.infer<typeof DryRunSchema>> {
  const ctx = getRunContext();
  const { runId, bus, ticket } = ctx;

  // ── Bug-B hotfix-1 pre-close (INVARIANT — preserve verbatim) ───
  // Profile-lock collision prevention across intra-Block-1 multi-pass,
  // refine re-invocations, and post-exec backtrack re-runs.
  if (ctx.browser) {
    try {
      await ctx.browser.close();
    } catch {
      // Prior session already dead; lock released regardless.
    }
    ctx.browser = undefined;
  }

  // Early-out: no scaffold picked.
  if (inputData.skillCardIds.length === 0) {
    return {
      domMatches: false,
      anomalies: [
        "planStep did not select a skill card; dry_run cannot dispatch.",
      ],
      plan: inputData,
      actionTrace: [],
      boundaryReached: null,
    };
  }

  // Load scaffold BEFORE launching the browser — scaffold-loading
  // errors should not leak a live Chromium subprocess.
  let scaffold: Skill;
  let baseUrl: string;
  try {
    const loaded = await loadSkill(inputData.skillCardIds[0]!);
    scaffold = loaded.skill;
    // week2e-dynamic-target-url — resolution precedence:
    //   1. plan.targetUrl (set by plan step from Sonnet Path A+ or
    //      ticket.targetUrl fallback at parse time)
    //   2. scaffold's declared base_url
    // Keeps scaffold URL as the last-resort default so existing
    // smoke paths (no ticket override) behave identically to week2d.
    baseUrl = inputData.targetUrl ?? loaded.card.base_url;
  } catch (err) {
    if (err instanceof SkillCardNotFoundError) {
      return {
        domMatches: false,
        anomalies: [`skill card '${err.skillName}' no longer loadable`],
        plan: inputData,
        actionTrace: [],
        boundaryReached: null,
      };
    }
    throw err;
  }

  // Launch + assign on OUTER ctx (CTX SPREAD INVARIANT — session
  // MUST propagate to executeStep's liveness probe).
  const session = await launchBrowser({
    runId,
    bus,
    stepId: "dry_run",
    signal: abortSignal,
  });
  ctx.browser = session;

  // Delegate to ReAct runner. Browser tools read ctx.browser at
  // invoke time; session is live because we just assigned it.
  // produceOutput aggregates iterations → DryRunSchema.
  return runReActIterations<
    z.infer<typeof PlanSchema>,
    z.infer<typeof DryRunSchema>
  >(
    inputData,
    abortSignal,
    buildDryRunStepConfig({
      scaffold,
      baseUrl,
      ticketSubject: ticket?.subject ?? "",
      ticketId: ticket?.ticketId ?? "(unknown)",
      category: inputData.classification.category,
      urgency: inputData.classification.urgency,
      priorObservations,
    }),
  );
}

const dryRunStep = createStep({
  id: "dry_run",
  inputSchema: PlanSchema,
  outputSchema: DryRunSchema,
  execute: ({ inputData, abortSignal }) => runDryRunStep(inputData, abortSignal),
});

// ─────────────────────────────────────────────────────────────────
// week2d Part 3 — `materialize_skill_card` step.
// ─────────────────────────────────────────────────────────────────
//
// Converts the agent's dry_run `actionTrace` + `boundaryReached` into
// an ephemeral `Skill` stored on `ctx.tempSkillCard`. Execute walks
// that skill (Part 3b wires the switch). Verify reads its
// postconditions (Part 3c).
//
// CRITICAL MENTAL MODEL — the destructive-append contract:
//   `boundary_reached` fires BEFORE the destructive click, so
//   `actionTrace` contains ONLY non-destructive pre-destructive steps.
//   The destructive action exists ONLY as metadata in
//   `boundaryReached.element`/`.reason`. The materializer APPENDS a
//   synthesized destructive click step from `boundaryReached.element`
//   as the final step of the ephemeral skill. A naive 1-to-1 mapping
//   would produce a skill with zero `destructive: true` steps, which
//   executeSkillCardSteps (with `resumeAtFirstDestructive: true`)
//   would no-op on — killing P1 smoke on arrival. See
//   reactBrowserTools.ts boundary_reached docstring + Part 3 RFC §4.

/** Anthropic tool names → `SkillStep.tool` enum. */
const REACT_TO_SKILL_TOOL_MAP: Record<string, Skill["steps"][number]["tool"]> = {
  browser_navigate: "navigate",
  browser_snapshot: "snapshot",
  browser_click: "click",
  browser_fillForm: "fillForm",
  browser_takeScreenshot: "takeScreenshot",
};

/** Part 2 click-arg `ref` is ephemeral (snapshot-scoped). Skill-card
 *  executor re-resolves refs at dispatch time via `resolveClickRef` —
 *  stale refs are dead weight. Strip for cleaner materialized args. */
function stripEphemeralRef(args: Record<string, unknown>): Record<string, unknown> {
  const { ref: _ref, ...rest } = args as { ref?: unknown; [k: string]: unknown };
  return rest;
}

/** Replace verbatim-match literals in a string with
 *  `{{ inputs.<key> }}` placeholders. First-declared-wins on
 *  collision (iteration order of `Object.entries(inputs)`). */
function substituteInputsInStringArg(
  value: string,
  inputs: Record<string, string>,
): string {
  for (const [key, v] of Object.entries(inputs)) {
    if (v && value === v) return `{{ inputs.${key} }}`;
  }
  return value;
}

/** Walk args tree; for each string leaf, apply
 *  `substituteInputsInStringArg`. Non-string leaves passthrough. */
function substituteInputsInArgs(
  args: Record<string, unknown>,
  inputs: Record<string, string>,
): Record<string, unknown> {
  function walk(v: unknown): unknown {
    if (typeof v === "string") return substituteInputsInStringArg(v, inputs);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v)) out[k] = walk(vv);
      return out;
    }
    return v;
  }
  return walk(args) as Record<string, unknown>;
}

/** Map ReAct `DryRunAction[]` + boundaryReached → `SkillStep[]`.
 *  Appends synthesized destructive click from `boundaryReached.element`
 *  after the non-destructive prefix (see critical mental model above). */
function materializeSteps(
  actionTrace: z.infer<typeof DryRunActionSchema>[],
  boundaryReached: z.infer<typeof BoundaryReachedSchema> | null,
  inputs: Record<string, string>,
): Skill["steps"] {
  const baseSteps: Skill["steps"] = actionTrace.map((a) => ({
    tool: REACT_TO_SKILL_TOOL_MAP[a.tool]!,
    args: substituteInputsInArgs(stripEphemeralRef(a.args), inputs),
    destructive: false,
  }));

  if (boundaryReached) {
    baseSteps.push({
      tool: "click",
      args: {
        element: substituteInputsInStringArg(boundaryReached.element, inputs),
      },
      destructive: true,
    });
  }
  // Exhaustion path (boundaryReached === null): caller throws per
  // §11 #4. baseSteps returned as-is for observability; execute would
  // no-op + verify hard-fail.
  return baseSteps;
}

/** Infer SkillInput metadata from a value string when scaffold didn't
 *  declare the key. Value-shape heuristics only — runtime template
 *  engine doesn't use the metadata, so this just seeds a better audit
 *  artifact. */
function inferSkillInputFromValue(value: string): SkillInput {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { type: "email", required: true };
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return { type: "uuid", required: true };
  }
  return { type: "string", required: true };
}

/** Derive ephemeral skill's `inputs:` block. Inherits scaffold's
 *  author-declared metadata when available (description, type hints,
 *  required-ness); infers only for keys the scaffold doesn't declare.
 *  Preserves curated metadata = better audit artifact. */
function deriveSkillInputs(
  planInputs: Record<string, string>,
  scaffoldInputs: Record<string, SkillInput> | undefined,
): Record<string, SkillInput> {
  const result: Record<string, SkillInput> = {};
  for (const [key, value] of Object.entries(planInputs)) {
    result[key] = scaffoldInputs?.[key] ?? inferSkillInputFromValue(value);
  }
  return result;
}

/** Walk scaffold.steps for the first step with `destructive: true`;
 *  return its `args.element` (or `args.url` for navigate destructive
 *  steps, which is unusual but possible). Fallback to scaffold.name
 *  if no step is marked destructive (defensive — shouldn't happen per
 *  skill-card loader cross-field assert). */
function findScaffoldDestructiveElement(scaffold: Skill): string {
  for (const step of scaffold.steps) {
    if (!step.destructive) continue;
    const args = step.args as Record<string, unknown>;
    if (typeof args.element === "string") return args.element;
    if (typeof args.url === "string") return args.url;
  }
  return scaffold.name;
}

/** Extracted materialize body — Part 3's `materializeSkillCardStep`
 *  Mastra wrapper delegates to this (extracting `.dryRun` from its
 *  ReviewSchema input); humanVerifyGateStep's backtrack loop
 *  direct-invokes it with the gate's ReviewSchema output.
 *
 *  `review` is threaded through onto the output so downstream
 *  `runExecuteStep` can detect the skip-cascade path via
 *  `review.approved === false`. Callers that don't need the
 *  skip-cascade semantic (unit tests, synthetic scenarios) can pass
 *  a happy-path review stub — see `materializeSkillCard.test.ts`. */
export async function runMaterializeSkillCardStep(
  inputData: z.infer<typeof DryRunSchema>,
  review: z.infer<typeof ReviewSchema>,
): Promise<z.infer<typeof MaterializeSchema>> {
  const ctx = getRunContext();
  const { plan, actionTrace, boundaryReached } = inputData;

  // Defensive: exhausted dry_run → UI should have disabled Approve
  // (Part 0 §7 Part 4 guard). If we're here, that guard failed; throw.
  if (!boundaryReached) {
    throw new Error(
      "[materialize] dry_run exhausted without boundary_reached; approve-on-exhausted is a UI-bug.",
    );
  }

  // Load scaffold for divergence detection + postcondition inheritance
  // + baseUrl plumbing (resolution of Part 3 RFC §11 #1).
  if (plan.skillCardIds.length === 0) {
    throw new Error("[materialize] plan.skillCardIds is empty; cannot resolve scaffold.");
  }
  const loaded = await loadSkill(plan.skillCardIds[0]!);
  const scaffold = loaded.skill;

  // Divergence = scaffoldMatch explicitly false. null (agent omitted)
  // is NOT divergence — reviewer decides at the gate.
  const divergence: z.infer<typeof DivergenceSchema> | null =
    boundaryReached.scaffoldMatch === false
      ? {
          expected: findScaffoldDestructiveElement(scaffold),
          actual: boundaryReached.element,
          reason: boundaryReached.reason,
        }
      : null;

  // Build ephemeral skill from actionTrace + inputs + append
  // synthesized destructive click.
  const steps = materializeSteps(actionTrace, boundaryReached, plan.inputs);
  const ephemeralSkill: Skill = {
    name: `${scaffold.name}_materialized`,
    description: scaffold.description,
    destructive: plan.destructive,
    inputs: deriveSkillInputs(plan.inputs, scaffold.inputs),
    preconditions: scaffold.preconditions,
    postconditions: scaffold.postconditions,
    steps,
  };

  // Validate — materialized card conforms to existing SkillSchema.
  const parsed = SkillSchema.safeParse(ephemeralSkill);
  if (!parsed.success) {
    throw new Error(
      `[materialize] ephemeral skill failed SkillSchema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  // Side effect: write to RunContext for downstream execute + verify.
  // Outer-scope assignment — tempSkillCard is read-only-safe-to-spread
  // (see CTX SPREAD INVARIANT), but this is the WRITE site so it must
  // land on the outer ctx, not a spread copy.
  ctx.tempSkillCard = parsed.data;

  // week2d Part 3b — persist to Postgres with the convention name
  // <sanitized-hostname>_<scaffold-name>_<uuid>. The UUID is fresh
  // per materialization and doubles as the future Qdrant collection
  // UUID (embedding deferred). Persistence is non-blocking: failures
  // log.warn but don't abort the run (ephemeral ctx.tempSkillCard is
  // what execute reads; DB row is audit only).
  // week2e-dynamic-target-url — resolve effective baseUrl with same
  // precedence runDryRunStep used: plan.targetUrl (reviewer/ticket)
  // wins, else scaffold. Persisted to materialized_skills.base_url
  // AND surfaced on MaterializeSchema.baseUrl so execute uses the
  // corrected origin when it walks the skill.
  const effectiveBaseUrl = plan.targetUrl ?? loaded.card.base_url;

  const skillId = randomUUID();
  const skillName = buildMaterializedSkillName(
    effectiveBaseUrl,
    scaffold.name,
    skillId,
  );
  await insertMaterializedSkill({
    id: skillId,
    name: skillName,
    runId: ctx.runId,
    scaffoldName: scaffold.name,
    baseUrl: effectiveBaseUrl,
    skill: parsed.data,
    divergence,
  });

  return {
    skill: parsed.data,
    skillId,
    skillName,
    baseUrl: effectiveBaseUrl,
    divergence,
    dryRun: inputData,
    review,
  };
}

const materializeSkillCardStep = createStep({
  id: "materialize_skill_card",
  // Mastra-chain input is reviewGateStep's output (ReviewSchema).
  // Wrapper extracts `.dryRun` for the materialize body; threads
  // the full ReviewSchema through as `review` for downstream
  // skip-cascade detection.
  inputSchema: ReviewSchema,
  outputSchema: MaterializeSchema,
  execute: async ({ inputData }) => {
    if (!inputData.approved) {
      // Skip-cascade path — synthesize a minimal valid MaterializeSchema
      // without invoking the materialize body OR the DB persistence.
      // runExecuteStep checks `inputData.review.approved` before reading
      // .skill. skillId + skillName use deterministic sentinels so
      // downstream code (including future grep tools) can distinguish
      // skipped materializations from real ones.
      const skippedId = randomUUID();
      return {
        skill: MINIMAL_SKIPPED_SKILL,
        skillId: skippedId,
        skillName: `skipped_${skippedId}`,
        baseUrl: "http://skipped.invalid/",
        divergence: null,
        dryRun: inputData.dryRun,
        review: inputData,
      };
    }
    return runMaterializeSkillCardStep(inputData.dryRun, inputData);
  },
});

/** 7b.iii.b — extracted reviewGate body so humanVerifyGateStep
 *  (commit 3) can re-invoke the pre-execute review on a backtrack
 *  iteration. `reviewHint` defaults to "pre_exec" for the
 *  Mastra-driven workflow path.
 *
 *  7b.iii.b commit 2 — refine loop: on `decision === "edit"`,
 *  synthesize observations from `patch.notes` and re-run Block 1
 *  with them threaded into `RunContext.priorObservations`. Emits
 *  `block.backtrack.triggered { fromStep: "review_gate" }` on each
 *  refine — same envelope variant commit 3's post-exec backtrack
 *  uses, discriminated by `fromStep`.
 *
 *  Cap: `MAX_PRE_GATE_REFINES = 2` → slot 0 (initial) + slot 1
 *  (refine #1) + slot 2 (refine #2) = 3 total slots. 3rd edit trips
 *  the cap and terminates as reject via the existing reject path
 *  (executeStep.skipped → verifyStep.skipped → logAndNotifyStep
 *  status=rejected). */
export async function runReviewGateStep(
  inputData: z.infer<typeof DryRunSchema>,
  opts: {
    /** Test seam — production callers pass nothing and the real
     *  `runBlock1` from blockController is used. Tests inject a stub
     *  to observe invocation count and per-refine priorObservations. */
    runBlock1Fn?: typeof runBlock1;
    abortSignal?: AbortSignal;
  } = {},
): Promise<z.infer<typeof ReviewSchema>> {
  const ctx = getRunContext();
  const { runId, bus, ticket } = ctx;
  const runBlock1Impl = opts.runBlock1Fn ?? runBlock1;

  let currentDryRun = inputData;
  let refineCount = 0;

  // Refine loop. Terminates by return on approve, reject, or
  // cap-trip; no other exit paths.
  while (true) {
    bus.publish({
      runId,
      stepId: "review_gate",
      payload: {
        type: "review.requested",
        plan: {
          planId: currentDryRun.plan.planId,
          actionCount: currentDryRun.plan.actionCount,
          destructive: currentDryRun.plan.destructive,
          skillCardIds: currentDryRun.plan.skillCardIds,
        },
        screenshots: [`playwright-videos/${runId}/dry_run-users.png`],
        viewerUrl: "http://localhost:6080",
        requiresApproval: true,
        reviewHint: "pre_exec",
        // 7b.iii.a — forward the Block 1 controller's result when
        // the inbound DryRunSchema carries it (exhausted-passes
        // path). Also fires on refined passes if refine exhausted.
        ...(currentDryRun.blockResult
          ? { blockResult: currentDryRun.blockResult }
          : {}),
      },
    });

    const decision = await bus.awaitDecisionForStep(runId, "review_gate");

    if (decision.decision === "approve") {
      return { decision: "approve", approved: true, dryRun: currentDryRun };
    }

    // Week-2a gate-decision-model — terminate short-circuits to the
    // skip cascade (executeStep.skipped → verifyStep.skipped →
    // logAndNotifyStep status=rejected). This is the mechanism
    // pre-week2a "reject" used verbatim; repurposed under the
    // clearer name. Browser cleanup via http/triage.ts:213-219
    // finally block fires on any return path so no special teardown
    // needed here.
    if (decision.decision === "terminate") {
      return {
        decision: "terminate",
        approved: false,
        dryRun: currentDryRun,
      };
    }

    // decision.decision === "edit" OR decision.decision === "reject"
    //   — both route into the refine loop. The difference is the
    //   seed observation that goes into Block 1's priorObservations:
    //     edit   → reviewer's patch.notes (if present) or
    //              edit-without-notes fallback copy.
    //     reject → reject-without-notes directive copy (more
    //              prescriptive: "take a different approach").
    //   Both share the MAX_PRE_GATE_REFINES budget — a mix of edits
    //   and rejects counts against the same cap (3 total refine
    //   cycles per run).
    if (refineCount >= MAX_PRE_GATE_REFINES) {
      // Week-2a gate-decision-model — cap trip terminates cleanly
      // via the new terminate mechanism (same skip-cascade as an
      // explicit reviewer Terminate click). Pre-week2a returned
      // decision="reject" which used the same mechanism but
      // conflated reviewer-initiated full-stop with "reject =
      // replan." The new model separates them.
      logger.warn(
        { runId, refineCount, max: MAX_PRE_GATE_REFINES },
        "[review_gate] pre-exec refine budget exhausted; terminating",
      );
      return {
        decision: "terminate",
        approved: false,
        dryRun: currentDryRun,
      };
    }

    if (!ticket) {
      // Defensive — http/triage.ts always sets ticket on RunContext
      // at workflow kickoff. If somehow absent, we can't re-run
      // Block 1; terminate cleanly rather than crash.
      logger.error(
        { runId },
        "[review_gate] RunContext.ticket undefined; cannot refine. Terminating.",
      );
      return {
        decision: "terminate",
        approved: false,
        dryRun: currentDryRun,
      };
    }

    refineCount++;
    const carriedContext = buildPreGateRefineContext(
      decision.patch?.notes,
      refineCount,
      decision.decision === "reject" ? "reject" : "edit",
    );

    bus.publish({
      runId,
      stepId: "review_gate",
      payload: {
        type: "block.backtrack.triggered",
        fromStep: "review_gate",
        toBlock: "block1",
        carriedContext,
        backtrackCount: refineCount,
      },
    });

    // 7b.iii.b-pre-exec-edit-ui-hotfix-2 — re-run Block 1 with the
    // carried reviewer note threaded through `opts.seedObservations`.
    //
    // NO withRunContext spread here. The spread pattern
    // (`withRunContext({ ...ctx, priorObservations: carriedContext },
    // () => runBlock1Impl(...))`) that this code originally used
    // was doubly broken:
    //   (a) It had no effect. Block 1's internal cognitive spread
    //       at blockController.ts overrides `ctx.priorObservations`
    //       with its own accumulator (starts empty). The reviewer's
    //       note was silently dropped before reaching any LLM call.
    //   (b) It re-introduced Bug A (spread-mutation loss) at a
    //       second scope boundary. `runDryRunStep`'s
    //       `getRunContext().browser = session` mutation landed on
    //       the spread copy, not outer_ctx. When the spread
    //       unwound, outer_ctx.browser still pointed at the PRIOR
    //       session (which hotfix-1's pre-close had already
    //       closed). `executeStep` then read a closed-session
    //       reference and crashed with "cannot invoke
    //       playwright.browser_snapshot: session already closed".
    //
    // Passing `seedObservations` instead keeps `runBlock1` running
    // in the outer_ctx scope, so:
    //   - `runDryRunStep`'s browser-session mutation propagates
    //     correctly to `executeStep` (Bug 4 fix);
    //   - the reviewer's note actually reaches the LLM via Block
    //     1's internal observations accumulator (dormant note-loss
    //     fix).
    //
    // 7b.iii.b commit 4 — wrap the refine's Block 1 invocation in
    // synthetic `block1` step.started/completed frames so the LEFT
    // column's <StepOutcome> picks up refined state via its
    // `findLast` read (Piece D.2). Mastra's own stepEmitter only
    // fires block1 frames for the INITIAL block1Step.execute; the
    // refine bypasses the Mastra engine and must emit its own.
    // Hotfix-2 smoke's SQL proved the staleness directly: block1's
    // step.completed.output.plan.planId was frozen at the initial
    // plan even after a distinct refined review.requested.
    const refineBlock1StartedAt = Date.now();
    bus.publish({
      runId,
      stepId: "block1",
      payload: { type: "step.started", input: ticket },
    });

    const nextBlock = await runBlock1Impl(ticket, buildBlock1Deps(), {
      abortSignal: opts.abortSignal,
      seedObservations: carriedContext,
    });

    currentDryRun = block1ResultToDryRun(nextBlock);

    bus.publish({
      runId,
      stepId: "block1",
      payload: {
        type: "step.completed",
        output: currentDryRun,
        durationMs: Date.now() - refineBlock1StartedAt,
      },
    });

    // Loop: emit fresh review.requested + await new decision.
  }
}

const reviewGateStep = createStep({
  id: "review_gate",
  inputSchema: DryRunSchema,
  outputSchema: ReviewSchema,
  execute: ({ inputData, abortSignal }) =>
    runReviewGateStep(inputData, { abortSignal }),
});

const executeStep = createStep({
  id: "execute",
  // week2d Part 3 — chain shifted: materialize emits MaterializeSchema.
  inputSchema: MaterializeSchema,
  outputSchema: ExecuteSchema,
  execute: ({ inputData }) => runExecuteStep(inputData),
});

/** 7b.iii.b — extracted executeStep body so humanVerifyGateStep can
 *  re-invoke it on a backtrack. Direct-call bypass of Mastra's
 *  engine is consistent with runReviewGateStep / runVerifyStep.
 *
 *  week2d Part 3 — input swapped from ReviewSchema to MaterializeSchema.
 *  Skill comes from `ctx.tempSkillCard` (written by materialize);
 *  baseUrl comes from `inputData.baseUrl` (forwarded from scaffold,
 *  resolution of Part 3 RFC §11 #1 — no scaffold re-load here).
 *  `inputData.review` preserves the skip-cascade check that was
 *  previously driven by `inputData.approved` on ReviewSchema. */
export async function runExecuteStep(
  inputData: z.infer<typeof MaterializeSchema>,
): Promise<z.infer<typeof ExecuteSchema>> {
  {
    const ctx = getRunContext();
    const { runId, bus } = ctx;
    const review = inputData.review;

    if (!review.approved) {
      // Rejection path: same semantic as pre-Part-3 — skipped flag
      // cascades through verify/log_and_notify → run.completed
      // { status: "rejected" }.
      return { stepsRun: 0, skipped: true, review };
    }

    // week2d Part 3 — session handling UNCHANGED from week2b-runtime
    // (liveness-probe + three branches). Only the INPUT SOURCE changed:
    //   - Was:  loadSkill(plan.skillCardIds[0])    (loaded scaffold)
    //   - Now:  ctx.tempSkillCard                   (materialized skill)
    //   - baseUrl: was loaded.card.base_url        (scaffold re-load)
    //              now inputData.baseUrl           (materialize forward)
    //
    // The materialized skill's trailing step is the destructive click
    // appended from boundaryReached.element, so `resumeAtFirstDestructive:
    // true` on the reused-session path fast-forwards straight to it.

    const skill = ctx.tempSkillCard;
    if (!skill) {
      // Defensive — materialize always runs before execute on the
      // approve path. If we hit this, a future refactor bypassed
      // materialize.
      logger.error(
        { runId },
        "[execute] ctx.tempSkillCard missing; cannot dispatch",
      );
      return { stepsRun: 0, skipped: false, review };
    }

    const existing = ctx.browser;
    let session: BrowserSession;
    let resumeAtFirstDestructive: boolean;

    if (existing) {
      // Tag the session with the execute stepId BEFORE the probe so
      // the probe's tool.started/tool.completed frames attribute to
      // execute (not stale dry_run). If the probe fails we close this
      // session immediately anyway; the mutation costs nothing.
      existing.setStepId("execute");
      try {
        await existing.snapshot();
        session = existing;
        resumeAtFirstDestructive = true;
        logger.info(
          { runId },
          "[execute] reusing live dry_run session; resuming at first destructive step",
        );
      } catch (err) {
        logger.warn(
          { runId, err: (err as Error).message },
          "[execute] dry_run session is dead; falling back to fresh launch",
        );
        try {
          await existing.close();
        } catch {
          // Prior transport already dead; profile lock released.
        }
        ctx.browser = undefined;
        session = await launchBrowser({
          runId,
          bus,
          stepId: "execute",
          // Pre-existing polish-queue gap: runExecuteStep's Mastra
          // wrapper doesn't forward abortSignal; tracked separately.
          signal: undefined,
        });
        ctx.browser = session;
        resumeAtFirstDestructive = false;
      }
    } else {
      session = await launchBrowser({
        runId,
        bus,
        stepId: "execute",
        signal: undefined,
      });
      ctx.browser = session;
      resumeAtFirstDestructive = false;
    }

    let stepsRun = 0;
    try {
      // week2d Part 3 — inputs come from plan.inputs (populated by
      // 3b's plan prompt update); materialized skill's template
      // placeholders (`{{ inputs.X }}`) resolve via these values.
      // No extractInputsForSkill fallback needed — materializer only
      // sets placeholders for keys actually in plan.inputs.
      const inputs = inputData.dryRun.plan.inputs;
      const tctx: TemplateContext = { inputs };

      const result: ExecuteSkillResult = await executeSkillCardSteps(
        skill,
        {
          preflight: false,
          resumeAtFirstDestructive,
          ctx: tctx,
          session,
          baseUrl: inputData.baseUrl,
        },
      );
      stepsRun = result.stepsRun;
      if (result.anomalies.length > 0) {
        // bug-2a fix — executor captured PlaywrightMcpError mid-flow
        // and returned partial stepsRun. Surface for ops; the session
        // wrapper already emitted tool.failed for the UI.
        logger.warn(
          { runId, anomalies: result.anomalies, stepsRun },
          "[execute] skill-card aborted mid-flow; partial stepsRun recorded",
        );
      }
    } catch (err) {
      // week2d Part 3 — SkillCardNotFoundError no longer fires here
      // (scaffold is loaded in materialize, not execute). Keep the
      // catch defensive in case executor wraps an unexpected error.
      logger.error(
        { runId, err: (err as Error).message },
        "[execute] unexpected failure during skill-card dispatch",
      );
      throw err;
    }

    return { stepsRun, skipped: false, review };
  }
}

const verifyStep = createStep({
  id: "verify",
  inputSchema: ExecuteSchema,
  outputSchema: VerifySchema,
  execute: ({ inputData }) => runVerifyStep(inputData),
});

/** 7b.iii.b — extracted verifyStep body so humanVerifyGateStep can
 *  re-invoke it on a backtrack.
 *
 *  week2d Part 3c — REDESIGNED as structured postcondition comparison
 *  (no ReAct, no `/verified/i` regex). Flow:
 *
 *    1. Skip cascade:       inputData.skipped → pass-through
 *    2. Hard-fail guard:    stepsRun===0 && !skipped → success: false
 *                           BEFORE any LLM call (Polish-queue #2 fold —
 *                           closes the hallucination surface where
 *                           Sonnet's regex-matched /verified/i on a
 *                           0-step executeStep falsely reported ok).
 *    3. Structured judge:   read ctx.tempSkillCard.postconditions +
 *                           a fresh browser snapshot; single Sonnet
 *                           call returns {success, evidence[]} as JSON.
 *    4. Fallback:           if no postconditions declared OR no browser
 *                           session, degrade to success=(stepsRun > 0)
 *                           with an observability evidence entry. */
export async function runVerifyStep(
  inputData: z.infer<typeof ExecuteSchema>,
): Promise<z.infer<typeof VerifySchema>> {
  const ctx = getRunContext();
  const { runId, bus } = ctx;

  // 1) Skip cascade — unchanged pre-3c behavior.
  if (inputData.skipped) {
    return {
      success: false,
      skipped: true,
      evidence: [],
      execute: inputData,
    };
  }

  // 2) Hard-fail guard — polish-queue #2 fold (closed in Part 3c).
  //    Runs BEFORE the LLM call so verify can't hallucinate "verified"
  //    on a 0-step executeStep (7b.iii.b meta-observation).
  if (inputData.stepsRun === 0) {
    logger.warn(
      { runId, stepsRun: 0, reviewDecision: inputData.review.decision },
      "[verify] hard-fail: stepsRun=0 && !skipped (polish #2 guard)",
    );
    return {
      success: false,
      skipped: false,
      evidence: ["executeStep ran 0 steps; no mutation could have occurred"],
      execute: inputData,
    };
  }

  const skill = ctx.tempSkillCard;
  const postconditions = skill?.postconditions ?? [];

  // 4a) Fallback — no postconditions declared OR no browser session.
  //     Degrade to success=(stepsRun > 0). This is the structural
  //     signal: if execute ran steps, the skill-card walker got
  //     through without throwing, so the mutation likely happened.
  //     Evidence cites the degradation reason for audit.
  if (postconditions.length === 0 || !ctx.browser) {
    const reason =
      postconditions.length === 0
        ? `No postconditions declared on tempSkillCard ("${skill?.name ?? "<missing>"}"); structural success based on stepsRun=${inputData.stepsRun}.`
        : `No active browser session; cannot snapshot for postcondition comparison. Structural success based on stepsRun=${inputData.stepsRun}.`;
    logger.info(
      { runId, stepsRun: inputData.stepsRun, degraded: true },
      "[verify] degraded to structural success check",
    );
    return {
      success: inputData.stepsRun > 0,
      skipped: false,
      evidence: [reason],
      execute: inputData,
    };
  }

  // 3) Structured LLM-judge path. Single Sonnet call; thinking off.
  //    Prompt shape follows the Lever-B terse convention from
  //    week2c-react-claude-verbosity (no preamble, no narration).
  const snap = await ctx.browser.snapshot();
  const domText = snap.text;

  const system =
    "Verify postconditions against the final DOM text. " +
    'Return JSON only: {"success": bool, "evidence": [string]}. ' +
    "- `success=true` IFF every postcondition is observably satisfied in the DOM text. " +
    "- `evidence`: exactly one entry per postcondition, each citing the specific DOM token or phrase that confirms (or falsifies) it. " +
    "- On any unsatisfied postcondition: `success=false`; the corresponding evidence entry cites what's missing. " +
    "No preamble. No narration. JSON only.";

  const userMsg =
    `Postconditions to verify (${postconditions.length}):\n` +
    postconditions.map((p, i) => `${i + 1}. ${p}`).join("\n") +
    `\n\nFinal DOM:\n${domText.slice(0, 8000)}\n\nEmit the JSON verdict.`;

  const result = await streamMessage({
    runId,
    bus,
    stepId: "verify",
    tier: "sonnet",
    maxTokens: 512,
    thinkingEnabled: false,
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  // Parse the structured JSON. On parse failure: soft-fail to
  // success=false with the raw text as evidence (same pattern as
  // planStep's parse fallback — doesn't crash verify, surfaces the
  // model drift for the reviewer's audit).
  const parsed = tryParseJson<{ success?: unknown; evidence?: unknown }>(
    result.text,
  );
  if (!parsed || typeof parsed !== "object") {
    logger.warn(
      { runId, responsePreview: result.text.slice(0, 200) },
      "[verify] structured JSON parse failed; returning success=false",
    );
    return {
      success: false,
      skipped: false,
      evidence: [
        `verify model returned non-JSON output: ${result.text.trim().slice(0, 200)}`,
      ],
      execute: inputData,
    };
  }

  const success = parsed.success === true;
  const evidence: string[] = Array.isArray(parsed.evidence)
    ? (parsed.evidence as unknown[])
        .map((e) => String(e).slice(0, 400))
        .slice(0, 10)
    : [
        `verify model returned success=${String(parsed.success)} but no evidence array`,
      ];

  return {
    success,
    skipped: false,
    evidence,
    execute: inputData,
  };
}

const logAndNotifyStep = createStep({
  id: "log_and_notify",
  inputSchema: VerifySchema,
  outputSchema: LogSchema,
  execute: async ({ inputData }) => {
    const { runId, bus } = getRunContext();

    const invocationId = randomUUID();
    bus.publish({
      runId,
      stepId: "log_and_notify",
      payload: {
        type: "tool.started",
        invocationId,
        name: "db.insert_event_log",
        args: { runId },
      },
    });

    await sleep(50);

    bus.publish({
      runId,
      stepId: "log_and_notify",
      payload: {
        type: "tool.completed",
        invocationId,
        name: "db.insert_event_log",
        resultSummary: { rows: 1 },
        durationMs: 50,
      },
    });

    const status = inputData.skipped
      ? ("rejected" as const)
      : inputData.success
        ? ("ok" as const)
        : ("failed" as const);

    return {
      status,
      note: inputData.skipped
        ? "Run rejected at review_gate; execute/verify short-circuited."
        : inputData.success
          ? "Verified."
          : "Verify step reported needs-review; escalate.",
    };
  },
});

/** ---------- Block 1 wrapper step (Commit 7b.iii.a) ---------- */

/**
 * Review-gate intent split (7b.iii.a / 7b.iii.b):
 *
 *   - `review_gate` (pre-execution, Commit 2 / 7b.iii.a): human approves
 *     the proposed plan BEFORE Block 2 executes it. Rejection here
 *     terminates the run with `run.completed status: rejected`. Intent:
 *     "this plan is wrong" — no retry, operator provides a new ticket
 *     if desired.
 *
 *   - `human_verify_gate` (post-execution, Commit 7b.iii.b — NOT YET
 *     IN PLACE): human reviews the POST-execution state. Rejection
 *     there triggers `block.backtrack.triggered` and re-enters Block 1
 *     with execute/verify observations in carriedContext. Intent: "the
 *     work didn't achieve the goal — iterate."
 *
 * Two different decisions; two different paths. Do not collapse them
 * into one gate.
 */

/** 7b.iii.b commit 2 — max pre-exec refine iterations. Each "edit"
 *  decision from the reviewer at review_gate re-runs Block 1 once
 *  with the reviewer's note injected as priorObservations. Cap = 2
 *  means: slot 0 (initial) + slot 1 (refine #1) + slot 2 (refine #2)
 *  = 3 total review cycles; the 3rd edit decision trips the cap and
 *  terminates as reject. Rationale matches blockController's
 *  BLOCK1_MAX_PASSES = 3 — more refines without human convergence
 *  means the ticket likely isn't recoverable at this skill level. */
const MAX_PRE_GATE_REFINES = 2;

/** 7b.iii.b commit 2 — shared Block1Deps factory. Returns raw
 *  references to the extracted step bodies. `runBlock1` threads its
 *  own `opts.abortSignal` into `runRetrieve` and `runDryRun` at
 *  `blockController.ts:230` and `:245`, so no closure-captured
 *  signal is needed here. Signatures match Block1Deps structurally.
 *  Extracted from block1Step's inline literal so commit 2's refine
 *  loop and commit 3's humanVerifyGate backtrack loop reference ONE
 *  definition. */
function buildBlock1Deps(): Block1Deps {
  return {
    runClassify: runClassifyStep,
    runRetrieve: runRetrieveStep,
    runPlan: runPlanStep,
    runDryRun: runDryRunStep,
  };
}

/** 7b.iii.b commit 2 — Convert Block 1's final state into the
 *  DryRunSchema shape that reviewGateStep / executeStep consume.
 *  Extracted from block1Step.execute (pre-commit-2 inline code) so
 *  commit 2's refine loop and commit 3's backtrack loop share one
 *  conversion. Byte-identical output for every input block1Step's
 *  pre-commit-2 inline code saw — zero happy-path behavior change. */
function block1ResultToDryRun(
  r: Block1Result,
): z.infer<typeof DryRunSchema> {
  if (r.passedLast && r.finalState.dryRun) {
    return {
      domMatches: r.finalState.dryRun.domMatches,
      anomalies: r.finalState.dryRun.anomalies,
      plan: r.finalState.plan,
      // week2d Part 2 — forward from dry_run if present (happy path
      // always has them after Part 2 lands); fallback [] / null for
      // any caller/test that still returns the pre-Part-2 shape.
      actionTrace: r.finalState.dryRun.actionTrace ?? [],
      boundaryReached: r.finalState.dryRun.boundaryReached ?? null,
    };
  }
  // Exhausted. If a dry_run happened to run on any pass we reuse its
  // anomalies; otherwise synthesize a diagnostic anomalies list from
  // the per-pass reasons so the reviewer sees what went wrong.
  const synthAnomalies =
    r.finalState.dryRun?.anomalies ??
    r.allReasons.map((reason, i) => `Pass ${i}: ${reason}`);
  return {
    domMatches: false,
    anomalies: synthAnomalies,
    plan: r.finalState.plan,
    blockResult: {
      passes: r.passes,
      passedLast: r.passedLast,
      allReasons: r.allReasons,
    },
    // week2d Part 2 — forward any partial trace from the last pass that
    // ran dry_run; boundary never reached on exhausted Block 1 (else
    // the pass would have been exit_signal_ok).
    actionTrace: r.finalState.dryRun?.actionTrace ?? [],
    boundaryReached: null,
  };
}

/** 7b.iii.b commit 2 — Build the priorObservations array injected
 *  into Block 1 on a pre-exec refine iteration.
 *
 *  Design: latest-note-only (NOT accumulating across refines).
 *  runBlock1 has its own per-pass observation accumulator
 *  (blockController.ts:260-275) that threads gap/anomaly observations
 *  across its internal 3 passes; passing prior refine notes back in
 *  would be duplication, not signal. Reviewer continuity surfaces in
 *  the behavior feed's retained review.decided frames (each carries
 *  its own patch.notes up to 2000 chars via PlanPatchSchema.notes).
 *
 *  Back-compat: PlanPatchSchema.notes is .optional() — when the
 *  reviewer sends `{"decision":"edit"}` with no notes, we synthesize
 *  a fallback string so Block 1 still runs a refine. Rejecting
 *  edit-without-notes would violate the back-compat spirit.
 *
 *  Envelope-cap arithmetic: BlockBacktrackTriggeredFrame.carriedContext[N]
 *  is capped at z.string().max(400). We build the string unbounded
 *  and slice at the final step so future prefix edits can't push the
 *  total past 400. Reviewer notes longer than ~365 chars are
 *  truncated here; the full note still lives in the review.decided
 *  frame's patch.notes for audit. */
function buildPreGateRefineContext(
  notes: unknown,
  refineCount: number,
  // Week-2a gate-decision-model — distinguishes "reject=replan-no-notes"
  // from "edit=replan-with-notes" for prompt-engineering purposes.
  // The seed observation text differs so Sonnet doesn't produce the
  // same plan on reject. Default "edit" preserves back-compat for any
  // call sites that don't pass the arg (there's one: triage.ts ~1330
  // at the refine-loop entry; it always passes the arg explicitly).
  decisionKind: "edit" | "reject" = "edit",
): string[] {
  const note = typeof notes === "string" ? notes.trim() : "";
  let raw: string;
  if (note.length > 0) {
    raw = `Pre-exec refine ${refineCount}: reviewer note: ${note}`;
  } else if (decisionKind === "reject") {
    // Week-2a gate-decision-model — reject-no-notes seed. Directive
    // (not merely descriptive) so Sonnet doesn't produce an identical
    // plan on the next pass. Trimmed to ~180 chars per reviewer-LLM
    // RFC audit (half the tokens of the original 330-char draft;
    // same directive intent).
    raw = `Pre-exec refine ${refineCount}: reviewer rejected the prior plan without notes. Try a fundamentally different approach — different skill card, different action sequence, or different assumption about the ticket's goal.`;
  } else {
    // edit-without-notes back-compat (PlanPatchSchema.notes is
    // optional; a client that sends decision=edit with no patch
    // still lands in this branch).
    raw = `Pre-exec refine ${refineCount}: reviewer requested retry without specific notes; re-attempt with current context.`;
  }
  return [raw.slice(0, 400)];
}

/** 7b.iii.b commit 4 — Build priorObservations for Block 1 on a
 *  post-exec backtrack iteration. Threaded via
 *  `runBlock1(..., { seedObservations: carriedContext })` per the
 *  hotfix-2 CTX SPREAD INVARIANT — NO withRunContext spread.
 *
 *  Envelope constraints: each entry capped ≤ 400 chars
 *  (BlockBacktrackTriggeredFrame.carriedContext[N]); array capped
 *  ≤ 12 entries. Envelope shape matches humanVerifyGate.test.ts [2]'s
 *  example:
 *    [0] header "Backtrack N: ..." (must match /Backtrack \d+/)
 *    [1] reviewer note as separate entry (if present)
 *    [2] prior stepsRun summary
 *    [3] prior verify.success summary
 *    [4] prior verify evidence (if present)
 *
 *  Separating the note from the header (rather than embedding it)
 *  keeps the header deterministic for test assertion and lets Sonnet
 *  weight the note as its own distinct observation in the refine
 *  prompt.
 *
 *  Exported so test/humanVerifyGate.test.ts [4] can assert the
 *  pure-function shape (no bus / no context / no stubs needed). */
export function buildBacktrackContext(
  currentVerify: z.infer<typeof VerifySchema>,
  reviewerNote: string | undefined,
  backtrackCount: number,
): string[] {
  const entries: string[] = [];
  entries.push(
    `Backtrack ${backtrackCount}: the human rejected the post-execution result.`.slice(0, 400),
  );
  const note = reviewerNote?.trim();
  if (note && note.length > 0) {
    entries.push(`Reviewer note: ${note}`.slice(0, 400));
  }
  const prev = currentVerify.execute;
  entries.push(
    `Prior attempt's execute.stepsRun: ${prev.stepsRun} (skipped=${prev.skipped}).`.slice(0, 400),
  );
  entries.push(
    `Prior attempt's verify.success: ${currentVerify.success}.`.slice(0, 400),
  );
  if (currentVerify.evidence.length > 0) {
    entries.push(
      `Prior verify evidence: ${currentVerify.evidence[0] ?? ""}`.slice(0, 400),
    );
  }
  return entries.slice(0, 12);
}

const block1Step = createStep({
  id: "block1",
  inputSchema: TicketSchema,
  outputSchema: DryRunSchema,
  execute: async ({ inputData, abortSignal }) => {
    // 7b.iii.b commit 2 — body collapsed to use shared helpers. The
    // DryRunSchema conversion (happy vs. exhausted) lives in
    // block1ResultToDryRun so commit 3's humanVerifyGate backtrack
    // loop can reuse it verbatim.
    const result = await runBlock1(inputData, buildBlock1Deps(), { abortSignal });
    return block1ResultToDryRun(result);
  },
});

/** ---------- Human-verify gate with backtrack (Commit 7b.iii.b) ----------
 *
 * PARKED 2026-04-23: the initial `humanVerifyGateStep` + backtrack loop
 * authored during the 7b.iii.b apply was reverted after discovering a
 * bus-architecture blocker:
 *   `EventBus.state.committedDecision` is a single-slot-per-run field.
 *   Once ANY `awaitDecision(runId)` resolves (e.g., for the pre-exec
 *   review_gate), all subsequent `awaitDecision(runId)` calls return
 *   the SAME cached decision immediately — the post-exec gate cannot
 *   block on a fresh human decision.
 *
 * Fixing this requires a bus extension (per-stepId decision slots +
 * a new `awaitDecisionForStep(runId, stepId)` primitive). That's a
 * focused ~100-150 LoC bus change; it was outside the proposed scope
 * of 7b.iii.b and needs a separate scope revision.
 *
 * What this commit DOES ship:
 *   - Envelope additions (block.backtrack.triggered variant,
 *     optional reviewHint on review.requested, human_verify_gate
 *     in StepIdSchema). All additive; no behavior change.
 *   - Extracted step bodies: runReviewGateStep, runExecuteStep,
 *     runVerifyStep. Same pattern as 7b.iii.a's runClassifyStep /
 *     runRetrieveStep / runPlanStep / runDryRunStep. Mastra wrappers
 *     delegate to them; existing behavior preserved.
 *   - Envelope + primitive tests that guard the wire contract +
 *     the EventBus decision mechanics as they exist today.
 *
 * What this commit does NOT ship (revisit in 7b.iii.c or equivalent):
 *   - humanVerifyGateStep itself.
 *   - workflow chain insertion.
 *   - backtrack loop + buildBacktrackContext + buildBlock1Deps.
 *   - reviewer UI for post-exec gate, pass-N indicator, backtrack
 *     banner.
 *
 * See the apply-time handoff record for the full discussion + next
 * scope cycle proposal.
 */

/** 7b.iii.b commit 4 — max post-exec backtrack iterations. Each
 *  reject on the human-verify gate re-runs the full pre-notify chain
 *  (Block 1 + review_gate + execute + verify) with the reviewer's
 *  reject context as observations. Cap = 2 means: slot 0 (initial
 *  post-exec review) + slot 1 (backtrack #1) + slot 2 (backtrack #2)
 *  = 3 total human-verify-gate cycles. 3rd reject forces
 *  `success: false` + evidence marker and the run terminates via
 *  logAndNotifyStep with status=failed. Symmetric with
 *  MAX_PRE_GATE_REFINES (pre-exec refine cap) and BLOCK1_MAX_PASSES
 *  (Block 1 internal cap). */
const MAX_BACKTRACKS = 2;

/** 7b.iii.b commit 4 — humanVerifyGateStep un-parked. Pattern was
 *  correctness-adjusted in-comment during hotfix-2 (awaitDecisionForStep
 *  bus API, seedObservations thread, no-spread around runBlock1); this
 *  un-park strips `/* PARKED: *\/` delimiters without further body
 *  changes. See humanVerifyGate.test.ts for 3 envelope-shape guards
 *  authored during the 7b.iii.b partial ship. */
const humanVerifyGateStep = createStep({
  id: "human_verify_gate",
  inputSchema: VerifySchema,
  outputSchema: VerifySchema,
  execute: async ({ inputData, abortSignal }) => {
    const ctx = getRunContext();
    const { runId, bus, ticket } = ctx;

    // Week-2a gate-decision-model-hotfix-1 — upstream skipped=true
    // pass-through. When pre-exec Terminate cascades through
    // executeStep.skipped → verifyStep.skipped, the VerifySchema
    // that arrives here carries skipped=true and there is no
    // destructive action to review. Pre-hotfix: the gate opened
    // anyway and awaited a decision, causing the post-exec
    // review.requested{post_exec} to publish on runs the reviewer
    // had just terminated — a confusing UX (P4 smoke observed: a
    // second terminate at post-exec was required to close the
    // run). Post-hotfix: pass through to logAndNotifyStep verbatim
    // so status=rejected derives from the existing skipped=true
    // mapping at line 1638-1642, same mechanism Finding 2's
    // budget-exhaust fix uses.
    //
    // Placement is BEFORE backtrackCount init + while loop — the
    // guard fires before any bus work, any decision await, any
    // local state. Symmetric with executeStep's skip-guard at the
    // top of runExecuteStep (line 1421-1430) and verifyStep's
    // analogous check.
    if (inputData.skipped) {
      return inputData;
    }

    let currentVerify = inputData;
    let backtrackCount = 0;

    while (true) {
      // Emit post-exec review.requested. stepId="human_verify_gate"
      // differentiates it from the pre-exec review_gate emission;
      // reviewHint="post_exec" is the authoritative signal for the UI
      // to render "approve completion" copy + point at the feed's
      // execute:* screenshots as the evidence surface.
      bus.publish({
        runId,
        stepId: "human_verify_gate",
        payload: {
          type: "review.requested",
          plan: {
            planId: currentVerify.execute.review.dryRun.plan.planId,
            actionCount: currentVerify.execute.review.dryRun.plan.actionCount,
            destructive:
              currentVerify.execute.review.dryRun.plan.destructive,
            skillCardIds:
              currentVerify.execute.review.dryRun.plan.skillCardIds,
          },
          // 7b.iii.b — post-exec evidence lives in the behavior feed
          // above (the execute:* screenshots). Embedding paths here
          // would require plumbing them through ExecuteSchema →
          // VerifySchema; that's Week 2 polish. For now the panel
          // tells the reviewer to scroll the feed.
          screenshots: [],
          viewerUrl: "http://localhost:6080",
          requiresApproval: true,
          reviewHint: "post_exec",
          ...(currentVerify.execute.review.dryRun.blockResult
            ? { blockResult: currentVerify.execute.review.dryRun.blockResult }
            : {}),
        },
      });

      // 7b.iii.b-pre-exec-edit-ui-hotfix-2 — post-commit-1 bus API.
      // Uses awaitDecisionForStep targeting "human_verify_gate" so
      // the post-exec gate awaits its own per-stepId slot (the
      // pre-exec review_gate's slot is already resolved upstream).
      const decision = await bus.awaitDecisionForStep(runId, "human_verify_gate");

      if (decision.decision === "approve" || decision.decision === "edit") {
        // Happy path — return the current verify output. Mastra's
        // workflow engine proceeds to logAndNotifyStep with status=ok.
        // Edit is treated as approve here per the wedge-prevention
        // docblock at the top of this step's Commit 4 implementation
        // (humanVerifyGateStep treats edit≡approve server-side; UI
        // hides Edit on post-exec to prevent the wedge).
        return currentVerify;
      }

      // Week-2a gate-decision-model — terminate short-circuits to
      // logAndNotifyStep with status=rejected. Symmetric with the
      // budget-exhaust return shape (Finding 2 fix, landed in
      // week2a-gate-exhaust-status): skipped=true surfaces
      // reviewer-initiated rejection via the derivation at line
      // 1638-1642. Does NOT enter the backtrack loop — the reviewer
      // explicitly wants to stop, not iterate.
      if (decision.decision === "terminate") {
        return {
          ...currentVerify,
          success: false,
          skipped: true,
          evidence: [
            ...currentVerify.evidence,
            `Post-exec review terminated by reviewer after backtrack ${backtrackCount}.`,
          ],
        };
      }

      // Reject. Check backtrack budget.
      if (backtrackCount >= MAX_BACKTRACKS) {
        logger.warn(
          { runId, backtrackCount, max: MAX_BACKTRACKS },
          "[human_verify_gate] backtrack budget exhausted; returning rejected verify",
        );
        // Week-2a gate-exhaust-status (Finding 2) — set skipped=true
        // so logAndNotifyStep's derivation at line 1638-1642 emits
        // status=rejected, not status=failed.
        //
        // Semantic rationale: skipped=true ≡ reviewer-initiated
        // rejection (the cascade path today's pre-exec reject /
        // terminate uses). Budget exhaust means the reviewer
        // refused the work MAX_BACKTRACKS+1 times — that's an
        // aggregated reviewer rejection, not a workflow execution
        // error. Pre-fix: the return omitted skipped, which fell
        // through to status=failed in logAndNotifyStep (pollutes
        // the rejected-vs-failed forensic semantics and implied
        // workflow-layer fault when there was none).
        //
        // Symmetric with: runReviewGateStep's reject/cap-trip paths
        // (line 1285-1310) which return approved=false → executeStep
        // skipped → verifyStep skipped → logAndNotifyStep rejected.
        return {
          ...currentVerify,
          success: false,
          skipped: true,
          evidence: [
            ...currentVerify.evidence,
            `Backtrack budget exhausted after ${backtrackCount} iteration${backtrackCount === 1 ? "" : "s"}; final human-verify decision: reject.`,
          ],
        };
      }

      backtrackCount++;
      const decisionNote =
        typeof decision.patch?.notes === "string"
          ? decision.patch.notes
          : undefined;
      const carriedContext = buildBacktrackContext(
        currentVerify,
        decisionNote,
        backtrackCount,
      );

      bus.publish({
        runId,
        stepId: "human_verify_gate",
        payload: {
          type: "block.backtrack.triggered",
          fromStep: "human_verify_gate",
          toBlock: "block1",
          carriedContext,
          backtrackCount,
        },
      });

      if (!ticket) {
        // Defensive: the workflow kickoff in http/triage.ts always sets
        // ticket on RunContext. If somehow it's absent we can't
        // re-invoke Block 1. Fall through to a failed verify so the
        // run terminates cleanly.
        logger.error(
          { runId },
          "[human_verify_gate] RunContext.ticket is undefined; cannot backtrack",
        );
        return {
          ...currentVerify,
          success: false,
          evidence: [
            ...currentVerify.evidence,
            "Backtrack aborted: run context lost ticket reference.",
          ],
        };
      }

      // 7b.iii.b-pre-exec-edit-ui-hotfix-2 — re-run the full
      // pre-notify chain with the backtrack carriedContext threaded
      // through `runBlock1`'s `seedObservations` opt. NO
      // withRunContext spread around the block1/review/execute/verify
      // chain — same reasoning as the pre-exec refine loop at
      // `runReviewGateStep` above:
      //   (a) spread-mutation loss traps `runDryRunStep`'s browser
      //       reference on the spread copy → `executeStep` crashes
      //       with "session already closed";
      //   (b) Block 1's inner cognitive spread overrides
      //       `ctx.priorObservations` anyway, so the "spread to
      //       pass observations" pattern is doubly broken.
      // Also uses hotfix-1's post-ref signature `buildBlock1Deps()`
      // (no arg — `runBlock1` threads its own `opts.abortSignal` to
      // deps internally).
      //
      // 7b.iii.b commit 4 — synthetic block1 step frames on backtrack
      // (symmetric with runReviewGateStep's refine loop — see the
      // refine docblock for rationale; reviewer UI needs to see the
      // backtrack's Block 1 output in LEFT column's block1 row).
      const backtrackBlock1StartedAt = Date.now();
      bus.publish({
        runId,
        stepId: "block1",
        payload: { type: "step.started", input: ticket },
      });
      const block1 = await runBlock1(ticket, buildBlock1Deps(), {
        abortSignal,
        seedObservations: carriedContext,
      });
      bus.publish({
        runId,
        stepId: "block1",
        payload: {
          type: "step.completed",
          output: block1ResultToDryRun(block1),
          durationMs: Date.now() - backtrackBlock1StartedAt,
        },
      });

      // Hand Block 1's last-pass state to reviewGate. If Block 1
      // exhausted on this backtrack iteration, blockResult is set
      // and the UI's "exhausted" banner fires + approve is disabled
      // — the human has to reject or sit tight.
      const gate1InputDry: z.infer<typeof DryRunSchema> =
        block1.passedLast && block1.finalState.dryRun
          ? {
              domMatches: block1.finalState.dryRun.domMatches,
              anomalies: block1.finalState.dryRun.anomalies,
              plan: block1.finalState.plan,
              // week2d Part 2
              actionTrace: block1.finalState.dryRun.actionTrace ?? [],
              boundaryReached:
                block1.finalState.dryRun.boundaryReached ?? null,
            }
          : {
              domMatches: false,
              anomalies:
                block1.finalState.dryRun?.anomalies ??
                block1.allReasons.map((r, i) => `Pass ${i}: ${r}`),
              plan: block1.finalState.plan,
              blockResult: {
                passes: block1.passes,
                passedLast: block1.passedLast,
                allReasons: block1.allReasons,
              },
              // week2d Part 2
              actionTrace: block1.finalState.dryRun?.actionTrace ?? [],
              boundaryReached: null,
            };

      // Re-enter review_gate. Pre-exec terminate (or the internal
      // refine-budget cap trip which now returns decision="terminate"
      // too per the week2a gate-decision-model) short-circuits the
      // backtrack chain. Pre-exec "reject" under the new model routes
      // through the refine loop inside runReviewGateStep and never
      // exits with decision="reject" directly — so `gate1Out.decision`
      // here is always "approve" (continue) or "terminate" (short-
      // circuit).
      const gate1Out = await runReviewGateStep(gate1InputDry);
      let nextVerify: z.infer<typeof VerifySchema>;
      if (gate1Out.decision === "terminate") {
        nextVerify = {
          success: false,
          skipped: true,
          evidence: [
            `Pre-exec review terminated during backtrack ${backtrackCount}.`,
          ],
          execute: {
            stepsRun: 0,
            skipped: true,
            review: gate1Out,
          },
        } satisfies z.infer<typeof VerifySchema>;
      } else {
        // week2d Part 3 — materialize lands between reviewGate and
        // execute in the backtrack chain (mirrors the Mastra chain
        // insertion). Each backtrack iteration produces a fresh
        // actionTrace → fresh ctx.tempSkillCard → fresh execute walk.
        // Wrap in synthetic step.started/completed frames so the
        // LEFT column's <StepOutcome> updates across backtracks
        // (same pattern as Piece B's synthetic block1 frames).
        const matStartedAt = Date.now();
        bus.publish({
          runId,
          stepId: "materialize_skill_card",
          payload: { type: "step.started" },
        });
        const matOut = await runMaterializeSkillCardStep(
          gate1Out.dryRun,
          gate1Out,
        );
        bus.publish({
          runId,
          stepId: "materialize_skill_card",
          payload: {
            type: "step.completed",
            output: matOut,
            durationMs: Date.now() - matStartedAt,
          },
        });
        const exec = await runExecuteStep(matOut);
        nextVerify = await runVerifyStep(exec);
      }

      currentVerify = nextVerify;
      // Loop: the top of the while emits a fresh post-exec
      // review.requested for the human to review the NEW verify result.
    }
  },
});

/** ---------- Workflow ---------- */

export const triageWorkflow = createWorkflow({
  id: "triage-and-execute",
  inputSchema: TicketSchema,
  outputSchema: LogSchema,
})
  .then(block1Step)            // 7b.iii.a — wraps classify → retrieve → plan → dry_run
  .then(reviewGateStep)        // pre-exec gate (Commit 2) — reject terminates; edit triggers refine loop
  .then(materializeSkillCardStep) // week2d Part 3 — actionTrace → ephemeral Skill in ctx.tempSkillCard
  .then(executeStep)
  .then(verifyStep)
  .then(humanVerifyGateStep)   // 7b.iii.b commit 4 — post-exec gate; reject triggers backtrack to Block 1
  .then(logAndNotifyStep)
  .commit();

export type TriageInput = z.infer<typeof TicketSchema>;
export type TriageOutput = z.infer<typeof LogSchema>;

/** ---------- helpers ---------- */

function tryParseJson<T>(raw: string): T | null {
  // Be lenient: models often wrap JSON in ```json ... ``` fences or preamble.
  // Grab the first {...} block; if that fails, try the whole string.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch?.[1] ?? raw.trim();
  // Try full candidate first.
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]) as T;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function pickUrgency(raw: unknown): "low" | "medium" | "high" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "high" || s === "medium" || s === "low") return s;
  return "low";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Ref-lookup helpers live at the top of the module (imported +
// re-exported there). Week-2c tools/ consolidation will collapse
// the re-export if + when a second consumer appears beyond
// test/findRef.test.ts.

/** Extract the user-status text from a Playwright MCP snapshot of the
 *  test-webapp user-detail page. The status badge renders as a YAML row
 *  like `  - generic [ref=e53]: locked` — a `generic` element with a ref
 *  and the status word as its text content. Returns the matched word
 *  (`active` / `locked` / `suspended`) in lowercase, or `null` if no such
 *  line exists.
 *
 *  Exported for unit testing. Do NOT loosen this regex to match anywhere
 *  in the snapshot — Playwright MCP's root element always includes an
 *  `[active]` focus marker (e.g. `- generic [active] [ref=e1]:`) which a
 *  loose `/\b(active|…)\b/` would pick up as a false positive, as
 *  6c-1 re-smoke demonstrated. The anchoring below requires the status
 *  word to be the line's trailing text-content (after `: `), which the
 *  root's `[active]` marker can never be. */
export function extractUserStatus(snapshot: string): string | null {
  if (!snapshot) return null;
  const re = /^\s*-\s*generic\s*\[ref=[a-z0-9_-]+\]:\s*(active|locked|suspended)\s*$/im;
  const m = re.exec(snapshot);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Emit a compact multi-line diagnostic for the anomaly log: up to 5 lines
 *  from `snapshot` that contain `needle` (case-insensitive), joined by ` | `,
 *  with whitespace collapsed and each line capped at 120 chars. Used when a
 *  ref lookup fails so the reviewer UI shows exactly what the parser saw
 *  without needing to fish the full snapshot out of postgres. */
function extractLinesMatching(snapshot: string, needle: string): string {
  if (!snapshot) return "(empty snapshot)";
  const needleLower = needle.toLowerCase();
  const matches: string[] = [];
  for (const line of snapshot.split("\n")) {
    if (!line.toLowerCase().includes(needleLower)) continue;
    const trimmed = line.trim().replace(/\s+/g, " ");
    matches.push(trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed);
    if (matches.length >= 5) break;
  }
  return matches.length === 0 ? `(no lines contain '${needle}')` : matches.join(" | ");
}

/** Week-2b-runtime — render the skill-card catalog for Sonnet's
 *  planner prompt. Each line is `  - <name> (destructive|safe): <description>`
 *  so the model can pattern-match a candidate by name. Empty catalog
 *  returns a placeholder that tells the model to fall through to a
 *  custom plan. Bounded at ~2 KiB (description capped at 240 chars)
 *  so Sonnet's prompt doesn't balloon on a large skill library.
 *
 *  Audit #2 (hits[].source unrecoverable): this function is the WHY
 *  planStep doesn't try to parse skill names from RAG retrieval
 *  hits — the rag cleaner renames input files to
 *  `clean_docs/<uuid>/finished.txt`, so the original
 *  `skill_<app>_<name>_<uuid>.html` filename is lost after ingest.
 *  Listing the full catalog directly (from the filesystem via
 *  `loadAllSkills`) is both simpler and avoids the parsing concern
 *  entirely. `retrieveSkillCardsByIntent` stays available for future
 *  ReAct-plan uses (semantic relevance signal) but is not consumed
 *  here in 2b-runtime. */
function buildSkillCatalog(
  skills: Map<string, LoadedSkill>,
): string {
  if (skills.size === 0) {
    return "  (no skill cards authored yet — produce a custom plan)\n";
  }
  const lines: string[] = [];
  for (const loaded of skills.values()) {
    const flag = loaded.skill.destructive ? "destructive" : "safe";
    const desc = loaded.skill.description.replace(/\s+/g, " ").slice(0, 240);
    lines.push(`  - ${loaded.skill.name} (${flag}): ${desc}`);
  }
  return lines.join("\n") + "\n";
}

/** Week-2b-runtime — populate a `TemplateContext.inputs` map from the
 *  ambient ticket + env, according to the skill's declared `inputs`
 *  spec. MVP heuristic: regex-extract email from the ticket subject,
 *  pull operator_email from env, use ticket.ticketId for ticket_id.
 *  Throws `SkillInputExtractionError` if a required input is declared
 *  by the skill but cannot be populated. Week-3+ plans to replace the
 *  heuristic extraction with an LLM-based extractor that reads the
 *  ticket subject/body and fills the inputs; for MVP the Jane smoke
 *  ticket ("Reset password for jane@example.com") hits the email
 *  regex reliably. */
export class SkillInputExtractionError extends Error {
  public readonly missingKey: string;
  constructor(missingKey: string, ticketSubject: string) {
    super(
      `Skill required input '${missingKey}' could not be extracted from ticket subject: "${ticketSubject}". ` +
        `Week-3 will add LLM-based input extraction; for MVP, ensure the ticket subject contains an email address for the 'email' input.`,
    );
    this.name = "SkillInputExtractionError";
    this.missingKey = missingKey;
  }
}

export function extractInputsForSkill(
  skill: Skill,
  ticket: { ticketId: string; subject: string },
): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (skill.inputs) {
    if ("email" in skill.inputs) {
      const m = ticket.subject.match(/[\w.+-]+@[\w.-]+\.\w+/);
      if (m) inputs.email = m[0];
    }
    if ("operator_email" in skill.inputs) {
      inputs.operator_email = env("TARGET_APP_USER");
    }
    if ("ticket_id" in skill.inputs) {
      inputs.ticket_id = ticket.ticketId;
    }
    // Assert every REQUIRED input was populated.
    for (const [key, spec] of Object.entries(skill.inputs)) {
      if (spec.required && !(key in inputs)) {
        throw new SkillInputExtractionError(key, ticket.subject);
      }
    }
  }
  return inputs;
}

/** Read an env value at call time without cycling through `../env.js`
 *  (avoids a test-time circular import when the workflow is tree-shaken
 *  into a smaller fixture). The actual validated value is populated by the
 *  `env.ts` singleton on process boot; this is just a thin typed getter.
 *  Keys that env.ts supplies a default for (TEST_WEBAPP_URL, TARGET_APP_*)
 *  will always be set by the time any step runs. */
function env(
  key:
    | "SHARED_RUNBOOKS_UUID"
    | "SHARED_SKILLS_UUID"
    | "SHARED_SELECTORS_UUID"
    | "TEST_WEBAPP_URL"
    | "TARGET_APP_USER"
    | "TARGET_APP_PASSWORD",
): string {
  const v = process.env[key];
  if (!v) {
    // Shouldn't happen — env.ts already validated at boot. Defensive.
    throw new Error(`[triage] missing ${key} at runtime`);
  }
  return v;
}
