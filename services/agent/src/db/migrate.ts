import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rawClient, closeDb } from "./client.js";
import { logger } from "../logger.js";

/**
 * Minimal migration runner for Commit 1.
 *
 * - Reads all `*.sql` files under `services/agent/migrations/` in lexical order.
 * - Tracks applied filenames in a single `_agent_migrations` table.
 * - Each file is executed inside a transaction. A failure rolls back that
 *   file's statements and aborts the runner; a subsequent run will retry
 *   from that file.
 *
 * Why hand-rolled instead of `drizzle-kit migrate` or `postgres-migrations`:
 *   - Our migration surface in Commit 1 is a single file. Pulling in another
 *     library for that is weight.
 *   - We want boot-time migration to be part of the agent's own code path so
 *     Docker container start is "run migrate + serve" with no external shell
 *     step. `drizzle-kit` is a CLI tool; embedding it in the runtime is
 *     fiddlier than shipping 40 lines of ts.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "migrations");
const TRACKER_TABLE = "_agent_migrations";

async function ensureTrackerTable(): Promise<void> {
  const sql = rawClient();
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${TRACKER_TABLE} (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function loadAppliedNames(): Promise<Set<string>> {
  const sql = rawClient();
  const rows = await sql<Array<{ name: string }>>`
    SELECT name FROM ${sql(TRACKER_TABLE)} ORDER BY name
  `;
  return new Set(rows.map((r) => r.name));
}

async function applyOne(name: string, contents: string): Promise<void> {
  const sql = rawClient();
  await sql.begin(async (tx) => {
    await tx.unsafe(contents);
    await tx`
      INSERT INTO ${tx(TRACKER_TABLE)} (name) VALUES (${name})
    `;
  });
}

export async function runMigrations(): Promise<void> {
  await ensureTrackerTable();
  const applied = await loadAppliedNames();

  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

  let appliedCount = 0;
  for (const file of sqlFiles) {
    if (applied.has(file)) {
      logger.debug({ file }, "[migrate] already applied");
      continue;
    }
    const path = join(MIGRATIONS_DIR, file);
    const sql = await readFile(path, "utf8");
    logger.info({ file }, "[migrate] applying");
    await applyOne(file, sql);
    appliedCount++;
  }

  logger.info(
    { appliedNow: appliedCount, appliedTotal: applied.size + appliedCount },
    "[migrate] done",
  );
}

/** Allow running this file standalone: `npm run migrate` */
const isDirectInvocation =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (isDirectInvocation) {
  runMigrations()
    .then(async () => {
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, "[migrate] failed");
      await closeDb();
      process.exit(1);
    });
}
