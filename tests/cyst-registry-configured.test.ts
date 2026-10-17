import { once } from 'node:events';
import { chmod, link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { loadConfig, type Config } from '../src/config.js';
import { configuredCystRegistry } from '../src/cysts/registry-configured.js';
import { cystRegistryPinsSchema } from '../src/cysts/registry-types.js';
import { CystService } from '../src/cysts/service.js';
import { openStore } from '../src/store.js';

const owner = '0x1111111111111111111111111111111111111111';
const secret = 'private-cyst-registry-config-sentinel';
const unavailable = 'Cyst registry configuration or reviewed deployment is unavailable';
const pins = cystRegistryPinsSchema.parse({ chainId: 31337, confirmations: 0,
  registryAddress: '0x4444444444444444444444444444444444444444', registryCodeHash: keccak256('0x60006000'),
  selectionRegistryAddress: '0x5555555555555555555555555555555555555555', selectionRegistryCodeHash: keccak256('0x60016000') });

describe('public CystRegistry configuration boundary with real private files and checkpoint storage', () => {
  let api: Server, origin: string, store: Awaited<ReturnType<typeof openStore>>;
  let root: string, pinsPath: string, config: Config, cysts: CystService;
  const requests: string[] = [];
  const environment = (): NodeJS.ProcessEnv => ({ MODE: 'demo', CHAIN_ID: '31337', DATA_DIR: ':memory:',
    RPC_URL: origin + '/private/' + secret + '?api-key=' + secret, HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:3280',
    SIGNER_PRIVATE_KEY: '0x' + '11'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '22'.repeat(32),
    ESCROW_ADDRESS: '0x3333333333333333333333333333333333333333', TOKEN_ADDRESS: '0x6666666666666666666666666666666666666666',
    CYSTS_ENABLED: 'true', CYSTS_DIR: join(root, 'ciphertexts'), CYST_REGISTRY_CONFIG: pinsPath });

  beforeAll(async () => {
    api = createServer((request, response) => {
      requests.push(request.url ?? '');
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const query: { id: unknown } = JSON.parse(body);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, error: { code: -32000,
          message: secret + ': private provider configuration was rejected' } }));
      });
    });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const address = api.address(); if (!address || typeof address === 'string') throw new Error('Missing configuration RPC fixture');
    origin = 'http://127.0.0.1:' + address.port;
    store = await openStore({ DATA_DIR: ':memory:' });
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-cyst-registry-config-'));
    pinsPath = join(root, secret + '.json'); requests.length = 0;
    await writeFile(pinsPath, JSON.stringify(pins), { mode: 0o600 });
    config = loadConfig(environment());
    cysts = new CystService(store.db, config.CYSTS_DIR ?? join(root, 'ciphertexts'));
    await cysts.initialize();
  });
  afterEach(async () => {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-cyst-registry-config-')) {
      throw new Error('Unexpected owned configuration test directory');
    }
    await rm(target, { recursive: true, force: true });
  });
  afterAll(async () => {
    await store?.close(); api?.closeAllConnections();
    if (api) await new Promise<void>(resolve => api.close(() => resolve()));
  });

  async function rejected(value: Config = config, storage: CystService | undefined = cysts, rpcExpected = false): Promise<void> {
    let error: unknown;
    try { await configuredCystRegistry(storage, value); } catch (received) { error = received; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: ' + unavailable);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(origin);
    expect(String(error)).not.toContain(root);
    expect(error).not.toHaveProperty('cause');
    if (rpcExpected) expect(requests.length).toBeGreaterThan(0);
    else expect(requests).toHaveLength(0);
  }

  it('keeps the registry optional when its reviewed file is not configured', async () => {
    const disabled = loadConfig({ ...environment(), CYST_REGISTRY_CONFIG: undefined, CYSTS_ENABLED: 'false', CYSTS_DIR: undefined });
    await expect(configuredCystRegistry(undefined, disabled)).resolves.toBeUndefined();
    await expect(configuredCystRegistry(cysts, loadConfig({ ...environment(), CYST_REGISTRY_CONFIG: undefined }))).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it('requires enabled encrypted checkpoint storage at the public environment boundary', () => {
    expect(() => loadConfig({ ...environment(), CYSTS_ENABLED: 'false' })).toThrow('CystRegistry requires enabled encrypted checkpoint storage');
    expect(requests).toHaveLength(0);
  });

  it('refuses a reviewed registry configuration when no checkpoint service was initialized', async () => {
    // Call the exported boundary directly with the absent dependency rather than a fake CystService.
    await expect(configuredCystRegistry(undefined, config)).rejects.toThrow(unavailable);
    expect(requests).toHaveLength(0);
  });

  it.each(['missing', 'directory'] as const)('refuses a %s reviewed config path before RPC', async mode => {
    const path = join(root, mode);
    if (mode === 'directory') await mkdir(path, { mode: 0o700 });
    await rejected({ ...config, CYST_REGISTRY_CONFIG: path });
  });

  it.each(['empty', 'malformed-json', 'oversized'] as const)('refuses a %s reviewed file before RPC', async mode => {
    const body = mode === 'empty' ? '' : mode === 'oversized' ? 'x'.repeat(8193) : '{"privateProvider":"' + secret;
    await writeFile(pinsPath, body, { mode: 0o600 });
    await rejected();
  });

  it('rejects reviewed pins for a different chain before any provider request', async () => {
    await writeFile(pinsPath, JSON.stringify({ ...pins, chainId: 31338 }), { mode: 0o600 });
    await rejected();
  });

  it.each(['api-wrapper', 'nested-code-hash'] as const)('refuses %s pin structure at the reviewed file boundary', async mode => {
    const value = mode === 'api-wrapper' ? { pins } : { ...pins, selectionRegistryCodeHash: { hash: pins.selectionRegistryCodeHash } };
    await writeFile(pinsPath, JSON.stringify(value), { mode: 0o600 });
    await rejected();
  });

  it('rejects zero confirmation depth in the testnet profile before RPC', async () => {
    await writeFile(pinsPath, JSON.stringify({ ...pins, chainId: 84532, confirmations: 0 }), { mode: 0o600 });
    const testnet = loadConfig({ ...environment(), MODE: 'testnet', CHAIN_ID: '84532', TOKEN_ADDRESS: baseSepoliaUsdc,
  TOKEN_CODE_HASH: '0x' + 'aa'.repeat(32), TOKEN_IMPLEMENTATION_ADDRESS: '0x' + '11'.repeat(20),
  TOKEN_IMPLEMENTATION_CODE_HASH: '0x' + 'bb'.repeat(32),
      DEMO_PRIVATE_KEY: undefined, CPU_MODE: 'docker', CPU_IMAGE: 'node@sha256:' + 'aa'.repeat(32),
      DATABASE_URL: 'postgresql://fixture:private@127.0.0.1:15432/telomere', PILOT_ALLOWED_OWNERS: owner });
    await rejected(testnet);
  });

  it('refuses either name of a real multiply linked reviewed file before RPC', async () => {
    const alias = join(root, 'hardlink.json'); await link(pinsPath, alias);
    expect((await lstat(pinsPath)).nlink).toBe(2);
    await rejected();
    await rejected({ ...config, CYST_REGISTRY_CONFIG: alias });
  });

  it('refuses an actual file symlink instead of following its reviewed JSON target', async context => {
    const alias = join(root, 'symlink.json');
    try { await symlink(pinsPath, alias, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
        context.skip('Creating Windows file symlinks requires an OS privilege'); return;
      }
      throw error;
    }
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    await rejected({ ...config, CYST_REGISTRY_CONFIG: alias });
  });

  it.skipIf(process.platform === 'win32')('refuses group/world-readable reviewed config permissions on POSIX', async () => {
    await chmod(pinsPath, 0o644);
    await rejected();
  });

  it('rejects an RPC URL containing credentials without contacting it or exposing them', async () => {
    const url = new URL(config.RPC_URL); url.username = secret; url.password = secret;
    const credentials = loadConfig({ ...environment(), RPC_URL: url.toString() });
    await rejected(credentials);
  });

  it('redacts a real provider failure after a valid private file reaches reviewed deployment initialization', async () => {
    await rejected(config, cysts, true);
    expect(requests).toEqual(['/private/' + secret + '?api-key=' + secret]);
  });
});
