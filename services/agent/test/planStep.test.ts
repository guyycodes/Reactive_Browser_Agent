import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import { runPlanStep } from "../src/mastra/workflows/triage.js";
import type { StreamResult } from "../src/llm/streamMapper.js";

/**
 * Commit 7b.ii-hotfix — planStep structured output.
 *
 * Drives `runPlanStep` (the extracted planStep body — same pattern as
 * `runReActIterations`) with mocked `streamMessage` results to verify:
 *
 *   [1] Structured JSON plan flows through cleanly: Zod-validated
 *       actions[], derived actionCount, LLM-declared destructive,
 *       narrative → planText for UI display.
 *   [2] Explicit `requiresContext: true` from the model is preserved
 *       (the refusal path stays a first-class citizen, not a
 *       regex-inferred "N-step plan").
 *   [3] Malformed JSON (model drift) → requiresContext=true with
 *       diagnostic; the log payload includes responsePreview.
 *   [4] Partial schema drift: model returns 3 raw actions but all
 *       fail PlanActionSchema.safeParse → actions[]=[], requiresContext
 *       flips to true (the pre-apply bug fix — previously this case
 *       rendered as "0-step plan" in the UI).
 *
 * Guards the truth invariant that 7b.ii-smoke broke: a refusal should
 * never render as a plausible-looking plan.
 */

const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface ScriptedCall {
  text?: string;
  thinking?: string;
}
const scriptedCalls: ScriptedCall[] = [];

vi.mock("../src/llm/streamMapper.js", async () => {
  const actual = await vi.importActual<typeof import("../src/llm/streamMapper.js")>(
    "../src/llm/streamMapper.js",
  );
  return {
    ...actual,
    streamMessage: vi.fn(async (): Promise<StreamResult> => {
      const next = scriptedCalls.shift() ?? { text: "" };
      return {
        text: next.text ?? "",
        thinking: next.thinking ?? "",
        toolUses: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 100 },
      };
    }),
  };
});

const classification = {
  category: "account_management",
  urgency: "high" as const,
  targetApps: ["test-webapp"],
  confidence: 0.86,
};

const emptyHits = { runbooks: [], skills: [] };

// 7b.ii-hotfix-2 — preview here exceeds the legacy 400-char cap so the
// wide-preview path through RagHitSummarySchema (.max(2000)) is
// exercised by Zod validation on the hits field of the mocked
// RetrievalSchema input. If RagHitSummarySchema's cap ever narrows
// below ~800 chars again, this fixture fails fast and the asymmetric-
// caps decision is re-opened with explicit test evidence.
const RUNBOOK_PASSAGE =
  "Password Reset — Internal Admin Portal Runbook: Password Reset in the Internal Admin Portal. " +
  "Preconditions: (a) the requester's identity must be verified by matching the ticket email header " +
  "to a user record; (b) the target user must exist and be in status {active, locked}; (c) the " +
  "requester must not have had more than 3 password resets in the past 24 hours. Procedure: " +
  "1. Navigate to the Internal Admin Portal at /login and sign in with operator credentials. " +
  "2. Search for the target user by email address using the /users search surface. " +
  "3. Click the user's row to open the detail page. " +
  "4. Click the 'Reset password' link to open the destructive reset flow. " +
  "5. Tick the 'I confirm' checkbox to acknowledge the destructive nature of the action. " +
  "6. Click the 'Reset password' submit button. " +
  "7. Verify a success toast appears containing 'password reset successful' and a temporary " +
  "password for the user. Rollback: if the user reports they did not request the reset, notify the " +
  "security team and escalate to tier-2 for incident review.";

const canonicalHits = {
  runbooks: [
    {
      score: 0.76,
      source: "runbooks/password-reset.html",
      preview: RUNBOOK_PASSAGE, // ~1050 chars — well above the old 400 cap
    },
  ],
  skills: [],
};

function makeRetrievalInput(overrides?: {
  hits?: typeof canonicalHits;
  runbookHits?: number;
  skillHits?: number;
}) {
  return {
    runbookHits: overrides?.runbookHits ?? 1,
    skillHits: overrides?.skillHits ?? 0,
    hits: overrides?.hits ?? canonicalHits,
    classification,
  };
}

describe("planStep — structured JSON output (7b.ii-hotfix)", () => {
  beforeEach(() => {
    scriptedCalls.length = 0;
  });
  afterEach(() => {
    scriptedCalls.length = 0;
  });

  it("[1] structured JSON plan: valid actions[] → actionCount = actions.length, destructive from model, narrative → planText", async () => {
    scriptedCalls.push({
      thinking: "the ticket asks for a password reset...",
      text: JSON.stringify({
        narrative:
          "Reset Jane's password via the admin portal. Destructive action; requires confirm checkbox.",
        actions: [
          {
            stepNumber: 1,
            verb: "navigate",
            target: "/login",
            description: "Load the admin login page.",
          },
          {
            stepNumber: 2,
            verb: "fill",
            target: "email textbox on /login",
            value: "theo@example.com",
            description: "Enter operator email.",
          },
          {
            stepNumber: 3,
            verb: "click",
            target: "Sign in button",
            description: "Submit login.",
          },
          {
            stepNumber: 4,
            verb: "navigate",
            target: "/users",
            description: "Navigate to user search.",
          },
          {
            stepNumber: 5,
            verb: "fill",
            target: "search textbox",
            value: "jane@example.com",
            description: "Search for Jane.",
          },
          {
            stepNumber: 6,
            verb: "click",
            target: "Jane's row",
            description: "Open user detail.",
          },
          {
            stepNumber: 7,
            verb: "click",
            target: "Reset password link",
            description: "Open destructive reset flow.",
          },
          {
            stepNumber: 8,
            verb: "click",
            target: "I confirm checkbox",
            description: "Confirm destructive action.",
          },
          {
            stepNumber: 9,
            verb: "click",
            target: "Reset password submit button",
            description: "Execute reset.",
          },
          {
            stepNumber: 10,
            verb: "verify",
            target: "success toast",
            description: "Confirm success.",
          },
        ],
        destructive: true,
        requiresContext: false,
      }),
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-1", subject: "Reset password for jane@example.com" },
      },
      () => runPlanStep(makeRetrievalInput()),
    );

    expect(result.requiresContext).toBe(false);
    expect(result.actions).toHaveLength(10);
    expect(result.actionCount).toBe(10); // authoritative derivation
    expect(result.destructive).toBe(true); // LLM-declared
    expect(result.planText).toMatch(/Reset Jane's password/);
    expect(result.missingContext).toBeUndefined();
    // Spot-check a specific action survived Zod validation intact.
    expect(result.actions[0]).toEqual({
      stepNumber: 1,
      verb: "navigate",
      target: "/login",
      description: "Load the admin login page.",
    });
  });

  it("[2] explicit requiresContext: model returns requiresContext=true with missingContext → preserved, actions=[], destructive=false, UI can render 'needs context'", async () => {
    scriptedCalls.push({
      text: JSON.stringify({
        narrative:
          "I need more information before I can produce a concrete plan.",
        actions: [],
        destructive: false,
        requiresContext: true,
        missingContext: [
          "Which user needs their password reset?",
          "Which environment (staging/prod)?",
          "Is there a temporary-password convention?",
        ],
      }),
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-2", subject: "password reset" },
      },
      () => runPlanStep(makeRetrievalInput({ hits: emptyHits, runbookHits: 0 })),
    );

    expect(result.requiresContext).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.actionCount).toBe(0);
    expect(result.destructive).toBe(false);
    expect(result.missingContext).toHaveLength(3);
    expect(result.missingContext?.[0]).toMatch(/Which user/);
  });

  it("[3] malformed JSON: non-JSON prose → requiresContext=true fallback with diagnostic, planText captures prose for debugging", async () => {
    scriptedCalls.push({
      text:
        "I cannot produce a plan without more information. Specifically, I need:\n" +
        "1. The specific user account\n" +
        "2. The environment\n" +
        "3. The reset convention",
      thinking: "the ticket is too ambiguous to act on",
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-3", subject: "reset password" },
      },
      () => runPlanStep(makeRetrievalInput()),
    );

    expect(result.requiresContext).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.actionCount).toBe(0);
    expect(result.destructive).toBe(false);
    expect(result.missingContext).toEqual([
      "model did not return valid JSON matching PlanSchema",
    ]);
    // Raw prose preserved in planText so the reviewer UI can surface
    // the model's actual words (capped at 2000 chars).
    expect(result.planText).toMatch(/I cannot produce a plan/);
  });

  it("[4] partial schema drift: 3 raw actions but all fail PlanActionSchema → actions=[], requiresContext flips to true (the pre-apply bug fix)", async () => {
    // Model emits JSON that parses but whose actions don't match
    // PlanActionSchema: "type" instead of enum "fill", missing target,
    // verb outside allowed set. Pre-fix, this rendered as "0-step plan
    // · not destructive" because requiresContext relied on
    // rawActions.length === 0. Post-fix, requiresContext flips to true
    // based on validActionsPresent.
    scriptedCalls.push({
      text: JSON.stringify({
        narrative: "Reset Jane's password",
        actions: [
          // Missing target field.
          {
            stepNumber: 1,
            verb: "navigate",
            description: "Go to login",
          },
          // Invalid verb ("type" is a common synonym for fill but not
          // in the enum — flagged for Week-2 skill-card verb widening).
          {
            stepNumber: 2,
            verb: "type",
            target: "email",
            value: "theo@example.com",
            description: "Enter email",
          },
          // Invalid stepNumber (zero not allowed — must be positive).
          {
            stepNumber: 0,
            verb: "click",
            target: "submit",
            description: "Submit",
          },
        ],
        destructive: true,
        requiresContext: false,
      }),
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-4", subject: "reset" },
      },
      () => runPlanStep(makeRetrievalInput()),
    );

    // Pre-fix: result.requiresContext would be false (model said so),
    // actions would be [] (all filtered), rendering as "0-step plan".
    // Post-fix: requiresContext flipped to true because no valid
    // actions survived.
    expect(result.requiresContext).toBe(true);
    expect(result.actions).toHaveLength(0);
    expect(result.actionCount).toBe(0);
    // destructive still reflects what the model declared — doesn't
    // get reset just because actions failed validation. The UI's
    // `requiresContext: true` branch doesn't show destructive anyway.
    expect(result.destructive).toBe(true);
  });

  it("[4.1] priorObservations threading (7b.iii.a): on pass N>0 user message prepends Prior-passes block", async () => {
    // Capture streamMessage's input via the mock so we can inspect the
    // user message the runner built.
    const { streamMessage: mockedStream } = await import(
      "../src/llm/streamMapper.js"
    );
    const mockFn = mockedStream as unknown as ReturnType<typeof vi.fn>;
    mockFn.mockClear();

    scriptedCalls.push({
      text: JSON.stringify({
        narrative: "ok",
        actions: [
          { stepNumber: 1, verb: "navigate", target: "/login", description: "go" },
        ],
        destructive: false,
        requiresContext: false,
      }),
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-plan-obs", subject: "test" },
        priorObservations: [
          "Pass 0 gap: missing portal URL",
          "Pass 0 gap: truncated runbook",
        ],
      },
      () => runPlanStep(makeRetrievalInput()),
    );

    const lastCall = mockFn.mock.calls[mockFn.mock.calls.length - 1];
    const userContent = String(lastCall?.[0]?.messages?.[0]?.content ?? "");
    expect(userContent).toMatch(/Prior passes \(2 observations carried forward\):/);
    expect(userContent).toMatch(/1\. Pass 0 gap: missing portal URL/);
    expect(userContent).toMatch(/2\. Pass 0 gap: truncated runbook/);
    // Pass-0 content still present after the prefix.
    expect(userContent).toMatch(/Ticket: test/);
  });

  it("[5] model emits value:null for actions without a value — all actions survive parsing (7b.ii-hotfix-3)", async () => {
    // 7b.ii-hotfix-3 regression guard: under the original
    // `value: z.string().optional()` on PlanActionSchema, Sonnet's
    // null-valued actions (the idiomatic JSON shape for navigate/click/
    // verify/notify — anything that isn't `fill`) failed safeParse and
    // were silently dropped. Hotfix-2 smoke surfaced a 9-action plan
    // rendering as "2-step plan" — only the 2 actions with string
    // values survived.
    //
    // This test exercises the exact failure shape: 9 actions, 7 with
    // `value: null`, 2 with string values. All 9 must survive parsing
    // after the `z.preprocess(v → v === null ? undefined : v, ...)`
    // fix. Per-action `value` type assertions verify the null →
    // undefined normalization (downstream consumers never see null).
    scriptedCalls.push({
      text: JSON.stringify({
        narrative:
          "Reset Jane's password via the Internal Admin Portal. Verify identity, navigate, click through the reset flow, confirm destructive action, verify success toast, notify ticket.",
        actions: [
          { stepNumber: 1, verb: "navigate", target: "Internal Admin Portal at /login", value: null, description: "Load the admin portal login." },
          { stepNumber: 2, verb: "fill", target: "user search input on /users", value: "jane@example.com", description: "Search for Jane by email." },
          { stepNumber: 3, verb: "click", target: "Jane's user record in search results", value: null, description: "Open the user detail page." },
          { stepNumber: 4, verb: "verify", target: "user record details — email matches jane@example.com", value: null, description: "Confirm we're on the right user before destructive action." },
          { stepNumber: 5, verb: "click", target: "Reset Password button on user detail", value: null, description: "Open the destructive reset flow." },
          { stepNumber: 6, verb: "verify", target: "confirmation dialog appears with reset warning", value: null, description: "Confirm the dialog rendered." },
          { stepNumber: 7, verb: "click", target: "confirm button in dialog", value: null, description: "Acknowledge the destructive action." },
          { stepNumber: 8, verb: "verify", target: "success toast notification containing 'password reset successful'", value: null, description: "Confirm the reset succeeded." },
          { stepNumber: 9, verb: "notify", target: "ticket T-7aiv", value: "Password reset completed for jane@example.com.", description: "Post resolution note to the ticket." },
        ],
        destructive: true,
        requiresContext: false,
      }),
    });

    const bus = new EventBus({ ringBufferSize: 64 });
    const result = await withRunContext(
      {
        runId: RUN_ID,
        bus,
        ticket: { ticketId: "T-5", subject: "Reset password for jane@example.com" },
      },
      () => runPlanStep(makeRetrievalInput()),
    );

    // All 9 actions survive — the core regression guard.
    expect(result.actions).toHaveLength(9);
    expect(result.actionCount).toBe(9);
    expect(result.requiresContext).toBe(false);
    expect(result.destructive).toBe(true);

    // null → undefined normalization — downstream consumers never see
    // a literal null on `action.value`. Every surviving action either
    // has a string value or undefined.
    expect(result.actions[0]?.value).toBeUndefined(); // navigate, was null
    expect(result.actions[1]?.value).toBe("jane@example.com"); // fill, string
    expect(result.actions[2]?.value).toBeUndefined(); // click, was null
    expect(result.actions[7]?.value).toBeUndefined(); // verify, was null
    expect(result.actions[8]?.value).toBe(
      "Password reset completed for jane@example.com.",
    ); // notify, string

    // Spot-check one full action shape survived intact.
    expect(result.actions[4]).toEqual({
      stepNumber: 5,
      verb: "click",
      target: "Reset Password button on user detail",
      description: "Open the destructive reset flow.",
      // `value` field omitted entirely from the parsed output when
      // undefined — Zod's default behavior on z.string().optional().
    });
  });
});
