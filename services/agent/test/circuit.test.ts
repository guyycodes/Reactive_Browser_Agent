import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  CircuitBreaker,
  CircuitOpenError,
  getCircuit,
  resetAllCircuits,
  type CircuitBreakerOptions,
  type StateChangeEvent,
} from "../src/lib/circuit.js";

/**
 * Commit 7b.i — circuit-breaker primitive.
 *
 * Tests exercise the three-state machine (closed / open / half-open),
 * composed retry semantics, external-abort non-counting, the
 * `streamResumeNotSafe` non-retriable marker, structured state-change
 * events, and the named-instance registry.
 *
 * All tests use `vi.useFakeTimers()` so retry delays + cooldown elapses
 * are deterministic. The shared `testOpts()` factory shortens every
 * threshold and timeout so a single pass runs in < 100 ms.
 */

const testOpts = (overrides?: Partial<CircuitBreakerOptions>): CircuitBreakerOptions => ({
  retry: {
    attempts: 3,
    minTimeoutMs: 100,
    maxTimeoutMs: 1_000,
    factor: 2,
    deadlineMs: 10_000,
    ...overrides?.retry,
  },
  breaker: {
    failureThreshold: 3,
    windowMs: 5_000,
    cooldownMs: 2_000,
    ...overrides?.breaker,
  },
  ...(overrides?.isRetriable ? { isRetriable: overrides.isRetriable } : {}),
  ...(overrides?.onStateChange ? { onStateChange: overrides.onStateChange } : {}),
});

/** Anthropic-style 5xx error (what the SDK throws on a transient api_error). */
function makeApiError(status = 500, message = "Internal server error"): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

describe("circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAllCircuits();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[1] happy path: single call, no retries, stays closed", async () => {
    const b = new CircuitBreaker("test", testOpts());
    const fn = vi.fn(async () => "ok");
    await expect(b.execute(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b.getState()).toBe("closed");
  });

  it("[2] retry-to-success with no-double-emit: 500 → success → single emission cycle, stays closed", async () => {
    // Regression guard for the "UI shows truth" invariant. If a future
    // refactor removes streamResumeNotSafe or changes retry semantics
    // such that deltas get replayed, the shared emission buffer will
    // show duplicates and this test fails.
    const b = new CircuitBreaker("test", testOpts());
    const emitted: string[] = [];
    let attemptNum = 0;
    const fn = vi.fn(async () => {
      attemptNum++;
      if (attemptNum === 1) {
        // Attempt 1 fails before emitting anything — matches the
        // Anthropic 500 case from 7a.v smoke, where api_error arrives
        // on the first SSE event before any content_block_delta.
        throw makeApiError(500);
      }
      // Attempt 2 succeeds, emits the full message exactly once.
      emitted.push("hello");
      emitted.push("world");
      return emitted.join(" ");
    });
    const p = b.execute(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("hello world");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual(["hello", "world"]); // no doubling
    expect(b.getState()).toBe("closed");
  });

  it("[3] retry exhausted: 3 consecutive 500s → throws after 3 attempts, 1 failure counted", async () => {
    const b = new CircuitBreaker("test", testOpts());
    const fn = vi.fn(async () => {
      throw makeApiError(500);
    });
    // Attach the rejection handler synchronously via expect().rejects so
    // the unhandled-rejection tracker doesn't complain during the
    // runAllTimersAsync() microtask window.
    const rejection = expect(b.execute(fn)).rejects.toThrow();
    await vi.runAllTimersAsync();
    await rejection;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(b.getState()).toBe("closed"); // 1 failure, threshold is 3
  });

  it("[4] trips open: threshold failures → 4th call fast-fails with CircuitOpenError, no fn invocation", async () => {
    const b = new CircuitBreaker("test", testOpts());
    const fn = vi.fn(async () => {
      throw makeApiError(500);
    });
    for (let i = 0; i < 3; i++) {
      const rejection = expect(b.execute(fn)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await rejection;
    }
    expect(b.getState()).toBe("open");
    const callsBefore = fn.mock.calls.length;
    await expect(b.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    // fn was NOT called — open-circuit rejection is fast-fail.
    expect(fn.mock.calls.length).toBe(callsBefore);
  });

  it("[5] half-open probe success: cooldown elapses → single probe → success → closed, counters reset", async () => {
    const b = new CircuitBreaker("test", testOpts());
    const failFn = vi.fn(async () => {
      throw makeApiError(500);
    });
    for (let i = 0; i < 3; i++) {
      const rejection = expect(b.execute(failFn)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await rejection;
    }
    expect(b.getState()).toBe("open");
    // Advance past cooldownMs (2_000).
    await vi.advanceTimersByTimeAsync(2_001);
    expect(b.getState()).toBe("half-open");
    const okFn = vi.fn(async () => "ok");
    await expect(b.execute(okFn)).resolves.toBe("ok");
    expect(b.getState()).toBe("closed");
    // Counters reset — another round of 3 failures would be needed to re-trip.
    const failFn2 = vi.fn(async () => {
      throw makeApiError(500);
    });
    for (let i = 0; i < 2; i++) {
      const rejection = expect(b.execute(failFn2)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await rejection;
    }
    expect(b.getState()).toBe("closed"); // only 2 failures, threshold is 3
  });

  it("[6] half-open probe failure: probe fails → back to open, cooldown restarts", async () => {
    const b = new CircuitBreaker("test", testOpts());
    const failFn = vi.fn(async () => {
      throw makeApiError(500);
    });
    for (let i = 0; i < 3; i++) {
      const rejection = expect(b.execute(failFn)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await rejection;
    }
    await vi.advanceTimersByTimeAsync(2_001);
    expect(b.getState()).toBe("half-open");
    // Probe fails → back to open.
    const rejection = expect(b.execute(failFn)).rejects.toThrow();
    await vi.runAllTimersAsync();
    await rejection;
    expect(b.getState()).toBe("open");
  });

  it("[7] external abort: cancels retry loop without counting toward threshold", async () => {
    const b = new CircuitBreaker("test", testOpts());
    const ac = new AbortController();
    const fn = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const id = setTimeout(resolve, 5_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(id);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return "ok";
    });
    const rejection = expect(b.execute(fn, { signal: ac.signal })).rejects.toThrow(/user_cancel/);
    setTimeout(() => ac.abort(new Error("user_cancel")), 100);
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
    // Abort did NOT count — breaker stays closed with empty failure window.
    expect(b.getState()).toBe("closed");
    // Confirm: 3 more unrelated failures are still needed to trip.
    const failFn = vi.fn(async () => {
      throw makeApiError(500);
    });
    for (let i = 0; i < 2; i++) {
      const r2 = expect(b.execute(failFn)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await r2;
    }
    expect(b.getState()).toBe("closed");
  });

  it("[8] non-retriable 400: throws immediately, counts 1 failure", async () => {
    const b = new CircuitBreaker("test", testOpts());
    const fn = vi.fn(async () => {
      throw makeApiError(400, "bad request");
    });
    await expect(b.execute(fn)).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1); // no retries
    expect(b.getState()).toBe("closed"); // 1 failure, threshold is 3
  });

  it("[9] state-change events: fire on every transition with correct fields", async () => {
    const events: StateChangeEvent[] = [];
    const b = new CircuitBreaker(
      "test",
      testOpts({ onStateChange: (e) => events.push(e) }),
    );
    const failFn = async () => {
      throw makeApiError(500);
    };
    const okFn = async () => "ok";

    // closed → open
    for (let i = 0; i < 3; i++) {
      const rejection = expect(b.execute(failFn)).rejects.toThrow();
      await vi.runAllTimersAsync();
      await rejection;
    }
    // open → half-open (lazy, triggered by the next getState / execute)
    await vi.advanceTimersByTimeAsync(2_001);
    b.getState();
    // half-open → closed via successful probe
    await b.execute(okFn);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      circuit: "test",
      from: "closed",
      to: "open",
      reason: "failure_threshold_exceeded",
      failuresInWindow: 3,
    });
    expect(events[0]?.lastError).not.toBeNull();
    expect(events[1]).toMatchObject({
      from: "open",
      to: "half-open",
      reason: "cooldown_elapsed",
      lastError: null,
    });
    expect(events[2]).toMatchObject({
      from: "half-open",
      to: "closed",
      reason: "probe_succeeded",
    });
  });

  it("[10] registry: getCircuit returns same instance; resetAllCircuits clears the map", () => {
    const a1 = getCircuit("anthropic");
    const a2 = getCircuit("anthropic");
    expect(a1).toBe(a2);

    const r1 = getCircuit("rag");
    expect(r1).not.toBe(a1);

    // opts on repeat calls are silently ignored (Hystrix/Polly convention).
    const a3 = getCircuit("anthropic", testOpts());
    expect(a3).toBe(a1);

    resetAllCircuits();
    const a4 = getCircuit("anthropic");
    expect(a4).not.toBe(a1);
  });

  it("[11] streamResumeNotSafe marker: non-retriable regardless of status code", async () => {
    // streamMapper.ts wraps mid-stream errors with this marker so retry
    // can't produce duplicate deltas in the bus. defaultIsRetriable must
    // honor the marker before it considers status / code / name.
    const b = new CircuitBreaker("test", testOpts());
    const fn = vi.fn(async () => {
      const e = new Error("connection reset mid-stream") as Error & {
        streamResumeNotSafe?: true;
        code?: string;
      };
      e.code = "ECONNRESET"; // would normally be retriable
      e.streamResumeNotSafe = true;
      throw e;
    });
    await expect(b.execute(fn)).rejects.toThrow("connection reset mid-stream");
    expect(fn).toHaveBeenCalledTimes(1); // no retries despite ECONNRESET
    expect(b.getState()).toBe("closed"); // 1 failure, threshold is 3
  });
});
