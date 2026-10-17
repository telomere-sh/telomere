import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { configuredLargeCysts } from '../src/cysts/large-configured.js';
import { LARGE_CYST_CHUNK_BYTES, LargeCystPrivateStore } from '../src/cysts/large-checkpoints.js';
import { LargeCystQuotaShadowStore } from '../src/cysts/large-quota-shadow.js';

const destination = (endpoint: string, region: string, failureDomain: string) => ({
  endpoint, bucket: 'telomere-large-test', region, failureDomain, reviewed: true as const,
  allowInsecureLoopback: true,
  credentials: { accessKeyId: 'local-test', secretAccessKey: 'test-secret-access-key' },
});

describe('large Cyst startup configuration', () => {
  let root: string;
  let env: Record<string, string>;
  let configPath: string;
  let servers: Server[];
  let endpoints: [string, string];
  let outages: boolean[];

  const fakeS3 = async (index: number): Promise<{ server: Server; endpoint: string }> => {
    const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
    const server = createServer(async (req, res) => {
      if (outages[index]) { res.writeHead(503).end(); return; }
      if (!req.url || !/^\/telomere-large-test\/large-cysts\/v1\/(?:_connectivity\/probe\.bin|[a-f0-9]{64}\/(?:header\.json|manifest\.json|part-[0-9]{6}\.bin))$/.test(req.url)
        || !req.headers.authorization) {
        res.writeHead(403).end(); return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (objects.has(req.url)) { res.writeHead(412).end(); return; }
        const headers = Object.fromEntries(Object.entries(req.headers)
          .filter(([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string')) as Record<string, string>;
        objects.set(req.url, { body: Buffer.concat(chunks), headers });
        res.writeHead(201).end(); return;
      }
      const saved = objects.get(req.url);
      if (req.method !== 'GET' || !saved) { res.writeHead(404).end(); return; }
      res.writeHead(200, { ...saved.headers, 'content-length': String(saved.body.length) }).end(saved.body);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing loopback address');
    return { server, endpoint: `http://127.0.0.1:${address.port}/` };
  };

  beforeEach(async () => {
    outages = [false, false];
    root = await mkdtemp(join(tmpdir(), 'telomere-large-config-'));
    await mkdir(join(root, 'small'), { mode: 0o700 });
    await mkdir(join(root, 'large'), { mode: 0o700 });
    configPath = join(root, 'large-storage.json');
    const [first, second] = await Promise.all([fakeS3(0), fakeS3(1)]);
    servers = [first.server, second.server];
    endpoints = [first.endpoint, second.endpoint];
    env = {
      MODE: 'demo', CYSTS_ENABLED: 'true', CYSTS_DIR: join(root, 'small'),
      CYSTS_LARGE_DIR: join(root, 'large'), CYSTS_LARGE_GLOBAL_BYTES: String(16 * 1024 * 1024),
      CYSTS_LARGE_OWNER_BYTES: String(8 * 1024 * 1024),
      SIGNER_PRIVATE_KEY: '0x' + '44'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '55'.repeat(32),
      ESCROW_ADDRESS: '0x' + '66'.repeat(20), TOKEN_ADDRESS: '0x' + '77'.repeat(20),
    };
  });
  afterEach(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  });

  const pair = () => ({ version: 1, destinations: [
    destination(endpoints[0], 'us-east-1', 'primary'),
    destination(endpoints[1], 'eu-west-1', 'secondary'),
  ] });
  const writePinned = async (value: object) => {
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(configPath, bytes, { mode: 0o600 });
    return { ...env, CYSTS_LARGE_REPLICATION_CONFIG: configPath,
      CYSTS_LARGE_REPLICATION_CONFIG_SHA256: '0x' + createHash('sha256').update(bytes).digest('hex') };
  };

  it('preserves the existing private local store when replication is unconfigured', async () => {
    const store = await configuredLargeCysts(loadConfig(env));
    expect(store).toBeInstanceOf(LargeCystPrivateStore);
    await store?.close();
  });

  it('requires a pin and mounts the quota shadow only for a reviewed two-destination file', async () => {
    const pinned = await writePinned(pair());
    expect(() => loadConfig({ ...pinned, CYSTS_LARGE_REPLICATION_CONFIG_SHA256: undefined })).toThrow();
    const store = await configuredLargeCysts(loadConfig(pinned));
    expect(store).toBeInstanceOf(LargeCystQuotaShadowStore);
    await store?.close();
  });

  it('commits a checkpoint through the configured local shadow and two signed S3 destinations', async () => {
    const pinned = await writePinned(pair());
    const store = await configuredLargeCysts(loadConfig(pinned));
    if (!store) throw new Error('large store missing');
    const id = '0x' + 'a'.repeat(64);
    const header = { version: 1 as const, algorithm: 'xchacha20-poly1305-chunked' as const,
      id, owner: '0x' + '1'.repeat(40), agent: '0x' + '2'.repeat(40), applicationSchema: 'test/v1',
      plaintextBytes: 3, chunkBytes: LARGE_CYST_CHUNK_BYTES, chunkCount: 1,
      sourceMac: 'b'.repeat(64), keyCommitment: 'c'.repeat(64) };
    const bytes = Buffer.alloc(43, 7);
    const manifest = { header, parts: [{ index: 0, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }], mac: 'd'.repeat(64) };
    await store.begin(header); await store.putPart(id, 0, bytes); await store.commit(manifest);
    expect(await store.manifest(id)).toEqual(manifest);
    expect(await store.part(id, 0)).toEqual(bytes);
    await store.close();
    const reopened = await configuredLargeCysts(loadConfig(pinned));
    expect(await reopened?.manifest(id)).toEqual(manifest);
    await reopened?.close();
  });

  it('reopens a bound topology read-only during one destination outage and restores writes after recovery', async () => {
    const pinned = await writePinned(pair());
    const first = await configuredLargeCysts(loadConfig(pinned));
    if (!first) throw new Error('large store missing');
    const id = '0x' + 'e'.repeat(64);
    const header = { version: 1 as const, algorithm: 'xchacha20-poly1305-chunked' as const,
      id, owner: '0x' + '1'.repeat(40), agent: '0x' + '2'.repeat(40), applicationSchema: 'test/v1',
      plaintextBytes: 3, chunkBytes: LARGE_CYST_CHUNK_BYTES, chunkCount: 1,
      sourceMac: 'b'.repeat(64), keyCommitment: 'c'.repeat(64) };
    const bytes = Buffer.alloc(43, 7);
    const manifest = { header, parts: [{ index: 0, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }], mac: 'd'.repeat(64) };
    await first.begin(header); await first.putPart(id, 0, bytes); await first.commit(manifest);
    await first.close();
    outages[1] = true;
    const degraded = await configuredLargeCysts(loadConfig(pinned));
    if (!(degraded instanceof LargeCystQuotaShadowStore)) throw new Error('replicated store missing');
    expect(degraded.readOnly).toBe(true);
    expect(await degraded.manifest(id)).toEqual(manifest);
    expect(await degraded.part(id, 0)).toEqual(bytes);
    expect(await degraded.isDurable(id)).toBe(false);
    await expect(degraded.begin(header)).rejects.toMatchObject({ code: 'storage_unavailable' });
    await degraded.close();
    outages[1] = false;
    const recovered = await configuredLargeCysts(loadConfig(pinned));
    if (!(recovered instanceof LargeCystQuotaShadowStore)) throw new Error('replicated store missing');
    expect(recovered.readOnly).toBe(false);
    expect(await recovered.isDurable(id)).toBe(true);
    await recovered.close();
  });

  it('persists the remote topology and refuses a silent switch back to local storage', async () => {
    const pinned = await writePinned(pair());
    const first = await configuredLargeCysts(loadConfig(pinned));
    await first?.close();
    await expect(configuredLargeCysts(loadConfig(env))).rejects.toMatchObject({ code: 'storage_unavailable' });
    const reopened = await configuredLargeCysts(loadConfig(pinned));
    expect(reopened).toBeInstanceOf(LargeCystQuotaShadowStore);
    await reopened?.close();
    const changed = pair();
    changed.destinations[1] = destination(endpoints[1], 'eu-west-1', 'secondary-changed');
    await expect(configuredLargeCysts(loadConfig(await writePinned(changed))))
      .rejects.toThrow('unavailable or unreviewed');
  });

  it('requires an explicit migration of a pre-existing local checkpoint', async () => {
    const local = await configuredLargeCysts(loadConfig(env));
    await local?.begin({ version: 1, algorithm: 'xchacha20-poly1305-chunked',
      id: '0x' + 'a'.repeat(64), owner: '0x' + '1'.repeat(40), agent: '0x' + '2'.repeat(40),
      applicationSchema: 'test/v1', plaintextBytes: 1, chunkBytes: LARGE_CYST_CHUNK_BYTES,
      chunkCount: 1, sourceMac: 'b'.repeat(64), keyCommitment: 'c'.repeat(64) });
    await local?.close();
    await expect(configuredLargeCysts(loadConfig(await writePinned(pair()))))
      .rejects.toThrow('unavailable or unreviewed');
  });

  it('fails startup on changed bytes or duplicate destination topology', async () => {
    const pinned = await writePinned(pair());
    await writeFile(configPath, JSON.stringify({ ...pair(), extra: true }), { mode: 0o600 });
    await expect(configuredLargeCysts(loadConfig(pinned))).rejects.toThrow('unavailable or unreviewed');
    const duplicate = pair();
    duplicate.destinations[1] = destination(endpoints[0], 'eu-west-1', 'secondary');
    await expect(configuredLargeCysts(loadConfig(await writePinned(duplicate)))).rejects.toThrow('unavailable or unreviewed');
  });

  it('does not pin an inaccessible S3 destination and allows corrected startup', async () => {
    const unreachable = pair();
    unreachable.destinations[1] = destination('http://127.0.0.1:1/', 'eu-west-1', 'secondary');
    await expect(configuredLargeCysts(loadConfig(await writePinned(unreachable))))
      .rejects.toThrow('unavailable or unreviewed');
    const corrected = await configuredLargeCysts(loadConfig(await writePinned(pair())));
    expect(corrected).toBeInstanceOf(LargeCystQuotaShadowStore);
    await corrected?.close();
  });

  it('rejects insecure loopback storage when testnet mode reaches the deployment factory', async () => {
    const config = loadConfig(await writePinned(pair()));
    await expect(configuredLargeCysts({ ...config, MODE: 'testnet' } satisfies Config))
      .rejects.toThrow('unavailable or unreviewed');
  });

  it.skipIf(process.platform === 'win32')('requires a private POSIX config file', async () => {
    const pinned = await writePinned(pair());
    await chmod(configPath, 0o644);
    await expect(configuredLargeCysts(loadConfig(pinned))).rejects.toThrow('unavailable or unreviewed');
  });
});
