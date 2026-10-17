import { pgTable, text, timestamp, boolean, jsonb, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import type { LargeCystRegistryPlan } from './large-publication-types.js';
import type { LargeCystRegistryDescriptor } from './large-registry.js';
import type { CystRegistryBinding, CystRegistryPins } from './registry-types.js';

export type LargePublicationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';

export const largeCystPublicationJobs = pgTable('large_cyst_publication_jobs', {
  id: text().primaryKey(),
  principal: text().notNull(),
  agentId: text().notNull(),
  checkpointId: text().notNull(),
  idempotencyKey: text().notNull(),
  status: text().$type<LargePublicationStatus>().notNull().default('queued'),
  deadlineAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  cancelRequested: boolean().notNull().default(false),
  plan: jsonb().$type<LargeCystRegistryPlan>(),
  errorCode: text(),
}, table => [uniqueIndex('large_cyst_publication_principal_idem').on(table.principal, table.idempotencyKey)]);

/** Durable locator evidence written atomically with a completed two-copy audit.
 * A row is only a candidate: every read must match fresh canonical state and
 * the immutable manifest before returning its checkpoint ID.
 */
export const largeCystPublicationCatalog = pgTable('large_cyst_publication_catalog', {
  storageRef: text().notNull(),
  agentId: text().notNull(),
  checkpointId: text().notNull(),
  descriptor: jsonb().$type<LargeCystRegistryDescriptor>().notNull(),
  binding: jsonb().$type<CystRegistryBinding>().notNull(),
  pins: jsonb().$type<CystRegistryPins>().notNull(),
  auditedJobId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.agentId, table.storageRef] })]);

export const largeCystPublicationMigrationSQL = `
CREATE TABLE IF NOT EXISTS large_cyst_publication_jobs (
  id text PRIMARY KEY, principal text NOT NULL, agent_id text NOT NULL,
  checkpoint_id text NOT NULL, idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued', deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  cancel_requested boolean NOT NULL DEFAULT false, plan jsonb, error_code text
);
CREATE UNIQUE INDEX IF NOT EXISTS large_cyst_publication_principal_idem
  ON large_cyst_publication_jobs(principal, idempotency_key);
CREATE INDEX IF NOT EXISTS large_cyst_publication_active
  ON large_cyst_publication_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS large_cyst_publication_catalog (
  storage_ref text NOT NULL, agent_id text NOT NULL, checkpoint_id text NOT NULL,
  descriptor jsonb NOT NULL, binding jsonb NOT NULL, pins jsonb NOT NULL,
  audited_job_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, storage_ref)
);
CREATE INDEX IF NOT EXISTS large_cyst_publication_catalog_agent
  ON large_cyst_publication_catalog(agent_id);
`;
