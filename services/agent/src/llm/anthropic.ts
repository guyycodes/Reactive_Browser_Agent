import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

/**
 * Anthropic client factory.
 *
 * One singleton client per process — the SDK manages connection pooling and
 * rate-limiting internally. Model identifiers come from env so they can be
 * rotated when Anthropic renames / retires a model without a code change.
 *
 * MASTER_PLAN §4 model assignment:
 *   - haiku  → classify (fast, cheap; extended thinking NOT used)
 *   - sonnet → plan, verify (extended thinking enabled; big visible reasoning)
 *   - opus   → eval judge, Week 4 (extended thinking used for tricky judgments)
 */

export type ClaudeTier = "haiku" | "sonnet" | "opus";

let singleton: Anthropic | null = null;

function getClient(): Anthropic {
  if (singleton) return singleton;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "[llm] ANTHROPIC_API_KEY is not set; the agent service cannot make LLM calls. " +
        "Set it in .env before starting the service.",
    );
  }
  singleton = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return singleton;
}

export function resolveModel(tier: ClaudeTier): string {
  switch (tier) {
    case "haiku":
      return env.ANTHROPIC_MODEL_HAIKU;
    case "sonnet":
      return env.ANTHROPIC_MODEL_SONNET;
    case "opus":
      return env.ANTHROPIC_MODEL_OPUS;
  }
}

/** Default extended-thinking budgets per tier. Callers override where needed.
 *  `plan` uses 8192 (the big reasoning surface); `verify` uses 4096 (tighter);
 *  `classify` on Haiku never enables thinking (fast + cheap). */
export const DEFAULT_THINKING_BUDGETS: Record<ClaudeTier, number> = {
  haiku: 0, // never enable on haiku for classify
  sonnet: 8192,
  opus: 4096,
};

export interface LlmCallOptions {
  tier: ClaudeTier;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Forward-compat: if the caller wants to pass through Anthropic-native
   *  params we haven't surfaced yet, they can via this escape hatch. */
  extra?: Record<string, unknown>;
}

/** Build the raw Anthropic request body from high-level options. Exported so
 *  `streamMapper.ts` can call `messages.stream(body)` directly. */
export function buildMessageRequest(opts: LlmCallOptions): {
  model: string;
  max_tokens: number;
  system?: string;
  thinking?: { type: "enabled"; budget_tokens: number };
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} & Record<string, unknown> {
  const model = resolveModel(opts.tier);
  const maxTokens = opts.maxTokens ?? 4096;
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;

  if (opts.thinkingEnabled) {
    const budget = opts.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGETS[opts.tier];
    if (budget > 0) {
      body.thinking = { type: "enabled", budget_tokens: budget };
      // When thinking is enabled Anthropic requires max_tokens > budget_tokens.
      if (maxTokens <= budget) {
        body.max_tokens = budget + 1024;
      }
    }
  }

  if (opts.extra) {
    Object.assign(body, opts.extra);
  }

  return body as ReturnType<typeof buildMessageRequest>;
}

export { getClient as getAnthropicClient };
export type { Anthropic };
