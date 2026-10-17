import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, http, keccak256, parseEventLogs, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { compileContracts } from '../scripts/compile-contracts.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

const hash = (label: string) => keccak256(toHex(label));
const ZERO: Hex = `0x${'0'.repeat(64)}`;
const MAX_CYST_BYTES = 2_147_483_648n;
type Checkpoint = { cystHash: Hex; sizeBytes: bigint; storageRef: Hex; revision: bigint; committedAt: bigint; retired: boolean };
type AgentState = { agentWallet: Address; vault: Address; parent: Hex; cystHash: Hex; lastActivationAt: bigint;
  deathAt: bigint; status: number; frozen: boolean };

async function fixture() {
  const artifacts = compileContracts(['CystRegistry.sol', 'PlatformSelectionRegistry.sol', 'PlatformAgentVault.sol',
    'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
  artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
  const local = await deployPlatformRuntime(hash('cyst-registry-host'), artifacts);
  try {
    const vault = await deployPlatformVault(local), artifact = local.artifact('CystRegistry');
    const receipt = await local.confirmed(local.owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode,
      args: [vault.registryAddress] }));
    if (!receipt.contractAddress) throw new Error('Cyst registry fixture deployment missing');
    const cystRegistry = receipt.contractAddress;
    const read = async <T>(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<T> => {
      // REASON: The dynamically compiled real-contract ABI defines each fixture getter's output.
      return await local.local.publicClient.readContract({ address, abi: local.artifact(name).abi, functionName, args }) as T;
    };
    const controller = createWalletClient({ account: local.accounts.signer, chain: localChain, transport: http(local.local.rpcUrl, { retryCount: 0 }) });
    const outsider = createWalletClient({ account: local.accounts.outsider, chain: localChain, transport: http(local.local.rpcUrl, { retryCount: 0 }) });
    // REASON: The real Selection identityAgent getter returns bytes32.
    const agentId = vault.agentId as Hex;
    return { ...local, cystRegistry, registry: vault.registryAddress, vault: vault.agent.vault, agentId,
      agent: vault.wallet, agentAccount: vault.account, guardian: vault.guardianWallet, controller, outsider, read };
  } catch (error) { await local.close(); throw error; }
}

describe('CystRegistry real Selection identities and append-only checkpoint revisions', () => {
  let deployed: Awaited<ReturnType<typeof fixture>>, snapshot: Hex;
  type Actor = Awaited<ReturnType<typeof fixture>>['owner'];
  beforeAll(async () => { deployed = await fixture(); snapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => { await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot(); });
  afterAll(async () => { await deployed?.close(); });

  const latest = (agentId = deployed.agentId) => deployed.read<Checkpoint>(deployed.cystRegistry, 'CystRegistry', 'latest', [agentId]);
  const agentState = (agentId = deployed.agentId) => deployed.read<AgentState>(deployed.registry, 'PlatformSelectionRegistry', 'getAgent', [agentId]);
  function write(address: Address, name: string, functionName: string, args: readonly unknown[], actor: Actor = deployed.agent) {
    return deployed.confirmed(actor.writeContract({ address, abi: deployed.artifact(name).abi, functionName, args }));
  }
  function mutate(functionName: string, args: readonly unknown[], actor: Actor = deployed.agent) {
    return write(deployed.cystRegistry, 'CystRegistry', functionName, args, actor);
  }
  function simulate(functionName: string, args: readonly unknown[], caller: Address = deployed.agentAccount.address) {
    return deployed.local.publicClient.simulateContract({ address: deployed.cystRegistry, abi: deployed.artifact('CystRegistry').abi,
      account: caller, functionName, args });
  }
  async function commit(label = 'initial', size = 128n) {
    return mutate('commit', [deployed.agentId, hash(label), size, hash(`locator:${label}`)]);
  }
  async function dormant() {
    await write(deployed.vault, 'PlatformAgentVault', 'ownerWithdraw', [1_000_000n], deployed.owner);
    const state = await agentState();
    await deployed.test.setNextBlockTimestamp({ timestamp: state.lastActivationAt + 86_400n });
    await write(deployed.registry, 'PlatformSelectionRegistry', 'declareDormant', [deployed.agentId], deployed.outsider);
    expect((await agentState()).status).toBe(2);
  }

  it('pins the real registry and its Vault dependency and rejects missing or unrelated contracts', async () => {
    expect((await deployed.read<Address>(deployed.cystRegistry, 'CystRegistry', 'selectionRegistry')).toLowerCase()).toBe(deployed.registry.toLowerCase());
    expect(await deployed.read<bigint>(deployed.cystRegistry, 'CystRegistry', 'MAX_CYST_BYTES')).toBe(MAX_CYST_BYTES);
    for (const registry of [zeroAddress, deployed.accounts.owner.address, deployed.pins.tokenAddress, deployed.vault]) {
      const artifact = deployed.artifact('CystRegistry');
      await expect(deployed.confirmed(deployed.owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode,
        args: [registry] }))).rejects.toThrow();
    }
  });

  it('starts empty and commits actual agent-signed ciphertext metadata with timestamp and event history', async () => {
    const empty = { cystHash: ZERO, sizeBytes: 0n, storageRef: ZERO, revision: 0n, committedAt: 0n, retired: false };
    expect(await latest()).toEqual(empty); expect(await latest(hash('unknown agent'))).toEqual(empty);
    const receipt = await commit(), block = await deployed.local.publicClient.getBlock({ blockHash: receipt.blockHash });
    expect(await latest()).toEqual({ cystHash: hash('initial'), sizeBytes: 128n, storageRef: hash('locator:initial'),
      revision: 1n, committedAt: block.timestamp, retired: false });
    expect(parseEventLogs({ abi: deployed.artifact('CystRegistry').abi, logs: receipt.logs, eventName: 'CystCommitted' })).toMatchObject([
      { args: { agentId: deployed.agentId, cystHash: hash('initial'), sizeBytes: 128n, storageRef: hash('locator:initial'),
        revision: 1n, committedAt: block.timestamp, agentWallet: deployed.agentAccount.address } },
    ]);
    // The new registry records checkpoints independently; it cannot impersonate
    // the agent when mutating Selection's separate lineage/bootstrap hash.
    expect((await agentState()).cystHash).toBe(`0x${'1'.repeat(64)}`);
  });

  it('refuses owner, controller, guardian, outsider and Vault substitution for the actual agent key', async () => {
    await commit(); const original = await latest();
    const callers = [deployed.accounts.owner.address, deployed.accounts.signer.address, deployed.guardian.account.address,
      deployed.accounts.outsider.address, deployed.vault];
    for (const caller of callers) {
      for (const method of ['commit', 'commitChecked']) {
        const args = [deployed.agentId, hash('forged'), 10n, hash('forged locator')];
        if (method === 'commitChecked') args.push(1n);
        await expect(simulate(method, args, caller)).rejects.toThrow('Unauthorized');
      }
      await expect(simulate('retire', [deployed.agentId], caller)).rejects.toThrow('Unauthorized');
      await expect(simulate('retireChecked', [deployed.agentId, 1n], caller)).rejects.toThrow('Unauthorized');
    }
    expect(await latest()).toEqual(original);
  });

  it('rejects unknown identities and zero agentId without creating a checkpoint', async () => {
    for (const agentId of [ZERO, hash('unregistered')]) {
      await expect(simulate('commit', [agentId, hash('cyst'), 1n, hash('ref')])).rejects.toThrow('InvalidAgent');
      await expect(simulate('commitChecked', [agentId, hash('cyst'), 1n, hash('ref'), 0n])).rejects.toThrow('InvalidAgent');
      await expect(simulate('retire', [agentId])).rejects.toThrow('InvalidAgent');
      await expect(simulate('retireChecked', [agentId, 0n])).rejects.toThrow('InvalidAgent');
      expect((await latest(agentId)).revision).toBe(0n);
    }
  });

  it('enforces nonzero ciphertext hash and locator and inclusive ciphertext size bounds before any revision', async () => {
    const invalid = [
      [deployed.agentId, ZERO, 1n, hash('ref')],
      [deployed.agentId, hash('cyst'), 1n, ZERO],
      [deployed.agentId, hash('cyst'), 0n, hash('ref')],
      [deployed.agentId, hash('cyst'), MAX_CYST_BYTES + 1n, hash('ref')],
    ];
    for (const args of invalid) {
      await expect(simulate('commit', args)).rejects.toThrow('InvalidCyst');
      await expect(simulate('commitChecked', [...args, 0n])).rejects.toThrow('InvalidCyst');
    }
    expect((await latest()).revision).toBe(0n);
    await commit('one byte', 1n); expect((await latest()).sizeBytes).toBe(1n);
    await commit('maximum ciphertext', MAX_CYST_BYTES);
    expect(await latest()).toMatchObject({ sizeBytes: MAX_CYST_BYTES, revision: 2n, retired: false });
  });

  it('retains retired metadata, advances every successful revision, and allows recommit after retirement', async () => {
    await expect(simulate('retire', [deployed.agentId])).rejects.toThrow('NoLiveCyst');
    await commit('first'); const first = await latest();
    await commit('replacement'); const replacement = await latest();
    expect(replacement.revision).toBe(2n); expect(replacement.cystHash).not.toBe(first.cystHash);
    const receipt = await mutate('retire', [deployed.agentId]);
    expect(await latest()).toEqual({ ...replacement, revision: 3n, retired: true });
    expect(parseEventLogs({ abi: deployed.artifact('CystRegistry').abi, logs: receipt.logs, eventName: 'CystRetired' })).toMatchObject([
      { args: { agentId: deployed.agentId, cystHash: replacement.cystHash, revision: 3n, agentWallet: deployed.agentAccount.address } },
    ]);
    await expect(simulate('retire', [deployed.agentId])).rejects.toThrow('NoLiveCyst');
    await expect(simulate('retireChecked', [deployed.agentId, 3n])).rejects.toThrow('NoLiveCyst');
    expect((await latest()).revision).toBe(3n);
    await commit('recommitted'); expect(await latest()).toMatchObject({ cystHash: hash('recommitted'), revision: 4n, retired: false });
  });

  it('rejects stale checked plans against the exact shared revision, including commit and retire races', async () => {
    await expect(simulate('commitChecked', [deployed.agentId, hash('first'), 1n, hash('ref'), 1n])).rejects.toThrow('RevisionMismatch');
    await mutate('commitChecked', [deployed.agentId, hash('first'), 1n, hash('ref'), 0n]);
    await mutate('commitChecked', [deployed.agentId, hash('winner'), 2n, hash('winner ref'), 1n]);
    const winner = await latest();
    await expect(simulate('commitChecked', [deployed.agentId, hash('stale'), 3n, hash('stale ref'), 1n])).rejects.toThrow('RevisionMismatch');
    await expect(simulate('retireChecked', [deployed.agentId, 1n])).rejects.toThrow('RevisionMismatch');
    expect(await latest()).toEqual(winner);
    await mutate('retireChecked', [deployed.agentId, 2n]);
    expect(await latest()).toEqual({ ...winner, revision: 3n, retired: true });
    await expect(simulate('commitChecked', [deployed.agentId, hash('stale'), 3n, hash('stale ref'), 2n])).rejects.toThrow('RevisionMismatch');
    await commit('unchecked latest');
    await expect(simulate('retireChecked', [deployed.agentId, 3n])).rejects.toThrow('RevisionMismatch');
    await mutate('retireChecked', [deployed.agentId, 4n]);
    expect(await latest()).toMatchObject({ cystHash: hash('unchecked latest'), revision: 5n, retired: true });
  });

  it('isolates parent and child identities even when their human owner and bootstrap Cyst are shared', async () => {
    await commit('parent'); const parent = await latest();
    const identity = await deployed.read<Address>(deployed.registry, 'PlatformSelectionRegistry', 'identityRegistry');
    await write(identity, 'PlatformRuntimeIdentityFixture', 'register', [2n, deployed.accounts.owner.address], deployed.owner);
    const expiry = await deployed.read<{ expiry: bigint }>(deployed.pins.escrowAddress, 'PlatformRunEscrow', 'getLeash', [
      await deployed.read<Hex>(deployed.vault, 'PlatformAgentVault', 'leashId'),
    ]);
    await write(deployed.registry, 'PlatformSelectionRegistry', 'spawn', [deployed.agentId, 2n, deployed.accounts.host.address, 1000n, expiry.expiry], deployed.owner);
    const childId = await deployed.read<Hex>(deployed.registry, 'PlatformSelectionRegistry', 'identityAgent', [2n]);
    expect(await agentState(childId)).toMatchObject({ parent: deployed.agentId, agentWallet: deployed.accounts.host.address });
    expect((await latest(childId)).revision).toBe(0n);
    await expect(simulate('commit', [childId, hash('forged child'), 1n, hash('ref')])).rejects.toThrow('Unauthorized');
    await expect(simulate('retire', [deployed.agentId], deployed.accounts.host.address)).rejects.toThrow('Unauthorized');
    await mutate('commitChecked', [childId, hash('child'), 16n, hash('child locator'), 0n], deployed.host);
    expect(await latest()).toEqual(parent);
    await mutate('retireChecked', [childId, 1n], deployed.host);
    expect(await latest(childId)).toMatchObject({ cystHash: hash('child'), revision: 2n, retired: true });
    expect(await latest()).toEqual(parent);
  });

  it('preserves checkpoint rights for frozen agents and killed compute Leashes without granting owners a bypass', async () => {
    await commit('before freeze');
    await write(deployed.registry, 'PlatformSelectionRegistry', 'setFrozen', [deployed.agentId, true, 'preserve state', hash('evidence')], deployed.guardian);
    await write(deployed.vault, 'PlatformAgentVault', 'killLeash', [], deployed.owner);
    expect(await deployed.read<boolean>(deployed.registry, 'PlatformSelectionRegistry', 'canRun', [deployed.agentId])).toBe(false);
    await mutate('commitChecked', [deployed.agentId, hash('frozen checkpoint'), 64n, hash('frozen locator'), 1n]);
    const frozen = await latest();
    await expect(simulate('retireChecked', [deployed.agentId, 2n], deployed.accounts.owner.address)).rejects.toThrow('Unauthorized');
    await mutate('retireChecked', [deployed.agentId, 2n]);
    expect(await latest()).toEqual({ ...frozen, revision: 3n, retired: true });
  });

  it('allows dormant preservation and retirement while leaving the real Selection lifecycle dormant', async () => {
    await commit('alive'); await dormant();
    await mutate('commitChecked', [deployed.agentId, hash('dormant'), 32n, hash('dormant locator'), 1n]);
    expect((await agentState()).status).toBe(2);
    await mutate('retireChecked', [deployed.agentId, 2n]);
    expect(await latest()).toMatchObject({ cystHash: hash('dormant'), revision: 3n, retired: true });
    await commit('dormant recommit'); expect((await latest()).revision).toBe(4n); expect((await agentState()).status).toBe(2);
  });

  it('retains the final checkpoint after actual death, forbids new commits and allows only the agent to retire it', async () => {
    await commit('last checkpoint'); const last = await latest(); await dormant();
    await deployed.test.setNextBlockTimestamp({ timestamp: (await agentState()).deathAt });
    await write(deployed.registry, 'PlatformSelectionRegistry', 'declareDeath', [deployed.agentId], deployed.outsider);
    expect((await agentState()).status).toBe(3); expect(await latest()).toEqual(last);
    await expect(simulate('commit', [deployed.agentId, hash('after death'), 1n, hash('ref')])).rejects.toThrow('InvalidLifecycle');
    await expect(simulate('commitChecked', [deployed.agentId, hash('after death'), 1n, hash('ref'), 1n])).rejects.toThrow('InvalidLifecycle');
    for (const caller of [deployed.accounts.owner.address, deployed.accounts.signer.address]) {
      await expect(simulate('retire', [deployed.agentId], caller)).rejects.toThrow('Unauthorized');
    }
    await mutate('retireChecked', [deployed.agentId, 1n]);
    expect(await latest()).toEqual({ ...last, revision: 2n, retired: true });
    await expect(simulate('commit', [deployed.agentId, hash('revive'), 1n, hash('ref')])).rejects.toThrow('InvalidLifecycle');
    expect((await agentState()).status).toBe(3);
  });
});
