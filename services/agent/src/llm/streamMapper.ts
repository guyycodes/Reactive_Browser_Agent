import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient, buildMessageRequest } from "./anthropic.js";
import type { LlmCallOptions, ClaudeTier } from "./anthropic.js";
import type { EventBus } from "../events/bus.js";
import type { StepId } from "../events/envelope.js";
import { MAX_FRAME_BYTES } from "../events/envelope.js";
import { env } from "../env.js";
import { getCircuit, defaultOptions } from "../lib/circuit.js";

/**
 * Anthropic SSE → envelope frames.
 *
 * Responsibilities
 * ----------------
 * 1. Open a streaming `messages.create({ stream: true })` connection.
 * 2. Translate each `RawMessageStreamEvent` into the correct envelope frame
 *    (`llm.thinking.delta` / `llm.text.delta` / `llm.tool_use.*` /
 *     `llm.message.started` / `llm.message.completed`).
 * 3. Proactively chunk any delta whose `text` exceeds `CHUNK_SIZE_BYTES` so
 *    the 16 KiB frame-size guard never fires on legitimate streaming. The
 *    guard is the safety net; this is the normal code path.
 * 4. Resolve to the fully-assembled `Message` (so the caller can consume the
 *    final text / tool_use input / stop reason without reassembling deltas).
 *
 * Implementation notes
 * --------------------
 * - We iterate the async iterator of `RawMessageStreamEvent`s returned by
 *   `messages.create({ stream: true })`. This gives us the raw server-sent
 *   events untouched — we own the mapping end-to-end and don't depend on any
 *   higher-level SDK abstractions that might change shape.
 * - Content blocks are tracked by `index`: Anthropic emits a
 *   `content_block_start` with an index, followed by any number of
 *   `content_block_delta` events with the same index, terminated by
 *   `content_block_stop`. Block types are `text`, `thinking`, `tool_use`,
 *   `server_tool_use`, etc. We handle the three that matter for Commit 2
 *   (text, thinking, tool_use); other types are tracked so stop events don't
 *   desync, but no frames are emitted for them.
 * - We assemble the final `Message` from the stream ourselves rather than
 *   relying on `.finalMessage()` (some SDK versions require the higher-level
 *   `.stream()` helper for that; we prefer controlling the event loop).
 */

/** Safe chunk size for any delta text. Well below MAX_FRAME_BYTES to leave
 *  headroom for the header + UTF-8 multi-byte boundaries. */
export const CHUNK_SIZE_BYTES = 8 * 1024;

export interface StreamMapperOptions extends LlmCallOptions {
  runId: string;
  stepId: StepId;
  bus: EventBus;
  /** Overrides the `model` field in `llm.message.started`. If omitted,
   *  inferred from `opts.tier`. */
  modelTier?: ClaudeTier;
  /** Optional external abort. Wired through to the Anthropic SDK call
   *  via the circuit breaker; also cancels in-flight retry backoff. */
  signal?: AbortSignal;
}

/**
 * Commit 7b.i — shared Anthropic circuit breaker.
 *
 * First call to `getCircuit("anthropic", opts)` creates the singleton with
 * env-tuned options; subsequent imports just retrieve it. Registry
 * semantics guarantee every Anthropic-backed caller (classify, plan,
 * verify, future ReAct iterations) shares the same failure window +
 * cooldown state — if Anthropic is 500-ing, every in-flight run
 * observes the same open circuit.
 */
const _anthropicCircuit = getCircuit("anthropic", {
  ...defaultOptions(),
  retry: {
    ...defaultOptions().retry,
    attempts: env.ANTHROPIC_CIRCUIT_RETRY_ATTEMPTS,
  },
  breaker: {
    failureThreshold: env.ANTHROPIC_CIRCUIT_FAILURE_THRESHOLD,
    windowMs: env.ANTHROPIC_CIRCUIT_WINDOW_MS,
    cooldownMs: env.ANTHROPIC_CIRCUIT_COOLDOWN_MS,
  },
});

/** Result of a streamed LLM call. Callers get the final assembled text,
 *  any tool_use blocks, and usage info. */
export interface StreamResult {
  text: string;
  thinking: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
  };
}

interface OpenBlock {
  index: number;
  type: "text" | "thinking" | "tool_use" | "other";
  /** For text + thinking: accumulates the delta. */
  text: string;
  /** For tool_use: accumulates the partial_json_delta. */
  partialJson: string;
  /** For tool_use: id + name from content_block_start. */
  toolUseId?: string;
  toolName?: string;
}

/** Stream an Anthropic Messages call, publish envelope frames to the bus as
 *  events arrive, and resolve to the fully-assembled result.
 *
 *  Commit 7b.i — the network call + stream consumption are wrapped in the
 *  shared `"anthropic"` circuit breaker. Retry is composed inside
 *  `circuit.execute`: transient errors (HTTP 5xx, network, api_error)
 *  retry with exponential backoff; exhausted-retry failures count toward
 *  the breaker's threshold and can trip it open.
 *
 *  Design decisions (see circuit.ts comment + handoff record):
 *
 *    A) `llm.message.started` fires EXACTLY ONCE, outside the retry
 *       loop. The reviewer UI's FeedBubble brackets deltas by the
 *       started → completed pair; multiple starts inside one logical
 *       message would shatter the bubble grouping.
 *
 *    B) Mid-stream errors are marked `streamResumeNotSafe = true` on the
 *       thrown error so `defaultIsRetriable` returns false. Retrying
 *       after deltas have already been emitted would duplicate text in
 *       the bus (and thus in the reviewer feed), breaking the "UI shows
 *       truth" invariant. A failed mid-stream lands as a clean
 *       `step.failed` with whatever partial text was emitted — the
 *       reviewer sees what they got plus an explicit failure marker. */
export async function streamMessage(opts: StreamMapperOptions): Promise<StreamResult> {
  const { runId, stepId, bus } = opts;
  const tier = opts.modelTier ?? opts.tier;
  const thinkingEnabled = Boolean(opts.thinkingEnabled);

  const request = buildMessageRequest(opts);
  const client = getAnthropicClient();

  // Decision A: emit opening frame exactly once, BEFORE the circuit.
  // Even connection errors are bracketed (step.failed terminates the step).
  bus.publish({
    runId,
    stepId,
    payload: {
      type: "llm.message.started",
      model: tier,
      thinkingEnabled,
    },
  });

  const result = await _anthropicCircuit.execute<StreamResult>(
    async (signal) => {
      // Per-attempt state: fresh on every retry so any partial delta
      // from a prior failed attempt doesn't leak into the final result.
      // (Prior attempts' deltas may still have been published to the
      // bus — hence Decision B, which makes the error non-retriable
      // once any delta has fired.)
      const openBlocks = new Map<number, OpenBlock>();
      const attemptResult: StreamResult = {
        text: "",
        thinking: "",
        toolUses: [],
        stopReason: "",
        usage: { inputTokens: 0, outputTokens: 0 },
      };

      // Decision B: track whether any delta-producing frame was emitted
      // on this attempt. If so, and the attempt then fails, mark the
      // error as non-resume-safe so the circuit's retry loop bails.
      let deltaEmittedThisAttempt = false;
      const trackingBus = new Proxy(bus, {
        get(target, prop, receiver) {
          if (prop === "publish") {
            return function (args: Parameters<typeof target.publish>[0]) {
              const t = args.payload.type;
              if (
                t === "llm.text.delta" ||
                t === "llm.thinking.delta" ||
                t === "llm.tool_use.delta"
              ) {
                deltaEmittedThisAttempt = true;
              }
              return target.publish(args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as EventBus;

      try {
        const stream = (await client.messages.create(
          { ...request, stream: true },
          { signal },
        )) as AsyncIterable<RawMessageStreamEvent>;

        for await (const evt of stream) {
          handleEvent(
            evt,
            { runId, stepId, bus: trackingBus },
            openBlocks,
            attemptResult,
          );
        }
      } catch (err) {
        if (deltaEmittedThisAttempt && err != null && typeof err === "object") {
          (err as { streamResumeNotSafe?: true }).streamResumeNotSafe = true;
        }
        throw err;
      }

      return attemptResult;
    },
    { runId, stepId, signal: opts.signal },
  );

  // Decision A: closing frame exactly once, on final success.
  bus.publish({
    runId,
    stepId,
    payload: {
      type: "llm.message.completed",
      stopReason: result.stopReason || "unknown",
      usage: result.usage,
    },
  });

  return result;
}

function handleEvent(
  evt: RawMessageStreamEvent,
  ctx: { runId: string; stepId: StepId; bus: EventBus },
  openBlocks: Map<number, OpenBlock>,
  result: StreamResult,
): void {
  switch (evt.type) {
    case "message_start": {
      // Usage is populated incrementally; start event has input_tokens.
      const u = evt.message.usage;
      result.usage.inputTokens = u.input_tokens ?? 0;
      if (typeof u.cache_read_input_tokens === "number") {
        result.usage.cacheReadInputTokens = u.cache_read_input_tokens;
      }
      return;
    }

    case "content_block_start": {
      const block = evt.content_block;
      const idx = evt.index;
      if (block.type === "text") {
        openBlocks.set(idx, {
          index: idx,
          type: "text",
          text: "",
          partialJson: "",
        });
      } else if (block.type === "thinking") {
        openBlocks.set(idx, {
          index: idx,
          type: "thinking",
          text: "",
          partialJson: "",
        });
      } else if (block.type === "tool_use") {
        openBlocks.set(idx, {
          index: idx,
          type: "tool_use",
          text: "",
          partialJson: "",
          toolUseId: block.id,
          toolName: block.name,
        });
        ctx.bus.publish({
          runId: ctx.runId,
          stepId: ctx.stepId,
          payload: {
            type: "llm.tool_use.started",
            toolUseId: block.id,
            name: block.name,
          },
        });
      } else {
        openBlocks.set(idx, {
          index: idx,
          type: "other",
          text: "",
          partialJson: "",
        });
      }
      return;
    }

    case "content_block_delta": {
      const idx = evt.index;
      const block = openBlocks.get(idx);
      if (!block) return;

      const delta = evt.delta;
      if (delta.type === "text_delta" && block.type === "text") {
        block.text += delta.text;
        emitChunkedDelta(ctx, "llm.text.delta", delta.text);
      } else if (delta.type === "thinking_delta" && block.type === "thinking") {
        block.text += delta.thinking;
        emitChunkedDelta(ctx, "llm.thinking.delta", delta.thinking);
      } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
        block.partialJson += delta.partial_json;
        if (block.toolUseId) {
          emitChunkedToolUseDelta(ctx, block.toolUseId, delta.partial_json);
        }
      }
      // Other delta types (signature_delta, citations_delta) are not mapped
      // to envelope frames in Commit 2; the final block.text still assembles
      // correctly for caller inspection.
      return;
    }

    case "content_block_stop": {
      const idx = evt.index;
      const block = openBlocks.get(idx);
      if (!block) return;

      if (block.type === "text") {
        result.text += block.text;
      } else if (block.type === "thinking") {
        result.thinking += block.text;
      } else if (block.type === "tool_use" && block.toolUseId && block.toolName) {
        let parsedInput: unknown = {};
        if (block.partialJson.length > 0) {
          try {
            parsedInput = JSON.parse(block.partialJson);
          } catch {
            parsedInput = { __parseError: true, raw: block.partialJson };
          }
        }
        result.toolUses.push({
          id: block.toolUseId,
          name: block.toolName,
          input: parsedInput,
        });
        ctx.bus.publish({
          runId: ctx.runId,
          stepId: ctx.stepId,
          payload: {
            type: "llm.tool_use.completed",
            toolUseId: block.toolUseId,
            input: parsedInput,
          },
        });
      }
      openBlocks.delete(idx);
      return;
    }

    case "message_delta": {
      // `message_delta` carries stop_reason + output_tokens finalised.
      if (evt.delta.stop_reason) {
        result.stopReason = evt.delta.stop_reason;
      }
      if (evt.usage?.output_tokens != null) {
        result.usage.outputTokens = evt.usage.output_tokens;
      }
      return;
    }

    case "message_stop":
      return;

    default:
      // Unknown event type — ignore. The Anthropic SDK occasionally adds
      // new event variants; forward-compat via explicit ignore.
      return;
  }
}

/** Split `text` into chunks no larger than CHUNK_SIZE_BYTES (UTF-8 aware)
 *  and emit one frame per chunk. */
function emitChunkedDelta(
  ctx: { runId: string; stepId: StepId; bus: EventBus },
  type: "llm.text.delta" | "llm.thinking.delta",
  text: string,
): void {
  if (text.length === 0) return;
  for (const chunk of chunkUtf8(text, CHUNK_SIZE_BYTES)) {
    ctx.bus.publish({
      runId: ctx.runId,
      stepId: ctx.stepId,
      payload: { type, text: chunk },
    });
  }
}

function emitChunkedToolUseDelta(
  ctx: { runId: string; stepId: StepId; bus: EventBus },
  toolUseId: string,
  partialJson: string,
): void {
  if (partialJson.length === 0) return;
  for (const chunk of chunkUtf8(partialJson, CHUNK_SIZE_BYTES)) {
    ctx.bus.publish({
      runId: ctx.runId,
      stepId: ctx.stepId,
      payload: {
        type: "llm.tool_use.delta",
        toolUseId,
        inputJsonDelta: chunk,
      },
    });
  }
}

/** Split a string so each chunk's UTF-8 byte length is ≤ `maxBytes`.
 *
 *  Naive `.slice()` on characters risks emitting a chunk that serialises to
 *  more than `maxBytes` if the text contains multi-byte code points. We
 *  measure byte length per character and cut before overflow. For
 *  Commit 2 this is plenty fast — the hot path is a few hundred KiB of
 *  English text per call. If we ever stream huge multi-byte payloads we can
 *  swap for a TextEncoder + slice-by-byte strategy. */
export function* chunkUtf8(text: string, maxBytes: number): Generator<string> {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    yield text;
    return;
  }
  let buf = "";
  let bufBytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bufBytes + chBytes > maxBytes) {
      yield buf;
      buf = ch;
      bufBytes = chBytes;
    } else {
      buf += ch;
      bufBytes += chBytes;
    }
  }
  if (buf.length > 0) yield buf;
}

// Invariant (documented, not statically enforceable because TS can't do
// arithmetic at the type level): CHUNK_SIZE_BYTES must leave meaningful
// headroom under MAX_FRAME_BYTES. If you bump either constant, keep the
// ratio comfortably below 1 so the envelope size guard never fires on a
// legitimate delta frame emitted via the chunker.
void MAX_FRAME_BYTES;
