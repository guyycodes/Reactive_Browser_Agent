import type { EventBus } from "../events/bus.js";
import type { StepId } from "../events/envelope.js";
import { StepIdSchema } from "../events/envelope.js";
import { logger } from "../logger.js";

/**
 * Translates Mastra workflow watch events into envelope `step.*` frames.
 *
 * Mastra emits many event types (workflow-start/finish, workflow-canceled,
 * workflow-step-start, workflow-step-result, workflow-step-finish,
 * workflow-step-suspended, workflow-step-output, workflow-step-progress,
 * workflow-step-waiting). For Commit 2 we only map the three bracket
 * events:
 *
 *   workflow-step-start   → step.started
 *   workflow-step-result  → step.completed (status: success)
 *                           step.failed    (status: failed)
 *                           step.completed (status: suspended — suspend
 *                             is not used in 1A; defensive mapping)
 *   workflow-step-finish  → IGNORED (fires right after step-result and
 *                             carries no additional payload we need)
 *
 * We also ignore workflow-start/finish/canceled here; the caller
 * (`triage.ts`) emits `run.started` / `run.completed` / `run.failed`
 * explicitly so the start/finish can include ticket / summary payloads
 * that Mastra wouldn't carry for us.
 *
 * Step IDs in the workflow definition MUST match the envelope `StepId`
 * enum (see MASTER_PLAN §4). A mismatched id is logged and dropped so a
 * typo in one step's id doesn't silently ship a malformed envelope frame.
 */

/**
 * Minimal shape we care about. Mastra's `WorkflowStreamEvent` is a large
 * discriminated union; we access only `type` + `payload.*` and cast the
 * fields we need at each call site. Using `any` for `payload` (not
 * `Record<string, unknown>`) sidesteps TS's strict index-signature check
 * when Mastra's variant objects without index signatures are passed in.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WatchEvent = { type: string; payload?: any };

export function attachStepEmitter(args: {
  runId: string;
  bus: EventBus;
  watch: (cb: (event: WatchEvent) => void) => () => void;
}): () => void {
  const { runId, bus, watch } = args;
  const stepStartedAt = new Map<string, number>();

  const unsubscribe = watch((event) => {
    try {
      dispatch(event, { runId, bus, stepStartedAt });
    } catch (err) {
      logger.warn(
        { runId, event: event.type, err: err instanceof Error ? err.message : String(err) },
        "[stepEmitter] dispatch error (continuing)",
      );
    }
  });

  return unsubscribe;
}

function dispatch(
  event: WatchEvent,
  ctx: { runId: string; bus: EventBus; stepStartedAt: Map<string, number> },
): void {
  switch (event.type) {
    case "workflow-step-start": {
      const id = pickStepId(event);
      if (!id) return;
      ctx.stepStartedAt.set(id, Date.now());
      const input = event.payload?.payload; // step input data
      ctx.bus.publish({
        runId: ctx.runId,
        stepId: id,
        payload: {
          type: "step.started",
          ...(input !== undefined ? { input } : {}),
        },
      });
      return;
    }

    case "workflow-step-result": {
      const id = pickStepId(event);
      if (!id) return;
      const startedAt = ctx.stepStartedAt.get(id) ?? Date.now();
      const durationMs = Math.max(0, Date.now() - startedAt);
      ctx.stepStartedAt.delete(id);

      const status = String(event.payload?.status ?? "success");
      const output = event.payload?.output;

      if (status === "failed") {
        // Mastra populates `output.error` or similar on failure; we take a
        // permissive view and pass whatever's available into the error
        // payload, capped by the envelope guard.
        const maybeErr = extractErrorMessage(event.payload);
        ctx.bus.publish({
          runId: ctx.runId,
          stepId: id,
          payload: {
            type: "step.failed",
            error: { message: maybeErr },
          },
        });
      } else {
        ctx.bus.publish({
          runId: ctx.runId,
          stepId: id,
          payload: {
            type: "step.completed",
            durationMs,
            ...(output !== undefined ? { output } : {}),
          },
        });
      }
      return;
    }

    // Explicitly ignored — we use the explicit run.* bracket frames from
    // triage.ts instead.
    case "workflow-start":
    case "workflow-finish":
    case "workflow-canceled":
    case "workflow-step-finish":
    case "workflow-step-suspended":
    case "workflow-step-output":
    case "workflow-step-progress":
    case "workflow-step-waiting":
      return;

    default:
      return;
  }
}

/** Validate-and-narrow the step id from a Mastra event's payload against
 *  our `StepId` enum. Logs-and-drops unrecognised ids so a typo in the
 *  workflow definition doesn't silently produce an invalid envelope frame. */
function pickStepId(event: WatchEvent): StepId | null {
  const raw = event.payload?.id;
  if (typeof raw !== "string") return null;
  const parsed = StepIdSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { badId: raw, eventType: event.type },
      "[stepEmitter] step id outside of StepIdSchema; skipping frame",
    );
    return null;
  }
  return parsed.data;
}

function extractErrorMessage(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "unknown step failure";
  const output = payload.output as Record<string, unknown> | undefined;
  if (output && typeof output.error === "string") return output.error;
  if (output && output.error && typeof output.error === "object") {
    const err = output.error as { message?: unknown };
    if (typeof err.message === "string") return err.message;
  }
  return "step failed";
}
