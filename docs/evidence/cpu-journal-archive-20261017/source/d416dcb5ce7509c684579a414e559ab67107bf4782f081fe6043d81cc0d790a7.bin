import { and, asc, desc, eq, gt, inArray, isNull, sql, getTableColumns } from 'drizzle-orm';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, verifyTypedData,
  type Hex, type TransactionSerialized } from 'viem';
import { z } from 'zod';
import type { ChainBridge } from '../bridge.js';
import { addressSchema, bytes32Schema, hashJson, signatureSchema } from '../common.js';
import { jobs, transactions, journalArchiveBatches, type Database } from '../store.js';
import { escrowAbi } from './abi.js';

export type JournalDatabase = Pick<Database, 'select' | 'execute' | 'insert' | 'update'>;
export const archiveZero: Hex = `0x${'00'.repeat(32)}`;
export const archiveCheckpointSchema = z.object({
  version: z.literal(1), sequence: z.number().int().positive().max(2_147_483_647),
  chainId: z.number().int().positive(), escrow: addressSchema, token: addressSchema, signer: addressSchema,
  previousId: bytes32Schema, rowsHash: bytes32Schema, rowCount: z.number().int().min(1).max(256),
  totalRows: z.number().int().positive().safe(), nonceFloor: z.number().int().min(0).max(2_147_483_647),
  anchorNumber: z.string().regex(/^(0|[1-9]\d{0,23})$/), anchorHash: bytes32Schema,
}).strict();
export type ArchiveCheckpoint = z.infer<typeof archiveCheckpointSchema>;
export const archiveTypes = { ArchiveCheckpoint: [{ name: 'checkpointHash', type: 'bytes32' }] } as const;
export const archiveDomain = (bridge: ChainBridge) => ({ name: 'TelomereJournalArchive', version: '1',
  chainId: bridge.config.CHAIN_ID, verifyingContract: bridge.config.ESCROW_ADDRESS });
const journalColumns = { ...getTableColumns(transactions), createdEpoch: sql<string>`extract(epoch from ${transactions.createdAt})::text` };
type JournalRow = typeof transactions.$inferSelect & { createdEpoch: string };
type Head = { id: Hex; body: ArchiveCheckpoint };
const equalAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function lockSettlementJournal(db: JournalDatabase): Promise<void> {
  await db.execute(sql`UPDATE settlement_journal_lock SET id=id WHERE id=1`);
}

export async function journalEnvelope(bridge: ChainBridge, entry: Pick<JournalRow, 'raw' | 'hash' | 'nonce' | 'runId'>) {
  if (!/^0x[0-9a-fA-F]+$/.test(entry.raw) || entry.raw.length > 16_384 || entry.raw.length % 2 !== 0
    || entry.nonce === null || !Number.isSafeInteger(entry.nonce) || entry.nonce < 0) throw new Error('Prior settlement journal differs from reviewed scope');
  // REASON: the bounded hex envelope is checked by parseTransaction and sender recovery below.
  const raw = entry.raw as TransactionSerialized, transaction = parseTransaction(raw);
  const call = transaction.data ? decodeFunctionData({ abi: escrowAbi, data: transaction.data }) : undefined;
  if (keccak256(raw) !== bytes32Schema.parse(entry.hash) || transaction.chainId !== bridge.config.CHAIN_ID
    || !transaction.to || !equalAddress(transaction.to, bridge.config.ESCROW_ADDRESS)
    || (transaction.value ?? 0n) !== 0n || transaction.nonce !== entry.nonce || call?.functionName !== 'settleRun'
    || call.args[0].runId !== bytes32Schema.parse(entry.runId)
    || !equalAddress(await recoverTransactionAddress({ serializedTransaction: raw }), bridge.account.address)) {
    throw new Error('Prior settlement journal differs from reviewed scope');
  }
  return { settlement: call.args[0], signature: call.args[1] };
}

function fingerprint(root: Hex, row: JournalRow): Hex {
  return hashJson({ previous: root, runId: row.runId, raw: row.raw, hash: row.hash, nonce: row.nonce, createdEpoch: row.createdEpoch });
}

async function batchFingerprint(db: JournalDatabase, id: string) {
  let cursor: string | undefined, rowsHash = archiveZero, rowCount = 0;
  for (;;) {
    const rows = await db.select(journalColumns).from(transactions).where(and(eq(transactions.archiveBatchId, id),
      ...(cursor ? [gt(transactions.runId, cursor)] : []))).orderBy(asc(transactions.runId)).limit(128);
    for (const row of rows) { rowsHash = fingerprint(rowsHash, row); rowCount++; }
    if (rowCount > 256) throw new Error('Journal archive batch exceeds its signed bounds');
    if (rows.length < 128) return { rowsHash, rowCount };
    cursor = rows.at(-1)!.runId; await yieldLoop();
  }
}

async function checkSignedBatch(bridge: ChainBridge, row: typeof journalArchiveBatches.$inferSelect): Promise<Head> {
  const body = archiveCheckpointSchema.parse(row.body), id = bytes32Schema.parse(row.id);
  if (row.sequence !== body.sequence || hashJson(body) !== id || body.chainId !== bridge.config.CHAIN_ID
    || !equalAddress(body.escrow, bridge.config.ESCROW_ADDRESS) || !equalAddress(body.token, bridge.config.TOKEN_ADDRESS)
    || !equalAddress(body.signer, bridge.account.address) || !await verifyTypedData({ address: bridge.account.address,
      domain: archiveDomain(bridge), types: archiveTypes, primaryType: 'ArchiveCheckpoint', message: { checkpointHash: id },
      signature: signatureSchema.parse(row.signature) })) throw new Error('Journal archive checkpoint signature or scope differs');
  return { id, body };
}

// A bounded observer checks the signed head and its retained members. Startup and
// settlement verification additionally walk every previously unseen batch.
export async function observeJournalArchive(bridge: ChainBridge, db: JournalDatabase) {
  const counts = (await db.select({ total: sql<string>`count(*)::text`,
    active: sql<string>`count(*) FILTER (WHERE ${transactions.archiveBatchId} IS NULL)::text` }).from(transactions))[0]!;
  const latest = (await db.select().from(journalArchiveBatches).orderBy(desc(journalArchiveBatches.sequence)).limit(1))[0];
  const archived = BigInt(counts.total) - BigInt(counts.active);
  if (!latest) {
    if (archived !== 0n) throw new Error('Journal archive checkpoint is missing');
    return { activeRows: counts.active, archivedRows: '0', latestCheckpointVerified: true, checkpoint: null };
  }
  const head = await checkSignedBatch(bridge, latest), actual = await batchFingerprint(db, head.id);
  if (actual.rowCount !== head.body.rowCount || actual.rowsHash !== head.body.rowsHash
    || archived !== BigInt(head.body.totalRows)) throw new Error('Journal archive retained head or row count differs');
  if ((await bridge.public.getBlock({ blockNumber: BigInt(head.body.anchorNumber) })).hash !== head.body.anchorHash
    || await bridge.public.getTransactionCount({ address: bridge.account.address, blockTag: 'latest' }) < head.body.nonceFloor) {
    throw new Error('Journal archive canonical anchor or nonce differs');
  }
  return { activeRows: counts.active, archivedRows: archived.toString(), latestCheckpointVerified: true, checkpoint: head.id };
}

export class JournalArchiveVerifier {
  private readonly cache = new WeakMap<object, Head>();
  async verify(bridge: ChainBridge, db: JournalDatabase, identity: object = db): Promise<Head | undefined> {
    const latest = (await db.select().from(journalArchiveBatches).orderBy(desc(journalArchiveBatches.sequence)).limit(1))[0];
    const cached = this.cache.get(identity);
    if (!latest) {
      if (cached) throw new Error('Journal archive checkpoint disappeared');
      const orphan = (await db.select({ id: transactions.runId }).from(transactions).where(sql`${transactions.archiveBatchId} IS NOT NULL`).limit(1))[0];
      if (orphan) throw new Error('Journal archive checkpoint is missing');
      return undefined;
    }
    const head = await checkSignedBatch(bridge, latest);
    if (cached && (head.body.sequence < cached.body.sequence || head.body.sequence === cached.body.sequence && head.id !== cached.id)) {
      throw new Error('Journal archive history regressed');
    }
    let previous = cached;
    if (!cached || cached.id !== head.id) {
      let after = cached?.body.sequence ?? 0;
      if (cached) {
        const saved = (await db.select().from(journalArchiveBatches).where(eq(journalArchiveBatches.sequence, after)).limit(1))[0];
        if (!saved || saved.id !== cached.id) throw new Error('Journal archive parent disappeared');
      }
      for (;;) {
        const page = await db.select().from(journalArchiveBatches).where(gt(journalArchiveBatches.sequence, after))
          .orderBy(asc(journalArchiveBatches.sequence)).limit(32);
        for (const row of page) {
          const batch = await checkSignedBatch(bridge, row), body = batch.body;
          if (body.previousId !== (previous?.id ?? archiveZero) || body.sequence !== (previous?.body.sequence ?? 0) + 1
            || body.totalRows !== (previous?.body.totalRows ?? 0) + body.rowCount
            || body.nonceFloor < (previous?.body.nonceFloor ?? 0)
            || BigInt(body.anchorNumber) < BigInt(previous?.body.anchorNumber ?? '0')) throw new Error('Journal archive chain is discontinuous');
          const actual = await batchFingerprint(db, batch.id);
          if (actual.rowCount !== body.rowCount || actual.rowsHash !== body.rowsHash) throw new Error('Journal archive original bytes or membership differ');
          previous = batch; after = body.sequence;
        }
        if (page.length < 32) break;
        await yieldLoop();
      }
      if (previous?.id !== head.id) throw new Error('Journal archive head changed during verification');
      const count = await db.select({ count: sql<string>`count(*)::text` }).from(transactions).where(sql`${transactions.archiveBatchId} IS NOT NULL`);
      if (BigInt(count[0]!.count) !== BigInt(head.body.totalRows)) throw new Error('Journal archive retained row count differs');
      // Cache only already-persisted checkpoints; a newly created batch is checked on its next use.
      this.cache.set(identity, head);
    }
    const anchor = await bridge.public.getBlock({ blockNumber: BigInt(head.body.anchorNumber) });
    if (anchor.hash !== head.body.anchorHash) throw new Error('Journal archive finalized anchor is no longer canonical');
    if (await bridge.public.getTransactionCount({ address: bridge.account.address, blockTag: 'latest' }) < head.body.nonceFloor) {
      throw new Error('Signer nonce is behind the journal archive checkpoint');
    }
    return head;
  }
}

export async function validateActiveJournal(bridge: ChainBridge, db: JournalDatabase, currentId: Hex): Promise<number> {
  const chainNonce = await bridge.public.getTransactionCount({ address: bridge.account.address, blockTag: 'latest' });
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.select(journalColumns).from(transactions).where(and(isNull(transactions.archiveBatchId),
      sql`${transactions.runId} <> ${currentId}`, ...(cursor ? [gt(transactions.runId, cursor)] : [])))
      .orderBy(asc(transactions.runId)).limit(64);
    for (const row of rows) {
      await journalEnvelope(bridge, row);
      if (row.nonce! >= chainNonce) throw new Error('Signer has an unresolved transaction nonce');
    }
    if (rows.length < 64) return chainNonce;
    cursor = rows.at(-1)!.runId; await yieldLoop();
  }
}

const storedReceipt = z.object({ receiptHash: bytes32Schema, body: z.record(z.unknown()), signature: signatureSchema,
  signer: addressSchema, settlement: z.object({ runId: bytes32Schema, billableSeconds: z.string().regex(/^\d+$/),
    inferenceCharge: z.string().regex(/^\d+$/), receiptHash: bytes32Schema }),
  domain: z.object({ name: z.literal('TelomereRunEscrow'), version: z.literal('1'), chainId: z.number().int(), verifyingContract: addressSchema }),
});
export const archiveOptions = z.object({ batchSize: z.number().int().min(1).max(256).default(8), force: z.boolean().default(false) }).strict();

export async function archiveConfirmedJournal(bridge: ChainBridge, db: JournalDatabase, previous: Head | undefined,
  input: z.input<typeof archiveOptions> = {}) {
  const options = archiveOptions.parse(input);
  const count = await db.select({ count: sql<string>`count(*)::text` }).from(transactions).where(isNull(transactions.archiveBatchId));
  if (!options.force && BigInt(count[0]!.count) < 128n) return { archived: 0, checkpoint: previous?.id ?? null };
  const finalized = await bridge.public.getBlock({ blockTag: 'finalized' });
  if (!finalized.hash || finalized.number === null) throw new Error('A finalized block is required for journal archival');
  if (previous && finalized.number < BigInt(previous.body.anchorNumber)) throw new Error('Finalized journal anchor regressed');
  const candidates = await db.select({ journal: journalColumns, job: getTableColumns(jobs) }).from(transactions)
    .innerJoin(jobs, eq(jobs.id, transactions.runId)).where(and(isNull(transactions.archiveBatchId),
      inArray(jobs.status, ['completed', 'failed', 'cancelled', 'timed_out'])))
    .orderBy(asc(transactions.nonce), asc(transactions.runId)).limit(options.batchSize);
  const ready: JournalRow[] = [];
  const chainNonce = await bridge.public.getTransactionCount({ address: bridge.account.address, blockTag: 'latest' });
  for (const { journal, job } of candidates) {
    const decoded = await journalEnvelope(bridge, journal);
    const receipt = await bridge.public.getTransactionReceipt({ hash: bytes32Schema.parse(journal.hash) });
    if (receipt.transactionHash !== journal.hash) throw new Error('Finalized journal receipt hash differs');
    if (receipt.blockNumber > finalized.number) break;
    await bridge.verifySettlementReceipt(decoded.settlement, receipt);
    const saved = storedReceipt.parse(job.receipt), terms = decoded.settlement, chainRun = await bridge.run(terms.runId);
    const charged = chainRun.billableSeconds * chainRun.pricePerSecond + chainRun.inferenceCharge;
    if (job.settlementTxHash !== journal.hash || saved.receiptHash !== terms.receiptHash || hashJson(saved.body) !== terms.receiptHash
      || saved.settlement.runId !== terms.runId || BigInt(saved.settlement.billableSeconds) !== terms.billableSeconds
      || BigInt(saved.settlement.inferenceCharge) !== terms.inferenceCharge || saved.settlement.receiptHash !== terms.receiptHash
      || saved.signature !== decoded.signature || !equalAddress(saved.signer, bridge.account.address)
      || saved.domain.chainId !== bridge.config.CHAIN_ID || !equalAddress(saved.domain.verifyingContract, bridge.config.ESCROW_ADDRESS)
      || chainRun.billableSeconds !== terms.billableSeconds || chainRun.inferenceCharge !== terms.inferenceCharge
      || chainRun.ceiling.toString() !== job.ceiling || chainRun.pricePerSecond.toString() !== job.quote.pricePerSecond
      || !equalAddress(chainRun.payer, job.owner) || chainRun.leashId !== job.leashId || chainRun.workloadHash !== job.quote.workloadHash
      || job.charged !== charged.toString() || BigInt(job.refund ?? '-1') + charged !== chainRun.ceiling
      || journal.nonce === null || journal.nonce >= chainNonce) throw new Error('Finalized journal differs from its saved financial receipt');
    ready.push(journal);
  }
  if (!ready.length) return { archived: 0, checkpoint: previous?.id ?? null };
  ready.sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  let rowsHash = archiveZero;
  for (const row of ready) rowsHash = fingerprint(rowsHash, row);
  if ((await bridge.public.getBlock({ blockNumber: finalized.number })).hash !== finalized.hash) throw new Error('Finalized block changed during journal archival');
  const body = archiveCheckpointSchema.parse({ version: 1, sequence: (previous?.body.sequence ?? 0) + 1,
    chainId: bridge.config.CHAIN_ID, escrow: bridge.config.ESCROW_ADDRESS, token: bridge.config.TOKEN_ADDRESS,
    signer: bridge.account.address, previousId: previous?.id ?? archiveZero, rowCount: ready.length,
    totalRows: (previous?.body.totalRows ?? 0) + ready.length, rowsHash,
    nonceFloor: Math.max(previous?.body.nonceFloor ?? 0, ...ready.map(row => row.nonce! + 1)),
    anchorNumber: finalized.number.toString(), anchorHash: finalized.hash });
  const id = hashJson(body), signature = await bridge.account.signTypedData({ domain: archiveDomain(bridge), types: archiveTypes,
    primaryType: 'ArchiveCheckpoint', message: { checkpointHash: id } });
  await db.insert(journalArchiveBatches).values({ id, sequence: body.sequence, body, signature });
  const moved = await db.update(transactions).set({ archiveBatchId: id }).where(and(isNull(transactions.archiveBatchId),
    inArray(transactions.runId, ready.map(row => row.runId)))).returning({ id: transactions.runId });
  if (moved.length !== ready.length) throw new Error('Journal archive membership changed before commit');
  // No original transaction, job or receipt is deleted or rewritten.
  return { archived: ready.length, checkpoint: id };
}
