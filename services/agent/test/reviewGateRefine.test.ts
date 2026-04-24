import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import { runReviewGateStep } from "../src/mastra/workflows/triage.js";
import type { Block1Result } from "../src/mastra/lib/blockController.js";
import { runBlock1 } from "../src/mastra/lib/blockController.js";

/**
 * Commit 7b.iii.b-2 — pre-exec edit-refine loop inside
 * runReviewGateStep.
 *
 * Tests drive the extracted step body directly with an injected
 * `runBlock1Fn` stub (Option-a test seam chosen in the scope
 * proposal). The stub captures priorObservations seen by each refine
 * invocation so we can assert:
 *   1. approve/reject at slot 0 → no refine.
 *   2. edit → approve → exactly one refine, carriedContext carries
 *      the reviewer's note, and the `block.backtrack.triggered`
 *      envelope frame is emitted with the correct fromStep/toBlock/
 *      backtrackCount/carriedContext shape.
 *   3. Budget exhausted (edit × 3) → reject with exactly 2 refine
 *      Block-1 invocations (slot 0 + refine #1 + refine #2; 3rd edit
 *      trips the cap).
 *   4. edit without notes → fallback observation string + Block 1
 *      still runs (no-op refine, not an error).
 *   5. Observation shape: refine #2's carriedContext contains ONLY
 *      refine #2's note, not refine #1's (latest-note-only design).
 */

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const FAKE_CLASSIFICATION = {
  category: "password_reset",
  urgency: "medium" as const,
  targetApps: ["test-webapp"],
  confidence: 0.85,
};

/** Shared PlanSchema-shaped object. planId is a fixed UUID v4 so the
 *  `review.requested` frame's PlanSummarySchema.planId validation
 *  passes; distinct from HAPPY_BLOCK1_RESULT.finalState.plan.planId
 *  for visual clarity in failure diffs. */
const FAKE_PLAN = {
  planId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  actionCount: 3,
  destructive: true,
  skillCardIds: ["reset_user_password"],
  planText: "1. navigate 2. click 3. submit",
  thinking: "test-fixture thinking block",
  classification: FAKE_CLASSIFICATION,
  actions: [
    { stepNumber: 1, verb: "navigate" as const, target: "/users", description: "go to users" },
    { stepNumber: 2, verb: "click" as const, target: "reset-link", description: "click reset" },
    { stepNumber: 3, verb: "click" as const, target: "submit-button", description: "submit" },
  ],
  requiresContext: false,
};

/** DryRunSchema-shaped input passed into runReviewGateStep (represents
 *  block1Step's output on the initial pass — happy path, domMatches=
 *  true, no blockResult set). */
const FAKE_DRY_RUN = {
  domMatches: true,
  anomalies: [],
  plan: FAKE_PLAN,
};

/** Block1Result fixture returned by the stub on each refine
 *  invocation. passedLast=true so `block1ResultToDryRun` takes the
 *  happy branch. A distinct planId from FAKE_PLAN.planId, stable
 *  across invocations for deterministic test output. */
const HAPPY_BLOCK1_RESULT: Block1Result = {
  passes: 1,
  passedLast: true,
  allReasons: ["exit_signal_ok"],
  finalState: {
    classification: FAKE_CLASSIFICATION,
    retrieval: {
      runbookHits: 2,
      skillHits: 1,
      hits: { runbooks: [], skills: [] },
      classification: FAKE_CLASSIFICATION,
    },
    plan: {
      ...FAKE_PLAN,
      planId: randomUUID(),
    },
    dryRun: {
      domMatches: true,
      anomalies: [],
      plan: FAKE_PLAN,
    },
  },
  carriedObservations: [],
};

/** Yield enough microtasks for a pending awaitDecisionForStep to
 *  register its waiter before the test commits a decision. Between
 *  slot N resolve and slot N+1 await there are ~4 await hops
 *  (decision resolve → withRunContext → stub async → next publish →
 *  next await); 8 is a comfortable margin. If tests flake, swap to
 *  a deterministic wait pattern (stub resolves an external promise). */
async function yieldMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Make a runBlock1 stub that captures the `seedObservations` passed
 *  via `opts` at each invocation. Returns `results[i]` on the i-th
 *  call (last-element sticky if exhausted).
 *
 *  7b.iii.b-pre-exec-edit-ui-hotfix-2 — previously captured
 *  `getRunContext().priorObservations` because the refine loop
 *  threaded observations via a `withRunContext({ ...ctx,
 *  priorObservations: ... })` spread. Hotfix-2 moved the threading
 *  to an explicit `opts.seedObservations` arg (removing the spread,
 *  which had caused Bug 4 — see blockController.ts docstring). The
 *  stub now captures from the new location; test semantics ("what
 *  did runBlock1 see?") are unchanged. */
function makeBlock1Stub(results: Block1Result[]): {
  fn: typeof runBlock1;
  invocations: Array<{ seedObservations: string[] | undefined }>;
} {
  const invocations: Array<{ seedObservations: string[] | undefined }> = [];
  let i = 0;
  const fn: typeof runBlock1 = async (
    _input,
    _deps,
    opts,
  ): Promise<Block1Result> => {
    invocations.push({ seedObservations: opts?.seedObservations });
    const r = results[Math.min(i, results.length - 1)];
    i++;
    if (!r) throw new Error("stub: results array must not be empty");
    return r;
  };
  return { fn, invocations };
}

describe("runReviewGateStep — pre-exec edit-refine loop (7b.iii.b commit 2)", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ ringBufferSize: 256 });
  });

  it("[1] approve/terminate at slot 0 returns without invoking Block 1", async () => {
    // Week-2a gate-decision-model — `reject` was the second
    // sub-case here pre-week2a (when reject was the skip-cascade
    // mechanism today's `terminate` uses). Under the 4-decision
    // model reject now routes through the refine loop, so its
    // skip-cascade slot is filled by the new `terminate` decision.
    // Test semantics preserved: both approve and terminate are
    // slot-0 short-circuits that return directly without invoking
    // runBlock1. Reject's new refine behavior is covered by test
    // [7] below.
    for (const d of ["approve", "terminate"] as const) {
      const { fn: stub, invocations } = makeBlock1Stub([]);
      await withRunContext(
        { runId: RUN_ID, bus, ticket: { ticketId: "T1", subject: "s" } },
        async () => {
          const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });
          await yieldMicrotasks();
          bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
            decision: d,
            by: "alice",
            at: "2026-04-24T00:00:00.000Z",
            idempotencyKey:
              d === "approve"
                ? "00000000-0000-4000-8000-000000000001"
                : "00000000-0000-4000-8000-000000000002",
          });
          const res = await p;
          expect(res.decision).toBe(d);
          expect(res.approved).toBe(d === "approve");
          expect(invocations.length).toBe(0);
        },
      );
      // Recycle the bus so the next sub-iteration starts with fresh
      // slot state + clean idempotencyMap; keeps beforeEach-created
      // `bus` in use across both sub-cases.
      bus.dispose(RUN_ID);
    }
  });

  it("[2] edit → approve runs Block 1 once with reviewer note in priorObservations (and emits block.backtrack.triggered)", async () => {
    const { fn: stub, invocations } = makeBlock1Stub([HAPPY_BLOCK1_RESULT]);

    // Collect block.backtrack.triggered frames off the bus so we can
    // assert the wire contract, not just what the stub saw internally.
    // Subscribe BEFORE withRunContext so no frames are missed.
    const backtrackFrames: Array<{
      fromStep: string;
      toBlock: string;
      backtrackCount: number;
      carriedContext: string[];
    }> = [];
    bus.subscribe(RUN_ID, (f) => {
      if (f.type === "block.backtrack.triggered") {
        backtrackFrames.push({
          fromStep: f.fromStep,
          toBlock: f.toBlock,
          backtrackCount: f.backtrackCount,
          carriedContext: f.carriedContext,
        });
      }
    });

    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T2", subject: "s" } },
      async () => {
        const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });

        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "edit",
          by: "alice",
          at: "2026-04-24T00:00:00.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000101",
          patch: { notes: "skip the email step; user confirmed phone" },
        });

        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "approve",
          by: "alice",
          at: "2026-04-24T00:00:10.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000102",
        });

        const res = await p;
        expect(res.decision).toBe("approve");
        expect(invocations.length).toBe(1);
        expect(invocations[0]?.seedObservations?.length).toBe(1);
        expect(invocations[0]?.seedObservations?.[0]).toMatch(
          /reviewer note: skip the email step/,
        );
      },
    );

    // Wire-contract assertions on the block.backtrack.triggered frame.
    // Catches typos in the bus.publish payload construction that the
    // priorObservations-only assertions above would miss.
    expect(backtrackFrames.length).toBe(1);
    expect(backtrackFrames[0]?.fromStep).toBe("review_gate");
    expect(backtrackFrames[0]?.toBlock).toBe("block1");
    expect(backtrackFrames[0]?.backtrackCount).toBe(1);
    expect(backtrackFrames[0]?.carriedContext.length).toBe(1);
    expect(backtrackFrames[0]?.carriedContext[0]).toMatch(
      /reviewer note: skip the email step/,
    );
  });

  it("[3] budget exhausted: 3rd edit terminates as reject with exactly 2 refine Block-1 invocations", async () => {
    const { fn: stub, invocations } = makeBlock1Stub([
      HAPPY_BLOCK1_RESULT,
      HAPPY_BLOCK1_RESULT,
    ]);
    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T3", subject: "s" } },
      async () => {
        const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });

        for (let i = 0; i < 3; i++) {
          await yieldMicrotasks();
          bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
            decision: "edit",
            by: "alice",
            at: `2026-04-24T00:00:0${i}.000Z`,
            idempotencyKey: `00000000-0000-4000-8000-00000000020${i + 1}`,
            patch: { notes: `edit iteration ${i + 1}` },
          });
        }

        const res = await p;
        // Week-2a gate-decision-model — cap-trip converts the 3rd
        // edit into a synthetic TERMINATE (not "reject" as pre-
        // week2a). Flows through the same skip cascade
        // (executeStep.skipped → verifyStep.skipped →
        // logAndNotifyStep status=rejected) the pre-week2a "reject"
        // mechanism used; only the decision value changed.
        expect(res.decision).toBe("terminate");
        expect(res.approved).toBe(false);
        // refine #1 + refine #2 ran, but the 3rd edit tripped the cap
        // BEFORE invoking Block 1 a 3rd time.
        expect(invocations.length).toBe(2);
      },
    );
  });

  it("[4] edit without notes uses fallback observation and still runs Block 1", async () => {
    const { fn: stub, invocations } = makeBlock1Stub([HAPPY_BLOCK1_RESULT]);
    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T4", subject: "s" } },
      async () => {
        const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });

        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "edit",
          by: "alice",
          at: "2026-04-24T00:00:00.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000401",
          // no patch.notes on purpose — PlanPatchSchema.notes is
          // .optional() and buildPreGateRefineContext synthesizes a
          // fallback string so Block 1 still runs (no-op refine, not
          // an error).
        });
        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "approve",
          by: "alice",
          at: "2026-04-24T00:00:10.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000402",
        });

        const res = await p;
        expect(res.decision).toBe("approve");
        expect(invocations.length).toBe(1);
        expect(invocations[0]?.seedObservations?.[0]).toMatch(
          /without specific notes/,
        );
      },
    );
  });

  it("[5] carriedContext on refine #2 contains only the latest note (not accumulated)", async () => {
    const { fn: stub, invocations } = makeBlock1Stub([
      HAPPY_BLOCK1_RESULT,
      HAPPY_BLOCK1_RESULT,
    ]);
    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T5", subject: "s" } },
      async () => {
        const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });

        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "edit",
          by: "alice",
          at: "2026-04-24T00:00:00.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000501",
          patch: { notes: "FIRST reviewer note about auth" },
        });
        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "edit",
          by: "alice",
          at: "2026-04-24T00:00:10.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000502",
          patch: { notes: "SECOND note: use phone not email" },
        });
        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "approve",
          by: "alice",
          at: "2026-04-24T00:00:20.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000503",
        });

        const res = await p;
        expect(res.decision).toBe("approve");
        expect(invocations.length).toBe(2);

        // Refine #1 observation → FIRST note only.
        expect(invocations[0]?.seedObservations?.length).toBe(1);
        expect(invocations[0]?.seedObservations?.[0]).toMatch(/FIRST reviewer/);

        // Refine #2 observation → SECOND note only. Critical
        // assertion: refine #2 does NOT carry refine #1's note
        // forward. Matches the "latest-note-only" design decision —
        // runBlock1 has its own per-pass observation accumulator so
        // passing prior refine notes back would be duplication.
        expect(invocations[1]?.seedObservations?.length).toBe(1);
        expect(invocations[1]?.seedObservations?.[0]).toMatch(/SECOND note/);
        expect(invocations[1]?.seedObservations?.[0]).not.toMatch(
          /FIRST reviewer/,
        );
      },
    );
  });

  it("[6] LEFT-column re-emission: refine emits synthetic block1 step.started/completed pair with refined plan", async () => {
    // 7b.iii.b commit 4 — guards the hotfix-2 smoke's truth-invariant
    // finding: pre-commit-4, block1's step.completed.output.plan.planId
    // stayed pinned to the initial plan even after refine, making the
    // LEFT column stale. Piece B adds a synthetic step.started/completed
    // pair around the refine's runBlock1Impl call so the LEFT column's
    // <StepOutcome> (post-commit-4 findLast read) picks up the refined
    // plan.
    //
    // Pair-balance assertion (B.3) is a regression guard for future
    // maintainers who might strip the synthetic step.started thinking
    // it's redundant. started count MUST equal completed count or the
    // UI's step-status state machine (hasStarted/hasCompleted derivation
    // in page.tsx) goes into transient "running" state mid-refine.
    const refinedPlanId = randomUUID();
    const refinedBlock1Result: Block1Result = {
      ...HAPPY_BLOCK1_RESULT,
      finalState: {
        ...HAPPY_BLOCK1_RESULT.finalState,
        plan: { ...HAPPY_BLOCK1_RESULT.finalState.plan, planId: refinedPlanId },
      },
    };
    const { fn: stub } = makeBlock1Stub([refinedBlock1Result]);

    // Collect block1-scoped step frames off the bus.
    const block1StepFrames: Array<{ type: string; planId?: string }> = [];
    bus.subscribe(RUN_ID, (f) => {
      if (f.stepId === "block1" && (f.type === "step.started" || f.type === "step.completed")) {
        const planId =
          f.type === "step.completed"
            ? (f as unknown as { output?: { plan?: { planId?: string } } }).output?.plan?.planId
            : undefined;
        block1StepFrames.push({ type: f.type, planId });
      }
    });

    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T6", subject: "s" } },
      async () => {
        const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });
        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "edit",
          by: "alice",
          at: "2026-04-24T00:00:00.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000601",
          patch: { notes: "refine please" },
        });
        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "approve",
          by: "alice",
          at: "2026-04-24T00:00:10.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000602",
        });
        await p;
      },
    );

    // Note: the INITIAL block1 step.started/completed comes from Mastra's
    // stepEmitter in production (wrapping block1Step.execute). In this
    // test we bypass Mastra and call runReviewGateStep directly, so only
    // the SYNTHETIC refine frames exist. Expect exactly 1 started + 1
    // completed from Piece B's emission.
    const started = block1StepFrames.filter((f) => f.type === "step.started");
    const completed = block1StepFrames.filter((f) => f.type === "step.completed");

    // B.1 — synthetic pair emitted on refine.
    expect(started.length).toBe(1);
    expect(completed.length).toBe(1);

    // B.2 — synthetic completed's output.plan.planId carries the refined plan.
    expect(completed[0]?.planId).toBe(refinedPlanId);

    // B.3 — pair balance (regression guard: started count === completed count).
    expect(started.length).toBe(completed.length);

    // B.4 — refined planId distinct from FAKE_DRY_RUN.plan.planId
    // (authoritative LEFT-column refresh signal).
    expect(completed[0]?.planId).not.toBe(FAKE_PLAN.planId);
  });

  it("[7] reject-no-notes enters refine loop with prescriptive seed observation (Week-2a gate-decision-model)", async () => {
    // Week-2a gate-decision-model — under the 4-decision HIL model
    // reject = "replan without notes" (NOT terminate). Routes
    // through the same refine loop as edit, but with a different
    // seed observation: the edit-without-notes fallback is mildly
    // descriptive ("retry without specific notes") while reject-
    // without-notes is prescriptive ("try a fundamentally different
    // approach — different skill card, different action sequence,
    // or different assumption").
    //
    // This test guards:
    //   - reject triggers refine (not terminate) → runBlock1 runs
    //   - the prescriptive copy reaches runBlock1's
    //     seedObservations (= reviewer intent flows to Sonnet)
    //   - subsequent approve still converges happily
    const { fn: stub, invocations } = makeBlock1Stub([HAPPY_BLOCK1_RESULT]);
    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T7", subject: "s" } },
      async () => {
        const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });

        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "reject", // reject-no-notes — new semantic
          by: "alice",
          at: "2026-04-24T00:00:00.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000701",
          // no patch.notes — this is the reject-no-notes path
        });
        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "approve",
          by: "alice",
          at: "2026-04-24T00:00:10.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000702",
        });

        const res = await p;
        expect(res.decision).toBe("approve");
        expect(invocations.length).toBe(1); // refine ran → Block 1 invoked
        // Prescriptive reject-no-notes seed (NOT the edit-without-
        // notes fallback "retry without specific notes").
        expect(invocations[0]?.seedObservations?.[0]).toMatch(
          /rejected the prior plan without notes/,
        );
        expect(invocations[0]?.seedObservations?.[0]).toMatch(
          /fundamentally different approach/,
        );
      },
    );
  });

  it("[8] terminate short-circuits — no refine, returns approved=false for skip cascade (Week-2a gate-decision-model)", async () => {
    // Week-2a gate-decision-model — terminate is the wire-level
    // kill. Returns decision="terminate" + approved=false without
    // entering the refine loop (Block 1 NOT invoked). The
    // approved=false flag flows into executeStep.skipped →
    // verifyStep.skipped → logAndNotifyStep status=rejected via
    // the same skip cascade the pre-week2a "reject" path used.
    //
    // Guards:
    //   - terminate does NOT trigger runBlock1 (invocations.length === 0)
    //   - return shape is { decision: "terminate", approved: false }
    //   - no block.backtrack.triggered frame emitted (the refine
    //     loop is the only emitter; terminate short-circuits before
    //     reaching it)
    const { fn: stub, invocations } = makeBlock1Stub([]);

    const backtrackFrames: Array<{ fromStep: string }> = [];
    bus.subscribe(RUN_ID, (f) => {
      if (f.type === "block.backtrack.triggered") {
        backtrackFrames.push({ fromStep: f.fromStep });
      }
    });

    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T8", subject: "s" } },
      async () => {
        const p = runReviewGateStep(FAKE_DRY_RUN, { runBlock1Fn: stub });

        await yieldMicrotasks();
        bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
          decision: "terminate",
          by: "alice",
          at: "2026-04-24T00:00:00.000Z",
          idempotencyKey: "00000000-0000-4000-8000-000000000801",
        });

        const res = await p;
        expect(res.decision).toBe("terminate");
        expect(res.approved).toBe(false);
        expect(invocations.length).toBe(0); // NO refine — short-circuit
      },
    );

    // NO block.backtrack.triggered — terminate is NOT a backtrack.
    // The pre-week2a "reject" path emitted zero of these too (reject
    // was a skip-cascade, not a refine), so this is consistent.
    expect(backtrackFrames.length).toBe(0);
  });
});
