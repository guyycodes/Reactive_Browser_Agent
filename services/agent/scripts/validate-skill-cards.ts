#!/usr/bin/env tsx
/**
 * validate-skill-cards.ts (Week-2b foundation)
 *
 * Walks `kb/skill_cards/` recursively, parses every .yml / .yaml file,
 * and validates against `SkillCardSchema`. On first failure: prints
 * offending file + Zod issue path + message → exit code 1. On all-
 * success: prints "✓ N cards valid" → exit code 0.
 *
 * Usage:
 *   npm run validate:skill-cards           # from services/agent/; defaults to repo kb/skill_cards
 *   tsx scripts/validate-skill-cards.ts <path>   # explicit directory
 *
 * Tested via `test/validateSkillCards.test.ts` which exercises the
 * exported `validateSkillCards()` function directly (no subprocess).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { SkillCardSchema } from "../src/schemas/skill-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts → agent → services → repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_KB_PATH = path.join(REPO_ROOT, "kb", "skill_cards");

export interface ValidateResult {
  ok: boolean;
  count: number;
  errorMessage?: string;
}

async function walkYaml(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkYaml(p)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
    ) {
      out.push(p);
    }
  }
  return out;
}

export async function validateSkillCards(
  kbPath: string,
): Promise<ValidateResult> {
  let files: string[];
  try {
    files = await walkYaml(kbPath);
  } catch (err) {
    return {
      ok: false,
      count: 0,
      errorMessage: `Failed to walk ${kbPath}: ${(err as Error).message}`,
    };
  }
  if (files.length === 0) {
    return {
      ok: false,
      count: 0,
      errorMessage: `No skill-card YAML files found under ${kbPath}`,
    };
  }

  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      return {
        ok: false,
        count: 0,
        errorMessage: `Failed to read ${file}: ${(err as Error).message}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      return {
        ok: false,
        count: 0,
        errorMessage: `YAML parse error in ${file}: ${(err as Error).message}`,
      };
    }
    const result = SkillCardSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      return {
        ok: false,
        count: 0,
        errorMessage: `Schema validation failed for ${file}:\n${issues}`,
      };
    }
  }
  return { ok: true, count: files.length };
}

async function main(): Promise<void> {
  const kbPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_KB_PATH;
  const result = await validateSkillCards(kbPath);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`✗ ${result.errorMessage}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(
    `✓ ${result.count} skill card${result.count === 1 ? "" : "s"} valid`,
  );
}

// Run main() only when invoked as a script (not when imported by tests).
// fileURLToPath() normalizes `file://` URLs to system paths; comparing
// the entry-point arg to that instead of a string concat is robust
// across OSes and npm-run invocations.
const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
