import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import { runClassifyStep } from "../src/mastra/workflows/triage.js";
import type { StreamResult } from "../src/llm/streamMapper.js";

/**
 * Classify-step coverage.
 *
 *   [1] Commit 7b.iii.a — `runClassifyStep` reads `priorObservations`
 *       from the ambient `RunContext` and prepends them to the user
 *       message on pass N > 0 of a Block 1 iteration. Pass 0 /
 *       out-of-controller invocations continue to produce the
 *       pre-hotfix user message shape.
 *   [2] Same, with observations present → Prior-passes prefix is
 *       rendered with numbered entries.
 *   [3] week2c-react-classify — ReAct tool-dispatch path: when
 *       streamMessage returns a `toolUse` on iter 0, the runner
 *       dispatches `rag_retrieveCategoryHints` and the final output
 *       reflects iter-1's JSON.
 *   [4] week2c-react-classify — produceOutput fallback: when the
 *       final iteration's text is not valid classification JSON,
 *       `runClassifyStep` returns the documented defaults
 *       (`uncategorized` / `low` / `[]` / `0.3`) rather than throwing.
 */

const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let capturedUserMsg: string | null = null;
/** Per-test override for the streamMessage mock. When null, the
 *  default impl (minimal-valid-classification-JSON return) applies. */
let streamMessageImpl: ((args: unknown) => Promise<StreamResult>) | null = null;
/** Per-test override for the retrieveCategoryHints mock. When set, the
 *  ReAct tool dispatch hits this instead of the real HTTP client. */
let retrieveCategoryHintsImpl:
  | ((
      category: string,
      query: string,
      opts: { signal?: AbortSignal },
    ) => Promise<{
      docs: string[];
      hits: unknown[];
      request_id: string;
      elapsed_seconds: number;
    }>)
  | null = null;

vi.mock("../src/llm/streamMapper.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/streamMapper.js")>(
    "../src/llm/streamMapper.js",
  );
  return {
    ...actual,
    streamMessage: vi.fn(async (args: unknown): Promise<StreamResult> => {
      if (streamMessageImpl) return streamMessageImpl(args);
      const userMsg =
        ((args as { messages?: Array<{ content?: string }> }).messages?.[0]
          ?.content as string) ?? "";
      capturedUserMsg = userMsg;
      // Default: return minimal valid classification JSON so tests [1]/[2]
      // don't hit the fallback path.
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

vi.mock("../src/mastra/tools/rag.js", async () => {
  const actual = await vi.importActual<typeof import("../src/mastra/tools/rag.js")>(
    "../src/mastra/tools/rag.js",
  );
  return {
    ...actual,
    retrieveCategoryHints: vi.fn(
      async (
        category: string,
        query: string,
        opts: { signal?: AbortSignal },
      ) => {
        if (retrieveCategoryHintsImpl)
          return retrieveCategoryHintsImpl(category, query, opts);
        // Default: minimal empty-hits response (classify tests [1]/[2]
        // never call the tool because toolUses is empty by default).
        return {
          docs: [],
          hits: [],
          request_id: "test-default",
          elapsed_seconds: 0.01,
        };
      },
    ),
  };
});

describe("classifyStep", () => {
  beforeEach(() => {
    capturedUserMsg = null;
    streamMessageImpl = null;
    retrieveCategoryHintsImpl = null;
  });
  afterEach(() => {
    capturedUserMsg = null;
    streamMessageImpl = null;
    retrieveCategoryHintsImpl = null;
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

  it("[3] ReAct tool path: iter-0 returns toolUse → runner dispatches retrieveCategoryHints → iter-1 returns final JSON", async () => {
    // Sequence streamMessage returns by call count: iter 0 emits a
    // tool_use block; iter 1 emits the final classification JSON with
    // empty toolUses so the runner treats iter 1 as final.
    let callCount = 0;
    streamMessageImpl = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "I should check the skill-card hints to confirm my category guess.",
          thinking: "",
          toolUses: [
            {
              id: "toolu_test_001",
              name: "rag_retrieveCategoryHints",
              input: {
                category: "account_management",
                query: "password reset locked user",
              },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 20, outputTokens: 40 },
        };
      }
      // iter 1: final
      return {
        text: JSON.stringify({
          category: "account_management",
          urgency: "high",
          targetApps: ["test-webapp"],
          confidence: 0.92,
        }),
        thinking: "",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 80, outputTokens: 30 },
      };
    };

    let rcCalledWith: { category: string; query: string } | null = null;
    retrieveCategoryHintsImpl = async (category, query) => {
      rcCalledWith = { category, query };
      return {
        docs: [],
        hits: [
          {
            id: "h1",
            score: 0.72,
            text: "Runbook excerpt about password resets.",
            source: "runbooks/password-reset.html",
            chunk_id: "c1",
          },
        ],
        request_id: "test-req-3",
        elapsed_seconds: 0.03,
      };
    };

    const bus = new EventBus({ ringBufferSize: 64 });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runClassifyStep({
        ticketId: "T-cs-3",
        subject: "Reset password for jane@example.com",
      }),
    );

    // Tool was dispatched with the iter-0 args.
    expect(rcCalledWith).toEqual({
      category: "account_management",
      query: "password reset locked user",
    });
    // Two streamMessage iterations fired.
    expect(callCount).toBe(2);
    // Final classification matches the iter-1 JSON.
    expect(result).toEqual({
      category: "account_management",
      urgency: "high",
      targetApps: ["test-webapp"],
      confidence: 0.92,
    });
  });

  it("[4] produceOutput fallback: malformed final JSON → runClassifyStep returns defaults without throwing", async () => {
    streamMessageImpl = async () => ({
      text: "this is not json {garbage",
      thinking: "",
      toolUses: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 15 },
    });

    const bus = new EventBus({ ringBufferSize: 32 });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runClassifyStep({
        ticketId: "T-cs-4",
        subject: "some ambiguous ticket",
      }),
    );

    expect(result).toEqual({
      category: "uncategorized",
      urgency: "low",
      targetApps: [],
      confidence: 0.3,
    });
  });

  it("[5] stepId attribution (hotfix-1): rag_retrieveCategoryHints frames carry stepId=classify, NOT retrieve", async () => {
    // Pre-hotfix, `runRagCall` hardcoded `stepId: "retrieve"` at all
    // 4 bus.publish sites, so classify's ReAct tool dispatch emitted
    // `tool.started` / `rag.retrieved` / `tool.completed` frames with
    // stepId="retrieve". Hotfix threads `ctx.stepId` from the ReactTool
    // invoke closure through `runRagCall.args.stepId`. This test guards
    // the attribution so a future drive-by refactor can't re-hardcode.
    let callCount = 0;
    streamMessageImpl = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: "",
          thinking: "",
          toolUses: [
            {
              id: "toolu_test_005",
              name: "rag_retrieveCategoryHints",
              input: {
                category: "account_management",
                query: "password reset locked user",
              },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 20, outputTokens: 40 },
        };
      }
      return {
        text: JSON.stringify({
          category: "account_management",
          urgency: "high",
          targetApps: ["test-webapp"],
          confidence: 0.9,
        }),
        thinking: "",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 60, outputTokens: 25 },
      };
    };
    retrieveCategoryHintsImpl = async () => ({
      docs: [],
      hits: [],
      request_id: "test-req-5",
      elapsed_seconds: 0.01,
    });

    const bus = new EventBus({ ringBufferSize: 128 });
    await withRunContext({ runId: RUN_ID, bus }, () =>
      runClassifyStep({
        ticketId: "T-cs-5",
        subject: "Reset password for jane@example.com",
      }),
    );

    // Replay the buffered frames for this run. Note: `bus.publish`
    // spreads the payload's fields directly onto the frame (see
    // `bus.ts:205-212`), so `type` and `name` are TOP-LEVEL properties
    // — not nested under `payload`.
    const frames = bus.replay(RUN_ID, 0);
    const ragFrames = frames.filter((f) => {
      const frame = f as unknown as { type?: string; name?: string };
      const isRagToolFrame =
        (frame.type === "tool.started" ||
          frame.type === "tool.completed" ||
          frame.type === "tool.failed") &&
        frame.name === "rag.retrieveCategoryHints";
      const isRagRetrievedFrame = frame.type === "rag.retrieved";
      return isRagToolFrame || isRagRetrievedFrame;
    });

    // Minimum: tool.started + rag.retrieved + tool.completed = 3 frames.
    expect(ragFrames.length).toBeGreaterThanOrEqual(3);

    // Every rag frame must carry stepId=classify (NOT retrieve).
    for (const f of ragFrames) {
      expect(f.stepId).toBe("classify");
    }

    // Belt-and-braces: no rag.retrieveCategoryHints frames should have
    // leaked into the retrieve stepId bucket.
    const misattributed = frames.filter((f) => {
      const frame = f as unknown as { name?: string };
      return (
        f.stepId === "retrieve" &&
        frame.name === "rag.retrieveCategoryHints"
      );
    });
    expect(misattributed).toEqual([]);
  });
});
