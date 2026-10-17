import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createWalletClient, getAbiItem, http, keccak256, parseAbi, toHex, type Hex } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { openStore } from '../src/store.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformPublicFinancialReader } from '../src/platform-runtime/public-financial.js';
import { createPlatformPublicFinancialRoutes } from '../src/platform-runtime/public-financial-routes.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformQuoteTypes, typedPlatformQuote, typedPlatformSettlement,
  type PlatformQuote, type PlatformSettlement } from '../src/platform-runtime/types.js';
import { platformFinancialLeaf } from '../src/receipts/platform-merkle.js';
import { platformReceiptRootAbi } from '../src/receipts/platform-service.js';
import { receiptTree } from '../src/receipts/merkle.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const id = (value: string) => keccak256(toHex(value));

describe('public read-only Platform financial evidence', () => {
  let fixture: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let bridge: PlatformBridge;
  let snapshot: Hex;
  let serial = 0;
  const now = async () => Number((await fixture.local.publicClient.getBlock()).timestamp);
  async function advance(timestamp: number) {
    await fixture.test.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
    await fixture.test.mine({ blocks: 1 });
  }
  async function open(pricePerSecond = 1000n, inferencePrice = 0n) {
    const leashId = id(`public-leash-${serial++}`), timestamp = await now();
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
      abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'createLeash',
      args: [leashId, { agent: fixture.accounts.owner.address, maxPerHour: 1_000_000n, maxPerDay: 1_000_000n,
        classMask: 1n, sealedOnly: false, imageAllowRoot: PLATFORM_ZERO, regionAllowRoot: PLATFORM_ZERO,
        expiry: BigInt(timestamp + 86_400) }] }));
    const quote: PlatformQuote = { runId: id(`public-run-${serial++}`), leashId, hostId: fixture.hostId,
      payer: fixture.accounts.owner.address, hwClass: 0, regionHash: id('region'), imageHash: id('image'),
      workloadHash: id('workload'), maxSeconds: 20, pricePerSecond: pricePerSecond.toString(),
      inferencePrice: inferencePrice.toString(), quoteExpiry: timestamp + 300 };
    const signature = await fixture.accounts.signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
      chainId: 31337, verifyingContract: fixture.pins.escrowAddress }, primaryType: 'PlatformQuote',
      types: platformQuoteTypes, message: typedPlatformQuote(quote) });
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'openRun', args: [typedPlatformQuote(quote), signature, [], []] }));
    return quote;
  }
  async function settled(quote: PlatformQuote, billableSeconds = 3, inferenceCharge = 0n) {
    await advance(await now() + 5);
    const outcome: PlatformSettlement = { runId: quote.runId, billableSeconds, endedAt: await now(),
      inferenceCharge: inferenceCharge.toString(), receiptHash: id(`public-receipt-${serial++}`) };
    const run = await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress,
      abi: platformEscrowAbi, functionName: 'getRun', args: [quote.runId] });
    const leaf = platformFinancialLeaf(31337, fixture.pins.escrowAddress, run, outcome);
    await advance((Math.floor(outcome.endedAt / 3600) + 1) * 3600 + 1);
    const signer = createWalletClient({ account: fixture.accounts.signer, chain: localChain,
      transport: http(fixture.local.rpcUrl, { retryCount: 0 }) });
    await fixture.confirmed(signer.writeContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi,
      functionName: 'postRoot', args: [BigInt(Math.floor(outcome.endedAt / 3600)), leaf, 1] }));
    const receipt = await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
      abi: platformEscrowAbi, functionName: 'settleRun', args: [typedPlatformSettlement(outcome),
        BigInt(Math.floor(outcome.endedAt / 3600)), []] }));
    return { outcome, receipt, leaf };
  }
  beforeAll(async () => { fixture = await deployPlatformRuntime(id('public-financial-host')); snapshot = await fixture.test.snapshot(); }, 120_000);
  beforeEach(async () => {
    await fixture.test.revert({ id: snapshot }); snapshot = await fixture.test.snapshot();
    await advance((Math.floor(await now() / 3600) + 1) * 3600 + 600);
    store = await openStore({ DATA_DIR: ':memory:' });
    bridge = new PlatformBridge(store.db, { pins: fixture.pins, rpcUrl: fixture.local.rpcUrl, signerPrivateKey: fixture.keys.signer });
  });
  afterEach(async () => { await store.close(); });
  afterAll(async () => { await fixture.close(); });

  it('verifies a real settlement through unauthenticated HTTP from calldata, Merkle root, escrow state and amounts', async () => {
    const quote = await open(), { outcome, receipt, leaf } = await settled(quote);
    const routes = createPlatformPublicFinancialRoutes(new PlatformPublicFinancialReader(bridge, 1));
    const response = await routes.request(`/receipts/${quote.runId}?transactionHash=${receipt.transactionHash}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ kind: 'settlement', runId: quote.runId,
      transactionHash: receipt.transactionHash, receiptHash: outcome.receiptHash, receiptLeaf: leaf,
      hostAmount: '3000', platformFee: '270', charged: '3270', returnedAmount: '18530',
      ceiling: '21800', proofVerified: true, verification: 'chain-financial-only', tickSignaturesVerified: false });
    await expect(new PlatformPublicFinancialReader(bridge, 1).verify(id('other-run'), receipt.transactionHash))
      .rejects.toMatchObject({ code: 'platform_financial_settlement' });
  }, 30_000);

  it('reports only canonical timeout refunds in a bounded finalized event window', async () => {
    const quote = await open(), { receipt: settlement } = await settled(quote);
    const timeout = await open();
    const opened = await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress,
      abi: platformEscrowAbi, functionName: 'getRun', args: [timeout.runId] });
    await advance(Number(opened.openedAt + opened.maxSeconds + 21_600n));
    const refunded = await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
      abi: platformEscrowAbi, functionName: 'refundRun', args: [timeout.runId] }));
    const reader = new PlatformPublicFinancialReader(bridge, 1);
    expect(await reader.verify(timeout.runId, refunded.transactionHash)).toMatchObject({ kind: 'timeout-refund',
      charged: '0', returnedAmount: '21800', verification: 'chain-financial-only' });
    const routes = createPlatformPublicFinancialRoutes(reader);
    const response = await routes.request(`/refund-rate?fromBlock=${settlement.blockNumber}&toBlock=${refunded.blockNumber}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ finalizedRuns: 2, settledRuns: 1,
      timeoutRefundedRuns: 1, timeoutRefundRateBps: 5000 });
    await expect(reader.refundRate(settlement.blockNumber.toString(), (refunded.blockNumber + 256n).toString()))
      .rejects.toMatchObject({ code: 'platform_refund_window' });
  }, 30_000);

  it('verifies each settlement in a real atomic batch from its own calldata proof and event', async () => {
    const quotes = [await open(), await open()];
    await advance(await now() + 5);
    const endedAt = await now();
    const outcomes: PlatformSettlement[] = quotes.map(quote => ({ runId: quote.runId, billableSeconds: 2,
      endedAt, inferenceCharge: '0', receiptHash: id(`public-batch-receipt-${serial++}`) }));
    const leaves = await Promise.all(outcomes.map(async outcome => platformFinancialLeaf(31337, fixture.pins.escrowAddress,
      await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi,
        functionName: 'getRun', args: [outcome.runId] }), outcome)));
    const tree = receiptTree(leaves), hour = BigInt(Math.floor(endedAt / 3600));
    await advance((Number(hour) + 1) * 3600 + 1);
    const signer = createWalletClient({ account: fixture.accounts.signer, chain: localChain,
      transport: http(fixture.local.rpcUrl, { retryCount: 0 }) });
    await fixture.confirmed(signer.writeContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi,
      functionName: 'postRoot', args: [hour, tree.root, 2] }));
    const receipt = await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
      abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'settleBatch',
      args: [outcomes.map((outcome, index) => ({ settlement: typedPlatformSettlement(outcome), hour, proof: tree.proof(index) }))] }));
    const reader = new PlatformPublicFinancialReader(bridge, 1);
    for (const [index, outcome] of outcomes.entries()) {
      expect(await reader.verify(outcome.runId, receipt.transactionHash)).toMatchObject({ kind: 'settlement',
        receiptHash: outcome.receiptHash, receiptLeaf: leaves[index], charged: '2180', returnedAmount: '19620' });
    }
  }, 30_000);

  it('withholds unconfirmed and orphaned finalizations', async () => {
    const quote = await open(), { receipt } = await settled(quote);
    await expect(new PlatformPublicFinancialReader(bridge, 3).verify(quote.runId, receipt.transactionHash))
      .rejects.toMatchObject({ code: 'platform_financial_unconfirmed' });
    const reader = new PlatformPublicFinancialReader(bridge, 1);
    expect((await reader.verify(quote.runId, receipt.transactionHash)).kind).toBe('settlement');
    await fixture.test.revert({ id: snapshot });
    await expect(reader.verify(quote.runId, receipt.transactionHash)).rejects.toThrow();
  }, 30_000);

  it('rechecks confirmation depth after RPC reads and reports the final accepted head', async () => {
    const quote = await open(), { receipt } = await settled(quote);
    await fixture.test.mine({ blocks: 2 });
    const head = await bridge.public.getBlockNumber({ cacheTime: 0 });
    const getBlockNumber = vi.spyOn(bridge.public, 'getBlockNumber');
    try {
      getBlockNumber.mockResolvedValueOnce(head).mockResolvedValueOnce(head - 1n);
      await expect(new PlatformPublicFinancialReader(bridge, 2).verify(quote.runId, receipt.transactionHash))
        .resolves.toMatchObject({ kind: 'settlement', confirmations: '2' });
      getBlockNumber.mockResolvedValueOnce(head - 1n).mockResolvedValueOnce(head - 2n);
      await expect(new PlatformPublicFinancialReader(bridge, 2).verify(quote.runId, receipt.transactionHash))
        .rejects.toMatchObject({ code: 'platform_financial_unconfirmed' });
      getBlockNumber.mockResolvedValueOnce(head - 1n).mockResolvedValueOnce(head - 2n);
      await expect(new PlatformPublicFinancialReader(bridge, 2)
        .refundRate(receipt.blockNumber.toString(), receipt.blockNumber.toString()))
        .rejects.toMatchObject({ code: 'platform_financial_unconfirmed' });
    } finally { getBlockNumber.mockRestore(); }
  }, 30_000);

  it('publishes restricted CPU unit-price quantiles from canonical finalization times, excluding inference-only work', async () => {
    const signerSet = await fixture.local.publicClient.readContract({ address: fixture.pins.receiptRootAddress,
      abi: platformReceiptRootAbi, functionName: 'signerSet' });
    await fixture.confirmed(fixture.owner.writeContract({ address: signerSet,
      abi: parseAbi(['function scheduleSigner(uint64 week,address signer)']), functionName: 'scheduleSigner',
      args: [BigInt(Math.floor(await now() / 604_800) + 1), fixture.accounts.signer.address] }));
    await settled(await open(500n));
    await advance(await now() + 25 * 3600);
    await settled(await open(9000n, 1000n), 0, 1000n);
    await settled(await open(7500n, 1000n), 3, 1000n);
    await settled(await open(1000n));
    await settled(await open(2001n));
    await settled(await open(3000n));
    const response = await createPlatformPublicFinancialRoutes(new PlatformPublicFinancialReader(bridge, 1))
      .request('/cpu-price-board');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const board = await response.json();
    expect(board).toMatchObject({ coverage: 'restricted-reviewed-platform-cpu-unsealed-settlements',
      marketWide: false, standardLaneOnchainVerified: false, unit: 'micro-USDC-per-billable-second-before-platform-fee',
      rpcLogEnumerationAssumed: true, settledEventsVerified: 6, eligibleCpuSettlements: 4,
      windows: {
        '1h': { count: 1, p10MicroUsdcPerSecond: '3000', medianMicroUsdcPerSecond: '3000', p90MicroUsdcPerSecond: '3000' },
        '24h': { count: 3, p10MicroUsdcPerSecond: '1000', medianMicroUsdcPerSecond: '2001', p90MicroUsdcPerSecond: '3000' },
        '7d': { count: 4, p10MicroUsdcPerSecond: '500', medianMicroUsdcPerSecond: '1500.5', p90MicroUsdcPerSecond: '3000' },
      } });
  }, 60_000);

  it('returns null quantiles for no eligible settlement and excludes the exact start of a fixed window', async () => {
    const reader = new PlatformPublicFinancialReader(bridge, 1);
    const empty = await reader.cpuPriceBoard();
    expect(empty.windows['1h']).toMatchObject({ count: 0, p10MicroUsdcPerSecond: null,
      medianMicroUsdcPerSecond: null, p90MicroUsdcPerSecond: null });
    const { receipt } = await settled(await open());
    const finalization = await fixture.local.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    await advance(Number(finalization.timestamp) + 3600);
    const board = await reader.cpuPriceBoard();
    expect(board.windows['1h']).toMatchObject({ count: 0, medianMicroUsdcPerSecond: null });
    expect(board.windows['24h']).toMatchObject({ count: 1, medianMicroUsdcPerSecond: '1000' });
  }, 60_000);

  it('fails closed when the seven-day event set is over limit or a returned settlement log is not canonical', async () => {
    const quote = await open(), { receipt } = await settled(quote);
    const event = getAbiItem({ abi: platformEscrowAbi, name: 'RunSettled' });
    const original = await bridge.public.getLogs({ address: fixture.pins.escrowAddress,
      event, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber, strict: true });
    expect(original).toHaveLength(1);
    const reader = new PlatformPublicFinancialReader(bridge, 1);
    const getLogs = vi.spyOn(bridge.public, 'getLogs');
    try {
      getLogs.mockResolvedValueOnce(Array(129).fill(original[0]) as typeof original);
      await expect(reader.cpuPriceBoard()).rejects.toMatchObject({ status: 503, code: 'platform_price_board_limit' });
      getLogs.mockResolvedValueOnce([{ ...original[0]!, blockHash: id('orphaned-price-event') }] as typeof original);
      await expect(reader.cpuPriceBoard()).rejects.toMatchObject({ code: 'platform_price_board_reorg' });
      getLogs.mockResolvedValueOnce([original[0]!, original[0]!] as typeof original);
      await expect(reader.cpuPriceBoard()).rejects.toMatchObject({ code: 'platform_price_board_log' });
      getLogs.mockResolvedValueOnce([{ ...original[0]!, args: { ...original[0]!.args, hostAmount: 1n } }] as typeof original);
      await expect(reader.cpuPriceBoard()).rejects.toMatchObject({ code: 'platform_price_board_log' });
      expect((await reader.cpuPriceBoard()).windows['7d']).toMatchObject({ count: 1,
        medianMicroUsdcPerSecond: '1000' });
    } finally { getLogs.mockRestore(); }
  }, 60_000);

  it('withholds the price board if a real Anvil settlement is orphaned while its event scan is in progress', async () => {
    const beforeSettlement = await fixture.test.snapshot();
    const quote = await open(), { receipt } = await settled(quote);
    const original = await bridge.public.getLogs({ address: fixture.pins.escrowAddress,
      event: getAbiItem({ abi: platformEscrowAbi, name: 'RunSettled' }),
      fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber, strict: true });
    const getLogs = vi.spyOn(bridge.public, 'getLogs').mockImplementationOnce(async () => {
      await fixture.test.revert({ id: beforeSettlement });
      return original;
    });
    try { await expect(new PlatformPublicFinancialReader(bridge, 1).cpuPriceBoard()).rejects.toThrow(); }
    finally { getLogs.mockRestore(); }
  }, 60_000);
});
