import "dotenv/config";
import { z } from "zod";

/**
 * Validated runtime environment for the agent service.
 *
 * All env access in the codebase should go through `env` (the parsed object)
 * rather than `process.env` directly, so that missing / malformed values fail
 * loudly at boot instead of silently at the first use.
 */

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "must be a canonical UUID4",
  );

const csvSchema = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  );

const rawSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // Peers on agent-net
  RAG_URL: z.string().url().default("http://rag:3009"),
  QDRANT_URL: z.string().url().default("http://qdrant:6333"),
  PG_URL: z.string().url().default("postgres://agent:agent@postgres:5432/agent"),

  // Shared Qdrant collection UUIDs — see MASTER_PLAN §3 and services/rag/src/util/queue.py
  SHARED_RUNBOOKS_UUID: uuidSchema,
  SHARED_SKILLS_UUID: uuidSchema,
  SHARED_SELECTORS_UUID: uuidSchema,

  // LLM provider (used by Commit 2's llm/* code; declared now so boot fails
  // early if the env is mis-provisioned).
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL_HAIKU: z.string().default("claude-haiku-4-5"),
  ANTHROPIC_MODEL_SONNET: z.string().default("claude-sonnet-4-5"),
  ANTHROPIC_MODEL_OPUS: z.string().default("claude-opus-4-5"),

  // Commit 7b.i — Anthropic circuit-breaker tuning. All optional; defaults
  // match `defaultOptions()` in `src/lib/circuit.ts`. Prefix is
  // ANTHROPIC_CIRCUIT_* for now; when a second circuit-protected caller
  // arrives (`rag`, `playwright-mcp`), this generalizes to
  // `CIRCUIT_DEFAULT_*` + per-name overrides (Week-2 cleanup, low risk).
  ANTHROPIC_CIRCUIT_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  ANTHROPIC_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  ANTHROPIC_CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  ANTHROPIC_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().min(500).max(600_000).default(30_000),

  // WS Origin allowlist (browser-enforced only; real auth lands Week 3).
  // Includes both localhost and 127.0.0.1 variants because VS Code port
  // forwarding uses 127.0.0.1 and browsers treat the two as distinct origins.
  ALLOWED_WS_ORIGINS: csvSchema.default(
    [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:6080",
      "http://127.0.0.1:6080",
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ].join(","),
  ),

  // Event bus tuning.
  EVENT_RING_BUFFER_SIZE: z.coerce.number().int().min(16).max(10_000).default(500),

  // Test-webapp target (used in Week 1B).
  TEST_WEBAPP_URL: z.string().url().default("http://test-webapp:3000"),

  // Credentials the Week-1B Playwright driver uses when filling the
  // test-webapp's `/login` form. The demo auth accepts any non-empty
  // password against a seeded email, so the defaults are enough to smoke
  // the full password-reset flow without requiring a dev to populate .env.
  // Week 3+ will move target credentials to Docker secrets / a per-skill
  // credential provider; these env vars exist solely so 6b's smoke has
  // a default happy path. Empty-string in `.env` is treated as unset so the
  // committed `.env.example` stub (`TARGET_APP_USER=`) falls through to the
  // defaults without a parse error.
  TARGET_APP_USER: z.preprocess(
    (v) => (typeof v === "string" && v.length > 0 ? v : undefined),
    z.string().min(1).default("theo@example.com"),
  ),
  TARGET_APP_PASSWORD: z.preprocess(
    (v) => (typeof v === "string" && v.length > 0 ? v : undefined),
    z.string().min(1).default("demo"),
  ),
});

const parsed = rawSchema.safeParse(process.env);
if (!parsed.success) {
  // Surface a loud, aggregated error at boot. We print to stderr directly
  // because the logger isn't initialized yet.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`[env] Invalid environment:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

// Mirror validated string defaults back to `process.env` so modules that
// read `process.env` directly (specifically the `env()` helper in
// `src/mastra/workflows/triage.ts`, which deliberately avoids importing
// this module to dodge a historical test-time circular) observe the same
// defaults the `env` singleton did. Only string fields are written so
// parsed arrays (ALLOWED_WS_ORIGINS) and numbers (PORT,
// EVENT_RING_BUFFER_SIZE) don't get stringified.
for (const [k, v] of Object.entries(env)) {
  if (typeof v === "string" && process.env[k] !== v) {
    process.env[k] = v;
  }
}
