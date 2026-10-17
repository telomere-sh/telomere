import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytes32Schema } from '../src/common.js';
import { FileSupplierLedger, type SupplierRecord } from '../src/suppliers/ledger.js';
import { FileNosanaLedger, type NosanaReservation } from '../src/suppliers/nosana-ledger.js';
import { FileSupplierSharedReserve } from '../src/suppliers/shared-reserve.js';

const hash = (digit: string) => bytes32Schema.parse('0x' + digit.repeat(64));
const owner = '0x1111111111111111111111111111111111111111', runId = hash('a');
const akashHold: SupplierRecord = { id: hash('1'), owner, runId, idemKey: 'original', requestHash: hash('2'),
  akashOwner: 'akash1' + 'o'.repeat(38), dseq: '1234567', gseq: 1, oseq: 1, provider: 'akash1' + 'p'.repeat(38),
  deploymentHash: 'fixture', pricePerBlockUact: '1', runtimeHours: 1, reservedUact: '100', reservedUsdcMicros: '1000000',
  quoteSource: 'local fixture', quoteAsOfMs: 1, usdcMicrosPerMillionUact: '1', maxBlocksPerHour: 3600,
  state: 'closed_unsettled', version: 0, createdAt: 1, updatedAt: 1, lastObservedAt: 1, reason: null };
const nosanaHold: NosanaReservation = { id: hash('3'), owner, runId, idemKey: 'original', requestHash: hash('4'),
  jobAddress: 'E'.repeat(43), payer: 'A'.repeat(43), market: 'B'.repeat(43), node: 'C'.repeat(43), ipfsJob: 'Qm' + 'a'.repeat(44),
  priceNosBaseUnitsPerSecond: '1', timeoutSeconds: 1, timeStartSeconds: 1, reservedNosBaseUnits: '100',
  reservedUsdcMicros: '1000000', quoteSource: 'local fixture', quoteAsOfMs: 1, usdcMicrosPerMillionNosBaseUnits: '1',
  state: 'quarantined', reason: null, version: 0, createdAt: 1, updatedAt: 1, lastObservedAt: 1 };
type Ledger = FileSupplierLedger | FileNosanaLedger;
const create = (kind: 'akash' | 'nosana', path: string): Ledger => kind === 'akash' ? new FileSupplierLedger(path) : new FileNosanaLedger(path);
async function hold(ledger: Ledger): Promise<void> {
  if (ledger instanceof FileSupplierLedger) await ledger.transact(file => { file.records.push(structuredClone(akashHold)); });
  else await ledger.transact(file => { file.records.push(structuredClone(nosanaHold)); });
}

describe.each(['akash', 'nosana'] as const)('%s private supplier journal filesystem', kind => {
  let directory: string, path: string, ledger: Ledger;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'telomere-private-supplier-')); path = join(directory, 'journal.json'); ledger = create(kind, path); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

  it('requires explicit fresh initialization and preserves the original held record across reopen', async () => {
    await expect(ledger.read()).rejects.toThrow();
    await expect(ledger.transact(() => { throw new Error('must not enter'); })).rejects.not.toThrow('must not enter');
    await ledger.initializeFresh(); await hold(ledger);
    const before = await readFile(path);
    expect((await create(kind, path).read()).records[0]).toMatchObject({ runId, reservedUsdcMicros: '1000000' });
    await expect(ledger.initializeFresh()).rejects.toThrow('already exists');
    expect(await readFile(path)).toEqual(before);
  });
  it.each(['journal', 'marker'] as const)('refuses a lost %s instead of resetting held liability', async lost => {
    await ledger.initializeFresh(); await hold(ledger);
    await unlink(lost === 'journal' ? path : path + '.initialized');
    let called = false;
    await expect(ledger.read()).rejects.toThrow();
    await expect(ledger.transact(() => { called = true; })).rejects.toThrow();
    await expect(ledger.initializeFresh()).rejects.toThrow('already exists');
    expect(called).toBe(false);
  });
  it('refuses an unreviewed legacy empty file and a marker copied from a different path', async () => {
    const empty = JSON.stringify({ version: 1, records: [] }); await writeFile(path, empty, { mode: 0o600 });
    await expect(ledger.read()).rejects.toThrow(); await expect(ledger.initializeFresh()).rejects.toThrow('already exists');
    expect(await readFile(path, 'utf8')).toBe(empty);
    await unlink(path); await ledger.initializeFresh();
    const other = join(directory, 'copied.json');
    await copyFile(path, other); await chmod(other, 0o600); await copyFile(path + '.initialized', other + '.initialized'); await chmod(other + '.initialized', 0o600);
    await expect(create(kind, other).read()).rejects.toThrow('identity differs');
    const opposite = kind === 'akash' ? new FileNosanaLedger(path) : new FileSupplierLedger(path);
    await expect(opposite.read()).rejects.toThrow('identity differs');
  });
  it.each(['truncated', 'oversized', 'duplicate'] as const)('rejects %s stored JSON without running a mutation', async corruption => {
    await ledger.initializeFresh(); await hold(ledger);
    await writeFile(path, corruption === 'truncated' ? '{' : corruption === 'oversized' ? 'x'.repeat(262145)
      : '{"version":1,"records":[],"records":[]}');
    let called = false; await expect(ledger.transact(() => { called = true; })).rejects.toThrow(); expect(called).toBe(false);
  });
  it.each(['journal', 'marker'] as const)('rejects a hardlinked %s', async target => {
    await ledger.initializeFresh(); const original = target === 'journal' ? path : path + '.initialized';
    await link(original, join(directory, 'hardlink'));
    await expect(ledger.read()).rejects.toThrow('storage rejected');
    await expect(ledger.transact(() => true)).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('rejects a symlinked journal, marker, parent and exposed POSIX storage', async () => {
    await ledger.initializeFresh(); await hold(ledger);
    for (const target of [path, path + '.initialized']) {
      const bytes = await readFile(target), other = target + '.original'; await copyFile(target, other); await unlink(target); await symlink(other, target);
      await expect(ledger.read()).rejects.toThrow(); await unlink(target); await writeFile(target, bytes, { mode: 0o600 });
    }
    await chmod(path, 0o644); await expect(ledger.read()).rejects.toThrow(); await chmod(path, 0o600);
    await chmod(directory, 0o755); await expect(ledger.read()).rejects.toThrow(); await chmod(directory, 0o700);
    const actual = join(directory, 'actual'); await mkdir(actual, { mode: 0o700 }); const alias = join(directory, 'alias'); await symlink(actual, alias);
    await expect(create(kind, join(alias, 'state.json')).initializeFresh()).rejects.toThrow();
  });
  it('serializes writers and leaves original bytes intact when an in-memory mutation fails', async () => {
    await ledger.initializeFresh(); await hold(ledger); const original = await readFile(path);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    const first = ledger.transact(async () => { entered(); await waiting; });
    await inside; await expect(create(kind, path).transact(() => true)).rejects.toThrow('locked');
    release(); await first; expect(await readFile(path)).toEqual(original);
    await expect(ledger.transact(file => { file.records.length = 0; throw new Error('local validation refusal'); })).rejects.toThrow('local validation refusal');
    expect(await readFile(path)).toEqual(original); await ledger.transact(() => undefined);
    expect((await readdir(directory)).sort()).toEqual(['journal.json', 'journal.json.initialized']);
  });
  it('retains the original hold and writer lock when directory durability fails after rename', async () => {
    await ledger.initializeFresh(); await hold(ledger);
    const journal = (ledger as unknown as { journal: { syncDirectory(): Promise<void> } }).journal;
    const sync = journal.syncDirectory.bind(journal); let calls = 0;
    vi.spyOn(journal, 'syncDirectory').mockImplementation(async () => { if (++calls === 2) throw new Error('injected directory fsync failure'); await sync(); });
    await expect(ledger.transact(file => { file.records[0]!.reason = 'durability outcome unknown'; })).rejects.toThrow('directory fsync failure');
    expect((await ledger.read()).records[0]).toMatchObject({ runId, reservedUsdcMicros: '1000000', reason: 'durability outcome unknown' });
    expect((await lstat(path + '.lock')).isFile()).toBe(true);
    await expect(create(kind, path).transact(() => true)).rejects.toThrow('locked');
  });
  it('does not overwrite an externally replaced file or remove a replaced writer lock', async () => {
    await ledger.initializeFresh(); await hold(ledger); const original = await readFile(path);
    await expect(ledger.transact(async () => { await writeFile(path, original); })).rejects.toThrow('changed before commit');
    expect(await readFile(path)).toEqual(original); expect((await lstat(path + '.lock')).isFile()).toBe(true);
    // Explicit fixture-only lock recovery; no production age-based recovery exists.
    await unlink(path + '.lock');
    await expect(ledger.transact(async file => { file.records[0]!.reason = 'must not publish'; await unlink(path + '.lock'); await writeFile(path + '.lock', 'replacement writer', { mode: 0o600 }); }))
      .rejects.toThrow('writer lock changed');
    expect(await readFile(path + '.lock', 'utf8')).toBe('replacement writer');
    expect((await ledger.read()).records[0]).toMatchObject({ runId, reservedUsdcMicros: '1000000', reason: null });
  });
});

describe('private supplier shared reserve identity and unknown commit', () => {
  let directory: string, akash: FileSupplierLedger, nosana: FileNosanaLedger, lockPath: string;
  const shared = (ceiling = '1500000', other = nosana) => new FileSupplierSharedReserve({ lockPath, akash, nosana: other, maxOpenReservedUsdcMicros: ceiling });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-private-shared-')); lockPath = join(directory, 'shared.lock');
    akash = new FileSupplierLedger(join(directory, 'akash.json')); nosana = new FileNosanaLedger(join(directory, 'nosana.json'));
    await akash.initializeFresh(); await nosana.initializeFresh();
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const candidate = { network: 'akash' as const, owner, runId, reservedUsdcMicros: '1000000' };
  it('requires explicit shared initialization and pins the original paths and ceiling', async () => {
    let called = false; await expect(shared().admit(candidate, async () => { called = true; })).rejects.toThrow(); expect(called).toBe(false);
    await shared().initializeFresh();
    await expect(shared('2000000').admit(candidate, async () => true)).rejects.toThrow('identity differs');
    const peer = new FileNosanaLedger(join(directory, 'other-nosana.json')); await peer.initializeFresh();
    await expect(shared('1500000', peer).admit(candidate, async () => true)).rejects.toThrow('identity differs');
    await unlink(lockPath + '.state'); await expect(shared().admit(candidate, async () => true)).rejects.toThrow();
    await expect(shared().initializeFresh()).rejects.toThrow('already exists');
  });
  it('retains a callback-committed liability and the shared lock after response loss', async () => {
    await shared().initializeFresh();
    await expect(shared().admit(candidate, async () => { await hold(akash); throw new Error('local response lost'); })).rejects.toThrow('local response lost');
    expect((await akash.read()).records[0]).toMatchObject({ runId, reservedUsdcMicros: '1000000' });
    expect((await lstat(lockPath)).isFile()).toBe(true);
    await expect(shared().admit({ ...candidate, runId: hash('b') }, async () => true)).rejects.toMatchObject({ code: 'supplier_shared_reserve_locked' });
  });
  it.each(['akash', 'nosana'] as const)('rejects a freshly reinitialized %s peer pair while original shared state survives', async kind => {
    await shared().initializeFresh(); const peer = kind === 'akash' ? akash : nosana;
    await hold(peer); const generation = await peer.initializationGeneration();
    // Destructive fixture-only action, explicitly unsupported as liability recovery.
    await unlink(peer.path); await unlink(peer.path + '.initialized'); await peer.initializeFresh();
    expect(await peer.initializationGeneration()).not.toBe(generation);
    let called = false;
    await expect(shared().admit(candidate, async () => { called = true; })).rejects.toThrow('generation differs');
    expect(called).toBe(false); await expect(shared().initializeFresh()).rejects.toThrow('already exists');
  });
  it('releases only a known unchanged local refusal and refuses a deleted peer before admission', async () => {
    await shared().initializeFresh();
    await expect(shared().admit(candidate, async () => { throw new Error('known validation refusal'); })).rejects.toThrow('known validation refusal');
    await shared().admit(candidate, async () => hold(akash));
    await unlink(nosana.path); let called = false;
    await expect(shared().admit({ ...candidate, runId: hash('b'), reservedUsdcMicros: '1' }, async () => { called = true; })).rejects.toThrow();
    expect(called).toBe(false); expect((await akash.read()).records[0]?.reservedUsdcMicros).toBe('1000000');
  });
  it('rejects all journal/marker/lock path aliases before any filesystem mutation', () => {
    expect(() => new FileSupplierSharedReserve({ lockPath: akash.path + '.lock', akash, nosana,
      maxOpenReservedUsdcMicros: '1500000' })).toThrow('overlap');
    expect(() => new FileSupplierSharedReserve({ lockPath, akash, nosana: new FileNosanaLedger(akash.path),
      maxOpenReservedUsdcMicros: '1500000' })).toThrow('overlap');
  });
});
