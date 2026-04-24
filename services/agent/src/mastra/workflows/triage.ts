import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { streamMessage } from "../../llm/streamMapper.js";
import { getRunContext, tryGetRunContext, withRunContext } from "../runContext.js";
import { logger } from "../../logger.js";
import {
  retrieveRunbooks,
  retrieveSkills,
  RagClientError,
  RagSchemaError,
  type RagHit,
} from "../tools/rag.js";
import {
  launchBrowser,
  PlaywrightMcpError,
  type BrowserSession,
} from "../tools/playwrightMcp.js";
import {
  createReActStep,
  runReActIterations,
  type CreateReActStepArgs,
} from "../lib/reactRunner.js";
import { runBlock1 } from "../lib/blockController.js";
import type { Block1Deps, Block1Result } from "../lib/blockController.js";

/**
 * The 8-step triage-and-execute workflow (MASTER_PLAN §4).
 *
 * Commit 2 reality
 * ----------------
 * - `classify` makes a real Anthropic Haiku call (no extended thinking).
 * - `plan` makes a real Sonnet call WITH extended thinking enabled at
 *   `budget_tokens: 8192`. This is the step that produces the big visible
 *   `llm.thinking.delta` stream in the WS feed.
 * - `review_gate` suspends on a real `bus.awaitDecision(runId)` promise —
 *   `suspend()` from Mastra is NOT used in 1A; the bus is the authoritative
 *   synchronization point and lives in-process across the HTTP+WS surface.
 * - `retrieve`, `dry_run`, `execute`, `verify`, `log_and_notify` are canned:
 *   they sleep briefly and emit synthetic `tool.*` / `browser.screenshot`
 *   frames so the envelope variants are exercised end-to-end. 1B replaces
 *   the canned bodies with real Playwright MCP / RAG / DB calls.
 *
 * Why the split
 * -------------
 * The user's 1A acceptance criteria: prove the stream + suspension + replay
 * work end-to-end with real LLM reasoning at the interesting steps. Running
 * the full browser chain is 1B's job. Keeping 1A canned where it doesn't
 * need to be real is how we avoid entangling two risk surfaces.
 *
 * Rejection path
 * --------------
 * When a reviewer rejects at `review_gate`, the step returns a small output
 * that the `execute`/`verify`/`log_and_notify` steps detect and short-circuit
 * — they emit one `step.started` / `step.completed` pair with a "skipped"
 * note so the timeline reads cleanly and the client sees a clean
 * `run.completed { status: "rejected" }`. No step is cancelled mid-flight.
 */

/** ---------- Schemas ---------- */

const TicketSchema = z.object({
  ticketId: z.string().min(1),
  subject: z.string().min(1),
  submittedBy: z.string().optional(),
});

const ClassificationSchema = z.object({
  category: z.string(),
  urgency: z.enum(["low", "medium", "high"]),
  targetApps: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

/** 7b.ii-hotfix — per-hit summary carried forward from retrieveStep
 *  into planStep's prompt.
 *
 *  Preview cap — 2000 chars.
 *  Intentionally ASYMMETRIC with the envelope `RagHitSchema.preview`
 *  cap of 400 chars (see `src/events/envelope.ts`):
 *    - This schema feeds Sonnet's plan prompt. Runbook passages are
 *      naturally long-form procedural text; 400 chars cuts mid-sentence
 *      and omits the actual procedure steps. 7b.ii-hotfix-1 smoke
 *      surfaced this as Sonnet's explicit complaint "The runbook
 *      passages are truncated and don't provide the complete
 *      procedure" — a legitimate prompt-budget signal, not model noise.
 *    - The envelope frame feeds the reviewer UI's rag-hit rows where
 *      400 chars is plenty for a "what did RAG return at a glance?"
 *      scan. Widening the envelope cap would bloat every rag.retrieved
 *      frame over the wire for no UI benefit.
 *
 *  Each consumer documents its cap at the point of use (see
 *  `runRagCall`'s hitSummaries builder and `mapHitToFrame` below). */
const RagHitSummarySchema = z.object({
  score: z.number(),
  source: z.string(),
  preview: z.string().max(2000),
});
type RagHitSummary = z.infer<typeof RagHitSummarySchema>;

const RetrievalSchema = z.object({
  runbookHits: z.number().int().nonnegative(),
  skillHits: z.number().int().nonnegative(),
  /** 7b.ii-hotfix — raw hit summaries from the retrieveStep ReAct
   *  runner's last iteration per tool. Capped top-5 per corpus to keep
   *  plan-prompt budget reasonable. Previously retrieveStep returned
   *  only counts; planStep therefore couldn't see what was retrieved
   *  and Sonnet (correctly) refused to plan from that thin context. */
  hits: z.object({
    runbooks: z.array(RagHitSummarySchema).max(5),
    skills: z.array(RagHitSummarySchema).max(5),
  }),
  classification: ClassificationSchema,
});

/** 7b.ii-hotfix — one action in a structured plan. Replaces the
 *  earlier regex-over-prose step-counting + destructive-keyword
 *  inference that misclassified model refusals as "3-step destructive
 *  plan" during 7b.ii smoke. Those heuristics were removed in the
 *  7b.iii.a prep cleanup now that the structured `actions[]` +
 *  LLM-declared `destructive` fields are authoritative. `verb` enum
 *  intentionally narrow for now; Week-2 skill-card schema will
 *  authoritative-source the verb vocabulary. */
const PlanActionSchema = z.object({
  stepNumber: z.number().int().positive(),
  verb: z.enum(["navigate", "fill", "click", "verify", "notify"]),
  target: z.string().min(1),
  /** 7b.ii-hotfix-3 — accept `null` as a synonym for `undefined`. JSON
   *  has no natural "undefined"; Sonnet (and Anthropic models
   *  generally) emit `"value": null` for actions without an applicable
   *  value (navigate / click / verify / notify — anything that isn't
   *  `fill`). Under the original `z.string().optional()` shape those
   *  entries failed `safeParse` and the surrounding parsing loop
   *  silently dropped them. 7b.ii-hotfix-2 smoke surfaced this as a
   *  9-action plan rendering as "2-step plan" in the UI — same class
   *  of truth-invariant violation the earlier hotfixes targeted.
   *
   *  `z.preprocess(v → v === null ? undefined : v, z.string().optional())`
   *  keeps the parsed output type as `string | undefined`, so every
   *  downstream `action.value` consumer stays source-compatible. */
  value: z.preprocess(
    (v) => (v === null ? undefined : v),
    z.string().optional(),
  ),
  description: z.string().min(1),
});

const PlanSchema = z.object({
  // Backward-compat fields (consumed by reviewGateStep's
  // `review.requested` emission and the reviewer UI's renderPlanBody).
  // Derived at planStep output time from authoritative structured fields.
  planId: z.string().uuid(),
  actionCount: z.number().int().nonnegative(), // = actions.length
  destructive: z.boolean(), // LLM-declared (was regex-inferred pre-hotfix)
  skillCardIds: z.array(z.string()),
  planText: z.string(), // narrative prose for UI display
  thinking: z.string(),
  classification: ClassificationSchema,
  // 7b.ii-hotfix new fields.
  /** Structured per-action plan. Empty when `requiresContext === true`. */
  actions: z.array(PlanActionSchema),
  /** True when the model refused to plan because it lacked information.
   *  First-class representation of the refusal path — UI renders
   *  "🟡 needs context" instead of falsifying a step count. 7b.iii's
   *  Block 1 exit signal is `!requiresContext && actions.length > 0`. */
  requiresContext: z.boolean(),
  /** What the model said it needed (if requiresContext). Bounded so
   *  the envelope frame stays well under MAX_FRAME_BYTES.
   *
   *  7b.ii-hotfix-3 — same `null → undefined` preprocess as
   *  `PlanActionSchema.value`. Defensive depth: the model is less
   *  likely to emit `"missingContext": null` than `"value": null` (it's
   *  array-shaped, not scalar), but the one-line preprocess is cheap
   *  and matches the pattern. */
  missingContext: z.preprocess(
    (v) => (v === null ? undefined : v),
    z.array(z.string().max(200)).max(8).optional(),
  ),
});

/** 7b.iii.a — reason codes recorded per Block 1 pass. Mirrors the
 *  envelope's `block.iteration.completed.reason` enum so the controller
 *  and the envelope schema stay in lockstep. */
const Block1ReasonSchema = z.enum([
  "exit_signal_ok",
  "plan_requires_context",
  "plan_empty_actions",
  "dry_run_mismatch",
  "max_iterations",
]);
type Block1Reason = z.infer<typeof Block1ReasonSchema>;

/** 7b.iii.a — carried on `DryRunSchema` only when Block 1 exhausted
 *  its passes. reviewGateStep forwards this to the `review.requested`
 *  envelope frame so the UI can render the "exhausted" banner +
 *  disable the approve button. Absent on happy-path outputs. */
const BlockResultSchema = z.object({
  passes: z.number().int().min(1).max(10),
  passedLast: z.boolean(),
  allReasons: z.array(Block1ReasonSchema).max(10),
});

const DryRunSchema = z.object({
  domMatches: z.boolean(),
  anomalies: z.array(z.string()),
  plan: PlanSchema,
  /** 7b.iii.a — set only when this output came from an exhausted
   *  Block 1 pass. Absence is the happy-path signal. */
  blockResult: BlockResultSchema.optional(),
});

const ReviewSchema = z.object({
  // Week-2a gate-decision-model — 4-value enum matches envelope.ts
  // ReviewDecidedFrame.decision. runReviewGateStep's return value
  // in practice only produces "approve" (happy path) or "terminate"
  // (skip-cascade trigger) — "reject" and "edit" exit via the refine
  // loop which either converges to approve or exhausts to terminate.
  // Kept at 4 values for wire-contract consistency; narrowing to
  // z.enum(["approve", "terminate"]) is a Week-2 polish queue item.
  decision: z.enum(["approve", "reject", "edit", "terminate"]),
  approved: z.boolean(),
  dryRun: DryRunSchema,
});

const ExecuteSchema = z.object({
  stepsRun: z.number().int().nonnegative(),
  skipped: z.boolean(),
  review: ReviewSchema,
});

const VerifySchema = z.object({
  success: z.boolean(),
  skipped: z.boolean(),
  evidence: z.array(z.string()),
  execute: ExecuteSchema,
});

const LogSchema = z.object({
  status: z.enum(["ok", "rejected", "failed"]),
  note: z.string(),
});

/** ---------- Steps ---------- */

/** 7b.iii.a — prepend prior-pass observations to a user message when
 *  the Block 1 controller populated `RunContext.priorObservations`.
 *  No-op on pass 0 (observations array empty or undefined). All three
 *  pre-gate steps (classify / retrieve / plan) call this so Sonnet
 *  sees what the previous passes tried + why they failed and can
 *  refine its next attempt. Kept as a tiny self-contained helper so
 *  the exact prefix shape is identical across all three call sites. */
function observationsPrefix(obs: string[] | undefined): string {
  if (!obs || obs.length === 0) return "";
  return (
    `Prior passes (${obs.length} observation${obs.length === 1 ? "" : "s"} carried forward):\n` +
    obs.map((o, i) => `  ${i + 1}. ${o}`).join("\n") +
    `\n\n`
  );
}

/** 7b.iii.a — extracted classify body so the Block 1 controller can
 *  invoke it directly (outside Mastra's step-execution machinery).
 *  `classifyStep` is a thin wrapper; the controller calls this
 *  function and emits its own `step.started` / `step.completed` frames
 *  around the invocation. Same pattern as `runPlanStep` / `runDryRunStep`. */
export async function runClassifyStep(
  inputData: z.infer<typeof TicketSchema>,
): Promise<z.infer<typeof ClassificationSchema>> {
  const { runId, bus, priorObservations } = getRunContext();

  const system =
    "You classify IT helpdesk tickets. Return ONLY a JSON object with keys: " +
    '`category` (string), `urgency` (one of "low"|"medium"|"high"), ' +
    "`targetApps` (array of app names referenced by the ticket, possibly empty), " +
    "`confidence` (float 0..1). No prose outside the JSON.";

  const userMsg =
    observationsPrefix(priorObservations) +
    `Ticket ID: ${inputData.ticketId}\n` +
    `Subject: ${inputData.subject}\n` +
    (inputData.submittedBy ? `Submitted by: ${inputData.submittedBy}\n` : "");

  const result = await streamMessage({
    runId,
    bus,
    stepId: "classify",
    tier: "haiku",
    maxTokens: 512,
    thinkingEnabled: false,
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  // Parse; if the model drifts off-format, fall back to a low-confidence
  // default so the workflow keeps moving and the downstream step can
  // observe the confidence score.
  const parsed = tryParseJson<Record<string, unknown>>(result.text);
  const validated = ClassificationSchema.safeParse({
    category: String(parsed?.category ?? "uncategorized"),
    urgency: pickUrgency(parsed?.urgency),
    targetApps: Array.isArray(parsed?.targetApps)
      ? parsed.targetApps.map(String)
      : [],
    confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0.3,
  });
  if (!validated.success) {
    logger.warn({ issues: validated.error.issues }, "[classify] fallback defaults");
    return {
      category: "uncategorized",
      urgency: "low" as const,
      targetApps: [],
      confidence: 0.3,
    };
  }
  return validated.data;
}

const classifyStep = createStep({
  id: "classify",
  inputSchema: TicketSchema,
  outputSchema: ClassificationSchema,
  execute: ({ inputData }) => runClassifyStep(inputData),
});

// Commit 7b.ii — retrieveStep reframed as a ReAct loop.
//
// Before 7b.ii: the step fired two identical RAG queries blindly and
// returned whatever hits came back. No adaptation to the classification,
// no refinement on weak hits, no visibility into the reasoning.
//
// After 7b.ii: the step is a `createReActStep` instance with a two-tool
// registry (`rag_retrieveRunbooks` + `rag_retrieveSkills`). Each
// iteration, Sonnet decides what to query for based on the classification
// + a summary of prior iterations' observations, calls one of the tools
// via Anthropic's native tool-use protocol, and observes the hit count +
// summary. After up to 3 iterations (or when the model declines further
// tool calls), the runner's `produceOutput` aggregates the per-tool
// last-call hit counts into the existing `RetrievalSchema` shape so
// downstream steps (planStep et al.) see identical input to before.
//
// The existing `runRagCall` helper (below) is preserved verbatim — the
// ReactTool `invoke` closures wrap it so the reviewer UI's business-level
// `tool.started → rag.retrieved → tool.completed` spans continue to emit
// exactly as they did in 5b/6c/7a.iv. The only new frames are the
// `react.iteration.*` dividers bracketing each iteration, plus the
// `reactIterationId` field carried by every frame emitted inside an
// iteration (which the reviewer UI uses to visually nest them).
//
// LLM calls inside each iteration ride through the
// `getCircuit("anthropic")` breaker introduced in 7b.i — a transient
// Anthropic 500 mid-iteration retries automatically and does not fail
// the run.

const RagQueryInputSchema = z.object({
  query: z.string().min(1).max(500),
});

/** Anthropic `input_schema` shape (hand-written JSON Schema). Paired
 *  with `RagQueryInputSchema` for runtime validation. Week-2 cleanup:
 *  introduce `zod-to-json-schema` when tool count grows past ~5 so we
 *  stop hand-writing duplicate schemas. */
const RAG_QUERY_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "A focused query describing what runbook or skill-card content to retrieve. Prefer short, specific phrases.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** 7b.iii.a — extracted retrieveStep config so `runRetrieveStep` can
 *  reuse it to invoke the ReAct runner directly from the Block 1
 *  controller (outside Mastra's step-execution machinery). The
 *  controller calls `runReActIterations(input, abortSignal, retrieveStepConfig)`
 *  and emits its own step.started/completed frames around the call.
 *  Same pattern as `runClassifyStep` / `runPlanStep`.
 *
 *  Explicit `CreateReActStepArgs<TIn, TOut>` typing is required: when
 *  the config object is inlined directly into `createReActStep<TIn, TOut>({...})`
 *  generic inference narrows the inner callback params; as a
 *  standalone const, we lose that inference and callbacks widen to
 *  `any`. Explicit typing restores it. */
const retrieveStepConfig: CreateReActStepArgs<
  z.infer<typeof ClassificationSchema>,
  z.infer<typeof RetrievalSchema>
> = {
  id: "retrieve" as const,
  inputSchema: ClassificationSchema,
  outputSchema: RetrievalSchema,
  tier: "sonnet" as const,
  thinkingEnabled: false, // retrieve isn't reasoning-heavy; save tokens + latency
  maxIterations: 3,
  // Tool `invoke` + `summarize` are typed against `unknown` here — the
  // `ToolRegistry = Record<string, ReactTool>` shape widens the generic
  // parameters when tools are inlined. Runtime validation still applies:
  // `ReactTool.validator` (Zod) narrows `input` to the typed shape just
  // before `invoke` is called, and the `parsed.data` passed to invoke is
  // already typed correctly inside the runner. Inside these closures we
  // cast once and the rest of the body is strongly typed.
  tools: {
    rag_retrieveRunbooks: {
      // Note: Anthropic tool names must match /^[a-zA-Z0-9_-]{1,64}$/ (no
      // periods), so we use `rag_retrieveRunbooks` here. The business-level
      // `tool.started` frame emitted by runRagCall below continues to use
      // the dotted form `rag.retrieveRunbooks` for continuity with 5b/6c.
      name: "rag_retrieveRunbooks",
      description:
        "Search the runbooks knowledge base for troubleshooting resolutions. Returns hit scores, source paths, and short previews.",
      inputSchema: RAG_QUERY_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      validator: RagQueryInputSchema,
      invoke: async (input: unknown, ctx) => {
        const { query } = input as { query: string };
        return runRagCall({
          name: "rag.retrieveRunbooks",
          collection: env("SHARED_RUNBOOKS_UUID"),
          query,
          abortSignal: ctx.signal ?? new AbortController().signal,
          invoke: (signal) => retrieveRunbooks(query, { signal }),
        });
      },
      summarize: (output: unknown) => {
        const { hitCount } = output as { hitCount: number };
        return `${hitCount} runbook hit${hitCount === 1 ? "" : "s"}`;
      },
    },
    rag_retrieveSkills: {
      name: "rag_retrieveSkills",
      description:
        "Search the skill-cards knowledge base for pre-authorized action patterns. Returns hit scores, source paths, and short previews.",
      inputSchema: RAG_QUERY_INPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      validator: RagQueryInputSchema,
      invoke: async (input: unknown, ctx) => {
        const { query } = input as { query: string };
        return runRagCall({
          name: "rag.retrieveSkills",
          collection: env("SHARED_SKILLS_UUID"),
          query,
          abortSignal: ctx.signal ?? new AbortController().signal,
          invoke: (signal) => retrieveSkills(query, { signal }),
        });
      },
      summarize: (output: unknown) => {
        const { hitCount } = output as { hitCount: number };
        return `${hitCount} skill-card hit${hitCount === 1 ? "" : "s"}`;
      },
    },
  },
  buildSystem: (c: z.infer<typeof ClassificationSchema>) =>
    `You help a tier-1 IT helpdesk agent retrieve relevant runbooks and skill cards from the knowledge base. ` +
    `The ticket has been classified as category="${c.category}", urgency="${c.urgency}"` +
    (c.targetApps.length > 0 ? `, targetApps=${c.targetApps.join(", ")}` : "") +
    `. Your job is to decide what to query the knowledge base for and observe the results. ` +
    `If hit scores are weak (top score below 0.5) you may refine your query and retry. ` +
    `When you have enough evidence (or a couple of queries have not improved the results), respond with a short final text summary — no further tool calls.`,
  // 7b.iii.a — buildUserMessage is called from inside `runReActIterations`
  // which runs inside a `withRunContext({ ...ctx, bus: taggedBus })`
  // scope (verified at reactRunner.ts:266-267). The spread preserves
  // `priorObservations` from the outer controller's context, so
  // `getRunContext()` here sees the accumulated observations on pass
  // N>0 and prepends them to the user message — same shape as
  // classifyStep and planStep. Using `tryGetRunContext` null-safe so
  // any future direct-test of this callback outside a run-context
  // scope degrades gracefully to the pass-0 behavior.
  buildUserMessage: (c: z.infer<typeof ClassificationSchema>) => {
    const ctx = tryGetRunContext();
    return (
      observationsPrefix(ctx?.priorObservations) +
      `Classification:\n${JSON.stringify(c, null, 2)}\n\n` +
      `Retrieve the most relevant runbooks AND skill cards for this ticket. Use the tools.`
    );
  },
  produceOutput: (iterations, classification) => {
    // "Last-wins per tool" — the model's final retrieval decision for
    // each collection is authoritative. A later iteration that
    // intentionally narrows and returns fewer-but-better hits is what
    // we report. If smoke shows the model aggressively narrowing to
    // zero (which would be a prompting issue), flipping to `max` here
    // is a one-line change.
    //
    // 7b.ii-hotfix — aggregate hit summaries alongside counts so
    // planStep can actually see what was retrieved. Pre-hotfix only
    // counts crossed the boundary, which caused Sonnet to correctly
    // refuse to plan for lack of substantive context.
    let runbookHits = 0;
    let skillHits = 0;
    let runbookHitSummaries: RagHitSummary[] = [];
    let skillHitSummaries: RagHitSummary[] = [];
    for (const iter of iterations) {
      const call = iter.toolCall;
      if (!call) continue;
      const out = call.output as { hitCount: number; hits: RagHitSummary[] };
      if (call.name === "rag_retrieveRunbooks") {
        runbookHits = out.hitCount;
        runbookHitSummaries = out.hits;
      } else if (call.name === "rag_retrieveSkills") {
        skillHits = out.hitCount;
        skillHitSummaries = out.hits;
      }
    }
    return {
      runbookHits,
      skillHits,
      hits: { runbooks: runbookHitSummaries, skills: skillHitSummaries },
      classification,
    };
  },
};

const retrieveStep = createReActStep<
  z.infer<typeof ClassificationSchema>,
  z.infer<typeof RetrievalSchema>
>(retrieveStepConfig);

/** 7b.iii.a — exposed so the Block 1 controller can invoke retrieve
 *  directly (outside Mastra's step-execution machinery). Same pattern
 *  as `runClassifyStep` / `runPlanStep`. Forwards the active
 *  AbortSignal into the ReAct runner, which threads it through every
 *  tool invocation and every LLM call. */
export async function runRetrieveStep(
  input: z.infer<typeof ClassificationSchema>,
  abortSignal?: AbortSignal,
): Promise<z.infer<typeof RetrievalSchema>> {
  return runReActIterations(input, abortSignal, retrieveStepConfig);
}

/** Shape the query sent to `/docs/models/qa`. The classifier's category +
 *  target apps are enough context for the runbook + skill collections; keeping
 *  the two queries identical is fine for 1B because the two collections are
 *  disjoint corpora and both retrieve against the same intent. */
function buildRetrievalQuery(c: z.infer<typeof ClassificationSchema>): string {
  const apps = c.targetApps.filter((s) => s.length > 0).join(", ");
  return apps ? `${c.category} (${apps})` : c.category;
}

/** One RAG call + its three-frame timeline span. Bookends the call with
 *  `performance.now()` so `durationMs` is wall-clock-around-the-full-retry-loop
 *  (a retry-heavy call surfaces as a slow `tool.completed` in the reviewer UI —
 *  intentional: slow retrieves are diagnostic signal, not noise to hide). */
async function runRagCall(args: {
  name: "rag.retrieveRunbooks" | "rag.retrieveSkills";
  collection: string;
  query: string;
  abortSignal: AbortSignal;
  invoke: (signal: AbortSignal) => Promise<{ hits: RagHit[]; request_id: string }>;
}): Promise<{ hitCount: number; hits: RagHitSummary[] }> {
  const { runId, bus } = getRunContext();
  const invocationId = randomUUID();
  const startedAt = performance.now();

  bus.publish({
    runId,
    stepId: "retrieve",
    payload: {
      type: "tool.started",
      invocationId,
      name: args.name,
      args: { query: args.query, collection: args.collection },
    },
  });

  try {
    const result = await args.invoke(args.abortSignal);
    const mappedHits = result.hits.slice(0, 10).map(mapHitToFrame);

    bus.publish({
      runId,
      stepId: "retrieve",
      payload: {
        type: "rag.retrieved",
        collection: args.collection,
        query: args.query,
        hits: mappedHits,
      },
    });

    bus.publish({
      runId,
      stepId: "retrieve",
      payload: {
        type: "tool.completed",
        invocationId,
        name: args.name,
        resultSummary: {
          hits: result.hits.length,
          requestId: result.request_id,
        },
        durationMs: Math.round(performance.now() - startedAt),
      },
    });

    // 7b.ii-hotfix — also return top-5 hit summaries so retrieveStep's
    // produceOutput can surface them in RetrievalSchema.hits for
    // planStep's prompt. Preview sliced at 2000 chars (matches
    // RagHitSummarySchema.preview.max(2000) — intentionally wider than
    // the envelope frame's 400-char cap because Sonnet needs enough of
    // the runbook procedural text to reason about it; see the schema
    // comment above for the asymmetry rationale).
    const hitSummaries: RagHitSummary[] = result.hits.slice(0, 5).map((h) => ({
      score: h.score,
      source: h.source ?? "unknown",
      preview: h.text.slice(0, 2000),
    }));
    return { hitCount: result.hits.length, hits: hitSummaries };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    const isKnownRagError = err instanceof RagClientError || err instanceof RagSchemaError;
    const message = err instanceof Error ? err.message : String(err);

    bus.publish({
      runId,
      stepId: "retrieve",
      payload: {
        type: "tool.failed",
        invocationId,
        name: args.name,
        error: {
          message: isKnownRagError ? message : `[unexpected] ${message}`,
          where: args.name,
        },
      },
    });

    logger.warn(
      {
        runId,
        tool: args.name,
        collection: args.collection,
        durationMs,
        err: message,
        knownRagError: isKnownRagError,
      },
      "[retrieve] rag call failed; continuing with empty hits",
    );

    return { hitCount: 0, hits: [] };
  }
}

/** Map the tool-client's `RagHit` (Python snake_case) onto the envelope's
 *  `RagHitSchema` (camelCase, string source, nonnegative-int-ish chunkId).
 *  Defensive slice(0, 400) on preview even though the envelope schema caps
 *  there — we don't want the schema's error surface to ever be reachable from
 *  this code path. `-1` is the sentinel for "chunk index not recorded" so the
 *  reviewer UI can distinguish "position 0" from "unknown position." */
function mapHitToFrame(h: RagHit): {
  chunkId: number;
  score: number;
  preview: string;
  source: string;
} {
  return {
    chunkId: h.chunk_id ?? -1,
    score: h.score,
    // Envelope cap — 400 chars. This frame feeds the reviewer UI's
    // rag-hit rows in the behavior feed, where 400 is plenty for a
    // "what did RAG return at a glance?" summary. Intentionally tighter
    // than the plan-prompt cap (2000 chars) used by RagHitSummarySchema
    // — wire/UI display goal is compact, plan-reasoning goal is
    // sufficient-context. See RagHitSummarySchema comment for the
    // asymmetry rationale (surfaced in 7b.ii-hotfix smoke).
    preview: h.text.slice(0, 400),
    source: h.source ?? "unknown",
  };
}

/** 7b.ii-hotfix-4 — describe the agent's target application to the
 *  planning model.
 *
 *  Pre-hotfix-4 Sonnet's `missingContext` output included "URL or
 *  access method for the Internal Admin Portal" — a legitimate
 *  technical gap: the runbooks describe WHAT to do but not WHERE the
 *  portal lives, and the prompt never told the model. This helper
 *  closes that gap by pulling the target URL from env (same source
 *  the Playwright MCP driver uses) and enumerating the known routes
 *  so Sonnet can write concrete `target` strings like "reset password
 *  submit button on /users/:id/reset-password".
 *
 *  Week 1B shortcut: single target app (the test-webapp). The
 *  `_targetApps` parameter is accepted but unused — it's a hint for
 *  Week 2 when per-skill-card `base_url` declarations from the skill-
 *  card registry replace this hardcoded block. At that point this
 *  helper becomes `buildTargetAppContext(skillCards.map(c => c.app))`
 *  and pulls per-app routes from each card's schema.
 *
 *  Authentication note: credentials are deliberately NOT included in
 *  the prompt. The runtime signs in via Playwright using env-scoped
 *  creds; Sonnet plans the UI actions and the runtime handles auth.
 *  Keeping creds out of the prompt is non-negotiable security posture
 *  (MASTER_PLAN §6). */
function buildTargetAppContext(_targetApps: string[]): string {
  const url = process.env.TEST_WEBAPP_URL ?? "http://test-webapp:3000";
  return (
    `Target application: Internal Admin Portal at ${url}\n` +
    `  Known routes:\n` +
    `    ${url}/login                             — sign-in page (email + password)\n` +
    `    ${url}/users                             — user list with search\n` +
    `    ${url}/users/:id                         — user detail page\n` +
    `    ${url}/users/:id/reset-password          — destructive reset page (checkbox + confirm)\n` +
    `    ${url}/status                            — system status dashboard\n` +
    `  Authentication: sign in as admin user. Credentials provided to the agent runtime at execution time.`
  );
}

/** 7b.ii-hotfix — render top-N RAG hits for the plan prompt. Uses the
 *  full 2000-char preview from RetrievalSchema.hits[] (asymmetric with
 *  the envelope RagHitSchema's 400-char cap — see the schema comment). */
function formatHitLines(hits: RagHitSummary[], label: string): string {
  if (hits.length === 0) return `${label}: (none)`;
  return (
    `${label}:\n` +
    hits
      .map(
        (h, i) =>
          `  ${i + 1}. [${h.score.toFixed(2)}] ${h.source} — ${h.preview}`,
      )
      .join("\n")
  );
}

/** 7b.ii-hotfix — extracted planStep body so tests can drive the
 *  JSON-parse + schema-validation + requiresContext-fallback logic
 *  directly under `withRunContext` without routing through Mastra's
 *  step-execution machinery. Same pattern as `runReActIterations` in
 *  `src/mastra/lib/reactRunner.ts`. Exported for test use only. */
export async function runPlanStep(
  inputData: z.infer<typeof RetrievalSchema>,
): Promise<z.infer<typeof PlanSchema>> {
  {
    const { runId, bus, ticket, priorObservations } = getRunContext();

    // 7b.ii-hotfix — build a prompt that actually includes the ticket
    // subject + top-5 hits per corpus. Previously Sonnet received only
    // the classification + hit counts, which (correctly) caused it to
    // refuse during 7b.ii smoke with "I don't have the specific issue
    // from the user, What the runbook hits contain...". That refusal's
    // incidental numbered list was then regex-counted as an "N-step
    // plan" and its keywords regex-flagged destructive — a double
    // truth-invariant violation. Both bugs are eliminated here via
    // (a) a prompt that includes the ticket + hit contents and (b) a
    // structured JSON output schema with a first-class requiresContext
    // refusal path.
    // 7b.ii-hotfix-4 — explicit division of labor between the three
    // actors (LLM planner / agent runtime / human reviewer).
    //
    // Pre-hotfix-4 smoke surfaced Sonnet refusing with
    // `requiresContext: true` over reviewer-responsibility items
    // ("identity verification required", "rate-limit status unknown")
    // and runtime-discoverable items ("account status unknown"). The
    // prior prompt said "if you lack enough information to produce a
    // concrete plan, return requiresContext: true" without clarifying
    // what "enough information" means relative to the workflow's
    // gate structure.
    //
    // The rewrite below:
    //   1. Names the three actors and their boundaries explicitly.
    //   2. Scopes `requiresContext: true` to TECHNICAL gaps only
    //      (missing URL, ambiguous UI target, absent procedure).
    //   3. Tells the model that runbook-mandated "verify identity",
    //      "check rate limits", etc. are `verb: "verify"` actions in
    //      the plan — the reviewer handles them at `review_gate`.
    //   4. Explicitly prohibits `requiresContext: true` for
    //      reviewer-responsibility or runtime-discoverable items.
    //
    // This is the last prompt-engineering hotfix before 7b.iii. If
    // stochastic refusals still happen >1/3 runs after this, the
    // block-level controller in 7b.iii handles them via backtracking
    // — architecture tolerates non-determinism, it doesn't try to
    // eliminate it via prompt-engineering arms race.
    const system =
      "You are the planning model for a tier-1 IT helpdesk agent. You produce a UI-action plan that the agent runtime will execute against a live browser, gated by mandatory human review.\n" +
      "\n" +
      "DIVISION OF LABOR (critical — read this carefully):\n" +
      "\n" +
      "1. YOU: translate runbook procedures into a sequence of UI actions (navigate, fill, click, verify, notify). You decide WHAT UI steps to take.\n" +
      "\n" +
      "2. The agent runtime: executes those UI actions via Playwright. It can DISCOVER live state during execution — account status, rate-limit counts, toast confirmations — by navigating and reading the DOM. You do NOT need this state upfront; your plan's `verify` actions mark the points where it should be checked.\n" +
      "\n" +
      "3. The human reviewer (mandatory, non-bypassable): approves or rejects the whole plan at `review_gate` AFTER you produce it. The reviewer is responsible for:\n" +
      "   - Requester identity verification.\n" +
      "   - Authorization and policy checks.\n" +
      "   - Runbook-mandated human-judgment gates.\n" +
      "   - Rate-limit and account-state sanity checks.\n" +
      "\n" +
      "   You do NOT do these. When a runbook says \"verify identity\" or \"require human review\", you include a `verb: \"verify\"` action at that point in the plan — the reviewer handles it at `review_gate`.\n" +
      "\n" +
      "WHEN TO RETURN `requiresContext: true`:\n" +
      "\n" +
      "Use `requiresContext: true` ONLY when you cannot construct a valid UI action sequence due to missing TECHNICAL information — e.g., the target application's URL is not provided, the UI targets are genuinely ambiguous (multiple possible buttons with no disambiguator), or the runbook procedure is entirely absent.\n" +
      "\n" +
      "Do NOT return `requiresContext: true` for:\n" +
      "- Missing requester identity → that's the reviewer's job at `review_gate`.\n" +
      "- Unknown current account status → the plan discovers this via navigation.\n" +
      "- Unknown rate-limit counts → the plan discovers this on the user detail page.\n" +
      "- Ambiguity the reviewer can resolve with a single decision at the gate.\n" +
      "\n" +
      "Return ONLY a JSON object matching this schema:\n" +
      "{\n" +
      '  "narrative": string,                      // short prose reasoning\n' +
      '  "actions": [{                             // [] if requiresContext=true\n' +
      '    "stepNumber": 1,\n' +
      '    "verb": "navigate"|"fill"|"click"|"verify"|"notify",\n' +
      '    "target": string,                       // e.g. "email textbox on /login"\n' +
      '    "value": string | null,                 // null for actions without a value\n' +
      '    "description": string\n' +
      "  }],\n" +
      '  "destructive": boolean,                   // true iff any action is destructive\n' +
      '  "requiresContext": boolean,\n' +
      '  "missingContext": string[]?               // required if requiresContext=true\n' +
      "}\n" +
      "No prose outside the JSON.";

    // 7b.ii-hotfix-2 — omit the "Submitted by" line entirely when
    // `submittedBy` is undefined, matching classifyStep's existing
    // pattern. Rendering "Submitted by: (unknown)" was a template
    // artifact that Sonnet correctly flagged as a missing-context
    // signal during 7b.ii-hotfix-1 smoke.
    //
    // 7b.ii-hotfix-4 — prepend a "Target application" section with
    // the test-webapp's base URL + known routes. Pre-hotfix-4 Sonnet
    // flagged "Internal Admin Portal URL not provided" as a
    // missingContext item — legitimate gap we really did need to
    // close. `buildTargetAppContext` pulls the URL from env (same
    // source the Playwright MCP driver uses) and enumerates the
    // known routes so Sonnet can write concrete `target` strings
    // referencing `/login`, `/users/:id/reset-password`, etc.
    // 7b.iii.a — prepend prior-pass observations when invoked from
    // inside the Block 1 controller's iteration loop (pass N > 0).
    // Empty string on pass 0 or when invoked outside the controller.
    const userMsg =
      observationsPrefix(priorObservations) +
      `Ticket: ${ticket?.subject ?? "(unknown)"}\n` +
      `Ticket ID: ${ticket?.ticketId ?? "(unknown)"}\n` +
      (ticket?.submittedBy ? `Submitted by: ${ticket.submittedBy}\n` : "") +
      `\n` +
      `Classification: ${JSON.stringify(inputData.classification)}\n\n` +
      buildTargetAppContext(inputData.classification.targetApps) +
      "\n\n" +
      formatHitLines(inputData.hits.runbooks, "Runbook hits") +
      "\n\n" +
      formatHitLines(inputData.hits.skills, "Skill-card hits") +
      "\n\n" +
      `Produce a JSON plan per the schema.`;

    const result = await streamMessage({
      runId,
      bus,
      stepId: "plan",
      tier: "sonnet",
      maxTokens: 4096,
      thinkingEnabled: true,
      thinkingBudgetTokens: 8192,
      system,
      messages: [{ role: "user", content: userMsg }],
    });

    const planId = randomUUID();
    const parsed = tryParseJson<Record<string, unknown>>(result.text);

    // Malformed-JSON fallback: preserves the "UI shows truth" invariant
    // by landing a drift as a cleanly-marked "needs context" refusal
    // (diagnostic in missingContext). 7b.iii's Block 1 loop controller
    // will naturally retry on requiresContext=true, so drift gets free
    // recovery once the controller lands. `responsePreview` in the log
    // lets us debug "why is the model drifting off JSON" without a
    // full run replay.
    if (!parsed) {
      logger.warn(
        {
          runId,
          stepId: "plan",
          responsePreview: result.text.slice(0, 200),
        },
        "[planStep] model returned non-JSON; marking requiresContext=true",
      );
      return {
        planId,
        actionCount: 0,
        destructive: false,
        skillCardIds: [],
        planText: result.text.slice(0, 2000),
        // 7b.iii.b commit 4 (Bug 3A mitigation) — thinking is already
        // streamed via `llm.thinking.delta` frames; embedding it in
        // step.completed.output would push plan step.completed past
        // MAX_FRAME_BYTES on long-thinking Sonnet calls. UI's thinking
        // fade reads from the delta stream, not from step.completed
        // (verified: rg 'thinking' services/test-webapp shows zero
        // reads of plan.thinking from the output path). Empty string
        // keeps PlanSchema.thinking's required-string shape intact.
        thinking: "",
        classification: inputData.classification,
        actions: [],
        requiresContext: true,
        missingContext: ["model did not return valid JSON matching PlanSchema"],
      };
    }

    // Validate actions[] — best-effort coerce. Actions that don't match
    // PlanActionSchema (e.g., verb outside the enum, missing target)
    // are dropped silently from the output. 7b.ii-hotfix-3 added
    // per-action rejection capture so the partial-drop path has a
    // useful diagnostic log (pre-hotfix-3 the "value: null" bug was
    // completely silent — 7 of 9 actions dropped with no signal).
    const rawActions = Array.isArray(parsed.actions)
      ? (parsed.actions as unknown[])
      : [];
    const actions: z.infer<typeof PlanActionSchema>[] = [];
    const rejections: Array<{ index: number; issues: string }> = [];
    for (let i = 0; i < rawActions.length; i++) {
      const av = PlanActionSchema.safeParse(rawActions[i]);
      if (av.success) {
        actions.push(av.data);
      } else {
        rejections.push({
          index: i,
          issues: av.error.issues
            .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
            .join("; "),
        });
      }
    }

    // requiresContext logic fix (hotfix pre-apply catch): if ANY valid
    // action survived Zod, the plan is usable; otherwise flag
    // requiresContext regardless of what the model claimed. Closes the
    // gap where rawActions.length > 0 but actions.length === 0 (schema
    // drift) would previously leave requiresContext=false with an
    // empty actions[] — rendering as "0-step plan" in the UI.
    const validActionsPresent = actions.length > 0;
    const requiresContext =
      Boolean(parsed.requiresContext) || !validActionsPresent;

    // 7b.ii-hotfix-3 — partial-drop diagnostic. Pre-hotfix-3 the warn
    // log only fired when ALL raw actions failed validation; partial
    // drops (the `value: null` path that caused 7 of 9 actions to
    // silently disappear) produced zero log signal. Now we split:
    //   - rawCount > 0, validCount == 0 → full-drop warn (as before)
    //   - rawCount > validCount > 0    → partial-drop warn (new)
    // Each carries the first rejection's Zod issues so future
    // schema-drift bugs surface in logs instead of only in smoke.
    const rawCount = rawActions.length;
    const validCount = actions.length;
    if (rawCount > 0 && validCount === 0) {
      logger.warn(
        {
          runId,
          stepId: "plan",
          rawCount,
          firstRejection: rejections[0]?.issues ?? null,
          responsePreview: result.text.slice(0, 200),
        },
        "[planStep] model returned actions but none passed PlanActionSchema; marking requiresContext=true",
      );
    } else if (rawCount > validCount) {
      logger.warn(
        {
          runId,
          stepId: "plan",
          rawCount,
          validCount,
          droppedCount: rawCount - validCount,
          firstRejection: rejections[0] ?? null,
          responsePreview: result.text.slice(0, 200),
        },
        "[planStep] some actions dropped during PlanActionSchema validation",
      );
    }

    const missingContextRaw = Array.isArray(parsed.missingContext)
      ? (parsed.missingContext as unknown[])
          .map((m) => String(m).slice(0, 200))
          .slice(0, 8)
      : undefined;
    const destructive = Boolean(parsed.destructive);
    const narrative =
      typeof parsed.narrative === "string" ? parsed.narrative : "";

    return {
      planId,
      actionCount: actions.length, // authoritative (derived)
      destructive, // LLM-declared (not regex-inferred)
      skillCardIds: [],
      planText: narrative, // narrative prose for reviewer UI display
      // 7b.iii.b commit 4 (Bug 3A mitigation) — see refusal-path comment above.
      thinking: "",
      classification: inputData.classification,
      actions,
      requiresContext,
      ...(missingContextRaw && missingContextRaw.length > 0
        ? { missingContext: missingContextRaw }
        : {}),
    };
  }
}

const planStep = createStep({
  id: "plan",
  inputSchema: RetrievalSchema,
  outputSchema: PlanSchema,
  execute: ({ inputData }) => runPlanStep(inputData),
});

/** 7b.iii.a — extracted dryRunStep body so the Block 1 controller can
 *  invoke it directly (outside Mastra's step-execution machinery).
 *  `dryRunStep` becomes a thin wrapper; the controller calls this
 *  function and emits its own `step.started` / `step.completed` frames
 *  around the invocation. `priorObservations` is NOT threaded into
 *  dry_run — the step's behavior is deterministic Playwright
 *  orchestration, not an LLM call that could benefit from observations
 *  (the next classify/retrieve/plan passes use them). */
export async function runDryRunStep(
  inputData: z.infer<typeof PlanSchema>,
  abortSignal: AbortSignal | undefined,
): Promise<z.infer<typeof DryRunSchema>> {
    // Commit 6b: real Playwright MCP against test-webapp. Dry-run is the
    // READ-ONLY reconnaissance pass — we log in, navigate to the user
    // detail page, take screenshots the reviewer will see at the review
    // gate, but we do NOT click the destructive "Reset password" action.
    // That lands in `executeStep` after human approval.
    //
    // The `BrowserSession` created here is stashed on `RunContext.browser`
    // so `executeStep` can inherit the logged-in Chromium session —
    // otherwise `executeStep` would have to redo the login dance every
    // run, doubling demo latency and duplicating nav frames in the
    // reviewer UI. The workflow wrapper in `http/triage.ts` owns the
    // matching `session.close()` in its outer `finally`.
    const ctx = getRunContext();
    const { runId, bus } = ctx;

    // 7b.iii.b-pre-exec-edit-ui-hotfix-1 — close any prior browser
    // session before launching a new one. Playwright MCP locks
    // `.playwright-videos/<runId>/.mcp-profile` per run; re-launching
    // without an explicit close fails immediately with
    //   "Browser is already in use, use --isolated to run multiple
    //   instances of the same browser".
    //
    // This trips in TWO scenarios:
    //   (a) commit 2's refine loop — initial Block 1's dry_run opens
    //       session A, refine re-runs Block 1 whose dry_run tries to
    //       open session B → lock collision.
    //   (b) 7b.iii.a's intra-Block-1 multi-pass — pass 0's dry_run
    //       leaves a session open, pass 1's dry_run collides the
    //       same way.
    //
    // Retroactive audit on postgres events surfaced 4 prior runs
    // carrying this error. Bug A (spread-mutation ctx.browser loss,
    // fixed in 7b.iii.b-2-hotfix-1) was HIDING Bug B's wire signal —
    // the session reference never survived to executeStep, which
    // masked the lock collision as a separate downstream
    // "playwright.session_check: no browser" failure. Fixing A
    // unmasked B. Self-healing pre-close here covers every caller
    // uniformly (refine + intra-Block-1 + any future caller) without
    // splitting browser-lifecycle knowledge across files.
    //
    // Silent catch on close() is deliberate: if the prior transport
    // already died, close() throws but the MCP profile lock is
    // released regardless, and the subsequent launchBrowser below
    // will succeed.
    if (ctx.browser) {
      try {
        await ctx.browser.close();
      } catch {
        // Prior session already dead; lock is released.
      }
      ctx.browser = undefined;
    }

    const session = await launchBrowser({
      runId,
      bus,
      stepId: "dry_run",
      signal: abortSignal,
    });
    ctx.browser = session;

    const anomalies: string[] = [];
    let domMatches = true;
    const baseUrl = env("TEST_WEBAPP_URL");

    try {
      // 1. Login page
      await session.navigate(`${baseUrl}/login`);
      const loginSnap = await session.snapshot();
      await session.takeScreenshot("dry_run:login-page");

      // Role filters on each lookup guard against ambiguous substring hits.
      // Specifically: on /login the heading "Sign in" (h1) appears BEFORE
      // the button "Sign in" — plain findRefByAccessibleName returns the
      // heading and a subsequent click does nothing. Confirmed by
      // findRef.test.ts fixtures captured from real MCP output.
      const emailRef = findRefForRole(loginSnap.text, "textbox", "Email");
      const passwordRef = findRefForRole(loginSnap.text, "textbox", "Password");
      const submitRef = findRefForRole(loginSnap.text, "button", "Sign in");

      if (!emailRef || !passwordRef || !submitRef) {
        anomalies.push(
          `login refs missing: email=${!!emailRef} password=${!!passwordRef} submit=${!!submitRef}`,
        );
        domMatches = false;
      } else {
        await session.fillForm([
          { name: "email", type: "textbox", ref: emailRef, value: env("TARGET_APP_USER") },
          { name: "password", type: "textbox", ref: passwordRef, value: env("TARGET_APP_PASSWORD") },
        ]);
        await session.click({ element: "login submit button", ref: submitRef });
      }

      // 2. After login → /users list lands here (login redirects).
      await session.navigate(`${baseUrl}/users`);
      await session.takeScreenshot("dry_run:users-list-initial");

      // 3. Search for "jane". Hardcoded target for 6b; Week-2 skill cards
      //    will parse the target user out of the ticket subject properly.
      const usersSnap = await session.snapshot();
      // Accessible name comes from the `aria-label="Search users"` on the
      // test-webapp input. The submit button is just "Search". Role filters
      // matter here because "Search" substring-matches both the textbox
      // ("Search users") and the button ("Search") — without the filter the
      // textbox wins and we'd fillForm + click on the input instead of its
      // submit.
      // Role is `searchbox` (the implicit ARIA role of `<input type="search">`
      // — the test-webapp's users search input), NOT `textbox`. Confirmed
      // empirically in 6b-hotfix-4 live smoke via the diagnostic
      // `extractLinesMatching` dump, which showed
      // `searchbox "Search users" [ref=e21]` in the snapshot. The button
      // lookup was always fine — a plain `button "Search" [ref=e22]`.
      const searchRef = findRefForRole(usersSnap.text, "searchbox", "Search users");
      const searchSubmitRef = findRefForRole(usersSnap.text, "button", "Search");
      if (!searchRef) {
        // 6b-hotfix-3 live smoke flagged this path as needing a fresh
        // live-snapshot probe to decide the right role/name — the current
        // lookup misses on some runs. Dump the lines containing the word
        // "Search" so the next smoke's anomaly payload tells the reviewer
        // exactly what to target without needing another deployment cycle.
        anomalies.push(
          `search textbox ref missing on /users. snapshot-search-lines: ${extractLinesMatching(usersSnap.text, "search")}`,
        );
        domMatches = false;
      }
      if (!searchSubmitRef) {
        anomalies.push(
          `search submit button ref missing on /users. snapshot-button-lines: ${extractLinesMatching(usersSnap.text, "button")}`,
        );
        domMatches = false;
      }
      if (searchRef && searchSubmitRef) {
        await session.fillForm([
          { name: "search query", type: "textbox", ref: searchRef, value: "jane" },
        ]);
        await session.click({ element: "user search submit", ref: searchSubmitRef });
      }
      // Skip-search recovery: downstream findRefForRole("link",
      // "jane@example.com") still works against the FULL (unfiltered) user
      // list since Jane is one of 20 seeded rows. That's why 6b-hotfix-3
      // live smoke saw the reset succeed despite these refs missing.

      // 4. Click through to Jane's detail page.
      const searchResultSnap = await session.snapshot();
      await session.takeScreenshot("dry_run:users-search-jane");
      // The test-webapp's users page sets `aria-label="View <name> (<email>)"`
      // on each row's View link (added in 6b-hotfix-2 for this exact
      // disambiguation need). Matching on the unique email uniquely selects
      // Jane's row even when 19 other "View" links are on the page.
      // Role-filtered to `link` so plain cell text containing the email
      // (if/when rendered with its own ref) can't accidentally match.
      const viewRef = findRefForRole(searchResultSnap.text, "link", "jane@example.com");
      if (!viewRef) {
        anomalies.push("user-view-u-001 not found in search results");
        domMatches = false;
      } else {
        await session.click({ element: "view Jane Cooper", ref: viewRef });
      }

      // 5. Snapshot user detail — final dry-run frame. DO NOT click the
      //    reset-password link; that's executeStep's job.
      const detailSnap = await session.snapshot();
      await session.takeScreenshot("dry_run:user-detail");
      const resetLinkRef = findRefForRole(detailSnap.text, "link", "Reset password");
      if (!resetLinkRef) {
        anomalies.push("'Reset password' link not found on user detail — cannot proceed");
        domMatches = false;
      }
      // The status badge on the user detail page renders in Playwright MCP's
      // snapshot as a `generic` element whose text content is the status
      // string, e.g. `- generic [ref=e53]: locked`. We explicitly anchor to
      // that shape — an earlier version used `/\b(active|locked|suspended)\b/`
      // against the whole snapshot, which picked up MCP's ROOT element's
      // `[active]` focus marker (the first line of every snapshot is
      // `- generic [active] [ref=e1]:`) and reported a false-positive
      // `user-status appears to be 'active'` anomaly on every run. 6c-1
      // re-smoke exposed the false positive once session isolation cleared
      // the louder `login refs missing` anomaly; fix landed with 6c-2.
      const status = extractUserStatus(detailSnap.text);
      if (status && status.toLowerCase() !== "locked") {
        anomalies.push(
          `user-status appears to be '${status}' (expected 'locked' for reset)`,
        );
      }
    } catch (err) {
      if (err instanceof PlaywrightMcpError) {
        anomalies.push(`playwright-mcp error: ${err.message}`);
        domMatches = false;
        logger.warn(
          { runId, err: err.message, toolName: err.toolName },
          "[dry_run] playwright-mcp call failed",
        );
      } else {
        throw err;
      }
    }

    return { domMatches, anomalies, plan: inputData };
}

const dryRunStep = createStep({
  id: "dry_run",
  inputSchema: PlanSchema,
  outputSchema: DryRunSchema,
  execute: ({ inputData, abortSignal }) => runDryRunStep(inputData, abortSignal),
});

/** 7b.iii.b — extracted reviewGate body so humanVerifyGateStep
 *  (commit 3) can re-invoke the pre-execute review on a backtrack
 *  iteration. `reviewHint` defaults to "pre_exec" for the
 *  Mastra-driven workflow path.
 *
 *  7b.iii.b commit 2 — refine loop: on `decision === "edit"`,
 *  synthesize observations from `patch.notes` and re-run Block 1
 *  with them threaded into `RunContext.priorObservations`. Emits
 *  `block.backtrack.triggered { fromStep: "review_gate" }` on each
 *  refine — same envelope variant commit 3's post-exec backtrack
 *  uses, discriminated by `fromStep`.
 *
 *  Cap: `MAX_PRE_GATE_REFINES = 2` → slot 0 (initial) + slot 1
 *  (refine #1) + slot 2 (refine #2) = 3 total slots. 3rd edit trips
 *  the cap and terminates as reject via the existing reject path
 *  (executeStep.skipped → verifyStep.skipped → logAndNotifyStep
 *  status=rejected). */
export async function runReviewGateStep(
  inputData: z.infer<typeof DryRunSchema>,
  opts: {
    /** Test seam — production callers pass nothing and the real
     *  `runBlock1` from blockController is used. Tests inject a stub
     *  to observe invocation count and per-refine priorObservations. */
    runBlock1Fn?: typeof runBlock1;
    abortSignal?: AbortSignal;
  } = {},
): Promise<z.infer<typeof ReviewSchema>> {
  const ctx = getRunContext();
  const { runId, bus, ticket } = ctx;
  const runBlock1Impl = opts.runBlock1Fn ?? runBlock1;

  let currentDryRun = inputData;
  let refineCount = 0;

  // Refine loop. Terminates by return on approve, reject, or
  // cap-trip; no other exit paths.
  while (true) {
    bus.publish({
      runId,
      stepId: "review_gate",
      payload: {
        type: "review.requested",
        plan: {
          planId: currentDryRun.plan.planId,
          actionCount: currentDryRun.plan.actionCount,
          destructive: currentDryRun.plan.destructive,
          skillCardIds: currentDryRun.plan.skillCardIds,
        },
        screenshots: [`playwright-videos/${runId}/dry_run-users.png`],
        viewerUrl: "http://localhost:6080",
        requiresApproval: true,
        reviewHint: "pre_exec",
        // 7b.iii.a — forward the Block 1 controller's result when
        // the inbound DryRunSchema carries it (exhausted-passes
        // path). Also fires on refined passes if refine exhausted.
        ...(currentDryRun.blockResult
          ? { blockResult: currentDryRun.blockResult }
          : {}),
      },
    });

    const decision = await bus.awaitDecisionForStep(runId, "review_gate");

    if (decision.decision === "approve") {
      return { decision: "approve", approved: true, dryRun: currentDryRun };
    }

    // Week-2a gate-decision-model — terminate short-circuits to the
    // skip cascade (executeStep.skipped → verifyStep.skipped →
    // logAndNotifyStep status=rejected). This is the mechanism
    // pre-week2a "reject" used verbatim; repurposed under the
    // clearer name. Browser cleanup via http/triage.ts:213-219
    // finally block fires on any return path so no special teardown
    // needed here.
    if (decision.decision === "terminate") {
      return {
        decision: "terminate",
        approved: false,
        dryRun: currentDryRun,
      };
    }

    // decision.decision === "edit" OR decision.decision === "reject"
    //   — both route into the refine loop. The difference is the
    //   seed observation that goes into Block 1's priorObservations:
    //     edit   → reviewer's patch.notes (if present) or
    //              edit-without-notes fallback copy.
    //     reject → reject-without-notes directive copy (more
    //              prescriptive: "take a different approach").
    //   Both share the MAX_PRE_GATE_REFINES budget — a mix of edits
    //   and rejects counts against the same cap (3 total refine
    //   cycles per run).
    if (refineCount >= MAX_PRE_GATE_REFINES) {
      // Week-2a gate-decision-model — cap trip terminates cleanly
      // via the new terminate mechanism (same skip-cascade as an
      // explicit reviewer Terminate click). Pre-week2a returned
      // decision="reject" which used the same mechanism but
      // conflated reviewer-initiated full-stop with "reject =
      // replan." The new model separates them.
      logger.warn(
        { runId, refineCount, max: MAX_PRE_GATE_REFINES },
        "[review_gate] pre-exec refine budget exhausted; terminating",
      );
      return {
        decision: "terminate",
        approved: false,
        dryRun: currentDryRun,
      };
    }

    if (!ticket) {
      // Defensive — http/triage.ts always sets ticket on RunContext
      // at workflow kickoff. If somehow absent, we can't re-run
      // Block 1; terminate cleanly rather than crash.
      logger.error(
        { runId },
        "[review_gate] RunContext.ticket undefined; cannot refine. Terminating.",
      );
      return {
        decision: "terminate",
        approved: false,
        dryRun: currentDryRun,
      };
    }

    refineCount++;
    const carriedContext = buildPreGateRefineContext(
      decision.patch?.notes,
      refineCount,
      decision.decision === "reject" ? "reject" : "edit",
    );

    bus.publish({
      runId,
      stepId: "review_gate",
      payload: {
        type: "block.backtrack.triggered",
        fromStep: "review_gate",
        toBlock: "block1",
        carriedContext,
        backtrackCount: refineCount,
      },
    });

    // 7b.iii.b-pre-exec-edit-ui-hotfix-2 — re-run Block 1 with the
    // carried reviewer note threaded through `opts.seedObservations`.
    //
    // NO withRunContext spread here. The spread pattern
    // (`withRunContext({ ...ctx, priorObservations: carriedContext },
    // () => runBlock1Impl(...))`) that this code originally used
    // was doubly broken:
    //   (a) It had no effect. Block 1's internal cognitive spread
    //       at blockController.ts overrides `ctx.priorObservations`
    //       with its own accumulator (starts empty). The reviewer's
    //       note was silently dropped before reaching any LLM call.
    //   (b) It re-introduced Bug A (spread-mutation loss) at a
    //       second scope boundary. `runDryRunStep`'s
    //       `getRunContext().browser = session` mutation landed on
    //       the spread copy, not outer_ctx. When the spread
    //       unwound, outer_ctx.browser still pointed at the PRIOR
    //       session (which hotfix-1's pre-close had already
    //       closed). `executeStep` then read a closed-session
    //       reference and crashed with "cannot invoke
    //       playwright.browser_snapshot: session already closed".
    //
    // Passing `seedObservations` instead keeps `runBlock1` running
    // in the outer_ctx scope, so:
    //   - `runDryRunStep`'s browser-session mutation propagates
    //     correctly to `executeStep` (Bug 4 fix);
    //   - the reviewer's note actually reaches the LLM via Block
    //     1's internal observations accumulator (dormant note-loss
    //     fix).
    //
    // 7b.iii.b commit 4 — wrap the refine's Block 1 invocation in
    // synthetic `block1` step.started/completed frames so the LEFT
    // column's <StepOutcome> picks up refined state via its
    // `findLast` read (Piece D.2). Mastra's own stepEmitter only
    // fires block1 frames for the INITIAL block1Step.execute; the
    // refine bypasses the Mastra engine and must emit its own.
    // Hotfix-2 smoke's SQL proved the staleness directly: block1's
    // step.completed.output.plan.planId was frozen at the initial
    // plan even after a distinct refined review.requested.
    const refineBlock1StartedAt = Date.now();
    bus.publish({
      runId,
      stepId: "block1",
      payload: { type: "step.started", input: ticket },
    });

    const nextBlock = await runBlock1Impl(ticket, buildBlock1Deps(), {
      abortSignal: opts.abortSignal,
      seedObservations: carriedContext,
    });

    currentDryRun = block1ResultToDryRun(nextBlock);

    bus.publish({
      runId,
      stepId: "block1",
      payload: {
        type: "step.completed",
        output: currentDryRun,
        durationMs: Date.now() - refineBlock1StartedAt,
      },
    });

    // Loop: emit fresh review.requested + await new decision.
  }
}

const reviewGateStep = createStep({
  id: "review_gate",
  inputSchema: DryRunSchema,
  outputSchema: ReviewSchema,
  execute: ({ inputData, abortSignal }) =>
    runReviewGateStep(inputData, { abortSignal }),
});

const executeStep = createStep({
  id: "execute",
  inputSchema: ReviewSchema,
  outputSchema: ExecuteSchema,
  execute: ({ inputData }) => runExecuteStep(inputData),
});

/** 7b.iii.b — extracted executeStep body so humanVerifyGateStep can
 *  re-invoke it on a backtrack. Direct-call bypass of Mastra's
 *  engine is consistent with runReviewGateStep / runVerifyStep. */
export async function runExecuteStep(
  inputData: z.infer<typeof ReviewSchema>,
): Promise<z.infer<typeof ExecuteSchema>> {
  {
    const ctx = getRunContext();
    const { runId, bus } = ctx;

    if (!inputData.approved) {
      // Rejection path: the step.completed frame emitted by stepEmitter is a
      // sufficient boundary marker. Emitting a lone tool.started here would
      // orphan a span in any timeline UI that brackets tool work by
      // started/completed pairs. The `skipped: true` flag in the returned
      // output cascades through verify/log_and_notify and ends up in
      // run.completed { status: "rejected" }, which is the right signal for
      // downstream consumers.
      return { stepsRun: 0, skipped: true, review: inputData };
    }

    const session = ctx.browser;
    if (!session) {
      // dryRunStep should have populated RunContext.browser. If it didn't
      // (e.g. dry_run threw before launchBrowser, or something up-stack
      // cleared the reference), we can't proceed — but we also shouldn't
      // crash the run process. Emit a diagnostic tool.failed so the
      // reviewer UI shows WHY execute returned zero steps, and short-circuit
      // to verify/log_and_notify which will surface status=failed.
      const invocationId = randomUUID();
      bus.publish({
        runId,
        stepId: "execute",
        payload: {
          type: "tool.started",
          invocationId,
          name: "playwright.session_check",
          args: {},
        },
      });
      bus.publish({
        runId,
        stepId: "execute",
        payload: {
          type: "tool.failed",
          invocationId,
          name: "playwright.session_check",
          error: {
            message:
              "executeStep: no browser session on RunContext — dryRunStep must populate ctx.browser before review_gate",
            where: "executeStep.session_check",
          },
        },
      });
      logger.error(
        { runId },
        "[execute] RunContext.browser is undefined; cannot perform reset",
      );
      return { stepsRun: 0, skipped: false, review: inputData };
    }

    session.setStepId("execute");
    let stepsRun = 0;

    try {
      // Re-snapshot Jane's detail page — dry_run left us on it, but between
      // dry_run and now the reviewer may have waited minutes and the Next.js
      // page may have re-rendered. One cheap snapshot beats assuming.
      const detailSnap = await session.snapshot();
      const resetLinkRef = findRefForRole(detailSnap.text, "link", "Reset password");
      if (!resetLinkRef) {
        throw new PlaywrightMcpError(
          "'Reset password' link not found on user detail page",
          undefined,
          "playwright.browser_snapshot",
        );
      }
      await session.click({
        element: "Reset password link on user detail",
        ref: resetLinkRef,
      });
      stepsRun++;

      // Reset-password confirm page. Check the box, click submit.
      const confirmSnap = await session.snapshot();
      await session.takeScreenshot("execute:reset-confirm");
      // The checkbox's accessible name is the visible label text:
      // "I confirm I want to reset <name>'s password." — substring match on
      // "I confirm" is stable across user names. Role filter is defensive.
      const checkRef = findRefForRole(confirmSnap.text, "checkbox", "I confirm");
      // The destructive submit — role-filtered to disambiguate from the
      // page heading "Reset password for <name>" which also substring-
      // matches "Reset password".
      const submitRef = findRefForRole(confirmSnap.text, "button", "Reset password");
      if (!checkRef || !submitRef) {
        throw new PlaywrightMcpError(
          `reset form refs missing: check=${!!checkRef} submit=${!!submitRef}`,
          undefined,
          "playwright.browser_snapshot",
        );
      }
      await session.click({
        element: "confirm checkbox for destructive reset",
        ref: checkRef,
      });
      stepsRun++;
      await session.click({ element: "Reset password submit button", ref: submitRef });
      stepsRun++;

      // Success page — snapshot + screenshot so verify/log_and_notify have
      // proof-of-completion. The reset-success toast's accessible name is
      // "Password reset successful" (the `<strong>` inside the toast's
      // role="status" region).
      const successSnap = await session.snapshot();
      await session.takeScreenshot("execute:after-reset");
      if (!/password reset successful/i.test(successSnap.text)) {
        throw new PlaywrightMcpError(
          "reset-success marker not found on post-submit page",
          undefined,
          "playwright.browser_snapshot",
        );
      }
      stepsRun++;
    } catch (err) {
      // On MCP-side failure: the session wrapper has already emitted
      // tool.failed for us; we just log and return the partial count.
      // Mastra will observe no throw and the workflow proceeds to verify,
      // which reports needs-review given stepsRun < 4.
      if (err instanceof PlaywrightMcpError) {
        logger.warn(
          { runId, err: err.message, toolName: err.toolName, stepsRun },
          "[execute] playwright-mcp call failed mid-flow",
        );
      } else {
        throw err;
      }
    }

    return { stepsRun, skipped: false, review: inputData };
  }
}

const verifyStep = createStep({
  id: "verify",
  inputSchema: ExecuteSchema,
  outputSchema: VerifySchema,
  execute: ({ inputData }) => runVerifyStep(inputData),
});

/** 7b.iii.b — extracted verifyStep body so humanVerifyGateStep can
 *  re-invoke it on a backtrack. */
export async function runVerifyStep(
  inputData: z.infer<typeof ExecuteSchema>,
): Promise<z.infer<typeof VerifySchema>> {
  {
    const { runId, bus } = getRunContext();

    if (inputData.skipped) {
      return {
        success: false,
        skipped: true,
        evidence: [],
        execute: inputData,
      };
    }

    // Canned: emit a brief sonnet call (thinking off) so the timeline
    // exercises llm.text.delta without ballooning token cost.
    const system =
      "You verify an IT helpdesk action. Reply with a single sentence: 'verified' or 'needs-review'.";
    const userMsg =
      `Execute result: stepsRun=${inputData.stepsRun}, review decision=${inputData.review.decision}. Verify.`;

    const result = await streamMessage({
      runId,
      bus,
      stepId: "verify",
      tier: "sonnet",
      maxTokens: 128,
      thinkingEnabled: false,
      system,
      messages: [{ role: "user", content: userMsg }],
    });

    const success = /verified/i.test(result.text);
    return {
      success,
      skipped: false,
      evidence: [result.text.trim().slice(0, 200)],
      execute: inputData,
    };
  }
}

const logAndNotifyStep = createStep({
  id: "log_and_notify",
  inputSchema: VerifySchema,
  outputSchema: LogSchema,
  execute: async ({ inputData }) => {
    const { runId, bus } = getRunContext();

    const invocationId = randomUUID();
    bus.publish({
      runId,
      stepId: "log_and_notify",
      payload: {
        type: "tool.started",
        invocationId,
        name: "db.insert_event_log",
        args: { runId },
      },
    });

    await sleep(50);

    bus.publish({
      runId,
      stepId: "log_and_notify",
      payload: {
        type: "tool.completed",
        invocationId,
        name: "db.insert_event_log",
        resultSummary: { rows: 1 },
        durationMs: 50,
      },
    });

    const status = inputData.skipped
      ? ("rejected" as const)
      : inputData.success
        ? ("ok" as const)
        : ("failed" as const);

    return {
      status,
      note: inputData.skipped
        ? "Run rejected at review_gate; execute/verify short-circuited."
        : inputData.success
          ? "Verified."
          : "Verify step reported needs-review; escalate.",
    };
  },
});

/** ---------- Block 1 wrapper step (Commit 7b.iii.a) ---------- */

/**
 * Review-gate intent split (7b.iii.a / 7b.iii.b):
 *
 *   - `review_gate` (pre-execution, Commit 2 / 7b.iii.a): human approves
 *     the proposed plan BEFORE Block 2 executes it. Rejection here
 *     terminates the run with `run.completed status: rejected`. Intent:
 *     "this plan is wrong" — no retry, operator provides a new ticket
 *     if desired.
 *
 *   - `human_verify_gate` (post-execution, Commit 7b.iii.b — NOT YET
 *     IN PLACE): human reviews the POST-execution state. Rejection
 *     there triggers `block.backtrack.triggered` and re-enters Block 1
 *     with execute/verify observations in carriedContext. Intent: "the
 *     work didn't achieve the goal — iterate."
 *
 * Two different decisions; two different paths. Do not collapse them
 * into one gate.
 */

/** 7b.iii.b commit 2 — max pre-exec refine iterations. Each "edit"
 *  decision from the reviewer at review_gate re-runs Block 1 once
 *  with the reviewer's note injected as priorObservations. Cap = 2
 *  means: slot 0 (initial) + slot 1 (refine #1) + slot 2 (refine #2)
 *  = 3 total review cycles; the 3rd edit decision trips the cap and
 *  terminates as reject. Rationale matches blockController's
 *  BLOCK1_MAX_PASSES = 3 — more refines without human convergence
 *  means the ticket likely isn't recoverable at this skill level. */
const MAX_PRE_GATE_REFINES = 2;

/** 7b.iii.b commit 2 — shared Block1Deps factory. Returns raw
 *  references to the extracted step bodies. `runBlock1` threads its
 *  own `opts.abortSignal` into `runRetrieve` and `runDryRun` at
 *  `blockController.ts:230` and `:245`, so no closure-captured
 *  signal is needed here. Signatures match Block1Deps structurally.
 *  Extracted from block1Step's inline literal so commit 2's refine
 *  loop and commit 3's humanVerifyGate backtrack loop reference ONE
 *  definition. */
function buildBlock1Deps(): Block1Deps {
  return {
    runClassify: runClassifyStep,
    runRetrieve: runRetrieveStep,
    runPlan: runPlanStep,
    runDryRun: runDryRunStep,
  };
}

/** 7b.iii.b commit 2 — Convert Block 1's final state into the
 *  DryRunSchema shape that reviewGateStep / executeStep consume.
 *  Extracted from block1Step.execute (pre-commit-2 inline code) so
 *  commit 2's refine loop and commit 3's backtrack loop share one
 *  conversion. Byte-identical output for every input block1Step's
 *  pre-commit-2 inline code saw — zero happy-path behavior change. */
function block1ResultToDryRun(
  r: Block1Result,
): z.infer<typeof DryRunSchema> {
  if (r.passedLast && r.finalState.dryRun) {
    return {
      domMatches: r.finalState.dryRun.domMatches,
      anomalies: r.finalState.dryRun.anomalies,
      plan: r.finalState.plan,
    };
  }
  // Exhausted. If a dry_run happened to run on any pass we reuse its
  // anomalies; otherwise synthesize a diagnostic anomalies list from
  // the per-pass reasons so the reviewer sees what went wrong.
  const synthAnomalies =
    r.finalState.dryRun?.anomalies ??
    r.allReasons.map((reason, i) => `Pass ${i}: ${reason}`);
  return {
    domMatches: false,
    anomalies: synthAnomalies,
    plan: r.finalState.plan,
    blockResult: {
      passes: r.passes,
      passedLast: r.passedLast,
      allReasons: r.allReasons,
    },
  };
}

/** 7b.iii.b commit 2 — Build the priorObservations array injected
 *  into Block 1 on a pre-exec refine iteration.
 *
 *  Design: latest-note-only (NOT accumulating across refines).
 *  runBlock1 has its own per-pass observation accumulator
 *  (blockController.ts:260-275) that threads gap/anomaly observations
 *  across its internal 3 passes; passing prior refine notes back in
 *  would be duplication, not signal. Reviewer continuity surfaces in
 *  the behavior feed's retained review.decided frames (each carries
 *  its own patch.notes up to 2000 chars via PlanPatchSchema.notes).
 *
 *  Back-compat: PlanPatchSchema.notes is .optional() — when the
 *  reviewer sends `{"decision":"edit"}` with no notes, we synthesize
 *  a fallback string so Block 1 still runs a refine. Rejecting
 *  edit-without-notes would violate the back-compat spirit.
 *
 *  Envelope-cap arithmetic: BlockBacktrackTriggeredFrame.carriedContext[N]
 *  is capped at z.string().max(400). We build the string unbounded
 *  and slice at the final step so future prefix edits can't push the
 *  total past 400. Reviewer notes longer than ~365 chars are
 *  truncated here; the full note still lives in the review.decided
 *  frame's patch.notes for audit. */
function buildPreGateRefineContext(
  notes: unknown,
  refineCount: number,
  // Week-2a gate-decision-model — distinguishes "reject=replan-no-notes"
  // from "edit=replan-with-notes" for prompt-engineering purposes.
  // The seed observation text differs so Sonnet doesn't produce the
  // same plan on reject. Default "edit" preserves back-compat for any
  // call sites that don't pass the arg (there's one: triage.ts ~1330
  // at the refine-loop entry; it always passes the arg explicitly).
  decisionKind: "edit" | "reject" = "edit",
): string[] {
  const note = typeof notes === "string" ? notes.trim() : "";
  let raw: string;
  if (note.length > 0) {
    raw = `Pre-exec refine ${refineCount}: reviewer note: ${note}`;
  } else if (decisionKind === "reject") {
    // Week-2a gate-decision-model — reject-no-notes seed. Directive
    // (not merely descriptive) so Sonnet doesn't produce an identical
    // plan on the next pass. Trimmed to ~180 chars per reviewer-LLM
    // RFC audit (half the tokens of the original 330-char draft;
    // same directive intent).
    raw = `Pre-exec refine ${refineCount}: reviewer rejected the prior plan without notes. Try a fundamentally different approach — different skill card, different action sequence, or different assumption about the ticket's goal.`;
  } else {
    // edit-without-notes back-compat (PlanPatchSchema.notes is
    // optional; a client that sends decision=edit with no patch
    // still lands in this branch).
    raw = `Pre-exec refine ${refineCount}: reviewer requested retry without specific notes; re-attempt with current context.`;
  }
  return [raw.slice(0, 400)];
}

/** 7b.iii.b commit 4 — Build priorObservations for Block 1 on a
 *  post-exec backtrack iteration. Threaded via
 *  `runBlock1(..., { seedObservations: carriedContext })` per the
 *  hotfix-2 CTX SPREAD INVARIANT — NO withRunContext spread.
 *
 *  Envelope constraints: each entry capped ≤ 400 chars
 *  (BlockBacktrackTriggeredFrame.carriedContext[N]); array capped
 *  ≤ 12 entries. Envelope shape matches humanVerifyGate.test.ts [2]'s
 *  example:
 *    [0] header "Backtrack N: ..." (must match /Backtrack \d+/)
 *    [1] reviewer note as separate entry (if present)
 *    [2] prior stepsRun summary
 *    [3] prior verify.success summary
 *    [4] prior verify evidence (if present)
 *
 *  Separating the note from the header (rather than embedding it)
 *  keeps the header deterministic for test assertion and lets Sonnet
 *  weight the note as its own distinct observation in the refine
 *  prompt.
 *
 *  Exported so test/humanVerifyGate.test.ts [4] can assert the
 *  pure-function shape (no bus / no context / no stubs needed). */
export function buildBacktrackContext(
  currentVerify: z.infer<typeof VerifySchema>,
  reviewerNote: string | undefined,
  backtrackCount: number,
): string[] {
  const entries: string[] = [];
  entries.push(
    `Backtrack ${backtrackCount}: the human rejected the post-execution result.`.slice(0, 400),
  );
  const note = reviewerNote?.trim();
  if (note && note.length > 0) {
    entries.push(`Reviewer note: ${note}`.slice(0, 400));
  }
  const prev = currentVerify.execute;
  entries.push(
    `Prior attempt's execute.stepsRun: ${prev.stepsRun} (skipped=${prev.skipped}).`.slice(0, 400),
  );
  entries.push(
    `Prior attempt's verify.success: ${currentVerify.success}.`.slice(0, 400),
  );
  if (currentVerify.evidence.length > 0) {
    entries.push(
      `Prior verify evidence: ${currentVerify.evidence[0] ?? ""}`.slice(0, 400),
    );
  }
  return entries.slice(0, 12);
}

const block1Step = createStep({
  id: "block1",
  inputSchema: TicketSchema,
  outputSchema: DryRunSchema,
  execute: async ({ inputData, abortSignal }) => {
    // 7b.iii.b commit 2 — body collapsed to use shared helpers. The
    // DryRunSchema conversion (happy vs. exhausted) lives in
    // block1ResultToDryRun so commit 3's humanVerifyGate backtrack
    // loop can reuse it verbatim.
    const result = await runBlock1(inputData, buildBlock1Deps(), { abortSignal });
    return block1ResultToDryRun(result);
  },
});

/** ---------- Human-verify gate with backtrack (Commit 7b.iii.b) ----------
 *
 * PARKED 2026-04-23: the initial `humanVerifyGateStep` + backtrack loop
 * authored during the 7b.iii.b apply was reverted after discovering a
 * bus-architecture blocker:
 *   `EventBus.state.committedDecision` is a single-slot-per-run field.
 *   Once ANY `awaitDecision(runId)` resolves (e.g., for the pre-exec
 *   review_gate), all subsequent `awaitDecision(runId)` calls return
 *   the SAME cached decision immediately — the post-exec gate cannot
 *   block on a fresh human decision.
 *
 * Fixing this requires a bus extension (per-stepId decision slots +
 * a new `awaitDecisionForStep(runId, stepId)` primitive). That's a
 * focused ~100-150 LoC bus change; it was outside the proposed scope
 * of 7b.iii.b and needs a separate scope revision.
 *
 * What this commit DOES ship:
 *   - Envelope additions (block.backtrack.triggered variant,
 *     optional reviewHint on review.requested, human_verify_gate
 *     in StepIdSchema). All additive; no behavior change.
 *   - Extracted step bodies: runReviewGateStep, runExecuteStep,
 *     runVerifyStep. Same pattern as 7b.iii.a's runClassifyStep /
 *     runRetrieveStep / runPlanStep / runDryRunStep. Mastra wrappers
 *     delegate to them; existing behavior preserved.
 *   - Envelope + primitive tests that guard the wire contract +
 *     the EventBus decision mechanics as they exist today.
 *
 * What this commit does NOT ship (revisit in 7b.iii.c or equivalent):
 *   - humanVerifyGateStep itself.
 *   - workflow chain insertion.
 *   - backtrack loop + buildBacktrackContext + buildBlock1Deps.
 *   - reviewer UI for post-exec gate, pass-N indicator, backtrack
 *     banner.
 *
 * See the apply-time handoff record for the full discussion + next
 * scope cycle proposal.
 */

/** 7b.iii.b commit 4 — max post-exec backtrack iterations. Each
 *  reject on the human-verify gate re-runs the full pre-notify chain
 *  (Block 1 + review_gate + execute + verify) with the reviewer's
 *  reject context as observations. Cap = 2 means: slot 0 (initial
 *  post-exec review) + slot 1 (backtrack #1) + slot 2 (backtrack #2)
 *  = 3 total human-verify-gate cycles. 3rd reject forces
 *  `success: false` + evidence marker and the run terminates via
 *  logAndNotifyStep with status=failed. Symmetric with
 *  MAX_PRE_GATE_REFINES (pre-exec refine cap) and BLOCK1_MAX_PASSES
 *  (Block 1 internal cap). */
const MAX_BACKTRACKS = 2;

/** 7b.iii.b commit 4 — humanVerifyGateStep un-parked. Pattern was
 *  correctness-adjusted in-comment during hotfix-2 (awaitDecisionForStep
 *  bus API, seedObservations thread, no-spread around runBlock1); this
 *  un-park strips `/* PARKED: *\/` delimiters without further body
 *  changes. See humanVerifyGate.test.ts for 3 envelope-shape guards
 *  authored during the 7b.iii.b partial ship. */
const humanVerifyGateStep = createStep({
  id: "human_verify_gate",
  inputSchema: VerifySchema,
  outputSchema: VerifySchema,
  execute: async ({ inputData, abortSignal }) => {
    const ctx = getRunContext();
    const { runId, bus, ticket } = ctx;

    // Week-2a gate-decision-model-hotfix-1 — upstream skipped=true
    // pass-through. When pre-exec Terminate cascades through
    // executeStep.skipped → verifyStep.skipped, the VerifySchema
    // that arrives here carries skipped=true and there is no
    // destructive action to review. Pre-hotfix: the gate opened
    // anyway and awaited a decision, causing the post-exec
    // review.requested{post_exec} to publish on runs the reviewer
    // had just terminated — a confusing UX (P4 smoke observed: a
    // second terminate at post-exec was required to close the
    // run). Post-hotfix: pass through to logAndNotifyStep verbatim
    // so status=rejected derives from the existing skipped=true
    // mapping at line 1638-1642, same mechanism Finding 2's
    // budget-exhaust fix uses.
    //
    // Placement is BEFORE backtrackCount init + while loop — the
    // guard fires before any bus work, any decision await, any
    // local state. Symmetric with executeStep's skip-guard at the
    // top of runExecuteStep (line 1421-1430) and verifyStep's
    // analogous check.
    if (inputData.skipped) {
      return inputData;
    }

    let currentVerify = inputData;
    let backtrackCount = 0;

    while (true) {
      // Emit post-exec review.requested. stepId="human_verify_gate"
      // differentiates it from the pre-exec review_gate emission;
      // reviewHint="post_exec" is the authoritative signal for the UI
      // to render "approve completion" copy + point at the feed's
      // execute:* screenshots as the evidence surface.
      bus.publish({
        runId,
        stepId: "human_verify_gate",
        payload: {
          type: "review.requested",
          plan: {
            planId: currentVerify.execute.review.dryRun.plan.planId,
            actionCount: currentVerify.execute.review.dryRun.plan.actionCount,
            destructive:
              currentVerify.execute.review.dryRun.plan.destructive,
            skillCardIds:
              currentVerify.execute.review.dryRun.plan.skillCardIds,
          },
          // 7b.iii.b — post-exec evidence lives in the behavior feed
          // above (the execute:* screenshots). Embedding paths here
          // would require plumbing them through ExecuteSchema →
          // VerifySchema; that's Week 2 polish. For now the panel
          // tells the reviewer to scroll the feed.
          screenshots: [],
          viewerUrl: "http://localhost:6080",
          requiresApproval: true,
          reviewHint: "post_exec",
          ...(currentVerify.execute.review.dryRun.blockResult
            ? { blockResult: currentVerify.execute.review.dryRun.blockResult }
            : {}),
        },
      });

      // 7b.iii.b-pre-exec-edit-ui-hotfix-2 — post-commit-1 bus API.
      // Uses awaitDecisionForStep targeting "human_verify_gate" so
      // the post-exec gate awaits its own per-stepId slot (the
      // pre-exec review_gate's slot is already resolved upstream).
      const decision = await bus.awaitDecisionForStep(runId, "human_verify_gate");

      if (decision.decision === "approve" || decision.decision === "edit") {
        // Happy path — return the current verify output. Mastra's
        // workflow engine proceeds to logAndNotifyStep with status=ok.
        // Edit is treated as approve here per the wedge-prevention
        // docblock at the top of this step's Commit 4 implementation
        // (humanVerifyGateStep treats edit≡approve server-side; UI
        // hides Edit on post-exec to prevent the wedge).
        return currentVerify;
      }

      // Week-2a gate-decision-model — terminate short-circuits to
      // logAndNotifyStep with status=rejected. Symmetric with the
      // budget-exhaust return shape (Finding 2 fix, landed in
      // week2a-gate-exhaust-status): skipped=true surfaces
      // reviewer-initiated rejection via the derivation at line
      // 1638-1642. Does NOT enter the backtrack loop — the reviewer
      // explicitly wants to stop, not iterate.
      if (decision.decision === "terminate") {
        return {
          ...currentVerify,
          success: false,
          skipped: true,
          evidence: [
            ...currentVerify.evidence,
            `Post-exec review terminated by reviewer after backtrack ${backtrackCount}.`,
          ],
        };
      }

      // Reject. Check backtrack budget.
      if (backtrackCount >= MAX_BACKTRACKS) {
        logger.warn(
          { runId, backtrackCount, max: MAX_BACKTRACKS },
          "[human_verify_gate] backtrack budget exhausted; returning rejected verify",
        );
        // Week-2a gate-exhaust-status (Finding 2) — set skipped=true
        // so logAndNotifyStep's derivation at line 1638-1642 emits
        // status=rejected, not status=failed.
        //
        // Semantic rationale: skipped=true ≡ reviewer-initiated
        // rejection (the cascade path today's pre-exec reject /
        // terminate uses). Budget exhaust means the reviewer
        // refused the work MAX_BACKTRACKS+1 times — that's an
        // aggregated reviewer rejection, not a workflow execution
        // error. Pre-fix: the return omitted skipped, which fell
        // through to status=failed in logAndNotifyStep (pollutes
        // the rejected-vs-failed forensic semantics and implied
        // workflow-layer fault when there was none).
        //
        // Symmetric with: runReviewGateStep's reject/cap-trip paths
        // (line 1285-1310) which return approved=false → executeStep
        // skipped → verifyStep skipped → logAndNotifyStep rejected.
        return {
          ...currentVerify,
          success: false,
          skipped: true,
          evidence: [
            ...currentVerify.evidence,
            `Backtrack budget exhausted after ${backtrackCount} iteration${backtrackCount === 1 ? "" : "s"}; final human-verify decision: reject.`,
          ],
        };
      }

      backtrackCount++;
      const decisionNote =
        typeof decision.patch?.notes === "string"
          ? decision.patch.notes
          : undefined;
      const carriedContext = buildBacktrackContext(
        currentVerify,
        decisionNote,
        backtrackCount,
      );

      bus.publish({
        runId,
        stepId: "human_verify_gate",
        payload: {
          type: "block.backtrack.triggered",
          fromStep: "human_verify_gate",
          toBlock: "block1",
          carriedContext,
          backtrackCount,
        },
      });

      if (!ticket) {
        // Defensive: the workflow kickoff in http/triage.ts always sets
        // ticket on RunContext. If somehow it's absent we can't
        // re-invoke Block 1. Fall through to a failed verify so the
        // run terminates cleanly.
        logger.error(
          { runId },
          "[human_verify_gate] RunContext.ticket is undefined; cannot backtrack",
        );
        return {
          ...currentVerify,
          success: false,
          evidence: [
            ...currentVerify.evidence,
            "Backtrack aborted: run context lost ticket reference.",
          ],
        };
      }

      // 7b.iii.b-pre-exec-edit-ui-hotfix-2 — re-run the full
      // pre-notify chain with the backtrack carriedContext threaded
      // through `runBlock1`'s `seedObservations` opt. NO
      // withRunContext spread around the block1/review/execute/verify
      // chain — same reasoning as the pre-exec refine loop at
      // `runReviewGateStep` above:
      //   (a) spread-mutation loss traps `runDryRunStep`'s browser
      //       reference on the spread copy → `executeStep` crashes
      //       with "session already closed";
      //   (b) Block 1's inner cognitive spread overrides
      //       `ctx.priorObservations` anyway, so the "spread to
      //       pass observations" pattern is doubly broken.
      // Also uses hotfix-1's post-ref signature `buildBlock1Deps()`
      // (no arg — `runBlock1` threads its own `opts.abortSignal` to
      // deps internally).
      //
      // 7b.iii.b commit 4 — synthetic block1 step frames on backtrack
      // (symmetric with runReviewGateStep's refine loop — see the
      // refine docblock for rationale; reviewer UI needs to see the
      // backtrack's Block 1 output in LEFT column's block1 row).
      const backtrackBlock1StartedAt = Date.now();
      bus.publish({
        runId,
        stepId: "block1",
        payload: { type: "step.started", input: ticket },
      });
      const block1 = await runBlock1(ticket, buildBlock1Deps(), {
        abortSignal,
        seedObservations: carriedContext,
      });
      bus.publish({
        runId,
        stepId: "block1",
        payload: {
          type: "step.completed",
          output: block1ResultToDryRun(block1),
          durationMs: Date.now() - backtrackBlock1StartedAt,
        },
      });

      // Hand Block 1's last-pass state to reviewGate. If Block 1
      // exhausted on this backtrack iteration, blockResult is set
      // and the UI's "exhausted" banner fires + approve is disabled
      // — the human has to reject or sit tight.
      const gate1InputDry: z.infer<typeof DryRunSchema> =
        block1.passedLast && block1.finalState.dryRun
          ? {
              domMatches: block1.finalState.dryRun.domMatches,
              anomalies: block1.finalState.dryRun.anomalies,
              plan: block1.finalState.plan,
            }
          : {
              domMatches: false,
              anomalies:
                block1.finalState.dryRun?.anomalies ??
                block1.allReasons.map((r, i) => `Pass ${i}: ${r}`),
              plan: block1.finalState.plan,
              blockResult: {
                passes: block1.passes,
                passedLast: block1.passedLast,
                allReasons: block1.allReasons,
              },
            };

      // Re-enter review_gate. Pre-exec terminate (or the internal
      // refine-budget cap trip which now returns decision="terminate"
      // too per the week2a gate-decision-model) short-circuits the
      // backtrack chain. Pre-exec "reject" under the new model routes
      // through the refine loop inside runReviewGateStep and never
      // exits with decision="reject" directly — so `gate1Out.decision`
      // here is always "approve" (continue) or "terminate" (short-
      // circuit).
      const gate1Out = await runReviewGateStep(gate1InputDry);
      let nextVerify: z.infer<typeof VerifySchema>;
      if (gate1Out.decision === "terminate") {
        nextVerify = {
          success: false,
          skipped: true,
          evidence: [
            `Pre-exec review terminated during backtrack ${backtrackCount}.`,
          ],
          execute: {
            stepsRun: 0,
            skipped: true,
            review: gate1Out,
          },
        } satisfies z.infer<typeof VerifySchema>;
      } else {
        const exec = await runExecuteStep(gate1Out);
        nextVerify = await runVerifyStep(exec);
      }

      currentVerify = nextVerify;
      // Loop: the top of the while emits a fresh post-exec
      // review.requested for the human to review the NEW verify result.
    }
  },
});

/** ---------- Workflow ---------- */

export const triageWorkflow = createWorkflow({
  id: "triage-and-execute",
  inputSchema: TicketSchema,
  outputSchema: LogSchema,
})
  .then(block1Step)            // 7b.iii.a — wraps classify → retrieve → plan → dry_run
  .then(reviewGateStep)        // pre-exec gate (Commit 2) — reject terminates; edit triggers refine loop
  .then(executeStep)
  .then(verifyStep)
  .then(humanVerifyGateStep)   // 7b.iii.b commit 4 — post-exec gate; reject triggers backtrack to Block 1
  .then(logAndNotifyStep)
  .commit();

export type TriageInput = z.infer<typeof TicketSchema>;
export type TriageOutput = z.infer<typeof LogSchema>;

/** ---------- helpers ---------- */

function tryParseJson<T>(raw: string): T | null {
  // Be lenient: models often wrap JSON in ```json ... ``` fences or preamble.
  // Grab the first {...} block; if that fails, try the whole string.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch?.[1] ?? raw.trim();
  // Try full candidate first.
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const braceMatch = candidate.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]) as T;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function pickUrgency(raw: unknown): "low" | "medium" | "high" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "high" || s === "medium" || s === "low") return s;
  return "low";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extract the `ref=<id>` that `@playwright/mcp`'s `browser_snapshot` assigns
 *  to the element whose accessible name contains `needle` (case-insensitive
 *  substring match on the quoted-name token).
 *
 *  Playwright MCP's snapshot is an accessibility tree — each line looks like:
 *
 *      textbox "Email" [ref=e12]
 *      button "Sign in" [ref=e16] [cursor=pointer]
 *      link "View Jane Cooper (jane@example.com)" [ref=e54] [cursor=pointer]
 *
 *  It does NOT expose `data-testid` attributes — only role, accessible name,
 *  and ref. Our earlier `findRefForTestId` scanned for the testid string and
 *  never found a match on a real snapshot (6b-hotfix live smoke). Case-
 *  insensitive substring matching on the captured name lets callers pass
 *  either an exact accessible name ("Email") or a distinguishing substring
 *  ("jane@example.com" against the disambiguated "View Jane Cooper (jane@…)").
 *
 *  Exported for unit testing; Week-2 skill cards will replace this regex
 *  parser with a proper YAML walker (role filters, state predicates, etc.). */
export function findRefByAccessibleName(
  snapshot: string,
  needle: string,
): string | null {
  return matchSnapshot(snapshot, needle, null);
}

/** Role-filtered variant. Needed on pages where the same accessible name
 *  appears on two different roles (e.g. the reset-password confirm page
 *  has a breadcrumb `link "Reset password"` AND a destructive
 *  `button "Reset password"` — plain `findRefByAccessibleName` returns the
 *  first match in YAML order, which is the link, not the button we want
 *  to click). Pass `role="button"` to filter. */
export function findRefForRole(
  snapshot: string,
  role: string,
  needle: string,
): string | null {
  return matchSnapshot(snapshot, needle, role.toLowerCase());
}

/** Extract the user-status text from a Playwright MCP snapshot of the
 *  test-webapp user-detail page. The status badge renders as a YAML row
 *  like `  - generic [ref=e53]: locked` — a `generic` element with a ref
 *  and the status word as its text content. Returns the matched word
 *  (`active` / `locked` / `suspended`) in lowercase, or `null` if no such
 *  line exists.
 *
 *  Exported for unit testing. Do NOT loosen this regex to match anywhere
 *  in the snapshot — Playwright MCP's root element always includes an
 *  `[active]` focus marker (e.g. `- generic [active] [ref=e1]:`) which a
 *  loose `/\b(active|…)\b/` would pick up as a false positive, as
 *  6c-1 re-smoke demonstrated. The anchoring below requires the status
 *  word to be the line's trailing text-content (after `: `), which the
 *  root's `[active]` marker can never be. */
export function extractUserStatus(snapshot: string): string | null {
  if (!snapshot) return null;
  const re = /^\s*-\s*generic\s*\[ref=[a-z0-9_-]+\]:\s*(active|locked|suspended)\s*$/im;
  const m = re.exec(snapshot);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Emit a compact multi-line diagnostic for the anomaly log: up to 5 lines
 *  from `snapshot` that contain `needle` (case-insensitive), joined by ` | `,
 *  with whitespace collapsed and each line capped at 120 chars. Used when a
 *  ref lookup fails so the reviewer UI shows exactly what the parser saw
 *  without needing to fish the full snapshot out of postgres. */
function extractLinesMatching(snapshot: string, needle: string): string {
  if (!snapshot) return "(empty snapshot)";
  const needleLower = needle.toLowerCase();
  const matches: string[] = [];
  for (const line of snapshot.split("\n")) {
    if (!line.toLowerCase().includes(needleLower)) continue;
    const trimmed = line.trim().replace(/\s+/g, " ");
    matches.push(trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed);
    if (matches.length >= 5) break;
  }
  return matches.length === 0 ? `(no lines contain '${needle}')` : matches.join(" | ");
}

function matchSnapshot(
  snapshot: string,
  needle: string,
  roleFilter: string | null,
): string | null {
  if (!snapshot || !needle) return null;
  const needleLower = needle.toLowerCase();
  // Capture: 1 = role, 2 = accessible name, 3 = ref
  //
  // Lazy `.*?` between the quoted name and `[ref=...]` because a line may
  // carry multiple bracketed attributes before the ref token, e.g.:
  //     heading "Reset password for Jane" [level=1] [ref=e10]
  //     button "Sign in" [ref=e16] [cursor=pointer]
  //     link "View Jane (jane@example.com)" [ref=e21] [cursor=pointer]
  const lineRe = /^\s*(?:- )?(\S+)\s+"([^"]+)".*?\[ref=([a-z0-9_-]+)\]/i;
  for (const line of snapshot.split("\n")) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const role = (m[1] ?? "").toLowerCase();
    const name = (m[2] ?? "").toLowerCase();
    const ref = m[3];
    if (!ref) continue;
    if (roleFilter && role !== roleFilter) continue;
    if (name.includes(needleLower)) return ref;
  }
  return null;
}

/** Read an env value at call time without cycling through `../env.js`
 *  (avoids a test-time circular import when the workflow is tree-shaken
 *  into a smaller fixture). The actual validated value is populated by the
 *  `env.ts` singleton on process boot; this is just a thin typed getter.
 *  Keys that env.ts supplies a default for (TEST_WEBAPP_URL, TARGET_APP_*)
 *  will always be set by the time any step runs. */
function env(
  key:
    | "SHARED_RUNBOOKS_UUID"
    | "SHARED_SKILLS_UUID"
    | "SHARED_SELECTORS_UUID"
    | "TEST_WEBAPP_URL"
    | "TARGET_APP_USER"
    | "TARGET_APP_PASSWORD",
): string {
  const v = process.env[key];
  if (!v) {
    // Shouldn't happen — env.ts already validated at boot. Defensive.
    throw new Error(`[triage] missing ${key} at runtime`);
  }
  return v;
}
