import type { Config } from "drizzle-kit";

// Drizzle config is used only for `drizzle-kit` introspection / studio.
// Migrations are hand-written SQL in ./migrations and applied by src/db/migrate.ts
// to keep the migration surface small and auditable during Commit 1.
export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Read from PG_URL at the time drizzle-kit is invoked.
    url: process.env.PG_URL ?? "postgres://agent:agent@localhost:5432/agent",
  },
  verbose: true,
  strict: true,
} satisfies Config;
