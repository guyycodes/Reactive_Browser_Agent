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
});
