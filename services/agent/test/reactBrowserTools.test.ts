import { describe, it, expect, beforeEach } from "vitest";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import type { BrowserSession } from "../src/mastra/tools/playwrightMcp.js";
import { REACT_FINAL_SENTINEL } from "../src/mastra/lib/reactRunner.js";
import type { ReactInvokeCtx } from "../src/mastra/lib/reactRunner.js";
import {
  buildBrowserReactTools,
  MissingBrowserSessionError,
} from "../src/mastra/tools/reactBrowserTools.js";

/**
 * week2d Part 1 — reactBrowserTools registry coverage.
 *
 *   [1]  browser_navigate.invoke delegates to session.navigate(url)
 *   [2]  browser_navigate.summarize shape
 *   [3]  browser_snapshot.invoke returns { text }
 *   [4]  browser_snapshot.summarize slices + collapses whitespace
 *   [5]  browser_click.invoke ordering: click THEN snapshot
 *   [6]  browser_click.summarize augmented shape (element + excerpt)
 *   [7]  browser_fillForm.invoke ordering: fillForm THEN snapshot
 *   [8]  browser_fillForm.summarize (fieldCount + excerpt)
 *   [9]  browser_takeScreenshot.invoke round-trips { path, label }
 *   [10] browser_takeScreenshot.summarize uses basename
 *   [11] boundary_reached.invoke returns sentinel-bearing output
 *   [12] boundary_reached.invoke omitting scaffoldMatch → null coercion
 *   [13] boundary_reached.summarize branches 3-way on scaffoldMatch
 *   [14] requireSession throws MissingBrowserSessionError on missing ctx.browser
 *   [15] validators reject bad inputs (spot-check one per tool)
 *   [16] buildBrowserReactTools() registry shape
 */

const RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type SessionCall =
  | { kind: "navigate"; url: string }
  | { kind: "snapshot" }
  | { kind: "click"; element: string; ref: string }
  | { kind: "fillForm"; fields: unknown[] }
  | { kind: "takeScreenshot"; label: string };

/** Stub BrowserSession that records every call in order. Inline here
 *  instead of borrowing from `playwrightMcp.test.ts` so this test file
 *  stays self-contained (~40 LoC vs cross-file coupling). */
function makeStubSession(
  overrides: Partial<{
    snapshotText: string;
    screenshotPath: string;
  }> = {},
): { session: BrowserSession; calls: SessionCall[] } {
  const calls: SessionCall[] = [];
  const session: BrowserSession = {
    setStepId: () => {},
    navigate: async (url: string) => {
      calls.push({ kind: "navigate", url });
    },
    snapshot: async () => {
      calls.push({ kind: "snapshot" });
      return { text: overrides.snapshotText ?? "root\n  button [ref=b1] 'Sign in'" };
    },
    click: async ({ element, ref }) => {
      calls.push({ kind: "click", element, ref });
    },
    fillForm: async (fields) => {
      calls.push({ kind: "fillForm", fields });
    },
    takeScreenshot: async (label: string) => {
      calls.push({ kind: "takeScreenshot", label });
      return { path: overrides.screenshotPath ?? "/workspace/.playwright-videos/run-id/1.png", label };
    },
    consoleMessages: async () => ({ messages: [] }),
    close: async () => {},
  };
  return { session, calls };
}

const DUMMY_INVOKE_CTX: ReactInvokeCtx = {
  signal: undefined,
  runId: RUN_ID,
  stepId: "dry_run",
  reactIterationId: "iter-0",
};

describe("reactBrowserTools", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ ringBufferSize: 32 });
  });

  it("[1] browser_navigate.invoke delegates to session.navigate(url)", async () => {
    const { session, calls } = makeStubSession();
    const { browser_navigate } = buildBrowserReactTools();
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: session },
      () => browser_navigate.invoke({ url: "http://localhost:3000/login" }, DUMMY_INVOKE_CTX),
    );
    expect(calls).toEqual([{ kind: "navigate", url: "http://localhost:3000/login" }]);
    expect(result).toEqual({ url: "http://localhost:3000/login" });
  });

  it("[2] browser_navigate.summarize shape", () => {
    const { browser_navigate } = buildBrowserReactTools();
    expect(browser_navigate.summarize!({ url: "http://example.com/x" })).toBe(
      "navigated to http://example.com/x",
    );
  });

  it("[3] browser_snapshot.invoke returns { text } from session.snapshot", async () => {
    const { session, calls } = makeStubSession({ snapshotText: "page text here" });
    const { browser_snapshot } = buildBrowserReactTools();
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: session },
      () => browser_snapshot.invoke({}, DUMMY_INVOKE_CTX),
    );
    expect(calls).toEqual([{ kind: "snapshot" }]);
    expect(result).toEqual({ text: "page text here" });
  });

  it("[4] browser_snapshot.summarize slices to 3000 chars + collapses whitespace + appends ellipsis on longer", () => {
    const { browser_snapshot } = buildBrowserReactTools();
    // Short case — no truncation.
    expect(browser_snapshot.summarize!({ text: "hi   world" })).toBe("hi world");
    // Long case — 3500 chars → sliced to 3000 + "…" (hotfix-1: cap widened
    // from 240 to 3000 so LLM observations include the accessibility-tree
    // ref IDs needed for click/fillForm dispatch).
    const long = "x".repeat(3500);
    const out = browser_snapshot.summarize!({ text: long }) as string;
    expect(out.endsWith("…")).toBe(true);
    expect(out).toHaveLength(3001);
  });

  it("[5] browser_click.invoke ordering: calls session.click THEN session.snapshot", async () => {
    const { session, calls } = makeStubSession({ snapshotText: "after-click DOM" });
    const { browser_click } = buildBrowserReactTools();
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: session },
      () =>
        browser_click.invoke(
          { element: "Sign in button", ref: "b1" },
          DUMMY_INVOKE_CTX,
        ),
    );
    expect(calls).toEqual([
      { kind: "click", element: "Sign in button", ref: "b1" },
      { kind: "snapshot" },
    ]);
    expect(result).toEqual({
      element: "Sign in button",
      postSnapshotExcerpt: "after-click DOM",
    });
  });

  it("[6] browser_click.summarize includes element name + DOM excerpt preview", () => {
    const { browser_click } = buildBrowserReactTools();
    const summary = browser_click.summarize!({
      element: "Reset password button",
      postSnapshotExcerpt: "Password reset successful. Temporary password: Pw-aK9bQ2",
    }) as string;
    expect(summary).toContain('clicked "Reset password button"');
    expect(summary).toContain("Password reset successful");
  });

  it("[7] browser_fillForm.invoke ordering: calls session.fillForm THEN session.snapshot", async () => {
    const { session, calls } = makeStubSession({ snapshotText: "form-filled state" });
    const { browser_fillForm } = buildBrowserReactTools();
    const fields = [
      { name: "Email", type: "textbox", ref: "e1", value: "jane@example.com" },
      { name: "Password", type: "textbox", ref: "e2", value: "demo" },
    ];
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: session },
      () => browser_fillForm.invoke({ fields }, DUMMY_INVOKE_CTX),
    );
    expect(calls[0]).toMatchObject({ kind: "fillForm" });
    expect(calls[1]).toEqual({ kind: "snapshot" });
    expect(result).toEqual({ fieldCount: 2, postSnapshotExcerpt: "form-filled state" });
  });

  it("[8] browser_fillForm.summarize includes fieldCount + DOM excerpt", () => {
    const { browser_fillForm } = buildBrowserReactTools();
    const summary = browser_fillForm.summarize!({
      fieldCount: 3,
      postSnapshotExcerpt: "search results for jane",
    }) as string;
    expect(summary).toContain("filled 3 fields");
    expect(summary).toContain("search results for jane");
  });

  it("[9] browser_takeScreenshot.invoke round-trips { path, label }", async () => {
    const { session, calls } = makeStubSession({
      screenshotPath: "/workspace/.playwright-videos/e/42.png",
    });
    const { browser_takeScreenshot } = buildBrowserReactTools();
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: session },
      () => browser_takeScreenshot.invoke({ label: "login-page" }, DUMMY_INVOKE_CTX),
    );
    expect(calls).toEqual([{ kind: "takeScreenshot", label: "login-page" }]);
    expect(result).toEqual({
      path: "/workspace/.playwright-videos/e/42.png",
      label: "login-page",
    });
  });

  it("[10] browser_takeScreenshot.summarize uses path basename", () => {
    const { browser_takeScreenshot } = buildBrowserReactTools();
    const summary = browser_takeScreenshot.summarize!({
      path: "/workspace/.playwright-videos/runid/42.png",
      label: "after-reset",
    }) as string;
    expect(summary).toBe('captured screenshot "after-reset" → 42.png');
  });

  it("[11] boundary_reached.invoke returns sentinel-bearing output", async () => {
    const { session } = makeStubSession();
    const { boundary_reached } = buildBrowserReactTools();
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: session },
      () =>
        boundary_reached.invoke(
          {
            element: "Reset password button",
            reason: "This commits the destructive mutation.",
            scaffoldMatch: true,
          },
          DUMMY_INVOKE_CTX,
        ),
    );
    expect(result).toMatchObject({
      element: "Reset password button",
      reason: "This commits the destructive mutation.",
      scaffoldMatch: true,
      acknowledged: true,
    });
    // Sentinel is present on the raw return — it's stripped by the
    // RUNNER, not by boundary_reached itself.
    expect(
      (result as Record<string, unknown>)[REACT_FINAL_SENTINEL],
    ).toBe(true);
  });

  it("[12] boundary_reached.invoke omitting scaffoldMatch → scaffoldMatch: null", async () => {
    const { session } = makeStubSession();
    const { boundary_reached } = buildBrowserReactTools();
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: session },
      () =>
        boundary_reached.invoke(
          {
            element: "Update credentials button",
            reason: "UI drift — this is the destructive action under a new name.",
            // scaffoldMatch omitted intentionally
          },
          DUMMY_INVOKE_CTX,
        ),
    );
    expect((result as { scaffoldMatch: unknown }).scaffoldMatch).toBeNull();
  });

  it("[13] boundary_reached.summarize branches 3-way on scaffoldMatch (true / false / null)", () => {
    const { boundary_reached } = buildBrowserReactTools();
    expect(
      boundary_reached.summarize!({ element: "X", scaffoldMatch: true }),
    ).toBe("boundary_reached: X [scaffold-match]");
    expect(
      boundary_reached.summarize!({ element: "X", scaffoldMatch: false }),
    ).toBe("boundary_reached: X [DIVERGENCE]");
    expect(
      boundary_reached.summarize!({ element: "X", scaffoldMatch: null }),
    ).toBe("boundary_reached: X [unverified]");
  });

  it("[14] requireSession: non-boundary tools throw MissingBrowserSessionError when ctx.browser is undefined", async () => {
    const tools = buildBrowserReactTools();

    // Spot-check one representative per category: navigate (stateless),
    // click (stateful). The error path is shared via requireSession().
    await expect(
      withRunContext({ runId: RUN_ID, bus }, () =>
        tools.browser_navigate.invoke({ url: "http://x" }, DUMMY_INVOKE_CTX),
      ),
    ).rejects.toThrow(MissingBrowserSessionError);

    await expect(
      withRunContext({ runId: RUN_ID, bus }, () =>
        tools.browser_click.invoke(
          { element: "Sign in", ref: "b1" },
          DUMMY_INVOKE_CTX,
        ),
      ),
    ).rejects.toThrow(MissingBrowserSessionError);
  });

  it("[15] validators reject bad inputs (spot-check one per tool)", () => {
    const tools = buildBrowserReactTools();

    // browser_navigate — bad URL
    expect(tools.browser_navigate.validator.safeParse({ url: "not-a-url" }).success).toBe(false);
    // browser_click — missing ref
    expect(tools.browser_click.validator.safeParse({ element: "X" }).success).toBe(false);
    // browser_fillForm — empty fields
    expect(tools.browser_fillForm.validator.safeParse({ fields: [] }).success).toBe(false);
    // browser_takeScreenshot — missing label
    expect(tools.browser_takeScreenshot.validator.safeParse({}).success).toBe(false);
    // boundary_reached — missing reason
    expect(
      tools.boundary_reached.validator.safeParse({ element: "X" }).success,
    ).toBe(false);
  });

  it("[16] buildBrowserReactTools() registry shape — all 6 tools keyed correctly with Anthropic-compatible names", () => {
    const tools = buildBrowserReactTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        "boundary_reached",
        "browser_click",
        "browser_fillForm",
        "browser_navigate",
        "browser_snapshot",
        "browser_takeScreenshot",
      ].sort(),
    );
    // Every tool's Anthropic `name` matches the registry key.
    for (const [key, tool] of Object.entries(tools)) {
      expect(tool.name).toBe(key);
      // Anthropic tool-name regex: ^[a-zA-Z0-9_-]{1,64}$ (no dots).
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});
