import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import pino from 'pino';
import type { Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { LargeCystPrivateStore, generateLargeCystId, restoreLargeCystFile,
  saveLargeCystFile, type LargeCystHeader, type LargeCystManifest, type LargeCystStore } from '../src/cysts/large-checkpoints.js';
import { LargeCystReplicatedStore } from '../src/cysts/large-replicated.js';
import { LargeCystHttpStore } from '../src/sdk/large-cyst-http-store.js';
import { Service } from '../src/service.js';
import { openStore } from '../src/store.js';

const owner = ('0x' + '11'.repeat(20)) as Address;
const foreign = ('0x' + '33'.repeat(20)) as Address;
const scope = { owner, agent: ('0x' + '22'.repeat(20)) as Address, applicationSchema: 'overlay.tar.zst/v1' };
const limits = { globalMaxBytes: 32 * 1024 * 1024, ownerMaxBytes: 16 * 1024 * 1024 };

class FaultStore implements LargeCystStore {
  failPut = false;
  failCommit = false;
  failRead = false;
  constructor(readonly inner: LargeCystPrivateStore) {}
  begin(header: LargeCystHeader) { return this.inner.begin(header); }
  header(id: string) { return this.inner.header(id); }
  putPart(id: string, index: number, bytes: Uint8Array) {
    if (this.failPut) throw new Error('destination down');
    return this.inner.putPart(id, index, bytes);
  }
  part(id: string, index: number) {
    if (this.failRead) throw new Error('destination down');
    return this.inner.part(id, index);
  }
  commit(manifest: LargeCystManifest) {
    if (this.failCommit) throw new Error('destination down');
    return this.inner.commit(manifest);
  }
  manifest(id: string) {
    if (this.failRead) throw new Error('destination down');
    return this.inner.manifest(id);
  }
}

describe('large Cyst two-destination persistence and recovery', () => {
  let root: string, source: string, output: string, id: string, key: Uint8Array;
  let stores: [LargeCystPrivateStore, LargeCystPrivateStore];
  let replica: LargeCystReplicatedStore;
  const directories = () => [join(root, 'destination-a'), join(root, 'destination-b')] as const;
  async function restart() {
    await Promise.all(stores.map(store => store.close()));
    stores = directories().map(directory => new LargeCystPrivateStore(directory, limits)) as typeof stores;
    await Promise.all(stores.map(store => store.initialize()));
    replica = new LargeCystReplicatedStore(stores);
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-large-cyst-replicated-'));
    source = join(root, 'source.tar.zst'); output = join(root, 'output');
    await mkdir(output, { mode: 0o700 });
    await Promise.all(directories().map(directory => mkdir(directory, { mode: 0o700 })));
    stores = directories().map(directory => new LargeCystPrivateStore(directory, limits)) as typeof stores;
    await Promise.all(stores.map(store => store.initialize()));
    replica = new LargeCystReplicatedStore(stores);
    id = generateLargeCystId(); key = randomBytes(32);
  });
  afterEach(async () => {
    key.fill(0); await Promise.all(stores.map(store => store.close()));
    await rm(root, { recursive: true, force: true });
  });

  it('acknowledges a committed checkpoint only after both destinations verify it', async () => {
    const plaintext = randomBytes(300_000); await writeFile(source, plaintext);
    const fault = new FaultStore(stores[1]); fault.failCommit = true;
    replica = new LargeCystReplicatedStore([stores[0], fault]);
    await expect(saveLargeCystFile({ store: replica, sourcePath: source, id, scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await stores[0].manifest(id)).toBeDefined();
    expect(await stores[1].manifest(id)).toBeUndefined();
    await restart();
    expect(await replica.isDurable(id)).toBe(false);
    await replica.repair(id);
    expect(await replica.isDurable(id)).toBe(true);
    await restoreLargeCystFile({ store: replica, id, destinationPath: join(output, 'restored'), scope, recoveryKey: key });
    expect(await readFile(join(output, 'restored'))).toEqual(plaintext);
  });

  it('repairs a partial part write on owner retry after both stores restart', async () => {
    const plaintext = randomBytes(240_000); await writeFile(source, plaintext);
    const fault = new FaultStore(stores[1]); fault.failPut = true;
    replica = new LargeCystReplicatedStore([stores[0], fault]);
    await expect(saveLargeCystFile({ store: replica, sourcePath: source, id, scope, recoveryKey: key }))
      .rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(await stores[0].part(id, 0)).toBeDefined();
    expect(await stores[1].part(id, 0)).toBeUndefined();
    await restart();
    await saveLargeCystFile({ store: replica, sourcePath: source, id, scope, recoveryKey: key });
    expect(await replica.isDurable(id)).toBe(true);
    expect(await stores[0].part(id, 0)).toEqual(await stores[1].part(id, 0));
  });

  it('restores from one digest-verified copy and never overwrites a present corrupt copy', async () => {
    const plaintext = randomBytes(260_000); await writeFile(source, plaintext);
    await saveLargeCystFile({ store: replica, sourcePath: source, id, scope, recoveryKey: key });
    await restart();
    const damaged = join(directories()[1], id.slice(2), 'part-000000.bin');
    const file = await open(damaged, 'r+');
    try { await file.write(Buffer.from([0xff]), 0, 1, 40); } finally { await file.close(); }
    await restoreLargeCystFile({ store: replica, id, destinationPath: join(output, 'degraded'), scope, recoveryKey: key });
    expect(await readFile(join(output, 'degraded'))).toEqual(plaintext);
    expect(await replica.isDurable(id)).toBe(false);
    await expect(replica.repair(id)).rejects.toMatchObject({ code: 'integrity_failed' });
    await Promise.all(stores.map(store => store.close()));
    await rm(damaged); // Operator removes a confirmed corrupt immutable object only with writers stopped.
    stores = directories().map(directory => new LargeCystPrivateStore(directory, limits)) as typeof stores;
    await Promise.all(stores.map(store => store.initialize()));
    replica = new LargeCystReplicatedStore(stores);
    await replica.repair(id);
    expect(await replica.isDurable(id)).toBe(true);
  });

  it('does not interpret an unknown destination outage as a missing object', async () => {
    await writeFile(source, randomBytes(200_000));
    await saveLargeCystFile({ store: replica, sourcePath: source, id, scope, recoveryKey: key });
    const fault = new FaultStore(stores[1]); fault.failRead = true;
    replica = new LargeCystReplicatedStore([stores[0], fault]);
    expect(await replica.isDurable(id)).toBe(false);
    await restoreLargeCystFile({ store: replica, id, destinationPath: join(output, 'degraded'), scope, recoveryKey: key });
    await expect(replica.repair(id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    fault.failRead = false;
    expect(await replica.isDurable(id)).toBe(true);
  });

  it('passes through the real owner-authenticated API and returns 503 for an unreplicated commit', async () => {
    await writeFile(source, randomBytes(210_000));
    const fault = new FaultStore(stores[1]); fault.failCommit = true;
    replica = new LargeCystReplicatedStore([stores[0], fault]);
    const database = await openStore({ DATA_DIR: ':memory:' });
    let server: Server | undefined;
    try {
      let listener: ReturnType<typeof getRequestListener> | undefined;
      server = createServer((request, response) => {
        if (!listener) { response.writeHead(503); response.end(); return; }
        listener(request, response);
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP port missing');
      const origin = 'http://127.0.0.1:' + address.port;
      const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin,
        SIGNER_PRIVATE_KEY: '0x' + '44'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '55'.repeat(32),
        ESCROW_ADDRESS: '0x' + '66'.repeat(20), TOKEN_ADDRESS: '0x' + '77'.repeat(20) });
      const auth = new Auth(database.db, config);
      const app = createApp(new Service(database.db, new ChainBridge(config), config, false), auth,
        pino({ enabled: false }), './dist/public', undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, replica);
      listener = getRequestListener(app.fetch);
      const session = await auth.session(owner), foreignSession = await auth.session(foreign);
      const client = new LargeCystHttpStore({ baseUrl: origin, sessionToken: session });
      await expect(saveLargeCystFile({ store: client, sourcePath: source, id, scope, recoveryKey: key }))
        .rejects.toThrow();
      expect(await stores[0].manifest(id)).toBeDefined();
      expect(await stores[1].manifest(id)).toBeUndefined();
      expect((await fetch(origin + '/api/cysts-large/' + id + '/manifest')).status).toBe(401);
      expect((await fetch(origin + '/api/cysts-large/' + id + '/manifest',
        { headers: { Cookie: 'telomere_session=' + foreignSession } })).status).toBe(404);
      fault.failCommit = false;
      await saveLargeCystFile({ store: client, sourcePath: source, id, scope, recoveryKey: key });
      expect(await replica.isDurable(id)).toBe(true);
      await restoreLargeCystFile({ store: client, id, destinationPath: join(output, 'via-http'), scope, recoveryKey: key });
      expect(await readFile(join(output, 'via-http'))).toEqual(await readFile(source));
    } finally {
      if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
      await database.close();
    }
  }, 90_000);
});
