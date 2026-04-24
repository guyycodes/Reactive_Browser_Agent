import type { Frame } from "./envelope.js";
import { isTimelineFrame } from "./envelope.js";
import type { Database } from "../db/client.js";
import { events } from "../db/schema.js";
import { logger } from "../logger.js";

/**
 * Append-only persistence of every timeline frame to Postgres `events`.
 *
 * Design
 * ------
 * - Transport frames (heartbeat, resync) are NOT persisted. They are ephemeral
 *   transport control and don't contribute to the run's audit trail.
 * - Inserts are awaited individually. Write volume is bounded (~100 frames
 *   per run, small number of concurrent runs in Week 1) so a batched / COPY
 *   path is unnecessary yet; revisit when profiling shows it.
 * - On insert failure we log and swallow — losing a persist should not kill
 *   a live run. The audit trail will have a gap visible via seq numbers, and
 *   the operator log will show the offending insert error.
 *
 * UNIQUE(run_id, seq) in the schema guarantees we can't accidentally
 * double-persist a frame on a retry path.
 */

export function makePersister(db: Database) {
  return async function persist(frame: Frame): Promise<void> {
    if (!isTimelineFrame(frame)) return;

    try {
      await db
        .insert(events)
        .values({
          runId: frame.runId,
          seq: frame.seq,
          ts: new Date(frame.ts),
          type: frame.type,
          stepId: frame.stepId,
          payload: frame as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing({
          target: [events.runId, events.seq],
        });
    } catch (err) {
      logger.error(
        {
          runId: frame.runId,
          seq: frame.seq,
          type: frame.type,
          err: err instanceof Error ? err.message : String(err),
        },
        "[persist] insert failed; audit trail will show a gap",
      );
    }
  };
}
