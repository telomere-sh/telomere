import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { IncomeBinding, IncomeChallenge, IncomeVerification } from './types.js';

export const incomeEndpointLock = pgTable('selection_income_endpoint_lock', { id: integer().primaryKey() });
export const incomeEndpoints = pgTable('selection_income_endpoints', { id: text().primaryKey(), agentId: text().notNull(),
  url: text().notNull(), binding: jsonb().$type<IncomeBinding>().notNull(), revision: text().notNull(),
  active: boolean().notNull(), declaredAt: timestamp({ withTimezone: true }).notNull(),
  challenge: jsonb().$type<IncomeChallenge>(), challengeUsed: boolean().notNull().default(false),
  verification: jsonb().$type<IncomeVerification>() }, table => [uniqueIndex('selection_income_endpoint_agent_url').on(table.agentId, table.url)]);
export const incomeEndpointOperations = pgTable('selection_income_endpoint_operations', { key: text().primaryKey(),
  inputHash: text().notNull(), result: jsonb().$type<{ id: string; challenge?: IncomeChallenge }>().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull() });
export const incomeEndpointSchema = { incomeEndpointLock, incomeEndpoints, incomeEndpointOperations };
export const incomeEndpointMigrationSQL = `
CREATE TABLE IF NOT EXISTS selection_income_endpoint_lock (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO selection_income_endpoint_lock(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS selection_income_endpoints (
 id text PRIMARY KEY, agent_id text NOT NULL, url text NOT NULL, binding jsonb NOT NULL, revision text NOT NULL,
 active boolean NOT NULL, declared_at timestamptz NOT NULL, challenge jsonb, challenge_used boolean NOT NULL DEFAULT false, verification jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS selection_income_endpoint_agent_url ON selection_income_endpoints(agent_id,url);
CREATE TABLE IF NOT EXISTS selection_income_endpoint_operations (
 key text PRIMARY KEY, input_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL
);
`;
