import { createServer, type Server } from 'node:http';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readPlatformMcpProfile } from '../src/mcp/platform-config.js';
import { platformPinsSchema } from '../src/platform-runtime/types.js';
import { platformVaultPinsSchema } from '../src/platform-runtime/vault-client.js';

describe('financial MCP public profile and actual stdio entry point', () => {
  let root: string, path: string, api: Server | undefined, client: Client | undefined;
  let vectors: { pins: unknown; vaultPins: unknown; config: unknown; owner: string;
    eoa: { run: { id: string }; actions: { stop: unknown } } };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-financial-mcp-')); path = join(root, 'pins.json');
    vectors = JSON.parse(await readFile('python/tests/fixtures/platform-typescript.json', 'utf8'));
    await writeFile(path, JSON.stringify({ pins: vectors.pins, vaultPins: vectors.vaultPins }));
  });
  afterEach(async () => {
    await client?.close(); client = undefined; api?.closeAllConnections();
    if (api) await new Promise<void>(done => api!.close(() => done())); api = undefined;
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-financial-mcp-')) throw new Error('Unexpected owned test directory');
    await rm(target, { recursive: true, force: true });
  });
  it('accepts only reviewed public deployment pins, with optional Vault mode', async () => {
    expect(await readPlatformMcpProfile(path)).toMatchObject({ pins: platformPinsSchema.parse(vectors.pins), vaultPins: platformVaultPinsSchema.parse(vectors.vaultPins) });
    await writeFile(path, JSON.stringify({ pins: vectors.pins }));
    expect(await readPlatformMcpProfile(path)).not.toHaveProperty('vaultPins');
    await writeFile(path, JSON.stringify({ pins: vectors.pins, signerKeyFile: 'do-not-read-private-controller-key' }));
    await expect(readPlatformMcpProfile(path)).rejects.toThrow();
  });
  it('rejects invalid UTF-8, oversized files, malformed JSON and hardlinks before connecting', async () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(16_385, 32), Buffer.from('{')]) {
      await writeFile(path, bytes); await expect(readPlatformMcpProfile(path)).rejects.toThrow();
    }
    await writeFile(path, JSON.stringify({ pins: vectors.pins }));
    await link(path, join(root, 'alias.json')); await expect(readPlatformMcpProfile(path)).rejects.toThrow();
  });
  it('negotiates official stdio, verifies scoped reads and returns an exact unsigned stop without broadcasting', async () => {
    const token = 'e'.repeat(64), paths: string[] = []; let origin = '';
    api = createServer((request, response) => {
      const requested = request.url ?? ''; paths.push(requested); response.setHeader('Content-Type', 'application/json');
      if (request.headers.cookie !== `telomere_session=${token}`) {
        response.statusCode = 401; response.end(JSON.stringify({ title: 'session_expired', detail: token })); return;
      }
      if (requested === '/api/platform/config') { response.end(JSON.stringify(vectors.config)); return; }
      if (requested === '/api/me') { response.end(JSON.stringify({ address: vectors.owner, demo: true })); return; }
      if (requested === '/api/platform/balance') { response.end(JSON.stringify({ available: '123456789' })); return; }
      if (requested === '/api/platform/runs/' + vectors.eoa.run.id) { response.end(JSON.stringify(vectors.eoa.run)); return; }
      if (requested === '/api/platform/runs/' + vectors.eoa.run.id + '/stop' && request.method === 'POST'
        && request.headers.origin === origin && request.headers['idempotency-key'] === 'stdio-stop-1') {
        response.end(JSON.stringify(vectors.eoa.actions.stop)); return;
      }
      response.statusCode = 404; response.end(JSON.stringify({ title: 'not_found', detail: token }));
    });
    await new Promise<void>(done => api!.listen(0, '127.0.0.1', done)); const address = api.address();
    if (!address || typeof address === 'string') throw new Error('Missing API address'); origin = `http://127.0.0.1:${address.port}`;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'scripts/mcp-platform.ts'], cwd: resolve('.'),
      env: { ...getDefaultEnvironment(), TELOMERE_PLATFORM_PINS_FILE: path, TELOMERE_API_URL: origin, TELOMERE_SESSION_TOKEN: token }, stderr: 'pipe' });
    client = new Client({ name: 'financial-stdio-acceptance', version: '1.0.0' }); await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(17);
    expect(await client.callTool({ name: 'telomere_platform_balance', arguments: {} })).toMatchObject({ structuredContent: { data: { available: '123456789' } } });
    const stopped = await client.callTool({ name: 'telomere_platform_stop_plan', arguments: { runId: vectors.eoa.run.id, idempotencyKey: 'stdio-stop-1' } });
    expect(stopped).toMatchObject({ structuredContent: { data: vectors.eoa.actions.stop } });
    expect(JSON.stringify(stopped)).not.toContain(token);
    expect(paths.some(value => /\/demo\/|\/auth\/|\/quotes$/.test(value))).toBe(false);
  });
});
