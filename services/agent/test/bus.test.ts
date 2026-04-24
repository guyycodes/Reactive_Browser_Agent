import { describe, it, expect } from "vitest";
import { EventBus, ConflictError } from "../src/events/bus.js";
import type { Frame, TimelineFrame } from "../src/events/envelope.js";
import { MAX_FRAME_BYTES } from "../src/events/envelope.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function makeBus(size = 4): EventBus {
  return new EventBus({ ringBufferSize: size });
}

function publishSimple(bus: EventBus, runId: string, text: string): void {
  bus.publish({
    runId,
    stepId: "agent",
    payload: { type: "llm.text.delta", text },
  });
}

describe("EventBus — publish / subscribe / seq", () => {
  it("assigns monotonic seq numbers per run", () => {
    const bus = makeBus();
    const seen: number[] = [];
    bus.subscribe(RUN_ID, (f) => {
      if (f.seq !== null) seen.push(f.seq);
    });
    publishSimple(bus, RUN_ID, "a");
    publishSimple(bus, RUN_ID, "b");
    publishSimple(bus, RUN_ID, "c");
    expect(seen).toEqual([0, 1, 2]);
    expect(bus.nextSeq(RUN_ID)).toBe(3);
  });

  it("isolates seq across different runs", () => {
    const bus = makeBus();
    const other = "22222222-2222-4222-8222-222222222222";
    publishSimple(bus, RUN_ID, "a");
    publishSimple(bus, other, "b");
    publishSimple(bus, RUN_ID, "c");
    expect(bus.nextSeq(RUN_ID)).toBe(2);
    expect(bus.nextSeq(other)).toBe(1);
  });

  it("fans out to multiple subscribers", () => {
    const bus = makeBus();
    const a: Frame[] = [];
    const b: Frame[] = [];
    bus.subscribe(RUN_ID, (f) => a.push(f));
    bus.subscribe(RUN_ID, (f) => b.push(f));
    publishSimple(bus, RUN_ID, "x");
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });
});

describe("EventBus — ring buffer + replay", () => {
  it("replay returns only frames with seq > resumeSeq", () => {
    const bus = makeBus(10);
    publishSimple(bus, RUN_ID, "a");
    publishSimple(bus, RUN_ID, "b");
    publishSimple(bus, RUN_ID, "c");
    const frames = bus.replay(RUN_ID, 0);
    const seqs = frames.map((f) => f.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it("ring buffer evicts oldest frames when full", () => {
    const bus = makeBus(3);
    for (let i = 0; i < 6; i++) publishSimple(bus, RUN_ID, `m${i}`);
    // Only seq 3,4,5 should still be buffered.
    const all = bus.replay(RUN_ID, -1).map((f: TimelineFrame) => f.seq);
    expect(all).toEqual([3, 4, 5]);
  });

  it("didBufferEvictBefore detects eviction", () => {
    const bus = makeBus(2);
    for (let i = 0; i < 5; i++) publishSimple(bus, RUN_ID, `m${i}`);
    // Buffer holds seq 3,4. Asking to resume from 0 → seq 1,2 were evicted.
    expect(bus.didBufferEvictBefore(RUN_ID, 0)).toBe(true);
    // Asking to resume from 2 → buffer's oldest (3) is exactly resumeSeq+1, no gap.
    expect(bus.didBufferEvictBefore(RUN_ID, 2)).toBe(false);
    // Asking to resume from 3 → buffer holds 3, no gap (will replay from 4).
    expect(bus.didBufferEvictBefore(RUN_ID, 3)).toBe(false);
  });
});

describe("EventBus — frame size guard", () => {
  it("oversized publish results in a synthetic run.failed frame", () => {
    const bus = makeBus();
    const captured: Frame[] = [];
    bus.subscribe(RUN_ID, (f) => captured.push(f));
    bus.publish({
      runId: RUN_ID,
      stepId: "plan",
      payload: {
        type: "llm.text.delta",
        text: "x".repeat(MAX_FRAME_BYTES + 1024),
      },
    });
    expect(captured.length).toBe(1);
    expect(captured[0]?.type).toBe("run.failed");
  });

  it("subsequent publishes still advance seq after a synthetic failure", () => {
    const bus = makeBus();
    const captured: Frame[] = [];
    bus.subscribe(RUN_ID, (f) => captured.push(f));
    bus.publish({
      runId: RUN_ID,
      stepId: "plan",
      payload: {
        type: "llm.text.delta",
        text: "x".repeat(MAX_FRAME_BYTES + 1024),
      },
    });
    publishSimple(bus, RUN_ID, "next");
    // Synthetic run.failed took seq=0, next delta took seq=1.
    expect(captured.map((f) => f.seq)).toEqual([0, 1]);
  });
});

describe("EventBus — review decisions", () => {
  const IDEM = "33333333-3333-4333-8333-333333333333";
  const IDEM2 = "44444444-4444-4444-8444-444444444444";

  it("first-writer-wins commits the decision and emits review.decided", () => {
    const bus = makeBus();
    const captured: Frame[] = [];
    bus.subscribe(RUN_ID, (f) => captured.push(f));

    bus.publishClientDecision(RUN_ID, {
      decision: "approve",
      by: "alice",
      at: "2026-04-22T12:00:00.000Z",
      idempotencyKey: IDEM,
    });
    const decided = captured.find((f) => f.type === "review.decided");
    expect(decided).toBeDefined();
  });

  it("same idempotency key replays the original decision", () => {
    const bus = makeBus();
    const first = bus.publishClientDecision(RUN_ID, {
      decision: "approve",
      by: "alice",
      at: "2026-04-22T12:00:00.000Z",
      idempotencyKey: IDEM,
    });
    const second = bus.publishClientDecision(RUN_ID, {
      decision: "reject", // different intent
      by: "alice",
      at: "2026-04-22T12:00:00.000Z",
      idempotencyKey: IDEM, // but same key
    });
    expect(second.decision).toBe(first.decision);
  });

  it("different idempotency key after commit throws ConflictError", () => {
    const bus = makeBus();
    bus.publishClientDecision(RUN_ID, {
      decision: "approve",
      by: "alice",
      at: "2026-04-22T12:00:00.000Z",
      idempotencyKey: IDEM,
    });
    expect(() =>
      bus.publishClientDecision(RUN_ID, {
        decision: "reject",
        by: "bob",
        at: "2026-04-22T12:01:00.000Z",
        idempotencyKey: IDEM2,
      }),
    ).toThrow(ConflictError);
  });

  it("awaitDecision resolves when a decision is committed", async () => {
    const bus = makeBus();
    const p = bus.awaitDecision(RUN_ID);
    bus.publishClientDecision(RUN_ID, {
      decision: "approve",
      by: "alice",
      at: "2026-04-22T12:00:00.000Z",
      idempotencyKey: IDEM,
    });
    const got = await p;
    expect(got.decision).toBe("approve");
  });
});

describe("EventBus — per-stepId decision slots (7b.iii.b)", () => {
  const IDEM_A = "55555555-5555-4555-8555-555555555555";
  const IDEM_B = "66666666-6666-4666-8666-666666666666";
  const IDEM_C = "77777777-7777-4777-8777-777777777777";

  it("[1] awaitDecisionForStep is scoped: a review_gate decision does not resolve a human_verify_gate awaiter", async () => {
    const bus = makeBus();
    const humanVerifyP = bus.awaitDecisionForStep(RUN_ID, "human_verify_gate");
    let humanVerifyResolved = false;
    void humanVerifyP.then(() => {
      humanVerifyResolved = true;
    });

    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "approve",
      by: "alice",
      at: "2026-04-23T00:00:00.000Z",
      idempotencyKey: IDEM_A,
    });
    // Yield twice to drain any accidental synchronous resolution path.
    await Promise.resolve();
    await Promise.resolve();
    expect(humanVerifyResolved).toBe(false);

    bus.publishClientDecisionForStep(RUN_ID, "human_verify_gate", {
      decision: "reject",
      by: "alice",
      at: "2026-04-23T00:00:01.000Z",
      idempotencyKey: IDEM_B,
    });
    const d = await humanVerifyP;
    expect(d.decision).toBe("reject");
    expect(d.by).toBe("alice");
  });

  it("[2] multi-invocation on same stepId: sequential await+publish cycles each resolve with a fresh decision", async () => {
    const bus = makeBus();

    const p1 = bus.awaitDecisionForStep(RUN_ID, "review_gate");
    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "edit",
      by: "alice",
      at: "2026-04-23T00:00:00.000Z",
      idempotencyKey: IDEM_A,
      patch: { notes: "please add auth steps" },
    });
    const d1 = await p1;
    expect(d1.decision).toBe("edit");

    // Second iteration (pre-exec refine retry with fresh decision):
    const p2 = bus.awaitDecisionForStep(RUN_ID, "review_gate");
    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "approve",
      by: "alice",
      at: "2026-04-23T00:00:10.000Z",
      idempotencyKey: IDEM_B,
    });
    const d2 = await p2;
    expect(d2.decision).toBe("approve");
  });

  it("[3] stale pre-delivered decision is discarded on new-slot-open after a prior resolve", async () => {
    const bus = makeBus();

    // Slot 0: resolve normally via waiter-shift.
    const p1 = bus.awaitDecisionForStep(RUN_ID, "review_gate");
    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "edit",
      by: "alice",
      at: "2026-04-23T00:00:00.000Z",
      idempotencyKey: IDEM_A,
    });
    await p1;

    // Race: a rogue publish arrives BEFORE the next await opens.
    // This is the diagnostic scenario the stale-discard branch guards.
    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "approve",
      by: "mallory",
      at: "2026-04-23T00:00:01.000Z",
      idempotencyKey: IDEM_B,
    });

    // Slot 1: the buffered stale commit must be discarded, not
    // silently consumed. The await should block until a fresh
    // decision is committed.
    const p2 = bus.awaitDecisionForStep(RUN_ID, "review_gate");
    let resolvedEarly = false;
    void p2.then(() => {
      resolvedEarly = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvedEarly).toBe(false);

    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "reject",
      by: "alice",
      at: "2026-04-23T00:00:02.000Z",
      idempotencyKey: IDEM_C,
    });
    const d2 = await p2;
    expect(d2.decision).toBe("reject");
    expect(d2.by).toBe("alice");
  });

  it("[4] idempotency is stepId-scoped: same key on different stepIds is independent", () => {
    const bus = makeBus();
    const first = bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "approve",
      by: "alice",
      at: "2026-04-23T00:00:00.000Z",
      idempotencyKey: IDEM_A,
    });
    // Same key on a DIFFERENT stepId — independent gate, no replay,
    // no conflict.
    const second = bus.publishClientDecisionForStep(RUN_ID, "human_verify_gate", {
      decision: "reject",
      by: "alice",
      at: "2026-04-23T00:00:01.000Z",
      idempotencyKey: IDEM_A,
    });
    expect(first.decision).toBe("approve");
    expect(second.decision).toBe("reject");
  });

  it("[5] ConflictError within a single slot: different key while decision buffered → throws, carries stepId", () => {
    const bus = makeBus();
    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "approve",
      by: "alice",
      at: "2026-04-23T00:00:00.000Z",
      idempotencyKey: IDEM_A,
    });
    let caught: unknown;
    try {
      bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
        decision: "reject",
        by: "bob",
        at: "2026-04-23T00:00:01.000Z",
        idempotencyKey: IDEM_B,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).stepId).toBe("review_gate");
    expect((caught as ConflictError).existingDecision.decision).toBe("approve");
  });

  it("[6] back-compat shim: awaitDecision + publishClientDecision default to review_gate", async () => {
    const bus = makeBus();
    const p = bus.awaitDecision(RUN_ID);
    // Commit via the new API on review_gate should resolve the
    // old-API shim's await.
    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "approve",
      by: "alice",
      at: "2026-04-23T00:00:00.000Z",
      idempotencyKey: IDEM_A,
    });
    const d = await p;
    expect(d.decision).toBe("approve");

    // Reverse: publish via shim, await via new API.
    const OTHER_RUN = "88888888-8888-4888-8888-888888888888";
    const p2 = bus.awaitDecisionForStep(OTHER_RUN, "review_gate");
    bus.publishClientDecision(OTHER_RUN, {
      decision: "reject",
      by: "alice",
      at: "2026-04-23T00:00:01.000Z",
      idempotencyKey: IDEM_B,
    });
    const d2 = await p2;
    expect(d2.decision).toBe("reject");
  });

  it("[7] idempotency is per-slot: same key reused across slots is a fresh commit, not a replay", async () => {
    const bus = makeBus();

    // Slot 0 resolves via waiter-shift. Waiter's wake callback must
    // clear the idempotencyMap so slot 1 sees a fresh scope.
    const p1 = bus.awaitDecisionForStep(RUN_ID, "review_gate");
    bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "edit",
      by: "alice",
      at: "2026-04-23T00:00:00.000Z",
      idempotencyKey: IDEM_A,
    });
    const d1 = await p1;
    expect(d1.decision).toBe("edit");

    // Slot 1 opens. Client accidentally reuses IDEM_A.
    //   Under per-run idempotency (bug): would replay slot-0's "edit"
    //   decision and the new waiter would hang forever.
    //   Under per-slot idempotency (correct, this commit): the reused
    //   key is a fresh commit on the new slot; the waiter resolves.
    const p2 = bus.awaitDecisionForStep(RUN_ID, "review_gate");
    const committed = bus.publishClientDecisionForStep(RUN_ID, "review_gate", {
      decision: "approve",
      by: "alice",
      at: "2026-04-23T00:00:10.000Z",
      idempotencyKey: IDEM_A,
    });
    expect(committed.decision).toBe("approve");
    const d2 = await p2;
    expect(d2.decision).toBe("approve");
  });
});

describe("EventBus — transport frames", () => {
  it("transport publishes do not consume seq", () => {
    const bus = makeBus();
    publishSimple(bus, RUN_ID, "a");
    bus.publishTransport({
      runId: RUN_ID,
      stepId: "agent",
      payload: { type: "heartbeat" },
    });
    publishSimple(bus, RUN_ID, "b");
    // Two timeline frames -> nextSeq 2, despite the intervening heartbeat.
    expect(bus.nextSeq(RUN_ID)).toBe(2);
  });

  it("transport frames are not in replay()", () => {
    const bus = makeBus();
    publishSimple(bus, RUN_ID, "a");
    bus.publishTransport({
      runId: RUN_ID,
      stepId: "agent",
      payload: { type: "heartbeat" },
    });
    const replay = bus.replay(RUN_ID, -1);
    expect(replay.every((f) => f.type !== "heartbeat")).toBe(true);
  });
});
