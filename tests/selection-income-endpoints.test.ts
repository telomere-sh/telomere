import { serve } from '@hono/node-server';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { compileContracts } from '../scripts/compile-contracts.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { Auth } from '../src/auth.js';
import { Problem } from '../src/common.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, transactions } from '../src/store.js';
import { createIncomeEndpointRoutes, incomeChallengeSchema, incomeEndpointProfileSchema, incomeEndpointProofMessage,
  incomeEndpoints, incomeEndpointOperations, IncomeEndpointService, isPublicIncomeEndpointAddress,
  probeIncomeEndpoint, RpcIncomeEndpointReader, type IncomeChallenge, type IncomeEndpointProfile } from '../src/selection/income-endpoints/index.js';
import { incomeStrictJson } from '../src/selection/income-endpoints/json.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const hash = (value: string) => keccak256(toHex(value));
const viewSchema = z.object({ id: z.string(), agentId: z.string(), url: z.string(), revision: z.string(), declared: z.boolean(),
  controlVerified: z.boolean(), termsMatchReviewedProfile: z.boolean(), incomeCredit: z.literal('none'),
  paymentCapabilityVerified: z.literal(false), verification: z.unknown() }).passthrough();
type View = z.infer<typeof viewSchema>;
async function fixture() {
  const artifacts = compileContracts(['PlatformSelectionRegistry.sol', 'PlatformAgentVault.sol', 'PlatformRunEscrow.sol',
    'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(hash('income-endpoint-host'), artifacts);
  try { const vault = await deployPlatformVault(local); await local.test.mine({ blocks: 3 });
    // REASON: The real compiled Selection identityAgent getter returns bytes32.
    return { ...local, vault, agentId: vault.agentId as Hex }; }
  catch (error) { await local.close(); throw error; }
}

describe('durable Selection income endpoint declarations with actual agent proofs, HTTP and Anvil authority', () => {
  let deployed: Awaited<ReturnType<typeof fixture>>, snapshot: Hex, root: string, config: Config, profile: IncomeEndpointProfile;
  let store: Awaited<ReturnType<typeof openStore>>, service: IncomeEndpointService, auth: Auth;
  let api: ReturnType<typeof serve> | undefined, endpointServer: HttpServer | undefined, endpointOrigin: string;
  let ownerCookie: string, agentCookie: string, outsiderCookie: string, now: number, serial: number;
  let mode: 'normal' | 'wrong-terms' | 'missing-terms' | 'redirect' | 'huge' | 'invalid-utf8' | 'duplicate-body' | 'duplicate-header' | 'stalled' = 'normal';
  const proofs = new Map<string, { challenge: IncomeChallenge; signature: Hex }>();
  const requests: { method: string | undefined; url: string | undefined; headers: Record<string, string | string[] | undefined> }[] = [];
  beforeAll(async () => { deployed = await fixture(); snapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot();
    root = await mkdtemp(join(tmpdir(), 'telomere-income-endpoints-')); now = Date.now(); serial = 0; proofs.clear(); requests.length = 0; mode = 'normal';
    endpointServer = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, headers: request.headers });
      if (mode === 'stalled') return;
      if (mode === 'redirect') { response.writeHead(302, { Location: endpointOrigin + '/redirected' }); response.end(); return; }
      const nonce = request.headers['x-telomere-verification-nonce'], proof = typeof nonce === 'string' ? proofs.get(nonce) : undefined;
      const required = { x402Version: 2, resource: { url: endpointOrigin + (request.url ?? '/') }, accepts: [{ scheme: 'exact',
        network: profile.network, asset: mode === 'wrong-terms' ? deployed.accounts.outsider.address : profile.asset,
        payTo: deployed.vault.agent.vault, amount: '1000', maxTimeoutSeconds: 60 }] };
      const header = Buffer.from(JSON.stringify(required)).toString('base64');
      response.statusCode = 402; response.setHeader('Content-Type', 'application/json');
      if (mode !== 'missing-terms') response.setHeader('PAYMENT-REQUIRED', mode === 'duplicate-header' ? [header, header] : header);
      if (mode === 'huge') { response.write('{"proof":'); response.end(' '.repeat(40_000)); return; }
      if (mode === 'invalid-utf8') { response.end(Buffer.from([0xc0, 0xaf])); return; }
      const body = JSON.stringify({ proof });
      response.end(mode === 'duplicate-body' ? '{"proof":null,"proof":' + JSON.stringify(proof) + '}' : body);
    });
    await new Promise<void>((done, reject) => endpointServer?.once('error', reject).listen(0, '127.0.0.1', done));
    const address = endpointServer.address(); if (!address || typeof address === 'string') throw new Error('Endpoint fixture port missing');
    endpointOrigin = 'http://127.0.0.1:' + address.port;
    profile = incomeEndpointProfileSchema.parse({ pins: { chainId: 31337, selectionRegistryAddress: deployed.vault.registryAddress,
      selectionRegistryCodeHash: deployed.vault.pins.registryCodeHash, vaultImplementationAddress: deployed.vault.implementationAddress,
      vaultImplementationCodeHash: deployed.vault.pins.implementationCodeHash, confirmations: 1 }, network: 'eip155:31337',
      asset: deployed.pins.tokenAddress, allowedOrigins: [endpointOrigin], localFixture: true });
    const port = await unusedLocalPort();
    config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: deployed.local.rpcUrl, DATA_DIR: join(root, 'db'),
      ESCROW_ADDRESS: deployed.pins.escrowAddress, TOKEN_ADDRESS: deployed.pins.tokenAddress, SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'http://127.0.0.1:' + port, CPU_MODE: 'demo', LOG_LEVEL: 'error' });
    await openApi(); ownerCookie = await login(deployed.accounts.owner); agentCookie = await login(deployed.vault.account); outsiderCookie = await login(deployed.accounts.outsider);
  }, 30_000);
  afterEach(async () => {
    if (api) { const server = api; api = undefined; await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
    endpointServer?.closeAllConnections();
    if (endpointServer) { const server = endpointServer; endpointServer = undefined; await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
    await store?.close();
    if (root) { const path = resolve(root); if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('telomere-income-endpoints-')) throw new Error('Unexpected owned endpoint fixture');
      await rm(path, { recursive: true, force: true }); }
  });
  afterAll(async () => { await deployed?.close(); });
  async function openApi() {
    store = await openStore(config); auth = new Auth(store.db, config);
    service = new IncomeEndpointService(store.db, new RpcIncomeEndpointReader({ rpcUrl: deployed.local.rpcUrl, pins: profile.pins, asset: profile.asset }),
      profile, { clock: () => now, probeTimeoutMs: 150 }); await service.initialize();
    const app = new Hono();
    app.onError((error, context) => context.json({ code: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method !== 'GET' && context.req.header('origin') !== config.PUBLIC_ORIGIN) throw new Problem(403, 'origin_mismatch', 'Origin differs'); await next();
    });
    app.post('/api/auth/challenge', async context => { const input = z.object({ address: z.string().transform(value => getAddress(value)) }).parse(await context.req.json()); return context.json(await auth.challenge(input.address)); });
    app.post('/api/auth/verify', async context => {
      const input = z.object({ address: z.string().transform(value => getAddress(value)), nonce: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).parse(await context.req.json());
      // REASON: The signature expression above validates exact 65-byte hex input for the real Auth boundary.
      const token = await auth.verify(input.address, input.nonce, input.signature as Hex); setCookie(context, 'telomere_session', token, { httpOnly: true, sameSite: 'Strict', path: '/' }); return context.json({ ok: true });
    });
    app.route('/api/selection/income-endpoints', createIncomeEndpointRoutes(service, context => auth.owner(getCookie(context, 'telomere_session'))));
    api = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });
    await new Promise<void>((done, reject) => { if (api?.listening) done(); else api?.once('listening', done).once('error', reject); });
  }
  function post(path: string, body: unknown, cookie = ownerCookie, key = 'endpoint-' + ++serial, origin = config.PUBLIC_ORIGIN) {
    return fetch(config.PUBLIC_ORIGIN + path, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  }
  function get(path: string, cookie = ownerCookie) { return fetch(config.PUBLIC_ORIGIN + path, { headers: { Cookie: cookie } }); }
  const base = () => '/api/selection/income-endpoints/agents/' + deployed.agentId + '/endpoints';
  async function login(account: typeof deployed.accounts.owner) {
    const response = await post('/api/auth/challenge', { address: account.address }, ''); expect(response.status).toBe(200);
    const challenge = z.object({ nonce: z.string(), message: z.string() }).parse(await response.json());
    const verified = await post('/api/auth/verify', { address: account.address, nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) }, '');
    expect(verified.status).toBe(200); const cookie = verified.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Endpoint real Auth cookie missing'); return cookie;
  }
  async function declare(path = '/service', key?: string) {
    const response = await post(base(), { url: endpointOrigin + path, expectedRevision: '0' }, ownerCookie, key); expect(response.status).toBe(200); return viewSchema.parse(await response.json());
  }
  async function challenge(row: View, account = deployed.vault.account) {
    const response = await post(base() + '/' + row.id + '/challenge', { expectedRevision: row.revision }); expect(response.status).toBe(200);
    const issued = z.object({ challenge: incomeChallengeSchema, message: z.string() }).parse(await response.json());
    expect(issued.message).toBe(incomeEndpointProofMessage(issued.challenge));
    const signature = await account.signMessage({ message: issued.message }); proofs.set(issued.challenge.nonce, { challenge: issued.challenge, signature }); return issued;
  }
  async function verify(row: View, key?: string) {
    const response = await post(base() + '/' + row.id + '/verify', { expectedRevision: row.revision }, ownerCookie, key); return response;
  }
  async function verified(path = '/service') {
    const row = await declare(path); await challenge(row); const response = await verify(row); expect(response.status).toBe(200); return viewSchema.parse(await response.json());
  }

  it('declares, serves an actual agent-signed proof over GET, verifies reviewed x402 terms and persists through PGlite reopen without money', async () => {
    const balance = await deployed.local.publicClient.readContract({ address: deployed.pins.tokenAddress, abi: deployed.artifact('MockToken').abi, functionName: 'balanceOf', args: [deployed.vault.agent.vault] });
    const before = await deployed.local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address });
    const row = await declare('/service', 'declare-exact'); expect(row).toMatchObject({ declared: true, revision: '1', controlVerified: false, termsMatchReviewedProfile: false });
    expect(requests).toHaveLength(0); await challenge(row); expect(requests).toHaveLength(0);
    const response = await verify(row, 'verify-exact'); expect(response.status).toBe(200);
    const result = viewSchema.parse(await response.json()); expect(result).toMatchObject({ controlVerified: true, termsMatchReviewedProfile: true, incomeCredit: 'none', paymentCapabilityVerified: false });
    expect(requests).toHaveLength(1); const request = requests[0]; expect(request).toMatchObject({ method: 'GET', url: '/service' });
    expect(request?.headers).not.toHaveProperty('cookie'); expect(request?.headers).not.toHaveProperty('authorization'); expect(request?.headers).not.toHaveProperty('payment-signature');
    expect(Object.keys(request?.headers ?? {}).some(key => key.includes('signature'))).toBe(false);
    expect((await verify(row, 'verify-exact')).status).toBe(200); expect(requests).toHaveLength(1);
    const publicConfig = await (await get('/api/selection/income-endpoints/config')).json(); expect(publicConfig).not.toHaveProperty('allowedOrigins');
    expect(await store.db.select().from(transactions)).toHaveLength(0);
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address })).toBe(before);
    expect(await deployed.local.publicClient.readContract({ address: deployed.pins.tokenAddress, abi: deployed.artifact('MockToken').abi, functionName: 'balanceOf', args: [deployed.vault.agent.vault] })).toBe(balance);
    if (!api) throw new Error('API missing'); await new Promise<void>((done, reject) => api?.close(error => error ? reject(error) : done())); api = undefined; await store.close(); await openApi();
    expect(viewSchema.parse(await (await get(base() + '/' + row.id, agentCookie)).json()).controlVerified).toBe(true);
    expect((await store.db.select().from(incomeEndpointOperations))).toHaveLength(3);
  });
  it('requires owner mutation authority and real sessions, while the registered agent can read but cannot replace its owner', async () => {
    expect((await get(base(), '')).status).toBe(401); expect((await get(base(), outsiderCookie)).status).toBe(403);
    for (const cookie of [agentCookie, outsiderCookie]) expect((await post(base(), { url: endpointOrigin + '/service', expectedRevision: '0' }, cookie)).status).toBe(403);
    const row = await declare(); expect((await get(base() + '/' + row.id, agentCookie)).status).toBe(200);
    for (const action of ['challenge', 'verify', 'revoke']) expect((await post(base() + '/' + row.id + '/' + action, { expectedRevision: '1' }, agentCookie)).status).toBe(403);
    expect((await post(base(), { url: endpointOrigin + '/service', expectedRevision: '0' }, ownerCookie, 'origin', 'https://wrong.invalid')).status).toBe(403);
    expect(requests).toHaveLength(0);
  });
  it.each(['owner', 'outsider'] as const)('rejects an endpoint proof signed by the %s instead of the actual agent key', async who => {
    const row = await declare(); await challenge(row, deployed.accounts[who]); const response = await verify(row);
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code: 'income_endpoint_proof_invalid' });
    expect(viewSchema.parse(await (await get(base() + '/' + row.id)).json()).controlVerified).toBe(false);
  });
  it.each(['wrong-terms', 'missing-terms'] as const)('keeps endpoint control separate from reviewed terms for %s', async scenario => {
    const row = await declare(); await challenge(row); mode = scenario; const response = await verify(row); expect(response.status).toBe(200);
    expect(viewSchema.parse(await response.json())).toMatchObject({ declared: true, controlVerified: true, termsMatchReviewedProfile: false, incomeCredit: 'none' });
  });
  it('binds every proof context field, nonce and expiry and never accepts a request echo', async () => {
    const row = await declare(), issued = await challenge(row), proof = proofs.get(issued.challenge.nonce); if (!proof) throw new Error('Proof missing');
    for (const changed of [{ vault: deployed.accounts.owner.address }, { revision: '2' }, { url: endpointOrigin + '/different' },
      { agentId: hash('different agent') }, { chainId: 84532 }, { selectionRegistryAddress: deployed.pins.escrowAddress },
      { owner: deployed.accounts.outsider.address }, { expiresAt: String(Number(issued.challenge.expiresAt) + 1) }, { nonce: hash('wrong nonce') }]) {
      proofs.set(issued.challenge.nonce, { challenge: { ...proof.challenge, ...changed }, signature: proof.signature }); expect((await verify(row)).status).toBe(422);
    }
    proofs.set(issued.challenge.nonce, proof); expect((await verify(row)).status).toBe(200);
  });
  it('consumes a challenge once, prevents replaced-proof replay and expires previous verification evidence', async () => {
    const row = await declare(), first = await challenge(row); expect((await verify(row, 'first-verification')).status).toBe(200);
    expect((await verify(row)).status).toBe(409); const second = await challenge(row), previous = proofs.get(first.challenge.nonce);
    if (!previous) throw new Error('First proof missing'); proofs.set(second.challenge.nonce, previous); expect((await verify(row)).status).toBe(422);
    now = Number(second.challenge.expiresAt) * 1000; expect((await verify(row)).status).toBe(409);
    expect(viewSchema.parse(await (await get(base() + '/' + row.id)).json()).controlVerified).toBe(false);
    expect((await verify(row, 'first-verification')).status).toBe(200);
    expect(viewSchema.parse(await (await get(base() + '/' + row.id)).json()).verification).toBeNull();
  });
  it('uses monotonic CAS revisions, exact durable operation input and revoke/redeclare without retaining proof validity', async () => {
    const row = await verified(), responses = await Promise.all(['race-a', 'race-b'].map(key => post(base(), { url: row.url, expectedRevision: '1' }, ownerCookie, key)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const current = viewSchema.parse(await (await get(base() + '/' + row.id)).json()); expect(current).toMatchObject({ revision: '2', controlVerified: false });
    expect((await verify(row)).status).toBe(409);
    const revoked = await post(base() + '/' + row.id + '/revoke', { expectedRevision: '2' }, ownerCookie, 'revoke-once'); expect(revoked.status).toBe(200);
    expect(viewSchema.parse(await revoked.json())).toMatchObject({ revision: '3', declared: false, controlVerified: false });
    expect((await post(base() + '/' + row.id + '/revoke', { expectedRevision: '2' }, ownerCookie, 'revoke-once')).status).toBe(200);
    expect((await post(base() + '/' + row.id + '/challenge', { expectedRevision: '3' })).status).toBe(409);
    expect((await post(base(), { url: row.url, expectedRevision: '3' }, ownerCookie, 'revoke-once')).status).toBe(409);
    const redeclared = await post(base(), { url: row.url, expectedRevision: '3' }); expect(redeclared.status).toBe(200);
    expect(viewSchema.parse(await redeclared.json())).toMatchObject({ id: row.id, revision: '4', declared: true, controlVerified: false });
  });
  it('invalidates previously verified evidence after an actual canonical Anvil reorg while keeping the declaration separate', async () => {
    const fork = await deployed.test.snapshot(); await deployed.test.mine({ blocks: 3 }); const row = await verified();
    await deployed.test.revert({ id: fork }); await deployed.test.setNextBlockTimestamp({ timestamp: (await deployed.local.publicClient.getBlock()).timestamp + 123n }); await deployed.test.mine({ blocks: 5 });
    expect(viewSchema.parse(await (await get(base() + '/' + row.id)).json())).toMatchObject({ declared: true, controlVerified: false, termsMatchReviewedProfile: false });
  });
  it('keeps frozen and dormant agent evidence separate from compute eligibility and permits owner revocation after actual death', async () => {
    await deployed.confirmed(deployed.vault.guardianWallet.writeContract({ address: deployed.vault.registryAddress, abi: deployed.artifact('PlatformSelectionRegistry').abi,
      functionName: 'setFrozen', args: [deployed.agentId, true, 'fixture policy', hash('freeze evidence')] })); await deployed.test.mine({ blocks: 2 });
    const row = await verified(); expect(row.controlVerified).toBe(true);
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.agent.vault, abi: deployed.artifact('PlatformAgentVault').abi, functionName: 'ownerWithdraw', args: [1_000_000n] }));
    await deployed.test.increaseTime({ seconds: 86_401 }); await deployed.test.mine({ blocks: 1 });
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.registryAddress, abi: deployed.artifact('PlatformSelectionRegistry').abi, functionName: 'declareDormant', args: [deployed.agentId] })); await deployed.test.mine({ blocks: 2 });
    expect(viewSchema.parse(await (await get(base() + '/' + row.id)).json()).controlVerified).toBe(true);
    await deployed.test.increaseTime({ seconds: 30 * 86_400 + 1 }); await deployed.test.mine({ blocks: 1 });
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.registryAddress, abi: deployed.artifact('PlatformSelectionRegistry').abi, functionName: 'declareDeath', args: [deployed.agentId] })); await deployed.test.mine({ blocks: 2 });
    expect(viewSchema.parse(await (await get(base() + '/' + row.id)).json()).controlVerified).toBe(false);
    expect((await post(base() + '/' + row.id + '/challenge', { expectedRevision: '1' })).status).toBe(409);
    expect((await post(base() + '/' + row.id + '/revoke', { expectedRevision: '1' })).status).toBe(200);
  });
  it.each(['redirect', 'huge', 'invalid-utf8', 'duplicate-body', 'duplicate-header', 'stalled'] as const)('rejects actual HTTP %s without storing verified evidence or following redirects', async scenario => {
    const row = await declare(); await challenge(row); mode = scenario; const response = await verify(row);
    expect(response.status).toBe(scenario === 'stalled' ? 503 : 422);
    expect(await response.json()).toMatchObject({ code: scenario === 'stalled' ? 'income_endpoint_unavailable' : 'income_endpoint_response_invalid' }); expect(requests).toHaveLength(1);
    expect(viewSchema.parse(await (await get(base() + '/' + row.id)).json()).controlVerified).toBe(false);
  });
  it('rejects unreviewed/private/query/credential URLs before making an endpoint request', async () => {
    for (const url of [endpointOrigin + '/service?query=1', endpointOrigin + '/service?', endpointOrigin + '/service#fragment', endpointOrigin + '/service#', 'http://user:password@127.0.0.1/service',
      'http://169.254.169.254/latest', 'http://[::ffff:127.0.0.1]/service', 'https://unreviewed.invalid/service', 'file:///etc/passwd']) {
      expect((await post(base(), { url, expectedRevision: '0' })).status).toBe(422);
    }
    expect(requests).toHaveLength(0);
    await expect(probeIncomeEndpoint('http://127.0.0.1:1/', hash('nonce'), { allowedOrigins: ['http://127.0.0.1:1'], localFixture: false })).rejects.toMatchObject({ code: 'income_endpoint_blocked' });
    const localDns = 'https://localhost:' + new URL(endpointOrigin).port;
    await expect(probeIncomeEndpoint(localDns + '/service', hash('nonce'), { allowedOrigins: [localDns], localFixture: false })).rejects.toMatchObject({ code: 'income_endpoint_blocked' });
    expect(requests).toHaveLength(0);
  });
  it('enforces request JSON, query, idempotency and collection bounds without network side effects', async () => {
    expect((await get(base() + '?owner=' + deployed.accounts.outsider.address)).status).toBe(422);
    for (const payload of ['{"url":"' + endpointOrigin + '/service","expectedRevision":"0","expectedRevision":"1"}', ' '.repeat(8193), '{"url":"x"}']) {
      const response = await fetch(config.PUBLIC_ORIGIN + base(), { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN, Cookie: ownerCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'body' }, body: payload }); expect(response.status).toBe(422);
    }
    const invalid = await fetch(config.PUBLIC_ORIGIN + base(), { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN, Cookie: ownerCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'utf8' }, body: Uint8Array.from([0xc0, 0xaf]) }); expect(invalid.status).toBe(422);
    const missingKey = await fetch(config.PUBLIC_ORIGIN + base(), { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN, Cookie: ownerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: endpointOrigin + '/service', expectedRevision: '0' }) }); expect(missingKey.status).toBe(422);
    for (let index = 0; index < 16; index++) await declare('/bounded-' + index);
    expect((await post(base(), { url: endpointOrigin + '/overflow', expectedRevision: '0' })).status).toBe(503);
    expect(await store.db.select().from(incomeEndpoints)).toHaveLength(16); expect(requests).toHaveLength(0);
  }, 30_000);
  it('checks independent chain, code, token, implementation and current mapping evidence without requiring a CystRegistry', async () => {
    for (const patch of [{ chainId: 31338 }, { selectionRegistryCodeHash: hash('wrong registry') }, { vaultImplementationCodeHash: hash('wrong implementation') }]) {
      const reader = new RpcIncomeEndpointReader({ rpcUrl: deployed.local.rpcUrl, pins: { ...profile.pins, ...patch }, asset: profile.asset }); await expect(reader.check()).rejects.toThrow();
    }
    const wrongToken = new RpcIncomeEndpointReader({ rpcUrl: deployed.local.rpcUrl, pins: profile.pins, asset: deployed.accounts.outsider.address }); await expect(wrongToken.check()).rejects.toThrow();
    const wrongImplementation = new RpcIncomeEndpointReader({ rpcUrl: deployed.local.rpcUrl, pins: { ...profile.pins, vaultImplementationAddress: deployed.pins.escrowAddress }, asset: profile.asset }); await expect(wrongImplementation.check()).rejects.toThrow();
    const row = await verified(); await deployed.test.setCode({ address: deployed.vault.registryAddress, bytecode: '0x60006000f3' }); await deployed.test.mine({ blocks: 2 });
    expect((await get(base() + '/' + row.id)).status).toBe(503);
  });
  it('fails closed if a verified checkpoint loses confirmation depth, and rejects unknown registered agents', async () => {
    const row = await verified(), [stored] = await store.db.select().from(incomeEndpoints).where(eq(incomeEndpoints.id, row.id));
    if (!stored?.verification) throw new Error('Verification absent');
    await expect(service.reader.canonical({ ...stored.verification.block, number: String((await deployed.local.publicClient.getBlockNumber({ cacheTime: 0 })) + 1n) })).rejects.toThrow();
    expect((await get('/api/selection/income-endpoints/agents/' + hash('unknown') + '/endpoints')).status).toBe(404);
    const alteredProfile = incomeEndpointProfileSchema.parse({ ...profile, verificationTtlSeconds: 60 });
    const replacement = new IncomeEndpointService(store.db, service.reader, alteredProfile, { clock: () => now });
    expect((await replacement.get(deployed.accounts.owner.address, deployed.agentId, row.id)).controlVerified).toBe(false);
  });
});

describe('income endpoint boundary policy', () => {
  it.each(['0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.31.1.1', '192.168.1.1',
    '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1',
    'ff02::1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::1', '2001::1', '3fff::1'])('blocks special-use IP %s', address => {
    expect(isPublicIncomeEndpointAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111'])('recognizes public address %s without contacting it', address => {
    expect(isPublicIncomeEndpointAddress(address)).toBe(true);
  });
  it('rejects duplicate nested proof keys and excessive JSON depth', () => {
    expect(() => incomeStrictJson('{"proof":{"nonce":1,"nonce":2}}')).toThrow('Duplicate');
    expect(() => incomeStrictJson('['.repeat(34) + '0' + ']'.repeat(34))).toThrow('limit');
    expect(incomeStrictJson('{"proof":{"escaped\\u004bey":1},"array":[true,null,"quoted\\\"value"]}')).toEqual({ proof: { escapedKey: 1 }, array: [true, null, 'quoted"value'] });
  });
  it('rejects wildcard, duplicate, insecure and nonlocal fixture origin policies', () => {
    const pins = { chainId: 31337, selectionRegistryAddress: '0x' + '1'.repeat(40), selectionRegistryCodeHash: hash('selection'),
      vaultImplementationAddress: '0x' + '2'.repeat(40), vaultImplementationCodeHash: hash('vault'), confirmations: 1 };
    const base = { pins, network: 'eip155:31337', asset: '0x' + '3'.repeat(40), allowedOrigins: ['https://reviewed.example'] };
    expect(incomeEndpointProfileSchema.parse(base).localFixture).toBe(false);
    for (const change of [{ allowedOrigins: ['https://*.example'] }, { allowedOrigins: ['https://reviewed.example', 'https://reviewed.example'] },
      { allowedOrigins: ['http://reviewed.example'] }, { allowedOrigins: ['https://reviewed.example/path'] }, { network: 'eip155:84532' },
      { localFixture: true, pins: { ...pins, chainId: 84532 }, network: 'eip155:84532' }, { pins: { ...pins, confirmations: 0 } }]) {
      expect(incomeEndpointProfileSchema.safeParse({ ...base, ...change }).success).toBe(false);
    }
  });
});
