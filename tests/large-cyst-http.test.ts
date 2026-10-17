import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import pino from 'pino';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { ChainBridge } from '../src/bridge.js';
import { Problem } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { LARGE_CYST_CHUNK_BYTES, LargeCystPrivateStore, generateLargeCystId,
  restoreLargeCystFile, saveLargeCystFile } from '../src/cysts/large-checkpoints.js';
import { createLargeCystRoutes } from '../src/cysts/large-routes.js';
import { LargeCystHttpStore } from '../src/sdk/large-cyst-http-store.js';
import { Service } from '../src/service.js';
import { openStore } from '../src/store.js';

const owner = ('0x' + '11'.repeat(20)) as Address, agent = ('0x' + '22'.repeat(20)) as Address,
  foreign = ('0x' + '33'.repeat(20)) as Address;
const scope = { owner, agent, applicationSchema: 'application.tar.zst/v1' };
const sentinel = 'private-agent-checkpoint-state';

describe('authenticated large Cyst multipart HTTP', () => {
  let root: string, storageDir: string, outputDir: string, sourcePath: string;
  let server: Server, origin: string, session: string, foreignSession: string;
  let store: LargeCystPrivateStore, database: Awaited<ReturnType<typeof openStore>>;
  let id: string, key: Uint8Array;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-large-cyst-http-'));
    storageDir = join(root, 'ciphertext'); outputDir = join(root, 'restored'); sourcePath = join(root, 'archive.tar.zst');
    await mkdir(storageDir, { mode: 0o700 }); await mkdir(outputDir, { mode: 0o700 });
    store = new LargeCystPrivateStore(storageDir, { globalMaxBytes: 16 * 1024 * 1024, ownerMaxBytes: 8 * 1024 * 1024 });
    await store.initialize(); database = await openStore({ DATA_DIR: ':memory:' });
    let listener: ReturnType<typeof getRequestListener> | undefined;
    server = createServer((request, response) => {
      if (!listener) { response.writeHead(503); response.end(); return; }
      listener(request, response);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP fixture port missing');
    origin = 'http://127.0.0.1:' + address.port;
    const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin,
      SIGNER_PRIVATE_KEY: '0x' + '44'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '55'.repeat(32),
      ESCROW_ADDRESS: '0x' + '66'.repeat(20), TOKEN_ADDRESS: '0x' + '77'.repeat(20) });
    const auth = new Auth(database.db, config), core = new Service(database.db, new ChainBridge(config), config, false);
    const app = createApp(core, auth, pino({ enabled: false }), './dist/public',
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, store);
    listener = getRequestListener(app.fetch);
    session = await auth.session(owner); foreignSession = await auth.session(foreign);
    id = generateLargeCystId(); key = randomBytes(32);
  });
  afterEach(async () => {
    key.fill(0); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await database.close(); await store.close(); await rm(root, { recursive: true, force: true });
  });

  it('uses the real owner session, origin guard and binary HTTP transfer to restore encrypted state', async () => {
    const plaintext = Buffer.concat([Buffer.from(sentinel), randomBytes(300_000)]);
    await writeFile(sourcePath, plaintext);
    const captured: Buffer[] = [];
    const client = new LargeCystHttpStore({ baseUrl: origin, sessionToken: session,
      fetchImpl: async (url, init) => {
        if (init?.body) captured.push(Buffer.from(init.body as Uint8Array | string));
        return fetch(url, init);
      } });
    const manifest = await saveLargeCystFile({ store: client, sourcePath, id, scope, recoveryKey: key });
    expect(manifest.parts).toHaveLength(1);
    expect(manifest.parts[0]?.bytes).toBeGreaterThan(196_608); // Above the unrelated JSON request bound.
    const freshClient = new LargeCystHttpStore({ baseUrl: origin, sessionToken: session });
    await restoreLargeCystFile({ store: freshClient, id, destinationPath: join(outputDir, 'restored.tar.zst'), scope, recoveryKey: key });
    expect(await readFile(join(outputDir, 'restored.tar.zst'))).toEqual(plaintext);
    for (const body of captured) {
      expect(body.includes(sentinel)).toBe(false);
      expect(body.includes(Buffer.from(key).toString('hex'))).toBe(false);
    }
    const url = origin + '/api/cysts-large/' + id;
    expect((await fetch(url + '/header')).status).toBe(401);
    expect((await fetch(url + '/manifest', { headers: { Cookie: 'telomere_session=' + foreignSession } })).status).toBe(404);
    const part = await freshClient.part(id, 0); if (!part) throw new Error('Missing fixture part');
    const validHeaders = { Cookie: 'telomere_session=' + session, Origin: origin, 'Content-Type': 'application/octet-stream' };
    const put = (body: Uint8Array, headers: Record<string, string> = validHeaders) => fetch(url + '/parts/0', { method: 'PUT', headers, body: Uint8Array.from(body) });
    expect((await put(part)).status).toBe(201); // Exact immutable replay.
    const conflicting = Uint8Array.from(part); conflicting[30] = (conflicting[30] ?? 0) ^ 1;
    expect((await put(conflicting)).status).toBe(409);
    expect((await put(part, { ...validHeaders, Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await put(part, { ...validHeaders, 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await put(part, { ...validHeaders, 'Content-Encoding': 'gzip' })).status).toBe(422);
    expect((await fetch(origin + '/api/quotes', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
      Cookie: 'telomere_session=' + session }, body: 'x'.repeat(196_609) })).status).toBe(413);
    expect((await fetch(url + '/manifest', { headers: { Cookie: 'telomere_session=' + session } })).headers.get('cache-control')).toBe('no-store');
  }, 90_000);

  it('rejects a body stream that stalls after an initial fragment', async () => {
    await writeFile(sourcePath, Buffer.from(sentinel));
    await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    const app = new Hono();
    app.onError((error, context) => context.json({ code: error instanceof Problem ? error.code : 'failed' },
      error instanceof Problem ? error.status : 503));
    app.route('/api/cysts-large', createLargeCystRoutes(store, async () => owner, { requestTimeoutMs: 30 }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
    const request = new Request('http://127.0.0.1/api/cysts-large/' + id + '/parts/0', { method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' }, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
    const response = await Promise.race([app.fetch(request), new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Stalled upload did not honor its deadline')), 1000))]);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('cyst_upload_timeout');
  });

  it('releases download slots when a caller never reads the response body', async () => {
    await writeFile(sourcePath, randomBytes(300_000));
    await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    const app = new Hono();
    app.onError((error, context) => context.json({ code: error instanceof Problem ? error.code : 'failed' },
      error instanceof Problem ? error.status : 503));
    app.route('/api/cysts-large', createLargeCystRoutes(store, async () => owner, { requestTimeoutMs: 100 }));
    const url = 'http://127.0.0.1/api/cysts-large/' + id + '/parts/0';
    const first = await app.fetch(new Request(url));
    const second = await app.fetch(new Request(url));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await app.fetch(new Request(url))).status).toBe(429);
    await new Promise(resolve => setTimeout(resolve, 160));
    const recovered = await app.fetch(new Request(url));
    expect(recovered.status).toBe(200);
    await recovered.body?.cancel();
  }, 15_000);

  it('bounds concurrent owner uploads, downloads and commits before expensive work', async () => {
    await writeFile(sourcePath, Buffer.from(sentinel));
    const manifest = await saveLargeCystFile({ store, sourcePath, id, scope, recoveryKey: key });
    const part = await store.part(id, 0); if (!part) throw new Error('Missing fixture part');
    const base = origin + '/api/cysts-large/' + id;
    const cookie = 'telomere_session=' + session;
    const put = () => fetch(base + '/parts/0', { method: 'PUT', headers: { Cookie: cookie, Origin: origin,
      'Content-Type': 'application/octet-stream' }, body: Uint8Array.from(part) });
    let putEntered = 0, putReady!: () => void, putRelease!: () => void;
    const putReadyPromise = new Promise<void>(resolve => { putReady = resolve; });
    const putBarrier = new Promise<void>(resolve => { putRelease = resolve; });
    const originalPut = store.putPart.bind(store);
    store.putPart = async (...args) => { if (++putEntered === 2) putReady(); await putBarrier; return originalPut(...args); };
    const firstPut = put(), secondPut = put();
    await putReadyPromise;
    expect((await put()).status).toBe(429);
    putRelease();
    expect((await Promise.all([firstPut, secondPut])).map(value => value.status)).toEqual([201, 201]);
    store.putPart = originalPut;

    let getEntered = 0, getReady!: () => void, getRelease!: () => void;
    const getReadyPromise = new Promise<void>(resolve => { getReady = resolve; });
    const getBarrier = new Promise<void>(resolve => { getRelease = resolve; });
    const originalPart = store.part.bind(store);
    store.part = async (...args) => { if (++getEntered === 2) getReady(); await getBarrier; return originalPart(...args); };
    const get = () => fetch(base + '/parts/0', { headers: { Cookie: cookie } });
    const firstGet = get(), secondGet = get();
    await getReadyPromise;
    expect((await get()).status).toBe(429);
    getRelease();
    const downloads = await Promise.all([firstGet, secondGet]);
    expect(downloads.map(value => value.status)).toEqual([200, 200]);
    await Promise.all(downloads.map(value => value.arrayBuffer()));
    store.part = originalPart;

    let commitReady!: () => void, commitRelease!: () => void;
    const commitReadyPromise = new Promise<void>(resolve => { commitReady = resolve; });
    const commitBarrier = new Promise<void>(resolve => { commitRelease = resolve; });
    const originalCommit = store.commit.bind(store);
    store.commit = async (...args) => { commitReady(); await commitBarrier; return originalCommit(...args); };
    const commit = () => fetch(base + '/commit', { method: 'POST', headers: { Cookie: cookie, Origin: origin,
      'Content-Type': 'application/json' }, body: JSON.stringify(manifest) });
    const firstCommit = commit(); await commitReadyPromise;
    expect((await commit()).status).toBe(429);
    commitRelease(); expect((await firstCommit).status).toBe(200);
    store.commit = originalCommit;
  }, 60_000);

  it('requires explicit startup quotas and never mounts the transfer route by default', async () => {
    const config = { MODE: 'demo', CYSTS_ENABLED: 'true', CYSTS_DIR: storageDir,
      CYSTS_LARGE_DIR: storageDir + '-other', SIGNER_PRIVATE_KEY: '0x' + '44'.repeat(32),
      DEMO_PRIVATE_KEY: '0x' + '55'.repeat(32), ESCROW_ADDRESS: '0x' + '66'.repeat(20),
      TOKEN_ADDRESS: '0x' + '77'.repeat(20) };
    expect(() => loadConfig(config)).toThrow();
    expect(() => loadConfig({ ...config, CYSTS_LARGE_GLOBAL_BYTES: String(16 * 1024 * 1024),
      CYSTS_LARGE_OWNER_BYTES: String(8 * 1024 * 1024), CYSTS_LARGE_DIR: join(storageDir, 'nested') })).toThrow();
    expect(LARGE_CYST_CHUNK_BYTES).toBe(4 * 1024 * 1024);
  });
});
