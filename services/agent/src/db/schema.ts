import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/pg-core";

/**
 * Schema for Commit 1 — just enough to hold run metadata, the append-only
 * event audit trail, and review decisions. Broader schema (selectors, skill
 * cards, etc.) lands in later commits / weeks per MASTER_PLAN.
 */

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey(),
  ticketId: text("ticket_id").notNull(),
  ticketSubject: text("ticket_subject").notNull(),
  submittedBy: text("submitted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status", { enum: ["pending", "running", "awaiting_review", "ok", "failed", "rejected"] })
    .notNull()
    .default("pending"),
});

export const events = pgTable(
  "events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    type: text("type").notNull(),
    stepId: text("step_id").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.seq] }),
    byTypeIdx: index("events_run_type_idx").on(t.runId, t.type),
  }),
);

/** week2d Part 3b — Persistent audit trail for materialized skills.
 *  Each happy-path run produces one row after successful materialization.
 *  `id` is a UUID4 that ALSO serves as the Qdrant collection name when
 *  vector-DB ingestion lands (embedding work deferred per reviewer).
 *  `name` follows the convention `<host>_<scaffold>_<uuid>`, unique
 *  across the table so operators can grep by domain or scaffold. */
export const materializedSkills = pgTable(
  "materialized_skills",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    scaffoldName: text("scaffold_name").notNull(),
    baseUrl: text("base_url").notNull(),
    skillJson: jsonb("skill_json").notNull(),
    divergence: jsonb("divergence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    nameUnique: unique("materialized_skills_name_unique").on(t.name),
    byRunIdx: index("materialized_skills_run_id_idx").on(t.runId),
    byScaffoldIdx: index("materialized_skills_scaffold_name_idx").on(t.scaffoldName),
  }),
);

export const reviews = pgTable(
  "reviews",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    idempotencyKey: uuid("idempotency_key"),
    // Week-2a gate-decision-model — 4-value decision enum. App-layer
    // validation via Drizzle's `enum` constraint; Postgres-layer
    // validation via the CHECK constraint at
    // `migrations/0002_add_terminate_decision.sql`. Both must be
    // kept in lockstep with envelope.ts ReviewDecidedFrame.decision
    // and clientFrameSchema.review.decide.decision.
    decision: text("decision", {
      enum: ["approve", "reject", "edit", "terminate"],
    }).notNull(),
    by: text("by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    patch: jsonb("patch"),
  },
  (t) => ({
    // If a client supplies an idempotency key we also track it uniquely so
    // the same key can be replayed from HTTP without reading the decision
    // column (and two different keys can't both commit).
    idempotencyKeyUnique: unique("reviews_idempotency_key_unique").on(t.idempotencyKey),
  }),
);
