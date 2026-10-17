import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestClient, createWalletClient, getContractAddress, http, keccak256, maxUint256, parseEther, toHex,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { localChain } from '../src/chain/chains.js';
import { platformQuoteTypes } from '../src/platform-runtime/types.js';
import { readTlmrSchedulingWeights } from '../src/economics/staking-reader.js';
import { buildWeeklyWorkAllocation, weeklyWorkLeaf, type VerifiedWorkActivity } from '../src/economics/work-allocation.js';
import { platformPinsSchema } from '../src/platform-runtime/types.js';
import { createPlatformReadOnlyBridge } from '../src/platform-runtime/read-only.js';
import { PlatformPublicFinancialReader } from '../src/platform-runtime/public-financial.js';
import { readPlatformV2OpeningAuthority } from '../src/receipts/platform-v2-history.js';
import { prepareBuyAndBurn, reconcileBuyAndBurn, type BuyAndBurnPins } from '../src/economics/buy-and-burn.js';
import { CanonicalCommittedWorkVerifier, committedWorkLeaf, type committedWorkObservationSchema } from '../src/economics/committed-work-verifier.js';
import { hashJson } from '../src/common.js';
import type { z } from 'zod';
import { prepareWeeklyWorkAllocation } from '../src/economics/work-operator.js';

const id = (name: string): Hex => keccak256(toHex(name));
const zero = `0x${'0'.repeat(64)}` as Hex;
type Account = ReturnType<typeof privateKeyToAccount>;
const burnTypes = { BurnQuote: [{ name: 'operationId', type: 'bytes32' }, { name: 'week', type: 'uint64' },
  { name: 'amountIn', type: 'uint96' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'validAfter', type: 'uint64' },
  { name: 'deadline', type: 'uint64' }] } as const;

describe('optional economics-v2 on an actual disposable local EVM', () => {
  let artifacts: Record<string, ContractArtifact>, local: Awaited<ReturnType<typeof startLocalChain>>;
  let test: ReturnType<typeof createTestClient>, admin: Account, owner: Account, host: Account, second: Account;
  let token: Address, utility: Address, signers: Address, roots: Address, registry: Address, router: Address;
  let staking: Address, burner: Address, dex: Address, escrow: Address, hostId: Hex, snapshot: Hex;
  const openings = new Map<Hex, Hex>();
  const artifact = (name: string) => { const value = artifacts[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  const wallet = (account: Account) => createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl) });
  async function deploy(name: string, args: readonly unknown[] = []) {
    const hash = await wallet(admin).deployContract({ ...artifact(name), args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress || receipt.status !== 'success') throw new Error(`${name} deployment failed`);
    return receipt.contractAddress;
  }
  async function write(address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = admin) {
    const hash = await wallet(account).writeContract({ address, abi: artifact(name).abi, functionName, args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`); return receipt;
  }
  const read = (address: Address, name: string, functionName: string, args: readonly unknown[] = []) =>
    local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args });
  const now = async () => (await local.publicClient.getBlock()).timestamp;
  const week = async () => await now() / 604800n;
  async function advance(seconds: number) { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); }
  async function jump(timestamp: bigint) { await test.setNextBlockTimestamp({ timestamp }); await test.mine({ blocks: 1 }); }
  async function stake(account: Account, amount = parseEther('1000'), label = 'reward-agent') {
    await write(utility, 'TlmrBurnableToken', 'approve', [staking, amount], account);
    await write(staking, 'TlmrRewardStaking', 'stake', [id(label), amount], account);
  }
  async function open(label: string, domainVersion = '2') {
    const leashId = id(`leash-${label}`), runId = id(`run-${label}`);
    await write(escrow, 'PlatformRunEscrowEconomicsV2', 'createLeash', [leashId, {
      agent: owner.address, maxPerHour: 20_000_000n, maxPerDay: 200_000_000n, classMask: 1n, sealedOnly: false,
      imageAllowRoot: zero, regionAllowRoot: zero, expiry: await now() + 604800n }], owner);
    const quote = { runId, leashId, hostId, payer: owner.address, hwClass: 0,
      regionHash: id('local'), imageHash: id('image'), workloadHash: id('workload'),
      maxSeconds: 10n, pricePerSecond: 100_000n, inferencePrice: 0n, quoteExpiry: await now() + 300n };
    const signature = await admin.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: domainVersion,
      chainId: 31337, verifyingContract: escrow }, types: platformQuoteTypes, primaryType: 'PlatformQuote', message: quote });
    const receipt = await write(escrow, 'PlatformRunEscrowEconomicsV2', 'openRun', [quote, signature, [], []], owner);
    openings.set(quote.runId, receipt.transactionHash);
    return quote;
  }
  async function settle(q: Awaited<ReturnType<typeof open>>) {
    const run = await read(escrow, 'PlatformRunEscrowEconomicsV2', 'getRun', [q.runId]) as { openedAt: bigint };
    await advance(5);
    const settlement = { runId: q.runId, billableSeconds: 5n, endedAt: run.openedAt + 5n,
      inferenceCharge: 0n, receiptHash: id(`settlement-${q.runId}`) };
    const leaf = await read(escrow, 'PlatformRunEscrowEconomicsV2', 'receiptLeaf', [settlement]) as Hex;
    const hour = settlement.endedAt / 3600n;
    await jump((hour + 1n) * 3600n + 1n);
    await write(roots, 'ReceiptRoot', 'postRoot', [hour, leaf, 1]);
    const receipt = await write(escrow, 'PlatformRunEscrowEconomicsV2', 'settleRun', [settlement, hour, []]);
    return { settlement, receipt, week: await week() };
  }
  async function fundedWeek(label: string) {
    const target = await week() + 1n;
    await write(signers, 'SignerSet', 'scheduleSigner', [target, admin.address]);
    await jump(target * 604800n + 1n);
    const q = await open(label); const result = await settle(q);
    return { ...result, q };
  }
  async function signedBurn(w: bigint, overrides: Partial<{ operationId: Hex; amountIn: bigint; minAmountOut: bigint;
    validAfter: bigint; deadline: bigint }> = {}) {
    const timestamp = await now(); const quote = { operationId: id('burn-operation'), week: w, amountIn: 1000n,
      minAmountOut: 1000n * 10n ** 12n, validAfter: timestamp, deadline: timestamp + 300n, ...overrides };
    const signature = await admin.signTypedData({ domain: { name: 'TelomereBuyAndBurn', version: '1', chainId: 31337,
      verifyingContract: burner }, types: burnTypes, primaryType: 'BurnQuote', message: quote });
    return { quote, signature };
  }
  async function pins() {
    const code = async (address: Address) => keccak256((await local.publicClient.getCode({ address }))!);
    return platformPinsSchema.parse({ chainId: 31337, escrowAddress: escrow, tokenAddress: token, quoteSigner: admin.address,
      receiptRootAddress: roots, hostRegistryAddress: registry, feeRouterAddress: router, reviewedTokenKind: 'immutable',
      tokenCodeHash: await code(token), escrowCodeHash: await code(escrow), receiptRootCodeHash: await code(roots),
      hostRegistryCodeHash: await code(registry), feeRouterCodeHash: await code(router),
      financialProfile: { kind: 'tlmr_economics_v2', stakingAddress: staking, stakingCodeHash: await code(staking),
        utilityTokenAddress: utility, utilityTokenCodeHash: await code(utility) } });
  }
  async function burnPins(): Promise<BuyAndBurnPins> {
    return { platform: await pins(), burner, burnerCodeHash: keccak256((await local.publicClient.getCode({ address: burner }))!),
      utilityToken: utility, utilityCodeHash: keccak256((await local.publicClient.getCode({ address: utility }))!),
      swapRouter: dex, swapRouterCodeHash: keccak256((await local.publicClient.getCode({ address: dex }))!),
      quoteSigner: admin.address, poolFee: 3000, maxPerSwap: '1000', maxPerWeek: '2000', maxQuoteLifetime: 300 };
  }
  beforeAll(async () => {
    artifacts = compileContracts(['PlatformRunEscrowEconomicsV2.sol', 'FeeRouterEconomicsV2.sol', 'HostRegistry.sol',
      'ReceiptRoot.sol', 'MockToken.sol', 'TlmrBurnableToken.sol', 'TlmrRewardStaking.sol', 'TlmrBuyAndBurn.sol',
      'TlmrSwapRouter02Adapter.sol', 'TestReviewedV3Router.sol', 'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol',
      'PlatformRunEscrow.sol', 'FeeRouter.sol', 'TestEconomicsIdentity.sol']);
    local = await startLocalChain(); test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    [admin, owner, host, second] = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey())) as [Account, Account, Account, Account];
    for (const account of [admin, owner, host, second]) await test.setBalance({ address: account.address, value: parseEther('10') });
    token = await deploy('MockToken'); utility = await deploy('TlmrBurnableToken', [admin.address, parseEther('1000000')]);
    signers = await deploy('SignerSet', [admin.address, admin.address]); roots = await deploy('ReceiptRoot', [signers]); dex = await deploy('TestReviewedV3Router');
    const nonce = BigInt(await local.publicClient.getTransactionCount({ address: admin.address }));
    const predictedStaking = getContractAddress({ from: admin.address, nonce: nonce + 2n });
    const predictedBurner = getContractAddress({ from: admin.address, nonce: nonce + 3n });
    const predictedEscrow = getContractAddress({ from: admin.address, nonce: nonce + 4n });
    registry = await deploy('HostRegistry', [token, predictedEscrow, admin.address, admin.address, roots]);
    router = await deploy('FeeRouterEconomicsV2', [token, predictedEscrow, admin.address, admin.address, predictedStaking, predictedBurner]);
    const routerHash = keccak256((await local.publicClient.getCode({ address: router }))!);
    staking = await deploy('TlmrRewardStaking', [utility, token, router, routerHash]);
    burner = await deploy('TlmrBuyAndBurn', [{ paymentToken: token, utilityToken: utility, feeRouter: router, feeRouterCodeHash: routerHash,
      swapRouter: dex, swapRouterCodeHash: keccak256((await local.publicClient.getCode({ address: dex }))!), quoteSigner: admin.address,
      poolFee: 3000, maxPerSwap: 1000n, maxPerWeek: 2000n, maxQuoteLifetime: 300n }]);
    escrow = await deploy('PlatformRunEscrowEconomicsV2', [{ token, quoteSigner: admin.address, receiptRoot: roots,
      hostRegistry: registry, feeRouter: router, guardian: admin.address }, staking]);
    expect(staking.toLowerCase()).toBe(predictedStaking.toLowerCase()); expect(burner.toLowerCase()).toBe(predictedBurner.toLowerCase());
    expect(escrow.toLowerCase()).toBe(predictedEscrow.toLowerCase());
    await write(token, 'MockToken', 'faucet', [owner.address, 100_000_000n]);
    await write(token, 'MockToken', 'faucet', [host.address, 300_000_000n]);
    await write(token, 'MockToken', 'approve', [registry, maxUint256], host);
    await write(registry, 'HostRegistry', 'register', [id('host-key'), 0, zero, 300_000_000n, false], host);
    hostId = await read(registry, 'HostRegistry', 'operatorHost', [host.address]) as Hex;
    await write(token, 'MockToken', 'approve', [escrow, maxUint256], owner);
    await write(escrow, 'PlatformRunEscrowEconomicsV2', 'deposit', [50_000_000n], owner);
    for (const account of [owner, host, second]) await write(utility, 'TlmrBurnableToken', 'transfer', [account.address, parseEther('1000')]);
    await write(utility, 'TlmrBurnableToken', 'transfer', [dex, parseEther('100000')]);
    snapshot = await test.snapshot();
  }, 90_000);
  beforeEach(async () => { await test.revert({ id: snapshot }); snapshot = await test.snapshot(); });
  afterAll(async () => { if (local) await local.close(); });

  it('keeps every optional runtime below EIP-170 and rejects out-of-policy fee inputs', async () => {
    for (const name of ['PlatformRunEscrowEconomicsV2', 'FeeRouterEconomicsV2', 'TlmrRewardStaking', 'TlmrBuyAndBurn', 'TlmrBurnableToken']) {
      expect((artifact(name).deployedBytecode.length - 2) / 2).toBeLessThanOrEqual(24576);
    }
    expect(await read(router, 'FeeRouterEconomicsV2', 'quoteFeeDiscounted', [1n, false, 300])).toBe(1n);
    expect(await read(router, 'FeeRouterEconomicsV2', 'quoteFeeDiscounted', [1_000_000n, false, 100])).toBe(80_000n);
    expect(await read(router, 'FeeRouterEconomicsV2', 'quoteFeeDiscounted', [1_000_000n, true, 300])).toBe(90_000n);
    await expect(read(router, 'FeeRouterEconomicsV2', 'quoteFeeDiscounted', [1n, false, 301])).rejects.toThrow();
  });
  it('rejects v1 signatures on v2 while preserving ABI selectors', async () => {
    await expect(open('wrong-domain', '1')).rejects.toThrow();
    await expect(open('right-domain')).resolves.toHaveProperty('runId');
  });
  it('locks admission discount, preserves the full host amount and exact budget conservation after holdings fall', async () => {
    const q = await open('discount'); expect(await read(escrow, 'PlatformRunEscrowEconomicsV2', 'runDiscountBps', [q.runId])).toBe(100);
    const reserved = await read(escrow, 'PlatformRunEscrowEconomicsV2', 'totalReserved') as bigint;
    expect(reserved).toBe(1_090_000n);
    await write(utility, 'TlmrBurnableToken', 'transfer', [second.address, parseEther('1000')], owner);
    expect(await read(staking, 'TlmrRewardStaking', 'feeDiscountBps', [owner.address])).toBe(0);
    const result = await settle(q), bucket = await read(router, 'FeeRouterEconomicsV2', 'getBuckets', [result.week]) as { work: bigint; treasury: bigint; stakers: bigint; buyAndBurn: bigint };
    expect(await read(router, 'FeeRouterEconomicsV2', 'hostAccrued', [result.week, host.address])).toBe(500_000n);
    expect(bucket).toEqual({ work: 32_000n, treasury: 4000n, stakers: 2000n, buyAndBurn: 2000n });
    expect(await read(router, 'FeeRouterEconomicsV2', 'accountedBalance')).toBe(540_000n);
    expect(await read(token, 'MockToken', 'balanceOf', [escrow])).toBe(49_460_000n);
    expect(await read(escrow, 'PlatformRunEscrowEconomicsV2', 'availableBalance', [owner.address])).toBe(49_460_000n);
    expect(await read(escrow, 'PlatformRunEscrowEconomicsV2', 'totalReserved')).toBe(0n);
    const reviewed = await pins(), independent = createPlatformReadOnlyBridge(reviewed, local.rpcUrl);
    const financial = await new PlatformPublicFinancialReader(independent, 1).verify(q.runId, result.receipt.transactionHash);
    expect(financial).toMatchObject({ kind: 'settlement', feeDiscountBps: 100, platformFee: '40000', hostAmount: '500000',
      charged: '540000', returnedAmount: '550000' });
    const historical = await readPlatformV2OpeningAuthority(local.publicClient, reviewed, openings.get(q.runId)!, 1);
    expect(historical.authority).toMatchObject({ quoteDomainVersion: '2', feeDiscountBps: 100 });
    const { financialProfile: _legacyProfile, ...legacyPins } = reviewed;
    await expect(readPlatformV2OpeningAuthority(local.publicClient, legacyPins, openings.get(q.runId)!, 1)).rejects.toThrow('signature');
  });
  it('new holdings after admission cannot change the locked settlement tier', async () => {
    await write(utility, 'TlmrBurnableToken', 'transfer', [second.address, parseEther('1000')], owner);
    const q = await open('no-discount');
    await write(utility, 'TlmrBurnableToken', 'transfer', [owner.address, parseEther('100000')]);
    const result = await settle(q);
    expect(await read(escrow, 'PlatformRunEscrowEconomicsV2', 'runDiscountBps', [q.runId])).toBe(0);
    expect(await read(router, 'FeeRouterEconomicsV2', 'accountedBalance')).toBe(545_000n);
    await expect(write(escrow, 'PlatformRunEscrowEconomicsV2', 'settleRun', [result.settlement, result.settlement.endedAt / 3600n, []])).rejects.toThrow();
  });
  it('reads real TLMR stake at one pinned canonical block independently from USDC collateral', async () => {
    await stake(host);
    const block = await local.publicClient.getBlock();
    const policy = { stakingAddress: staking, stakingCodeHash: keccak256((await local.publicClient.getCode({ address: staking }))!),
      tokenAddress: utility, tokenCodeHash: keccak256((await local.publicClient.getCode({ address: utility }))!),
      blockNumber: block.number, blockHash: block.hash, hosts: [{ hostId, operator: host.address, strikes: 3 }] };
    const rows = await readTlmrSchedulingWeights(local.publicClient, policy);
    expect(rows[0]?.activeStake).toBe(parseEther('1000')); expect(rows[0]?.schedulingWeight).toBe(parseEther('250'));
    await write(staking, 'TlmrRewardStaking', 'requestUnstake', [id('reward-agent'), parseEther('1000')], host);
    expect((await readTlmrSchedulingWeights(local.publicClient, policy))[0]?.activeStake).toBe(parseEther('1000'));
    await expect(readTlmrSchedulingWeights(local.publicClient, { ...policy, blockHash: id('wrong-block') })).rejects.toThrow('canonical');
    await expect(readTlmrSchedulingWeights(local.publicClient, { ...policy, stakingCodeHash: id('wrong-code') })).rejects.toThrow('reviewed');
  });
  it('distributes actual USDC staker fees by full-week stake seconds and keeps rounding dust backed', async () => {
    await stake(owner); const target = await week() + 1n;
    await write(signers, 'SignerSet', 'scheduleSigner', [target, admin.address]); await jump(target * 604800n + 1n);
    const q = await open('rewards'), funded = await settle(q);
    await jump(target * 604800n + 302400n); await stake(second);
    await jump((target + 1n) * 604800n + 1n);
    const full = await read(staking, 'TlmrRewardStaking', 'stakeSeconds', [owner.address, target]) as bigint;
    const partial = await read(staking, 'TlmrRewardStaking', 'stakeSeconds', [second.address, target]) as bigint;
    expect(full).toBeGreaterThan(partial); expect(full / partial).toBe(2n);
    await expect(write(router, 'FeeRouterEconomicsV2', 'claimBucket', [funded.week, 2])).rejects.toThrow();
    await write(staking, 'TlmrRewardStaking', 'fundWeek', [target]);
    const before = await read(token, 'MockToken', 'balanceOf', [owner.address]) as bigint;
    await write(staking, 'TlmrRewardStaking', 'claimReward', [target], owner);
    expect(await read(token, 'MockToken', 'balanceOf', [owner.address])).toBe(before + 2000n * full / (full + partial));
    await write(staking, 'TlmrRewardStaking', 'claimReward', [target], second);
    expect(await read(token, 'MockToken', 'balanceOf', [staking])).toBe(await read(staking, 'TlmrRewardStaking', 'accountedRewards'));
    expect(await read(staking, 'TlmrRewardStaking', 'accountedRewards')).toBeLessThanOrEqual(1n);
    await expect(write(staking, 'TlmrRewardStaking', 'claimReward', [target], owner)).rejects.toThrow();
    await expect(write(staking, 'TlmrRewardStaking', 'fundWeek', [target])).rejects.toThrow();
  });
  it('excludes queued stake immediately and keeps already earned historical weight', async () => {
    await stake(owner); const target = await week() + 1n; await jump(target * 604800n);
    await jump(target * 604800n + 302400n);
    await write(staking, 'TlmrRewardStaking', 'requestUnstake', [id('reward-agent'), parseEther('1000')], owner);
    expect(await read(staking, 'TlmrRewardStaking', 'activeByOwner', [owner.address])).toBe(0n);
    await jump((target + 1n) * 604800n);
    expect(await read(staking, 'TlmrRewardStaking', 'stakeSeconds', [owner.address, target])).toBe(parseEther('1000') * 302400n);
    await expect(write(staking, 'TlmrRewardStaking', 'withdrawStake', [id('reward-agent')], owner)).rejects.toThrow();
    await advance(7 * 86400 + 302400);
    await write(staking, 'TlmrRewardStaking', 'withdrawStake', [id('reward-agent')], owner);
    expect(await read(staking, 'TlmrRewardStaking', 'totalCustodied')).toBe(0n);
  });
  it('does not pay a snapshot-sized share to a late flash stake and rejects open/empty reward weeks', async () => {
    await expect(write(staking, 'TlmrRewardStaking', 'fundWeek', [await week()])).rejects.toThrow();
    const target = await week() + 1n; await stake(owner); await jump(target * 604800n);
    await jump((target + 1n) * 604800n - 10n); await stake(second);
    await write(staking, 'TlmrRewardStaking', 'requestUnstake', [id('reward-agent'), parseEther('1000')], second);
    await jump((target + 1n) * 604800n);
    const flash = await read(staking, 'TlmrRewardStaking', 'stakeSeconds', [second.address, target]) as bigint;
    const permanent = await read(staking, 'TlmrRewardStaking', 'stakeSeconds', [owner.address, target]) as bigint;
    expect(flash).toBeLessThan(parseEther('1000') * 10n); expect(permanent).toBe(parseEther('1000') * 604800n);
    await expect(write(staking, 'TlmrRewardStaking', 'fundWeek', [target])).rejects.toThrow();
  });
  it('buys on the reviewed route, removes real TLMR supply, clears allowance and prevents duplicate execution', async () => {
    const result = await fundedWeek('burn'); await jump((result.week + 1n) * 604800n + 1n);
    await expect(write(router, 'FeeRouterEconomicsV2', 'claimBucket', [result.week, 3])).rejects.toThrow();
    await write(burner, 'TlmrBuyAndBurn', 'fundWeek', [result.week]);
    const supply = await read(utility, 'TlmrBurnableToken', 'totalSupply') as bigint, approved = await signedBurn(result.week);
    const reviewed = await burnPins(), normalizedQuote = { ...approved.quote, week: Number(approved.quote.week),
      amountIn: approved.quote.amountIn.toString(), minAmountOut: approved.quote.minAmountOut.toString(),
      validAfter: Number(approved.quote.validAfter), deadline: Number(approved.quote.deadline) };
    const prepared = await prepareBuyAndBurn(local.publicClient, reviewed, normalizedQuote, approved.signature);
    const hash = await wallet(second).sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data, value: 0n });
    await local.publicClient.waitForTransactionReceipt({ hash });
    expect(await read(utility, 'TlmrBurnableToken', 'totalSupply')).toBe(supply - 1000n * 10n ** 12n);
    expect(await read(utility, 'TlmrBurnableToken', 'balanceOf', [burner])).toBe(0n);
    expect(await read(token, 'MockToken', 'allowance', [burner, dex])).toBe(0n);
    expect(await read(burner, 'TlmrBuyAndBurn', 'accountedPayment')).toBe(1000n);
    expect(await read(dex, 'TestReviewedV3Router', 'swaps')).toBe(1n);
    const reconciled = await reconcileBuyAndBurn(local.publicClient, reviewed, normalizedQuote, approved.signature, hash, 1);
    expect(reconciled).toMatchObject({ operationId: approved.quote.operationId, paymentAmount: '1000',
      burnedUtilityAmount: (1000n * 10n ** 12n).toString(), supplyBurnVerified: true });
    expect(await reconcileBuyAndBurn(local.publicClient, reviewed, normalizedQuote, approved.signature, hash, 1)).toEqual(reconciled);
    await expect(prepareBuyAndBurn(local.publicClient, reviewed, normalizedQuote, approved.signature)).rejects.toThrow('already executed');
    await expect(reconcileBuyAndBurn(local.publicClient, reviewed, { ...normalizedQuote, amountIn: '999' }, approved.signature, hash, 1)).rejects.toThrow();
    await expect(write(burner, 'TlmrBuyAndBurn', 'execute', [approved.quote, approved.signature])).rejects.toThrow();
    expect(await read(dex, 'TestReviewedV3Router', 'swaps')).toBe(1n);
  });
  it.each([1, 2, 3])('rolls back rejected, partial-input or false-output swaps, failure mode %s', async failureMode => {
    const result = await fundedWeek('failed-burn'); await jump((result.week + 1n) * 604800n + 1n);
    await write(burner, 'TlmrBuyAndBurn', 'fundWeek', [result.week]); await write(dex, 'TestReviewedV3Router', 'setFailureMode', [failureMode]);
    const approved = await signedBurn(result.week), before = await read(utility, 'TlmrBurnableToken', 'totalSupply');
    await expect(write(burner, 'TlmrBuyAndBurn', 'execute', [approved.quote, approved.signature])).rejects.toThrow();
    expect(await read(burner, 'TlmrBuyAndBurn', 'executedOperation', [approved.quote.operationId])).toBe(false);
    expect(await read(burner, 'TlmrBuyAndBurn', 'accountedPayment')).toBe(2000n);
    expect(await read(token, 'MockToken', 'allowance', [burner, dex])).toBe(0n);
    expect(await read(utility, 'TlmrBurnableToken', 'totalSupply')).toBe(before);
  });
  it('rejects unsigned scope, stale quotes, overspending and insufficient minimum output', async () => {
    const result = await fundedWeek('bounds'); await jump((result.week + 1n) * 604800n + 1n);
    await write(burner, 'TlmrBuyAndBurn', 'fundWeek', [result.week]);
    for (const overrides of [{ amountIn: 1001n }, { minAmountOut: 1001n * 10n ** 12n },
      { deadline: await now() - 1n }, { deadline: await now() + 301n }, { minAmountOut: 0n }]) {
      const approved = await signedBurn(result.week, overrides);
      await expect(write(burner, 'TlmrBuyAndBurn', 'execute', [approved.quote, approved.signature])).rejects.toThrow();
    }
    const approved = await signedBurn(result.week);
    await expect(write(burner, 'TlmrBuyAndBurn', 'execute', [{ ...approved.quote, amountIn: 999n }, approved.signature])).rejects.toThrow();
    expect(await read(dex, 'TestReviewedV3Router', 'swaps')).toBe(0n);
  });
  it('posts and claims deterministic exact weekly work allocation with zero lost USDC units', async () => {
    const funded = await fundedWeek('work'), closed = funded.week; await jump((closed + 1n) * 604800n + 1n);
    const block = await local.publicClient.getBlock(), activity = (recipient: Address, units: string, receiptId: Hex): VerifiedWorkActivity => ({
      kind: 'cpu', receiptId, recipient, units, week: Number(closed), chainId: 31337,
      blockNumber: block.number.toString(), blockHash: block.hash, evidenceDigest: id('accepted-evidence') });
    // This fixture tests the allocation mechanism only. Production CPU verification
    // uses CanonicalCpuWorkVerifier to retrieve both signed/canonical v2 copies.
    const activities = [activity(host.address, '2', id('work-1')), activity(second.address, '1', id('work-2'))];
    const policy = { protocol: 'telomere-weekly-work-policy-v1' as const, chainId: 31337,
      router, policyApproval: id('fixture-policy'), weights: { cpu: '1', probe: '0', verification: '0', storage: '0' } };
    const verifier = { read: async (raw: unknown) => raw as VerifiedWorkActivity, recheck: async () => undefined };
    const plan = await prepareWeeklyWorkAllocation({ client: local.publicClient, pins: await pins(), policy,
      week: Number(closed), handles: activities, verifier, minConfirmations: 1 });
    expect(plan.status).toBe('prepared'); expect(plan.allocated).toBe('32000');
    expect(plan.transaction?.to.toLowerCase()).toBe(router.toLowerCase());
    expect(plan.claims.reduce((sum, claim) => sum + BigInt(claim.amount), 0n)).toBe(32000n);
    await write(router, 'FeeRouterEconomicsV2', 'postWorkRoot', [closed, plan.root, BigInt(plan.allocated)]);
    const reconciled = await prepareWeeklyWorkAllocation({ client: local.publicClient, pins: await pins(), policy,
      week: Number(closed), handles: activities, verifier, minConfirmations: 1 });
    expect(reconciled.status).toBe('already_committed'); expect(reconciled.transaction).toBeNull(); expect(reconciled.planDigest).toBe(plan.planDigest);
    for (const claim of plan.claims) {
      const account = claim.recipient.toLowerCase() === host.address.toLowerCase() ? host : second;
      expect(claim.leaf).toBe(weeklyWorkLeaf(31337, router, Number(closed), account.address, BigInt(claim.amount)));
      await write(router, 'FeeRouterEconomicsV2', 'claimWork', [closed, BigInt(claim.amount), claim.proof], account);
      await expect(write(router, 'FeeRouterEconomicsV2', 'claimWork', [closed, BigInt(claim.amount), claim.proof], account)).rejects.toThrow();
    }
    const buckets = await read(router, 'FeeRouterEconomicsV2', 'getBuckets', [closed]) as { work: bigint };
    expect(buckets.work).toBe(0n);
    expect(await read(token, 'MockToken', 'balanceOf', [router])).toBe(await read(router, 'FeeRouterEconomicsV2', 'accountedBalance'));
  });
  it('accepts only policy-bound canonical non-compute observations and rejects changed units/role/receipt identity', async () => {
    const closedHour = await now() / 3600n - 1n, endedAt = Number(closedHour * 3600n + 1n), closedWeek = Math.floor(endedAt / 604800);
    const allocationPolicy = { protocol: 'telomere-weekly-work-policy-v1' as const, chainId: 31337, router,
      policyApproval: id('local-approved-work-policy'), weights: { cpu: '1', probe: '1', verification: '1', storage: '1' } };
    const policy = { chainId: 31337, receiptRoot: roots, receiptRootCodeHash: keccak256((await local.publicClient.getCode({ address: roots }))!),
      signerSet: signers, signerSetCodeHash: keccak256((await local.publicClient.getCode({ address: signers }))!),
      approvedPolicyDigest: hashJson(allocationPolicy), minConfirmations: 1 };
    // Trusted publisher observations are fixtures, not a claim of live storage/probe capacity.
    const observation = (kind: 'probe' | 'verification' | 'storage', recipient: Address): z.infer<typeof committedWorkObservationSchema> => ({
      protocol: 'telomere-work-observation-v1', kind, sourceReceiptId: id(`accepted-${kind}`), recipient, units: '1',
      week: closedWeek, endedAt, evidenceDigest: id(`measured-${kind}`), policyDigest: policy.approvedPolicyDigest });
    const observations = [observation('probe', host.address), observation('verification', owner.address), observation('storage', second.address)];
    const leaves = observations.map(item => committedWorkLeaf(item, policy)), pair = (a: Hex, b: Hex): Hex =>
      keccak256(`0x${[a, b].sort().map(value => value.slice(2)).join('')}`);
    const lower = pair(leaves[0]!, leaves[1]!), root = pair(lower, leaves[2]!);
    const committed = await write(roots, 'ReceiptRoot', 'postRoot', [closedHour, root, 3]);
    const handles = observations.map((item, index) => ({ observation: item, rootTransactionHash: committed.transactionHash,
      proof: index === 0 ? [leaves[1]!, leaves[2]!] : index === 1 ? [leaves[0]!, leaves[2]!] : [lower] }));
    const verifier = new CanonicalCommittedWorkVerifier(local.publicClient, policy);
    const plan = await buildWeeklyWorkAllocation({ policy: allocationPolicy, week: closedWeek, closedWeek,
      budget: '11', handles, verifier });
    expect(plan.claims.map(claim => BigInt(claim.amount)).sort()).toEqual([3n, 4n, 4n]);
    await expect(verifier.read({ ...handles[0], observation: { ...observations[0], units: '1000000' } })).rejects.toThrow('absent');
    await expect(verifier.read({ ...handles[0], observation: { ...observations[0], kind: 'cpu' } })).rejects.toThrow();
    await expect(verifier.read({ ...handles[0], observation: { ...observations[0], policyDigest: id('unapproved') } })).rejects.toThrow('not approved');
    await expect(buildWeeklyWorkAllocation({ policy: allocationPolicy, week: closedWeek, closedWeek,
      budget: '11', handles: [handles[0], handles[0]], verifier })).rejects.toThrow('Duplicate');
  });
  it('adapts the actual SwapRouter02 ABI with fixed route, deadline, temporary allowance and exact rollback', async () => {
    const adapter = await deploy('TlmrSwapRouter02Adapter', [dex, keccak256((await local.publicClient.getCode({ address: dex }))!),
      owner.address, token, utility, 3000]);
    await write(token, 'MockToken', 'approve', [adapter, 10000n], owner);
    const quote = { tokenIn: token, tokenOut: utility, fee: 3000, recipient: owner.address, deadline: await now() + 300n,
      amountIn: 1000n, amountOutMinimum: 1000n * 10n ** 12n, sqrtPriceLimitX96: 0n };
    const before = await read(utility, 'TlmrBurnableToken', 'balanceOf', [owner.address]) as bigint;
    await write(adapter, 'TlmrSwapRouter02Adapter', 'exactInputSingle', [quote], owner);
    expect(await read(utility, 'TlmrBurnableToken', 'balanceOf', [owner.address])).toBe(before + 1000n * 10n ** 12n);
    expect(await read(token, 'MockToken', 'balanceOf', [adapter])).toBe(0n);
    expect(await read(token, 'MockToken', 'allowance', [adapter, dex])).toBe(0n);
    await expect(write(adapter, 'TlmrSwapRouter02Adapter', 'exactInputSingle', [quote], second)).rejects.toThrow();
    await expect(write(adapter, 'TlmrSwapRouter02Adapter', 'exactInputSingle', [{ ...quote, recipient: second.address }], owner)).rejects.toThrow();
    await expect(write(adapter, 'TlmrSwapRouter02Adapter', 'exactInputSingle', [{ ...quote, deadline: await now() - 1n }], owner)).rejects.toThrow();
    await write(dex, 'TestReviewedV3Router', 'setFailureMode', [2]);
    await expect(write(adapter, 'TlmrSwapRouter02Adapter', 'exactInputSingle', [quote], owner)).rejects.toThrow();
    expect(await read(token, 'MockToken', 'balanceOf', [adapter])).toBe(0n);
    expect(await read(token, 'MockToken', 'allowance', [adapter, dex])).toBe(0n);
    expect(await read(dex, 'TestReviewedV3Router', 'swaps')).toBe(1n);
  });
  it('resolves a real factory Vault owner once before admissions and locks their tier without trusting arbitrary payer.owner()', async () => {
    const identity = await deploy('TestEconomicsIdentity');
    const factory = await deploy('PlatformSelectionRegistry', [{ token, escrow, controller: admin.address, guardian: admin.address,
      identityRegistry: identity, staking, treasury: admin.address, entryFee: 100n, vaultFloor: 100n }]);
    const codeHash = keccak256((await local.publicClient.getCode({ address: factory }))!);
    await expect(write(escrow, 'PlatformRunEscrowEconomicsV2', 'configureDiscountVaultRegistry', [factory, codeHash])).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrowEconomicsV2', 'setOpensPaused', [true]);
    await expect(write(escrow, 'PlatformRunEscrowEconomicsV2', 'configureDiscountVaultRegistry', [factory, codeHash], owner)).rejects.toThrow();
    await expect(write(escrow, 'PlatformRunEscrowEconomicsV2', 'configureDiscountVaultRegistry', [factory, id('wrong-code')])).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrowEconomicsV2', 'configureDiscountVaultRegistry', [factory, codeHash]);
    await expect(write(escrow, 'PlatformRunEscrowEconomicsV2', 'configureDiscountVaultRegistry', [factory, codeHash])).rejects.toThrow();
    await write(escrow, 'PlatformRunEscrowEconomicsV2', 'setOpensPaused', [false]);
    await write(identity, 'TestEconomicsIdentity', 'register', [1n, owner.address]);
    await write(token, 'MockToken', 'approve', [factory, maxUint256], owner);
    await write(factory, 'PlatformSelectionRegistry', 'enter', [{ identityId: 1n, agentWallet: second.address,
      maxPerHour: 20_000_000n, maxPerDay: 200_000_000n, expiry: await now() + 86400n,
      cystHash: id('owner-cyst'), endowment: 10_000_000n,
      scope: { classMask: 1n, sealedOnly: false, imageAllowRoot: zero, regionAllowRoot: zero } }], owner);
    const agentId = await read(factory, 'PlatformSelectionRegistry', 'identityAgent', [1n]) as Hex;
    const agent = await read(factory, 'PlatformSelectionRegistry', 'getAgent', [agentId]) as { vault: Address; leashId: Hex };
    expect((await read(escrow, 'PlatformRunEscrowEconomicsV2', 'discountBeneficiary', [agent.vault]) as Address).toLowerCase()).toBe(owner.address.toLowerCase());
    expect((await read(escrow, 'PlatformRunEscrowEconomicsV2', 'discountBeneficiary', [dex]) as Address).toLowerCase()).toBe(dex.toLowerCase());
    const q = { runId: id('real-vault-discount'), leashId: agent.leashId, hostId, payer: agent.vault, hwClass: 0,
      regionHash: id('local'), imageHash: id('image'), workloadHash: id('workload'), maxSeconds: 10n,
      pricePerSecond: 100_000n, inferencePrice: 0n, quoteExpiry: await now() + 300n };
    const signature = await admin.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '2', chainId: 31337,
      verifyingContract: escrow }, types: platformQuoteTypes, primaryType: 'PlatformQuote', message: q });
    const opened = await write(agent.vault, 'PlatformAgentVault', 'payRun', [q, signature, [], []], second);
    expect(await read(utility, 'TlmrBurnableToken', 'balanceOf', [agent.vault])).toBe(0n);
    expect(await read(escrow, 'PlatformRunEscrowEconomicsV2', 'runDiscountBps', [q.runId])).toBe(100);
    await write(utility, 'TlmrBurnableToken', 'transfer', [host.address, parseEther('1000')], owner);
    const result = await settle(q), baselinePins = await pins();
    const implementationAddress = await read(factory, 'PlatformSelectionRegistry', 'vaultImplementation') as Address;
    const reviewed = platformPinsSchema.parse({ ...baselinePins, financialProfile: { ...baselinePins.financialProfile!,
      discountVaultRegistry: { address: factory, codeHash, implementationAddress,
        implementationCodeHash: keccak256((await local.publicClient.getCode({ address: implementationAddress }))!) } } });
    const independent = createPlatformReadOnlyBridge(reviewed, local.rpcUrl);
    expect(await new PlatformPublicFinancialReader(independent, 1).verify(q.runId, result.receipt.transactionHash))
      .toMatchObject({ feeDiscountBps: 100, platformFee: '40000', hostAmount: '500000' });
    const original = await readPlatformV2OpeningAuthority(local.publicClient, reviewed, opened.transactionHash, 1);
    expect(original.authority).toMatchObject({ quoteDomainVersion: '2', feeDiscountBps: 100 });
    await expect(readPlatformV2OpeningAuthority(local.publicClient, baselinePins, opened.transactionHash, 1)).rejects.toThrow('lacks reviewed');
  });
  it('cannot bind a discount factory after any first admission even if the guardian pauses opens', async () => {
    await open('first-admission'); await write(escrow, 'PlatformRunEscrowEconomicsV2', 'setOpensPaused', [true]);
    await expect(write(escrow, 'PlatformRunEscrowEconomicsV2', 'configureDiscountVaultRegistry', [registry,
      keccak256((await local.publicClient.getCode({ address: registry }))!)])).rejects.toThrow();
    expect(await read(escrow, 'PlatformRunEscrowEconomicsV2', 'hasAdmittedRun')).toBe(true);
  });
  it('bounds integral arithmetic so a huge fixed supply cannot trap an active stake on later unstake', async () => {
    const enormous = await deploy('TlmrBurnableToken', [admin.address, maxUint256]);
    const nonce = BigInt(await local.publicClient.getTransactionCount({ address: admin.address }));
    const predicted = getContractAddress({ from: admin.address, nonce: nonce + 1n });
    const feeRouter = await deploy('FeeRouterEconomicsV2', [token, admin.address, admin.address, admin.address, predicted, admin.address]);
    const bounded = await deploy('TlmrRewardStaking', [enormous, token, feeRouter,
      keccak256((await local.publicClient.getCode({ address: feeRouter }))!)]);
    const cap = await read(bounded, 'TlmrRewardStaking', 'MAX_CUSTODIED_STAKE') as bigint;
    await write(enormous, 'TlmrBurnableToken', 'approve', [bounded, maxUint256]);
    await expect(write(bounded, 'TlmrRewardStaking', 'stake', [id('enormous-stake'), cap + 1n])).rejects.toThrow();
    expect(await read(enormous, 'TlmrBurnableToken', 'balanceOf', [admin.address])).toBe(maxUint256);
    await write(bounded, 'TlmrRewardStaking', 'stake', [id('enormous-stake'), cap]);
    await advance(2);
    await write(bounded, 'TlmrRewardStaking', 'requestUnstake', [id('enormous-stake'), cap]);
    expect(await read(bounded, 'TlmrRewardStaking', 'activeByOwner', [admin.address])).toBe(0n);
    await advance(14 * 86400);
    await write(bounded, 'TlmrRewardStaking', 'withdrawStake', [id('enormous-stake')]);
    expect(await read(enormous, 'TlmrBurnableToken', 'balanceOf', [admin.address])).toBe(maxUint256);
  });
});
