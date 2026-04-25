"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";

/**
 * Reviewer UI — Commit 7a.ii (behavior-feed rail refactor, IA pass 1).
 *
 * The page is a two-column grid, always:
 *
 *   LEFT  .review-outcomes-col : one compact <StepOutcome> row per
 *         workflow step, distilled from step.completed.output. Shows
 *         what each step decided, not how it got there.
 *
 *   RIGHT .review-feed-col     : a chronological behavior feed
 *         (<BehaviorFeed>) rendering every llm.*, tool.*, rag.retrieved
 *         and browser.* frame in arrival order, with inline step
 *         dividers. Sticky to viewport; auto-scrolls to bottom with a
 *         stick-to-bottom gesture (user scroll-up pauses auto-scroll
 *         for 3s, then resumes).
 *
 * The review panel (Approve/Reject) lives outside the grid, sticky at
 * the container bottom, full-width — the "big decision" surface isn't
 * a column.
 *
 * Absorbs 7a.i: the single-image rail is replaced by inline 320×180
 * feed thumbnails. Zero agent-side changes, zero envelope changes.
 */

const STEP_IDS = [
  "classify",
  "retrieve",
  "plan",
  "dry_run",
  "review_gate",
  // week2d Part 4 — 10-step workflow. Inserted between review_gate
  // (approve) and execute. Renders LEFT-column <StepOutcome> row
  // with materialized skill convention name + divergence chip.
  "materialize_skill_card",
  "execute",
  "verify",
  "log_and_notify",
] as const;

// Commit 7b.iii.a — StepId type also accepts "block1" for frames the
// Block 1 controller emits (step.* + block.iteration.*). The LEFT
// outcomes column iterates over STEP_IDS (the 8 visible workflow
// steps) and explicitly does NOT include block1 — so block1's
// step.started/completed frames never render as a LEFT-column row.
// block.iteration.* frames render only in the RIGHT feed as
// FeedBlockDividerView items. Per the invariant in blockController.ts.
//
// Week-2a ux-polish — "human_verify_gate" added to the type union
// (but NOT to STEP_IDS; there's no LEFT-column row for it — the
// post-exec gate's decision surface is the ChatBar, not a step card).
// Inclusion here is required so STEP_LABELS' Record<StepId, string>
// can carry the display label for RIGHT-column feed dividers on
// human_verify_gate frames (fixes the UNDEFINED · XXXXMS bug surfaced
// during P3 smoke).
type StepId = (typeof STEP_IDS)[number] | "agent" | "block1" | "human_verify_gate";
type StepStatus = "pending" | "running" | "awaiting" | "completed" | "failed";

interface Frame {
  v: 1;
  runId: string;
  seq: number | null;
  ts: string;
  stepId: StepId;
  type: string;
  [k: string]: unknown;
}

/** 7b.iii.b-pre-exec-edit-ui — narrowed shape for review.requested
 *  frames. All timeline frames carry `stepId` (from baseHeader on the
 *  agent's envelope), so the existing `stepId: StepId` field on
 *  `Frame` is always populated on review.requested. This alias
 *  exposes the review-specific payload fields typed instead of
 *  leaking the `[k: string]: unknown` index signature at call sites. */
type ReviewRequestedFrame = Frame & {
  type: "review.requested";
  plan: {
    planId: string;
    actionCount?: number;
    destructive?: boolean;
    skillCardIds?: string[];
  };
  screenshots?: string[];
  viewerUrl?: string;
  requiresApproval?: boolean;
  blockResult?: {
    passes?: number;
    passedLast?: boolean;
    allReasons?: string[];
  };
  reviewHint?: "pre_exec" | "post_exec";
};

/** 7b.iii.b-pre-exec-edit-ui — max chars for reviewer edit notes.
 *  Matches the agent-side PlanPatchSchema.notes cap so client-side
 *  validation gives immediate feedback instead of bouncing off the
 *  wire. */
const REVIEW_EDIT_NOTES_MAX = 2000;

/** 7b.iii.b commit 4 — display-only mirror of the agent-side
 *  MAX_BACKTRACKS const (src/mastra/workflows/triage.ts). Shown in
 *  post-exec panel copy so reviewer knows the retry ceiling.
 *  Out-of-sync would be a minor copy issue, not a gate-enforcement
 *  issue (the gate itself enforces via the agent const). */
const MAX_BACKTRACKS_UI = 2;

/** Week-2a gate-decision-model — the set of review decisions that
 *  DO NOT close the gate (they trigger a refine / backtrack that
 *  emits a fresh review.requested). Used by the pendingReview memo
 *  below to decide whether a `review.decided` frame should unmount
 *  the ChatBar's decision-required mode or keep it open waiting
 *  for the next fresh gate.
 *
 *  Decisions that close the gate (and therefore are NOT in this set):
 *    - approve   — flows to execute / verify / post-exec
 *    - terminate — skip cascade to run.completed{status=rejected}
 *
 *  Module-scope (not inside the memo's closure) for referential
 *  stability across re-renders. Adding a future 5th decision
 *  variant? One-line edit to this set. */
const REFINE_TRIGGERS: ReadonlySet<string> = new Set(["reject", "edit"]);

/** Week-2a gate-decision-model — Terminate confirmation window.
 *  Single click on the Terminate link arms a pending state; second
 *  click within TERMINATE_CONFIRM_MS commits. Matches the project's
 *  3_000 idle-gesture convention (stick-to-bottom autoscroll grace,
 *  active-step autoscroll grace). Cleanup via useEffect return. */
const TERMINATE_CONFIRM_MS = 3_000;

type ConnStatus = "connecting" | "open" | "closed" | "error";

const STEP_LABELS: Record<StepId, string> = {
  agent: "agent",
  classify: "classify",
  retrieve: "retrieve",
  plan: "plan",
  dry_run: "dry_run",
  review_gate: "review_gate",
  execute: "execute",
  verify: "verify",
  // Week-2a ux-polish — missing entry caused "UNDEFINED · XXXXMS" in
  // RIGHT-column step dividers on every post-exec run (the envelope
  // schema added human_verify_gate to StepIdSchema in 7b.iii.b
  // commit 4, but this map was never extended). Snake-case matches
  // the other multi-word stepIds (review_gate / dry_run /
  // log_and_notify) so SQL queries + smoke-recipe references line up.
  human_verify_gate: "human_verify_gate",
  log_and_notify: "log_and_notify",
  block1: "block 1",
  // week2d Part 4 — snake_case matches the other multi-word step
  // ids for SQL + smoke-recipe consistency.
  materialize_skill_card: "materialize",
};

export default function ReviewPage() {
  const params = useParams<{ runId: string }>();
  const runId = params?.runId ?? "";

  const [frames, setFrames] = useState<Frame[]>([]);
  const [connStatus, setConnStatus] = useState<ConnStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);

  // Commit 7a.iii — resizable-divider state.
  // Default 42%; clamped [20, 80]. Initialized lazy to the default and
  // hydrated from localStorage in a mount effect (not in useState's lazy
  // initializer) so the server-pre-render and first client render agree
  // on the default — avoids a hydration warning when the saved ratio
  // differs from the default.
  const [leftPct, setLeftPct] = useState<number>(42);

  const wsRef = useRef<WebSocket | null>(null);
  const didHelloRef = useRef(false);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("reviewLeftPct"));
      if (Number.isFinite(saved) && saved >= 20 && saved <= 80) {
        setLeftPct(saved);
      }
    } catch {
      /* localStorage unavailable (private mode, sandbox) — stay at default */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("reviewLeftPct", String(leftPct));
    } catch {
      /* ignore */
    }
  }, [leftPct]);

  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const divider = e.currentTarget;
      const layout = divider.parentElement as HTMLElement | null;
      if (!layout) return;
      divider.setPointerCapture(e.pointerId);
      const rect = layout.getBoundingClientRect();
      const onMove = (ev: PointerEvent) => {
        const x = ev.clientX - rect.left;
        const pct = Math.max(20, Math.min(80, (x / rect.width) * 100));
        setLeftPct(pct);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        try {
          divider.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore — capture may have been released already */
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  const onDividerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setLeftPct((p) => Math.max(20, p - 2));
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setLeftPct((p) => Math.min(80, p + 2));
      }
    },
    [],
  );

  // Commit 7a.v — active-step autoscroll in the LEFT outcomes column.
  //
  // The "active" step is the one whose step.started was most recently
  // emitted; as the workflow progresses, we want its outcome row to be
  // visible in the column even if the reviewer scrolled elsewhere.
  //
  // Mirrors the feed's "stuck-to-bottom + 3s idle" idiom but scoped to the
  // outcomes column with its own state:
  //   - outcomeRefs[stepId] → element ref (populated by StepOutcome via
  //     callback ref prop).
  //   - lastOutcomesInteractionAt ref tracks user-initiated scrolls only.
  //   - programmaticOutcomesScroll ref suppresses the onScroll handler
  //     while our own scrollIntoView fires, so we don't self-cancel the
  //     next auto-scroll. Cleared via setTimeout(0) — the scroll event
  //     has fired synchronously by then.
  //   - prevActiveStepRef ensures we only scroll on step transitions, not
  //     every render.
  const outcomeRefs = useRef<Partial<Record<StepId, HTMLElement | null>>>({});
  const lastOutcomesInteractionAt = useRef<number>(0);
  const programmaticOutcomesScroll = useRef<boolean>(false);
  const prevActiveStepRef = useRef<StepId | null>(null);

  const activeStepId = useMemo<StepId | null>(() => {
    let current: StepId | null = null;
    for (const f of frames) {
      if (f.type === "step.started") current = f.stepId;
    }
    return current;
  }, [frames]);

  const onOutcomesScroll = useCallback(() => {
    if (programmaticOutcomesScroll.current) return;
    lastOutcomesInteractionAt.current = Date.now();
  }, []);

  useEffect(() => {
    if (activeStepId === prevActiveStepRef.current) return;
    prevActiveStepRef.current = activeStepId;
    if (!activeStepId) return;
    if (Date.now() - lastOutcomesInteractionAt.current < 3_000) return;
    const el = outcomeRefs.current[activeStepId];
    if (!el) return;
    programmaticOutcomesScroll.current = true;
    el.scrollIntoView({ block: "nearest", behavior: "auto" });
    setTimeout(() => {
      programmaticOutcomesScroll.current = false;
    }, 0);
  }, [activeStepId]);

  // --- WS lifecycle ---
  useEffect(() => {
    if (!runId) return;
    didHelloRef.current = false;
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname}:3001/stream/${runId}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnStatus("open");
      if (!didHelloRef.current) {
        ws.send(JSON.stringify({ type: "hello", runId }));
        didHelloRef.current = true;
      }
    };

    ws.onmessage = (evt) => {
      try {
        const frame = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data)) as Frame;
        setFrames((prev) => [...prev, frame]);
      } catch (e) {
        console.error("[reviewer] bad frame JSON", e);
      }
    };

    ws.onerror = () => {
      setConnStatus("error");
      setLastError("WebSocket error — check the agent service is reachable at :3001");
    };

    ws.onclose = () => {
      setConnStatus((s) => (s === "error" ? s : "closed"));
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [runId]);

  const byStep = useMemo(() => bucketByStep(frames), [frames]);
  const runStatus = useMemo(() => deriveRunStatus(frames), [frames]);

  // 7b.iii.b-pre-exec-edit-ui-hotfix-1 — pendingReview must
  // distinguish `edit` from `approve`/`reject`. A review.decided with
  // decision="edit" does NOT close the gate — it triggers a refine
  // which will emit a fresh review.requested. Before this fix, the
  // old form (`decisions.length >= reqs.length`) unmounted the panel
  // immediately on the edit ack frame, destroying the three-mode
  // state (submitting + Cancel-refine escape hatch) mid-flight.
  //
  // 7b.iii.b-pre-exec-edit-ui-hotfix-1-amend-1 — terminal guard
  // narrowed from `run.completed || run.failed` to `run.completed`
  // ONLY.
  //
  // `run.failed` fires from TWO sources in the current codebase:
  //   (1) bus.publishSyntheticFailure on envelope violations (e.g.,
  //       an oversize step.completed payload tripping
  //       MAX_FRAME_BYTES). The workflow keeps running; the frame
  //       is a wire-level diagnostic, not a terminus.
  //   (2) http/triage.ts catch on a caught workflow exception. In
  //       that path a subsequent `run.completed{status:"failed"}`
  //       is ALWAYS also emitted from the post-finally block, so
  //       `run.completed` remains the single correct terminator.
  // Conflating (1) with workflow termination closed the panel on
  // every envelope-violation frame, making every subsequent
  // review.requested unrenderable. Narrowing to `run.completed`
  // preserves the hotfix's intent (close on real terminus) while
  // excluding synthetic bus diagnostics.
  //
  // NOTE: the envelope violation itself (Bug 3A — stochastic
  // oversize step.completed payload on long-thinking plan steps) is
  // a separate defect out of scope for this amendment. Tracked for
  // follow-up: remove `thinking` from runPlanStep's step.completed
  // output (the thinking text is already streamed via
  // llm.thinking.delta; duplicating it in step.completed wastes
  // envelope budget).
  //
  // Logic:
  //   1. No review.requested → no gate pending. Return null.
  //   2. `run.completed` fired → gate is over regardless of decision
  //      counts. Critical for budget-exhaust: the 3rd edit commits
  //      to the wire as decision="edit" but the server internally
  //      converts it to a synthetic reject + emits
  //      run.completed{status:rejected}. Without this
  //      short-circuit, `lastIsEdit` stays true forever and the
  //      panel wedges.
  //   3. Last decision is edit AND no run.completed yet → panel
  //      stays mounted on the original request; ReviewPanel's own
  //      submittedAtPlanId logic holds submitting-mode until the
  //      fresh review.requested arrives.
  //   4. Otherwise close when decisions >= reqs (terminal decision
  //      matched every request).
  const pendingReview = useMemo<ReviewRequestedFrame | null>(() => {
    const reqs = frames.filter((f) => f.type === "review.requested");
    if (reqs.length === 0) return null;

    const isRunTerminal = frames.some((f) => f.type === "run.completed");
    if (isRunTerminal) return null;

    const decisions = frames.filter((f) => f.type === "review.decided");
    const lastDecision = decisions[decisions.length - 1] as
      | (Frame & { decision?: string })
      | undefined;

    // Week-2a gate-decision-model — set-based trigger check replaces
    // the prior single-value `lastIsEdit` conditional. Reject now
    // ALSO keeps the panel mounted (routes through the refine loop
    // → fresh review.requested with new planId), same as edit. The
    // REFINE_TRIGGERS module-scope set is the single source of
    // truth; add/remove decisions from it as the 4-decision model
    // evolves.
    const lastDecisionValue = lastDecision?.decision;
    const lastTriggersRefine =
      typeof lastDecisionValue === "string" &&
      REFINE_TRIGGERS.has(lastDecisionValue);

    if (!lastTriggersRefine && decisions.length >= reqs.length) return null;
    return (reqs[reqs.length - 1] as ReviewRequestedFrame) ?? null;
  }, [frames]);

  // 7b.iii.b-pre-exec-edit-ui — `decide` widens to support the edit
  // path. `opts.stepId` routes the decision to the correct bus slot
  // (commit 1's per-stepId decision API); defaults to "review_gate"
  // server-side when absent. `opts.notes` rides PlanPatchSchema.notes
  // on decision="edit" to trigger Block 1's pre-exec refine loop.
  //
  // Week-2a gate-decision-model — "terminate" added to the union
  // for the ChatBar's new Terminate affordance. Wire shape unchanged;
  // only the decision string widens.
  const decide = useCallback(
    (
      decision: "approve" | "reject" | "edit" | "terminate",
      opts?: { notes?: string; stepId?: string },
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg = {
        type: "review.decide" as const,
        decision,
        ...(opts?.stepId ? { stepId: opts.stepId } : {}),
        ...(decision === "edit" && opts?.notes
          ? { patch: { notes: opts.notes } }
          : {}),
        idempotencyKey:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
      ws.send(JSON.stringify(msg));
    },
    [],
  );

  return (
    <main className="review-page">
      <div className="header">
        <div className="header-meta">
          <h1>browser_agent · run</h1>
          <span className="run-id">{runId}</span>
        </div>
        <RunBadge status={runStatus} />
      </div>

      <ConnectionStrip status={connStatus} error={lastError} />

      <div
        className="review-layout"
        style={{ ["--left-pct" as string]: `${leftPct}%` } as React.CSSProperties}
      >
        <aside
          className="review-outcomes-col"
          role="region"
          aria-label="step outcomes"
        >
          {/*
            Week-2a — ChatBar UX refactor. The LEFT column becomes a
            flex-column with a scrollable inner div (StepOutcome rows)
            and a bottom-pinned ChatBar. The scroll handler + tabIndex
            move to the inner div (that's now the scrolling element);
            the aside remains the semantic region wrapper for a11y.
          */}
          <div
            className="review-outcomes-scroll"
            tabIndex={0}
            onScroll={onOutcomesScroll}
          >
            {STEP_IDS.map((id) => {
              const bucket = byStep.get(id) ?? { frames: [], status: "pending" as StepStatus };
              return (
                <StepOutcome
                  key={id}
                  stepId={id}
                  status={bucket.status}
                  frames={bucket.frames}
                  outcomeRef={(el) => {
                    outcomeRefs.current[id] = el;
                  }}
                />
              );
            })}
          </div>
          <ChatBar
            pendingReview={pendingReview}
            frames={frames}
            onDecide={decide}
            disabled={connStatus !== "open"}
          />
        </aside>
        <div
          className="review-divider"
          onPointerDown={onDividerPointerDown}
          onKeyDown={onDividerKeyDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          aria-valuenow={Math.round(leftPct)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          data-testid="review-divider"
        />
        <aside
          className="review-feed-col"
          role="region"
          aria-label="behavior feed"
          tabIndex={0}
        >
          <BehaviorFeed frames={frames} runId={runId} />
        </aside>
      </div>
    </main>
  );
}

/* ---------- ConnectionStrip + RunBadge (unchanged from 7a.i) ---------- */

function ConnectionStrip({ status, error }: { status: ConnStatus; error: string | null }) {
  const cls = status === "open" ? "ok" : status === "error" ? "err" : "";
  const text =
    status === "connecting"
      ? "connecting to agent at ws://…:3001"
      : status === "open"
        ? "connected · streaming"
        : status === "closed"
          ? "socket closed"
          : `error: ${error ?? "unknown"}`;
  return <div className={`conn-strip ${cls}`}>{text}</div>;
}

function RunBadge({ status }: { status: StepStatus | "ok" | "rejected" }) {
  const { cls, label } = (() => {
    switch (status) {
      case "ok":
        return { cls: "ok", label: "completed" };
      case "completed":
        return { cls: "ok", label: "completed" };
      case "failed":
        return { cls: "err", label: "failed" };
      case "rejected":
        return { cls: "warn", label: "rejected" };
      case "awaiting":
        return { cls: "warn", label: "awaiting review" };
      case "running":
        return { cls: "live", label: "running" };
      default:
        return { cls: "", label: "pending" };
    }
  })();
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ---------- Left column: StepOutcome ---------- */

function StepOutcome(props: {
  stepId: StepId;
  status: StepStatus;
  frames: Frame[];
  /** Commit 7a.v — callback ref for active-step autoscroll. Parent
   *  stores the element handle so a step.started transition can scroll
   *  the matching outcome row into view. */
  outcomeRef?: (el: HTMLElement | null) => void;
}) {
  const { stepId, status, frames, outcomeRef } = props;
  // 7b.iii.b commit 4 — read LATEST step.completed, not first. On
  // refine / backtrack runs, multiple step.completed frames land
  // for the same step (classify/retrieve/plan/dry_run re-run inside
  // runReviewGateStep's refine loop or humanVerifyGateStep's
  // backtrack loop; block1 gets synthetic step.completed emitted
  // around each refine/backtrack Block 1 invocation — see Piece B
  // in triage.ts). `.find` returned the initial frame; reviewer saw
  // stale plan data in LEFT column. `.findLast` reads the most
  // recent emission → LEFT column reflects the currently-pending
  // plan. Guarded by test/reviewGateRefine.test.ts [6] on the
  // agent-side (asserts the synthetic frames emit with refined
  // planId).
  const completed = frames.findLast((f) => f.type === "step.completed");
  const durationMs = completed ? Number(completed.durationMs ?? 0) : null;
  const output = (completed?.output ?? undefined) as Record<string, unknown> | undefined;

  const body = useMemo(() => {
    if (stepId === "review_gate") return renderReviewGateBody(frames);
    if (!output) return null;
    switch (stepId) {
      case "classify":       return renderClassifyBody(output);
      case "retrieve":       return renderRetrieveBody(output);
      case "plan":           return renderPlanBody(output);
      case "dry_run":        return renderDryRunBody(output);
      case "materialize_skill_card": return renderMaterializeBody(output);
      case "execute":        return renderExecuteBody(output);
      case "verify":         return renderVerifyBody(output);
      case "log_and_notify": return renderLogBody(output);
      default:               return null;
    }
  }, [stepId, output, frames]);

  return (
    <section
      ref={outcomeRef}
      className={`step-outcome ${status}`}
      data-step-id={stepId}
      data-testid={`outcome-${stepId}`}
    >
      <div className="step-outcome-head">
        <span className="dot" />
        <span className="label">{STEP_LABELS[stepId]}</span>
        <RunBadge status={status} />
        {durationMs !== null && <span className="dur">{durationMs}ms</span>}
      </div>
      {body && <div className="step-outcome-body">{body}</div>}
    </section>
  );
}

/* Per-step outcome body renderers — pure, read only from step.completed.output
 * (shapes are defined in services/agent/src/mastra/workflows/triage.ts). */

function renderClassifyBody(o: Record<string, unknown>): React.ReactNode {
  const category = String(o.category ?? "");
  const urgency = String(o.urgency ?? "");
  const confidence = typeof o.confidence === "number" ? o.confidence : null;
  const apps = Array.isArray(o.targetApps) ? (o.targetApps as unknown[]).map(String) : [];
  return (
    <>
      <span>
        {category || "—"} · {urgency || "—"}
        {confidence !== null ? ` · conf=${confidence.toFixed(2)}` : ""}
      </span>
      {apps.length > 0 && (
        <div className="dim">
          {apps.length} app{apps.length === 1 ? "" : "s"}: {apps.join(", ")}
        </div>
      )}
    </>
  );
}

function renderRetrieveBody(o: Record<string, unknown>): React.ReactNode {
  const runbook = Number(o.runbookHits ?? 0);
  const skill = Number(o.skillHits ?? 0);
  return (
    <span>
      {runbook} runbook hit{runbook === 1 ? "" : "s"} · {skill} skill hit{skill === 1 ? "" : "s"}
    </span>
  );
}

function renderPlanBody(o: Record<string, unknown>): React.ReactNode {
  const requiresContext = Boolean(o.requiresContext);
  const missingContext = Array.isArray(o.missingContext)
    ? (o.missingContext as unknown[]).map(String)
    : [];

  // Commit 7b.ii-hotfix — first-class "needs context" rendering.
  // Pre-hotfix, planStep's regex-over-prose heuristics would falsify
  // an N-step-plan count from any numbered list the model happened to
  // emit — including refusal text like "I need: 1. X, 2. Y, 3. Z".
  // The UI rendered "3-step plan · ⚠ destructive" for what was
  // objectively a refusal — a truth-invariant violation. Now the
  // refusal path has a dedicated visual state and authoritative
  // fields (`requiresContext`, `missingContext`) on PlanSchema.
  if (requiresContext) {
    return (
      <>
        <span>
          🟡 needs context
          {missingContext.length > 0
            ? `: ${short(missingContext.join("; "), 120)}`
            : ""}
        </span>
        {typeof o.planText === "string" && o.planText && (
          <PlanPreview text={String(o.planText)} />
        )}
      </>
    );
  }

  const actions = Number(o.actionCount ?? 0);
  const destructive = Boolean(o.destructive);
  const planText = String(o.planText ?? "");
  return (
    <>
      <span>
        {actions}-step plan{destructive ? " · ⚠ destructive" : ""}
      </span>
      {planText && <PlanPreview text={planText} />}
    </>
  );
}

/** week2d Part 4 — materialize_skill_card LEFT-column row.
 *
 *  Skill JSON shape (from MaterializeSchema in triage.ts):
 *    { skill: { name, steps[], ... },
 *      skillId: UUID,
 *      skillName: "<host>_<scaffold>_<uuid>",
 *      divergence: { expected, actual, reason } | null,
 *      ... }
 *
 *  Three visual states:
 *    - skipped sentinel (skill.name === "skipped") → dim one-liner
 *    - happy (divergence === null) → step count + truncated skillName
 *    - divergent (divergence !== null) → same + warn-yellow chip
 *      that's a button expanding to show expected/actual/reason. */
function renderMaterializeBody(o: Record<string, unknown>): React.ReactNode {
  const skill = (o.skill ?? {}) as Record<string, unknown>;
  const skillNameCard = String(skill.name ?? "");
  const convention = String(o.skillName ?? "");
  const steps = Array.isArray(skill.steps) ? (skill.steps as unknown[]) : [];
  const divergence = (o.divergence ?? null) as
    | { expected?: string; actual?: string; reason?: string }
    | null;

  // Skip-cascade sentinel — see MINIMAL_SKIPPED_SKILL in triage.ts.
  if (skillNameCard === "skipped") {
    return <span className="dim">(skipped — reviewer rejected/terminated)</span>;
  }

  const shortName = convention.length > 40
    ? `${convention.slice(0, 37)}…`
    : convention;

  return (
    <>
      <span>
        {steps.length} step{steps.length === 1 ? "" : "s"} · {skillNameCard || "—"}
      </span>
      {convention && (
        <div className="dim cell-mono" title={convention}>
          {shortName}
        </div>
      )}
      {divergence && (
        <div
          className="materialize-divergence-chip"
          data-testid="materialize-divergence-chip"
          title={`expected: ${divergence.expected ?? "—"} · actual: ${divergence.actual ?? "—"} · ${divergence.reason ?? ""}`}
        >
          ⚠ divergence: {short(String(divergence.actual ?? ""), 48)}
        </div>
      )}
    </>
  );
}

function renderDryRunBody(o: Record<string, unknown>): React.ReactNode {
  const domMatches = Boolean(o.domMatches);
  const anomalies = Array.isArray(o.anomalies) ? (o.anomalies as unknown[]) : [];
  return (
    <span>
      domMatches: {domMatches ? "✓" : "✗"}
      {anomalies.length > 0 ? ` · ${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"}` : ""}
    </span>
  );
}

function renderExecuteBody(o: Record<string, unknown>): React.ReactNode {
  const stepsRun = Number(o.stepsRun ?? 0);
  const skipped = Boolean(o.skipped);
  return (
    <span>
      {stepsRun} step{stepsRun === 1 ? "" : "s"} run{skipped ? " (skipped)" : ""}
    </span>
  );
}

function renderVerifyBody(o: Record<string, unknown>): React.ReactNode {
  const success = Boolean(o.success);
  const evidence = Array.isArray(o.evidence) ? (o.evidence as unknown[]) : [];
  const first = evidence.length > 0 ? String(evidence[0]) : "";
  return (
    <>
      <span>{success ? "✓ success" : "✗ failed"}</span>
      {first && <div className="dim">{short(first, 120)}</div>}
    </>
  );
}

function renderLogBody(o: Record<string, unknown>): React.ReactNode {
  const status = String(o.status ?? "");
  const note = String(o.note ?? "");
  return (
    <span>
      {status || "—"}
      {note ? ` · ${short(note, 100)}` : ""}
    </span>
  );
}

function renderReviewGateBody(frames: Frame[]): React.ReactNode {
  const decided = frames.find((f) => f.type === "review.decided") as
    | (Frame & { decision?: string; by?: string })
    | undefined;
  const requested = frames.find((f) => f.type === "review.requested");
  if (decided) return <span>{String(decided.decision)} by {String(decided.by ?? "?")}</span>;
  if (requested) return <span>awaiting reviewer</span>;
  return null;
}

function PlanPreview({ text }: { text: string }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <>
      <div className={`plan-preview ${collapsed ? "collapsed" : ""}`}>{text}</div>
      <button
        className="plan-preview-toggle"
        type="button"
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? "show full plan" : "collapse"}
      </button>
    </>
  );
}

/* ---------- Right column: BehaviorFeed ---------- */

type FeedBubble = {
  kind: "bubble";
  key: string;
  stepId: StepId;
  started: Frame;
  completed?: Frame;
  thinking: string;
  text: string;
  /** Commit 7b.ii — set when this bubble's frames were emitted inside
   *  a ReAct iteration. Used to visually nest the bubble under the
   *  iteration's divider in the feed. */
  iterationId?: string;
};

type FeedTool = {
  kind: "tool";
  key: string;
  stepId: StepId;
  started: Frame;
  completed?: Frame;
  failed?: Frame;
  hits: Frame[];
  iterationId?: string;
};

/** 7b.ii — ReAct iteration bracket. Rendered as a smaller, indented
 *  version of the step divider inside the feed. `phase: "start"` opens
 *  the bracket, `phase: "complete"` closes it (with optional
 *  observation summary + `final` flag). */
type FeedIterationDivider = {
  kind: "iterationDivider";
  key: string;
  stepId: StepId;
  phase: "start" | "complete";
  iteration: number;
  reactRunId: string;
  /** Only set on phase: "complete". */
  final?: boolean;
  toolUsed?: string;
  observationSummary?: string;
  iterationId?: string;
};

/** 7b.iii.a — Block 1 iteration bracket. Visually LARGER and bolder
 *  than FeedIterationDivider — one level above a step. */
type FeedBlockDivider = {
  kind: "blockDivider";
  key: string;
  stepId: StepId;
  phase: "start" | "complete";
  blockId: "block1";
  iteration: number;
  /** Only set on phase: "complete". */
  passed?: boolean;
  reason?:
    | "exit_signal_ok"
    | "plan_requires_context"
    | "plan_empty_actions"
    | "dry_run_mismatch"
    | "max_iterations";
  observationSummary?: string;
  iterationId?: string;
};

/** 7b.iii.b commit 4 — visual banner for `block.backtrack.triggered`
 *  frames. Full-width accent-colored row in BehaviorFeed (NOT a
 *  compact tool card — backtracks are structural events that
 *  separate one cognitive pass from another and the reviewer needs
 *  to see the boundary clearly). `fromStep` discriminates pre-exec
 *  refine ("review_gate") vs. post-exec backtrack
 *  ("human_verify_gate") for UI copy. */
type FeedBacktrackBanner = {
  kind: "backtrack";
  key: string;
  stepId: StepId;
  fromStep: string;
  toBlock: string;
  backtrackCount: number;
  carriedContext: string[];
  iterationId?: string;
};

/** week2d Part 4 — divergence banner inserted in the feed at the
 *  chronological position of a materialize_skill_card.step.completed
 *  frame whose output.divergence !== null. Warn-yellow accent, full
 *  width, read-only. Complementary to the LEFT-column chip in
 *  renderMaterializeBody — this surface carries the detail, LEFT
 *  carries the status signal. */
type FeedDivergenceBanner = {
  kind: "divergence";
  key: string;
  stepId: StepId;
  expected: string;
  actual: string;
  reason: string;
  skillName?: string;
  /** Structural feed items (dividers, banners) don't nest under
   *  ReAct iterations — optional to satisfy FeedItemView's
   *  iteration-wrap prop shape. */
  iterationId?: string;
};

type FeedItem =
  | { kind: "divider"; key: string; stepId: StepId; phase: "start" | "complete" | "failed"; durationMs?: number; errorMsg?: string; iterationId?: string }
  | FeedBubble
  | FeedTool
  | FeedIterationDivider
  | FeedBlockDivider
  | FeedBacktrackBanner
  | FeedDivergenceBanner
  | { kind: "rag"; key: string; stepId: StepId; frame: Frame; iterationId?: string }
  | { kind: "nav"; key: string; stepId: StepId; frame: Frame; iterationId?: string }
  | { kind: "screenshot"; key: string; stepId: StepId; frame: Frame; iterationId?: string }
  | { kind: "console"; key: string; stepId: StepId; frame: Frame; iterationId?: string };

/**
 * Walk frames in arrival order and build a stable list of feed items.
 * Pure function — recomputed on every render (cheap: O(n), typical n < 1k).
 *
 * Grouping rules:
 *   - llm.message.started opens a bubble; subsequent llm.thinking.delta
 *     and llm.text.delta frames accumulate into it; llm.message.completed
 *     closes it.
 *   - tool.started opens a tool card (keyed by invocationId);
 *     tool.completed / tool.failed closes it.
 *   - rag.retrieved nests into the most-recent OPEN tool card whose name
 *     starts with "rag.". If no such card is open (orphan — envelope
 *     weirdness / bus re-ordering), render as a standalone "rag orphan"
 *     item so hits aren't silently dropped (handoff requirement A).
 *   - step.started / step.completed / step.failed render as dividers.
 *   - Dropped: heartbeat, resync, run.*, review.*, llm.tool_use.*,
 *     step.started/completed/failed are handled as dividers above.
 */
function projectFeedItems(frames: Frame[]): FeedItem[] {
  const items: FeedItem[] = [];
  let currentBubble: FeedBubble | null = null;
  const openTools = new Map<string, FeedTool>();

  const keyOf = (f: Frame, suffix = "") =>
    `${f.seq ?? f.ts}-${f.type}${suffix}`;

  // Commit 7b.ii — pull `reactIterationId` off every timeline frame
  // into the projected item so the render path can apply visual
  // nesting (data-react-iteration-id attribute on the outer wrapper).
  // Never set on `react.iteration.*` frames themselves (the iteration
  // divider IS the bracket; nesting it inside itself would be circular).
  const iterIdOf = (f: Frame): string | undefined => {
    const raw = (f as Frame & { reactIterationId?: unknown }).reactIterationId;
    return typeof raw === "string" ? raw : undefined;
  };

  for (const f of frames) {
    switch (f.type) {
      case "step.started":
        items.push({ kind: "divider", key: keyOf(f), stepId: f.stepId, phase: "start" });
        break;
      case "step.completed":
        items.push({
          kind: "divider",
          key: keyOf(f),
          stepId: f.stepId,
          phase: "complete",
          durationMs: Number(f.durationMs ?? 0),
        });
        // week2d Part 4 — divergence banner insertion.
        // Fires when materialize_skill_card's step.completed carries
        // a non-null divergence (scaffoldMatch was false; UI drift).
        // Happy-path materializations (divergence === null) emit zero
        // banners — identical to pre-Part-4 behavior.
        if (f.stepId === "materialize_skill_card") {
          const out = f.output as
            | { divergence?: { expected?: unknown; actual?: unknown; reason?: unknown } | null; skillName?: unknown }
            | undefined;
          const div = out?.divergence;
          if (div && typeof div === "object") {
            items.push({
              kind: "divergence",
              key: keyOf(f, "-div"),
              stepId: f.stepId,
              expected: String(div.expected ?? "—"),
              actual: String(div.actual ?? "—"),
              reason: String(div.reason ?? ""),
              skillName: typeof out?.skillName === "string" ? out.skillName : undefined,
            });
          }
        }
        break;
      case "step.failed": {
        const err = f.error as { message?: string } | undefined;
        items.push({
          kind: "divider",
          key: keyOf(f),
          stepId: f.stepId,
          phase: "failed",
          errorMsg: err?.message ?? "",
        });
        break;
      }
      // Commit 7b.iii.a — Block 1 iteration brackets rendered inline
      // as larger dividers than the ReAct iteration dividers below.
      // Block brackets live at the step-level (one visual level above
      // ReAct dividers); a pass of Block 1 contains multiple inner
      // steps, and each step may itself contain ReAct iterations.
      case "block.iteration.started":
        items.push({
          kind: "blockDivider",
          key: keyOf(f),
          stepId: f.stepId,
          phase: "start",
          blockId: "block1",
          iteration: Number(f.iteration ?? 0),
        });
        break;
      case "block.iteration.completed": {
        const reason = typeof f.reason === "string" ? f.reason : "";
        items.push({
          kind: "blockDivider",
          key: keyOf(f),
          stepId: f.stepId,
          phase: "complete",
          blockId: "block1",
          iteration: Number(f.iteration ?? 0),
          passed: Boolean(f.passed),
          reason: reason as FeedBlockDivider["reason"],
          observationSummary:
            typeof f.observationSummary === "string" ? f.observationSummary : undefined,
        });
        break;
      }

      // 7b.iii.b commit 4 — backtrack banner. Renders as a full-width
      // structural separator in the feed; carriedContext is surfaced
      // to the reviewer so they can see what observations are being
      // threaded into the next Block 1 iteration.
      case "block.backtrack.triggered":
        items.push({
          kind: "backtrack",
          key: keyOf(f),
          stepId: f.stepId,
          fromStep: String(f.fromStep ?? ""),
          toBlock: String(f.toBlock ?? ""),
          backtrackCount: Number(f.backtrackCount ?? 0),
          carriedContext: Array.isArray(f.carriedContext)
            ? (f.carriedContext as unknown[]).map(String)
            : [],
        });
        break;

      // Commit 7b.ii — ReAct iteration brackets rendered inline.
      case "react.iteration.started":
        items.push({
          kind: "iterationDivider",
          key: keyOf(f),
          stepId: f.stepId,
          phase: "start",
          iteration: Number(f.iteration ?? 0),
          reactRunId: String(f.reactRunId ?? ""),
        });
        break;
      case "react.iteration.completed":
        items.push({
          kind: "iterationDivider",
          key: keyOf(f),
          stepId: f.stepId,
          phase: "complete",
          iteration: Number(f.iteration ?? 0),
          reactRunId: String(f.reactRunId ?? ""),
          final: Boolean(f.final),
          toolUsed: typeof f.toolUsed === "string" ? f.toolUsed : undefined,
          observationSummary:
            typeof f.observationSummary === "string" ? f.observationSummary : undefined,
        });
        break;
      case "llm.message.started": {
        const bubble: FeedBubble = {
          kind: "bubble",
          key: keyOf(f),
          stepId: f.stepId,
          started: f,
          thinking: "",
          text: "",
          iterationId: iterIdOf(f),
        };
        items.push(bubble);
        currentBubble = bubble;
        break;
      }
      case "llm.thinking.delta":
        if (currentBubble) currentBubble.thinking += String(f.text ?? "");
        break;
      case "llm.text.delta":
        if (currentBubble) currentBubble.text += String(f.text ?? "");
        break;
      case "llm.message.completed":
        if (currentBubble) currentBubble.completed = f;
        currentBubble = null;
        break;
      case "tool.started": {
        const invocationId = String(f.invocationId ?? "");
        const tool: FeedTool = {
          kind: "tool",
          key: keyOf(f),
          stepId: f.stepId,
          started: f,
          hits: [],
          iterationId: iterIdOf(f),
        };
        items.push(tool);
        if (invocationId) openTools.set(invocationId, tool);
        break;
      }
      case "tool.completed": {
        const invocationId = String(f.invocationId ?? "");
        const tool = openTools.get(invocationId);
        if (tool) {
          tool.completed = f;
          openTools.delete(invocationId);
        } else {
          items.push({
            kind: "tool",
            key: keyOf(f, "-orphan"),
            stepId: f.stepId,
            started: f,
            completed: f,
            hits: [],
            iterationId: iterIdOf(f),
          });
        }
        break;
      }
      case "tool.failed": {
        const invocationId = String(f.invocationId ?? "");
        const tool = openTools.get(invocationId);
        if (tool) {
          tool.failed = f;
          openTools.delete(invocationId);
        } else {
          items.push({
            kind: "tool",
            key: keyOf(f, "-orphan"),
            stepId: f.stepId,
            started: f,
            failed: f,
            hits: [],
            iterationId: iterIdOf(f),
          });
        }
        break;
      }
      case "rag.retrieved": {
        let nested = false;
        for (const tool of openTools.values()) {
          const name = String(tool.started.name ?? "");
          if (name.startsWith("rag.")) {
            tool.hits.push(f);
            nested = true;
            break;
          }
        }
        if (!nested) {
          items.push({ kind: "rag", key: keyOf(f), stepId: f.stepId, frame: f, iterationId: iterIdOf(f) });
        }
        break;
      }
      case "browser.nav":
        items.push({ kind: "nav", key: keyOf(f), stepId: f.stepId, frame: f, iterationId: iterIdOf(f) });
        break;
      case "browser.screenshot":
        items.push({ kind: "screenshot", key: keyOf(f), stepId: f.stepId, frame: f, iterationId: iterIdOf(f) });
        break;
      case "browser.console":
        items.push({ kind: "console", key: keyOf(f), stepId: f.stepId, frame: f, iterationId: iterIdOf(f) });
        break;
      default:
        break;
    }
  }
  return items;
}

function BehaviorFeed({ frames, runId }: { frames: Frame[]; runId: string }) {
  const items = useMemo(() => projectFeedItems(frames), [frames]);

  const feedRef = useRef<HTMLDivElement>(null);
  const stuckToBottomRef = useRef<boolean>(true);
  const lastUserScrollAt = useRef<number>(0);

  const onScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 24;
    stuckToBottomRef.current = atBottom;
    if (!atBottom) lastUserScrollAt.current = Date.now();
  }, []);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const shouldAutoScroll =
      stuckToBottomRef.current || Date.now() - lastUserScrollAt.current > 3_000;
    if (!shouldAutoScroll) return;
    const last = el.lastElementChild;
    if (!last) return;
    // Week-2a ux-polish — scroll anchor is state-dependent:
    //   • default (7a.v) — `scrollIntoView({ block: "start" })` parks
    //     the last feed item's TOP at `scroll-margin-top: 33vh`.
    //     Ideal for short frames (browser.nav, tool.completed) that
    //     finish close to their starting height.
    //   • streaming bubble (Week-2a) — if the last item is a bubble
    //     whose thinking or text block is actively streaming, anchor
    //     its BOTTOM to the viewport bottom so the growing caret /
    //     tail stays visible instead of drifting below the fold.
    //
    // Streaming detection is done in JS (NOT via a CSS `:not()`
    // selector) with two `querySelector` calls:
    //   • text stream — `.text-block.typing` is present (the 7a.v
    //     typewriter marker; class drops on `llm.message.completed`).
    //   • thinking stream — `.thinking-block` is present AND its
    //     enclosing `.thinking-wrapper` does NOT carry `.collapsed`
    //     (the wrapper flips to `.collapsed` on
    //     `llm.message.completed` via the 7a.v fade-to-summary
    //     transition). Both end-conditions align on the same
    //     lifecycle boundary, so the bottom-anchor auto-reverts to
    //     top-anchor at stream end without any explicit transition
    //     state.
    //
    // `scroll-margin-bottom: 12vh` (added on `.behavior-feed > *` in
    // globals.css) gives the caret breathing room when the
    // bottom-anchor path fires.
    // Three-const extraction of the streaming-detection selectors
    // (readability refactor from week2a-chatbar-ux-fix probe investigation;
    // semantics identical to the original inline ternary). Naming the
    // individual checks makes the compound boolean easier to reason
    // about during future scroll-anchor tweaks — see MASTER_PLAN
    // Week-2 polish queue: "thinking-scroll perfect-pin math".
    const hasTextTyping = last.querySelector(".text-block.typing") !== null;
    const hasThinkingBlock = last.querySelector(".thinking-block") !== null;
    const hasCollapsed = last.querySelector(".thinking-wrapper.collapsed") !== null;
    const isStreamingBubble = hasTextTyping || (hasThinkingBlock && !hasCollapsed);
    last.scrollIntoView({
      block: isStreamingBubble ? "end" : "start",
      behavior: "auto",
    });
  }, [frames.length]);

  return (
    <div
      className="behavior-feed"
      ref={feedRef}
      onScroll={onScroll}
      data-testid="behavior-feed"
    >
      {items.length === 0 ? (
        <div className="feed-empty">waiting for the first frame…</div>
      ) : (
        items.map((item) => <FeedItemView key={item.key} item={item} runId={runId} />)
      )}
    </div>
  );
}

function FeedItemView({ item, runId }: { item: FeedItem; runId: string }) {
  // Commit 7b.ii — outer wrapper carries `data-react-iteration-id` so
  // CSS can indent + border-left every item emitted inside a ReAct
  // iteration. `.behavior-feed > *` scroll-anchor rule still fires
  // correctly because the wrapper IS the direct child of .behavior-feed.
  const inner = renderInner(item, runId);
  return (
    <div
      className="feed-item-wrap"
      data-react-iteration-id={item.iterationId || undefined}
      data-kind={item.kind}
    >
      {inner}
    </div>
  );
}

function renderInner(item: FeedItem, runId: string) {
  switch (item.kind) {
    case "divider":
      return <FeedDivider item={item} />;
    case "iterationDivider":
      return <FeedIterationDivider item={item} />;
    case "blockDivider":
      return <FeedBlockDividerView item={item} />;
    case "backtrack":
      return <FeedBacktrackBannerView item={item} />;
    case "divergence":
      return <FeedDivergenceBannerView item={item} />;
    case "bubble":
      return <FeedBubbleView item={item} />;
    case "tool":
      return <FeedToolCard item={item} />;
    case "rag":
      return <FeedRagOrphan item={item} />;
    case "nav":
      return <FeedNav item={item} />;
    case "screenshot":
      return <FeedShot item={item} runId={runId} />;
    case "console":
      return <FeedConsole item={item} />;
  }
}

function FeedDivider({ item }: { item: Extract<FeedItem, { kind: "divider" }> }) {
  const cls = item.phase === "complete" ? "ok" : item.phase === "failed" ? "err" : "";
  const label =
    item.phase === "start"
      ? STEP_LABELS[item.stepId]
      : item.phase === "complete"
        ? `✓ ${STEP_LABELS[item.stepId]} · ${item.durationMs ?? 0}ms`
        : `✗ ${STEP_LABELS[item.stepId]}${item.errorMsg ? ` · ${short(item.errorMsg, 80)}` : ""}`;
  return (
    <div className={`feed-divider ${cls}`} data-testid={`feed-divider-${item.stepId}-${item.phase}`}>
      {label}
    </div>
  );
}

/** Commit 7b.iii.a — Block 1 iteration bracket. Visually LARGER and
 *  bolder than FeedIterationDivider (one visual level ABOVE a step),
 *  since a Block 1 pass contains multiple inner steps + each step may
 *  contain ReAct iterations. The failed path (`passed === false`)
 *  tints orange/warn; the exhausted-terminal (`reason === "max_iterations"`)
 *  tints red. */
function FeedBlockDividerView({
  item,
}: {
  item: Extract<FeedItem, { kind: "blockDivider" }>;
}) {
  if (item.phase === "start") {
    return (
      <div
        className="feed-block-divider start"
        data-testid={`feed-block-divider-${item.iteration}-start`}
      >
        block 1 · pass {item.iteration}
      </div>
    );
  }
  // phase: "complete"
  const isExhausted = item.reason === "max_iterations";
  const cls = item.passed ? "passed" : isExhausted ? "exhausted" : "failed";
  const reasonLabel =
    item.reason === "exit_signal_ok"
      ? "ready for review"
      : item.reason === "plan_requires_context"
        ? "plan needs context"
        : item.reason === "plan_empty_actions"
          ? "plan empty"
          : item.reason === "dry_run_mismatch"
            ? "dry-run mismatch"
            : item.reason === "max_iterations"
              ? "exhausted"
              : "";
  const prefix = item.passed ? "✓" : isExhausted ? "⚠" : "✗";
  const obsBit = item.observationSummary
    ? ` · ${short(item.observationSummary, 80)}`
    : "";
  return (
    <div
      className={`feed-block-divider complete ${cls}`}
      data-testid={`feed-block-divider-${item.iteration}-complete`}
    >
      {prefix} pass {item.iteration} · {reasonLabel}
      {obsBit}
    </div>
  );
}

/** 7b.iii.b commit 4 — Backtrack banner. Full-width structural
 *  separator in the BehaviorFeed marking a block.backtrack.triggered
 *  event. Copy branches on fromStep: pre-exec refine
 *  ("review_gate" — reviewer clicked Edit with notes) vs. post-exec
 *  backtrack ("human_verify_gate" — reviewer clicked Reject on the
 *  post-exec gate). The carried context is displayed so the reviewer
 *  sees exactly what observations are being threaded into the next
 *  Block 1 iteration: reviewer's note (highlighted) + prior-attempt
 *  summary (dim). */
function FeedBacktrackBannerView({
  item,
}: {
  item: Extract<FeedItem, { kind: "backtrack" }>;
}) {
  const isPreExec = item.fromStep === "review_gate";
  const subtitle = isPreExec
    ? "Pre-exec refine requested by reviewer"
    : "Post-exec reject — re-entering full pre-notify chain";
  const noteEntry = item.carriedContext.find((e) => e.startsWith("Reviewer note:"));
  const otherEntries = item.carriedContext.filter(
    (e) => !e.startsWith("Reviewer note:"),
  );
  return (
    <div
      className={`feed-backtrack-banner ${isPreExec ? "pre-exec" : "post-exec"}`}
      data-testid={`feed-backtrack-banner-${item.backtrackCount}`}
    >
      <div className="feed-backtrack-head">
        <span className="feed-backtrack-arrow">↻</span>
        <span className="feed-backtrack-title">
          BACKTRACK #{item.backtrackCount} · {item.fromStep} → {item.toBlock}
        </span>
      </div>
      <div className="feed-backtrack-subtitle">{subtitle}</div>
      {noteEntry && (
        <div className="feed-backtrack-note">{short(noteEntry, 240)}</div>
      )}
      {otherEntries.length > 0 && (
        <div className="feed-backtrack-context dim">
          Carrying {otherEntries.length} observation
          {otherEntries.length === 1 ? "" : "s"} forward
        </div>
      )}
    </div>
  );
}

/** week2d Part 4 — divergence banner. Inline full-width row in the
 *  behavior feed, rendered at the chronological position of a
 *  materialize_skill_card.step.completed frame whose output.divergence
 *  !== null. Warn-yellow accent, read-only. Complementary to the
 *  LEFT-column chip in renderMaterializeBody: LEFT carries the
 *  status signal, RIGHT carries the detail (expected / actual / reason). */
function FeedDivergenceBannerView({
  item,
}: {
  item: Extract<FeedItem, { kind: "divergence" }>;
}) {
  return (
    <div
      className="feed-divergence-banner"
      data-testid="feed-divergence-banner"
    >
      <div className="feed-divergence-head">
        <span className="feed-divergence-icon">⚠</span>
        <span className="feed-divergence-title">UI DRIFT DETECTED</span>
      </div>
      <div className="feed-divergence-row">
        <span className="feed-divergence-label">Scaffold expected:</span>
        <span className="feed-divergence-value">{item.expected}</span>
      </div>
      <div className="feed-divergence-row">
        <span className="feed-divergence-label">Agent found:</span>
        <span className="feed-divergence-value">{item.actual}</span>
      </div>
      {item.reason && (
        <div className="feed-divergence-reason">
          <span className="feed-divergence-label">Reason:</span>{" "}
          <span className="feed-divergence-value">&ldquo;{item.reason}&rdquo;</span>
        </div>
      )}
      <div className="feed-divergence-footer dim">
        The materialized skill uses the agent&apos;s observed element. Reviewer:
        verify the semantic match at the gate above.
      </div>
    </div>
  );
}

/** Commit 7b.ii — ReAct iteration bracket. Visually a smaller / indented
 *  version of FeedDivider, nested inside its parent step's frames. */
function FeedIterationDivider({
  item,
}: {
  item: Extract<FeedItem, { kind: "iterationDivider" }>;
}) {
  if (item.phase === "start") {
    return (
      <div
        className="feed-iteration-divider start"
        data-testid={`feed-iteration-divider-${item.iteration}-start`}
      >
        iteration {item.iteration}
      </div>
    );
  }
  // phase: "complete"
  const cls = item.final ? "final" : "";
  const prefix = item.final ? "✓ final" : `✓ iteration ${item.iteration}`;
  const toolBit = item.toolUsed ? ` · ${item.toolUsed}` : "";
  const obsBit = item.observationSummary
    ? ` · ${short(item.observationSummary, 80)}`
    : "";
  return (
    <div
      className={`feed-iteration-divider complete ${cls}`}
      data-testid={`feed-iteration-divider-${item.iteration}-complete`}
    >
      {prefix}
      {toolBit}
      {obsBit}
    </div>
  );
}

/**
 * Commit 7a.v — typewriter hook for llm.text.delta reveal.
 *
 * Drives a steady ~60 cps char pump while the bubble is streaming. If
 * `fullText` grows faster than our pump can reveal (Sonnet's
 * token-burst pattern during extended thinking), a catchup clause
 * scales the step-size so displayed text never drifts far from the
 * actual stream (max ~1s visual lag behind the wire).
 *
 * Flushes remaining text immediately on completion so the reviewer
 * isn't left waiting on the animation after the model has already
 * finished.
 *
 * Note on deps: the effect only depends on `completed`. `fullText` is
 * read via a ref that tracks every render, so delta arrivals don't
 * thrash the interval identity.
 */
function useTypewriter(fullText: string, completed: boolean): string {
  const [revealed, setRevealed] = useState<number>(0);
  const textRef = useRef<string>(fullText);
  textRef.current = fullText;

  useEffect(() => {
    if (completed) {
      setRevealed(textRef.current.length);
      return;
    }
    const id = setInterval(() => {
      setRevealed((n) => {
        const target = textRef.current.length;
        const behind = target - n;
        if (behind <= 0) return n;
        // Steady state: 1 char / 16ms tick ≈ 60 cps. Catch up faster if
        // the pump has fallen > 50 chars behind so bursts don't leave
        // visible text lagging seconds behind the wire.
        const step = behind > 50 ? Math.max(2, Math.ceil(behind / 20)) : 1;
        return Math.min(target, n + step);
      });
    }, 16);
    return () => clearInterval(id);
  }, [completed]);

  return completed ? fullText : fullText.slice(0, revealed);
}

function FeedBubbleView({ item }: { item: FeedBubble }) {
  const model = String(item.started.model ?? "");
  const thinkingEnabled = Boolean(item.started.thinkingEnabled);
  const completed = item.completed;
  const usage = completed?.usage as
    | { inputTokens?: number; outputTokens?: number }
    | undefined;
  const durMs = completed ? computeMsBetween(item.started.ts, completed.ts) : null;

  // Commit 7a.v — thinking bubble collapses to a one-line summary on
  // `llm.message.completed`. Click the pill to expand; click the
  // inner "collapse" button to re-collapse. Collapse is intentionally
  // post-completion only — collapsing a mid-stream thinking block
  // leaves the reviewer wondering "is it still thinking or is the
  // summary final?", which is the wrong UX.
  const [thinkingExpanded, setThinkingExpanded] = useState<boolean>(true);
  useEffect(() => {
    if (completed && item.thinking) {
      setThinkingExpanded(false);
    }
  }, [completed, item.thinking]);

  // Commit 7a.v — typewriter reveal on output text only (not thinking —
  // thinking is internal monologue and should feel fast / as-arrives).
  const displayedText = useTypewriter(item.text, !!completed);

  return (
    <div className="feed-bubble" data-testid="feed-bubble">
      <div className="feed-bubble-header">
        <span className="model-tag">[{model || "?"}]</span>
        {!completed && thinkingEnabled && <span>thinking…</span>}
        {!completed && !thinkingEnabled && <span>streaming…</span>}
      </div>

      {item.thinking && (
        <>
          {!thinkingExpanded && (
            <button
              type="button"
              className="thinking-summary"
              onClick={() => setThinkingExpanded(true)}
              data-testid="thinking-summary"
            >
              [{model || "?"}] thought for {durMs !== null ? `${(durMs / 1000).toFixed(1)}s` : "—"} · click to expand
            </button>
          )}
          <div className={`thinking-wrapper ${thinkingExpanded ? "" : "collapsed"}`}>
            <div className="thinking-block">
              {item.thinking}
              {completed && (
                <button
                  type="button"
                  className="thinking-collapse-btn"
                  onClick={() => setThinkingExpanded(false)}
                >
                  collapse
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {item.text && (
        <div className={`text-block ${!completed ? "typing" : ""}`}>{displayedText}</div>
      )}

      {completed && (
        <div className="feed-bubble-footer">
          ✓ {durMs !== null ? `${durMs}ms` : "—"} · in={usage?.inputTokens ?? "?"} out={usage?.outputTokens ?? "?"} · stop={String(completed.stopReason ?? "?")}
        </div>
      )}
    </div>
  );
}

function FeedToolCard({ item }: { item: FeedTool }) {
  const name = String(item.started.name ?? "");
  const completed = item.completed;
  const failed = item.failed;
  const status = failed ? "err" : completed ? "ok" : "pending";
  const marker = failed ? "✗" : completed ? "✓" : "→";
  const durMs = completed ? Number(completed.durationMs ?? 0) : null;
  const errMsg = failed
    ? String(((failed.error as { message?: string } | undefined)?.message) ?? "")
    : "";

  return (
    <div className={`feed-tool ${status}`} data-testid="feed-tool">
      <div className="feed-tool-head">
        <span className="marker">{marker}</span>
        <span>{name}</span>
        {durMs !== null && <span className="feed-tool-meta">{durMs}ms</span>}
        {errMsg && <span className="feed-tool-meta">· {short(errMsg, 80)}</span>}
      </div>
      {renderHitRows(item.hits)}
    </div>
  );
}

function FeedRagOrphan({ item }: { item: Extract<FeedItem, { kind: "rag" }> }) {
  const hits = extractHits(item.frame);
  return (
    <div className="feed-tool pending" data-testid="feed-rag-orphan">
      <div className="feed-tool-head">
        <span className="marker">●</span>
        <span>rag.retrieved (unpaired)</span>
        <span className="feed-tool-meta">{hits.length} hit{hits.length === 1 ? "" : "s"}</span>
      </div>
      {hits.length > 0 && (
        <div className="feed-tool-hits">
          {hits.map((h, i) => (
            <div className="feed-tool-hit" key={i}>
              <span className="score">{h.score.toFixed(2)}</span>
              <span>{short(String(h.source), 36)} — {short(String(h.preview), 80)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Render a set of rag hit rows nested under a tool card. Flattens
 *  `hits[]` arrays from multiple rag.retrieved frames in arrival order. */
function renderHitRows(hitFrames: Frame[]): React.ReactNode {
  if (hitFrames.length === 0) return null;
  const flat = hitFrames.flatMap((hf) =>
    extractHits(hf).map((h, i) => ({ h, key: `${hf.seq ?? hf.ts}-${i}` })),
  );
  if (flat.length === 0) return null;
  return (
    <div className="feed-tool-hits">
      {flat.map(({ h, key }) => (
        <div className="feed-tool-hit" key={key}>
          <span className="score">{h.score.toFixed(2)}</span>
          <span>{short(String(h.source), 36)} — {short(String(h.preview), 80)}</span>
        </div>
      ))}
    </div>
  );
}

interface RagHit {
  score: number;
  source: string;
  preview: string;
  chunkId?: string | number;
}

function extractHits(frame: Frame): RagHit[] {
  const raw = frame.hits as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((h) => {
    const obj = h as Record<string, unknown>;
    return {
      score: typeof obj.score === "number" ? obj.score : 0,
      source: String(obj.source ?? ""),
      preview: String(obj.preview ?? ""),
      chunkId: (obj.chunkId ?? undefined) as string | number | undefined,
    };
  });
}

function FeedNav({ item }: { item: Extract<FeedItem, { kind: "nav" }> }) {
  const url = String(item.frame.url ?? "");
  return <div className="feed-nav">→ nav: {url}</div>;
}

function FeedShot({ item, runId }: { item: Extract<FeedItem, { kind: "screenshot" }>; runId: string }) {
  const path = String(item.frame.path ?? "");
  const label = String(item.frame.label ?? "");
  const src = path && runId ? `/api/static/runs/${runId}/${basename(path)}` : null;
  if (!src) return null;
  return (
    <div className="feed-shot-row">
      <div className="feed-shot-label">{label}</div>
      <a href={src} target="_blank" rel="noopener noreferrer" className="feed-shot-link">
        <img src={src} alt={label || "browser screenshot"} loading="lazy" className="feed-shot" />
      </a>
    </div>
  );
}

function FeedConsole({ item }: { item: Extract<FeedItem, { kind: "console" }> }) {
  const level = String(item.frame.level ?? "log");
  const text = String(item.frame.text ?? "");
  return <div className={`feed-console ${level}`}>[{level}] {short(text, 200)}</div>;
}

/* ---------- ChatBar (Week-2a — Jakob's-Law persistent decision surface) ----------
 *
 * Replaces the legacy <ReviewPanel>. Persistent, always-mounted input surface
 * pinned to the bottom of the LEFT column (inherits `--left-pct` via its flex
 * container). Visible regardless of gate state; mode-derived styling
 * communicates whether reviewer input is required, the agent is working, or
 * the run is terminal.
 *
 * Wire contract UNCHANGED: every decision still round-trips as a
 * `review.decide` client frame via the parent's `decide()` callback. Server
 * emits `review.decided` / `review.requested` / `run.completed` unchanged.
 * Zero envelope additions, zero agent-side code changes, zero tests changed
 * (UI-smoke-gated per 6b / 7a / commit-3 precedent).
 *
 * Mode machine (priority: terminal > submitting > decision-required > idle):
 *   - idle                          : no pendingReview, run still live
 *   - decision-required.pre_exec    : review.requested{pre_exec} pending;
 *                                     Approve / Edit / Reject visible
 *                                     (sub-state `.exhausted` disables Approve)
 *   - decision-required.post_exec   : review.requested{post_exec} pending;
 *                                     Approve / Reject only (Edit hidden —
 *                                     wedge prevention, see allowEdit docblock)
 *   - submitting                    : local state while Block 1 re-runs on Edit;
 *                                     exits on fresh review.requested via
 *                                     planId-delta effect (E4)
 *   - terminal                      : run.completed received; all controls
 *                                     disabled, summary line shown
 *
 * Cmd/Ctrl+Enter (non-empty note + decision-required + allowEdit) fires
 * Edit; silent no-op otherwise. Approve / Reject require explicit click
 * (destructive-action deliberation discipline; asymmetric by design).
 * See Artifact 5 of the week2a-chatbar proposal for the handler contract.
 *
 * PRESERVED FROM REVIEWPANEL VERBATIM:
 *   - submittedAtPlanId state + planId-delta useEffect (migrated from
 *     ReviewPanel scope; same state names, same deps, same clear logic)
 *   - Cancel-refine escape hatch (copy + "UI-only reset" caveat unchanged)
 *   - Exhausted-state Approve disable + same title tooltip
 *   - Post-exec Edit hiding + wedge-prevention docblock on allowEdit
 *   - 2000-char maxLength on textarea (REVIEW_EDIT_NOTES_MAX)
 */
function ChatBar(props: {
  pendingReview: ReviewRequestedFrame | null;
  frames: Frame[];
  onDecide: (
    decision: "approve" | "reject" | "edit" | "terminate",
    opts?: { notes?: string; stepId?: string },
  ) => void;
  disabled: boolean;
}) {
  const [note, setNote] = useState("");
  // Week-2a gate-decision-model — Terminate two-step confirmation.
  // `null` = link in default state; `number` (timestamp) = armed,
  // awaiting second click within TERMINATE_CONFIRM_MS. A useEffect
  // below cleans up the arm-timeout on unmount (prevents stale
  // state-setters) and resets the flag if the reviewer doesn't
  // double-click within the window.
  const [terminateArmedAt, setTerminateArmedAt] = useState<number | null>(
    null,
  );
  /** 7b.iii.b-pre-exec-edit-ui — planId of the review.requested that
   *  was showing when the reviewer submitted an Edit. Used to detect
   *  the server's response — a fresh review.requested with a new
   *  planId means Block 1 finished re-planning and it's safe to
   *  re-enable the bar. Closes the double-submit window during the
   *  ~2-5 minute Block-1 re-run.
   *
   *  (Week-2a: migrated from ReviewPanel scope verbatim — same state
   *  name, same semantics. The planId-delta effect below is the E4
   *  edge on the ChatBar state-transition diagram.) */
  const [submittedAtPlanId, setSubmittedAtPlanId] = useState<string | null>(null);

  const isRunTerminal = useMemo(
    () => props.frames.some((f) => f.type === "run.completed"),
    [props.frames],
  );

  const currentPlanId = props.pendingReview?.plan.planId ?? null;
  const isSubmitting = submittedAtPlanId !== null;

  // Auto-exit submitting mode when a fresh review.requested arrives
  // (detected by planId delta). Defensive reset clears note state so
  // a subsequent Edit click starts from a clean slate.
  //
  // (Week-2a: migrated from ReviewPanel's `useEffect` at the old
  // page.tsx:1557-1567. Mode is now derived rather than stateful, so
  // the `setMode("default")` line has no analog — exiting submitting
  // is just "clear submittedAtPlanId". Equivalent behavior.)
  useEffect(() => {
    if (
      isSubmitting &&
      submittedAtPlanId &&
      currentPlanId !== submittedAtPlanId
    ) {
      setSubmittedAtPlanId(null);
      setNote("");
    }
  }, [isSubmitting, submittedAtPlanId, currentPlanId]);

  // Week-2a gate-decision-model — Terminate armed-state auto-reset.
  // If the reviewer clicks Terminate but doesn't confirm within
  // TERMINATE_CONFIRM_MS, revert to the unarmed link state silently
  // (no toast, no shake — matches the Cmd+Enter silent-no-op
  // discipline). Cleanup on unmount via return function prevents
  // stale state-setters firing on an unmounted component.
  useEffect(() => {
    if (terminateArmedAt === null) return;
    const t = setTimeout(
      () => setTerminateArmedAt(null),
      TERMINATE_CONFIRM_MS,
    );
    return () => clearTimeout(t);
  }, [terminateArmedAt]);

  // Sub-state derivations (match today's ReviewPanel exactly).
  const isPostExec = props.pendingReview?.reviewHint === "post_exec";
  const blockResult = props.pendingReview?.blockResult;
  const isBlock1Exhausted = blockResult?.passedLast === false;

  // week2d Part 4 — dry_run-exhaustion derivation. The review.requested
  // frame doesn't surface boundaryReached directly (envelope non-goal
  // for Part 4), so scan the frames array backwards for the most-recent
  // dry_run step.completed and read its output.boundaryReached. `null`
  // = agent exhausted iteration cap without identifying a destructive
  // boundary (Part 3 RFC §6 graceful-exhaustion path). Only relevant
  // on pre-exec gate (post-exec wouldn't have a live dry_run output).
  const isDryRunExhausted = useMemo(() => {
    if (!props.pendingReview || isPostExec) return false;
    for (let i = props.frames.length - 1; i >= 0; i--) {
      const f = props.frames[i]!;
      if (f.type === "step.completed" && f.stepId === "dry_run") {
        const out = f.output as { boundaryReached?: unknown } | undefined;
        return out?.boundaryReached === null || out?.boundaryReached === undefined;
      }
    }
    return false;
  }, [props.frames, props.pendingReview, isPostExec]);

  const isExhausted = isBlock1Exhausted || isDryRunExhausted;

  // Mode derivation (priority order).
  type ChatBarMode = "idle" | "decision-required" | "submitting" | "terminal";
  const mode: ChatBarMode = isRunTerminal
    ? "terminal"
    : isSubmitting
      ? "submitting"
      : props.pendingReview
        ? "decision-required"
        : "idle";

  // canDecide: can the reviewer submit any of the non-terminate
  //   decisions (approve / reject / edit) right now?
  //   WS open AND we're in decision-required mode.
  //   Week-2a gate-decision-model — Terminate is deliberately NOT
  //   gated by this; it has its own canTerminate guard below that
  //   widens to the submitting state. Do NOT widen canDecide to
  //   include submitting — that would accidentally re-enable the
  //   Approve / Edit / Reject buttons in submitting mode and break
  //   the existing planId-delta auto-exit discipline.
  const canDecide = mode === "decision-required" && !props.disabled;

  // Week-2a gate-decision-model — Terminate is reachable from
  // BOTH decision-required AND submitting states (per hard
  // requirement from the ux-polish review round). Rationale: if
  // the server-side refine wedges (Block 1 hangs, Anthropic
  // circuit-open cascade, etc.) the reviewer needs a wire-level
  // kill. Cancel-refine is a UI-only unlock that doesn't stop the
  // agent; Terminate IS a wire-level kill.
  //
  // Idle and terminal states don't render Terminate (no pending
  // gate to terminate, or run is already over). Post-exec's
  // submitting is theoretical — post-exec has no Edit path so
  // never enters submitting today; guard still applies harmlessly.
  const canTerminate =
    !props.disabled &&
    props.pendingReview !== null &&
    (mode === "decision-required" || mode === "submitting");

  // allowEdit: is the Edit button visible/usable?
  //   Post-exec hides Edit (wedge prevention — humanVerifyGateStep
  //   treats edit≡approve server-side; offering Edit would wedge the
  //   submitting state forever since no fresh review.requested
  //   follows a post-exec edit. DO NOT re-enable here without also
  //   changing the server semantic. Polish item #11 queued.)
  //   Block-1-exhausted also hides Edit because Block 1 already spent
  //   its 3-pass budget — a reviewer note would trip the refine budget
  //   with the same upstream cause.
  //   week2d Part 4 — dry_run-exhaustion DOES allow Edit, specifically
  //   so the reviewer can provide a UI-drift hint to help the next
  //   exploration find the destructive boundary. Distinct from Block-1
  //   exhaustion because the failure mode is a tight iteration budget,
  //   not a deeper plan problem.
  const allowEdit =
    mode === "decision-required" && !isPostExec && !isBlock1Exhausted;

  const trimmedLength = note.trim().length;
  const canSubmitEdit =
    allowEdit && canDecide && trimmedLength > 0 && trimmedLength <= REVIEW_EDIT_NOTES_MAX;

  const handleApprove = () => {
    if (!canDecide || !props.pendingReview || isExhausted) return;
    props.onDecide("approve", { stepId: props.pendingReview.stepId });
  };

  const handleReject = () => {
    if (!canDecide || !props.pendingReview) return;
    props.onDecide("reject", { stepId: props.pendingReview.stepId });
  };

  const handleEdit = () => {
    if (!canSubmitEdit || !props.pendingReview) return;
    const trimmed = note.trim();
    setSubmittedAtPlanId(currentPlanId);
    props.onDecide("edit", {
      notes: trimmed,
      stepId: props.pendingReview.stepId,
    });
  };

  // Week-2a gate-decision-model — Terminate two-step confirmation.
  // First click arms (stores timestamp; armed-state useEffect above
  // auto-resets after TERMINATE_CONFIRM_MS). Second click within
  // the window commits by firing onDecide("terminate"). Asymmetric
  // vs Approve/Reject/Edit (which commit on single click) because
  // terminate is a destructive-action-style wire-level kill —
  // deliberation discipline matches the Cmd+Enter safety posture.
  const handleTerminate = () => {
    if (!canTerminate || !props.pendingReview) return;
    if (terminateArmedAt === null) {
      setTerminateArmedAt(Date.now());
      return;
    }
    setTerminateArmedAt(null);
    props.onDecide("terminate", { stepId: props.pendingReview.stepId });
  };

  // 7b.iii.b-pre-exec-edit-ui — local-only escape hatch.
  // Resets UI state to default; does NOT cancel the server-side
  // Block 1 refine (it can't be interrupted mid-flight in this
  // release). Intended for two cases:
  //   (a) reviewer regret after Submit;
  //   (b) pathological wedge where the fresh review.requested never
  //       arrives (Block 1 bug, network loss, etc.).
  // When the fresh review.requested DOES arrive later, it flips the
  // planId-delta effect above and the bar renders in
  // decision-required mode. Any approve/reject clicked on the stale
  // bar between Cancel-refine and the fresh request arriving lands
  // in the bus's stale-discard path (commit-1 semantics) and is
  // logged but not acted on — reviewer must re-click once the fresh
  // request appears.
  const handleCancelRefine = () => {
    setSubmittedAtPlanId(null);
    setNote("");
  };

  // Cmd/Ctrl+Enter handler (Artifact 5 — ≤10 LoC, verbatim from proposal).
  // C1: `.trim().length > 0` — whitespace-only is empty.
  // C2: strict silent no-op — no toast, no shake; macOS/Windows textareas
  //     native-no-op on Cmd/Ctrl+Enter so the browser eats it cleanly.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === "Enter";
    if (!isCmdEnter) return;
    if (note.trim().length === 0) return;
    if (!canDecide || !allowEdit) return;
    e.preventDefault();
    handleEdit();
  };

  // Placeholder per state/sub-state (Artifact 4 — 5 final strings).
  const placeholder = (() => {
    if (mode === "terminal") return "Run complete";
    if (mode === "submitting") return "";
    if (mode === "decision-required" && isPostExec) {
      return "Add a note (optional), then click Approve / Reject";
    }
    if (mode === "decision-required") {
      return "Add a note for Edit, or click Approve / Reject";
    }
    return "Note will attach to your next decision";
  })();

  // Status line copy — replaces today's ReviewPanel h3+p blocks with a
  // single paragraph above the textarea. Copy is preserved in intent
  // from each ReviewPanel variant (exhausted / post-exec / submitting /
  // default pre-exec / terminal).
  const statusLine = (() => {
    if (mode === "submitting") {
      return "Re-planning… Block 1 is re-running with your note as a prior observation.";
    }
    if (mode === "terminal") {
      return `${describeDecision(props.frames)} — no further action needed.`;
    }
    if (mode === "decision-required") {
      if (isExhausted) {
        if (isBlock1Exhausted) {
          const passes = blockResult?.passes ?? 0;
          return `⚠ Block 1 exhausted — ${passes} pass${
            passes === 1 ? "" : "es"
          } failed. Reject to replan; terminate to stop; override-and-proceed is Week-2 polish.`;
        }
        // week2d Part 4 — dry_run-exhaustion distinct copy. Agent
        // spent its iteration budget without flagging a destructive
        // boundary; reviewer can Edit with a UI-drift hint to help
        // the next exploration, Reject to auto-retry, or Terminate.
        return `⚠ Dry-run exhausted its iteration budget without identifying a destructive boundary. The agent explored but couldn't confidently flag the commit action. Edit with a UI-drift hint, Reject to retry, or Terminate.`;
      }
      if (isPostExec) {
        return `Post-execution review. Reject triggers a backtrack through Block 1 (max ${MAX_BACKTRACKS_UI} retries per run).`;
      }
      const actionCount = props.pendingReview?.plan.actionCount ?? 0;
      const destructive = props.pendingReview?.plan.destructive ?? false;
      return `${actionCount} action${actionCount === 1 ? "" : "s"}${
        destructive ? " · ⚠ destructive" : ""
      }`;
    }
    return null;
  })();

  const exhaustedReasons =
    isExhausted && Array.isArray(blockResult?.allReasons)
      ? blockResult!.allReasons!
      : [];

  const className = [
    "chat-bar",
    mode,
    isPostExec ? "post-exec" : "",
    isExhausted ? "exhausted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const textareaDisabled = mode === "submitting" || mode === "terminal";

  return (
    <div className={className} data-testid="chat-bar">
      {statusLine && <p className="chat-bar-status">{statusLine}</p>}
      {isExhausted && exhaustedReasons.length > 0 && (
        <div className="chat-bar-exhausted-reasons">
          <span>Reasons:</span>
          {exhaustedReasons.map((r, i) => (
            <span key={i} className="chat-bar-exhausted-reason-chip">
              {r.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}
      <textarea
        className="chat-bar-textarea"
        placeholder={placeholder}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={onKeyDown}
        maxLength={REVIEW_EDIT_NOTES_MAX}
        rows={3}
        disabled={textareaDisabled}
        data-testid="chat-bar-textarea"
      />
      <div className="chat-bar-meta">
        <span className="chat-bar-counter" aria-live="polite">
          {trimmedLength} / {REVIEW_EDIT_NOTES_MAX}
        </span>
        <div className="chat-bar-actions">
          {mode === "submitting" && (
            <button
              type="button"
              className="chat-bar-cancel-refine"
              onClick={handleCancelRefine}
              data-testid="chat-bar-cancel-refine"
              title="Unlock the panel without cancelling the agent's refine work"
            >
              Cancel refine (unlock panel)
            </button>
          )}
          {allowEdit && (
            <button
              type="button"
              className="btn edit"
              onClick={handleEdit}
              disabled={!canSubmitEdit}
              data-testid="chat-bar-edit"
              title="Send the agent additional context and re-plan (Cmd/Ctrl+Enter)"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="btn reject"
            onClick={handleReject}
            disabled={!canDecide}
            data-testid="chat-bar-reject"
          >
            Reject
          </button>
          <button
            type="button"
            className="btn approve"
            onClick={handleApprove}
            disabled={!canDecide || isExhausted}
            data-testid="chat-bar-approve"
            title={
              isExhausted
                ? "Approve disabled on exhausted runs — reject to terminate. Override-and-proceed is Week-2 polish."
                : undefined
            }
          >
            Approve
          </button>
        </div>
      </div>
      {/*
        Week-2a gate-decision-model — Terminate affordance.
        Secondary-row danger link (NOT a button in the action group)
        so the visual hierarchy keeps Approve/Edit/Reject as primary
        and Terminate as escape-hatch. Two-step confirmation (arm
        via first click, commit via second click within
        TERMINATE_CONFIRM_MS) is the destructive-action discipline:
        Terminate is a wire-level kill that can't be undone once
        committed. Renders in BOTH decision-required AND submitting
        states so a wedged refine can still be killed (reviewer
        can't rescue a hung run via Cancel-refine alone — that's
        UI-only).
      */}
      {canTerminate && (
        <div className="chat-bar-terminate-row">
          <button
            type="button"
            className={
              terminateArmedAt !== null
                ? "chat-bar-terminate-link armed"
                : "chat-bar-terminate-link"
            }
            onClick={handleTerminate}
            data-testid="chat-bar-terminate"
            title={
              terminateArmedAt !== null
                ? "Click again to confirm — ends the run immediately"
                : "End this run entirely (requires confirmation click)"
            }
          >
            {terminateArmedAt !== null
              ? "─ Really terminate? (click again within 3s to confirm) ─"
              : "─ Terminate run (end ticket) ─"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Helpers ---------- */

interface StepBucket {
  frames: Frame[];
  status: StepStatus;
}

function bucketByStep(frames: Frame[]): Map<StepId, StepBucket> {
  const buckets = new Map<StepId, StepBucket>();
  for (const id of STEP_IDS) {
    buckets.set(id, { frames: [], status: "pending" });
  }
  for (const f of frames) {
    if (f.stepId === "agent") continue;
    const bucket = buckets.get(f.stepId);
    if (!bucket) continue;
    bucket.frames.push(f);
  }
  for (const [, bucket] of buckets) {
    bucket.status = deriveStepStatus(bucket.frames);
  }
  return buckets;
}

function deriveStepStatus(frames: Frame[]): StepStatus {
  if (frames.length === 0) return "pending";
  // Week-2a ux-polish — use the LATEST lifecycle frame, not any-ever
  // aggregation. On refine / backtrack runs the same stepId emits
  // {started, completed, started, completed, ...} across passes; the
  // pre-polish any-ever logic stuck on "completed" after pass 1 and
  // never surfaced subsequent "running" transitions. `findLast`
  // captures whichever lifecycle edge was most recent, so pass-2
  // step.started correctly flips the LEFT-column status back to
  // running (and the Week-2a shimmer selector activates).
  //
  // The review-gate awaiting branch is preserved via `hasPendingReview`
  // — a gate that emitted review.requested without a matching
  // review.decided is "awaiting" regardless of its step.* lifecycle
  // state. review.decided flips back to running until the terminal
  // step.completed emits.
  const latestLifecycle = frames.findLast(
    (f) =>
      f.type === "step.started" ||
      f.type === "step.completed" ||
      f.type === "step.failed",
  );
  const hasPendingReview =
    frames.some((f) => f.type === "review.requested") &&
    !frames.some((f) => f.type === "review.decided");

  if (hasPendingReview) return "awaiting";
  if (!latestLifecycle) return "pending";
  if (latestLifecycle.type === "step.failed") return "failed";
  if (latestLifecycle.type === "step.started") return "running";
  return "completed";
}

function deriveRunStatus(frames: Frame[]): StepStatus | "ok" | "rejected" {
  const completed = frames.find((f) => f.type === "run.completed") as
    | (Frame & { status?: string })
    | undefined;
  if (completed) {
    const s = completed.status;
    if (s === "ok") return "ok";
    if (s === "rejected") return "rejected";
    if (s === "failed") return "failed";
  }
  if (frames.some((f) => f.type === "run.failed")) return "failed";
  if (
    frames.some((f) => f.type === "review.requested") &&
    !frames.some((f) => f.type === "review.decided")
  ) {
    return "awaiting";
  }
  if (frames.some((f) => f.type === "run.started")) return "running";
  return "pending";
}

/** Strip directory components from a path. The agent's screenshot frames
 *  carry absolute POSIX paths like /workspace/.playwright-videos/<runId>/<seq>.png. */
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function describeDecision(frames: Frame[]): string {
  const d = frames.find((f) => f.type === "review.decided") as
    | (Frame & { decision?: string; by?: string })
    | undefined;
  if (!d) return "(unknown)";
  return `${d.decision} by ${d.by}`;
}

function short(s: string, len: number): string {
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

function computeMsBetween(a: string, b: string): number | null {
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return null;
  return Math.max(0, bt - at);
}
