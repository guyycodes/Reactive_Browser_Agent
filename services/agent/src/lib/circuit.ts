import { logger } from "../logger.js";

/**
 * Reusable circuit-breaker primitive (Commit 7b.i).
 *
 * Shape
 * -----
 * - A **named-instance registry**: one `CircuitBreaker` per logical upstream
 *   (`getCircuit("anthropic")`, `getCircuit("rag")`, …). State is a
 *   cross-run property — if Anthropic is 500-ing, every in-flight triage
 *   run should observe the same open circuit. Matches Hystrix / Polly /
 *   Istio conventions.
 * - A **three-state machine** (closed → open → half-open) with a sliding
 *   failure window + cooldown + single-probe recovery.
 * - **Composed retry** inside `execute`: exponential backoff against
 *   transient errors, failures that exhaust retries count toward the
 *   breaker's threshold, and an outer `deadlineMs` caps total wall-clock.
 *
 * Pager integration contract (documented, not yet wired)
 * ------------------------------------------------------
 * Every state transition emits a structured pino log line at `warn` level
 * with a fixed `event: "circuit_breaker.state_change"` field. To page on
 * LLM outage, a future log processor filters:
 *
 *     event == "circuit_breaker.state_change" AND to == "open" AND circuit == "anthropic"
 *
 * Payload carries `runId + stepId + lastError` so the pager page can
 * deep-link to the affected run. Two supporting events at the same
 * namespace: `circuit_breaker.request_rejected` (warn) when an open
 * circuit refuses a call — helps quantify blast radius for incident
 * post-mortem — and `circuit_breaker.retry_attempt` (debug) per retry
 * inside `execute` for investigation.
 *
 * No pager integration lands in 7b.i itself; this is the log trail only.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  retry: {
    attempts: number;
    minTimeoutMs: number;
    maxTimeoutMs: number;
    factor: number;
    deadlineMs: number;
  };
  breaker: {
    failureThreshold: number;
    windowMs: number;
    cooldownMs: number;
  };
  /** Return true if `err` is transient enough to retry. Defaults to
   *  5xx + network + Anthropic APIConnectionError*. Always returns false
   *  for errors marked `streamResumeNotSafe === true` (see
   *  `streamMapper.ts` — a mid-stream disconnect can't be resumed without
   *  risking duplicate deltas in the bus). */
  isRetriable?: (err: unknown) => boolean;
  /** Test hook: fires on every state transition. NOT intended as a pager
   *  hook — pagers should filter the structured log trail instead. */
  onStateChange?: (e: StateChangeEvent) => void;
}

export interface StateChangeEvent {
  circuit: string;
  from: CircuitState;
  to: CircuitState;
  reason:
    | "failure_threshold_exceeded"
    | "cooldown_elapsed"
    | "probe_succeeded"
    | "probe_failed"
    | "manual_reset";
  failuresInWindow: number;
  at: number;
  lastError: { message: string; status?: number; code?: string } | null;
  runId: string | null;
  stepId: string | null;
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly circuit: string,
    public readonly retryAfterMs: number,
  ) {
    super(`circuit ${circuit} is open (retry after ${retryAfterMs}ms)`);
    this.name = "CircuitOpenError";
  }
}

export function defaultOptions(): CircuitBreakerOptions {
  return {
    retry: {
      attempts: 3,
      minTimeoutMs: 500,
      maxTimeoutMs: 15_000,
      factor: 2,
      deadlineMs: 90_000,
    },
    breaker: {
      failureThreshold: 5,
      windowMs: 60_000,
      cooldownMs: 30_000,
    },
  };
}

/**
 * Default retriability predicate.
 *
 * Retriable:
 *   - HTTP 5xx (`err.status >= 500` — Anthropic SDK surfaces this on
 *     transient server errors).
 *   - Network-level error codes: ECONNRESET, ECONNREFUSED, ETIMEDOUT,
 *     EPIPE, EAI_AGAIN.
 *   - Anthropic-SDK classes: APIConnectionError, APIConnectionTimeoutError.
 *   - Fallback: message containing "api_error" (Anthropic sometimes
 *     wraps transient errors without a numeric status — the verify-step
 *     smoke in 7a.v hit one of these).
 *
 * Non-retriable:
 *   - `streamResumeNotSafe === true` — set by streamMapper.ts when
 *     deltas have already been emitted on the failed attempt. Retrying
 *     would duplicate text in the reviewer feed.
 *   - HTTP 4xx (won't get better on retry).
 *   - CircuitOpenError (never retry our own signal).
 *   - AbortError / aborted-signal-triggered errors.
 */
export function defaultIsRetriable(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
    streamResumeNotSafe?: boolean;
  };
  if (e.streamResumeNotSafe === true) return false;
  if (e.name === "CircuitOpenError") return false;
  if (e.name === "AbortError") return false;
  if (typeof e.status === "number") {
    if (e.status >= 500) return true;
    if (e.status >= 400) return false;
  }
  if (typeof e.code === "string") {
    const net = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "EAI_AGAIN",
    ]);
    if (net.has(e.code)) return true;
  }
  if (
    e.name === "APIConnectionError" ||
    e.name === "APIConnectionTimeoutError"
  ) {
    return true;
  }
  if (typeof e.message === "string" && /api_error/i.test(e.message)) {
    return true;
  }
  return false;
}

function summarizeError(
  err: unknown,
): { message: string; status?: number; code?: string } {
  if (err == null || typeof err !== "object") {
    return { message: String(err) };
  }
  const e = err as { message?: string; status?: number; code?: string };
  const out: { message: string; status?: number; code?: string } = {
    message:
      typeof e.message === "string"
        ? e.message.slice(0, 500)
        : String(err),
  };
  if (typeof e.status === "number") out.status = e.status;
  if (typeof e.code === "string") out.code = e.code;
  return out;
}

/** Identify a deadline-timer abort so it isn't mistaken for an external
 *  user cancellation (which is treated differently — not counted toward
 *  the failure threshold). */
function isDeadlineAbort(err: unknown): boolean {
  return err instanceof Error && /deadline .* hit/.test(err.message);
}

/** Abortable sleep. Resolves after `ms` or rejects immediately if the
 *  signal fires. Used between retry attempts so an external cancel
 *  cuts through the backoff wait without a further delay. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures: number[] = []; // Date.now() timestamps, sliding window
  private openedAt: number | null = null;
  private halfOpenInFlight = false;
  private readonly opts: CircuitBreakerOptions;

  constructor(public readonly name: string, opts: CircuitBreakerOptions) {
    this.opts = opts;
  }

  /** Current state. Lazily transitions `open → half-open` if the cooldown
   *  has elapsed; the check runs on every `execute` call and every
   *  `getState` probe so time-based transitions don't require a timer. */
  getState(): CircuitState {
    if (this.state === "open" && this.openedAt != null) {
      if (Date.now() - this.openedAt >= this.opts.breaker.cooldownMs) {
        this.transition("open", "half-open", "cooldown_elapsed", null, null, null);
      }
    }
    return this.state;
  }

  /** Test-only: force-reset to closed, wipe all counters. Equivalent to
   *  constructing a fresh breaker with the same options. Not in any
   *  production hot path. */
  reset(): void {
    const prev = this.state;
    this.state = "closed";
    this.failures = [];
    this.openedAt = null;
    this.halfOpenInFlight = false;
    if (prev !== "closed") {
      this.transition(prev, "closed", "manual_reset", null, null, null);
    }
  }

  /**
   * Run `fn` through the circuit with composed retry.
   *
   *   - If the breaker is `open` and the cooldown hasn't elapsed → throw
   *     `CircuitOpenError` without invoking `fn`.
   *   - If `half-open` and no probe is in flight → allow this single call
   *     as the probe. Concurrent calls during a probe also fast-fail.
   *   - On failure: retry up to `retry.attempts` times with exponential
   *     backoff (capped by `retry.maxTimeoutMs`), bailing early on
   *     non-retriable errors, external aborts, or the total `deadlineMs`.
   *   - A call that exhausts its retries and throws counts as **one**
   *     failure toward `breaker.failureThreshold`.
   *
   * External aborts (via `ctx.signal`) cancel the retry loop immediately
   * and do NOT count toward the threshold — the upstream is presumably
   * healthy, the user/system just changed their mind.
   */
  async execute<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    ctx?: { runId?: string; stepId?: string; signal?: AbortSignal },
  ): Promise<T> {
    const runId = ctx?.runId ?? null;
    const stepId = ctx?.stepId ?? null;
    const externalSignal = ctx?.signal;

    const initialState = this.getState();

    if (initialState === "open") {
      const retryAfterMs =
        this.openedAt != null
          ? Math.max(
              0,
              this.opts.breaker.cooldownMs - (Date.now() - this.openedAt),
            )
          : this.opts.breaker.cooldownMs;
      logger.warn(
        {
          event: "circuit_breaker.request_rejected",
          circuit: this.name,
          retryAfterMs,
          failuresInWindow: this.failures.length,
          runId,
          stepId,
        },
        `[circuit:${this.name}] request rejected; retry after ${retryAfterMs}ms`,
      );
      throw new CircuitOpenError(this.name, retryAfterMs);
    }

    if (initialState === "half-open") {
      if (this.halfOpenInFlight) {
        logger.warn(
          {
            event: "circuit_breaker.request_rejected",
            circuit: this.name,
            retryAfterMs: 0,
            failuresInWindow: this.failures.length,
            runId,
            stepId,
            reason: "probe_in_flight",
          },
          `[circuit:${this.name}] request rejected; half-open probe in flight`,
        );
        throw new CircuitOpenError(this.name, 0);
      }
      this.halfOpenInFlight = true;
    }

    // Internal AbortController gates both the outer deadline and fn's
    // signal. External aborts propagate in; the deadline fires internally.
    const ac = new AbortController();
    const onExternalAbort = (): void => {
      ac.abort(externalSignal?.reason ?? new Error("external abort"));
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        ac.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    const deadlineTimer = setTimeout(() => {
      ac.abort(
        new Error(
          `[circuit:${this.name}] deadline ${this.opts.retry.deadlineMs}ms hit`,
        ),
      );
    }, this.opts.retry.deadlineMs);

    let lastError: unknown = null;
    try {
      for (let attempt = 1; attempt <= this.opts.retry.attempts; attempt++) {
        if (ac.signal.aborted) {
          throw ac.signal.reason ?? new Error(`[circuit:${this.name}] aborted`);
        }
        try {
          const result = await fn(ac.signal);
          // Success.
          if (initialState === "half-open") {
            this.halfOpenInFlight = false;
            const prev = this.state;
            this.failures = [];
            this.openedAt = null;
            this.transition(prev, "closed", "probe_succeeded", null, runId, stepId);
          }
          return result;
        } catch (err) {
          lastError = err;
          const externalAborted =
            externalSignal?.aborted === true && !isDeadlineAbort(err);
          if (externalAborted) {
            throw err;
          }
          const isRetriable = (this.opts.isRetriable ?? defaultIsRetriable)(err);
          if (!isRetriable || attempt === this.opts.retry.attempts) {
            throw err;
          }
          const nextDelayMs = Math.min(
            this.opts.retry.maxTimeoutMs,
            this.opts.retry.minTimeoutMs *
              Math.pow(this.opts.retry.factor, attempt - 1),
          );
          logger.debug(
            {
              event: "circuit_breaker.retry_attempt",
              circuit: this.name,
              attempt,
              nextDelayMs,
              lastError: summarizeError(err),
              runId,
              stepId,
            },
            `[circuit:${this.name}] attempt ${attempt} failed; retrying in ${nextDelayMs}ms`,
          );
          await abortableDelay(nextDelayMs, ac.signal);
        }
      }
      throw lastError;
    } catch (finalErr) {
      const externalAborted =
        externalSignal?.aborted === true && !isDeadlineAbort(finalErr);
      if (!externalAborted) {
        this.failures.push(Date.now());
        this.prune();
        if (initialState === "half-open") {
          this.halfOpenInFlight = false;
          this.openedAt = Date.now();
          this.transition(
            "half-open",
            "open",
            "probe_failed",
            finalErr,
            runId,
            stepId,
          );
        } else if (
          this.state === "closed" &&
          this.failures.length >= this.opts.breaker.failureThreshold
        ) {
          this.openedAt = Date.now();
          this.transition(
            "closed",
            "open",
            "failure_threshold_exceeded",
            finalErr,
            runId,
            stepId,
          );
        }
      } else if (initialState === "half-open") {
        // External abort during a half-open probe: release the flag
        // without counting the failure. The breaker stays half-open
        // until the next execute probes again or a cooldown lapses
        // (which it already did to get here).
        this.halfOpenInFlight = false;
      }
      throw finalErr;
    } finally {
      clearTimeout(deadlineTimer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.opts.breaker.windowMs;
    this.failures = this.failures.filter((t) => t >= cutoff);
  }

  private transition(
    from: CircuitState,
    to: CircuitState,
    reason: StateChangeEvent["reason"],
    lastError: unknown,
    runId: string | null,
    stepId: string | null,
  ): void {
    this.state = to;
    const event: StateChangeEvent = {
      circuit: this.name,
      from,
      to,
      reason,
      failuresInWindow: this.failures.length,
      at: Date.now(),
      lastError: lastError ? summarizeError(lastError) : null,
      runId,
      stepId,
    };
    logger.warn(
      {
        event: "circuit_breaker.state_change",
        ...event,
        windowMs: this.opts.breaker.windowMs,
        cooldownMs: this.opts.breaker.cooldownMs,
      },
      `[circuit:${this.name}] ${from} → ${to} (${reason})`,
    );
    this.opts.onStateChange?.(event);
  }
}

// ===== Named-instance registry =====

const circuits = new Map<string, CircuitBreaker>();

/**
 * Get or create the named circuit.
 *
 * Registry semantics (Hystrix / Polly convention):
 *   - First call with `name` creates the breaker using the supplied
 *     `opts` (or `defaultOptions()` if omitted).
 *   - Subsequent calls return the same instance and **silently ignore**
 *     `opts` — "first call wins." To swap config at runtime, call
 *     `resetAllCircuits()` (or introduce a dedicated updateOptions()
 *     helper in a future commit when the use-case arrives).
 *
 * The expectation is that exactly one module (typically the primary
 * consumer — e.g., `streamMapper.ts` for `"anthropic"`) passes `opts` at
 * module-load time, and all other call sites just retrieve the
 * singleton.
 */
export function getCircuit(
  name: string,
  opts?: CircuitBreakerOptions,
): CircuitBreaker {
  let c = circuits.get(name);
  if (!c) {
    c = new CircuitBreaker(name, opts ?? defaultOptions());
    circuits.set(name, c);
  }
  return c;
}

/** Test-only. Wipes the registry so subsequent `getCircuit(name)` calls
 *  return fresh instances. */
export function resetAllCircuits(): void {
  circuits.clear();
}
