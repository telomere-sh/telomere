import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaidCystInputSpool, paidCystInputSpoolIdentity } from '../src/host-kit/sessions/cyst-input-spool.js';
import { cystInputBindingSchema } from '../src/host-kit/sessions/cyst-input-protocol.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const key = new Ed25519Identity();
const bytes = Buffer.alloc(4 * 1024 * 1024 + 19, 37);
const run = (digit = '1') => '0x' + digit.repeat(64);
function binding(digit = '1', content = bytes) {
  return cystInputBindingSchema.parse({ version: 1, hostKey: key.publicKey, runId: run(digit),
    owner: '0x' + '2'.repeat(40), leaseHash: run('a'), expiresAt: Date.now() + 90_000,
    descriptor: { protocol: 'telomere-cyst-application-file-v1', operationId: 'restore-file', agentId: run('b'),
      revision: '1', plaintextBytes: content.length, plaintextSha256: hash(content),
      checkpoint: { version: 1, format: 'telomere-large-cyst-manifest-v1', id: run('c'), owner: '0x' + '3'.repeat(40),
        agent: '0x' + '4'.repeat(40), applicationSchema: 'counter.v1', manifestSha256: run('d'),
        cystHash: run('e'), sizeBytes: content.length + 80, storageRef: run('f') } } });
}
function stream(value = bytes) { let offset = 0; return new ReadableStream<Uint8Array>({ pull(controller) {
  if (offset === value.length) { controller.close(); return; }
  const end = Math.min(value.length, offset + 65_536); controller.enqueue(value.subarray(offset, end)); offset = end;
} }); }
describe('private paid declared-file input spool', () => {
  const roots: string[] = [], opened: PaidCystInputSpool[] = [];
  afterEach(async () => { for (const spool of opened.splice(0)) await spool.close().catch(() => undefined);
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function setup(overrides: { globalBytes?: number; minimumFreeBytes?: number; maxOperations?: number } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'paid-file-spool-')); roots.push(root);
    const options = { directory: join(root, 'spool'), maxInputBytes: bytes.length, globalBytes: bytes.length,
      maxOperations: 4, minimumFreeBytes: 0, ...overrides };
    const spool = await PaidCystInputSpool.open(options); opened.push(spool); return { root, spool, options };
  }
  it('streams several chunks privately, publishes only after explicit commit, and cleans exact data after resource removal', async () => {
    const { spool } = await setup(), original = binding(); await spool.reserve(original, 'a'.repeat(64));
    const ready = await spool.readyDirectory(original.runId, 'a'.repeat(64));
    expect(await readdir(ready)).toEqual([]);
    await spool.stage(original, stream(), new AbortController().signal, () => undefined);
    expect(await readdir(ready)).toEqual([]);
    expect(await spool.status(original)).toEqual({ state: 'staged', committed: false });
    await spool.commit(original, () => undefined);
    expect((await readFile(join(ready, 'state.bin'))).equals(bytes)).toBe(true);
    if (process.platform !== 'win32') expect((await lstat(join(ready, 'state.bin'))).mode & 0o777).toBe(0o444);
    await spool.cleanup(original.runId);
    expect(await spool.status(original)).toEqual({ state: 'cleaned', committed: true });
    expect(await readdir(join(spool.directory, 'run-' + original.runId.slice(2)))).toEqual(expect.arrayContaining(['binding.json', 'status.json']));
    expect(await spool.canReserve(bytes.length)).toBe(true);
    await expect(spool.cleanup(run('9'))).rejects.toMatchObject({ code: 'cyst_input_storage' });
  });
  it('reserves global bytes and disk headroom before receiving any input and never lets a rebind reuse quota', async () => {
    const { spool } = await setup(), first = binding(); await spool.reserve(first, 'a'.repeat(64));
    expect(await spool.canReserve(1)).toBe(false);
    await expect(spool.reserve(binding('2'), 'a'.repeat(64))).rejects.toMatchObject({ code: 'cyst_input_quota' });
    await expect(spool.reserve({ ...first, descriptor: { ...first.descriptor, operationId: 'different' } }, 'a'.repeat(64)))
      .rejects.toMatchObject({ code: 'cyst_input_conflict' });
    expect((await spool.inventory()).map(record => record.binding)).toEqual([first]);
    const free = await statfs(spool.directory, { bigint: true });
    const other = await setup({ minimumFreeBytes: Number(free.bavail * free.bsize) + 10_000_000 });
    expect(await other.spool.canReserve(1)).toBe(false);
    await expect(other.spool.reserve(binding('3'), 'a'.repeat(64))).rejects.toMatchObject({ code: 'cyst_input_disk_headroom' });
    expect(await other.spool.inventory()).toEqual([]);
  });
  it('fully verifies duplicate staged and ready bodies without rewriting their original inode', async () => {
    const { spool } = await setup(), original = binding(); await spool.reserve(original, 'a'.repeat(64));
    await spool.stage(original, stream(), new AbortController().signal, () => undefined);
    const incoming = join(spool.directory, 'run-' + original.runId.slice(2), 'incoming.bin');
    const before = await lstat(incoming, { bigint: true });
    await spool.stage(original, stream(), new AbortController().signal, () => undefined);
    const repeated = await lstat(incoming, { bigint: true });
    expect([repeated.ino, repeated.size, repeated.mtimeNs, repeated.ctimeNs]).toEqual([before.ino, before.size, before.mtimeNs, before.ctimeNs]);
    for (const wrong of [Buffer.alloc(bytes.length, 7), bytes.subarray(1), Buffer.concat([bytes, Buffer.from([1])])]) {
      await expect(spool.stage(original, stream(wrong), new AbortController().signal, () => undefined)).rejects.toThrow();
      expect(await spool.status(original)).toEqual({ state: 'staged', committed: false });
    }
    await spool.commit(original, () => undefined);
    const ready = join(spool.directory, 'run-' + original.runId.slice(2), 'ready', 'state.bin'), published = await lstat(ready, { bigint: true });
    await spool.stage(original, stream(), new AbortController().signal, () => undefined);
    await expect(spool.stage(original, stream(Buffer.alloc(bytes.length, 1)), new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'cyst_input_integrity' });
    const retained = await lstat(ready, { bigint: true });
    expect([retained.ino, retained.size, retained.mtimeNs, retained.ctimeNs]).toEqual([published.ino, published.size, published.mtimeNs, published.ctimeNs]);
    expect((await readFile(ready)).equals(bytes)).toBe(true);
  });
  it('rejects digest, truncation, excess bytes, stale authority and concurrent ingress without exposing a partial file', async () => {
    const { spool } = await setup(), original = binding(); await spool.reserve(original, 'a'.repeat(64));
    const ready = await spool.readyDirectory(original.runId, 'a'.repeat(64));
    await expect(spool.stage(original, stream(Buffer.alloc(bytes.length, 12)), new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'cyst_input_integrity' });
    await expect(spool.stage(original, stream(bytes.subarray(1)), new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'cyst_input_integrity' });
    await expect(spool.stage(original, stream(Buffer.concat([bytes, Buffer.from([1])])), new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'cyst_input_length' });
    expect(await readdir(ready)).toEqual([]);
    await spool.stage(original, stream(), new AbortController().signal, () => undefined);
    await expect(spool.commit(original, () => { throw new Error('paid policy killed'); })).rejects.toThrow('paid policy killed');
    expect(await readdir(ready)).toEqual([]);
    await spool.commit(original, () => undefined);
  });
  it('aborts a stalled body, retains binding on restart, and never rearms its original lease', async () => {
    const { spool, options } = await setup(), original = binding(); await spool.reserve(original, 'a'.repeat(64));
    const abort = new AbortController(); let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const stalled = new ReadableStream<Uint8Array>({ pull() { started(); } });
    const transfer = spool.stage(original, stalled, abort.signal, () => undefined); await begun; abort.abort();
    await expect(transfer).rejects.toThrow();
    await spool.close();
    const recovered = await PaidCystInputSpool.open(options); opened.push(recovered);
    expect((await recovered.inventory())[0]?.binding).toEqual(original);
    await expect(recovered.reserve(original, 'a'.repeat(64))).rejects.toMatchObject({ code: 'cyst_input_storage' });
    await recovered.cleanup(original.runId);
    expect(await recovered.status(original)).toEqual({ state: 'cleaned', committed: false });
  });
  it('closes upload admission before cleanup awaits, including a stage paused inside its initial audit', async () => {
    const { spool } = await setup(), original = binding(); await spool.reserve(original, 'a'.repeat(64));
    const audited = spool as unknown as { auditEntry(runId: string): Promise<void> };
    const audit = audited.auditEntry.bind(spool);
    let entered!: () => void, release!: () => void, first = true;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(audited, 'auditEntry').mockImplementation(async runId => {
      await audit(runId); if (first) { first = false; entered(); await resume; }
    });
    const uploading = spool.stage(original, stream(), new AbortController().signal, () => undefined);
    // Attach rejection before releasing the deterministic barrier.
    const rejected = expect(uploading).rejects.toMatchObject({ code: 'cyst_input_expired' });
    await paused; const cleaning = spool.cleanup(original.runId); await cleaning; release(); await rejected; spy.mockRestore();
    const names = await readdir(join(spool.directory, 'run-' + original.runId.slice(2)));
    expect(names.sort()).toEqual(['binding.json', 'status.json']);
    expect(await spool.status(original)).toEqual({ state: 'cleaned', committed: false });
    expect(await spool.canReserve(bytes.length)).toBe(true);
  });
  it('fails closed on policy/metadata mutation and rejects a symlink or hardlinked incoming file', async () => {
    const first = await setup(), original = binding(); await first.spool.reserve(original, 'a'.repeat(64));
    const incoming = join(first.spool.directory, 'run-' + original.runId.slice(2), 'incoming.bin');
    const target = join(first.root, 'outside'); await writeFile(target, 'secret', { mode: 0o600 });
    if (process.platform !== 'win32') {
      await symlink(target, incoming);
      await expect(first.spool.stage(original, stream(), new AbortController().signal, () => undefined)).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('secret');
      await expect(first.spool.cleanup(original.runId)).rejects.toThrow();
    }
    const second = await setup(), another = binding('2'); await second.spool.reserve(another, 'a'.repeat(64));
    await link(target, join(second.spool.directory, 'run-' + another.runId.slice(2), 'incoming.bin'));
    await expect(second.spool.stage(another, stream(), new AbortController().signal, () => undefined)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('secret');
    const third = await setup(); await chmod(join(third.spool.directory, '.policy.json'), 0o600);
    await writeFile(join(third.spool.directory, '.policy.json'), '{}');
    await expect(third.spool.canReserve(1)).rejects.toThrow();
    expect(paidCystInputSpoolIdentity(third.options)).toHaveLength(64);
  });
});
