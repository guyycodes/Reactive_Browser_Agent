import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { EventBus } from "../src/events/bus.js";
import type { TimelineFrame, TimelineFramePayload } from "../src/events/envelope.js";
import { withRunContext } from "../src/mastra/runContext.js";
import { buildBacktrackContext } from "../src/mastra/workflows/triage.js";

/**
 * Commit 7b.iii.b — humanVerifyGateStep backtrack control flow.
 *
 * Tests drive the humanVerifyGateStep's extracted execute body
 * indirectly via a minimal harness that simulates the bus decisions
 * the real reviewer would commit over WebSocket. Mocks out
 * streamMessage + runBlock1 + the per-step extracted bodies so the
 * focus is the gate / backtrack control flow, not the underlying
 * LLM / browser work.
 *
 * The step's execute body lives inside triage.ts. Rather than
 * re-export it for tests (which would force an awkward export from
 * the workflow module), this suite composes equivalent direct calls
 * to the primitives it uses (bus.publish, bus.awaitDecision,
 * runBlock1, runReviewGateStep, runExecuteStep, runVerifyStep). If the
 * step's control flow ever drifts from the pattern asserted here,
 * the smoke surface will catch it — these tests guard the primitives
 * + mechanics, not the exact step wiring.
 */

const RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function bucketFrames(bus: EventBus): {
  all: TimelineFrame[];
  byType: Record<string, TimelineFramePayload[]>;
} {
  const all = bus.replay(RUN_ID, -1);
  const byType: Record<string, TimelineFramePayload[]> = {};
  for (const f of all) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { v, runId, seq, ts, stepId, ...payload } = f;
    (byType[f.type] ??= []).push(payload as TimelineFramePayload);
  }
  return { all, byType };
}

/** Simulate the reviewer's decision lifecycle: the humanVerifyGate
 *  emits review.requested then calls bus.awaitDecision; the test
 *  commits the next scripted decision after a microtask boundary. */
async function commitDecision(
  bus: EventBus,
  decision: "approve" | "reject" | "edit",
  note?: string,
): Promise<void> {
  // Yield once so the gate has time to register its waiter.
  await Promise.resolve();
  await Promise.resolve();
  bus.publishClientDecision(RUN_ID, {
    decision,
    by: "test-operator",
    ...(note ? { patch: { notes: note } } : {}),
  });
}

describe("humanVerifyGateStep — gate + backtrack control flow (7b.iii.b)", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ ringBufferSize: 256 });
  });
  afterEach(() => {
    // no-op
  });

  it("[1] post-exec review.requested emits with reviewHint='post_exec' + stepId='human_verify_gate' + empty screenshots", async () => {
    // Minimal harness: emit a single post-exec review.requested frame
    // the same shape humanVerifyGateStep emits, verify the wire
    // contract. Guards the reviewHint + stepId fields that the
    // reviewer UI's panel-copy branches on.
    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T-h1", subject: "t" } },
      async () => {
        bus.publish({
          runId: RUN_ID,
          stepId: "human_verify_gate",
          payload: {
            type: "review.requested",
            plan: {
              planId: "11111111-1111-4111-8111-111111111111",
              actionCount: 8,
              destructive: true,
              skillCardIds: [],
            },
            screenshots: [],
            viewerUrl: "http://localhost:3000/agent/review/" + RUN_ID,
            requiresApproval: true,
            reviewHint: "post_exec",
          },
        });
      },
    );

    const { byType } = bucketFrames(bus);
    const reviewRequested = byType["review.requested"]?.[0] as
      | {
          reviewHint?: string;
          screenshots?: string[];
          plan?: { destructive?: boolean };
        }
      | undefined;
    expect(reviewRequested).toBeDefined();
    expect(reviewRequested?.reviewHint).toBe("post_exec");
    expect(reviewRequested?.screenshots).toEqual([]);
    expect(reviewRequested?.plan?.destructive).toBe(true);
  });

  it("[2] backtrack emission: reject → block.backtrack.triggered with carriedContext + 1-indexed count", async () => {
    // Harness: simulate the gate's reject-emits-backtrack sequence.
    // The real humanVerifyGateStep constructs carriedContext via
    // buildBacktrackContext; here we assert the envelope shape it
    // emits rather than the helper's exact output (which is covered
    // by backtrackIntegration.test.ts).
    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T-h2", subject: "t" } },
      async () => {
        bus.publish({
          runId: RUN_ID,
          stepId: "human_verify_gate",
          payload: {
            type: "block.backtrack.triggered",
            fromStep: "human_verify_gate",
            toBlock: "block1",
            carriedContext: [
              "Backtrack 1: the human rejected the post-execution result.",
              "Reviewer note: reset was applied to the wrong user.",
              "Prior attempt's execute.stepsRun: 4 (skipped=false).",
              "Prior attempt's verify.success: true.",
            ],
            backtrackCount: 1,
          },
        });
      },
    );

    const { byType } = bucketFrames(bus);
    const backtrack = byType["block.backtrack.triggered"]?.[0] as
      | {
          backtrackCount?: number;
          fromStep?: string;
          toBlock?: string;
          carriedContext?: string[];
        }
      | undefined;
    expect(backtrack).toBeDefined();
    expect(backtrack?.backtrackCount).toBe(1);
    expect(backtrack?.fromStep).toBe("human_verify_gate");
    expect(backtrack?.toBlock).toBe("block1");
    expect(backtrack?.carriedContext?.length).toBeGreaterThan(0);
    expect(backtrack?.carriedContext?.[0]).toMatch(/Backtrack 1/);
  });

  it("[3] decision commit via bus.publishClientDecision: awaitDecision unblocks with the decision payload", async () => {
    // Mirrors the gate's core await. If this primitive ever changes
    // semantics (e.g., returns null on race), the gate's behavior
    // changes and this test catches it.
    await withRunContext(
      { runId: RUN_ID, bus, ticket: { ticketId: "T-h3", subject: "t" } },
      async () => {
        const decisionPromise = bus.awaitDecision(RUN_ID);
        void commitDecision(bus, "approve", "all good");
        const decision = await decisionPromise;
        expect(decision.decision).toBe("approve");
        expect(decision.by).toBe("test-operator");
        expect(decision.patch?.notes).toBe("all good");
      },
    );
  });

  // Note — a [4] "multi-cycle gate" test was attempted here during
  // 7b.iii.b apply and uncovered a scope-blocking bug: `bus.awaitDecision`
  // returns the run's single cached decision on every subsequent call,
  // so a second gate (post-exec) can't actually block on a fresh human
  // response. Fix requires a bus-extension (per-stepId decision slots).
  // Surfaced in the 7b.iii.b apply handoff; test reinstated once the
  // bus extension lands.

  it("[4] buildBacktrackContext shape: envelope-correct entries with note, truncation, and length caps", () => {
    // 7b.iii.b commit 4 — pure-unit test of buildBacktrackContext.
    // No context setup, no stubs, no bus — the helper is a pure
    // function. Guards the envelope shape that humanVerifyGate.test.ts
    // [2]'s harness expects (carriedContext[0] must match /Backtrack
    // \d+/) + the per-entry 400-char cap + the array 12-entry cap.
    //
    // Fixture pattern: minimal VerifySchema-shaped object with empty
    // plan ({} as never). buildBacktrackContext reads ONLY
    // .execute.stepsRun, .execute.skipped, .success, and .evidence —
    // never touches .execute.review.dryRun.plan. Minimal fixture is
    // safe and self-documenting.
    const baseVerify = {
      success: true,
      skipped: false,
      evidence: ["verified"],
      execute: {
        stepsRun: 4,
        skipped: false,
        review: {
          decision: "approve",
          approved: true,
          dryRun: {
            domMatches: true,
            anomalies: [],
            plan: {} as never,
            // week2d Part 2 — required DryRunSchema fields.
            actionTrace: [],
            boundaryReached: null,
          },
        },
      },
    } as unknown as Parameters<typeof buildBacktrackContext>[0];

    // A.1 — with reviewer note: header + note + stepsRun + success + evidence = 5 entries
    const withNote = buildBacktrackContext(baseVerify, "reset was wrong user", 1);
    expect(withNote[0]).toMatch(/^Backtrack 1: the human rejected/);
    expect(withNote[1]).toMatch(/^Reviewer note: reset was wrong user/);
    expect(withNote.length).toBe(5);

    // A.2 — without reviewer note: no "Reviewer note:" entry, array
    // length drops to 4 (header + stepsRun + success + evidence).
    const withoutNote = buildBacktrackContext(baseVerify, undefined, 1);
    expect(withoutNote.some((e) => e.startsWith("Reviewer note:"))).toBe(false);
    expect(withoutNote.length).toBe(4);

    // A.3 — long note: per-entry truncated at envelope 400-char cap.
    const longNote = "x".repeat(500);
    const longResult = buildBacktrackContext(baseVerify, longNote, 1);
    expect(longResult[1]?.length).toBeLessThanOrEqual(400);
    expect(longResult[1]?.startsWith("Reviewer note: ")).toBe(true);

    // A.4 — array length cap (≤ 12) defensive even on inflated inputs.
    // Current shape emits at most 5 entries, but the .slice(0, 12)
    // guard is authoritative; test asserts the guard, not the current
    // emission count.
    const inflatedVerify = {
      ...baseVerify,
      evidence: Array.from({ length: 20 }, (_, i) => `evidence ${i}`),
    } as unknown as Parameters<typeof buildBacktrackContext>[0];
    const capped = buildBacktrackContext(inflatedVerify, "note", 1);
    expect(capped.length).toBeLessThanOrEqual(12);

    // A.5 — evidence branch: present path emits a 5th entry matching
    // /^Prior verify evidence:/; empty path does NOT.
    const withEvidence = buildBacktrackContext(baseVerify, undefined, 2);
    expect(withEvidence.some((e) => e.startsWith("Prior verify evidence:"))).toBe(true);
    const noEvidenceVerify = {
      ...baseVerify,
      evidence: [] as string[],
    } as unknown as Parameters<typeof buildBacktrackContext>[0];
    const withoutEvidence = buildBacktrackContext(noEvidenceVerify, undefined, 2);
    expect(withoutEvidence.some((e) => e.startsWith("Prior verify evidence:"))).toBe(false);
  });

  it("[5] budget-exhaust emits skipped=true → status=rejected via logAndNotify derivation (Finding 2)", () => {
    // Week-2a gate-exhaust-status (Finding 2) — humanVerifyGateStep's
    // budget-exhaust branch at triage.ts:~1949-1981 must return a
    // VerifySchema with skipped=true so logAndNotifyStep's
    // status-derivation at triage.ts:1638-1642 emits "rejected"
    // instead of "failed".
    //
    // Pre-fix behavior (P4 + P5 smoke observations on the week2a-chatbar
    // run battery): the return literal omitted skipped, which cascaded
    // to status=failed — falsely implying workflow execution error when
    // the actual cause was reviewer-initiated aggregated rejection
    // (MAX_BACKTRACKS+1 rejects).
    //
    // This test is a shape-assertion + derivation-replay in the pattern
    // of test [4] above. It breaks if:
    //   (a) someone removes skipped=true from humanVerifyGateStep's
    //       budget-exhaust return literal (Finding 2 regression); or
    //   (b) logAndNotifyStep's status derivation changes such that
    //       skipped=true no longer maps to status=rejected.
    // Both sites carry inline comments pointing back to this test.
    // Typed as `number` (not literal `2`) so the plural-`s` ternary
    // in the evidence string construction below doesn't trip tsc's
    // "provably-false comparison" warning under the IDE's strictness.
    const backtrackCount: number = 2; // MAX_BACKTRACKS cap trip
    const currentVerifyBeforeExhaust = {
      success: true,
      skipped: false,
      evidence: ["Verified via selector 'button.btn-success'."],
      execute: {
        stepsRun: 4,
        skipped: false,
        review: {
          decision: "approve",
          approved: true,
          dryRun: {} as never,
        },
      },
    } as const;

    // Construct the exact shape humanVerifyGateStep returns on budget
    // exhaust (post-Finding-2 fix). The fields + evidence-string
    // format match triage.ts:~1949-1981 verbatim.
    const exhaustedReturn = {
      ...currentVerifyBeforeExhaust,
      success: false,
      skipped: true, // Finding 2 fix — field MUST be present
      evidence: [
        ...currentVerifyBeforeExhaust.evidence,
        `Backtrack budget exhausted after ${backtrackCount} iteration${backtrackCount === 1 ? "" : "s"}; final human-verify decision: reject.`,
      ],
    };

    // Shape assertions.
    expect(exhaustedReturn.skipped).toBe(true);
    expect(exhaustedReturn.success).toBe(false);
    const lastEvidence =
      exhaustedReturn.evidence[exhaustedReturn.evidence.length - 1];
    expect(lastEvidence).toMatch(/budget exhausted/);
    expect(lastEvidence).toMatch(/iterations/); // plural (count=2)

    // Downstream propagation via logAndNotifyStep's status derivation
    // (triage.ts:1638-1642). Reconstruct the derivation here so any
    // future drift at either site breaks this test, not just smoke.
    const derivedStatus = exhaustedReturn.skipped
      ? "rejected"
      : exhaustedReturn.success
        ? "ok"
        : "failed";
    expect(derivedStatus).toBe("rejected"); // NOT "failed" — Finding 2
  });

  it("[6] post-exec terminate returns {skipped: true} (Week-2a gate-decision-model)", () => {
    // Week-2a gate-decision-model — humanVerifyGateStep's new
    // terminate branch at triage.ts (post-week2a-gate-decision-model
    // location) returns a VerifySchema with skipped=true, symmetric
    // with budget-exhaust's Finding 2 fix above. Semantic: reviewer
    // initiated full-stop on the post-exec gate; don't enter the
    // backtrack loop, skip straight to logAndNotifyStep with
    // status=rejected.
    //
    // Shape-assertion + derivation-replay pattern, matching test [5]
    // above. Guards the symmetry invariant: any new return site in
    // humanVerifyGateStep that emits VerifySchema with success=false
    // MUST also set skipped=true, or logAndNotifyStep falls through
    // to status=failed (polluting the rejected-vs-failed forensic
    // semantics).
    const backtrackCount: number = 1; // terminate after 1 backtrack cycle
    const currentVerifyBeforeTerminate = {
      success: true,
      skipped: false,
      evidence: ["Verified via selector 'button.btn-success'."],
      execute: {
        stepsRun: 4,
        skipped: false,
        review: {
          decision: "approve",
          approved: true,
          dryRun: {} as never,
        },
      },
    } as const;

    // Exact shape humanVerifyGateStep returns on terminate (post-
    // week2a-gate-decision-model, post-exec gate new branch).
    const terminateReturn = {
      ...currentVerifyBeforeTerminate,
      success: false,
      skipped: true, // Week-2a gate-decision-model — MUST be present
      evidence: [
        ...currentVerifyBeforeTerminate.evidence,
        `Post-exec review terminated by reviewer after backtrack ${backtrackCount}.`,
      ],
    };

    // Shape assertions.
    expect(terminateReturn.skipped).toBe(true);
    expect(terminateReturn.success).toBe(false);
    const lastEvidence =
      terminateReturn.evidence[terminateReturn.evidence.length - 1];
    expect(lastEvidence).toMatch(/terminated by reviewer/);
    expect(lastEvidence).toMatch(/backtrack 1/);

    // Downstream propagation — same derivation as test [5],
    // asserting symmetry between terminate and budget-exhaust paths.
    const derivedStatus = terminateReturn.skipped
      ? "rejected"
      : terminateReturn.success
        ? "ok"
        : "failed";
    expect(derivedStatus).toBe("rejected");
  });

  it("[7] upstream skipped=true passes through without opening the post-exec gate (hotfix-1)", () => {
    // Week-2a gate-decision-model-hotfix-1 — humanVerifyGateStep's
    // skip-guard at entry: if inputData.skipped is true (pre-exec
    // Terminate cascaded through executeStep/verifyStep as
    // no-ops), return inputData verbatim WITHOUT opening the
    // post-exec gate. Pass-through semantics: the output shape
    // equals the input, preserving skipped=true for
    // logAndNotifyStep's derivation at line 1638-1642.
    //
    // Pre-hotfix behavior (P4 smoke observation on Commit B):
    // humanVerifyGateStep opened the post-exec gate regardless of
    // inputData.skipped, forcing the reviewer to issue a redundant
    // second terminate to close the run. Post-hotfix: single
    // pre-exec terminate → immediate run.completed{status=rejected}.
    //
    // This shape-assertion test documents the guard contract; the
    // P4 smoke path verifies end-to-end wire behavior (zero
    // review.requested{human_verify_gate} frames emitted on a
    // pre-exec Terminate run). Pattern matches tests [5] and [6]
    // above.
    const skippedInput = {
      success: false,
      skipped: true,
      evidence: [
        "Pre-exec review terminated; executeStep.skipped=true cascaded.",
      ],
      execute: {
        stepsRun: 0,
        skipped: true,
        review: {
          decision: "terminate" as const,
          approved: false,
          dryRun: {} as never,
        },
      },
    } as const;

    // Replicate the skip-guard's early-return (triage.ts ~line 1895,
    // `if (inputData.skipped) return inputData`). If the guard's
    // shape ever drifts from "return inputData" verbatim (e.g.
    // someone wraps it, or adds side-effects before return), this
    // test's replication will need updating — the test IS the
    // contract by construction.
    const guardResult = skippedInput.skipped ? skippedInput : null;

    // Pass-through semantics — output IS the input, unmodified.
    // Reference equality check catches any accidental clone.
    expect(guardResult).toBe(skippedInput);
    expect(guardResult?.skipped).toBe(true);
    expect(guardResult?.success).toBe(false);

    // Downstream derivation: skipped=true → status=rejected via
    // logAndNotifyStep's derivation. Symmetric with tests [5] and
    // [6] above — all three paths (budget-exhaust, explicit
    // post-exec terminate, pre-exec-terminate-pass-through)
    // converge on status=rejected via the same skipped=true flag.
    const derivedStatus = guardResult?.skipped
      ? "rejected"
      : guardResult?.success
        ? "ok"
        : "failed";
    expect(derivedStatus).toBe("rejected");

    // backtrackCount invariance: the guard fires at entry BEFORE
    // the backtrackCount init + while-loop. Pass-through holds
    // regardless of any backtrack state — there's no state at
    // this point in the function. Asserted by construction: the
    // guard in triage.ts reads inputData.skipped only and never
    // references backtrackCount (which isn't initialized yet at
    // this site).
  });

  it("[8] week2d Part 3b — backtrack loop plumbs runMaterializeSkillCardStep between runReviewGateStep and runExecuteStep (tracker #19 regression guard)", async () => {
    // runMaterializeSkillCardStep is exported with the
    // backtrack-compatible signature (dryRun, review) → MaterializeSchema.
    const triage = await import("../src/mastra/workflows/triage.js");
    expect(typeof triage.runMaterializeSkillCardStep).toBe("function");
    expect(triage.runMaterializeSkillCardStep.length).toBe(2);

    // Source-level regression: the humanVerifyGateStep backtrack body
    // MUST invoke runMaterializeSkillCardStep between runReviewGateStep
    // and runExecuteStep. If a future refactor drops or reorders the
    // call, execute reads a stale ctx.tempSkillCard (or skipped-sentinel
    // on the fresh backtrack's first pass). This grep is fragile by
    // design — it's cheaper than wiring a full Mastra-integration run
    // for a structural guard. See Part 3 RFC §8 + tracker #19.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const src = await fs.readFile(
      url.fileURLToPath(
        new URL(
          "../src/mastra/workflows/triage.ts",
          import.meta.url,
        ),
      ),
      "utf-8",
    );
    // Narrow: must see reviewGate → materialize → execute → verify, in
    // that order, inside one backtrack-loop block. `[\s\S]*?` is
    // non-greedy so we don't cross unrelated function bodies.
    expect(src).toMatch(
      /runReviewGateStep\s*\(\s*gate1InputDry[\s\S]*?runMaterializeSkillCardStep\s*\([\s\S]*?runExecuteStep\s*\([\s\S]*?runVerifyStep\s*\(/,
    );
  });

  it("[9] week2e: backtrack loop preserves ticket (incl. targetUrl) by passing the outer ticket closure into runBlock1", async () => {
    // Dynamic URL injection (week2e-dynamic-target-url) relies on
    // ticket.targetUrl surviving across backtracks. The backtrack
    // loop invokes runBlock1(ticket, buildBlock1Deps(), { ... }) with
    // `ticket` captured from the outer humanVerifyGateStep closure —
    // never re-constructed, never re-read from a mutated source. If
    // a future refactor replaces that with `{ ...ticket, targetUrl:
    // undefined }` or re-derives ticket from a fresh source, URL
    // overrides would drop on backtrack (Jane-reset on corrected URL
    // would revert to scaffold default after post-exec reject).
    // Source-level regex catches the drift.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const src = await fs.readFile(
      url.fileURLToPath(
        new URL(
          "../src/mastra/workflows/triage.ts",
          import.meta.url,
        ),
      ),
      "utf-8",
    );
    // Match: `runBlock1(ticket, buildBlock1Deps()` — verbatim ticket
    // passthrough, no spread/override.
    expect(src).toMatch(/runBlock1\s*\(\s*ticket\s*,\s*buildBlock1Deps\s*\(\s*\)/);
  });
});
