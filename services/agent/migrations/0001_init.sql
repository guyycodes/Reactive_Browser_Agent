-- 0001_init.sql — Commit 1 initial schema.
-- Hand-written and idempotent; applied by src/db/migrate.ts on boot.
-- The Drizzle schema in src/db/schema.ts mirrors this file.

CREATE TABLE IF NOT EXISTS runs (
  id              uuid PRIMARY KEY,
  ticket_id       text NOT NULL,
  ticket_subject  text NOT NULL,
  submitted_by    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','awaiting_review','ok','failed','rejected'))
);

CREATE TABLE IF NOT EXISTS events (
  run_id    uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq       integer NOT NULL,
  ts        timestamptz NOT NULL,
  type      text NOT NULL,
  step_id   text NOT NULL,
  payload   jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS events_run_type_idx ON events (run_id, type);

CREATE TABLE IF NOT EXISTS reviews (
  run_id           uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  idempotency_key  uuid,
  decision         text NOT NULL CHECK (decision IN ('approve','reject','edit')),
  by               text NOT NULL,
  decided_at       timestamptz NOT NULL,
  patch            jsonb,
  CONSTRAINT reviews_idempotency_key_unique UNIQUE (idempotency_key)
);
