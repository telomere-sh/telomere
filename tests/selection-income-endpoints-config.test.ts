import { once } from 'node:events';
import { chmod, link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionResult, keccak256, parseAbi, toFunctionSelector, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { loadConfig, type Config } from '../src/config.js';
import { configuredIncomeEndpoints } from '../src/selection/income-endpoints/configured.js';
import { IncomeEndpointService } from '../src/selection/income-endpoints/service.js';
import { incomeEndpointLock, incomeEndpointOperations, incomeEndpoints } from '../src/selection/income-endpoints/schema.js';
import { incomeEndpointProfileSchema } from '../src/selection/income-endpoints/types.js';
import { openStore } from '../src/store.js';

const secret = 'income-profile-private-sentinel', unavailable = 'Income endpoint configuration or reviewed deployment is unavailable';
const registry = '0x1111111111111111111111111111111111111111', implementation = '0x2222222222222222222222222222222222222222';
const escrow = '0x3333333333333333333333333333333333333333', controller = '0x4444444444444444444444444444444444444444';
const treasury = '0x5555555555555555555555555555555555555555', token = '0x6666666666666666666666666666666666666666';
const registryCode: Hex = '0x60006000', implementationCode: Hex = '0x60016000';
const hash = keccak256(toHex('income-config-canonical-block'));
const readAbi = parseAbi(['function token() view returns(address)', 'function escrow() view returns(address)',
  'function controller() view returns(address)', 'function treasury() view returns(address)',
  'function vaultImplementation() view returns(address)', 'function registry() view returns(address)']);
const reviewed = incomeEndpointProfileSchema.parse({ pins: { chainId: 31337, confirmations: 0,
  selectionRegistryAddress: registry, selectionRegistryCodeHash: keccak256(registryCode),
  vaultImplementationAddress: implementation, vaultImplementationCodeHash: keccak256(implementationCode) },
  network: 'eip155:31337', asset: token, allowedOrigins: ['https://income-endpoint.invalid'], localFixture: true });
const rpcSchema = z.object({ id: z.union([z.string(), z.number()]), method: z.string(), params: z.array(z.unknown()).default([]) }).passthrough();
type Rpc = z.infer<typeof rpcSchema>;
function block(height: bigint) {
  return { number: toHex(height), hash, parentHash: hash, nonce: '0x0000000000000000', sha3Uncles: hash,
    logsBloom: '0x' + '00'.repeat(256), transactionsRoot: hash, stateRoot: hash, receiptsRoot: hash, miner: controller,
    difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', gasLimit: '0x0', gasUsed: '0x0',
    timestamp: '0x1', transactions: [], uncles: [] };
}

describe('private reviewed income endpoint configuration with real files, HTTP RPC and PGlite', () => {
  let api: Server, origin: string, store: Awaited<ReturnType<typeof openStore>>, directory: string, path: string, config: Config;
  let providerError: boolean, rpcChain: number, rpcAsset: string;
  const requests: { path: string; method: string; rpc: Rpc }[] = [];
  const environment = (): NodeJS.ProcessEnv => ({ MODE: 'demo', CHAIN_ID: '31337', DATA_DIR: ':memory:',
    RPC_URL: origin + '/private/' + secret + '?key=' + secret, HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:3280',
    SIGNER_PRIVATE_KEY: '0x' + '11'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '22'.repeat(32), ESCROW_ADDRESS: escrow,
    TOKEN_ADDRESS: token, INCOME_ENDPOINTS_CONFIG: path });
  const testnet = () => loadConfig({ ...environment(), MODE: 'testnet', CHAIN_ID: '84532', TOKEN_ADDRESS: baseSepoliaUsdc,
    TOKEN_CODE_HASH: '0x' + 'aa'.repeat(32), TOKEN_IMPLEMENTATION_ADDRESS: '0x' + '11'.repeat(20),
    TOKEN_IMPLEMENTATION_CODE_HASH: '0x' + 'bb'.repeat(32),
    DEMO_PRIVATE_KEY: undefined, CPU_MODE: 'docker', CPU_IMAGE: 'node@sha256:' + 'aa'.repeat(32),
    DATABASE_URL: 'postgresql://fixture:private@127.0.0.1:15432/telomere', PILOT_ALLOWED_OWNERS: controller });

  beforeAll(async () => {
    api = createServer((request, response) => { void (async () => {
      let body = ''; for await (const chunk of request) body += String(chunk);
      const query = rpcSchema.parse(JSON.parse(body)); requests.push({ path: request.url ?? '', method: request.method ?? '', rpc: query });
      response.setHeader('Content-Type', 'application/json');
      const success = (result: unknown) => response.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, result }));
      const failure = () => response.end(JSON.stringify({ jsonrpc: '2.0', id: query.id,
        error: { code: -32000, message: secret + ': private provider rejected configuration' } }));
      if (providerError) { failure(); return; }
      if (query.method === 'eth_chainId') { success(toHex(rpcChain)); return; }
      if (query.method === 'eth_blockNumber') { success('0x64'); return; }
      if (query.method === 'eth_getBlockByNumber') { success(block(BigInt(z.string().parse(query.params[0])))); return; }
      if (query.method === 'eth_getCode') {
        z.object({ blockHash: z.literal(hash), requireCanonical: z.literal(true) }).strict().parse(query.params[1]);
        const address = z.string().parse(query.params[0]).toLowerCase();
        success(address === registry ? registryCode : address === implementation ? implementationCode : '0x'); return;
      }
      if (query.method !== 'eth_call') { failure(); return; }
      z.object({ blockHash: z.literal(hash), requireCanonical: z.literal(true) }).strict().parse(query.params[1]);
      const call = z.object({ to: z.string(), data: z.string() }).passthrough().parse(query.params[0]);
      const values = { token: rpcAsset, escrow, controller, treasury, vaultImplementation: implementation, registry };
      const name = (Object.keys(values) as (keyof typeof values)[]).find(name => toFunctionSelector(name + '()') === call.data.slice(0, 10));
      if (!name || ![registry, implementation].includes(call.to.toLowerCase())) { failure(); return; }
      success(encodeFunctionResult({ abi: readAbi, functionName: name, result: values[name] as `0x${string}` }));
    })().catch(() => { if (!response.headersSent) response.statusCode = 500; response.end('{}'); }); });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const address = api.address(); if (!address || typeof address === 'string') throw new Error('Missing configuration RPC fixture');
    origin = 'http://127.0.0.1:' + address.port; store = await openStore({ DATA_DIR: ':memory:' });
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-income-endpoint-config-')); path = join(directory, secret + '.json');
    await writeFile(path, JSON.stringify(reviewed), { mode: 0o600 });
    providerError = false; rpcChain = 31337; rpcAsset = token; requests.length = 0; config = loadConfig(environment());
  });
  afterEach(async () => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-income-endpoint-config-')) throw new Error('Unexpected fixture directory');
    await rm(target, { recursive: true, force: true });
  });
  afterAll(async () => { await store?.close(); api?.closeAllConnections(); if (api) await new Promise<void>(resolve => api.close(() => resolve())); });

  async function rejected(value = config, rpcExpected = false) {
    let failure: unknown; try { await configuredIncomeEndpoints(value, store.db); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).toBe('Error: ' + unavailable);
    for (const privateValue of [secret, origin, directory]) expect(String(failure)).not.toContain(privateValue);
    expect(failure).not.toHaveProperty('cause');
    if (rpcExpected) expect(requests.length).toBeGreaterThan(0); else expect(requests).toHaveLength(0);
  }

  it('stays disabled with no profile path and makes no RPC request', async () => {
    expect(loadConfig({ ...environment(), INCOME_ENDPOINTS_CONFIG: undefined }).INCOME_ENDPOINTS_CONFIG).toBeUndefined();
    await expect(configuredIncomeEndpoints(loadConfig({ ...environment(), INCOME_ENDPOINTS_CONFIG: undefined }), store.db)).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });
  it('initializes the actual read-only service and schema from an explicit private local-fixture profile', async () => {
    const service = await configuredIncomeEndpoints(config, store.db);
    expect(service).toBeInstanceOf(IncomeEndpointService); expect(service?.publicConfig()).toMatchObject({ pins: reviewed.pins,
      network: 'eip155:31337', asset: token, incomeCredit: 'none', paymentCapabilityVerified: false });
    expect(JSON.stringify(service?.publicConfig())).not.toContain('allowedOrigins');
    expect(await store.db.select().from(incomeEndpointLock)).toEqual([{ id: 1 }]);
    expect(await store.db.select().from(incomeEndpoints)).toEqual([]); expect(await store.db.select().from(incomeEndpointOperations)).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => request.method === 'POST' && request.path === '/private/' + secret + '?key=' + secret
      && ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(request.rpc.method))).toBe(true);
  });
  it('accepts the exact 8 KiB bound and closes failed profile reads before a corrected retry', async () => {
    await writeFile(path, Buffer.from([0xff])); await rejected();
    const body = JSON.stringify(reviewed); await writeFile(path, body + ' '.repeat(8192 - Buffer.byteLength(body)));
    expect((await lstat(path)).size).toBe(8192);
    await expect(configuredIncomeEndpoints(config, store.db)).resolves.toBeInstanceOf(IncomeEndpointService);
  });
  it('initializes a confirmed testnet profile only when runtime chain and asset match independently read deployment', async () => {
    rpcChain = 84532; rpcAsset = baseSepoliaUsdc;
    await writeFile(path, JSON.stringify({ ...reviewed, pins: { ...reviewed.pins, chainId: 84532, confirmations: 1 },
      network: 'eip155:84532', asset: baseSepoliaUsdc, localFixture: false }));
    await expect(configuredIncomeEndpoints(testnet(), store.db)).resolves.toBeInstanceOf(IncomeEndpointService);
    expect(requests.some(request => request.rpc.method === 'eth_getBlockByNumber' && request.rpc.params[0] === '0x63')).toBe(true);
  });
  it.each(['missing', 'directory'] as const)('rejects a %s path before RPC', async kind => {
    const name = join(directory, kind); if (kind === 'directory') await mkdir(name, { mode: 0o700 });
    await rejected({ ...config, INCOME_ENDPOINTS_CONFIG: name });
  });
  it.each(['empty', 'malformed', 'oversized', 'invalid-utf8'] as const)('rejects %s file contents before RPC', async kind => {
    const body = kind === 'empty' ? '' : kind === 'malformed' ? '{"private":' : kind === 'oversized' ? ' '.repeat(8193) : Buffer.from([0xc3, 0x28]);
    await writeFile(path, body); await rejected();
  });
  it.each(['top-level', 'nested', 'escaped'] as const)('rejects duplicate %s JSON keys whose last value would otherwise be valid', async kind => {
    let body = JSON.stringify(reviewed);
    if (kind === 'top-level') body = body.replace('"network":"eip155:31337"', '"network":"eip155:84532","network":"eip155:31337"');
    else if (kind === 'nested') body = body.replace('"chainId":31337', '"chainId":84532,"chainId":31337');
    else body = body.replace('"network":"eip155:31337"', '"netw\\u006frk":"eip155:84532","network":"eip155:31337"');
    expect(JSON.parse(body)).toEqual(reviewed); await writeFile(path, body); await rejected();
  });
  it.each(['chain', 'asset', 'unknown-field', 'invalid-pin'] as const)('rejects the %s reviewed profile boundary before RPC', async kind => {
    const profile = kind === 'chain' ? { ...reviewed, pins: { ...reviewed.pins, chainId: 31338 }, network: 'eip155:31338', localFixture: false }
      : kind === 'asset' ? { ...reviewed, asset: treasury } : kind === 'unknown-field' ? { ...reviewed, privateKey: secret }
        : { ...reviewed, pins: { ...reviewed.pins, selectionRegistryCodeHash: { hash: reviewed.pins.selectionRegistryCodeHash } } };
    await writeFile(path, JSON.stringify(profile)); await rejected();
  });
  it('rejects an explicit fixture on a DNS name even when the runtime demo origin accepts localhost', async () => {
    const rpc = new URL(config.RPC_URL); rpc.hostname = 'localhost';
    await rejected(loadConfig({ ...environment(), RPC_URL: rpc.href }));
  });
  it.each(['fixture', 'zero-confirmations'] as const)('rejects testnet %s policy before RPC', async kind => {
    await writeFile(path, JSON.stringify({ ...reviewed, pins: { ...reviewed.pins, chainId: 84532, confirmations: kind === 'fixture' ? 1 : 0 },
      network: 'eip155:84532', asset: baseSepoliaUsdc, localFixture: kind === 'fixture' }));
    await rejected(testnet());
  });
  it('rejects both names of a real hard-linked profile before RPC', async () => {
    const alias = join(directory, 'hardlink.json'); await link(path, alias); expect((await lstat(path)).nlink).toBe(2);
    await rejected(); await rejected({ ...config, INCOME_ENDPOINTS_CONFIG: alias });
  });
  it('rejects a real symlink instead of following its valid private profile target', async context => {
    const alias = join(directory, 'symlink.json');
    try { await symlink(path, alias, 'file'); }
    catch (error) { if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
      context.skip('Creating a Windows file symlink requires an OS privilege'); return;
    } throw error; }
    expect((await lstat(alias)).isSymbolicLink()).toBe(true); await rejected({ ...config, INCOME_ENDPOINTS_CONFIG: alias });
  });
  it.skipIf(process.platform === 'win32')('rejects group/world POSIX profile permissions', async () => {
    for (const mode of [0o644, 0o620, 0o601]) { await chmod(path, mode); await rejected(); }
  });
  it('rejects RPC URL credentials before dispatch and redacts the private path', async () => {
    const rpc = new URL(config.RPC_URL); rpc.username = secret; rpc.password = secret;
    await rejected(loadConfig({ ...environment(), RPC_URL: rpc.href }));
  });
  it('redacts an actual provider initialization failure without probing an endpoint or broadcasting', async () => {
    providerError = true; await rejected(config, true);
    expect(requests.every(request => request.method === 'POST' && request.rpc.method === 'eth_blockNumber')).toBe(true);
  });
});
