import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { addressSchema, bytes32Schema, moneySchema, Problem, quoteSchema, sameAddress } from '../common.js';
import { jobs, type Database } from '../store.js';
import { signedReceiptSchema } from '../service.js';
import { MAX_HOUR_RECEIPTS, RECEIPT_TREE_ALGORITHM, receiptHourSchema, receiptLeaf, receiptTree } from './merkle.js';
import { receiptHourBatches, receiptHourEntries, receiptHourLock, receiptHourMigrationSQL } from './schema.js';
import { receiptOwner, verifySignedReceipt, type ReceiptProof, type ReceiptVerificationPins } from './verifier.js';

const MAX_RECEIPT_BYTES = 196_608;
const MAX_BATCH_RECEIPT_BYTES = 16_777_216;
const publicationAbi = parseAbi(['function postRoot(uint64 hour,bytes32 root,uint32 count)']);
export type ReceiptBatch = { hour: number; root: Hex; leafCount: number; algorithm: typeof RECEIPT_TREE_ALGORITHM;
  cutoff: string; sealedAt: string };
function publicBatch(row: typeof receiptHourBatches.$inferSelect): ReceiptBatch {
  if (row.algorithm !== RECEIPT_TREE_ALGORITHM || !Number.isSafeInteger(row.leafCount) || row.leafCount < 0 || row.leafCount > MAX_HOUR_RECEIPTS) {
    throw new Problem(503, 'receipt_batch_corrupt', 'Receipt batch metadata is inconsistent.');
  }
  return { hour: receiptHourSchema.parse(row.hour), root: bytes32Schema.parse(row.root), leafCount: row.leafCount,
    algorithm: RECEIPT_TREE_ALGORITHM, cutoff: row.cutoff.toISOString(), sealedAt: row.sealedAt.toISOString() };
}

/** Immutable publication-hour batches. No keys, signing, broadcasting, or provider calls. */
export class HourReceiptService {
  readonly pins: Readonly<ReceiptVerificationPins>;
  readonly maxLeaves: number;
  constructor(private readonly db: Database, pins: ReceiptVerificationPins,
    private readonly clock: () => number = Date.now, maxLeaves = 256) {
    if (!Number.isSafeInteger(pins.chainId) || pins.chainId <= 0) throw new Error('Invalid reviewed receipt chain');
    this.pins = Object.freeze({ chainId: pins.chainId, escrowAddress: addressSchema.parse(pins.escrowAddress),
      tokenAddress: addressSchema.parse(pins.tokenAddress), receiptSigner: addressSchema.parse(pins.receiptSigner),
      ...(pins.receiptRootAddress === undefined ? {} : { receiptRootAddress: addressSchema.parse(pins.receiptRootAddress) }) });
    if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 1 || maxLeaves > MAX_HOUR_RECEIPTS) throw new Error('Invalid hourly receipt limit');
    this.maxLeaves = maxLeaves;
  }
  async initialize(): Promise<void> {
    await this.db.transaction(async tx => {
      for (const statement of receiptHourMigrationSQL.split(';').map(item => item.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
    });
  }
  async seal(publicationHour = Math.floor(this.clock() / 3_600_000) - 1): Promise<ReceiptBatch> {
    const hour = receiptHourSchema.parse(publicationHour), now = this.clock();
    if (!Number.isFinite(now) || hour >= Math.floor(now / 3_600_000)) throw new Problem(409, 'receipt_hour_open', 'Only a closed UTC hour can be sealed.');
    const cutoff = new Date((hour + 1) * 3_600_000), sealedAt = new Date(now);
    return this.db.transaction(async tx => {
      // The row lock serializes separate service instances and survives process restarts.
      const lock = await tx.select().from(receiptHourLock).where(eq(receiptHourLock.id, 1)).for('update');
      if (lock.length !== 1) throw new Error('Hourly receipt service was not initialized');
      const [existing] = await tx.select().from(receiptHourBatches).where(eq(receiptHourBatches.hour, hour)).limit(1);
      if (existing) return publicBatch(existing);
      const [latest] = await tx.select({ hour: receiptHourBatches.hour }).from(receiptHourBatches)
        .orderBy(desc(receiptHourBatches.hour)).limit(1);
      if (latest && hour <= latest.hour) throw new Problem(409, 'receipt_hour_out_of_order', 'Seal a later publication hour; old roots cannot be rewritten.');
      const candidates = await tx.select({ id: jobs.id, owner: jobs.owner, quote: jobs.quote, ceiling: jobs.ceiling,
        receipt: jobs.receipt, charged: jobs.charged, refund: jobs.refund, billableSeconds: jobs.billableSeconds,
        settlementTxHash: jobs.settlementTxHash }).from(jobs).leftJoin(receiptHourEntries, eq(receiptHourEntries.runId, jobs.id))
        .where(and(inArray(jobs.status, ['completed', 'failed', 'cancelled', 'timed_out']), isNotNull(jobs.receipt),
          isNotNull(jobs.settlementTxHash), lt(jobs.updatedAt, cutoff), isNull(receiptHourEntries.runId)))
        .orderBy(asc(jobs.updatedAt), asc(jobs.id)).limit(this.maxLeaves);
      const entries: (typeof receiptHourEntries.$inferInsert)[] = []; let totalBytes = 0;
      for (const candidate of candidates) {
        const quote = quoteSchema.parse(candidate.quote);
        const receipt = signedReceiptSchema.parse(candidate.receipt);
        const receiptBytes = Buffer.byteLength(JSON.stringify(receipt), 'utf8');
        if (receiptBytes > MAX_RECEIPT_BYTES) throw new Problem(503, 'receipt_batch_invalid', 'A finalized receipt exceeds the supported byte limit.');
        if (totalBytes + receiptBytes > MAX_BATCH_RECEIPT_BYTES) break;
        const verified = await verifySignedReceipt(receipt, this.pins), body = receipt.body;
        const owner = addressSchema.parse(candidate.owner).toLowerCase();
        if (!verified.valid || !sameAddress(receiptOwner(receipt), addressSchema.parse(owner))
          || receipt.settlement.runId !== bytes32Schema.parse(candidate.id) || quote.runId !== candidate.id || body.leashId !== quote.leashId
          || body.workloadHash !== quote.workloadHash || !sameAddress(quote.payer, addressSchema.parse(owner))
          || receipt.settlement.billableSeconds !== candidate.billableSeconds.toString()
          || candidate.charged === null || candidate.refund === null || !body.billing || typeof body.billing !== 'object'
          || (body.billing as Record<string, unknown>).ceiling !== moneySchema.parse(candidate.ceiling)
          || (body.billing as Record<string, unknown>).charged !== moneySchema.parse(candidate.charged)
          || (body.billing as Record<string, unknown>).refund !== moneySchema.parse(candidate.refund)) {
          throw new Problem(503, 'receipt_batch_invalid', 'A finalized receipt does not match its durable run.');
        }
        bytes32Schema.parse(candidate.settlementTxHash);
        const cpu = body.cpu as Record<string, unknown>;
        if (cpu.pricePerSecond !== quote.pricePerSecond || BigInt(receipt.settlement.billableSeconds) > BigInt(quote.maxSeconds)
          || BigInt(candidate.ceiling) !== BigInt(quote.maxSeconds) * BigInt(quote.pricePerSecond) + BigInt(quote.inferencePrice)
          || (receipt.settlement.inferenceCharge !== '0' && receipt.settlement.inferenceCharge !== quote.inferencePrice)) {
          throw new Problem(503, 'receipt_batch_invalid', 'A finalized receipt differs from its quoted prices.');
        }
        entries.push({ runId: candidate.id, hour, owner, receiptHash: receipt.receiptHash,
          leaf: receiptLeaf(receipt.receiptHash), position: entries.length, receipt }); totalBytes += receiptBytes;
      }
      const tree = receiptTree(entries.map(entry => bytes32Schema.parse(entry.leaf)));
      const [batch] = await tx.insert(receiptHourBatches).values({ hour, root: tree.root, leafCount: entries.length,
        algorithm: RECEIPT_TREE_ALGORITHM, cutoff, sealedAt }).returning();
      if (!batch) throw new Error('Hourly receipt batch was not stored');
      // Bounded inserts also avoid PostgreSQL's parameter limit for the maximum tree size.
      for (let offset = 0; offset < entries.length; offset += 100) await tx.insert(receiptHourEntries).values(entries.slice(offset, offset + 100));
      return publicBatch(batch);
    });
  }
  async batch(hour: number): Promise<ReceiptBatch | undefined> {
    const [row] = await this.db.select().from(receiptHourBatches).where(eq(receiptHourBatches.hour, receiptHourSchema.parse(hour))).limit(1);
    return row ? publicBatch(row) : undefined;
  }
  async preparePublication(hour: number): Promise<{ batch: ReceiptBatch; transaction: { to: Address; data: Hex; value: '0x0' } } | null> {
    const batch = await this.batch(hour); if (!batch || batch.leafCount === 0) return null;
    if (!this.pins.receiptRootAddress) throw new Problem(503, 'receipt_root_unconfigured', 'Review and configure the receipt root contract before publishing.');
    return { batch, transaction: { to: this.pins.receiptRootAddress,
      data: encodeFunctionData({ abi: publicationAbi, functionName: 'postRoot', args: [BigInt(batch.hour), batch.root, batch.leafCount] }), value: '0x0' } };
  }
  async list(authenticatedOwner: string, cursor?: Hex): Promise<{ receipts: { runId: string; receiptHash: string; hour: number }[]; nextCursor: Hex | null }> {
    const owner = addressSchema.parse(authenticatedOwner).toLowerCase();
    const rows = await this.db.select({ runId: receiptHourEntries.runId, receiptHash: receiptHourEntries.receiptHash, hour: receiptHourEntries.hour })
      .from(receiptHourEntries).where(and(eq(receiptHourEntries.owner, owner),
        ...(cursor === undefined ? [] : [gt(receiptHourEntries.runId, bytes32Schema.parse(cursor))])))
      .orderBy(asc(receiptHourEntries.runId)).limit(101);
    const receipts = rows.slice(0, 100);
    return { receipts, nextCursor: rows.length > 100 ? bytes32Schema.parse(receipts.at(-1)?.runId) : null };
  }
  async proof(authenticatedOwner: string, runId: Hex): Promise<ReceiptProof> {
    const owner = addressSchema.parse(authenticatedOwner).toLowerCase();
    const [entry] = await this.db.select().from(receiptHourEntries).where(and(eq(receiptHourEntries.owner, owner),
      eq(receiptHourEntries.runId, bytes32Schema.parse(runId)))).limit(1);
    if (!entry) throw new Problem(404, 'receipt_proof_not_found', 'Published receipt proof not found.');
    const batch = await this.batch(entry.hour);
    const leaves = await this.db.select({ leaf: receiptHourEntries.leaf, position: receiptHourEntries.position }).from(receiptHourEntries)
      .where(eq(receiptHourEntries.hour, entry.hour)).orderBy(asc(receiptHourEntries.position)).limit(MAX_HOUR_RECEIPTS + 1);
    if (!batch || batch.leafCount !== leaves.length || leaves.some((leaf, position) => leaf.position !== position)) throw new Problem(503, 'receipt_batch_corrupt', 'Receipt batch metadata is inconsistent.');
    const tree = receiptTree(leaves.map(leaf => bytes32Schema.parse(leaf.leaf)));
    if (tree.root !== batch.root || entry.leaf !== receiptLeaf(entry.receiptHash as Hex)
      || entry.receipt.receiptHash !== entry.receiptHash || entry.receipt.settlement.runId !== entry.runId
      || receiptOwner(entry.receipt).toLowerCase() !== owner || !(await verifySignedReceipt(entry.receipt, this.pins)).valid) {
      throw new Problem(503, 'receipt_batch_corrupt', 'Receipt batch no longer matches its immutable root.');
    }
    return { version: 1, algorithm: RECEIPT_TREE_ALGORITHM, hour: batch.hour, root: batch.root,
      leafCount: batch.leafCount, leaf: bytes32Schema.parse(entry.leaf), proof: tree.proof(entry.position), receipt: entry.receipt };
  }
}
