import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformQuoteTypes, typedPlatformQuote } from '../src/platform-runtime/types.js';
import { akashSupplierIntentTypes, typedAkashSupplierIntent, verifyAkashSignedBinding,
  type AkashSignedBinding } from '../src/suppliers/akash-signed-binding.js';
import { FileSupplierLedger } from '../src/suppliers/ledger.js';
import { FileNosanaLedger } from '../src/suppliers/nosana-ledger.js';
import { FileSupplierSharedReserve } from '../src/suppliers/shared-reserve.js';
import { SupplierService } from '../src/suppliers/service.js';

const owner = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const signer = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const other = privateKeyToAccount(`0x${'3'.repeat(64)}`);
const pins = { chainId: 31337, escrowAddress: '0x4444444444444444444444444444444444444444' as const,
  quoteSigner: signer.address };
const runId = `0x${'a'.repeat(64)}` as const;
const akashOwner = `akash1${'o'.repeat(38)}`;
const provider = `akash1${'p'.repeat(38)}`;
const now = 1_800_000_000_000;
const quote = { runId, leashId: `0x${'b'.repeat(64)}` as const, hostId: `0x${'c'.repeat(64)}` as const,
  payer: owner.address, hwClass: 0 as const, regionHash: `0x${'d'.repeat(64)}` as const,
  imageHash: `0x${'e'.repeat(64)}` as const, workloadHash: `0x${'f'.repeat(64)}` as const,
  maxSeconds: 7200, pricePerSecond: '300', inferencePrice: '0', quoteExpiry: Math.floor(now / 1000) + 30 };
const quoteDomain = { name: 'TelomerePlatformEscrow', version: '1', chainId: pins.chainId,
  verifyingContract: pins.escrowAddress } as const;
const intentDomain = { name: 'TelomereAkashSupplierIntent', version: '1', chainId: pins.chainId,
  verifyingContract: pins.escrowAddress } as const;
const quoteDigest = hashTypedData({ domain: quoteDomain, types: platformQuoteTypes,
  primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
const intent = { owner: owner.address, runId, quoteDigest, akashOwner,
  dseq: '1234567', gseq: 1, oseq: 1, provider, deploymentHash: 'pinned-manifest-hash',
  pricePerBlockUact: '3.98304', runtimeHours: 1, maxBlocksPerHour: 7200,
  maxSpendUsdcMicros: '59078', expiresAt: Math.floor(now / 1000) + 3600 };
const expected = { owner: owner.address, runId, approvedQuoteDigest: quoteDigest,
  approvedMaxSeconds: 7200, approvedMaxSpendUsdcMicros: '2000000', akashOwner,
  dseq: intent.dseq, gseq: 1, oseq: 1, provider, deploymentHash: intent.deploymentHash,
  pricePerBlockUact: '3.98304', runtimeHours: 1, maxBlocksPerHour: 7200,
  maxSpendUsdcMicros: '59078', nowMs: now };

async function signedBinding(): Promise<AkashSignedBinding> {
  return { quote, quoteSignature: await signer.signTypedData({ domain: quoteDomain, types: platformQuoteTypes,
    primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) }),
  intent, ownerSignature: await owner.signTypedData({ domain: intentDomain, types: akashSupplierIntentTypes,
    primaryType: 'AkashSupplierIntent', message: typedAkashSupplierIntent(intent) }) };
}

describe('owner-signed Akash supplier quote binding', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it('binds the platform signer, admitted quote digest, owner and exact supplier/cost terms', async () => {
    const binding = await signedBinding();
    expect(await verifyAkashSignedBinding(binding, pins, expected)).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(verifyAkashSignedBinding(binding, pins, { ...expected, provider: `akash1${'x'.repeat(38)}` }))
      .rejects.toThrow(/differs/);
    await expect(verifyAkashSignedBinding(binding, pins, { ...expected, approvedQuoteDigest: `0x${'0'.repeat(64)}` }))
      .rejects.toThrow(/differs/);
    await expect(verifyAkashSignedBinding(binding, pins, { ...expected, maxSpendUsdcMicros: '59077' }))
      .rejects.toThrow(/differs/);
    await expect(verifyAkashSignedBinding(binding, pins, { ...expected, pricePerBlockUact: '3.98305' }))
      .rejects.toThrow(/differs/);
    await expect(verifyAkashSignedBinding(binding, pins, { ...expected, nowMs: now + 3_500_000 }))
      .rejects.toThrow(/differs/);
    await expect(verifyAkashSignedBinding({ ...binding, quoteSignature: await other.signTypedData({
      domain: quoteDomain, types: platformQuoteTypes, primaryType: 'PlatformQuote',
      message: typedPlatformQuote(quote) }) }, pins, expected)).rejects.toThrow(/quote signature/);
    await expect(verifyAkashSignedBinding({ ...binding, ownerSignature: await other.signTypedData({
      domain: intentDomain, types: akashSupplierIntentTypes, primaryType: 'AkashSupplierIntent',
      message: typedAkashSupplierIntent(intent) }) }, pins, expected)).rejects.toThrow(/owner supplier-intent/);
  });

  it('blocks private lease POST on missing binding and on the absent atomic Akash price constraint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'telomere-akash-binding-'));
    const ledger = new FileSupplierLedger(join(dir, 'supplier.json'));
    const sharedReserve = new FileSupplierSharedReserve({ lockPath: join(dir, 'shared.lock'), akash: ledger,
      nosana: new FileNosanaLedger(join(dir, 'nosana.json')), maxOpenReservedUsdcMicros: '10000000' });
    await sharedReserve.akash.initializeFresh(); await sharedReserve.nosana.initializeFresh(); await sharedReserve.initializeFresh();
    let currentBinding: AkashSignedBinding | undefined = await signedBinding();
    const leaseWriter = { createLease: vi.fn(async () => ({ deployment: { id: { owner: akashOwner,
      dseq: intent.dseq }, state: 'active', hash: intent.deploymentHash }, leases: [{ id: { owner: akashOwner,
      dseq: intent.dseq, gseq: 1, oseq: 1, provider }, state: 'active', price: { denom: 'uact', amount: '3.983040000000000000' } }] })) };
    const service = new SupplierService({ ledger, sharedReserve, leaseWriter,
      akash: { providers: async () => [{ owner: provider, isOnline: true, isAudited: true,
        isValidVersion: true, uptime30d: 0.99 }], bids: async () => [{ id: { owner: akashOwner,
        dseq: intent.dseq, gseq: 1, oseq: 1, provider }, state: 'open', price: { denom: 'uact', amount: '3.983040000000000000' } }],
      deployment: async () => ({ deployment: { id: { owner: akashOwner, dseq: intent.dseq },
        state: 'active', hash: intent.deploymentHash }, leases: [] }),
      settings: async () => ({ dseq: intent.dseq, autoTopUpEnabled: true,
        runtimeLimitHours: 1, runtimeEndsAt: null }) },
      approvedRun: async () => ({ owner: owner.address, runId, hardwareClass: 'cpu' as const,
        active: true, maxSeconds: 7200, maxSpendUsdcMicros: '2000000', quoteDigest,
        expiresAtMs: now + 7_400_000 }),
      signedBinding: async () => { if (!currentBinding) throw new Error('missing'); return currentBinding; },
      treasurySnapshot: async () => ({ availableUact: '2000000', usdcMicrosPerMillionUact: '2000000',
        asOfMs: now, source: 'fixture' }), now: () => now,
      policy: { approvedProviders: [provider], maxBlocksPerHour: 7200, inventoryBufferBps: 300,
        maxOpenReservedUsdcMicros: '10000000', leaseCreationEnabled: true,
        requireSignedBinding: true, bindingPins: pins } });
    const planned = await service.plan({ owner: owner.address, runId, akashOwner, dseq: intent.dseq,
      gseq: 1, oseq: 1, plannedSeconds: 1800, maxSpendUsdcMicros: '2000000' }, 'signed-1');
    expect(planned.reservation.signedBindingDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(planned.reservation.pricePerBlockUact).toBe('3.98304');
    expect(planned.reservation.reservedUact).toBe('29539');
    currentBinding = undefined;
    await expect(service.activate(owner.address, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_binding_invalid' });
    expect(leaseWriter.createLease).not.toHaveBeenCalled();
    expect((await ledger.read()).records[0]?.state).toBe('planned');
    currentBinding = await signedBinding();
    await expect(service.activate(owner.address, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_atomic_price_unavailable' });
    expect(leaseWriter.createLease).not.toHaveBeenCalled();
    expect((await ledger.read()).records[0]?.state).toBe('planned');
    currentBinding = { ...currentBinding, intent: { ...currentBinding.intent,
      pricePerBlockUact: '3.983040000000000000' } };
    await expect(service.activate(owner.address, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_binding_invalid' });
    currentBinding = await signedBinding();

    let exactBid: unknown = { bid: { id: { owner: akashOwner, dseq: intent.dseq,
      gseq: 1, oseq: 1, provider, bseq: 37 }, state: 'open', price: { denom: 'uact', amount: '3.983040000000000000' } } };
    const exactReader = { getBid: vi.fn(async () => exactBid) };
    const exactService = new SupplierService({ ledger, sharedReserve, leaseWriter,
      exactBidReader: exactReader,
      akash: { providers: async () => [{ owner: provider, isOnline: true, isAudited: true,
        isValidVersion: true, uptime30d: 0.99 }], bids: async () => [{ id: { owner: akashOwner,
        dseq: intent.dseq, gseq: 1, oseq: 1, provider, bseq: 37 }, state: 'open',
      price: { denom: 'uact', amount: '3.983040000000000000' } }],
      deployment: async () => ({ deployment: { id: { owner: akashOwner, dseq: intent.dseq },
        state: 'active', hash: intent.deploymentHash }, leases: [] }),
      settings: async () => ({ dseq: intent.dseq, autoTopUpEnabled: true,
        runtimeLimitHours: 1, runtimeEndsAt: null }) },
      approvedRun: async () => ({ owner: owner.address, runId, hardwareClass: 'cpu' as const,
        active: true, maxSeconds: 7200, maxSpendUsdcMicros: '2000000', quoteDigest,
        expiresAtMs: now + 7_400_000 }),
      signedBinding: async () => currentBinding!,
      treasurySnapshot: async () => ({ availableUact: '2000000', usdcMicrosPerMillionUact: '2000000',
        asOfMs: now, source: 'fixture' }), now: () => now,
      policy: { approvedProviders: [provider], maxBlocksPerHour: 7200, inventoryBufferBps: 300,
        maxOpenReservedUsdcMicros: '10000000', leaseCreationEnabled: true,
        requireSignedBinding: true, bindingPins: pins } });
    await expect(exactService.activate(owner.address, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_atomic_budget_unavailable' });
    for (const mutation of [
      { bid: { id: { owner: akashOwner, dseq: intent.dseq, gseq: 1, oseq: 1,
        provider, bseq: 38 }, state: 'open', price: { denom: 'uact', amount: '3.983040000000000000' } } },
      { bid: { id: { owner: akashOwner, dseq: intent.dseq, gseq: 1, oseq: 1,
        provider, bseq: 37 }, state: 'open', price: { denom: 'uact', amount: '3.98305' } } },
      { bid: { id: { owner: `akash1${'x'.repeat(38)}`, dseq: intent.dseq, gseq: 1, oseq: 1,
        provider, bseq: 37 }, state: 'open', price: { denom: 'uact', amount: '3.983040000000000000' } } },
      { bid: { id: { owner: akashOwner, dseq: intent.dseq, gseq: 1, oseq: 1,
        provider, bseq: 37 }, state: 'open', price: { denom: 'uakt', amount: '3.983040000000000000' } } },
    ]) {
      exactBid = mutation;
      await expect(exactService.activate(owner.address, planned.reservation.id))
        .rejects.toMatchObject({ code: 'supplier_exact_bid_unverified' });
    }
    expect(exactReader.getBid).toHaveBeenCalledTimes(5);
    expect(leaseWriter.createLease).not.toHaveBeenCalled();
    expect((await ledger.read()).records[0]?.state).toBe('planned');
    const path = join(dir, 'supplier.json');
    const changed = JSON.parse(await readFile(path, 'utf8')) as { records: Array<{ pricePerBlockUact: string }> };
    changed.records[0]!.pricePerBlockUact = '3.98305';
    await writeFile(path, JSON.stringify(changed));
    expect((await new FileSupplierLedger(path).read()).records[0]?.pricePerBlockUact).toBe('3.98305');
    await expect(exactService.activate(owner.address, planned.reservation.id))
      .rejects.toMatchObject({ code: 'supplier_bid_unavailable' });
    expect(leaseWriter.createLease).not.toHaveBeenCalled();
  });
});
