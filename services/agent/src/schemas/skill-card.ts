import { z } from "zod";

/**
 * Skill Card Zod schema (Week-2b foundation).
 *
 * A skill card declares a discrete, auditable operation the agent can
 * execute against a target application — e.g. `reset_password`,
 * `unlock_account`, `check_system_status`. Each card is a YAML file on
 * disk under `kb/skill_cards/<app>/<skill>.yml` plus the compiled prose
 * gets ingested into RAG (see `scripts/embed-skill-cards.ts`) so the
 * agent's planner can retrieve relevant skill cards by intent.
 *
 * Design notes
 * ------------
 * - `schemaVersion` is a literal "1" — future migrations bump this and
 *   reject old YAML explicitly via validation failure.
 * - `tool` enum matches `BrowserSession`'s public methods (navigate /
 *   snapshot / click / fillForm / takeScreenshot) in
 *   `src/mastra/tools/playwrightMcp.ts`. Catches typos at validate-time.
 * - `args` is `z.record(z.unknown())` — tool-specific shapes are
 *   validated at step-execution time by the playwrightMcp wrapper
 *   (runtime commit `week2b-skill-cards-runtime` owns this).
 * - `{{ inputs.X }}` template placeholders in `args` are raw strings
 *   here; the runtime template resolver is deferred to week2b-runtime.
 *   Foundation commit only guarantees the schema validates, the YAML
 *   parses, and the ingest pipeline successfully uploads prose.
 * - `destructive: boolean` is required on every skill (not optional) —
 *   reviewer-gate dispatch hinges on this field, and forcing authors
 *   to declare it catches "forgot to mark" bugs at validate time.
 * - `auth` is card-level optional (not per-skill). Test-webapp's
 *   `check_system_status` doesn't need login; `reset_password` does.
 * - `base_url` stays concrete (not genericized to `handle`) per
 *   `PLATFORM_PIVOTS.md` YAGNI discipline — skill-card content is
 *   IT-vertical and gets rewritten wholesale on any pivot.
 *
 * Not in scope for foundation commit
 * ----------------------------------
 * - Template substitution engine for `{{ inputs.X }}` placeholders
 *   (runtime commit).
 * - Runtime wiring into `runDryRunStep` / `runExecuteStep` (runtime
 *   commit).
 * - Skill-card caching / hot-reload (Week-3+ polish if needed).
 * - Rollback semantics for `destructive: true` skills — the `rollback`
 *   steps are declaratively present on the schema but runtime
 *   execution is Week-3 scope.
 */

export const SkillStepSchema = z.object({
  tool: z.enum([
    "navigate",
    "snapshot",
    "click",
    "fillForm",
    "takeScreenshot",
  ]),
  /** Tool-specific args. Resolved at runtime via the template engine
   *  (`{{ inputs.X }}` → caller-provided values) then dispatched to
   *  the Playwright MCP wrapper. The shape is validated by the
   *  executor at dispatch time, not here. */
  args: z.record(z.unknown()),
  /** Optional human-readable annotation for reviewer UI + audit logs. */
  description: z.string().min(1).max(200).optional(),
  /** Week-2b-runtime — marks a step as destructive (causes state
   *  change). `dry_run` STOPS BEFORE the first step with this set to
   *  true; `execute` runs all steps unchanged. Default false
   *  (back-compat with week2b-foundation cards that omit the field).
   *
   *  Cross-field constraint enforced at skill-card load time (NOT in
   *  this Zod schema — Zod can't express cross-field rules cleanly):
   *  if the SKILL-level `destructive: true`, at least one step MUST
   *  carry step-level `destructive: true`. See
   *  `src/lib/skillCardLoader.ts:assertCrossFieldConstraints`. */
  destructive: z.boolean().optional(),
});

export const SkillInputSchema = z.object({
  type: z.enum(["string", "email", "uuid"]),
  required: z.boolean().default(true),
  description: z.string().max(200).optional(),
});

export const SkillSchema = z.object({
  /** snake_case identifier — matches ReAct tool-name regex and SQL
   *  audit joins. Max 64 matches Anthropic tool-name cap. */
  name: z.string().min(1).max(64).regex(
    /^[a-z][a-z0-9_]*$/,
    "must be snake_case starting with a letter",
  ),
  description: z.string().min(1).max(500),
  /** Load-bearing for reviewer gate dispatch. Every skill MUST declare
   *  destructive: true|false — there is no default. */
  destructive: z.boolean(),
  /** Typed placeholder spec for `{{ inputs.X }}` template substitution.
   *  Runtime commit uses this to validate/coerce caller-supplied values
   *  before resolving templates. */
  inputs: z.record(SkillInputSchema).optional(),
  /** Free-text predicates the planner can surface to the reviewer UI
   *  as "this skill assumes" bullets. Bounded to keep envelope frames
   *  that carry skill metadata under MAX_FRAME_BYTES. */
  preconditions: z.array(z.string().max(300)).max(10).optional(),
  /** Free-text predicates that verify-step can assert against after
   *  execution. Runtime verify uses these as assertion targets. */
  postconditions: z.array(z.string().max(300)).max(10).optional(),
  steps: z.array(SkillStepSchema).min(1).max(20),
  /** Optional rollback sequence — declarative only in foundation. */
  rollback: z.array(SkillStepSchema).max(10).optional(),
});

export const SkillCardAuthSchema = z.object({
  strategy: z.enum(["cookie_session", "none"]),
});

export const SkillCardSchema = z.object({
  schemaVersion: z.literal("1"),
  app: z.string().min(1).max(64),
  base_url: z.string().url(),
  auth: SkillCardAuthSchema.optional(),
  skills: z.array(SkillSchema).min(1),
});

export type SkillCard = z.infer<typeof SkillCardSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type SkillStep = z.infer<typeof SkillStepSchema>;
export type SkillInput = z.infer<typeof SkillInputSchema>;
export type SkillCardAuth = z.infer<typeof SkillCardAuthSchema>;
