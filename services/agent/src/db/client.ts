import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * Shared Postgres client + Drizzle handle.
 *
 * Connection pool sizing for Commit 1:
 *   - `max: 10` is plenty for a single-process agent handling a handful of
 *     concurrent runs. Revisit when we know the real request profile.
 *   - `idle_timeout: 20s` closes idle connections reasonably quickly for dev.
 *   - `connect_timeout: 5s` fails fast on boot if Postgres isn't reachable.
 */

const client = postgres(env.PG_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 5,
  // Return lowercase column names to match Drizzle defaults.
  transform: { undefined: null },
});

export const db = drizzle(client, { schema });

export type Database = typeof db;
export type PgClient = typeof client;

/** Close the pool — called from the process shutdown hook in src/index.ts. */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}

/** Exposed for the migration runner, which needs raw SQL execution. */
export function rawClient(): PgClient {
  return client;
}
