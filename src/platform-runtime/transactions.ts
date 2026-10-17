import { and, eq } from 'drizzle-orm';
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Account, type Address, type Chain,
  type Hex, type PublicClient, type TransactionReceipt, type TransactionSerialized, type Transport, type WalletClient } from 'viem';
import type { Database } from '../store.js';
import { Problem, bytes32Schema } from '../common.js';
import { platformSignerLock, platformTransactionJournal } from './schema.js';

/** A dedicated signer and one durable nonce lane for root publication and settlement. */
export class PlatformTransactions {
  constructor(private readonly db: Database, private readonly rpc: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>, private readonly chainId: number) {}
  async submit(key: string, to: Address, data: Hex): Promise<TransactionReceipt> {
    if (!/^[a-zA-Z0-9:_-]{1,180}$/.test(key) || !/^0x(?:[a-fA-F0-9]{2})*$/.test(data)) throw new Error('Invalid platform transaction intent');
    if (await this.rpc.getChainId() !== this.chainId) throw new Error('Platform transaction chain changed');
    const sender = this.wallet.account.address.toLowerCase(), destination = getAddress(to).toLowerCase();
    const journal = await this.db.transaction(async tx => {
      await tx.select().from(platformSignerLock).where(eq(platformSignerLock.id, 1)).for('update');
      const [existing] = await tx.select().from(platformTransactionJournal).where(eq(platformTransactionJournal.key, key));
      if (existing) return existing;
      const previous = await tx.select().from(platformTransactionJournal)
        .where(and(eq(platformTransactionJournal.sender, sender), eq(platformTransactionJournal.chainId, this.chainId))).limit(4097);
      if (previous.length >= 4096) throw new Error('Platform signer journal requires archival review');
      const [confirmed, pending] = await Promise.all([
        this.rpc.getTransactionCount({ address: this.wallet.account.address, blockTag: 'latest' }),
        this.rpc.getTransactionCount({ address: this.wallet.account.address, blockTag: 'pending' }),
      ]);
      if (pending !== confirmed || previous.some(row => row.nonce >= confirmed)) {
        throw new Problem(409, 'platform_nonce_pending', 'The platform signer has an unresolved transaction.');
      }
      const request = await this.wallet.prepareTransactionRequest({ to, data, value: 0n, nonce: confirmed });
      const raw = await this.wallet.signTransaction({ ...request,
        ...(request.gas ? { gas: request.gas * 13n / 10n + 10_000n } : {}) });
      const value = { key, chainId: this.chainId, sender, to: destination, data: data.toLowerCase(), raw, hash: keccak256(raw), nonce: confirmed };
      await tx.insert(platformTransactionJournal).values(value);
      return value;
    });
    const hash = bytes32Schema.parse(journal.hash);
    if (journal.chainId !== this.chainId || journal.sender !== sender || journal.to !== destination
      || journal.data !== data.toLowerCase() || keccak256(journal.raw as Hex) !== hash) throw new Error('Platform journal intent mismatch');
    // REASON: persisted transaction bytes are locally signed; independently verify every effect before retry.
    const raw = journal.raw as TransactionSerialized, parsed = parseTransaction(raw);
    if (parsed.chainId !== this.chainId || parsed.nonce !== journal.nonce || parsed.to?.toLowerCase() !== destination
      || parsed.data?.toLowerCase() !== data.toLowerCase() || (parsed.value ?? 0n) !== 0n
      || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== sender) throw new Error('Platform signed journal is corrupted');
    const known = await this.rpc.getTransactionReceipt({ hash }).catch(() => undefined);
    if (known) return this.confirm(known, hash, to);
    const nonce = await this.rpc.getTransactionCount({ address: this.wallet.account.address, blockTag: 'latest' });
    if (nonce > journal.nonce) throw new Problem(409, 'platform_nonce_consumed', 'The original transaction requires canonical reconciliation.');
    try { await this.rpc.sendRawTransaction({ serializedTransaction: raw }); }
    catch { /* Ambiguous or duplicate sends are resolved only through the persisted deterministic hash. */ }
    const receipt = await this.rpc.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 15_000 });
    return this.confirm(receipt, hash, to);
  }
  private async confirm(receipt: TransactionReceipt, hash: Hex, to: Address): Promise<TransactionReceipt> {
    if (receipt.transactionHash !== hash || receipt.to?.toLowerCase() !== to.toLowerCase()
      || (await this.rpc.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Platform transaction is not canonical');
    if (receipt.status !== 'success') throw new Problem(409, 'platform_transaction_reverted', 'The persisted platform transaction reverted.');
    return receipt;
  }
}
