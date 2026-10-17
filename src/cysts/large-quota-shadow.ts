import { createHash } from 'node:crypto';
import { LARGE_CYST_MAX_PACKAGE_BYTES, LargeCystError, LargeCystPrivateStore,
  parseLargeCystHeader, parseLargeCystManifest, type LargeCystHeader,
  type LargeCystManifest, type LargeCystStore } from './large-checkpoints.js';
import { LargeCystReplicatedStore } from './large-replicated.js';
import { cystIdSchema } from './types.js';

export type ManagedLargeCystStore = LargeCystStore & { initialize(): Promise<void>; close?(): Promise<void> };
const fail = (code: LargeCystError['code']): LargeCystError => new LargeCystError(code);
const same = (left: object, right: object): boolean => JSON.stringify(left) === JSON.stringify(right);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Local ciphertext is the durable quota and retry authority. The remote pair is
 * the commit authority; a local-only manifest is never exposed as committed.
 * The configured topology is pinned after both remote probes succeed. A prior
 * binding permits read-only startup while a destination is unavailable.
 */
export class LargeCystQuotaShadowStore implements LargeCystStore {
  readonly remote: LargeCystReplicatedStore;
  private readonly queues = new Map<string, Promise<void>>();
  private state: 'new' | 'initializing' | 'ready' | 'read_only' | 'closing' | 'closed' = 'new';
  private initPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(readonly shadow: LargeCystPrivateStore,
    readonly destinations: readonly [ManagedLargeCystStore, ManagedLargeCystStore],
    private readonly topologySha256?: string) {
    if (destinations[0] === destinations[1] || destinations.includes(shadow)) throw fail('storage_unavailable');
    this.remote = new LargeCystReplicatedStore(destinations);
  }

  initialize(): Promise<void> {
    if (this.state !== 'new') return Promise.reject(fail('storage_unavailable'));
    this.state = 'initializing';
    this.initPromise = (async () => {
      try {
        await this.shadow.initialize();
        const topology = this.topologySha256
          ? await this.shadow.remoteTopologyState(this.topologySha256) : 'new';
        const results = await Promise.allSettled(this.destinations.map(store => store.initialize()));
        const outage = results.some(result => result.status === 'rejected');
        if (outage && topology !== 'bound') throw fail('storage_unavailable');
        if (!outage && this.topologySha256) await this.shadow.assertRemoteTopology(this.topologySha256);
        if (this.state === 'initializing') this.state = outage ? 'read_only' : 'ready';
      } catch (error) {
        await Promise.allSettled([this.shadow.close(), ...this.destinations.map(store => store.close?.())]);
        this.state = 'closed';
        throw error instanceof LargeCystError ? error : fail('storage_unavailable');
      }
    })();
    return this.initPromise;
  }

  get readOnly(): boolean { return this.state === 'read_only'; }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'closed' || this.state === 'new') {
      this.state = 'closed'; return Promise.resolve();
    }
    this.state = 'closing';
    this.closePromise = (async () => {
      await this.initPromise?.catch(() => undefined);
      await Promise.allSettled([...this.queues.values()]);
      const results = await Promise.allSettled([this.shadow.close(), ...this.destinations.map(store => store.close?.())]);
      this.state = 'closed';
      if (results.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
    })();
    return this.closePromise;
  }

  private readable(): void {
    if (this.state !== 'ready' && this.state !== 'read_only') throw fail('storage_unavailable');
  }
  private writable(): void { if (this.state !== 'ready') throw fail('storage_unavailable'); }

  private async withId<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.writable();
    cystIdSchema.parse(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(id, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (this.queues.get(id) === tail) this.queues.delete(id); }
  }

  async begin(input: LargeCystHeader): Promise<void> {
    const header = parseLargeCystHeader(input);
    await this.withId(header.id, async () => {
      await this.shadow.begin(header);
      await this.remote.begin(header);
    });
  }

  async header(id: string): Promise<LargeCystHeader | undefined> {
    this.readable();
    return this.shadow.header(cystIdSchema.parse(id));
  }

  async putPart(id: string, index: number, bytes: Uint8Array): Promise<void> {
    await this.withId(id, async () => {
      await this.shadow.putPart(id, index, bytes);
      const header = await this.shadow.header(id);
      const original = await this.shadow.part(id, index);
      if (!header || !original) throw fail('storage_unavailable');
      await this.remote.begin(header);
      await this.remote.putPart(id, index, original);
    });
  }

  /** The shadow preserves the original random nonce even if neither remote PUT
   * succeeded. The owner-side retry validates the ciphertext with its key.
   */
  async part(id: string, index: number, signal?: AbortSignal): Promise<Buffer | undefined> {
    signal?.throwIfAborted();
    this.readable();
    const checked = cystIdSchema.parse(id);
    const manifest = await this.shadow.manifest(checked);
    signal?.throwIfAborted();
    const sealed = manifest && await this.shadow.hasRemoteCommit(checked);
    signal?.throwIfAborted();
    let local: Buffer | undefined;
    let localFailure: unknown;
    try { local = await this.shadow.part(checked, index); }
    catch (error) { localFailure = error; }
    signal?.throwIfAborted();
    if (!sealed || !manifest) {
      if (localFailure) throw localFailure;
      return local;
    }
    const part = manifest.parts[index];
    if (!part || part.index !== index) throw fail('integrity_failed');
    if (local && local.length === part.bytes && digest(local) === part.sha256) return local;
    const remote = await this.remote.part(checked, index, signal);
    signal?.throwIfAborted();
    if (!remote || remote.length !== part.bytes || digest(remote) !== part.sha256) throw fail('integrity_failed');
    return remote;
  }

  private async syncRemote(manifest: LargeCystManifest): Promise<void> {
    const { header } = manifest;
    await this.shadow.reserveRemoteCommit(header.id);
    await this.remote.begin(header);
    for (const part of manifest.parts) {
      const bytes = await this.shadow.part(header.id, part.index);
      if (!bytes || bytes.length !== part.bytes || digest(bytes) !== part.sha256) throw fail('integrity_failed');
      const copies = await Promise.allSettled(this.destinations.map(store => store.part(header.id, part.index)));
      if (copies.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
      const missing: ManagedLargeCystStore[] = [];
      for (let index = 0; index < copies.length; index++) {
        const result = copies[index]!;
        if (result.status === 'rejected') throw fail('storage_unavailable');
        if (!result.value) missing.push(this.destinations[index]!);
        else if (result.value.length !== part.bytes || digest(result.value) !== part.sha256) throw fail('integrity_failed');
      }
      const repairs = await Promise.allSettled(missing.map(store => store.putPart(header.id, part.index, bytes)));
      if (repairs.some(result => result.status === 'rejected')) throw fail('storage_unavailable');
      for (const store of missing) {
        const saved = await store.part(header.id, part.index);
        if (!saved || saved.length !== part.bytes || digest(saved) !== part.sha256) throw fail('storage_unavailable');
      }
    }
    await this.remote.commit(manifest);
    if (!await this.remote.isDurable(header.id)) throw fail('storage_unavailable');
    await this.shadow.sealRemoteCommit(header.id);
  }

  async commit(input: LargeCystManifest): Promise<void> {
    const manifest = parseLargeCystManifest(input);
    if (manifest.parts.reduce((sum, part) => sum + part.bytes,
      Buffer.byteLength(JSON.stringify(manifest)) + Buffer.byteLength(JSON.stringify(manifest.header))) > LARGE_CYST_MAX_PACKAGE_BYTES) {
      throw fail('integrity_failed');
    }
    await this.withId(manifest.header.id, async () => {
      await this.shadow.commit(manifest);
      await this.syncRemote(manifest);
    });
  }

  /** Complete a crash-left remote upload using only its original local bytes. */
  async repair(id: string): Promise<void> {
    await this.withId(id, async () => {
      const manifest = await this.shadow.manifest(id);
      if (!manifest) throw fail('incomplete');
      await this.syncRemote(manifest);
    });
  }

  async isDurable(id: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    this.readable();
    if (this.readOnly) return false;
    const checked = cystIdSchema.parse(id);
    const local = await this.shadow.manifest(checked);
    signal?.throwIfAborted();
    if (!local || !await this.shadow.hasRemoteCommit(checked)) return false;
    signal?.throwIfAborted();
    if (!await this.remote.isDurable(checked, signal)) return false;
    signal?.throwIfAborted();
    const remote = await this.remote.manifest(checked, signal);
    signal?.throwIfAborted();
    if (!remote || !same(remote, local)) throw fail('conflict');
    return true;
  }

  /** Cheap read of a previously dual-acknowledged commit. Use isDurable for a
   * new live audit of every remote part; restore can proceed during an outage.
   */
  async manifest(id: string): Promise<LargeCystManifest | undefined> {
    this.readable();
    const checked = cystIdSchema.parse(id);
    const local = await this.shadow.manifest(checked);
    if (!local) return undefined;
    if (!await this.shadow.hasRemoteCommit(checked)) return undefined;
    return local;
  }
}
