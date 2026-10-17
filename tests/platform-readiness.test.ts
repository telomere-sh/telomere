import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { openStore } from '../src/store.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema, platformEscrowAbi } from '../src/platform-runtime/types.js';
import { platformRuns, platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { PlatformReceiptService, platformReceiptRootAbi } from '../src/receipts/platform-service.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const id = (value: string) => keccak256(toHex(value));
describe('actual financial publication signer readiness before new work', () => {
  let fixture: Awaited<ReturnType<typeof deployPlatformRuntime>>, snapshot: Hex;
  let store: Awaited<ReturnType<typeof openStore>>, bridge: PlatformBridge, runtime: PlatformRuntimeService, executor: PlatformHostExecutor;
  let nextWeek: number; let count = 0;
  const leashId = id('readiness-leash'), zero = `0x${'0'.repeat(64)}` as Hex;
  const now = async () => Number((await fixture.local.publicClient.getBlock()).timestamp);
  async function advance(timestamp: number) { await fixture.test.setNextBlockTimestamp({ timestamp: BigInt(timestamp) }); await fixture.test.mine({ blocks: 1 }); }
  async function schedule(address: string) {
    const signers = await fixture.local.publicClient.readContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'signerSet' });
    await fixture.confirmed(fixture.owner.writeContract({ address: signers, abi: fixture.artifact('SignerSet').abi,
      functionName: 'scheduleSigner', args: [BigInt(nextWeek), address] }));
  }
  async function prepare() {
    return runtime.quote(fixture.accounts.owner.address, { leashId, task: { kind: 'sha256', text: 'signer-readiness' },
      maxSeconds: 20, deadline: await now() + 300, maxSpend: '10000' }, `ready-${count++}`);
  }
  async function untouched(before: number, expectedRows = 0) {
    expect(await store.db.select().from(platformRuns)).toHaveLength(expectedRows);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
    expect(await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address })).toBe(before);
    expect(executor.run).not.toHaveBeenCalled();
  }
  beforeAll(async () => { fixture = await deployPlatformRuntime(id('ready-host')); snapshot = await fixture.test.snapshot(); }, 120_000);
  beforeEach(async () => {
    await fixture.test.revert({ id: snapshot }); snapshot = await fixture.test.snapshot();
    nextWeek = Math.floor(await now() / 604800) + 1;
    store = await openStore({ DATA_DIR: ':memory:' });
    bridge = new PlatformBridge(store.db, { pins: fixture.pins, rpcUrl: fixture.local.rpcUrl, signerPrivateKey: fixture.keys.signer });
    executor = new PlatformHostExecutor(store.db, new Map());
    vi.spyOn(executor, 'run').mockImplementation(async () => { throw new Error('CPU must not be dispatched by readiness checks'); });
    vi.spyOn(executor, 'capacityAvailable').mockResolvedValue(true);
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: fixture.pins.escrowAddress,
      receiptRootAddress: fixture.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    const host = platformHostSchema.parse({ hostId: fixture.hostId, hostKey: id('ready-host'), hardwareClass: 'cpu', region: 'fixture',
      image: `example/cpu@sha256:${'1'.repeat(64)}`, imageDigest: `sha256:${'1'.repeat(64)}`, sealed: false, lane: 'standard',
      pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    runtime = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts); await runtime.initialize();
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: fixture.artifact('PlatformRunEscrow').abi,
      functionName: 'createLeash', args: [leashId, { agent: fixture.accounts.owner.address, maxPerHour: 1_000_000n, maxPerDay: 1_000_000n,
        classMask: 1n, sealedOnly: false, imageAllowRoot: zero, regionAllowRoot: zero, expiry: BigInt(await now() + 30 * 86400) }] }));
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); });
  afterAll(async () => { await fixture.close(); });

  it('refuses a quote when the actual current signer epoch is missing', async () => {
    await advance(nextWeek * 604800 + 60); const nonce = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address });
    // Financial publisher readiness must not prevent original-lease recovery or refund-plan access.
    await expect(bridge.check()).resolves.toBeUndefined(); await expect(runtime.initialize()).resolves.toBeUndefined();
    await expect(prepare()).rejects.toThrow(); await untouched(nonce);
  });
  it('refuses a quote when its hour-close publication falls in an unscheduled next epoch', async () => {
    await advance(nextWeek * 604800 - 90); const nonce = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address });
    await expect(prepare()).rejects.toThrow(); await untouched(nonce);
  });
  it('refuses new work when governance scheduled another publication signer at hour close', async () => {
    await schedule(fixture.accounts.outsider.address); await advance(nextWeek * 604800 - 90);
    const nonce = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address });
    await expect(prepare()).rejects.toThrow(); await untouched(nonce);
  });
  it('prepares an offline quote when the approved next epoch keeps the dedicated publication signer', async () => {
    await schedule(fixture.accounts.signer.address); await advance(nextWeek * 604800 + 60);
    const nonce = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address });
    const quote = await prepare(); expect(quote.quote.hostId).toBe(fixture.hostId); await untouched(nonce, 1);
  });
  it('does not admit or dispatch an earlier paid reservation after its publication signer epoch becomes unavailable', async () => {
    const prepared = await prepare();
    const admission = await fixture.confirmed(fixture.owner.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data as Hex, value: 0n }));
    await advance(nextWeek * 604800 + 60); const nonce = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.signer.address });
    await expect(runtime.admit(fixture.accounts.owner.address, { runId: prepared.quote.runId, transactionHash: admission.transactionHash }, 'readiness-admit')).rejects.toThrow();
    await untouched(nonce, 1); expect((await runtime.get(fixture.accounts.owner.address, prepared.quote.runId)).status).toBe('prepared');
    expect((await bridge.run(prepared.quote.runId)).status).toBe(1);
    expect(await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'availableBalance', args: [fixture.accounts.owner.address] })).toBe(1_000_000n - BigInt(prepared.ceiling));
    const refundPlan = await runtime.refundPlan(fixture.accounts.owner.address, prepared.quote.runId);
    await fixture.confirmed(fixture.owner.sendTransaction({ to: refundPlan.to, data: refundPlan.data, value: 0n }));
    expect((await bridge.balance(fixture.accounts.owner.address)).available).toBe('1000000'); await untouched(nonce, 1);
  });

  it('reconciles an independent refund even when another queued run cannot publish in the new epoch', async () => {
    const stopped = await prepare();
    const stoppedAdmission = await fixture.confirmed(fixture.owner.sendTransaction({ to: stopped.transaction.to, data: stopped.transaction.data as Hex, value: 0n }));
    await runtime.admit(fixture.accounts.owner.address, { runId: stopped.quote.runId, transactionHash: stoppedAdmission.transactionHash }, 'stopped-ready');
    const stop = await runtime.stopPlan(fixture.accounts.owner.address, stopped.quote.runId);
    await fixture.confirmed(fixture.owner.sendTransaction({ to: stop.to, data: stop.data, value: 0n }));
    await runtime.drain(); expect((await runtime.get(fixture.accounts.owner.address, stopped.quote.runId)).status).toBe('receipt_pending');
    const queued = await prepare();
    const queuedAdmission = await fixture.confirmed(fixture.owner.sendTransaction({ to: queued.transaction.to, data: queued.transaction.data as Hex, value: 0n }));
    await runtime.admit(fixture.accounts.owner.address, { runId: queued.quote.runId, transactionHash: queuedAdmission.transactionHash }, 'queued-ready');
    await advance(nextWeek * 604800 + 60);
    const refund = await runtime.refundPlan(fixture.accounts.owner.address, stopped.quote.runId);
    await fixture.confirmed(fixture.owner.sendTransaction({ to: refund.to, data: refund.data, value: 0n }));
    await expect(runtime.drain()).resolves.toBeUndefined();
    expect((await runtime.get(fixture.accounts.owner.address, stopped.quote.runId)).status).toBe('refunded');
    expect(executor.run).not.toHaveBeenCalled();
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(0);
  });
});
