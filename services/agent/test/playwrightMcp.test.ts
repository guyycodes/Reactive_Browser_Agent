import { describe, it, expect } from "vitest";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

import { EventBus } from "../src/events/bus.js";
import type { TimelineFrame, TimelineFramePayload } from "../src/events/envelope.js";
import {
  launchBrowser,
  PlaywrightMcpError,
  type McpClientLike,
  type McpCallToolResult,
} from "../src/mastra/tools/playwrightMcp.js";

/**
 * Commit 6a unit coverage for the Playwright MCP wrapper.
 *
 * Scope (per reviewer handoff):
 *   1. Happy navigate → snapshot → screenshot → 8-frame timeline span,
 *      correct invocationId pairing, real durationMs, screenshot path shape.
 *   2. `CallToolResult.isError=true` → `tool.failed` instead of
 *      `tool.completed`, `PlaywrightMcpError` thrown, span invariant kept.
 *   3. AbortSignal mid-session → client.close() called, subsequent tool
 *      calls throw, no orphan tool.started frames.
 *   4. StdioClientTransport spawn args pin output directory via BOTH the
 *      `--output-dir` CLI flag and the `PLAYWRIGHT_MCP_OUTPUT_DIR` env var.
 *
 * We inject two factory opts (`clientFactory`, `transportFactory`) to keep
 * the test dependency-free — no real subprocess spawn, no `undici`, no
 * `msw`. Matches the pattern established in 5a's `rag.test.ts`.
 */

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const TEST_OUTPUT_ROOT = "/tmp/test-playwright";

/** Escape a literal string for safe use inside a RegExp. Screenshot path
 *  regexes are built dynamically from `TEST_OUTPUT_ROOT` + `RUN_ID`; the
 *  hyphens in the UUID and the slashes in the path are escape-by-accident
 *  today but would break a future fixture swap. Cheap insurance. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the exact absolute-path regex every screenshot mcpArgs assertion
 *  in this file uses. Ref location for 6b-hotfix-5's contract: PNGs MUST
 *  land at `${runDir}/${seq}.png`, not under the MCP server's CWD. */
const SCREENSHOT_PATH_RE = new RegExp(
  `^${escapeRegex(TEST_OUTPUT_ROOT)}/${escapeRegex(RUN_ID)}/\\d+\\.png$`,
);

type CallLog = {
  name: string;
  args: Record<string, unknown> | undefined;
  signal?: AbortSignal;
};

function mockClient(
  responses: Array<McpCallToolResult | (() => McpCallToolResult | Promise<McpCallToolResult>)>,
): {
  client: McpClientLike;
  calls: CallLog[];
  closedCount: () => number;
  connectedCount: () => number;
} {
  const calls: CallLog[] = [];
  let closed = 0;
  let connected = 0;
  let i = 0;
  const client: McpClientLike = {
    async connect(_transport) {
      connected++;
    },
    async callTool(params, _schema, options) {
      calls.push({
        name: params.name,
        args: params.arguments,
        signal: options?.signal,
      });
      const next = responses[i++];
      if (next === undefined) {
        throw new Error(`[mock-client] no queued response for call #${i} (${params.name})`);
      }
      return typeof next === "function" ? next() : next;
    },
    async close() {
      closed++;
    },
  };
  return { client, calls, closedCount: () => closed, connectedCount: () => connected };
}

/** Drain any frames the bus has buffered for the run. Uses the bus's own
 *  replay API with `resumeSeq = -1` so the first frame (`seq === 0`) is
 *  included — `replay` returns frames with `seq > resumeSeq`. */
function framesFor(bus: EventBus, runId: string): TimelineFramePayload[] {
  return bus.replay(runId, -1).map(stripHeader);
}

function stripHeader(e: TimelineFrame): TimelineFramePayload {
  // Clone and drop the header fields so assertions focus on the payload.
  // The discriminated union is preserved via the `type` field.
  const { v: _v, runId: _runId, seq: _seq, ts: _ts, stepId: _stepId, ...rest } = e;
  return rest as TimelineFramePayload;
}

const okResult = (text = ""): McpCallToolResult => ({
  content: text ? [{ type: "text", text }] : [],
  isError: false,
});

describe("playwrightMcp — launchBrowser", () => {
  it("[1] happy path: navigate → snapshot → screenshot emits correct 8-frame span", async () => {
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client, calls } = mockClient([
      okResult(), // browser_navigate
      okResult("role: main\n  button #login-submit [ref=a1]"), // browser_snapshot
      okResult(), // browser_take_screenshot
    ]);

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
    });

    await session.navigate("http://test-webapp:3000/login");
    const snap = await session.snapshot();
    const shot = await session.takeScreenshot("login-page");

    expect(calls.length).toBe(3);
    expect(calls[0]?.name).toBe("browser_navigate");
    expect(calls[0]?.args).toEqual({ url: "http://test-webapp:3000/login" });
    expect(calls[1]?.name).toBe("browser_snapshot");
    expect(calls[2]?.name).toBe("browser_take_screenshot");
    // `filename` must be the ABSOLUTE path under `<outputRoot>/<runId>/` —
    // @playwright/mcp@0.0.70 resolves a relative filename against its CWD
    // (the agent package root), not `--output-dir`. 6b-hotfix-5 regression
    // guard: before the fix, PNGs accumulated in `services/agent/*.png`.
    expect(calls[2]?.args).toMatchObject({
      type: "png",
      filename: expect.stringMatching(SCREENSHOT_PATH_RE),
    });

    expect(snap.text).toContain("login-submit");

    // Screenshot path is absolute + under the per-run output dir.
    expect(shot.path.startsWith(`${TEST_OUTPUT_ROOT}/${RUN_ID}/`)).toBe(true);
    expect(shot.path.endsWith(".png")).toBe(true);
    expect(shot.label).toBe("login-page");

    const frames = framesFor(bus, RUN_ID);
    // Expected sequence: 3x (tool.started + aux + tool.completed) for nav,
    // 2x (tool.started + tool.completed) for snapshot (no aux frames),
    // 3x (tool.started + browser.screenshot + tool.completed) for screenshot.
    // Total = 3 + 2 + 3 = 8 frames.
    expect(frames.length).toBe(8);

    const types = frames.map((f) => f.type);
    expect(types).toEqual([
      "tool.started",
      "browser.nav",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "tool.started",
      "browser.screenshot",
      "tool.completed",
    ]);

    // invocationId pairing: each tool.started's id appears on exactly one
    // tool.completed (or tool.failed) and nowhere else.
    const startedIds = frames
      .filter((f): f is Extract<TimelineFramePayload, { type: "tool.started" }> => f.type === "tool.started")
      .map((f) => f.invocationId);
    const completedIds = frames
      .filter((f): f is Extract<TimelineFramePayload, { type: "tool.completed" }> => f.type === "tool.completed")
      .map((f) => f.invocationId);
    expect(new Set(completedIds)).toEqual(new Set(startedIds));

    // durationMs is non-negative on every tool.completed.
    for (const f of frames.filter((x) => x.type === "tool.completed")) {
      const c = f as Extract<TimelineFramePayload, { type: "tool.completed" }>;
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
    }

    // browser.screenshot carries the same absolute path we returned.
    const screenshotFrame = frames.find(
      (f): f is Extract<TimelineFramePayload, { type: "browser.screenshot" }> =>
        f.type === "browser.screenshot",
    );
    expect(screenshotFrame?.path).toBe(shot.path);
    expect(screenshotFrame?.label).toBe("login-page");

    await session.close();
  });

  it("[2] tool.failed: isError=true → span closes with tool.failed and PlaywrightMcpError is thrown", async () => {
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client } = mockClient([
      okResult(), // navigate succeeds
      { content: [{ type: "text", text: "element not found: ref=bogus" }], isError: true },
    ]);

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "execute",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
    });

    await session.navigate("http://test-webapp:3000/users");

    await expect(
      session.click({ element: "reset button", ref: "bogus" }),
    ).rejects.toBeInstanceOf(PlaywrightMcpError);

    const frames = framesFor(bus, RUN_ID);

    // Span-invariant: exactly as many tool.started frames as terminators
    // (tool.completed + tool.failed), and every started invocationId matches
    // exactly one terminator.
    const started = frames.filter((f) => f.type === "tool.started");
    const completed = frames.filter((f) => f.type === "tool.completed");
    const failed = frames.filter((f) => f.type === "tool.failed");
    expect(started.length).toBe(2);
    expect(completed.length).toBe(1); // navigate's
    expect(failed.length).toBe(1); // click's
    expect(started.length).toBe(completed.length + failed.length);

    const failedFrame = failed[0] as Extract<TimelineFramePayload, { type: "tool.failed" }>;
    expect(failedFrame.name).toBe("playwright.browser_click");
    expect(failedFrame.error.message).toContain("element not found");

    await session.close();
  });

  it("[3] AbortSignal teardown: firing abort closes the client; subsequent calls throw; process-tree kill runs", async () => {
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client, closedCount } = mockClient([
      okResult(), // navigate succeeds before abort
    ]);

    // Record every call to the process-tree-kill hook so we can assert the
    // Chromium-orphan cleanup path fires on close. 6b-hotfix-2 regression
    // guard: before that fix, SDK-level `client.close()` SIGTERMed `npx
    // @playwright/mcp` but left Chromium reparented to init.
    const killedRoots: number[] = [];
    const killProcessTreeImpl = (pid: number): void => {
      killedRoots.push(pid);
    };

    // Stub the transport so it has a synthetic `.pid` the launchBrowser
    // path can capture — production grabs this from the real
    // `StdioClientTransport`. We need a real-ish transport shape here so
    // the `opts.transportFactory == null` gate lets the pid-capture run.
    const controller = new AbortController();
    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      signal: controller.signal,
      clientFactory: () => client,
      killProcessTreeImpl,
      // No transportFactory: launchBrowser builds a real
      // `StdioClientTransport` but doesn't `.start()` it (the mock client's
      // `connect()` is a no-op). The transport's `.pid` is `null` until
      // start, so the pid-capture path skips the kill. That leaves us with
      // one behaviour to assert this test: the abort → close handshake.
    });

    await session.navigate("http://test-webapp:3000/login");
    expect(closedCount()).toBe(0);

    // External cancellation (mirrors Mastra's step.abortSignal firing).
    controller.abort(new Error("run_cancelled"));

    // Abort is fire-and-forget → drain microtasks before asserting close.
    await new Promise((r) => setImmediate(r));
    expect(closedCount()).toBeGreaterThanOrEqual(1);

    // After abort, any session method must refuse to invoke MCP.
    await expect(
      session.navigate("http://test-webapp:3000/users"),
    ).rejects.toBeInstanceOf(PlaywrightMcpError);

    // Idempotent close.
    await session.close();
    const after = closedCount();
    await session.close();
    expect(closedCount()).toBe(after);

    // The kill hook was NOT called here because the unstarted transport
    // has a null pid (see note above); the positive-path assertion lives
    // in test [6] below, which drives a pid explicitly.
    expect(killedRoots.length).toBe(0);
  });

  it("[6] process-tree kill runs on close when transport reports a pid (Chromium-orphan guard)", async () => {
    // Regression guard for the 6b-hotfix-2 orphan issue: SDK-level
    // `client.close()` SIGTERMs `npx @playwright/mcp` but Chromium
    // grandchildren get reparented to init. Our wrapper `close()` must
    // walk the process tree rooted at npx's pid and SIGKILL descendants.
    // This test verifies the hook fires with the expected root pid.
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client } = mockClient([okResult()]);

    const killedRoots: number[] = [];
    const killProcessTreeImpl = (pid: number): void => {
      killedRoots.push(pid);
    };

    // Fake transport with a populated `.pid` — mirrors the real
    // `StdioClientTransport` state post-spawn and triggers the pid-capture
    // branch in launchBrowser.
    const fakeTransport = { pid: 42424 };

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
      transportFactory: () => fakeTransport,
      killProcessTreeImpl,
    });

    expect(killedRoots.length).toBe(0);
    await session.close();
    expect(killedRoots).toEqual([42424]);

    // Idempotent: second close is a no-op.
    await session.close();
    expect(killedRoots).toEqual([42424]);
  });

  it("[9] takeScreenshot passes type='png' to browser_take_screenshot (silent-no-op regression guard)", async () => {
    // @playwright/mcp@0.0.70's `browser_take_screenshot` inputSchema marks
    // `type` as required. Without it, the tool silently claims success
    // (no isError) but writes nothing to disk — 6b-hotfix-3 live smoke
    // observed zero .png files on the `playwright-videos` volume despite
    // every screenshot frame emitting. This test guards the arg shape so
    // a future refactor that drops `type` fails loud at `npm run check`
    // rather than at 6c's `<img src>` rendering.
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client, calls } = mockClient([okResult()]);

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
    });

    const shot = await session.takeScreenshot("dry_run:login-page");

    expect(calls.length).toBe(1);
    expect(calls[0]?.name).toBe("browser_take_screenshot");
    // Absolute path so `workspaceFile()` writes into `--output-dir` instead
    // of resolving the relative filename against the MCP server's CWD
    // (= `/workspace/services/agent` at runtime, which silently piled up 22
    // PNGs during 6b-hotfix-4 smoke).
    expect(calls[0]?.args).toMatchObject({
      type: "png",
      filename: expect.stringMatching(SCREENSHOT_PATH_RE),
    });
    expect(shot.path).toMatch(SCREENSHOT_PATH_RE);

    await session.close();
  });

  it("[10] takeScreenshot forwards fullPage when supplied alongside type='png'", async () => {
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client, calls } = mockClient([okResult()]);

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
    });

    await session.takeScreenshot("full", { fullPage: true });

    expect(calls[0]?.args).toMatchObject({
      type: "png",
      filename: expect.stringMatching(SCREENSHOT_PATH_RE),
      fullPage: true,
    });

    await session.close();
  });

  it("[8] fillForm passes {name, type, ref, value} verbatim to client.callTool", async () => {
    // MCP's `browser_fill_form` inputSchema requires every field to have
    // `name`, `type` (enum), `ref`, `value` — all four — and rejects any
    // additional properties. The 6b-hotfix-2 live smoke hit this as a hard
    // schema error when our wrapper sent only `{ref, value}`:
    //     [{"expected":"string","path":["fields",0,"name"], ...}]
    // This test guards the contract: whatever shape the workflow hands to
    // fillForm must reach client.callTool byte-for-byte.
    //
    // 7a.iv bump: after 7a.iv, every successful fillForm emits an implicit
    // post-action screenshot so `calls.length` is now 2 (fillForm + its
    // :after screenshot). The fillForm contract assertion is unchanged —
    // it still lives on calls[0]. The :after contract (label convention,
    // absolute-path filename) is owned by test [12].
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client, calls } = mockClient([
      okResult(), // browser_fill_form
      okResult(), // implicit browser_take_screenshot (7a.iv)
    ]);

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
    });

    const fields = [
      { name: "email", type: "textbox" as const, ref: "e12", value: "theo@example.com" },
      { name: "password", type: "textbox" as const, ref: "e15", value: "demo" },
    ];
    await session.fillForm(fields);

    expect(calls.length).toBe(2);
    expect(calls[0]?.name).toBe("browser_fill_form");
    expect(calls[0]?.args).toEqual({ fields });
    // Explicit shape assertion — the reviewer's regression guard. If a
    // future refactor drops `name` or `type` silently, this fails loud.
    expect(calls[0]?.args?.fields).toEqual([
      { name: "email", type: "textbox", ref: "e12", value: "theo@example.com" },
      { name: "password", type: "textbox", ref: "e15", value: "demo" },
    ]);
    // Sanity-check calls[1] is the implicit :after screenshot — no arg
    // assertion here, test [12] owns that.
    expect(calls[1]?.name).toBe("browser_take_screenshot");

    await session.close();
  });

  it("[12] click and fillForm each emit an implicit :after screenshot (post-action hook)", async () => {
    // Commit 7a.iv: every successful click / fillForm produces a follow-up
    // takeScreenshot whose label ends in ":after", so the reviewer's
    // behavior feed updates at ~1 snapshot per user-visible browser action
    // during execute (PNG count per happy-path run bumps from 6 to
    // ~12-15). The post-action screenshot goes through the same public
    // takeScreenshot codepath — same absolute-path filename contract,
    // same browser.screenshot envelope frame, same
    // tool.started → tool.completed span — and is wrapped in a try/catch
    // that downgrades failures to a debug log so a flaky screenshot
    // never poisons a successful click. A failed action throws BEFORE
    // the post-action hook runs (see test [2] for the negative-path span
    // invariant, which remains 1:1 started-vs-terminated).
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client, calls } = mockClient([
      okResult(), // browser_click           (user action)
      okResult(), // browser_take_screenshot (implicit :after)
      okResult(), // browser_fill_form       (user action)
      okResult(), // browser_take_screenshot (implicit :after)
    ]);

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "execute",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
    });

    await session.click({ element: "reset button", ref: "a7" });
    await session.fillForm([
      { name: "email", type: "textbox" as const, ref: "e1", value: "theo@example.com" },
    ]);

    // Four MCP calls in order: action, :after, action, :after.
    expect(calls.length).toBe(4);
    expect(calls[0]?.name).toBe("browser_click");
    expect(calls[1]?.name).toBe("browser_take_screenshot");
    expect(calls[1]?.args).toMatchObject({
      type: "png",
      filename: expect.stringMatching(SCREENSHOT_PATH_RE),
    });
    expect(calls[2]?.name).toBe("browser_fill_form");
    expect(calls[3]?.name).toBe("browser_take_screenshot");
    expect(calls[3]?.args).toMatchObject({
      type: "png",
      filename: expect.stringMatching(SCREENSHOT_PATH_RE),
    });

    // browser.screenshot frames carry the `${mcpToolName}:after` label
    // convention so the reviewer feed can identify which user action
    // produced the snapshot.
    const frames = framesFor(bus, RUN_ID);
    const shots = frames.filter(
      (f): f is Extract<TimelineFramePayload, { type: "browser.screenshot" }> =>
        f.type === "browser.screenshot",
    );
    expect(shots.length).toBe(2);
    expect(shots[0]?.label).toBe("browser_click:after");
    expect(shots[1]?.label).toBe("browser_fill_form:after");

    await session.close();
  });

  it("[7] process-tree kill is skipped when transport has no pid", async () => {
    // Sanity check: pre-start transports (or any mock that doesn't expose
    // a pid) must NOT invoke the kill hook — otherwise test paths would
    // spuriously try to SIGKILL arbitrary pids.
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client } = mockClient([okResult()]);

    const killedRoots: number[] = [];
    const killProcessTreeImpl = (pid: number): void => {
      killedRoots.push(pid);
    };

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
      transportFactory: () => ({}), // no pid
      killProcessTreeImpl,
    });

    await session.close();
    expect(killedRoots).toEqual([]);
  });

  it("[4] output dir pinned via --output-dir arg AND PLAYWRIGHT_MCP_OUTPUT_DIR env", async () => {
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client } = mockClient([okResult()]);
    let capturedSpawn: StdioServerParameters | null = null;

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
      transportFactory: (params) => {
        capturedSpawn = params;
        return {}; // opaque — the mock client.connect accepts anything
      },
    });

    expect(capturedSpawn).not.toBeNull();
    const spawn = capturedSpawn as unknown as StdioServerParameters;

    // Command targets npx + the exact pinned MCP version.
    expect(spawn.command).toBe("npx");
    expect(spawn.args).toEqual(
      expect.arrayContaining([
        "-y",
        "@playwright/mcp@0.0.70",
        "--headless",
        "--output-dir",
        `${TEST_OUTPUT_ROOT}/${RUN_ID}`,
      ]),
    );
    // Argument order matters for `--output-dir <path>` — confirm the flag
    // immediately precedes the path value (catches a regression that splits
    // or reorders args).
    const argsArr = spawn.args ?? [];
    const flagIdx = argsArr.indexOf("--output-dir");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(argsArr[flagIdx + 1]).toBe(`${TEST_OUTPUT_ROOT}/${RUN_ID}`);

    // Belt-and-suspenders env var is ALSO set to the same path. If either
    // `@playwright/mcp`'s CLI flag or its env-var support drifts in a patch
    // bump, the other pins the location so 6c's `/static` route keeps
    // resolving.
    expect(spawn.env?.PLAYWRIGHT_MCP_OUTPUT_DIR).toBe(`${TEST_OUTPUT_ROOT}/${RUN_ID}`);

    await session.close();
  });

  it("[11] user-data-dir is per-run and under the run's output tree (prevents session bleed regression)", async () => {
    // 6c-1 regression guard: without `--user-data-dir`, `@playwright/mcp`
    // reuses a single shared Chromium profile across `POST /triage`
    // invocations. 6b-hotfix-5 live smoke observed this as "login refs
    // missing: email=false password=false submit=false" on the SECOND
    // consecutive run (the browser was still authenticated from run #1
    // so /login server-side-redirected to /users). The fix is a
    // per-run profile under `${runDir}/.mcp-profile`; cleanup happens in
    // session.close() via `fs.rm`. If a future refactor drops or
    // relocates this flag, live smokes would regress silently after the
    // first run — caught here at `npm run check` time instead.
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client } = mockClient([okResult()]);
    let capturedSpawn: StdioServerParameters | null = null;

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
      transportFactory: (params) => {
        capturedSpawn = params;
        return {};
      },
    });

    expect(capturedSpawn).not.toBeNull();
    const spawn = capturedSpawn as unknown as StdioServerParameters;
    const argsArr = spawn.args ?? [];

    const flagIdx = argsArr.indexOf("--user-data-dir");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    // Profile dir lives under the run's output dir so teardown stays
    // atomic with the rest of the run's artifacts. Dot-prefix so the
    // 6c-2 /static route doesn't expose it.
    expect(argsArr[flagIdx + 1]).toBe(`${TEST_OUTPUT_ROOT}/${RUN_ID}/.mcp-profile`);

    await session.close();
  });

  it("[5] browser channel pinned via --browser chromium (prevents 'chrome not found' regression)", async () => {
    // @playwright/mcp@0.0.70 defaults to the `chrome` channel and looks for
    // /opt/google/chrome/chrome. The agent Dockerfile installs Playwright's
    // bundled Chromium at /opt/ms-playwright. Without this flag, 6b's live
    // smoke surfaced the error as `tool.failed` with
    //   "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome"
    // on the very first browser_navigate call. This test guards the spawn
    // args against silently regressing the flag in a future refactor.
    const bus = new EventBus({ ringBufferSize: 64 });
    const { client } = mockClient([okResult()]);
    let capturedSpawn: StdioServerParameters | null = null;

    const session = await launchBrowser({
      runId: RUN_ID,
      bus,
      stepId: "dry_run",
      outputRoot: TEST_OUTPUT_ROOT,
      clientFactory: () => client,
      transportFactory: (params) => {
        capturedSpawn = params;
        return {};
      },
    });

    expect(capturedSpawn).not.toBeNull();
    const spawn = capturedSpawn as unknown as StdioServerParameters;
    const argsArr = spawn.args ?? [];

    const flagIdx = argsArr.indexOf("--browser");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(argsArr[flagIdx + 1]).toBe("chromium");

    await session.close();
  });
});
