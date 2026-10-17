import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { addressSchema, bytes32Schema, canonical, hashJson, Problem, sameAddress } from '../common.js';
import type { Database } from '../store.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformSettlementSchema, typedPlatformSettlement, type PlatformSettlement } from '../platform-runtime/types.js';
import { MAX_HOUR_RECEIPTS, receiptHourSchema, receiptTree } from './merkle.js';
import { PLATFORM_RECEIPT_ALGORITHM, platformFinancialLeaf, type PlatformLeafRun } from './platform-merkle.js';
import { platformReceiptBatches as batches, platformReceiptEntries as entries, platformReceiptLock as locks, platformReceiptDdl } from './platform-schema.js';

export const platformReceiptRootAbi = parseAbi([
  'struct Root { bytes32 root; uint32 count; address signer; uint64 postedAt; }',
  'function postRoot(uint64 hour,bytes32 root,uint32 count)', 'function getRoot(uint64 hour) view returns (Root)',
  'function signerSet() view returns (address)',
  'event RootPosted(uint64 indexed hour,bytes32 indexed root,uint32 count,address indexed signer)',
]);
const signerAbi = parseAbi(['function currentSigner() view returns (address)', 'function weeklySigner(uint64 week) view returns (address)']);
const usedReceiptAbi = parseAbi(['function usedReceiptHash(bytes32 receiptHash) view returns (bool)']);
type Batch = typeof batches.$inferSelect;
type Entry = typeof entries.$inferSelect;
export type PlatformReceiptProof = { hour: number; leaf: Hex; root: Hex; proof: Hex[]; transactionHash: Hex };
export type PlatformReceiptOptions = {
  chainId: number; escrowAddress: Address; receiptRootAddress: Address; publicClient: PublicClient;
  submitTransaction(key: string, to: Address, data: Hex): Promise<TransactionReceipt>;
  canSeal?(hour: number): Promise<boolean>;
};
/** Separate financial tree. Late outcomes require reconciliation; endedAt is never rewritten. */
export class PlatformReceiptService {
  readonly scope: Hex;
  private readonly escrow: Address;
  private readonly rootAddress: Address;
  constructor(private readonly db: Database, private readonly options: PlatformReceiptOptions) {
    if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) throw new Error('Invalid platform receipt chain');
    this.escrow = addressSchema.parse(options.escrowAddress); this.rootAddress = addressSchema.parse(options.receiptRootAddress);
    this.scope = hashJson({ chainId: options.chainId, escrow: this.escrow.toLowerCase(), receiptRoot: this.rootAddress.toLowerCase() });
  }
  async initialize(): Promise<void> {
    await this.db.transaction(async tx => {
      for (const statement of platformReceiptDdl.split(';').map(value => value.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
    });
  }
  private async snapshot() {
    const rpc = this.options.publicClient;
    if (await rpc.getChainId() !== this.options.chainId) throw new Error('Platform receipt chain changed');
    const block = await rpc.getBlock();
    if (!block.hash || block.number === null) throw new Error('Platform canonical block is unavailable');
    const root = await rpc.readContract({ address: this.escrow, abi: platformEscrowAbi, functionName: 'receiptRoot', blockNumber: block.number });
    if (!sameAddress(root, this.rootAddress)) throw new Error('Platform escrow receipt-root link changed');
    return block;
  }
  private async lock(tx: Parameters<Parameters<Database['transaction']>[0]>[0]) {
    if ((await tx.select().from(locks).where(eq(locks.id, 1)).for('update')).length !== 1) throw new Error('Platform receipt schema is not initialized');
  }
  private fail(code: string, message: string): never { throw new Problem(409, code, message); }
  /** Runtime sealing guard: an outcome object alone does not prove it entered this immutable tree. */
  async hasRecorded(ownerValue: string, raw: PlatformSettlement): Promise<boolean> {
    const owner = addressSchema.parse(ownerValue).toLowerCase(), settlement = platformSettlementSchema.parse(raw);
    const [entry] = await this.db.select().from(entries).where(and(eq(entries.scope, this.scope), eq(entries.owner, owner), eq(entries.runId, settlement.runId)));
    return !!entry && canonical(entry.settlement) === canonical(settlement)
      && entry.receiptHash === settlement.receiptHash && entry.hour === Math.floor(settlement.endedAt / 3600)
      && entry.leaf === platformFinancialLeaf(this.options.chainId, this.escrow, entry.run, settlement);
  }
  async record(ownerValue: string, raw: PlatformSettlement): Promise<void> {
    const owner = addressSchema.parse(ownerValue).toLowerCase(), settlement = platformSettlementSchema.parse(raw);
    const [previous] = await this.db.select().from(entries).where(and(eq(entries.scope, this.scope), eq(entries.runId, settlement.runId)));
    if (previous) {
      if (previous.owner !== owner || canonical(previous.settlement) !== canonical(settlement)) this.fail('platform_receipt_conflict', 'The original financial outcome is immutable.');
      return;
    }
    const block = await this.snapshot(), rpc = this.options.publicClient;
    const run = await rpc.readContract({ address: this.escrow, abi: platformEscrowAbi, functionName: 'getRun', args: [settlement.runId], blockNumber: block.number });
    const leash = await rpc.readContract({ address: this.escrow, abi: platformEscrowAbi, functionName: 'getLeash', args: [run.leashId], blockNumber: block.number });
    const cutoff = [block.timestamp, run.acceptedExpiry, ...(run.stopAt ? [run.stopAt] : []), ...(leash.killed ? [leash.killedAt] : [])].reduce((a, b) => a < b ? a : b);
    if (!sameAddress(run.payer, addressSchema.parse(owner)) || run.status !== 1 || settlement.receiptHash === PLATFORM_ZERO
      || BigInt(settlement.endedAt) < run.openedAt || BigInt(settlement.endedAt) > cutoff
      || BigInt(settlement.billableSeconds) > run.maxSeconds || BigInt(settlement.billableSeconds) > BigInt(settlement.endedAt) - run.openedAt + 1n
      || (BigInt(settlement.inferenceCharge) !== 0n && BigInt(settlement.inferenceCharge) !== run.inferencePrice)
      || block.timestamp >= run.openedAt + run.maxSeconds + 21600n) this.fail('platform_receipt_invalid', 'The financial outcome does not match its active owner reservation.');
    const leafRun: PlatformLeafRun = { hostId: run.hostId, payer: run.payer, hwClass: run.hwClass, regionHash: run.regionHash, imageHash: run.imageHash, workloadHash: run.workloadHash };
    const leaf = platformFinancialLeaf(this.options.chainId, this.escrow, leafRun, settlement);
    if (leaf !== await rpc.readContract({ address: this.escrow, abi: platformEscrowAbi, functionName: 'receiptLeaf', args: [typedPlatformSettlement(settlement)], blockNumber: block.number })) {
      throw new Error('Independent financial leaf differs from the configured escrow');
    }
    const hour = receiptHourSchema.parse(Math.floor(settlement.endedAt / 3600));
    const [published, used] = await Promise.all([
      rpc.readContract({ address: this.rootAddress, abi: platformReceiptRootAbi, functionName: 'getRoot', args: [BigInt(hour)], blockNumber: block.number }),
      rpc.readContract({ address: this.escrow, abi: usedReceiptAbi, functionName: 'usedReceiptHash', args: [settlement.receiptHash], blockNumber: block.number }),
    ]);
    if (published.root !== PLATFORM_ZERO) this.fail('platform_receipt_late', 'This financial hour is already published; reconcile or refund the original reservation.');
    if (used) this.fail('platform_receipt_replay', 'This receipt hash was already consumed by the escrow.');
    await this.db.transaction(async tx => {
      await this.lock(tx);
      const [prior] = await tx.select().from(entries).where(and(eq(entries.scope, this.scope), eq(entries.runId, settlement.runId)));
      if (prior) {
        if (prior.owner !== owner || canonical(prior.settlement) !== canonical(settlement)) this.fail('platform_receipt_conflict', 'The original financial outcome is immutable.');
        return;
      }
      if ((await tx.select().from(batches).where(and(eq(batches.scope, this.scope), eq(batches.hour, hour)))).length) {
        this.fail('platform_receipt_late', 'This financial hour is already sealed; reconcile or refund the original reservation.');
      }
      const candidates = await tx.select({ id: entries.runId, hash: entries.receiptHash }).from(entries)
        .where(and(eq(entries.scope, this.scope), eq(entries.hour, hour))).limit(MAX_HOUR_RECEIPTS + 1);
      if (candidates.length >= MAX_HOUR_RECEIPTS) this.fail('platform_receipt_hour_full', 'The immutable hour reached its financial receipt limit.');
      if ((await tx.select({ id: entries.runId }).from(entries).where(and(eq(entries.scope, this.scope), eq(entries.receiptHash, settlement.receiptHash))).limit(1)).length) {
        this.fail('platform_receipt_replay', 'This receipt hash already belongs to another run.');
      }
      await tx.insert(entries).values({ scope: this.scope, runId: settlement.runId, owner, hour, receiptHash: settlement.receiptHash, settlement, run: leafRun, leaf });
    });
  }
  private checkedTree(batch: Batch, rows: Entry[]) {
    if (batch.algorithm !== PLATFORM_RECEIPT_ALGORITHM || rows.length !== batch.count || !rows.length || rows.length > MAX_HOUR_RECEIPTS) throw new Error('Financial batch metadata is corrupted');
    const leaves = rows.map((row, position) => {
      if (row.position !== position || row.scope !== this.scope || row.hour !== batch.hour || row.runId !== row.settlement.runId
        || row.receiptHash !== row.settlement.receiptHash || Math.floor(row.settlement.endedAt / 3600) !== row.hour
        || !sameAddress(row.owner, addressSchema.parse(row.run.payer))) throw new Error('Financial batch entry is corrupted');
      const leaf = platformFinancialLeaf(this.options.chainId, this.escrow, row.run, row.settlement);
      if (leaf !== row.leaf) throw new Error('Financial batch leaf is corrupted'); return leaf;
    });
    const tree = receiptTree(leaves);
    if (tree.root !== bytes32Schema.parse(batch.root)) throw new Error('Financial batch root is corrupted'); return tree;
  }
  async seal(hourValue: number): Promise<Batch | undefined> {
    const hour = receiptHourSchema.parse(hourValue), block = await this.snapshot();
    if (BigInt(hour + 1) * 3600n > block.timestamp) this.fail('platform_receipt_hour_open', 'Only a closed financial hour may be sealed.');
    const [alreadySealed] = await this.db.select().from(batches).where(and(eq(batches.scope, this.scope), eq(batches.hour, hour)));
    if (alreadySealed) return alreadySealed;
    // The runtime supplies this guard for every admitted reservation with an unknown outcome.
    if (this.options.canSeal && !await this.options.canSeal(hour)) return undefined;
    return this.db.transaction(async tx => {
      await this.lock(tx);
      const [prior] = await tx.select().from(batches).where(and(eq(batches.scope, this.scope), eq(batches.hour, hour)));
      if (prior) return prior;
      const rows = await tx.select().from(entries).where(and(eq(entries.scope, this.scope), eq(entries.hour, hour)))
        .orderBy(asc(entries.runId)).limit(MAX_HOUR_RECEIPTS + 1);
      if (!rows.length) return undefined;
      if (rows.length > MAX_HOUR_RECEIPTS) throw new Error('Financial hour exceeds its immutable bound');
      const tree = receiptTree(rows.map(row => bytes32Schema.parse(row.leaf)));
      const batch = { scope: this.scope, hour, root: tree.root, count: rows.length, algorithm: PLATFORM_RECEIPT_ALGORITHM };
      for (const [position, row] of rows.entries()) await tx.update(entries).set({ position }).where(and(eq(entries.scope, this.scope), eq(entries.runId, row.runId)));
      this.checkedTree({ ...batch, transactionHash: null, blockHash: null, blockNumber: null, signer: null }, rows.map((row, position) => ({ ...row, position })));
      const [stored] = await tx.insert(batches).values(batch).returning(); return stored;
    });
  }
  private async rows(hour: number) { return this.db.select().from(entries).where(and(eq(entries.scope, this.scope), eq(entries.hour, hour))).orderBy(asc(entries.position)).limit(MAX_HOUR_RECEIPTS + 1); }
  private data(batch: Batch) { return encodeFunctionData({ abi: platformReceiptRootAbi, functionName: 'postRoot', args: [BigInt(batch.hour), bytes32Schema.parse(batch.root), batch.count] }); }
  private async confirm(batch: Batch, hash: Hex): Promise<TransactionReceipt> {
    const rpc = this.options.publicClient, block = await this.snapshot();
    const receipt = await rpc.getTransactionReceipt({ hash }), transaction = await rpc.getTransaction({ hash });
    if (receipt.status !== 'success' || receipt.transactionHash !== hash || !receipt.to || !sameAddress(receipt.to, this.rootAddress)
      || !transaction.to || !sameAddress(transaction.to, this.rootAddress) || transaction.input !== this.data(batch)
      || transaction.chainId !== this.options.chainId || transaction.value !== 0n
      || (await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Financial root publication is not canonical');
    const root = await rpc.readContract({ address: this.rootAddress, abi: platformReceiptRootAbi, functionName: 'getRoot', args: [BigInt(batch.hour)], blockNumber: block.number });
    const set = await rpc.readContract({ address: this.rootAddress, abi: platformReceiptRootAbi, functionName: 'signerSet', blockNumber: block.number });
    const signer = await rpc.readContract({ address: set, abi: signerAbi, functionName: 'weeklySigner', args: [root.postedAt / 604800n], blockNumber: block.number });
    if (root.root !== batch.root || root.count !== batch.count || root.postedAt !== (await rpc.getBlock({ blockNumber: receipt.blockNumber })).timestamp
      || !sameAddress(root.signer, signer) || !sameAddress(transaction.from, root.signer) || !sameAddress(receipt.from, root.signer)) throw new Error('Financial root differs from its canonical signer commitment');
    const events = receipt.logs.flatMap(log => {
      if (!sameAddress(log.address, this.rootAddress)) return [];
      try { const decoded = decodeEventLog({ abi: platformReceiptRootAbi, data: log.data, topics: log.topics }); return decoded.eventName === 'RootPosted' ? [decoded.args] : []; }
      catch { return []; }
    });
    if (events.length !== 1 || events[0]?.hour !== BigInt(batch.hour) || events[0].root !== batch.root || events[0].count !== batch.count
      || !sameAddress(events[0].signer, root.signer) || (await rpc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Financial root publication event or canonical snapshot differs');
    return receipt;
  }
  async publish(hourValue: number): Promise<void> {
    const batch = await this.seal(hourValue); if (!batch) return;
    // A sealed batch may be replayed after a reorg. Its original bytes remain
    // immutable, but evidence availability must still precede this broadcast.
    if (this.options.canSeal && !await this.options.canSeal(batch.hour)) return;
    this.checkedTree(batch, await this.rows(batch.hour));
    let hash: Hex;
    if (!batch.transactionHash) {
      const rpc = this.options.publicClient, snapshot = await this.snapshot();
      const set = await rpc.readContract({ address: this.rootAddress, abi: platformReceiptRootAbi, functionName: 'signerSet', blockNumber: snapshot.number });
      const signer = await rpc.readContract({ address: set, abi: signerAbi, functionName: 'currentSigner', blockNumber: snapshot.number });
      if (/^0x0{40}$/i.test(signer)) this.fail('platform_receipt_signer_missing', 'This publication week has no approved receipt signer.');
    }
    const result = await this.options.submitTransaction(`platform-root:${this.scope.slice(2)}:${batch.hour}`, this.rootAddress, this.data(batch));
    hash = bytes32Schema.parse(result.transactionHash);
    if (batch.transactionHash && hash !== batch.transactionHash) throw new Error('Original financial root transaction changed');
    const receipt = await this.confirm(batch, hash);
    await this.db.update(batches).set({ transactionHash: hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), signer: receipt.from.toLowerCase() })
      .where(and(eq(batches.scope, this.scope), eq(batches.hour, batch.hour)));
  }
  async publishClosed(): Promise<void> {
    const block = await this.snapshot(), closed = Number(block.timestamp / 3600n);
    const pending = await this.db.selectDistinct({ hour: entries.hour }).from(entries).leftJoin(batches, and(eq(batches.scope, entries.scope), eq(batches.hour, entries.hour)))
      .where(and(eq(entries.scope, this.scope), lt(entries.hour, closed), isNull(batches.transactionHash))).orderBy(asc(entries.hour)).limit(32);
    for (const row of pending) await this.publish(row.hour);
  }
  async proof(ownerValue: string, runValue: string): Promise<PlatformReceiptProof | undefined> {
    const owner = addressSchema.parse(ownerValue).toLowerCase(), runId = bytes32Schema.parse(runValue);
    const [entry] = await this.db.select().from(entries).where(and(eq(entries.scope, this.scope), eq(entries.owner, owner), eq(entries.runId, runId)));
    if (!entry) return undefined;
    const [batch] = await this.db.select().from(batches).where(and(eq(batches.scope, this.scope), eq(batches.hour, entry.hour)));
    if (!batch?.transactionHash) return undefined;
    const tree = this.checkedTree(batch, await this.rows(entry.hour)), hash = bytes32Schema.parse(batch.transactionHash);
    await this.confirm(batch, hash);
    const block = await this.snapshot();
    const run = await this.options.publicClient.readContract({ address: this.escrow, abi: platformEscrowAbi, functionName: 'getRun', args: [runId], blockNumber: block.number });
    if (!sameAddress(run.payer, addressSchema.parse(owner)) || platformFinancialLeaf(this.options.chainId, this.escrow, run, entry.settlement) !== entry.leaf) throw new Error('Financial proof no longer matches its canonical reservation');
    await this.confirm(batch, hash);
    if (entry.position === null) throw new Error('Financial proof position is missing');
    return { hour: batch.hour, leaf: bytes32Schema.parse(entry.leaf), root: tree.root, proof: tree.proof(entry.position), transactionHash: hash };
  }
}
