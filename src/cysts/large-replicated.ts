import { createHash, timingSafeEqual } from 'node:crypto';
import { LARGE_CYST_MAX_PART_BYTES, LargeCystError, largeCystPartBytes,
  parseLargeCystHeader, parseLargeCystManifest, type LargeCystHeader,
  type LargeCystManifest, type LargeCystStore } from './large-checkpoints.js';
import { cystIdSchema } from './types.js';

type Pair<T> = readonly [PromiseSettledResult<T>, PromiseSettledResult<T>];
const fail = (code: LargeCystError['code']) => new LargeCystError(code);
const same = (left: object, right: object) => JSON.stringify(left) === JSON.stringify(right);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function readPair<T>(stores: readonly [LargeCystStore, LargeCystStore],
  read: (store: LargeCystStore) => Promise<T>): Promise<Pair<T>> {
  return Promise.allSettled([
    Promise.resolve().then(() => read(stores[0])),
    Promise.resolve().then(() => read(stores[1])),
  ]);
}

function available<T extends object>(results: Pair<T | undefined>): T | undefined {
  const first = results[0].status === 'fulfilled' ? results[0].value : undefined;
  const second = results[1].status === 'fulfilled' ? results[1].value : undefined;
  if (first && second && !same(first, second)) throw fail('conflict');
  if (first || second) return first ?? second;
  if (results.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
  return undefined;
}

function validPart(bytes: Buffer | undefined, part: LargeCystManifest['parts'][number]): boolean {
  return Boolean(bytes && bytes.length === part.bytes && sha256(bytes) === part.sha256);
}

async function readHeader(store: LargeCystStore, id: string, signal?: AbortSignal): Promise<LargeCystHeader | undefined> {
  const value = await store.header(id, signal);
  if (!value) return undefined;
  const header = parseLargeCystHeader(value);
  if (header.id !== id) throw fail('integrity_failed');
  return header;
}

async function readManifest(store: LargeCystStore, id: string, signal?: AbortSignal): Promise<LargeCystManifest | undefined> {
  const value = await store.manifest(id, signal);
  if (!value) return undefined;
  const manifest = parseLargeCystManifest(value);
  if (manifest.header.id !== id) throw fail('integrity_failed');
  return manifest;
}

/** Replicates the large-Cyst protocol across two independently provisioned stores.
 * Store construction, region separation, credentials, and lifecycle remain the caller's responsibility.
 * A degraded read is never presented as proof that both copies are durable.
 */
export class LargeCystReplicatedStore implements LargeCystStore {
  constructor(private readonly stores: readonly [LargeCystStore, LargeCystStore]) {
    if (stores[0] === stores[1]) throw fail('storage_unavailable');
  }

  async begin(input: LargeCystHeader): Promise<void> {
    const header = parseLargeCystHeader(input);
    const writes = await readPair(this.stores, store => store.begin(header));
    if (writes.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
    const saved = await readPair(this.stores, store => readHeader(store, header.id));
    for (const result of saved) {
      if (result.status !== 'fulfilled' || !result.value) throw fail('storage_unavailable');
      if (!same(result.value, header)) throw fail('conflict');
    }
  }

  async header(id: string, signal?: AbortSignal): Promise<LargeCystHeader | undefined> {
    signal?.throwIfAborted();
    cystIdSchema.parse(id);
    const results = await readPair(this.stores, store => readHeader(store, id, signal));
    signal?.throwIfAborted();
    return available(results);
  }

  async putPart(id: string, index: number, bytes: Uint8Array): Promise<void> {
    const header = await this.header(id);
    if (!header) throw fail('incomplete');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== largeCystPartBytes(header, index)
      || bytes.byteLength > LARGE_CYST_MAX_PART_BYTES) throw fail('integrity_failed');
    const writes = await readPair(this.stores, store => store.putPart(id, index, bytes));
    if (writes.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
    const saved = await readPair(this.stores, store => store.part(id, index));
    for (const result of saved) {
      if (result.status !== 'fulfilled' || !result.value || result.value.length !== bytes.byteLength
        || !timingSafeEqual(result.value, bytes)) throw fail('storage_unavailable');
    }
  }

  async part(id: string, index: number, signal?: AbortSignal): Promise<Buffer | undefined> {
    signal?.throwIfAborted();
    const header = await this.header(id, signal);
    signal?.throwIfAborted();
    if (!header) throw fail('incomplete');
    const expectedLength = largeCystPartBytes(header, index);
    const manifest = await this.manifest(id, signal);
    signal?.throwIfAborted();
    const committedPart = manifest?.parts[index];
    if (committedPart && (committedPart.index !== index || committedPart.bytes !== expectedLength)) throw fail('integrity_failed');
    const results = await readPair(this.stores, store => store.part(id, index, signal));
    signal?.throwIfAborted();
    const candidates = results.map(result => result.status === 'fulfilled' ? result.value : undefined);
    if (committedPart) {
      const verified = candidates.find(bytes => validPart(bytes, committedPart));
      if (verified) return Buffer.from(verified);
      if (candidates.some(Boolean)) throw fail('integrity_failed');
      if (results.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
      return undefined;
    }
    const first = candidates[0], second = candidates[1];
    if (first && first.length !== expectedLength || second && second.length !== expectedLength) throw fail('integrity_failed');
    if (first && second && !first.equals(second)) throw fail('conflict');
    if (first || second) return Buffer.from(first ?? second!);
    if (results.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
    return undefined;
  }

  async manifest(id: string, signal?: AbortSignal): Promise<LargeCystManifest | undefined> {
    signal?.throwIfAborted();
    cystIdSchema.parse(id);
    const results = await readPair(this.stores, store => readManifest(store, id, signal));
    signal?.throwIfAborted();
    return available(results);
  }

  async commit(input: LargeCystManifest): Promise<void> {
    await this.reconcile(parseLargeCystManifest(input));
  }

  /** Explicit repair after restart or a partial commit. Only confirmed missing
   * objects are copied from a digest-verified peer; corrupt objects are never overwritten.
   */
  async repair(id: string): Promise<void> {
    const manifest = await this.manifest(id);
    if (!manifest) throw fail('incomplete');
    await this.reconcile(manifest);
  }

  /** Checks durability without repairing or claiming a degraded read is complete. */
  async isDurable(id: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    cystIdSchema.parse(id);
    const manifest = await this.manifest(id, signal);
    signal?.throwIfAborted();
    if (!manifest) return false;
    const headers = await readPair(this.stores, store => readHeader(store, id, signal));
    signal?.throwIfAborted();
    if (headers.some(result => result.status !== 'fulfilled' || !result.value
      || !same(result.value, manifest.header))) return false;
    const manifests = await readPair(this.stores, store => readManifest(store, id, signal));
    signal?.throwIfAborted();
    if (manifests.some(result => result.status !== 'fulfilled' || !result.value
      || !same(result.value, manifest))) return false;
    for (const part of manifest.parts) {
      signal?.throwIfAborted();
      const results = await readPair(this.stores, store => store.part(id, part.index, signal));
      signal?.throwIfAborted();
      if (results.some(result => result.status !== 'fulfilled' || !validPart(result.value, part))) return false;
    }
    return true;
  }

  private async reconcile(manifest: LargeCystManifest): Promise<void> {
    const { header } = manifest, id = header.id;
    const existing = await readPair(this.stores, store => readManifest(store, id));
    for (const result of existing) {
      if (result.status === 'fulfilled' && result.value && !same(result.value, manifest)) throw fail('conflict');
    }
    const headers = await readPair(this.stores, store => readHeader(store, id));
    for (let index = 0; index < 2; index++) {
      const result = headers[index]!;
      if (result.status === 'rejected') throw fail('storage_unavailable');
      if (result.value && !same(result.value, header)) throw fail('conflict');
      if (!result.value) {
        try { await this.stores[index]!.begin(header); }
        catch { throw fail('storage_unavailable'); }
      }
    }
    for (const part of manifest.parts) {
      const copies = await readPair(this.stores, store => store.part(id, part.index));
      if (copies.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
      const bytes = copies.map(result => result.status === 'fulfilled' ? result.value : undefined);
      // A present but invalid immutable object requires operator intervention.
      if (bytes.some(value => value && !validPart(value, part))) throw fail('integrity_failed');
      const good = bytes.find((value): value is Buffer => value !== undefined);
      if (!good) throw fail('incomplete');
      for (let index = 0; index < 2; index++) {
        if (bytes[index]) continue;
        try {
          await this.stores[index]!.putPart(id, part.index, good);
          const saved = await this.stores[index]!.part(id, part.index);
          if (!validPart(saved, part)) throw fail('integrity_failed');
        } catch { throw fail('storage_unavailable'); }
      }
    }
    const commits = await readPair(this.stores, store => store.commit(manifest));
    if (commits.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
    const saved = await readPair(this.stores, store => readManifest(store, id));
    for (const result of saved) {
      if (result.status !== 'fulfilled' || !result.value || !same(result.value, manifest)) throw fail('storage_unavailable');
    }
  }
}
