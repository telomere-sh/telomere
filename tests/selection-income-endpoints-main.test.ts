import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request, type Server as HttpServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { compileContracts } from '../scripts/compile-contracts.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { loadConfig, type Config } from '../src/config.js';
import { startPilot } from '../src/main.js';
import * as storeModule from '../src/store.js';
import { incomeChallengeSchema, incomeEndpointProfileSchema, incomeEndpointProofMessage,
  type IncomeEndpointProfile, type IncomeProof } from '../src/selection/income-endpoints/types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const hash = (value: string) => keccak256(toHex(value));
const realOpenStore = storeModule.openStore;
const endpointView = z.object({ id: z.string(), url: z.string(), revision: z.string(), declared: z.boolean(),
  controlVerified: z.boolean(), termsMatchReviewedProfile: z.boolean(), incomeCredit: z.literal('none'),
  paymentCapabilityVerified: z.literal(false) }).passthrough();

async function fixture() {
  const artifacts = compileContracts(['TelomereRunEscrow.sol', 'PlatformSelectionRegistry.sol', 'PlatformAgentVault.sol',
    'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(hash('income-endpoints-main-fixture'), artifacts);
  try {
    const vault = await deployPlatformVault(local), legacy = local.artifact('TelomereRunEscrow');
    const receipt = await local.confirmed(local.owner.deployContract({ abi: legacy.abi, bytecode: legacy.bytecode,
      args: [local.pins.tokenAddress, local.accounts.signer.address, local.accounts.signer.address, local.accounts.owner.address] }));
    if (!receipt.contractAddress) throw new Error('Disposable main escrow was not deployed');
    await local.test.mine({ blocks: 3 });
    // REASON: The dynamically compiled Selection identityAgent getter returns bytes32.
    return { ...local, vault, agentId: vault.agentId as Hex, legacyEscrow: receipt.contractAddress };
  } catch (error) { await local.close(); throw error; }
}

describe('actual startPilot income endpoint configuration and HTTP boundaries', () => {
  let deployed: Awaited<ReturnType<typeof fixture>>, chainSnapshot: Hex, directory: string, config: Config;
  let profile: IncomeEndpointProfile, profilePath: string, pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  let endpointServer: HttpServer | undefined, endpointOrigin: string, ownerCookie: string, agentCookie: string, outsiderCookie: string;
  const proofs = new Map<string, IncomeProof>();
  const probes: { method: string | undefined; path: string | undefined; headers: Record<string, string | string[] | undefined> }[] = [];
  const trackedClose: ReturnType<typeof vi.fn<() => Promise<void>>>[] = [];
  beforeAll(async () => { deployed = await fixture(); chainSnapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: chainSnapshot }); chainSnapshot = await deployed.test.snapshot();
    directory = await mkdtemp(join(tmpdir(), 'telomere-income-endpoints-main-')); proofs.clear(); probes.length = 0;
    endpointServer = createHttpServer((incoming, response) => {
      probes.push({ method: incoming.method, path: incoming.url, headers: incoming.headers });
      const nonce = incoming.headers['x-telomere-verification-nonce'];
      const offer = { x402Version: 2, resource: { url: endpointOrigin + (incoming.url ?? '/') }, accepts: [{ scheme: 'exact',
        network: profile.network, asset: profile.asset, payTo: deployed.vault.agent.vault, amount: '123', maxTimeoutSeconds: 60 }] };
      response.writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(offer)).toString('base64') });
      response.end(JSON.stringify({ proof: typeof nonce === 'string' ? proofs.get(nonce) : undefined }));
    });
    await new Promise<void>((done, reject) => endpointServer!.once('error', reject).listen(0, '127.0.0.1', done));
    const endpointAddress = endpointServer.address();
    if (!endpointAddress || typeof endpointAddress === 'string') throw new Error('Disposable endpoint has no port');
    endpointOrigin = 'http://127.0.0.1:' + endpointAddress.port;
    profile = incomeEndpointProfileSchema.parse({ pins: { chainId: 31337, selectionRegistryAddress: deployed.vault.registryAddress,
      selectionRegistryCodeHash: deployed.vault.pins.registryCodeHash, vaultImplementationAddress: deployed.vault.implementationAddress,
      vaultImplementationCodeHash: deployed.vault.pins.implementationCodeHash, confirmations: 1 }, network: 'eip155:31337',
      asset: deployed.pins.tokenAddress, allowedOrigins: [endpointOrigin], localFixture: true });
    profilePath = join(directory, 'income-endpoints.json'); await saveProfile();
    const port = await unusedLocalPort();
    config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: deployed.local.rpcUrl, DATA_DIR: join(directory, 'db'),
      ESCROW_ADDRESS: deployed.legacyEscrow, TOKEN_ADDRESS: deployed.pins.tokenAddress, SIGNER_PRIVATE_KEY: deployed.keys.signer,
      DEMO_PRIVATE_KEY: deployed.keys.owner, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'http://127.0.0.1:' + port,
      CPU_MODE: 'demo', CYSTS_ENABLED: 'false', SELECTION_ENABLED: 'true', SELECTION_REGISTRY_ADDRESS: deployed.vault.registryAddress,
      SELECTION_CODE_HASH: deployed.vault.pins.registryCodeHash, SELECTION_START_BLOCK: '0', SELECTION_CONFIRMATIONS: '1',
      INCOME_ENDPOINTS_CONFIG: profilePath, LOG_LEVEL: 'error' });
    trackedClose.length = 0;
    // Track actual PGlite close calls while retaining real migrations, SQL and persistence.
    vi.spyOn(storeModule, 'openStore').mockImplementation(async input => {
      const actual = await realOpenStore(input), close = vi.fn(async () => { await actual.close(); });
      trackedClose.push(close); return { db: actual.db, close };
    });
    pilot = await startPilot(config);
    ownerCookie = await signedSession(deployed.accounts.owner);
    agentCookie = await signedSession(deployed.vault.account);
    outsiderCookie = await signedSession(deployed.accounts.outsider);
  }, 30_000);
  afterEach(async () => {
    await pilot?.close(); pilot = undefined;
    for (const close of trackedClose) if (close.mock.calls.length === 0) await close();
    vi.restoreAllMocks();
    endpointServer?.closeAllConnections();
    if (endpointServer) { const server = endpointServer; endpointServer = undefined;
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
    if (directory) {
      const owned = resolve(directory);
      if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('telomere-income-endpoints-main-')) throw new Error('Unexpected owned main fixture directory');
      await rm(owned, { recursive: true, force: true });
    }
  });
  afterAll(async () => { await deployed?.close(); });

  async function saveProfile(value: unknown = profile) { await writeFile(profilePath, JSON.stringify(value), { mode: 0o600 }); }
  const base = () => '/api/selection/income-endpoints/agents/' + deployed.agentId + '/endpoints';
  function post(path: string, value: unknown, cookie = ownerCookie, key = 'main-operation', origin = config.PUBLIC_ORIGIN) {
    return fetch(config.PUBLIC_ORIGIN + path, { method: 'POST', headers: { Origin: origin, Cookie: cookie,
      'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) });
  }
  function get(path: string, cookie = ownerCookie) { return fetch(config.PUBLIC_ORIGIN + path, { headers: { Cookie: cookie } }); }
  async function signedSession(account: typeof deployed.accounts.owner) {
    const requested = await post('/api/auth/challenge', { address: account.address }, ''); expect(requested.status).toBe(200);
    const challenge = z.object({ nonce: z.string(), message: z.string() }).parse(await requested.json());
    const response = await post('/api/auth/verify', { address: account.address, nonce: challenge.nonce,
      signature: await account.signMessage({ message: challenge.message }) }, ''); expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Actual main authentication cookie missing'); return cookie;
  }
  async function declare(path: string, key = path) {
    const response = await post(base(), { url: endpointOrigin + path, expectedRevision: '0' }, ownerCookie, key);
    expect(response.status).toBe(200); return endpointView.parse(await response.json());
  }
  async function assertPortReleased() {
    const probe = createPortProbe();
    await new Promise<void>((done, reject) => probe.once('error', reject).listen(config.PORT, '127.0.0.1', done));
    await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  }
  /** A real chunked HTTP request. An unfinished body keeps trickling below any idle timeout. */
  async function streamedRequest(value: string, unfinished = false) {
    const started = Date.now();
    return new Promise<{ status: number; body: unknown; elapsed: number }>((done, reject) => {
      let settled = false, trickle: ReturnType<typeof setInterval> | undefined;
      const timeout = setTimeout(() => finish(new Error('Actual main body deadline was not enforced')), 8500);
      const outgoing = request(config.PUBLIC_ORIGIN + base(), { method: 'POST', agent: false,
        headers: { Origin: config.PUBLIC_ORIGIN, Cookie: ownerCookie, 'Content-Type': 'application/json',
          'Idempotency-Key': unfinished ? 'unfinished-body' : 'bounded-body', 'Transfer-Encoding': 'chunked' } }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.byteLength;
          if (bytes > 8192) finish(new Error('Unexpected main response size')); else chunks.push(chunk); });
        response.on('error', finish);
        response.on('end', () => {
          try { finish(undefined, { status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, elapsed: Date.now() - started }); }
          catch { finish(new Error('Actual main response was not JSON')); }
        });
      });
      function finish(error?: Error, result?: { status: number; body: unknown; elapsed: number }) {
        if (settled) return; settled = true; clearTimeout(timeout); clearInterval(trickle); outgoing.destroy();
        if (error) reject(error); else if (result) done(result); else reject(new Error('Actual main request did not finish'));
      }
      outgoing.on('error', finish); outgoing.flushHeaders(); outgoing.write(value.slice(0, 1));
      if (unfinished) trickle = setInterval(() => { outgoing.write(' '); }, 100);
      else { outgoing.write(value.slice(1)); outgoing.end(); }
    });
  }

  it('mounts optional reviewed income endpoints with real owner sessions, agent-only proof and no financial mutation', async () => {
    expect((await get('/health/ready', '')).status).toBe(200);
    expect((await get('/api/selection/income-endpoints/config', '')).status).toBe(401);
    const configResponse = await get('/api/selection/income-endpoints/config'); expect(configResponse.status).toBe(200);
    expect(await configResponse.json()).toMatchObject({ protocol: 'telomere-income-endpoint-v1', incomeCredit: 'none', paymentCapabilityVerified: false });
    expect((await get(base(), outsiderCookie)).status).toBe(403);
    expect((await post(base(), { url: endpointOrigin + '/agent-write', expectedRevision: '0' }, agentCookie)).status).toBe(403);
    expect((await post(base(), { url: endpointOrigin + '/origin', expectedRevision: '0' }, ownerCookie, 'origin', 'https://foreign.invalid')).status).toBe(403);
    expect(probes).toHaveLength(0);
    const nonce = await deployed.local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address });
    const row = await declare('/service', 'declare-service');
    const response = await post(base() + '/' + row.id + '/challenge', { expectedRevision: row.revision }, ownerCookie, 'challenge-service');
    expect(response.status).toBe(200);
    const issued = z.object({ challenge: incomeChallengeSchema, message: z.string() }).parse(await response.json());
    expect(issued.message).toBe(incomeEndpointProofMessage(issued.challenge));
    proofs.set(issued.challenge.nonce, { challenge: issued.challenge, signature: await deployed.vault.account.signMessage({ message: issued.message }) });
    expect(probes).toHaveLength(0);
    const verified = await post(base() + '/' + row.id + '/verify', { expectedRevision: row.revision }, ownerCookie, 'verify-service');
    expect(verified.status).toBe(200); expect(endpointView.parse(await verified.json())).toMatchObject({
      declared: true, controlVerified: true, termsMatchReviewedProfile: true, incomeCredit: 'none', paymentCapabilityVerified: false });
    expect(probes).toHaveLength(1); expect(probes[0]).toMatchObject({ method: 'GET', path: '/service' });
    for (const header of ['cookie', 'authorization', 'payment-signature']) expect(probes[0]!.headers).not.toHaveProperty(header);
    expect((await get(base() + '/' + row.id, agentCookie)).status).toBe(200);
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address })).toBe(nonce);
    if (!pilot?.platform.selection) throw new Error('Actual Selection indexer missing');
    expect(await pilot.service.db.select().from(storeModule.transactions)).toHaveLength(0);
    let indexed = false;
    for (let attempt = 0; attempt < 4; attempt++) if ((await pilot.platform.selection.sync()).processedBlocks === 0) { indexed = true; break; }
    expect(indexed).toBe(true);
    const chainDate = new Date(Number((await deployed.local.publicClient.getBlock()).timestamp) * 1000);
    const weekday = (chainDate.getUTCDay() + 6) % 7;
    const week = new Date(Date.UTC(chainDate.getUTCFullYear(), chainDate.getUTCMonth(), chainDate.getUTCDate() - weekday)).toISOString().slice(0, 10);
    const publicResponse = await get('/api/selection/dataset?week=' + week, ''); expect(publicResponse.status).toBe(200);
    const publicData = z.object({ currency: z.literal('registry-token-base-units'), rows: z.array(z.object({ agentId: z.string(),
      weeklyIncomeUnits: z.string(), lifetimeIncomeUnits: z.string(), lifetimeSubsidyUnits: z.string() }).passthrough()) }).passthrough()
      .parse(await publicResponse.json());
    expect(publicData.rows).toHaveLength(1); expect(publicData.rows[0]).toMatchObject({ agentId: deployed.agentId,
      weeklyIncomeUnits: '0', lifetimeIncomeUnits: '0', lifetimeSubsidyUnits: '1000000' });
    for (const privateAddress of [deployed.accounts.owner.address, deployed.vault.agent.vault]) {
      expect(JSON.stringify(publicData).toLowerCase()).not.toContain(privateAddress.toLowerCase());
    }
  });

  it('enforces exactly 8 KiB and a five-second total deadline on actual chunked unfinished HTTP bodies', async () => {
    const input = JSON.stringify({ url: endpointOrigin + '/exact-boundary', expectedRevision: '0' });
    const exact = input + ' '.repeat(8192 - Buffer.byteLength(input));
    const accepted = await streamedRequest(exact); expect(accepted.status).toBe(200);
    expect(endpointView.parse(accepted.body)).toMatchObject({ declared: true, controlVerified: false });
    const exceeded = await streamedRequest(exact + ' '); expect(exceeded.status).toBe(422);
    expect(exceeded.body).toMatchObject({ title: 'income_endpoint_body_limit' });
    const unfinished = await streamedRequest('{', true); expect(unfinished.status).toBe(422);
    expect(unfinished.body).toMatchObject({ title: 'income_endpoint_body_timeout' });
    expect(unfinished.elapsed).toBeGreaterThanOrEqual(4500); expect(unfinished.elapsed).toBeLessThan(8500);
    expect(probes).toHaveLength(0); expect((await get('/health/ready', '')).status).toBe(200);
  }, 20_000);

  it('closes the actual store and leaves no listener after bad reviewed startup configuration, then recovers durable declarations', async () => {
    const row = await declare('/durable', 'durable-declare'); await pilot?.close(); pilot = undefined;
    for (const invalid of ['{invalid-json', JSON.stringify({ ...profile, pins: { ...profile.pins, selectionRegistryCodeHash: hash('wrong code') } }),
      JSON.stringify({ ...profile, asset: deployed.accounts.outsider.address })]) {
      await writeFile(profilePath, invalid, { mode: 0o600 }); const before = trackedClose.length;
      await expect(startPilot(config)).rejects.toThrow('Income endpoint configuration or reviewed deployment is unavailable');
      expect(trackedClose).toHaveLength(before + 1); expect(trackedClose.at(-1)).toHaveBeenCalledTimes(1);
      await assertPortReleased(); const reopened = await realOpenStore(config); await reopened.close();
    }
    await saveProfile(); pilot = await startPilot(config);
    const current = await get(base() + '/' + row.id); expect(current.status).toBe(200);
    expect(endpointView.parse(await current.json())).toMatchObject({ id: row.id, revision: '1', declared: true, controlVerified: false });
    expect(probes).toHaveLength(0);
  }, 30_000);

  it('keeps the endpoint subsystem optional and releases its actual HTTP listener on close', async () => {
    await pilot?.close(); pilot = undefined;
    pilot = await startPilot({ ...config, INCOME_ENDPOINTS_CONFIG: undefined });
    expect((await get('/api/selection/income-endpoints/config')).status).toBe(404);
    expect((await get('/health/ready', '')).status).toBe(200); expect(probes).toHaveLength(0);
    await pilot.close(); pilot = undefined; await assertPortReleased();
    const reopened = await realOpenStore(config); await reopened.close();
  });
});
