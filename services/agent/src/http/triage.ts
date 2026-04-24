import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { EventBus } from "../events/bus.js";
import type { Database } from "../db/client.js";
import { runs } from "../db/schema.js";
import { logger } from "../logger.js";
import { triageWorkflow } from "../mastra/index.js";
import { attachStepEmitter } from "../mastra/stepEmitter.js";
import { withRunContext, type RunContext } from "../mastra/runContext.js";

/**
 * POST /triage
 *   Body: { ticketId, subject, submittedBy? }
 *   Response: { runId, streamUrl }
 *
 * Starts the `triage-and-execute` Mastra workflow. Runs in the background;
 * the HTTP response returns immediately so the client can connect its WS
 * (`/stream/:runId`) and receive the live timeline as it's produced.
 *
 * Flow
 * ----
 * 1. Mint a `runId` and insert a `runs` row (status=running).
 * 2. Create a Mastra workflow run bound to that `runId`.
 * 3. Attach the step emitter so workflow step events → envelope frames.
 * 4. Emit an explicit `run.started` frame so the timeline opens with the
 *    ticket payload (Mastra's own workflow-start event doesn't carry it).
 * 5. Kick the workflow inside a `withRunContext({ runId, bus })` scope so
 *    every step can resolve ambient `{ runId, bus }` via AsyncLocalStorage.
 * 6. On success: emit `run.completed` with status + summary, mark the run
 *    row, dispose bus state (after a 30s grace window for late reconnects).
 * 7. On failure: emit `run.failed`, mark the run row.
 */

const triageBodySchema = z.object({
  ticketId: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  submittedBy: z.string().min(1).max(200).optional(),
});

/** How long to wait before disposing the in-memory run state after a run
 *  terminates. Late WS reconnects within this window can still replay from
 *  the bus ring buffer. Outside the window, they'd need to replay from
 *  Postgres (not implemented in 1A; returns empty replay). */
const POST_TERMINAL_DISPOSE_MS = 30_000;

export function triageRouter(deps: { bus: EventBus; db: Database }): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const parsed = triageBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const { ticketId, subject, submittedBy } = parsed.data;

    const runId = randomUUID();
    await deps.db.insert(runs).values({
      id: runId,
      ticketId,
      ticketSubject: subject,
      submittedBy: submittedBy ?? null,
      status: "running",
      startedAt: new Date(),
    });

    logger.info({ runId, ticketId }, "[triage] run started");

    // Fire-and-forget. Errors inside the workflow body are logged and reflected
    // in the envelope timeline via run.failed; the HTTP response has already
    // returned by then.
    void runTriageWorkflow(deps, { runId, ticketId, subject, submittedBy }).catch(
      (err) => {
        logger.error({ runId, err }, "[triage] workflow wrapper failed");
      },
    );

    return c.json({
      runId,
      streamUrl: `/stream/${runId}`,
    });
  });

  return app;
}

async function runTriageWorkflow(
  deps: { bus: EventBus; db: Database },
  args: {
    runId: string;
    ticketId: string;
    subject: string;
    submittedBy: string | undefined;
  },
): Promise<void> {
  const { bus, db } = deps;
  const { runId, ticketId, subject, submittedBy } = args;
  const startedAt = Date.now();

  // Create the workflow run. Mastra accepts a runId override so we match
  // the DB + WS runId exactly.
  const run = await triageWorkflow.createRun({ runId });

  // Attach the Mastra-event → envelope-frame translator.
  const detach = attachStepEmitter({
    runId,
    bus,
    watch: (cb) => run.watch(cb),
  });

  // Explicit run.started — Mastra's own workflow-start doesn't carry the
  // ticket payload.
  bus.publish({
    runId,
    stepId: "agent",
    payload: {
      type: "run.started",
      ticket: {
        ticketId,
        subject,
        ...(submittedBy ? { submittedBy } : {}),
      },
    },
  });

  let terminalStatus: "ok" | "failed" | "rejected" = "failed";
  let terminalNote = "unknown";
  const stepsExecuted: Array<
    "agent" | "classify" | "retrieve" | "plan" | "dry_run" | "review_gate" | "execute" | "verify" | "log_and_notify"
  > = [];

  // Declared outside the `withRunContext` call so the outer `finally` can
  // read any browser session that `dryRunStep` (Commit 6b) stashed on the
  // context via `getRunContext().browser = session`. `AsyncLocalStorage.run`
  // uses this exact object reference as the store — it doesn't clone — so
  // mutations from within any step are visible here.
  //
  // 7b.ii-hotfix — `ticket` is populated here so `planStep` (which only
  // receives RetrievalSchema via Mastra inputData) can still read the
  // original ticket subject for its prompt. Pre-hotfix, planStep saw
  // only the classification + hit counts, which caused Sonnet to
  // correctly refuse with "I don't have the specific issue from the user"
  // — the hotfix's root cause.
  const ctx: RunContext = {
    runId,
    bus,
    ticket: { ticketId, subject, ...(submittedBy ? { submittedBy } : {}) },
  };

  try {
    const result = await withRunContext(ctx, async () => {
      return run.start({
        inputData: { ticketId, subject, ...(submittedBy ? { submittedBy } : {}) },
      });
    });

    const wfStatus = String((result as { status?: unknown }).status ?? "unknown");
    if (wfStatus === "success") {
      const outputUnknown = (result as { result?: unknown }).result ?? (result as { output?: unknown }).output;
      const output = outputUnknown as { status?: string; note?: string } | undefined;
      terminalStatus =
        output?.status === "rejected"
          ? "rejected"
          : output?.status === "ok"
            ? "ok"
            : "failed";
      terminalNote = output?.note ?? "no terminal note";
      stepsExecuted.push(
        "classify",
        "retrieve",
        "plan",
        "dry_run",
        "review_gate",
        "execute",
        "verify",
        "log_and_notify",
      );
    } else {
      terminalStatus = "failed";
      terminalNote = `mastra status=${wfStatus}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ runId, err: msg }, "[triage] workflow threw");
    bus.publish({
      runId,
      stepId: "agent",
      payload: {
        type: "run.failed",
        error: { message: msg, where: "workflow.start" },
      },
    });
    terminalStatus = "failed";
    terminalNote = msg;
  } finally {
    detach();
    // Tear down any Playwright MCP session that Commit 6b's workflow steps
    // stashed on the context. Close is idempotent; this covers happy path,
    // step throw, and run cancellation uniformly — eliminates the "browser
    // subprocess leaks if the run crashes between dry_run and execute"
    // failure class.
    if (ctx.browser) {
      try {
        await ctx.browser.close();
      } catch (err) {
        logger.warn({ runId, err }, "[triage] browser session close failed");
      }
    }
  }

  const durationMs = Date.now() - startedAt;

  if (terminalStatus !== "failed" || terminalNote !== "unknown") {
    bus.publish({
      runId,
      stepId: "agent",
      payload: {
        type: "run.completed",
        status: terminalStatus,
        summary: {
          durationMs,
          stepsExecuted,
        },
      },
    });
  }

  await db
    .update(runs)
    .set({
      status: terminalStatus,
      finishedAt: new Date(),
    })
    .where(eq(runs.id, runId));

  // Grace window for late WS reconnects.
  setTimeout(() => bus.dispose(runId), POST_TERMINAL_DISPOSE_MS);
}
