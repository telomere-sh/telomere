import { pgTable, text, timestamp, integer, uniqueIndex } from 'drizzle-orm/pg-core';

export const deadlineJobs = pgTable('deadline_jobs', {
  id: text().primaryKey(), owner: text().notNull(), idemKey: text().notNull(), inputHash: text().notNull(),
  runId: text(), deadlineAt: timestamp({ withTimezone: true }).notNull(), maxSpend: text().notNull(),
  maxSeconds: integer().notNull(), hostId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('deadline_owner_idem').on(table.owner, table.idemKey), uniqueIndex('deadline_run').on(table.runId)]);
export const deadlineMigrationSQL = `
CREATE TABLE IF NOT EXISTS deadline_jobs (
 id text PRIMARY KEY, owner text NOT NULL, idem_key text NOT NULL, input_hash text NOT NULL,
 run_id text, deadline_at timestamptz NOT NULL, max_spend text NOT NULL, max_seconds integer NOT NULL,
 host_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS deadline_owner_idem ON deadline_jobs(owner, idem_key);
CREATE UNIQUE INDEX IF NOT EXISTS deadline_run ON deadline_jobs(run_id);
`;
