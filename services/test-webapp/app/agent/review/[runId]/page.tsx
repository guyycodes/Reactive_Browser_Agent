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
type StepId = (typeof STEP_IDS)[number] | "agent" | "block1";
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
  log_and_notify: "log_and_notify",
  block1: "block 1",
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
    const lastIsEdit = lastDecision?.decision === "edit";

    if (!lastIsEdit && decisions.length >= reqs.length) return null;
    return (reqs[reqs.length - 1] as ReviewRequestedFrame) ?? null;
  }, [frames]);

  // 7b.iii.b-pre-exec-edit-ui — `decide` widens to support the edit
  // path. `opts.stepId` routes the decision to the correct bus slot
  // (commit 1's per-stepId decision API); defaults to "review_gate"
  // server-side when absent. `opts.notes` rides PlanPatchSchema.notes
  // on decision="edit" to trigger Block 1's pre-exec refine loop.
  const decide = useCallback(
    (
      decision: "approve" | "reject" | "edit",
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

      {pendingReview && (
        <ReviewPanel
          onApprove={() => decide("approve", { stepId: pendingReview.stepId })}
          onReject={() => decide("reject", { stepId: pendingReview.stepId })}
          onEdit={(notes) =>
            decide("edit", { notes, stepId: pendingReview.stepId })
          }
          request={pendingReview}
          disabled={connStatus !== "open"}
        />
      )}

      {!pendingReview && frames.some((f) => f.type === "review.decided") && (
        <div className="review-panel decided">
          <div className="review-info">
            <h3>Review decided</h3>
            <p>{describeDecision(frames)} — no further action needed.</p>
          </div>
        </div>
      )}
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

type FeedItem =
  | { kind: "divider"; key: string; stepId: StepId; phase: "start" | "complete" | "failed"; durationMs?: number; errorMsg?: string; iterationId?: string }
  | FeedBubble
  | FeedTool
  | FeedIterationDivider
  | FeedBlockDivider
  | FeedBacktrackBanner
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
    if (shouldAutoScroll) {
      // Commit 7a.v — scroll anchor: call scrollIntoView on the last DOM
      // child rather than mutating scrollTop to scrollHeight. Combined
      // with `.behavior-feed > * { scroll-margin-top: 33vh }` in CSS,
      // the newest feed item anchors at ~1/3 from viewport top —
      // deterministic regardless of frame height, so typewriter-growing
      // bubbles fill downward from a stable anchor point instead of
      // drifting below the fold.
      const last = el.lastElementChild;
      if (last) last.scrollIntoView({ block: "start", behavior: "auto" });
    }
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

/* ---------- ReviewPanel (7b.iii.b-pre-exec-edit-ui — adds Edit path) ---------- */

function ReviewPanel(props: {
  onApprove: () => void;
  onReject: () => void;
  /** 7b.iii.b-pre-exec-edit-ui — commit 2's pre-exec refine loop
   *  consumes `patch.notes` from a decision=edit and re-runs Block 1
   *  with the reviewer's note threaded into `priorObservations`.
   *  ReviewPanel now exposes this as a textarea flow gated by an
   *  explicit Edit button. */
  onEdit: (notes: string) => void;
  request: ReviewRequestedFrame;
  disabled: boolean;
}) {
  type PanelMode = "default" | "edit" | "submitting";
  const [mode, setMode] = useState<PanelMode>("default");
  const [notes, setNotes] = useState("");
  /** 7b.iii.b-pre-exec-edit-ui — planId of the review.requested that
   *  was showing when the reviewer submitted an Edit. Used to detect
   *  the server's response — a fresh review.requested with a new
   *  planId means Block 1 finished re-planning and it's safe to
   *  re-enable the panel. Closes the double-submit window during the
   *  ~2-5 minute Block-1 re-run. */
  const [submittedAtPlanId, setSubmittedAtPlanId] = useState<string | null>(null);

  const actionCount = props.request.plan.actionCount ?? 0;
  const destructive = props.request.plan.destructive ?? false;
  const currentPlanId = props.request.plan.planId;

  // Auto-exit submitting mode when a fresh review.requested arrives
  // (detected by planId delta). Defensive reset clears all edit-mode
  // state so a subsequent Edit click starts from a clean slate.
  useEffect(() => {
    if (
      mode === "submitting" &&
      submittedAtPlanId &&
      currentPlanId !== submittedAtPlanId
    ) {
      setMode("default");
      setSubmittedAtPlanId(null);
      setNotes("");
    }
  }, [mode, submittedAtPlanId, currentPlanId]);

  // Commit 7b.iii.a — exhausted-passes path. When the Block 1
  // controller hit its BLOCK1_MAX_PASSES cap without producing a
  // viable plan, the review.requested frame carries a populated
  // `blockResult` field. UI renders a distinct "exhausted" banner
  // with the per-pass reasons + disables the approve button.
  //
  // 7b.iii.b-pre-exec-edit-ui — Edit is NOT offered on the exhausted
  // path: Block 1 already spent its internal 3-pass budget, so
  // soliciting reviewer notes would just trip the refine-loop budget
  // with the same upstream cause. Reject-only remains correct here;
  // override-and-proceed is Week-2 polish.
  const blockResult = props.request.blockResult;
  const isExhausted = blockResult?.passedLast === false;

  if (isExhausted) {
    const passes = blockResult?.passes ?? 0;
    const reasons = Array.isArray(blockResult?.allReasons)
      ? blockResult!.allReasons!
      : [];
    return (
      <div className="review-panel exhausted" data-testid="review-panel-exhausted">
        <div className="review-info">
          <h3>⚠ Block 1 exhausted — {passes} pass{passes === 1 ? "" : "es"} failed</h3>
          <p>
            The planning agent could not produce a viable plan within its iteration
            budget. Reject this run to terminate; override-and-proceed is deferred
            to Week-2 polish.
          </p>
          {reasons.length > 0 && (
            <p className="review-exhausted-reasons">
              Reasons: {reasons.map((r, i) => (
                <span key={i} className="review-exhausted-reason-chip">
                  {r.replace(/_/g, " ")}
                </span>
              ))}
            </p>
          )}
        </div>
        <div className="review-actions">
          <button className="btn reject" onClick={props.onReject} disabled={props.disabled}>
            Reject
          </button>
          <button
            className="btn approve"
            disabled
            title="Approve disabled on exhausted runs — reject to terminate. Override-and-proceed is Week-2 polish."
          >
            Approve
          </button>
        </div>
      </div>
    );
  }

  // 7b.iii.b commit 4 — post-exec review variant. Triggered when the
  // incoming review.requested carries reviewHint="post_exec" (emitted
  // by humanVerifyGateStep). Different question than pre-exec:
  //   - Pre-exec: "does this plan look right?" (approve / edit / reject)
  //   - Post-exec: "did execution achieve the goal?" (approve / reject only)
  //
  // Edit is DELIBERATELY HIDDEN on this path. Rationale:
  //   The server-side humanVerifyGateStep treats decision="edit" as
  //   equivalent to "approve" (both take the happy path, ending the
  //   run). Showing an Edit button that means the same thing as
  //   Approve is confusing UX. Worse, the ReviewPanel's submitting-mode
  //   state machine (planId-delta auto-exit via `submittedAtPlanId`)
  //   assumes an Edit triggers a fresh review.requested. Post-exec
  //   edit wouldn't produce one — the gate returns happy-path to
  //   logAndNotifyStep — so the UI would wedge forever in submitting
  //   mode with only the Cancel-refine escape hatch. Hiding Edit
  //   prevents this wedge. If post-exec "approve with audit note" is
  //   wanted later, either (a) change the server semantic to have
  //   edit not terminate, or (b) use a separate text field on approve.
  //   DO NOT re-enable Edit here without also changing the server.
  //
  // Branches BEFORE submitting-mode check because post-exec has no
  // Edit path to put it into submitting — this block is terminal for
  // the post-exec panel.
  const isPostExec = props.request.reviewHint === "post_exec";

  if (isPostExec) {
    return (
      <div className="review-panel post-exec" data-testid="review-panel-post-exec">
        <div className="review-info">
          <h3>Post-execution review</h3>
          <p>
            Did the agent achieve the ticket&apos;s goal? Evidence is in the
            behavior feed above — check the <code>execute:*</code> screenshots
            and the verify output. Reject triggers a backtrack through Block 1
            (max {MAX_BACKTRACKS_UI} retries per run).
          </p>
        </div>
        <div className="review-actions">
          <button
            className="btn reject"
            onClick={props.onReject}
            disabled={props.disabled}
            data-testid="review-post-exec-reject"
          >
            Reject (backtrack)
          </button>
          <button
            className="btn approve"
            onClick={props.onApprove}
            disabled={props.disabled}
            data-testid="review-post-exec-approve"
          >
            Approve (complete)
          </button>
        </div>
      </div>
    );
  }

  // Submitting mode — Block 1 is re-running with the reviewer's note.
  // All primary controls disabled; waiting for the fresh
  // review.requested to arrive (detected via the planId-delta effect
  // above). A local escape hatch is always available (see comment
  // on the Cancel-refine button).
  if (mode === "submitting") {
    return (
      <div className="review-panel submitting" data-testid="review-panel-submitting">
        <div className="review-info">
          <h3>Re-planning…</h3>
          <p>
            Block 1 is re-running with your note as a prior observation.
            The refined plan will appear here in a few seconds.
          </p>
        </div>
        <div className="review-actions">
          <button className="btn btn-ghost" disabled aria-busy="true">
            Waiting for refined plan…
          </button>
          {/*
            7b.iii.b-pre-exec-edit-ui — local-only escape hatch.
            Resets UI state to default mode; does NOT cancel the
            server-side Block 1 refine (it can't be interrupted
            mid-flight in this release). Intended for two cases:
              (a) reviewer regret after Submit;
              (b) pathological wedge where the fresh review.requested
                  never arrives (Block 1 bug, network loss, etc.).
            When the fresh review.requested DOES arrive later, it
            replaces `pendingReview` via the memo and the panel
            renders it in default mode. Any approve/reject clicked
            on the stale panel between Cancel-refine and the fresh
            request arriving lands in the bus's stale-discard path
            (commit-1 semantics) and is logged but not acted on —
            reviewer must re-click once the fresh request appears.
          */}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setMode("default");
              setSubmittedAtPlanId(null);
              setNotes("");
            }}
            data-testid="review-refine-cancel"
            title="Unlock the panel without cancelling the agent's refine work"
          >
            Cancel refine (unlock panel)
          </button>
        </div>
      </div>
    );
  }

  // Edit mode — textarea + submit/cancel. Submit transitions the
  // panel into submitting mode and fires props.onEdit(trimmed) which
  // sends WS review.decide(edit, {notes}). The server emits a fresh
  // review.requested after Block 1 re-runs; the planId-delta effect
  // above flips us back to default mode when that arrives.
  if (mode === "edit") {
    const trimmed = notes.trim();
    const canSubmit =
      trimmed.length > 0 &&
      trimmed.length <= REVIEW_EDIT_NOTES_MAX &&
      !props.disabled;
    return (
      <div className="review-panel edit-mode" data-testid="review-panel-edit">
        <div className="review-info">
          <h3>Guide the agent · re-plan</h3>
          <p>
            Tell the planning agent what additional context or constraint to
            apply, then submit to re-run Block 1. Your note is threaded into
            the next planning pass as a prior observation. Up to 2 refines
            per run.
          </p>
        </div>
        <form
          className="review-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            setSubmittedAtPlanId(currentPlanId);
            setMode("submitting");
            props.onEdit(trimmed);
          }}
        >
          <textarea
            className="review-edit-notes"
            placeholder="e.g., the target user is jane@example.com; use the Unlock Account runbook, not Password Reset"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={REVIEW_EDIT_NOTES_MAX}
            rows={4}
            autoFocus
            data-testid="review-edit-notes"
          />
          <div className="review-edit-meta">
            <span className="review-edit-counter" aria-live="polite">
              {trimmed.length} / {REVIEW_EDIT_NOTES_MAX}
            </span>
            <div className="review-edit-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setMode("default");
                  setNotes("");
                }}
                data-testid="review-edit-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!canSubmit}
                data-testid="review-edit-submit"
              >
                Submit &amp; re-plan
              </button>
            </div>
          </div>
        </form>
      </div>
    );
  }

  // Default mode — three buttons (Edit | Reject | Approve).
  return (
    <div className="review-panel">
      <div className="review-info">
        <h3>Review requested</h3>
        <p>
          {actionCount} action{actionCount === 1 ? "" : "s"}
          {destructive ? " · ⚠ destructive" : ""}
        </p>
      </div>
      <div className="review-actions">
        <button
          className="btn edit"
          onClick={() => setMode("edit")}
          disabled={props.disabled}
          data-testid="review-edit-btn"
          title="Send the agent additional context and re-plan"
        >
          Edit
        </button>
        <button className="btn reject" onClick={props.onReject} disabled={props.disabled}>
          Reject
        </button>
        <button className="btn approve" onClick={props.onApprove} disabled={props.disabled}>
          Approve
        </button>
      </div>
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
  const hasStarted = frames.some((f) => f.type === "step.started");
  const hasCompleted = frames.some((f) => f.type === "step.completed");
  const hasFailed = frames.some((f) => f.type === "step.failed");
  const hasReviewRequested = frames.some((f) => f.type === "review.requested");
  const hasReviewDecided = frames.some((f) => f.type === "review.decided");

  if (hasFailed) return "failed";
  if (hasCompleted) return "completed";
  if (hasReviewRequested && !hasReviewDecided) return "awaiting";
  if (hasStarted) return "running";
  return "pending";
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
