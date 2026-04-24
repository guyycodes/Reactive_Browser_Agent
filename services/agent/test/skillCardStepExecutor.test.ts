import { describe, it, expect } from "vitest";

import { executeSkillCardSteps } from "../src/mastra/tools/skillCardExecutor.js";
import { PlaywrightMcpError } from "../src/mastra/tools/playwrightMcp.js";
import type { Skill } from "../src/schemas/skill-card.js";

/**
 * Week-2b-runtime — executeSkillCardSteps unit coverage.
 *
 *   [1] dispatch happy path — navigate / snapshot / click / fillForm /
 *       takeScreenshot all invoked correctly; template args resolved;
 *       preflight stops BEFORE first step-level destructive:true.
 *   [2] ref-not-found on click — executor catches PlaywrightMcpError
 *       INTERNALLY (Path A' bug-2a fix), returns partial stepsRun +
 *       formatted anomaly entry; does NOT re-throw.
 *   [3] partial-failure mid-flow — session throws on the Nth call;
 *       executor records `step N (<tool>): <msg>` and aborts the loop;
 *       stepsRun reflects completed steps before the failing one.
 *   [4] resume-at-first-destructive happy path — executor skips the
 *       non-destructive prefix and begins dispatch at the first
 *       destructive step; from that point every step runs.
 *   [5] resume on read-only skill — no step has destructive:true;
 *       with resumeAtFirstDestructive:true the executor dispatches
 *       zero steps (correct no-op for lookup_user-style skills).
 *   [6] assert: preflight:true + resumeAtFirstDestructive:true throws
 *       (documented mutually-exclusive invariant).
 *
 * All tests drive a stubbed `BrowserSession` (call recorder) rather
 * than a real Playwright MCP session — matches the dependency-free
 * pattern used by `test/playwrightMcp.test.ts`.
 */

// Minimal snapshot fixture that contains the refs the test clicks /
// fillForms need. Role + name matches the skill-card element strings
// used in the happy-path test below.
const FIXTURE_SNAPSHOT = `
- textbox "Email" [ref=e12]
- textbox "Password" [ref=e13]
- button "Sign in" [ref=e14] [cursor=pointer]
- button "Reset password submit" [ref=e20] [cursor=pointer]
`;

/** Stub session that records every call + returns a fixed snapshot. */
function makeStubSession(opts?: { failOnClick?: string }) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const session = {
    async navigate(url: string) {
      calls.push({ method: "navigate", args: { url } });
    },
    async snapshot() {
      calls.push({ method: "snapshot", args: {} });
      return { text: FIXTURE_SNAPSHOT };
    },
    async click(args: { element: string; ref: string }) {
      calls.push({ method: "click", args });
      if (opts?.failOnClick && args.element === opts.failOnClick) {
        throw new PlaywrightMcpError(
          "simulated click failure",
          undefined,
          "playwright.browser_click",
        );
      }
    },
    async fillForm(fields: unknown) {
      calls.push({ method: "fillForm", args: fields });
    },
    async takeScreenshot(label: string) {
      calls.push({ method: "takeScreenshot", args: { label } });
    },
    setStepId(_stepId: string) {
      // no-op
    },
    async close() {
      // no-op
    },
    async consoleMessages() {
      return [];
    },
  };
  return { session, calls };
}

const RESET_SKILL: Skill = {
  name: "reset_password",
  description: "Reset a user password.",
  destructive: true,
  inputs: {
    email: { type: "email", required: true },
  },
  steps: [
    { tool: "navigate", args: { url: "/login" } },
    {
      tool: "fillForm",
      args: {
        fields: [
          { name: "Email", value: "{{ inputs.email }}" },
          { name: "Password", value: "demo" },
        ],
      },
    },
    { tool: "click", args: { element: "Sign in button" } },
    // Destructive step — preflight stops HERE.
    { tool: "click", args: { element: "Reset password submit button" }, destructive: true },
    { tool: "takeScreenshot", args: { label: "after-reset" } },
  ],
};

describe("executeSkillCardSteps — Week-2b-runtime", () => {
  it("[1] happy path: dispatches steps + resolves templates + preflight stops before destructive", async () => {
    const { session, calls } = makeStubSession();

    const result = await executeSkillCardSteps(RESET_SKILL, {
      preflight: true,
      ctx: { inputs: { email: "jane@example.com" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      baseUrl: "http://test-webapp:3000",
    });

    // Preflight runs steps 0-2 (navigate + fillForm + Sign-in click);
    // stops BEFORE step 3 (destructive) and thus also skips step 4
    // (takeScreenshot after the destructive click).
    expect(result.stepsRun).toBe(3);

    // Navigate resolved relative path against baseUrl.
    const navCall = calls.find((c) => c.method === "navigate");
    expect(navCall?.args).toEqual({ url: "http://test-webapp:3000/login" });

    // fillForm received template-resolved email + ref from stub snapshot.
    const fillCall = calls.find((c) => c.method === "fillForm");
    const fields = fillCall?.args as Array<{ name: string; value: string; ref: string }>;
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ name: "Email", value: "jane@example.com", ref: "e12" });
    expect(fields[1]).toMatchObject({ name: "Password", value: "demo", ref: "e13" });

    // Click resolved via role+name parsing ("Sign in button" → role=button name="Sign in").
    const clickCall = calls.find((c) => c.method === "click");
    expect(clickCall?.args).toMatchObject({ element: "Sign in button", ref: "e14" });

    // Destructive click + post-destructive takeScreenshot were NOT dispatched.
    const destructiveClick = calls.find(
      (c) => c.method === "click" && (c.args as { element: string }).element === "Reset password submit button",
    );
    expect(destructiveClick).toBeUndefined();
    expect(calls.find((c) => c.method === "takeScreenshot")).toBeUndefined();
  });

  it("[2] ref miss on click: executor catches internally, returns partial stepsRun + anomaly entry", async () => {
    const { session } = makeStubSession();
    const skillWithBadClick: Skill = {
      name: "bad_skill",
      description: "Clicks a nonexistent element.",
      destructive: false,
      steps: [
        { tool: "navigate", args: { url: "/login" } },
        { tool: "click", args: { element: "Completely Unknown Element button" } },
      ],
    };

    // Path A' bug-2a fix — executor no longer throws PlaywrightMcpError
    // up to the caller. It catches internally, records the failing step,
    // and returns partial stepsRun so the caller preserves telemetry.
    const result = await executeSkillCardSteps(skillWithBadClick, {
      preflight: false,
      ctx: { inputs: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      baseUrl: "http://test-webapp:3000",
    });

    expect(result.stepsRun).toBe(1); // navigate succeeded; click did not
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatch(
      /^step 2 \(click\): .*Completely Unknown Element button/,
    );
  });

  it("[3] partial failure mid-flow: Nth call throws, executor aborts loop and records step N", async () => {
    // Stub that fails on the 2nd navigate call. Tests the 1-indexed
    // step formatting in anomalies and the break-on-first-failure
    // semantic (subsequent steps are NOT dispatched).
    let navCount = 0;
    const calls: string[] = [];
    const session = {
      async navigate(url: string) {
        navCount++;
        calls.push(`navigate:${url}`);
        if (navCount === 2) {
          throw new PlaywrightMcpError(
            "simulated navigate failure on call 2",
            undefined,
            "playwright.browser_navigate",
          );
        }
      },
      async snapshot() {
        return { text: FIXTURE_SNAPSHOT };
      },
      async click() {
        calls.push("click");
      },
      async fillForm() {
        calls.push("fillForm");
      },
      async takeScreenshot() {
        calls.push("takeScreenshot");
      },
      setStepId() {},
      async close() {},
      async consoleMessages() {
        return [];
      },
    };

    const skill: Skill = {
      name: "triple_navigate",
      description: "Three sequential navigates.",
      destructive: false,
      steps: [
        { tool: "navigate", args: { url: "/a" } },
        { tool: "navigate", args: { url: "/b" } },
        { tool: "navigate", args: { url: "/c" } },
      ],
    };

    const result = await executeSkillCardSteps(skill, {
      preflight: false,
      ctx: { inputs: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      baseUrl: "http://test-webapp:3000",
    });

    expect(result.stepsRun).toBe(1); // only the 1st navigate completed
    expect(result.anomalies).toEqual([
      "step 2 (navigate): simulated navigate failure on call 2",
    ]);
    // Step 3 must NOT have been dispatched — the loop breaks on anomaly.
    expect(calls).toEqual([
      "navigate:http://test-webapp:3000/a",
      "navigate:http://test-webapp:3000/b",
    ]);
  });

  it("[4] resumeAtFirstDestructive: skips non-destructive prefix, dispatches from first destructive", async () => {
    const { session, calls } = makeStubSession();
    const skill: Skill = {
      name: "resumable_reset",
      description: "4-step skill with destructive at index 2.",
      destructive: true,
      steps: [
        { tool: "navigate", args: { url: "/login" } }, // SKIPPED
        { tool: "snapshot", args: {} }, //               SKIPPED
        { tool: "click", args: { element: "Sign in button" }, destructive: true }, // dispatched
        { tool: "takeScreenshot", args: { label: "after" } }, // dispatched (post-destructive)
      ],
    };

    const result = await executeSkillCardSteps(skill, {
      preflight: false,
      resumeAtFirstDestructive: true,
      ctx: { inputs: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      baseUrl: "http://test-webapp:3000",
    });

    expect(result.stepsRun).toBe(2);
    expect(result.anomalies).toEqual([]);
    // First two steps NOT in call log.
    expect(calls.find((c) => c.method === "navigate")).toBeUndefined();
    // (`click`'s implicit snapshot for ref resolution IS expected — it's
    // internal to the click dispatch, not a skipped snapshot step.)
    expect(calls.find(
      (c) => c.method === "click" && (c.args as { element: string }).element === "Sign in button",
    )).toBeDefined();
    expect(calls.find((c) => c.method === "takeScreenshot")).toMatchObject({
      args: { label: "after" },
    });
  });

  it("[5] resume on read-only skill (no destructive step): dispatches zero steps, stepsRun=0", async () => {
    const { session, calls } = makeStubSession();
    const readOnlySkill: Skill = {
      name: "lookup_user",
      description: "Read-only lookup; no destructive step.",
      destructive: false,
      steps: [
        { tool: "navigate", args: { url: "/users" } },
        { tool: "snapshot", args: {} },
        { tool: "takeScreenshot", args: { label: "users-list" } },
      ],
    };

    const result = await executeSkillCardSteps(readOnlySkill, {
      preflight: false,
      resumeAtFirstDestructive: true,
      ctx: { inputs: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: session as any,
      baseUrl: "http://test-webapp:3000",
    });

    expect(result.stepsRun).toBe(0);
    expect(result.anomalies).toEqual([]);
    expect(calls).toEqual([]); // executor dispatched nothing
  });

  it("[6] invariant: preflight:true + resumeAtFirstDestructive:true throws at entry", async () => {
    const { session } = makeStubSession();

    await expect(
      executeSkillCardSteps(RESET_SKILL, {
        preflight: true,
        resumeAtFirstDestructive: true,
        ctx: { inputs: { email: "jane@example.com" } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: session as any,
        baseUrl: "http://test-webapp:3000",
      }),
    ).rejects.toThrow(/mutually exclusive/i);
  });
});
