import solc from 'solc';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, decodeEventLog, encodeAbiParameters, getContractAddress, hashTypedData, http, keccak256, maxUint256,
  parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { localChain } from '../src/chain/chains.js';
import { platformQuoteTypes } from '../src/platform-runtime/types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

type Account = ReturnType<typeof privateKeyToAccount>;
type Scope = { classMask: bigint; sealedOnly: boolean; imageAllowRoot: Hex; regionAllowRoot: Hex };
type Entry = { identityId: bigint; agentWallet: Address; maxPerHour: bigint; maxPerDay: bigint;
  expiry: bigint; cystHash: Hex; endowment: bigint; scope: Scope };
type Agent = { owner: Address; agentWallet: Address; vault: Address; leashId: Hex; parent: Hex; family: Hex; cystHash: Hex;
  status: number; frozen: boolean; livingChildren: number; lastPaidRun: bigint; lastActivationAt: bigint;
  dormantAt: bigint; deathAt: bigint; lifetimeBurn: bigint; lifetimeIncome: bigint; lifetimeIncomeFees: bigint; lifetimeSubsidy: bigint };
type Quote = { runId: Hex; leashId: Hex; hostId: Hex; payer: Address; hwClass: number; regionHash: Hex; imageHash: Hex;
  workloadHash: Hex; maxSeconds: bigint; pricePerSecond: bigint; inferencePrice: bigint; quoteExpiry: bigint };
type Settlement = { runId: Hex; billableSeconds: bigint; endedAt: bigint; inferenceCharge: bigint; receiptHash: Hex };
type Leash = Scope & { owner: Address; agent: Address; expiry: bigint; maxPerHour: bigint; maxPerDay: bigint;
  pending: bigint; spentHour: bigint; spentDay: bigint; killed: boolean; killedAt: bigint };
type Run = { openedAt: bigint; ceiling: bigint; billableSeconds: bigint; inferenceCharge: bigint; status: number;
  sealedHost: boolean; acceptedExpiry: bigint; stopAt: bigint; hostReleased: boolean };
const id = (label: string): Hex => keccak256(toHex(label));
const allowLeaf = (value: Hex) => keccak256(keccak256(encodeAbiParameters([{ type: 'bytes32' }], [value])));
const pair = (a: Hex, b: Hex): Hex => keccak256(`0x${[a, b].sort().map(item => item.slice(2)).join('')}`);

function identityFixture(): ContractArtifact {
  const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
// Disposable ownerOf adapter; not the ERC8004 reference implementation.
contract LocalPlatformIdentity {
    mapping(uint256 => address) private owners;
    constructor() { require(block.chainid == 31337, "local fixture only"); }
    function register(uint256 identity, address owner) external {
        require(owner != address(0) && owners[identity] == address(0), "fixture identity"); owners[identity] = owner;
    }
    function ownerOf(uint256 identity) external view returns(address) {
        require(owners[identity] != address(0), "fixture missing identity"); return owners[identity];
    }
}`;
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'LocalPlatformIdentity.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }))) as {
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
    errors?: { severity: string; formattedMessage: string }[] };
  const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const value = output.contracts['LocalPlatformIdentity.sol']!['LocalPlatformIdentity']!;
  return { contractName: 'LocalPlatformIdentity', compiler: solc.version(), abi: value.abi,
    bytecode: `0x${value.evm.bytecode.object}`, deployedBytecode: `0x${value.evm.deployedBytecode.object}` };
}

describe('Platform Selection vaults wired to bonded hosts and full receipt Merkle settlement', () => {
  let deployed: Awaited<ReturnType<typeof deployPlatformRuntime>>, snapshot: Hex;
  let controller: Account, guardian: Account, treasury: Account, agentKey: Account, sealedHost: Account, childKey: Account;
  let identity: Address, staking: Address, utility: Address, registry: Address, sealedId: Hex;
  const fee = 1_000_000n, floor = 1_000_000n, endowment = 50_000_000n;
  const managedCap = 2_500_000_000n;
  const image = id('platform-agent-image'), region = id('platform-agent-region');
  const imageSibling = allowLeaf(id('second-approved-image')), regionSibling = allowLeaf(id('second-approved-region'));
  const scope: Scope = { classMask: 3n, sealedOnly: false, imageAllowRoot: pair(allowLeaf(image), imageSibling),
    regionAllowRoot: pair(allowLeaf(region), regionSibling) };
  const wallet = (account: Account) => createWalletClient({ account, chain: localChain, transport: http(deployed.local.rpcUrl, { retryCount: 0 }) });
  const artifact = (name: string) => deployed.artifact(name);
  const owner = () => deployed.accounts.owner;
  const outsider = () => deployed.accounts.outsider;
  const escrow = () => deployed.pins.escrowAddress;
  const token = () => deployed.pins.tokenAddress;
  async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
    const value = artifact(name), receipt = await deployed.confirmed(wallet(owner()).deployContract({ abi: value.abi, bytecode: value.bytecode, args }));
    if (!receipt.contractAddress) throw new Error('Missing local deployment'); return receipt.contractAddress;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = owner()) {
    return deployed.confirmed(wallet(account).writeContract({ address, abi: artifact(name).abi, functionName, args }));
  }
  async function read<T>(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return await deployed.local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args }) as T;
  }
  const balance = (address: Address) => read<bigint>(token(), 'MockToken', 'balanceOf', [address]);
  const available = (vault: Address) => read<bigint>(escrow(), 'PlatformRunEscrow', 'availableBalance', [vault]);
  const now = async () => (await deployed.local.publicClient.getBlock()).timestamp;
  async function advance(seconds: number) { await deployed.test.increaseTime({ seconds }); await deployed.test.mine({ blocks: 1 }); }
  const getAgent = (agentId: Hex) => read<Agent>(registry, 'PlatformSelectionRegistry', 'getAgent', [agentId]);
  async function futureVault(identityId: bigint): Promise<Address> {
    const implementation = await read<Address>(registry, 'PlatformSelectionRegistry', 'vaultImplementation');
    const salt = keccak256(encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [31337n, registry, identity, identityId]));
    const bytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
    return getContractAddress({ opcode: 'CREATE2', from: registry, salt, bytecode });
  }
  async function terms(overrides: Partial<Entry> = {}): Promise<Entry> {
    return { identityId: 1n, agentWallet: agentKey.address, maxPerHour: 20_000_000n, maxPerDay: 200_000_000n,
      expiry: await now() + 365n * 86_400n, cystHash: id('platform-parent-cyst'), endowment, scope, ...overrides };
  }
  async function enter(overrides: Partial<Entry> = {}) {
    await write(registry, 'PlatformSelectionRegistry', 'enter', [await terms(overrides)]);
    const agentId = await read<Hex>(registry, 'PlatformSelectionRegistry', 'identityAgent', [overrides.identityId ?? 1n]);
    return { agentId, ...(await getAgent(agentId)) };
  }
  async function quote(agent: { vault: Address; leashId: Hex }, overrides: Partial<Quote> = {}): Promise<Quote> {
    return { runId: id(`platform-vault-run-${Math.random()}`), leashId: agent.leashId, hostId: deployed.hostId, payer: agent.vault,
      hwClass: 0, regionHash: region, imageHash: image, workloadHash: id('platform-agent-workload'), maxSeconds: 10n,
      pricePerSecond: 100_000n, inferencePrice: 0n, quoteExpiry: await now() + 300n, ...overrides };
  }
  const typed = (q: Quote) => ({ domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: 31337, verifyingContract: escrow() },
    types: platformQuoteTypes, primaryType: 'PlatformQuote' as const, message: q });
  const sign = (q: Quote) => deployed.accounts.signer.signTypedData(typed(q));
  async function open(vault: Address, q: Quote, account = agentKey, imageProof: Hex[] = [imageSibling], regionProof: Hex[] = [regionSibling]) {
    return write(vault, 'PlatformAgentVault', 'payRun', [q, await sign(q), imageProof, regionProof], account);
  }
  async function settlement(q: Quote, seconds = 3n, inference = 0n): Promise<Settlement> {
    return { runId: q.runId, billableSeconds: seconds, endedAt: await now(), inferenceCharge: inference, receiptHash: id(`paid-${q.runId}`) };
  }
  async function publish(s: Settlement) {
    const leaf = await read<Hex>(escrow(), 'PlatformRunEscrow', 'receiptLeaf', [s]);
    const sibling = id('another-independent-platform-receipt'), hour = s.endedAt / 3600n;
    if (await now() < (hour + 1n) * 3600n) { await deployed.test.setNextBlockTimestamp({ timestamp: (hour + 1n) * 3600n }); await deployed.test.mine({ blocks: 1 }); }
    await write(deployed.pins.receiptRootAddress, 'ReceiptRoot', 'postRoot', [hour, pair(leaf, sibling), 2], deployed.accounts.signer);
    return { hour, proof: [sibling] };
  }
  async function settle(q: Quote, seconds = 3n, inference = 0n) {
    const s = await settlement(q, seconds, inference), proof = await publish(s);
    await write(escrow(), 'PlatformRunEscrow', 'settleRun', [s, proof.hour, proof.proof], outsider()); return s;
  }
  const sync = (vault: Address, runId: Hex) => write(vault, 'PlatformAgentVault', 'syncRun', [runId], outsider());
  async function backing() {
    expect(await balance(escrow())).toBe(await read<bigint>(escrow(), 'PlatformRunEscrow', 'totalAvailable')
      + await read<bigint>(escrow(), 'PlatformRunEscrow', 'totalReserved'));
    expect(await balance(deployed.pins.feeRouterAddress)).toBe(await read<bigint>(deployed.pins.feeRouterAddress, 'FeeRouter', 'accountedBalance'));
  }
  beforeAll(async () => {
    const artifacts = compileContracts(); artifacts.LocalPlatformIdentity = identityFixture();
    deployed = await deployPlatformRuntime(id('platform-vault-cpu-host'), artifacts);
    [controller, guardian, treasury, agentKey, sealedHost, childKey] = Array.from({ length: 6 }, () => privateKeyToAccount(generatePrivateKey())) as
      [Account, Account, Account, Account, Account, Account];
    for (const account of [controller, guardian, treasury, agentKey, sealedHost, childKey]) await deployed.test.setBalance({ address: account.address, value: parseEther('10') });
    identity = await deploy('LocalPlatformIdentity'); utility = await deploy('TlmrToken', [owner().address, parseEther('1000000')]);
    staking = await deploy('TlmrStaking', [utility]);
    registry = await deploy('PlatformSelectionRegistry', [{ token: token(), escrow: escrow(), controller: controller.address,
      guardian: guardian.address, identityRegistry: identity, staking, treasury: treasury.address, entryFee: fee, vaultFloor: floor }]);
    for (const identityId of [1n, 2n, 3n, 4n, 5n]) await write(identity, 'LocalPlatformIdentity', 'register', [identityId, owner().address]);
    for (const account of [owner(), outsider()]) await write(token(), 'MockToken', 'faucet', [account.address, 1_000_000_000n]);
    await write(token(), 'MockToken', 'approve', [registry, maxUint256]);
    await write(token(), 'MockToken', 'faucet', [sealedHost.address, 1_500_000_000n]);
    await write(token(), 'MockToken', 'approve', [deployed.pins.hostRegistryAddress, maxUint256], sealedHost);
    await write(deployed.pins.hostRegistryAddress, 'HostRegistry', 'register', [id('platform-vault-sealed-host'), 2, id('sealed-measurement'), 1_500_000_000n, true], sealedHost);
    sealedId = await read<Hex>(deployed.pins.hostRegistryAddress, 'HostRegistry', 'operatorHost', [sealedHost.address]);
    snapshot = await deployed.test.snapshot();
  }, 90_000);
  beforeEach(async () => { await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot(); });
  afterAll(async () => { await deployed?.close(); });

  it('deploys bounded immutable factory/clones and exposes exact Vault-to-human authorization mappings', async () => {
    const agent = await enter(), leash = await read<Leash>(escrow(), 'PlatformRunEscrow', 'getLeash', [agent.leashId]);
    for (const name of ['PlatformAgentVault', 'PlatformSelectionRegistry']) expect((artifact(name).deployedBytecode.length - 2) / 2).toBeLessThanOrEqual(24_576);
    expect(await read(registry, 'PlatformSelectionRegistry', 'vaultAgent', [agent.vault])).toBe(agent.agentId);
    expect(agent.owner.toLowerCase()).toBe(owner().address.toLowerCase());
    expect((await read<Address>(agent.vault, 'PlatformAgentVault', 'owner')).toLowerCase()).toBe(owner().address.toLowerCase());
    expect((await read<Address>(agent.vault, 'PlatformAgentVault', 'escrow')).toLowerCase()).toBe(escrow().toLowerCase());
    expect((await read<Address>(agent.vault, 'PlatformAgentVault', 'registry')).toLowerCase()).toBe(registry.toLowerCase());
    expect(leash.owner.toLowerCase()).toBe(agent.vault.toLowerCase()); expect(leash.agent.toLowerCase()).toBe(agent.vault.toLowerCase());
    expect(leash.classMask).toBe(3n); expect(leash.imageAllowRoot).toBe(scope.imageAllowRoot); expect(leash.regionAllowRoot).toBe(scope.regionAllowRoot);
    const impl = await read<Address>(registry, 'PlatformSelectionRegistry', 'vaultImplementation');
    await expect(write(impl, 'PlatformAgentVault', 'initialize', [owner().address, agentKey.address, id('fake'), id('fake-leash'), 1n, 2n, await now() + 1n, scope])).rejects.toThrow();
    expect(await balance(agent.vault)).toBe(endowment); expect(await balance(treasury.address)).toBe(fee);
  });
  it('accepts an exact 2,500-token entry endowment and rolls back one base unit more', async () => {
    await write(token(), 'MockToken', 'faucet', [owner().address, managedCap + fee]);
    await expect(enter({ endowment: managedCap + 1n })).rejects.toThrow();
    expect(await read<bigint>(registry, 'PlatformSelectionRegistry', 'totalBirths')).toBe(0n);
    const agent = await enter({ endowment: managedCap });
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'MAX_MANAGED_EXPOSURE')).toBe(managedCap);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
    expect(await balance(agent.vault)).toBe(managedCap);
  });
  it('allows zero-endowment entry and owner recovery after a future clone address was pre-funded above the cap', async () => {
    const predicted = await futureVault(1n);
    await write(token(), 'MockToken', 'faucet', [owner().address, managedCap + 1n]);
    await write(token(), 'MockToken', 'transfer', [predicted, managedCap + 1n]);
    const agent = await enter({ endowment: 0n });
    expect(agent.vault.toLowerCase()).toBe(predicted.toLowerCase());
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap + 1n);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [managedCap + 1n]);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(0n);
  });
  it('rolls back a pre-funded child birth above the cap and accepts its exact boundary', async () => {
    const parent = await enter(), predicted = await futureVault(2n), firstEndowment = 5_000_000n;
    await write(token(), 'MockToken', 'faucet', [owner().address, managedCap]);
    await write(token(), 'MockToken', 'transfer', [predicted, managedCap - firstEndowment + 1n]);
    const expiry = await now() + 300n * 86_400n;
    await expect(write(registry, 'PlatformSelectionRegistry', 'spawn', [parent.agentId, 2n,
      childKey.address, firstEndowment, expiry], controller)).rejects.toThrow();
    expect(await read<bigint>(registry, 'PlatformSelectionRegistry', 'totalBirths')).toBe(1n);
    expect(await balance(parent.vault)).toBe(endowment);
    await write(registry, 'PlatformSelectionRegistry', 'spawn', [parent.agentId, 2n,
      childKey.address, firstEndowment - 1n, expiry], controller);
    const childId = await read<Hex>(registry, 'PlatformSelectionRegistry', 'identityAgent', [2n]);
    const child = await getAgent(childId);
    expect(child.vault.toLowerCase()).toBe(predicted.toLowerCase());
    expect(await read<bigint>(child.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
  });
  it('includes pending run ceilings in managed exposure and keeps refunds owner-withdrawable', async () => {
    await write(token(), 'MockToken', 'faucet', [owner().address, managedCap]);
    const agent = await enter({ endowment: managedCap - 99n });
    await write(token(), 'MockToken', 'approve', [agent.vault, 102n], outsider());
    await write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [100n, id('cap-income')], outsider());
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 100n, lifetimeIncomeFees: 1n });
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [2n, id('cap-excess')], outsider())).rejects.toThrow();
    expect(await getAgent(agent.agentId)).toMatchObject({ lifetimeIncome: 100n, lifetimeIncomeFees: 1n });
    const q = await quote(agent); await open(agent.vault, q);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'spendableBalance')).toBe(managedCap - 1_090_000n);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [2n, id('cap-pending')], outsider())).rejects.toThrow();
    const due = await read<bigint>(escrow(), 'PlatformRunEscrow', 'refundAt', [q.runId]);
    await deployed.test.setNextBlockTimestamp({ timestamp: due }); await deployed.test.mine({ blocks: 1 });
    await write(escrow(), 'PlatformRunEscrow', 'refundRun', [q.runId], outsider());
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
    await sync(agent.vault, q.runId);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [managedCap]);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(0n);
    await backing();
  });
  it('releases only the proven settlement charge and allows exact owner subsidy before run sync', async () => {
    await write(token(), 'MockToken', 'faucet', [owner().address, managedCap]);
    const agent = await enter({ endowment: managedCap }), q = await quote(agent);
    await open(agent.vault, q); await advance(4); await settle(q);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap - 327_000n);
    await write(token(), 'MockToken', 'approve', [agent.vault, 327_001n]);
    await write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [327_000n, id('exact-subsidy')]);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [1n, id('excess-subsidy')])).rejects.toThrow();
    await sync(agent.vault, q.runId);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
    await backing();
  });
  it('observes direct donations above the cap, blocks managed work and child funding, and permits owner recovery', async () => {
    await write(token(), 'MockToken', 'faucet', [owner().address, managedCap]);
    const agent = await enter({ endowment: managedCap });
    await write(token(), 'MockToken', 'transfer', [agent.vault, 1n]);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap + 1n);
    await write(token(), 'MockToken', 'approve', [agent.vault, 1n]);
    await expect(write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [1n, id('over-cap')])).rejects.toThrow();
    await expect(open(agent.vault, await quote(agent))).rejects.toThrow();
    await expect(write(registry, 'PlatformSelectionRegistry', 'spawn', [agent.agentId, 2n,
      childKey.address, 5_000_000n, await now() + 300n * 86_400n], controller)).rejects.toThrow();
    expect(await read<bigint>(registry, 'PlatformSelectionRegistry', 'totalBirths')).toBe(1n);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [1n]);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
    await open(agent.vault, await quote(agent));
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'managedExposure')).toBe(managedCap);
  });
  it('executes deposit→scoped Leash→host hook→nonempty full Merkle proof→fees→Vault burn and owner withdrawal', async () => {
    const agent = await enter(), q = await quote(agent); expect(await read(escrow(), 'PlatformRunEscrow', 'quoteDigest', [q])).toBe(hashTypedData(typed(q)));
    await open(agent.vault, q); const run = await read<Run>(escrow(), 'PlatformRunEscrow', 'getRun', [q.runId]);
    expect(run.ceiling).toBe(1_090_000n); expect(await available(agent.vault)).toBe(0n); expect(await balance(agent.vault)).toBe(endowment - run.ceiling);
    expect((await read<{ openRuns: bigint }>(deployed.pins.hostRegistryAddress, 'HostRegistry', 'getHost', [deployed.hostId])).openRuns).toBe(1n);
    await advance(5); const s = await settlement(q);
    await expect(write(escrow(), 'PlatformRunEscrow', 'settleRun', [s, s.endedAt / 3600n, []], outsider())).rejects.toThrow();
    const proof = await publish(s);
    await expect(write(escrow(), 'PlatformRunEscrow', 'settleRun', [{ ...s, billableSeconds: 4n }, proof.hour, proof.proof], outsider())).rejects.toThrow();
    await expect(write(escrow(), 'PlatformRunEscrow', 'settleRun', [s, proof.hour, []], outsider())).rejects.toThrow();
    await write(escrow(), 'PlatformRunEscrow', 'settleRun', [s, proof.hour, proof.proof], outsider());
    expect(await available(agent.vault)).toBe(763_000n); expect(await balance(deployed.pins.feeRouterAddress)).toBe(327_000n);
    const receipt = await sync(agent.vault, q.runId), updated = await getAgent(agent.agentId);
    expect(updated.lifetimeBurn).toBe(327_000n); expect(updated.lastPaidRun).toBe(run.openedAt + 3n);
    expect(await read(agent.vault, 'PlatformAgentVault', 'openRuns')).toBe(0n);
    expect((await read<{ openRuns: bigint }>(deployed.pins.hostRegistryAddress, 'HostRegistry', 'getHost', [deployed.hostId])).openRuns).toBe(0n);
    const burned = receipt.logs.flatMap(log => { try { return [decodeEventLog({ abi: artifact('PlatformSelectionRegistry').abi, data: log.data, topics: log.topics })]; } catch { return []; } });
    expect(burned.some(event => event.eventName === 'Burn')).toBe(true);
    const ownerBefore = await balance(owner().address);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [endowment - 327_000n]);
    expect(await balance(owner().address) - ownerBefore).toBe(endowment - 327_000n); expect(await balance(agent.vault)).toBe(0n); expect(await available(agent.vault)).toBe(0n);
    await backing(); await expect(sync(agent.vault, q.runId)).rejects.toThrow();
    const week = await now() / 604800n;
    expect(await read<bigint>(deployed.pins.feeRouterAddress, 'FeeRouter', 'hostAccrued', [week, deployed.accounts.host.address])).toBe(300_000n);
    expect(await read(deployed.pins.feeRouterAddress, 'FeeRouter', 'getBuckets', [week])).toMatchObject({ work: 21_600n, treasury: 2_700n, stakers: 1_350n, buyAndBurn: 1_350n });
    await deployed.test.setNextBlockTimestamp({ timestamp: (week + 1n) * 604800n }); await deployed.test.mine({ blocks: 1 });
    const hostBefore = await balance(deployed.accounts.host.address);
    await write(deployed.pins.feeRouterAddress, 'FeeRouter', 'claimHost', [week], deployed.accounts.host);
    expect(await balance(deployed.accounts.host.address) - hostBefore).toBe(300_000n);
    await expect(write(deployed.pins.feeRouterAddress, 'FeeRouter', 'claimHost', [week], deployed.accounts.host)).rejects.toThrow(); await backing();
  });
  it('uses actual sealed-host 12% ceiling and fee-inclusive Burn, even for a controller-opened run', async () => {
    const agent = await enter({ scope: { ...scope, sealedOnly: true } });
    const q = await quote(agent, { hostId: sealedId, hwClass: 1, inferencePrice: 7n, pricePerSecond: 1001n });
    await open(agent.vault, q, controller); const run = await read<Run>(escrow(), 'PlatformRunEscrow', 'getRun', [q.runId]);
    expect(run.ceiling).toBe(11_220n); expect(run.sealedHost).toBe(true);
    await advance(5); await settle(q, 3n, 7n); await sync(agent.vault, q.runId);
    expect((await getAgent(agent.agentId)).lifetimeBurn).toBe(3372n); expect(await balance(deployed.pins.feeRouterAddress)).toBe(3372n);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'spendableBalance')).toBe(endowment - 3372n); await backing();
  });
  it('includes fees in Selection caps and rolls back failed funding together with host admission', async () => {
    const agent = await enter({ maxPerHour: 1_000_000n }), q = await quote(agent);
    await expect(open(agent.vault, q)).rejects.toThrow();
    expect(await balance(agent.vault)).toBe(endowment); expect(await available(agent.vault)).toBe(0n);
    expect(await read(agent.vault, 'PlatformAgentVault', 'openRuns')).toBe(0n);
    expect((await read<{ openRuns: bigint }>(deployed.pins.hostRegistryAddress, 'HostRegistry', 'getHost', [deployed.hostId])).openRuns).toBe(0n); await backing();
  });
  it.each(['image', 'region', 'class', 'signature'] as const)('rejects invalid %s with no Vault deposit, reservation or host hook residue', async failure => {
    const agent = await enter(), q = await quote(agent, failure === 'class' ? { hwClass: 2 } : {});
    const signature = failure === 'signature' ? await outsider().signTypedData(typed(q)) : await sign(q);
    await expect(write(agent.vault, 'PlatformAgentVault', 'payRun', [q, signature,
      failure === 'image' ? [] : [imageSibling], failure === 'region' ? [] : [regionSibling]], agentKey)).rejects.toThrow();
    expect(await balance(agent.vault)).toBe(endowment); expect(await available(agent.vault)).toBe(0n);
    expect((await read<Leash>(escrow(), 'PlatformRunEscrow', 'getLeash', [agent.leashId])).pending).toBe(0n); await backing();
  });
  it('prevents direct agent/owner escrow bypass and arbitrary outsiders using the Vault', async () => {
    const agent = await enter(), q = await quote(agent), signature = await sign(q);
    for (const account of [agentKey, owner()]) await expect(write(escrow(), 'PlatformRunEscrow', 'openRun', [q, signature, [imageSibling], [regionSibling]], account)).rejects.toThrow();
    for (const account of [outsider(), owner()]) await expect(open(agent.vault, q, account)).rejects.toThrow();
    await expect(open(agent.vault, { ...q, payer: owner().address })).rejects.toThrow();
    await expect(open(agent.vault, { ...q, leashId: id('foreign-leash') })).rejects.toThrow();
    expect(await balance(agent.vault)).toBe(endowment);
  });
  it('preserves scope on owner budget updates and blocks pending scope changes or agent widening', async () => {
    const agent = await enter(); await write(agent.vault, 'PlatformAgentVault', 'setBudget', [19_000_000n, 190_000_000n, await now() + 86400n]);
    const before = await read<Leash>(escrow(), 'PlatformRunEscrow', 'getLeash', [agent.leashId]); expect(before.imageAllowRoot).toBe(scope.imageAllowRoot);
    await expect(write(agent.vault, 'PlatformAgentVault', 'setScope', [{ ...scope, classMask: 7n }], agentKey)).rejects.toThrow();
    const q = await quote(agent); await open(agent.vault, q);
    await expect(write(agent.vault, 'PlatformAgentVault', 'setScope', [{ ...scope, classMask: 7n }])).rejects.toThrow();
    await expect(write(agent.vault, 'PlatformAgentVault', 'setBudget', [1_000_000n, 190_000_000n, before.expiry])).rejects.toThrow();
    await expect(write(agent.vault, 'PlatformAgentVault', 'setBudget', [20_000_001n, 200_000_000n, before.expiry])).rejects.toThrow();
    await backing();
  });
  it('frozen agent cannot open but owner can withdraw only free funds and settle/sync existing work', async () => {
    const agent = await enter(), q = await quote(agent); await open(agent.vault, q); await advance(4);
    await write(registry, 'PlatformSelectionRegistry', 'setFrozen', [agent.agentId, true, 'reviewed policy evidence', id('freeze-evidence')], guardian);
    await expect(open(agent.vault, await quote(agent))).rejects.toThrow();
    await expect(write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [endowment])).rejects.toThrow();
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [endowment - 1_090_000n]);
    await settle(q); await sync(agent.vault, q.runId);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [763_000n]);
    expect((await getAgent(agent.agentId)).lifetimeBurn).toBe(327_000n); expect(await available(agent.vault)).toBe(0n); await backing();
  });
  it('owner kill/stop preserves reserved funds until timeout then refunds the entire fee-inclusive ceiling', async () => {
    const agent = await enter(), q = await quote(agent); await open(agent.vault, q); await advance(2);
    await expect(write(agent.vault, 'PlatformAgentVault', 'requestStop', [q.runId], agentKey)).rejects.toThrow();
    await write(agent.vault, 'PlatformAgentVault', 'requestStop', [q.runId]); await write(agent.vault, 'PlatformAgentVault', 'killLeash');
    await expect(open(agent.vault, await quote(agent))).rejects.toThrow(); await expect(sync(agent.vault, q.runId)).rejects.toThrow();
    await expect(write(escrow(), 'PlatformRunEscrow', 'refundRun', [q.runId], outsider())).rejects.toThrow();
    const due = await read<bigint>(escrow(), 'PlatformRunEscrow', 'refundAt', [q.runId]);
    await deployed.test.setNextBlockTimestamp({ timestamp: due }); await deployed.test.mine({ blocks: 1 });
    await write(escrow(), 'PlatformRunEscrow', 'refundRun', [q.runId], outsider()); await sync(agent.vault, q.runId);
    const updated = await getAgent(agent.agentId); expect(updated.lifetimeBurn).toBe(0n); expect(updated.lastPaidRun).toBe(0n);
    expect(await available(agent.vault)).toBe(1_090_000n); expect(await balance(deployed.pins.feeRouterAddress)).toBe(0n);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [endowment]); expect(await balance(agent.vault)).toBe(0n);
    expect(await available(agent.vault)).toBe(0n); await backing();
  });
  it('zero-charge proven completion releases all funds without fabricated income, Burn or activity', async () => {
    const agent = await enter(), q = await quote(agent); await open(agent.vault, q); await settle(q, 0n); await sync(agent.vault, q.runId);
    const updated = await getAgent(agent.agentId); expect(updated.lifetimeBurn).toBe(0n); expect(updated.lastPaidRun).toBe(0n);
    expect(await read<bigint>(agent.vault, 'PlatformAgentVault', 'spendableBalance')).toBe(endowment);
    expect(await balance(deployed.pins.feeRouterAddress)).toBe(0n); await backing();
  });
  it('spawns a separately gated child with half current caps, identical scope and parent-only funding', async () => {
    const parent = await enter(); await write(parent.vault, 'PlatformAgentVault', 'setBudget', [18_000_000n, 180_000_000n, await now() + 86400n]);
    const leash = await read<Leash>(escrow(), 'PlatformRunEscrow', 'getLeash', [parent.leashId]), ownerBefore = await balance(owner().address);
    await write(registry, 'PlatformSelectionRegistry', 'spawn', [parent.agentId, 2n, childKey.address, 5_000_000n, leash.expiry], controller);
    const childId = await read<Hex>(registry, 'PlatformSelectionRegistry', 'identityAgent', [2n]), child = await getAgent(childId);
    const childLeash = await read<Leash>(escrow(), 'PlatformRunEscrow', 'getLeash', [child.leashId]);
    expect(childLeash.maxPerHour).toBe(9_000_000n); expect(childLeash.maxPerDay).toBe(90_000_000n);
    for (const field of ['classMask', 'sealedOnly', 'imageAllowRoot', 'regionAllowRoot'] as const) expect(childLeash[field]).toBe(leash[field]);
    expect(child.parent).toBe(parent.agentId); expect(child.family).toBe(parent.family); expect(child.cystHash).toBe(parent.cystHash);
    expect(await balance(child.vault)).toBe(5_000_000n); expect(await balance(parent.vault)).toBe(endowment - 6_000_000n);
    expect(await balance(owner().address)).toBe(ownerBefore);
    const q = await quote(child); await open(child.vault, q, childKey); await advance(4); await settle(q); await sync(child.vault, q.runId);
    expect((await getAgent(childId)).lifetimeBurn).toBe(327_000n); expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(0n); await backing();
  });
  it('counts external income separately from owner subsidy and requires actual payer transfers', async () => {
    const agent = await enter();
    await write(token(), 'MockToken', 'approve', [agent.vault, 1_000_000n], outsider());
    await write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [1_000_000n, id('outside-income')], outsider());
    await write(token(), 'MockToken', 'approve', [agent.vault, 2_000_000n]);
    await write(agent.vault, 'PlatformAgentVault', 'receiveFunds', [2_000_000n, id('owner-subsidy')]);
    const updated = await getAgent(agent.agentId); expect(updated.lifetimeIncome).toBe(1_000_000n); expect(updated.lifetimeIncomeFees).toBe(10_000n);
    expect(updated.lifetimeSubsidy).toBe(endowment + 2_000_000n); expect(await balance(treasury.address)).toBe(fee + 10_000n);
    await expect(write(registry, 'PlatformSelectionRegistry', 'recordIncome', [agent.agentId, outsider().address, 1n, id('fabricated')], outsider())).rejects.toThrow();
    await expect(write(registry, 'PlatformSelectionRegistry', 'recordBurn', [agent.agentId, id('fake-run'), 1n, await now()], outsider())).rejects.toThrow();
  });
  it('uses actual TLMR grace and dormant revival, while dead/frozen funds remain owner-withdrawable', async () => {
    const agent = await enter({ endowment: 0n });
    await write(utility, 'TlmrToken', 'approve', [staking, parseEther('1000')]);
    await write(staking, 'TlmrStaking', 'stake', [agent.agentId, parseEther('1000')]); await advance(86400);
    await write(registry, 'PlatformSelectionRegistry', 'declareDormant', [agent.agentId], outsider());
    const dormant = await getAgent(agent.agentId); expect(dormant.deathAt - dormant.dormantAt).toBe(60n * 86400n);
    await expect(open(agent.vault, await quote(agent))).rejects.toThrow();
    await write(token(), 'MockToken', 'transfer', [agent.vault, floor]); await write(registry, 'PlatformSelectionRegistry', 'revive', [agent.agentId]);
    expect((await getAgent(agent.agentId)).status).toBe(1); await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [floor]);
    await advance(86400); await write(registry, 'PlatformSelectionRegistry', 'declareDormant', [agent.agentId], outsider());
    const again = await getAgent(agent.agentId); await deployed.test.setNextBlockTimestamp({ timestamp: again.deathAt }); await deployed.test.mine({ blocks: 1 });
    await write(registry, 'PlatformSelectionRegistry', 'declareDeath', [agent.agentId], outsider());
    await write(registry, 'PlatformSelectionRegistry', 'setFrozen', [agent.agentId, true, 'post-death evidence', id('dead-freeze')], guardian);
    await write(token(), 'MockToken', 'transfer', [agent.vault, 7n]); await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [7n]);
    expect((await getAgent(agent.agentId)).status).toBe(3); expect(await balance(agent.vault)).toBe(0n);
    await expect(write(registry, 'PlatformSelectionRegistry', 'revive', [agent.agentId])).rejects.toThrow();
  });
  it('rejects legacy escrow configuration and cannot initialize a vault twice', async () => {
    const pilot = await deploy('TelomereRunEscrow', [token(), deployed.accounts.signer.address, deployed.accounts.signer.address, treasury.address]);
    await expect(deploy('PlatformSelectionRegistry', [{ token: token(), escrow: pilot, controller: controller.address, guardian: guardian.address,
      identityRegistry: identity, staking, treasury: treasury.address, entryFee: fee, vaultFloor: floor }])).rejects.toThrow();
    const agent = await enter();
    await expect(write(agent.vault, 'PlatformAgentVault', 'initialize', [outsider().address, outsider().address, agent.agentId, agent.leashId,
      1n, 2n, await now() + 100n, scope], outsider())).rejects.toThrow();
    expect((await read<Address>(agent.vault, 'PlatformAgentVault', 'owner')).toLowerCase()).toBe(owner().address.toLowerCase());
  });
  it('reuses escrow available funds and deposits only the missing portion of a second reservation', async () => {
    const agent = await enter(), first = await quote(agent); await open(agent.vault, first); await advance(4);
    await settle(first); await sync(agent.vault, first.runId);
    expect(await available(agent.vault)).toBe(763_000n); const cash = await balance(agent.vault);
    const second = await quote(agent); await open(agent.vault, second);
    expect(cash - await balance(agent.vault)).toBe(327_000n); expect(await available(agent.vault)).toBe(0n);
    expect((await read<Run>(escrow(), 'PlatformRunEscrow', 'getRun', [second.runId])).ceiling).toBe(1_090_000n); await backing();
  });
  it('owner scope updates after completed work preserve Vault caller identity and fee-inclusive caps', async () => {
    const agent = await enter(), q = await quote(agent); await open(agent.vault, q); await advance(4); await settle(q); await sync(agent.vault, q.runId);
    await write(agent.vault, 'PlatformAgentVault', 'setScope', [{ ...scope, classMask: 1n }]);
    const updated = await read<Leash>(escrow(), 'PlatformRunEscrow', 'getLeash', [agent.leashId]);
    expect(updated.classMask).toBe(1n); expect(updated.maxPerHour).toBe(20_000_000n);
    expect(updated.agent.toLowerCase()).toBe(agent.vault.toLowerCase()); expect(updated.owner.toLowerCase()).toBe(agent.vault.toLowerCase());
    const denied = await quote(agent, { hostId: sealedId, hwClass: 1 }); await expect(open(agent.vault, denied)).rejects.toThrow();
    expect(updated.pending).toBe(0n); await backing();
  });
  it('delayed sync cannot fabricate recent paid activity or skip unsynchronized reservations', async () => {
    const agent = await enter(), q = await quote(agent); await open(agent.vault, q); await advance(4); await settle(q);
    const run = await read<Run>(escrow(), 'PlatformRunEscrow', 'getRun', [q.runId]);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [endowment - 327_000n]); await advance(86400);
    await expect(write(registry, 'PlatformSelectionRegistry', 'declareDormant', [agent.agentId], outsider())).rejects.toThrow();
    await sync(agent.vault, q.runId); expect((await getAgent(agent.agentId)).lastPaidRun).toBe(run.openedAt + 3n);
    await write(registry, 'PlatformSelectionRegistry', 'declareDormant', [agent.agentId], outsider());
    expect((await getAgent(agent.agentId)).status).toBe(2);
  });
  it('keeps full Vault refunds withdrawable when the host-close hook fails, then repairs the actual registry', async () => {
    const agent = await enter(), q = await quote(agent); await open(agent.vault, q);
    const originalCode = (await deployed.local.publicClient.getCode({ address: deployed.pins.hostRegistryAddress }))!;
    // Disposable Anvil fault injection: preserve actual registry storage, temporarily reject every hook call.
    await deployed.test.setCode({ address: deployed.pins.hostRegistryAddress, bytecode: '0x60006000fd' });
    const due = await read<bigint>(escrow(), 'PlatformRunEscrow', 'refundAt', [q.runId]);
    await deployed.test.setNextBlockTimestamp({ timestamp: due }); await deployed.test.mine({ blocks: 1 });
    await write(escrow(), 'PlatformRunEscrow', 'refundRun', [q.runId], outsider()); await sync(agent.vault, q.runId);
    expect((await read<Run>(escrow(), 'PlatformRunEscrow', 'getRun', [q.runId])).hostReleased).toBe(false);
    expect((await getAgent(agent.agentId)).lifetimeBurn).toBe(0n);
    await write(agent.vault, 'PlatformAgentVault', 'ownerWithdraw', [endowment]); expect(await balance(agent.vault)).toBe(0n); expect(await available(agent.vault)).toBe(0n);
    await deployed.test.setCode({ address: deployed.pins.hostRegistryAddress, bytecode: originalCode });
    expect((await read<{ openRuns: bigint }>(deployed.pins.hostRegistryAddress, 'HostRegistry', 'getHost', [deployed.hostId])).openRuns).toBe(1n);
    await write(escrow(), 'PlatformRunEscrow', 'retryHostClosure', [q.runId], outsider());
    expect((await read<{ openRuns: bigint }>(deployed.pins.hostRegistryAddress, 'HostRegistry', 'getHost', [deployed.hostId])).openRuns).toBe(0n); await backing();
  });
});
