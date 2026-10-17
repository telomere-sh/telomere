import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

/** This immutable namespace is deliberately separate from Selection indexing. */
export const selectionReputationPublisherBinding = pgTable('selection_reputation_publisher_binding', {
  id: integer().primaryKey(), profileHash: text().notNull(), profile: text().notNull(),
});
export interface SelectionReputationPublicationPlan {
  agentId: string; identityId: string; originalOwner: string; summaryHash: string; sourceHeight: string;
  feedbackHash: string; feedbackURI: string; feedbackContent: string; data: string;
}
export const selectionReputationPublications = pgTable('selection_reputation_publications', {
  summaryHash: text().primaryKey(), plan: jsonb().$type<SelectionReputationPublicationPlan>().notNull(),
  state: text().$type<'prepared' | 'published' | 'retracted' | 'revoked'>().notNull(),
  transactionHash: text(), blockNumber: text(), blockHash: text(), feedbackIndex: text(),
  revokeTransactionHash: text(), revokeBlockNumber: text(), revokeBlockHash: text(),
});
// Fixed migration, with no caller-controlled identifiers or SQL fragments.
export const selectionReputationPublisherDDL = `
CREATE TABLE IF NOT EXISTS selection_reputation_publisher_binding (
 id integer PRIMARY KEY CHECK(id=1), profile_hash text NOT NULL, profile text NOT NULL
);
CREATE TABLE IF NOT EXISTS selection_reputation_publications (
 summary_hash text PRIMARY KEY, plan jsonb NOT NULL, state text NOT NULL CHECK(state IN ('prepared','published','retracted','revoked')),
 transaction_hash text, block_number text, block_hash text, feedback_index text,
 revoke_transaction_hash text, revoke_block_number text, revoke_block_hash text
);
`;
