import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { Problem } from '../src/common.js';
import { readCystQuotaPolicy } from '../src/cysts/quota.js';
import { cystQuotaPolicySchema } from '../src/cysts/quota-types.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { cystOwners } from '../src/cysts/schema.js';
import { CystService } from '../src/cysts/service.js';
import { CYST_CAPABILITIES } from '../src/cysts/types.js';
import { CystClient, encryptCheckpoint } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { openStore } from '../src/store.js';

const owner = '0x' + '11'.repeat(20), other = '0x' + '22'.repeat(20);
const policy = cystQuotaPolicySchema.parse({ version: 2, kind: 'telomere-cyst-quota-v2', maxOwnerCheckpoints: 4096, maxOwnerBytes: 33554432 });

it('negotiates an explicitly reviewed quota, retains 960 actual HTTP checkpoints, and atomically fences count/byte exhaustion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-quota-v2-')), store = await openStore({ DATA_DIR: ':memory:' });
  let server: Server | undefined;
  try {
    // The default database constraint and published client profile remain512.
    await expect(store.db.execute(sql`INSERT INTO cyst_owners(owner,checkpoints) VALUES (${other},513)`)).rejects.toThrow();
    const service = new CystService(store.db, join(directory, 'ciphertext'), { quotaPolicy: policy }); await service.initialize();
    const app = new Hono(); app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : 422));
    app.route('/api/cysts', createCystRoutes(service, async () => owner));
    server = createServer(getRequestListener(app.fetch)); await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
    const transport = new ApiTransport('http://127.0.0.1:' + address.port), legacy = new CystClient(transport), client = new CystClient(transport, { quotaVersion: 2 });
    for (const path of ['/api/me', '/api/cysts-evil', '/api/cysts/../../platform', '/api/cysts/%2e%2e/platform']) {
      await expect(transport.request(path, { cystQuotaVersion: 2 })).rejects.toThrow('restricted to Cyst');
    }
    expect(await legacy.capabilities()).toEqual(CYST_CAPABILITIES);
    expect((await client.capabilities()).maxOwnerCheckpoints).toBe(4096);
    const records: Awaited<ReturnType<typeof encryptCheckpoint>>[] = [];
    try {
      for (let index = 0; index < 960; index++) {
        const encrypted = await encryptCheckpoint(Buffer.from(JSON.stringify({ index })), { owner, applicationSchema: 'quota.counter.v1' });
        records.push(encrypted); await client.upload(encrypted.envelope, 'quota-http-' + index);
      }
      expect((await client.list()).usage.checkpoints).toBe(960);
      await expect(legacy.list()).rejects.toThrow('cyst_quota_profile_required');
      expect((await client.upload(records[0]!.envelope, 'quota-http-0')).replayed).toBe(true);
      expect((await client.list()).usage.checkpoints).toBe(960);
      for (const index of [0, 479, 959]) expect(JSON.parse(Buffer.from(await client.restore(records[index]!.envelope.id,
        records[index]!.recoveryKey, { owner })).toString())).toEqual({ index });
      const extra = await encryptCheckpoint(Buffer.from('last-slot'), { owner, applicationSchema: 'quota.counter.v1' });
      try { await expect(legacy.upload(extra.envelope, 'legacy-over-512')).rejects.toThrow('cyst_quota_exceeded'); }
      finally { extra.recoveryKey.fill(0); }
    } finally { for (const record of records) record.recoveryKey.fill(0); }
    // A fixture owner at the final reserved slot exercises the real SQL lock;
    // only one of two concurrent new ciphertexts may reserve that slot.
    await store.db.insert(cystOwners).values({ owner: other, checkpoints: 4095, usedBytes: 0 });
    const a = await encryptCheckpoint(Buffer.from('a'), { owner: other, applicationSchema: 'quota.counter.v1' });
    const b = await encryptCheckpoint(Buffer.from('b'), { owner: other, applicationSchema: 'quota.counter.v1' });
    try {
      const outcomes = await Promise.allSettled([service.upload(other, a.envelope, 'final-slot-a', 2), service.upload(other, b.envelope, 'final-slot-b', 2)]);
      expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
      const [usage] = await store.db.select().from(cystOwners).where(eq(cystOwners.owner, other)); expect(usage?.checkpoints).toBe(4096);
      await expect(store.db.update(cystOwners).set({ checkpoints: 4097 }).where(eq(cystOwners.owner, other))).rejects.toThrow();
      await store.db.update(cystOwners).set({ checkpoints: 1, usedBytes: 33554432 }).where(eq(cystOwners.owner, other));
      const c = await encryptCheckpoint(Buffer.from('c'), { owner: other, applicationSchema: 'quota.counter.v1' });
      try { await expect(service.upload(other, c.envelope, 'byte-cap-new', 2)).rejects.toMatchObject({ code: 'cyst_quota_exceeded' }); }
      finally { c.recoveryKey.fill(0); }
    } finally { a.recoveryKey.fill(0); b.recoveryKey.fill(0); }
    const disabled = new CystService(store.db, join(directory, 'disabled')); await disabled.initialize();
    expect(() => disabled.capabilities(2)).toThrow('not enabled');
  } finally {
    if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
    await store.close(); const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-quota-v2-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 180_000);

it('reads only an exact hash-pinned private operator policy and rejects unreviewed policy fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-quota-v2-')), path = join(directory, 'policy.json');
  try {
    const bytes = Buffer.from(JSON.stringify(policy)); await writeFile(path, bytes, { mode: 0o600 });
    const hash = createHash('sha256').update(bytes).digest('hex'); expect(await readCystQuotaPolicy(path, hash)).toEqual(policy);
    await expect(readCystQuotaPolicy(path, '0'.repeat(64))).rejects.toThrow('reviewed hash');
    await writeFile(path, JSON.stringify({ ...policy, maxOwnerBytes: 67108864 }), { mode: 0o600 });
    await expect(readCystQuotaPolicy(path, hash)).rejects.toThrow('reviewed hash');
    const unreviewed = Buffer.from(JSON.stringify({ ...policy, unexpected: true })); await writeFile(path, unreviewed, { mode: 0o600 });
    await expect(readCystQuotaPolicy(path, createHash('sha256').update(unreviewed).digest('hex'))).rejects.toThrow('reviewed hash');
    await writeFile(path, Buffer.alloc(8192), { mode: 0o600 });
    await expect(readCystQuotaPolicy(path, hash)).rejects.toThrow('reviewed hash');
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-quota-v2-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
