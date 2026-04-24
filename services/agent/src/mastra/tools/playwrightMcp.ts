import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import { rm } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import { logger } from "../../logger.js";
import type { EventBus } from "../../events/bus.js";
import type { StepId } from "../../events/envelope.js";

/**
 * Thin, deterministic wrapper around `@playwright/mcp` (stdio transport),
 * built on the raw `@modelcontextprotocol/sdk` `Client`.
 *
 * Why not `@mastra/mcp`
 * --------------------
 * `@mastra/mcp`'s public `MCPClient` surface (`listTools` / `listToolsets`)
 * returns `Tool<...>` objects intended for `new Agent({ tools })` consumption.
 * There is no user-facing `callTool(name, args)` for deterministic
 * workflow-step invocation, and the direct-invocation class is marked
 * `@internal`. Reaching into internals is a semver trap. The raw SDK exposes
 * `client.callTool(params, schema?, { signal, timeout })` cleanly — one tool
 * per call, typed return, explicit cancellation, no Agent loop.
 *
 * Lifecycle contract
 * ------------------
 * - ONE MCP subprocess per run. `launchBrowser({ runId, bus })` spawns it;
 *   the returned `BrowserSession.close()` tears it down (transport → process).
 * - Caller owns lifecycle: `dryRunStep` calls `launchBrowser`, stashes the
 *   session on `RunContext.browser`, `executeStep` consumes it, the workflow
 *   wrapper's `finally` calls `close()` so a crashed run can't leak the
 *   Chromium subprocess.
 * - `AbortSignal` wired in two ways: each `callTool` gets the signal via
 *   `RequestOptions`, AND the session attaches an abort listener that
 *   proactively calls `client.close()` so the subprocess dies even mid-tool.
 *
 * Frame emission
 * --------------
 * Every tool call emits a `tool.started` / tool-specific frame(s) /
 * `tool.completed` span to the supplied `EventBus`, matching the pattern
 * established by `rag.ts`'s `runRagCall` in `triage.ts`. On MCP-side error
 * (`CallToolResult.isError === true`) or thrown transport error, the span
 * closes with `tool.failed` instead and the wrapper throws
 * `PlaywrightMcpError` so the calling step can decide whether to short-circuit
 * the run or continue.
 *
 * Output directory
 * ----------------
 * Screenshots + snapshots land in `${outputRoot}/${runId}/`. The path is
 * pinned via BOTH the `--output-dir` CLI flag AND the
 * `PLAYWRIGHT_MCP_OUTPUT_DIR` env var — belt-and-suspenders, since
 * `@playwright/mcp@0.0.x`'s CLI surface may drift between patch bumps. If one
 * is silently dropped the other still pins the location; the `/static/...`
 * route in Commit 6c depends on this path shape.
 *
 * Ambient context
 * ---------------
 * Deliberately NOT using `getRunContext()` — `{ runId, bus, signal }` are
 * explicit opts so unit tests can exercise this file in isolation the same
 * way `rag.ts` can. The ambient-vs-explicit asymmetry between this and
 * `runRagCall` is acknowledged (see the 5b handoff record) and deferred to
 * the Week-2+ consistency pass.
 */

/** ---------- Error type ---------- */

export class PlaywrightMcpError extends Error {
  public readonly toolName?: string;
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown, toolName?: string) {
    super(message);
    this.name = "PlaywrightMcpError";
    this.cause = cause;
    this.toolName = toolName;
  }
}

/** ---------- Public types ---------- */

/** Exact shape `@playwright/mcp@0.0.x`'s `browser_fill_form` accepts per
 *  field. Every key is required and `additionalProperties: false` on the
 *  server side — sending anything else is a hard schema error. Discovered
 *  during 6b-hotfix-2 live smoke: our earlier `{ref, value}` shape hit
 *  "invalid_type: expected string, received undefined at fields[0].name".
 *
 *  - `name` is a human-readable field label (any string; surfaces in the
 *    MCP server's own tool logs but is not semantically validated).
 *  - `type` MUST be one of the enum values below — textbox/checkbox/radio/
 *    combobox/slider. MCP uses this to branch its Playwright fill logic.
 *  - `ref` is the ref token returned by a prior `browser_snapshot`.
 *  - `value` is a string for every type. For checkboxes pass "true"/"false". */
export type FillFormField = {
  name: string;
  type: "textbox" | "checkbox" | "radio" | "combobox" | "slider";
  ref: string;
  value: string;
};

export type BrowserSession = {
  /** Update the `stepId` that future frames emitted by this session will
   *  carry. Called by `executeStep` in 6b when it inherits a session that
   *  `dryRunStep` originally created — the session handle is the same, but
   *  frames should be bucketed under the current workflow step. */
  setStepId(stepId: StepId): void;

  /** Navigate the active page to `url`. Emits `browser.nav` (on success) plus
   *  the tool.* span. Throws `PlaywrightMcpError` on MCP failure. */
  navigate(url: string): Promise<void>;

  /** Capture the current page's accessibility tree. Returns the raw YAML
   *  text produced by `@playwright/mcp`'s `browser_snapshot`. Callers are
   *  responsible for extracting `ref` IDs (regex / YAML walk) before passing
   *  them into `click` or `fillForm`. Week 2's skill-card schema will
   *  abstract this parsing; 6a keeps it raw by design. */
  snapshot(): Promise<{ text: string }>;

  /** Click the element identified by `ref` from a prior snapshot. */
  click(args: { element: string; ref: string }): Promise<void>;

  /** Bulk-fill form fields. Every field MUST include `name`, `type`, `ref`,
   *  `value` — the MCP server schema is strict (`additionalProperties:
   *  false`, all four keys required). See `FillFormField` docs above. */
  fillForm(fields: FillFormField[]): Promise<void>;

  /** Take a PNG screenshot. Filename is auto-assigned as `${seq}.png` where
   *  `seq = bus.nextSeq(runId)` — monotonic per-run, matches reviewer UI
   *  ordering, keeps the reviewer's `/static/runs/:runId/:filename` route
   *  computable from the frame alone. Returns the absolute filesystem path. */
  takeScreenshot(label: string, opts?: { fullPage?: boolean }): Promise<{ path: string; label: string }>;

  /** Pull and emit buffered browser console messages. */
  consoleMessages(): Promise<{ messages: Array<{ level: "log" | "warn" | "error"; text: string }> }>;

  /** Close the MCP transport (and kill the subprocess). Idempotent. */
  close(): Promise<void>;
};

/** ---------- Factory injection (tests only) ---------- */

/** Minimal surface of `@modelcontextprotocol/sdk`'s `Client` that we use.
 *  Exposed so `playwrightMcp.test.ts` can inject a mock without installing
 *  `undici` / patching globals. Prod passes the real `Client`. */
export type McpClientLike = {
  connect(transport: unknown): Promise<void>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
};

/** The subset of `CallToolResult` we read from. */
export type McpCallToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

export type LaunchBrowserOptions = {
  runId: string;
  bus: EventBus;
  /** StepId that frames emitted by this session will initially carry. The
   *  caller (typically `dryRunStep`) passes its own stepId; `setStepId` lets
   *  `executeStep` re-tag the session later. */
  stepId: StepId;
  /** External cancellation — if this aborts, the session closes and any
   *  in-flight tool call rejects. */
  signal?: AbortSignal;
  /** Root directory for Playwright MCP output. Defaults to
   *  `/workspace/.playwright-videos` (the compose volume mount). */
  outputRoot?: string;
  /** Test-only: supply an already-connected `McpClientLike`. When set,
   *  `transportFactory` is NOT invoked and `client.connect()` is skipped. */
  clientFactory?: () => McpClientLike;
  /** Test-only: intercept the transport constructor so tests can assert on
   *  the spawn args. When set, this runs instead of `new StdioClientTransport`. */
  transportFactory?: (params: StdioServerParameters) => unknown;
  /** Test-only: override the process-tree kill helper. Production defaults
   *  to a `ps`-based walk that SIGKILLs `npx @playwright/mcp`'s descendants
   *  (specifically Chromium, which survives SIGTERM to the direct child
   *  under the SDK's default spawn config). Tests inject a stub so they can
   *  assert the cleanup path runs without touching real OS processes. */
  killProcessTreeImpl?: (rootPid: number) => Promise<void> | void;
};

/** Default root — agent container mounts `playwright-videos:/workspace/.playwright-videos`. */
const DEFAULT_OUTPUT_ROOT = "/workspace/.playwright-videos";

/** ---------- Main entry point ---------- */

export async function launchBrowser(opts: LaunchBrowserOptions): Promise<BrowserSession> {
  const outputRoot = opts.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const runDir = `${outputRoot}/${opts.runId}`;
  // Per-run Chromium profile. Dot-prefixed so it won't be mistaken for a
  // screenshot output by 6c-2's /static route extension whitelist, and
  // co-located under `runDir` so teardown stays atomic with the rest of
  // the run's artifacts. Without this, `@playwright/mcp` reuses a single
  // shared profile across `POST /triage` invocations and session cookies
  // bleed between runs — 6b-hotfix-5 live smoke surfaced this as
  // "login refs missing" on a second consecutive run (the browser was
  // still logged in from the first).
  const profileDir = `${runDir}/.mcp-profile`;
  let currentStepId: StepId = opts.stepId;

  if (opts.signal?.aborted) {
    throw new PlaywrightMcpError(
      "launchBrowser invoked with an already-aborted signal",
      opts.signal.reason,
    );
  }

  // Commit 7b.i — the MCP SDK's `client.callTool({ signal })` adds one
  // abort listener per invocation. With 7a.iv's post-action screenshots
  // roughly doubling tool calls per run (6 labelled + ~6-8 `:after`
  // implicit screenshots), Node's default 10-listener threshold is
  // reliably breached mid-run, producing `MaxListenersExceededWarning`
  // in stderr. 32 is defensive — well above the current ~14 peak but
  // not so high that a real listener leak would go unnoticed.
  if (opts.signal) {
    setMaxListeners(32, opts.signal);
  }

  // Spawn params used whether we're building a real transport or handing
  // them to a test transportFactory for assertion.
  //
  // `--browser chromium` is required: @playwright/mcp@0.0.70 defaults to the
  // `chrome` channel (looks for `/opt/google/chrome/chrome`), but the agent
  // Dockerfile installs Playwright's bundled Chromium at `/opt/ms-playwright`
  // (exported via `PLAYWRIGHT_BROWSERS_PATH`, which `sanitizeProcessEnv`
  // forwards below). Without this flag the first `browser_navigate` call
  // fails with "Chromium distribution 'chrome' is not found". Week-1B live
  // smoke caught this during 6b verification.
  const serverParams: StdioServerParameters = {
    command: "npx",
    args: [
      "-y",
      "@playwright/mcp@0.0.70",
      "--headless", // Commit 7 flips to --no-headless + Xvfb
      "--browser",
      "chromium",
      "--output-dir",
      runDir,
      "--user-data-dir",
      profileDir,
    ],
    env: {
      ...sanitizeProcessEnv(),
      PLAYWRIGHT_MCP_OUTPUT_DIR: runDir,
    },
    stderr: "pipe",
  };

  // Construct transport (real or mocked). A mock transportFactory may return
  // any object — the `Client` boundary is what we unit-test against.
  let transport: unknown;
  if (opts.transportFactory) {
    transport = opts.transportFactory(serverParams);
  } else {
    transport = new StdioClientTransport(serverParams);
  }

  // Construct client (real or mocked).
  const client: McpClientLike =
    opts.clientFactory?.() ??
    (new Client(
      { name: "browser-agent", version: "0.1.0" },
      { capabilities: {} },
    ) as unknown as McpClientLike);

  // Connect. A real Client will start the subprocess via the transport; a
  // mock clientFactory is free to no-op.
  try {
    await client.connect(transport);
  } catch (err) {
    throw new PlaywrightMcpError(
      `failed to connect to Playwright MCP subprocess: ${(err as Error).message}`,
      err,
    );
  }

  // Snapshot the transport's npx pid (if available). Under `StdioClientTransport`
  // the child process is the `npx @playwright/mcp` wrapper; Chromium is a
  // grandchild whose PPID points at the MCP server's internal Playwright
  // launcher. SIGTERM to npx (which the SDK's `close()` sends) doesn't
  // propagate, so Chromium survives and gets reparented to init. We track
  // the pid so the wrapper `close()` below can walk the descendant tree and
  // SIGKILL everything.
  //
  // Tests can drive this path by returning an object with a `pid` number
  // from `transportFactory`; when the factory returns an object without a
  // pid (or a negative pid), the kill path is skipped.
  const rawPid = (transport as { pid?: number | null | undefined }).pid;
  const rootPid: number | null =
    typeof rawPid === "number" && rawPid > 0 ? rawPid : null;

  const killTree = opts.killProcessTreeImpl ?? defaultKillProcessTree;

  // Single abort path: either the external signal fires or we propagate a
  // close call. Both converge on `close()`, which is idempotent.
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch (err) {
      logger.warn({ runId: opts.runId, err }, "[playwrightMcp] client.close threw");
    }
    // After the SDK's close: walk the MCP subprocess tree and SIGKILL any
    // descendants still alive (specifically Chromium). Idempotent — if the
    // tree is already empty, `defaultKillProcessTree` is a no-op.
    if (rootPid != null) {
      try {
        await Promise.resolve(killTree(rootPid));
      } catch (err) {
        logger.warn(
          { runId: opts.runId, rootPid, err },
          "[playwrightMcp] process tree kill failed; orphaned Chromium may remain",
        );
      }
    }
    // Best-effort profile cleanup. Each run uses its own `.mcp-profile` dir
    // for session isolation; leaving them would slowly fill the
    // `playwright-videos` volume (~5-20 MB per run). Failure here is
    // logged but non-fatal — stale profile dirs are a disk-space
    // annoyance, not a correctness issue.
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch (err) {
      logger.debug(
        { runId: opts.runId, profileDir, err },
        "[playwrightMcp] profile dir cleanup failed",
      );
    }
  };

  // Wire abort → close. Listener is cleaned up by `close()`.
  const onAbort = (): void => {
    logger.info({ runId: opts.runId }, "[playwrightMcp] abort received; closing MCP client");
    void close();
  };
  if (opts.signal) {
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Generic helper: span + callTool + span close. Used by every method below.
  const callWithSpan = async <T>(args: {
    toolName: `playwright.${string}`;
    mcpToolName: string;
    mcpArgs: Record<string, unknown>;
    /** Frames to emit on success BETWEEN tool.started and tool.completed —
     *  e.g. `browser.nav`, `browser.screenshot`. */
    onResult: (result: McpCallToolResult) => { frames: SpanFrame[]; value: T };
  }): Promise<T> => {
    if (closed) {
      throw new PlaywrightMcpError(
        `cannot invoke ${args.toolName}: session already closed`,
        undefined,
        args.toolName,
      );
    }

    const invocationId = randomUUID();
    const startedAt = performance.now();

    opts.bus.publish({
      runId: opts.runId,
      stepId: currentStepId,
      payload: {
        type: "tool.started",
        invocationId,
        name: args.toolName,
        args: args.mcpArgs,
      },
    });

    let result: McpCallToolResult;
    try {
      result = await client.callTool(
        { name: args.mcpToolName, arguments: args.mcpArgs },
        undefined,
        { signal: opts.signal },
      );
    } catch (err) {
      emitToolFailed(opts, currentStepId, invocationId, args.toolName, err);
      throw new PlaywrightMcpError(
        `${args.toolName} transport error: ${(err as Error).message}`,
        err,
        args.toolName,
      );
    }

    if (result.isError) {
      const detail = extractText(result) ?? "tool reported isError=true";
      emitToolFailed(opts, currentStepId, invocationId, args.toolName, new Error(detail));
      throw new PlaywrightMcpError(
        `${args.toolName} returned isError: ${detail}`,
        result,
        args.toolName,
      );
    }

    const { frames, value } = args.onResult(result);
    for (const f of frames) {
      opts.bus.publish({
        runId: opts.runId,
        stepId: currentStepId,
        payload: f,
      });
    }

    opts.bus.publish({
      runId: opts.runId,
      stepId: currentStepId,
      payload: {
        type: "tool.completed",
        invocationId,
        name: args.toolName,
        resultSummary: summarize(result),
        durationMs: Math.round(performance.now() - startedAt),
      },
    });

    return value;
  };

  // Commit 7a.iv — screenshot helper shared by the public `takeScreenshot`
  // method and the post-action hook. Extracted as a closure-local const
  // (not a method on `session`) so the post-action hook can call it
  // directly without a forward-reference to `session` itself (TDZ trap if
  // we tried to call `session.takeScreenshot` from here). Semantics are
  // unchanged from the pre-7a.iv `takeScreenshot` body: same
  // absolute-path filename contract, same `browser.screenshot` envelope
  // frame emission, same `tool.started → tool.completed` span.
  const doTakeScreenshot = async (
    label: string,
    screenshotOpts?: { fullPage?: boolean },
  ): Promise<{ path: string; label: string }> => {
    const seq = opts.bus.nextSeq(opts.runId);
    const absolutePath = `${runDir}/${seq}.png`;
    return callWithSpan({
      toolName: "playwright.browser_take_screenshot",
      mcpToolName: "browser_take_screenshot",
      // `filename` MUST be an absolute path. @playwright/mcp@0.0.70's
      // `workspaceFile()` in playwright-core/lib/tools/backend/context.js
      // resolves a relative `filename` against the MCP server's CWD
      // (our `/workspace/services/agent`), NOT against `--output-dir`.
      // 6b-hotfix-4 live smoke proved this: frames reported success, but
      // 22 stray PNGs piled up in the agent package root instead of
      // under `playwright-videos/<runId>/`. `--output-dir` is only
      // consulted when `filename` is omitted (via the `outputFile()`
      // path). Passing the absolute path bypasses workspaceFile's
      // CWD-resolution entirely and lands the PNG where 6c's `/static`
      // route expects it. `type: "png"` is the schema default and
      // harmless to set explicitly — kept for forward-compat should the
      // default change in a future patch.
      mcpArgs: {
        type: "png",
        filename: absolutePath,
        ...(screenshotOpts?.fullPage !== undefined
          ? { fullPage: screenshotOpts.fullPage }
          : {}),
      },
      onResult: () => ({
        frames: [
          { type: "browser.screenshot", path: absolutePath, label },
        ],
        value: { path: absolutePath, label },
      }),
    });
  };

  // Commit 7a.iv — post-action screenshot hook. Called after every
  // successful `click` / `fillForm` to give the reviewer's behavior feed
  // ~1 snapshot per user-visible browser action (PNG count per happy-path
  // run bumps from 6 → ~12-15). Wrapped in try/catch that downgrades any
  // screenshot failure to a debug log: a successful click must never be
  // poisoned by a flaky post-action screenshot, because screenshots are
  // diagnostic, not semantic. Failure ordering is intentional — the
  // calling method's `await callWithSpan(...)` throws BEFORE this hook
  // runs on action failure, so failed clicks emit no post-action frames
  // (test [2] guards that span invariant).
  const emitPostActionScreenshot = async (mcpToolName: string): Promise<void> => {
    try {
      await doTakeScreenshot(`${mcpToolName}:after`);
    } catch (err) {
      logger.debug(
        {
          runId: opts.runId,
          mcpToolName,
          err: err instanceof Error ? err.message : String(err),
        },
        "[playwrightMcp] post-action screenshot failed; continuing",
      );
    }
  };

  const session: BrowserSession = {
    setStepId(stepId: StepId) {
      currentStepId = stepId;
    },

    async navigate(url: string) {
      await callWithSpan({
        toolName: "playwright.browser_navigate",
        mcpToolName: "browser_navigate",
        mcpArgs: { url },
        onResult: () => ({
          frames: [{ type: "browser.nav", url }],
          value: undefined as void,
        }),
      });
    },

    async snapshot() {
      return callWithSpan({
        toolName: "playwright.browser_snapshot",
        mcpToolName: "browser_snapshot",
        mcpArgs: {},
        onResult: (result) => {
          const text = extractText(result) ?? "";
          return { frames: [], value: { text } };
        },
      });
    },

    async click(clickArgs: { element: string; ref: string }) {
      await callWithSpan({
        toolName: "playwright.browser_click",
        mcpToolName: "browser_click",
        mcpArgs: { element: clickArgs.element, ref: clickArgs.ref },
        onResult: () => ({ frames: [], value: undefined as void }),
      });
      // Commit 7a.iv — implicit post-action snapshot. Only reached on
      // success; a failed click's `callWithSpan` throws first.
      await emitPostActionScreenshot("browser_click");
    },

    async fillForm(fields) {
      await callWithSpan({
        toolName: "playwright.browser_fill_form",
        mcpToolName: "browser_fill_form",
        mcpArgs: { fields },
        onResult: () => ({ frames: [], value: undefined as void }),
      });
      // Commit 7a.iv — implicit post-action snapshot (success-only).
      await emitPostActionScreenshot("browser_fill_form");
    },

    async takeScreenshot(label, screenshotOpts) {
      // Thin delegation to the closure-local helper so both public
      // (`session.takeScreenshot`) and implicit (post-action hook)
      // screenshots go through the exact same code path.
      return doTakeScreenshot(label, screenshotOpts);
    },

    async consoleMessages() {
      return callWithSpan({
        toolName: "playwright.browser_console_messages",
        mcpToolName: "browser_console_messages",
        mcpArgs: {},
        onResult: (result) => {
          const raw = extractText(result) ?? "";
          const messages = parseConsoleMessages(raw);
          return {
            frames: messages.map((m) => ({
              type: "browser.console" as const,
              level: m.level,
              text: m.text,
            })),
            value: { messages },
          };
        },
      });
    },

    async close() {
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onAbort);
      }
      await close();
    },
  };

  return session;
}

/** ---------- Internal helpers ---------- */

type SpanFrame =
  | { type: "browser.nav"; url: string; title?: string }
  | { type: "browser.screenshot"; path: string; label: string }
  | { type: "browser.console"; level: "log" | "warn" | "error"; text: string };

function emitToolFailed(
  opts: LaunchBrowserOptions,
  stepId: StepId,
  invocationId: string,
  name: `playwright.${string}`,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  opts.bus.publish({
    runId: opts.runId,
    stepId,
    payload: {
      type: "tool.failed",
      invocationId,
      name,
      error: {
        message: message.slice(0, 1000),
        where: name,
      },
    },
  });
}

function extractText(result: McpCallToolResult): string | null {
  const first = result.content?.[0];
  if (!first) return null;
  if (typeof first.text === "string") return first.text;
  return null;
}

function summarize(result: McpCallToolResult): Record<string, unknown> {
  const text = extractText(result);
  return {
    contentItems: result.content?.length ?? 0,
    textLen: text?.length ?? 0,
  };
}

/** Best-effort Playwright MCP console parser. The tool returns a text block
 *  with one message per line; formats seen in `@playwright/mcp@0.0.70` include
 *  `[log] message`, `[error] message`, `[warning] message`, and bare
 *  `message` with no level tag. Unknown levels normalize to "log" since the
 *  envelope `BrowserConsoleFrame.level` is constrained to `log|warn|error`.
 *  On empty / unparseable input, returns `[]` (no frames emitted). */
function parseConsoleMessages(
  raw: string,
): Array<{ level: "log" | "warn" | "error"; text: string }> {
  if (!raw.trim()) return [];
  const out: Array<{ level: "log" | "warn" | "error"; text: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^\[([a-z]+)\]\s+(.*)$/i.exec(trimmed);
    if (m) {
      const rawLevel = (m[1] ?? "").toLowerCase();
      const text = (m[2] ?? "").slice(0, 2000);
      out.push({ level: normalizeLevel(rawLevel), text });
    } else {
      out.push({ level: "log", text: trimmed.slice(0, 2000) });
    }
  }
  return out;
}

function normalizeLevel(raw: string): "log" | "warn" | "error" {
  if (raw === "error" || raw === "fatal") return "error";
  if (raw === "warn" || raw === "warning") return "warn";
  return "log";
}

/** Walk the process tree rooted at `rootPid` and SIGKILL every descendant.
 *  Kills leaves first so parents can't mask child survival. Uses `ps -o
 *  pid,ppid -ax` which is available on Linux (the agent container's Debian
 *  base) and macOS; call is shell-free so no injection surface. Any failure
 *  (ps missing, permission denied, process already gone) is swallowed with
 *  a debug log — we'd rather orphan a Chromium than crash the agent run. */
function defaultKillProcessTree(rootPid: number): void {
  let output: string;
  try {
    output = execSync("ps -o pid,ppid -ax", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    logger.debug({ rootPid, err }, "[playwrightMcp] ps probe failed; skipping tree kill");
    return;
  }

  const children = new Map<number, number[]>();
  for (const line of output.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1] ?? "", 10);
    const ppid = Number.parseInt(m[2] ?? "", 10);
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    const bucket = children.get(ppid) ?? [];
    bucket.push(pid);
    children.set(ppid, bucket);
  }

  // BFS collect, then kill in reverse so leaves go first.
  const toKill: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid == null) break;
    toKill.push(pid);
    const kids = children.get(pid) ?? [];
    queue.push(...kids);
  }

  for (const pid of toKill.reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited — no-op.
    }
  }
}

/** Inherit a minimal env into the MCP subprocess — PATH + HOME + friends so
 *  `npx` can resolve, plus the Playwright browsers path the agent Dockerfile
 *  sets. Deliberately excludes `ANTHROPIC_API_KEY` and database creds; the
 *  browser subprocess has no need for them. */
function sanitizeProcessEnv(): Record<string, string> {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "PLAYWRIGHT_BROWSERS_PATH",
    "NODE_PATH",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}
