import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  ENVELOPE_VERSION,
  MAX_FRAME_BYTES,
  frameSchema,
  isTimelineFrame,
} from "./envelope.js";
import type {
  Frame,
  TimelineFrame,
  TimelineFramePayload,
  TransportFramePayload,
  StepId,
} from "./envelope.js";
import { logger } from "../logger.js";

/**
 * In-memory event bus for the agent service.
 *
 * Responsibilities
 * ----------------
 * 1. Assign monotonic `seq` numbers to timeline frames (per `runId`).
 * 2. Maintain a bounded ring buffer per run so reconnecting WS clients can
 *    resume from a `resumeSeq` without replaying from Postgres on every
 *    reconnect (Postgres is still the durable store — see persist.ts).
 * 3. Enforce the 16 KiB per-frame size guard by running each emitted frame
 *    through `frameSchema`. An oversized or malformed frame is NOT
 *    published; instead the bus synthesises a `run.failed` frame and emits
 *    that to all subscribers, so the run visibly dies rather than silently
 *    truncating.
 * 4. Broker human review decisions from WS/HTTP back into the Mastra
 *    workflow's `suspend()/resume()` mechanism, with first-writer-wins
 *    idempotency keyed on (runId, idempotencyKey).
 *
 * Not responsibilities (deliberately)
 * -----------------------------------
 * - Durable persistence (persist.ts does that via Postgres).
 * - Cross-process fan-out (v1 is single-process; if we ever scale to multiple
 *   agent replicas, swap this for Postgres LISTEN/NOTIFY or Redis pub/sub
 *   behind the same surface).
 */

export interface PublishInput {
  runId: string;
  stepId: StepId;
  // Discriminated-union payload (one branch per timeline frame variant).
  // Uses DistributivelyOmit so `type`-specific fields (`ticket`, `status`,
  // `text`, etc.) survive after removing header fields the bus fills in.
  payload: TimelineFramePayload;
}

export interface PublishTransportInput {
  runId: string;
  stepId: StepId;
  payload: TransportFramePayload;
}

export interface ReviewDecision {
  decision: "approve" | "reject" | "edit";
  by: string;
  at: string;
  idempotencyKey?: string;
  patch?: Record<string, unknown>;
}

export class ConflictError extends Error {
  constructor(
    public readonly runId: string,
    public readonly existingDecision: ReviewDecision,
    /** 7b.iii.b — which stepId's gate slot is already committed.
     *  Optional for back-compat with pre-7b.iii.b catch sites that
     *  read only `existingDecision`. New catch sites can branch on
     *  this to present gate-specific error copy. */
    public readonly stepId?: StepId,
  ) {
    super(
      `Review decision already recorded for run ${runId}` +
        (stepId ? ` (stepId=${stepId})` : "") +
        `; first-writer-wins.`,
    );
    this.name = "ConflictError";
  }
}

/** 7b.iii.b — Back-compat default stepId for the un-scoped
 *  `awaitDecision` / `publishClientDecision` shims. Pre-7b.iii.b the
 *  bus had a single slot per run; all decisions implicitly targeted
 *  the pre-exec review_gate. The new per-stepId API
 *  (`awaitDecisionForStep` / `publishClientDecisionForStep`) is
 *  authoritative; the old names default stepId to this constant. */
const DEFAULT_GATE_STEP_ID: StepId = "review_gate";

/** 7b.iii.b — Per-(runId, stepId) gate slot state.
 *
 *  One StepGateState per gate the workflow can suspend on — pre-exec
 *  `review_gate` today, post-exec `human_verify_gate` once 7b.iii.b
 *  commit 3 un-parks it, any Week-3 skill-card authorization gate
 *  after that. Each `review.requested` → `awaitDecisionForStep` →
 *  `publishClientDecisionForStep` cycle is one "slot." Slots for the
 *  same stepId run sequentially across the pre-exec refine loop
 *  (7b.iii.b commit 2) and the post-exec backtrack loop (7b.iii.b
 *  commit 3); slots for different stepIds are independent.
 *
 *  Slot resolution (three paths) MUST clear `idempotencyMap` so each
 *  new slot is a fresh scope for replay semantics — otherwise a
 *  client that accidentally reuses an idempotencyKey across slots
 *  would get its new decision silently rewritten to the prior slot's
 *  cached one, and the waiter would hang forever. */
interface StepGateState {
  /** Most recent commit awaiting consumption by the next
   *  `awaitDecisionForStep`. Null while the slot is either
   *  open-with-waiter or fresh-since-last-resolution. */
  committedDecision: ReviewDecision | null;
  /** Waiters for this stepId's next decision. One await → one push;
   *  one publish with a live waiter → shift+wake. */
  waiters: Array<(d: ReviewDecision) => void>;
  /** Idempotency replay map scoped to the CURRENT slot on this
   *  stepId. Cleared on every slot-end path (pre-delivery consume,
   *  waiter-shift resolve, stale discard) so keys are per-slot,
   *  not per-run. */
  idempotencyMap: Map<string, ReviewDecision>;
  /** Count of `awaitDecisionForStep` calls for this (runId, stepId)
   *  that have resolved. Used to distinguish legitimate pre-delivery
   *  (slotsResolved===0, publish-before-first-await) from stale
   *  lingering decisions (slotsResolved>0 + buffered
   *  committedDecision after an earlier slot resolved). */
  slotsResolved: number;
}

interface RunState {
  nextSeq: number;
  ringBuffer: TimelineFrame[]; // FIFO, bounded by maxBufferSize
  /** Per-stepId gate slots. Created lazily on first await / publish
   *  for that (runId, stepId) tuple via `getOrInitGate`. */
  stepGates: Map<StepId, StepGateState>;
}

export interface EventBusOptions {
  ringBufferSize: number;
}

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly runs = new Map<string, RunState>();
  private readonly maxBufferSize: number;

  // Hook for persist.ts — set by the owner of the bus at wire-up time.
  // Intentionally not an EventEmitter listener because we want back-pressure
  // (awaited) and sequential guarantees.
  public onPersist: ((frame: Frame) => Promise<void>) | null = null;

  constructor(opts: EventBusOptions) {
    this.maxBufferSize = opts.ringBufferSize;
    // Raise max listeners cap to tolerate many concurrent WS subscribers per run.
    this.emitter.setMaxListeners(1000);
  }

  /** Subscribe a listener to live frames for a specific run. Returns unsubscribe. */
  subscribe(runId: string, listener: (frame: Frame) => void): () => void {
    const channel = `run:${runId}`;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  /** Replay buffered timeline frames where `seq > resumeSeq`. If the oldest
   *  buffered frame has a higher seq than `resumeSeq + 1`, the caller has
   *  missed evicted frames; we signal this by emitting a `resync` transport
   *  frame to the caller and returning only what the buffer still holds.
   *  The caller is responsible for reconciling via Postgres if needed. */
  replay(runId: string, resumeSeq: number): TimelineFrame[] {
    const state = this.runs.get(runId);
    if (!state) return [];
    return state.ringBuffer.filter((f) => f.seq > resumeSeq);
  }

  /** Did the buffer evict anything between `resumeSeq+1` and the oldest
   *  in-buffer seq? If yes, the caller should emit a `resync` and then
   *  replay(resumeSeq) for whatever is still in-buffer. */
  didBufferEvictBefore(runId: string, resumeSeq: number): boolean {
    const state = this.runs.get(runId);
    if (!state || state.ringBuffer.length === 0) return false;
    const firstBuffered = state.ringBuffer[0];
    if (!firstBuffered) return false;
    // If oldest in-buffer is greater than what client asked to resume from + 1,
    // something in (resumeSeq, firstBuffered.seq) was evicted.
    return firstBuffered.seq > resumeSeq + 1;
  }

  /** Publish a timeline frame. Assigns `seq`, timestamps, validates size,
   *  appends to ring buffer, fans out to subscribers, and triggers persist.
   *
   *  On validation failure: emits a `run.failed` frame describing the issue
   *  (bypassing the size guard for that synthetic frame) and terminates the
   *  run state. No exception is thrown — the caller is typically an emitter
   *  running inside a Mastra step and doesn't have a sensible recovery path. */
  publish(input: PublishInput): void {
    const state = this.getOrInitState(input.runId);
    const seq = state.nextSeq;

    const frame = {
      v: ENVELOPE_VERSION,
      runId: input.runId,
      stepId: input.stepId,
      seq,
      ts: new Date().toISOString(),
      ...input.payload,
    } as unknown as Frame;

    const parsed = frameSchema.safeParse(frame);
    if (!parsed.success) {
      this.publishSyntheticFailure(input.runId, input.stepId, frame, parsed.error.message);
      return;
    }

    state.nextSeq++;
    const timelineFrame = parsed.data as TimelineFrame;
    this.pushToBuffer(state, timelineFrame);
    this.fanOutAndPersist(input.runId, timelineFrame);
  }

  /** Publish a transport-control frame (seq: null). Not buffered, not persisted. */
  publishTransport(input: PublishTransportInput): void {
    const frame = {
      v: ENVELOPE_VERSION,
      runId: input.runId,
      stepId: input.stepId,
      seq: null,
      ts: new Date().toISOString(),
      ...input.payload,
    } as unknown as Frame;

    const parsed = frameSchema.safeParse(frame);
    if (!parsed.success) {
      // Transport frames should never be oversize; if they are, that's a
      // programming bug — fail loudly but don't kill the run state.
      // eslint-disable-next-line no-console
      console.error(
        `[bus] Invalid transport frame for run ${input.runId}: ${parsed.error.message}`,
      );
      return;
    }

    const channel = `run:${input.runId}`;
    this.emitter.emit(channel, parsed.data);
  }

  /** 7b.iii.b — Record a human review decision targeting a specific
   *  gate's step. First-writer-wins per (runId, stepId) SLOT — one
   *  committed decision per await cycle. Multiple slots run
   *  sequentially across refine / backtrack loops; slots on different
   *  stepIds are independent.
   *
   *  Semantics:
   *    - Same (runId, stepId) + same idempotencyKey cached in the
   *      CURRENT slot's idempotencyMap → returns cached decision
   *      (replay-safe). Idempotency maps are cleared at every slot
   *      resolution so keys are effectively per-slot.
   *    - Slot already has an uncommitted buffered decision + new
   *      different key → ConflictError (first-writer-wins).
   *    - Live waiter for this stepId → decision hands directly to
   *      waiter; the waiter's wake callback clears idempotencyMap
   *      (slot scope resets).
   *    - No waiter → decision buffers in committedDecision for the
   *      next await to consume.
   *
   *  Ordering: the `review.decided` timeline frame is emitted AFTER
   *  the waiter wake so downstream workflow frames (step.started,
   *  eventually run.completed) can't land on the wire before the
   *  decision frame they logically follow — matches the pre-7b.iii.b
   *  ordering guarantee that `runReviewGateStep` depends on. */
  publishClientDecisionForStep(
    runId: string,
    stepId: StepId,
    decision: ReviewDecision,
  ): ReviewDecision {
    const gate = this.getOrInitGate(runId, stepId);

    // Replay: same key already committed on this stepId's CURRENT slot.
    if (
      decision.idempotencyKey &&
      gate.idempotencyMap.has(decision.idempotencyKey)
    ) {
      const known = gate.idempotencyMap.get(decision.idempotencyKey);
      if (known) return known;
    }

    // Slot-scope conflict: a different-key decision is still buffered
    // waiting for the next await to consume. Preserves first-writer-wins
    // within a single gate invocation.
    if (gate.committedDecision !== null) {
      throw new ConflictError(runId, gate.committedDecision, stepId);
    }

    if (decision.idempotencyKey) {
      gate.idempotencyMap.set(decision.idempotencyKey, decision);
    }

    if (gate.waiters.length > 0) {
      // Live waiter — the waiter's wake callback clears idempotencyMap
      // + increments slotsResolved. We do NOT set committedDecision
      // (the waiter consumed it directly).
      const w = gate.waiters.shift()!;
      try {
        w(decision);
      } catch {
        // Swallow — bus shouldn't die because a consumer threw.
      }
    } else {
      // No waiter — buffer for the next await (legitimate pre-delivery
      // on slot 0; potentially-stale on later slots, in which case the
      // next awaitDecisionForStep's stale-discard branch catches it).
      gate.committedDecision = decision;
    }

    // Emit review.decided LAST. `ReviewDecision.patch` is typed as
    // `Record<string, unknown>` at the bus layer (generic for any client
    // payload), whereas the envelope schema narrows it to `PlanPatchSchema`.
    // The double-cast through `unknown` asserts that the subsequent
    // `frameSchema.safeParse` inside `publish()` is authoritative about the
    // runtime shape.
    this.publish({
      runId,
      stepId,
      payload: {
        type: "review.decided",
        decision: decision.decision,
        by: decision.by,
        at: decision.at,
        ...(decision.patch ? { patch: decision.patch } : {}),
      } as unknown as TimelineFramePayload,
    });

    return decision;
  }

  /** 7b.iii.b — Block until a decision is committed for this
   *  (runId, stepId) gate's next slot.
   *
   *  Each call opens a new slot:
   *    - slotsResolved === 0 AND a committedDecision is already
   *      buffered → legitimate pre-delivery (publish landed before
   *      the workflow reached the first await). Consume it, clear
   *      idempotencyMap (new scope), increment slotsResolved.
   *    - slotsResolved > 0 AND a committedDecision is buffered →
   *      stale from a previously resolved slot (client raced the
   *      gate between slots). Discard + clear idempotencyMap, log
   *      a warn, then register a waiter for a fresh decision.
   *    - Otherwise → register waiter; wake callback clears
   *      idempotencyMap + increments slotsResolved. */
  awaitDecisionForStep(runId: string, stepId: StepId): Promise<ReviewDecision> {
    const gate = this.getOrInitGate(runId, stepId);

    if (gate.committedDecision !== null) {
      if (gate.slotsResolved === 0) {
        const d = gate.committedDecision;
        gate.committedDecision = null;
        gate.slotsResolved++;
        gate.idempotencyMap = new Map();
        return Promise.resolve(d);
      }
      // Stale from a previously resolved slot. Discard so the new
      // slot is a clean scope. If this path ever fires in prod it's
      // a diagnostic signal that a client published before the gate
      // re-opened; the UI doesn't normally render a decide button
      // while the workflow is between slots.
      logger.warn(
        {
          runId,
          stepId,
          discardedDecision: gate.committedDecision.decision,
          prevSlots: gate.slotsResolved,
        },
        "[bus] stale pre-delivered decision discarded on new slot open; client may have raced review.requested emission",
      );
      gate.committedDecision = null;
      gate.idempotencyMap = new Map();
    }

    return new Promise<ReviewDecision>((resolve) => {
      gate.waiters.push((d) => {
        gate.slotsResolved++;
        gate.idempotencyMap = new Map();
        resolve(d);
      });
    });
  }

  /** Back-compat shim — defaults stepId to "review_gate" (pre-exec).
   *  Preserves the pre-7b.iii.b API surface so existing clients
   *  (`test/bus.test.ts` cases, external curl scripts) keep working.
   *  New call sites should use `publishClientDecisionForStep`
   *  directly so the intended gate is explicit. */
  publishClientDecision(runId: string, decision: ReviewDecision): ReviewDecision {
    return this.publishClientDecisionForStep(
      runId,
      DEFAULT_GATE_STEP_ID,
      decision,
    );
  }

  /** Back-compat shim — defaults stepId to "review_gate" (pre-exec).
   *  New call sites (post-exec humanVerifyGate in 7b.iii.b commit 3,
   *  skill-card gates in Week-3) should use `awaitDecisionForStep`
   *  directly. */
  awaitDecision(runId: string): Promise<ReviewDecision> {
    return this.awaitDecisionForStep(runId, DEFAULT_GATE_STEP_ID);
  }

  /** Forget a run. Called when the run terminates (completed/failed/rejected)
   *  to prevent unbounded memory growth. Buffered frames are discarded; any
   *  WS reconnect after this point must replay from Postgres. */
  dispose(runId: string): void {
    this.runs.delete(runId);
    this.emitter.removeAllListeners(`run:${runId}`);
  }

  /** Current ring-buffer head (oldest buffered seq, or -1 if empty). */
  oldestBufferedSeq(runId: string): number {
    const state = this.runs.get(runId);
    if (!state || state.ringBuffer.length === 0) return -1;
    return state.ringBuffer[0]?.seq ?? -1;
  }

  /** Current `nextSeq` for this run (i.e. the seq that the next publish will assign). */
  nextSeq(runId: string): number {
    return this.runs.get(runId)?.nextSeq ?? 0;
  }

  /** ---------- internals ---------- */

  private getOrInitState(runId: string): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        nextSeq: 0,
        ringBuffer: [],
        stepGates: new Map(),
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  /** 7b.iii.b — Lazily create per-(runId, stepId) gate slot state.
   *  Called from `publishClientDecisionForStep` and
   *  `awaitDecisionForStep`. */
  private getOrInitGate(runId: string, stepId: StepId): StepGateState {
    const state = this.getOrInitState(runId);
    let gate = state.stepGates.get(stepId);
    if (!gate) {
      gate = {
        committedDecision: null,
        waiters: [],
        idempotencyMap: new Map(),
        slotsResolved: 0,
      };
      state.stepGates.set(stepId, gate);
    }
    return gate;
  }

  private pushToBuffer(state: RunState, frame: TimelineFrame): void {
    state.ringBuffer.push(frame);
    while (state.ringBuffer.length > this.maxBufferSize) {
      state.ringBuffer.shift();
    }
  }

  private fanOutAndPersist(runId: string, frame: Frame): void {
    const channel = `run:${runId}`;
    this.emitter.emit(channel, frame);
    if (this.onPersist) {
      // Fire-and-forget; errors surface via the persister's own logging.
      this.onPersist(frame).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[bus] persist failed for ${runId} seq=${isTimelineFrame(frame) ? frame.seq : "transport"}: ${String(err)}`);
      });
    }
  }

  /** Build and emit a synthetic `run.failed` frame describing the offender.
   *  The synthetic frame is small enough that the size guard can't reject it. */
  private publishSyntheticFailure(
    runId: string,
    stepId: StepId,
    offender: Frame,
    reason: string,
  ): void {
    const state = this.getOrInitState(runId);
    const seq = state.nextSeq++;
    const failureFrame = {
      v: ENVELOPE_VERSION,
      runId,
      stepId,
      seq,
      ts: new Date().toISOString(),
      type: "run.failed" as const,
      error: {
        message: "envelope_violation",
        where: `type=${String(offender.type)}`,
        // Keep reason small to avoid ballooning this frame too.
        stack: reason.slice(0, 1500),
      },
    };

    // Bypass the full schema check (which could loop on an edge-case reason)
    // by constructing the failure frame shape by hand. Push + fan out.
    this.pushToBuffer(state, failureFrame as TimelineFrame);
    this.fanOutAndPersist(runId, failureFrame as Frame);
  }
}

/** Small helper for code sites that need to generate an idempotency key on
 *  behalf of a client that didn't send one (e.g., curl user). */
export function newIdempotencyKey(): string {
  return randomUUID();
}
