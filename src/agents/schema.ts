import { integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AgentMode, IntentKind, IntentPhase } from './types.js';
import type { evaluateMetabolismV2 } from './metabolism-v2.js';

export const agents = pgTable('agents', {
  owner: text().notNull(), agent: text().notNull(), version: integer().notNull().default(0),
  mode: text().$type<AgentMode>().notNull().default('cyst'), currentRunId: text(),
  checkpointId: text(), leaseUntil: timestamp({ withTimezone: true }), wakeAt: timestamp({ withTimezone: true }),
  killedAt: timestamp({ withTimezone: true }), createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.owner, table.agent] })]);
export const agentIntents = pgTable('agent_intents', {
  id: text().primaryKey(), owner: text().notNull(), agent: text().notNull(), idemKey: text().notNull(), requestHash: text().notNull(),
  kind: text().$type<IntentKind>().notNull(), phase: text().$type<IntentPhase>().notNull(), targetMode: text().$type<AgentMode>().notNull(),
  sourceRunId: text(), targetRunId: text(), checkpointId: text(), checkpointSha256: text(),
  targetLeaseUntil: timestamp({ withTimezone: true }), version: integer().notNull().default(0),
  metabolismVersion: integer(), metabolismEvaluation: jsonb().$type<ReturnType<typeof evaluateMetabolismV2>>(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('agent_intent_owner_idem').on(table.owner, table.idemKey)]);
export const agentBilling = pgTable('agent_billing', {
  owner: text().notNull(), receiptId: text().notNull(), agent: text().notNull(), amount: text().notNull(),
  settledAt: timestamp({ withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.owner, table.receiptId] })]);
export const agentRuntimeBinding = pgTable('agent_runtime_binding', {
  id: integer().primaryKey(), protocol: text().notNull(), chainId: integer().notNull(),
  escrow: text().notNull(), token: text().notNull(), vaultProfileHash: text(),
});
export const agentVaultBindings = pgTable('agent_vault_bindings', {
  owner: text().notNull(), agent: text().notNull(), vault: text().notNull(), agentId: text().notNull(), leashId: text().notNull(),
}, table => [primaryKey({ columns: [table.owner, table.agent] }), uniqueIndex('agent_vault_binding_vault').on(table.vault)]);
export const agentBillingProvenance = pgTable('agent_billing_provenance', {
  owner: text().notNull(), receiptId: text().notNull(), transactionHash: text().notNull(),
  blockNumber: text().notNull(), blockHash: text().notNull(), factsHash: text().notNull(),
  validatedAnchorHash: text(),
}, table => [primaryKey({ columns: [table.owner, table.receiptId] })]);
export const agentBillingAnchors = pgTable('agent_billing_anchors', {
  owner: text().notNull(), agent: text().notNull(), blockNumber: text().notNull(), blockHash: text().notNull(),
}, table => [primaryKey({ columns: [table.owner, table.agent] })]);
export type AgentRecord = typeof agents.$inferSelect;
export type AgentIntent = typeof agentIntents.$inferSelect;
export const agentMigrationSQL = `
CREATE TABLE IF NOT EXISTS agents (
 owner text NOT NULL, agent text NOT NULL, version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
 mode text NOT NULL DEFAULT 'cyst' CHECK (mode IN ('full','lean','torpor','cyst')), current_run_id text,
 checkpoint_id text, lease_until timestamptz, wake_at timestamptz, killed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner,agent)
);
CREATE TABLE IF NOT EXISTS agent_intents (
 id text PRIMARY KEY, owner text NOT NULL, agent text NOT NULL, idem_key text NOT NULL, request_hash text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('migrate','sleep','wake','profile','kill','rollover')),
 phase text NOT NULL CHECK (phase IN ('checkpoint','stop','attach','resume','profile','done')),
 target_mode text NOT NULL CHECK (target_mode IN ('full','lean','torpor','cyst')),
 source_run_id text, target_run_id text, checkpoint_id text, checkpoint_sha256 text, target_lease_until timestamptz,
 version integer NOT NULL DEFAULT 0 CHECK (version >= 0), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (owner,agent) REFERENCES agents(owner,agent)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_intent_owner_idem ON agent_intents(owner,idem_key);
ALTER TABLE agent_intents ADD COLUMN IF NOT EXISTS metabolism_version integer CHECK (metabolism_version IS NULL OR metabolism_version=2);
ALTER TABLE agent_intents ADD COLUMN IF NOT EXISTS metabolism_evaluation jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS agent_one_open_intent ON agent_intents(owner,agent) WHERE phase <> 'done';
CREATE TABLE IF NOT EXISTS agent_billing (
 owner text NOT NULL, receipt_id text NOT NULL, agent text NOT NULL,
 amount text NOT NULL CHECK (amount ~ '^(0|[1-9][0-9]{0,77})$'), settled_at timestamptz NOT NULL,
 PRIMARY KEY (owner,receipt_id), FOREIGN KEY (owner,agent) REFERENCES agents(owner,agent)
);
CREATE INDEX IF NOT EXISTS agent_billing_window ON agent_billing(owner,agent,settled_at);
CREATE TABLE IF NOT EXISTS agent_runtime_binding (
 id integer PRIMARY KEY CHECK (id=1), protocol text NOT NULL CHECK (protocol IN ('legacy','platform','platform_vault')),
 chain_id integer NOT NULL, escrow text NOT NULL, token text NOT NULL
);
ALTER TABLE agent_runtime_binding ADD COLUMN IF NOT EXISTS vault_profile_hash text;
ALTER TABLE agent_runtime_binding DROP CONSTRAINT IF EXISTS agent_runtime_binding_protocol_check;
ALTER TABLE agent_runtime_binding ADD CONSTRAINT agent_runtime_binding_protocol_check CHECK (protocol IN ('legacy','platform','platform_vault'));
CREATE TABLE IF NOT EXISTS agent_vault_bindings (
 owner text NOT NULL, agent text NOT NULL, vault text NOT NULL, agent_id text NOT NULL, leash_id text NOT NULL,
 PRIMARY KEY (owner,agent), FOREIGN KEY (owner,agent) REFERENCES agents(owner,agent)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_vault_binding_vault ON agent_vault_bindings(vault);
CREATE TABLE IF NOT EXISTS agent_billing_provenance (
 owner text NOT NULL, receipt_id text NOT NULL, transaction_hash text NOT NULL,
 block_number text NOT NULL CHECK (block_number ~ '^(0|[1-9][0-9]{0,19})$'), block_hash text NOT NULL,
 facts_hash text NOT NULL, PRIMARY KEY (owner,receipt_id),
 FOREIGN KEY (owner,receipt_id) REFERENCES agent_billing(owner,receipt_id)
);
ALTER TABLE agent_billing_provenance ADD COLUMN IF NOT EXISTS validated_anchor_hash text;
CREATE TABLE IF NOT EXISTS agent_billing_anchors (
 owner text NOT NULL, agent text NOT NULL, block_number text NOT NULL CHECK (block_number ~ '^(0|[1-9][0-9]{0,19})$'),
 block_hash text NOT NULL, PRIMARY KEY (owner,agent), FOREIGN KEY (owner,agent) REFERENCES agents(owner,agent)
);
`;
