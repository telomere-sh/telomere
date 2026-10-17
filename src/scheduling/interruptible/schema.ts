import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { InterruptibleAdmission, ApprovedInterruptibleRun, CompletedInterruptibleSettlement,
  SignedPreemptionNotice, InterruptibleState } from './types.js';

export const interruptibleRuns = pgTable('interruptible_runs', {
  id: text().primaryKey(), owner: text().notNull(), agent: text().notNull(), runId: text().notNull(),
  idemKey: text().notNull(), requestHash: text().notNull(), input: jsonb().$type<InterruptibleAdmission>().notNull(),
  source: jsonb().$type<ApprovedInterruptibleRun>().notNull(), targets: jsonb().$type<ApprovedInterruptibleRun[]>().notNull().default([]),
  notice: jsonb().$type<SignedPreemptionNotice>(), state: text().$type<InterruptibleState>().notNull().default('admitted'),
  version: integer().notNull().default(0), sleepVersion: integer(), sleepIntentId: text(), checkpointId: text(),
  settlement: jsonb().$type<CompletedInterruptibleSettlement>(), targetSettlement: jsonb().$type<CompletedInterruptibleSettlement>(),
  targetRunId: text(), wakeVersion: integer(), wakeIntentId: text(),
  cancelVersion: integer(), cancelIntentId: text(), reason: text(), createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('interruptible_owner_idem').on(table.owner, table.idemKey),
  uniqueIndex('interruptible_source_run').on(table.runId)]);
export const hostPreemptionNotices = pgTable('host_preemption_notices', {
  id: text().primaryKey(), owner: text().notNull(), runId: text().notNull(), hostKey: text().notNull(),
  requestHash: text().notNull(), notice: jsonb().$type<SignedPreemptionNotice>().notNull(),
  cleanupConfirmed: integer().notNull().default(0), enforcedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type InterruptibleRecord = typeof interruptibleRuns.$inferSelect;
export const interruptibleMigrationSQL = `
CREATE TABLE IF NOT EXISTS interruptible_runs (
 id text PRIMARY KEY, owner text NOT NULL, agent text NOT NULL, run_id text NOT NULL,
 idem_key text NOT NULL, request_hash text NOT NULL, input jsonb NOT NULL, source jsonb NOT NULL,
 targets jsonb NOT NULL DEFAULT '[]', notice jsonb,
 state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted','noticed','checkpointing','settling','selecting','waking','cancelling','resumed','cancelled')),
 version integer NOT NULL DEFAULT 0 CHECK (version >= 0), sleep_version integer, sleep_intent_id text, checkpoint_id text,
 settlement jsonb, target_settlement jsonb, target_run_id text, wake_version integer, wake_intent_id text, cancel_version integer, cancel_intent_id text,
 reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (owner,agent) REFERENCES agents(owner,agent)
);
CREATE UNIQUE INDEX IF NOT EXISTS interruptible_owner_idem ON interruptible_runs(owner,idem_key);
CREATE UNIQUE INDEX IF NOT EXISTS interruptible_source_run ON interruptible_runs(run_id);
ALTER TABLE interruptible_runs ADD COLUMN IF NOT EXISTS target_settlement jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS interruptible_one_open_agent ON interruptible_runs(owner,agent)
 WHERE state NOT IN ('resumed','cancelled');
CREATE INDEX IF NOT EXISTS interruptible_owner_recent ON interruptible_runs(owner,created_at);
CREATE TABLE IF NOT EXISTS host_preemption_notices (
 id text PRIMARY KEY, owner text NOT NULL, run_id text NOT NULL, host_key text NOT NULL, request_hash text NOT NULL,
 notice jsonb NOT NULL, cleanup_confirmed integer NOT NULL DEFAULT 0 CHECK (cleanup_confirmed IN (0,1)),
 enforced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE host_preemption_notices ADD COLUMN IF NOT EXISTS cleanup_confirmed integer NOT NULL DEFAULT 0;
ALTER TABLE host_preemption_notices ADD COLUMN IF NOT EXISTS enforced_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS host_preemption_one_notice ON host_preemption_notices(host_key,run_id);
`;
