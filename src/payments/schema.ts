import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PaymentRequirements, PaymentResource, SettleResponse } from './protocol.js';

export const paymentLock = pgTable('x402_lock', { id: integer().primaryKey() });
export const paymentChallenges = pgTable('x402_challenges', { id: text().primaryKey(), nonce: text().notNull(),
  requestHash: text().notNull(), resource: jsonb().$type<PaymentResource>().notNull(),
  requirements: jsonb().$type<PaymentRequirements>().notNull(), expiresAt: timestamp({ withTimezone: true }).notNull() });
export const paymentJournal = pgTable('x402_journal', { key: text().primaryKey(), challengeId: text().notNull(),
  attemptHash: text().notNull(), signer: text().notNull(), network: text().notNull(),
  state: text().$type<'prepared' | 'settled' | 'reverted'>().notNull(), raw: text(), hash: text(), nonce: integer(),
  response: jsonb().$type<SettleResponse>().notNull(), createdAt: timestamp({ withTimezone: true }).notNull(),
}, table => [uniqueIndex('x402_journal_challenge').on(table.challengeId)]);
export const paymentResourceResults = pgTable('x402_resource_results', { challengeId: text().primaryKey(),
  attemptHash: text().notNull(), state: text().$type<'executing' | 'ready'>().notNull(), amount: text(), result: jsonb().$type<unknown>() });
export const paymentSchema = { paymentLock, paymentChallenges, paymentJournal, paymentResourceResults };
export const paymentMigrationSQL = `
CREATE TABLE IF NOT EXISTS x402_lock (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO x402_lock(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS x402_challenges (id text PRIMARY KEY, nonce text NOT NULL UNIQUE,
 request_hash text NOT NULL, resource jsonb NOT NULL, requirements jsonb NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS x402_journal (key text PRIMARY KEY, challenge_id text NOT NULL REFERENCES x402_challenges(id),
 attempt_hash text NOT NULL, signer text NOT NULL, network text NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','settled','reverted')), raw text, hash text, nonce integer,
 response jsonb NOT NULL, created_at timestamptz NOT NULL,
 CHECK((raw IS NULL AND hash IS NULL AND nonce IS NULL AND state='settled') OR (raw IS NOT NULL AND hash IS NOT NULL AND nonce >= 0)));
CREATE UNIQUE INDEX IF NOT EXISTS x402_journal_challenge ON x402_journal(challenge_id);
CREATE INDEX IF NOT EXISTS x402_journal_sender ON x402_journal(signer,network,state);
CREATE TABLE IF NOT EXISTS x402_resource_results (challenge_id text PRIMARY KEY REFERENCES x402_challenges(id),
 attempt_hash text NOT NULL, state text NOT NULL CHECK(state IN ('executing','ready')), amount text, result jsonb,
 CHECK(state='executing' OR (amount IS NOT NULL AND result IS NOT NULL)));
`;
