import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LARGE_CYST_CHUNK_BYTES, LARGE_CYST_MAX_PART_BYTES, LargeCystPrivateStore,
  type LargeCystHeader, type LargeCystManifest } from '../src/cysts/large-checkpoints.js';
import { LargeCystQuotaShadowStore, type ManagedLargeCystStore } from '../src/cysts/large-quota-shadow.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const id = '0x' + 'a'.repeat(64);
const owner = '0x' + '1'.repeat(40), agent = '0x' + '2'.repeat(40);
const header: LargeCystHeader = { version: 1, algorithm: 'xchacha20-poly1305-chunked', id, owner, agent,
  applicationSchema: 'test/v1', plaintextBytes: 3, chunkBytes: LARGE_CYST_CHUNK_BYTES,
  chunkCount: 1, sourceMac: 'b'.repeat(64), keyCommitment: 'c'.repeat(64) };
const part = Buffer.alloc(43, 7);
const manifest: LargeCystManifest = { header, parts: [{ index: 0, bytes: part.length, sha256: sha256(part) }], mac: 'd'.repeat(64) };
const defaultLimits = { globalMaxBytes: 16 * 1024 * 1024, ownerMaxBytes: 8 * 1024 * 1024 };

class FaultStore implements ManagedLargeCystStore {
  failInitialize = false;
  failPutPart = false;
  failCommit = false;
  failReadPart = false;
  constructor(readonly inner: LargeCystPrivateStore) {}
  async initialize() {
    if (this.failInitialize) throw new Error('remote initialization outage');
    return this.inner.initialize();
  }
  close() { return this.inner.close(); }
  begin(value: LargeCystHeader) { return this.inner.begin(value); }
  header(checkpointId: string) { return this.inner.header(checkpointId); }
  async putPart(checkpointId: string, index: number, bytes: Uint8Array) {
    if (this.failPutPart) throw new Error('remote part outage');
    return this.inner.putPart(checkpointId, index, bytes);
  }
  part(checkpointId: string, index: number) {
    if (this.failReadPart) return Promise.reject(new Error('remote read outage'));
    return this.inner.part(checkpointId, index);
  }
  async commit(value: LargeCystManifest) {
    if (this.failCommit) throw new Error('remote commit outage');
    return this.inner.commit(value);
  }
  manifest(checkpointId: string) { return this.inner.manifest(checkpointId); }
}

describe('large Cyst local quota shadow and remote pair', () => {
  let root: string;
  let shadowDir: string, firstDir: string, secondDir: string;
  let shadow: LargeCystPrivateStore, first: FaultStore, second: FaultStore;
  let store: LargeCystQuotaShadowStore;

  const create = async (limits = defaultLimits): Promise<void> => {
    shadow = new LargeCystPrivateStore(shadowDir, limits);
    first = new FaultStore(new LargeCystPrivateStore(firstDir, limits));
    second = new FaultStore(new LargeCystPrivateStore(secondDir, limits));
    store = new LargeCystQuotaShadowStore(shadow, [first, second]);
    await store.initialize();
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-large-quota-shadow-'));
    shadowDir = join(root, 'quota'); firstDir = join(root, 'remote-a'); secondDir = join(root, 'remote-b');
    await Promise.all([mkdir(shadowDir, { mode: 0o700 }), mkdir(firstDir, { mode: 0o700 }), mkdir(secondDir, { mode: 0o700 })]);
    await create();
  });
  afterEach(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });

  it('acknowledges a manifest only after local quota and both remote copies are complete', async () => {
    await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
    expect(await store.manifest(id)).toEqual(manifest);
    expect(await store.isDurable(id)).toBe(true);
    expect(await shadow.part(id, 0)).toEqual(part);
    expect(await first.part(id, 0)).toEqual(part);
    expect(await second.part(id, 0)).toEqual(part);
  });

  it('retains the original local ciphertext if neither remote receives the part, then repairs after restart', async () => {
    await store.begin(header);
    first.failPutPart = true; second.failPutPart = true;
    await expect(store.putPart(id, 0, part)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await shadow.part(id, 0)).toEqual(part);
    expect(await first.part(id, 0)).toBeUndefined();
    expect(await second.part(id, 0)).toBeUndefined();
    await store.close(); await create();
    expect(await store.part(id, 0)).toEqual(part);
    await store.commit(manifest);
    expect(await store.isDurable(id)).toBe(true);
    expect(await store.manifest(id)).toEqual(manifest);
  });

  it('fills a single missing remote part from the local shadow after restart', async () => {
    await store.begin(header);
    second.failPutPart = true;
    await expect(store.putPart(id, 0, part)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await first.part(id, 0)).toEqual(part);
    expect(await second.part(id, 0)).toBeUndefined();
    await store.close(); await create();
    await store.commit(manifest);
    expect(await second.part(id, 0)).toEqual(part);
    expect(await store.isDurable(id)).toBe(true);
  });

  it('keeps a failed remote commit pending and reserves its quota through restart', async () => {
    await store.begin(header); await store.putPart(id, 0, part);
    second.failCommit = true;
    await expect(store.commit(manifest)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await shadow.manifest(id)).toEqual(manifest);
    expect(await first.manifest(id)).toEqual(manifest);
    expect(await second.manifest(id)).toBeUndefined();
    expect(await store.manifest(id)).toBeUndefined();
    expect(await store.isDurable(id)).toBe(false);
    await store.close(); await create();
    expect(await store.manifest(id)).toBeUndefined();
    await store.repair(id);
    expect(await store.manifest(id)).toEqual(manifest);
    expect(await store.isDurable(id)).toBe(true);
  });

  it('serves a sealed manifest and intact local part during one remote outage after restart', async () => {
    await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
    await store.close(); await create();
    second.failReadPart = true;
    expect(await store.manifest(id)).toEqual(manifest);
    expect(await store.part(id, 0)).toEqual(part);
    expect(await store.isDurable(id)).toBe(false);
  });

  it('uses a digest-verified remote copy when the sealed local part is corrupt', async () => {
    await store.begin(header); await store.putPart(id, 0, part); await store.commit(manifest);
    await writeFile(join(shadowDir, id.slice(2), 'part-000000.bin'), Buffer.alloc(part.length, 9));
    second.failReadPart = true;
    expect(await store.part(id, 0)).toEqual(part);
    expect(await store.manifest(id)).toEqual(manifest);
  });

  it('refuses insufficient marker quota before either remote manifest is committed', async () => {
    await store.close();
    const largePart = Buffer.alloc(LARGE_CYST_MAX_PART_BYTES, 3);
    const largeHeader = { ...header, plaintextBytes: LARGE_CYST_CHUNK_BYTES };
    const largeManifest = { ...manifest, header: largeHeader,
      parts: [{ index: 0, bytes: largePart.length, sha256: sha256(largePart) }] };
    const noMarkerSpace = Buffer.byteLength(JSON.stringify(largeHeader)) + largePart.length
      + Buffer.byteLength(JSON.stringify(largeManifest));
    await create({ globalMaxBytes: noMarkerSpace, ownerMaxBytes: noMarkerSpace });
    await store.begin(largeHeader); await store.putPart(id, 0, largePart);
    await expect(store.commit(largeManifest)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(await first.manifest(id)).toBeUndefined();
    expect(await second.manifest(id)).toBeUndefined();
    expect(await store.manifest(id)).toBeUndefined();
  });

  it('keeps proof quota across restart after both remotes commit but before local seal', async () => {
    await store.close();
    const largePart = Buffer.alloc(LARGE_CYST_MAX_PART_BYTES, 4);
    const largeHeader = { ...header, plaintextBytes: LARGE_CYST_CHUNK_BYTES };
    const largeManifest = { ...manifest, header: largeHeader,
      parts: [{ index: 0, bytes: largePart.length, sha256: sha256(largePart) }] };
    const cap = Buffer.byteLength(JSON.stringify(largeHeader)) + largePart.length
      + Buffer.byteLength(JSON.stringify(largeManifest))
      + Buffer.byteLength(JSON.stringify({ version: 1, sha256: 'a'.repeat(64) }));
    await create({ globalMaxBytes: cap, ownerMaxBytes: cap });
    await store.begin(largeHeader); await store.putPart(id, 0, largePart);
    shadow.sealRemoteCommit = async () => { throw new Error('simulated stop before proof publication'); };
    await expect(store.commit(largeManifest)).rejects.toThrow('simulated stop');
    expect(await first.manifest(id)).toEqual(largeManifest);
    expect(await second.manifest(id)).toEqual(largeManifest);
    expect(await store.manifest(id)).toBeUndefined();
    await store.close(); await create({ globalMaxBytes: cap, ownerMaxBytes: cap });
    await expect(store.begin({ ...header, id: '0x' + 'e'.repeat(64) }))
      .rejects.toMatchObject({ code: 'quota_exceeded' });
    await store.repair(id);
    expect(await store.manifest(id)).toEqual(largeManifest);
    expect(await store.isDurable(id)).toBe(true);
  }, 90_000);

  it('serializes same-ID writes and refuses a different immutable ciphertext', async () => {
    await store.begin(header);
    const other = Buffer.alloc(part.length, 8);
    const results = await Promise.allSettled([store.putPart(id, 0, part), store.putPart(id, 0, other)]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    if (results[1]?.status === 'rejected') expect(results[1].reason).toMatchObject({ code: 'conflict' });
    expect(await store.part(id, 0)).toEqual(part);
    expect(await first.part(id, 0)).toEqual(part);
    expect(await second.part(id, 0)).toEqual(part);
  });

  it('releases initialized writer locks when one destination fails startup', async () => {
    await store.close();
    shadow = new LargeCystPrivateStore(shadowDir, defaultLimits);
    first = new FaultStore(new LargeCystPrivateStore(firstDir, defaultLimits));
    second = new FaultStore(new LargeCystPrivateStore(secondDir, defaultLimits));
    second.failInitialize = true;
    store = new LargeCystQuotaShadowStore(shadow, [first, second]);
    await expect(store.initialize()).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(store.header(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await store.close();
    await create();
    await store.begin(header);
    expect(await store.header(id)).toEqual(header);
  });

  it('waits for an active immutable write on concurrent close calls', async () => {
    await store.begin(header);
    const original = first.putPart.bind(first);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    first.putPart = async (...args) => { entered(); await barrier; return original(...args); };
    const write = store.putPart(id, 0, part);
    await started;
    const closing = store.close(), sameClose = store.close();
    expect(closing).toBe(sameClose);
    await expect(store.begin(header)).rejects.toMatchObject({ code: 'storage_unavailable' });
    release();
    await write; await closing;
    await create();
    expect(await store.part(id, 0)).toEqual(part);
  });

  it('preserves the local 32-ID per-owner limit before attempting remote writes', async () => {
    for (let number = 0; number < 32; number++) {
      await store.begin({ ...header, id: '0x' + number.toString(16).padStart(64, '0') });
    }
    const extra = { ...header, id: '0x' + 'f'.repeat(64) };
    await expect(store.begin(extra)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(await first.header(extra.id)).toBeUndefined();
    expect(await second.header(extra.id)).toBeUndefined();
  }, 90_000);

  it('preserves the byte cap after restart, including completed remote ciphertext', async () => {
    await store.close();
    const largePart = Buffer.alloc(LARGE_CYST_MAX_PART_BYTES, 3);
    const largeHeader = { ...header, plaintextBytes: LARGE_CYST_CHUNK_BYTES };
    const largeManifest = { ...manifest, header: largeHeader,
      parts: [{ index: 0, bytes: largePart.length, sha256: sha256(largePart) }] };
    const cap = Buffer.byteLength(JSON.stringify(largeHeader)) + largePart.length + Buffer.byteLength(JSON.stringify(largeManifest))
      + Buffer.byteLength(JSON.stringify({ version: 1, sha256: 'a'.repeat(64) }));
    await create({ globalMaxBytes: cap, ownerMaxBytes: cap });
    await store.begin(largeHeader); await store.putPart(id, 0, largePart); await store.commit(largeManifest);
    await store.close(); await create({ globalMaxBytes: cap, ownerMaxBytes: cap });
    expect(await store.isDurable(id)).toBe(true);
    const other = { ...header, id: '0x' + 'e'.repeat(64) };
    await expect(store.begin(other)).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(await first.header(other.id)).toBeUndefined();
  }, 90_000);
});
