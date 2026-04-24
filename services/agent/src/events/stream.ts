import { clientFrameSchema } from "./envelope.js";
import type { Frame, GateStepId } from "./envelope.js";
import type { EventBus } from "./bus.js";
import { ConflictError } from "./bus.js";
import { logger } from "../logger.js";

/**
 * WS stream handler utilities.
 *
 * The Hono upgrade handler in src/index.ts delegates to the functions here so
 * the transport logic stays testable independently of the HTTP framework.
 *
 * Auth model (Week 1A):
 *   - Origin-header allowlist enforced before upgrade (see `isOriginAllowed`).
 *   - No bearer token yet — that lands Week 3 per MASTER_PLAN.
 *
 * Per-socket lifecycle:
 *   1. Client dials `ws://.../stream/:runId`.
 *   2. Origin check (pre-upgrade).
 *   3. Server accepts, waits for a `hello` frame.
 *   4. Replays buffered timeline frames with seq > resumeSeq, emits `resync`
 *      if the buffer has evicted frames in the gap.
 *   5. Subscribes to live frames until close.
 *   6. Client may send `review.decide` to commit a review decision; the bus
 *      enforces first-writer-wins.
 */

/** Normalised origin comparison. We match scheme+host+port exactly. Trailing
 *  slashes and uppercase host components are treated as equivalent to the
 *  lowercase form. Query/hash/path are ignored (they aren't meaningful on
 *  Origin headers per RFC 6454 anyway). */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowlist: readonly string[],
): boolean {
  if (!origin) return false;
  const normalise = (o: string) => {
    try {
      const u = new URL(o);
      // Origin = scheme://host[:port] — no path, no trailing slash.
      return `${u.protocol}//${u.host}`.toLowerCase();
    } catch {
      return o.toLowerCase();
    }
  };
  const needle = normalise(origin);
  return allowlist.some((a) => normalise(a) === needle);
}

/** Outbound sender interface. Abstracts the underlying WS transport so tests
 *  don't need a real socket. */
export interface StreamSender {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
}

/** Per-socket runtime state. Created by `openStream` on each WS connection. */
export interface StreamSession {
  runId: string;
  onClientMessage(raw: string): void;
  onClose(): void;
}

export interface OpenStreamDeps {
  bus: EventBus;
  runId: string;
  sender: StreamSender;
  /** Resolves the identity of the client for review decisions. Week 1A uses
   *  a static "anonymous" identity; Week 3 will populate from the bearer
   *  token. Keeping this pluggable so the auth upgrade is contained. */
  resolveClientIdentity: () => string;
}

/** Open a stream session. The caller wires client inbound bytes through
 *  `session.onClientMessage` and terminal close through `session.onClose`. */
export function openStream(deps: OpenStreamDeps): StreamSession {
  const { bus, runId, sender, resolveClientIdentity } = deps;

  let unsubscribe: (() => void) | null = null;
  let helloReceived = false;

  const sendFrame = (frame: Frame): void => {
    if (!sender.isOpen) return;
    try {
      sender.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn({ runId, err }, "[stream] send failed, closing socket");
      sender.close(1011, "send failed");
    }
  };

  const sendTransportHeartbeat = (reason: "hello_ack" | "keepalive"): void => {
    bus.publishTransport({
      runId,
      stepId: "agent",
      payload: { type: "heartbeat" },
    });
    logger.trace({ runId, reason }, "[stream] heartbeat emitted");
  };

  const handleHello = (resumeSeq: number | undefined): void => {
    const fromSeq = resumeSeq ?? -1;

    // If the buffer evicted frames between fromSeq and the oldest buffered
    // frame, inform the client so it can fall back to Postgres replay.
    if (bus.didBufferEvictBefore(runId, fromSeq)) {
      bus.publishTransport({
        runId,
        stepId: "agent",
        payload: { type: "resync", reason: "buffer_overflow" },
      });
    }

    // Replay whatever the bus still has in memory.
    const backlog = bus.replay(runId, fromSeq);
    for (const f of backlog) sendFrame(f);

    // Subscribe to live frames. We also forward transport frames so the
    // client sees heartbeats/resyncs that originate from the bus.
    unsubscribe = bus.subscribe(runId, sendFrame);

    // Immediate heartbeat so the client has a first "alive" signal.
    sendTransportHeartbeat("hello_ack");
  };

  const handleReviewDecide = (msg: {
    // Week-2a gate-decision-model — mirrors clientFrameSchema in
    // envelope.ts. See the schema docblock there for 4-decision
    // semantic definitions.
    decision: "approve" | "reject" | "edit" | "terminate";
    /** 7b.iii.b — which gate's slot this decision targets. Server
     *  defaults to "review_gate" for back-compat with pre-7b.iii.b
     *  clients that don't send the field. */
    stepId?: GateStepId;
    patch?: Record<string, unknown>;
    idempotencyKey?: string;
  }): void => {
    try {
      bus.publishClientDecisionForStep(
        runId,
        msg.stepId ?? "review_gate",
        {
          decision: msg.decision,
          by: resolveClientIdentity(),
          at: new Date().toISOString(),
          idempotencyKey: msg.idempotencyKey,
          patch: msg.patch,
        },
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        // First-writer-wins. The losing client will see the winner's
        // `review.decided` frame on the stream like any other subscriber —
        // no need to invent a per-socket error frame. We just log and let
        // the socket keep listening.
        logger.info(
          { runId, existingDecision: err.existingDecision.decision },
          "[stream] rejected duplicate review.decide; first-writer-wins",
        );
        return;
      }
      throw err;
    }
  };

  return {
    runId,
    onClientMessage(raw: string): void {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        logger.warn({ runId }, "[stream] non-JSON message; closing");
        sender.close(1003, "expected JSON");
        return;
      }

      const parsed = clientFrameSchema.safeParse(json);
      if (!parsed.success) {
        logger.warn(
          { runId, issues: parsed.error.issues },
          "[stream] invalid client frame; closing",
        );
        sender.close(1003, "invalid client frame");
        return;
      }

      const msg = parsed.data;

      if (msg.type === "hello") {
        if (msg.runId !== runId) {
          sender.close(1008, "hello.runId mismatch with path");
          return;
        }
        if (helloReceived) {
          logger.warn({ runId }, "[stream] duplicate hello; ignoring");
          return;
        }
        helloReceived = true;
        handleHello(msg.resumeSeq);
        return;
      }

      if (!helloReceived) {
        logger.warn(
          { runId, msgType: msg.type },
          "[stream] message before hello; closing",
        );
        sender.close(1008, "hello required first");
        return;
      }

      if (msg.type === "ping") {
        sendTransportHeartbeat("keepalive");
        return;
      }

      if (msg.type === "review.decide") {
        handleReviewDecide(msg);
        return;
      }
    },

    onClose(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
