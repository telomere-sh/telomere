import { and, eq, sql } from 'drizzle-orm';
import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { addressSchema, bytes32Schema, canonical, hashJson } from '../common.js';
import type { Database } from '../store.js';
import { PLATFORM_V2_CORE_MAX_BYTES, platformV2EvidenceCoreSchema, platformV2EvidenceDigest,
  platformV2ReceiptHash, type PlatformV2EvidenceCore } from './platform-v2.js';

export const PLATFORM_V2_MANIFEST_MAX_BYTES = 4096;
const identitySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const scopeSchema = z.object({ chainId: z.union([z.literal(31337), z.literal(8453), z.literal(84532)]),
  escrow: addressSchema, hostRegistry: addressSchema }).strict();
export type PlatformV2PublicationScope = z.input<typeof scopeSchema>;
const destinationSchema = z.object({ identity: identitySchema, failureDomain: identitySchema }).strict();
export const platformV2PublicationOpeningSchema = z.object({
  transactionHash: bytes32Schema, blockHash: bytes32Schema,
  blockNumber: z.union([z.string().regex(/^[1-9][0-9]{0,23}$/),
    z.bigint().positive().max(10n ** 24n - 1n).transform(value => value.toString())]),
  logIndex: z.number().int().min(0).max(1_000_000),
}).strict();
export type PlatformV2PublicationOpening = z.infer<typeof platformV2PublicationOpeningSchema>;
export type PlatformV2PublicationOpeningInput = z.input<typeof platformV2PublicationOpeningSchema>;
export const platformV2PublicationManifestSchema = z.object({
  protocol: z.literal('telomere-platform-evidence-publication-v2'),
  ...scopeSchema.shape, scope: bytes32Schema, runId: bytes32Schema, receiptHash: bytes32Schema,
  evidenceCoreDigest: bytes32Schema, coreBytes: z.number().int().min(1).max(PLATFORM_V2_CORE_MAX_BYTES),
  opening: platformV2PublicationOpeningSchema,
  destinations: z.tuple([destinationSchema, destinationSchema]),
}).strict();
export type PlatformV2PublicationManifest = z.infer<typeof platformV2PublicationManifestSchema>;

/** Ports are operator configured. Implementations must cap streamed reads and honour cancellation.
 * Immutable puts must refuse changed bytes for an existing key, even after an uncertain response. */
export interface PlatformV2PublicationStore {
  readonly identity: string;
  readonly failureDomain: string;
  putImmutable(key: string, bytes: Uint8Array, options: { signal: AbortSignal; maxBytes: number }): Promise<void>;
  get(key: string, options: { signal: AbortSignal; maxBytes: number }): Promise<Uint8Array | undefined>;
}
type Stores = readonly [PlatformV2PublicationStore, PlatformV2PublicationStore];
type PublicationOptions = { timeoutMs?: number };
type ReadOptions = { expectedReceiptHash?: string; signal?: AbortSignal };
type OperationGate = { inFlight: number };
const scopeDigest = (scope: z.infer<typeof scopeSchema>) => hashJson({
  protocol: 'telomere-platform-v2-publication-scope', chainId: scope.chainId,
  escrow: scope.escrow.toLowerCase(), hostRegistry: scope.hostRegistry.toLowerCase(),
});
export function platformV2PublicationKeys(scope: string, runId: string, coreDigest: string) {
  const checkedScope = bytes32Schema.parse(scope), checkedRun = bytes32Schema.parse(runId), digest = bytes32Schema.parse(coreDigest);
  return { manifest: `v2/${checkedScope}/runs/${checkedRun}/manifest.json`,
    core: `v2/${checkedScope}/${digest}/core.json` };
}
function checkedStores(stores: Stores) {
  const destinations = stores.map(store => destinationSchema.parse({ identity: store.identity, failureDomain: store.failureDomain }));
  const [first, second] = destinations;
  if (!first || !second || stores[0] === stores[1] || first.identity === second.identity
    || first.failureDomain === second.failureDomain) throw new Error('Platform v2 publication requires two distinct configured stores and domains');
  return [Object.freeze(first), Object.freeze(second)] as const;
}
function timeoutValue(options: PublicationOptions): number {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid Platform v2 publication timeout');
  return timeoutMs;
}
async function bounded<T>(gate: OperationGate, timeoutMs: number, parent: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = new AbortController(), signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
  signal.throwIfAborted();
  if (gate.inFlight >= 4) throw new Error('Platform v2 publication operation capacity is exhausted');
  gate.inFlight++;
  const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); });
  // Retain capacity until the underlying port settles, even if it ignores cancellation.
  // Both rejection paths are observed, preventing an unhandled late rejection.
  void pending.then(() => { gate.inFlight--; }, () => { gate.inFlight--; });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Platform v2 publication operation was cancelled or timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try { return await Promise.race([pending, aborted]); }
  finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
}
function encoded(value: unknown, maxBytes: number): Uint8Array {
  const bytes = Buffer.from(canonical(value), 'utf8');
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new Error('Platform v2 publication bytes exceed their bound');
  return bytes;
}
function decoded<T>(bytes: Uint8Array | undefined, schema: z.ZodType<T>, maxBytes: number): T {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error('Platform v2 publication copy is missing or exceeds its bound');
  }
  const textValue = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(textValue, 'utf8').equals(Buffer.from(bytes))) throw new Error('Platform v2 publication copy is not UTF-8');
  let value: unknown;
  try { value = JSON.parse(textValue); } catch { throw new Error('Platform v2 publication copy is not JSON'); }
  const checked = schema.parse(value);
  if (canonical(checked) !== textValue) throw new Error('Platform v2 publication copy is not canonical');
  return checked;
}
function checkedCore(scope: z.infer<typeof scopeSchema>, raw: unknown): PlatformV2EvidenceCore {
  const core = platformV2EvidenceCoreSchema.parse(raw), body = core.delegation.body;
  if (body.chainId !== scope.chainId || body.escrow.toLowerCase() !== scope.escrow.toLowerCase()
    || body.hostRegistry.toLowerCase() !== scope.hostRegistry.toLowerCase() || body.runId !== core.quote.runId) {
    throw new Error('Platform v2 publication core differs from its deployment scope');
  }
  encoded(core, PLATFORM_V2_CORE_MAX_BYTES);
  return core;
}
function checkedManifest(scope: z.infer<typeof scopeSchema>, destinations: ReturnType<typeof checkedStores>,
  raw: unknown, core?: PlatformV2EvidenceCore): PlatformV2PublicationManifest {
  const manifest = platformV2PublicationManifestSchema.parse(raw);
  if (manifest.scope !== scopeDigest(scope) || manifest.chainId !== scope.chainId
    || manifest.escrow.toLowerCase() !== scope.escrow.toLowerCase()
    || manifest.hostRegistry.toLowerCase() !== scope.hostRegistry.toLowerCase()
    || canonical(manifest.destinations) !== canonical(destinations)) {
    throw new Error('Platform v2 publication manifest differs from its deployment or destinations');
  }
  if (core && (core.quote.runId !== manifest.runId || platformV2ReceiptHash(core) !== manifest.receiptHash
    || platformV2EvidenceDigest(core) !== manifest.evidenceCoreDigest
    || encoded(core, PLATFORM_V2_CORE_MAX_BYTES).byteLength !== manifest.coreBytes)) {
    throw new Error('Platform v2 publication manifest differs from its core');
  }
  encoded(manifest, PLATFORM_V2_MANIFEST_MAX_BYTES);
  return manifest;
}

/** Exact canonical bytes, anchored before the first external write. There is no replace API. */
export const platformV2PublicationRows = pgTable('platform_v2_publication_journal', {
  scope: text().notNull(), runId: text().notNull(), coreText: text().notNull(), manifestText: text().notNull(),
  manifestDigest: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.scope, table.runId] })]);
const ddl = `CREATE TABLE IF NOT EXISTS platform_v2_publication_journal (
 scope text NOT NULL, run_id text NOT NULL, core_text text NOT NULL, manifest_text text NOT NULL, manifest_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,run_id))`;
export class PlatformV2PublicationJournal {
  readonly scope: string;
  readonly deployment: z.infer<typeof scopeSchema>;
  #initialized = false;
  constructor(private readonly db: Database, rawScope: PlatformV2PublicationScope) {
    this.deployment = Object.freeze(scopeSchema.parse(rawScope)); this.scope = scopeDigest(this.deployment);
  }
  async initialize(): Promise<void> { await this.db.execute(sql.raw(ddl)); this.#initialized = true; }
  async record(rawCore: unknown, rawOpening: PlatformV2PublicationOpeningInput, stores: Stores) {
    if (!this.#initialized) throw new Error('Platform v2 publication journal is not initialized');
    const core = checkedCore(this.deployment, rawCore), destinations = checkedStores(stores);
    const coreText = canonical(core), opening = platformV2PublicationOpeningSchema.parse(rawOpening);
    const manifest = checkedManifest(this.deployment, destinations, {
      protocol: 'telomere-platform-evidence-publication-v2', ...this.deployment, scope: this.scope,
      runId: core.quote.runId, receiptHash: platformV2ReceiptHash(core), evidenceCoreDigest: platformV2EvidenceDigest(core),
      coreBytes: Buffer.byteLength(coreText, 'utf8'), opening, destinations,
    }, core), manifestText = canonical(manifest);
    await this.db.insert(platformV2PublicationRows).values({ scope: this.scope, runId: manifest.runId,
      coreText, manifestText, manifestDigest: hashJson(manifest) }).onConflictDoNothing();
    const saved = await this.get(manifest.runId, stores);
    if (!saved || canonical(saved.core) !== coreText || canonical(saved.manifest) !== manifestText) {
      throw new Error('Platform v2 publication retry conflicts with its durable original');
    }
    return saved;
  }
  async get(rawRunId: string, stores: Stores) {
    if (!this.#initialized) throw new Error('Platform v2 publication journal is not initialized');
    const runId = bytes32Schema.parse(rawRunId), destinations = checkedStores(stores);
    const [row] = await this.db.select().from(platformV2PublicationRows).where(and(
      eq(platformV2PublicationRows.scope, this.scope), eq(platformV2PublicationRows.runId, runId))).limit(1);
    if (!row) return undefined;
    if (Buffer.byteLength(row.coreText, 'utf8') > PLATFORM_V2_CORE_MAX_BYTES
      || Buffer.byteLength(row.manifestText, 'utf8') > PLATFORM_V2_MANIFEST_MAX_BYTES) {
      throw new Error('Platform v2 publication journal exceeds its bound');
    }
    const core = checkedCore(this.deployment, decoded(Buffer.from(row.coreText), platformV2EvidenceCoreSchema, PLATFORM_V2_CORE_MAX_BYTES));
    const manifest = checkedManifest(this.deployment, destinations,
      decoded(Buffer.from(row.manifestText), platformV2PublicationManifestSchema, PLATFORM_V2_MANIFEST_MAX_BYTES), core);
    const manifestDigest = hashJson(manifest);
    if (manifest.runId !== runId || manifestDigest !== row.manifestDigest) {
      throw new Error('Platform v2 publication journal run or manifest digest changed');
    }
    return { core, manifest, manifestDigest };
  }
}

/** Public retrieval never repairs a copy or accepts a caller supplied endpoint. Canonical chain authority is checked separately. */
export class PlatformV2PublishedEvidenceReader {
  readonly scope: string;
  protected readonly deployment: z.infer<typeof scopeSchema>;
  protected readonly destinations: ReturnType<typeof checkedStores>;
  protected readonly timeoutMs: number;
  protected readonly operationGate: OperationGate = { inFlight: 0 };
  protected readonly stores: Stores;
  constructor(rawScope: PlatformV2PublicationScope, stores: Stores, options: PublicationOptions = {}) {
    this.deployment = Object.freeze(scopeSchema.parse(rawScope)); this.scope = scopeDigest(this.deployment);
    this.destinations = checkedStores(stores); this.timeoutMs = timeoutValue(options);
    this.stores = Object.freeze([stores[0], stores[1]]);
  }
  protected checkDestinations(): void {
    if (canonical(checkedStores(this.stores)) !== canonical(this.destinations)) {
      throw new Error('Platform v2 configured publication destinations changed');
    }
  }
  async retrieve(rawRunId: string, options: ReadOptions = {}) {
    this.checkDestinations();
    const runId = bytes32Schema.parse(rawRunId);
    const expectedReceiptHash = options.expectedReceiptHash === undefined ? undefined : bytes32Schema.parse(options.expectedReceiptHash);
    const manifestKey = platformV2PublicationKeys(this.scope, runId, runId).manifest;
    const results = await Promise.allSettled(this.stores.map(async store => {
      const manifest = checkedManifest(this.deployment, this.destinations, decoded(await bounded(this.operationGate, this.timeoutMs, options.signal,
        signal => store.get(manifestKey, { signal, maxBytes: PLATFORM_V2_MANIFEST_MAX_BYTES })),
      platformV2PublicationManifestSchema, PLATFORM_V2_MANIFEST_MAX_BYTES));
      if (manifest.runId !== runId || expectedReceiptHash && expectedReceiptHash !== manifest.receiptHash) {
        throw new Error('Platform v2 publication manifest run or expected receipt changed');
      }
      const keys = platformV2PublicationKeys(this.scope, runId, manifest.evidenceCoreDigest);
      const core = checkedCore(this.deployment, decoded(await bounded(this.operationGate, this.timeoutMs, options.signal,
        signal => store.get(keys.core, { signal, maxBytes: PLATFORM_V2_CORE_MAX_BYTES })), platformV2EvidenceCoreSchema, PLATFORM_V2_CORE_MAX_BYTES));
      checkedManifest(this.deployment, this.destinations, manifest, core);
      return { core, manifest };
    }));
    const [first, second] = results;
    if (!first || !second || first.status !== 'fulfilled' || second.status !== 'fulfilled') {
      throw new Error('Both configured Platform v2 publication copies must be available and valid');
    }
    if (canonical(first.value) !== canonical(second.value)) throw new Error('Platform v2 publication copies disagree');
    return { ...first.value, manifestDigest: hashJson(first.value.manifest), configuredCopiesVerified: true as const,
      independentlyPublished: false as const, storageAssurance: 'two-operator-declared-domains' as const };
  }
}

/** Disabled unless explicitly enabled. Every retry uses the journal's exact first core and manifest bytes. */
export class PlatformV2EvidencePublisher extends PlatformV2PublishedEvidenceReader {
  readonly enabled: boolean;
  constructor(private readonly journal: PlatformV2PublicationJournal, stores: Stores,
    options: PublicationOptions & { enabled?: boolean } = {}) {
    super(journal.deployment, stores, options); this.enabled = options.enabled === true;
  }
  async initialize(): Promise<void> { await this.journal.initialize(); }
  async publish(core: unknown, opening: PlatformV2PublicationOpeningInput, options: { signal?: AbortSignal } = {}) {
    if (!this.enabled) throw new Error('Platform v2 evidence publication is disabled');
    this.checkDestinations();
    options.signal?.throwIfAborted();
    const saved = await this.journal.record(core, opening, this.stores);
    const coreBytes = encoded(saved.core, PLATFORM_V2_CORE_MAX_BYTES), manifestBytes = encoded(saved.manifest, PLATFORM_V2_MANIFEST_MAX_BYTES);
    const keys = platformV2PublicationKeys(this.scope, saved.manifest.runId, saved.manifest.evidenceCoreDigest);
    const results = await Promise.allSettled(this.stores.map(async store => {
      // A manifest is visible only after its core is read back on this same destination.
      await bounded(this.operationGate, this.timeoutMs, options.signal, signal => store.putImmutable(keys.core,
        Uint8Array.from(coreBytes), { signal, maxBytes: PLATFORM_V2_CORE_MAX_BYTES }));
      const readCore = await bounded(this.operationGate, this.timeoutMs, options.signal, signal => store.get(keys.core, { signal, maxBytes: PLATFORM_V2_CORE_MAX_BYTES }));
      if (!(readCore instanceof Uint8Array) || readCore.byteLength !== coreBytes.byteLength
        || !Buffer.from(readCore).equals(Buffer.from(coreBytes))) throw new Error('Platform v2 publication core readback changed');
      await bounded(this.operationGate, this.timeoutMs, options.signal, signal => store.putImmutable(keys.manifest,
        Uint8Array.from(manifestBytes), { signal, maxBytes: PLATFORM_V2_MANIFEST_MAX_BYTES }));
      const readManifest = await bounded(this.operationGate, this.timeoutMs, options.signal, signal => store.get(keys.manifest, { signal, maxBytes: PLATFORM_V2_MANIFEST_MAX_BYTES }));
      if (!(readManifest instanceof Uint8Array) || readManifest.byteLength !== manifestBytes.byteLength
        || !Buffer.from(readManifest).equals(Buffer.from(manifestBytes))) throw new Error('Platform v2 publication manifest readback changed');
    }));
    if (results.some(result => result.status !== 'fulfilled')) throw new Error('Platform v2 publication is incomplete; retry its original bytes');
    const read = await this.retrieve(saved.manifest.runId, { expectedReceiptHash: saved.manifest.receiptHash, ...options });
    if (read.manifestDigest !== saved.manifestDigest) throw new Error('Platform v2 publication differs from its durable original');
    return read;
  }
}
