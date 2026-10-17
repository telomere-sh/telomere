import { createHash } from 'node:crypto';
import { Problem } from '../common.js';
import { CYST_CAPABILITIES } from './types.js';

export interface CiphertextStore {
  initialize(): Promise<void>;
  read(owner: string, digest: string, expectedBytes: number): Promise<Uint8Array | undefined>;
  put(owner: string, digest: string, bytes: Uint8Array): Promise<void>;
  /** Recovery promotion must require full durability, separately from a degraded but verified fallback read. */
  isDurable?(owner: string, digest: string, expectedBytes: number): Promise<boolean>;
}
export interface ReviewedCystDestination {
  readonly endpoint: string; readonly bucket: string; readonly region: string; readonly failureDomain: string; readonly reviewed: true;
}
export interface ReviewedCiphertextStore extends CiphertextStore { readonly destination: ReviewedCystDestination }
export const cystStorageUnavailable = () => new Problem(503, 'cyst_storage_unavailable', 'Checkpoint storage is unavailable.');
export function validateCiphertextScope(owner: string, digest: string, expectedBytes: number): void {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^[0-9a-f]{64}$/.test(digest)
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 17 || expectedBytes > CYST_CAPABILITIES.maxCiphertextBytes) throw cystStorageUnavailable();
}
export function verifyCiphertext(owner: string, digest: string, bytes: Uint8Array, expectedBytes = bytes.byteLength): void {
  validateCiphertextScope(owner, digest, expectedBytes);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expectedBytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Problem(503, 'cyst_integrity_failed', 'Checkpoint ciphertext failed its integrity check.');
  }
}
type ReplicaState = 'verified' | 'missing' | 'unavailable' | 'invalid';

/** Two independently reviewed failure domains. Upload acknowledgment requires both durable, verified replicas. */
export class ReplicatedCystStorage implements CiphertextStore {
  readonly destinations: readonly ReviewedCystDestination[];
  #stores: readonly [ReviewedCiphertextStore, ReviewedCiphertextStore];
  #initialized = false;
  constructor(stores: readonly [ReviewedCiphertextStore, ReviewedCiphertextStore]) {
    const [a, b] = stores.map(store => store.destination);
    let independentEndpoints = false;
    try { independentEndpoints = a !== undefined && b !== undefined && new URL(a.endpoint).origin !== new URL(b.endpoint).origin; } catch { /* Fail closed with a redacted message below. */ }
    if (!a || !b || a.reviewed !== true || b.reviewed !== true || !a.region || !b.region || !a.failureDomain || !b.failureDomain
      || a.region === b.region || a.failureDomain === b.failureDomain || !independentEndpoints) {
      throw new Error('Review two distinct storage endpoints, regions and failure domains before enabling replication');
    }
    this.#stores = stores; this.destinations = Object.freeze(stores.map(store => Object.freeze({ ...store.destination })));
  }
  async initialize(): Promise<void> {
    const results = await Promise.allSettled(this.#stores.map(store => store.initialize()));
    if (results.some(result => result.status === 'rejected')) throw cystStorageUnavailable();
    this.#initialized = true;
  }
  async put(owner: string, digest: string, value: Uint8Array): Promise<void> {
    if (!this.#initialized) throw cystStorageUnavailable();
    if (!(value instanceof Uint8Array)) throw cystStorageUnavailable(); validateCiphertextScope(owner, digest, value.byteLength);
    const bytes = Uint8Array.from(value); verifyCiphertext(owner, digest, bytes);
    const results = await Promise.allSettled(this.#stores.map(async store => {
      await store.put(owner, digest, Uint8Array.from(bytes));
      const saved = await store.read(owner, digest, bytes.byteLength);
      if (!saved) throw cystStorageUnavailable(); verifyCiphertext(owner, digest, saved, bytes.byteLength);
    }));
    if (results.some(result => result.status === 'rejected')) throw cystStorageUnavailable();
  }
  async read(owner: string, digest: string, expectedBytes: number): Promise<Uint8Array | undefined> {
    return (await this.readDetailed(owner, digest, expectedBytes)).bytes;
  }
  async isDurable(owner: string, digest: string, expectedBytes: number): Promise<boolean> {
    const result = await this.readDetailed(owner, digest, expectedBytes);
    return result.bytes !== undefined && result.replicas.every((state, index) => state === 'verified' || state === 'missing' && result.repairs[index] === 'verified');
  }
  async readDetailed(owner: string, digest: string, expectedBytes: number): Promise<{
    bytes: Uint8Array | undefined; replicas: readonly ReplicaState[]; repairs: readonly ('not-needed' | 'verified' | 'failed')[];
  }> {
    if (!this.#initialized) throw cystStorageUnavailable(); validateCiphertextScope(owner, digest, expectedBytes);
    const results = await Promise.allSettled(this.#stores.map(async store => {
      const bytes = await store.read(owner, digest, expectedBytes);
      if (bytes) verifyCiphertext(owner, digest, bytes, expectedBytes); return bytes;
    }));
    const replicas: ReplicaState[] = results.map(result => result.status === 'fulfilled' ? result.value ? 'verified' : 'missing'
      : result.reason instanceof Problem && result.reason.code === 'cyst_integrity_failed' ? 'invalid' : 'unavailable');
    const healthy = results.find(result => result.status === 'fulfilled' && result.value !== undefined);
    if (!healthy || healthy.status !== 'fulfilled' || !healthy.value) {
      if (replicas.every(state => state === 'missing')) return { bytes: undefined, replicas, repairs: ['not-needed', 'not-needed'] };
      throw cystStorageUnavailable();
    }
    const bytes = Uint8Array.from(healthy.value), repairs: ('not-needed' | 'verified' | 'failed')[] = ['not-needed', 'not-needed'];
    // Only a confirmed absent object is repaired. Existing corrupt/foreign objects are immutable and need operator investigation.
    await Promise.all(this.#stores.map(async (store, index) => {
      if (replicas[index] !== 'missing') return;
      try {
        await store.put(owner, digest, bytes); const saved = await store.read(owner, digest, expectedBytes);
        if (!saved) throw cystStorageUnavailable(); verifyCiphertext(owner, digest, saved, expectedBytes); repairs[index] = 'verified';
      } catch { repairs[index] = 'failed'; }
    }));
    return { bytes, replicas: Object.freeze(replicas), repairs: Object.freeze(repairs) };
  }
}
