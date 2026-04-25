import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { EventBus } from "../src/events/bus.js";
import type { TimelineFrame, TimelineFramePayload } from "../src/events/envelope.js";
import { withRunContext, tryGetRunContext, getRunContext, type RunContext } from "../src/mastra/runContext.js";
import { runBlock1, type Block1Deps } from "../src/mastra/lib/blockController.js";
import type { BrowserSession } from "../src/mastra/tools/playwrightMcp.js";

/**
 * Commit 7b.iii.a — Block 1 controller.
 *
 * Drives `runBlock1` directly with injected step-body deps so tests
 * can exercise the pass loop, the exit-signal branching, the
 * priorObservations threading, and the per-step step.started /
 * step.completed frame emission without touching Mastra or real LLM
 * calls.
 *
 * Each test:
 *   - Constructs a `Block1Deps` stub whose step bodies are plain
 *     async functions (no LLM / no Playwright / no RAG).
 *   - Runs the controller inside a `withRunContext({ runId, bus })`
 *     scope with a real EventBus to capture emitted frames.
 *   - Asserts: result shape, emitted frame sequence, observations
 *     propagation behavior, stepId invariant (inner frames emit under
 *     their original stepIds, not under "block1").
 */

const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TICKET = { ticketId: "T-bc1", subject: "Reset password for jane@example.com" };

function cls(overrides?: Partial<Block1Deps>): Block1Deps["runClassify"] {
  return overrides?.runClassify ??
    (async () => ({
      category: "account_management",
      urgency: "high" as const,
      targetApps: ["test-webapp"],
      confidence: 0.85,
    }));
}

function ret(overrides?: Partial<Block1Deps>): Block1Deps["runRetrieve"] {
  return overrides?.runRetrieve ??
    (async (classification) => ({
      runbookHits: 3,
      skillHits: 0,
      hits: {
        runbooks: [
          { score: 0.76, source: "runbooks/password-reset.html", preview: "..." },
        ],
        skills: [],
      },
      classification,
    }));
}

function makePlan(requiresContext: boolean, actions = 5) {
  return {
    planId: "11111111-1111-4111-8111-111111111111",
    actionCount: requiresContext ? 0 : actions,
    destructive: !requiresContext,
    skillCardIds: [],
    planText: "plan narrative",
    thinking: "",
    classification: {
      category: "account_management",
      urgency: "high" as const,
      targetApps: ["test-webapp"],
      confidence: 0.85,
    },
    actions: requiresContext
      ? []
      : Array.from({ length: actions }, (_, i) => ({
          stepNumber: i + 1,
          verb: "click" as const,
          target: `target-${i}`,
          description: `step ${i + 1}`,
        })),
    requiresContext,
    ...(requiresContext
      ? { missingContext: ["missing-portal-url", "missing-procedure"] }
      : {}),
  };
}

function makeDryRun(domMatches: boolean, anomalies: string[] = []) {
  return {
    domMatches,
    anomalies,
    plan: makePlan(false, 5),
    // week2d Part 2 — required DryRunSchema fields. Internal
    // blockController `DryRunOutput` declares them optional so this
    // type-checks against the stub contract; runtime callers get
    // empty arrays / null, same as pre-ReAct dry_run output would on
    // these fixtures.
    actionTrace: [],
    boundaryReached: null,
  };
}

function bucketFrames(bus: EventBus): {
  all: TimelineFrame[];
  byType: Record<string, TimelineFramePayload[]>;
  byStep: Record<string, TimelineFramePayload[]>;
} {
  const all = bus.replay(RUN_ID, -1);
  const byType: Record<string, TimelineFramePayload[]> = {};
  const byStep: Record<string, TimelineFramePayload[]> = {};
  for (const f of all) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { v, runId, seq, ts, stepId, ...payload } = f;
    (byType[f.type] ??= []).push(payload as TimelineFramePayload);
    (byStep[f.stepId] ??= []).push(payload as TimelineFramePayload);
  }
  return { all, byType, byStep };
}

describe("blockController — runBlock1", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ ringBufferSize: 256 });
  });
  afterEach(() => {
    // no-op; EventBus per-test
  });

  it("[1] happy pass 0 succeeds: exit signal satisfies on first pass, no backtrack", async () => {
    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      runPlan: async () => makePlan(false, 5),
      runDryRun: async () => makeDryRun(true, []),
    };

    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runBlock1(TICKET, deps),
    );

    expect(result.passes).toBe(1);
    expect(result.passedLast).toBe(true);
    expect(result.allReasons).toEqual(["exit_signal_ok"]);
    expect(result.carriedObservations).toEqual([]);

    const { byType } = bucketFrames(bus);
    expect(byType["block.iteration.started"]).toHaveLength(1);
    expect(byType["block.iteration.completed"]).toHaveLength(1);
    expect(byType["block.iteration.completed"]?.[0]).toMatchObject({
      iteration: 0,
      passed: true,
      reason: "exit_signal_ok",
    });
  });

  it("[2] multi-pass with backtrack: pass 0 refuses → pass 1 succeeds with observations threaded", async () => {
    const plans = [makePlan(true), makePlan(false, 7)];
    let planCall = 0;
    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      // On pass 1 runPlan is expected to see priorObservations — we
      // capture them via RunContext inside the mock.
      runPlan: async () => {
        const ctx = tryGetRunContext();
        observationsSeenPerCall.push(ctx?.priorObservations ?? []);
        return plans[planCall++]!;
      },
      runDryRun: async () => makeDryRun(true, []),
    };
    const observationsSeenPerCall: string[][] = [];

    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runBlock1(TICKET, deps),
    );

    expect(result.passes).toBe(2);
    expect(result.passedLast).toBe(true);
    expect(result.allReasons).toEqual(["plan_requires_context", "exit_signal_ok"]);

    // Pass 0: no priorObservations (fresh run).
    expect(observationsSeenPerCall[0]).toEqual([]);
    // Pass 1: observations from pass 0's missingContext carried forward.
    expect(observationsSeenPerCall[1]?.length).toBeGreaterThan(0);
    expect(observationsSeenPerCall[1]?.[0]).toMatch(/Pass 0 gap:/);

    const { byType } = bucketFrames(bus);
    expect(byType["block.iteration.started"]).toHaveLength(2);
    expect(byType["block.iteration.completed"]?.[0]).toMatchObject({
      iteration: 0,
      passed: false,
      reason: "plan_requires_context",
    });
    expect(byType["block.iteration.completed"]?.[1]).toMatchObject({
      iteration: 1,
      passed: true,
      reason: "exit_signal_ok",
    });
  });

  it("[3] all 3 passes refuse → passedLast: false, allReasons populated, blockResult-ready shape", async () => {
    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      runPlan: async () => makePlan(true),
      runDryRun: async () => makeDryRun(true),
    };

    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runBlock1(TICKET, deps),
    );

    expect(result.passes).toBe(3);
    expect(result.passedLast).toBe(false);
    // 3 pass failures + the terminal "max_iterations" synthetic reason.
    expect(result.allReasons).toEqual([
      "plan_requires_context",
      "plan_requires_context",
      "plan_requires_context",
      "max_iterations",
    ]);
    // dry_run was skipped on every pass (plan refused).
    expect(result.finalState.dryRun).toBeNull();
  });

  it("[4] carriedObservations aggregation: observations from passes 0 and 1 both present on pass 2", async () => {
    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      // Each refusal produces a distinct missingContext so we can tell
      // them apart in the observations log.
      runPlan: async () => {
        const ctx = tryGetRunContext();
        const passIdx = ctx?.priorObservations?.length ?? 0;
        return {
          ...makePlan(true),
          missingContext: [`pass-${passIdx}-gap`],
        };
      },
      runDryRun: async () => makeDryRun(true),
    };

    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runBlock1(TICKET, deps),
    );

    // carriedObservations contains entries from each failed pass.
    expect(result.carriedObservations.length).toBeGreaterThanOrEqual(3);
    const joined = result.carriedObservations.join(" | ");
    expect(joined).toContain("pass-0-gap");
    expect(joined).toContain("pass-1-gap");
    expect(joined).toContain("pass-2-gap");
  });

  it("[5] dry_run skipped when plan.requiresContext=true: plan_requires_context reason recorded, runDryRun never invoked", async () => {
    const planSpy = vi.fn(async () => makePlan(true));
    const dryRunSpy = vi.fn(async () => makeDryRun(true));
    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      runPlan: planSpy,
      runDryRun: dryRunSpy,
    };

    await withRunContext({ runId: RUN_ID, bus }, () =>
      runBlock1(TICKET, deps, { maxPasses: 1 }),
    );

    expect(planSpy).toHaveBeenCalledTimes(1);
    // dry_run must NOT run when plan refused — that's the whole point
    // of the skip: no actions to verify.
    expect(dryRunSpy).toHaveBeenCalledTimes(0);
  });

  it("[6] dry_run_mismatch path: plan OK but dryRun.domMatches=false triggers retry with anomalies in observations", async () => {
    const plans = [makePlan(false, 5), makePlan(false, 5)];
    const dryRuns = [
      makeDryRun(false, ["login-page structure changed"]),
      makeDryRun(true, []),
    ];
    let planCall = 0;
    let dryCall = 0;
    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      runPlan: async () => plans[planCall++]!,
      runDryRun: async () => dryRuns[dryCall++]!,
    };

    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runBlock1(TICKET, deps),
    );

    expect(result.passes).toBe(2);
    expect(result.passedLast).toBe(true);
    expect(result.allReasons).toEqual(["dry_run_mismatch", "exit_signal_ok"]);
    // Pass 0's anomaly surfaces in carriedObservations.
    const joined = result.carriedObservations.join(" | ");
    expect(joined).toContain("login-page structure changed");
  });

  it("[7] stepId invariant: inner step.* frames emit under original stepIds (classify / retrieve / plan / dry_run), block.iteration.* under 'block1'", async () => {
    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      runPlan: async () => makePlan(false, 5),
      runDryRun: async () => makeDryRun(true, []),
    };

    await withRunContext({ runId: RUN_ID, bus }, () =>
      runBlock1(TICKET, deps),
    );

    const { byStep, byType } = bucketFrames(bus);

    // Inner step frames carry their ORIGINAL stepIds.
    expect(byStep["classify"]?.length).toBe(2); // step.started + step.completed
    expect(byStep["retrieve"]?.length).toBe(2);
    expect(byStep["plan"]?.length).toBe(2);
    expect(byStep["dry_run"]?.length).toBe(2);

    // block.iteration.* frames carry stepId "block1".
    expect(byStep["block1"]?.some((p) => p.type === "block.iteration.started")).toBe(true);
    expect(byStep["block1"]?.some((p) => p.type === "block.iteration.completed")).toBe(true);

    // step.* frames NOT emitted under "block1" (the Mastra wrapper
    // handles those; controller doesn't emit them directly).
    expect(
      byStep["block1"]?.some((p) => p.type === "step.started" || p.type === "step.completed"),
    ).toBeFalsy();

    // Sanity: at least one step.completed per inner step.
    const completed = byType["step.completed"] ?? [];
    expect(completed).toHaveLength(4); // classify / retrieve / plan / dry_run
  });

  it("[8] 7b.iii.b-2-hotfix-1 regression guard: dry_run runs in outer ctx scope; runDryRun's ctx.browser mutation is visible after runBlock1 returns", async () => {
    // Rationale: pre-hotfix, runBlock1 wrapped all 4 inner steps in a
    // spread withRunContext({ ...ctx, priorObservations }, ...). That
    // spread creates a new object; any mutation to getRunContext()
    // inside lands on the spread and is lost when the scope unwinds.
    // runDryRunStep's `ctx.browser = session` was silently dropped,
    // and executeStep downstream emitted
    // tool.failed(playwright.session_check, "no browser session on
    // RunContext"). This test guards against regression both
    // structurally (scope identity) AND by symptom (propagation).
    const outerCtx: RunContext = { runId: RUN_ID, bus };
    const stubSession = { marker: "SESSION_FROM_STUB" } as unknown as BrowserSession;

    const deps: Block1Deps = {
      runClassify: cls(),
      runRetrieve: ret(),
      runPlan: async () => makePlan(false, 5),
      runDryRun: async () => {
        // ASSERTION #1 (scope identity, BEFORE mutation): the ctx
        // visible to runDryRun MUST be the literal outer object ref
        // — NOT a spread copy. If someone later wraps dry_run in
        // another spread "to be safe," this check fires immediately.
        // Tests the DESIGN INVARIANT #2 docblock rule directly.
        expect(getRunContext()).toBe(outerCtx);
        getRunContext().browser = stubSession;
        return makeDryRun(true, []);
      },
    };

    const result = await withRunContext(outerCtx, () =>
      runBlock1(TICKET, deps),
    );

    expect(result.passedLast).toBe(true);

    // ASSERTION #2 (downstream propagation symptom): the outer ctx
    // literal object reference now carries the browser session.
    // Pre-hotfix this failed because the mutation landed on the
    // spread copy inside the pass loop.
    expect(outerCtx.browser).toBeDefined();
    expect(
      (outerCtx.browser as unknown as { marker: string }).marker,
    ).toBe("SESSION_FROM_STUB");
  });
});
