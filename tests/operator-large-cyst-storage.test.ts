import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { configuredLargeCysts } from '../src/cysts/large-configured.js';
import { observeLargeCystStorage } from '../src/operator/large-cyst-storage.js';

type S3Fixture = { server: Server; endpoint: string; requests: string[]; setOutage(value: boolean): void };

async function s3Fixture(): Promise<S3Fixture> {
  let outage = false;
  const requests: string[] = [];
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  const server = createServer(async (request, response) => {
    const path = request.url ?? '';
    const method = request.method ?? '';
    requests.push(method);
    if (outage) { response.writeHead(503).end(); return; }
    if (!request.headers.authorization || path !== '/large-bucket/large-cysts/v1/_connectivity/probe.bin') {
      response.writeHead(403).end(); return;
    }
    if (method === 'PUT') {
      if (request.headers['if-none-match'] !== '*') { response.writeHead(400).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (objects.has(path)) { response.writeHead(412).end(); return; }
      const metadata = Object.fromEntries(Object.entries(request.headers)
        .filter(([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string'));
      // REASON: The filter above narrows every retained metadata value to string.
      objects.set(path, { bytes: Buffer.concat(chunks), metadata: metadata as Record<string, string> });
      response.writeHead(201).end(); return;
    }
    if (method !== 'GET') { response.writeHead(405).end(); return; }
    const object = objects.get(path);
    if (!object) { response.writeHead(404).end(); return; }
    response.writeHead(200, { ...object.metadata, 'content-length': String(object.bytes.length) }).end(object.bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('S3 fixture did not bind');
  return { server, endpoint: `http://127.0.0.1:${address.port}/`, requests,
    setOutage(value: boolean) { outage = value; } };
}

describe('read-only operator observation of configured large-Cyst S3', () => {
  let root: string, configPath: string, profile: Record<string, string>, controllerOrigin: URL;
  let s3: readonly [S3Fixture, S3Fixture], controller: Server;
  let writable: boolean, replicated: boolean, controllerChainId: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-operator-storage-'));
    await mkdir(join(root, 'small'), { mode: 0o700 });
    await mkdir(join(root, 'large'), { mode: 0o700 });
    configPath = join(root, 'replication.json');
    const [first, second] = await Promise.all([s3Fixture(), s3Fixture()]);
    s3 = [first, second];
    writable = true; replicated = true; controllerChainId = 31337;
    controller = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/api/config') { response.writeHead(404).end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ mode: 'demo', chain: { id: controllerChainId },
        token: { address: '0x' + '77'.repeat(20) }, escrowAddress: '0x' + '66'.repeat(20),
        largeCystsAvailable: true, largeCystsReplicated: replicated, largeCystsWritable: writable }));
    });
    await new Promise<void>(resolve => controller.listen(0, '127.0.0.1', resolve));
    const address = controller.address();
    if (!address || typeof address === 'string') throw new Error('Controller fixture did not bind');
    controllerOrigin = new URL(`http://127.0.0.1:${address.port}/`);
    profile = { MODE: 'demo', CYSTS_ENABLED: 'true', CYSTS_DIR: join(root, 'small'),
      CYSTS_LARGE_DIR: join(root, 'large'), CYSTS_LARGE_GLOBAL_BYTES: String(16 * 1024 * 1024),
      CYSTS_LARGE_OWNER_BYTES: String(8 * 1024 * 1024),
      SIGNER_PRIVATE_KEY: '0x' + '44'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '55'.repeat(32),
      ESCROW_ADDRESS: '0x' + '66'.repeat(20), TOKEN_ADDRESS: '0x' + '77'.repeat(20) };
  });
  afterEach(async () => {
    for (const server of [...s3.map(item => item.server), controller]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  });

  const pinnedConfig = async (base: Record<string, string>, destinations: readonly [S3Fixture, S3Fixture]): Promise<Config> => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, destinations: [
      { endpoint: destinations[0].endpoint, bucket: 'large-bucket', region: 'us-east-1',
        failureDomain: 'region-one', reviewed: true, allowInsecureLoopback: true,
        credentials: { accessKeyId: 'local-test', secretAccessKey: 'test-secret-access-key' } },
      { endpoint: destinations[1].endpoint, bucket: 'large-bucket', region: 'eu-west-1',
        failureDomain: 'region-two', reviewed: true, allowInsecureLoopback: true,
        credentials: { accessKeyId: 'local-test', secretAccessKey: 'test-secret-access-key' } },
    ] }));
    await writeFile(configPath, bytes, { mode: 0o600 });
    return loadConfig({ ...base, CYSTS_LARGE_REPLICATION_CONFIG: configPath,
      CYSTS_LARGE_REPLICATION_CONFIG_SHA256: '0x' + createHash('sha256').update(bytes).digest('hex') });
  };

  it('preserves unconfigured legacy staging without probing S3 or controller config', async () => {
    expect(await observeLargeCystStorage(loadConfig(profile), controllerOrigin)).toEqual({ status: 'not_configured' });
    expect(s3[0].requests).toEqual([]);
    expect(s3[1].requests).toEqual([]);
  });

  it('uses only signed canary GETs and reflects live destination and startup read-only faults', async () => {
    const config = await pinnedConfig(profile, s3);
    const store = await configuredLargeCysts(config);
    if (!store) throw new Error('configured storage missing');
    try {
      const before = s3.map(item => item.requests.length);
      expect(await observeLargeCystStorage(config, controllerOrigin)).toEqual({
        status: 'ready', destinations: ['ready', 'ready'],
      });
      expect(s3.map((item, index) => item.requests.slice(before[index]))).toEqual([['GET'], ['GET']]);
      s3[1].setOutage(true);
      expect(await observeLargeCystStorage(config, controllerOrigin)).toEqual({
        status: 'destination_unavailable', destinations: ['ready', 'unavailable'],
      });
      writable = false;
      expect(await observeLargeCystStorage(config, controllerOrigin)).toEqual({
        status: 'read_only', destinations: ['ready', 'unavailable'],
      });
      s3[1].setOutage(false);
      expect(await observeLargeCystStorage(config, controllerOrigin)).toEqual({
        status: 'read_only', destinations: ['ready', 'ready'],
      });
      expect(s3.every((item, index) => item.requests.slice(before[index]).every(method => method === 'GET'))).toBe(true);
    } finally { await store.close(); }
  });

  it('fails closed on changed pins, absent topology marker and wrong controller identity', async () => {
    const config = await pinnedConfig(profile, s3);
    const store = await configuredLargeCysts(config);
    if (!store) throw new Error('configured storage missing');
    try {
      controllerChainId = 84532;
      expect(await observeLargeCystStorage(config, controllerOrigin)).toMatchObject({
        status: 'unobserved', reason: 'controller_untrusted', destinations: ['ready', 'ready'],
      });
      controllerChainId = 31337;
      replicated = false;
      expect(await observeLargeCystStorage(config, controllerOrigin)).toMatchObject({
        status: 'unobserved', reason: 'controller_untrusted', destinations: ['ready', 'ready'],
      });
      replicated = true;
      await writeFile(configPath, '{}', { mode: 0o600 });
      const before = s3.map(item => item.requests.length);
      const invalid = await observeLargeCystStorage(config, controllerOrigin);
      expect(invalid).toMatchObject({
        status: 'unobserved', reason: 'configuration_untrusted',
      });
      expect(s3.map(item => item.requests.length)).toEqual(before);
      expect(JSON.stringify(invalid)).not.toContain('test-secret-access-key');
    } finally { await store.close(); }
    await pinnedConfig(profile, s3);
    await unlink(join(root, 'large', '.remote-topology.json'));
    expect(await observeLargeCystStorage(config, controllerOrigin)).toMatchObject({
      status: 'unobserved', reason: 'topology_untrusted',
    });
  });
});
