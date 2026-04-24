import { describe, it, expect } from "vitest";
import {
  ENVELOPE_VERSION,
  MAX_FRAME_BYTES,
  frameSchema,
  clientFrameSchema,
  isTimelineFrame,
} from "../src/events/envelope.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-04-22T12:00:00.000Z";

describe("envelope — timeline frames", () => {
  it("parses a run.started frame", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 0,
      ts: NOW,
      stepId: "agent",
      type: "run.started",
      ticket: { ticketId: "T-1", subject: "reset jane" },
    };
    const res = frameSchema.safeParse(f);
    expect(res.success).toBe(true);
  });

  it("parses an llm.thinking.delta frame", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 12,
      ts: NOW,
      stepId: "plan",
      type: "llm.thinking.delta",
      text: "considering the options...",
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("rejects a timeline frame with seq: null", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: null,
      ts: NOW,
      stepId: "agent",
      type: "run.started",
      ticket: { ticketId: "T-1", subject: "x" },
    };
    expect(frameSchema.safeParse(f).success).toBe(false);
  });

  it("isTimelineFrame returns true for numeric seq", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 3,
      ts: NOW,
      stepId: "agent",
      type: "step.started",
    };
    const parsed = frameSchema.safeParse(f);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isTimelineFrame(parsed.data)).toBe(true);
    }
  });
});

describe("envelope — transport frames (seq: null)", () => {
  it("parses a heartbeat with seq: null", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: null,
      ts: NOW,
      stepId: "agent",
      type: "heartbeat",
    };
    const res = frameSchema.safeParse(f);
    expect(res.success).toBe(true);
  });

  it("rejects a heartbeat with seq: 0", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 0,
      ts: NOW,
      stepId: "agent",
      type: "heartbeat",
    };
    expect(frameSchema.safeParse(f).success).toBe(false);
  });

  it("parses a resync transport frame", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: null,
      ts: NOW,
      stepId: "agent",
      type: "resync",
      reason: "buffer_overflow",
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("isTimelineFrame returns false for null seq", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: null,
      ts: NOW,
      stepId: "agent",
      type: "heartbeat",
    } as const;
    const parsed = frameSchema.safeParse(f);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isTimelineFrame(parsed.data)).toBe(false);
    }
  });
});

describe("envelope — frame size guard", () => {
  it("accepts a frame under the 16 KiB cap", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 0,
      ts: NOW,
      stepId: "plan",
      type: "llm.text.delta",
      text: "x".repeat(1024),
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("rejects a frame over the 16 KiB cap", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 0,
      ts: NOW,
      stepId: "plan",
      type: "llm.text.delta",
      text: "x".repeat(MAX_FRAME_BYTES + 1024),
    };
    const res = frameSchema.safeParse(f);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toMatch(/MAX_FRAME_BYTES/);
    }
  });

  // Commit 7b.ii — ReAct iteration envelope variants.
  // See `src/mastra/lib/reactRunner.ts` for the runner that emits these.
  const REACT_RUN_ID = "33333333-3333-4333-8333-333333333333";
  const REACT_ITER_ID = "44444444-4444-4444-8444-444444444444";

  it("parses a react.iteration.started frame (7b.ii)", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 20,
      ts: NOW,
      stepId: "retrieve",
      type: "react.iteration.started",
      reactRunId: REACT_RUN_ID,
      iteration: 0,
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("parses a react.iteration.completed frame with final=true + observationSummary (7b.ii)", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 21,
      ts: NOW,
      stepId: "retrieve",
      type: "react.iteration.completed",
      reactRunId: REACT_RUN_ID,
      iteration: 0,
      final: true,
      toolUsed: "rag_retrieveRunbooks",
      observationSummary: "3 hits, top score 0.76",
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("accepts an optional reactIterationId on existing timeline frames (7b.ii)", () => {
    // The optional field lives on `timelineHeader`, so every timeline
    // variant inherits it — test via llm.text.delta as a representative.
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 22,
      ts: NOW,
      stepId: "retrieve",
      reactIterationId: REACT_ITER_ID,
      type: "llm.text.delta",
      text: "considering a refined query...",
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("rejects a react.iteration.started with iteration above the envelope cap (7b.ii)", () => {
    // Schema-level runaway safeguard: even though the runner caps at
    // `maxIterations` (default 3), the envelope guards at 20 so a
    // pathological emitter can't smuggle a four-digit iteration past
    // frameSchema validation.
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 23,
      ts: NOW,
      stepId: "retrieve",
      type: "react.iteration.started",
      reactRunId: REACT_RUN_ID,
      iteration: 999,
    };
    expect(frameSchema.safeParse(f).success).toBe(false);
  });

  // Commit 7b.iii.a — Block 1 iteration envelope variants.
  // See `src/mastra/lib/blockController.ts` for the controller that
  // emits these.

  it("parses a block.iteration.started frame with blockId + iteration (7b.iii.a)", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 30,
      ts: NOW,
      stepId: "block1",
      type: "block.iteration.started",
      blockId: "block1",
      iteration: 0,
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("parses a block.iteration.completed frame with reason enum + observationSummary (7b.iii.a)", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 31,
      ts: NOW,
      stepId: "block1",
      type: "block.iteration.completed",
      blockId: "block1",
      iteration: 1,
      passed: false,
      reason: "plan_requires_context",
      observationSummary:
        "Pass 0 gap: missing Internal Admin Portal URL — retrying with target app context",
    };
    expect(frameSchema.safeParse(f).success).toBe(true);
  });

  it("parses a block.backtrack.triggered frame with carriedContext + backtrackCount (7b.iii.b)", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 40,
      ts: NOW,
      stepId: "human_verify_gate",
      type: "block.backtrack.triggered",
      fromStep: "human_verify_gate",
      toBlock: "block1",
      carriedContext: [
        "Prior attempt: execute completed 3 of 4 steps but verify reported needs-review.",
        "Human decision: reject — password reset was applied to the wrong user.",
      ],
      backtrackCount: 1,
    };
    expect(frameSchema.safeParse(f).success).toBe(true);

    // Reject runaway backtrackCount values past the envelope cap.
    const fBad = { ...f, backtrackCount: 99 };
    expect(frameSchema.safeParse(fBad).success).toBe(false);
  });

  it("accepts an optional reviewHint on review.requested (7b.iii.b — pre_exec vs post_exec)", () => {
    // Shape: happy-path pre-exec review (no reviewHint — backward-compat
    // for consumers that don't know about it).
    const fPreImplicit = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 41,
      ts: NOW,
      stepId: "review_gate",
      type: "review.requested",
      plan: {
        planId: "33333333-3333-4333-8333-333333333333",
        actionCount: 8,
        destructive: true,
        skillCardIds: [],
      },
      screenshots: ["playwright-videos/" + RUN_ID + "/dry_run-users.png"],
      viewerUrl: "http://localhost:3000/agent/review/" + RUN_ID,
      requiresApproval: true,
    };
    expect(frameSchema.safeParse(fPreImplicit).success).toBe(true);

    // Explicit pre_exec.
    expect(
      frameSchema.safeParse({ ...fPreImplicit, reviewHint: "pre_exec" }).success,
    ).toBe(true);

    // Post-exec variant (stepId + reviewHint both signal it).
    const fPost = {
      ...fPreImplicit,
      seq: 42,
      stepId: "human_verify_gate",
      screenshots: [], // post-exec evidence lives in the feed for 7b.iii.b
      reviewHint: "post_exec",
    };
    expect(frameSchema.safeParse(fPost).success).toBe(true);

    // Invalid enum value rejected.
    const fBad = { ...fPreImplicit, reviewHint: "somewhere_else" };
    expect(frameSchema.safeParse(fBad).success).toBe(false);
  });

  it("accepts an optional blockResult on review.requested (7b.iii.a — exhausted-passes path)", () => {
    // On the exhausted path (Block 1 hits max passes without a viable
    // plan), the synthesized review.requested frame carries
    // blockResult so the reviewer UI can render the "exhausted" banner
    // + disable the approve button. Absent on happy-path review
    // requests — the optional shape preserves backward compat.
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 32,
      ts: NOW,
      stepId: "review_gate",
      type: "review.requested",
      plan: {
        planId: "33333333-3333-4333-8333-333333333333",
        actionCount: 0,
        destructive: false,
        skillCardIds: [],
      },
      screenshots: [],
      viewerUrl: "http://localhost:3000/agent/review/" + RUN_ID,
      requiresApproval: true,
      blockResult: {
        passes: 3,
        passedLast: false,
        allReasons: [
          "plan_requires_context",
          "plan_requires_context",
          "max_iterations",
        ],
      },
    };
    expect(frameSchema.safeParse(f).success).toBe(true);

    // Sanity: happy-path review.requested without blockResult still
    // parses (backward compat).
    const fHappy = { ...f, blockResult: undefined } as Record<string, unknown>;
    delete fHappy.blockResult;
    expect(frameSchema.safeParse(fHappy).success).toBe(true);
  });

  it("rejects a rag.retrieved frame with too many hits", () => {
    const f = {
      v: ENVELOPE_VERSION,
      runId: RUN_ID,
      seq: 0,
      ts: NOW,
      stepId: "retrieve",
      type: "rag.retrieved",
      collection: "d96b439c-5e3d-4e25-9790-f2235ffffe26",
      query: "anything",
      hits: Array.from({ length: 11 }, (_, i) => ({
        chunkId: i,
        score: 0.5,
        preview: "short",
        source: "x.html",
      })),
    };
    expect(frameSchema.safeParse(f).success).toBe(false);
  });
});

describe("envelope — client frames", () => {
  it("parses a hello with resumeSeq", () => {
    const res = clientFrameSchema.safeParse({
      type: "hello",
      runId: RUN_ID,
      resumeSeq: 7,
    });
    expect(res.success).toBe(true);
  });

  it("parses a review.decide with idempotencyKey", () => {
    const res = clientFrameSchema.safeParse({
      type: "review.decide",
      decision: "approve",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
    expect(res.success).toBe(true);
  });

  it("rejects an unknown client frame type", () => {
    const res = clientFrameSchema.safeParse({ type: "something.else" });
    expect(res.success).toBe(false);
  });
});
