import { createHash } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../store.js';
import { Problem } from '../common.js';
import { cysts, cystOwners, cystQuotaV2MigrationSQL, type CystRecord } from './schema.js';
import { PrivateCystStorage, ciphertextDigest } from './storage.js';
import { cystCapabilities, cystQuotaPolicySchema, type CystQuotaPolicy } from './quota.js';
import type { CiphertextStore } from './replicated.js';
import { CYST_CAPABILITIES, cystAddressSchema, cystEnvelopeSchema, cystIdSchema, cystIdempotencySchema,
  cystHeaderSchema, cystMetadataSchema, type CystEnvelope, type CystMetadata } from './types.js';

function metadata(record: CystRecord): CystMetadata {
  return cystMetadataSchema.parse({ version: record.version, algorithm: record.algorithm,
    id: record.id, owner: record.owner, agent: record.agent, applicationSchema: record.applicationSchema,
    plaintextBytes: record.plaintextBytes, nonce: record.nonce, sha256: record.sha256,
    ciphertextBytes: record.ciphertextBytes, state: record.state, createdAt: record.createdAt.toISOString() });
}
function requestDigest(input: CystEnvelope): string {
  // Fixed-key metadata plus the ciphertext digest is enough after the actual bytes have been checked.
  const header = cystHeaderSchema.parse({ version: input.version, algorithm: input.algorithm, id: input.id,
    owner: input.owner, agent: input.agent, applicationSchema: input.applicationSchema,
    plaintextBytes: input.plaintextBytes, nonce: input.nonce });
  return createHash('sha256').update(JSON.stringify([header, input.sha256])).digest('hex');
}
export class CystService {
  readonly storage: CiphertextStore;
  private readonly quotaPolicy: CystQuotaPolicy | undefined;
  constructor(private readonly db: Database, destination: string | CiphertextStore, options: { quotaPolicy?: CystQuotaPolicy } = {}) {
    this.storage = typeof destination === 'string' ? new PrivateCystStorage(destination) : destination;
    this.quotaPolicy = options.quotaPolicy === undefined ? undefined : Object.freeze(cystQuotaPolicySchema.parse(options.quotaPolicy));
  }
  capabilities(quotaVersion: 1 | 2 = 1) { return cystCapabilities(this.quotaPolicy, quotaVersion); }
  get privateDirectory(): string {
    if (!(this.storage instanceof PrivateCystStorage)) throw new Error('This checkpoint store has no private filesystem directory');
    return this.storage.directory;
  }
  async initialize(): Promise<void> {
    if (this.quotaPolicy) await this.db.transaction(async transaction => {
      for (const statement of cystQuotaV2MigrationSQL.split(';').map(value => value.trim()).filter(Boolean)) await transaction.execute(sql.raw(statement));
    });
    await this.storage.initialize();
  }
  async upload(authenticatedOwner: string, value: unknown, idempotencyKey: string, quotaVersion: 1 | 2 = 1): Promise<{ checkpoint: CystMetadata; replayed: boolean }> {
    const capabilities = this.capabilities(quotaVersion);
    const owner = cystAddressSchema.parse(authenticatedOwner);
    const input = cystEnvelopeSchema.parse(value); const idemKey = cystIdempotencySchema.parse(idempotencyKey);
    if (input.owner !== owner) throw new Problem(403, 'cyst_owner_mismatch', 'Checkpoint owner differs from the authenticated owner.');
    const bytes = Buffer.from(input.ciphertext, 'base64');
    if (bytes.toString('base64') !== input.ciphertext || bytes.byteLength !== input.plaintextBytes + 16
      || bytes.byteLength > CYST_CAPABILITIES.maxCiphertextBytes || ciphertextDigest(bytes) !== input.sha256) {
      throw new Problem(422, 'cyst_payload_invalid', 'Check the ciphertext length and SHA-256 digest.');
    }
    const digest = requestDigest(input);
    const claimed = await this.db.transaction(async tx => {
      await tx.insert(cystOwners).values({ owner }).onConflictDoNothing();
      const [usage] = await tx.select().from(cystOwners).where(eq(cystOwners.owner, owner)).for('update');
      if (!usage) throw new Problem(503, 'cyst_storage_unavailable', 'Checkpoint metadata is unavailable.');
      const [previous] = await tx.select().from(cysts).where(and(eq(cysts.owner, owner), eq(cysts.idemKey, idemKey))).limit(1);
      if (previous) {
        if (previous.requestHash !== digest) throw new Problem(409, 'cyst_idempotency_conflict', 'Reuse this key only for the original encrypted checkpoint.');
        return { record: previous, replayed: true };
      }
      const [duplicate] = await tx.select({ id: cysts.id }).from(cysts)
        .where(and(eq(cysts.owner, owner), eq(cysts.id, input.id))).limit(1);
      const [nonce] = await tx.select({ id: cysts.id }).from(cysts)
        .where(and(eq(cysts.owner, owner), eq(cysts.nonce, input.nonce))).limit(1);
      if (duplicate || nonce) throw new Problem(409, 'cyst_conflict', 'Checkpoint identifier or nonce is already reserved.');
      if (usage.usedBytes + bytes.byteLength > capabilities.maxOwnerBytes || usage.checkpoints >= capabilities.maxOwnerCheckpoints) {
        throw new Problem(409, 'cyst_quota_exceeded', 'Checkpoint storage quota is full.');
      }
      const [record] = await tx.insert(cysts).values({ owner, id: input.id, agent: input.agent, idemKey, requestHash: digest,
        version: input.version, algorithm: input.algorithm, applicationSchema: input.applicationSchema,
        plaintextBytes: input.plaintextBytes, nonce: input.nonce, sha256: input.sha256, ciphertextBytes: bytes.byteLength }).returning();
      await tx.update(cystOwners).set({ usedBytes: usage.usedBytes + bytes.byteLength, checkpoints: usage.checkpoints + 1 })
        .where(eq(cystOwners.owner, owner));
      if (!record) throw new Problem(503, 'cyst_storage_unavailable', 'Checkpoint metadata is unavailable.');
      return { record, replayed: false };
    });
    // Reserve quota durably before file writes. Interrupted uploads remain pending and bounded;
    // the same idempotency key can finish them without a second charge against the quota.
    await this.storage.put(owner, input.sha256, bytes);
    await this.db.update(cysts).set({ state: 'ready' }).where(and(eq(cysts.owner, owner), eq(cysts.id, input.id)));
    return { checkpoint: metadata({ ...claimed.record, state: 'ready' }), replayed: claimed.replayed };
  }
  private async record(authenticatedOwner: string, id: string): Promise<CystRecord> {
    const owner = cystAddressSchema.parse(authenticatedOwner); const parsedId = cystIdSchema.parse(id);
    const [record] = await this.db.select().from(cysts).where(and(eq(cysts.owner, owner), eq(cysts.id, parsedId))).limit(1);
    if (!record) throw new Problem(404, 'cyst_not_found', 'Checkpoint not found.');
    if (record.state === 'pending' && await this.storage.read(owner, record.sha256, record.ciphertextBytes)
      && (!this.storage.isDurable || await this.storage.isDurable(owner, record.sha256, record.ciphertextBytes))) {
      await this.db.update(cysts).set({ state: 'ready' }).where(and(eq(cysts.owner, owner), eq(cysts.id, parsedId)));
      return { ...record, state: 'ready' };
    }
    return record;
  }
  async metadata(owner: string, id: string): Promise<CystMetadata> { return metadata(await this.record(owner, id)); }
  async download(owner: string, id: string): Promise<{ metadata: CystMetadata; ciphertext: string }> {
    const record = await this.record(owner, id);
    if (record.state !== 'ready') throw new Problem(409, 'cyst_pending', 'Retry the original encrypted upload to finish this checkpoint.');
    const bytes = await this.storage.read(record.owner, record.sha256, record.ciphertextBytes);
    if (!bytes) throw new Problem(503, 'cyst_storage_unavailable', 'Checkpoint ciphertext is unavailable.');
    return { metadata: metadata(record), ciphertext: Buffer.from(bytes).toString('base64') };
  }
  async list(authenticatedOwner: string, options: { agent?: string; cursor?: string; quotaVersion?: 1 | 2 } = {}) {
    const capabilities = this.capabilities(options.quotaVersion ?? 1);
    const owner = cystAddressSchema.parse(authenticatedOwner);
    const agent = options.agent === undefined ? undefined : cystAddressSchema.parse(options.agent);
    const cursor = options.cursor === undefined ? undefined : cystIdSchema.parse(options.cursor);
    const rows = await this.db.select().from(cysts).where(and(eq(cysts.owner, owner),
      agent === undefined ? undefined : eq(cysts.agent, agent), cursor === undefined ? undefined : gt(cysts.id, cursor)))
      .orderBy(asc(cysts.id)).limit(CYST_CAPABILITIES.listLimit + 1);
    const [usage] = await this.db.select().from(cystOwners).where(eq(cystOwners.owner, owner)).limit(1);
    if ((usage?.checkpoints ?? 0) > capabilities.maxOwnerCheckpoints) {
      throw new Problem(409, 'cyst_quota_profile_required', 'Select the enabled checkpoint quota profile to read the full owner usage.');
    }
    // Reconcile only this bounded owner-scoped page. A completed blob whose ready
    // update failed must become downloadable after a browser restart, when the
    // original upload envelope/idempotency key is no longer in client memory.
    // Sequential reads bound I/O; total stored ciphertext for an owner is 32 MiB.
    const checkpoints: CystMetadata[] = [];
    for (const row of rows.slice(0, CYST_CAPABILITIES.listLimit)) {
      checkpoints.push(metadata(row.state === 'pending' ? await this.record(owner, row.id) : row));
    }
    const last = checkpoints.at(-1);
    return { checkpoints, ...(rows.length > CYST_CAPABILITIES.listLimit && last ? { nextCursor: last.id } : {}),
      usage: { bytes: usage?.usedBytes ?? 0, checkpoints: usage?.checkpoints ?? 0 }, capabilities };
  }
}
