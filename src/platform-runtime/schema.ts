import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PlatformQuote, PlatformQuoteInput, PlatformSettlement } from './types.js';
import type { SignedHostAck, SignedHostLease, SignedHostTick } from '../host-kit/protocol.js';
import type { CpuRunResult, MeterTick } from '../runtime/types.js';
import type { PlatformVaultBinding } from './vault.js';
import type { SessionEvent } from '../host-kit/sessions/types.js';
import type { NearCompletionResult } from '../providers/near.js';
import type { X402CpuReservation } from '../payments/cpu-reservations.js';

export type PlatformRunStatus = 'prepared' | 'queued' | 'running' | 'near_dispatching' | 'receipt_pending' | 'settling' | 'completed' | 'refunded' | 'reconciliation';
export const platformRuns = pgTable('platform_runs', {
  id: text().primaryKey(), owner: text().notNull(), agent: text().notNull(), idemKey: text().notNull(), inputHash: text().notNull(),
  input: jsonb().$type<PlatformQuoteInput>().notNull(), quote: jsonb().$type<PlatformQuote>().notNull(), signature: text().notNull(),
  ceiling: text().notNull(), imageProof: jsonb().$type<string[]>().notNull(), regionProof: jsonb().$type<string[]>().notNull(),
  status: text().$type<PlatformRunStatus>().notNull(), receiptVersion: integer().$type<1 | 2>().notNull().default(1), admissionTx: text(), settlementTx: text(),
  ticks: jsonb().$type<MeterTick[]>().notNull().default([]), result: jsonb().$type<CpuRunResult>(),
  nearResult: jsonb().$type<NearCompletionResult>(),
  settlement: jsonb().$type<PlatformSettlement>(), charged: text(), refund: text(), errorCode: text(),
  vaultBinding: jsonb().$type<PlatformVaultBinding>(), vaultSyncTx: text(),
  x402Funding: jsonb().$type<X402CpuReservation>(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('platform_runs_owner_idem').on(table.owner, table.idemKey)]);
export const platformHostLeases = pgTable('platform_host_leases', {
  runId: text().primaryKey().references(() => platformRuns.id), hostId: text().notNull(), owner: text().notNull(), leaseHash: text().notNull(),
  lease: jsonb().$type<SignedHostLease>().notNull(), ticks: jsonb().$type<SignedHostTick[]>().notNull().default([]),
  acknowledgments: jsonb().$type<SignedHostAck[]>().notNull().default([]), cleanupConfirmed: integer().notNull().default(0),
  sessionEvents: jsonb().$type<SessionEvent[]>(),
});
export const platformSignerLock = pgTable('platform_signer_lock', { id: integer().primaryKey() });
export const platformTransactionJournal = pgTable('platform_transaction_journal', {
  key: text().primaryKey(), chainId: integer().notNull(), sender: text().notNull(), to: text().notNull(), data: text().notNull(),
  raw: text().notNull(), hash: text().notNull(), nonce: integer().notNull(),
}, table => [uniqueIndex('platform_transaction_sender_nonce').on(table.chainId, table.sender, table.nonce)]);
/** No signatures or raw external-wallet transactions are retained here. */
export const platformX402Challenges = pgTable('platform_x402_challenges', {
  id: text().primaryKey(), owner: text().notNull(), idemKey: text().notNull(), inputHash: text().notNull(), requestHash: text().notNull(),
  resourceUrl: text().notNull(), scheme: text().$type<'exact' | 'upto'>().notNull(), salt: text().notNull(), runId: text(),
  paymentHash: text(), intentHash: text(), createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('platform_x402_owner_idem').on(table.owner, table.idemKey), uniqueIndex('platform_x402_run').on(table.runId)]);
export const platformRuntimeSchema = { platformRuns, platformHostLeases, platformSignerLock, platformTransactionJournal, platformX402Challenges };
export const platformRuntimeMigrationSQL = `
CREATE TABLE IF NOT EXISTS platform_runs (
 id text PRIMARY KEY, owner text NOT NULL, agent text NOT NULL, idem_key text NOT NULL, input_hash text NOT NULL,
 input jsonb NOT NULL, quote jsonb NOT NULL, signature text NOT NULL, ceiling text NOT NULL,
 image_proof jsonb NOT NULL, region_proof jsonb NOT NULL, status text NOT NULL,
 admission_tx text, settlement_tx text, ticks jsonb NOT NULL DEFAULT '[]', result jsonb, settlement jsonb,
 charged text, refund text, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_runs_owner_idem ON platform_runs(owner, idem_key);
ALTER TABLE platform_runs ADD COLUMN IF NOT EXISTS vault_binding jsonb;
ALTER TABLE platform_runs ADD COLUMN IF NOT EXISTS vault_sync_tx text;
ALTER TABLE platform_runs ADD COLUMN IF NOT EXISTS near_result jsonb;
ALTER TABLE platform_runs ADD COLUMN IF NOT EXISTS receipt_version integer NOT NULL DEFAULT 1 CHECK (receipt_version IN (1,2));
ALTER TABLE platform_runs ADD COLUMN IF NOT EXISTS x402_funding jsonb;
CREATE TABLE IF NOT EXISTS platform_x402_challenges (
 id text PRIMARY KEY, owner text NOT NULL, idem_key text NOT NULL, input_hash text NOT NULL, request_hash text NOT NULL,
 resource_url text NOT NULL, scheme text NOT NULL CHECK(scheme IN ('exact','upto')), salt text NOT NULL,
 run_id text, payment_hash text, intent_hash text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_x402_owner_idem ON platform_x402_challenges(owner,idem_key);
CREATE UNIQUE INDEX IF NOT EXISTS platform_x402_run ON platform_x402_challenges(run_id);
CREATE INDEX IF NOT EXISTS platform_runs_status_created ON platform_runs(status, created_at);
CREATE TABLE IF NOT EXISTS platform_host_leases (
 run_id text PRIMARY KEY REFERENCES platform_runs(id), host_id text NOT NULL, owner text NOT NULL, lease_hash text NOT NULL,
 lease jsonb NOT NULL, ticks jsonb NOT NULL DEFAULT '[]', acknowledgments jsonb NOT NULL DEFAULT '[]',
 cleanup_confirmed integer NOT NULL DEFAULT 0 CHECK (cleanup_confirmed IN (0,1))
);
ALTER TABLE platform_host_leases ADD COLUMN IF NOT EXISTS session_events jsonb;
CREATE TABLE IF NOT EXISTS platform_signer_lock (id integer PRIMARY KEY CHECK (id=1));
INSERT INTO platform_signer_lock(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_transaction_journal (
 key text PRIMARY KEY, chain_id integer NOT NULL, sender text NOT NULL, "to" text NOT NULL, data text NOT NULL,
 raw text NOT NULL, hash text NOT NULL, nonce integer NOT NULL CHECK (nonce>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_transaction_sender_nonce ON platform_transaction_journal(chain_id,sender,nonce);
`;
