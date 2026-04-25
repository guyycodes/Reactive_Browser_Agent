import { describe, it, expect, beforeEach, vi } from "vitest";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import type { BrowserSession } from "../src/mastra/tools/playwrightMcp.js";
import type { Skill } from "../src/schemas/skill-card.js";
import type { StreamResult } from "../src/llm/streamMapper.js";

/**
 * week2d Part 3c — `runVerifyStep` structured-postcondition redesign.
 *
 *   [1] skip cascade: inputData.skipped=true → pass-through (no LLM call)
 *   [2] hard-fail guard (polish #2): stepsRun=0 && !skipped → success=false
 *       BEFORE the LLM call; streamMessage NEVER invoked
 *   [3] structured JSON happy path: Sonnet emits {success:true, evidence[]}
 *       → parsed verbatim, evidence cites postconditions
 *   [4] structured JSON failure path: Sonnet emits {success:false, evidence[]}
 *       → preserved; verify does not override
 *   [5] empty-postconditions fallback: tempSkillCard has no postconditions
 *       → degrade to success=(stepsRun>0), evidence cites degradation
 *   [6] no-browser fallback: ctx.browser undefined → same structural-success
 *       degradation path with different evidence message
 *   [7] malformed JSON: Sonnet emits non-JSON → success=false soft-fail
 */

const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ─────────────────────── streamMessage mock ───────────────────────

const scriptedResponses: Array<{ text: string }> = [];
let streamMessageCallCount = 0;

vi.mock("../src/llm/streamMapper.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/streamMapper.js")>(
    "../src/llm/streamMapper.js",
  );
  return {
    ...actual,
    streamMessage: vi.fn(async (): Promise<StreamResult> => {
      streamMessageCallCount++;
      const next = scriptedResponses.shift() ?? { text: "" };
      return {
        text: next.text,
        thinking: "",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }),
  };
});

// ─────────────────────── fixtures ───────────────────────

function makeStubSession(snapshotText: string): BrowserSession {
  return {
    setStepId: () => {},
    navigate: async () => {},
    snapshot: async () => ({ text: snapshotText }),
    click: async () => {},
    fillForm: async () => {},
    takeScreenshot: async (label) => ({ path: "/tmp/x.png", label }),
    consoleMessages: async () => ({ messages: [] }),
    close: async () => {},
  };
}

function makeSkill(
  postconditions: string[] | undefined = ["user status is active"],
): Skill {
  return {
    name: "reset_password_materialized",
    description: "Materialized reset-password skill",
    destructive: true,
    ...(postconditions !== undefined ? { postconditions } : {}),
    steps: [
      { tool: "snapshot", args: {}, destructive: false },
      { tool: "click", args: { element: "Reset password button" }, destructive: true },
    ],
  } as Skill;
}

function makeExecuteInput(
  overrides: Partial<{ stepsRun: number; skipped: boolean }> = {},
): {
  stepsRun: number;
  skipped: boolean;
  review: {
    decision: "approve" | "reject" | "edit" | "terminate";
    approved: boolean;
    dryRun: {
      domMatches: boolean;
      anomalies: string[];
      plan: Record<string, unknown>;
      actionTrace: unknown[];
      boundaryReached: null;
    };
  };
} {
  return {
    stepsRun: overrides.stepsRun ?? 1,
    skipped: overrides.skipped ?? false,
    review: {
      decision: "approve",
      approved: true,
      dryRun: {
        domMatches: true,
        anomalies: [],
        plan: {},
        actionTrace: [],
        boundaryReached: null,
      },
    },
  };
}

// ─────────────────────── tests ───────────────────────

describe("runVerifyStep — Part 3c structured redesign", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ ringBufferSize: 64 });
    scriptedResponses.length = 0;
    streamMessageCallCount = 0;
  });

  it("[1] skip cascade: inputData.skipped=true → pass-through verbatim, NO LLM call", async () => {
    const { runVerifyStep } = await import("../src/mastra/workflows/triage.js");
    const input = makeExecuteInput({ stepsRun: 0, skipped: true });
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: makeStubSession(""), tempSkillCard: makeSkill() },
      () => runVerifyStep(input as never),
    );
    expect(result.skipped).toBe(true);
    expect(result.success).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(streamMessageCallCount).toBe(0);
  });

  it("[2] hard-fail guard (polish #2): stepsRun=0 && !skipped → success=false BEFORE LLM call, evidence cites zero-step condition", async () => {
    const { runVerifyStep } = await import("../src/mastra/workflows/triage.js");
    const input = makeExecuteInput({ stepsRun: 0, skipped: false });
    const result = await withRunContext(
      { runId: RUN_ID, bus, browser: makeStubSession(""), tempSkillCard: makeSkill() },
      () => runVerifyStep(input as never),
    );
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.evidence[0]).toMatch(/executeStep ran 0 steps/);
    // Critical — LLM was NEVER called.
    expect(streamMessageCallCount).toBe(0);
  });

  it("[3] structured JSON happy path: Sonnet emits {success:true, evidence:[...]} → parsed verbatim", async () => {
    scriptedResponses.push({
      text: JSON.stringify({
        success: true,
        evidence: [
          "user-status badge shows 'active' in the DOM tree",
          "user-last-reset field shows fresh ISO timestamp 2026-04-25T01:28:00Z",
        ],
      }),
    });
    const { runVerifyStep } = await import("../src/mastra/workflows/triage.js");
    const input = makeExecuteInput({ stepsRun: 1 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        browser: makeStubSession("user-status: active\nuser-last-reset: 2026-04-25T01:28:00Z"),
        tempSkillCard: makeSkill(["user status is active", "lastPasswordReset advanced"]),
      },
      () => runVerifyStep(input as never),
    );
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatch(/badge shows 'active'/);
    expect(result.evidence[1]).toMatch(/fresh ISO timestamp/);
    expect(streamMessageCallCount).toBe(1);
  });

  it("[4] structured JSON failure path: Sonnet emits {success:false, evidence:[...]} → preserved, verify does not override", async () => {
    scriptedResponses.push({
      text: JSON.stringify({
        success: false,
        evidence: [
          "user-status still shows 'locked' — postcondition 'user status is active' not satisfied",
        ],
      }),
    });
    const { runVerifyStep } = await import("../src/mastra/workflows/triage.js");
    const input = makeExecuteInput({ stepsRun: 1 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        browser: makeStubSession("user-status: locked"),
        tempSkillCard: makeSkill(["user status is active"]),
      },
      () => runVerifyStep(input as never),
    );
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.evidence[0]).toMatch(/locked.*not satisfied/);
  });

  it("[5] empty-postconditions fallback: tempSkillCard has no postconditions → degrade to success=(stepsRun>0), NO LLM call", async () => {
    const { runVerifyStep } = await import("../src/mastra/workflows/triage.js");
    const input = makeExecuteInput({ stepsRun: 2 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        browser: makeStubSession(""),
        tempSkillCard: makeSkill([]), // empty postconditions
      },
      () => runVerifyStep(input as never),
    );
    expect(result.success).toBe(true); // stepsRun > 0
    expect(result.evidence[0]).toMatch(/No postconditions declared/);
    expect(streamMessageCallCount).toBe(0);
  });

  it("[6] no-browser fallback: ctx.browser undefined → same structural degradation path, different evidence", async () => {
    const { runVerifyStep } = await import("../src/mastra/workflows/triage.js");
    const input = makeExecuteInput({ stepsRun: 3 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        browser: undefined,   // no session
        tempSkillCard: makeSkill(["user status is active"]),
      },
      () => runVerifyStep(input as never),
    );
    expect(result.success).toBe(true); // stepsRun > 0
    expect(result.evidence[0]).toMatch(/No active browser session/);
    expect(streamMessageCallCount).toBe(0);
  });

  it("[7] malformed JSON: Sonnet emits non-JSON → soft-fail to success=false + raw text as evidence", async () => {
    scriptedResponses.push({
      text: "This is not JSON; it's narrative prose about verification.",
    });
    const { runVerifyStep } = await import("../src/mastra/workflows/triage.js");
    const input = makeExecuteInput({ stepsRun: 1 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        browser: makeStubSession("dom state"),
        tempSkillCard: makeSkill(["user status is active"]),
      },
      () => runVerifyStep(input as never),
    );
    expect(result.success).toBe(false);
    expect(result.evidence[0]).toMatch(/verify model returned non-JSON/);
  });
});
