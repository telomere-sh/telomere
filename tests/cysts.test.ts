import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Problem } from '../src/common.js';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { Service } from '../src/service.js';
import { openStore } from '../src/store.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { cystMigrationSQL, cystOwners, cysts } from '../src/cysts/schema.js';
import { CystService } from '../src/cysts/service.js';
import { PrivateCystStorage } from '../src/cysts/storage.js';
import { CYST_CAPABILITIES, type CystEnvelope } from '../src/cysts/types.js';
import { CystClient, decryptCheckpoint, encryptCheckpoint, exportCystRecoveryKey, generateCystRecoveryKey, importCystRecoveryKey } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const agent = '0x3333333333333333333333333333333333333333';
const origin = 'http://127.0.0.1:3280';
const plaintext = new TextEncoder().encode('{"counter":42,"privateMemory":"client-only-sentinel-value"}');
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function changedBytes(envelope: CystEnvelope): CystEnvelope {
  const bytes = Buffer.from(envelope.ciphertext, 'base64'); bytes[0] = (bytes[0] ?? 0) ^ 1;
  return { ...envelope, ciphertext: bytes.toString('base64'), sha256: digest(bytes) };
}

describe('bounded encrypted application Cysts', () => {
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, service: CystService, app: Hono;
  let authenticatedOwner: string;
  const encrypted = () => encryptCheckpoint(plaintext, { owner, agent, applicationSchema: 'counter.v1' });
  function mounted(cystService: CystService): Hono {
    const router = new Hono();
    router.use('/api/*', async (context, next) => {
      if (!['GET', 'HEAD'].includes(context.req.method)) {
        if (context.req.header('Origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Invalid origin.');
        if (!context.req.header('Content-Type')?.startsWith('application/json')) throw new Problem(400, 'json_required', 'Send JSON.');
      }
      await next();
    });
    router.onError((error, context) => {
      const status = error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503;
      return context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, status);
    });
    router.route('/api/cysts', createCystRoutes(cystService, async () => {
      if (!authenticatedOwner) throw new Problem(401, 'unauthorized', 'Sign in.'); return authenticatedOwner;
    }));
    return router;
  }
  const upload = (envelope: unknown, key = 'checkpoint-upload-1') => app.request('/api/cysts', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(envelope) });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-cysts-'));
    store = await openStore({ DATA_DIR: ':memory:' });
    for (const statement of cystMigrationSQL.split(';').map(item => item.trim()).filter(Boolean)) await store.db.execute(sql.raw(statement));
    service = new CystService(store.db, join(directory, 'ciphertext'));
    await service.initialize(); authenticatedOwner = owner; app = mounted(service);
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); await rm(directory, { recursive: true, force: true }); });

  it('encrypts in the client, uploads opaque ciphertext, downloads and restores portable state', async () => {
    const { envelope, recoveryKey } = await encrypted();
    const capturedBodies: string[] = [];
    const transport = new ApiTransport(origin, { fetch: async (url, init) => {
      if (typeof init.body === 'string') capturedBodies.push(init.body);
      return app.request(new URL(url).pathname + new URL(url).search, init);
    } });
    const client = new CystClient(transport);
    expect(await client.capabilities()).toEqual(CYST_CAPABILITIES);
    expect((await client.upload(envelope, 'portable-upload-1')).checkpoint.state).toBe('ready');
    const downloaded = await client.download(envelope.id, { owner, agent });
    await expect(client.download(envelope.id, { owner: other })).rejects.toThrow('scope changed');
    await expect(client.download(envelope.id, { owner, agent: other })).rejects.toThrow('scope changed');
    const secondClientDirectory = join(directory, 'different-client');
    // A standalone envelope can be saved by a separate client without server filesystem access.
    await writeFile(secondClientDirectory, JSON.stringify(downloaded), { mode: 0o600 });
    const restored = await decryptCheckpoint(JSON.parse(await readFile(secondClientDirectory, 'utf8')), importCystRecoveryKey(exportCystRecoveryKey(recoveryKey)));
    expect(restored).toEqual(plaintext);
    expect(await client.restore(envelope.id, recoveryKey, { owner, agent })).toEqual(plaintext);
    const files = await readdir(service.privateDirectory);
    expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[0-9a-f]{64}\.blob$/);
    const stored = await readFile(join(service.privateDirectory, files[0] ?? 'missing'));
    expect(stored.toString('base64')).toBe(envelope.ciphertext);
    for (const body of capturedBodies) {
      expect(body).not.toContain(new TextDecoder().decode(plaintext)); expect(body).not.toContain(exportCystRecoveryKey(recoveryKey));
      expect(body).not.toContain('recoveryKey');
    }
    expect(JSON.stringify(await service.list(owner))).not.toContain(exportCystRecoveryKey(recoveryKey));
    expect((await client.list({ agent })).checkpoints).toHaveLength(1);
    expect((await client.metadata(envelope.id)).id).toBe(envelope.id);
  });

  it('uses independent random recovery keys and fresh 24-byte nonces', async () => {
    const first = await encrypted(), second = await encrypted();
    expect(first.recoveryKey).toHaveLength(32); expect(first.envelope.nonce).toHaveLength(48);
    expect(first.recoveryKey).not.toEqual(second.recoveryKey); expect(first.envelope.nonce).not.toBe(second.envelope.nonce);
    expect(first.envelope.id).not.toBe(second.envelope.id);
    await expect(decryptCheckpoint(first.envelope, second.recoveryKey)).rejects.toThrow('authentication failed');
    expect(importCystRecoveryKey(exportCystRecoveryKey(first.recoveryKey))).toEqual(first.recoveryKey);
    expect(() => importCystRecoveryKey('invalid')).toThrow(); expect(() => exportCystRecoveryKey(new Uint8Array(31))).toThrow();
  });

  it('preserves caller-owned recovery keys across repeated restores, exports and failure paths', async () => {
    const callerKey = generateCystRecoveryKey(), original = Uint8Array.from(callerKey);
    const prepared = await encryptCheckpoint(plaintext, { owner, agent, applicationSchema: 'counter.v1' }, callerKey);
    expect(prepared.recoveryKey).not.toBe(callerKey); expect(prepared.recoveryKey).toEqual(original);
    const code = exportCystRecoveryKey(callerKey); expect(importCystRecoveryKey(code)).toEqual(original);
    for (let attempt = 0; attempt < 2; attempt++) expect(await decryptCheckpoint(prepared.envelope, callerKey)).toEqual(plaintext);
    await expect(decryptCheckpoint(changedBytes(prepared.envelope), callerKey)).rejects.toThrow('authentication failed');
    await expect(decryptCheckpoint({ ...prepared.envelope, sha256: 'ff'.repeat(32) }, callerKey)).rejects.toThrow('integrity check');
    await expect(encryptCheckpoint(plaintext, { owner: 'invalid', applicationSchema: 'counter.v1' }, callerKey)).rejects.toThrow();
    await expect(encryptCheckpoint(plaintext, { owner, applicationSchema: '../invalid' }, callerKey)).rejects.toThrow();
    expect(callerKey).toEqual(original); expect(prepared.recoveryKey).toEqual(original);
    expect(await decryptCheckpoint(prepared.envelope, prepared.recoveryKey)).toEqual(plaintext);
  });

  it('validates combined agent/cursor queries and rejects list responses that change their scope', async () => {
    const { envelope } = await encrypted(); await service.upload(owner, envelope, 'list-scope-upload');
    const cursor = '0x' + '00'.repeat(32);
    const requests: string[] = [];
    const client = new CystClient(new ApiTransport(origin, { fetch: async (url, init) => {
      const parsed = new URL(url); requests.push(parsed.search); return app.request(parsed.pathname + parsed.search, init);
    } }));
    expect((await client.list({ agent, cursor })).checkpoints).toHaveLength(1);
    expect(requests[0]).toContain('&cursor=');
    const response = await service.list(owner, { agent, cursor });
    const scopedClient = (value: unknown) => new CystClient(new ApiTransport(origin, { fetch: async () => new Response(JSON.stringify(value),
      { headers: { 'Content-Type': 'application/json' } }) }));
    await expect(scopedClient({ ...response, checkpoints: response.checkpoints.map(item => ({ ...item, agent: other })) }).list({ agent, cursor }))
      .rejects.toThrow('requested agent or cursor');
    await expect(scopedClient(response).list({ cursor: envelope.id })).rejects.toThrow('requested agent or cursor');
    await expect(scopedClient({ ...response, nextCursor: envelope.id }).list({ agent, cursor })).rejects.toThrow('continuation cursor');
  });

  it.each(['owner', 'agent', 'id', 'nonce', 'applicationSchema'] as const)('authenticates %s as AEAD context', async field => {
    const { envelope, recoveryKey } = await encrypted();
    const replacement = field === 'nonce' ? 'dd'.repeat(24) : field === 'id' ? '0x' + 'ee'.repeat(32)
      : field === 'applicationSchema' ? 'changed.v2' : other;
    await expect(decryptCheckpoint({ ...envelope, [field]: replacement }, recoveryKey)).rejects.toThrow('authentication failed');
  });

  it('rejects tampered ciphertext even if its public digest was recomputed', async () => {
    const { envelope, recoveryKey } = await encrypted();
    await expect(decryptCheckpoint(changedBytes(envelope), recoveryKey)).rejects.toThrow('authentication failed');
    await expect(decryptCheckpoint({ ...envelope, sha256: 'aa'.repeat(32) }, recoveryKey)).rejects.toThrow('integrity check');
  });

  it('enforces owner access on metadata, blobs, lists and uploads without revealing another tenant', async () => {
    const { envelope } = await encrypted(); expect((await upload(envelope)).status).toBe(201);
    authenticatedOwner = other;
    for (const suffix of [envelope.id, envelope.id + '/blob']) expect((await app.request('/api/cysts/' + suffix)).status).toBe(404);
    expect((await (await app.request('/api/cysts')).json()).checkpoints).toEqual([]);
    expect((await upload(envelope)).status).toBe(403);
    authenticatedOwner = ''; expect((await app.request('/api/cysts/capabilities')).status).toBe(401);
  });

  it('replays exactly one immutable upload and rejects changed idempotent requests or reused nonces', async () => {
    const first = await encrypted(); expect((await upload(first.envelope)).status).toBe(201);
    const replay = await upload(first.envelope); expect(replay.status).toBe(200); expect((await replay.json()).replayed).toBe(true);
    const second = await encrypted(); expect((await upload(second.envelope)).status).toBe(409);
    expect((await upload({ ...first.envelope, id: second.envelope.id }, 'different-idempotency-key')).status).toBe(409);
    expect((await service.list(owner)).usage).toEqual({ bytes: first.envelope.plaintextBytes + 16, checkpoints: 1 });
    expect(await readdir(service.privateDirectory)).toHaveLength(1);
  });

  it('atomically reserves quota under concurrent uploads', async () => {
    const a = await encrypted(), b = await encrypted();
    await store.db.insert(cystOwners).values({ owner, usedBytes: CYST_CAPABILITIES.maxOwnerBytes - (plaintext.byteLength + 16), checkpoints: 1 });
    const responses = await Promise.all([upload(a.envelope, 'concurrent-upload-a'), upload(b.envelope, 'concurrent-upload-b')]);
    expect(responses.map(item => item.status).sort()).toEqual([201, 409]);
    expect((await service.list(owner)).usage.bytes).toBe(CYST_CAPABILITIES.maxOwnerBytes);
    expect(await readdir(service.privateDirectory)).toHaveLength(1);
  });

  it('also bounds tiny checkpoints by record count', async () => {
    await store.db.insert(cystOwners).values({ owner, usedBytes: 0, checkpoints: CYST_CAPABILITIES.maxOwnerCheckpoints });
    const { envelope } = await encrypted(); expect((await upload(envelope)).status).toBe(409);
    expect(await readdir(service.privateDirectory)).toHaveLength(0);
  });

  it('resumes a durable pending reservation after a failed filesystem write without double quota', async () => {
    const { envelope, recoveryKey } = await encrypted();
    const put = vi.spyOn(service.storage, 'put').mockRejectedValueOnce(new Error('Injected private storage outage'));
    expect((await upload(envelope)).status).toBe(503);
    expect(await service.metadata(owner, envelope.id)).toMatchObject({ state: 'pending' });
    expect((await service.list(owner)).checkpoints[0]?.state).toBe('pending');
    await expect(service.download(owner, envelope.id)).rejects.toMatchObject({ code: 'cyst_pending' });
    const restarted = new CystService(store.db, service.privateDirectory); await restarted.initialize(); app = mounted(restarted);
    expect((await upload(envelope)).status).toBe(200);
    expect(await decryptCheckpoint({ ...envelope, ciphertext: (await restarted.download(owner, envelope.id)).ciphertext }, recoveryKey)).toEqual(plaintext);
    expect((await restarted.list(owner)).usage.checkpoints).toBe(1); expect(put).toHaveBeenCalledTimes(1);
  });

  it('recovers a durable blob after the ready database update fails on restart', async () => {
    const { envelope, recoveryKey } = await encrypted();
    await store.db.execute(sql.raw("ALTER TABLE cysts ADD CONSTRAINT injected_ready_outage CHECK (state = 'pending')"));
    expect((await upload(envelope)).status).toBe(503);
    expect(await readdir(service.privateDirectory)).toHaveLength(1);
    await store.db.execute(sql.raw('ALTER TABLE cysts DROP CONSTRAINT injected_ready_outage'));
    const restarted = new CystService(store.db, service.privateDirectory); await restarted.initialize();
    const listed = await restarted.list(owner);
    expect(listed.checkpoints).toHaveLength(1); expect(listed.checkpoints[0]?.state).toBe('ready');
    app = mounted(restarted);
    const freshClient = new CystClient(new ApiTransport(origin, { fetch: async (url, init) => app.request(new URL(url).pathname, init) }));
    const restoredId = (await freshClient.list()).checkpoints[0]?.id;
    if (!restoredId) throw new Error('Recovered checkpoint is missing from the fresh client list');
    // The new client uses only list metadata and its saved recovery key, with no
    // original upload envelope or idempotency key retained in the new client.
    expect(await freshClient.restore(restoredId, recoveryKey, { owner, agent })).toEqual(plaintext);
    expect(await restarted.metadata(owner, envelope.id)).toMatchObject({ state: 'ready' });
    expect((await restarted.download(owner, envelope.id)).ciphertext).toBe(envelope.ciphertext);
    expect((await restarted.list(owner)).usage.checkpoints).toBe(1);
  });

  it('restores metadata and ciphertext together after closing and reopening a persistent store', async () => {
    await store.close(); store = await openStore({ DATA_DIR: join(directory, 'database') });
    for (const statement of cystMigrationSQL.split(';').map(item => item.trim()).filter(Boolean)) await store.db.execute(sql.raw(statement));
    service = new CystService(store.db, join(directory, 'persistent-ciphertext')); await service.initialize();
    const { envelope, recoveryKey } = await encrypted(); await service.upload(owner, envelope, 'persistent-upload');
    await store.close(); store = await openStore({ DATA_DIR: join(directory, 'database') });
    const relocated = join(directory, 'relocated-ciphertext'); await cp(service.privateDirectory, relocated, { recursive: true });
    const restored = new CystService(store.db, relocated); await restored.initialize();
    const blob = await restored.download(owner, envelope.id);
    expect(await decryptCheckpoint({ ...envelope, ciphertext: blob.ciphertext }, recoveryKey)).toEqual(plaintext);
    expect(blob.metadata.state).toBe('ready');
  });

  it('bounds maximum upload and download and leaves the ordinary SDK response cap unchanged', async () => {
    const large = new Uint8Array(CYST_CAPABILITIES.maxPlaintextBytes).fill(7);
    const { envelope, recoveryKey } = await encryptCheckpoint(large, { owner, applicationSchema: 'bytes.v1' });
    const transport = new ApiTransport(origin, { fetch: async (url, init) => app.request(new URL(url).pathname, init) });
    const client = new CystClient(transport); await client.upload(envelope, 'maximum-sized-upload');
    const restored = await client.restore(envelope.id, recoveryKey, { owner });
    expect(restored.byteLength).toBe(large.byteLength); expect(digest(restored)).toBe(digest(large));
    await expect(transport.request('/api/cysts/' + envelope.id + '/blob')).rejects.toMatchObject({ code: 'response_limit' });
    await expect(encryptCheckpoint(new Uint8Array(large.byteLength + 1), { owner, applicationSchema: 'bytes.v1' })).rejects.toThrow('2 MiB');
    const oversized = await app.request('/api/cysts', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: 'x'.repeat(CYST_CAPABILITIES.maxUploadBodyBytes + 1) }); expect(oversized.status).toBe(413);
  });

  it('rejects keys, paths, malformed metadata, changed digests and noncanonical base64 before storage', async () => {
    const { envelope } = await encrypted();
    const inputs = [{ ...envelope, recoveryKey: 'aa'.repeat(32) }, { ...envelope, filename: '../escape' },
      { ...envelope, applicationSchema: '../escape' }, { ...envelope, plaintextBytes: 0 }, { ...envelope, version: 2 },
      { ...envelope, sha256: 'ff'.repeat(32) }, { ...envelope, nonce: 'ab'.repeat(12) }, { ...envelope, ciphertext: 'AAAA====' }];
    for (const input of inputs) expect((await upload(input)).status).toBe(422);
    expect((await service.list(owner)).usage).toEqual({ bytes: 0, checkpoints: 0 });
    expect(await readdir(service.privateDirectory)).toHaveLength(0);
    expect((await app.request('/api/cysts?filename=escape')).status).toBe(422);
  });

  it('detects ciphertext corruption and never overwrites the immutable blob', async () => {
    const { envelope } = await encrypted(); await service.upload(owner, envelope, 'immutable-upload');
    const file = (await readdir(service.privateDirectory))[0]; if (!file) throw new Error('Fixture blob missing');
    const path = join(service.privateDirectory, file); const bytes = await readFile(path); bytes[0] = (bytes[0] ?? 0) ^ 1; await writeFile(path, bytes);
    await expect(service.download(owner, envelope.id)).rejects.toMatchObject({ code: 'cyst_integrity_failed' });
    await expect(service.upload(owner, envelope, 'immutable-upload')).rejects.toMatchObject({ code: 'cyst_integrity_failed' });
    // A pending metadata record must not be promoted by list-based recovery when
    // its committed ciphertext was corrupted while the ready update was missing.
    await store.db.update(cysts).set({ state: 'pending' }).where(and(eq(cysts.owner, owner), eq(cysts.id, envelope.id)));
    await expect(service.list(owner)).rejects.toMatchObject({ code: 'cyst_integrity_failed' });
    const [record] = await store.db.select({ state: cysts.state }).from(cysts).where(and(eq(cysts.owner, owner), eq(cysts.id, envelope.id)));
    expect(record?.state).toBe('pending');
    expect(await readFile(path)).toEqual(bytes);
  });

  it('refuses a replaced storage directory by inode even when the pathname is unchanged', async () => {
    const { envelope } = await encrypted(); await service.upload(owner, envelope, 'directory-replacement');
    const oldPath = service.privateDirectory; await rename(oldPath, oldPath + '-old');
    await cp(oldPath + '-old', oldPath, { recursive: true });
    await expect(service.download(owner, envelope.id)).rejects.toMatchObject({ code: 'cyst_storage_unavailable' });
  });

  it('cleans only bounded private upload temporary files before accepting new requests', async () => {
    const { envelope } = await encrypted(); await service.upload(owner, envelope, 'startup-cleanup-upload');
    const name = '.tmp-12345678-1234-1234-1234-123456789abc';
    await writeFile(join(service.privateDirectory, name), Buffer.from(envelope.ciphertext, 'base64'), { mode: 0o600 });
    const unrelated = '.tmp-unrecognized-name'; await writeFile(join(service.privateDirectory, unrelated), 'leave alone', { mode: 0o600 });
    const restarted = new CystService(store.db, service.privateDirectory); await restarted.initialize();
    const names = await readdir(service.privateDirectory);
    expect(names).not.toContain(name); expect(names).toContain(unrelated);
    expect((await restarted.download(owner, envelope.id)).ciphertext).toBe(envelope.ciphertext);
  });

  it.skipIf(process.platform === 'win32')('enforces private POSIX modes and rejects symlink blobs or roots', async () => {
    const { envelope } = await encrypted(); await service.upload(owner, envelope, 'private-modes-upload');
    const file = (await readdir(service.privateDirectory))[0]; if (!file) throw new Error('Fixture blob missing');
    expect((await stat(service.privateDirectory)).mode & 0o077).toBe(0);
    const path = join(service.privateDirectory, file); expect((await stat(path)).mode & 0o077).toBe(0);
    await chmod(path, 0o644); await expect(service.download(owner, envelope.id)).rejects.toMatchObject({ code: 'cyst_storage_unavailable' });
    await chmod(path, 0o600); const target = path + '.original'; await rename(path, target); await symlink(target, path);
    await expect(service.download(owner, envelope.id)).rejects.toMatchObject({ code: 'cyst_storage_unavailable' });
    const linkedDirectory = join(directory, 'linked-root'); await symlink(service.privateDirectory, linkedDirectory);
    await expect(new PrivateCystStorage(linkedDirectory).initialize()).rejects.toMatchObject({ code: 'cyst_storage_unavailable' });
    await symlink(target, join(service.privateDirectory, '.tmp-12345678-1234-1234-1234-123456789abc'));
    await expect(new PrivateCystStorage(service.privateDirectory).initialize()).rejects.toMatchObject({ code: 'cyst_storage_unavailable' });
  });

  it('never discloses idempotency or internal storage paths through public metadata', async () => {
    const { envelope } = await encrypted(); await service.upload(owner, envelope, 'private-idem-key');
    const value = JSON.stringify(await service.metadata(owner, envelope.id));
    for (const hidden of ['idemKey', 'requestHash', service.privateDirectory, 'private-idem-key', 'recoveryKey']) expect(value).not.toContain(hidden);
    const [row] = await store.db.select().from(cysts).where(and(eq(cysts.owner, owner), eq(cysts.id, envelope.id)));
    expect(row?.requestHash).toMatch(/^[0-9a-f]{64}$/); expect(generateCystRecoveryKey()).toHaveLength(32);
  });

  it('uses real createApp authentication and origin guards, changing body limits only for mounted Cysts', async () => {
    const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin,
      SIGNER_PRIVATE_KEY: '0x' + '11'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '22'.repeat(32),
      ESCROW_ADDRESS: '0x4444444444444444444444444444444444444444', TOKEN_ADDRESS: '0x5555555555555555555555555555555555555555' });
    const bridge = new ChainBridge(config), auth = new Auth(store.db, config), core = new Service(store.db, bridge, config, false);
    const actual = createApp(core, auth, pino({ enabled: false }), './dist/public', undefined, service);
    const session = await auth.session(owner);
    const headers = { Cookie: 'telomere_session=' + session, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'actual-mount-upload' };
    expect((await actual.request('/api/cysts')).status).toBe(401);
    const { envelope } = await encrypted();
    const request = (body: string, custom = headers, path = '/api/cysts') => actual.request(path, { method: 'POST', headers: custom, body });
    expect((await request(JSON.stringify(envelope), { ...headers, Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await request(JSON.stringify(envelope), { ...headers, 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await request(JSON.stringify(envelope), { ...headers, Cookie: 'telomere_session=invalid' })).status).toBe(401);
    expect((await request(JSON.stringify(envelope))).status).toBe(201);
    const large = await encryptCheckpoint(new Uint8Array(256_000).fill(5), { owner, applicationSchema: 'bytes.v1' });
    expect((await request(JSON.stringify(large.envelope), { ...headers, 'Idempotency-Key': 'large-mounted-upload' })).status).toBe(201);
    expect((await request('x'.repeat(196609), headers, '/api/quotes')).status).toBe(413);
    expect((await request('x'.repeat(CYST_CAPABILITIES.maxUploadBodyBytes + 1))).status).toBe(413);
    expect((await request('x'.repeat(196609), headers, '/api/cysts-pretend')).status).toBe(413);
    const disabled = createApp(core, auth, pino({ enabled: false }));
    expect((await disabled.request('/api/cysts', { method: 'POST', headers, body: JSON.stringify(large.envelope) })).status).toBe(413);
    expect((await disabled.request('/api/cysts', { headers })).status).toBe(404);
    const metadataResponse = await actual.request('/api/cysts/' + envelope.id, { headers });
    expect(metadataResponse.headers.get('Cache-Control')).toBe('no-store');
    await auth.logout(session); expect((await actual.request('/api/cysts/' + envelope.id, { headers })).status).toBe(401);
  });
});
