import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateSkillCards } from "../scripts/validate-skill-cards.js";

/**
 * Week-2b foundation — `validateSkillCards()` exit-code behavior.
 *
 * Exercises the exported function directly on tmp directories (no
 * subprocess). The `main()` wrapper in the script file only calls this
 * function + branches on result.ok to set process.exit code, so covering
 * the function path covers the script.
 */

const VALID_YAML = `
schemaVersion: "1"
app: test-webapp
base_url: http://test-webapp:3000
skills:
  - name: s1
    description: test skill
    destructive: false
    steps:
      - tool: navigate
        args:
          url: "/"
`;

// name is uppercase "S1" — violates the snake_case regex
// /^[a-z][a-z0-9_]*$/ in SkillSchema. Schema-level rejection.
const MALFORMED_YAML = `
schemaVersion: "1"
app: test-webapp
base_url: http://test-webapp:3000
skills:
  - name: S1
    description: test skill
    destructive: false
    steps:
      - tool: navigate
        args:
          url: "/"
`;

describe("validateSkillCards script", () => {
  it("[1] ok on valid card, not-ok on malformed card, error message cites the file", async () => {
    const tmp = await fs.mkdtemp(path.join(tmpdir(), "skill-validate-"));
    try {
      // First: drop a valid card and assert ok.
      await fs.writeFile(path.join(tmp, "ok.yml"), VALID_YAML, "utf8");
      const okResult = await validateSkillCards(tmp);
      expect(okResult.ok).toBe(true);
      expect(okResult.count).toBe(1);
      expect(okResult.errorMessage).toBeUndefined();

      // Then: drop a malformed card and assert not-ok.
      await fs.writeFile(path.join(tmp, "bad.yml"), MALFORMED_YAML, "utf8");
      const failResult = await validateSkillCards(tmp);
      expect(failResult.ok).toBe(false);
      expect(failResult.errorMessage).toBeDefined();
      expect(failResult.errorMessage!).toContain("bad.yml");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
