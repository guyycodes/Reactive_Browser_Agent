import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { EventBus } from "../src/events/bus.js";
import { withRunContext } from "../src/mastra/runContext.js";
import { SkillSchema } from "../src/schemas/skill-card.js";

/**
 * week2d Part 3a — `runMaterializeSkillCardStep` coverage.
 *
 *   [1] destructive-append contract (BLOCKING-correction regression guard):
 *       actionTrace.length = 5 + boundaryReached !== null →
 *       materialized skill has 6 steps; last is destructive:true click.
 *   [2] happy path — scaffoldMatch:true → divergence=null + skill.steps
 *       preserve non-destructive prefix.
 *   [3] divergence path — scaffoldMatch:false → divergence populated
 *       (expected from scaffold, actual from boundaryReached).
 *   [4] template substitution — verbatim values become
 *       `{{ inputs.X }}`; non-matches stay literal.
 *   [5] ephemeral ref stripping — click args' ephemeral `ref` is dropped;
 *       `element` survives.
 *   [6] ctx.tempSkillCard written on success.
 *   [7] exhaustion-path throws (defensive — UI should have disabled approve).
 */

const RUN_ID = "33333333-3333-4333-8333-333333333333";

// ─────────────────────── loadSkill mock ───────────────────────
//
// Stub scaffold with author-declared inputs, postconditions,
// and a destructive step the materializer can diff against.

// ─────────────────────── db persistence mock ───────────────────────
//
// week2d Part 3b — runMaterializeSkillCardStep now inserts a row into
// `materialized_skills`. Mock the helper so tests don't hit Postgres;
// capture calls for assertions.

const insertedRows: Array<{
  id: string;
  name: string;
  runId: string;
  scaffoldName: string;
  baseUrl: string;
}> = [];
vi.mock("../src/db/materializedSkills.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/db/materializedSkills.js")
  >("../src/db/materializedSkills.js");
  return {
    ...actual,
    insertMaterializedSkill: vi.fn(async (args: unknown) => {
      const { id, name, runId, scaffoldName, baseUrl } = args as {
        id: string;
        name: string;
        runId: string;
        scaffoldName: string;
        baseUrl: string;
      };
      insertedRows.push({ id, name, runId, scaffoldName, baseUrl });
    }),
  };
});

vi.mock("../src/lib/skillCardLoader.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/skillCardLoader.js")
  >("../src/lib/skillCardLoader.js");
  return {
    ...actual,
    loadSkill: vi.fn(async (name: string) => ({
      skill: {
        name,
        description: "Reset a locked user's password",
        destructive: true,
        inputs: {
          email: {
            type: "email" as const,
            required: true,
            description: "Target user's email",
          },
        },
        preconditions: ["admin signed in", "user locked"],
        postconditions: ["user status is active", "lastPasswordReset advanced"],
        steps: [
          { tool: "navigate" as const, args: { url: "http://test-webapp:3000/login" } },
          { tool: "click" as const, args: { element: "Reset password button" }, destructive: true },
        ],
      },
      card: {
        schemaVersion: "1" as const,
        app: "test-webapp",
        base_url: "http://test-webapp:3000",
        skills: [],
      },
    })),
  };
});

// ─────────────────────── Fixtures ───────────────────────

// Minimal happy-path ReviewSchema stub for tests that just want
// materialize to run end-to-end. Skip-cascade semantic is tested via
// the Mastra wrapper, not runMaterializeSkillCardStep directly.
function makeReview(
  dryRun: ReturnType<typeof makeDryRun>,
  approved = true,
): {
  decision: "approve" | "reject" | "edit" | "terminate";
  approved: boolean;
  dryRun: typeof dryRun;
} {
  return { decision: approved ? "approve" : "terminate", approved, dryRun };
}

function makeDryRun(overrides: {
  actionTrace?: Array<{
    tool:
      | "browser_navigate"
      | "browser_snapshot"
      | "browser_click"
      | "browser_fillForm"
      | "browser_takeScreenshot";
    args: Record<string, unknown>;
  }>;
  boundaryReached?: {
    element: string;
    reason: string;
    scaffoldMatch: boolean | null;
    iteration: number;
  } | null;
  inputs?: Record<string, string>;
}) {
  return {
    domMatches: overrides.boundaryReached !== null,
    anomalies: [],
    plan: {
      planId: randomUUID(),
      actionCount: 3,
      destructive: true,
      skillCardIds: ["reset_password"],
      planText: "plan text",
      thinking: "",
      classification: {
        category: "account_management",
        urgency: "high" as const,
        targetApps: ["test-webapp"],
        confidence: 0.92,
      },
      actions: [],
      requiresContext: false,
      inputs: overrides.inputs ?? { email: "jane@example.com" },
    },
    actionTrace: overrides.actionTrace ?? [],
    boundaryReached: overrides.boundaryReached ?? null,
  };
}

function makeTrace(n: number) {
  // A realistic-ish non-destructive prefix: nav, snapshot, fillForm,
  // click, snapshot, click, ... repeating. None destructive.
  const tools: Array<
    | "browser_navigate"
    | "browser_snapshot"
    | "browser_click"
    | "browser_fillForm"
  > = [
    "browser_navigate",
    "browser_snapshot",
    "browser_fillForm",
    "browser_click",
    "browser_snapshot",
  ];
  return Array.from({ length: n }, (_, i) => ({
    tool: tools[i % tools.length]!,
    args:
      tools[i % tools.length] === "browser_navigate"
        ? { url: "http://test-webapp:3000/login" }
        : tools[i % tools.length] === "browser_click"
          ? { element: "Sign in", ref: `e${i}` }
          : {},
  }));
}

// ─────────────────────── Tests ───────────────────────

describe("runMaterializeSkillCardStep (week2d Part 3a)", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ ringBufferSize: 64 });
    insertedRows.length = 0;
  });

  it("[1] destructive-append: actionTrace.length=5 + boundaryReached → materialized skill has 6 steps, last is destructive:true click", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const input = makeDryRun({
      actionTrace: makeTrace(5),
      boundaryReached: {
        element: "Reset password button",
        reason: "clicking commits the reset",
        scaffoldMatch: true,
        iteration: 8,
      },
    });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runMaterializeSkillCardStep(input, makeReview(input)),
    );
    expect(result.skill.steps).toHaveLength(6);
    const last = result.skill.steps[5]!;
    expect(last.destructive).toBe(true);
    expect(last.tool).toBe("click");
    expect(last.args.element).toBe("Reset password button");
    // All prefix steps non-destructive.
    for (let i = 0; i < 5; i++) {
      expect(result.skill.steps[i]!.destructive).toBe(false);
    }
  });

  it("[2] happy path: scaffoldMatch:true → divergence=null + baseUrl forwarded", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const input = makeDryRun({
      actionTrace: makeTrace(3),
      boundaryReached: {
        element: "Reset password button",
        reason: "the final commit",
        scaffoldMatch: true,
        iteration: 4,
      },
    });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runMaterializeSkillCardStep(input, makeReview(input)),
    );
    expect(result.divergence).toBeNull();
    expect(result.baseUrl).toBe("http://test-webapp:3000");
    expect(result.skill.name).toBe("reset_password_materialized");
  });

  it("[3] divergence path: scaffoldMatch:false → divergence populated with expected from scaffold, actual from boundaryReached", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const input = makeDryRun({
      actionTrace: makeTrace(3),
      boundaryReached: {
        element: "Update credentials button",
        reason: "UI drift; same semantic role",
        scaffoldMatch: false,
        iteration: 5,
      },
    });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runMaterializeSkillCardStep(input, makeReview(input)),
    );
    expect(result.divergence).not.toBeNull();
    expect(result.divergence!.expected).toBe("Reset password button"); // from scaffold
    expect(result.divergence!.actual).toBe("Update credentials button"); // from boundary
    expect(result.divergence!.reason).toBe("UI drift; same semantic role");
    // Skill's destructive step uses the ACTUAL (agent-observed) element.
    const last = result.skill.steps[result.skill.steps.length - 1]!;
    expect(last.args.element).toBe("Update credentials button");
  });

  it("[4] template substitution: verbatim-match values become {{ inputs.X }}; non-matches stay literal", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const input = makeDryRun({
      inputs: { email: "jane@example.com" },
      actionTrace: [
        {
          tool: "browser_fillForm",
          args: {
            fields: [
              {
                name: "Email",
                type: "textbox",
                ref: "e1",
                value: "jane@example.com", // verbatim match → substitute
              },
              {
                name: "Password",
                type: "textbox",
                ref: "e2",
                value: "demo", // no match → literal
              },
            ],
          },
        },
      ],
      boundaryReached: {
        element: "Reset password button",
        reason: "r",
        scaffoldMatch: true,
        iteration: 1,
      },
    });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runMaterializeSkillCardStep(input, makeReview(input)),
    );
    const fillStep = result.skill.steps[0]!;
    const fields = fillStep.args.fields as Array<{ value: string }>;
    expect(fields[0]!.value).toBe("{{ inputs.email }}");
    expect(fields[1]!.value).toBe("demo");
  });

  it("[5] ephemeral ref stripping: click args' ref is dropped; element survives", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const input = makeDryRun({
      actionTrace: [
        {
          tool: "browser_click",
          args: { element: "Sign in button", ref: "e42" },
        },
      ],
      boundaryReached: {
        element: "Reset password button",
        reason: "r",
        scaffoldMatch: true,
        iteration: 1,
      },
    });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runMaterializeSkillCardStep(input, makeReview(input)),
    );
    const firstStep = result.skill.steps[0]!;
    expect(firstStep.args.element).toBe("Sign in button");
    expect("ref" in firstStep.args).toBe(false);
  });

  it("[6] ctx.tempSkillCard written on success", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const ctxRef: { tempSkillCard?: unknown } = {};
    const input = makeDryRun({
      actionTrace: makeTrace(2),
      boundaryReached: {
        element: "Reset password button",
        reason: "r",
        scaffoldMatch: true,
        iteration: 3,
      },
    });
    await withRunContext({ runId: RUN_ID, bus }, async () => {
      await runMaterializeSkillCardStep(input, makeReview(input));
      const { getRunContext } = await import("../src/mastra/runContext.js");
      ctxRef.tempSkillCard = getRunContext().tempSkillCard;
    });
    expect(ctxRef.tempSkillCard).toBeDefined();
    const validated = SkillSchema.safeParse(ctxRef.tempSkillCard);
    expect(validated.success).toBe(true);
  });

  it("[8] db persistence (Part 3b): inserts row with convention name <host>_<scaffold>_<uuid>; skillId+skillName surfaced on output", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const input = makeDryRun({
      actionTrace: makeTrace(3),
      boundaryReached: {
        element: "Reset password button",
        reason: "r",
        scaffoldMatch: true,
        iteration: 4,
      },
    });
    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runMaterializeSkillCardStep(input, makeReview(input)),
    );
    // Single row inserted.
    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    // Convention: <sanitized-host>_<scaffold-name>_<uuid>. The stub
    // scaffold uses base_url "http://test-webapp:3000" and name
    // "reset_password" → host token "test-webapp_3000".
    expect(row.name).toMatch(
      /^test-webapp_3000_reset_password_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row.scaffoldName).toBe("reset_password");
    expect(row.baseUrl).toBe("http://test-webapp:3000");
    expect(row.runId).toBe(RUN_ID);
    // UUID surfaced on output matches the row id.
    expect(result.skillId).toBe(row.id);
    expect(result.skillName).toBe(row.name);
    // skillId is a UUID4.
    expect(result.skillId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("[9] week2e: plan.targetUrl overrides scaffold.base_url on MaterializeSchema.baseUrl + persisted row", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const OVERRIDE = "https://customer-a-admin.example.com";
    const input = makeDryRun({
      actionTrace: makeTrace(3),
      boundaryReached: {
        element: "Reset password button",
        reason: "r",
        scaffoldMatch: true,
        iteration: 4,
      },
    });
    // Inject targetUrl on the plan (simulating Path A+ flip from plan step).
    (input.plan as Record<string, unknown>).targetUrl = OVERRIDE;

    const result = await withRunContext({ runId: RUN_ID, bus }, () =>
      runMaterializeSkillCardStep(input, makeReview(input)),
    );
    // MaterializeSchema.baseUrl reflects the override (scaffold stub's
    // base_url is http://test-webapp:3000; we expect OVERRIDE here).
    expect(result.baseUrl).toBe(OVERRIDE);
    // Persisted row carries the effective URL — not the scaffold default.
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]!.baseUrl).toBe(OVERRIDE);
  });

  it("[7] exhaustion path: boundaryReached=null → throws (UI approve-on-exhausted bug guard)", async () => {
    const { runMaterializeSkillCardStep } = await import(
      "../src/mastra/workflows/triage.js"
    );
    const input = makeDryRun({
      actionTrace: makeTrace(5),
      boundaryReached: null, // exhaustion
    });
    await expect(
      withRunContext({ runId: RUN_ID, bus }, () =>
        runMaterializeSkillCardStep(input, makeReview(input)),
      ),
    ).rejects.toThrow(/exhausted without boundary_reached/);
  });
});
