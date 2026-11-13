import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { FinancialFact } from './financial-history.js';

/** Rebuildable read model, never a balance or settlement authority. */
export const financialFacts = pgTable('insight_financial_facts', {
  scope: text().notNull(), runId: text().notNull(), owner: text().notNull(), generation: text().notNull(),
  returnedAt: timestamp({ withTimezone: true }).notNull(), data: jsonb().$type<FinancialFact>().notNull(),
}, table => [primaryKey({ columns: [table.scope, table.runId] })]);
export const financialReferences = pgTable('insight_financial_references', {
  scope: text().notNull(), runId: text().notNull(), transactionHash: text().notNull(),
}, table => [primaryKey({ columns: [table.scope, table.runId] })]);
export const financialInsightDdl = `
CREATE TABLE IF NOT EXISTS insight_financial_facts (scope text NOT NULL, run_id text NOT NULL, owner text NOT NULL,
 generation text NOT NULL, returned_at timestamptz NOT NULL, data jsonb NOT NULL, PRIMARY KEY(scope,run_id));
CREATE INDEX IF NOT EXISTS insight_financial_facts_owner ON insight_financial_facts(scope,generation,owner,returned_at,run_id);
CREATE TABLE IF NOT EXISTS insight_financial_references (scope text NOT NULL,run_id text NOT NULL,transaction_hash text NOT NULL,PRIMARY KEY(scope,run_id));
`;
