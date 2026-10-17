import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Problem } from '../src/common.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { CystService } from '../src/cysts/service.js';
import { CYST_CAPABILITIES, cystEnvelopeSchema } from '../src/cysts/types.js';
import { openStore } from '../src/store.js';
import { CystClient, decryptCheckpoint, exportCystRecoveryKey, importCystRecoveryKey } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { CystCheckpointCoordinator, DEFAULT_CYST_CHECKPOINT_INTERVAL_MS,
  type CystCheckpointJournal, type CystCheckpointRecord, type CystCheckpointScope,
  type CystCheckpointState, type CystCheckpointTrigger } from '../src/sdk/cyst-checkpoints.js';

const owner = '0x' + '11'.repeat(20), agent = '0x' + '22'.repeat(20), other = '0x' + '33'.repeat(20);
const token = 'a'.repeat(64), foreignToken = 'b'.repeat(64);
const scope: CystCheckpointScope = { owner, agent, applicationSchema: 'cyst-hook-counter/v1' };
const initialTime = 1_791_799_200_000;
const sentinel = '{"counter":19,"privateMemory":"onCyst-client-only-sentinel-🧬"}';
const plaintext = new TextEncoder().encode(sentinel);

function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }

/** Test-only client vault: fsynced files + atomic rename, reopened from disk.
 * The shared mutex covers instances within THIS process; this is not an OS
 * cross-process lock. POSIX additionally fsyncs directory rename metadata.
 */
class FileClientVault {
  private static readonly locks = new Map<string, Promise<void>>();
  readonly issuedKeys: Uint8Array[] = [];
  readonly savedKeys: Uint8Array[] = [];
  failRecord = false;
  loseRecordAck = false;
  failCompletion = false;
  loseCompletionAck = false;
  constructor(readonly directory: string, readonly events: string[]) {}
  path(value: CystCheckpointScope): string {
    return join(this.directory, createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  }
  private async atomic(path: string, text: string): Promise<void> {
    const temporary = path + '.tmp-' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(join(path, '..'), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  private async text(path: string): Promise<string | undefined> {
    try { return await readFile(path, 'utf8'); } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async state(value = scope): Promise<CystCheckpointState | undefined> {
    const text = await this.text(join(this.path(value), 'state.json'));
    return text === undefined ? undefined : JSON.parse(text) as CystCheckpointState;
  }
  async record(id: string, value = scope): Promise<CystCheckpointRecord | undefined> {
    const text = await this.text(join(this.path(value), id + '.json'));
    if (text === undefined) return undefined;
    const raw: unknown = JSON.parse(text);
    const parsed = z.object({ envelope: cystEnvelopeSchema, recoveryKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
    const key = importCystRecoveryKey(parsed.recoveryKey);
    this.issuedKeys.push(key);
    return { envelope: parsed.envelope, recoveryKey: key };
  }
  async exclusive<T>(value: CystCheckpointScope, operation: (journal: CystCheckpointJournal) => Promise<T>): Promise<T> {
    const directory = this.path(value), previous = FileClientVault.locks.get(directory) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    FileClientVault.locks.set(directory, next);
    await previous;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const journal: CystCheckpointJournal = {
        load: () => this.state(value),
        save: async state => {
          const completion = state.latest !== null && state.pending === null && !state.paused;
          if (completion && this.failCompletion) { this.failCompletion = false; throw new Error('Completion persistence failed'); }
          await this.atomic(join(directory, 'state.json'), JSON.stringify(state));
          this.events.push(state.pending ? 'state.begin' : state.latest ? 'state.complete' : 'state.initialize');
          if (completion && this.loseCompletionAck) { this.loseCompletionAck = false; throw new Error('Lost durable completion acknowledgment'); }
        },
        checkpoint: id => this.record(id, value),
        saveCheckpoint: async (id, record) => {
          if (this.failRecord) { this.failRecord = false; throw new Error('Checkpoint persistence failed'); }
          const path = join(directory, id + '.json');
          const serialized = JSON.stringify({ envelope: record.envelope, recoveryKey: exportCystRecoveryKey(record.recoveryKey) });
          const previousRecord = await this.text(path);
          if (previousRecord !== undefined && previousRecord !== serialized) throw new Error('Immutable checkpoint record conflict');
          if (previousRecord === undefined) await this.atomic(path, serialized);
          this.savedKeys.push(record.recoveryKey);
          this.events.push('record.persist');
          if (this.loseRecordAck) { this.loseRecordAck = false; throw new Error('Lost durable checkpoint acknowledgment'); }
        },
      };
      return await operation(journal);
    } finally { release(); if (FileClientVault.locks.get(directory) === next) FileClientVault.locks.delete(directory); }
  }
}

describe('durable owner-side onCyst checkpoint coordinator over real HTTP and private storage', () => {
  let directory: string, store: Awaited<ReturnType<typeof openStore>>, service: CystService, server: Server, origin: string;
  let vault: FileClientVault, client: CystClient, now: number, failHook: boolean, dropUploadResponse: boolean;
  let mutateBlob: (value: { metadata: unknown; ciphertext: string }) => unknown;
  let beforeUploadResponse: () => Promise<void>;
  const events: string[] = [], uploads: { body: string; key: string }[] = [];
  const hooks: { operationId: string; trigger: CystCheckpointTrigger }[] = [], ownedPlaintexts: Uint8Array[] = [];
  const hook = async (context: { operationId: string; trigger: CystCheckpointTrigger }) => {
    hooks.push(context);
    if (failHook) { failHook = false; throw new Error('Application capture failed'); }
    const bytes = Uint8Array.from(plaintext); ownedPlaintexts.push(bytes); return bytes;
  };
  const coordinator = (options: { vault?: FileClientVault; intervalMs?: number; client?: CystClient;
    onCyst?: typeof hook; clock?: () => number } = {}) => new CystCheckpointCoordinator({ ...scope,
    cysts: options.client ?? client, vault: options.vault ?? vault, onCyst: options.onCyst ?? hook,
    now: options.clock ?? (() => now), ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }) });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-cyst-hook-'));
    store = await openStore({ DATA_DIR: ':memory:' });
    service = new CystService(store.db, join(directory, 'ciphertext')); await service.initialize();
    now = initialTime; failHook = false; dropUploadResponse = false;
    events.length = 0; uploads.length = 0; hooks.length = 0; ownedPlaintexts.length = 0;
    beforeUploadResponse = async () => {}; mutateBlob = value => value;
    vault = new FileClientVault(join(directory, 'client-vault'), events);
    const app = new Hono();
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST') {
        if (context.req.header('Origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Invalid origin');
        if (context.req.header('Content-Type') !== 'application/json') throw new Problem(400, 'json_required', 'Send JSON');
      }
      if (context.req.method === 'POST' && context.req.path === '/api/cysts') {
        uploads.push({ body: await context.req.raw.clone().text(), key: context.req.header('Idempotency-Key') ?? '' });
        events.push('upload');
      }
      await next();
    });
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'fixture_failed' },
      error instanceof Problem ? error.status : 503));
    app.route('/api/cysts', createCystRoutes(service, async context => {
      const cookie = context.req.header('Cookie');
      if (cookie === 'telomere_session=' + token) return owner;
      if (cookie === 'telomere_session=' + foreignToken) return other;
      throw new Problem(401, 'unauthorized', 'Sign in');
    }));
    server = createServer(getRequestListener(app.fetch)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing private fixture address');
    origin = 'http://127.0.0.1:' + address.port;
    client = new CystClient(new ApiTransport(origin, { sessionToken: token, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init.method === 'POST') {
        await beforeUploadResponse();
        if (dropUploadResponse) { dropUploadResponse = false; await response.arrayBuffer(); throw new Error('Lost upload response'); }
      }
      if (new URL(url).pathname.endsWith('/blob') && response.ok) {
        const value: unknown = await response.json();
        const parsed = z.object({ metadata: z.unknown(), ciphertext: z.string() }).strict().parse(value);
        return new Response(JSON.stringify(mutateBlob({ metadata: parsed.metadata, ciphertext: parsed.ciphertext })),
          { status: response.status, headers: response.headers });
      }
      return response;
    } }));
  });
  afterEach(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await store?.close();
    if (directory) {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-cyst-hook-')) throw new Error('Unexpected fixture directory');
      await rm(target, { recursive: true, force: true });
    }
  });

  it('uses durable default 15-minute cadence and schedules from completion without catch-up storms', async () => {
    const value = coordinator();
    expect(await value.tick()).toEqual({ status: 'idle', nextDueAtMs: initialTime + DEFAULT_CYST_CHECKPOINT_INTERVAL_MS });
    now += DEFAULT_CYST_CHECKPOINT_INTERVAL_MS - 1;
    expect((await coordinator().tick()).status).toBe('idle'); expect(hooks).toHaveLength(0);
    now++;
    beforeUploadResponse = async () => { now += 45_000; };
    const first = await value.tick();
    expect(first).toMatchObject({ status: 'uploaded', trigger: 'periodic', nextDueAtMs: now + DEFAULT_CYST_CHECKPOINT_INTERVAL_MS });
    now += DEFAULT_CYST_CHECKPOINT_INTERVAL_MS * 10;
    expect((await value.tick()).status).toBe('uploaded');
    expect((await value.tick()).status).toBe('idle'); expect(hooks).toHaveLength(2); expect(uploads).toHaveLength(2);
  });

  it.each(['owner_request', 'preemption', 'budget_exhaustion', 'metabolism_step_down', 'periodic'] as const)
    ('captures the explicit %s trigger through the same durable application hook', async reason => {
      const result = await coordinator().snapshot(reason);
      expect(result).toMatchObject({ status: 'uploaded', trigger: reason });
      expect(hooks).toEqual([{ operationId: uploads[0]!.key, trigger: reason }]);
      expect((await vault.state())?.latest?.trigger).toBe(reason);
    });

  it('persists envelope/key before HTTP upload, restores after disk reopen and keeps secrets off the API', async () => {
    const value = coordinator(); const result = await value.snapshot();
    if (result.status !== 'uploaded') throw new Error('Expected checkpoint upload');
    expect(events.indexOf('state.begin')).toBeLessThan(events.indexOf('record.persist'));
    expect(events.indexOf('record.persist')).toBeLessThan(events.indexOf('upload'));
    expect(events.indexOf('upload')).toBeLessThan(events.indexOf('state.complete'));
    expect(ownedPlaintexts.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    expect([...vault.issuedKeys, ...vault.savedKeys].every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    const reopened = new FileClientVault(vault.directory, events), saved = await reopened.record(result.operationId);
    if (!saved) throw new Error('Missing durable checkpoint record');
    expect(saved.recoveryKey.some(byte => byte !== 0)).toBe(true);
    for (const upload of uploads) {
      expect(upload.body).not.toContain(sentinel); expect(upload.body).not.toContain(exportCystRecoveryKey(saved.recoveryKey));
      expect(Object.keys(JSON.parse(upload.body) as Record<string, unknown>).sort()).toEqual(Object.keys(saved.envelope).sort());
      expect(upload.body).not.toContain('recoveryKey'); expect(upload.body).not.toContain('plaintext"');
    }
    expect(await coordinator({ vault: reopened }).restoreLatest()).toEqual(plaintext);
    expect(uploads).toHaveLength(1); expect(hooks).toHaveLength(1); saved.recoveryKey.fill(0);
    const blobs = await readdir(service.privateDirectory);
    expect(blobs).toHaveLength(1); expect((await readFile(join(service.privateDirectory, blobs[0]!))).toString('base64')).toBe(saved.envelope.ciphertext);
  });

  it('retries the exact durable ciphertext and idempotency key after a lost upload response and coordinator restart', async () => {
    dropUploadResponse = true;
    await expect(coordinator().snapshot('preemption')).rejects.toThrow('Lost upload response');
    expect((await vault.state())?.pending).not.toBeNull(); expect((await vault.state())?.latest).toBeNull();
    now += 120_000;
    const reopened = new FileClientVault(vault.directory, events);
    const result = await coordinator({ vault: reopened }).retryPending();
    expect(result).toMatchObject({ status: 'uploaded', replayed: true, trigger: 'preemption' });
    expect(uploads).toHaveLength(2); expect(uploads[1]).toEqual(uploads[0]); expect(hooks).toHaveLength(1);
    expect(await coordinator({ vault: reopened }).restoreLatest()).toEqual(plaintext);
    expect(await readdir(service.privateDirectory)).toHaveLength(1);
  });

  it('repeats an incomplete begin with the same idempotent onCyst operation after capture failure', async () => {
    failHook = true;
    await expect(coordinator().snapshot()).rejects.toThrow('Application capture failed');
    expect(uploads).toHaveLength(0);
    expect((await coordinator({ vault: new FileClientVault(vault.directory, events) }).retryPending()).status).toBe('uploaded');
    expect(hooks).toHaveLength(2); expect(hooks[1]).toEqual(hooks[0]);
  });

  it('never uploads if the vault cannot persist envelope/key and clears the captured state', async () => {
    vault.failRecord = true;
    await expect(coordinator().snapshot()).rejects.toThrow('Checkpoint persistence failed');
    expect(uploads).toHaveLength(0); expect(ownedPlaintexts[0]!.every(byte => byte === 0)).toBe(true);
    expect((await coordinator().retryPending()).status).toBe('uploaded');
    expect(hooks).toHaveLength(2); expect(hooks[1]).toEqual(hooks[0]);
  });

  it('recovers a persisted envelope after losing its vault acknowledgment without calling the hook again', async () => {
    vault.loseRecordAck = true;
    await expect(coordinator().snapshot()).rejects.toThrow('Lost durable checkpoint acknowledgment');
    expect(uploads).toHaveLength(0);
    expect((await coordinator({ vault: new FileClientVault(vault.directory, events) }).retryPending()).status).toBe('uploaded');
    expect(hooks).toHaveLength(1); expect(uploads).toHaveLength(1);
  });

  it('replays the original upload after completion persistence failure with no second blob or new state capture', async () => {
    vault.failCompletion = true;
    await expect(coordinator().snapshot()).rejects.toThrow('Completion persistence failed');
    expect((await vault.state())?.pending).not.toBeNull();
    expect(await coordinator().retryPending()).toMatchObject({ status: 'uploaded', replayed: true });
    expect(uploads[1]).toEqual(uploads[0]); expect(hooks).toHaveLength(1);
    expect(await readdir(service.privateDirectory)).toHaveLength(1);
  });

  it('recognizes durable completion after a lost vault acknowledgment without uploading again', async () => {
    vault.loseCompletionAck = true;
    await expect(coordinator().snapshot()).rejects.toThrow('Lost durable completion acknowledgment');
    const reopened = coordinator({ vault: new FileClientVault(vault.directory, events) });
    const [cadence, emptyRetry] = await Promise.all([reopened.tick(), reopened.retryPending()]);
    expect(cadence.status).toBe('idle'); expect(emptyRetry.status).toBe('no_pending');
    expect(await reopened.restoreLatest()).toEqual(plaintext);
    expect(uploads).toHaveLength(1); expect(hooks).toHaveLength(1);
  });

  it('coalesces concurrent explicit captures and a due tick into a single operation', async () => {
    const value = coordinator(); await value.tick(); now += DEFAULT_CYST_CHECKPOINT_INTERVAL_MS;
    const results = await Promise.all([value.tick(), value.snapshot('preemption'), value.snapshot('owner_request'), value.retryPending()]);
    expect(results.every(result => result.status === 'uploaded')).toBe(true);
    expect(new Set(results.map(result => result.status === 'uploaded' ? result.operationId : 'missing')).size).toBe(1);
    expect(hooks).toHaveLength(1); expect(uploads).toHaveLength(1);
  });

  it('does not swallow an explicit request arriving during an idle cadence check', async () => {
    const value = coordinator();
    const [tick, requested] = await Promise.all([value.tick(), value.snapshot('owner_request')]);
    expect(tick.status).toBe('idle'); expect(requested.status).toBe('uploaded'); expect(hooks).toHaveLength(1);
  });

  it('serializes separate coordinator instances through their shared scoped vault mutex', async () => {
    await coordinator().tick(); now += DEFAULT_CYST_CHECKPOINT_INTERVAL_MS;
    const reopened = new FileClientVault(vault.directory, events);
    const results = await Promise.all([coordinator().tick(), coordinator({ vault: reopened }).tick()]);
    expect(results.map(result => result.status).sort()).toEqual(['idle', 'uploaded']);
    expect(hooks).toHaveLength(1); expect(uploads).toHaveLength(1);
  });

  it('durably pauses after an in-flight snapshot without erasing it and blocks new captures', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    beforeUploadResponse = async () => { entered(); await gate; };
    const value = coordinator(), snapshot = value.snapshot(); await reached;
    const pause = value.pause(); release();
    expect((await snapshot).status).toBe('uploaded'); await pause;
    expect((await vault.state())?.paused).toBe(true); expect((await vault.state())?.latest).not.toBeNull();
    const reopened = coordinator({ vault: new FileClientVault(vault.directory, events) });
    expect((await reopened.tick()).status).toBe('paused'); expect((await reopened.snapshot()).status).toBe('paused');
    const [paused, emptyRetry] = await Promise.all([reopened.tick(), reopened.retryPending()]);
    expect(paused.status).toBe('paused'); expect(emptyRetry.status).toBe('no_pending');
    expect(await reopened.restoreLatest()).toEqual(plaintext);
    expect(hooks).toHaveLength(1); expect(uploads).toHaveLength(1);
    await reopened.resume(); expect((await coordinator().tick()).status).toBe('idle');
  });

  it('permits only explicit pending recovery while paused, then requires explicit durable resume', async () => {
    const value = coordinator(); dropUploadResponse = true;
    await expect(value.snapshot('budget_exhaustion')).rejects.toThrow(); await value.pause();
    expect((await value.tick()).status).toBe('paused'); expect((await value.snapshot()).status).toBe('paused');
    const [paused, recovered] = await Promise.all([value.tick(), value.retryPending()]);
    expect(paused.status).toBe('paused');
    expect(recovered).toMatchObject({ status: 'uploaded', replayed: true, trigger: 'budget_exhaustion' });
    expect((await vault.state())?.paused).toBe(true); expect(hooks).toHaveLength(1);
    await value.resume(); expect((await coordinator().tick()).status).toBe('idle');
  });

  it('restores only the exact saved envelope even when a substitute has a valid public digest and scope', async () => {
    const value = coordinator(); await value.snapshot();
    mutateBlob = raw => ({ ...raw, metadata: { ...z.record(z.unknown()).parse(raw.metadata), nonce: 'ee'.repeat(24) } });
    await expect(value.restoreLatest()).rejects.toThrow('exact saved original envelope');
    expect(uploads).toHaveLength(1); expect(hooks).toHaveLength(1);
  });

  it('fails closed with a lost recovery record or wrong saved key and never creates a checkpoint on restore', async () => {
    await expect(coordinator().restoreLatest()).rejects.toThrow('no completed checkpoint');
    expect(await vault.state()).toBeUndefined(); expect(hooks).toHaveLength(0); expect(uploads).toHaveLength(0);
    const value = coordinator(); const result = await value.snapshot();
    if (result.status !== 'uploaded') throw new Error('Expected uploaded checkpoint');
    const path = join(vault.path(scope), result.operationId + '.json'), text = await readFile(path, 'utf8');
    const stored = z.object({ envelope: cystEnvelopeSchema, recoveryKey: z.string() }).parse(JSON.parse(text) as unknown);
    const file = await open(path, 'w');
    try { await file.writeFile(JSON.stringify({ ...stored, recoveryKey: '00'.repeat(32) })); await file.sync(); } finally { await file.close(); }
    await expect(value.restoreLatest()).rejects.toThrow('authentication failed');
    await rm(path);
    await expect(value.restoreLatest()).rejects.toThrow('no saved checkpoint recovery record');
    expect(uploads).toHaveLength(1); expect(hooks).toHaveLength(1);
  });

  it('does not publish a prepared checkpoint whose independently saved key cannot authenticate it', async () => {
    dropUploadResponse = true; await expect(coordinator().snapshot()).rejects.toThrow();
    const state = await vault.state(); if (!state?.pending) throw new Error('Expected pending checkpoint');
    const path = join(vault.path(scope), state.pending.operationId + '.json');
    const stored = z.object({ envelope: cystEnvelopeSchema, recoveryKey: z.string() }).parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    const file = await open(path, 'w');
    try { await file.writeFile(JSON.stringify({ ...stored, recoveryKey: '00'.repeat(32) })); await file.sync(); } finally { await file.close(); }
    await expect(coordinator().retryPending()).rejects.toThrow('authentication failed');
    expect(uploads).toHaveLength(1); expect(hooks).toHaveLength(1);
    expect(vault.issuedKeys.every(key => key.every(byte => byte === 0))).toBe(true);
  });

  it('retains older immutable recovery records and restores the completed state without retrying new pending work', async () => {
    const value = coordinator(), first = await value.snapshot();
    if (first.status !== 'uploaded') throw new Error('Expected first checkpoint');
    dropUploadResponse = true; await expect(value.snapshot('metabolism_step_down')).rejects.toThrow();
    expect(await value.restoreLatest()).toEqual(plaintext); expect(uploads).toHaveLength(2);
    expect((await vault.state())?.pending).not.toBeNull(); expect((await vault.state())?.latest?.operationId).toBe(first.operationId);
    await value.retryPending();
    const records = (await readdir(vault.path(scope))).filter(name => name.startsWith('cyst-hook-'));
    expect(records).toHaveLength(2);
    const old = await vault.record(first.operationId); if (!old) throw new Error('Old key was removed');
    try { expect(await decryptCheckpoint(old.envelope, old.recoveryKey)).toEqual(plaintext); } finally { old.recoveryKey.fill(0); }
  });

  it('rejects mismatched persisted scope/cadence and malformed interval or clock bounds', async () => {
    await coordinator().tick();
    await expect(coordinator({ intervalMs: 1000 }).tick()).rejects.toThrow('scope or cadence');
    for (const intervalMs of [999, 86_400_001, NaN, Infinity, 1000.5]) expect(() => coordinator({ intervalMs })).toThrow();
    for (const time of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, initialTime + 0.5]) expect(() => coordinator({ clock: () => time })).toThrow();
    const value = coordinator();
    expect(() => value.snapshot('unknown' as CystCheckpointTrigger)).toThrow();
    expect(uploads).toHaveLength(0);
  });

  it.each([0, CYST_CAPABILITIES.maxPlaintextBytes + 1])('rejects %i-byte application state and clears its owning buffer without upload', async bytes => {
    const state = new Uint8Array(bytes).fill(7);
    await expect(coordinator({ onCyst: async () => state }).snapshot()).rejects.toThrow('between 1 byte and 2 MiB');
    expect(state.every(byte => byte === 0)).toBe(true); expect(uploads).toHaveLength(0);
  });

  it('uses the authenticated owner upload boundary rather than accepting arbitrary checkpoint labels', async () => {
    const foreign = new CystClient(new ApiTransport(origin, { sessionToken: foreignToken }));
    await expect(coordinator({ client: foreign }).snapshot()).rejects.toThrow('cyst_owner_mismatch');
    expect((await vault.state())?.pending).not.toBeNull(); expect((await service.list(owner)).checkpoints).toHaveLength(0);
  });
});
