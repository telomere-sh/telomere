import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeBase58, SolanaTopUpReader } from '../src/treasury/solana-reader.js';
import { SOLANA_MAINNET_GENESIS, SOLANA_TOKEN_PROGRAM, SOLANA_USDC_MINT, sourceCreditNonce } from '../src/treasury/types.js';
import { fixtureSolanaAta, fixtureSolanaRecipient, SolanaTopUpRpcFixture } from './fixtures/treasury-topups.js';

describe('strict finalized Solana USDC source observations (local RPC fixtures)', () => {
  let fixture: SolanaTopUpRpcFixture;
  const invoice = { reference: encodeBase58(Buffer.alloc(32, 51)), amountMicros: '123456', createdAt: 1_800_000_000, expiresAt: 1_800_000_900 };
  const reader = () => new SolanaTopUpReader({ rpcUrl: fixture.endpoint, genesisHash: SOLANA_MAINNET_GENESIS,
    mint: SOLANA_USDC_MINT, tokenProgram: SOLANA_TOKEN_PROGRAM, recipient: fixtureSolanaRecipient, recipientAta: fixtureSolanaAta });
  beforeEach(async () => { fixture = new SolanaTopUpRpcFixture(); await fixture.start(); });
  afterEach(async () => { await fixture.close(); });
  it('checks treasury readiness before accepting a finalized exact transfer and scopes replay to the transfer itself', async () => {
    const signature = fixture.add(invoice), client = reader(); await client.check();
    const proof = await client.verify(signature, invoice);
    expect(proof).toMatchObject({ signature, amountMicros: invoice.amountMicros, reference: invoice.reference, slot: 100, instructionIndex: 0,
      mint: SOLANA_USDC_MINT, recipient: fixtureSolanaRecipient, recipientAta: fixtureSolanaAta });
    expect(sourceCreditNonce(proof)).toBe(sourceCreditNonce({ ...proof, reference: encodeBase58(Buffer.alloc(32, 52)) }));
    expect(fixture.requests.every(method => ['getGenesisHash', 'getAccountInfo', 'getTransaction', 'getSignatureStatuses', 'getBlock'].includes(method))).toBe(true);
    expect(fixture.requests).not.toContain('sendTransaction');
  });
  it('rejects the wrong cluster or absent existing treasury ATA before issuing payment instructions', async () => {
    fixture.genesisHash = encodeBase58(Buffer.alloc(32, 9)); await expect(reader().check()).rejects.toThrow('cluster differs');
    fixture.genesisHash = SOLANA_MAINNET_GENESIS; fixture.treasuryAccountAvailable = false;
    await expect(reader().check()).rejects.toThrow();
  });
  it('does not credit a merely confirmed source, a late transfer, or changed reference', async () => {
    const signature = fixture.add(invoice), client = reader(); fixture.finalized = false;
    await expect(client.verify(signature, invoice)).rejects.toThrow(); fixture.finalized = true;
    await expect(client.verify(signature, { ...invoice, expiresAt: invoice.createdAt - 1 })).rejects.toThrow('payment window differs');
    await expect(client.verify(signature, { ...invoice, reference: encodeBase58(Buffer.alloc(32, 52)) })).rejects.toThrow('reference binding differs');
  });
  it('rejects writable references, another mint, multiple references, mismatched amounts and unrelated treasury deltas', async () => {
    const mutations: ((transaction: ReturnType<typeof fixture.transactions.get> & {}) => void)[] = [
      transaction => { transaction.transaction.message.header.numReadonlyUnsignedAccounts = 0; },
      transaction => { transaction.transaction.message.accountKeys[3] = encodeBase58(Buffer.alloc(32, 7)); },
      transaction => { transaction.transaction.message.instructions[0]!.accounts.push(5); },
      transaction => { const data = Buffer.alloc(10); data[0] = 12; data[9] = 6; data.writeBigUInt64LE(1n, 1); transaction.transaction.message.instructions[0]!.data = encodeBase58(data); },
      transaction => { transaction.meta.postTokenBalances[0]!.uiTokenAmount.amount = '123457'; },
    ];
    for (const mutation of mutations) {
      const signature = fixture.add(invoice), transaction = fixture.transactions.get(signature); if (!transaction) throw new Error('Missing RPC fixture');
      mutation(transaction); await expect(reader().verify(signature, invoice)).rejects.toThrow();
    }
  });
});
