import { eq } from 'drizzle-orm';
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from 'viem';
import { z } from 'zod';
import { addressSchema } from '../common.js';
import { paymentJournal } from '../payments/schema.js';
import { platformTransactionJournal } from '../platform-runtime/schema.js';
import { transactions, type Database } from '../store.js';

const maximumRows = 4096;
const signedRaw = z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/).max(262146);

/** Disabling a module does not invalidate its retained signed transactions.
 * Keep its sender out of the independent top-up nonce journal. */
export async function retainedFinancialSigners(db: Database, chainId: number): Promise<string[]> {
  const [payments, platform, legacy] = await Promise.all([
    db.selectDistinct({ signer: paymentJournal.signer }).from(paymentJournal)
      .where(eq(paymentJournal.network, `eip155:${chainId}`)).limit(maximumRows + 1),
    db.selectDistinct({ signer: platformTransactionJournal.sender }).from(platformTransactionJournal)
      .where(eq(platformTransactionJournal.chainId, chainId)).limit(maximumRows + 1),
    db.select({ raw: transactions.raw }).from(transactions).limit(maximumRows + 1),
  ]);
  if ([payments, platform, legacy].some(rows => rows.length > maximumRows)) {
    throw new Error('Retained financial sender inventory exceeds its reviewed startup bound');
  }
  const senders = new Set([...payments, ...platform].map(row => addressSchema.parse(row.signer).toLowerCase()));
  for (const record of legacy) {
    // REASON: the stored raw bytes have a bounded complete hexadecimal boundary.
    const raw = signedRaw.parse(record.raw) as TransactionSerialized;
    const transaction = parseTransaction(raw);
    if (!transaction.chainId) throw new Error('Unprotected retained transaction requires operator reconciliation');
    if (transaction.chainId === chainId) {
      senders.add((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase());
    }
  }
  return [...senders];
}
