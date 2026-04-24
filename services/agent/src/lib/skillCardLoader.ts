import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import {
  SkillCardSchema,
  type SkillCard,
  type Skill,
} from "../schemas/skill-card.js";

/**
 * Skill card loader (Week-2b-runtime).
 *
 * Responsibilities
 * ----------------
 * 1. `loadSkill(name)` — walks `kb/skill_cards/`, finds the YAML card
 *    containing a skill matching `name`, validates via Zod + cross-field
 *    assertions, returns typed `{card, skill}`.
 * 2. `loadAllSkills()` — preloads every skill in the kb directory,
 *    returning a Map keyed by skill name. Used by `runPlanStep` to
 *    present the full catalog to Sonnet's skill-picker prompt.
 * 3. Cache — in-process indefinite. First `loadSkill(X)` or
 *    `loadAllSkills()` walks disk; subsequent calls return from cache.
 *    No mtime invalidation — production skill cards change at deploy
 *    time. See MASTER_PLAN polish queue for dev-iteration hot-reload
 *    if it becomes painful.
 *
 * Audit items addressed (week2b-runtime RFC):
 * - Audit #1 (ambiguous skill name): `SkillCardAmbiguityError` thrown
 *   when the same `skill.name` appears in two different cards. Paths
 *   to both conflicting cards included in the error message.
 * - Cross-field constraint: skill-level `destructive: true` MUST have
 *   at least one step-level `destructive: true`. Asserted at load
 *   time; violators throw `SkillCardValidationError`.
 */

// loader lives at services/agent/src/lib/; repo root is ../../../..
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KB_PATH = path.resolve(__dirname, "..", "..", "..", "..", "kb", "skill_cards");

export interface LoadedSkill {
  /** The parent skill card (for `card.base_url`, `card.auth`, etc.). */
  card: SkillCard;
  /** The specific skill within the card, matched by name. */
  skill: Skill;
  /** Absolute path to the source YAML file (diagnostic only — used in
   *  error messages + logs). */
  source: string;
}

export interface LoaderOptions {
  /** Override the default kb path. Used by tests against tmpdirs. */
  kbPath?: string;
  /** Bypass the in-process cache. Used by tests that want a fresh walk. */
  bypassCache?: boolean;
}

export class SkillCardNotFoundError extends Error {
  public readonly skillName: string;
  public readonly kbPath: string;

  constructor(skillName: string, kbPath: string) {
    super(
      `Skill '${skillName}' not found in any card under ${kbPath}. ` +
        `Check kb/skill_cards/ or run \`npm run validate:skill-cards\`.`,
    );
    this.name = "SkillCardNotFoundError";
    this.skillName = skillName;
    this.kbPath = kbPath;
  }
}

export class SkillCardAmbiguityError extends Error {
  public readonly skillName: string;
  public readonly sources: readonly string[];

  constructor(skillName: string, sources: readonly string[]) {
    super(
      `Skill '${skillName}' is defined in multiple cards:\n` +
        sources.map((s) => `  - ${s}`).join("\n") +
        `\nRename one of the conflicting skills or split them into distinct names.`,
    );
    this.name = "SkillCardAmbiguityError";
    this.skillName = skillName;
    this.sources = sources;
  }
}

export class SkillCardValidationError extends Error {
  public readonly source: string;

  constructor(source: string, detail: string) {
    super(`Skill card at ${source} failed validation:\n${detail}`);
    this.name = "SkillCardValidationError";
    this.source = source;
  }
}

// In-process cache. Key: kbPath → Map<skillName, LoadedSkill>.
// A single agent process almost always uses one kbPath (env-pinned),
// but keying by kbPath keeps tests-with-tmpdirs isolated from each
// other. `clearCache()` exported for tests only.
const cache = new Map<string, Map<string, LoadedSkill>>();

export function clearCache(): void {
  cache.clear();
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

/** Assert skill-level `destructive: true` → at least one step-level
 *  `destructive: true`. This is a cross-field constraint that Zod
 *  can't express as a single schema rule. Throws
 *  `SkillCardValidationError` on violation. */
export function assertCrossFieldConstraints(
  card: SkillCard,
  source: string,
): void {
  for (const skill of card.skills) {
    if (skill.destructive) {
      const anyStepDestructive = skill.steps.some((s) => s.destructive === true);
      if (!anyStepDestructive) {
        throw new SkillCardValidationError(
          source,
          `Skill '${skill.name}' is marked destructive: true but no step carries ` +
            `step-level destructive: true. dry_run would execute the full sequence, ` +
            `violating the dry_run-is-read-only contract. Mark the first state- ` +
            `changing step with destructive: true.`,
        );
      }
    }
  }
}

/** Walk kbPath + parse + validate every YAML card, populating the
 *  cache for kbPath. Throws on first malformed card. Ambiguity
 *  detection runs after the full walk completes so conflicting cards
 *  can be named together in the error message. */
async function populateCache(kbPath: string): Promise<Map<string, LoadedSkill>> {
  const files = await walkYaml(kbPath);
  const bySkillName = new Map<string, LoadedSkill[]>();

  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      throw new SkillCardValidationError(
        file,
        `Failed to read file: ${(err as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new SkillCardValidationError(
        file,
        `YAML parse error: ${(err as Error).message}`,
      );
    }
    const result = SkillCardSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new SkillCardValidationError(file, `Schema issues:\n${issues}`);
    }
    const card = result.data;
    assertCrossFieldConstraints(card, file);

    for (const skill of card.skills) {
      const entry: LoadedSkill = { card, skill, source: file };
      const existing = bySkillName.get(skill.name) ?? [];
      existing.push(entry);
      bySkillName.set(skill.name, existing);
    }
  }

  // Ambiguity detection — any skill name with >1 card wins an error.
  // We run this AFTER the full walk so the error message includes
  // every conflicting source at once (per audit #1).
  const ambiguous: Array<[string, string[]]> = [];
  const flat = new Map<string, LoadedSkill>();
  for (const [name, entries] of bySkillName) {
    if (entries.length > 1) {
      ambiguous.push([name, entries.map((e) => e.source)]);
    } else {
      flat.set(name, entries[0]!);
    }
  }
  if (ambiguous.length > 0) {
    // Throw the first ambiguity. Other conflicts will surface on
    // subsequent walks once the first is resolved.
    const [name, sources] = ambiguous[0]!;
    throw new SkillCardAmbiguityError(name, sources);
  }

  cache.set(kbPath, flat);
  return flat;
}

/** Load a skill by name. Walks kbPath + populates cache on first call;
 *  subsequent calls return from cache. */
export async function loadSkill(
  skillName: string,
  opts: LoaderOptions = {},
): Promise<LoadedSkill> {
  const kbPath = opts.kbPath ?? DEFAULT_KB_PATH;
  let bySkillName = opts.bypassCache ? undefined : cache.get(kbPath);
  if (!bySkillName) {
    bySkillName = await populateCache(kbPath);
  }
  const loaded = bySkillName.get(skillName);
  if (!loaded) {
    throw new SkillCardNotFoundError(skillName, kbPath);
  }
  return loaded;
}

/** Load every skill in kbPath as a Map keyed by skill.name. Used by
 *  `runPlanStep` to list the full catalog in Sonnet's prompt. */
export async function loadAllSkills(
  opts: LoaderOptions = {},
): Promise<Map<string, LoadedSkill>> {
  const kbPath = opts.kbPath ?? DEFAULT_KB_PATH;
  let bySkillName = opts.bypassCache ? undefined : cache.get(kbPath);
  if (!bySkillName) {
    bySkillName = await populateCache(kbPath);
  }
  return bySkillName;
}
