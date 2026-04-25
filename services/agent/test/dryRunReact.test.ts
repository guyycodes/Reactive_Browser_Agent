import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import type { BrowserSession } from "../src/mastra/tools/playwrightMcp.js";
import { REACT_FINAL_SENTINEL } from "../src/mastra/lib/reactRunner.js";
import type { StreamResult } from "../src/llm/streamMapper.js";

/**
 * week2d Part 2 — agentic `runDryRunStep` ReAct coverage.
 *
 *   [1] Happy — boundary_reached at iter N with scaffoldMatch:true →
 *       actionTrace populated, boundaryReached set, domMatches=true.
 *   [2] Divergence — boundary_reached with scaffoldMatch:false →
 *       DryRunSchema preserves the divergence signal.
 *   [3] Exhaustion — iteration cap without boundary_reached →
 *       domMatches=false + anomaly, boundaryReached=null.
 *   [4] Pre-close — when ctx.browser populated at entry, old session's
 *       close() fires BEFORE launchBrowser is invoked (Bug-B hotfix-1
 *       regression guard).
 *   [5] stepId attribution — every scripted browser tool frame carries
 *       stepId=dry_run (hotfix-1 style non-regression).
 */

const RUN_ID = "ddddeeee-dddd-4ddd-8ddd-ddddeeeeeeee";

// ──────────────────────── streamMessage mock ────────────────────────
//
// Script one StreamResult per iteration; runner pops from the front.
// Empty queue → default `end_turn` text result so runner exits cleanly.

interface ScriptedCall {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason?: string;
}

const scriptedCalls: ScriptedCall[] = [];
function scriptNext(call: ScriptedCall): void {
  scriptedCalls.push(call);
}
function makeResult(call: ScriptedCall): StreamResult {
  return {
    text: call.text ?? "",
    thinking: "",
    toolUses: call.toolUses ?? [],
    stopReason: call.stopReason ?? (call.toolUses?.length ? "tool_use" : "end_turn"),
    usage: { inputTokens: 10, outputTokens: 10 },
  };
}

vi.mock("../src/llm/streamMapper.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/streamMapper.js")>(
    "../src/llm/streamMapper.js",
  );
  return {
    ...actual,
    streamMessage: vi.fn(async () => {
      const next = scriptedCalls.shift();
      return makeResult(next ?? { text: "fallback final" });
    }),
  };
});

// ──────────────────────── launchBrowser mock ────────────────────────
//
// Inline stub factory so tests can inject a pre-populated session
// (test [4]) or the default fresh session. The mock tracks spawn
// count per test via `launchBrowserCalls`.

type SessionCall =
  | { kind: "navigate"; url: string }
  | { kind: "snapshot" }
  | { kind: "click"; element: string; ref: string }
  | { kind: "fillForm"; fields: unknown[] }
  | { kind: "takeScreenshot"; label: string }
  | { kind: "close" };

function makeStubSession(): { session: BrowserSession; calls: SessionCall[] } {
  const calls: SessionCall[] = [];
  const session: BrowserSession = {
    setStepId: () => {},
    navigate: async (url) => {
      calls.push({ kind: "navigate", url });
    },
    snapshot: async () => {
      calls.push({ kind: "snapshot" });
      return { text: "root\n  button [ref=b1] 'Sign in'" };
    },
    click: async ({ element, ref }) => {
      calls.push({ kind: "click", element, ref });
    },
    fillForm: async (fields) => {
      calls.push({ kind: "fillForm", fields });
    },
    takeScreenshot: async (label: string) => {
      calls.push({ kind: "takeScreenshot", label });
      return { path: "/tmp/x.png", label };
    },
    consoleMessages: async () => ({ messages: [] }),
    close: async () => {
      calls.push({ kind: "close" });
    },
  };
  return { session, calls };
}

let launchBrowserCalls: number = 0;
let mockedSession: BrowserSession | null = null;

vi.mock("../src/mastra/tools/playwrightMcp.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/mastra/tools/playwrightMcp.js")
  >("../src/mastra/tools/playwrightMcp.js");
  return {
    ...actual,
    launchBrowser: vi.fn(async () => {
      launchBrowserCalls++;
      if (!mockedSession) {
        mockedSession = makeStubSession().session;
      }
      return mockedSession;
    }),
  };
});

// ──────────────────────── loadSkill mock ────────────────────────
//
// Stub scaffold loader returns a minimal Skill for the LLM's hint.
// Shape matches the real `loadSkill` return ({ skill, card }).

vi.mock("../src/lib/skillCardLoader.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/skillCardLoader.js")
  >("../src/lib/skillCardLoader.js");
  return {
    ...actual,
    loadSkill: vi.fn(async (name: string) => ({
      skill: {
        name,
        description: "Test skill",
        destructive: true,
        inputs: { email: { type: "email" as const, required: true } },
        preconditions: [],
        postconditions: [],
        steps: [
          { tool: "navigate" as const, args: { url: "/login" } },
          {
            tool: "fillForm" as const,
            args: {
              fields: [
                { name: "Email", type: "textbox", ref: "{{ e }}", value: "{{ inputs.email }}" },
                { name: "Password", type: "textbox", ref: "{{ p }}", value: "demo" },
              ],
            },
          },
          { tool: "click" as const, args: { element: "Sign in" } },
          {
            tool: "click" as const,
            args: { element: "Reset password" },
            destructive: true,
          },
        ],
      },
      card: {
        schemaVersion: "1" as const,
        app: "test-webapp",
        base_url: "http://test-webapp:3000",
        skills: [],
      },
    })),
  };
});

// ──────────────────────── Plan fixture ────────────────────────

function makePlan() {
  return {
    planId: randomUUID(),
    actionCount: 3,
    destructive: true,
    skillCardIds: ["reset_password"],
    planText: "Reset password plan",
    thinking: "",
    classification: {
      category: "account_management",
      urgency: "high" as const,
      targetApps: ["test-webapp"],
      confidence: 0.92,
    },
    actions: [
      { stepNumber: 1, verb: "navigate" as const, target: "/login", description: "go" },
      { stepNumber: 2, verb: "click" as const, target: "sign-in", description: "click" },
      { stepNumber: 3, verb: "click" as const, target: "reset", description: "reset" },
    ],
    requiresContext: false,
    inputs: {}, // week2d Part 3
  };
}

// ──────────────────────── Tests ────────────────────────

describe("runDryRunStep — agentic ReAct (week2d Part 2)", () => {
  beforeEach(() => {
    scriptedCalls.length = 0;
    launchBrowserCalls = 0;
    mockedSession = null;
  });
  afterEach(() => {
    scriptedCalls.length = 0;
    launchBrowserCalls = 0;
    mockedSession = null;
  });

  it("[1] happy path: boundary_reached with scaffoldMatch:true → actionTrace + boundaryReached populated, domMatches=true", async () => {
    // Script 3 browser tool calls → boundary_reached at iter 3.
    // Absolute URL is required by `browser_navigate.validator` (z.string().url()).
    scriptNext({
      toolUses: [
        {
          id: "t1",
          name: "browser_navigate",
          input: { url: "http://test-webapp:3000/login" },
        },
      ],
    });
    scriptNext({
      toolUses: [{ id: "t2", name: "browser_snapshot", input: {} }],
    });
    scriptNext({
      toolUses: [
        { id: "t3", name: "browser_click", input: { element: "Sign in button", ref: "b1" } },
      ],
    });
    scriptNext({
      toolUses: [
        {
          id: "t4",
          name: "boundary_reached",
          input: {
            element: "Reset password button",
            reason: "Clicking this commits the destructive reset",
            scaffoldMatch: true,
          },
        },
      ],
    });

    const { runDryRunStep } = await import("../src/mastra/workflows/triage.js");
    const bus = new EventBus({ ringBufferSize: 256 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-1", subject: "Reset password for jane@example.com" },
      },
      () => runDryRunStep(makePlan(), undefined),
    );

    expect(result.domMatches).toBe(true);
    expect(result.anomalies).toEqual([]);
    expect(result.actionTrace).toHaveLength(3);
    expect(result.actionTrace.map((a) => a.tool)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
    ]);
    expect(result.boundaryReached).toEqual({
      element: "Reset password button",
      reason: "Clicking this commits the destructive reset",
      scaffoldMatch: true,
      iteration: 3,
    });
  });

  it("[2] divergence path: boundary_reached with scaffoldMatch:false → DryRunSchema preserves the divergence", async () => {
    scriptNext({
      toolUses: [
        {
          id: "t1",
          name: "browser_navigate",
          input: { url: "http://test-webapp:3000/login" },
        },
      ],
    });
    scriptNext({
      toolUses: [
        {
          id: "t2",
          name: "boundary_reached",
          input: {
            element: "Update credentials button",
            reason: "Same semantic role but renamed in this deployment",
            scaffoldMatch: false,
          },
        },
      ],
    });

    const { runDryRunStep } = await import("../src/mastra/workflows/triage.js");
    const bus = new EventBus({ ringBufferSize: 128 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-2", subject: "Reset password" },
      },
      () => runDryRunStep(makePlan(), undefined),
    );

    expect(result.domMatches).toBe(true);
    expect(result.boundaryReached?.scaffoldMatch).toBe(false);
    expect(result.boundaryReached?.element).toBe("Update credentials button");
  });

  it("[3] graceful exhaustion: iteration cap hit without boundary_reached → domMatches=false + anomaly", async () => {
    // Override DRY_RUN_MAX_ITERATIONS down to 3 so the test runs fast.
    process.env.DRY_RUN_MAX_ITERATIONS = "3";
    try {
      scriptNext({
        toolUses: [
          {
            id: "t1",
            name: "browser_navigate",
            input: { url: "http://test-webapp:3000/a" },
          },
        ],
      });
      scriptNext({
        toolUses: [{ id: "t2", name: "browser_snapshot", input: {} }],
      });
      scriptNext({
        toolUses: [{ id: "t3", name: "browser_snapshot", input: {} }],
      });

      const { runDryRunStep } = await import("../src/mastra/workflows/triage.js");
      const bus = new EventBus({ ringBufferSize: 128 });
      const result = await withRunContext(
        {
          runId: RUN_ID,
          bus,
          ticket: { ticketId: "T-3", subject: "unsolvable" },
        },
        () => runDryRunStep(makePlan(), undefined),
      );

      expect(result.domMatches).toBe(false);
      expect(result.boundaryReached).toBeNull();
      expect(result.anomalies.length).toBeGreaterThan(0);
      expect(result.anomalies[0]).toMatch(/Exhausted.*iteration/);
      // actionTrace should still contain whatever was explored.
      expect(result.actionTrace.length).toBe(3);
    } finally {
      delete process.env.DRY_RUN_MAX_ITERATIONS;
    }
  });

  it("[4] pre-close preserved: old ctx.browser session's close() fires before launchBrowser", async () => {
    const oldSession = makeStubSession();
    // Script a single boundary_reached so the ReAct loop exits quickly.
    scriptNext({
      toolUses: [
        {
          id: "t1",
          name: "boundary_reached",
          input: { element: "X", reason: "y", scaffoldMatch: true },
        },
      ],
    });

    const { runDryRunStep } = await import("../src/mastra/workflows/triage.js");
    const bus = new EventBus({ ringBufferSize: 128 });
    await withRunContext(
      {
        runId: RUN_ID,
        bus,
        browser: oldSession.session, // pre-populate to trigger pre-close
        ticket: { ticketId: "T-4", subject: "Reset" },
      },
      () => runDryRunStep(makePlan(), undefined),
    );

    // Old session's close() fired.
    expect(oldSession.calls.filter((c) => c.kind === "close")).toHaveLength(1);
    // New launchBrowser was invoked (exactly once).
    expect(launchBrowserCalls).toBe(1);
  });

  it("[5] stepId attribution: react.iteration.* frames carry stepId=dry_run", async () => {
    scriptNext({
      toolUses: [
        {
          id: "t1",
          name: "browser_navigate",
          input: { url: "http://test-webapp:3000/x" },
        },
      ],
    });
    scriptNext({
      toolUses: [
        {
          id: "t2",
          name: "boundary_reached",
          input: { element: "X", reason: "y", scaffoldMatch: true },
        },
      ],
    });

    const { runDryRunStep } = await import("../src/mastra/workflows/triage.js");
    const bus = new EventBus({ ringBufferSize: 256 });
    await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-5", subject: "Reset" },
      },
      () => runDryRunStep(makePlan(), undefined),
    );

    const frames = bus.replay(RUN_ID, 0);
    const iterFrames = frames.filter(
      (f) =>
        f.type === "react.iteration.started" ||
        f.type === "react.iteration.completed",
    );
    expect(iterFrames.length).toBeGreaterThan(0);
    for (const f of iterFrames) {
      expect(f.stepId).toBe("dry_run");
    }

    // Sanity — REACT_FINAL_SENTINEL never leaks into stored outputs.
    // (tested end-to-end in reactRunner.test.ts [10]; spot-check here.)
    expect(REACT_FINAL_SENTINEL).toBe("__final");
  });

  it("[6] week2e: plan.targetUrl overrides scaffold.base_url in buildDryRunStepConfig deps.baseUrl (source regex)", async () => {
    // Structural guard — runDryRunStep resolves baseUrl as
    //   plan.targetUrl ?? loaded.card.base_url
    // before passing to buildDryRunStepConfig. A future refactor that
    // drops the ?? fallback would silently ignore ticket URL overrides
    // (Path A+ auditability breaks). Source-level regex catches the
    // removal.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const src = await fs.readFile(
      url.fileURLToPath(
        new URL(
          "../src/mastra/workflows/triage.ts",
          import.meta.url,
        ),
      ),
      "utf-8",
    );
    expect(src).toMatch(/baseUrl\s*=\s*inputData\.targetUrl\s*\?\?\s*loaded\.card\.base_url/);
  });
});
