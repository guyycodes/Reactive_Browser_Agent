import { z } from "zod";

/**
 * Event envelope — the single wire format for the agent's WebSocket stream.
 *
 * Design notes
 * ------------
 * 1. Every frame carries a small header (`v`, `runId`, `seq`, `ts`, `stepId`)
 *    plus a `type` discriminator that selects the payload shape.
 *
 * 2. `seq` semantics:
 *    - `number` (0, 1, 2, ...) for ordered timeline frames that belong to the
 *      replayable sequence for this run. Monotonic per-run.
 *    - `null` for transport-control frames (heartbeat, resync) that are NOT
 *      part of the replayable sequence. A client MUST NOT treat a null-seq
 *      frame as a gap when gap-detecting over `seq`.
 *
 * 3. Frame-size guard: `MAX_FRAME_BYTES` (16 KiB) is enforced by
 *    `frameSchema.superRefine`. Binary artifacts (screenshots, videos) and
 *    large structured payloads (full plans, long RAG hits) never ride on the
 *    wire — they are persisted to disk / Postgres and the frame carries a
 *    reference (e.g. `path`, `blobRef`). This keeps the WebSocket reactive
 *    and makes per-frame parse cost predictable.
 *
 * 4. Stream mappers (e.g. Anthropic SSE → envelope in Commit 2) MUST
 *    proactively chunk large deltas at the emission site so the guard never
 *    trips on legitimate streaming content. The guard is a safety net, not a
 *    routine code path.
 */

export const ENVELOPE_VERSION = 1 as const;

export const MAX_FRAME_BYTES = 16 * 1024; // 16 KiB

/** Workflow steps from MASTER_PLAN §4 plus "agent" for pre/post-workflow frames. */
export const StepIdSchema = z.enum([
  "agent",
  "classify",
  "retrieve",
  "plan",
  "dry_run",
  "review_gate",
  "execute",
  "verify",
  // Commit 7b.iii.b — second human gate, post-execution. The workflow
  // emits `review.requested` twice per happy-path run: once with
  // stepId="review_gate" (pre-execution, asks "does this plan look
  // right?") and once with stepId="human_verify_gate" (post-execution,
  // asks "did the actual execution achieve the goal?"). On reject here,
  // humanVerifyGateStep emits `block.backtrack.triggered` and re-enters
  // the full pipeline from Block 1 with observations carried forward.
  // MAX_BACKTRACKS=2 caps the outer loop (see triage.ts).
  "human_verify_gate",
  "log_and_notify",
  // Commit 7b.iii.a — Block 1 iteration controller wraps the pre-gate
  // steps (classify / retrieve / plan / dry_run) in a pass loop. The
  // inner 4 steps continue to emit their step.* frames under their
  // ORIGINAL stepIds via the ambient bus; "block1" is used only for
  // the outer Mastra step wrapper's own step.* frames and the
  // block.iteration.* frames. The reviewer UI's LEFT column remains
  // keyed on the original 8 stepIds; block-level frames render
  // exclusively in the RIGHT feed as iteration dividers. See
  // src/mastra/lib/blockController.ts for the design invariant.
  "block1",
]);
export type StepId = z.infer<typeof StepIdSchema>;

/** 7b.iii.b — Subset of StepId that can be the target of a human
 *  review decision on the wire. Pre-exec `review_gate` + post-exec
 *  `human_verify_gate`. Single source of truth for the WS client
 *  frame (`clientFrameSchema`), the HTTP review body
 *  (`src/http/runs.ts:reviewBodySchema`), and the bus's public
 *  per-stepId API call sites. Week-3 may extend with skill-card
 *  authorization gates; keep additions narrow so a mis-targeted
 *  decision can't open a never-awaited StepGateState in the bus. */
export const GateStepIdSchema = z.enum([
  "review_gate",
  "human_verify_gate",
]);
export type GateStepId = z.infer<typeof GateStepIdSchema>;

/** Shared header. `seq` is narrowed to `number` on timeline frames and
 *  `null` on transport frames in the per-type schemas below. */
const baseHeader = z.object({
  v: z.literal(ENVELOPE_VERSION),
  runId: z.string().uuid(),
  ts: z.string().datetime({ offset: true }),
  stepId: StepIdSchema,
});

const seqNumber = z.number().int().nonnegative();

/** Maximum `iteration` number accepted on react.iteration.* frames.
 *  Envelope-level safeguard against runaway ReAct runners — the
 *  `createReActStep` runner caps at `maxIterations` (default 3) but we
 *  guard in the schema too so a pathological emitter can't ship
 *  `iteration: 10000` past frameSchema validation. 20 is generously
 *  above any realistic loop budget. */
const REACT_ITERATION_MAX = 20;

/** ---------- Payload fragments ---------- */

const TicketSummarySchema = z.object({
  ticketId: z.string().min(1),
  subject: z.string().min(1).max(500),
  submittedBy: z.string().min(1).optional(),
});

const RunSummarySchema = z.object({
  durationMs: z.number().int().nonnegative(),
  stepsExecuted: z.array(StepIdSchema),
  costUsd: z.number().nonnegative().optional(),
});

const PlanSummarySchema = z.object({
  planId: z.string().uuid(),
  actionCount: z.number().int().nonnegative(),
  destructive: z.boolean(),
  skillCardIds: z.array(z.string()),
});

const PlanPatchSchema = z.object({
  removeActionIds: z.array(z.string()).optional(),
  addAfterActionId: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

const ErrorPayload = z.object({
  message: z.string().min(1),
  stack: z.string().optional(),
  where: z.string().optional(),
});

const RagHitSchema = z.object({
  chunkId: z.union([z.string(), z.number()]),
  score: z.number(),
  // Preview cap — 400 chars. Wire-format cap for the rag.retrieved
  // envelope frame; feeds the reviewer UI's rag-hit rows in the
  // behavior feed where 400 chars is plenty for a "what did RAG return
  // at a glance?" scan. Full text lives in Postgres for audit.
  //
  // Intentionally ASYMMETRIC with the workflow-internal RagHitSummarySchema
  // (2000 chars) in src/mastra/workflows/triage.ts: that schema feeds
  // planStep's Sonnet prompt, where runbook procedural text needs more
  // room than a UI summary. 7b.ii-hotfix-1 smoke surfaced the tight cap
  // here being plenty for reviewer display while 400 chars at planStep
  // cut procedures mid-sentence. Caps differ by role; each is
  // documented at its own definition.
  preview: z.string().max(400),
  source: z.string(),
});

/** ---------- Frame variants ---------- */

// Timeline (seq: number)
//
// `reactIterationId` (optional, Commit 7b.ii): set by the ReAct runner
// (`src/mastra/lib/reactRunner.ts`) on every timeline frame emitted inside
// one of its iterations. The reviewer UI (`behavior-feed`) reads this to
// nest matching frames under a `react.iteration.*` divider visually.
// Existing emitters (Commits 2 / 5b / 6b / 7a.iv) don't set it and don't
// need to — it's optional everywhere. Transport frames (heartbeat /
// resync) extend `baseHeader` directly, not `timelineHeader`, so they
// can't carry this field (correctly, since they aren't scoped to a
// workflow step let alone a ReAct iteration).
const timelineHeader = baseHeader.extend({
  seq: seqNumber,
  reactIterationId: z.string().uuid().optional(),
});

const RunStartedFrame = timelineHeader.extend({
  type: z.literal("run.started"),
  ticket: TicketSummarySchema,
});

const RunCompletedFrame = timelineHeader.extend({
  type: z.literal("run.completed"),
  status: z.enum(["ok", "failed", "rejected"]),
  summary: RunSummarySchema,
});

const RunFailedFrame = timelineHeader.extend({
  type: z.literal("run.failed"),
  error: ErrorPayload,
});

const StepStartedFrame = timelineHeader.extend({
  type: z.literal("step.started"),
  input: z.unknown().optional(),
});

const StepCompletedFrame = timelineHeader.extend({
  type: z.literal("step.completed"),
  output: z.unknown().optional(),
  durationMs: z.number().int().nonnegative(),
});

const StepFailedFrame = timelineHeader.extend({
  type: z.literal("step.failed"),
  error: ErrorPayload,
});

const LlmMessageStartedFrame = timelineHeader.extend({
  type: z.literal("llm.message.started"),
  model: z.enum(["haiku", "sonnet", "opus"]),
  thinkingEnabled: z.boolean(),
});

const LlmThinkingDeltaFrame = timelineHeader.extend({
  type: z.literal("llm.thinking.delta"),
  text: z.string(),
});

const LlmTextDeltaFrame = timelineHeader.extend({
  type: z.literal("llm.text.delta"),
  text: z.string(),
});

const LlmToolUseStartedFrame = timelineHeader.extend({
  type: z.literal("llm.tool_use.started"),
  toolUseId: z.string().min(1),
  name: z.string().min(1),
});

const LlmToolUseDeltaFrame = timelineHeader.extend({
  type: z.literal("llm.tool_use.delta"),
  toolUseId: z.string().min(1),
  inputJsonDelta: z.string(),
});

const LlmToolUseCompletedFrame = timelineHeader.extend({
  type: z.literal("llm.tool_use.completed"),
  toolUseId: z.string().min(1),
  input: z.unknown(),
});

const LlmMessageCompletedFrame = timelineHeader.extend({
  type: z.literal("llm.message.completed"),
  stopReason: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative().optional(),
  }),
});

const ToolStartedFrame = timelineHeader.extend({
  type: z.literal("tool.started"),
  invocationId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional(),
});

const ToolCompletedFrame = timelineHeader.extend({
  type: z.literal("tool.completed"),
  invocationId: z.string().min(1),
  name: z.string().min(1),
  resultSummary: z.unknown().optional(),
  durationMs: z.number().int().nonnegative(),
});

const ToolFailedFrame = timelineHeader.extend({
  type: z.literal("tool.failed"),
  invocationId: z.string().min(1),
  name: z.string().min(1),
  error: ErrorPayload,
});

const BrowserNavFrame = timelineHeader.extend({
  type: z.literal("browser.nav"),
  url: z.string().url(),
  title: z.string().optional(),
});

const BrowserScreenshotFrame = timelineHeader.extend({
  type: z.literal("browser.screenshot"),
  path: z.string().min(1), // relative to playwright-videos volume
  label: z.string().min(1),
});

const BrowserConsoleFrame = timelineHeader.extend({
  type: z.literal("browser.console"),
  level: z.enum(["log", "warn", "error"]),
  text: z.string().max(2000),
});

const RagRetrievedFrame = timelineHeader.extend({
  type: z.literal("rag.retrieved"),
  collection: z.string().uuid(),
  query: z.string().max(500),
  hits: z.array(RagHitSchema).max(10), // cap to keep frame bounded
});

/** 7b.iii.a — emitted on `review.requested` when the Block 1 controller
 *  exhausted its passes without producing a viable plan, so the
 *  reviewer UI can render a distinct "exhausted" banner and disable
 *  the approve button. Absent on happy-path review.requested frames. */
const BlockResultSchema = z.object({
  passes: z.number().int().min(1).max(10),
  passedLast: z.boolean(),
  allReasons: z
    .array(
      z.enum([
        "exit_signal_ok",
        "plan_requires_context",
        "plan_empty_actions",
        "dry_run_mismatch",
        "max_iterations",
      ]),
    )
    .max(10),
});

const ReviewRequestedFrame = timelineHeader.extend({
  type: z.literal("review.requested"),
  plan: PlanSummarySchema,
  screenshots: z.array(z.string()).max(20), // path references only
  viewerUrl: z.string().url(),
  requiresApproval: z.literal(true),
  /** 7b.iii.a — present when the Block 1 controller exhausted its
   *  passes. On happy-path review.requested frames this field is
   *  absent, so existing reviewer UI code that doesn't know about it
   *  stays source-compatible. */
  blockResult: BlockResultSchema.optional(),
  /** 7b.iii.b — hints which human-gate phase this frame belongs to so
   *  the reviewer UI can render copy appropriate to the question being
   *  asked. Pre-exec ("does this plan look right?") shows plan text +
   *  dry_run screenshots inline; post-exec ("did execution achieve the
   *  goal?") points the reviewer at the behavior-feed's execute:*
   *  screenshots as the primary evidence surface.
   *
   *  For 7b.iii.b the post-exec panel does NOT embed screenshots
   *  directly (VerifySchema.evidence is text, not paths; plumbing
   *  paths through ExecuteSchema is deferred to Week 2 polish).
   *  Instead the panel tells the reviewer to scroll the feed above.
   *  This field is discriminated by `stepId` too — a UI that ignores
   *  `reviewHint` can fall back to `stepId === "human_verify_gate"`
   *  detection — but having it explicit avoids the UI having to
   *  depend on the stepId enum for semantic intent. */
  reviewHint: z.enum(["pre_exec", "post_exec"]).optional(),
});

const ReviewDecidedFrame = timelineHeader.extend({
  type: z.literal("review.decided"),
  // Week-2a gate-decision-model — 4-decision HIL semantics:
  //   approve   — "proceed with this plan" → execute → verify → post-exec
  //   reject    — "this plan is wrong, try again (no specific guidance)"
  //               → pre-exec: enters refine loop with auto-generated
  //               seed observation; post-exec: triggers backtrack loop
  //   edit      — "this plan is wrong, here's HOW to try again"
  //               → refine loop with reviewer's patch.notes threaded in
  //               (pre-exec only; post-exec treats edit ≡ approve per
  //               the humanVerifyGateStep wedge-prevention docblock)
  //   terminate — "stop this run entirely, don't replan"
  //               → skip cascade (executeStep.skipped → verifyStep
  //               .skipped → logAndNotifyStep status=rejected); the
  //               same proven mechanism today's pre-exec "reject"
  //               used pre-week2a (repurposed under the clearer name).
  decision: z.enum(["approve", "reject", "edit", "terminate"]),
  by: z.string().min(1),
  at: z.string().datetime({ offset: true }),
  patch: PlanPatchSchema.optional(),
});

// Backtrack trigger (Commit 7b.iii.b).
//
// Emitted by humanVerifyGateStep on post-exec reject, before the
// pipeline re-enters Block 1 with observations carried forward.
// `backtrackCount` is 1-indexed: first backtrack is 1, hard-capped at
// 5 in the schema (controller caps at MAX_BACKTRACKS=2 in practice).
// The envelope cap is higher than the runtime cap so a future op-time
// override of MAX_BACKTRACKS has schema headroom without needing a
// wire-contract revision.
const BlockBacktrackTriggeredFrame = timelineHeader.extend({
  type: z.literal("block.backtrack.triggered"),
  /** Where the backtrack was triggered from. Always "human_verify_gate"
   *  in 7b.iii.b; future extensions (Week-3 skill-card policy
   *  rollback) could add "execute" or "verify". */
  fromStep: StepIdSchema,
  /** Where the flow re-enters. Only block1 exists today; kept as an
   *  enum-of-one so a future second block doesn't need an envelope
   *  contract revision. */
  toBlock: z.enum(["block1"]),
  /** Observations synthesized from the rejected execute/verify output
   *  (plus the human's decision reasoning if present on the
   *  review.decided frame). Fed into the next pipeline iteration's
   *  classify/retrieve/plan prompts via RunContext.priorObservations.
   *  Bounded (12 × 400 chars) so runaway backtracks can't bloat the
   *  envelope. */
  carriedContext: z.array(z.string().max(400)).max(12),
  /** 1-indexed pipeline-level backtrack counter for this run. Used by
   *  the reviewer UI to render "BACKTRACK #1" / "#2" banners. */
  backtrackCount: z.number().int().min(1).max(5),
});

// Block 1 iteration brackets (Commit 7b.iii.a).
//
// Emitted by `runBlock1` in `src/mastra/lib/blockController.ts` at the
// start and end of each pass (think → classify → retrieve → plan →
// dry_run). The controller wraps its 4 inner pre-gate steps in a loop;
// each pass emits one started/completed pair. The reviewer UI renders
// these as larger dividers in the right feed — nested OUTSIDE the
// per-step frames, one level above the ReAct iteration dividers from
// 7b.ii.
//
// `iteration` is 0-indexed and capped at 10 as an envelope-level
// runaway safeguard; the controller's own BLOCK1_MAX_PASSES const
// caps at 3 in practice.
const BlockIterationStartedFrame = timelineHeader.extend({
  type: z.literal("block.iteration.started"),
  blockId: z.enum(["block1"]),
  iteration: z.number().int().min(0).max(10),
});

const BlockIterationCompletedFrame = timelineHeader.extend({
  type: z.literal("block.iteration.completed"),
  blockId: z.enum(["block1"]),
  iteration: z.number().int().min(0).max(10),
  /** True if this pass's exit signal satisfied
   *  (`!requiresContext && actions.length > 0 && dryRun.domMatches`).
   *  Block 1 emits review.requested on the next tick. False if
   *  backtracking to a new pass OR if we hit max passes (in which
   *  case Block 1 still emits review.requested but with a populated
   *  `blockResult` field so the UI can show the exhausted banner). */
  passed: z.boolean(),
  reason: z.enum([
    "exit_signal_ok",
    "plan_requires_context",
    "plan_empty_actions",
    "dry_run_mismatch",
    "max_iterations",
  ]),
  observationSummary: z.string().max(400).optional(),
});

// ReAct iteration brackets (Commit 7b.ii).
//
// Emitted by `createReActStep` in `src/mastra/lib/reactRunner.ts` at the
// start and end of each think → tool → observe iteration inside a
// ReAct-ified step. `reactRunId` groups iterations belonging to one
// runner invocation (allows future multi-runner steps if we ever
// compose them). `iteration` is 0-indexed and capped at
// `REACT_ITERATION_MAX` as an envelope-level runaway safeguard
// independent of the runner's own `maxIterations` cap.
//
// Every `llm.*` / `tool.*` / `rag.retrieved` / `browser.*` frame emitted
// between the opening and closing iteration frame carries the matching
// `reactIterationId` (set on the `timelineHeader` above) so the reviewer
// UI can nest them visually.
const ReactIterationStartedFrame = timelineHeader.extend({
  type: z.literal("react.iteration.started"),
  reactRunId: z.string().uuid(),
  iteration: z.number().int().min(0).max(REACT_ITERATION_MAX),
});

const ReactIterationCompletedFrame = timelineHeader.extend({
  type: z.literal("react.iteration.completed"),
  reactRunId: z.string().uuid(),
  iteration: z.number().int().min(0).max(REACT_ITERATION_MAX),
  /** True if this iteration was the runner's terminal one (either the
   *  model produced text-only output or we hit `maxIterations`). */
  final: z.boolean(),
  /** Tool invoked this iteration, if any. Matches `ReactTool.name`. */
  toolUsed: z.string().min(1).max(64).optional(),
  /** Short human-readable summary for the feed; bounded so a misbehaving
   *  tool's output can't blow past MAX_FRAME_BYTES via this field. */
  observationSummary: z.string().max(400).optional(),
});

// Transport-control (seq: null)
const transportHeader = baseHeader.extend({ seq: z.null() });

const HeartbeatFrame = transportHeader.extend({
  type: z.literal("heartbeat"),
});

const ResyncFrame = transportHeader.extend({
  type: z.literal("resync"),
  reason: z.enum(["buffer_overflow", "client_requested"]),
});

/** ---------- Discriminated union ---------- */

const TimelineFrameSchemas = [
  RunStartedFrame,
  RunCompletedFrame,
  RunFailedFrame,
  StepStartedFrame,
  StepCompletedFrame,
  StepFailedFrame,
  LlmMessageStartedFrame,
  LlmThinkingDeltaFrame,
  LlmTextDeltaFrame,
  LlmToolUseStartedFrame,
  LlmToolUseDeltaFrame,
  LlmToolUseCompletedFrame,
  LlmMessageCompletedFrame,
  ToolStartedFrame,
  ToolCompletedFrame,
  ToolFailedFrame,
  BrowserNavFrame,
  BrowserScreenshotFrame,
  BrowserConsoleFrame,
  RagRetrievedFrame,
  ReviewRequestedFrame,
  ReviewDecidedFrame,
  ReactIterationStartedFrame,
  ReactIterationCompletedFrame,
  BlockIterationStartedFrame,
  BlockIterationCompletedFrame,
  BlockBacktrackTriggeredFrame,
] as const;

const TransportFrameSchemas = [HeartbeatFrame, ResyncFrame] as const;

const untypedFrameSchema = z.discriminatedUnion("type", [
  ...TimelineFrameSchemas,
  ...TransportFrameSchemas,
]);

/** Runtime byte-size guard. Enforced on publish via `frameSchema.safeParse`. */
export const frameSchema = untypedFrameSchema.superRefine((frame, ctx) => {
  // Serialise once; callers should re-use this stringify when shipping to WS
  // clients (we re-stringify on the hot path for now; optimise later if the
  // profile shows it).
  const size = Buffer.byteLength(JSON.stringify(frame), "utf8");
  if (size > MAX_FRAME_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `Frame of type '${frame.type}' is ${size} bytes, exceeds MAX_FRAME_BYTES=${MAX_FRAME_BYTES}. ` +
        `Emitters MUST chunk large payloads at the source; binary artifacts MUST be written to disk and referenced by path.`,
    });
  }
});

export type Frame = z.infer<typeof untypedFrameSchema>;
export type TimelineFrame = Extract<Frame, { seq: number }>;
export type TransportFrame = Extract<Frame, { seq: null }>;
export type FrameType = Frame["type"];

/**
 * Distributive `Omit` — applies `Omit<T, K>` to each variant of a union
 * independently, preserving the discriminated-union shape.
 *
 * Why we need this: the built-in `Omit<Union, K>` is non-distributive — it
 * unifies the union into its common base first, so on a discriminated union
 * it strips every field except the shared discriminator. Call sites that
 * construct a frame payload with variant-specific fields (e.g. `ticket` on
 * `run.started`, `reason` on `resync`) would then fail to typecheck because
 * those fields are no longer known on the erased shape.
 */
export type DistributivelyOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Payload-only shape (the caller does not provide `v`/`runId`/`seq`/`ts`/`stepId`;
 *  the bus fills them in). One branch per timeline frame variant. */
export type TimelineFramePayload = DistributivelyOmit<
  TimelineFrame,
  "v" | "runId" | "seq" | "ts" | "stepId"
>;

/** Payload-only shape for transport (seq-null) frames. */
export type TransportFramePayload = DistributivelyOmit<
  TransportFrame,
  "v" | "runId" | "seq" | "ts" | "stepId"
>;

/** Client → Server frames. Received on the WS from reviewers / clients. */
export const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    runId: z.string().uuid(),
    resumeSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("review.decide"),
    /** 7b.iii.b — which gate's slot this decision targets. Optional
     *  for back-compat; server defaults to "review_gate" so pre-
     *  7b.iii.b clients keep working unchanged. Narrow enum
     *  (`GateStepIdSchema`) so the bus can't be pushed to open a
     *  gate slot for a non-gate stepId. */
    stepId: GateStepIdSchema.optional(),
    // Week-2a gate-decision-model — 4-decision HIL semantics.
    // Mirrors ReviewDecidedFrame.decision above (server's outbound
    // enum); kept in lockstep so a decision the client sends is
    // never a value the server couldn't emit.
    decision: z.enum(["approve", "reject", "edit", "terminate"]),
    patch: PlanPatchSchema.optional(),
    idempotencyKey: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("ping"),
  }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

/** Helper: is this a timeline frame (seq: number)? */
export function isTimelineFrame(frame: Frame): frame is TimelineFrame {
  return frame.seq !== null;
}
