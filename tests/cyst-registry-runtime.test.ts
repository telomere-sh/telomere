import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts } from '../scripts/compile-contracts.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { loadConfig, type Config } from '../src/config.js';
import { startPilot } from '../src/main.js';
import { cysts } from '../src/cysts/schema.js';
import { RpcCystRegistryReader } from '../src/cysts/registry-reader.js';
import { CystRegistryClient } from '../src/cysts/registry-client.js';
import { cystRegistryAbi, cystRegistryCommitPreparedSchema, cystRegistryConfigSchema, cystRegistryPinsSchema,
  cystRegistryDownloadSchema, cystRegistryRetirePreparedSchema, cystRegistrySnapshotSchema, cystRegistryStorageRef, cystRegistryVerificationSchema,
  type CystRegistryPins } from '../src/cysts/registry-types.js';
import { CYST_CAPABILITIES, cystMetadataSchema, type CystEnvelope } from '../src/cysts/types.js';
import { decryptCheckpoint, encryptCheckpoint, exportCystRecoveryKey, generateCystRecoveryKey } from '../src/sdk/cysts.js';
import { openStore, transactions } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const hash = (label: string) => keccak256(toHex(label));
const plaintext = new TextEncoder().encode('{"counter":9,"memory":"cyst-registry-client-only-sentinel"}');

async function chainFixture() {
  const artifacts = compileContracts(['CystRegistry.sol', 'TelomereRunEscrow.sol', 'PlatformSelectionRegistry.sol',
    'PlatformAgentVault.sol', 'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol',
    'MockToken.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(hash('cyst-runtime-host'), artifacts);
  try {
    const vault = await deployPlatformVault(local), cyst = local.artifact('CystRegistry');
    const registryReceipt = await local.confirmed(local.owner.deployContract({ abi: cyst.abi, bytecode: cyst.bytecode,
      args: [vault.registryAddress] }));
    if (!registryReceipt.contractAddress) throw new Error('Runtime Cyst registry fixture missing');
    const registryAddress = registryReceipt.contractAddress, key = generatePrivateKey(), signer = privateKeyToAccount(key);
    const legacy = local.artifact('TelomereRunEscrow');
    const escrow = await local.confirmed(local.owner.deployContract({ abi: legacy.abi, bytecode: legacy.bytecode,
      args: [local.pins.tokenAddress, signer.address, signer.address, local.accounts.owner.address] }));
    if (!escrow.contractAddress) throw new Error('Runtime legacy escrow fixture missing');
    const code = await local.local.publicClient.getCode({ address: registryAddress });
    if (!code) throw new Error('Runtime Cyst registry fixture code missing');
    const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress, registryCodeHash: keccak256(code),
      selectionRegistryAddress: vault.registryAddress, selectionRegistryCodeHash: vault.pins.registryCodeHash, confirmations: 0 });
    await local.test.mine({ blocks: 3 });
    // REASON: Selection's real identityAgent getter returns a bytes32 identity.
    const agentId = vault.agentId as Hex;
    return { ...local, vault, pins, agentId, paymentToken: local.pins.tokenAddress, legacyEscrow: escrow.contractAddress, legacyKey: key };
  } catch (error) { await local.close(); throw error; }
}

describe('actual main HTTP CystRegistry with encrypted storage and independent Anvil state', () => {
  let deployed: Awaited<ReturnType<typeof chainFixture>>, snapshot: Hex;
  let root: string, config: Config, pinsPath: string, pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  let ownerCookie: string, agentCookie: string, outsiderCookie: string;
  beforeAll(async () => { deployed = await chainFixture(); snapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot();
    root = await mkdtemp(join(tmpdir(), 'telomere-cyst-registry-runtime-'));
    pinsPath = join(root, 'cyst-registry.json'); await reviewedPins(deployed.pins);
    const port = await unusedLocalPort();
    config = loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: deployed.local.rpcUrl, DATA_DIR: join(root, 'db'),
      ESCROW_ADDRESS: deployed.legacyEscrow, TOKEN_ADDRESS: deployed.paymentToken, SIGNER_PRIVATE_KEY: deployed.legacyKey,
      DEMO_PRIVATE_KEY: deployed.keys.owner, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'http://127.0.0.1:' + port,
      CPU_MODE: 'demo', CYSTS_ENABLED: 'true', CYSTS_DIR: join(root, 'ciphertext'), CYST_REGISTRY_CONFIG: pinsPath,
      SELECTION_ENABLED: 'false', LOG_LEVEL: 'error' });
    pilot = await startPilot(config);
    ownerCookie = await signedSession(deployed.accounts.owner);
    agentCookie = await signedSession(deployed.vault.account);
    outsiderCookie = await signedSession(deployed.accounts.outsider);
  }, 30_000);
  afterEach(async () => {
    await pilot?.close(); pilot = undefined;
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-cyst-registry-runtime-')) throw new Error('Unexpected owned runtime directory');
      await rm(target, { recursive: true, force: true });
    }
  });
  afterAll(async () => { await deployed?.close(); });

  async function reviewedPins(pins: CystRegistryPins) {
    await writeFile(pinsPath, JSON.stringify(pins), { mode: 0o600 });
  }
  function post(path: string, body: unknown, cookie = agentCookie, idempotencyKey = 'cyst-runtime-plan', origin = config.PUBLIC_ORIGIN) {
    return fetch(config.PUBLIC_ORIGIN + path, { method: 'POST', headers: { Origin: origin, Cookie: cookie,
      'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) });
  }
  function get(path: string, cookie = agentCookie) {
    return fetch(config.PUBLIC_ORIGIN + path, { headers: { Cookie: cookie } });
  }
  const base = (agentId = deployed.agentId) => '/api/cyst-registry/agents/' + agentId;
  async function signedSession(account: Awaited<ReturnType<typeof chainFixture>>['accounts']['owner']) {
    const requested = await post('/api/auth/challenge', { address: account.address }, ''); expect(requested.status).toBe(200);
    const challenge = await requested.json();
    if (!challenge || typeof challenge !== 'object' || typeof challenge.nonce !== 'string' || typeof challenge.message !== 'string') {
      throw new Error('Runtime challenge has no signable nonce/message');
    }
    const signature = await account.signMessage({ message: challenge.message });
    const verified = await post('/api/auth/verify', { address: account.address, nonce: challenge.nonce, signature }, '');
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Runtime signed session missing'); return cookie;
  }
  async function upload(options: { owner?: Address; agent?: Address; cookie?: string; label?: string } = {}) {
    const encrypted = await encryptCheckpoint(plaintext, { owner: options.owner ?? deployed.accounts.owner.address,
      agent: options.agent ?? deployed.vault.account.address, applicationSchema: 'runtime-state.v1' });
    const response = await post('/api/cysts', encrypted.envelope, options.cookie ?? ownerCookie, options.label ?? encrypted.envelope.id);
    expect(response.status).toBe(201);
    const uploaded = await response.json();
    const checkpoint = cystMetadataSchema.parse(uploaded.checkpoint);
    return { ...encrypted, checkpoint };
  }
  async function prepared(checkpointId: string, key = 'cyst-runtime-plan') {
    const response = await post(base() + '/commit-plan', { checkpointId }, agentCookie, key);
    expect(response.status).toBe(200); return cystRegistryCommitPreparedSchema.parse(await response.json());
  }
  async function submitted(transaction: { to: Address; data: string; value: string }) {
    // REASON: Successful plans pass the shared schema's exact even-length hexadecimal data expression.
    const data = transaction.data as Hex;
    return deployed.confirmed(deployed.vault.wallet.sendTransaction({ to: transaction.to, data, value: BigInt(transaction.value) }));
  }
  async function verify(checkpointId: string, cookie = agentCookie) {
    const response = await post(base() + '/verify', { checkpointId }, cookie);
    expect(response.status).toBe(200); return cystRegistryVerificationSchema.parse(await response.json());
  }
  function publishedBlob(checkpointId: string, cookie = agentCookie) {
    return get(base() + '/checkpoints/' + checkpointId + '/blob', cookie);
  }
  function checkedClient(cookie = agentCookie) {
    return new CystRegistryClient({ baseUrl: config.PUBLIC_ORIGIN, pins: deployed.pins,
      reader: new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }),
      sessionToken: cookie.slice('telomere_session='.length) });
  }
  function blobPath(envelope: CystEnvelope): string {
    const name = createHash('sha256').update('telomere-cyst-blob:' + envelope.owner + ':' + envelope.sha256).digest('hex') + '.blob';
    if (!config.CYSTS_DIR) throw new Error('Runtime private blob directory missing');
    return join(config.CYSTS_DIR, name);
  }
  async function assertPortReleased() {
    const probe = createServer();
    await new Promise<void>((done, reject) => probe.once('error', reject).listen(config.PORT, '127.0.0.1', done));
    await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  }

  it('uploads owner-encrypted bytes, prepares an exact unsigned agent CAS transaction, verifies and restores across restart', async () => {
    const item = await upload();
    const publicResponse = await get('/api/cyst-registry/config'); expect(publicResponse.status).toBe(200);
    const published = cystRegistryConfigSchema.parse(await publicResponse.json());
    expect(published.pins).toEqual(deployed.pins); expect(published.maxCheckpointBytes).toBe(CYST_CAPABILITIES.maxCiphertextBytes);
    expect(published.maxRegistryBytes).toBe(2_147_483_648);
    const before = await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address });
    const plan = await prepared(item.envelope.id);
    expect(plan.checkpoint).toEqual(item.checkpoint); expect(plan.current.revision).toBe('0');
    expect(plan.binding).toMatchObject({ owner: getAddress(deployed.accounts.owner.address), agentWallet: deployed.vault.account.address,
      vault: getAddress(deployed.vault.agent.vault), agentId: deployed.agentId });
    expect(plan.transaction).toEqual({ chainId: 31337, from: deployed.vault.account.address, to: deployed.pins.registryAddress,
      value: '0', data: encodeFunctionData({ abi: cystRegistryAbi, functionName: 'commitChecked', args: [deployed.agentId,
        `0x${item.envelope.sha256}`, BigInt(item.checkpoint.ciphertextBytes), cystRegistryStorageRef(item.checkpoint), 0n] }) });
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address })).toBe(before);
    expect((await verify(item.envelope.id)).matches).toBe(false);
    const responseText = JSON.stringify(plan); expect(responseText).not.toContain(exportCystRecoveryKey(item.recoveryKey));
    expect(responseText).not.toContain(new TextDecoder().decode(plaintext)); expect(responseText).not.toContain(config.CYSTS_DIR);
    await submitted(plan.transaction);
    const verified = await verify(item.envelope.id, ownerCookie);
    expect(verified).toMatchObject({ matches: true, current: { revision: '1', cystHash: '0x' + item.envelope.sha256,
      sizeBytes: String(item.checkpoint.ciphertextBytes), retired: false } });
    expect((await verify(item.envelope.id)).current).toEqual(verified.current);
    expect(await pilot?.service.db.select().from(transactions)).toHaveLength(0);
    await pilot?.close(); pilot = undefined; await assertPortReleased();
    pilot = await startPilot(config);
    expect((await verify(item.envelope.id, ownerCookie)).matches).toBe(true);
    const downloaded = await get('/api/cysts/' + item.envelope.id + '/blob', ownerCookie); expect(downloaded.status).toBe(200);
    const blob = await downloaded.json();
    expect(cystMetadataSchema.parse(blob.metadata)).toEqual(item.checkpoint);
    expect(await decryptCheckpoint({ ...item.envelope, ciphertext: blob.ciphertext }, item.recoveryKey)).toEqual(plaintext);
  });

  it('enforces signed HTTP principals and prevents owner/outsider plan authority or raw owner-blob disclosure to agents', async () => {
    const item = await upload();
    expect((await get(base() + '/latest', '')).status).toBe(401);
    expect((await get(base() + '/latest', outsiderCookie)).status).toBe(403);
    expect((await get(base() + '/latest', ownerCookie)).status).toBe(200);
    for (const cookie of [ownerCookie, outsiderCookie]) {
      expect((await post(base() + '/commit-plan', { checkpointId: item.envelope.id }, cookie)).status).toBe(403);
      expect((await post(base() + '/retire-plan', { expectedRevision: '1' }, cookie)).status).toBe(403);
    }
    expect((await post(base() + '/verify', { checkpointId: item.envelope.id }, outsiderCookie)).status).toBe(403);
    expect((await get('/api/cysts/' + item.envelope.id + '/blob', agentCookie)).status).toBe(404);
    expect((await get(base(hash('unregistered agent')) + '/latest')).status).toBe(404);
    const queried = await get(base() + '/latest?owner=' + deployed.accounts.outsider.address);
    expect(queried.status).toBe(200);
    expect(cystRegistrySnapshotSchema.parse(await queried.json()).binding.owner).toBe(getAddress(deployed.accounts.owner.address));
  });

  it('refuses checkpoints labeled for a different agent or stored under a different owner', async () => {
    const wrongAgent = await upload({ agent: deployed.accounts.host.address, label: 'wrong-agent-upload' });
    expect((await post(base() + '/commit-plan', { checkpointId: wrongAgent.envelope.id })).status).toBe(404);
    expect((await post(base() + '/verify', { checkpointId: wrongAgent.envelope.id })).status).toBe(404);
    const wrongOwner = await upload({ owner: deployed.accounts.outsider.address, cookie: outsiderCookie, label: 'wrong-owner-upload' });
    expect((await post(base() + '/commit-plan', { checkpointId: wrongOwner.envelope.id })).status).toBe(404);
    const forged = await encryptCheckpoint(plaintext, { owner: deployed.accounts.outsider.address, agent: deployed.vault.account.address,
      applicationSchema: 'runtime-state.v1' });
    expect((await post('/api/cysts', forged.envelope, ownerCookie, 'forged-owner')).status).toBe(403);
    expect(cystRegistrySnapshotSchema.parse(await (await get(base() + '/latest')).json()).current.revision).toBe('0');
  });

  it.each(['absent', 'pending', 'missing', 'corrupt'] as const)('refuses a %s checkpoint before returning any commit transaction', async mode => {
    let checkpointId: string = hash('absent checkpoint');
    if (mode !== 'absent') {
      const item = await upload(); checkpointId = item.envelope.id;
      if (mode === 'pending') {
        if (!pilot) throw new Error('Runtime pilot missing');
        await pilot.service.db.update(cysts).set({ state: 'pending' }).where(and(eq(cysts.owner, item.envelope.owner), eq(cysts.id, item.envelope.id)));
      }
      if (mode === 'corrupt') {
        const bytes = await readFile(blobPath(item.envelope)); bytes[0] = (bytes[0] ?? 0) ^ 1;
        await writeFile(blobPath(item.envelope), bytes);
      } else await unlink(blobPath(item.envelope));
    }
    const response = await post(base() + '/commit-plan', { checkpointId });
    expect(response.status).toBe(mode === 'absent' ? 404 : mode === 'pending' ? 409 : 503);
    expect(await response.json()).not.toHaveProperty('transaction');
    expect(cystRegistrySnapshotSchema.parse(await (await get(base() + '/latest')).json()).current.revision).toBe('0');
  });

  it('binds concurrent unsigned plans to one exact revision and rejects stale CAS transactions on chain', async () => {
    const first = await upload({ label: 'race-first' }), second = await upload({ label: 'race-second' });
    const firstPlan = await prepared(first.envelope.id, 'race-plan-first'), stalePlan = await prepared(second.envelope.id, 'race-plan-second');
    expect(firstPlan.current.revision).toBe('0'); expect(stalePlan.current.revision).toBe('0');
    await submitted(firstPlan.transaction);
    await expect(submitted(stalePlan.transaction)).rejects.toThrow();
    expect((await verify(first.envelope.id)).matches).toBe(true); expect((await verify(second.envelope.id)).matches).toBe(false);
    const fresh = await prepared(second.envelope.id, 'race-plan-fresh'); expect(fresh.current.revision).toBe('1');
    await submitted(fresh.transaction);
    expect((await verify(second.envelope.id)).matches).toBe(true); expect((await verify(first.envelope.id)).matches).toBe(false);
  });

  it('retires the exact live revision, preserves its metadata, and recommits a new checked revision', async () => {
    const item = await upload(); await submitted((await prepared(item.envelope.id)).transaction);
    const committed = (await verify(item.envelope.id)).current;
    expect((await post(base() + '/retire-plan', { expectedRevision: '0' })).status).toBe(409);
    const planned = await post(base() + '/retire-plan', { expectedRevision: '1' }); expect(planned.status).toBe(200);
    const retire = cystRegistryRetirePreparedSchema.parse(await planned.json());
    // REASON: The shared prepared-plan schema validates even-length hexadecimal calldata.
    const retireData = retire.transaction.data as Hex;
    expect(decodeFunctionData({ abi: cystRegistryAbi, data: retireData })).toEqual({ functionName: 'retireChecked', args: [deployed.agentId, 1n] });
    await submitted(retire.transaction);
    expect((await verify(item.envelope.id)).current).toEqual({ ...committed, revision: '2', retired: true,
      block: (await verify(item.envelope.id)).current.block });
    expect((await verify(item.envelope.id)).matches).toBe(false);
    expect((await post(base() + '/retire-plan', { expectedRevision: '1' })).status).toBe(409);
    expect((await post(base() + '/retire-plan', { expectedRevision: '2' })).status).toBe(409);
    const recommit = await prepared(item.envelope.id, 'recommit-plan'); expect(recommit.current.revision).toBe('2');
    await submitted(recommit.transaction); expect(await verify(item.envelope.id)).toMatchObject({ matches: true, current: { revision: '3', retired: false } });
  });

  it('invalidates a previously verified checkpoint after a real Anvil branch revert', async () => {
    const item = await upload(), plan = await prepared(item.envelope.id), fork = await deployed.test.snapshot();
    await submitted(plan.transaction); const committed = await verify(item.envelope.id); expect(committed.matches).toBe(true);
    expect((await publishedBlob(item.envelope.id)).status).toBe(200);
    await deployed.test.revert({ id: fork }); await deployed.test.mine({ blocks: 1 });
    const reverted = await verify(item.envelope.id); expect(reverted.matches).toBe(false); expect(reverted.current.revision).toBe('0');
    expect(reverted.current.block.hash).not.toBe(committed.current.block.hash);
    expect((await publishedBlob(item.envelope.id)).status).toBe(409);
    await submitted(plan.transaction); expect((await verify(item.envelope.id)).matches).toBe(true);
  });

  it('restores only canonical published ciphertext through the real checked Node SDK and agent HTTP session', async () => {
    const item = await upload(), client = checkedClient();
    const unpublished = await publishedBlob(item.envelope.id); expect(unpublished.status).toBe(409);
    expect(await unpublished.json()).toMatchObject({ title: 'cyst_not_current' });
    await expect(client.download(deployed.agentId, item.checkpoint)).rejects.toThrow('current published live revision');
    const plan = await client.commitPlan(deployed.agentId, item.checkpoint, 'checked-sdk-commit');
    await submitted(plan.transaction);
    const response = await publishedBlob(item.envelope.id); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const published = cystRegistryDownloadSchema.parse(await response.json());
    expect(published.checkpoint).toEqual(item.checkpoint); expect(published.ciphertext).toBe(item.envelope.ciphertext);
    expect(published.current).toEqual((await verify(item.envelope.id)).current);
    expect((await publishedBlob(item.envelope.id, ownerCookie)).status).toBe(200);
    expect((await publishedBlob(item.envelope.id, outsiderCookie)).status).toBe(403);
    expect(await client.download(deployed.agentId, item.checkpoint)).toEqual(item.envelope);
    expect(await client.restore(deployed.agentId, item.checkpoint, item.recoveryKey)).toEqual(plaintext);
    await expect(client.restore(deployed.agentId, item.checkpoint, generateCystRecoveryKey())).rejects.toThrow('authentication failed');
    expect(await checkedClient(ownerCookie).restore(deployed.agentId, item.checkpoint, item.recoveryKey)).toEqual(plaintext);
    const responseText = JSON.stringify(published);
    expect(responseText).not.toContain(exportCystRecoveryKey(item.recoveryKey)); expect(responseText).not.toContain(new TextDecoder().decode(plaintext));
    await pilot?.close(); pilot = undefined; pilot = await startPilot(config);
    expect(await client.restore(deployed.agentId, item.checkpoint, item.recoveryKey)).toEqual(plaintext);
    const bytes = await readFile(blobPath(item.envelope)); bytes[0] = (bytes[0] ?? 0) ^ 1; await writeFile(blobPath(item.envelope), bytes);
    expect((await publishedBlob(item.envelope.id)).status).toBe(503);
    await expect(client.restore(deployed.agentId, item.checkpoint, item.recoveryKey)).rejects.toThrow('503');
  }, 30_000);

  it('denies canonical published blob access for label-only, replaced and retired checkpoints', async () => {
    const first = await upload({ label: 'published-first' }), second = await upload({ label: 'published-second' });
    const mislabeled = await upload({ label: 'published-wrong-agent', agent: deployed.accounts.host.address });
    expect((await publishedBlob(mislabeled.envelope.id)).status).toBe(404);
    await submitted((await prepared(first.envelope.id, 'published-first-plan')).transaction);
    expect((await publishedBlob(first.envelope.id)).status).toBe(200);
    expect((await publishedBlob(second.envelope.id)).status).toBe(409);
    await submitted((await prepared(second.envelope.id, 'published-second-plan')).transaction);
    expect((await publishedBlob(first.envelope.id)).status).toBe(409);
    expect((await publishedBlob(second.envelope.id)).status).toBe(200);
    await expect(checkedClient().download(deployed.agentId, first.checkpoint)).rejects.toThrow('current published live revision');
    const retired = await post(base() + '/retire-plan', { expectedRevision: '2' }); expect(retired.status).toBe(200);
    await submitted(cystRegistryRetirePreparedSchema.parse(await retired.json()).transaction);
    for (const cookie of [agentCookie, ownerCookie]) expect((await publishedBlob(second.envelope.id, cookie)).status).toBe(409);
    await expect(checkedClient().download(deployed.agentId, second.checkpoint)).rejects.toThrow('current published live revision');
    expect((await get('/api/cysts/' + second.envelope.id + '/blob', ownerCookie)).status).toBe(200);
  }, 30_000);

  it('waits for the reviewed confirmation depth and survives a controller restart without caching optimistic state', async () => {
    const item = await upload();
    await pilot?.close(); pilot = undefined; await reviewedPins({ ...deployed.pins, confirmations: 2 });
    pilot = await startPilot(config);
    const plan = await prepared(item.envelope.id); await submitted(plan.transaction);
    expect((await verify(item.envelope.id)).matches).toBe(false);
    await deployed.test.mine({ blocks: 2 });
    expect((await verify(item.envelope.id)).matches).toBe(true);
    const freshReader = new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: { ...deployed.pins, confirmations: 2 } });
    const snapshot = await freshReader.snapshot(deployed.agentId), head = await deployed.local.publicClient.getBlockNumber({ cacheTime: 0 });
    expect(BigInt(snapshot.current.block.number)).toBe(head - 2n);
    expect(snapshot.current.revision).toBe('1');
  });

  it('allows frozen and dormant preservation but enforces actual death before new plans and retains agent retirement rights', async () => {
    const item = await upload();
    await deployed.confirmed(deployed.vault.guardianWallet.writeContract({ address: deployed.vault.registryAddress,
      abi: deployed.artifact('PlatformSelectionRegistry').abi, functionName: 'setFrozen',
      args: [deployed.agentId, true, 'checkpoint preservation', hash('runtime freeze evidence')] }));
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.agent.vault,
      abi: deployed.artifact('PlatformAgentVault').abi, functionName: 'killLeash', args: [] }));
    const frozen = await prepared(item.envelope.id); expect(frozen.binding.frozen).toBe(true);
    await submitted(frozen.transaction);
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.agent.vault,
      abi: deployed.artifact('PlatformAgentVault').abi, functionName: 'ownerWithdraw', args: [1_000_000n] }));
    await deployed.test.setNextBlockTimestamp({ timestamp: (await deployed.local.publicClient.getBlock()).timestamp + 86_400n });
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.registryAddress,
      abi: deployed.artifact('PlatformSelectionRegistry').abi, functionName: 'declareDormant', args: [deployed.agentId] }));
    const dormant = await prepared(item.envelope.id, 'dormant-preservation'); expect(dormant.binding.status).toBe(2);
    await submitted(dormant.transaction);
    await deployed.test.setNextBlockTimestamp({ timestamp: (await deployed.local.publicClient.getBlock()).timestamp + 30n * 86_400n });
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.registryAddress,
      abi: deployed.artifact('PlatformSelectionRegistry').abi, functionName: 'declareDeath', args: [deployed.agentId] }));
    expect((await verify(item.envelope.id)).binding.status).toBe(3);
    const denied = await post(base() + '/commit-plan', { checkpointId: item.envelope.id });
    expect(denied.status).toBe(409); expect(await denied.json()).toMatchObject({ title: 'cyst_agent_dead' });
    expect((await post(base() + '/retire-plan', { expectedRevision: '2' }, ownerCookie)).status).toBe(403);
    const retire = await post(base() + '/retire-plan', { expectedRevision: '2' }); expect(retire.status).toBe(200);
    await submitted(cystRegistryRetirePreparedSchema.parse(await retire.json()).transaction);
    expect(await verify(item.envelope.id)).toMatchObject({ matches: false, binding: { status: 3 }, current: { revision: '3', retired: true } });
  });

  it.each(['registry', 'selection'] as const)('refuses %s code replacement before returning state, plans or verification', async target => {
    const item = await upload();
    await deployed.test.setCode({ address: target === 'registry' ? deployed.pins.registryAddress : deployed.pins.selectionRegistryAddress, bytecode: '0x60006000fd' });
    expect((await get(base() + '/latest')).status).toBe(503);
    for (const route of ['commit-plan', 'verify']) {
      const response = await post(base() + '/' + route, { checkpointId: item.envelope.id });
      expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty('transaction');
    }
  });

  it('rejects unreviewed chain/code pins and malformed startup config, releases its store and starts after correction', async () => {
    await pilot?.close(); pilot = undefined;
    for (const pins of [{ ...deployed.pins, chainId: 31338 }, { ...deployed.pins, registryCodeHash: hash('wrong code') },
      { ...deployed.pins, selectionRegistryCodeHash: hash('wrong selection code') }]) {
      await reviewedPins(pins); await expect(startPilot(config)).rejects.toThrow(); await assertPortReleased();
      const reopened = await openStore(config); await reopened.close();
    }
    await writeFile(pinsPath, '{invalid-json', { mode: 0o600 });
    await expect(startPilot(config)).rejects.toThrow(); await assertPortReleased();
    await reviewedPins(deployed.pins); pilot = await startPilot(config);
    expect((await get(base() + '/latest')).status).toBe(200);
    const disabled = { ...config, CYSTS_ENABLED: false };
    await pilot.close(); pilot = undefined;
    await expect(startPilot(disabled)).rejects.toThrow(); await assertPortReleased();
    pilot = await startPilot({ ...config, CYST_REGISTRY_CONFIG: undefined });
    expect((await get('/api/cyst-registry/config')).status).toBe(404);
    expect((await upload({ label: 'optional-registry-disabled' })).checkpoint.state).toBe('ready');
  }, 30_000);

  it('enforces actual main Origin and streamed body boundaries and releases its HTTP port on close', async () => {
    const item = await upload();
    expect((await post(base() + '/commit-plan', { checkpointId: item.envelope.id }, agentCookie, 'foreign-origin', 'https://untrusted.invalid')).status).toBe(403);
    expect((await post(base() + '/commit-plan', { checkpointId: item.envelope.id, unexpected: true })).status).toBe(422);
    const noKey = await fetch(config.PUBLIC_ORIGIN + base() + '/commit-plan', { method: 'POST',
      headers: { Origin: config.PUBLIC_ORIGIN, Cookie: agentCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpointId: item.envelope.id }) });
    expect(noKey.status).toBe(422);
    const malformedUtf8 = await fetch(config.PUBLIC_ORIGIN + base() + '/commit-plan', { method: 'POST',
      headers: { Origin: config.PUBLIC_ORIGIN, Cookie: agentCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-utf8' },
      body: new Uint8Array([0x7b, 0xff, 0x7d]) });
    expect(malformedUtf8.status).toBe(422); expect(await malformedUtf8.json()).not.toHaveProperty('transaction');
    const large = await post(base() + '/commit-plan', { checkpointId: item.envelope.id, padding: 'x'.repeat(8193) });
    expect(large.status).toBe(422); expect(await large.json()).toMatchObject({ title: 'cyst_registry_body_limit' });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
    const init = { method: 'POST', headers: { Origin: config.PUBLIC_ORIGIN, Cookie: agentCookie, 'Content-Type': 'application/json',
      'Idempotency-Key': 'unfinished-cyst-body' }, body, duplex: 'half' as const };
    if (!pilot) throw new Error('Runtime pilot missing');
    const stalled = await pilot.app.request(new Request(config.PUBLIC_ORIGIN + base() + '/commit-plan', init));
    expect(stalled.status).toBe(422); expect(await stalled.json()).toMatchObject({ title: 'cyst_registry_body_timeout' }); expect(cancelled).toBe(true);
    await pilot.close(); pilot = undefined; await assertPortReleased();
    const reopened = await openStore(config); await reopened.close();
  }, 30_000);
});
