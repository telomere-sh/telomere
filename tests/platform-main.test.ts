import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, toHex, verifyTypedData } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { startPilot } from '../src/main.js';
import { loadConfig, type Config } from '../src/config.js';
import * as storeModule from '../src/store.js';
import { randomId } from '../src/common.js';
import { Ed25519Identity, capacityChallengeSchema, hostMessageHash, verifyHostMessage } from '../src/host-kit/protocol.js';
import { platformHostLeases, platformRuns } from '../src/platform-runtime/schema.js';
import { platformHostSchema, platformPinsSchema, platformPreparedSchema, platformQuoteTypes, typedPlatformQuote, type PlatformQuote } from '../src/platform-runtime/types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';
import { platformVaultConfigSchema } from '../src/platform-runtime/vault.js';
import { HttpAgentLifecycleControl } from '../src/agents/http-client.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { Worker } from '../src/worker.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';

const realOpenStore = storeModule.openStore;

describe('actual startPilot platform startup failure boundaries', () => {
  let artifacts: Record<string, ContractArtifact>, local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let root: string, config: Config, control: Ed25519Identity;
  let pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  let capacityServer: HttpServer | undefined;
  const trackedClose: ReturnType<typeof vi.fn<() => Promise<void>>>[] = [];
  beforeAll(() => { artifacts = compileContracts(['MockToken.sol', 'TelomereRunEscrow.sol', 'PlatformRunEscrow.sol',
    'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact(); }, 90_000);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-platform-main-')); control = new Ed25519Identity();
    local = await deployPlatformRuntime(control.publicKey as `0x${string}`, artifacts);
    const legacyKey = generatePrivateKey(), legacy = privateKeyToAccount(legacyKey), artifact = local.artifact('TelomereRunEscrow');
    const receipt = await local.confirmed(local.owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode,
      args: [local.pins.tokenAddress, legacy.address, legacy.address, local.accounts.owner.address] }));
    if (!receipt.contractAddress) throw new Error('Local legacy escrow deployment missing');
    const port = await unusedLocalPort();
    config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: local.local.rpcUrl, DATA_DIR: join(root, 'db'),
      ESCROW_ADDRESS: receipt.contractAddress, TOKEN_ADDRESS: local.pins.tokenAddress, SIGNER_PRIVATE_KEY: legacyKey,
      DEMO_PRIVATE_KEY: local.keys.owner, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'http://127.0.0.1:' + port,
      CPU_MODE: 'demo', CYSTS_ENABLED: 'false', SELECTION_ENABLED: 'false', LOG_LEVEL: 'error' });
    trackedClose.length = 0;
    // Track the actual database close, retaining real PGlite migrations, persistence and SQL throughout.
    vi.spyOn(storeModule, 'openStore').mockImplementation(async input => {
      const actual = await realOpenStore(input), close = vi.fn(async () => { await actual.close(); });
      trackedClose.push(close); return { db: actual.db, close };
    });
  });
  afterEach(async () => {
    await pilot?.close(); pilot = undefined;
    if (capacityServer) { await new Promise<void>(resolve => capacityServer!.close(() => resolve())); capacityServer = undefined; }
    for (const close of trackedClose) if (close.mock.calls.length === 0) await close();
    vi.restoreAllMocks(); await local?.close();
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-platform-main-')) throw new Error('Unexpected owned test directory');
      await rm(target, { recursive: true, force: true });
    }
  });
  async function assertNoListeningServer() {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(config.PORT, '127.0.0.1', resolve));
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  }
  async function configuredHost(imageDigest = 'sha256:' + '1'.repeat(64), withCapacity = false) {
    const signerKeyFile = join(root, 'platform.key'), controlPemFile = join(root, 'control.pem'), path = join(root, 'platform.json');
    await writeFile(signerKeyFile, local.keys.signer, { mode: 0o600 });
    await writeFile(controlPemFile, control.exportPrivatePem(), { mode: 0o600 });
    const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: control.publicKey, hardwareClass: 'cpu', region: 'local-test',
      image: 'fixture/node@sha256:' + '1'.repeat(64), imageDigest, sealed: false, lane: 'standard', pricePerSecond: '100',
      reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    let url = 'http://127.0.0.1:1';
    if (withCapacity) {
      // Only quote placement is exercised here. This disposable fixture signs
      // a fresh, challenge-bound hint; it never starts or meters a Cell.
      capacityServer = createHttpServer(async (request, response) => {
        try {
          if (request.method !== 'POST' || request.url !== '/v1/capacity') throw new Error('Unexpected host fixture route');
          const parts: Buffer[] = []; let size = 0;
          for await (const part of request) {
            const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
            size += bytes.length; if (size > 4096) throw new Error('Host fixture request too large'); parts.push(bytes);
          }
          const challenge = capacityChallengeSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
          const now = Date.now();
          if (!verifyHostMessage(control.publicKey, 'capacity-challenge', challenge)
            || challenge.body.hostKey !== control.publicKey || challenge.body.image !== host.image
            || Math.abs(challenge.body.issuedAt - now) > 5000 || challenge.body.expiresAt <= now) {
            throw new Error('Host fixture challenge invalid');
          }
          const signed = control.sign('capacity', { version: 1 as const, hostKey: control.publicKey,
            image: challenge.body.image, kind: challenge.body.kind, nonce: challenge.body.nonce,
            challengeHash: hostMessageHash(challenge), isolation: 'gvisor' as const, available: true,
            issuedAt: now, expiresAt: Math.min(challenge.body.expiresAt, now + 2000) });
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(signed));
        } catch { response.writeHead(400).end(); }
      });
      await new Promise<void>((resolveListening, reject) => capacityServer!.once('error', reject)
        .listen(0, '127.0.0.1', resolveListening));
      const address = capacityServer.address(); if (!address || typeof address === 'string') throw new Error('Host fixture port missing');
      url = `http://127.0.0.1:${address.port}`;
    }
    await writeFile(path, JSON.stringify({ pins: local.pins, signerKeyFile, hosts: [{ ...host, url, controlPemFile }] }), { mode: 0o600 });
    return { ...config, PLATFORM_RUNTIME_CONFIG: path };
  }
  const mcpProtocol = '2025-11-25';
  function mcpPost(endpoint: '/mcp' | '/mcp/platform', value: unknown, cookie: string, session?: string, origin = config.PUBLIC_ORIGIN) {
    return fetch(config.PUBLIC_ORIGIN + endpoint, { method: 'POST', headers: { Origin: origin, Cookie: cookie,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': mcpProtocol } : {}) }, body: JSON.stringify(value) });
  }
  async function mcpSession(endpoint: '/mcp' | '/mcp/platform', cookie: string) {
    const initialized = await mcpPost(endpoint, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: mcpProtocol, capabilities: {}, clientInfo: { name: 'actual-platform-main', version: '1.0.0' } } }, cookie);
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: mcpProtocol } });
    const session = initialized.headers.get('mcp-session-id'); if (!session) throw new Error('Actual main MCP session missing');
    const ready = await mcpPost(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, cookie, session);
    expect(ready.status).toBe(202); expect(await ready.text()).toBe(''); return session;
  }
  function mcpTool(id: number, name: string, args: unknown) {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
  }
  async function signedSession(account: Awaited<ReturnType<typeof deployPlatformVault>>['account']) {
    const post = (path: string, body: unknown) => fetch(config.PUBLIC_ORIGIN + path, { method: 'POST',
      headers: { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const requested = await post('/api/auth/challenge', { address: account.address }); expect(requested.status).toBe(200);
    // REASON: The actual authentication endpoint supplies its own signable nonce/message pair.
    const challenge = await requested.json() as { nonce: string; message: string };
    const signature = await account.signMessage({ message: challenge.message });
    const verified = await post('/api/auth/verify', { address: account.address, nonce: challenge.nonce, signature });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Actual signed main session cookie missing'); return cookie;
  }
  async function staleLease() {
    const db = await realOpenStore(config), now = Number((await local.local.publicClient.getBlock()).timestamp);
    const runId = randomId(), leashId = randomId(), task = { kind: 'sha256' as const, text: 'unfinished-original-cell' };
    const quote: PlatformQuote = { runId, leashId, hostId: local.hostId, payer: local.accounts.owner.address, hwClass: 0,
      regionHash: keccak256(toHex('local-test')), imageHash: keccak256(toHex('sha256:' + '1'.repeat(64))),
      workloadHash: keccak256(toHex(JSON.stringify({ task }))), maxSeconds: 25, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: now + 60 };
    const signature = await local.accounts.signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
      chainId: 31337, verifyingContract: local.pins.escrowAddress }, primaryType: 'PlatformQuote', types: platformQuoteTypes,
      message: typedPlatformQuote(quote) });
    const lease = control.sign('lease', { version: 1 as const, hostKey: control.publicKey, runId,
      owner: local.accounts.owner.address.toLowerCase(), image: 'fixture/node@sha256:' + '1'.repeat(64),
      argv: ['/usr/local/bin/node', '/opt/telomere/task-runner.mjs'], stdin: JSON.stringify(task),
      issuedAt: Date.now(), expiresAt: Date.now() + 25_000, maxSeconds: 25, nonce: randomId() });
    try {
      await db.db.insert(platformRuns).values({ id: runId, owner: local.accounts.owner.address.toLowerCase(), agent: local.accounts.owner.address.toLowerCase(),
        idemKey: 'original-running-intent', inputHash: keccak256(toHex('original-running-intent')), input: { leashId, task, maxSeconds: 25,
          deadline: now + 300, maxSpend: '2725', regions: [] }, quote, signature, ceiling: '2725', imageProof: [], regionProof: [], status: 'running' });
      await db.db.insert(platformHostLeases).values({ runId, owner: local.accounts.owner.address.toLowerCase(), hostId: local.hostId,
        leaseHash: hostMessageHash(lease), lease, cleanupConfirmed: 0 });
    } finally { await db.close(); }
    return { runId, lease };
  }
  it('fails closed when runtime configuration is removed with an unfinished original lease, and releases its actual store', async () => {
    const original = await staleLease();
    await expect(startPilot(config)).rejects.toThrow('Unconfirmed platform leases require their original reviewed platform configuration');
    expect(trackedClose).toHaveLength(1); expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
    const reopened = await realOpenStore(config);
    try {
      const [lease] = await reopened.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, original.runId));
      expect(lease?.cleanupConfirmed).toBe(0); expect(lease?.leaseHash).toBe(hostMessageHash(original.lease));
      expect((await reopened.db.select().from(platformRuns))[0]?.status).toBe('running');
    } finally { await reopened.close(); }
  });
  it('closes the real store after the platform constructor rejects mismatched image pins, then starts with corrected configuration', async () => {
    const invalid = await configuredHost('sha256:' + '2'.repeat(64));
    await expect(startPilot(invalid)).rejects.toThrow('Platform host image digest differs from its reviewed image');
    expect(trackedClose).toHaveLength(1); expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
    const valid = await configuredHost(); pilot = await startPilot(valid);
    expect(pilot.platformRuntime).toBeDefined();
    const auth = await fetch(config.PUBLIC_ORIGIN + '/api/auth/demo', { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN,
      'Content-Type': 'application/json' }, body: '{}' });
    expect(auth.status).toBe(200); const cookie = auth.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    expect(cookie).toBeDefined();
    const response = await fetch(config.PUBLIC_ORIGIN + '/api/platform/config', { headers: { Cookie: cookie! } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ protocol: 'telomere-platform-v1', pins: platformPinsSchema.parse(local.pins) });
    await pilot.close(); pilot = undefined; expect(trackedClose[1]).toHaveBeenCalledTimes(1);
  });
  it('releases the real store after private runtime configuration parsing fails before construction', async () => {
    const path = join(root, 'invalid-platform.json'); await writeFile(path, '{invalid-json', { mode: 0o600 });
    await expect(startPilot({ ...config, PLATFORM_RUNTIME_CONFIG: path })).rejects.toThrow();
    expect(trackedClose).toHaveLength(1); expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
    pilot = await startPilot(config); expect(pilot.platformRuntime).toBeUndefined();
    expect((await fetch(config.PUBLIC_ORIGIN + '/api/config')).status).toBe(200);
    await pilot.close(); pilot = undefined; expect(trackedClose[1]).toHaveBeenCalledTimes(1);
  });
  it('releases the real store if the private reputation publisher configuration fails before recovery or listening', async () => {
    const path = join(root, 'invalid-reputation-publisher.json');
    await writeFile(path, '{invalid-json', { mode: 0o600 });
    const selected: Config = { ...config, SELECTION_ENABLED: true,
      SELECTION_REGISTRY_ADDRESS: local.pins.escrowAddress,
      SELECTION_CODE_HASH: keccak256(toHex('selection-startup-fixture')),
      SELECTION_START_BLOCK: '0', REPUTATION_PUBLISHER_CONFIG: path };
    await expect(startPilot(selected)).rejects.toThrow('Reputation publisher configuration');
    expect(trackedClose).toHaveLength(1); expect(trackedClose[0]).toHaveBeenCalledTimes(1);
    await assertNoListeningServer();
  });
  it('returns a listening platform controller that can close immediately and release its real store and port', async () => {
    pilot = await startPilot(await configuredHost()); expect(pilot.platformRuntime).toBeDefined();
    // No request, timer, or yield between successful startup and shutdown.
    await pilot.close(); pilot = undefined;
    expect(trackedClose).toHaveLength(1); expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
    const reopened = await realOpenStore(config);
    try { expect(await reopened.db.select().from(platformHostLeases)).toHaveLength(0); }
    finally { await reopened.close(); }
  });
  it('mounts public financial reads on the actual server without a wallet session', async () => {
    pilot = await startPilot(await configuredHost());
    await local.test.mine({ blocks: 12 });
    const rate = await fetch(config.PUBLIC_ORIGIN + '/api/platform/public/refund-rate');
    expect(rate.status).toBe(200);
    expect(rate.headers.get('Cache-Control')).toBe('no-store');
    expect(await rate.json()).toMatchObject({ finalizedRuns: 0, timeoutRefundRateBps: null });
    const missingTransaction = await fetch(config.PUBLIC_ORIGIN + '/api/platform/public/receipts/' + randomId());
    expect(missingTransaction.status).toBe(422);
    const invalidV2 = await fetch(config.PUBLIC_ORIGIN + '/api/platform/public/v2/verify', { method: 'POST',
      headers: { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
    expect(invalidV2.status).toBe(422);
    expect(invalidV2.headers.get('Cache-Control')).toBe('no-store');
    const foreignOriginV2 = await fetch(config.PUBLIC_ORIGIN + '/api/platform/public/v2/verify', { method: 'POST',
      headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{}' });
    expect(foreignOriginV2.status).toBe(403);
  });
  it('mounts paid lifecycle in the actual server and refuses switching its persisted financial scope after restart', async () => {
    const configured = { ...await configuredHost(), CYSTS_ENABLED: true, CYSTS_DIR: join(root, 'cysts'),
      AGENT_RUNTIME: 'platform' as const };
    pilot = await startPilot(configured);
    const signIn = await fetch(config.PUBLIC_ORIGIN + '/api/auth/demo', { method: 'POST',
      headers: { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
    const sessionToken = signIn.headers.get('set-cookie')?.match(/telomere_session=([a-f0-9]{64})/)?.[1];
    if (!sessionToken) throw new Error('Actual lifecycle session cookie missing');
    const owner = local.accounts.owner.address;
    const control = new HttpAgentLifecycleControl(new ApiTransport(config.PUBLIC_ORIGIN, { sessionToken }));
    expect((await fetch(config.PUBLIC_ORIGIN + '/api/agents')).status).toBe(401);
    await control.register(owner, owner);
    expect((await control.get(owner, owner)).policy).toMatchObject({ maximumLeaseSeconds: 120, rollBeforeSeconds: 30 });
    expect((await control.evaluate(owner, owner)).balance).toBe('1000000');
    const publicConfig = await fetch(config.PUBLIC_ORIGIN + '/api/config');
    expect(await publicConfig.json()).toMatchObject({ platform: { agentLifecycle: true,
      agentRuntimeScope: { protocol: 'platform', escrow: local.pins.escrowAddress.toLowerCase(), ownerPayersOnly: true } } });
    await pilot.close(); pilot = undefined;
    const recover = vi.spyOn(Worker.prototype, 'recover'), initialize = vi.spyOn(PlatformRuntimeService.prototype, 'initialize');
    await expect(startPilot({ ...configured, AGENT_RUNTIME: 'legacy' })).rejects.toThrow('different reviewed runtime');
    await expect(startPilot({ ...configured, AGENT_RUNTIME: 'legacy', CYSTS_ENABLED: false, CYSTS_DIR: undefined }))
      .rejects.toThrow('different reviewed runtime');
    expect(recover).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
    recover.mockRestore(); initialize.mockRestore();
    await assertNoListeningServer();
    pilot = await startPilot(configured);
    expect((await control.list(owner)).agents).toHaveLength(1);
  });
  it('rejects an occupied actual HTTP port, closes its store, and can restart after that port is released', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => occupied.once('error', reject).listen(config.PORT, '127.0.0.1', resolve));
    const fullConfig = await configuredHost();
    try {
      await expect(startPilot(fullConfig)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(trackedClose).toHaveLength(1); expect(trackedClose[0]).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
    }
    await assertNoListeningServer();
    pilot = await startPilot(fullConfig); expect(pilot.platformRuntime).toBeDefined();
    await pilot.close(); pilot = undefined; expect(trackedClose[1]).toHaveBeenCalledTimes(1);
  });
  it('mounts reviewed Vault routes in the actual app with signed agent sessions and enforced origin checks', async () => {
    const vault = await deployPlatformVault(local), configured = await configuredHost(undefined, true);
    const path = configured.PLATFORM_RUNTIME_CONFIG;
    if (!path) throw new Error('Reviewed platform configuration missing');
    const reviewed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!reviewed || typeof reviewed !== 'object') throw new Error('Invalid reviewed test configuration');
    await writeFile(path, JSON.stringify({ ...reviewed, vaults: vault.pins }), { mode: 0o600 });
    pilot = await startPilot(configured); expect(pilot.platformVaultRuntime).toBeDefined();
    const post = (route: string, body: unknown, cookie?: string, origin = config.PUBLIC_ORIGIN) => fetch(config.PUBLIC_ORIGIN + route, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const challengeResponse = await post('/api/auth/challenge', { address: vault.account.address });
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { nonce: string; message: string };
    const signature = await vault.account.signMessage({ message: challenge.message });
    const verified = await post('/api/auth/verify', { address: vault.account.address, nonce: challenge.nonce, signature });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0]; expect(cookie).toBeDefined();
    const base = '/api/platform/vaults/' + vault.agent.vault;
    const response = await fetch(config.PUBLIC_ORIGIN + base + '/config', { headers: { Cookie: cookie! } });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ binding: { vault: vault.agent.vault, agentWallet: vault.account.address }, vaultPins: platformVaultConfigSchema.parse(vault.pins) });
    const input = { leashId: vault.agent.leashId, task: { kind: 'sha256', text: 'actual-main-vault' }, maxSeconds: 10,
      deadline: Number((await local.local.publicClient.getBlock()).timestamp) + 180, maxSpend: '1090' };
    const quote = await fetch(config.PUBLIC_ORIGIN + base + '/quotes', { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN,
      'Content-Type': 'application/json', Cookie: cookie!, 'Idempotency-Key': 'actual-main-vault' }, body: JSON.stringify(input) });
    expect(quote.status).toBe(201); expect(await quote.json()).toMatchObject({ quote: { payer: vault.agent.vault }, transaction: { to: vault.agent.vault } });
    expect((await post(base + '/quotes', input, cookie, 'https://untrusted.invalid')).status).toBe(403);
    expect((await fetch(config.PUBLIC_ORIGIN + base + '/config')).status).toBe(401);
    let cancelled = false;
    const pendingBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
    const init = { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json',
      Cookie: cookie!, 'Idempotency-Key': 'incomplete-vault-body' }, body: pendingBody, duplex: 'half' as const };
    const stalled = await pilot.app.request(new Request(config.PUBLIC_ORIGIN + base + '/quotes', init));
    expect(stalled.status).toBe(422); expect(await stalled.json()).toMatchObject({ title: 'platform_body_timeout' }); expect(cancelled).toBe(true);
    await pilot.close(); pilot = undefined;
    expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
  }, 30_000);
  it('rejects invalid reviewed Vault code before listening and releases the database for a corrected startup', async () => {
    const vault = await deployPlatformVault(local), configured = await configuredHost(), path = configured.PLATFORM_RUNTIME_CONFIG;
    if (!path) throw new Error('Reviewed platform configuration missing');
    const reviewed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!reviewed || typeof reviewed !== 'object') throw new Error('Invalid reviewed test configuration');
    await writeFile(path, JSON.stringify({ ...reviewed, vaults: { ...vault.pins, registryCodeHash: randomId() } }), { mode: 0o600 });
    await expect(startPilot(configured)).rejects.toThrow('Platform Vault contract code pin changed');
    expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
    await writeFile(path, JSON.stringify({ ...reviewed, vaults: vault.pins }), { mode: 0o600 });
    pilot = await startPilot(configured); expect(pilot.platformVaultRuntime).toBeDefined();
    await pilot.close(); pilot = undefined; expect(trackedClose[1]).toHaveBeenCalledTimes(1);
  });

  it('keeps owner paid CPU MCP available and leaves full platform MCP unavailable when its configuration is disabled', async () => {
    pilot = await startPilot(config);
    const authenticated = await fetch(config.PUBLIC_ORIGIN + '/api/auth/demo', { method: 'POST',
      headers: { Origin: config.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
    expect(authenticated.status).toBe(200);
    const cookie = authenticated.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Disposable main owner session missing');
    const legacy = await mcpSession('/mcp', cookie);
    const listed = await mcpPost('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, cookie, legacy);
    expect(listed.status).toBe(200);
    // REASON: This is the real JSON-RPC tools/list envelope, asserted below against the public contract.
    const value = await listed.json() as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    expect(value.result.tools).toHaveLength(16);
    expect(value.result.tools.filter(tool => tool.annotations?.readOnlyHint === false).map(tool => tool.name).sort())
      .toEqual(['telomere_quote', 'telomere_admit_confirmed_run'].sort());
    expect(value.result.tools.some(tool => tool.name === 'telomere_run_status')).toBe(true);
    expect(value.result.tools.some(tool => tool.name === 'telomere_stop_plan')).toBe(true);
    expect(value.result.tools.some(tool => tool.name.startsWith('telomere_platform_'))).toBe(false);
    expect((await mcpPost('/mcp/platform', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: mcpProtocol, capabilities: {}, clientInfo: { name: 'disabled-full-platform', version: '1.0.0' } } }, cookie)).status).toBe(404);
    await pilot.close(); pilot = undefined; expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
  });

  it('mounts seventeen full platform MCP tools with real signed Vault sessions, checked unsigned quotes and isolated session cookies', async () => {
    const vault = await deployPlatformVault(local), configured = await configuredHost(undefined, true), path = configured.PLATFORM_RUNTIME_CONFIG;
    if (!path) throw new Error('Reviewed platform configuration missing');
    const reviewed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!reviewed || typeof reviewed !== 'object') throw new Error('Invalid reviewed test configuration');
    await writeFile(path, JSON.stringify({ ...reviewed, vaults: vault.pins }), { mode: 0o600 });
    pilot = await startPilot(configured);
    const agentCookie = await signedSession(vault.account), sameAgentCookie = await signedSession(vault.account);
    const ownerCookie = await signedSession(local.accounts.owner);
    const agentSession = await mcpSession('/mcp/platform', agentCookie), ownerSession = await mcpSession('/mcp/platform', ownerCookie);
    const legacySession = await mcpSession('/mcp', agentCookie);
    const listed = await mcpPost('/mcp/platform', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, agentCookie, agentSession);
    expect(listed.status).toBe(200);
    // REASON: The MCP transport provides this tools/list JSON-RPC envelope; only public names are compared.
    const toolList = await listed.json() as { result: { tools: { name: string }[] } };
    expect(toolList.result.tools.map(tool => tool.name).sort()).toEqual(['telomere_platform_config', 'telomere_platform_balance',
      'telomere_platform_runs', 'telomere_platform_run_status', 'telomere_platform_quote', 'telomere_platform_admit_confirmed_run',
      'telomere_platform_session_command', 'telomere_platform_session_events',
      'telomere_platform_stop_plan', 'telomere_platform_refund_plan',
      'telomere_paid_cpu_job_create', 'telomere_paid_cpu_job_status', 'telomere_paid_cpu_job_replan',
      'telomere_paid_cpu_job_approve', 'telomere_paid_cpu_job_cancel', 'telomere_paid_cpu_job_finish',
      'telomere_paid_cpu_reliability'].sort());
    const args = { vault: vault.agent.vault };
    const configuration = await mcpPost('/mcp/platform', mcpTool(3, 'telomere_platform_config', args), agentCookie, agentSession);
    expect(configuration.status).toBe(200);
    expect(await configuration.json()).toMatchObject({ result: { structuredContent: { data: { protocol: 'telomere-platform-v1',
      pins: platformPinsSchema.parse(local.pins), binding: { vault: vault.agent.vault, owner: local.accounts.owner.address,
        agentWallet: vault.account.address }, vaultPins: platformVaultConfigSchema.parse(vault.pins) } } } });
    const balance = await mcpPost('/mcp/platform', mcpTool(4, 'telomere_platform_balance', args), agentCookie, agentSession);
    expect(balance.status).toBe(200); expect(await balance.json()).toMatchObject({ result: { structuredContent: { data: { available: '1000000' } } } });
    const input = { ...args, leashId: vault.agent.leashId, task: { kind: 'sha256', text: 'actual-main-mcp-vault' }, maxSeconds: 10,
      deadline: Number((await local.local.publicClient.getBlock()).timestamp) + 180, maxSpend: '1090', idempotencyKey: 'main-mcp-unsigned-vault' };
    const quoted = await mcpPost('/mcp/platform', mcpTool(5, 'telomere_platform_quote', input), agentCookie, agentSession);
    expect(quoted.status).toBe(200);
    // REASON: The nested data is validated against the exact public signed-plan schema immediately below.
    const quoteEnvelope = await quoted.json() as { result: { structuredContent: { data: unknown } } };
    const prepared = platformPreparedSchema.parse(quoteEnvelope.result.structuredContent.data);
    expect(prepared.quote.payer.toLowerCase()).toBe(vault.agent.vault.toLowerCase()); expect(prepared.ceiling).toBe('1090');
    expect(prepared.transaction.to.toLowerCase()).toBe(vault.agent.vault.toLowerCase()); expect(prepared.transaction.value).toBe('0');
    expect(prepared.transaction.data).toBe(encodeFunctionData({ abi: local.artifact('PlatformAgentVault').abi, functionName: 'payRun',
      args: [typedPlatformQuote(prepared.quote), prepared.signature, prepared.imageProof, prepared.regionProof] }));
    expect(await verifyTypedData({ address: local.pins.quoteSigner, domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: 31337,
      verifyingContract: local.pins.escrowAddress }, types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(prepared.quote),
      signature: prepared.signature })).toBe(true);
    const ownerDenied = await mcpPost('/mcp/platform', mcpTool(2, 'telomere_platform_quote', { ...input, idempotencyKey: 'owner-mcp-denied' }), ownerCookie, ownerSession);
    expect(ownerDenied.status).toBe(200); expect(await ownerDenied.json()).toMatchObject({ result: { isError: true } });
    // A matching wallet identity with a different login cookie still has no access to the original MCP session.
    for (const cookie of [ownerCookie, sameAgentCookie]) {
      const denied = await mcpPost('/mcp/platform', mcpTool(6, 'telomere_platform_balance', args), cookie, agentSession);
      expect(denied.status).toBe(404); expect(await denied.text()).not.toContain(agentCookie);
    }
    expect((await mcpPost('/mcp/platform', mcpTool(6, 'telomere_platform_balance', args), agentCookie, legacySession)).status).toBe(404);
    expect((await mcpPost('/mcp', mcpTool(6, 'telomere_balance', {}), agentCookie, agentSession)).status).toBe(404);
    expect((await mcpPost('/mcp/platform', mcpTool(6, 'telomere_platform_balance', args), agentCookie, agentSession, 'https://untrusted.invalid')).status).toBe(403);
    expect((await mcpPost('/mcp/platform', mcpTool(6, 'telomere_platform_balance', args), '', agentSession)).status).toBe(401);
    const runs = await mcpPost('/mcp/platform', mcpTool(6, 'telomere_platform_runs', args), agentCookie, agentSession);
    expect(runs.status).toBe(200); expect(await runs.json()).toMatchObject({ result: { structuredContent: { data: { runs: [
      { id: prepared.quote.runId, status: 'prepared', admissionTx: null, settlementTx: null } ] } } } });
    // Preparing MCP work produces no payment, reservation, HostKit lease or host dispatch.
    expect((await local.local.publicClient.readContract({ address: vault.agent.vault, abi: local.artifact('PlatformAgentVault').abi,
      functionName: 'openRuns' }))).toBe(0n);
    let socketRateLimited = false, authenticationFailures = 0;
    for (let attempt = 0; attempt < 241; attempt++) {
      const limited = await fetch(config.PUBLIC_ORIGIN + '/mcp/platform', { headers: { 'X-Forwarded-For': `198.51.100.${attempt % 250 + 1}` } });
      if (limited.status === 429) {
        expect(await limited.json()).toMatchObject({ title: 'rate_limit' }); socketRateLimited = true; break;
      }
      expect(limited.status).toBe(401); authenticationFailures++; await limited.text();
    }
    expect(authenticationFailures).toBeGreaterThan(0); expect(socketRateLimited).toBe(true);
    const sharedBucket = await fetch(config.PUBLIC_ORIGIN + '/mcp');
    expect(sharedBucket.status).toBe(429); expect(await sharedBucket.json()).toMatchObject({ title: 'rate_limit' });
    const running = pilot; await running.close(); pilot = undefined;
    expect(trackedClose[0]).toHaveBeenCalledTimes(1); await assertNoListeningServer();
    for (const endpoint of ['/mcp', '/mcp/platform']) {
      const closed = await running.app.request(new Request(config.PUBLIC_ORIGIN + endpoint, { method: 'POST',
        headers: { Origin: config.PUBLIC_ORIGIN, Cookie: agentCookie, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': endpoint === '/mcp' ? legacySession : agentSession, 'Mcp-Protocol-Version': mcpProtocol },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) }));
      expect(closed.status).toBe(503);
    }
  }, 30_000);
});
