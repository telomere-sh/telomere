import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LARGE_CYST_CHUNK_BYTES, LargeCystPrivateStore,
  type LargeCystHeader, type LargeCystManifest } from '../src/cysts/large-checkpoints.js';
import { LargeCystQuotaShadowStore, type ManagedLargeCystStore } from '../src/cysts/large-quota-shadow.js';

const id = '0x' + 'a'.repeat(64);
const part = Buffer.alloc(43, 7);
const header: LargeCystHeader = { version: 1, algorithm: 'xchacha20-poly1305-chunked', id,
  owner: '0x' + '1'.repeat(40), agent: '0x' + '2'.repeat(40), applicationSchema: 'test/v1',
  plaintextBytes: 3, chunkBytes: LARGE_CYST_CHUNK_BYTES, chunkCount: 1,
  sourceMac: 'b'.repeat(64), keyCommitment: 'c'.repeat(64) };
const manifest: LargeCystManifest = { header, parts: [{ index: 0, bytes: part.length,
  sha256: createHash('sha256').update(part).digest('hex') }], mac: 'd'.repeat(64) };
const limits = { globalMaxBytes: 16 * 1024 * 1024, ownerMaxBytes: 8 * 1024 * 1024 };

class StallingDestination implements ManagedLargeCystStore {
  stall = false;
  receivedSignal: AbortSignal | undefined;
  private entered!: () => void;
  readonly partEntered = new Promise<void>(resolve => { this.entered = resolve; });

  constructor(private readonly inner: LargeCystPrivateStore) {}
  initialize() { return this.inner.initialize(); }
  close() { return this.inner.close(); }
  begin(value: LargeCystHeader) { return this.inner.begin(value); }
  header(value: string) { return this.inner.header(value); }
  putPart(value: string, index: number, bytes: Uint8Array) { return this.inner.putPart(value, index, bytes); }
  commit(value: LargeCystManifest) { return this.inner.commit(value); }
  manifest(value: string) { return this.inner.manifest(value); }

  async part(value: string, index: number, signal?: AbortSignal): Promise<Buffer | undefined> {
    if (!this.stall) return this.inner.part(value, index);
    this.receivedSignal = signal;
    this.entered();
    if (!signal) throw new Error('Remote part read did not receive the abort signal');
    signal.throwIfAborted();
    return new Promise<Buffer | undefined>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
}

describe('large Cyst agent part read cancellation', () => {
  it('aborts both remote reads when the sealed local ciphertext is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telomere-large-part-abort-'));
    const paths = [join(root, 'shadow'), join(root, 'remote-a'), join(root, 'remote-b')] as const;
    await Promise.all(paths.map(path => mkdir(path, { mode: 0o700 })));
    const shadow = new LargeCystPrivateStore(paths[0], limits);
    const first = new StallingDestination(new LargeCystPrivateStore(paths[1], limits));
    const second = new StallingDestination(new LargeCystPrivateStore(paths[2], limits));
    const store = new LargeCystQuotaShadowStore(shadow, [first, second]);
    try {
      await store.initialize();
      await store.begin(header);
      await store.putPart(id, 0, part);
      await store.commit(manifest);
      await writeFile(join(paths[0], id.slice(2), 'part-000000.bin'), Buffer.alloc(part.length, 9));
      first.stall = true;
      second.stall = true;
      const controller = new AbortController();
      const pending = store.part(id, 0, controller.signal);
      void pending.catch(() => undefined);
      try {
        await Promise.all([first.partEntered, second.partEntered]);
        const started = Date.now();
        controller.abort(new Error('Agent part transfer cancelled'));
        await expect(pending).rejects.toThrow('Agent part transfer cancelled');
        expect(Date.now() - started).toBeLessThan(900);
        expect(first.receivedSignal).toBe(controller.signal);
        expect(second.receivedSignal).toBe(controller.signal);
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
      }
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
