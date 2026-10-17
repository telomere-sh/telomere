import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, encodeAbiParameters, getContractAddress, hashTypedData, http, keccak256,
  maxUint256, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../scripts/local-chain.js';
import { projectRoot } from '../scripts/compile-contracts.js';
import { localChain } from '../src/chain/chains.js';

type Artifact = { abi: Abi; bytecode: Hex; runtimeBytes: number };
type Account = ReturnType<typeof privateKeyToAccount>;
type Quote = { runId: Hex; leashId: Hex; hostId: Hex; payer: Address; hwClass: number; regionHash: Hex;
  imageHash: Hex; workloadHash: Hex; maxSeconds: bigint; pricePerSecond: bigint; inferencePrice: bigint; quoteExpiry: bigint };
type Settlement = { runId: Hex; billableSeconds: bigint; endedAt: bigint; inferenceCharge: bigint; receiptHash: Hex };
type LeashTerms = { agent: Address; maxPerHour: bigint; maxPerDay: bigint; classMask: bigint; sealedOnly: boolean;
  imageAllowRoot: Hex; regionAllowRoot: Hex; expiry: bigint };
type Run = { status: number; ceiling: bigint; openedAt: bigint; maxSeconds: bigint; hostReleased: boolean;
  billableSeconds: bigint; inferenceCharge: bigint; receiptHash: Hex; stopAt: bigint };
const id = (text: string): Hex => keccak256(toHex(text));
const zero = `0x${'00'.repeat(32)}` as Hex;
const allowLeaf = (value: Hex) => keccak256(keccak256(encodeAbiParameters([{ type: 'bytes32' }], [value])));
const pair = (a: Hex, b: Hex): Hex => keccak256(`0x${[a, b].sort().map(value => value.slice(2)).join('')}`);
const quoteTypes = { PlatformQuote: [
  { name: 'runId', type: 'bytes32' }, { name: 'leashId', type: 'bytes32' }, { name: 'hostId', type: 'bytes32' },
  { name: 'payer', type: 'address' }, { name: 'hwClass', type: 'uint16' }, { name: 'regionHash', type: 'bytes32' },
  { name: 'imageHash', type: 'bytes32' }, { name: 'workloadHash', type: 'bytes32' }, { name: 'maxSeconds', type: 'uint64' },
  { name: 'pricePerSecond', type: 'uint96' }, { name: 'inferencePrice', type: 'uint96' }, { name: 'quoteExpiry', type: 'uint64' },
] } as const;

function compilePlatformEscrow(): Record<string, Artifact> {
  const paths = ['contracts/PlatformRunEscrow.sol', 'contracts/HostRegistry.sol', 'contracts/ReceiptRoot.sol',
    'contracts/FeeRouter.sol', 'contracts/MockToken.sol', 'contracts/TestAdversarialToken.sol'];
  const fixturePath = 'tests/FailingPlatformHostRegistry.sol';
  const sources = { ...Object.fromEntries(paths.map(path => [path, { content: readFileSync(resolve(projectRoot, path), 'utf8') }])),
    [fixturePath]: { content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {HostRegistry} from "contracts/HostRegistry.sol";
// Local-only fault injection adapter. Production tests use the actual registry.
contract FailingPlatformHostRegistry {
    address public immutable token; address public immutable controller; address public immutable evidenceRoot;
    address public immutable operator; uint8 public failure; uint64 public openRuns;
    mapping(bytes32 => bool) public runOpen;
    constructor(address token_, address controller_, address root_, address operator_) {
        require(block.chainid == 31337, "local fixture only"); token=token_; controller=controller_; evidenceRoot=root_; operator=operator_;
    }
    function setFailure(uint8 value) external { failure=value; }
    function getHost(bytes32 hostId) external view returns (HostRegistry.Host memory host) {
        if (hostId != bytes32(0)) host=HostRegistry.Host(operator, bytes32(uint256(1)), 0, bytes32(0), 300000000, 0, 0, true, false, openRuns);
    }
    function openRun(bytes32, bytes32 runId) external {
        require(msg.sender == controller && failure != 4 && !runOpen[runId], "open fixture failure");
        runOpen[runId]=true; openRuns+=1;
    }
    function closeRun(bytes32 runId) external {
        require(msg.sender == controller && runOpen[runId], "close fixture authority");
        if (failure == 1) revert("close fixture failure");
        if (failure == 2) { assembly { revert(0, 1048576) } }
        if (failure == 3) { while (gasleft() > 0) {} }
        runOpen[runId]=false; openRuns-=1;
    }
}
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract MutablePlatformToken is ERC20 {
    bool public feeMode;
    constructor() ERC20("Local Platform Fault Token", "PFAULT") { require(block.chainid == 31337, "local fixture only"); }
    function decimals() public pure override returns (uint8) { return 6; }
    function faucet(address to, uint256 amount) external { _mint(to, amount); }
    function setFee(bool active) external { feeMode = active; }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool result = super.transferFrom(from, to, amount); if (feeMode && amount != 0) _burn(to, 1); return result;
    }
}` } };
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (path: string) => {
    if (!path.startsWith('@openzeppelin/contracts/') || path.includes('..')) return { error: 'Unsupported import' };
    return { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') };
  } })) as { errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  const failures = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join('\n'));
  return Object.fromEntries([...paths, fixturePath].flatMap(path => Object.entries(output.contracts[path] ?? {}).map(([name, value]) =>
    [name, { abi: value.abi, bytecode: `0x${value.evm.bytecode.object}` as Hex, runtimeBytes: value.evm.deployedBytecode.object.length / 2 }])));
}

describe('platform escrow atomic host admission, receipted fees and independent refunds', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>; let test: ReturnType<typeof createTestClient>;
  let artifacts: Record<string, Artifact>; let owner: Account; let signer: Account; let guardian: Account;
  let agent: Account; let outsider: Account; let hostOperator: Account; let gpuOperator: Account; let sealedOperator: Account;
  let treasury: Account; let stakers: Account; let burn: Account;
  let token: Address; let signers: Address; let roots: Address; let hostRegistry: Address; let router: Address; let escrow: Address;
  let cpuHost: Hex; let gpuHost: Hex; let sealedHost: Hex; let snapshot: Hex;
  const leashId = id('platform-leash'); const image = id('approved-image'); const region = id('approved-region');
  const deposit = 50_000_000n;

  function artifact(name: string) { const found = artifacts[name]; if (!found) throw new Error(`Missing ${name}`); return found; }
  async function deploy(name: string, args: readonly unknown[] = []) {
    const compiled = artifact(name); const wallet = createWalletClient({ account: owner, chain: localChain, transport: http(local.rpcUrl) });
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode, args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = owner, gas?: bigint) {
    const wallet = createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl) });
    const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, ...(gas ? { gas } : {}) });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    return receipt;
  }
  async function read(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<unknown> {
    return local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args });
  }
  async function now() { return (await local.publicClient.getBlock()).timestamp; }
  async function advance(seconds: number) { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); }
  async function balance(address: Address, tokenAddress = token) { return read(tokenAddress, 'MockToken', 'balanceOf', [address]) as Promise<bigint>; }
  async function available(address = owner.address, escrowAddress = escrow) {
    return read(escrowAddress, 'PlatformRunEscrow', 'availableBalance', [address]) as Promise<bigint>;
  }
  async function terms(overrides: Partial<LeashTerms> = {}): Promise<LeashTerms> {
    return { agent: agent.address, maxPerHour: 100_000_000n, maxPerDay: 1_000_000_000n, classMask: 7n,
      sealedOnly: false, imageAllowRoot: allowLeaf(image), regionAllowRoot: allowLeaf(region),
      expiry: await now() + 30n * 86_400n, ...overrides };
  }
  async function quote(overrides: Partial<Quote> = {}): Promise<Quote> {
    return { runId: id(`platform-run-${Math.random()}`), leashId, hostId: cpuHost, payer: owner.address, hwClass: 0,
      regionHash: region, imageHash: image, workloadHash: id('workload'), maxSeconds: 10n,
      pricePerSecond: 100_000n, inferencePrice: 0n, quoteExpiry: await now() + 300n, ...overrides };
  }
  function typed(q: Quote, escrowAddress = escrow, chainId = 31337) {
    return { domain: { name: 'TelomerePlatformEscrow', version: '1', chainId, verifyingContract: escrowAddress },
      types: quoteTypes, primaryType: 'PlatformQuote' as const, message: q };
  }
  async function open(q: Quote, account = agent, signature?: Hex, imageProof: Hex[] = [], regionProof: Hex[] = [], escrowAddress = escrow) {
    return write(escrowAddress, 'PlatformRunEscrow', 'openRun', [q, signature ?? await signer.signTypedData(typed(q, escrowAddress)), imageProof, regionProof], account);
  }
  async function run(runId: Hex, escrowAddress = escrow) { return read(escrowAddress, 'PlatformRunEscrow', 'getRun', [runId]) as Promise<Run>; }
  async function settlement(q: Quote, overrides: Partial<Settlement> = {}): Promise<Settlement> {
    return { runId: q.runId, billableSeconds: 3n, endedAt: await now(), inferenceCharge: 0n,
      receiptHash: id(`platform-receipt-${q.runId}`), ...overrides };
  }
  async function leaf(s: Settlement, escrowAddress = escrow) { return read(escrowAddress, 'PlatformRunEscrow', 'receiptLeaf', [s]) as Promise<Hex>; }
  async function publish(s: Settlement, escrowAddress = escrow) {
    const h = s.endedAt / 3_600n; const nextHour = (h + 1n) * 3_600n;
    if (await now() < nextHour) { await test.setNextBlockTimestamp({ timestamp: nextHour }); await test.mine({ blocks: 1 }); }
    await write(roots, 'ReceiptRoot', 'postRoot', [h, await leaf(s, escrowAddress), 1], signer);
    return h;
  }
  async function settle(s: Settlement, hour: bigint, proof: Hex[] = [], escrowAddress = escrow) {
    return write(escrowAddress, 'PlatformRunEscrow', 'settleRun', [s, hour, proof], outsider);
  }
  async function assertBacking(escrowAddress = escrow) {
    const totalAvailable = await read(escrowAddress, 'PlatformRunEscrow', 'totalAvailable') as bigint;
    const totalReserved = await read(escrowAddress, 'PlatformRunEscrow', 'totalReserved') as bigint;
    expect(await balance(escrowAddress)).toBe(totalAvailable + totalReserved);
  }
  async function faultDeployment() {
    const nonce = await local.publicClient.getTransactionCount({ address: owner.address });
    const predicted = getContractAddress({ from: owner.address, nonce: BigInt(nonce) + 2n });
    const fixture = await deploy('FailingPlatformHostRegistry', [token, predicted, roots, hostOperator.address]);
    const faultRouter = await deploy('FeeRouter', [token, predicted, owner.address, treasury.address, stakers.address, burn.address]);
    const faultEscrow = await deploy('PlatformRunEscrow', [{ token, quoteSigner: signer.address, receiptRoot: roots,
      hostRegistry: fixture, feeRouter: faultRouter, guardian: guardian.address }]);
    expect(faultEscrow.toLowerCase()).toBe(predicted.toLowerCase());
    await write(token, 'MockToken', 'approve', [faultEscrow, maxUint256]);
    await write(faultEscrow, 'PlatformRunEscrow', 'deposit', [deposit]);
    await write(faultEscrow, 'PlatformRunEscrow', 'createLeash', [leashId, await terms()]);
    return { fixture, faultRouter, faultEscrow };
  }
  async function tokenBoundDeployment(tokenAddress: Address) {
    const nonce = await local.publicClient.getTransactionCount({ address: owner.address });
    const predicted = getContractAddress({ from: owner.address, nonce: BigInt(nonce) + 2n });
    const boundRegistry = await deploy('HostRegistry', [tokenAddress, predicted, guardian.address, treasury.address, roots]);
    const boundRouter = await deploy('FeeRouter', [tokenAddress, predicted, owner.address, treasury.address, stakers.address, burn.address]);
    const boundEscrow = await deploy('PlatformRunEscrow', [{ token: tokenAddress, quoteSigner: signer.address, receiptRoot: roots,
      hostRegistry: boundRegistry, feeRouter: boundRouter, guardian: guardian.address }]);
    for (const account of [owner, hostOperator]) {
      await write(tokenAddress, 'MutablePlatformToken', 'faucet', [account.address, 10_000_000_000n]);
      await write(tokenAddress, 'MutablePlatformToken', 'approve', [boundRegistry, maxUint256], account);
    }
    await write(boundRegistry, 'HostRegistry', 'register', [id('bound-host'), 0, zero, 300_000_000n, false], hostOperator);
    const boundHost = await read(boundRegistry, 'HostRegistry', 'operatorHost', [hostOperator.address]) as Hex;
    await write(tokenAddress, 'MutablePlatformToken', 'approve', [boundEscrow, maxUint256]);
    await write(boundEscrow, 'PlatformRunEscrow', 'deposit', [deposit]);
    await write(boundEscrow, 'PlatformRunEscrow', 'createLeash', [leashId, await terms()]);
    return { boundRegistry, boundRouter, boundEscrow, boundHost };
  }

  beforeAll(async () => {
    artifacts = compilePlatformEscrow(); local = await startLocalChain();
    test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    [owner, signer, guardian, agent, outsider, hostOperator, gpuOperator, sealedOperator, treasury, stakers, burn] =
      Array.from({ length: 11 }, () => privateKeyToAccount(generatePrivateKey())) as
      [Account, Account, Account, Account, Account, Account, Account, Account, Account, Account, Account];
    for (const account of [owner, signer, guardian, agent, outsider, hostOperator, gpuOperator, sealedOperator, treasury, stakers, burn]) {
      await test.setBalance({ address: account.address, value: parseEther('10') });
    }
    token = await deploy('MockToken'); signers = await deploy('SignerSet', [owner.address, signer.address]);
    roots = await deploy('ReceiptRoot', [signers]);
    const nonce = await local.publicClient.getTransactionCount({ address: owner.address });
    const predicted = getContractAddress({ from: owner.address, nonce: BigInt(nonce) + 2n });
    hostRegistry = await deploy('HostRegistry', [token, predicted, guardian.address, treasury.address, roots]);
    router = await deploy('FeeRouter', [token, predicted, owner.address, treasury.address, stakers.address, burn.address]);
    escrow = await deploy('PlatformRunEscrow', [{ token, quoteSigner: signer.address, receiptRoot: roots,
      hostRegistry, feeRouter: router, guardian: guardian.address }]);
    expect(escrow.toLowerCase()).toBe(predicted.toLowerCase());
    for (const account of [owner, hostOperator, gpuOperator, sealedOperator]) {
      await write(token, 'MockToken', 'faucet', [account.address, 10_000_000_000n]);
      await write(token, 'MockToken', 'approve', [hostRegistry, maxUint256], account);
    }
    await write(hostRegistry, 'HostRegistry', 'register', [id('cpu-key'), 0, zero, 300_000_000n, false], hostOperator);
    cpuHost = await read(hostRegistry, 'HostRegistry', 'operatorHost', [hostOperator.address]) as Hex;
    await write(hostRegistry, 'HostRegistry', 'register', [id('gpu-key'), 0, zero, 1_500_000_000n, true], gpuOperator);
    gpuHost = await read(hostRegistry, 'HostRegistry', 'operatorHost', [gpuOperator.address]) as Hex;
    await write(hostRegistry, 'HostRegistry', 'register', [id('sealed-key'), 2, id('tee-measurement'), 1_500_000_000n, true], sealedOperator);
    sealedHost = await read(hostRegistry, 'HostRegistry', 'operatorHost', [sealedOperator.address]) as Hex;
    await write(token, 'MockToken', 'approve', [escrow, maxUint256]); await write(escrow, 'PlatformRunEscrow', 'deposit', [deposit]);
    await write(escrow, 'PlatformRunEscrow', 'createLeash', [leashId, await terms()]); snapshot = await test.snapshot();
  }, 60_000);
  beforeEach(async () => { await test.revert({ id: snapshot }); snapshot = await test.snapshot(); });
  afterAll(async () => { if (local) await local.close(); });

  it('deploys under EIP-170 with exact pinned controller/token/root coupling and typed quote digest', async () => {
    expect(artifact('PlatformRunEscrow').runtimeBytes).toBeLessThanOrEqual(24_576);
    expect((await read(hostRegistry, 'HostRegistry', 'controller') as string).toLowerCase()).toBe(escrow.toLowerCase());
    expect((await read(router, 'FeeRouter', 'controller') as string).toLowerCase()).toBe(escrow.toLowerCase());
    const q = await quote(); expect(await read(escrow, 'PlatformRunEscrow', 'quoteDigest', [q])).toBe(hashTypedData(typed(q)));
    expect(await read(escrow, 'PlatformRunEscrow', 'allowLeaf', [image])).toBe(allowLeaf(image)); await assertBacking();
  });
  it('enforces the fee-inclusive 250 USDC run ceiling at its exact boundary', async () => {
    await write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({ maxPerHour: 250_000_000n })]);
    await write(escrow, 'PlatformRunEscrow', 'deposit', [200_000_000n]);
    const accepted = await quote({ maxSeconds: 1n, pricePerSecond: 229_357_798n });
    expect(await read(escrow, 'PlatformRunEscrow', 'quoteCeiling', [accepted, false])).toBe(250_000_000n);
    await open(accepted);
    expect(await available()).toBe(0n);
    const rejected = await quote({ maxSeconds: 1n, pricePerSecond: 229_357_799n });
    await expect(read(escrow, 'PlatformRunEscrow', 'quoteCeiling', [rejected, false])).rejects.toThrow();
    await expect(open(rejected)).rejects.toThrow();
    await assertBacking();
  });
  it('caps new and updated Leashes at 1,000 USDC per day', async () => {
    const exact = await terms({ maxPerHour: 1_000_000_000n, maxPerDay: 1_000_000_000n });
    const otherId = id('exact-day-leash');
    await write(escrow, 'PlatformRunEscrow', 'createLeash', [otherId, exact]);
    expect((await read(escrow, 'PlatformRunEscrow', 'getLeash', [otherId]) as { maxPerDay: bigint }).maxPerDay).toBe(1_000_000_000n);
    await expect(write(escrow, 'PlatformRunEscrow', 'createLeash', [id('over-day-leash'),
      { ...exact, maxPerDay: 1_000_000_001n }])).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, exact]);
    await expect(write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId,
      { ...exact, maxPerDay: 1_000_000_001n }])).rejects.toThrow();
    expect((await read(escrow, 'PlatformRunEscrow', 'getLeash', [leashId]) as { maxPerDay: bigint }).maxPerDay).toBe(1_000_000_000n);
  });
  it('caps aggregate available plus reserved escrow at 500,000 USDC and releases room on withdrawal', async () => {
    await open(await quote());
    const remaining = 500_000_000_000n - deposit;
    await write(token, 'MockToken', 'faucet', [owner.address, remaining]);
    await write(escrow, 'PlatformRunEscrow', 'deposit', [remaining]);
    expect(await read(escrow, 'PlatformRunEscrow', 'totalAvailable')).toBe(500_000_000_000n - 1_090_000n);
    expect(await read(escrow, 'PlatformRunEscrow', 'totalReserved')).toBe(1_090_000n);
    await expect(write(escrow, 'PlatformRunEscrow', 'deposit', [1n])).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrow', 'withdraw', [1n]);
    await write(escrow, 'PlatformRunEscrow', 'deposit', [1n]);
    await assertBacking();
  });
  it('atomically opens a CPU host run with base-plus-9% ceiling and actual collateral open-run count', async () => {
    const q = await quote(); await open(q);
    expect(await available()).toBe(deposit - 1_090_000n); expect((await run(q.runId)).ceiling).toBe(1_090_000n);
    expect((await read(hostRegistry, 'HostRegistry', 'getHost', [cpuHost]) as { openRuns: bigint }).openRuns).toBe(1n);
    expect((await read(escrow, 'PlatformRunEscrow', 'getLeash', [leashId]) as { pending: bigint }).pending).toBe(1_090_000n);
    await expect(write(hostRegistry, 'HostRegistry', 'requestUnbond', [], hostOperator)).rejects.toThrow(); await assertBacking();
  });
  it('honors image and region sorted-pair allowlists and rejects changed scope/proofs before reserving', async () => {
    const imageOther = id('other-image'); const regionOther = id('other-region');
    await write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({
      imageAllowRoot: pair(allowLeaf(image), allowLeaf(imageOther)), regionAllowRoot: pair(allowLeaf(region), allowLeaf(regionOther)),
    })]);
    const q = await quote(); await expect(open(q)).rejects.toThrow();
    await expect(open(q, agent, undefined, [id('bad')], [allowLeaf(regionOther)])).rejects.toThrow();
    await open(q, agent, undefined, [allowLeaf(imageOther)], [allowLeaf(regionOther)]);
    await expect(open(await quote({ imageHash: id('forbidden') }), agent, undefined, [allowLeaf(imageOther)], [allowLeaf(regionOther)])).rejects.toThrow();
    await assertBacking();
  });
  it('enforces class masks, CPU-vs-GPU eligibility and sealed-only with the correct 12% fee', async () => {
    await expect(open(await quote({ hwClass: 1 }))).rejects.toThrow();
    await expect(open(await quote({ hwClass: 64, hostId: gpuHost }))).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({ classMask: 4n, sealedOnly: true })]);
    await expect(open(await quote({ hostId: gpuHost, hwClass: 2 }))).rejects.toThrow();
    await expect(open(await quote({ hostId: sealedHost, hwClass: 1 }))).rejects.toThrow();
    const q = await quote({ hostId: sealedHost, hwClass: 2 }); await open(q);
    expect((await run(q.runId)).ceiling).toBe(1_120_000n); await assertBacking();
  });
  it('rejects inactive/unbonding/unknown hosts and quote signature/payer/price/chain substitutions', async () => {
    const q = await quote(); const signature = await signer.signTypedData(typed(q));
    await expect(open({ ...q, payer: outsider.address }, agent, signature)).rejects.toThrow();
    await expect(open({ ...q, pricePerSecond: 100_001n }, agent, signature)).rejects.toThrow();
    await expect(open(q, outsider, signature)).rejects.toThrow();
    await expect(open(q, agent, await signer.signTypedData(typed(q, escrow, 84532)))).rejects.toThrow();
    await expect(open(await quote({ hostId: id('unknown-host') }))).rejects.toThrow();
    await write(hostRegistry, 'HostRegistry', 'requestUnbond', [], hostOperator);
    await expect(open(q)).rejects.toThrow(); expect(await available()).toBe(deposit); await assertBacking();
  });
  it('carries pending ceilings across hour/day changes and prevents cap reductions or scope changes under reservations', async () => {
    await write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({ maxPerHour: 1_090_000n, maxPerDay: 2_180_000n })]);
    const q = await quote(); await open(q); await advance(86_401);
    await expect(open(await quote())).rejects.toThrow();
    await expect(write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({ maxPerHour: 1_089_999n })])).rejects.toThrow();
    await expect(write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({ classMask: 1n })])).rejects.toThrow();
    const state = await read(escrow, 'PlatformRunEscrow', 'getLeash', [leashId]) as { pending: bigint; spentHour: bigint; spentDay: bigint };
    expect(state.pending).toBe(1_090_000n); expect(state.spentHour).toBe(0n); expect(state.spentDay).toBe(0n); await assertBacking();
  });
  it('requires a closed-hour full settlement leaf and rejects missing/wrong proofs and billed-field substitution', async () => {
    const q = await quote(); await open(q); await advance(3); const s = await settlement(q); const h = s.endedAt / 3_600n;
    await expect(settle(s, h)).rejects.toThrow(); await publish(s);
    await expect(settle({ ...s, billableSeconds: 4n }, h)).rejects.toThrow();
    await expect(settle({ ...s, receiptHash: id('changed-receipt') }, h)).rejects.toThrow();
    await expect(settle(s, h, [id('wrong-proof')])).rejects.toThrow();
    await expect(settle(s, h - 1n)).rejects.toThrow();
    expect((await run(q.runId)).status).toBe(1); expect(await balance(router)).toBe(0n); await assertBacking();
  });
  it('settles only proven seconds, closes the real host and funds full posted price plus 9% without losing refund units', async () => {
    const q = await quote(); await open(q); await advance(3); const s = await settlement(q); const h = await publish(s); await settle(s, h);
    const w = await now() / 604_800n;
    expect((await run(q.runId)).status).toBe(2); expect((await run(q.runId)).hostReleased).toBe(true);
    expect(await read(router, 'FeeRouter', 'hostAccrued', [w, hostOperator.address])).toBe(300_000n);
    expect(await balance(router)).toBe(327_000n); expect(await available()).toBe(deposit - 327_000n);
    expect((await read(hostRegistry, 'HostRegistry', 'getHost', [cpuHost]) as { openRuns: bigint }).openRuns).toBe(0n);
    expect(await read(router, 'FeeRouter', 'getBuckets', [w])).toEqual({ work: 21_600n, treasury: 2_700n, stakers: 1_350n, buyAndBurn: 1_350n });
    await write(escrow, 'PlatformRunEscrow', 'withdraw', [deposit - 327_000n]); expect(await balance(escrow)).toBe(0n);
    await write(hostRegistry, 'HostRegistry', 'requestUnbond', [], hostOperator); await assertBacking();
  });
  it('settles sealed-host inference receipts at 12% and rejects partial or invented inference charges', async () => {
    const q = await quote({ hostId: sealedHost, hwClass: 2, inferencePrice: 200_000n }); await open(q); await advance(3);
    const s = await settlement(q, { inferenceCharge: 200_000n }); const h = await publish(s);
    await expect(settle({ ...s, inferenceCharge: 199_999n }, h)).rejects.toThrow();
    await settle(s, h); expect(await balance(router)).toBe(560_000n); expect(await available()).toBe(deposit - 560_000n);
    const w = await now() / 604_800n; expect(await read(router, 'FeeRouter', 'hostAccrued', [w, sealedOperator.address])).toBe(500_000n); await assertBacking();
  });
  it('has zero fee and no fake host credit for proven zero-charge settlement', async () => {
    const q = await quote(); await open(q); const s = await settlement(q, { billableSeconds: 0n }); const h = await publish(s); await settle(s, h);
    expect(await available()).toBe(deposit); expect(await balance(router)).toBe(0n);
    expect((await read(hostRegistry, 'HostRegistry', 'getHost', [cpuHost]) as { openRuns: bigint }).openRuns).toBe(0n);
    expect(await read(escrow, 'PlatformRunEscrow', 'usedReceiptHash', [s.receiptHash])).toBe(true); await assertBacking();
  });
  it('guardian pauses only new opens while valid settlement and owner withdrawals remain available', async () => {
    const q = await quote(); await open(q); await advance(3); const s = await settlement(q);
    await expect(write(escrow, 'PlatformRunEscrow', 'setOpensPaused', [true], outsider)).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrow', 'setOpensPaused', [true], guardian);
    await expect(open(await quote())).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrow', 'withdraw', [deposit - 1_090_000n]);
    const h = await publish(s); await settle(s, h); expect(await available()).toBe(763_000n); await assertBacking();
  });
  it('owner stop/kill enforces the accepted time boundary but cannot erase receipted accepted charges', async () => {
    const q = await quote(); await open(q); await advance(2); const stoppedAt = await now();
    await write(escrow, 'PlatformRunEscrow', 'requestStop', [q.runId]); await write(escrow, 'PlatformRunEscrow', 'killLeash', [leashId]);
    await expect(open(await quote())).rejects.toThrow();
    const s = await settlement(q, { billableSeconds: 2n, endedAt: stoppedAt }); const h = await publish(s);
    await expect(settle({ ...s, billableSeconds: 4n }, h)).rejects.toThrow(); await settle(s, h);
    expect(await balance(router)).toBe(218_000n); expect(await available()).toBe(deposit - 218_000n); await assertBacking();
  });
  it('permissionless timeout refund returns full ceiling and closes the actual host even while paused/killed', async () => {
    const q = await quote(); await open(q);
    await write(escrow, 'PlatformRunEscrow', 'setOpensPaused', [true], guardian); await write(escrow, 'PlatformRunEscrow', 'killLeash', [leashId]);
    await expect(write(escrow, 'PlatformRunEscrow', 'refundRun', [q.runId], outsider)).rejects.toThrow();
    const boundary = await read(escrow, 'PlatformRunEscrow', 'refundAt', [q.runId]) as bigint;
    await test.setNextBlockTimestamp({ timestamp: boundary }); await test.mine({ blocks: 1 });
    await write(escrow, 'PlatformRunEscrow', 'refundRun', [q.runId], outsider);
    expect(await available()).toBe(deposit); expect((await run(q.runId)).hostReleased).toBe(true);
    expect((await read(hostRegistry, 'HostRegistry', 'getHost', [cpuHost]) as { openRuns: bigint }).openRuns).toBe(0n);
    await write(escrow, 'PlatformRunEscrow', 'withdraw', [deposit]); await assertBacking();
  });
  it('refunds reject one second early, succeed at the exact boundary, and prevent later settlement/replay', async () => {
    const q = await quote(); await open(q); await advance(3); const s = await settlement(q); const h = await publish(s);
    const boundary = await read(escrow, 'PlatformRunEscrow', 'refundAt', [q.runId]) as bigint;
    await test.setNextBlockTimestamp({ timestamp: boundary - 1n }); await test.mine({ blocks: 1 });
    await expect(local.publicClient.simulateContract({ account: outsider, address: escrow, abi: artifact('PlatformRunEscrow').abi,
      functionName: 'refundRun', args: [q.runId] })).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: boundary }); await test.mine({ blocks: 1 });
    await expect(settle(s, h)).rejects.toThrow(); await write(escrow, 'PlatformRunEscrow', 'refundRun', [q.runId], outsider);
    await expect(write(escrow, 'PlatformRunEscrow', 'refundRun', [q.runId], outsider)).rejects.toThrow();
    await expect(settle(s, h)).rejects.toThrow(); await expect(open(q)).rejects.toThrow(); await assertBacking();
  });
  it('atomically settles a bounded batch through real host/router hooks with sorted-pair proofs', async () => {
    const a = await quote(); const b = await quote({ hostId: gpuHost, hwClass: 1 }); await open(a); await open(b); await advance(3);
    const sa = await settlement(a); const sb = await settlement(b); const la = await leaf(sa); const lb = await leaf(sb);
    const h = sa.endedAt / 3_600n; await test.setNextBlockTimestamp({ timestamp: (h + 1n) * 3_600n }); await test.mine({ blocks: 1 });
    await write(roots, 'ReceiptRoot', 'postRoot', [h, pair(la, lb), 2], signer);
    await expect(write(escrow, 'PlatformRunEscrow', 'settleBatch', [[{ settlement: sa, hour: h, proof: [lb] },
      { settlement: { ...sb, billableSeconds: 4n }, hour: h, proof: [la] }]], outsider)).rejects.toThrow();
    expect((await run(a.runId)).status).toBe(1); expect(await balance(router)).toBe(0n);
    await write(escrow, 'PlatformRunEscrow', 'settleBatch', [[{ settlement: sa, hour: h, proof: [lb] }, { settlement: sb, hour: h, proof: [la] }]], outsider);
    expect(await balance(router)).toBe(654_000n); expect(await available()).toBe(deposit - 654_000n); await assertBacking();
  });
  it('rejects empty/oversized batches and receipt reuse across distinct proven runs without partial payment', async () => {
    await expect(write(escrow, 'PlatformRunEscrow', 'settleBatch', [[]], outsider)).rejects.toThrow();
    const a = await quote(); const b = await quote(); await open(a); await open(b); await advance(3);
    const sa = await settlement(a); const sb = await settlement(b, { receiptHash: sa.receiptHash });
    const la = await leaf(sa); const lb = await leaf(sb); const h = sa.endedAt / 3_600n;
    await test.setNextBlockTimestamp({ timestamp: (h + 1n) * 3_600n }); await test.mine({ blocks: 1 });
    await write(roots, 'ReceiptRoot', 'postRoot', [h, pair(la, lb), 2], signer);
    const input = { settlement: sa, hour: h, proof: [lb] };
    await expect(write(escrow, 'PlatformRunEscrow', 'settleBatch', [Array.from({ length: 33 }, () => input)], outsider)).rejects.toThrow();
    await expect(write(escrow, 'PlatformRunEscrow', 'settleBatch', [[input, { settlement: sb, hour: h, proof: [la] }]], outsider)).rejects.toThrow();
    expect(await balance(router)).toBe(0n); expect((await run(a.runId)).status).toBe(1); await assertBacking();
  });
  it('open-hook failure rolls back reservations and settlement-hook failure rolls back registry/router/money changes', async () => {
    const fault = await faultDeployment(); const q = await quote({ hostId: id('fixture-host') });
    await write(fault.fixture, 'FailingPlatformHostRegistry', 'setFailure', [4]);
    await expect(open(q, agent, undefined, [], [], fault.faultEscrow)).rejects.toThrow();
    expect(await available(owner.address, fault.faultEscrow)).toBe(deposit); await assertBacking(fault.faultEscrow);
    await write(fault.fixture, 'FailingPlatformHostRegistry', 'setFailure', [0]); await open(q, agent, undefined, [], [], fault.faultEscrow);
    await advance(3); const s = await settlement(q); const h = await publish(s, fault.faultEscrow);
    await write(fault.fixture, 'FailingPlatformHostRegistry', 'setFailure', [1]);
    await expect(settle(s, h, [], fault.faultEscrow)).rejects.toThrow();
    expect((await run(q.runId, fault.faultEscrow)).status).toBe(1); expect(await balance(fault.faultRouter)).toBe(0n);
    expect(await read(fault.fixture, 'FailingPlatformHostRegistry', 'openRuns')).toBe(1n); await assertBacking(fault.faultEscrow);
  });
  it('a FeeRouter transfer failure atomically restores the real registry count, receipt state and owner ledgers', async () => {
    const mutableToken = await deploy('MutablePlatformToken'); const bound = await tokenBoundDeployment(mutableToken);
    const q = await quote({ hostId: bound.boundHost }); await open(q, agent, undefined, [], [], bound.boundEscrow);
    await advance(3); const s = await settlement(q); const h = await publish(s, bound.boundEscrow);
    await write(mutableToken, 'MutablePlatformToken', 'setFee', [true]);
    await expect(settle(s, h, [], bound.boundEscrow)).rejects.toThrow();
    expect((await run(q.runId, bound.boundEscrow)).status).toBe(1);
    expect(await read(bound.boundEscrow, 'PlatformRunEscrow', 'usedReceiptHash', [s.receiptHash])).toBe(false);
    expect((await read(bound.boundRegistry, 'HostRegistry', 'getHost', [bound.boundHost]) as { openRuns: bigint }).openRuns).toBe(1n);
    expect(await balance(bound.boundRouter, mutableToken)).toBe(0n);
    expect(await available(owner.address, bound.boundEscrow)).toBe(deposit - 1_090_000n);
    expect(await balance(bound.boundEscrow, mutableToken)).toBe(deposit);
    await write(mutableToken, 'MutablePlatformToken', 'setFee', [false]);
    await settle(s, h, [], bound.boundEscrow);
    expect((await read(bound.boundRegistry, 'HostRegistry', 'getHost', [bound.boundHost]) as { openRuns: bigint }).openRuns).toBe(0n);
    expect(await balance(bound.boundRouter, mutableToken)).toBe(327_000n);
  });
  it('forwards only proof-authorized host penalties, rejects replay and preserves accepted settlement on underbonded hosts', async () => {
    const q = await quote(); await open(q); const incident = id('host-probe-failed');
    const penalty = await read(hostRegistry, 'HostRegistry', 'penaltyLeaf', [cpuHost, incident, 1_000_000n]) as Hex;
    const h = await now() / 3_600n - 1n;
    await write(roots, 'ReceiptRoot', 'postRoot', [h, penalty, 1], signer);
    await expect(write(escrow, 'PlatformRunEscrow', 'penalizeHost', [cpuHost, incident, 1_000_001n, h, []], outsider)).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrow', 'penalizeHost', [cpuHost, incident, 1_000_000n, h, []], outsider);
    expect((await read(hostRegistry, 'HostRegistry', 'getHost', [cpuHost]) as { active: boolean }).active).toBe(false);
    expect(await balance(treasury.address)).toBe(1_000_000n);
    await expect(write(escrow, 'PlatformRunEscrow', 'penalizeHost', [cpuHost, incident, 1_000_000n, h, []], outsider)).rejects.toThrow();
    await expect(open(await quote())).rejects.toThrow();
    await advance(3); const s = await settlement(q); const receiptHour = await publish(s); await settle(s, receiptHour);
    expect((await run(q.runId)).status).toBe(2);
    expect((await read(hostRegistry, 'HostRegistry', 'getHost', [cpuHost]) as { openRuns: bigint }).openRuns).toBe(0n);
    await assertBacking();
  });
  it('rejects malformed Leash terms, foreign updates and wrong immutable controller pins', async () => {
    await expect(write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({ classMask: 0n })])).rejects.toThrow();
    await expect(write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms({ maxPerDay: 1n })])).rejects.toThrow();
    await expect(write(escrow, 'PlatformRunEscrow', 'updateLeash', [leashId, await terms()], outsider)).rejects.toThrow();
    await expect(write(escrow, 'PlatformRunEscrow', 'createLeash', [leashId, await terms()])).rejects.toThrow();
    const wrongRegistry = await deploy('HostRegistry', [token, owner.address, guardian.address, treasury.address, roots]);
    await expect(deploy('PlatformRunEscrow', [{ token, quoteSigner: signer.address, receiptRoot: roots,
      hostRegistry: wrongRegistry, feeRouter: router, guardian: guardian.address }])).rejects.toThrow();
    expect(await available()).toBe(deposit); await assertBacking();
  });
  it.each([1, 2, 3])('refund releases money despite host close failure mode %s and permits later independent repair', async mode => {
    const fault = await faultDeployment(); const q = await quote({ hostId: id('fixture-host') });
    await open(q, agent, undefined, [], [], fault.faultEscrow);
    await write(fault.fixture, 'FailingPlatformHostRegistry', 'setFailure', [mode]); await advance(6 * 3_600 + 10);
    await write(fault.faultEscrow, 'PlatformRunEscrow', 'refundRun', [q.runId], outsider, 500_000n);
    expect(await available(owner.address, fault.faultEscrow)).toBe(deposit); expect((await run(q.runId, fault.faultEscrow)).hostReleased).toBe(false);
    await write(fault.faultEscrow, 'PlatformRunEscrow', 'withdraw', [deposit]); expect(await balance(fault.faultEscrow)).toBe(0n);
    await expect(write(fault.faultEscrow, 'PlatformRunEscrow', 'retryHostClosure', [q.runId], outsider, 200_000n)).rejects.toThrow();
    await write(fault.fixture, 'FailingPlatformHostRegistry', 'setFailure', [0]);
    await write(fault.faultEscrow, 'PlatformRunEscrow', 'retryHostClosure', [q.runId], outsider);
    expect((await run(q.runId, fault.faultEscrow)).hostReleased).toBe(true); expect(await read(fault.fixture, 'FailingPlatformHostRegistry', 'openRuns')).toBe(0n);
    await assertBacking(fault.faultEscrow);
  });
});
