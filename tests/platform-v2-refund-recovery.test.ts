import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hashJson, randomId } from '../src/common.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { Ed25519Identity, hostMessageHash, hostTickSchema, leaseSchema } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { platformHostLeases, platformRuns } from '../src/platform-runtime/schema.js';
import { PlatformRuntimeService, type PlatformReceiptPort, type PlatformV2ReceiptPort } from '../src/platform-runtime/service.js';
import { platformEscrowAbi, platformHostSchema, platformQuoteSchema, platformWorkloadHash,
  validatedPlatformQuoteInputSchema } from '../src/platform-runtime/types.js';
import { RunMeter } from '../src/runtime/meter.js';
import { openStore } from '../src/store.js';

async function fixture(status: 'queued' | 'running' = 'running') {
  const store = await openStore({ DATA_DIR: ':memory:' });
  const owner = '0x1111111111111111111111111111111111111111', key = randomId();
  const signer = privateKeyToAccount(key), controller = new Ed25519Identity(), hostIdentity = new Ed25519Identity();
  const address = (digit: string) => `0x${digit.repeat(40)}` as const;
  const pins = { chainId: 31337 as const, escrowAddress: address('2'), tokenAddress: address('3'),
    quoteSigner: signer.address, receiptRootAddress: address('4'), hostRegistryAddress: address('5'),
    feeRouterAddress: address('6'), tokenCodeHash: randomId(), reviewedTokenKind: 'immutable' as const,
    escrowCodeHash: randomId(), receiptRootCodeHash: randomId(), hostRegistryCodeHash: randomId(), feeRouterCodeHash: randomId() };
  const bridge = new PlatformBridge(store.db, { pins, rpcUrl: 'http://127.0.0.1:1', signerPrivateKey: key });
  vi.spyOn(bridge.public, 'request').mockRejectedValue(new Error('Unexpected network request in v2 refund recovery fixture'));
  vi.spyOn(bridge, 'check').mockResolvedValue();
  vi.spyOn(bridge, 'now').mockResolvedValue(1_700_000_010);
  vi.spyOn(bridge, 'publicationReady').mockResolvedValue();
  const input = validatedPlatformQuoteInputSchema.parse({ leashId: randomId(), task: { kind: 'sha256', text: 'x' },
    maxSeconds: 20, deadline: 1_700_000_300, maxSpend: '10000' });
  const image = `fixture/cpu@sha256:${'a'.repeat(64)}`, hostId = randomId();
  const quote = platformQuoteSchema.parse({ runId: randomId(), leashId: input.leashId, hostId, payer: owner,
    hwClass: 0, regionHash: keccak256(toHex('local-test')), imageHash: keccak256(toHex(image.split('@')[1]!)),
    workloadHash: platformWorkloadHash(input), maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0',
    quoteExpiry: 1_700_000_300 });
  const chainRun = { payer: owner as Hex, hostOperator: owner as Hex, leashId: quote.leashId, hostId,
    hwClass: 0, regionHash: quote.regionHash, imageHash: quote.imageHash, workloadHash: quote.workloadHash,
    sealedHost: false, openedAt: 1_700_000_000n, acceptedExpiry: 1_700_000_300n, maxSeconds: 20n,
    stopAt: 0n, pricePerSecond: 100n, inferencePrice: 0n, ceiling: 2000n, status: 1,
    billableSeconds: 0n, inferenceCharge: 0n, receiptHash: `0x${'0'.repeat(64)}` as Hex, hostReleased: false };
  vi.spyOn(bridge, 'run').mockImplementation(async () => chainRun);
  const leash = { owner: owner as Hex, agent: owner as Hex, maxPerHour: 10_000n, maxPerDay: 100_000n,
    classMask: 1n, sealedOnly: false, imageAllowRoot: randomId(), regionAllowRoot: randomId(),
    expiry: 1_700_000_300n, killed: false, killedAt: 0n, hourKey: 0n, dayKey: 0n,
    spentHour: 0n, spentDay: 0n, pending: 2000n };
  vi.spyOn(bridge, 'leash').mockImplementation(async () => leash);
  const host = platformHostSchema.parse({ hostId, hostKey: hostIdentity.publicKey,
    hardwareClass: 'cpu', region: 'local-test', image, imageDigest: image.split('@')[1], sealed: false,
    lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
  const executor = new PlatformHostExecutor(store.db, new Map());
  const dispatch = vi.spyOn(executor, 'run').mockRejectedValue(new Error('Recovery must never dispatch a CPU task'));
  const recover = vi.spyOn(executor, 'recover').mockRejectedValue(new Error('Unexpected original host recovery'));
  const receipts: PlatformReceiptPort = { record: vi.fn(async () => undefined), publishClosed: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined), proof: vi.fn(async () => undefined) };
  const issuer: PlatformV2ReceiptPort = { initialize: vi.fn(async () => undefined),
    prepare: vi.fn(async () => { throw new Error('Incomplete execution cannot fabricate v2 or v1 evidence'); }),
    assertPublished: vi.fn(async () => { throw new Error('No settled v2 receipt exists'); }) };
  const service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, undefined, undefined, issuer);
  await store.db.insert(platformRuns).values({ id: quote.runId, owner, agent: owner, idemKey: randomId(),
    inputHash: hashJson(input), input, quote, signature: await bridge.signQuote(quote), ceiling: '2000',
    imageProof: [], regionProof: [], status, receiptVersion: 2, admissionTx: randomId() });
  const meter = new RunMeter(quote.runId, quote.maxSeconds);
  await meter.emit('cancelled', 0, ''); await meter.flush();
  const result = { status: 'cancelled' as const, output: '', exitCode: -1, billableSeconds: 0, ticks: meter.ticks };
  async function installHost(pairKind: 'empty' | 'running' | 'mismatch', cleanupConfirmed: 0 | 1 = 0) {
    const issuedAt = 1_700_000_000_000;
    const lease = controller.sign('lease', leaseSchema.parse({ version: 1, hostKey: hostIdentity.publicKey,
      runId: quote.runId, owner, image, argv: ['/app/run'], issuedAt, expiresAt: issuedAt + 20_000,
      maxSeconds: 20, nonce: randomId() }));
    const hostMeter = new HostMeterVerifier(lease.body, controller, () => issuedAt);
    const tick = hostIdentity.sign('tick', hostTickSchema.parse({ version: 1, hostKey: hostIdentity.publicKey,
      runId: quote.runId, owner, leaseHash: hostMeter.leaseHash, sequence: 0, timestamp: issuedAt,
      elapsedMs: 0, cpuMs: 0, state: 'RUNNING', previousHash: null,
      heartbeat: { sequence: 0, elapsedMs: 0, receivedAt: issuedAt }, gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
    await store.db.insert(platformHostLeases).values({ runId: quote.runId, hostId, owner,
      leaseHash: hostMessageHash(lease), lease, cleanupConfirmed,
      ticks: pairKind === 'empty' ? [] : [tick], acknowledgments: pairKind === 'running' ? [hostMeter.accept(tick)] : [] });
    recover.mockImplementation(async () => {
      await store.db.update(platformHostLeases).set({ cleanupConfirmed: 1 }).where(eq(platformHostLeases.runId, quote.runId));
      return result;
    });
  }
  return { store, service, bridge, quote, chainRun, leash, dispatch, recover, issuer, receipts, installHost };
}

describe('Platform v2 incomplete execution retains the original refund path', () => {
  it('recovers a crash before any HostKit lease without dispatch or fabricated receipt, then observes the original refund', async () => {
    const value = await fixture();
    try {
      await value.service.initialize();
      let [row] = await value.store.db.select().from(platformRuns);
      expect(row).toMatchObject({ status: 'reconciliation', receiptVersion: 2,
        errorCode: 'platform_v2_unexecuted', result: null, settlement: null });
      expect(value.recover).not.toHaveBeenCalled();
      expect(value.dispatch).not.toHaveBeenCalled();
      expect(value.issuer.prepare).not.toHaveBeenCalled();
      const plan = await value.service.refundPlan(value.quote.payer, value.quote.runId);
      expect(decodeFunctionData({ abi: platformEscrowAbi, data: plan.data })).toEqual({
        functionName: 'refundRun', args: [value.quote.runId] });
      value.chainRun.status = 3; value.chainRun.hostReleased = true;
      await value.service.drain();
      [row] = await value.store.db.select().from(platformRuns);
      expect(row).toMatchObject({ status: 'refunded', receiptVersion: 2, charged: '0', refund: '2000',
        settlement: null, settlementTx: null, errorCode: null });
      expect(value.receipts.record).not.toHaveBeenCalled();
      expect(value.issuer.prepare).not.toHaveBeenCalled();
      expect(value.dispatch).not.toHaveBeenCalled();
    } finally { await value.store.close(); vi.restoreAllMocks(); }
  });

  for (const pairKind of ['empty', 'running', 'mismatch'] as const) {
    it(`keeps incomplete ${pairKind} signed meter history unchanged after confirmed original cleanup`, async () => {
      const value = await fixture();
      try {
        await value.installHost(pairKind);
        const [original] = await value.store.db.select().from(platformHostLeases);
        await value.service.initialize();
        const [row] = await value.store.db.select().from(platformRuns);
        const [host] = await value.store.db.select().from(platformHostLeases);
        expect(row).toMatchObject({ status: 'reconciliation', receiptVersion: 2,
          errorCode: 'platform_v2_incomplete_meter', settlement: null });
        expect(host).toMatchObject({ cleanupConfirmed: 1, ticks: original!.ticks, acknowledgments: original!.acknowledgments });
        expect(value.recover).toHaveBeenCalledTimes(1);
        await value.service.drain();
        expect(value.dispatch).not.toHaveBeenCalled();
        expect(value.issuer.prepare).not.toHaveBeenCalled();
        expect(value.receipts.record).not.toHaveBeenCalled();
      } finally { await value.store.close(); vi.restoreAllMocks(); }
    });
  }

  it('keeps startup closed when cleanup of the original admitted host is still uncertain', async () => {
    const value = await fixture();
    try {
      await value.installHost('empty');
      value.recover.mockRejectedValue(new Error('Original host cleanup remains uncertain'));
      await expect(value.service.initialize()).rejects.toThrow('cleanup remains uncertain');
      const [row] = await value.store.db.select().from(platformRuns);
      expect(row).toMatchObject({ status: 'running', receiptVersion: 2, settlement: null });
      const [host] = await value.store.db.select().from(platformHostLeases);
      expect(host?.cleanupConfirmed).toBe(0);
      expect(value.issuer.prepare).not.toHaveBeenCalled();
      expect(value.dispatch).not.toHaveBeenCalled();
    } finally { await value.store.close(); vi.restoreAllMocks(); }
  });

  it('cancels an owner-killed queued v2 reservation through refund reconciliation before HostKit dispatch', async () => {
    const value = await fixture('queued');
    try {
      value.leash.killed = true; value.leash.killedAt = 1_700_000_009n;
      await value.service.initialize();
      await value.service.drain();
      const [row] = await value.store.db.select().from(platformRuns);
      expect(row).toMatchObject({ status: 'reconciliation', receiptVersion: 2,
        errorCode: 'platform_v2_unexecuted', settlement: null });
      expect(value.dispatch).not.toHaveBeenCalled();
      expect(value.recover).not.toHaveBeenCalled();
      expect(value.issuer.prepare).not.toHaveBeenCalled();
      value.chainRun.status = 3;
      await value.service.drain();
      expect((await value.store.db.select().from(platformRuns))[0]?.status).toBe('refunded');
    } finally { await value.store.close(); vi.restoreAllMocks(); }
  });
});
