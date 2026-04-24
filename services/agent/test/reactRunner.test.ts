import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";

import { EventBus } from "../src/events/bus.js";
import type { TimelineFrame, TimelineFramePayload } from "../src/events/envelope.js";
import { withRunContext } from "../src/mastra/runContext.js";
import {
  runReActIterations,
  type ReactTool,
} from "../src/mastra/lib/reactRunner.js";
import type { StreamResult } from "../src/llm/streamMapper.js";

/**
 * Commit 7b.ii — createReActStep / runReActIterations primitive.
 *
 * These tests drive the extracted `runReActIterations` core loop
 * directly (bypassing the thin `createReActStep` → Mastra wrapper)
 * so assertions can inspect emitted frames + iteration state without
 * routing through Mastra's step-execution machinery.
 *
 * `streamMessage` is mocked via `vi.mock` to return scripted
 * `StreamResult`s per iteration, so tests exercise the runner's
 * branching (final / tool-call / unknown-tool / invalid-input /
 * tool-throws / iteration-cap) deterministically with no real
 * Anthropic calls.
 */

const RUN_ID = "11111111-1111-4111-8111-111111111111";

// ---------- streamMessage mock ----------
//
// We script one StreamResult per iteration. The mock pops from the
// front of the queue; a test that expects N iterations queues N results.
// Any extra iteration pulls an empty "final text" result by default so
// the runner exits gracefully rather than throwing.

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
      if (!next) {
        // Default: text-only finalization so the runner exits cleanly.
        return makeResult({ text: "default final" });
      }
      return makeResult(next);
    }),
  };
});

// ---------- Test fixtures ----------

interface TestIn {
  hint: string;
}
interface TestOut {
  iterations: number;
  finalIterationIdx: number;
  lastToolCalled: string | null;
}

function makeTool(
  name: string,
  overrides: Partial<ReactTool> = {},
): ReactTool<{ query: string }, { hitCount: number; hits: string[] }> {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    validator: z.object({ query: z.string().min(1) }),
    invoke: async ({ query }) => ({ hitCount: 3, hits: [`hit for ${query}`] }),
    summarize: (o) => `${o.hitCount} hits`,
    ...overrides,
  } as ReactTool<{ query: string }, { hitCount: number; hits: string[] }>;
}

function bucketByType(bus: EventBus): Record<string, TimelineFramePayload[]> {
  const frames: TimelineFrame[] = bus.replay(RUN_ID, -1);
  const out: Record<string, TimelineFramePayload[]> = {};
  for (const f of frames) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { v, runId, seq, ts, stepId, ...payload } = f;
    (out[f.type] ??= []).push(payload as TimelineFramePayload);
  }
  return out;
}

describe("reactRunner — runReActIterations", () => {
  beforeEach(() => {
    scriptedCalls.length = 0;
  });
  afterEach(() => {
    scriptedCalls.length = 0;
  });

  it("[1] zero-iteration final: model replies text-only on iter 0, produceOutput called with 1 iteration", async () => {
    scriptNext({ text: "done, here is my answer", toolUses: [] });
    const bus = new EventBus({ ringBufferSize: 64 });

    let producedIterations: unknown[] = [];
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations<TestIn, TestOut>(
        { hint: "h" },
        undefined,
        {
          id: "retrieve",
          inputSchema: z.object({ hint: z.string() }),
          outputSchema: z.object({
            iterations: z.number(),
            finalIterationIdx: z.number(),
            lastToolCalled: z.string().nullable(),
          }),
          tier: "sonnet",
          tools: { tool_a: makeTool("tool_a") },
          buildSystem: () => "sys",
          buildUserMessage: () => "user",
          produceOutput: (iters) => {
            producedIterations = iters;
            return {
              iterations: iters.length,
              finalIterationIdx: iters.findIndex((i) => i.final),
              lastToolCalled:
                iters.reverse().find((i) => i.toolCall)?.toolCall?.name ?? null,
            };
          },
        },
      ),
    );

    expect(result.iterations).toBe(1);
    expect(result.finalIterationIdx).toBe(0);
    expect(result.lastToolCalled).toBeNull();
    expect(producedIterations).toHaveLength(1);

    const frames = bucketByType(bus);
    expect(frames["react.iteration.started"]).toHaveLength(1);
    expect(frames["react.iteration.completed"]?.[0]).toMatchObject({
      iteration: 0,
      final: true,
    });
  });

  it("[2] multi-iter: iter 0 calls tool_a, iter 1 calls tool_b, iter 2 finalizes", async () => {
    scriptNext({ toolUses: [{ id: "t1", name: "tool_a", input: { query: "q1" } }] });
    scriptNext({ toolUses: [{ id: "t2", name: "tool_b", input: { query: "q2" } }] });
    scriptNext({ text: "done" });

    const bus = new EventBus({ ringBufferSize: 64 });
    await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations<TestIn, TestOut>(
        { hint: "h" },
        undefined,
        {
          id: "retrieve",
          inputSchema: z.object({ hint: z.string() }),
          outputSchema: z.object({
            iterations: z.number(),
            finalIterationIdx: z.number(),
            lastToolCalled: z.string().nullable(),
          }),
          tier: "sonnet",
          tools: {
            tool_a: makeTool("tool_a"),
            tool_b: makeTool("tool_b"),
          },
          buildSystem: () => "sys",
          buildUserMessage: () => "user",
          produceOutput: (iters) => ({
            iterations: iters.length,
            finalIterationIdx: iters.findIndex((i) => i.final),
            lastToolCalled: null,
          }),
        },
      ),
    );

    const frames = bucketByType(bus);
    expect(frames["react.iteration.started"]).toHaveLength(3);
    expect(frames["react.iteration.completed"]).toHaveLength(3);
    expect(frames["react.iteration.completed"]?.[0]).toMatchObject({
      iteration: 0,
      final: false,
      toolUsed: "tool_a",
    });
    expect(frames["react.iteration.completed"]?.[1]).toMatchObject({
      iteration: 1,
      final: false,
      toolUsed: "tool_b",
    });
    expect(frames["react.iteration.completed"]?.[2]).toMatchObject({
      iteration: 2,
      final: true,
    });
  });

  it("[3] maxIterations safeguard: all 3 iterations call tools, loop exits without a final=true iteration", async () => {
    scriptNext({ toolUses: [{ id: "t1", name: "tool_a", input: { query: "q1" } }] });
    scriptNext({ toolUses: [{ id: "t2", name: "tool_a", input: { query: "q2" } }] });
    scriptNext({ toolUses: [{ id: "t3", name: "tool_a", input: { query: "q3" } }] });

    const bus = new EventBus({ ringBufferSize: 64 });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations<TestIn, TestOut>(
        { hint: "h" },
        undefined,
        {
          id: "retrieve",
          inputSchema: z.object({ hint: z.string() }),
          outputSchema: z.object({
            iterations: z.number(),
            finalIterationIdx: z.number(),
            lastToolCalled: z.string().nullable(),
          }),
          tier: "sonnet",
          maxIterations: 3,
          tools: { tool_a: makeTool("tool_a") },
          buildSystem: () => "sys",
          buildUserMessage: () => "user",
          produceOutput: (iters) => ({
            iterations: iters.length,
            finalIterationIdx: iters.findIndex((i) => i.final),
            lastToolCalled: "tool_a",
          }),
        },
      ),
    );

    expect(result.iterations).toBe(3);
    // No iteration flagged final — cap hit without convergence.
    expect(result.finalIterationIdx).toBe(-1);

    const frames = bucketByType(bus);
    expect(frames["react.iteration.started"]).toHaveLength(3);
    expect(frames["react.iteration.completed"]).toHaveLength(3);
    expect(
      frames["react.iteration.completed"]?.every(
        (f) => (f as { final: boolean }).final === false,
      ),
    ).toBe(true);
  });

  it("[4] unknown tool: model invokes a tool not in the registry, iteration is marked final + logged", async () => {
    scriptNext({
      toolUses: [{ id: "t1", name: "nonexistent_tool", input: { query: "q" } }],
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations<TestIn, TestOut>(
        { hint: "h" },
        undefined,
        {
          id: "retrieve",
          inputSchema: z.object({ hint: z.string() }),
          outputSchema: z.object({
            iterations: z.number(),
            finalIterationIdx: z.number(),
            lastToolCalled: z.string().nullable(),
          }),
          tier: "sonnet",
          tools: { tool_a: makeTool("tool_a") },
          buildSystem: () => "sys",
          buildUserMessage: () => "user",
          produceOutput: (iters) => ({
            iterations: iters.length,
            finalIterationIdx: iters.findIndex((i) => i.final),
            lastToolCalled: null,
          }),
        },
      ),
    );

    const frames = bucketByType(bus);
    expect(frames["react.iteration.completed"]).toHaveLength(1);
    expect(frames["react.iteration.completed"]?.[0]).toMatchObject({
      iteration: 0,
      final: true,
    });
    expect(
      (frames["react.iteration.completed"]?.[0] as { observationSummary?: string })
        ?.observationSummary,
    ).toMatch(/unknown tool requested: nonexistent_tool/);
  });

  it("[5] invalid tool input: Zod rejects, iteration recorded with error observation, loop continues", async () => {
    scriptNext({
      // `query` required but we send `wrongField` — validator rejects.
      toolUses: [{ id: "t1", name: "tool_a", input: { wrongField: "x" } }],
    });
    scriptNext({ text: "finalizing after invalid input" });

    const bus = new EventBus({ ringBufferSize: 64 });
    await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations<TestIn, TestOut>(
        { hint: "h" },
        undefined,
        {
          id: "retrieve",
          inputSchema: z.object({ hint: z.string() }),
          outputSchema: z.object({
            iterations: z.number(),
            finalIterationIdx: z.number(),
            lastToolCalled: z.string().nullable(),
          }),
          tier: "sonnet",
          tools: { tool_a: makeTool("tool_a") },
          buildSystem: () => "sys",
          buildUserMessage: () => "user",
          produceOutput: (iters) => ({
            iterations: iters.length,
            finalIterationIdx: iters.findIndex((i) => i.final),
            lastToolCalled: null,
          }),
        },
      ),
    );

    const frames = bucketByType(bus);
    expect(frames["react.iteration.completed"]).toHaveLength(2);
    expect(frames["react.iteration.completed"]?.[0]).toMatchObject({
      iteration: 0,
      final: false,
      toolUsed: "tool_a",
    });
    const obs0 = (frames["react.iteration.completed"]?.[0] as { observationSummary?: string })
      ?.observationSummary;
    expect(obs0).toMatch(/invalid input/);
    expect(frames["react.iteration.completed"]?.[1]).toMatchObject({
      iteration: 1,
      final: true,
    });
  });

  it("[6] tool invocation throws: error observation recorded, loop continues to iter 1", async () => {
    scriptNext({
      toolUses: [{ id: "t1", name: "tool_a", input: { query: "q" } }],
    });
    scriptNext({ text: "giving up after error" });

    const throwingTool = makeTool("tool_a", {
      invoke: async () => {
        throw new Error("upstream exploded");
      },
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations<TestIn, TestOut>(
        { hint: "h" },
        undefined,
        {
          id: "retrieve",
          inputSchema: z.object({ hint: z.string() }),
          outputSchema: z.object({
            iterations: z.number(),
            finalIterationIdx: z.number(),
            lastToolCalled: z.string().nullable(),
          }),
          tier: "sonnet",
          tools: { tool_a: throwingTool },
          buildSystem: () => "sys",
          buildUserMessage: () => "user",
          produceOutput: (iters) => ({
            iterations: iters.length,
            finalIterationIdx: iters.findIndex((i) => i.final),
            lastToolCalled: null,
          }),
        },
      ),
    );

    const frames = bucketByType(bus);
    expect(frames["react.iteration.completed"]).toHaveLength(2);
    expect(
      (frames["react.iteration.completed"]?.[0] as { observationSummary?: string })
        ?.observationSummary,
    ).toMatch(/error: upstream exploded/);
    expect(frames["react.iteration.completed"]?.[1]).toMatchObject({
      iteration: 1,
      final: true,
    });
  });

  it("[7] envelope tagging: nested llm.* / tool.* frames emitted inside an iteration carry reactIterationId", async () => {
    scriptNext({
      toolUses: [{ id: "t1", name: "tool_a", input: { query: "q" } }],
    });
    scriptNext({ text: "done" });

    // Inject a tool that publishes its own `tool.started / tool.completed`
    // pair so we can verify those frames inherit `reactIterationId` via
    // the tagFramesWithIteration ambient-bus proxy.
    const toolWithFrames = makeTool("tool_a", {
      invoke: async (_input, ctx) => {
        // Use the ambient bus from the runner's tagged scope so the proxy
        // adds reactIterationId for us.
        const { getRunContext } = await import("../src/mastra/runContext.js");
        const { bus: ambientBus } = getRunContext();
        const invocationId = "inv-test-1";
        ambientBus.publish({
          runId: RUN_ID,
          stepId: "retrieve",
          payload: { type: "tool.started", invocationId, name: "tool_a" },
        });
        ambientBus.publish({
          runId: RUN_ID,
          stepId: "retrieve",
          payload: {
            type: "tool.completed",
            invocationId,
            name: "tool_a",
            durationMs: 1,
          },
        });
        return { hitCount: 3, hits: ["h"] };
      },
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    await withRunContext({ runId: RUN_ID, bus }, () =>
      runReActIterations<TestIn, TestOut>(
        { hint: "h" },
        undefined,
        {
          id: "retrieve",
          inputSchema: z.object({ hint: z.string() }),
          outputSchema: z.object({
            iterations: z.number(),
            finalIterationIdx: z.number(),
            lastToolCalled: z.string().nullable(),
          }),
          tier: "sonnet",
          tools: { tool_a: toolWithFrames },
          buildSystem: () => "sys",
          buildUserMessage: () => "user",
          produceOutput: (iters) => ({
            iterations: iters.length,
            finalIterationIdx: iters.findIndex((i) => i.final),
            lastToolCalled: "tool_a",
          }),
        },
      ),
    );

    const rawFrames: TimelineFrame[] = bus.replay(RUN_ID, -1);
    const iterStarted = rawFrames.find((f) => f.type === "react.iteration.started");
    expect(iterStarted).toBeDefined();
    const iter0Id = (iterStarted as { reactIterationId?: string } | undefined)
      ?.reactIterationId;
    // The react.iteration.started frame itself is NOT tagged — tagging only
    // applies to frames emitted INSIDE the iteration (via the tagged-bus
    // proxy). The opener is published with the outer bus. That's correct.
    expect(iter0Id).toBeUndefined();

    // Nested tool.started / tool.completed must carry reactIterationId
    // matching the iteration's react.iteration.started frame's reactRunId
    // scope — specifically the tagged UUID generated by the runner.
    const toolStarted = rawFrames.find((f) => f.type === "tool.started");
    const toolCompleted = rawFrames.find((f) => f.type === "tool.completed");
    expect(toolStarted).toBeDefined();
    expect(toolCompleted).toBeDefined();
    const toolStartedIter = (toolStarted as { reactIterationId?: string })
      .reactIterationId;
    const toolCompletedIter = (toolCompleted as { reactIterationId?: string })
      .reactIterationId;
    expect(toolStartedIter).toBeTypeOf("string");
    expect(toolCompletedIter).toBe(toolStartedIter);

    // Closing iteration frame for iter 0 should match.
    const iterCompleted = rawFrames.filter(
      (f) => f.type === "react.iteration.completed",
    );
    expect(iterCompleted.length).toBeGreaterThanOrEqual(1);
  });

  it("[8] priorObservations propagate from outer RunContext through the runner's internal withRunContext into user callbacks (7b.iii.a)", async () => {
    // Correctness test for the Block 1 integration path. The Block 1
    // controller sets `withRunContext({ ...ctx, priorObservations: [...] })`
    // before invoking each pass's inner steps. For retrieveStep
    // specifically, the runner then internally does its own
    // `withRunContext({ ...ctx, bus: taggedBus })` to install the
    // frame-tagging Proxy bus. If that internal call used a fresh
    // context (e.g. `{ runId, bus: taggedBus }` instead of the spread
    // form `{ ...ctx, bus: taggedBus }`), the outer `priorObservations`
    // would evaporate and retrieveStep's buildUserMessage callback
    // would silently see `undefined` — a hard-to-catch correctness
    // bug that breaks pass N>0 refinement.
    //
    // reactRunner.ts:266-267 and :391-392 both use the spread form,
    // verified pre-apply. This test guards against future regression.
    scriptNext({ text: "done" });

    const bus = new EventBus({ ringBufferSize: 64 });
    let seenObservationsInCallback: string[] | undefined;

    const { tryGetRunContext } = await import("../src/mastra/runContext.js");

    await withRunContext(
      {
        runId: RUN_ID,
        bus,
        priorObservations: ["outer-marker-1", "outer-marker-2"],
      },
      () =>
        runReActIterations<TestIn, TestOut>(
          { hint: "h" },
          undefined,
          {
            id: "retrieve",
            inputSchema: z.object({ hint: z.string() }),
            outputSchema: z.object({
              iterations: z.number(),
              finalIterationIdx: z.number(),
              lastToolCalled: z.string().nullable(),
            }),
            tier: "sonnet",
            tools: {},
            buildSystem: () => "sys",
            // This callback runs INSIDE the runner's internal
            // withRunContext scope. It should see the outer
            // priorObservations via the spread-preserved ambient ctx.
            buildUserMessage: () => {
              const ctx = tryGetRunContext();
              seenObservationsInCallback = ctx?.priorObservations;
              return "user";
            },
            produceOutput: (iters) => ({
              iterations: iters.length,
              finalIterationIdx: iters.findIndex((i) => i.final),
              lastToolCalled: null,
            }),
          },
        ),
    );

    expect(seenObservationsInCallback).toBeDefined();
    expect(seenObservationsInCallback).toEqual([
      "outer-marker-1",
      "outer-marker-2",
    ]);
  });
});
