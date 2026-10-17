import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, link, lstat, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Problem } from '../src/common.js';
import { CYST_CAPABILITIES, type CystMetadata } from '../src/cysts/types.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { CystService } from '../src/cysts/service.js';
import { openStore } from '../src/store.js';
import { CystClient, encryptCheckpoint } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { CystCheckpointCoordinator, type CystCheckpointJournal, type CystCheckpointRecord,
  type CystCheckpointScope, type CystCheckpointState } from '../src/sdk/cyst-checkpoints.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';

const scope: CystCheckpointScope = { owner: '0x' + '11'.repeat(20), agent: '0x' + '22'.repeat(20), applicationSchema: 'file-vault-state/v1' };
const alternateScope = { ...scope, applicationSchema: 'file-vault-state/v2' };
const id = 'cyst-hook-' + 'a'.repeat(64), alternateId = 'cyst-hook-' + 'b'.repeat(64);
const sentinel = 'owner-side-file-vault-secret-🧬';
const initial = (value = scope): CystCheckpointState => ({ version: 1, scope: { ...value }, intervalMs: 900_000,
  paused: false, nextDueAtMs: 900_000, pending: null, latest: null });
const metadata = (record: CystCheckpointRecord): CystMetadata => {
  const { ciphertext: _ciphertext, ...header } = record.envelope;
  return { ...header, ciphertextBytes: record.envelope.plaintextBytes + 16, state: 'ready', createdAt: '2026-10-12T00:00:00.000Z' };
};
const complete = (record: CystCheckpointRecord): CystCheckpointState => ({ ...initial(), latest: {
  operationId: id, trigger: 'owner_request', completedAtMs: 1000, checkpoint: metadata(record) } });

const childModule = new URL('../src/sdk/cyst-checkpoints-file-vault.ts', import.meta.url).href;
const childSource = `
import { CystCheckpointFileVault } from ${JSON.stringify(childModule)};
const send = value => new Promise(resolve => process.send(value, resolve));
process.once('message', async input => {
  const key = Uint8Array.from(input.key);
  const vault = new CystCheckpointFileVault({ directory: input.directory, masterKey: key, acquireTimeoutMs: 5000 });
  key.fill(0);
  try {
    await send({ type: 'attempting' });
    await vault.exclusive(input.scope, async journal => {
      const state = await journal.load() ?? { version: 1, scope: input.scope, intervalMs: 900000,
        paused: false, nextDueAtMs: 0, pending: null, latest: null };
      const before = state.nextDueAtMs; state.nextDueAtMs++;
      await journal.save(state); await send({ type: 'entered', before, pid: process.pid });
      if (input.mode === 'crash') { await send({ type: 'durable-before-crash' }); process.exit(0); }
      if (input.mode === 'hold') await new Promise(resolve => process.once('message', resolve));
      await send({ type: 'leaving' });
    });
    vault.close(); await send({ type: 'released' }); process.disconnect();
  } catch { await send({ type: 'failed' }); process.exitCode = 1; process.disconnect(); }
});
await send({ type: 'ready' });
`;

describe('owner encrypted filesystem checkpoint vault', () => {
  let directory: string, vaultDirectory: string, key: Uint8Array, server: Server | undefined;
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  const vaults: CystCheckpointFileVault[] = [], children: ChildProcess[] = [];
  const vault = (options: { masterKey?: Uint8Array; directory?: string; acquireTimeoutMs?: number; maxRecordsPerScope?: number } = {}) => {
    const value = new CystCheckpointFileVault({ directory: options.directory ?? vaultDirectory, masterKey: options.masterKey ?? key,
      ...(options.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: options.acquireTimeoutMs }),
      ...(options.maxRecordsPerScope === undefined ? {} : { maxRecordsPerScope: options.maxRecordsPerScope }) });
    vaults.push(value); return value;
  };
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'telomere-cyst-file-vault-'));
    vaultDirectory = join(directory, 'vault'); key = Uint8Array.from(randomBytes(32)); });
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
      child.kill(); await Promise.race([once(child, 'exit'), new Promise(done => setTimeout(done, 2000))]);
    }
    server?.closeAllConnections(); if (server) { const owned = server; server = undefined;
      await new Promise<void>(done => owned.close(() => done())); }
    await store?.close(); store = undefined;
    for (const value of vaults.splice(0)) value.close(); key.fill(0);
    if (directory) { const owned = resolve(directory);
      if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('telomere-cyst-file-vault-')) throw new Error('Unexpected owned vault test directory');
      await rm(owned, { recursive: true, force: true }); }
  });
  async function scopeDirectory(value = scope) {
    const owner = vault(); await owner.exclusive(value, async () => {});
    const entries = await readdir(vaultDirectory); const scoped = entries.filter(name => /^[a-f0-9]{64}$/.test(name));
    if (scoped.length !== 1) throw new Error('Expected one fixture scope directory'); return join(vaultDirectory, scoped[0]!);
  }
  async function prepared(value = scope, bytes = new TextEncoder().encode(sentinel)) { return encryptCheckpoint(bytes, value); }
  function child() {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
      cwd: globalThis.process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const messages: Record<string, unknown>[] = []; const waiters = new Set<() => void>();
    process.on('message', message => { if (message && typeof message === 'object') messages.push(message as Record<string, unknown>);
      for (const notify of waiters) notify(); });
    // Drain private diagnostics without printing generated fixture data or keys.
    process.stderr?.resume(); children.push(process);
    const wait = async (type: string) => {
      const started = Date.now();
      while (!messages.some(message => message.type === type)) {
        if (messages.some(message => message.type === 'failed') || process.exitCode !== null || process.signalCode !== null
          || Date.now() - started > 10_000) throw new Error('Isolated vault process did not complete');
        await new Promise<void>(done => { const timer = setTimeout(() => { waiters.delete(notify); done(); }, 100);
          const notify = () => { clearTimeout(timer); waiters.delete(notify); done(); }; waiters.add(notify); });
      }
      return messages.find(message => message.type === type)!;
    };
    return { process, messages, wait, async start(mode: 'hold' | 'once' | 'crash') {
      await wait('ready'); process.send({ directory: vaultDirectory, key: Array.from(key), scope, mode }); await wait('attempting');
    } };
  }

  it('encrypts all state, original envelope and recovery key, and retains writes when a callback throws', async () => {
    const value = vault(), record = await prepared();
    await expect(value.exclusive(scope, async journal => {
      await journal.saveCheckpoint(id, record); await journal.save(complete(record)); throw new Error('callback failure');
    })).rejects.toThrow('callback failure');
    const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!);
    expect(await readdir(scoped)).toEqual(expect.arrayContaining(['identity.bin', 'state.bin', 'record-' + id + '.bin']));
    expect(await readdir(scoped)).not.toContain('exclusive.lock');
    for (const name of await readdir(scoped)) {
      const raw = await readFile(join(scoped, name)), text = raw.toString('utf8');
      for (const secret of [sentinel, scope.owner, scope.agent, scope.applicationSchema, record.envelope.ciphertext, Buffer.from(record.recoveryKey).toString('hex')]) expect(text).not.toContain(secret);
      expect(raw.subarray(0, 4).toString()).toBe('TCV1');
    }
    await vault().exclusive(scope, async journal => {
      expect(await journal.load()).toEqual(complete(record)); const first = await journal.checkpoint(id), second = await journal.checkpoint(id);
      expect(first).toEqual(record); if (!first || !second) throw new Error('Recovery record missing');
      first.recoveryKey.fill(0); first.envelope.ciphertext = ''; expect(second).toEqual(record); second.recoveryKey.fill(0);
    });
    record.recoveryKey.fill(0);
  });

  it('copies the caller key, uses a fresh GCM nonce for every state write and expires escaped journals', async () => {
    const value = vault(), retained = Uint8Array.from(key); key.fill(0); let escaped: CystCheckpointJournal | undefined;
    await value.exclusive(scope, async journal => { escaped = journal; await journal.save(initial()); });
    const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!), before = await readFile(join(scoped, 'state.bin'));
    await value.exclusive(scope, async journal => { await journal.save(initial()); });
    expect((await readFile(join(scoped, 'state.bin'))).equals(before)).toBe(false);
    if (!escaped) throw new Error('Expected escaped journal'); await expect(escaped.load()).rejects.toMatchObject({ code: 'vault_journal_expired' });
    await vault({ masterKey: retained }).exclusive(scope, async journal => { expect(await journal.load()).toEqual(initial()); });
    value.close(); await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_closed' }); retained.fill(0);
  });

  it('binds immutable records to the exact operation, envelope and recovery key', async () => {
    const value = vault(), first = await prepared(), other = await prepared();
    await value.exclusive(scope, async journal => { await journal.saveCheckpoint(id, first); await journal.saveCheckpoint(id, first); });
    await expect(value.exclusive(scope, journal => journal.saveCheckpoint(id, other))).rejects.toMatchObject({ code: 'vault_record_conflict' });
    await value.exclusive(scope, async journal => { expect(await journal.checkpoint(id)).toEqual(first); });
    const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!);
    await copyFile(join(scoped, 'record-' + id + '.bin'), join(scoped, 'record-' + alternateId + '.bin'));
    await chmod(join(scoped, 'record-' + alternateId + '.bin'), 0o600);
    await expect(value.exclusive(scope, journal => journal.checkpoint(alternateId))).rejects.toMatchObject({ code: 'vault_integrity' });
    first.recoveryKey.fill(0); other.recoveryKey.fill(0);
  });

  it('rejects wrong master keys and corrupt journals before the application callback can overwrite them', async () => {
    const value = vault(); await value.exclusive(scope, journal => journal.save(initial()));
    let called = false;
    await expect(vault({ masterKey: randomBytes(32) }).exclusive(scope, async () => { called = true; })).rejects.toMatchObject({ code: 'vault_integrity' });
    expect(called).toBe(false);
    const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!), path = join(scoped, 'state.bin'), original = await readFile(path);
    const broken = Buffer.from(original); broken[broken.length - 1]! ^= 1; await writeFile(path, broken, { mode: 0o600 });
    await expect(value.exclusive(scope, async () => { called = true; })).rejects.toMatchObject({ code: 'vault_integrity' });
    expect(called).toBe(false); expect(await readFile(path)).toEqual(broken);
  });

  it('rejects cross-scope ciphertext substitution and missing or corrupt original records behind completed pointers', async () => {
    const value = vault(), record = await prepared();
    await value.exclusive(scope, async journal => { await journal.saveCheckpoint(id, record); await journal.save(complete(record)); });
    const originalDirectory = join(vaultDirectory, (await readdir(vaultDirectory))[0]!);
    await value.exclusive(alternateScope, journal => journal.save(initial(alternateScope)));
    const alternateDirectory = join(vaultDirectory, (await readdir(vaultDirectory)).find(name => join(vaultDirectory, name) !== originalDirectory)!);
    await copyFile(join(originalDirectory, 'state.bin'), join(alternateDirectory, 'state.bin'));
    await expect(value.exclusive(alternateScope, async () => {})).rejects.toMatchObject({ code: 'vault_integrity' });
    const recordPath = join(originalDirectory, 'record-' + id + '.bin'), original = await readFile(recordPath); await unlink(recordPath);
    await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_invalid_data' });
    await writeFile(recordPath, original, { mode: 0o600 }); const broken = Buffer.from(original); broken[33]! ^= 1;
    await writeFile(recordPath, broken, { mode: 0o600 });
    await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_integrity' }); record.recoveryKey.fill(0);
  });

  it('validates bounded scope/state/records, rejects wrong recovery keys and enforces immutable record capacity', async () => {
    const value = vault({ maxRecordsPerScope: 1 }), record = await prepared(), second = await prepared();
    await expect(value.exclusive(scope, journal => journal.save({ ...initial(), scope: alternateScope }))).rejects.toMatchObject({ code: 'vault_invalid_data' });
    await expect(value.exclusive(scope, journal => journal.saveCheckpoint(id, { ...record, recoveryKey: randomBytes(32) }))).rejects.toBeInstanceOf(Error);
    await expect(value.exclusive(scope, journal => journal.save(complete(record)))).rejects.toMatchObject({ code: 'vault_invalid_data' });
    await value.exclusive(scope, journal => journal.saveCheckpoint(id, record));
    await expect(value.exclusive(scope, journal => journal.saveCheckpoint(alternateId, second))).rejects.toMatchObject({ code: 'vault_invalid_data' });
    await value.exclusive(scope, async journal => { expect(await journal.checkpoint(alternateId)).toBeUndefined(); expect(await journal.checkpoint(id)).toEqual(record); });
    const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!), path = join(scoped, 'state.bin');
    const file = await open(path, 'wx', 0o600); try { await file.truncate(8192 + 33); } finally { await file.close(); }
    await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_unavailable' });
    record.recoveryKey.fill(0); second.recoveryKey.fill(0);
  });

  it('accepts the maximum 2 MiB original application envelope without truncation', async () => {
    const record = await prepared(scope, new Uint8Array(CYST_CAPABILITIES.maxPlaintextBytes).fill(0x5a)), value = vault();
    await value.exclusive(scope, journal => journal.saveCheckpoint(id, record));
    await vault().exclusive(scope, async journal => { const saved = await journal.checkpoint(id); expect(saved).toEqual(record); saved?.recoveryKey.fill(0); });
    record.recoveryKey.fill(0);
  });

  it.runIf(process.platform !== 'win32')('rejects permissive owner files and directories without changing their permissions', async () => {
    const value = vault(); await value.exclusive(scope, journal => journal.save(initial()));
    const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!), path = join(scoped, 'state.bin');
    await chmod(path, 0o644); await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_unavailable' });
    expect((await lstat(path)).mode & 0o777).toBe(0o644); await chmod(path, 0o600);
    await chmod(vaultDirectory, 0o755); await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_unavailable' });
    await chmod(vaultDirectory, 0o700);
  });

  it.runIf(process.platform !== 'win32')('rejects symlink directories and record links without following them', async () => {
    const scoped = await scopeDirectory(), original = await readFile(join(scoped, 'identity.bin'));
    const outside = join(directory, 'outside.bin'); await writeFile(outside, original, { mode: 0o600 });
    await unlink(join(scoped, 'identity.bin')); await symlink(outside, join(scoped, 'identity.bin'));
    await expect(vault().exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_unavailable' });
    expect(await readFile(outside)).toEqual(original);
    const alias = join(directory, 'alias'); await symlink(vaultDirectory, alias, 'dir');
    await expect(vault({ directory: alias }).exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_unavailable' });
  });

  it('rejects hard-linked private files and never releases a replacement or corrupted owner lock', async () => {
    const value = vault(); await value.exclusive(scope, journal => journal.save(initial()));
    const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!), path = join(scoped, 'state.bin');
    await link(path, join(directory, 'hard-link.bin'));
    await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_unavailable' });
    await unlink(join(directory, 'hard-link.bin'));
    const broken = Buffer.alloc(64, 0x41);
    await expect(value.exclusive(scope, async () => { await writeFile(join(scoped, 'exclusive.lock'), broken, { mode: 0o600 }); })).rejects.toMatchObject({ code: 'vault_integrity' });
    expect(await readFile(join(scoped, 'exclusive.lock'))).toEqual(broken);
    await expect(value.lockStatus(scope)).rejects.toMatchObject({ code: 'vault_integrity' });
  });

  it('serializes separate actual Node processes and reopens the same durable state in a fresh process', async () => {
    const first = child(), second = child(); await Promise.all([first.wait('ready'), second.wait('ready')]);
    await first.start('hold'); expect((await first.wait('entered')).before).toBe(0);
    await second.start('once'); await new Promise(done => setTimeout(done, 150));
    expect(second.messages.some(message => message.type === 'entered')).toBe(false);
    first.process.send({ release: true }); await first.wait('released'); expect((await second.wait('entered')).before).toBe(1); await second.wait('released');
    const reopened = child(); await reopened.start('once'); expect((await reopened.wait('entered')).before).toBe(2); await reopened.wait('released');
    await vault().exclusive(scope, async journal => { expect((await journal.load())?.nextDueAtMs).toBe(3); });
  }, 25_000);

  it('bounds lock acquisition and refuses live/reused or unknown PID recovery', async () => {
    const owner = child(); await owner.start('hold'); await owner.wait('entered');
    const value = vault({ acquireTimeoutMs: 75 }), started = Date.now();
    await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_lock_timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    const status = await value.lockStatus(scope); expect(status?.pid).toBe(owner.process.pid);
    if (!status) throw new Error('Expected live lock');
    expect(status.process).toBe(process.platform === 'linux' ? 'live' : 'unknown');
    await expect(value.recoverStaleLock(scope, status.lockId)).rejects.toMatchObject({ code: 'vault_lock_recovery_unavailable' });
    owner.process.send({ release: true }); await owner.wait('released'); await value.exclusive(scope, async () => {});
  });

  it('keeps crashed-process writes and locks, with explicit proven-dead recovery only in the same Linux boot and PID namespace', async () => {
    const owner = child(); await owner.start('crash'); await owner.wait('durable-before-crash');
    if (owner.process.exitCode === null) await once(owner.process, 'exit');
    const value = vault({ acquireTimeoutMs: 50 }), status = await value.lockStatus(scope);
    if (!status) throw new Error('Expected stale lock');
    await expect(value.exclusive(scope, async () => {})).rejects.toMatchObject({ code: 'vault_lock_timeout' });
    await expect(value.recoverStaleLock(scope, '0'.repeat(64))).rejects.toMatchObject({ code: 'vault_lock_recovery_unavailable' });
    if (process.platform === 'linux') {
      expect(status).toMatchObject({ sameLinuxBoot: true, process: 'dead' });
      const scoped = join(vaultDirectory, (await readdir(vaultDirectory))[0]!), path = join(scoped, 'exclusive.lock');
      const original = await readFile(path), aad = Buffer.from(JSON.stringify(['telomere.cyst-checkpoint-file-vault', 1,
        scope.owner, scope.agent, scope.applicationSchema, 'lock', 'exclusive.lock']));
      const decoder = createDecipheriv('aes-256-gcm', key, original.subarray(4, 16));
      decoder.setAAD(aad); decoder.setAuthTag(original.subarray(16, 32));
      const plaintext = Buffer.concat([decoder.update(original.subarray(32)), decoder.final()]);
      const originalLock = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>; plaintext.fill(0);
      for (const changed of [{ pidNamespace: 'pid:[0]' }, { bootId: '00000000-0000-0000-0000-000000000000' }]) {
        const nonce = randomBytes(12), encoder = createCipheriv('aes-256-gcm', key, nonce), input = Buffer.from(JSON.stringify({ ...originalLock, ...changed }));
        encoder.setAAD(aad); const ciphertext = Buffer.concat([encoder.update(input), encoder.final()]); input.fill(0);
        await writeFile(path, Buffer.concat([Buffer.from('TCV1'), nonce, encoder.getAuthTag(), ciphertext]), { mode: 0o600 });
        expect(await value.lockStatus(scope)).toMatchObject({ sameLinuxBoot: false, process: 'unknown' });
        await expect(value.recoverStaleLock(scope, status.lockId)).rejects.toMatchObject({ code: 'vault_lock_recovery_unavailable' });
      }
      await writeFile(path, original, { mode: 0o600 });
      const results = await Promise.allSettled([value.recoverStaleLock(scope, status.lockId), vault().recoverStaleLock(scope, status.lockId)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      await vault().exclusive(scope, async journal => { expect((await journal.load())?.nextDueAtMs).toBe(1); });
    } else await expect(value.recoverStaleLock(scope, status.lockId)).rejects.toMatchObject({ code: 'vault_lock_recovery_unavailable' });
  });

  it('uses the production vault for actual owner Cyst HTTP lost-ACK exact retry and independent restore after reopen', async () => {
    store = await openStore({ DATA_DIR: ':memory:' }); const service = new CystService(store.db, join(directory, 'ciphertext')); await service.initialize();
    let origin = '', loseAck = true; const uploads: { body: string; key: string }[] = [];
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_failed' }, error instanceof Problem ? error.status : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST') {
        if (context.req.header('Origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Origin differs');
        uploads.push({ body: await context.req.raw.clone().text(), key: context.req.header('Idempotency-Key') ?? '' });
      }
      await next();
    });
    const token = 'a'.repeat(64);
    app.route('/api/cysts', createCystRoutes(service, async context => {
      if (context.req.header('Cookie') !== 'telomere_session=' + token) throw new Problem(401, 'sign_in', 'Session required'); return scope.owner;
    }));
    server = createServer(getRequestListener(app.fetch)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP fixture port missing'); origin = 'http://127.0.0.1:' + address.port;
    const client = new CystClient(new ApiTransport(origin, { sessionToken: token, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init.method === 'POST' && loseAck) { loseAck = false; await response.arrayBuffer(); throw new Error('Lost actual HTTP ACK'); } return response;
    } }));
    const value = vault(); let hooks = 0;
    const coordinator = (target: CystCheckpointFileVault) => new CystCheckpointCoordinator({ ...scope, cysts: client, vault: target,
      onCyst: async () => { hooks++; return new TextEncoder().encode(sentinel); } });
    await expect(coordinator(value).snapshot()).rejects.toThrow();
    const saved = await value.exclusive(scope, async journal => {
      const state = await journal.load(); if (!state?.pending) throw new Error('Expected original durable pending checkpoint');
      const record = await journal.checkpoint(state.pending.operationId); if (!record) throw new Error('Original recovery record missing'); return record;
    });
    const retried = await coordinator(vault()).retryPending(); expect(retried).toMatchObject({ status: 'uploaded', replayed: true });
    expect(hooks).toBe(1); expect(uploads).toHaveLength(2); expect(uploads[0]).toEqual(uploads[1]);
    for (const upload of uploads) for (const secret of [sentinel, Buffer.from(saved.recoveryKey).toString('hex'), Buffer.from(key).toString('hex')]) expect(upload.body).not.toContain(secret);
    expect(new TextDecoder().decode(await coordinator(vault()).restoreLatest())).toBe(sentinel); expect(hooks).toBe(1);
    saved.recoveryKey.fill(0);
  });
});
