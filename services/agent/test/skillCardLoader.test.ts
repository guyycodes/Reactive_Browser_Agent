import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadSkill,
  loadAllSkills,
  clearCache,
  SkillCardNotFoundError,
  SkillCardAmbiguityError,
  SkillCardValidationError,
} from "../src/lib/skillCardLoader.js";

/**
 * Week-2b-runtime — skillCardLoader unit coverage.
 *
 *   [1] happy path + caching — load a skill by name, verify shape,
 *       verify cache hit on second call.
 *   [2] ambiguity — two cards defining the same skill name throw
 *       SkillCardAmbiguityError with both source paths in the message
 *       (audit item #1 from week2b-runtime RFC review).
 *   [3] cross-field constraint — skill-level destructive:true with no
 *       step-level destructive:true throws SkillCardValidationError.
 *   [4] not-found — asking for a skill that doesn't exist throws
 *       SkillCardNotFoundError.
 */

const VALID_RESET = `
schemaVersion: "1"
app: test-webapp
base_url: http://test-webapp:3000
skills:
  - name: reset_password
    description: Reset a user's password.
    destructive: true
    steps:
      - tool: navigate
        args:
          url: "/login"
      - tool: click
        args:
          element: "Reset password submit button"
        destructive: true
`;

const VALID_LOOKUP = `
schemaVersion: "1"
app: test-webapp
base_url: http://test-webapp:3000
skills:
  - name: lookup_user
    description: Look up a user.
    destructive: false
    steps:
      - tool: navigate
        args:
          url: "/users"
`;

// No step-level destructive despite skill-level destructive: true.
const MALFORMED_CROSSFIELD = `
schemaVersion: "1"
app: test-webapp
base_url: http://test-webapp:3000
skills:
  - name: bad_skill
    description: Destructive at skill level but no step-level destructive flag.
    destructive: true
    steps:
      - tool: navigate
        args:
          url: "/admin"
      - tool: click
        args:
          element: "Do something button"
`;

describe("skillCardLoader — Week-2b-runtime", () => {
  beforeEach(() => {
    // Tests run sequentially; each uses its own tmpdir as kbPath but
    // we clear cache between tests to avoid cross-test pollution.
    clearCache();
  });

  it("[1] loadSkill happy path + loadAllSkills catalog + cache", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "skill-loader-"));
    try {
      await fs.writeFile(path.join(tmp, "reset.yml"), VALID_RESET, "utf8");
      await fs.writeFile(path.join(tmp, "lookup.yml"), VALID_LOOKUP, "utf8");

      // loadSkill returns the specific skill + its parent card.
      const reset = await loadSkill("reset_password", { kbPath: tmp });
      expect(reset.skill.name).toBe("reset_password");
      expect(reset.skill.destructive).toBe(true);
      expect(reset.card.app).toBe("test-webapp");
      expect(reset.source).toContain("reset.yml");

      // loadAllSkills returns every skill across every card.
      const all = await loadAllSkills({ kbPath: tmp });
      expect(all.size).toBe(2);
      expect(all.has("reset_password")).toBe(true);
      expect(all.has("lookup_user")).toBe(true);

      // Cache hit: a second call should return the SAME object
      // reference (in-process cache by kbPath identity).
      const resetAgain = await loadSkill("reset_password", { kbPath: tmp });
      expect(resetAgain.skill).toBe(reset.skill);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("[2] ambiguity: two cards both defining 'reset_password' throw SkillCardAmbiguityError citing both sources", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "skill-ambiguity-"));
    try {
      // Both cards define a skill named reset_password.
      await fs.writeFile(path.join(tmp, "card-a.yml"), VALID_RESET, "utf8");
      await fs.writeFile(path.join(tmp, "card-b.yml"), VALID_RESET, "utf8");

      await expect(
        loadSkill("reset_password", { kbPath: tmp }),
      ).rejects.toBeInstanceOf(SkillCardAmbiguityError);

      try {
        await loadSkill("reset_password", { kbPath: tmp, bypassCache: true });
      } catch (err) {
        const e = err as SkillCardAmbiguityError;
        expect(e.skillName).toBe("reset_password");
        expect(e.sources).toHaveLength(2);
        expect(e.message).toContain("card-a.yml");
        expect(e.message).toContain("card-b.yml");
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("[3] cross-field constraint: skill-level destructive without step-level destructive throws SkillCardValidationError", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "skill-crossfield-"));
    try {
      await fs.writeFile(path.join(tmp, "bad.yml"), MALFORMED_CROSSFIELD, "utf8");

      await expect(
        loadSkill("bad_skill", { kbPath: tmp }),
      ).rejects.toBeInstanceOf(SkillCardValidationError);

      try {
        await loadSkill("bad_skill", { kbPath: tmp, bypassCache: true });
      } catch (err) {
        const e = err as SkillCardValidationError;
        expect(e.source).toContain("bad.yml");
        expect(e.message).toContain("destructive");
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("[4] not-found: loadSkill('nonexistent') throws SkillCardNotFoundError", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "skill-notfound-"));
    try {
      await fs.writeFile(path.join(tmp, "reset.yml"), VALID_RESET, "utf8");
      await expect(
        loadSkill("nonexistent_skill", { kbPath: tmp }),
      ).rejects.toBeInstanceOf(SkillCardNotFoundError);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
