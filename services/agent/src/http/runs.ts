import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { EventBus } from "../events/bus.js";
import { ConflictError } from "../events/bus.js";
import { GateStepIdSchema } from "../events/envelope.js";
import type { Database } from "../db/client.js";
import { runs, reviews } from "../db/schema.js";
import { logger } from "../logger.js";

/**
 * HTTP surface for runs.
 *
 *   GET  /runs/:id           — run metadata + current committed review (if any)
 *   POST /runs/:id/review    — submit a review decision (idempotent)
 *
 * The WS `review.decide` client frame is the other path for review decisions;
 * both converge on `bus.publishClientDecision` which enforces first-writer-wins.
 */

const reviewBodySchema = z.object({
  /** 7b.iii.b — which gate's slot this decision targets. Optional
   *  for back-compat; defaults to "review_gate" server-side so
   *  pre-7b.iii.b curl scripts keep working unchanged. */
  stepId: GateStepIdSchema.optional(),
  // Week-2a gate-decision-model — mirrors clientFrameSchema in
  // envelope.ts. Both HTTP POST /runs/:id/review and the WS
  // `review.decide` client frame accept the same 4-value enum.
  decision: z.enum(["approve", "reject", "edit", "terminate"]),
  by: z.string().min(1),
  idempotencyKey: z.string().uuid().optional(),
  patch: z.record(z.unknown()).optional(),
});

const uuidParam = z.string().uuid();

export function runsRouter(deps: { bus: EventBus; db: Database }): Hono {
  const app = new Hono();

  app.get("/:id", async (c) => {
    const parsed = uuidParam.safeParse(c.req.param("id"));
    if (!parsed.success) return c.json({ error: "invalid run id" }, 400);
    const runId = parsed.data;

    const [run] = await deps.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) return c.json({ error: "run not found" }, 404);

    const [review] = await deps.db
      .select()
      .from(reviews)
      .where(eq(reviews.runId, runId))
      .limit(1);

    return c.json({
      run,
      review: review ?? null,
      liveSeqCursor: deps.bus.nextSeq(runId),
    });
  });

  app.post("/:id/review", async (c) => {
    const paramParsed = uuidParam.safeParse(c.req.param("id"));
    if (!paramParsed.success) return c.json({ error: "invalid run id" }, 400);
    const runId = paramParsed.data;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const bodyParsed = reviewBodySchema.safeParse(body);
    if (!bodyParsed.success) {
      return c.json(
        { error: "invalid body", issues: bodyParsed.error.issues },
        400,
      );
    }
    const msg = bodyParsed.data;

    // Does the run actually exist? We do this cheaply before committing to
    // the bus so a curl mistake returns 404 instead of a silent accepted.
    const [run] = await deps.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) return c.json({ error: "run not found" }, 404);

    try {
      const decision = deps.bus.publishClientDecisionForStep(
        runId,
        msg.stepId ?? "review_gate",
        {
          decision: msg.decision,
          by: msg.by,
          at: new Date().toISOString(),
          idempotencyKey: msg.idempotencyKey,
          patch: msg.patch,
        },
      );

      // Persist the authoritative review row. The bus frame is the audit
      // event; this row is the queryable current state.
      await deps.db
        .insert(reviews)
        .values({
          runId,
          idempotencyKey: msg.idempotencyKey ?? null,
          decision: decision.decision,
          by: decision.by,
          decidedAt: new Date(decision.at),
          patch: decision.patch ?? null,
        })
        .onConflictDoNothing({ target: reviews.runId });

      return c.json({ accepted: true, decision }, 200);
    } catch (err) {
      if (err instanceof ConflictError) {
        // Idempotent replay? Re-check if the key matches the committed one.
        const [review] = await deps.db
          .select()
          .from(reviews)
          .where(eq(reviews.runId, runId))
          .limit(1);

        if (
          review &&
          msg.idempotencyKey &&
          review.idempotencyKey === msg.idempotencyKey
        ) {
          // Same client, same key — return the original decision with 200.
          return c.json({ accepted: true, decision: review, replay: true }, 200);
        }

        return c.json(
          {
            error: "review already decided",
            existing: err.existingDecision,
          },
          409,
        );
      }
      logger.error({ runId, err }, "[runs] review decision failed");
      return c.json({ error: "internal error" }, 500);
    }
  });

  return app;
}
