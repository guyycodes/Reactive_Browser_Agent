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

export const reviews = pgTable(
  "reviews",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    idempotencyKey: uuid("idempotency_key"),
    decision: text("decision", { enum: ["approve", "reject", "edit"] }).notNull(),
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
