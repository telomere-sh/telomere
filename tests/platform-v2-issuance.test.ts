import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { hashJson, randomId } from '../src/common.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { ArchiveHostV2AdmissionAuthority } from '../src/host-kit/v2-admission.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { createPlatformReadOnlyBridge } from '../src/platform-runtime/read-only.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { platformReceiptEntries } from '../src/receipts/platform-schema.js';
import { PlatformV2AdmissionJournal } from '../src/receipts/platform-v2-admission.js';
import { verifyPlatformV2PublishedEvidence } from '../src/receipts/platform-v2-combined.js';
import { PlatformV2EvidenceJournal } from '../src/receipts/platform-v2-journal.js';
import { PlatformV2ReceiptIssuer, platformV2IssuanceDrafts } from '../src/receipts/platform-v2-issuer.js';
import { PlatformV2EvidencePublisher, PlatformV2PublicationJournal, PlatformV2PublishedEvidenceReader,
  type PlatformV2PublicationStore } from '../src/receipts/platform-v2-publication.js';
import { createPlatformV2Routes } from '../src/receipts/platform-v2-routes.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { CanonicalCpuWorkVerifier } from '../src/economics/cpu-work-verifier.js';
import { buildWeeklyWorkAllocation } from '../src/economics/work-allocation.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';

const privateInput = 'PRIVATE_WORKLOAD_NEVER_PUBLIC';
const privateOutput = 'PRIVATE_OUTPUT_NEVER_PUBLIC';
class PaidCpuFixture extends LocalProcessFixtureRuntime {
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    return super.start({ ...lease, argv: [process.execPath, '-e',
      `process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write('${privateOutput}'),12000));`] }, heartbeat);
  }
}
class TestPublicationStore implements PlatformV2PublicationStore {
  readonly objects = new Map<string, Uint8Array>();
  failWrites = false;
  hideReads = false;
  corruptReads = false;
  writes = 0;
  constructor(readonly identity: string, readonly failureDomain: string) {}
  async putImmutable(key: string, bytes: Uint8Array, options: { signal: AbortSignal; maxBytes: number }) {
    options.signal.throwIfAborted();
    this.writes++;
    if (this.failWrites) throw new Error('test destination is unavailable');
    if (bytes.byteLength > options.maxBytes) throw new Error('test object exceeds bound');
    const prior = this.objects.get(key);
    if (prior && !Buffer.from(prior).equals(Buffer.from(bytes))) throw new Error('test immutable conflict');
    this.objects.set(key, Uint8Array.from(bytes));
  }
  async get(key: string, options: { signal: AbortSignal; maxBytes: number }) {
    options.signal.throwIfAborted();
    const bytes = this.objects.get(key);
    if (this.hideReads || !bytes) return undefined;
    if (bytes.byteLength > options.maxBytes) throw new Error('test object exceeds bound');
    return this.corruptReads ? Buffer.from('{}') : Uint8Array.from(bytes);
  }
}

describe('real paid CPU v2 issuance, restart and canonical public retrieval', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol',
    'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); });

  it('keeps the original outcome and salt after one store fails, settles only with both copies, and serves the committed redacted core', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-v2-issuance-'));
    const hostJournal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const local = await deployPlatformRuntime(hostJournal.identity.publicKey as Hex, artifacts);
    let store = await openStore({ DATA_DIR: join(directory, 'controller') });
    let storeClosed = false, server: Server | undefined;
    const runtime = new PaidCpuFixture(), start = vi.spyOn(runtime, 'start');
    const image = `fixture/node@sha256:${'1'.repeat(64)}`;
    let bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl,
      signerPrivateKey: local.keys.signer });
    const agent = new HostKitAgent(hostJournal, runtime, controller.publicKey, new Set([image]),
      Date.now, undefined, new ArchiveHostV2AdmissionAuthority(bridge.public, local.pins, 1));
    try {
      await agent.initialize();
      server = createServer(getRequestListener(createHostKitRoutes(agent).fetch));
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing host fixture port');
      const client = new HostKitClient(`http://127.0.0.1:${address.port}`, hostJournal.identity.publicKey, controller, true);
      const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: hostJournal.identity.publicKey,
        hardwareClass: 'cpu', region: 'local-test', image, imageDigest: image.split('@')[1],
        sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000,
        strikes: 0, stake: '300000000', availableAt: 0 });
      const copies = [new TestPublicationStore('acceptance-a', 'declared-domain-a'),
        new TestPublicationStore('acceptance-b', 'declared-domain-b')] as const;
      const scope = { chainId: 31337 as const, escrow: local.pins.escrowAddress, hostRegistry: local.pins.hostRegistryAddress };
      let service: PlatformRuntimeService;
      let admission: PlatformV2AdmissionJournal, evidence: PlatformV2EvidenceJournal, publisher: PlatformV2EvidencePublisher;
      const rebuild = () => {
        bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
        admission = new PlatformV2AdmissionJournal(store.db, bridge, true);
        evidence = new PlatformV2EvidenceJournal(store.db, 31337, scope.escrow, scope.hostRegistry);
        publisher = new PlatformV2EvidencePublisher(new PlatformV2PublicationJournal(store.db, scope), copies, { enabled: true });
        const executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]), admission);
        const receipts = new PlatformReceiptService(store.db, { chainId: 31337,
          escrowAddress: scope.escrow, receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
          submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
        const issuer = new PlatformV2ReceiptIssuer(store.db, bridge, admission, evidence, publisher, 1);
        service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, undefined, undefined, issuer);
        return { executor, receipts };
      };
      let ports = rebuild();
      await service!.initialize();
      const leashId = randomId();
      await local.confirmed(local.owner.writeContract({ address: scope.escrow, abi: local.artifact('PlatformRunEscrow').abi,
        functionName: 'createLeash', args: [leashId, { agent: local.accounts.owner.address,
          maxPerHour: 100_000n, maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
          imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(await bridge.now() + 86_400) }] }));
      const quoteInput = { leashId, task: { kind: 'sha256' as const, text: privateInput },
        maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' };
      // Exercise the real Node transport/schema/signature checks against this
      // actual paid v2 producer. No request is sent to an external origin.
      const sdkNow = await bridge.now();
      let stripReceiptVersion = false;
      let stripConfigVersion = false;
      const sdk = new PlatformRuntimeClient({ baseUrl: 'http://127.0.0.1:1', pins: local.pins,
        nowSeconds: () => sdkNow, fetch: async (url, init) => {
          const path = new URL(url).pathname;
          if (path === '/api/platform/config') {
            const configured = service!.publicConfig();
            if (!stripConfigVersion) return Response.json(configured);
            const { cpuReceiptVersion: _version, ...downgraded } = configured;
            return Response.json(downgraded);
          }
          if (path === '/api/me') return Response.json({ address: local.accounts.owner.address, demo: false });
          if (path !== '/api/platform/quotes' || typeof init?.body !== 'string') throw new Error('Unexpected SDK fixture request');
          const result = await service!.quote(local.accounts.owner.address, JSON.parse(init.body) as unknown,
            new Headers(init.headers).get('Idempotency-Key')!);
          if (!stripReceiptVersion) return Response.json(result);
          const { receiptVersion: _version, ...downgraded } = result;
          return Response.json(downgraded);
        } });
      expect((await sdk.config()).cpuReceiptVersion).toBe(2);
      const acceptedSdkQuote = await sdk.quote(quoteInput, 'sdk-real-v2-quote');
      expect(acceptedSdkQuote.receiptVersion).toBe(2);
      stripReceiptVersion = true;
      await expect(sdk.quote(quoteInput, 'sdk-v2-prepared-downgrade')).rejects.toThrow('receipt version');
      stripReceiptVersion = false;
      stripConfigVersion = true;
      await expect(sdk.quote(quoteInput, 'sdk-v2-config-downgrade')).rejects.toThrow('downgraded');
      stripConfigVersion = false;
      const { cpuReceiptVersion: _configuredVersion, ...untrustedLegacyConfig } = service!.publicConfig();
      const strictSdk = new PlatformRuntimeClient({ baseUrl: 'http://127.0.0.1:1', pins: local.pins,
        cpuReceiptVersion: 2, fetch: async () => Response.json(untrustedLegacyConfig) });
      await expect(strictSdk.config()).rejects.toThrow('downgraded');
      const prepared = await service!.quote(local.accounts.owner.address, quoteInput, 'actual-v2-issue');
      expect(prepared.receiptVersion).toBe(2);
      const opened = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await service!.admit(local.accounts.owner.address, { runId: prepared.quote.runId,
        transactionHash: opened.transactionHash }, 'actual-v2-admit');
      copies[1].failWrites = true;
      await expect(service!.drain()).rejects.toThrow('original-lease recovery');
      const readRow = async () => (await store.db.select().from(platformRuns)
        .where(eq(platformRuns.id, prepared.quote.runId)))[0]!;
      const failed = await readRow();
      expect(failed).toMatchObject({ receiptVersion: 2, status: 'running', settlement: null,
        result: { status: 'completed', output: privateOutput } });
      expect(start).toHaveBeenCalledTimes(1);
      expect(await store.db.select().from(platformReceiptEntries)).toHaveLength(0);
      const firstCore = await evidence!.get(prepared.quote.runId);
      const [firstDraft] = await store.db.select().from(platformV2IssuanceDrafts);
      expect(firstCore?.core.hostAdmission).toBeDefined();
      expect(firstDraft?.draft.input.outputSalt).toBe(firstCore!.outputSalt);
      expect(copies[0].objects.size).toBe(2);
      expect(copies[1].objects.size).toBe(0);
      await expect(service!.quote(local.accounts.owner.address, quoteInput, 'after-failed-publication'))
        .rejects.toMatchObject({ code: 'platform_not_ready' });
      await expect(new PlatformRuntimeService(store.db, bridge, [host], ports.executor, ports.receipts).initialize())
        .rejects.toThrow('original evidence publisher configuration');

      await store.close(); storeClosed = true;
      store = await openStore({ DATA_DIR: join(directory, 'controller') }); storeClosed = false;
      copies[1].failWrites = false;
      ports = rebuild();
      await service!.initialize();
      const resumed = await readRow();
      expect(resumed).toMatchObject({ receiptVersion: 2, status: 'receipt_pending' });
      expect(resumed.result).toEqual(failed.result);
      expect(resumed.result!.billableSeconds).toBeGreaterThan(0);
      expect(start).toHaveBeenCalledTimes(1);
      expect(await evidence!.get(prepared.quote.runId)).toEqual(firstCore);
      const [resumedDraft] = await store.db.select().from(platformV2IssuanceDrafts);
      expect(resumedDraft?.draft).toEqual(firstDraft!.draft);
      expect(resumed.settlement!.receiptHash).toBe(firstCore!.receiptHash);
      const v1Hash = hashJson({ protocol: 'telomere-platform-receipt-v1', chainId: 31337, escrow: scope.escrow,
        quote: resumed.quote, endedAt: resumed.settlement!.endedAt, billableSeconds: resumed.settlement!.billableSeconds,
        output: resumed.result!.output, status: resumed.result!.status, ticks: resumed.result!.ticks,
        hostLeaseHash: firstDraft!.draft.input.delegation.body.signedLeaseHash });
      expect(resumed.settlement!.receiptHash).not.toBe(v1Hash);
      const retrieved = await publisher!.retrieve(prepared.quote.runId);
      expect(retrieved.configuredCopiesVerified).toBe(true);
      expect(retrieved.independentlyPublished).toBe(false);
      const publicText = JSON.stringify(retrieved);
      for (const secret of [privateInput, privateOutput, firstCore!.outputSalt, '"argv"', '"stdin"']) {
        expect(publicText).not.toContain(secret);
      }

      const hour = Math.floor(resumed.settlement!.endedAt / 3600);
      await local.test.setNextBlockTimestamp({ timestamp: BigInt(Math.max(await bridge.now() + 1, (hour + 1) * 3600)) });
      await local.test.mine({ blocks: 1 });
      copies[1].hideReads = true;
      await service!.drain();
      expect((await readRow()).status).toBe('reconciliation');
      expect(await store.db.select().from(platformReceiptEntries)).toHaveLength(0);
      expect((await bridge.run(prepared.quote.runId)).status).toBe(1);
      await expect(publisher!.retrieve(prepared.quote.runId)).rejects.toThrow('Both configured');
      copies[1].hideReads = false;
      await service!.drain();
      const settled = await readRow();
      expect(settled).toMatchObject({ status: 'completed', receiptVersion: 2 });
      expect(settled.settlement!.receiptHash).toBe(firstCore!.receiptHash);
      expect((await bridge.run(prepared.quote.runId)).receiptHash).toBe(firstCore!.receiptHash);
      expect(start).toHaveBeenCalledTimes(1);
      const independent = createPlatformReadOnlyBridge(local.pins, local.local.rpcUrl);
      const reader = new PlatformV2PublishedEvidenceReader(scope, copies);
      const verified = await verifyPlatformV2PublishedEvidence(independent, reader,
        prepared.quote.runId, settled.settlementTx!, 1);
      expect(verified.verification).toMatchObject({ hostAdmissionVerified: true,
        receiptHash: firstCore!.receiptHash, onchainReceiptVerified: true,
        historicalAuthoritySource: 'archive-rpc', historicalDelegationIssuanceTimeProven: false });
      expect(verified.publication).toMatchObject({ configuredCopiesVerified: true, independentlyPublished: false });
      const financial = verified.verification.financial;
      if (financial.kind !== 'settlement') throw new Error('Expected real financial settlement');
      const base = BigInt(financial.hostAmount), fee = BigInt(financial.platformFee), charged = BigInt(financial.charged);
      expect(charged).toBeGreaterThan(0n);
      expect(base).toBe(BigInt(resumed.settlement!.billableSeconds) * 100n);
      expect(fee).toBe((base * 900n + 9999n) / 10000n);
      expect(charged).toBe(base + fee);
      expect(charged + BigInt(financial.returnedAmount)).toBe(BigInt(resumed.ceiling));
      expect(settled.charged).toBe(charged.toString());
      expect(settled.refund).toBe(financial.returnedAmount);
      const workVerifier = new CanonicalCpuWorkVerifier(independent, reader, 1);
      const workHandle = { runId: prepared.quote.runId, transactionHash: settled.settlementTx! };
      const activity = await workVerifier.read(workHandle);
      expect(activity).toMatchObject({ kind: 'cpu', recipient: local.accounts.host.address,
        units: financial.billableSeconds.toString(), receiptId: firstCore!.receiptHash,
        blockHash: financial.blockHash, evidenceDigest: verified.verification.evidenceCoreDigest });
      const workPlan = await buildWeeklyWorkAllocation({ policy: {
        protocol: 'telomere-weekly-work-policy-v1', chainId: 31337, router: local.pins.feeRouterAddress,
        policyApproval: hashJson({ localAcceptancePolicy: true }),
        weights: { cpu: '1', probe: '0', verification: '0', storage: '0' } },
      week: activity.week, closedWeek: activity.week, budget: '1', handles: [workHandle], verifier: workVerifier });
      expect(workPlan.claims).toHaveLength(1);
      expect(workPlan.claims[0]).toMatchObject({ amount: '1', recipient: local.accounts.host.address.toLowerCase() });
      const routes = createPlatformV2Routes(independent, 1, undefined, reader);
      const get = () => routes.request(`/runs/${prepared.quote.runId}?settlementTransactionHash=${settled.settlementTx}`);
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = await response.json();
      expect(body).toMatchObject({ verification: { hostAdmissionVerified: true,
        onchainReceiptVerified: true }, publication: { configuredCopiesVerified: true } });
      for (const secret of [privateInput, privateOutput, firstCore!.outputSalt, '"argv"', '"stdin"']) {
        expect(JSON.stringify(body)).not.toContain(secret);
      }
      copies[1].corruptReads = true;
      await expect(workVerifier.read(workHandle)).rejects.toThrow('Both configured');
      expect((await get()).status).toBe(503);
      const rootBroadcast = vi.spyOn(bridge.transactions, 'submit');
      const writesBeforeRootCheck = copies.map(copy => copy.writes);
      expect(await service!.canSeal(hour)).toBe(false);
      await ports.receipts.publish(hour);
      expect(rootBroadcast).not.toHaveBeenCalled();
      expect(copies.map(copy => copy.writes)).toEqual(writesBeforeRootCheck);
      rootBroadcast.mockRestore();
      expect((await service!.get(local.accounts.owner.address, prepared.quote.runId)).status).toBe('reconciliation');
      copies[1].corruptReads = false;
      await service!.drain();
      expect((await readRow()).status).toBe('completed');
      expect((await readRow()).settlement!.receiptHash).toBe(firstCore!.receiptHash);

      // A payer stops a queued reservation before HostKit admission. It must
      // retain the independent refund path without fabricating a v1/v2 receipt.
      const stopped = await service!.quote(local.accounts.owner.address,
        { ...quoteInput, deadline: await bridge.now() + 300 }, 'v2-stopped-before-dispatch');
      const stoppedOpen = await local.confirmed(local.owner.sendTransaction({ to: stopped.transaction.to,
        data: stopped.transaction.data as Hex, value: 0n }));
      await service!.admit(local.accounts.owner.address, { runId: stopped.quote.runId,
        transactionHash: stoppedOpen.transactionHash }, 'v2-stop-admit');
      await local.confirmed(local.owner.writeContract({ address: scope.escrow,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'requestStop', args: [stopped.quote.runId] }));
      await service!.drain();
      const readStopped = async () => (await store.db.select().from(platformRuns)
        .where(eq(platformRuns.id, stopped.quote.runId)))[0]!;
      expect(await readStopped()).toMatchObject({ receiptVersion: 2, status: 'reconciliation',
        settlement: null, errorCode: 'platform_v2_unexecuted' });
      expect(start).toHaveBeenCalledTimes(1);
      expect(await admission!.originalHostAdmission(stopped.quote.runId)).toBeUndefined();
      expect(await evidence!.get(stopped.quote.runId)).toBeUndefined();

      // Inject the durable state of a controller crash immediately after its
      // running claim, before producing any lease or host POST, then reopen disk.
      await store.db.update(platformRuns).set({ status: 'running', errorCode: null })
        .where(eq(platformRuns.id, stopped.quote.runId));
      await store.close(); storeClosed = true;
      store = await openStore({ DATA_DIR: join(directory, 'controller') }); storeClosed = false;
      ports = rebuild();
      await service!.initialize();
      expect(await readStopped()).toMatchObject({ status: 'reconciliation', settlement: null,
        errorCode: 'platform_v2_unexecuted' });
      expect(start).toHaveBeenCalledTimes(1);
      expect((await service!.quote(local.accounts.owner.address,
        { ...quoteInput, deadline: await bridge.now() + 300 }, 'ready-with-refund-pending')).receiptVersion).toBe(2);
      const refundAt = await bridge.public.readContract({ address: scope.escrow,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'refundAt', args: [stopped.quote.runId] }) as bigint;
      await local.test.setNextBlockTimestamp({ timestamp: refundAt });
      await local.test.mine({ blocks: 1 });
      await local.confirmed(local.host.writeContract({ address: scope.escrow,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'refundRun', args: [stopped.quote.runId] }));
      await service!.drain();
      expect(await readStopped()).toMatchObject({ status: 'refunded', receiptVersion: 2,
        charged: '0', refund: stopped.ceiling, settlement: null });
      expect(await store.db.select().from(platformReceiptEntries)).toHaveLength(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await agent.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await hostJournal.close(); if (!storeClosed) await store.close(); await local.close();
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('telomere-v2-issuance-')) {
        throw new Error('Unexpected v2 issuance test directory');
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 240_000);
});
