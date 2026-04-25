-- 0003_materialized_skills.sql — week2d Part 3b (reviewer-added DB persistence).
-- Materialized skills are ephemeral per-run artifacts on ctx.tempSkillCard,
-- but durably persisted here with a naming convention
--   <sanitized-hostname>_<scaffold-name>_<uuid>
-- so the UUID (`id` column) can later serve as the Qdrant collection name for
-- vector-DB ingestion (matching the filename-UUID convention in
-- ARCHITECTURE §2.2: `skill_<uuid>.html` → collection `<uuid>`).
--
-- Example: http://example.com + reset_password →
--   name = "example_com_reset_password_a1b2c3d4-..."
--   id   = a1b2c3d4-... (UUID4; also the future Qdrant collection UUID)
--
-- Embedding is NOT landed here; reviewer explicitly punted that to later.
-- This migration only stores the materialized skill for audit + future use.

CREATE TABLE IF NOT EXISTS materialized_skills (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  run_id          uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scaffold_name   text NOT NULL,
  base_url        text NOT NULL,
  skill_json      jsonb NOT NULL,
  divergence      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT materialized_skills_name_unique UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS materialized_skills_run_id_idx
  ON materialized_skills (run_id);
CREATE INDEX IF NOT EXISTS materialized_skills_scaffold_name_idx
  ON materialized_skills (scaffold_name);
