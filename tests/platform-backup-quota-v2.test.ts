import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { cystQuotaPolicySchema } from '../src/cysts/quota-types.js';
import { cystMigrationSQL, cystOwners, cystQuotaV2MigrationSQL, cysts } from '../src/cysts/schema.js';
import { cystObjectKey } from '../src/cysts/s3.js';
import { readBackupCystQuotaPolicy } from '../src/operator/backup.js';
import { verifyPlatformSmallCysts } from '../src/operator/platform-backup.js';
import { encryptCheckpoint } from '../src/sdk/cysts.js';
import { storeSchema } from '../src/store.js';

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const owner = '0x' + '11'.repeat(20);

it('verifies 513 paid checkpoint replicas with explicit reviewed quota in real read-only SQL and sends GETs only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-paid-backup-quota-'));
  const database = new PGlite(), servers: Server[] = [];
  const encrypted: Awaited<ReturnType<typeof encryptCheckpoint>>[] = [];
  const objects = new Map<string, { bytes: Buffer; digest: string }>();
  const observed: { method: string; path: string }[] = [];
  let corruptSecond = false;
  try {
    const endpoints: string[] = [];
    for (let replica = 0; replica < 2; replica++) {
      const server = createServer((request, response) => {
        const method = request.method ?? '', path = request.url ?? '';
        observed.push({ method, path });
        const object = objects.get(path);
        if (method !== 'GET' || !object) { response.writeHead(405); response.end(); return; }
        if (!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=')) {
          response.writeHead(403); response.end(); return;
        }
        const bytes = Buffer.from(object.bytes);
        if (replica === 1 && corruptSecond) bytes[0] = (bytes[0] ?? 0) ^ 1;
        response.writeHead(200, { 'content-length': String(bytes.length), 'x-amz-meta-telomere-version': '1',
          'x-amz-meta-telomere-owner': sha('telomere-cyst-owner:' + owner),
          'x-amz-meta-telomere-sha256': object.digest, 'x-amz-meta-telomere-bytes': String(bytes.length) });
        response.end(bytes);
      });
      servers.push(server);
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing replica test port');
      endpoints.push('http://127.0.0.1:' + address.port);
    }
    const topologyPath = join(directory, 'topology.json'), quotaPath = join(directory, 'quota.json');
    await writeFile(topologyPath, JSON.stringify({ version: 1, destinations: endpoints.map((endpoint, index) => ({
      endpoint, bucket: 'checkpoint-bucket', region: index === 0 ? 'us-east-1' : 'eu-west-1',
      failureDomain: 'local-independent-fixture-' + index, reviewed: true, allowInsecureLoopback: true,
      credentials: { accessKeyId: 'LOCALTESTACCESS000001', secretAccessKey: 'fixture-only-storage-secret-123456789' },
    })) }), { mode: 0o600 });
    const quotaPolicy = cystQuotaPolicySchema.parse({ version: 2, kind: 'telomere-cyst-quota-v2',
      maxOwnerCheckpoints: 4096, maxOwnerBytes: 33554432 });
    const policyBytes = Buffer.from(JSON.stringify(quotaPolicy)); await writeFile(quotaPath, policyBytes, { mode: 0o600 });
    const config = loadConfig({ MODE: 'demo', ESCROW_ADDRESS: owner, TOKEN_ADDRESS: '0x' + '22'.repeat(20),
      SIGNER_PRIVATE_KEY: '0x' + '33'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '44'.repeat(32),
      CYSTS_ENABLED: 'true', CYSTS_REPLICATION_CONFIG: topologyPath,
      CYSTS_QUOTA_POLICY_PATH: quotaPath, CYSTS_QUOTA_POLICY_SHA256: sha(policyBytes) });
    const reviewedPolicy = await readBackupCystQuotaPolicy(config); if (!reviewedPolicy) throw new Error('Missing reviewed test policy');
    await database.exec(cystMigrationSQL + cystQuotaV2MigrationSQL);
    const db = drizzle(database, { schema: storeSchema, casing: 'snake_case' });
    const records: (typeof cysts.$inferInsert)[] = [];
    let bytes = 0;
    for (let index = 0; index < 513; index++) {
      const checkpoint = await encryptCheckpoint(Buffer.from(JSON.stringify({ index })), { owner, applicationSchema: 'paid.backup.quota2.v1' });
      encrypted.push(checkpoint); const envelope = checkpoint.envelope, ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      objects.set('/checkpoint-bucket/' + cystObjectKey(owner, envelope.sha256), { bytes: ciphertext, digest: envelope.sha256 });
      bytes += ciphertext.length;
      records.push({ owner, id: envelope.id, agent: envelope.agent, idemKey: 'paid-backup-' + index, requestHash: sha('request-' + index),
        version: envelope.version, algorithm: envelope.algorithm, applicationSchema: envelope.applicationSchema,
        plaintextBytes: envelope.plaintextBytes, nonce: envelope.nonce, sha256: envelope.sha256,
        ciphertextBytes: ciphertext.length, state: 'ready' });
    }
    await db.insert(cystOwners).values({ owner, usedBytes: bytes, checkpoints: records.length });
    await db.insert(cysts).values(records);
    const before = await database.query('SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint ORDER BY conname,definition');
    // REASON: the verifier uses only pg.ClientBase.query(text); PGlite executes
    // the same parameterized SELECTs against the actual PostgreSQL engine.
    const client = database as unknown as pg.ClientBase;
    await database.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      expect((await database.query<{ transaction_read_only: string }>('SHOW transaction_read_only')).rows[0]?.transaction_read_only).toBe('on');
      await expect(verifyPlatformSmallCysts(client, config)).rejects.toThrow('exceeds the reviewed profile');
      expect(observed).toHaveLength(0);
      await expect(verifyPlatformSmallCysts(client, config, { quotaPolicy: JSON.parse(JSON.stringify({ ...reviewedPolicy, version: 1 })) }))
        .rejects.toThrow();
      expect(observed).toHaveLength(0);
      expect(await verifyPlatformSmallCysts(client, config, { quotaPolicy: reviewedPolicy })).toMatchObject({ records: 513, bytes });
      expect(observed).toHaveLength(1026);
      expect(observed.every(request => request.method === 'GET')).toBe(true);
      corruptSecond = true;
      await expect(verifyPlatformSmallCysts(client, config, { quotaPolicy: reviewedPolicy })).rejects.toThrow();
      expect(observed.every(request => request.method === 'GET')).toBe(true);
    } finally { await database.exec('ROLLBACK'); }
    expect(await database.query('SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint ORDER BY conname,definition')).toEqual(before);
    expect((await db.select().from(cystOwners))[0]).toMatchObject({ owner, usedBytes: bytes, checkpoints: 513 });
    expect((await db.select().from(cysts)).every(record => record.state === 'ready')).toBe(true);
  } finally {
    for (const checkpoint of encrypted) checkpoint.recoveryKey.fill(0);
    for (const server of servers) {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    }
    await database.close();
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-paid-backup-quota-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 90_000);
