import { AsyncLocalStorage } from "node:async_hooks";
import type { EventBus } from "../events/bus.js";
import type { BrowserSession } from "./tools/playwrightMcp.js";

/**
 * Per-run ambient context, carried through async boundaries via
 * `AsyncLocalStorage`.
 *
 * Why
 * ---
 * Mastra's `createStep({ execute })` receives a fixed set of parameters
 * (`inputData`, `suspend`, `resumeData`, `state`, ...) but no user-defined
 * per-run context. We need to plumb `{runId, bus}` into every step so
 * helpers (LLM stream mapper, tool wrappers) can publish envelope frames
 * without us passing those two arguments through every layer.
 *
 * `AsyncLocalStorage.run(ctx, fn)` sets `ctx` as the ambient context for
 * `fn` and every async task it spawns — the value is resolved by
 * `getStore()` from any descendant call, including inside step execute
 * functions that Mastra invokes on our behalf.
 *
 * Cleanup: the storage slot is automatically cleared when the `.run()`
 * callback returns or throws. No manual dispose needed.
 *
 * =====================================================================
 * CTX SPREAD INVARIANT (7b.iii.b commit 5 — docs-sync) — READ BEFORE
 * ADDING A withRunContext({ ...ctx, <override> }, fn) CALL.
 * =====================================================================
 *
 * `AsyncLocalStorage.run(store, fn)` wraps the STORE OBJECT REFERENCE
 * passed in — no clone. `withRunContext({ ...ctx, ... }, fn)` creates
 * a NEW spread object and sets THAT as the store inside fn. Any
 * mutation to `getRunContext().<field>` inside fn lands on the SPREAD
 * copy and is LOST when the scope unwinds; the outer ctx never sees it.
 *
 * Field mutability classification (current):
 *   - Read-only-safe to spread:
 *       `runId`, `bus`, `ticket`, `priorObservations`.
 *     These are only READ from the ambient ctx (see prompt builders
 *     in triage.ts). Spread copies work because callees don't mutate
 *     them.
 *   - DO NOT spread around:
 *       `browser` (set by `runDryRunStep` at
 *       `src/mastra/workflows/triage.ts`, consumed by `executeStep`).
 *     `runDryRunStep` mutates `getRunContext().browser = session`. If
 *     this mutation lands on a spread copy, `executeStep` reads the
 *     outer ctx and sees `browser: undefined` (or a stale reference
 *     to a pre-close-ed session). Canonical failure signature:
 *       `tool.failed { name: "playwright.session_check",
 *                       error: "no browser session on RunContext" }`
 *     — the "Bug A" pattern. Also manifests (post-hotfix-1 on the
 *     initial scope) as `executeStep` crashing with "cannot invoke
 *     playwright.browser_snapshot: session already closed" when the
 *     pre-close inside `runDryRunStep` closes the outer's session
 *     via the shallow-copied reference.
 *
 * Causal history — three scope boundaries have been bitten by this:
 *   1. `blockController.ts runBlock1`: inner cognitive spread wrapped
 *      dry_run along with classify/retrieve/plan. Fixed in
 *      7b.iii.b-2-hotfix-1 (moved dry_run to outer scope).
 *   2. `runReviewGateStep` refine loop: outer spread around
 *      `runBlock1Impl`. Fixed in 7b.iii.b-pre-exec-edit-ui-hotfix-2
 *      (removed spread; thread observations via
 *      `runBlock1(..., { seedObservations: ... })` instead).
 *   3. `humanVerifyGateStep` backtrack loop: same outer-spread
 *      pattern. Fixed in-comment during hotfix-2 so commit 4's
 *      un-park inherited the correct shape.
 *
 * Authoritative pathway for cross-invocation observations: pass
 * `seedObservations` as an opt on `runBlock1(input, deps, opts)`. The
 * controller seeds its internal accumulator from that array on entry.
 * `ctx.priorObservations` is READ by classify/retrieve/plan step
 * bodies but MUST NOT be SET via a spread around `runBlock1` — the
 * inner cognitive spread overrides it with the controller's own
 * observations array, silently dropping the caller's value.
 *
 * Audit recipe when touching ctx-spread patterns:
 *   rg 'withRunContext\(\{\s*\.\.\.' services/agent
 * Every match must be audited against the Field mutability
 * classification above. If a NEW mutable field is added to
 * RunContext, update this docblock AND audit every existing spread
 * call site.
 * =====================================================================
 */

export interface RunContext {
  runId: string;
  bus: EventBus;
  /** Optional Playwright MCP browser session.
   *
   *  Lifecycle (Week-2b-runtime):
   *  - `runDryRunStep` populates this field via `launchBrowser`, after
   *    pre-closing any stale session (hotfix-1 pattern for intra-Block-1
   *    retries + refine + backtrack re-invocations).
   *  - `runExecuteStep` probes session liveness at entry via a snapshot
   *    call. On success: REUSES the session and invokes the executor
   *    with `resumeAtFirstDestructive: true`, skipping the
   *    non-destructive prefix that dry_run already walked. On failure
   *    (session dead, commonly from review_gate timeouts): pre-closes +
   *    fresh `launchBrowser`, runs the full skill card.
   *  - Closed by the workflow wrapper's `finally` in `http/triage.ts`.
   *
   *  The session-carry-over optimization is load-bearing for UX: the
   *  happy path skips 3-5s of re-login per run, and read-only skills
   *  (no destructive steps) become a correct no-op at execute. The
   *  graceful-fallback path costs one cheap probe call (~200ms) when
   *  the session IS alive and one extra launch when it isn't.
   *
   *  Not present during classify / retrieve / plan / review_gate /
   *  verify / log_and_notify. */
  browser?: BrowserSession;
  /** Commit 7b.ii-hotfix — the ticket payload from `POST /triage`,
   *  populated at workflow kickoff in `http/triage.ts`. Available to
   *  any step that calls `getRunContext().ticket` without threading it
   *  through Mastra inputData (Mastra only flows the PREVIOUS step's
   *  output forward, so steps after classify wouldn't otherwise see
   *  the raw ticket). `planStep` reads this to build its prompt;
   *  7b.iii's Block 1 loop controller will also read it when deciding
   *  whether to reclassify on a requiresContext=true plan. */
  ticket?: {
    ticketId: string;
    subject: string;
    submittedBy?: string;
  };
  /** Commit 7b.iii.a — observations carried forward across Block 1
   *  iteration passes. READ-ONLY from the ambient ctx by
   *  classify/retrieve/plan step bodies and by the reactRunner's
   *  buildSystem/buildUserMessage callbacks (each prepends a "Prior
   *  passes" block to its user message so Sonnet doesn't repeat
   *  earlier refusals).
   *
   *  7b.iii.b-pre-exec-edit-ui-hotfix-2 (commit 5 docs-sync) —
   *  SET via Block 1's internal cognitive spread
   *  `withRunContext({ ...ctx, priorObservations: [...observations] }, fn)`
   *  in `src/mastra/lib/blockController.ts:runBlock1`. That spread
   *  wraps classify/retrieve/plan ONLY; it is safe because those
   *  three step bodies do not mutate ctx (spread cycling is
   *  read-only). See `blockController.ts` DESIGN INVARIANT #2 +
   *  `runContext.ts` CTX SPREAD INVARIANT docblock above.
   *
   *  NOT SET from outside `runBlock1`. The previously-documented
   *  pattern `withRunContext({ ...ctx, priorObservations: [caller
   *  seed] }, () => runBlock1(...))` was DOUBLY BROKEN and has been
   *  removed at every call site:
   *    (a) The inner cognitive spread at blockController.ts
   *        overrides ctx.priorObservations with its own accumulator
   *        (starts empty). The caller's seed was silently dropped
   *        before any LLM saw it.
   *    (b) The outer spread trapped runDryRunStep's
   *        `ctx.browser = session` mutation, breaking executeStep.
   *  Authoritative caller pathway: pass
   *  `runBlock1(input, deps, { seedObservations: [...] })`. The
   *  controller seeds its internal `observations` array from opts
   *  on entry, which IS read during each pass's cognitive spread. */
  priorObservations?: string[];
}

const runContextStorage = new AsyncLocalStorage<RunContext>();

/** Run `fn` with the given context set as the ambient RunContext. All async
 *  descendants can call `getRunContext()` to retrieve it. */
export function withRunContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  return runContextStorage.run(ctx, fn);
}

/** Return the ambient RunContext. Throws if called outside a
 *  `withRunContext` scope — that's a programming bug, not a user error. */
export function getRunContext(): RunContext {
  const ctx = runContextStorage.getStore();
  if (!ctx) {
    throw new Error(
      "[runContext] getRunContext() called outside withRunContext scope. " +
        "This indicates a workflow step or LLM call ran without its run context set.",
    );
  }
  return ctx;
}

/** Soft variant — returns `null` if no context is set. Useful for generic
 *  utilities that want to be lenient when invoked from tests. */
export function tryGetRunContext(): RunContext | null {
  return runContextStorage.getStore() ?? null;
}
