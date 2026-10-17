import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts } from '../scripts/compile-contracts.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { AgentCurrentCystPaidRestore } from '../src/agents/agent-current-cyst-restore.js';
import { canonical, secretHash } from '../src/common.js';
import { loadConfig, type Config } from '../src/config.js';
import { generateLargeCystId, restoreLargeCystFileWithWrappedKey,
  saveLargeCystFile } from '../src/cysts/large-checkpoints.js';
import { RpcCystRegistryReader } from '../src/cysts/registry-reader.js';
import { largeCystRegistryPlanSchema } from '../src/cysts/large-registry.js';
import { cystRegistryPinsSchema } from '../src/cysts/registry-types.js';
import { startPilot } from '../src/main.js';
import { sessionCommandSchema } from '../src/host-kit/sessions/types.js';
import { platformWorkloadHash } from '../src/platform-runtime/types.js';
import type { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { LargeCystHttpStore } from '../src/sdk/large-cyst-http-store.js';
import { LargeCystAgentManifestStore } from '../src/sdk/large-cyst-agent-manifest.js';
import { generateCystWrappingIdentity, wrapCystRecoveryKey } from '../src/sdk/cyst-key-wrap.js';
import { checkedLargeCystCommitPlan } from '../src/sdk/large-cyst-registry.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const hash = (label: string) => keccak256(toHex(label));

async function chainFixture() {
  const artifacts = compileContracts(['CystRegistry.sol', 'TelomereRunEscrow.sol', 'PlatformSelectionRegistry.sol',
    'PlatformAgentVault.sol', 'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol',
    'MockToken.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(hash('large-publication-main-host'), artifacts);
  try {
    const vault = await deployPlatformVault(local), cyst = local.artifact('CystRegistry');
    const registry = await local.confirmed(local.owner.deployContract({ abi: cyst.abi, bytecode: cyst.bytecode,
      args: [vault.registryAddress] }));
    if (!registry.contractAddress) throw new Error('CystRegistry deployment missing');
    const key = generatePrivateKey(), signer = privateKeyToAccount(key), escrow = local.artifact('TelomereRunEscrow');
    const legacy = await local.confirmed(local.owner.deployContract({ abi: escrow.abi, bytecode: escrow.bytecode,
      args: [local.pins.tokenAddress, signer.address, signer.address, local.accounts.owner.address] }));
    if (!legacy.contractAddress) throw new Error('Legacy escrow deployment missing');
    const code = await local.local.publicClient.getCode({ address: registry.contractAddress });
    if (!code) throw new Error('CystRegistry code missing');
    const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress: registry.contractAddress,
      registryCodeHash: keccak256(code), selectionRegistryAddress: vault.registryAddress,
      selectionRegistryCodeHash: vault.pins.registryCodeHash, confirmations: 0 });
    await local.test.mine({ blocks: 3 });
    return { ...local, vault, pins, agentId: vault.agentId as Hex, paymentToken: local.pins.tokenAddress,
      legacyEscrow: legacy.contractAddress, legacyKey: key };
  } catch (error) { await local.close(); throw error; }
}

class LoopbackS3 {
  readonly objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>();
  readonly server: Server;
  endpoint = '';
  outage = false;
  constructor() {
    this.server = createServer((request, response) => { void (async () => {
      if (this.outage) { response.writeHead(503).end(); return; }
      const path = request.url ?? '';
      if (!/^\/large-publication-test\/large-cysts\/v1\/(?:_connectivity\/probe\.bin|[a-f0-9]{64}\/(?:header\.json|manifest\.json|part-[0-9]{6}\.bin))$/.test(path)
        || typeof request.headers.authorization !== 'string') { response.writeHead(403).end(); return; }
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.headers['if-none-match'] !== '*') { response.writeHead(400).end(); return; }
        if (this.objects.has(path)) { response.writeHead(412).end(); return; }
        const metadata = Object.fromEntries(Object.entries(request.headers)
          .filter(([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string')) as Record<string, string>;
        this.objects.set(path, { body: Buffer.concat(chunks), metadata });
        response.writeHead(201).end(); return;
      }
      const saved = this.objects.get(path);
      if (request.method !== 'GET' || !saved) { response.writeHead(404).end(); return; }
      response.writeHead(200, { ...saved.metadata, 'content-length': String(saved.body.length) }).end(saved.body);
    })().catch(() => response.destroy()); });
  }
  async start() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback S3 port missing');
    this.endpoint = `http://127.0.0.1:${address.port}/`;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

describe('full pilot large Cyst publication route and signed agent session', () => {
  let deployed: Awaited<ReturnType<typeof chainFixture>>;
  let snapshot: Hex;
  let root: string, config: Config, pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  let first: LoopbackS3, second: LoopbackS3;
  let ownerCookie: string, agentCookie: string, outsiderCookie: string;
  beforeAll(async () => { deployed = await chainFixture(); snapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot();
    root = await mkdtemp(join(tmpdir(), 'telomere-large-publication-main-'));
    const small = join(root, 'small'), large = join(root, 'large');
    await Promise.all([mkdir(small, { mode: 0o700 }), mkdir(large, { mode: 0o700 })]);
    first = new LoopbackS3(); second = new LoopbackS3();
    await Promise.all([first.start(), second.start()]);
    const pair = { version: 1, destinations: [
      { endpoint: first.endpoint, bucket: 'large-publication-test', region: 'us-east-1', failureDomain: 'region-one',
        reviewed: true, allowInsecureLoopback: true,
        credentials: { accessKeyId: 'localtestone', secretAccessKey: 'local-test-secret-access-key-one' } },
      { endpoint: second.endpoint, bucket: 'large-publication-test', region: 'eu-west-1', failureDomain: 'region-two',
        reviewed: true, allowInsecureLoopback: true,
        credentials: { accessKeyId: 'localtesttwo', secretAccessKey: 'local-test-secret-access-key-two' } },
    ] };
    const replicationPath = join(root, 'large-replication.json');
    const replicationBytes = Buffer.from(JSON.stringify(pair));
    await writeFile(replicationPath, replicationBytes, { mode: 0o600 });
    const pinsPath = join(root, 'cyst-registry.json');
    await writeFile(pinsPath, JSON.stringify(deployed.pins), { mode: 0o600 });
    const port = await unusedLocalPort();
    config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: deployed.local.rpcUrl,
      DATA_DIR: join(root, 'db'), HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      ESCROW_ADDRESS: deployed.legacyEscrow, TOKEN_ADDRESS: deployed.paymentToken,
      SIGNER_PRIVATE_KEY: deployed.legacyKey, DEMO_PRIVATE_KEY: deployed.keys.owner,
      CPU_MODE: 'demo', SELECTION_ENABLED: 'false', LOG_LEVEL: 'error',
      CYSTS_ENABLED: 'true', CYSTS_DIR: small, CYST_REGISTRY_CONFIG: pinsPath,
      CYSTS_LARGE_DIR: large, CYSTS_LARGE_GLOBAL_BYTES: String(16 * 1024 * 1024),
      CYSTS_LARGE_OWNER_BYTES: String(8 * 1024 * 1024), CYSTS_LARGE_REPLICATION_CONFIG: replicationPath,
      CYSTS_LARGE_REPLICATION_CONFIG_SHA256: '0x' + createHash('sha256').update(replicationBytes).digest('hex') });
    pilot = await startPilot(config);
    ownerCookie = await signedSession(deployed.accounts.owner);
    agentCookie = await signedSession(deployed.vault.account);
    outsiderCookie = await signedSession(deployed.accounts.outsider);
  }, 45_000);
  afterEach(async () => {
    await pilot?.close(); pilot = undefined;
    await Promise.all([first?.close(), second?.close()]);
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-large-publication-main-')) {
        throw new Error('Unexpected owned fixture directory');
      }
      await rm(target, { recursive: true, force: true });
    }
  });
  afterAll(async () => { await deployed?.close(); });

  function post(path: string, body: unknown, cookie = agentCookie, key = 'large-publication-main') {
    return fetch(config.PUBLIC_ORIGIN + path, { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN,
      Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  }
  function get(path: string, cookie = agentCookie) {
    return fetch(config.PUBLIC_ORIGIN + path, { headers: { Cookie: cookie } });
  }
  async function signedSession(account: typeof deployed.accounts.owner) {
    const challenge = await post('/api/auth/challenge', { address: account.address }, '');
    expect(challenge.status).toBe(200);
    const value = await challenge.json() as { nonce: string; message: string };
    const signature = await account.signMessage({ message: value.message });
    const verification = await post('/api/auth/verify', { address: account.address, nonce: value.nonce, signature }, '');
    expect(verification.status).toBe(200);
    const cookie = verification.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Signed agent session cookie missing');
    return cookie;
  }
  async function done(path: string) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const value = await response.json() as { status: string; plan?: unknown; errorCode?: string };
      if (value.status === 'succeeded') return largeCystRegistryPlanSchema.parse(value.plan);
      if (value.status !== 'queued' && value.status !== 'running') throw new Error(`Publication failed: ${value.errorCode}`);
      if (Date.now() >= deadline) throw new Error('Publication job did not complete');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  it('mounts only with both reviewed pins, accepts real agent auth, and survives route-condition restarts', async () => {
    expect(pilot?.largePublication).toBeDefined();
    const checkpointId = generateLargeCystId(), recoveryKey = randomBytes(32);
    const source = join(root, 'checkpoint.tar.zst');
    try {
      await writeFile(source, randomBytes(300_000));
      const scope = { owner: deployed.accounts.owner.address, agent: deployed.vault.account.address,
        applicationSchema: 'agent-overlay.tar.zst/v1' };
      const ownerIdentity = await generateCystWrappingIdentity();
      const agentIdentity = await generateCystWrappingIdentity();
      const wrapped = await wrapCystRecoveryKey(recoveryKey,
        { owner: scope.owner, agent: scope.agent, checkpointId },
        { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
      const ownerStore = new LargeCystHttpStore({ baseUrl: config.PUBLIC_ORIGIN,
        sessionToken: ownerCookie.slice('telomere_session='.length) });
      await saveLargeCystFile({ store: ownerStore, sourcePath: source, id: checkpointId,
        scope, recoveryKey, wrappedKey: { bundle: wrapped, ownerIdentity,
          agentPublicKey: agentIdentity.publicKey } });
      const beforeNonce = await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address });
      const manifestPath = `/api/cysts-large-registry/agents/${deployed.agentId}`
        + `/checkpoints/${checkpointId}/manifest`;
      expect((await get(manifestPath, '')).status).toBe(401);
      expect((await get(manifestPath, ownerCookie)).status).toBe(403);
      expect((await get(manifestPath, outsiderCookie)).status).toBe(403);
      const agentManifestStore = new LargeCystAgentManifestStore({ baseUrl: config.PUBLIC_ORIGIN,
        agentId: deployed.agentId, sessionToken: agentCookie.slice('telomere_session='.length) });
      const manifest = await agentManifestStore.manifest(checkpointId);
      expect(manifest?.header.id).toBe(checkpointId);
      expect(manifest?.header.owner).toBe(deployed.accounts.owner.address.toLowerCase());
      expect(manifest?.header.agent).toBe(deployed.vault.account.address.toLowerCase());
      expect(manifest?.wrappedKey).toEqual(wrapped);
      expect((await get(manifestPath)).headers.get('cache-control')).toBe('no-store');
      const partPath = `/api/cysts-large-registry/agents/${deployed.agentId}`
        + `/checkpoints/${checkpointId}/parts/0`;
      expect((await get(partPath, '')).status).toBe(401);
      expect((await get(partPath, ownerCookie)).status).toBe(403);
      expect((await get(partPath, outsiderCookie)).status).toBe(403);
      const restoredPath = join(root, 'agent-restored.tar.zst');
      await restoreLargeCystFileWithWrappedKey({ store: agentManifestStore, id: checkpointId,
        destinationPath: restoredPath, scope, recipient: 'agent', identity: agentIdentity });
      expect(await readFile(restoredPath)).toEqual(await readFile(source));
      expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address })).toBe(beforeNonce);
      const base = `/api/cysts-large-registry/agents/${deployed.agentId}/jobs`;
      expect((await post(base, { checkpointId }, '', 'large-publication-anon')).status).toBe(401);
      expect((await post(base, { checkpointId }, ownerCookie, 'large-publication-owner')).status).toBe(403);
      expect((await post(base, { checkpointId }, outsiderCookie, 'large-publication-outsider')).status).toBe(403);
      const created = await post(base, { checkpointId }, agentCookie, 'large-publication-agent');
      expect(created.status).toBe(202);
      const job = await created.json() as { id: string; status: string };
      expect(['queued', 'running']).toContain(job.status);
      const replay = await post(base, { checkpointId }, agentCookie, 'large-publication-agent');
      expect((await replay.json() as { id: string }).id).toBe(job.id);
      const statusPath = base + '/' + job.id;
      expect((await get(statusPath, ownerCookie)).status).toBe(404);
      expect((await get(statusPath, outsiderCookie)).status).toBe(404);
      const crossOrigin = await fetch(config.PUBLIC_ORIGIN + base, { method: 'POST', headers: {
        Origin: 'https://untrusted.invalid', Cookie: agentCookie, 'Content-Type': 'application/json',
        'Idempotency-Key': 'large-publication-cross-origin',
      }, body: JSON.stringify({ checkpointId }) });
      expect(crossOrigin.status).toBe(403);
      const plan = await done(statusPath);
      expect(plan.binding.agentWallet).toBe(deployed.vault.account.address);
      expect(plan.transaction.from).toBe(deployed.vault.account.address);
      const checked = await checkedLargeCystCommitPlan({ plan, agentWallet: deployed.vault.account.address,
        agentId: deployed.agentId, checkpointId, recoveryKey, agentIdentity, manifestStore: agentManifestStore,
        reader: new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }) });
      expect(checked).toEqual(plan.transaction);
      expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address })).toBe(beforeNonce);
      expect(JSON.stringify(plan)).not.toContain(Buffer.from(recoveryKey).toString('hex'));

      await pilot?.close(); pilot = undefined;
      pilot = await startPilot({ ...config, CYST_REGISTRY_CONFIG: undefined });
      expect(pilot.largePublication).toBeUndefined();
      expect((await get(statusPath)).status).toBe(404);
      await pilot.close(); pilot = undefined;
      second.outage = true;
      pilot = await startPilot(config);
      expect(pilot.largePublication).toBeUndefined();
      expect((await get(statusPath)).status).toBe(404);
      await pilot.close(); pilot = undefined;
      second.outage = false;
      pilot = await startPilot(config);
      expect(pilot.largePublication).toBeDefined();
      const restored = await get(statusPath);
      expect(restored.status).toBe(200);
      const restoredJob = await restored.json() as { status: string; plan?: unknown };
      expect(restoredJob.status).toBe('succeeded');
      const restoredPlan = largeCystRegistryPlanSchema.parse(restoredJob.plan);
      expect(restoredPlan).toEqual(plan);
      expect(await checkedLargeCystCommitPlan({ plan: restoredPlan, agentWallet: deployed.vault.account.address,
        agentId: deployed.agentId, checkpointId, recoveryKey, agentIdentity, manifestStore: agentManifestStore,
        reader: new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }) }))
        .toEqual(plan.transaction);
      expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address })).toBe(beforeNonce);
    } finally { recoveryKey.fill(0); }
  }, 120_000);

  it('resolves an agent-published current locator after restart and rejects an orphaned commit', async () => {
    const checkpointId = generateLargeCystId(), recoveryKey = randomBytes(32);
    const source = join(root, 'current-source.tar.zst');
    const scope = { owner: deployed.accounts.owner.address, agent: deployed.vault.account.address,
      applicationSchema: 'agent-overlay.tar.zst/v1' };
    try {
      await writeFile(source, randomBytes(90_000));
      const ownerIdentity = await generateCystWrappingIdentity();
      const agentIdentity = await generateCystWrappingIdentity();
      const wrapped = await wrapCystRecoveryKey(recoveryKey,
        { owner: scope.owner, agent: scope.agent, checkpointId },
        { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
      const ownerStore = new LargeCystHttpStore({ baseUrl: config.PUBLIC_ORIGIN,
        sessionToken: ownerCookie.slice('telomere_session='.length) });
      await saveLargeCystFile({ store: ownerStore, sourcePath: source, id: checkpointId,
        scope, recoveryKey, wrappedKey: { bundle: wrapped, ownerIdentity,
          agentPublicKey: agentIdentity.publicKey } });
      const currentPath = `/api/cysts-large-registry/agents/${deployed.agentId}/checkpoints/current`;
      expect((await get(currentPath)).status).toBe(404);
      const agentStore = new LargeCystAgentManifestStore({ baseUrl: config.PUBLIC_ORIGIN,
        agentId: deployed.agentId, sessionToken: agentCookie.slice('telomere_session='.length) });
      const reader = new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins });
      const created = await post(`/api/cysts-large-registry/agents/${deployed.agentId}/jobs`,
        { checkpointId }, agentCookie, 'current-locator-audit');
      expect(created.status).toBe(202);
      const job = await created.json() as { id: string };
      const plan = await done(`/api/cysts-large-registry/agents/${deployed.agentId}/jobs/${job.id}`);
      expect((await get(currentPath)).status).toBe(404);
      const checked = await checkedLargeCystCommitPlan({ plan, agentWallet: deployed.vault.account.address,
        agentId: deployed.agentId, checkpointId, recoveryKey, agentIdentity,
        manifestStore: agentStore, reader });
      const beforeCommit = await deployed.test.snapshot();
      await deployed.confirmed(deployed.vault.wallet.sendTransaction({ to: checked.to,
        data: checked.data as Hex, value: 0n }));
      expect((await get(currentPath, '')).status).toBe(401);
      expect((await get(currentPath, ownerCookie)).status).toBe(403);
      expect((await get(currentPath, outsiderCookie)).status).toBe(403);
      const response = await get(currentPath);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const resolved = await agentStore.resolveCurrent(reader);
      expect(resolved.checkpointId).toBe(checkpointId);
      expect(resolved.checkpoint).toEqual(plan.checkpoint);
      expect(resolved.current.revision).toBe('1');
      expect(resolved.manifest.wrappedKey).toEqual(wrapped);
      let partReads = 0, paidCalls = 0;
      const oversized = new LargeCystAgentManifestStore({ baseUrl: config.PUBLIC_ORIGIN,
        agentId: deployed.agentId, sessionToken: agentCookie.slice('telomere_session='.length) });
      oversized.part = async () => { partReads++; throw new Error('oversized Cyst part must not be read'); };
      const noPaidCall = async () => { paidCalls++; throw new Error('oversized Cyst cannot reach paid target'); };
      const oversizedRestore = new AgentCurrentCystPaidRestore({ owner: scope.owner, agent: scope.agent,
        agentId: deployed.agentId, applicationSchema: scope.applicationSchema,
        imageDigest: `sha256:${'a'.repeat(64)}`, maxCommands: 4,
        restoreArgvPrefix: ['/usr/local/bin/node', '/app/restore.mjs'],
        reader, store: oversized, identity: agentIdentity,
        client: { config: noPaidCall, get: noPaidCall, command: noPaidCall } as unknown as
          Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'command'>,
        journal: { exclusive: noPaidCall } as unknown as CystCheckpointFileVault,
        temporaryDirectory: root });
      await expect(oversizedRestore.restore({ targetRunId: hash('oversized-target'),
        restoreOperationId: 'oversized' })).rejects.toThrow('does not fit');
      expect(partReads).toBe(0);
      expect(paidCalls).toBe(0);
      const output = join(root, 'current-restored.tar.zst');
      await agentStore.restoreCurrent({ reader, destinationPath: output, scope, identity: agentIdentity });
      expect(await readFile(output)).toEqual(await readFile(source));
      await pilot?.close(); pilot = undefined;
      pilot = await startPilot(config);
      expect((await agentStore.resolveCurrent(reader)).checkpointId).toBe(checkpointId);
      await deployed.test.revert({ id: beforeCommit });
      expect((await get(currentPath)).status).toBe(404);
      await expect(agentStore.resolveCurrent(reader)).rejects.toThrow('HTTP 404');
    } finally { recoveryKey.fill(0); }
  }, 120_000);

  it('restores the current small registered state as the original agent with one durable paid command', async () => {
    const checkpointId = generateLargeCystId(), recoveryKey = randomBytes(32), journalKey = randomBytes(32);
    const source = join(root, 'paid-agent-state.bin'), privateRoot = join(root, 'agent-private');
    await mkdir(privateRoot, { mode: 0o700 });
    const original = Buffer.from(JSON.stringify({ counter: 17, marker: 'agent-current-paid-restore' }));
    await writeFile(source, original, { mode: 0o600 });
    const scope = { owner: deployed.accounts.owner.address, agent: deployed.vault.account.address,
      applicationSchema: 'agent-counter.v1' };
    const ownerIdentity = await generateCystWrappingIdentity();
    const agentIdentity = await generateCystWrappingIdentity();
    const journal = new CystCheckpointFileVault({ directory: privateRoot, masterKey: journalKey });
    try {
      const wrapped = await wrapCystRecoveryKey(recoveryKey,
        { owner: scope.owner, agent: scope.agent, checkpointId },
        { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
      const ownerStore = new LargeCystHttpStore({ baseUrl: config.PUBLIC_ORIGIN,
        sessionToken: ownerCookie.slice('telomere_session='.length) });
      await saveLargeCystFile({ store: ownerStore, sourcePath: source, id: checkpointId,
        scope, recoveryKey, wrappedKey: { bundle: wrapped, ownerIdentity,
          agentPublicKey: agentIdentity.publicKey } });
      const agentStore = new LargeCystAgentManifestStore({ baseUrl: config.PUBLIC_ORIGIN,
        agentId: deployed.agentId, sessionToken: agentCookie.slice('telomere_session='.length) });
      const reader = new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins });
      const created = await post(`/api/cysts-large-registry/agents/${deployed.agentId}/jobs`,
        { checkpointId }, agentCookie, 'paid-agent-current-audit');
      expect(created.status).toBe(202);
      const job = await created.json() as { id: string };
      const plan = await done(`/api/cysts-large-registry/agents/${deployed.agentId}/jobs/${job.id}`);
      const checked = await checkedLargeCystCommitPlan({ plan, agentWallet: scope.agent,
        agentId: deployed.agentId, checkpointId, recoveryKey, agentIdentity,
        manifestStore: agentStore, reader });
      const beforeCommit = await deployed.test.snapshot();
      await deployed.confirmed(deployed.vault.wallet.sendTransaction({ to: checked.to,
        data: checked.data as Hex, value: 0n }));

      const targetRunId = hash('paid-agent-current-target'), imageDigest = `sha256:${'a'.repeat(64)}`;
      const run = { id: targetRunId, status: 'running', admissionTx: hash('paid-agent-admission'),
        quote: { runId: targetRunId, hostId: deployed.hostId, payer: deployed.vault.agent.vault,
          leashId: hash('paid-agent-leash'), hwClass: 0, inferencePrice: '0',
          regionHash: keccak256(toHex('local-test')), imageHash: keccak256(toHex(imageDigest)),
          workloadHash: platformWorkloadHash({ task: { kind: 'session', imageDigest, maxCommands: 4 } }) } };
      const configuration = { binding: { agentId: deployed.agentId, owner: scope.owner,
        agentWallet: scope.agent, vault: deployed.vault.agent.vault, leashId: hash('paid-agent-leash') },
        capacity: [{ hostId: deployed.hostId, imageDigest, region: 'local-test', sessionEnabled: true }] };
      let commandCalls = 0, applied = 0, loseResponse = true;
      const commands = new Map<string, { command: unknown; result: unknown }>();
      const paid = { config: async () => configuration,
        get: async (id: string) => ({ ...run, id, quote: { ...run.quote, runId: id } }),
        command: async (id: string, raw: unknown) => {
          expect(id).toBe(targetRunId);
          const command = sessionCommandSchema.parse(raw);
          commandCalls++;
          const previous = commands.get(command.commandId);
          if (previous && canonical(previous.command) !== canonical(command)) throw new Error('changed paid command');
          if (!previous) {
            const value = JSON.parse(command.stdin ?? '{}') as { stateBase64: string; stateSha256: string;
              protocol: string; checkpointId: string; targetRunId: string };
            const plaintext = Buffer.from(value.stateBase64, 'base64');
            expect(plaintext).toEqual(original);
            expect(createHash('sha256').update(plaintext).digest('hex')).toBe(value.stateSha256);
            expect(value.checkpointId).toBe(checkpointId);
            expect(value.targetRunId).toBe(targetRunId);
            await writeFile(join(root, 'guest-applied-state.bin'), plaintext, { flag: 'wx', mode: 0o600 });
            applied++;
            const { stateBase64: _secret, ...receipt } = value;
            const result = { command, inputHash: secretHash(canonical(command)), state: 'completed',
              stdout: JSON.stringify(receipt), stderr: '', exitCode: 0, reason: 'exited',
              outputBytes: Buffer.byteLength(JSON.stringify(receipt)) };
            commands.set(command.commandId, { command, result });
            plaintext.fill(0);
          }
          if (loseResponse) { loseResponse = false; throw new Error('lost paid command response'); }
          return commands.get(command.commandId)!.result;
        } } as unknown as Pick<PlatformVaultRuntimeClient, 'config' | 'get' | 'command'>;
      const make = (target = targetRunId, commandSuffix = '', selectedStore = agentStore,
        operation = 'agent-current-restore-1') => new AgentCurrentCystPaidRestore({
        owner: scope.owner, agent: scope.agent, agentId: deployed.agentId, applicationSchema: scope.applicationSchema,
        imageDigest, maxCommands: 4, restoreArgvPrefix: ['/usr/local/bin/node', '/app/restore.mjs' + commandSuffix],
        reader, store: selectedStore, identity: agentIdentity, client: paid, journal,
        temporaryDirectory: privateRoot,
      }).restore({ targetRunId: target, restoreOperationId: operation });
      const revertingStore = new LargeCystAgentManifestStore({ baseUrl: config.PUBLIC_ORIGIN,
        agentId: deployed.agentId, sessionToken: agentCookie.slice('telomere_session='.length) });
      const originalPart = revertingStore.part.bind(revertingStore);
      let revertedDuringPart = false;
      revertingStore.part = async (id, index) => {
        const bytes = await originalPart(id, index);
        if (!revertedDuringPart) {
          revertedDuringPart = true;
          await deployed.test.revert({ id: beforeCommit });
        }
        return bytes;
      };
      await expect(make(targetRunId, '', revertingStore)).rejects.toThrow('Current registered checkpoint');
      expect(commandCalls).toBe(0);
      const beforeRetryCommit = await deployed.test.snapshot();
      await deployed.confirmed(deployed.vault.wallet.sendTransaction({ to: checked.to,
        data: checked.data as Hex, value: 0n }));
      await expect(make()).rejects.toThrow('lost paid command response');
      expect(applied).toBe(1);
      expect(await readFile(join(root, 'guest-applied-state.bin'))).toEqual(original);
      const restored = await make();
      expect(restored).toMatchObject({ agentId: deployed.agentId, targetRunId,
        checkpointId, restoreOperationId: 'agent-current-restore-1' });
      expect(applied).toBe(1);
      expect(commandCalls).toBe(2);
      run.status = 'completed';
      expect(await make()).toEqual(restored);
      await expect(make(targetRunId, '', agentStore, 'new-restore-after-close'))
        .rejects.toThrow('reviewed admitted paid CPU session');
      expect(commandCalls).toBe(3);
      await expect(make(targetRunId, '.changed')).rejects.toThrow('already bound');
      await expect(make(hash('other-paid-cell'))).rejects.toThrow('already bound');
      expect(commandCalls).toBe(3);
      const nextId = generateLargeCystId(), nextKey = randomBytes(32);
      try {
        const nextScope = { ...scope, applicationSchema: 'agent-counter.v2' };
        const nextWrapped = await wrapCystRecoveryKey(nextKey,
          { owner: scope.owner, agent: scope.agent, checkpointId: nextId },
          { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
        await saveLargeCystFile({ store: ownerStore, sourcePath: source, id: nextId,
          scope: nextScope, recoveryKey: nextKey, wrappedKey: { bundle: nextWrapped, ownerIdentity,
            agentPublicKey: agentIdentity.publicKey } });
        const nextCreated = await post(`/api/cysts-large-registry/agents/${deployed.agentId}/jobs`,
          { checkpointId: nextId }, agentCookie, 'paid-agent-next-schema-audit');
        expect(nextCreated.status).toBe(202);
        const nextJob = await nextCreated.json() as { id: string };
        const nextPlan = await done(`/api/cysts-large-registry/agents/${deployed.agentId}/jobs/${nextJob.id}`);
        const nextChecked = await checkedLargeCystCommitPlan({ plan: nextPlan, agentWallet: scope.agent,
          agentId: deployed.agentId, checkpointId: nextId, recoveryKey: nextKey, agentIdentity,
          manifestStore: agentStore, reader });
        await deployed.confirmed(deployed.vault.wallet.sendTransaction({ to: nextChecked.to,
          data: nextChecked.data as Hex, value: 0n }));
        const changedSchema = new AgentCurrentCystPaidRestore({ owner: scope.owner, agent: scope.agent,
          agentId: deployed.agentId, applicationSchema: nextScope.applicationSchema,
          imageDigest, maxCommands: 4, restoreArgvPrefix: ['/usr/local/bin/node', '/app/restore.mjs'],
          reader, store: agentStore, identity: agentIdentity, client: paid, journal,
          temporaryDirectory: privateRoot });
        await expect(changedSchema.restore({ targetRunId,
          restoreOperationId: 'agent-current-restore-1' })).rejects.toThrow('already bound');
        expect(commandCalls).toBe(3);
      } finally { nextKey.fill(0); }
      expect((await readFile(source))).toEqual(original);
      const remaining = (await import('node:fs/promises')).readdir(privateRoot);
      expect((await remaining).some(name => name.startsWith('agent-cyst-restore-'))).toBe(false);
      await deployed.test.revert({ id: beforeRetryCommit });
      await expect(make()).rejects.toThrow('HTTP 404');
      expect(commandCalls).toBe(3);
    } finally { journal.close(); recoveryKey.fill(0); journalKey.fill(0); }
  }, 120_000);
});
