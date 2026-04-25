import { db } from "./client.js";
import { materializedSkills } from "./schema.js";
import { logger } from "../logger.js";
import type { Skill } from "../schemas/skill-card.js";

/**
 * week2d Part 3b — Persistence helper for materialized skills.
 *
 * Extracted as its own module so `runMaterializeSkillCardStep` tests can
 * mock the insert without touching the Drizzle client. Also the single
 * place the naming-convention rule lives (see `buildMaterializedSkillName`).
 */

/** Convert a URL into a filesystem / identifier-safe host token.
 *
 *  Example: `http://test-webapp:3000`  → `test-webapp_3000`
 *           `https://example.com`      → `example_com`
 *           `http://localhost:3000/x`  → `localhost_3000`
 *
 *  - Hostname + port (no scheme, no path).
 *  - Dots + colons → underscores. Hyphens preserved (readable).
 *  - Lowercased. */
function sanitizeHost(baseUrl: string): string {
  const u = new URL(baseUrl);
  return u.host.replace(/[:.]/g, "_").toLowerCase();
}

/** Build the materialized-skill identifier per the week2d Part 3b
 *  convention: `<sanitized-hostname>_<scaffold-name>_<uuid4>`.
 *
 *  The UUID is injected by the caller (generated fresh at materialize
 *  time) so the same value ends up in BOTH the Postgres `id` column
 *  AND the embedded name — which means future Qdrant ingestion can
 *  parse the UUID back out of the filename if it wants, and the
 *  collection UUID in Qdrant matches the Postgres row verbatim.
 *
 *  Example:
 *    buildMaterializedSkillName("http://example.com", "reset_password", "a1b2...")
 *      → "example_com_reset_password_a1b2..."
 */
export function buildMaterializedSkillName(
  baseUrl: string,
  scaffoldName: string,
  uuid: string,
): string {
  return `${sanitizeHost(baseUrl)}_${scaffoldName}_${uuid}`;
}

export interface InsertMaterializedSkillArgs {
  id: string;
  name: string;
  runId: string;
  scaffoldName: string;
  baseUrl: string;
  skill: Skill;
  divergence: {
    expected: string;
    actual: string;
    reason: string;
  } | null;
}

/** Append a materialized-skill row. Logs on failure but does NOT
 *  throw — materialization is already successful and the ephemeral
 *  `ctx.tempSkillCard` is what execute reads. Persistence failure
 *  is an audit-trail gap, not a run-blocker. */
export async function insertMaterializedSkill(
  args: InsertMaterializedSkillArgs,
): Promise<void> {
  try {
    await db.insert(materializedSkills).values({
      id: args.id,
      name: args.name,
      runId: args.runId,
      scaffoldName: args.scaffoldName,
      baseUrl: args.baseUrl,
      skillJson: args.skill,
      divergence: args.divergence,
    });
  } catch (err) {
    logger.warn(
      {
        runId: args.runId,
        skillName: args.name,
        err: (err as Error).message,
      },
      "[materialize] failed to persist materialized skill to Postgres (non-blocking)",
    );
  }
}
