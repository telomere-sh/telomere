import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, http, keccak256, toHex, type Hex } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { randomId } from '../src/common.js';
import { Ed25519Identity, hostMessageHash, leaseSchema, type SignedHostTick } from '../src/host-kit/protocol.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { preparePresentedMeterBundle, verifyPresentedMeterBundle } from '../src/platform-runtime/presented-meter.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformQuoteTypes, typedPlatformQuote, typedPlatformSettlement,
  type PlatformQuote, type PlatformSettlement } from '../src/platform-runtime/types.js';
import { platformFinancialLeaf } from '../src/receipts/platform-merkle.js';
import { platformReceiptRootAbi } from '../src/receipts/platform-service.js';
import { createPlatformPresentedMeterRoutes } from '../src/receipts/platform-presented-meter-routes.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const id = (value: string) => keccak256(toHex(value));

describe('presented HostKit meter evidence against a canonical paid Platform run', () => {
  it('checks historical registry identity and signatures, but never claims a tick-root or work proof', async () => {
    const hostIdentity = new Ed25519Identity(), control = new Ed25519Identity();
    const fixture = await deployPlatformRuntime(hostIdentity.publicKey as Hex);
    try {
      const snapshot = await fixture.test.snapshot();
      const now = async () => Number((await fixture.local.publicClient.getBlock()).timestamp);
      const advance = async (timestamp: number) => {
        await fixture.test.setNextBlockTimestamp({ timestamp: BigInt(timestamp) });
        await fixture.test.mine({ blocks: 1 });
      };
      await advance((Math.floor(await now() / 3600) + 1) * 3600 + 600);
      const timestamp = await now(), leashId = id('meter-leash');
      await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
        abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'createLeash',
        args: [leashId, { agent: fixture.accounts.owner.address, maxPerHour: 1_000_000n,
          maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false, imageAllowRoot: PLATFORM_ZERO,
          regionAllowRoot: PLATFORM_ZERO, expiry: BigInt(timestamp + 86_400) }] }));
      const quote: PlatformQuote = { runId: id('meter-paid-run'), leashId, hostId: fixture.hostId,
        payer: fixture.accounts.owner.address, hwClass: 0, regionHash: id('region'), imageHash: id('image'),
        workloadHash: id('workload'), maxSeconds: 20, pricePerSecond: '1000', inferencePrice: '0',
        quoteExpiry: timestamp + 300 };
      const signature = await fixture.accounts.signer.signTypedData({ domain: {
        name: 'TelomerePlatformEscrow', version: '1', chainId: 31337,
        verifyingContract: fixture.pins.escrowAddress }, primaryType: 'PlatformQuote',
        types: platformQuoteTypes, message: typedPlatformQuote(quote) });
      const opened = await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'openRun', args: [typedPlatformQuote(quote), signature, [], []] }));
      const run = await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'getRun', args: [quote.runId] });
      const issuedAt = Number(run.openedAt) * 1000;
      const body = leaseSchema.parse({ version: 1, hostKey: hostIdentity.publicKey,
        runId: quote.runId, owner: quote.payer.toLowerCase(), image: `fixture/cpu@sha256:${'a'.repeat(64)}`,
        argv: ['node', '-e', 'SECRET_ARGV_NEVER_EXPORT'], stdin: 'PRIVATE_STDIN_NEVER_EXPORT',
        issuedAt, expiresAt: issuedAt + 20_000, maxSeconds: 20, nonce: randomId() });
      let clock = issuedAt;
      const meter = new HostMeterVerifier(body, control, () => clock);
      const ticks: SignedHostTick[] = [];
      const tick = (elapsedMs: number) => hostIdentity.sign('tick', {
        version: 1 as const, hostKey: hostIdentity.publicKey, runId: quote.runId,
        owner: quote.payer.toLowerCase(), leaseHash: meter.leaseHash, sequence: ticks.length,
        timestamp: clock, elapsedMs, cpuMs: elapsedMs, state: 'RUNNING' as const,
        previousHash: ticks.length ? hostMessageHash(ticks.at(-1)!) : null,
        heartbeat: { sequence: ticks.length, elapsedMs, receivedAt: clock },
        gpuUtil: 0 as const, gpuMemoryBytes: 0 as const, powerWatts: 0 as const });
      ticks.push(tick(0)); expect(meter.accept(ticks[0]).body.billableSeconds).toBe(0);
      clock += 5000;
      ticks.push(tick(5000)); expect(meter.accept(ticks[1]).body.billableSeconds).toBe(5);
      await advance(await now() + 5);
      const outcome: PlatformSettlement = { runId: quote.runId, billableSeconds: 5,
        endedAt: await now(), inferenceCharge: '0', receiptHash: id('opaque-meter-receipt') };
      const leaf = platformFinancialLeaf(31337, fixture.pins.escrowAddress, run, outcome);
      await advance((Math.floor(outcome.endedAt / 3600) + 1) * 3600 + 1);
      const signer = createWalletClient({ account: fixture.accounts.signer, chain: localChain,
        transport: http(fixture.local.rpcUrl, { retryCount: 0 }) });
      await fixture.confirmed(signer.writeContract({ address: fixture.pins.receiptRootAddress,
        abi: platformReceiptRootAbi, functionName: 'postRoot',
        args: [BigInt(Math.floor(outcome.endedAt / 3600)), leaf, 1] }));
      const settled = await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'settleRun',
        args: [typedPlatformSettlement(outcome), BigInt(Math.floor(outcome.endedAt / 3600)), []] }));
      const bundle = preparePresentedMeterBundle(quote.runId, settled.transactionHash, ticks);
      const verified = await verifyPresentedMeterBundle(bundle, fixture.pins, fixture.local.rpcUrl, 1);
      expect(verified).toMatchObject({ verification: 'presented-host-signatures-only',
        runId: quote.runId, hostId: fixture.hostId, hostKey: hostIdentity.publicKey,
        transactionHash: settled.transactionHash, presentedTickCount: 2,
        presentedTickSignaturesVerified: true, completeTickHistoryVerified: false,
        billableSecondsVerifiedFromTicks: false, outputVerified: false, onchainTickCommitment: false });
      expect(JSON.stringify(bundle)).not.toContain(body.argv[2]!);
      expect(JSON.stringify(bundle)).not.toContain(body.stdin!);
      expect(JSON.stringify(bundle)).not.toContain(body.image);

      const publicRoutes = createPlatformPresentedMeterRoutes(fixture.pins, fixture.local.rpcUrl, 1);
      const publicResponse = await publicRoutes.request('http://localhost/verify', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle) });
      expect(publicResponse.status).toBe(200);
      expect(await publicResponse.json()).toMatchObject({ verification: 'presented-host-signatures-only',
        runId: quote.runId, presentedTickSignaturesVerified: true, completeTickHistoryVerified: false,
        billableSecondsVerifiedFromTicks: false, onchainTickCommitment: false });
      expect(publicResponse.headers.get('Cache-Control')).toBe('no-store');
      const malformedResponse = await publicRoutes.request('http://localhost/verify', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bundle, ticks: [] }) });
      expect(malformedResponse.status).not.toBe(200);
      const tooLargeResponse = await publicRoutes.request('http://localhost/verify', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'a'.repeat(96 * 1024) }) });
      expect(tooLargeResponse.status).toBe(413);

      const altered = [
        { ...bundle, ticks: [{ ...ticks[0]!, signature: control.sign('tick', ticks[0]!.body).signature }, ticks[1]!] },
        { ...bundle, ticks: [ticks[0]!, hostIdentity.sign('tick', { ...ticks[1]!.body,
          owner: fixture.accounts.outsider.address.toLowerCase() })] },
        { ...bundle, ticks: [ticks[0]!, hostIdentity.sign('tick', { ...ticks[1]!.body, previousHash: randomId() })] },
        { ...bundle, ticks: [ticks[0]!, ticks[0]!] },
      ];
      for (const item of altered) {
        await expect(verifyPresentedMeterBundle(item, fixture.pins, fixture.local.rpcUrl, 1))
          .rejects.toMatchObject({ code: 'platform_meter_tick' });
      }
      await expect(verifyPresentedMeterBundle({ ...bundle, transactionHash: opened.transactionHash },
        fixture.pins, fixture.local.rpcUrl, 1)).rejects.toMatchObject({ code: 'platform_meter_transaction' });
      await expect(verifyPresentedMeterBundle(bundle, { ...fixture.pins, hostRegistryCodeHash: randomId() },
        fixture.local.rpcUrl, 1)).rejects.toMatchObject({ code: 'platform_meter_pin_changed' });
      await fixture.test.revert({ id: snapshot });
      await expect(verifyPresentedMeterBundle(bundle, fixture.pins, fixture.local.rpcUrl, 1)).rejects.toThrow();
    } finally { await fixture.close(); }
  }, 120_000);
});

describe('public presented meter request limits', () => {
  const pins = {} as Parameters<typeof createPlatformPresentedMeterRoutes>[0];
  const result = {} as Awaited<ReturnType<typeof verifyPresentedMeterBundle>>;
  const post = (routes: ReturnType<typeof createPlatformPresentedMeterRoutes>, body = '{}') =>
    routes.request('http://localhost/verify', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body });

  it('counts actual bytes even when Content-Length understates a streaming body', async () => {
    const verify = vi.fn(async () => result);
    const routes = createPlatformPresentedMeterRoutes(pins, 'http://localhost', 1, verify);
    const response = await routes.request('http://localhost/verify', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
      body: JSON.stringify({ padding: 'a'.repeat(96 * 1024) }) });
    expect(response.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  it('times out an incomplete request body within five seconds', async () => {
    vi.useFakeTimers();
    try {
      const verify = vi.fn(async () => result);
      const routes = createPlatformPresentedMeterRoutes(pins, 'http://localhost', 1, verify);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      } });
      const responsePromise = routes.request('http://localhost/verify', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2' }, body,
        duplex: 'half' } as RequestInit);
      await vi.advanceTimersByTimeAsync(5_001);
      const response = await responsePromise;
      expect(response.status).toBe(408);
      expect(verify).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('retains slots while slow request sources have not acknowledged cancellation', async () => {
    vi.useFakeTimers();
    try {
      const verify = vi.fn(async () => result);
      const routes = createPlatformPresentedMeterRoutes(pins, 'http://localhost', 1, verify);
      const finishCancellation: Array<() => void> = [];
      const slowRequest = () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
          cancel() { return new Promise<void>(resolve => { finishCancellation.push(resolve); }); },
        });
        return routes.request('http://localhost/verify', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '2' }, body,
          duplex: 'half' } as RequestInit);
      };
      const responses = Array.from({ length: 4 }, slowRequest);
      await vi.advanceTimersByTimeAsync(5_001);
      for (const response of await Promise.all(responses)) expect(response.status).toBe(408);
      expect((await post(routes)).status).toBe(429);
      expect(finishCancellation).toHaveLength(4);
      for (const finish of finishCancellation) finish();
      await vi.advanceTimersByTimeAsync(1);
      expect((await post(routes)).status).toBe(200);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('caps all concurrent work and keeps timed-out verifier slots occupied until RPC work settles', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: typeof result) => void;
      const pending = new Promise<typeof result>(resolve => { finish = resolve; });
      const verify = vi.fn(() => pending);
      const routes = createPlatformPresentedMeterRoutes(pins, 'http://localhost', 1, verify);
      const requests = Array.from({ length: 4 }, () => post(routes));
      await vi.advanceTimersByTimeAsync(1);
      expect(verify).toHaveBeenCalledTimes(4);
      expect((await post(routes)).status).toBe(429);
      await vi.advanceTimersByTimeAsync(30_000);
      for (const response of await Promise.all(requests)) expect(response.status).toBe(503);
      expect((await post(routes)).status).toBe(429);
      finish(result);
      await vi.advanceTimersByTimeAsync(1);
      expect((await post(routes)).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
