import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import { runClassifyStep } from "../src/mastra/workflows/triage.js";
import type { StreamResult } from "../src/llm/streamMapper.js";

/**
 * Commit 7b.iii.a — classifyStep observations threading.
 *
 * Guards that `runClassifyStep` reads `priorObservations` from the
 * ambient `RunContext` and prepends them to the user message on
 * pass N > 0 of a Block 1 iteration. Pass 0 / out-of-controller
 * invocations (priorObservations undefined or empty) continue to
 * produce the pre-hotfix user message shape.
 */

const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let capturedUserMsg: string | null = null;

vi.mock("../src/llm/streamMapper.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/streamMapper.js")>(
    "../src/llm/streamMapper.js",
  );
  return {
    ...actual,
    streamMessage: vi.fn(async (args): Promise<StreamResult> => {
      const userMsg = args.messages?.[0]?.content ?? "";
      capturedUserMsg = userMsg;
      // Return minimal valid classification JSON so runClassifyStep
      // doesn't hit its fallback path during tests.
      return {
        text: JSON.stringify({
          category: "account_management",
          urgency: "high",
          targetApps: ["test-webapp"],
          confidence: 0.85,
        }),
        thinking: "",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    }),
  };
});

describe("classifyStep — priorObservations threading (7b.iii.a)", () => {
  beforeEach(() => {
    capturedUserMsg = null;
  });
  afterEach(() => {
    capturedUserMsg = null;
  });

  it("[1] pass 0 (no priorObservations): user message omits Prior-passes prefix", async () => {
    const bus = new EventBus({ ringBufferSize: 32 });
    await withRunContext({ runId: RUN_ID, bus }, () =>
      runClassifyStep({
        ticketId: "T-cs-1",
        subject: "Reset password for jane@example.com",
      }),
    );

    expect(capturedUserMsg).toBeTruthy();
    expect(capturedUserMsg).not.toMatch(/Prior passes/);
    // Sanity: core fields still present.
    expect(capturedUserMsg).toMatch(/Ticket ID: T-cs-1/);
    expect(capturedUserMsg).toMatch(/Subject: Reset password/);
  });

  it("[2] pass N>0 (priorObservations set): user message prepends Prior-passes block with each observation numbered", async () => {
    const bus = new EventBus({ ringBufferSize: 32 });
    const observations = [
      "Pass 0 gap: missing Internal Admin Portal URL",
      "Pass 0 gap: runbook passages truncated",
    ];

    await withRunContext(
      { runId: RUN_ID, bus, priorObservations: observations },
      () =>
        runClassifyStep({
          ticketId: "T-cs-2",
          subject: "reset",
        }),
    );

    expect(capturedUserMsg).toBeTruthy();
    expect(capturedUserMsg).toMatch(/Prior passes \(2 observations carried forward\):/);
    expect(capturedUserMsg).toMatch(/1\. Pass 0 gap: missing Internal Admin Portal URL/);
    expect(capturedUserMsg).toMatch(/2\. Pass 0 gap: runbook passages truncated/);
    // Ticket fields still present after the prefix.
    expect(capturedUserMsg).toMatch(/Ticket ID: T-cs-2/);
  });
});
