import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PaidCpuJob, PaidCpuJobReplan } from './paid-job-types.js';
export const paidCpuJobs = pgTable('paid_cpu_jobs', { id: text().primaryKey(), owner: text().notNull(),
  vault: text().notNull(), idemKey: text().notNull(), inputHash: text().notNull(), revision: integer().notNull().default(0),
  state: jsonb().$type<PaidCpuJob>().notNull(), replanKey: text(), replan: jsonb().$type<PaidCpuJobReplan>(),
}, table => [uniqueIndex('paid_cpu_jobs_owner_vault_idem').on(table.owner, table.vault, table.idemKey)]);
export const paidCpuJobMigrationSQL = `
CREATE TABLE IF NOT EXISTS paid_cpu_jobs (
 id text PRIMARY KEY, owner text NOT NULL, vault text NOT NULL, idem_key text NOT NULL, input_hash text NOT NULL,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), state jsonb NOT NULL, replan_key text, replan jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS paid_cpu_jobs_owner_vault_idem ON paid_cpu_jobs(owner,vault,idem_key);
`;
