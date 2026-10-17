import { bigint, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

export const selectionCursors = pgTable('selection_cursors', { key: text().primaryKey(), profileHash: text().notNull(),
  nextBlock: bigint({ mode: 'bigint' }).notNull(), lastHash: text(), revision: integer().notNull().default(0) });
export const selectionBlocks = pgTable('selection_blocks', { indexKey: text().notNull(), height: bigint({ mode: 'bigint' }).notNull(),
  hash: text().notNull(), parentHash: text().notNull(), timestamp: bigint({ mode: 'bigint' }).notNull() }, table => [primaryKey({ columns: [table.indexKey, table.height] })]);
export const selectionEvents = pgTable('selection_events', { indexKey: text().notNull(), id: text().notNull(),
  height: bigint({ mode: 'bigint' }).notNull(), blockHash: text().notNull(), transactionHash: text().notNull(), logIndex: integer().notNull(),
  address: text().notNull(), name: text().notNull(), args: jsonb().$type<Record<string, string | boolean>>().notNull() }, table => [primaryKey({ columns: [table.indexKey, table.id] })]);
export interface SelectionAgentView {
  agentId: string; owner: string; vault: string; identityId: string; leashId: string; parent: string; family: string; generation: number;
  cystHash: string; status: 'alive' | 'dormant' | 'dead'; frozen: boolean; bornAt: string; birthBlock: string;
  dormantAt: string | null; deathAt: string | null; diedAt: string | null; lastPaidAt: string; lastActivationAt: string;
  income: string; incomeFees: string; burn: string; subsidy: string; ownerWithdrawals: string; childFunding: string; openRuns: number; livingChildren: number; offspring: number;
}
export interface SelectionFossilView {
  agentId: string; owner: string; family: string; parent: string; generation: number; identityId: string; vault: string;
  bornAt: string; diedAt: string; lifespanSeconds: string; deathBlock: string; deathBlockHash: string; deathTransaction: string; cause: string;
  lifetimeIncome: string; lifetimeIncomeFees: string; lifetimeNetIncome: string; lifetimeBurn: string; lifetimeSubsidy: string;
  survivalRatio: { numerator: string; denominator: string } | null; cystHash: string; offspring: number;
}
export const selectionAgents = pgTable('selection_agents', { indexKey: text().notNull(), agentId: text().notNull(), owner: text().notNull(),
  vault: text().notNull(), data: jsonb().$type<SelectionAgentView>().notNull() }, table => [primaryKey({ columns: [table.indexKey, table.agentId] })]);
export const selectionFossils = pgTable('selection_fossils', { indexKey: text().notNull(), agentId: text().notNull(),
  deathBlock: bigint({ mode: 'bigint' }).notNull(), data: jsonb().$type<SelectionFossilView>().notNull() }, table => [primaryKey({ columns: [table.indexKey, table.agentId] })]);
export const selectionSchema = { selectionCursors, selectionBlocks, selectionEvents, selectionAgents, selectionFossils };
export const selectionMigrationSQL = `
CREATE TABLE IF NOT EXISTS selection_cursors (key text PRIMARY KEY, profile_hash text NOT NULL, next_block bigint NOT NULL, last_hash text, revision integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS selection_blocks (index_key text NOT NULL, height bigint NOT NULL, hash text NOT NULL, parent_hash text NOT NULL, timestamp bigint NOT NULL, PRIMARY KEY(index_key,height));
CREATE TABLE IF NOT EXISTS selection_events (index_key text NOT NULL, id text NOT NULL, height bigint NOT NULL, block_hash text NOT NULL, transaction_hash text NOT NULL, log_index integer NOT NULL, address text NOT NULL, name text NOT NULL, args jsonb NOT NULL, PRIMARY KEY(index_key,id));
CREATE INDEX IF NOT EXISTS selection_events_height ON selection_events(index_key,height,log_index);
CREATE TABLE IF NOT EXISTS selection_agents (index_key text NOT NULL, agent_id text NOT NULL, owner text NOT NULL, vault text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(index_key,agent_id));
CREATE INDEX IF NOT EXISTS selection_agents_owner ON selection_agents(index_key,owner,agent_id);
CREATE TABLE IF NOT EXISTS selection_fossils (index_key text NOT NULL, agent_id text NOT NULL, death_block bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY(index_key,agent_id));
`;
