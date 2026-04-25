import { randomUUID } from "node:crypto";
import { createStep } from "@mastra/core/workflows";
import { z } from "zod";

import type { EventBus } from "../../events/bus.js";
import type { StepId } from "../../events/envelope.js";
import { streamMessage } from "../../llm/streamMapper.js";
import type { ClaudeTier } from "../../llm/anthropic.js";
import { logger } from "../../logger.js";
import { getRunContext, withRunContext } from "../runContext.js";

/**
 * Reusable ReAct-step factory (Commit 7b.ii).
 *
 * Builds a Mastra `createStep`-compatible step whose execute body runs a
 * think → (optional) tool → observe → think loop. The loop uses
 * Anthropic's native tool-use protocol (one tool call per iteration, no
 * parallel tool calls), dispatches through a caller-supplied
 * `ReactTool` registry, and produces a typed output via a caller-supplied
 * `produceOutput` function.
 *
 * Design decisions (locked in during 7b.ii proposal; see handoff record)
 * ----------------------------------------------------------------------
 *
 *   A) Native Anthropic tool-use via the streamMapper we already have.
 *      The Anthropic request carries `tools: [...]` + `tool_choice:
 *      {type: "auto"}` through `LlmCallOptions.extra`. `streamResult.toolUses`
 *      is populated by streamMapper's existing `llm.tool_use.*` handling.
 *      `stopReason === "end_turn"` OR `toolUses.length === 0` → final.
 *
 *   B) Observation log as user-message text, NOT native `tool_result`
 *      content blocks. Each iteration is a fresh two-turn conversation —
 *      the assistant's prior reasoning is never replayed as a raw
 *      `tool_use` block (which would require paired `tool_result`
 *      content blocks that our current `LlmCallOptions.messages` shape
 *      can't express). Instead, the next iteration's user message
 *      embeds a structured "here's what you tried and observed"
 *      summary. Simpler, correct (no Anthropic 400 from unpaired
 *      tool_use), adequate for the first application (retrieveStep).
 *      Upgrade path flagged for 7b.iii / Week 2 if multi-turn fidelity
 *      is needed.
 *
 *   C) Frame nesting via `reactIterationId` on `timelineHeader`. Every
 *      frame emitted inside one iteration carries the same id. The
 *      reviewer UI reads this and indents those frames under an
 *      iteration divider.
 *
 *   D) Runtime input validation via caller-supplied Zod `validator`
 *      alongside the Anthropic-consumed `inputSchema` (JSON Schema).
 *      Two hand-written schemas is cheaper than a `zod-to-json-schema`
 *      dependency for the current tool count. Week 2 can introduce a
 *      helper when tool count grows past ~5.
 *
 *   E) `tagFramesWithIteration` propagates `reactIterationId` to all
 *      frames emitted during a tool dispatch by temporarily replacing
 *      the ambient `RunContext.bus` (via `withRunContext`) with a
 *      Proxy-wrapped bus. This is why `runContext.ts` exports
 *      `withRunContext` — adding a second propagation mechanism
 *      alongside AsyncLocalStorage would fragment the pattern.
 *
 * What this does NOT do
 * ---------------------
 *   - Multiple tool calls per iteration (we consume `toolUses[0]` only).
 *   - Block-level ReAct (iterating the WHOLE Block 1 → review_gate →
 *     Block 2 pipeline with backtracking). That's 7b.iii's scope; it
 *     wraps step-level ReAct with a composition controller.
 *   - Circuit-breaker retry. Every `streamMessage` call is already
 *     routed through `getCircuit("anthropic").execute(...)` in 7b.i —
 *     transient Anthropic 500s retry automatically per iteration.
 */

/** Opt-in sentinel a tool's `invoke` can include in its return value to
 *  signal "this was the last iteration needed." The runner records the
 *  tool call as a normal observation (frames emit identically), then
 *  breaks the iteration loop after invoke returns. The sentinel is
 *  STRIPPED before the output is stored on
 *  `ReactIteration.toolCall.output`, so downstream `produceOutput`
 *  consumers see their declared `TOutput` shape clean — no cascading
 *  awareness of the termination mechanism.
 *
 *  Name-agnostic by design: the runner never branches on `tool.name` to
 *  decide termination. Concrete first consumer is `boundary_reached`
 *  (week2d Part 1, `reactBrowserTools.ts`). Future candidates: a
 *  `user_intent_clarified` tool on a clarification-gate step; a
 *  `goal_reached` tool on a verify-style ReAct step.
 *
 *  USAGE CONVENTION: tools that want to terminate the loop should
 *  return their `TOutput` with `REACT_FINAL_SENTINEL` set to `true`,
 *  using a runtime cast (`as unknown as TOutput`). The declared type
 *  is intentionally NOT widened on `ReactTool.invoke`'s return because
 *  TS variance on the tool registry (`Record<string, ReactTool>`)
 *  causes fixture-assignment friction with the existing
 *  `ReactTool<TypedInput, TypedOutput>` fixtures. Runtime behavior:
 *  runner detects the sentinel, strips it before storing on
 *  `iter.toolCall.output`, and breaks the iteration loop.
 *
 *  Canonical first consumer: `boundary_reached` in
 *  `reactBrowserTools.ts` (see `BoundaryReachedOutput` + the invoke
 *  return's `as unknown as BoundaryReachedOutput` pattern). */
export const REACT_FINAL_SENTINEL = "__final" as const;

export interface ReactInvokeCtx {
  /** Optional — tools should forward this to their own AbortSignal
   *  plumbing if they want to honor external cancellation. A step
   *  execution with no wrapping AbortController will pass `undefined`. */
  signal: AbortSignal | undefined;
  runId: string;
  stepId: StepId;
  /** The UUID stamped on every frame emitted during this iteration.
   *  Tools can pass it through to sub-emitters via `withRunContext` if
   *  they need the frame-tagging to reach deeper helpers. */
  reactIterationId: string;
}

export interface ReactTool<TInput = unknown, TOutput = unknown> {
  /** Anthropic tool name. MUST match `^[a-zA-Z0-9_-]{1,64}$` — the API
   *  rejects periods, so `rag.retrieveRunbooks` becomes e.g.
   *  `rag_retrieveRunbooks` here. The business-level `tool.started`
   *  frame's `name` field (emitted by `runRagCall` et al.) still uses
   *  the dotted form for continuity with earlier commits. */
  name: string;
  /** Shown to the model verbatim. Should describe what the tool does
   *  and when to call it. */
  description: string;
  /** JSON Schema (Anthropic `input_schema` shape). Hand-written
   *  alongside `validator`. */
  inputSchema: Record<string, unknown>;
  /** Zod validator applied to the model-produced tool input before
   *  dispatch. On Zod failure, the iteration records an "invalid input"
   *  observation and loops to the next iteration. */
  validator: z.ZodType<TInput>;
  /** Actual tool implementation. Should emit its own `tool.*` span
   *  frames via the ambient `getRunContext().bus` (the runner has
   *  already replaced that bus with a reactIterationId-tagging Proxy
   *  via `withRunContext` by the time `invoke` runs).
   *
   *  Early-termination opt-in: a tool may attach
   *  `{ [REACT_FINAL_SENTINEL]: true }` to its return value (via a
   *  type-assertion cast — the sentinel is intentionally OUTSIDE the
   *  declared TOutput so every existing tool's type-inference story
   *  stays unchanged). The runner runtime-detects the sentinel,
   *  strips it from the stored output, flips the iteration's `final`
   *  field to true, and breaks the loop after the normal frame
   *  emission completes. See `REACT_FINAL_SENTINEL` + the canonical
   *  reference implementation at `reactBrowserTools.ts`
   *  `boundary_reached`. */
  invoke: (input: TInput, ctx: ReactInvokeCtx) => Promise<TOutput>;
  /** Shape the observation summary that goes back into the next
   *  iteration's user message. Default: `JSON.stringify(output).slice(0, 400)`. */
  summarize?: (output: TOutput) => string;
}

export type ToolRegistry = Record<string, ReactTool>;

export interface ReactIteration {
  iteration: number;
  reactIterationId: string;
  /** Accumulated `llm.text.delta` — the model's visible reasoning this
   *  iteration. Empty for pure tool-use iterations where the model
   *  emits only a tool_use block. */
  thought: string;
  /** Tool invocation result, or null if this iteration finalized
   *  without calling a tool. */
  toolCall: {
    name: string;
    input: unknown;
    output: unknown;
  } | null;
  final: boolean;
}

export interface CreateReActStepArgs<TInput, TOutput> {
  id: StepId;
  /** week2d Part 2 widening — accepts preprocessed schemas (e.g.
   *  `PlanSchema` has `z.preprocess(null → undefined)` on `actions[].value`
   *  + `missingContext`) whose input type differs from output type. The
   *  default `z.ZodType<T>` equals `z.ZodType<T, ZodTypeDef, T>` which
   *  rejects preprocess-widened inputs. Using `any` on the input-side
   *  parameter lets Zod do runtime coercion before the runner sees
   *  `TInput`; `parseAsync` is the guard at dispatch time. */
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  tier: ClaudeTier;
  thinkingEnabled?: boolean;
  /** Hard cap on iteration count. Default 3. Envelope additionally
   *  caps at 20 as a belt-and-suspenders runaway safeguard. */
  maxIterations?: number;
  tools: ToolRegistry;
  buildSystem: (input: TInput) => string;
  /** Built once at iteration 0. Subsequent iterations append a
   *  structured observation-log section to this same base message. */
  buildUserMessage: (input: TInput) => string;
  produceOutput: (iterations: ReactIteration[], input: TInput) => TOutput;
}

interface ObservationLogEntry {
  iteration: number;
  tool: string;
  status: "ok" | "error";
  summary: string;
}

/** Build this iteration's user message: the caller's base message, plus
 *  a structured summary of prior iterations' observations if any. The
 *  model uses this to decide whether to refine its next query or
 *  finalize. */
function buildIterationUserMessage(
  base: string,
  log: ObservationLogEntry[],
  currentIteration: number,
  maxIter: number,
): string {
  if (log.length === 0) {
    const remaining = maxIter - currentIteration;
    return (
      `${base}\n\n` +
      `You have up to ${remaining} iteration${remaining === 1 ? "" : "s"} to call tools before you must finalize. ` +
      `Call a tool if you need evidence; otherwise provide a final text answer.`
    );
  }
  const lines = log.map(
    (e) =>
      `  - Iteration ${e.iteration}: called ${e.tool} → [${e.status}] ${e.summary}`,
  );
  const remaining = maxIter - currentIteration;
  return (
    `${base}\n\n` +
    `Prior iterations (${log.length}):\n${lines.join("\n")}\n\n` +
    `You have ${remaining} iteration${remaining === 1 ? "" : "s"} remaining. ` +
    `Refine your query and call a tool again if hits are weak, or provide a final text answer.`
  );
}

/** Proxy-wrap an EventBus so every publish call adds `reactIterationId`
 *  to the payload. Transport frames (heartbeat / resync) are passed
 *  through untouched — they aren't scoped to a workflow step let alone
 *  a ReAct iteration. The `EventBus.publish` signature accepts only
 *  timeline payloads for user callers (the bus emits heartbeats
 *  internally), so the guard uses a string cast to stay forward-compat
 *  in case bus.publish ever accepts transport payloads at the type
 *  level. */
function tagFramesWithIteration(
  bus: EventBus,
  reactIterationId: string,
): EventBus {
  return new Proxy(bus, {
    get(target, prop, receiver) {
      if (prop === "publish") {
        return function (args: Parameters<typeof target.publish>[0]) {
          const typeStr = args.payload.type as string;
          if (typeStr === "heartbeat" || typeStr === "resync") {
            return target.publish(args);
          }
          return target.publish({
            ...args,
            payload: { ...args.payload, reactIterationId },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as EventBus;
}

/**
 * Core ReAct loop, extracted from `createReActStep` so tests can
 * drive it directly without routing through Mastra's step-execution
 * machinery. The Mastra step wrapper is a thin forwarder.
 *
 * Must be called inside a `withRunContext(...)` scope — it relies on
 * `getRunContext()` for the ambient `{runId, bus}`.
 */
export async function runReActIterations<TInput, TOutput>(
  inputData: TInput,
  abortSignal: AbortSignal | undefined,
  args: CreateReActStepArgs<TInput, TOutput>,
): Promise<TOutput> {
  const maxIter = args.maxIterations ?? 3;
  const tools = args.tools;
  const anthropicTools = Object.values(tools).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const ctx = getRunContext();
  const { runId, bus } = ctx;
  const reactRunId = randomUUID();

  const iterations: ReactIteration[] = [];
  const observationLog: ObservationLogEntry[] = [];

  const systemMessage = args.buildSystem(inputData);
  const baseUserMessage = args.buildUserMessage(inputData);

  for (let i = 0; i < maxIter; i++) {
        const reactIterationId = randomUUID();
        const taggedBus = tagFramesWithIteration(bus, reactIterationId);

        bus.publish({
          runId,
          stepId: args.id,
          payload: {
            type: "react.iteration.started",
            reactRunId,
            iteration: i,
          },
        });

        // Drive the LLM call through a tagged-bus ambient context so
        // streamMapper's frame emissions AND any downstream tool
        // invocations in this iteration all inherit `reactIterationId`
        // without per-tool plumbing.
        const streamResult = await withRunContext(
          { ...ctx, bus: taggedBus },
          () =>
            streamMessage({
              runId,
              stepId: args.id,
              bus: taggedBus,
              tier: args.tier,
              thinkingEnabled: args.thinkingEnabled,
              system: systemMessage,
              messages: [
                {
                  role: "user",
                  content: buildIterationUserMessage(
                    baseUserMessage,
                    observationLog,
                    i,
                    maxIter,
                  ),
                },
              ],
              signal: abortSignal,
              extra:
                anthropicTools.length > 0
                  ? { tools: anthropicTools, tool_choice: { type: "auto" } }
                  : {},
            }),
        );

        const toolUse = streamResult.toolUses[0];

        // No tool call → final. Model finished with text only.
        if (!toolUse) {
          const iter: ReactIteration = {
            iteration: i,
            reactIterationId,
            thought: streamResult.text,
            toolCall: null,
            final: true,
          };
          iterations.push(iter);
          bus.publish({
            runId,
            stepId: args.id,
            payload: {
              type: "react.iteration.completed",
              reactRunId,
              iteration: i,
              final: true,
              observationSummary: streamResult.text.slice(0, 400) || undefined,
            },
          });
          break;
        }

        // Tool call path.
        const tool = tools[toolUse.name];
        if (!tool) {
          // Model hallucinated a tool name outside the registry. Log
          // and treat this iteration as final with an error observation
          // — no way to continue safely.
          logger.warn(
            { runId, stepId: args.id, requestedTool: toolUse.name },
            "[reactRunner] model invoked unknown tool; treating iteration as final",
          );
          const iter: ReactIteration = {
            iteration: i,
            reactIterationId,
            thought: streamResult.text,
            toolCall: null,
            final: true,
          };
          iterations.push(iter);
          bus.publish({
            runId,
            stepId: args.id,
            payload: {
              type: "react.iteration.completed",
              reactRunId,
              iteration: i,
              final: true,
              observationSummary: `unknown tool requested: ${toolUse.name}`,
            },
          });
          break;
        }

        const parsed = tool.validator.safeParse(toolUse.input);
        if (!parsed.success) {
          const errMsg = parsed.error.issues
            .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
            .join("; ");
          observationLog.push({
            iteration: i,
            tool: toolUse.name,
            status: "error",
            summary: `invalid input: ${errMsg}`,
          });
          const iter: ReactIteration = {
            iteration: i,
            reactIterationId,
            thought: streamResult.text,
            toolCall: null,
            final: false,
          };
          iterations.push(iter);
          bus.publish({
            runId,
            stepId: args.id,
            payload: {
              type: "react.iteration.completed",
              reactRunId,
              iteration: i,
              final: false,
              toolUsed: toolUse.name,
              observationSummary: `invalid input: ${errMsg.slice(0, 200)}`,
            },
          });
          continue;
        }

        // Run the tool inside the tagged-bus ambient context so its own
        // `tool.*` / `rag.retrieved` / etc. emissions inherit
        // `reactIterationId`.
        try {
          const raw = await withRunContext(
            { ...ctx, bus: taggedBus },
            () =>
              tool.invoke(parsed.data, {
                signal: abortSignal,
                runId,
                stepId: args.id,
                reactIterationId,
              }),
          );
          // week2d Part 1 — detect + strip the REACT_FINAL_SENTINEL.
          // Non-object outputs (unusual but permitted by the TOutput
          // generic) pass through untouched. Strip runs regardless of
          // whether the sentinel is present so the hot path stays
          // single-branch.
          const isFinal =
            typeof raw === "object" &&
            raw !== null &&
            (raw as Record<string, unknown>)[REACT_FINAL_SENTINEL] === true;
          const output: unknown = isFinal
            ? (() => {
                const clone = { ...(raw as Record<string, unknown>) };
                delete clone[REACT_FINAL_SENTINEL];
                return clone;
              })()
            : raw;
          const summary = tool.summarize
            ? tool.summarize(output)
            : JSON.stringify(output).slice(0, 400);
          observationLog.push({
            iteration: i,
            tool: toolUse.name,
            status: "ok",
            summary,
          });
          const iter: ReactIteration = {
            iteration: i,
            reactIterationId,
            thought: streamResult.text,
            toolCall: { name: toolUse.name, input: parsed.data, output },
            final: isFinal,
          };
          iterations.push(iter);
          bus.publish({
            runId,
            stepId: args.id,
            payload: {
              type: "react.iteration.completed",
              reactRunId,
              iteration: i,
              // Frame-level `final` tracks "LLM emitted end_turn" — a
              // sentinel-terminated iteration is not that; the iteration
              // DID call a tool. The runner-level loop termination is
              // separate (see iter.final above + the break below). This
              // observability asymmetry is tracked as MASTER_PLAN polish
              // queue #24.
              final: false,
              toolUsed: toolUse.name,
              observationSummary: summary.slice(0, 400) || undefined,
            },
          });
          if (isFinal) break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          observationLog.push({
            iteration: i,
            tool: toolUse.name,
            status: "error",
            summary: errMsg,
          });
          const iter: ReactIteration = {
            iteration: i,
            reactIterationId,
            thought: streamResult.text,
            toolCall: null,
            final: false,
          };
          iterations.push(iter);
          bus.publish({
            runId,
            stepId: args.id,
            payload: {
              type: "react.iteration.completed",
              reactRunId,
              iteration: i,
              final: false,
              toolUsed: toolUse.name,
              observationSummary: `error: ${errMsg.slice(0, 200)}`,
            },
          });
        }
  }

  // If we hit the iteration cap without an explicit final, the last
  // iteration is left with `final: false` and `produceOutput` sees this
  // and can decide whether to throw or fall through.
  return args.produceOutput(iterations, inputData);
}

export function createReActStep<TInput, TOutput>(
  args: CreateReActStepArgs<TInput, TOutput>,
) {
  return createStep({
    id: args.id,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    execute: ({ inputData, abortSignal }) =>
      runReActIterations(inputData as TInput, abortSignal, args),
  });
}
