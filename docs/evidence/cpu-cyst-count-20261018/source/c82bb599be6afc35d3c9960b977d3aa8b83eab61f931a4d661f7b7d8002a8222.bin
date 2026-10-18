import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { CYST_BACKUP_CAPACITY } from '../src/cysts/capacity.js';
import { configuredCysts } from '../src/cysts/configured.js';
import { CystService } from '../src/cysts/service.js';
import { cystOwners, cysts } from '../src/cysts/schema.js';
import { encryptCheckpoint } from '../src/sdk/cysts.js';

const owner = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
let folder: string, store: Awaited<ReturnType<typeof openStore>>;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'cyst-count-')); store = await openStore({ DATA_DIR: ':memory:' }); });
afterEach(async () => { vi.restoreAllMocks(); await store.close(); await rm(folder, { recursive: true, force: true }); });
const encrypted = (address = owner) => encryptCheckpoint(new Uint8Array([7]), { owner: address, applicationSchema: 'count.v1' });

it('shares the 50,000-member recovery budget and refuses an operator override above its reserved Cyst slots', () => {
  expect(CYST_BACKUP_CAPACITY.globalCheckpoints + CYST_BACKUP_CAPACITY.reservedMembers).toBe(50_000);
  const environment = { ESCROW_ADDRESS: owner, TOKEN_ADDRESS: other, SIGNER_PRIVATE_KEY: '0x' + '1'.repeat(64), DEMO_PRIVATE_KEY: '0x' + '2'.repeat(64) };
  expect(loadConfig(environment).CYSTS_GLOBAL_CHECKPOINTS).toBe(49_000);
  for (const limit of ['0', '49001', '1.5']) expect(() => loadConfig({ ...environment, CYSTS_GLOBAL_CHECKPOINTS: limit })).toThrow();
  for (const limit of [0, 49_001, 1.5, Number.NaN]) expect(() => new CystService(store.db, folder, { globalCheckpoints: limit })).toThrow();
});

it('applies configured count admission across owners while retaining reads and exact idempotent replay at capacity', async () => {
  const config = loadConfig({ ESCROW_ADDRESS: owner, TOKEN_ADDRESS: other, SIGNER_PRIVATE_KEY: '0x' + '1'.repeat(64),
    DEMO_PRIVATE_KEY: '0x' + '2'.repeat(64), CYSTS_ENABLED: 'true', CYSTS_DIR: folder, CYSTS_GLOBAL_CHECKPOINTS: '1', WALLET_ACCESS: 'public' });
  const service = await configuredCysts(store.db, config); if (!service) throw new Error('Missing fixture Cysts'); await service.initialize();
  const first = await encrypted(), next = await encrypted(other);
  await service.upload(owner, first.envelope, 'first-count-checkpoint');
  await expect(service.upload(other, next.envelope, 'overflow-count-checkpoint')).rejects.toMatchObject({ code: 'cyst_global_checkpoint_capacity' });
  expect((await service.upload(owner, first.envelope, 'first-count-checkpoint')).replayed).toBe(true);
  expect((await service.download(owner, first.envelope.id)).ciphertext).toBe(first.envelope.ciphertext);
  expect(await store.db.select().from(cystOwners)).toHaveLength(1);
});

it('counts a pending reservation once and permits its original retry after another owner fills the final slot', async () => {
  const service = new CystService(store.db, folder, { globalCheckpoints: 2 }); await service.initialize();
  const pending = await encrypted(), next = await encrypted(other);
  vi.spyOn(service.storage, 'put').mockRejectedValueOnce(new Error('fixture interruption'));
  await expect(service.upload(owner, pending.envelope, 'pending-count-checkpoint')).rejects.toThrow('fixture interruption');
  await service.upload(other, next.envelope, 'last-count-checkpoint');
  const restarted = new CystService(store.db, folder, { globalCheckpoints: 2 }); await restarted.initialize();
  expect((await restarted.upload(owner, pending.envelope, 'pending-count-checkpoint')).replayed).toBe(true);
  expect((await restarted.download(owner, pending.envelope.id)).ciphertext).toBe(pending.envelope.ciphertext);
  expect(await store.db.select().from(cysts)).toHaveLength(2);
  expect((await store.db.select().from(cystOwners)).reduce((sum, row) => sum + row.checkpoints, 0)).toBe(2);
  const extra = await encrypted(); await expect(restarted.upload(owner, extra.envelope, 'after-restart-overflow')).rejects.toMatchObject({ code: 'cyst_global_checkpoint_capacity' });
});

it('serializes concurrent reservations across service instances at the final global slots', async () => {
  const a = new CystService(store.db, folder, { globalCheckpoints: 2 }), b = new CystService(store.db, folder, { globalCheckpoints: 2 });
  await a.initialize(); await b.initialize();
  const items = await Promise.all(Array.from({ length: 8 }, (_, index) => encrypted('0x' + (index + 1).toString(16).padStart(40, '0'))));
  const results = await Promise.allSettled(items.map((item, index) => (index % 2 ? a : b).upload(item.envelope.owner, item.envelope, 'parallel-count-' + index)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
  for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'cyst_global_checkpoint_capacity' });
  expect(await store.db.select().from(cysts)).toHaveLength(2); expect(await readdir(folder)).toHaveLength(2);
});

it('rejects new reservations before any metadata or file write when the shared admission lock is missing', async () => {
  const service = new CystService(store.db, folder); await service.initialize();
  await store.db.execute(sql`DELETE FROM quote_admission_lock WHERE id = 1`);
  const item = await encrypted(); await expect(service.upload(owner, item.envelope, 'missing-admission-lock')).rejects.toMatchObject({ code: 'cyst_storage_unavailable' });
  expect(await store.db.select().from(cystOwners)).toHaveLength(0); expect(await readdir(folder)).toHaveLength(0);
});
