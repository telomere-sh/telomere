import { z } from 'zod';
import { bytes32Schema } from '../common.js';

export const journalDiagnosticSchema = z.object({ runId: bytes32Schema, status: z.string().max(64), errorCode: z.string().max(128).nullable(),
  txHash: bytes32Schema, nonce: z.number().int().min(0).nullable(), runStatus: z.number().int().min(0).max(3),
  chainNonce: z.number().int().min(0), receipt: z.object({ status: z.enum(['success', 'reverted']), canonical: z.boolean() }).nullable() }).strict();
export type JournalDiagnostic = z.infer<typeof journalDiagnosticSchema>;
export type DiagnosticKind = 'settlement_rejected' | 'settlement_mined' | 'settlement_state_mismatch' | 'noncanonical_receipt'
  | 'external_refund_unresolved_nonce' | 'unresolved_transaction_nonce' | 'nonce_consumed_receipt_unknown' | 'legacy_nonce_unknown';

/** Classification is intentionally read-only: a refund never grants permission to reuse an unresolved nonce. */
export function classifyJournal(raw: JournalDiagnostic): { kind: DiagnosticKind; nonceResolved: boolean; action: string } {
  const item = journalDiagnosticSchema.parse(raw);
  const nonceResolved = item.nonce !== null && item.nonce < item.chainNonce;
  if (item.receipt && !item.receipt.canonical) return { kind: 'noncanonical_receipt', nonceResolved,
    action: 'Check canonical history and stored bytes; do not create a replacement transaction.' };
  if (item.receipt?.status === 'reverted') return { kind: 'settlement_rejected', nonceResolved,
    action: 'Review the failed settlement and contract state. Do not reprice or silently retry.' };
  if (item.receipt?.status === 'success') return { kind: item.runStatus === 2 ? 'settlement_mined' : 'settlement_state_mismatch', nonceResolved,
    action: item.runStatus === 2 ? 'Compare the anchored receipt with the stored settlement.' : 'Review receipt events and escrow state before reconciliation.' };
  if (item.nonce === null) return { kind: 'legacy_nonce_unknown', nonceResolved: false,
    action: 'Recover the nonce from the exact stored transaction bytes before reviewing signer availability.' };
  if (nonceResolved) return { kind: 'nonce_consumed_receipt_unknown', nonceResolved: true,
    action: 'Find the canonical transaction using this signer nonce; consumption alone does not prove our settlement succeeded.' };
  if (item.runStatus === 3) return { kind: 'external_refund_unresolved_nonce', nonceResolved: false,
    action: 'The run is refunded but the signed transaction nonce is unresolved. Preserve the journal and block new signer transactions.' };
  return { kind: 'unresolved_transaction_nonce', nonceResolved: false,
    action: 'Preserve the exact stored transaction. Investigate RPC and canonical history before any operator action.' };
}
