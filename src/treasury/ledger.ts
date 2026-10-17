import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { keccak256, type Hex } from 'viem';
import { bytes32Schema, moneySchema, Problem } from '../common.js';
import { readPrivateBounded } from '../operator/backup.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { sourceCreditNonce, topUpRecordSchema } from './types.js';

const journalSchema = z.object({ version: z.literal(1), policyHash: bytes32Schema,
  inventoryCeilingMicros: moneySchema,
  records: z.array(topUpRecordSchema).max(128) }).strict().superRefine((journal, context) => {
  const ids = new Set<string>(), clients = new Set<string>(), sources = new Set<string>(), references = new Set<string>();
  for (const record of journal.records) {
    const client = record.owner.toLowerCase() + ':' + record.clientId;
    const source = record.source ? sourceCreditNonce(record.source) : undefined;
    if (ids.has(record.id) || clients.has(client) || references.has(record.reference) || source && sources.has(source)
      || !!record.authorization !== !!record.source || record.signature && !record.authorization
      || record.source && (record.source.reference !== record.reference || record.source.amountMicros !== record.amountMicros
        || record.authorization?.nonce !== sourceCreditNonce(record.source) || record.authorization.to !== record.vault || record.authorization.value !== record.amountMicros)
      || !!record.rawTransaction !== !!record.transactionHash || !!record.rawTransaction !== (record.relayerNonce !== null)
      || record.rawTransaction && keccak256(record.rawTransaction as Hex) !== record.transactionHash
      || record.rawTransaction && !record.signature || record.state === 'credited' && (!record.transactionHash || !record.creditedBlockHash || record.creditedBlockNumber === null)) {
      context.addIssue({ code: 'custom', message: 'Top-up journal identity or transition differs' }); return;
    }
    ids.add(record.id); clients.add(client); references.add(record.reference); if (source) sources.add(source);
  }
});
export type TopUpJournal = z.infer<typeof journalSchema>;
const maximum = 1_048_576;
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Private local durable budget. Crash-held writer locks require operator recovery;
 * deleting or rolling back this complete journal is not supported recovery. */
export class FileTopUpLedger {
  readonly path: string;
  constructor(path: string, readonly policyHash: `0x${string}`) {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Top-up journal requires an absolute path');
    this.path = resolve(path);
  }
  private async guard(): Promise<void> {
    let current = dirname(this.path);
    const leaf = await lstat(current);
    if (!leaf.isDirectory() || leaf.isSymbolicLink() || process.platform !== 'win32' && (leaf.mode & 0o077) !== 0) throw new Error('Private top-up journal directory required');
    for (;;) { const value = await lstat(current); if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('Top-up journal ancestor changed');
      const parent = dirname(current); if (parent === current) break; current = parent; }
  }
  async initialize(inventoryCeilingMicros: string): Promise<void> {
    moneySchema.parse(inventoryCeilingMicros);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await this.guard();
    let exists = false;
    try { await lstat(this.path); exists = true; } catch (error) { if (!missing(error)) throw error; }
    if (exists) { await this.read(); return; }
    if (BigInt(inventoryCeilingMicros) === 0n) throw new Problem(409, 'topup_inventory_unfunded', 'Fund the reviewed Base treasury before creating its finite policy journal.');
    const marker = this.path + '.initialized';
    // A retained creation marker prevents a missing journal from silently
    // resetting this policy's original finite issuance budget.
    const markerFile = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await markerFile.writeFile(this.policyHash); await markerFile.sync(); } finally { await markerFile.close(); }
    const file = await open(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(JSON.stringify({ version: 1, policyHash: this.policyHash, inventoryCeilingMicros, records: [] })); await file.sync(); }
    finally { await file.close(); }
    await this.syncDirectory();
  }
  async read(): Promise<TopUpJournal> {
    await this.guard();
    const journal = journalSchema.parse(incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateBounded(this.path, 1, maximum))));
    if (journal.policyHash !== this.policyHash) throw new Error('Top-up journal belongs to another reviewed policy');
    const marker = await readPrivateBounded(this.path + '.initialized', 66, 66);
    if (marker.toString() !== this.policyHash) throw new Error('Top-up journal initialization marker differs');
    return journal;
  }
  async transact<T>(change: (journal: TopUpJournal) => Promise<T> | T): Promise<T> {
    await this.guard(); const lockPath = this.path + '.lock'; let lock;
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Problem(409, 'topup_journal_locked', 'The top-up journal has an unresolved writer.');
      throw error;
    }
    try {
      await lock.writeFile(String(process.pid)); await lock.sync();
      const journal = await this.read(), result = await change(journal);
      const bytes = Buffer.from(JSON.stringify(journalSchema.parse(journal)));
      if (bytes.length > maximum) throw new Error('Top-up journal exceeds its private storage bound');
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await this.guard(); await rename(temporary, this.path); await this.syncDirectory(); }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
      return result;
    } finally { await lock.close(); await unlink(lockPath); }
  }
  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return;
    const directory = await open(dirname(this.path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
