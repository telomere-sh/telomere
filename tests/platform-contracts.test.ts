import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, encodeFunctionData, http, keccak256, maxUint256, parseEther,
  toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../scripts/local-chain.js';
import { projectRoot } from '../scripts/compile-contracts.js';
import { localChain } from '../src/chain/chains.js';

type Artifact = { abi: Abi; bytecode: Hex };
type Account = ReturnType<typeof privateKeyToAccount>;
function compilePlatform(): Record<string, Artifact> {
  const paths = ['contracts/HostRegistry.sol', 'contracts/ReceiptRoot.sol', 'contracts/FeeRouter.sol',
    'contracts/MockToken.sol', 'contracts/TestAdversarialToken.sol'];
  const fixturePath = 'tests/PlatformAdversarialToken.sol';
  const fixture = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract PlatformAdversarialToken is ERC20 {
    bool public feeMode; bool public callbackAttempted; bool public callbackSucceeded;
    address public callbackTarget; bytes public callbackData;
    constructor() ERC20("Local Callback Token", "CALLBACK") { require(block.chainid == 31337, "local only"); }
    function decimals() public pure override returns (uint8) { return 6; }
    function faucet(address to, uint256 amount) external { _mint(to, amount); }
    function setFee(bool active) external { feeMode = active; }
    function approveSelf(address spender) external { _approve(address(this), spender, type(uint256).max); }
    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target; callbackData = data; callbackAttempted = false; callbackSucceeded = false;
    }
    function callAsToken(address target, bytes calldata data) external {
        (bool success,) = target.call(data); require(success, "token execution failed");
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (callbackTarget != address(0) && !callbackAttempted) {
            callbackAttempted = true; (callbackSucceeded,) = callbackTarget.call(callbackData);
        }
        bool result = super.transferFrom(from, to, amount);
        if (feeMode && amount != 0) _burn(to, 1);
        return result;
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        bool result = super.transfer(to, amount); if (feeMode && amount != 0) _burn(to, 1); return result;
    }
}`;
  const input = { language: 'Solidity', sources: {
    ...Object.fromEntries(paths.map(path => [path, { content: readFileSync(resolve(projectRoot, path), 'utf8') }])),
    [fixturePath]: { content: fixture },
  }, settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  } };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (path: string) => {
    if (!path.startsWith('@openzeppelin/contracts/') || path.includes('..')) return { error: 'Unsupported import' };
    return { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') };
  } })) as { errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const failures = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (failures.length) throw new Error(failures.map(error => error.formattedMessage).join('\n'));
  return Object.fromEntries([...paths, fixturePath].flatMap(path => Object.entries(output.contracts[path] ?? {}).map(([name, contract]) =>
    [name, { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex }])));
}
const id = (label: string): Hex => keccak256(toHex(label));
const zero = `0x${'00'.repeat(32)}` as Hex;
const pair = (a: Hex, b: Hex): Hex => keccak256(`0x${[a, b].sort().map(value => value.slice(2)).join('')}`);

describe('non-upgradeable platform contracts on a disposable local EVM', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let test: ReturnType<typeof createTestClient>;
  let artifacts: Record<string, Artifact>;
  let admin: Account; let host: Account; let guardian: Account; let outsider: Account; let successor: Account;
  let token: Address; let registry: Address; let signers: Address; let roots: Address; let router: Address;
  let snapshot: Hex;

  function artifact(name: string): Artifact {
    const found = artifacts[name]; if (!found) throw new Error(`Missing ${name}`); return found;
  }
  async function deploy(name: string, args: readonly unknown[] = []) {
    const wallet = createWalletClient({ account: admin, chain: localChain, transport: http(local.rpcUrl) });
    const hash = await wallet.deployContract({ ...artifact(name), args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = admin) {
    const wallet = createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl) });
    const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    return receipt;
  }
  async function read(address: Address, name: string, functionName: string, args: readonly unknown[] = []): Promise<unknown> {
    return local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args });
  }
  async function balance(address: Address) { return read(token, 'MockToken', 'balanceOf', [address]); }
  async function advance(seconds: number) { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); }
  async function hour() { return (await local.publicClient.getBlock()).timestamp / 3_600n; }
  async function week() { return (await local.publicClient.getBlock()).timestamp / 604_800n; }
  async function register(gpu = false, collateral = gpu ? 1_500_000_000n : 300_000_000n, key = id('host-key')) {
    await write(registry, 'HostRegistry', 'register', [key, 0, zero, collateral, gpu], host);
    return read(registry, 'HostRegistry', 'operatorHost', [host.address]) as Promise<Hex>;
  }
  async function hostState(hostId: Hex) {
    return read(registry, 'HostRegistry', 'getHost', [hostId]) as Promise<{
      operator: Address; hostKey: Hex; collateral: bigint; strikes: number; unbondAt: bigint; active: boolean; gpu: boolean; openRuns: bigint;
    }>;
  }
  async function post(leaf: Hex, rootHour?: bigint, account = admin) {
    const closedHour = rootHour ?? await hour() - 1n;
    await write(roots, 'ReceiptRoot', 'postRoot', [closedHour, leaf, 1], account);
    return closedHour;
  }

  beforeAll(async () => {
    artifacts = compilePlatform(); local = await startLocalChain();
    test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    [admin, host, guardian, outsider, successor] = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey())) as
      [Account, Account, Account, Account, Account];
    for (const account of [admin, host, guardian, outsider, successor]) {
      await test.setBalance({ address: account.address, value: parseEther('10') });
    }
    token = await deploy('MockToken'); signers = await deploy('SignerSet', [admin.address, admin.address]);
    roots = await deploy('ReceiptRoot', [signers]);
    registry = await deploy('HostRegistry', [token, admin.address, guardian.address, outsider.address, roots]);
    router = await deploy('FeeRouter', [token, admin.address, admin.address, guardian.address, outsider.address, successor.address]);
    for (const account of [admin, host]) {
      await write(token, 'MockToken', 'faucet', [account.address, 20_000_000_000n]);
      await write(token, 'MockToken', 'approve', [registry, maxUint256], account);
      await write(token, 'MockToken', 'approve', [router, maxUint256], account);
    }
    snapshot = await test.snapshot();
  }, 60_000);
  beforeEach(async () => { await test.revert({ id: snapshot }); snapshot = await test.snapshot(); });
  afterAll(async () => { if (local) await local.close(); });

  it('records exact CPU collateral and immutable operator/key identity', async () => {
    const before = await balance(host.address) as bigint; const hostId = await register();
    const state = await hostState(hostId);
    expect(state.operator.toLowerCase()).toBe(host.address.toLowerCase());
    expect(state.collateral).toBe(300_000_000n); expect(state.active).toBe(true); expect(state.gpu).toBe(false);
    expect(await balance(host.address)).toBe(before - 300_000_000n);
    expect(await balance(registry)).toBe(300_000_000n);
    expect(await read(registry, 'HostRegistry', 'totalCollateral')).toBe(300_000_000n);
  });
  it('requires GPU minimum, valid kinds and a measurement only for sealed hosts', async () => {
    await expect(register(true, 1_499_999_999n)).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'register', [id('key'), 3, zero, 1_500_000_000n, true], host)).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'register', [id('key'), 2, zero, 1_500_000_000n, true], host)).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'register', [id('key'), 0, id('measurement'), 300_000_000n, false], host)).rejects.toThrow();
    await write(registry, 'HostRegistry', 'register', [id('key'), 2, id('measurement'), 1_500_000_000n, true], host);
    expect((await hostState(await read(registry, 'HostRegistry', 'operatorHost', [host.address]) as Hex)).gpu).toBe(true);
  });
  it('rejects zero keys, duplicate keys, duplicate operators and insufficient CPU collateral', async () => {
    await expect(register(false, 299_999_999n)).rejects.toThrow();
    await expect(register(false, 300_000_000n, zero)).rejects.toThrow();
    await register();
    await expect(register(false, 300_000_000n, id('another'))).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'register', [id('host-key'), 0, zero, 300_000_000n, false], outsider)).rejects.toThrow();
  });
  it('allows only controller run hooks and never recycles a closed run ID', async () => {
    const hostId = await register(); const runId = id('run');
    await expect(write(registry, 'HostRegistry', 'openRun', [hostId, runId], host)).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'openRun', [hostId, zero])).rejects.toThrow();
    await write(registry, 'HostRegistry', 'openRun', [hostId, runId]);
    expect((await hostState(hostId)).openRuns).toBe(1n);
    await expect(write(registry, 'HostRegistry', 'openRun', [hostId, runId])).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'closeRun', [runId], host)).rejects.toThrow();
    await write(registry, 'HostRegistry', 'closeRun', [runId]);
    expect((await hostState(hostId)).openRuns).toBe(0n);
    await expect(write(registry, 'HostRegistry', 'closeRun', [runId])).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'openRun', [hostId, runId])).rejects.toThrow();
  });
  it('blocks unbond with open runs and enforces the entire 21-day delay', async () => {
    const hostId = await register(); await write(registry, 'HostRegistry', 'openRun', [hostId, id('run')]);
    await expect(write(registry, 'HostRegistry', 'requestUnbond', [], host)).rejects.toThrow();
    await write(registry, 'HostRegistry', 'closeRun', [id('run')]);
    await write(registry, 'HostRegistry', 'requestUnbond', [], host);
    const state = await hostState(hostId); expect(state.active).toBe(false);
    expect(state.unbondAt).toBe((await local.publicClient.getBlock()).timestamp + 21n * 86_400n);
    await expect(write(registry, 'HostRegistry', 'withdrawCollateral', [], host)).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'openRun', [hostId, id('new')])).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'addCollateral', [1n], host)).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: state.unbondAt - 1n }); await test.mine({ blocks: 1 });
    await expect(local.publicClient.simulateContract({ account: host, address: registry, abi: artifact('HostRegistry').abi,
      functionName: 'withdrawCollateral' })).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: state.unbondAt }); await test.mine({ blocks: 1 });
    const before = await balance(host.address) as bigint;
    await write(registry, 'HostRegistry', 'withdrawCollateral', [], host);
    expect(await balance(host.address)).toBe(before + 300_000_000n);
    expect(await balance(registry)).toBe(0n); expect(await read(registry, 'HostRegistry', 'totalCollateral')).toBe(0n);
    await expect(write(registry, 'HostRegistry', 'withdrawCollateral', [], host)).rejects.toThrow();
  });
  it('guardian pauses registration without blocking collateral additions, closures or withdrawals', async () => {
    const hostId = await register();
    await expect(write(registry, 'HostRegistry', 'setRegistrationPaused', [true])).rejects.toThrow();
    await write(registry, 'HostRegistry', 'setRegistrationPaused', [true], guardian);
    await expect(write(registry, 'HostRegistry', 'register', [id('other'), 0, zero, 300_000_000n, false], outsider)).rejects.toThrow();
    await write(registry, 'HostRegistry', 'addCollateral', [10n], host);
    await write(registry, 'HostRegistry', 'openRun', [hostId, id('run')]);
    await write(registry, 'HostRegistry', 'closeRun', [id('run')]);
    await write(registry, 'HostRegistry', 'requestUnbond', [], host); await advance(21 * 86_400);
    await write(registry, 'HostRegistry', 'withdrawCollateral', [], host);
    expect(await balance(registry)).toBe(0n);
  });
  it('requires committed domain-bound penalty evidence, exact amount and controller authority', async () => {
    const hostId = await register(); const incident = id('failed-run');
    const leaf = await read(registry, 'HostRegistry', 'penaltyLeaf', [hostId, incident, 10_000_000n]) as Hex;
    const closedHour = await post(leaf);
    await expect(write(registry, 'HostRegistry', 'penalize', [hostId, incident, 10_000_000n, closedHour, []], outsider)).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'penalize', [hostId, incident, 11_000_000n, closedHour, []])).rejects.toThrow();
    await expect(write(registry, 'HostRegistry', 'penalize', [hostId, incident, 10_000_000n, closedHour, [id('bad')]])).rejects.toThrow();
    await write(registry, 'HostRegistry', 'penalize', [hostId, incident, 10_000_000n, closedHour, []]);
    expect((await hostState(hostId)).collateral).toBe(290_000_000n);
    expect((await hostState(hostId)).strikes).toBe(1); expect((await hostState(hostId)).active).toBe(false);
    expect(await balance(outsider.address)).toBe(10_000_000n);
    expect(await read(registry, 'HostRegistry', 'totalCollateral')).toBe(290_000_000n);
    await expect(write(registry, 'HostRegistry', 'penalize', [hostId, incident, 10_000_000n, closedHour, []])).rejects.toThrow();
    await write(registry, 'HostRegistry', 'addCollateral', [10_000_000n], host);
    expect((await hostState(hostId)).active).toBe(true);
  });
  it('rejects reusing the same incident through another amount and another root', async () => {
    const hostId = await register(); const incident = id('incident'); const h = await hour();
    const first = await read(registry, 'HostRegistry', 'penaltyLeaf', [hostId, incident, 1n]) as Hex;
    const second = await read(registry, 'HostRegistry', 'penaltyLeaf', [hostId, incident, 2n]) as Hex;
    await post(first, h - 1n); await post(second, h - 2n);
    await write(registry, 'HostRegistry', 'penalize', [hostId, incident, 1n, h - 1n, []]);
    await expect(write(registry, 'HostRegistry', 'penalize', [hostId, incident, 2n, h - 2n, []])).rejects.toThrow();
  });
  it('allows evidence-backed penalties during unbond but returns only the remaining collateral', async () => {
    const hostId = await register(); const incident = id('unbond-incident');
    const leaf = await read(registry, 'HostRegistry', 'penaltyLeaf', [hostId, incident, 300_000_000n]) as Hex;
    const h = await post(leaf); await write(registry, 'HostRegistry', 'requestUnbond', [], host);
    await write(registry, 'HostRegistry', 'penalize', [hostId, incident, 300_000_000n, h, []]);
    await advance(21 * 86_400); await write(registry, 'HostRegistry', 'withdrawCollateral', [], host);
    expect(await balance(registry)).toBe(0n); expect(await read(registry, 'HostRegistry', 'totalCollateral')).toBe(0n);
    await expect(register()).rejects.toThrow();
    await register(false, 300_000_000n, id('fresh-key'));
  });

  it('commits only closed hours, nonzero roots/counts and never overwrites a root', async () => {
    const h = await hour();
    await expect(post(id('leaf'), h)).rejects.toThrow();
    await expect(post(id('leaf'), h + 1n)).rejects.toThrow();
    await expect(post(zero, h - 1n)).rejects.toThrow();
    await expect(write(roots, 'ReceiptRoot', 'postRoot', [h - 1n, id('leaf'), 0])).rejects.toThrow();
    await expect(post(id('leaf'), h - 1n, outsider)).rejects.toThrow();
    await post(id('leaf'), h - 1n);
    await expect(post(id('replacement'), h - 1n)).rejects.toThrow();
    const committed = await read(roots, 'ReceiptRoot', 'getRoot', [h - 1n]) as { root: Hex; count: number; signer: Address };
    expect(committed.root).toBe(id('leaf')); expect(committed.count).toBe(1);
    expect(committed.signer.toLowerCase()).toBe(admin.address.toLowerCase());
  });
  it('verifies sorted-pair proofs and rejects wrong leaves, proofs and hours', async () => {
    const a = id('a'); const b = id('b'); const h = await hour() - 1n;
    await write(roots, 'ReceiptRoot', 'postRoot', [h, pair(a, b), 2]);
    expect(await read(roots, 'ReceiptRoot', 'verify', [a, [b], h])).toBe(true);
    expect(await read(roots, 'ReceiptRoot', 'verify', [b, [a], h])).toBe(true);
    expect(await read(roots, 'ReceiptRoot', 'verify', [id('fake'), [b], h])).toBe(false);
    expect(await read(roots, 'ReceiptRoot', 'verify', [a, [], h])).toBe(false);
    expect(await read(roots, 'ReceiptRoot', 'verify', [a, [b], h - 1n])).toBe(false);
  });
  it('rotates signers weekly, freezes scheduled slots and fails closed when the next week is unscheduled', async () => {
    const current = await week();
    await expect(write(signers, 'SignerSet', 'scheduleSigner', [current, successor.address])).rejects.toThrow();
    await expect(write(signers, 'SignerSet', 'scheduleSigner', [current + 1n, successor.address], outsider)).rejects.toThrow();
    await expect(write(signers, 'SignerSet', 'scheduleSigner', [current + 1n, '0x0000000000000000000000000000000000000000'])).rejects.toThrow();
    await write(signers, 'SignerSet', 'scheduleSigner', [current + 1n, successor.address]);
    await expect(write(signers, 'SignerSet', 'scheduleSigner', [current + 1n, outsider.address])).rejects.toThrow();
    await test.setNextBlockTimestamp({ timestamp: (current + 1n) * 604_800n }); await test.mine({ blocks: 1 });
    expect((await read(signers, 'SignerSet', 'currentSigner') as string).toLowerCase()).toBe(successor.address.toLowerCase());
    await expect(post(id('old-signer'))).rejects.toThrow();
    await post(id('new-signer'), undefined, successor);
    await advance(604_800);
    await expect(post(id('missing-signer'), undefined, successor)).rejects.toThrow();
  });

  it('adds exact 9% / 12% fees without reducing host posted prices', async () => {
    const w = await week();
    expect(await read(router, 'FeeRouter', 'quoteFee', [1_000_000n, false])).toBe(90_000n);
    expect(await read(router, 'FeeRouter', 'quoteFee', [1_000_000n, true])).toBe(120_000n);
    await write(router, 'FeeRouter', 'recordSettlement', [id('cell'), host.address, 1_000_000n, false]);
    await write(router, 'FeeRouter', 'recordSettlement', [id('sealed'), host.address, 1_000_000n, true]);
    expect(await read(router, 'FeeRouter', 'hostAccrued', [w, host.address])).toBe(2_000_000n);
    expect(await read(router, 'FeeRouter', 'getBuckets', [w])).toEqual({ work: 168_000n, treasury: 21_000n, stakers: 10_500n, buyAndBurn: 10_500n });
    expect(await read(router, 'FeeRouter', 'accountedBalance')).toBe(2_210_000n);
    expect(await balance(router)).toBe(2_210_000n);
  });
  it('accounts integer rounding dust in work pool with exact total conservation', async () => {
    const w = await week();
    expect(await read(router, 'FeeRouter', 'quoteFee', [1n, false])).toBe(1n);
    await write(router, 'FeeRouter', 'recordSettlement', [id('tiny'), host.address, 1n, false]);
    expect(await read(router, 'FeeRouter', 'getBuckets', [w])).toEqual({ work: 1n, treasury: 0n, stakers: 0n, buyAndBurn: 0n });
    expect(await read(router, 'FeeRouter', 'accountedBalance')).toBe(2n);
  });
  it('rejects unauthorized settlement, duplicate receipts, zero values and router-as-host', async () => {
    const args = [id('receipt'), host.address, 1_000_000n, false];
    await expect(write(router, 'FeeRouter', 'recordSettlement', args, host)).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'recordSettlement', [zero, host.address, 1n, false])).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'recordSettlement', [id('z'), host.address, 0n, false])).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'recordSettlement', [id('r'), router, 1n, false])).rejects.toThrow();
    await write(router, 'FeeRouter', 'recordSettlement', args);
    await expect(write(router, 'FeeRouter', 'recordSettlement', args)).rejects.toThrow();
    expect(await balance(router)).toBe(1_090_000n);
  });
  it('host pulls only its own closed-week amount once, even if unrelated tokens were donated', async () => {
    const w = await week(); await write(router, 'FeeRouter', 'recordSettlement', [id('receipt'), host.address, 1_000_000n, false]);
    await expect(write(router, 'FeeRouter', 'claimHost', [w], host)).rejects.toThrow();
    await write(token, 'MockToken', 'faucet', [router, 123n]); await advance(604_800);
    await expect(write(router, 'FeeRouter', 'claimHost', [w], outsider)).rejects.toThrow();
    const before = await balance(host.address) as bigint;
    await write(router, 'FeeRouter', 'claimHost', [w], host);
    expect(await balance(host.address)).toBe(before + 1_000_000n);
    await expect(write(router, 'FeeRouter', 'claimHost', [w], host)).rejects.toThrow();
    expect(await read(router, 'FeeRouter', 'accountedBalance')).toBe(90_000n); expect(await balance(router)).toBe(90_123n);
  });
  it('pays fixed 10/5/5 recipients once with no redirect or work-bucket shortcut', async () => {
    const w = await week(); await write(router, 'FeeRouter', 'recordSettlement', [id('receipt'), host.address, 1_000_000n, false]);
    await expect(write(router, 'FeeRouter', 'claimBucket', [w, 1], outsider)).rejects.toThrow(); await advance(604_800);
    await expect(write(router, 'FeeRouter', 'claimBucket', [w, 0], outsider)).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'claimBucket', [w, 4], outsider)).rejects.toThrow();
    await write(router, 'FeeRouter', 'claimBucket', [w, 1], host);
    await write(router, 'FeeRouter', 'claimBucket', [w, 2], host);
    await write(router, 'FeeRouter', 'claimBucket', [w, 3], host);
    expect(await balance(guardian.address)).toBe(9_000n); expect(await balance(outsider.address)).toBe(4_500n);
    expect(await balance(successor.address)).toBe(4_500n);
    await expect(write(router, 'FeeRouter', 'claimBucket', [w, 1])).rejects.toThrow();
    expect(await read(router, 'FeeRouter', 'accountedBalance')).toBe(1_072_000n);
  });
  it('binds immutable work distributions to chain/router/week/recipient/amount and never overpays', async () => {
    const w = await week(); await write(router, 'FeeRouter', 'recordSettlement', [id('receipt'), host.address, 1_000_000n, false]);
    const a = await read(router, 'FeeRouter', 'workLeaf', [w, outsider.address, 40_000n]) as Hex;
    const b = await read(router, 'FeeRouter', 'workLeaf', [w, successor.address, 32_000n]) as Hex;
    await expect(write(router, 'FeeRouter', 'postWorkRoot', [w, pair(a, b), 72_000n])).rejects.toThrow();
    await advance(604_800);
    await expect(write(router, 'FeeRouter', 'postWorkRoot', [w, pair(a, b), 72_000n], outsider)).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'postWorkRoot', [w, pair(a, b), 72_001n])).rejects.toThrow();
    await write(router, 'FeeRouter', 'postWorkRoot', [w, pair(a, b), 72_000n]);
    await expect(write(router, 'FeeRouter', 'postWorkRoot', [w, a, 40_000n])).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'claimWork', [w, 40_001n, [b]], outsider)).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'claimWork', [w, 40_000n, [b]], host)).rejects.toThrow();
    await expect(write(router, 'FeeRouter', 'claimWork', [w + 1n, 40_000n, [b]], outsider)).rejects.toThrow();
    await write(router, 'FeeRouter', 'claimWork', [w, 40_000n, [b]], outsider);
    await expect(write(router, 'FeeRouter', 'claimWork', [w, 40_000n, [b]], outsider)).rejects.toThrow();
    await write(router, 'FeeRouter', 'claimWork', [w, 32_000n, [a]], successor);
    expect(await balance(outsider.address)).toBe(40_000n); expect(await balance(successor.address)).toBe(32_000n);
    const distribution = await read(router, 'FeeRouter', 'workDistribution', [w]) as [Hex, bigint, bigint];
    expect(distribution[1]).toBe(72_000n); expect(distribution[2]).toBe(72_000n);
    expect((await read(router, 'FeeRouter', 'getBuckets', [w]) as { work: bigint }).work).toBe(0n);
  });
  it('rejects a Merkle allocation whose valid leaves sum above the declared work budget', async () => {
    const w = await week(); await write(router, 'FeeRouter', 'recordSettlement', [id('receipt'), host.address, 1_000_000n, false]);
    const a = await read(router, 'FeeRouter', 'workLeaf', [w, outsider.address, 60_000n]) as Hex;
    const b = await read(router, 'FeeRouter', 'workLeaf', [w, successor.address, 60_000n]) as Hex;
    await advance(604_800); await write(router, 'FeeRouter', 'postWorkRoot', [w, pair(a, b), 72_000n]);
    await write(router, 'FeeRouter', 'claimWork', [w, 60_000n, [b]], outsider);
    await expect(write(router, 'FeeRouter', 'claimWork', [w, 60_000n, [a]], successor)).rejects.toThrow();
    expect(await read(router, 'FeeRouter', 'accountedBalance')).toBe(1_030_000n);
  });

  it('rejects transfer-tax tokens without leaving registry collateral or fee ledger credit', async () => {
    const evil = await deploy('TestAdversarialToken', [true]);
    const badRegistry = await deploy('HostRegistry', [evil, admin.address, guardian.address, outsider.address, roots]);
    const badRouter = await deploy('FeeRouter', [evil, admin.address, admin.address, guardian.address, outsider.address, successor.address]);
    await write(evil, 'TestAdversarialToken', 'faucet', [host.address, 1_000_000_000n]);
    await write(evil, 'TestAdversarialToken', 'faucet', [admin.address, 1_000_000_000n]);
    await write(evil, 'TestAdversarialToken', 'approve', [badRegistry, maxUint256], host);
    await write(evil, 'TestAdversarialToken', 'approve', [badRouter, maxUint256]);
    await expect(write(badRegistry, 'HostRegistry', 'register', [id('evil-key'), 0, zero, 300_000_000n, false], host)).rejects.toThrow();
    expect(await read(badRegistry, 'HostRegistry', 'totalCollateral')).toBe(0n);
    expect(await read(evil, 'TestAdversarialToken', 'balanceOf', [badRegistry])).toBe(0n);
    await expect(write(badRouter, 'FeeRouter', 'recordSettlement', [id('evil-receipt'), host.address, 1_000_000n, false])).rejects.toThrow();
    expect(await read(badRouter, 'FeeRouter', 'accountedBalance')).toBe(0n);
    expect(await read(badRouter, 'FeeRouter', 'settledReceipt', [id('evil-receipt')])).toBe(false);
  });
  it('resists callback reentrancy during collateral deposits without losing exact accounting', async () => {
    const evil = await deploy('TestAdversarialToken', [false]);
    const target = await deploy('HostRegistry', [evil, admin.address, guardian.address, outsider.address, roots]);
    await write(evil, 'TestAdversarialToken', 'faucet', [host.address, 1_000_000_000n]);
    await write(evil, 'TestAdversarialToken', 'approve', [target, maxUint256], host);
    const attack = encodeFunctionData({ abi: artifact('HostRegistry').abi, functionName: 'register',
      args: [id('callback-key'), 0, zero, 300_000_000n, false] });
    await write(evil, 'TestAdversarialToken', 'configureAttack', [target, attack]);
    await write(target, 'HostRegistry', 'register', [id('real-key'), 0, zero, 300_000_000n, false], host);
    expect(await read(evil, 'TestAdversarialToken', 'reentrySucceeded')).toBe(false);
    expect(await read(target, 'HostRegistry', 'totalCollateral')).toBe(300_000_000n);
    expect(await read(evil, 'TestAdversarialToken', 'balanceOf', [target])).toBe(300_000_000n);
  });
  it('blocks nested fee settlement even when the callback token is the authorized controller', async () => {
    const evil = await deploy('PlatformAdversarialToken');
    const target = await deploy('FeeRouter', [evil, evil, admin.address, guardian.address, outsider.address, successor.address]);
    await write(evil, 'PlatformAdversarialToken', 'faucet', [evil, 1_000_000_000n]);
    await write(evil, 'PlatformAdversarialToken', 'approveSelf', [target]);
    const data = encodeFunctionData({ abi: artifact('FeeRouter').abi, functionName: 'recordSettlement',
      args: [id('callback-receipt'), host.address, 1_000_000n, false] });
    await write(evil, 'PlatformAdversarialToken', 'configureCallback', [target, data]);
    await write(evil, 'PlatformAdversarialToken', 'callAsToken', [target, data]);
    expect(await read(evil, 'PlatformAdversarialToken', 'callbackAttempted')).toBe(true);
    expect(await read(evil, 'PlatformAdversarialToken', 'callbackSucceeded')).toBe(false);
    expect(await read(target, 'FeeRouter', 'hostAccrued', [await week(), host.address])).toBe(1_000_000n);
    expect(await read(target, 'FeeRouter', 'accountedBalance')).toBe(1_090_000n);
    expect(await read(evil, 'PlatformAdversarialToken', 'balanceOf', [target])).toBe(1_090_000n);
  });
  it('rolls back withdrawal ledgers if a token starts charging transfer fees after deposit', async () => {
    const evil = await deploy('PlatformAdversarialToken');
    const targetRegistry = await deploy('HostRegistry', [evil, admin.address, guardian.address, outsider.address, roots]);
    const targetRouter = await deploy('FeeRouter', [evil, admin.address, admin.address, guardian.address, outsider.address, successor.address]);
    await write(evil, 'PlatformAdversarialToken', 'faucet', [host.address, 1_000_000_000n]);
    await write(evil, 'PlatformAdversarialToken', 'faucet', [admin.address, 1_000_000_000n]);
    await write(evil, 'PlatformAdversarialToken', 'approve', [targetRegistry, maxUint256], host);
    await write(evil, 'PlatformAdversarialToken', 'approve', [targetRouter, maxUint256]);
    await write(targetRegistry, 'HostRegistry', 'register', [id('mutable-key'), 0, zero, 300_000_000n, false], host);
    const hostId = await read(targetRegistry, 'HostRegistry', 'operatorHost', [host.address]);
    const w = await week();
    await write(targetRouter, 'FeeRouter', 'recordSettlement', [id('mutable-receipt'), host.address, 1_000_000n, false]);
    await write(targetRegistry, 'HostRegistry', 'requestUnbond', [], host); await advance(21 * 86_400);
    await write(evil, 'PlatformAdversarialToken', 'setFee', [true]);
    await expect(write(targetRegistry, 'HostRegistry', 'withdrawCollateral', [], host)).rejects.toThrow();
    await expect(write(targetRouter, 'FeeRouter', 'claimHost', [w], host)).rejects.toThrow();
    expect(await read(targetRegistry, 'HostRegistry', 'operatorHost', [host.address])).toBe(hostId);
    expect(await read(targetRegistry, 'HostRegistry', 'totalCollateral')).toBe(300_000_000n);
    expect(await read(targetRouter, 'FeeRouter', 'hostAccrued', [w, host.address])).toBe(1_000_000n);
    expect(await read(targetRouter, 'FeeRouter', 'accountedBalance')).toBe(1_090_000n);
    await write(evil, 'PlatformAdversarialToken', 'setFee', [false]);
    await write(targetRegistry, 'HostRegistry', 'withdrawCollateral', [], host);
    await write(targetRouter, 'FeeRouter', 'claimHost', [w], host);
    expect(await read(targetRegistry, 'HostRegistry', 'totalCollateral')).toBe(0n);
    expect(await read(targetRouter, 'FeeRouter', 'accountedBalance')).toBe(90_000n);
  });
});
