import { describe, it, expect } from "vitest";
import yaml from "js-yaml";

import { SkillCardSchema } from "../src/schemas/skill-card.js";

/**
 * Week-2b foundation — SkillCardSchema Zod validation.
 *
 * Five cases per the RFC's schema-review contract:
 *   [1] happy path — authored YAML parses + validates
 *   [2] missing `destructive` rejects (load-bearing for gate dispatch)
 *   [3] invalid `base_url` rejects (URL required)
 *   [4] schemaVersion mismatch rejects (forward-compat guard)
 *   [5] unknown tool enum rejects (catches typos at validate time)
 *
 * We parse YAML inline (instead of from disk) so the tests are
 * filesystem-free and portable — runtime commit's integration layer
 * tests will exercise the on-disk `kb/skill_cards/**` corpus.
 */

const VALID_CARD_YAML = `
schemaVersion: "1"
app: test-webapp
base_url: http://test-webapp:3000
auth:
  strategy: cookie_session
skills:
  - name: reset_password
    description: Reset a user's password.
    destructive: true
    inputs:
      email:
        type: email
        required: true
    preconditions:
      - The user's status may be 'locked' or 'active'.
    postconditions:
      - The user's status is 'active'.
    steps:
      - tool: navigate
        args:
          url: "/login"
      - tool: click
        args:
          element: "Sign in button"
`;

describe("SkillCardSchema — Week-2b foundation", () => {
  it("[1] happy path — valid YAML parses and validates", () => {
    const parsed = yaml.load(VALID_CARD_YAML);
    const result = SkillCardSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.schemaVersion).toBe("1");
    expect(result.data.app).toBe("test-webapp");
    expect(result.data.skills).toHaveLength(1);
    const skill = result.data.skills[0];
    expect(skill).toBeDefined();
    expect(skill!.destructive).toBe(true);
    expect(skill!.steps).toHaveLength(2);
  });

  it("[2] missing `destructive` field rejects", () => {
    const raw = yaml.load(VALID_CARD_YAML) as Record<string, unknown>;
    const skills = raw.skills as Array<Record<string, unknown>>;
    delete skills[0]!.destructive;
    const result = SkillCardSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) =>
        i.path.some((p) => p === "destructive"),
      ),
    ).toBe(true);
  });

  it("[3] invalid base_url rejects", () => {
    const raw = yaml.load(VALID_CARD_YAML) as Record<string, unknown>;
    raw.base_url = "not-a-url";
    const result = SkillCardSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) => i.path.some((p) => p === "base_url")),
    ).toBe(true);
  });

  it("[4] schemaVersion mismatch rejects (forward-compat guard)", () => {
    const raw = yaml.load(VALID_CARD_YAML) as Record<string, unknown>;
    raw.schemaVersion = "2";
    const result = SkillCardSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) =>
        i.path.some((p) => p === "schemaVersion"),
      ),
    ).toBe(true);
  });

  it("[5] unknown tool enum value rejects", () => {
    const raw = yaml.load(VALID_CARD_YAML) as Record<string, unknown>;
    const skills = raw.skills as Array<Record<string, unknown>>;
    const steps = skills[0]!.steps as Array<Record<string, unknown>>;
    steps[0]!.tool = "unknown_tool";
    const result = SkillCardSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.some((p) => p === "tool"))).toBe(
      true,
    );
  });
});
