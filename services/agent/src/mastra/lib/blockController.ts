import { z } from "zod";

import type { EventBus } from "../../events/bus.js";
import type { StepId } from "../../events/envelope.js";
import { logger } from "../../logger.js";
import { getRunContext, withRunContext } from "../runContext.js";

/**
 * Block 1 controller (Commit 7b.iii.a).
 *
 * DESIGN INVARIANT #1 — stepId namespace:
 *   The four inner steps (classify / retrieve / plan / dry_run) emit
 *   step.started / step.completed / step.failed frames under their
 *   ORIGINAL stepIds via the ambient getRunContext().bus. The outer
 *   "block1" stepId is used only for:
 *     - The Mastra step wrapper's own step.* frames (emitted
 *       automatically by the stepEmitter when Mastra runs block1Step).
 *     - The block.iteration.started / .completed frames emitted here.
 *   The reviewer UI's LEFT outcomes column keys on the original 8
 *   stepIds; block-level frames render exclusively in the RIGHT feed
 *   as iteration dividers.
 *
 *   This matters because this controller is a plain-TypeScript
 *   orchestrator — NOT a Mastra sub-workflow. It invokes the extracted
 *   step bodies (runClassifyStep, runRetrieveStep, runPlanStep,
 *   runDryRunStep) directly and takes responsibility for emitting
 *   their step-bracket frames itself. (Mastra's stepEmitter in
 *   `src/mastra/stepEmitter.ts` hooks workflow-step-start/result
 *   events that only fire when Mastra runs the step via its workflow
 *   engine — which we deliberately bypass here.)
 *
 * DESIGN INVARIANT #2 — context-mutation scope (7b.iii.b-2-hotfix-1):
 *   `runDryRunStep` mutates `getRunContext().browser` to stash the
 *   Playwright MCP session for `executeStep`. Because
 *   `AsyncLocalStorage.run(ctx, fn)` wraps the `ctx` object REFERENCE
 *   passed in (no clone), any `withRunContext({ ...ctx, ... }, fn)`
 *   call creates a NEW spread object that becomes the store INSIDE
 *   the callback. Mutations against `getRunContext()` inside that
 *   callback land on the spread and are LOST when the scope unwinds.
 *
 *   Therefore: `dry_run` MUST run in the OUTER ctx scope — not inside
 *   the spread `withRunContext({ ...ctx, priorObservations }, fn)`
 *   that wraps the cognitive steps (classify / retrieve / plan). If
 *   it's placed inside the spread, `runDryRunStep`'s
 *   `ctx.browser = session` lands on the spread copy, the outer ctx
 *   never sees the session, and `executeStep` emits
 *   `tool.failed(playwright.session_check, "no browser session on
 *   RunContext")` — the canonical signature of this regression.
 *
 *   The three cognitive steps (classify / retrieve / plan) do NOT
 *   mutate ctx; they only READ `priorObservations` via
 *   `getRunContext()` in their prompt builders, so the spread is
 *   safe (and required) for them.
 *
 *   RULE FOR FUTURE CONTRIBUTORS: if a new inner step MUTATES
 *   `getRunContext()` (not just reads from it), audit its scope
 *   placement against this invariant before merging. Don't spread
 *   ctx "to be safe" around a mutating step — that's exactly what
 *   breaks propagation.
 *
 * Loop shape — per pass:
 *   1. emit block.iteration.started
 *   2. run classify / retrieve / plan INSIDE a spread withRunContext
 *      that overlays priorObservations (each wrapped in manual
 *      step.started + step.completed frames).
 *   3. If plan.requiresContext OR plan.actions.length === 0 → skip
 *      dry_run (no point running Playwright when there's nothing to
 *      verify) and record a failure reason + observations.
 *   4. Else run dry_run in the OUTER ctx scope (per invariant #2 —
 *      its ctx.browser mutation must survive to executeStep).
 *   5. Evaluate exit signal:
 *        !plan.requiresContext && plan.actions.length > 0 && dryRun.domMatches
 *   6. emit block.iteration.completed with the reason code.
 *   7. Break on exit_signal_ok; continue to next pass on failure
 *      (carrying observations forward via RunContext.priorObservations).
 *
 * After BLOCK1_MAX_PASSES without success, return with
 * `passedLast: false` + populated `allReasons`. The caller (block1Step)
 * passes this to reviewGateStep as DryRunSchema.blockResult, which
 * surfaces it on the review.requested envelope frame so the UI can
 * render an "exhausted" banner.
 */

/** Max Block 1 passes before synthesizing an "exhausted" review.
 *  3 matches typical ReAct literature — more passes usually means
 *  the underlying prompt is broken and needs engineering, not
 *  iteration budget. Env-var override is deferred to a later commit;
 *  the one-line change when operator-configurability is needed is
 *  this const. */
const BLOCK1_MAX_PASSES = 3;

type Block1Reason =
  | "exit_signal_ok"
  | "plan_requires_context"
  | "plan_empty_actions"
  | "dry_run_mismatch"
  | "max_iterations";

/** Minimal shapes the controller consumes. Kept as type-level imports
 *  from `triage.ts` would introduce a circular dependency — the
 *  controller lives in `mastra/lib/` and the workflow in
 *  `mastra/workflows/`, with the workflow importing the controller
 *  (not the other way around). Instead we use structural shapes that
 *  match the actual Zod-inferred types. */
interface ClassificationOutput {
  category: string;
  urgency: "low" | "medium" | "high";
  targetApps: string[];
  confidence: number;
}

interface RetrievalOutput {
  runbookHits: number;
  skillHits: number;
  hits: {
    runbooks: Array<{ score: number; source: string; preview: string }>;
    skills: Array<{ score: number; source: string; preview: string }>;
  };
  classification: ClassificationOutput;
}

interface PlanOutput {
  planId: string;
  actionCount: number;
  destructive: boolean;
  skillCardIds: string[];
  planText: string;
  thinking: string;
  classification: ClassificationOutput;
  actions: Array<{
    stepNumber: number;
    verb: "navigate" | "fill" | "click" | "verify" | "notify";
    target: string;
    value?: string;
    description: string;
  }>;
  requiresContext: boolean;
  missingContext?: string[];
  /** week2d Part 3 — template-substitution values extracted by plan.
   *  Defaulted to `{}` on the schema side (`z.record(z.string()).default({})`)
   *  so existing callers don't break; populated for-real by the plan
   *  prompt update (Part 3b). */
  inputs: Record<string, string>;
  /** week2e-dynamic-target-url — optional target URL override. See
   *  PlanSchema.targetUrl docblock in triage.ts for resolution
   *  precedence. Mirrored here so block-controller-internal consumers
   *  (none today, but future Block-1 gates might want it) stay typed. */
  targetUrl?: string;
}

/** week2d Part 2 — widened to carry actionTrace + boundaryReached so
 *  block1ResultToDryRun can forward them on happy-path exit (when
 *  dry_run produced a trace + boundary signal). Exhausted-passes paths
 *  populate `[]` + `null`. Optional on this internal type because Part 2
 *  ships parallel-operation (execute doesn't read them yet); Part 3
 *  makes them load-bearing for the materializer. */
interface DryRunOutput {
  domMatches: boolean;
  anomalies: string[];
  plan: PlanOutput;
  actionTrace?: Array<{
    tool:
      | "browser_navigate"
      | "browser_snapshot"
      | "browser_click"
      | "browser_fillForm"
      | "browser_takeScreenshot";
    args: Record<string, unknown>;
    destructive?: boolean;
    screenshotPath?: string;
  }>;
  boundaryReached?: {
    element: string;
    reason: string;
    scaffoldMatch: boolean | null;
    iteration: number;
  } | null;
}

export interface Block1Result {
  passes: number;
  passedLast: boolean;
  allReasons: Block1Reason[];
  finalState: {
    classification: ClassificationOutput;
    retrieval: RetrievalOutput;
    plan: PlanOutput;
    /** `null` when plan refused and dry_run was skipped on every pass. */
    dryRun: DryRunOutput | null;
  };
  carriedObservations: string[];
}

export interface Block1Deps {
  runClassify: (input: {
    ticketId: string;
    subject: string;
    submittedBy?: string;
  }) => Promise<ClassificationOutput>;
  runRetrieve: (
    input: ClassificationOutput,
    signal?: AbortSignal,
  ) => Promise<RetrievalOutput>;
  runPlan: (input: RetrievalOutput) => Promise<PlanOutput>;
  runDryRun: (
    input: PlanOutput,
    signal: AbortSignal | undefined,
    /** week2d Part 2 hotfix-1 — observations carried forward from
     *  refine/backtrack loops. Threaded through to dry_run's LLM
     *  prompt so reviewer corrections alter the agent's browser
     *  exploration (not just plan.inputs). Optional for back-compat
     *  with pre-hotfix callers. */
    priorObservations?: string[],
  ) => Promise<DryRunOutput>;
}

/** Emit a `step.started` / `step.completed` pair around `fn`. Used
 *  because the controller bypasses Mastra's workflow engine and thus
 *  Mastra's stepEmitter — the inner step's frames won't land otherwise.
 *  Matches the envelope shape the stepEmitter would have produced. */
async function wrapStepFrames<T>(
  bus: EventBus,
  runId: string,
  stepId: StepId,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  bus.publish({ runId, stepId, payload: { type: "step.started" } });
  try {
    const result = await fn();
    bus.publish({
      runId,
      stepId,
      payload: {
        type: "step.completed",
        durationMs: Date.now() - startedAt,
        output: result as unknown,
      },
    });
    return result;
  } catch (err) {
    bus.publish({
      runId,
      stepId,
      payload: {
        type: "step.failed",
        error: {
          message: err instanceof Error ? err.message : String(err),
          where: stepId,
        },
      },
    });
    throw err;
  }
}

/** Block 1 controller. Must be called inside a `withRunContext` scope
 *  — it relies on `getRunContext()` for `{runId, bus}`.
 *
 *  7b.iii.b-pre-exec-edit-ui-hotfix-2 — the controller does NOT read
 *  `ctx.priorObservations` directly. Cross-invocation observations
 *  (the reviewer's refine note from `runReviewGateStep`, or the
 *  post-exec backtrack context from commit 3's `humanVerifyGateStep`)
 *  are threaded in via `opts.seedObservations`. On entry,
 *  `observations` is initialized from that seed and accumulates
 *  per-pass gap/anomaly strings on top; Block 1's inner cognitive
 *  spread then overlays the accumulated array as `priorObservations`
 *  on each pass's classify/retrieve/plan prompt.
 *
 *  DO NOT wrap `runBlock1(...)` in a `withRunContext({ ...ctx,
 *  priorObservations: ... }, fn)` spread "to pass observations."
 *  That pattern was what commit 2 originally did and it was DOUBLY
 *  BROKEN:
 *    (a) The reviewer's note never reached any LLM call. Block 1's
 *        inner cognitive spread at
 *        `{ ...ctx, priorObservations: [...observations] }`
 *        overrides the inbound value with its own (empty-on-pass-0)
 *        accumulator. The outer spread's `priorObservations` was
 *        silently dropped.
 *    (b) It trapped `runDryRunStep`'s `getRunContext().browser =
 *        session` mutation inside the spread's new object. When the
 *        spread unwound, the outer ctx never saw the session
 *        reference, `executeStep` read a stale (pre-close-ed)
 *        session and crashed with "cannot invoke
 *        playwright.browser_snapshot: session already closed" —
 *        Bug A recurrence at a second scope boundary. This was the
 *        hotfix-2 root cause.
 *
 *  The cognitive spread is INTERNAL, seed-only, and is the
 *  authoritative pathway for observations. If you need to pass
 *  observations across a `runBlock1` invocation, use
 *  `opts.seedObservations`. */
export async function runBlock1(
  input: { ticketId: string; subject: string; submittedBy?: string },
  deps: Block1Deps,
  opts: {
    abortSignal?: AbortSignal;
    maxPasses?: number;
    /** 7b.iii.b-pre-exec-edit-ui-hotfix-2 — seed Block 1's internal
     *  observation accumulator on entry. Used by:
     *    - `runReviewGateStep`'s pre-exec refine loop (commit 2) to
     *      thread the reviewer's edit note into pass 0's
     *      classify/retrieve/plan prompts.
     *    - commit 3's `humanVerifyGateStep` post-exec backtrack
     *      loop (once un-parked) to thread the carriedContext the
     *      same way.
     *  Both prior call-sites used `withRunContext({ ...ctx,
     *  priorObservations: ... }, () => runBlock1(...))` which was
     *  doubly broken — see this function's docstring above. */
    seedObservations?: string[];
  } = {},
): Promise<Block1Result> {
  const ctx = getRunContext();
  const { runId, bus } = ctx;
  const maxPasses = opts.maxPasses ?? BLOCK1_MAX_PASSES;

  // 7b.iii.b-pre-exec-edit-ui-hotfix-2 — seed from opts, NOT from
  // `ctx.priorObservations`. The caller might set
  // `ctx.priorObservations` via a spread, but that pathway is
  // explicitly unsupported per the docstring above (it's lost by
  // the inner cognitive spread anyway).
  const observations: string[] = [...(opts.seedObservations ?? [])];
  const reasons: Block1Reason[] = [];
  let lastClassification: ClassificationOutput | undefined;
  let lastRetrieval: RetrievalOutput | undefined;
  let lastPlan: PlanOutput | undefined;
  let lastDryRun: DryRunOutput | null = null;

  for (let pass = 0; pass < maxPasses; pass++) {
    bus.publish({
      runId,
      stepId: "block1",
      payload: {
        type: "block.iteration.started",
        blockId: "block1",
        iteration: pass,
      },
    });

    // Cognitive steps (classify / retrieve / plan) run inside a spread
    // withRunContext that overlays priorObservations. Their prompt
    // builders read priorObservations via getRunContext() to refine
    // across passes. These steps do NOT mutate ctx — safe for the
    // spread scope (per DESIGN INVARIANT #2 above).
    const cognitive = await withRunContext(
      { ...ctx, priorObservations: [...observations] },
      async () => {
        const classification = await wrapStepFrames(
          bus,
          runId,
          "classify",
          () => deps.runClassify(input),
        );
        const retrieval = await wrapStepFrames(bus, runId, "retrieve", () =>
          deps.runRetrieve(classification, opts.abortSignal),
        );
        const plan = await wrapStepFrames(bus, runId, "plan", () =>
          deps.runPlan(retrieval),
        );
        return { classification, retrieval, plan };
      },
    );
    const { classification, retrieval, plan } = cognitive;

    // Dry-run runs in the OUTER ctx scope (per DESIGN INVARIANT #2).
    // runDryRunStep does `getRunContext().browser = session` — that
    // mutation MUST land on the outer RunContext so downstream steps
    // (reviewGateStep, executeStep) can read it via getRunContext().
    // Running dry_run inside the spread above would lose the browser
    // reference when the spread unwinds — this regression was caught
    // by 7b.iii.b-2-hotfix-1.
    //
    // We also skip dry_run when the plan refused or emitted zero
    // actions — no point running Playwright when there's nothing to
    // verify; the pass fails at the plan stage and the next pass's
    // classify/retrieve/plan refine with the plan's missingContext.
    let dryRun: DryRunOutput | null = null;
    if (!plan.requiresContext && plan.actions.length > 0) {
      dryRun = await wrapStepFrames(bus, runId, "dry_run", () =>
        // week2d Part 2 hotfix-1 — forward per-pass observations
        // to dry_run's ReAct loop. `observations` is the controller's
        // local accumulator (seeded from opts.seedObservations +
        // appended to each pass's exit-reason). This is what lets
        // reviewer corrections (from refine/backtrack seed) alter
        // dry_run's exploration, not just plan.inputs.
        deps.runDryRun(plan, opts.abortSignal, [...observations]),
      );
    }

    lastClassification = classification;
    lastRetrieval = retrieval;
    lastPlan = plan;
    lastDryRun = dryRun;

    // Evaluate exit signal for this pass.
    let reason: Block1Reason;
    if (plan.requiresContext) {
      reason = "plan_requires_context";
      observations.push(
        ...(plan.missingContext ?? []).map(
          (m) => `Pass ${pass} gap: ${m}`,
        ),
      );
    } else if (plan.actions.length === 0) {
      reason = "plan_empty_actions";
      observations.push(
        `Pass ${pass}: plan returned non-refusing but produced 0 valid actions — check model output or parsing.`,
      );
    } else if (!dryRun || !dryRun.domMatches) {
      reason = "dry_run_mismatch";
      const anomalies = dryRun?.anomalies ?? [];
      observations.push(
        ...anomalies.slice(0, 4).map((a) => `Pass ${pass} dry-run anomaly: ${a}`),
      );
    } else {
      reason = "exit_signal_ok";
    }
    reasons.push(reason);

    // Bound the observation log so one runaway pass can't bloat
    // subsequent prompts. 12 observations is generous for a 3-pass
    // limit (up to ~4 per pass).
    if (observations.length > 12) {
      observations.splice(0, observations.length - 12);
    }

    bus.publish({
      runId,
      stepId: "block1",
      payload: {
        type: "block.iteration.completed",
        blockId: "block1",
        iteration: pass,
        passed: reason === "exit_signal_ok",
        reason,
        ...(observations.length > 0
          ? {
              observationSummary: observations[observations.length - 1]?.slice(0, 400),
            }
          : {}),
      },
    });

    if (reason === "exit_signal_ok") {
      logger.info(
        { runId, pass: pass + 1, passes: maxPasses },
        "[block1] exit signal satisfied — Block 1 done",
      );
      return {
        passes: pass + 1,
        passedLast: true,
        allReasons: reasons,
        finalState: {
          classification: lastClassification!,
          retrieval: lastRetrieval!,
          plan: lastPlan!,
          dryRun: lastDryRun,
        },
        carriedObservations: observations,
      };
    }
  }

  // Exhausted. Record the terminal reason and return with
  // passedLast: false.
  reasons.push("max_iterations");
  logger.warn(
    { runId, passes: maxPasses, reasons },
    "[block1] exhausted without viable plan — synthesizing exhausted review",
  );
  return {
    passes: maxPasses,
    passedLast: false,
    allReasons: reasons,
    finalState: {
      classification: lastClassification!,
      retrieval: lastRetrieval!,
      plan: lastPlan!,
      dryRun: lastDryRun,
    },
    carriedObservations: observations,
  };
}

// ZodSchema exported solely for test-time parity checks.
export const Block1ReasonSchema = z.enum([
  "exit_signal_ok",
  "plan_requires_context",
  "plan_empty_actions",
  "dry_run_mismatch",
  "max_iterations",
]);
