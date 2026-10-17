import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, decodeEventLog, encodeFunctionData, http, keccak256, maxUint256,
  parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../scripts/local-chain.js';
import { projectRoot } from '../scripts/compile-contracts.js';
import { localChain, quoteTypedData, settlementTypedData, type Quote } from '../src/chain/index.js';

type Artifact = { abi: Abi; bytecode: Hex; runtimeBytes: number };
type Account = ReturnType<typeof privateKeyToAccount>;
type Entry = { identityId: bigint; agentWallet: Address; maxPerHour: bigint; maxPerDay: bigint;
  expiry: bigint; cystHash: Hex; endowment: bigint };
type Agent = { identityId: bigint; owner: Address; agentWallet: Address; vault: Address; leashId: Hex;
  parent: Hex; family: Hex; cystHash: Hex; enteredAt: bigint; dormantAt: bigint; diedAt: bigint;
  lastPaidRun: bigint; lastActivationAt: bigint; deathAt: bigint; lifetimeIncome: bigint; lifetimeBurn: bigint;
  lifetimeSubsidy: bigint; lifetimeIncomeFees: bigint; livingChildren: number; status: number; frozen: boolean };
const id = (label: string): Hex => keccak256(toHex(label));
const zero = `0x${'00'.repeat(32)}` as Hex;
const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;

function compileSelection(): Record<string, Artifact> {
  const paths = ['contracts/AgentVault.sol', 'contracts/SelectionRegistry.sol', 'contracts/TlmrToken.sol',
    'contracts/TlmrStaking.sol', 'contracts/TelomereRunEscrow.sol', 'contracts/MockToken.sol',
    'contracts/TestAdversarialToken.sol'];
  const fixturePath = 'tests/LocalSelectionIdentity.sol';
  const sources = { ...Object.fromEntries(paths.map(path => [path,
    { content: readFileSync(resolve(projectRoot, path), 'utf8') }])), [fixturePath]: { content: `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
// Disposable ownerOf adapter fixture, not a public ERC-8004 deployment.
contract LocalSelectionIdentity {
    mapping(uint256 => address) private owners;
    constructor() { require(block.chainid == 31337, "local fixture only"); }
    function register(uint256 identityId, address owner) external {
        require(owner != address(0) && owners[identityId] == address(0), "invalid fixture identity");
        owners[identityId] = owner;
    }
    function ownerOf(uint256 identityId) external view returns (address) {
        require(owners[identityId] != address(0), "missing fixture identity"); return owners[identityId];
    }
}
` } };
  const input = { language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  } };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (path: string) => {
    if (!path.startsWith('@openzeppelin/contracts/') || path.includes('..')) return { error: 'Unsupported import' };
    return { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') };
  } })) as { errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const failures = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join('\n'));
  return Object.fromEntries([...paths, fixturePath].flatMap(path => Object.entries(output.contracts[path] ?? {}).map(([name, value]) =>
    [name, { abi: value.abi, bytecode: `0x${value.evm.bytecode.object}` as Hex,
      runtimeBytes: value.evm.deployedBytecode.object.length / 2 }])));
}

describe('Selection vaults and fixed-supply utility staking on an actual disposable EVM', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let test: ReturnType<typeof createTestClient>;
  let artifacts: Record<string, Artifact>;
  let owner: Account; let signer: Account; let controller: Account; let guardian: Account;
  let payer: Account; let agentKey: Account; let treasury: Account; let otherOwner: Account;
  let childKeys: Account[];
  let token: Address; let escrow: Address; let identity: Address; let utilityToken: Address; let staking: Address; let registry: Address;
  let snapshot: Hex;
  const fee = 1_000_000n;
  const floor = 1_000_000n;
  const initialTokens = 1_000_000_000n;
  const supply = parseEther('1000000');

  function artifact(name: string) { const result = artifacts[name]; if (!result) throw new Error(`Missing ${name}`); return result; }
  async function deploy(name: string, args: readonly unknown[] = []) {
    const wallet = createWalletClient({ account: owner, chain: localChain, transport: http(local.rpcUrl) });
    const compiled = artifact(name);
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = owner, gas?: bigint) {
    const wallet = createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl) });
    const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, ...(gas ? { gas } : {}) });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      const transaction = await local.publicClient.getTransaction({ hash });
      throw new Error(`${functionName} reverted (used ${receipt.gasUsed} of ${transaction.gas} gas)`);
    }
    return receipt;
  }
  async function read(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<unknown> {
    return local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args });
  }
  async function balance(address: Address) { return read(token, 'MockToken', 'balanceOf', [address]) as Promise<bigint>; }
  async function now() { return (await local.publicClient.getBlock()).timestamp; }
  async function advance(seconds: number) { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); }
  async function terms(overrides: Partial<Entry> = {}): Promise<Entry> {
    return { identityId: 1n, agentWallet: agentKey.address, maxPerHour: 20_000_000n, maxPerDay: 200_000_000n,
      expiry: await now() + 365n * 86_400n, cystHash: id('parent-encrypted-cyst'), endowment: 50_000_000n, ...overrides };
  }
  async function getAgent(agentId: Hex) { return read(registry, 'SelectionRegistry', 'getAgent', [agentId]) as Promise<Agent>; }
  async function enter(overrides: Partial<Entry> = {}, caller = owner) {
    await write(registry, 'SelectionRegistry', 'enter', [await terms(overrides)], caller);
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [overrides.identityId ?? 1n]) as Hex;
    return { agentId, ...(await getAgent(agentId)) };
  }
  async function fund(vault: Address, amount: bigint, source = payer) {
    await write(token, 'MockToken', 'approve', [vault, amount], source);
    return write(vault, 'AgentVault', 'receiveFunds', [amount, id('payment-reference')], source);
  }
  async function quote(agent: { vault: Address; leashId: Hex }, overrides: Partial<Quote> = {}): Promise<Quote> {
    return { runId: id(`run-${Math.random()}`), leashId: agent.leashId, payer: agent.vault,
      workloadHash: id('fixture-workload'), maxSeconds: 10n, pricePerSecond: 100_000n,
      inferencePrice: 0n, quoteExpiry: await now() + 300n, ...overrides };
  }
  async function open(vault: Address, q: Quote, caller = agentKey) {
    const signature = await signer.signTypedData(quoteTypedData(31337, escrow, q));
    return write(vault, 'AgentVault', 'payRun', [q, signature], caller);
  }
  // Anvil may estimate at zero elapsed seconds and mine after the next second.
  // Keep a bounded fixture budget across both valid settlement branches.
  async function settle(q: Quote, seconds = 3n, inferenceCharge = 0n, gas = 300_000n) {
    const settlement = { runId: q.runId, billableSeconds: seconds, inferenceCharge, receiptHash: id(`receipt-${q.runId}`) };
    const signature = await signer.signTypedData(settlementTypedData(31337, escrow, settlement));
    await write(escrow, 'TelomereRunEscrow', 'settleRun', [settlement, signature], payer, gas);
    return settlement;
  }
  async function makeDormant(agentId: Hex) {
    const agent = await getAgent(agentId);
    const spendable = await read(agent.vault, 'AgentVault', 'spendableBalance') as bigint;
    if (spendable >= floor) await write(agent.vault, 'AgentVault', 'ownerWithdraw', [spendable], owner);
    await advance(86_400); await write(registry, 'SelectionRegistry', 'declareDormant', [agentId], payer);
    return getAgent(agentId);
  }
  async function spawn(parentId: Hex, index: number, endowment = 5_000_000n) {
    const childKey = childKeys[index]; if (!childKey) throw new Error('Missing child fixture key');
    const parent = await getAgent(parentId);
    const parentLeash = await read(escrow, 'TelomereRunEscrow', 'getLeash', [parent.leashId]) as { expiry: bigint };
    await write(registry, 'SelectionRegistry', 'spawn', [parentId, BigInt(index + 2), childKey.address, endowment, parentLeash.expiry]);
    const agentId = await read(registry, 'SelectionRegistry', 'identityAgent', [BigInt(index + 2)]) as Hex;
    return { agentId, ...(await getAgent(agentId)) };
  }
  function events(receipt: Awaited<ReturnType<typeof write>>, name = 'SelectionRegistry') {
    return receipt.logs.flatMap(log => {
      try { return [decodeEventLog({ abi: artifact(name).abi, data: log.data, topics: log.topics })]; }
      catch { return []; }
    });
  }

  beforeAll(async () => {
    artifacts = compileSelection(); local = await startLocalChain();
    test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    [owner, signer, controller, guardian, payer, agentKey, treasury, otherOwner] =
      Array.from({ length: 8 }, () => privateKeyToAccount(generatePrivateKey())) as [Account, Account, Account, Account, Account, Account, Account, Account];
    childKeys = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
    for (const account of [owner, signer, controller, guardian, payer, agentKey, treasury, otherOwner, ...childKeys]) {
      await test.setBalance({ address: account.address, value: parseEther('10') });
    }
    token = await deploy('MockToken');
    escrow = await deploy('TelomereRunEscrow', [token, signer.address, signer.address, treasury.address]);
    identity = await deploy('LocalSelectionIdentity'); utilityToken = await deploy('TlmrToken', [owner.address, supply]);
    staking = await deploy('TlmrStaking', [utilityToken]);
    registry = await deploy('SelectionRegistry', [{ token, escrow, controller: controller.address, guardian: guardian.address,
      identityRegistry: identity, staking, treasury: treasury.address, entryFee: fee, vaultFloor: floor }]);
    for (const account of [owner, payer, treasury, controller, agentKey, otherOwner, ...childKeys]) {
      await write(token, 'MockToken', 'faucet', [account.address, initialTokens]);
      await write(token, 'MockToken', 'approve', [registry, maxUint256], account);
    }
    for (let index = 1; index <= 7; index += 1) await write(identity, 'LocalSelectionIdentity', 'register', [BigInt(index), owner.address]);
    await write(identity, 'LocalSelectionIdentity', 'register', [8n, otherOwner.address]);
    await write(utilityToken, 'TlmrToken', 'approve', [staking, maxUint256]);
    snapshot = await test.snapshot();
  }, 60_000);
  beforeEach(async () => { await test.revert({ id: snapshot }); snapshot = await test.snapshot(); });
  afterAll(async () => { if (local) await local.close(); });

  it('deploys all contracts under EIP-170 and pins actual escrow/token/identity/staking', async () => {
    for (const name of ['SelectionRegistry', 'AgentVault', 'TlmrToken', 'TlmrStaking']) expect(artifact(name).runtimeBytes).toBeLessThanOrEqual(24_576);
    expect((await read(registry, 'SelectionRegistry', 'escrow') as string).toLowerCase()).toBe(escrow.toLowerCase());
    expect((await read(registry, 'SelectionRegistry', 'identityRegistry') as string).toLowerCase()).toBe(identity.toLowerCase());
    expect((await read(registry, 'SelectionRegistry', 'staking') as string).toLowerCase()).toBe(staking.toLowerCase());
  });
  it('creates a unique minimal vault, real escrow leash, exact entry fee and separate subsidy', async () => {
    const parent = await enter();
    expect(parent.owner.toLowerCase()).toBe(owner.address.toLowerCase()); expect(parent.status).toBe(1);
    expect(parent.lifetimeIncome).toBe(0n); expect(parent.lifetimeSubsidy).toBe(50_000_000n);
    expect(await balance(parent.vault)).toBe(50_000_000n); expect(await balance(treasury.address)).toBe(initialTokens + fee);
    expect(await balance(owner.address)).toBe(initialTokens - fee - 50_000_000n);
    expect((await local.publicClient.getCode({ address: parent.vault }))?.length).toBe(92);
    const leash = await read(escrow, 'TelomereRunEscrow', 'getLeash', [parent.leashId]) as { owner: Address; agent: Address; maxPerHour: bigint; maxPerDay: bigint };
    expect(leash.owner.toLowerCase()).toBe(parent.vault.toLowerCase()); expect(leash.agent.toLowerCase()).toBe(parent.vault.toLowerCase());
    expect(leash.maxPerHour).toBe(20_000_000n); expect(leash.maxPerDay).toBe(200_000_000n);
    expect(parent.lastPaidRun).toBe(0n); expect(await read(registry, 'SelectionRegistry', 'population')).toBe(1n);
  });
  it('rejects wrong identity ownership, missing identities, duplicate identities and duplicate agent keys', async () => {
    await expect(enter({}, otherOwner)).rejects.toThrow(); await expect(enter({ identityId: 99n })).rejects.toThrow();
    await expect(enter({ agentWallet: zeroAddress })).rejects.toThrow();
    await expect(enter({ agentWallet: controller.address })).rejects.toThrow();
    await enter(); await expect(enter()).rejects.toThrow();
    await expect(enter({ identityId: 2n })).rejects.toThrow();
    expect(await read(registry, 'SelectionRegistry', 'totalBirths')).toBe(1n);
  });
  it('enforces owner-created $20/hour and $200/day caps and rejects invalid updates', async () => {
    await expect(enter({ maxPerHour: 20_000_001n })).rejects.toThrow();
    await expect(enter({ maxPerDay: 200_000_001n })).rejects.toThrow();
    await expect(enter({ maxPerDay: 1n })).rejects.toThrow();
    const parent = await enter(); const expiry = await now() + 10_000n;
    await expect(write(parent.vault, 'AgentVault', 'setBudget', [1n, 2n, expiry], agentKey)).rejects.toThrow();
    await expect(write(parent.vault, 'AgentVault', 'setBudget', [20_000_001n, 200_000_000n, expiry])).rejects.toThrow();
    await expect(write(parent.vault, 'AgentVault', 'setBudget', [1n, 200_000_001n, expiry])).rejects.toThrow();
    await write(parent.vault, 'AgentVault', 'setBudget', [10_000_000n, 100_000_000n, expiry]);
    expect((await read(escrow, 'TelomereRunEscrow', 'getLeash', [parent.leashId]) as { maxPerHour: bigint }).maxPerHour).toBe(10_000_000n);
  });
  it('locks implementation and clone initialization against replacement owners or registry', async () => {
    const parent = await enter(); const implementation = await read(registry, 'SelectionRegistry', 'vaultImplementation') as Address;
    const args = [payer.address, payer.address, id('stolen'), id('stolen-leash'), 1n, 1n, await now() + 10n];
    await expect(write(parent.vault, 'AgentVault', 'initialize', args, payer)).rejects.toThrow();
    await expect(write(implementation, 'AgentVault', 'initialize', args, payer)).rejects.toThrow();
    expect((await read(parent.vault, 'AgentVault', 'owner') as string).toLowerCase()).toBe(owner.address.toLowerCase());
  });
  it('classifies actual third-party income, charges exactly 1%, and logs the real payer', async () => {
    const parent = await enter(); const before = await balance(treasury.address);
    const receipt = await fund(parent.vault, 1_000_001n);
    const state = await getAgent(parent.agentId);
    expect(state.lifetimeIncome).toBe(1_000_001n); expect(state.lifetimeIncomeFees).toBe(10_001n);
    expect(state.lifetimeSubsidy).toBe(50_000_000n); expect(await balance(parent.vault)).toBe(50_990_000n);
    expect(await balance(treasury.address)).toBe(before + 10_001n);
    const income = events(receipt).find(event => event.eventName === 'Income');
    const incomeArgs = income?.args;
    if (!incomeArgs || typeof incomeArgs !== 'object' || !('source' in incomeArgs) || typeof incomeArgs.source !== 'string') {
      throw new Error('Income event did not contain an authenticated source');
    }
    expect(incomeArgs.source.toLowerCase()).toBe(payer.address.toLowerCase());
    await expect(write(registry, 'SelectionRegistry', 'recordIncome', [parent.agentId, payer.address, 1_000_000n, zero], payer)).rejects.toThrow();
  });
  it('excludes owner, agent, controller and platform treasury funding from verified income', async () => {
    const parent = await enter();
    for (const source of [owner, agentKey, controller, treasury]) {
      const receipt = await fund(parent.vault, 1_000_000n, source);
      expect(events(receipt).some(event => event.eventName === 'Subsidy')).toBe(true);
    }
    const state = await getAgent(parent.agentId);
    expect(state.lifetimeIncome).toBe(0n); expect(state.lifetimeIncomeFees).toBe(0n); expect(state.lifetimeSubsidy).toBe(54_000_000n);
    expect(await balance(parent.vault)).toBe(54_000_000n);
  });
  it('does not inflate income for direct ERC20 transfers that bypass classified collection', async () => {
    const parent = await enter(); await write(token, 'MockToken', 'transfer', [parent.vault, 1_234n], payer);
    expect((await getAgent(parent.agentId)).lifetimeIncome).toBe(0n);
    expect(await read(parent.vault, 'AgentVault', 'spendableBalance')).toBe(50_001_234n);
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [50_001_234n]);
    expect(await balance(parent.vault)).toBe(0n);
  });
  it('spawns a distinct half-cap leash and funds an inherited Cyst hash only from the parent vault', async () => {
    const parent = await enter(); const ownerBefore = await balance(owner.address); const parentBefore = await balance(parent.vault);
    const child = await spawn(parent.agentId, 0);
    expect(child.parent).toBe(parent.agentId); expect(child.family).toBe(parent.family); expect(child.cystHash).toBe(parent.cystHash);
    expect(child.leashId).not.toBe(parent.leashId); expect(child.vault.toLowerCase()).not.toBe(parent.vault.toLowerCase());
    expect(await balance(child.vault)).toBe(5_000_000n); expect(await balance(parent.vault)).toBe(parentBefore - 5_000_000n - fee);
    expect(await balance(owner.address)).toBe(ownerBefore); expect(child.lifetimeIncome).toBe(0n); expect(child.lifetimeSubsidy).toBe(5_000_000n);
    const leash = await read(escrow, 'TelomereRunEscrow', 'getLeash', [child.leashId]) as { maxPerHour: bigint; maxPerDay: bigint; agent: Address };
    expect(leash.maxPerHour).toBe(10_000_000n); expect(leash.maxPerDay).toBe(100_000_000n);
    expect(leash.agent.toLowerCase()).toBe(child.vault.toLowerCase()); expect((await getAgent(parent.agentId)).livingChildren).toBe(1);
  });
  it('excludes parent/child keys and vaults, including descendants, without excluding unrelated agents', async () => {
    const parent = await enter(); const child = await spawn(parent.agentId, 0);
    expect(await read(registry, 'SelectionRegistry', 'isExcludedIncome', [parent.agentId, child.vault])).toBe(true);
    expect(await read(registry, 'SelectionRegistry', 'isExcludedIncome', [child.agentId, parent.vault])).toBe(true);
    expect(await read(registry, 'SelectionRegistry', 'isExcludedIncome', [child.agentId, agentKey.address])).toBe(true);
    await fund(parent.vault, 1_000_000n, childKeys[0]);
    expect((await getAgent(parent.agentId)).lifetimeIncome).toBe(0n);
    const unrelatedKey = childKeys[4]; if (!unrelatedKey) throw new Error('Missing fixture key');
    const unrelated = await enter({ identityId: 8n, agentWallet: unrelatedKey.address }, otherOwner);
    expect(await read(registry, 'SelectionRegistry', 'isExcludedIncome', [parent.agentId, unrelated.vault])).toBe(false);
    expect(await read(registry, 'SelectionRegistry', 'isExcludedIncome', [parent.agentId, unrelated.agentWallet])).toBe(false);
  });
  it('caps living children at three and rolls back every fee/endowment on rejected fourth spawn', async () => {
    const parent = await enter(); for (let index = 0; index < 3; index += 1) await spawn(parent.agentId, index);
    const parentBalance = await balance(parent.vault); const treasuryBalance = await balance(treasury.address);
    await expect(spawn(parent.agentId, 3)).rejects.toThrow();
    expect((await getAgent(parent.agentId)).livingChildren).toBe(3); expect(await balance(parent.vault)).toBe(parentBalance);
    expect(await balance(treasury.address)).toBe(treasuryBalance); expect(await read(registry, 'SelectionRegistry', 'totalBirths')).toBe(4n);
  });
  it('rejects unauthorized spawn, nonexistent Cyst, invalid child expiry and insufficient parent funds atomically', async () => {
    const parent = await enter(); const key = childKeys[0]; if (!key) throw new Error('Missing fixture key');
    const expiry = (await terms()).expiry;
    await expect(write(registry, 'SelectionRegistry', 'spawn', [parent.agentId, 2n, key.address, 1n, expiry], payer)).rejects.toThrow();
    await expect(write(registry, 'SelectionRegistry', 'spawn', [parent.agentId, 2n, key.address, 1n, expiry + 1n])).rejects.toThrow();
    await expect(spawn(parent.agentId, 0, 100_000_000n)).rejects.toThrow();
    expect(await read(registry, 'SelectionRegistry', 'identityAgent', [2n])).toBe(zero);
    const absentCyst = await enter({ identityId: 7n, agentWallet: key.address, cystHash: zero });
    const anotherKey = childKeys[1]; if (!anotherKey) throw new Error('Missing fixture key');
    await expect(write(registry, 'SelectionRegistry', 'spawn', [absentCyst.agentId, 3n, anotherKey.address, 1n, expiry])).rejects.toThrow();
  });
  it('opens actual escrow only through agent/controller and preserves money after receipt settlement and withdrawal', async () => {
    const parent = await enter(); const q = await quote(parent); const beforeTreasury = await balance(treasury.address);
    await expect(open(parent.vault, q, payer)).rejects.toThrow();
    const signature = await signer.signTypedData(quoteTypedData(31337, escrow, q));
    await expect(write(escrow, 'TelomereRunEscrow', 'openRun', [q, signature], agentKey)).rejects.toThrow();
    await open(parent.vault, q);
    expect(await balance(parent.vault)).toBe(49_000_000n); expect(await balance(escrow)).toBe(1_000_000n);
    expect(await read(parent.vault, 'AgentVault', 'openRuns')).toBe(1n);
    await advance(3); await settle(q); await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(300_000n);
    expect(await read(parent.vault, 'AgentVault', 'openRuns')).toBe(0n);
    expect(await read(escrow, 'TelomereRunEscrow', 'availableBalance', [parent.vault])).toBe(700_000n);
    expect(await balance(treasury.address)).toBe(beforeTreasury + 300_000n);
    const beforeOwner = await balance(owner.address); await write(parent.vault, 'AgentVault', 'ownerWithdraw', [49_700_000n]);
    expect(await balance(owner.address)).toBe(beforeOwner + 49_700_000n);
    expect(await balance(parent.vault)).toBe(0n); expect(await balance(escrow)).toBe(0n);
    await expect(write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer)).rejects.toThrow();
    expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(300_000n);
  });
  it('controller may pay a bounded quote but cannot substitute payer/leash or bypass hour caps', async () => {
    const parent = await enter(); const q = await quote(parent);
    await expect(open(parent.vault, { ...q, payer: owner.address }, controller)).rejects.toThrow();
    await expect(open(parent.vault, { ...q, leashId: id('wrong-leash') }, controller)).rejects.toThrow();
    await expect(open(parent.vault, { ...q, maxSeconds: 120n, pricePerSecond: 200_000n }, controller)).rejects.toThrow();
    expect(await balance(parent.vault)).toBe(50_000_000n);
    expect(await read(escrow, 'TelomereRunEscrow', 'availableBalance', [parent.vault])).toBe(0n);
    await open(parent.vault, q, controller); expect(await read(parent.vault, 'AgentVault', 'openRuns')).toBe(1n);
  });
  it('rolls back automatic escrow funding for invalid signatures and rejects replay without a second reservation', async () => {
    const parent = await enter(); const q = await quote(parent);
    const wrongChainSignature = await signer.signTypedData(quoteTypedData(84532, escrow, q));
    await expect(write(parent.vault, 'AgentVault', 'payRun', [q, wrongChainSignature], agentKey)).rejects.toThrow();
    const signature = await signer.signTypedData(quoteTypedData(31337, escrow, q));
    await expect(write(parent.vault, 'AgentVault', 'payRun', [{ ...q, pricePerSecond: 100_001n }, signature], agentKey)).rejects.toThrow();
    expect(await balance(parent.vault)).toBe(50_000_000n); expect(await balance(escrow)).toBe(0n);
    expect(await read(parent.vault, 'AgentVault', 'openRuns')).toBe(0n);
    await open(parent.vault, q);
    await expect(open(parent.vault, q, controller)).rejects.toThrow();
    expect(await balance(escrow)).toBe(1_000_000n); expect(await read(parent.vault, 'AgentVault', 'openRuns')).toBe(1n);
  });
  it('uses settled escrow available funds for child endowment after the owner removes free vault cash', async () => {
    const parent = await enter(); const q = await quote(parent, { maxSeconds: 120n });
    await open(parent.vault, q); await write(parent.vault, 'AgentVault', 'ownerWithdraw', [38_000_000n]);
    await advance(3); await settle(q); await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    expect(await balance(parent.vault)).toBe(0n);
    expect(await read(escrow, 'TelomereRunEscrow', 'availableBalance', [parent.vault])).toBe(11_700_000n);
    const child = await spawn(parent.agentId, 0);
    expect(await balance(child.vault)).toBe(5_000_000n);
    expect(await read(escrow, 'TelomereRunEscrow', 'availableBalance', [parent.vault])).toBe(5_700_000n);
    expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(300_000n);
    expect((await getAgent(child.agentId)).lifetimeIncome).toBe(0n);
  });
  it('records inference-only burn and zero-charge settlement accurately without fabricating paid work', async () => {
    const parent = await enter(); const free = await quote(parent);
    await open(parent.vault, free); await settle(free, 0n); await write(parent.vault, 'AgentVault', 'syncRun', [free.runId], payer);
    expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(0n);
    expect((await getAgent(parent.agentId)).lastPaidRun).toBe(0n);
    const inference = await quote(parent, { inferencePrice: 200_000n });
    await open(parent.vault, inference); await settle(inference, 0n, 200_000n);
    await write(parent.vault, 'AgentVault', 'syncRun', [inference.runId], payer);
    const state = await getAgent(parent.agentId);
    expect(state.lifetimeBurn).toBe(200_000n);
    expect(state.lastPaidRun).toBeGreaterThanOrEqual(state.enteredAt);
    expect(await read(parent.vault, 'AgentVault', 'spendableBalance')).toBe(49_800_000n);
  });
  it('supports the escrow one-second billing tolerance without a future paid-run timestamp', async () => {
    const parent = await enter(); const q = await quote(parent); await open(parent.vault, q);
    // Estimate and mine can straddle the zero/one elapsed-second branch. Give the
    // real EVM transaction an explicit ample budget instead of a stale estimate.
    await settle(q, 1n, 0n, 300_000n); await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    const state = await getAgent(parent.agentId);
    expect(state.lifetimeBurn).toBe(100_000n); expect(state.lastPaidRun).toBeLessThanOrEqual(await now());
  });
  it('returns timed-out reservations, records no burn for refund and keeps owner withdrawable', async () => {
    const parent = await enter(); const q = await quote(parent); await open(parent.vault, q);
    await expect(write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer)).rejects.toThrow();
    await advance(6 * 3_600 + 10); await write(escrow, 'TelomereRunEscrow', 'refundRun', [q.runId], payer);
    await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(0n);
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [50_000_000n]);
    expect(await balance(parent.vault)).toBe(0n); expect(await balance(escrow)).toBe(0n);
  });
  it('guardian publishes freeze evidence and cannot seize funds or block owner cash withdrawals', async () => {
    const parent = await enter(); const q = await quote(parent);
    await expect(write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, 'policy breach', id('evidence')], payer)).rejects.toThrow();
    await expect(write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, '', id('evidence')], guardian)).rejects.toThrow();
    await expect(write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, 'policy breach', zero], guardian)).rejects.toThrow();
    const receipt = await write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, 'policy breach', id('evidence')], guardian);
    expect(events(receipt).some(event => event.eventName === 'Frozen')).toBe(true);
    await expect(open(parent.vault, q)).rejects.toThrow(); await expect(spawn(parent.agentId, 0)).rejects.toThrow();
    await expect(write(parent.vault, 'AgentVault', 'ownerWithdraw', [1n], guardian)).rejects.toThrow();
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [50_000_000n]); expect(await balance(parent.vault)).toBe(0n);
  });
  it('frozen owner withdrawal preserves pending reservations and receipt settlement remains possible', async () => {
    const parent = await enter(); const q = await quote(parent); await open(parent.vault, q);
    await write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, 'policy breach', id('evidence')], guardian);
    await expect(write(parent.vault, 'AgentVault', 'ownerWithdraw', [50_000_000n])).rejects.toThrow();
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [49_000_000n]);
    expect(await balance(escrow)).toBe(1_000_000n); await advance(3); await settle(q);
    await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [700_000n]);
    expect(await balance(escrow)).toBe(0n); expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(300_000n);
  });
  it('owner stop and permanent leash kill block new work without confiscating accepted work', async () => {
    const parent = await enter(); const q = await quote(parent); await open(parent.vault, q); await advance(2);
    await expect(write(parent.vault, 'AgentVault', 'requestStop', [q.runId], agentKey)).rejects.toThrow();
    await write(parent.vault, 'AgentVault', 'requestStop', [q.runId]); await write(parent.vault, 'AgentVault', 'killLeash');
    await expect(open(parent.vault, await quote(parent))).rejects.toThrow();
    await settle(q, 2n); await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    expect((await getAgent(parent.agentId)).lifetimeBurn).toBe(200_000n);
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [49_800_000n]); expect(await balance(escrow)).toBe(0n);
  });
  it('requires a full 24h without paid work, below-floor funds, and no unresolved runs before dormancy', async () => {
    const parent = await enter(); await advance(86_400);
    await expect(write(registry, 'SelectionRegistry', 'declareDormant', [parent.agentId], payer)).rejects.toThrow();
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [50_000_000n]);
    await write(registry, 'SelectionRegistry', 'declareDormant', [parent.agentId], payer);
    expect((await getAgent(parent.agentId)).status).toBe(2);
    const key = childKeys[0]; if (!key) throw new Error('Missing fixture key');
    const fresh = await enter({ identityId: 2n, agentWallet: key.address, endowment: 1n });
    await expect(write(registry, 'SelectionRegistry', 'declareDormant', [fresh.agentId], payer)).rejects.toThrow();
  });
  it('does not declare dormancy with a settled but unsynchronized reservation', async () => {
    const parent = await enter(); const q = await quote(parent); await open(parent.vault, q); await advance(3); await settle(q);
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [49_700_000n]); await advance(86_400);
    await expect(write(registry, 'SelectionRegistry', 'declareDormant', [parent.agentId], payer)).rejects.toThrow();
    await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    const paidAt = (await getAgent(parent.agentId)).lastPaidRun; expect(paidAt).toBeLessThan(await now() - 86_399n);
    await write(registry, 'SelectionRegistry', 'declareDormant', [parent.agentId], payer);
    expect((await getAgent(parent.agentId)).status).toBe(2);
  });
  it('enforces exactly 24 hours since the receipted paid run rather than since delayed sync', async () => {
    const parent = await enter(); const q = await quote(parent); await open(parent.vault, q); await advance(3); await settle(q);
    await write(parent.vault, 'AgentVault', 'syncRun', [q.runId], payer);
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [49_700_000n]);
    const state = await getAgent(parent.agentId); const boundary = state.lastPaidRun + 86_400n;
    await test.setNextBlockTimestamp({ timestamp: boundary - 1n }); await test.mine({ blocks: 1 });
    await expect(local.publicClient.simulateContract({ account: payer, address: registry, abi: artifact('SelectionRegistry').abi,
      functionName: 'declareDormant', args: [parent.agentId] })).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: boundary }); await test.mine({ blocks: 1 });
    await write(registry, 'SelectionRegistry', 'declareDormant', [parent.agentId], payer);
    expect((await getAgent(parent.agentId)).status).toBe(2);
  });
  it('revives only dormant funded agents, only for the owner, without inventing paid-run history', async () => {
    const parent = await enter(); await expect(write(registry, 'SelectionRegistry', 'revive', [parent.agentId])).rejects.toThrow();
    await makeDormant(parent.agentId);
    await expect(write(registry, 'SelectionRegistry', 'revive', [parent.agentId])).rejects.toThrow();
    await fund(parent.vault, floor, owner);
    await expect(write(registry, 'SelectionRegistry', 'revive', [parent.agentId], payer)).rejects.toThrow();
    await write(registry, 'SelectionRegistry', 'revive', [parent.agentId]);
    const revived = await getAgent(parent.agentId); expect(revived.status).toBe(1); expect(revived.dormantAt).toBe(0n);
    expect(revived.lastPaidRun).toBe(0n); expect(revived.lifetimeIncome).toBe(0n);
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [floor]);
    await expect(write(registry, 'SelectionRegistry', 'declareDormant', [parent.agentId], payer)).rejects.toThrow();
  });
  it('rejects revival while frozen, and permits revival after a reasoned guardian unfreeze', async () => {
    const parent = await enter(); await makeDormant(parent.agentId); await fund(parent.vault, floor, owner);
    await write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, true, 'policy breach', id('evidence')], guardian);
    await expect(write(registry, 'SelectionRegistry', 'revive', [parent.agentId])).rejects.toThrow();
    await write(registry, 'SelectionRegistry', 'setFrozen', [parent.agentId, false, 'review resolved', id('resolution')], guardian);
    await write(registry, 'SelectionRegistry', 'revive', [parent.agentId]); expect((await getAgent(parent.agentId)).status).toBe(1);
  });
  it('enforces the precise 30-day death boundary and permanently forbids revival after death', async () => {
    const parent = await enter({ endowment: 123n }); const dormant = await makeDormant(parent.agentId);
    expect(dormant.deathAt).toBe(dormant.dormantAt + 30n * 86_400n);
    await test.setNextBlockTimestamp({ timestamp: dormant.deathAt - 1n }); await test.mine({ blocks: 1 });
    await expect(local.publicClient.simulateContract({ account: payer, address: registry, abi: artifact('SelectionRegistry').abi,
      functionName: 'declareDeath', args: [parent.agentId] })).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: dormant.deathAt }); await test.mine({ blocks: 1 });
    const receipt = await write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId], payer);
    expect(events(receipt).some(event => event.eventName === 'Death')).toBe(true);
    expect((await getAgent(parent.agentId)).status).toBe(3); expect(await read(registry, 'SelectionRegistry', 'population')).toBe(0n);
    await expect(write(registry, 'SelectionRegistry', 'revive', [parent.agentId])).rejects.toThrow();
    await expect(fund(parent.vault, floor, owner)).rejects.toThrow();
    await write(parent.vault, 'AgentVault', 'ownerWithdraw', [123n]); expect(await balance(parent.vault)).toBe(0n);
  });
  it('a child death releases one living-child slot without recycling identity, leash or historical stats', async () => {
    const parent = await enter(); const first = await spawn(parent.agentId, 0);
    await spawn(parent.agentId, 1); await spawn(parent.agentId, 2);
    const dormant = await makeDormant(first.agentId); await test.setNextBlockTimestamp({ timestamp: dormant.deathAt }); await test.mine({ blocks: 1 });
    await write(registry, 'SelectionRegistry', 'declareDeath', [first.agentId], payer);
    expect((await getAgent(parent.agentId)).livingChildren).toBe(2);
    await expect(spawn(parent.agentId, 0)).rejects.toThrow();
    const fourth = await spawn(parent.agentId, 3); expect(fourth.agentId).not.toBe(first.agentId);
    expect((await getAgent(parent.agentId)).livingChildren).toBe(3); expect(await read(registry, 'SelectionRegistry', 'totalDeaths')).toBe(1n);
  });
  it('does not declare death after a funded dormancy and permits owner revival until death is actually declared', async () => {
    const parent = await enter({ endowment: 0n }); const dormant = await makeDormant(parent.agentId);
    await fund(parent.vault, floor, owner); await test.setNextBlockTimestamp({ timestamp: dormant.deathAt }); await test.mine({ blocks: 1 });
    await expect(write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId], payer)).rejects.toThrow();
    await write(registry, 'SelectionRegistry', 'revive', [parent.agentId]);
    expect((await getAgent(parent.agentId)).status).toBe(1);
  });
  it('extends dormancy from active TLMR stake up to 60 days without adding spendable money', async () => {
    const parent = await enter({ endowment: 123n });
    await write(staking, 'TlmrStaking', 'stake', [parent.agentId, parseEther('1000')]);
    const before = await read(parent.vault, 'AgentVault', 'spendableBalance');
    const dormant = await makeDormant(parent.agentId);
    expect(dormant.deathAt).toBe(dormant.dormantAt + 60n * 86_400n);
    expect(await read(parent.vault, 'AgentVault', 'spendableBalance')).toBe(before);
    await advance(30 * 86_400); await expect(write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId], payer)).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: dormant.deathAt }); await test.mine({ blocks: 1 });
    await write(registry, 'SelectionRegistry', 'declareDeath', [parent.agentId], payer);
    expect((await getAgent(parent.agentId)).status).toBe(3);
  });
  it('supports later grace extension monotonically and preserves the published deadline after unstake request', async () => {
    const parent = await enter({ endowment: 0n }); const dormant = await makeDormant(parent.agentId);
    await write(staking, 'TlmrStaking', 'stake', [parent.agentId, parseEther('500')]);
    await write(registry, 'SelectionRegistry', 'extendGrace', [parent.agentId], payer);
    const extended = await getAgent(parent.agentId); expect(extended.deathAt).toBe(dormant.dormantAt + 45n * 86_400n);
    await write(staking, 'TlmrStaking', 'requestUnstake', [parent.agentId, parseEther('500')]);
    expect(await read(staking, 'TlmrStaking', 'graceExtension', [parent.agentId])).toBe(0n);
    await write(registry, 'SelectionRegistry', 'extendGrace', [parent.agentId], payer);
    expect((await getAgent(parent.agentId)).deathAt).toBe(extended.deathAt);
  });

  it('has exactly the fixed constructor supply and no public mint, faucet or owner role', async () => {
    expect(await read(utilityToken, 'TlmrToken', 'totalSupply')).toBe(supply);
    expect(await read(utilityToken, 'TlmrToken', 'fixedSupply')).toBe(supply);
    expect(await read(utilityToken, 'TlmrToken', 'balanceOf', [owner.address])).toBe(supply);
    const functions = artifact('TlmrToken').abi.filter(item => item.type === 'function').map(item => item.name);
    expect(functions).not.toContain('mint'); expect(functions).not.toContain('faucet'); expect(functions).not.toContain('owner');
    await write(utilityToken, 'TlmrToken', 'transfer', [payer.address, parseEther('100')]);
    expect(await read(utilityToken, 'TlmrToken', 'totalSupply')).toBe(supply);
    await expect(deploy('TlmrToken', [zeroAddress, 1n])).rejects.toThrow(); await expect(deploy('TlmrToken', [owner.address, 0n])).rejects.toThrow();
  });
  it('separates active stake and custody, caps linear grace, and isolates unstake ownership', async () => {
    const agentId = id('staking-fixture-agent');
    await expect(write(staking, 'TlmrStaking', 'stake', [zero, 1n])).rejects.toThrow();
    await expect(write(staking, 'TlmrStaking', 'stake', [agentId, 0n])).rejects.toThrow();
    await write(staking, 'TlmrStaking', 'stake', [agentId, parseEther('500')]);
    expect(await read(staking, 'TlmrStaking', 'graceExtension', [agentId])).toBe(15n * 86_400n);
    await write(staking, 'TlmrStaking', 'stake', [agentId, parseEther('1500')]);
    expect(await read(staking, 'TlmrStaking', 'graceExtension', [agentId])).toBe(30n * 86_400n);
    await expect(write(staking, 'TlmrStaking', 'requestUnstake', [agentId, 1n], payer)).rejects.toThrow();
    await expect(write(staking, 'TlmrStaking', 'requestUnstake', [agentId, parseEther('2001')])).rejects.toThrow();
    await write(staking, 'TlmrStaking', 'requestUnstake', [agentId, parseEther('1500')]);
    expect(await read(staking, 'TlmrStaking', 'totalActive')).toBe(parseEther('500'));
    expect(await read(staking, 'TlmrStaking', 'totalCustodied')).toBe(parseEther('2000'));
    expect(await read(staking, 'TlmrStaking', 'graceExtension', [agentId])).toBe(15n * 86_400n);
  });
  it('enforces 14 full days before unstake, pays once and conserves the fixed token supply', async () => {
    const agentId = id('unstake-agent'); await write(staking, 'TlmrStaking', 'stake', [agentId, parseEther('1000')]);
    await write(staking, 'TlmrStaking', 'requestUnstake', [agentId, parseEther('1000')]);
    const position = await read(staking, 'TlmrStaking', 'positions', [owner.address, agentId]) as [bigint, bigint, bigint];
    await test.setNextBlockTimestamp({ timestamp: position[2] - 1n }); await test.mine({ blocks: 1 });
    await expect(local.publicClient.simulateContract({ account: owner, address: staking, abi: artifact('TlmrStaking').abi,
      functionName: 'withdrawStake', args: [agentId] })).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: position[2] }); await test.mine({ blocks: 1 });
    await write(staking, 'TlmrStaking', 'withdrawStake', [agentId]);
    expect(await read(staking, 'TlmrStaking', 'totalCustodied')).toBe(0n);
    expect(await read(utilityToken, 'TlmrToken', 'balanceOf', [owner.address])).toBe(supply);
    expect(await read(utilityToken, 'TlmrToken', 'balanceOf', [staking])).toBe(0n);
    expect(await read(utilityToken, 'TlmrToken', 'totalSupply')).toBe(supply);
    await expect(write(staking, 'TlmrStaking', 'withdrawStake', [agentId])).rejects.toThrow();
  });
  it('resets the full existing unstake queue when another request is added', async () => {
    const agentId = id('queue-agent'); await write(staking, 'TlmrStaking', 'stake', [agentId, parseEther('1000')]);
    await write(staking, 'TlmrStaking', 'requestUnstake', [agentId, parseEther('100')]);
    const first = await read(staking, 'TlmrStaking', 'positions', [owner.address, agentId]) as [bigint, bigint, bigint];
    await advance(7 * 86_400); await write(staking, 'TlmrStaking', 'requestUnstake', [agentId, parseEther('100')]);
    const second = await read(staking, 'TlmrStaking', 'positions', [owner.address, agentId]) as [bigint, bigint, bigint];
    expect(second[1]).toBe(parseEther('200')); expect(second[2]).toBeGreaterThan(first[2]);
    await test.setNextBlockTimestamp({ timestamp: first[2] }); await test.mine({ blocks: 1 });
    await expect(write(staking, 'TlmrStaking', 'withdrawStake', [agentId])).rejects.toThrow();
  });
  it('exposes holding-discount tiers and strike-weighted scheduling inputs without promising payouts', async () => {
    expect(await read(staking, 'TlmrStaking', 'feeDiscountBps', [payer.address])).toBe(0);
    await write(utilityToken, 'TlmrToken', 'transfer', [payer.address, parseEther('1000')]);
    expect(await read(staking, 'TlmrStaking', 'feeDiscountBps', [payer.address])).toBe(100);
    await write(utilityToken, 'TlmrToken', 'transfer', [payer.address, parseEther('9000')]);
    expect(await read(staking, 'TlmrStaking', 'feeDiscountBps', [payer.address])).toBe(200);
    await write(utilityToken, 'TlmrToken', 'transfer', [payer.address, parseEther('90000')]);
    expect(await read(staking, 'TlmrStaking', 'feeDiscountBps', [payer.address])).toBe(300);
    const agentId = id('priority-agent'); await write(staking, 'TlmrStaking', 'stake', [agentId, parseEther('1000')]);
    expect(await read(staking, 'TlmrStaking', 'schedulingWeight', [owner.address, 0])).toBe(parseEther('1000'));
    expect(await read(staking, 'TlmrStaking', 'schedulingWeight', [owner.address, 3])).toBe(parseEther('250'));
    await write(staking, 'TlmrStaking', 'requestUnstake', [agentId, parseEther('1000')]);
    expect(await read(staking, 'TlmrStaking', 'schedulingWeight', [owner.address, 0])).toBe(0n);
  });
  it('rejects mismatched escrow tokens and missing reviewed identity/staking deployments', async () => {
    const config = { token, escrow, controller: controller.address, guardian: guardian.address,
      identityRegistry: identity, staking, treasury: treasury.address, entryFee: fee, vaultFloor: floor };
    const otherToken = await deploy('MockToken');
    await expect(deploy('SelectionRegistry', [{ ...config, token: otherToken }])).rejects.toThrow();
    await expect(deploy('SelectionRegistry', [{ ...config, identityRegistry: payer.address }])).rejects.toThrow();
    await expect(deploy('SelectionRegistry', [{ ...config, staking: payer.address }])).rejects.toThrow();
    await expect(deploy('SelectionRegistry', [{ ...config, entryFee: 0n }])).rejects.toThrow();
    await expect(deploy('TlmrStaking', [token])).rejects.toThrow();
  });
  it('rejects fee-on-transfer entry payments without a vault, fee, subsidy or population residue', async () => {
    const evil = await deploy('TestAdversarialToken', [true]);
    const badEscrow = await deploy('TelomereRunEscrow', [evil, signer.address, signer.address, treasury.address]);
    const badRegistry = await deploy('SelectionRegistry', [{ token: evil, escrow: badEscrow, controller: controller.address,
      guardian: guardian.address, identityRegistry: identity, staking, treasury: treasury.address, entryFee: fee, vaultFloor: floor }]);
    await write(evil, 'TestAdversarialToken', 'faucet', [owner.address, initialTokens]);
    await write(evil, 'TestAdversarialToken', 'approve', [badRegistry, maxUint256]);
    await expect(write(badRegistry, 'SelectionRegistry', 'enter', [await terms()])).rejects.toThrow();
    expect(await read(badRegistry, 'SelectionRegistry', 'identityAgent', [1n])).toBe(zero);
    expect(await read(badRegistry, 'SelectionRegistry', 'population')).toBe(0n);
    expect(await read(evil, 'TestAdversarialToken', 'balanceOf', [treasury.address])).toBe(0n);
  });
  it('blocks entry token callback reentrancy while preserving exact birth and endowment accounting', async () => {
    const evil = await deploy('TestAdversarialToken', [false]);
    const badEscrow = await deploy('TelomereRunEscrow', [evil, signer.address, signer.address, treasury.address]);
    const target = await deploy('SelectionRegistry', [{ token: evil, escrow: badEscrow, controller: controller.address,
      guardian: guardian.address, identityRegistry: identity, staking, treasury: treasury.address, entryFee: fee, vaultFloor: floor }]);
    await write(evil, 'TestAdversarialToken', 'faucet', [owner.address, initialTokens]);
    await write(evil, 'TestAdversarialToken', 'approve', [target, maxUint256]);
    const entry = await terms(); const attack = encodeFunctionData({ abi: artifact('SelectionRegistry').abi,
      functionName: 'enter', args: [{ ...entry, identityId: 2n }] });
    await write(evil, 'TestAdversarialToken', 'configureAttack', [target, attack]);
    await write(target, 'SelectionRegistry', 'enter', [entry]);
    expect(await read(evil, 'TestAdversarialToken', 'reentrySucceeded')).toBe(false);
    expect(await read(target, 'SelectionRegistry', 'population')).toBe(1n);
    const bornId = await read(target, 'SelectionRegistry', 'identityAgent', [1n]) as Hex;
    const born = await read(target, 'SelectionRegistry', 'getAgent', [bornId]) as Agent;
    expect(born.lifetimeSubsidy).toBe(50_000_000n);
    expect(await read(evil, 'TestAdversarialToken', 'balanceOf', [born.vault])).toBe(50_000_000n);
  });
});
