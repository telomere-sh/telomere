import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { compileContracts } from '../scripts/compile-contracts.js';
import { LargeCystPrivateStore, generateLargeCystId, restoreLargeCystFile,
  saveLargeCystFile, type LargeCystHeader, type LargeCystManifest,
  type LargeCystStore } from '../src/cysts/large-checkpoints.js';
import { LargeCystQuotaShadowStore } from '../src/cysts/large-quota-shadow.js';
import { LargeCystRegistryPlanner, largeCystRegistryDescriptor,
  largeCystRegistryMatches } from '../src/cysts/large-registry.js';
import { checkedLargeCystCommitPlan } from '../src/sdk/large-cyst-registry.js';
import { generateCystWrappingIdentity, wrapCystRecoveryKey } from '../src/sdk/cyst-key-wrap.js';
import { RpcCystRegistryReader } from '../src/cysts/registry-reader.js';
import { cystRegistryAbi, cystRegistryPinsSchema } from '../src/cysts/registry-types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const hash = (label: string) => keccak256(toHex(label));
const limits = { globalMaxBytes: 48 * 1024 * 1024, ownerMaxBytes: 24 * 1024 * 1024 };

class FaultDestination implements LargeCystStore {
  unavailable = false;
  constructor(readonly inner: LargeCystPrivateStore) {}
  initialize() { return this.inner.initialize(); }
  close() { return this.inner.close(); }
  begin(header: LargeCystHeader) { return this.inner.begin(header); }
  header(id: string) { return this.inner.header(id); }
  putPart(id: string, index: number, bytes: Uint8Array) { return this.inner.putPart(id, index, bytes); }
  part(id: string, index: number) {
    if (this.unavailable) throw new Error('Second storage destination unavailable');
    return this.inner.part(id, index);
  }
  commit(manifest: LargeCystManifest) { return this.inner.commit(manifest); }
  manifest(id: string) {
    if (this.unavailable) throw new Error('Second storage destination unavailable');
    return this.inner.manifest(id);
  }
}

async function fixture() {
  const artifacts = compileContracts(['CystRegistry.sol', 'PlatformSelectionRegistry.sol', 'PlatformAgentVault.sol',
    'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol',
    'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(hash('large-cyst-registry-host'), artifacts);
  try {
    const vault = await deployPlatformVault(local), artifact = local.artifact('CystRegistry');
    const receipt = await local.confirmed(local.owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode,
      args: [vault.registryAddress] }));
    if (!receipt.contractAddress) throw new Error('CystRegistry deployment missing');
    const code = await local.local.publicClient.getCode({ address: receipt.contractAddress });
    if (!code) throw new Error('CystRegistry code missing');
    const pins = cystRegistryPinsSchema.parse({ chainId: 31337, registryAddress: receipt.contractAddress,
      registryCodeHash: keccak256(code), selectionRegistryAddress: vault.registryAddress,
      selectionRegistryCodeHash: vault.pins.registryCodeHash, confirmations: 0 });
    return { ...local, vault, pins, agentId: vault.agentId as Hex };
  } catch (error) { await local.close(); throw error; }
}

describe('large encrypted Cyst → original Selection CystRegistry unsigned publication', () => {
  let deployed: Awaited<ReturnType<typeof fixture>>, chainSnapshot: Hex;
  let root: string, store: LargeCystQuotaShadowStore, second: FaultDestination;
  let source: string, id: string, recoveryKey: Uint8Array;
  beforeAll(async () => { deployed = await fixture(); chainSnapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: chainSnapshot }); chainSnapshot = await deployed.test.snapshot();
    root = await mkdtemp(join(tmpdir(), 'telomere-large-registry-'));
    const paths = ['shadow', 'remote-a', 'remote-b'].map(name => join(root, name));
    await Promise.all(paths.map(path => mkdir(path, { mode: 0o700 })));
    second = new FaultDestination(new LargeCystPrivateStore(paths[2]!, limits));
    store = new LargeCystQuotaShadowStore(new LargeCystPrivateStore(paths[0]!, limits),
      [new LargeCystPrivateStore(paths[1]!, limits), second]);
    await store.initialize();
    source = join(root, 'source.tar.zst'); id = generateLargeCystId(); recoveryKey = randomBytes(32);
  });
  afterEach(async () => {
    recoveryKey?.fill(0); await store?.close();
    if (root) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-large-registry-')) {
        throw new Error('Unexpected owned test directory');
      }
      await rm(target, { recursive: true, force: true });
    }
  });
  afterAll(async () => { await deployed?.close(); });

  const scope = () => ({ owner: deployed.accounts.owner.address, agent: deployed.vault.account.address,
    applicationSchema: 'overlay.tar.zst/v1' });
  const planner = () => new LargeCystRegistryPlanner(store,
    new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }));
  function duringDurability(action: () => Promise<unknown>) {
    return {
      begin: (value: LargeCystHeader) => store.begin(value),
      header: (value: string) => store.header(value),
      putPart: (value: string, index: number, bytes: Uint8Array) => store.putPart(value, index, bytes),
      part: (value: string, index: number) => store.part(value, index),
      commit: (value: LargeCystManifest) => store.commit(value),
      manifest: (value: string) => store.manifest(value),
      isDurable: async (value: string) => {
        await action();
        return store.isDurable(value);
      },
    };
  }
  async function upload(bytes = randomBytes(320_000), labels = scope()) {
    await writeFile(source, bytes);
    await saveLargeCystFile({ store, sourcePath: source, id, scope: labels, recoveryKey });
    return bytes;
  }
  async function submit(data: string) {
    return deployed.confirmed(deployed.vault.wallet.sendTransaction({ to: deployed.pins.registryAddress,
      data: data as Hex, value: 0n }));
  }

  it('binds dual-durable encrypted parts to an agent-signed CAS plan and independently verifies the canonical result', async () => {
    const plaintext = await upload();
    const agent = deployed.vault.account.address, owner = deployed.accounts.owner.address;
    const beforeNonce = await deployed.local.publicClient.getTransactionCount({ address: agent });
    const plan = await planner().commitPlan(agent, deployed.agentId, id);
    const checkedPlan = await checkedLargeCystCommitPlan({ plan, agentWallet: agent,
      agentId: deployed.agentId, checkpointId: id, recoveryKey, manifestStore: store,
      reader: new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }) });
    expect(checkedPlan).toEqual(plan.transaction);
    await expect(checkedLargeCystCommitPlan({ plan: { ...plan,
      transaction: { ...plan.transaction, data: '0x1234' } }, agentWallet: agent,
      agentId: deployed.agentId, checkpointId: id, recoveryKey, manifestStore: store,
      reader: new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }) }))
      .rejects.toThrow('Publication calldata differs');
    expect(await deployed.local.publicClient.getTransactionCount({ address: agent })).toBe(beforeNonce);
    expect(plan.binding).toMatchObject({ agentId: deployed.agentId, owner, agentWallet: agent });
    expect(plan.checkpoint).toEqual(largeCystRegistryDescriptor(await store.manifest(id)));
    expect(plan.checkpoint.sizeBytes).toBeGreaterThan(plaintext.length);
    expect(decodeFunctionData({ abi: cystRegistryAbi, data: plan.transaction.data as Hex }))
      .toEqual({ functionName: 'commitChecked', args: [deployed.agentId, plan.checkpoint.cystHash,
        BigInt(plan.checkpoint.sizeBytes), plan.checkpoint.storageRef, 0n] });
    expect(JSON.stringify(plan)).not.toContain(Buffer.from(recoveryKey).toString('hex'));
    expect((await planner().verify(owner, deployed.agentId, id)).matches).toBe(false);
    const fork = await deployed.test.snapshot();
    await submit(plan.transaction.data);
    const verified = await planner().verify(owner, deployed.agentId, id);
    expect(verified.matches).toBe(true);
    expect(largeCystRegistryMatches(verified.current, plan.checkpoint)).toBe(true);
    const destination = join(root, 'restored.tar.zst');
    await restoreLargeCystFile({ store, id, destinationPath: destination, scope: scope(), recoveryKey });
    expect(await readFile(destination)).toEqual(plaintext);
    await deployed.test.revert({ id: fork });
    expect((await planner().verify(agent, deployed.agentId, id)).matches).toBe(false);
  }, 90_000);

  it('refuses to return agent-signed calldata when the agent wrap contains a different key', async () => {
    const ownerIdentity = await generateCystWrappingIdentity();
    const agentIdentity = await generateCystWrappingIdentity();
    const recipientScope = { owner: scope().owner, agent: scope().agent, checkpointId: id };
    const recipients = { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey };
    const correct = await wrapCystRecoveryKey(recoveryKey, recipientScope, recipients);
    const wrongKey = randomBytes(32);
    try {
      const wrong = await wrapCystRecoveryKey(wrongKey, recipientScope, recipients);
      const mixed = { ...correct, wrappings: [correct.wrappings[0]!, wrong.wrappings[1]!] };
      await writeFile(source, randomBytes(100_000));
      await saveLargeCystFile({ store, sourcePath: source, id, scope: scope(), recoveryKey,
        wrappedKey: { bundle: mixed, ownerIdentity, agentPublicKey: agentIdentity.publicKey } });
      const plan = await planner().commitPlan(deployed.vault.account.address, deployed.agentId, id);
      const options = { plan, agentWallet: deployed.vault.account.address, agentId: deployed.agentId,
        checkpointId: id, recoveryKey, manifestStore: store,
        reader: new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }) };
      const beforeNonce = await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address });
      await expect(checkedLargeCystCommitPlan(options)).rejects.toThrow('agent wrapping identity is required');
      await expect(checkedLargeCystCommitPlan({ ...options, agentIdentity }))
        .rejects.toThrow('agent wrap differs');
      expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.vault.account.address })).toBe(beforeNonce);
    } finally { wrongKey.fill(0); }
  }, 90_000);

  it('refuses incomplete, foreign, degraded and changed-revision material without issuing a usable plan', async () => {
    const publisher = planner(), agent = deployed.vault.account.address;
    await expect(publisher.commitPlan(agent, deployed.agentId, id)).rejects.toMatchObject({ code: 'cyst_pending' });
    await upload(randomBytes(240_000), { ...scope(), agent: deployed.accounts.outsider.address });
    await expect(publisher.commitPlan(agent, deployed.agentId, id)).rejects.toMatchObject({ code: 'cyst_not_found' });
    // A second file uses the correct immutable owner/agent labels.
    id = generateLargeCystId(); await upload();
    await expect(publisher.commitPlan(deployed.accounts.owner.address, deployed.agentId, id))
      .rejects.toMatchObject({ code: 'cyst_agent_forbidden' });
    const original = await publisher.commitPlan(agent, deployed.agentId, id);
    second.unavailable = true;
    await expect(publisher.commitPlan(agent, deployed.agentId, id)).rejects.toMatchObject({ code: 'cyst_not_durable' });
    second.unavailable = false;
    await deployed.confirmed(deployed.vault.wallet.sendTransaction({ to: deployed.pins.registryAddress,
      data: original.transaction.data as Hex, value: 0n }));
    const fresh = await publisher.commitPlan(agent, deployed.agentId, id);
    expect(fresh.current.revision).toBe('1');
    await expect(submit(original.transaction.data)).rejects.toThrow();
    expect((await publisher.verify(agent, deployed.agentId, id)).matches).toBe(true);
  }, 90_000);

  it('accepts a new canonical block during a dual-copy audit when the registered state is unchanged', async () => {
    await upload();
    const reader = new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins });
    const before = await reader.snapshot(deployed.agentId);
    const advancing = new LargeCystRegistryPlanner(duringDurability(() => deployed.test.mine({ blocks: 1 })), reader);
    const plan = await advancing.commitPlan(deployed.vault.account.address, deployed.agentId, id);
    expect(BigInt(plan.current.block.number)).toBeGreaterThan(BigInt(before.current.block.number));
    expect(plan.current.revision).toBe(before.current.revision);
    expect(plan.checkpoint).toEqual(largeCystRegistryDescriptor(await store.manifest(id)));
    expect(decodeFunctionData({ abi: cystRegistryAbi, data: plan.transaction.data as Hex }))
      .toMatchObject({ functionName: 'commitChecked', args: [deployed.agentId, plan.checkpoint.cystHash,
        BigInt(plan.checkpoint.sizeBytes), plan.checkpoint.storageRef, 0n] });
  }, 90_000);

  it('rejects a damaged immutable copy and a canonical revision changed during the durability audit', async () => {
    await upload();
    const agent = deployed.vault.account.address;
    const original = await planner().commitPlan(agent, deployed.agentId, id);
    const damaged = join(root, 'remote-b', id.slice(2), 'part-000000.bin');
    const file = await open(damaged, 'r+');
    try { await file.write(Buffer.from([0xff]), 0, 1, 40); } finally { await file.close(); }
    await expect(planner().commitPlan(agent, deployed.agentId, id))
      .rejects.toMatchObject({ code: 'cyst_not_durable' });

    // The independent durability audit below deliberately changes the original
    // CystRegistry revision after the planner's first canonical snapshot.
    id = generateLargeCystId(); await upload();
    const guarded = new LargeCystRegistryPlanner(duringDurability(() => submit(original.transaction.data)),
      new RpcCystRegistryReader({ rpcUrl: deployed.local.rpcUrl, pins: deployed.pins }));
    await expect(guarded.commitPlan(agent, deployed.agentId, id))
      .rejects.toMatchObject({ code: 'cyst_revision_changed' });
  }, 90_000);
});
