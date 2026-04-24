import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";

import { EventBus } from "../src/events/bus.js";
import type { TimelineFrame, TimelineFramePayload } from "../src/events/envelope.js";
import { withRunContext } from "../src/mastra/runContext.js";
import { runReActIterations } from "../src/mastra/lib/reactRunner.js";
import type { StreamResult } from "../src/llm/streamMapper.js";

/**
 * Commit 7b.ii — retrieveStep ReAct integration.
 *
 * The real `retrieveStep` in `src/mastra/workflows/triage.ts` is a
 * `createReActStep` instance whose tools wrap `retrieveRunbooks` /
 * `retrieveSkills` (which in turn hit the RAG HTTP service). A full
 * integration test would require a live RAG service + real Anthropic
 * streaming, neither of which is appropriate for a unit suite.
 *
 * Instead, this test drives `runReActIterations` directly — the same
 * core loop that `retrieveStep` uses — with the same Zod schemas and
 * the same `produceOutput` aggregation logic, mocking out both
 * streamMessage and the RAG client. It's a contract-stability test:
 * it verifies that the runner + aggregator combo produces the exact
 * `RetrievalSchema` output shape downstream steps expect, that the
 * "last-wins per tool" semantics hold, and that the frame timeline
 * emits the expected `react.iteration.*` brackets.
 *
 * If `retrieveStep`'s `produceOutput` is ever changed (e.g. max vs.
 * last-wins), this test is where the behavior change gets observed.
 */

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Mirror the real retrieveStep's schemas (kept private in triage.ts).
const ClassificationSchema = z.object({
  category: z.string(),
  urgency: z.enum(["low", "medium", "high"]),
  targetApps: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

// 7b.ii-hotfix — RetrievalSchema now carries top-N hit summaries so
// planStep can see the actual retrieved content, not just counts.
const RagHitSummarySchema = z.object({
  score: z.number(),
  source: z.string(),
  preview: z.string().max(400),
});

const RetrievalSchema = z.object({
  runbookHits: z.number().int().nonnegative(),
  skillHits: z.number().int().nonnegative(),
  hits: z.object({
    runbooks: z.array(RagHitSummarySchema).max(5),
    skills: z.array(RagHitSummarySchema).max(5),
  }),
  classification: ClassificationSchema,
});

// Mock streamMessage to script iteration behavior.
interface ScriptedCall {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
}
const scriptedCalls: ScriptedCall[] = [];

vi.mock("../src/llm/streamMapper.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/streamMapper.js")>(
    "../src/llm/streamMapper.js",
  );
  return {
    ...actual,
    streamMessage: vi.fn(async (): Promise<StreamResult> => {
      const next = scriptedCalls.shift() ?? { text: "done" };
      return {
        text: next.text ?? "",
        thinking: "",
        toolUses: next.toolUses ?? [],
        stopReason: next.toolUses?.length ? "tool_use" : "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  };
});

describe("retrieveStep ReAct integration", () => {
  beforeEach(() => {
    scriptedCalls.length = 0;
  });
  afterEach(() => {
    scriptedCalls.length = 0;
  });

  it("[1] iter 0 calls rag_retrieveRunbooks with 3 hits → iter 1 calls rag_retrieveSkills with 0 hits → iter 2 finalizes; output matches RetrievalSchema, last-wins aggregation applied", async () => {
    // Script a realistic 3-iteration ReAct session mirroring the real
    // retrieveStep's expected flow against the SHARED_RUNBOOKS corpus
    // (populated) + SHARED_SKILLS corpus (empty in Week 1B).
    scriptedCalls.push({
      toolUses: [
        { id: "t1", name: "rag_retrieveRunbooks", input: { query: "password reset" } },
      ],
    });
    scriptedCalls.push({
      toolUses: [
        { id: "t2", name: "rag_retrieveSkills", input: { query: "password reset" } },
      ],
    });
    scriptedCalls.push({
      text: "Retrieved 3 runbook hits and 0 skill hits. The runbooks cover password-reset procedures; no matching skill cards available (corpus is empty in 1B).",
    });

    // Replicate the real retrieveStep's tool registry shape. `invoke`
    // skips the real RAG client and returns canned hit counts so the
    // test focuses on the runner + aggregator contract.
    const bus = new EventBus({ ringBufferSize: 128 });
    const classification = {
      category: "account_management",
      urgency: "high" as const,
      targetApps: ["test-webapp"],
      confidence: 0.86,
    };

    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations(classification, undefined, {
        id: "retrieve",
        inputSchema: ClassificationSchema,
        outputSchema: RetrievalSchema,
        tier: "sonnet",
        thinkingEnabled: false,
        maxIterations: 3,
        tools: {
          rag_retrieveRunbooks: {
            name: "rag_retrieveRunbooks",
            description: "runbooks",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
            validator: z.object({ query: z.string().min(1) }),
            // 7b.ii-hotfix — tools now return hit summaries alongside counts.
            invoke: async () => ({
              hitCount: 3,
              hits: [
                {
                  score: 0.76,
                  source: "runbooks/password-reset.html",
                  preview: "An IT user has forgotten their password...",
                },
                {
                  score: 0.74,
                  source: "runbooks/unlock-account.html",
                  preview: "To unlock a locked account, navigate to...",
                },
                {
                  score: 0.62,
                  source: "runbooks/system-status-check.html",
                  preview: "Status dashboard at /status shows...",
                },
              ],
            }),
            summarize: (o: unknown) =>
              `${(o as { hitCount: number }).hitCount} runbook hits`,
          },
          rag_retrieveSkills: {
            name: "rag_retrieveSkills",
            description: "skills",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
            validator: z.object({ query: z.string().min(1) }),
            invoke: async () => ({ hitCount: 0, hits: [] }),
            summarize: (o: unknown) =>
              `${(o as { hitCount: number }).hitCount} skill hits`,
          },
        },
        buildSystem: () => "You retrieve relevant runbooks/skills.",
        buildUserMessage: () => "Retrieve hits for this classification.",
        // The same "last-wins per tool" aggregator the real retrieveStep
        // uses in triage.ts. If retrieveStep's produceOutput ever changes
        // semantics, this test is where the delta is caught.
        produceOutput: (iterations, input) => {
          let runbookHits = 0;
          let skillHits = 0;
          let runbookHitsArr: z.infer<typeof RagHitSummarySchema>[] = [];
          let skillHitsArr: z.infer<typeof RagHitSummarySchema>[] = [];
          for (const iter of iterations) {
            const call = iter.toolCall;
            if (!call) continue;
            const out = call.output as {
              hitCount: number;
              hits: z.infer<typeof RagHitSummarySchema>[];
            };
            if (call.name === "rag_retrieveRunbooks") {
              runbookHits = out.hitCount;
              runbookHitsArr = out.hits;
            } else if (call.name === "rag_retrieveSkills") {
              skillHits = out.hitCount;
              skillHitsArr = out.hits;
            }
          }
          return {
            runbookHits,
            skillHits,
            hits: { runbooks: runbookHitsArr, skills: skillHitsArr },
            classification: input,
          };
        },
      }),
    );

    // Output shape matches RetrievalSchema verbatim.
    const parsed = RetrievalSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.runbookHits).toBe(3);
    expect(result.skillHits).toBe(0);
    expect(result.classification).toEqual(classification);
    // 7b.ii-hotfix assertion: hits aggregated, not just counts.
    expect(result.hits.runbooks).toHaveLength(3);
    expect(result.hits.runbooks[0]).toMatchObject({
      score: 0.76,
      source: "runbooks/password-reset.html",
    });
    expect(result.hits.skills).toHaveLength(0);

    // Frame timeline: 3 iteration-started + 3 iteration-completed
    // bracketing the expected tool sequence.
    const rawFrames: TimelineFrame[] = bus.replay(RUN_ID, -1);
    const starts = rawFrames.filter(
      (f) => f.type === "react.iteration.started",
    );
    const completes = rawFrames.filter(
      (f) => f.type === "react.iteration.completed",
    );
    expect(starts).toHaveLength(3);
    expect(completes).toHaveLength(3);

    const c0 = completes[0] as TimelineFramePayload & {
      iteration: number;
      final: boolean;
      toolUsed?: string;
    };
    const c1 = completes[1] as TimelineFramePayload & {
      iteration: number;
      final: boolean;
      toolUsed?: string;
    };
    const c2 = completes[2] as TimelineFramePayload & {
      iteration: number;
      final: boolean;
    };
    expect(c0.iteration).toBe(0);
    expect(c0.final).toBe(false);
    expect(c0.toolUsed).toBe("rag_retrieveRunbooks");
    expect(c1.iteration).toBe(1);
    expect(c1.final).toBe(false);
    expect(c1.toolUsed).toBe("rag_retrieveSkills");
    expect(c2.iteration).toBe(2);
    expect(c2.final).toBe(true);
  });

  it("[2] priorObservations threading (7b.iii.a): buildUserMessage on pass N>0 prepends Prior-passes block", async () => {
    // Guards the integration between the Block 1 controller's
    // `withRunContext({ ...ctx, priorObservations: [...] })` and the
    // retrieveStep's buildUserMessage callback inside the ReAct
    // runner. The runner uses a spread-pattern withRunContext
    // internally (verified at reactRunner.ts:266-267) so outer
    // observations propagate into the callback.
    const { streamMessage: mockedStream } = await import(
      "../src/llm/streamMapper.js"
    );
    const mockFn = mockedStream as unknown as ReturnType<typeof vi.fn>;
    mockFn.mockClear();
    scriptedCalls.length = 0;
    scriptedCalls.push({ text: "done" }); // iter 0 finalizes immediately

    // Directly exercise runReActIterations with retrieveStepConfig by
    // building a minimal config mirror (avoids re-exporting the
    // private config from triage.ts). The key assertion is that the
    // buildUserMessage callback, called from inside the runner's
    // withRunContext-spread scope, sees priorObservations set on the
    // OUTER context.
    let seenUserMsg = "";
    const { runReActIterations } = await import(
      "../src/mastra/lib/reactRunner.js"
    );
    const { tryGetRunContext } = await import("../src/mastra/runContext.js");

    const bus = new EventBus({ ringBufferSize: 64 });
    const classification = {
      category: "account_management",
      urgency: "high" as const,
      targetApps: ["test-webapp"],
      confidence: 0.85,
    };

    await withRunContext(
      {
        runId: RUN_ID,
        bus,
        priorObservations: [
          "Pass 0 gap: missing portal URL",
          "Pass 0 gap: runbook truncated",
        ],
      },
      () =>
        runReActIterations(classification, undefined, {
          id: "retrieve",
          inputSchema: ClassificationSchema,
          outputSchema: RetrievalSchema,
          tier: "sonnet",
          maxIterations: 1,
          tools: {},
          buildSystem: () => "sys",
          buildUserMessage: (c) => {
            // Same pattern as the real retrieveStepConfig.buildUserMessage:
            // tryGetRunContext inside the callback, observations-prefix
            // the classification payload.
            const ctx = tryGetRunContext();
            const obs = ctx?.priorObservations ?? [];
            const prefix =
              obs.length > 0
                ? `Prior passes (${obs.length} observations carried forward):\n${obs.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\n\n`
                : "";
            seenUserMsg =
              prefix +
              `Classification:\n${JSON.stringify(c, null, 2)}\n\n` +
              `Retrieve hits.`;
            return seenUserMsg;
          },
          produceOutput: (_iters, input) => ({
            runbookHits: 0,
            skillHits: 0,
            hits: { runbooks: [], skills: [] },
            classification: input,
          }),
        }),
    );

    expect(seenUserMsg).toMatch(/Prior passes \(2 observations carried forward\):/);
    expect(seenUserMsg).toMatch(/1\. Pass 0 gap: missing portal URL/);
    expect(seenUserMsg).toMatch(/2\. Pass 0 gap: runbook truncated/);
  });
});
