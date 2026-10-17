import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createPublicClient, http, keccak256, toHex, type Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { hashJson, randomId } from '../src/common.js';
import { HostAdmissionCoordinator } from '../src/host-kit/admission.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { hostBinding, hostClaims, hostPaidSessions, hostRuns, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, leaseSchema, verifyHostMessage } from '../src/host-kit/protocol.js';
import type { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { ArchiveHostV2AdmissionAuthority, type HostV2AdmissionEnvelope } from '../src/host-kit/v2-admission.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import type { PlatformPins, PlatformQuote } from '../src/platform-runtime/types.js';
import { platformV2DelegationSchema, platformV2DelegationTypedData } from '../src/receipts/platform-v2.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

describe('default-off HostKit v2 admission envelope', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol',
    'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); });

  it('does not mount the v2 route for an ordinary HostKit agent', async () => {
    const journal = await openHostJournal(':memory:');
    const controller = new Ed25519Identity();
    const agent = new HostKitAgent(journal, new LocalProcessFixtureRuntime('test-fixture-only'),
      controller.publicKey, new Set());
    try {
      await agent.initialize();
      const response = await createHostKitRoutes(agent).request('/v2/leases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(404);
    } finally { await agent.close(); await journal.close(); }
  });

  it('refuses a shared-coordinator CPU binding in plain v1 mode', async () => {
    const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const sharedRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
    const coordinator = new HostAdmissionCoordinator(journal, sharedRuntime, undefined, {
      version: 1, hostKey: journal.identity.publicKey, controlKey: controller.publicKey,
      isolation: sharedRuntime.isolation, runtime: 'shared-v1-fixture', sessionBackend: null,
    }, async () => []);
    const plainRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
    const plainAgent = new HostKitAgent(journal, plainRuntime, controller.publicKey, new Set());
    const initialize = vi.spyOn(plainRuntime, 'initialize');
    const cleanup = vi.spyOn(plainRuntime, 'cleanupOrphans');
    try {
      await coordinator.initialize();
      expect((await journal.db.select().from(hostBinding))[0]?.slot).toBe('cpu1');
      await expect(plainAgent.initialize()).rejects.toThrow('permanently bound CPU journal');
      expect(plainAgent.identity().ready).toBe(false);
      expect(initialize).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    } finally { await plainAgent.close(); coordinator.closeAdmission(); await journal.close(); }
  });

  it('refuses paid-session route composition and any prior shared CPU journal state', async () => {
    const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const address = (digit: string) => `0x${digit.repeat(40)}` as const;
    const pins: PlatformPins = { chainId: 31337, escrowAddress: address('1'), tokenAddress: address('2'),
      quoteSigner: address('3'), receiptRootAddress: address('4'), hostRegistryAddress: address('5'),
      feeRouterAddress: address('6'), tokenCodeHash: randomId(), reviewedTokenKind: 'immutable',
      escrowCodeHash: randomId(), receiptRootCodeHash: randomId(), hostRegistryCodeHash: randomId(),
      feeRouterCodeHash: randomId() };
    const authority = new ArchiveHostV2AdmissionAuthority(
      createPublicClient({ transport: http('http://127.0.0.1:1') }), pins, 1);
    const image = `fixture/node@sha256:${'1'.repeat(64)}`;
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const agent = new HostKitAgent(journal, runtime,
      controller.publicKey, new Set([image]), Date.now, undefined, authority);
    try {
      expect(() => createHostKitRoutes(agent, {} as PaidHostSessionAgent))
        .toThrow('Host v2 admission cannot share paid session routes');
      await journal.db.insert(hostBinding).values({ slot: 'cpu', scopeHash: randomId(), scope: {} });
      await expect(agent.initialize()).rejects.toThrow('Host v2 admission requires its exclusive CPU binding');
      await journal.db.delete(hostBinding);
      await journal.db.insert(hostClaims).values({ slot: 'cpu', kind: 'session', resourceId: randomId(),
        token: randomId(), scopeHash: randomId(), inputHash: randomId(), original: {} });
      await expect(agent.initialize()).rejects.toThrow('Host v2 admission requires its exclusive CPU binding');
      await journal.db.delete(hostClaims);
      const issuedAt = Date.now(), owner = address('a');
      const lease = controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: journal.identity.publicKey, runId: randomId(), owner, image,
        argv: [process.execPath, '-e', "process.stdout.write('x')"], issuedAt,
        expiresAt: issuedAt + 20_000, maxSeconds: 20, nonce: randomId() }));
      await journal.db.insert(hostPaidSessions).values({ sessionId: lease.body.runId, owner,
        leaseHash: hostMessageHash(lease), lease, state: 'completed' });
      await expect(agent.initialize()).rejects.toThrow('Host v2 admission requires its exclusive CPU binding');
      await journal.db.delete(hostPaidSessions);
      await agent.initialize();
      expect(agent.identity().ready).toBe(true);
      const [bound] = await journal.db.select().from(hostBinding);
      expect(bound?.slot).toBe('cpu1');
      expect(bound?.scope).toMatchObject({ version: 2, kind: 'host-v2-exclusive-cpu',
        hostKey: journal.identity.publicKey, controlKey: controller.publicKey });
      const competing = new HostAdmissionCoordinator(journal, runtime, undefined, {
        version: 1, hostKey: journal.identity.publicKey, controlKey: controller.publicKey,
        isolation: runtime.isolation, runtime: 'competing-v1', sessionBackend: null,
      }, async () => []);
      await expect(competing.initialize()).rejects.toThrow('Shared host admission or cleanup is incomplete');
    } finally { await agent.close(); await journal.close(); }
  });

  it('journals a host-signed exact-envelope receipt before dispatch and refuses late v1 upgrades', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.host-v2-test-'));
    const journal = await openHostJournal(directory), controller = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const image = `fixture/node@sha256:${'1'.repeat(64)}`;
    const local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    const store = await openStore({ DATA_DIR: ':memory:' });
    const bridge = new PlatformBridge(store.db, { pins: local.pins,
      rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    const authority = new ArchiveHostV2AdmissionAuthority(bridge.public, local.pins, 1);
    const agent = new HostKitAgent(journal, runtime, controller.publicKey, new Set([image]),
      Date.now, undefined, authority);
    let server: Server | undefined, reopenedJournal: HostJournal | undefined;
    let originalClosed = false, originalJournalClosed = false, recoveredAgent: HostKitAgent | undefined;
    try {
      await agent.initialize();
      server = createServer(getRequestListener(createHostKitRoutes(agent).fetch));
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const bound = server.address(); if (!bound || typeof bound === 'string') throw new Error('Missing HostKit port');
      const client = new HostKitClient(`http://127.0.0.1:${bound.port}`, journal.identity.publicKey,
        controller, true);
      expect(await client.capacity(image, 'one_shot')).toBe(true);
      const leashId = randomId(), now = await bridge.now();
      await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'createLeash',
        args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n,
          maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
          imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(now + 86_400) }] }));
      const quote: PlatformQuote = { runId: randomId(), leashId, hostId: local.hostId,
        payer: local.accounts.owner.address, hwClass: 0, regionHash: keccak256(toHex('local')),
        imageHash: keccak256(toHex(image.split('@')[1]!)), workloadHash: randomId(),
        maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: now + 300 };
      const quoteSignature = await bridge.signQuote(quote);
      const opened = await local.confirmed(local.owner.sendTransaction({ to: local.pins.escrowAddress,
        data: bridge.openPlan(quote, quoteSignature, [], []).data, value: 0n }));
      const issuedAt = Date.now();
      const lease = controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: journal.identity.publicKey, runId: quote.runId, owner: quote.payer,
        image, argv: [process.execPath, '-e', "process.stdout.write('v2')"],
        issuedAt, expiresAt: issuedAt + quote.maxSeconds * 1000,
        maxSeconds: quote.maxSeconds, nonce: randomId() }));
      const body = platformV2DelegationSchema.parse({ version: 2, chainId: local.pins.chainId,
        escrow: local.pins.escrowAddress, hostRegistry: local.pins.hostRegistryAddress,
        runId: quote.runId, hostId: quote.hostId, hostKey: journal.identity.publicKey,
        controllerKey: controller.publicKey, quoteHash: hashJson(quote),
        signedLeaseHash: hostMessageHash(lease),
        meterLeaseHash: hostMessageHash({ body: lease.body, signature: '' }),
        leaseIssuedAtMs: issuedAt, leaseExpiresAtMs: lease.body.expiresAt,
        maxSeconds: quote.maxSeconds, nonce: randomId() });
      const delegation = { body, signature: await bridge.account.signTypedData(platformV2DelegationTypedData(body)) };
      const envelope: HostV2AdmissionEnvelope = { version: 2, admissionTx: opened.transactionHash,
        lease, quote, quoteSignature, delegation };
      const originalStart = runtime.start.bind(runtime);
      const started = vi.spyOn(runtime, 'start').mockImplementation(async (value, heartbeat) => {
        const [saved] = await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, value.runId));
        expect(saved?.leaseHash).toBe(hostMessageHash(lease));
        expect(saved?.v2Admission?.body.delegationHash).toBe(hashJson(delegation));
        expect(verifyHostMessage(journal.identity.publicKey, 'v2-admission', saved!.v2Admission!)).toBe(true);
        return originalStart(value, heartbeat);
      });
      await expect(client.admitV2({ ...envelope, delegation: { ...delegation,
        signature: `0x${'0'.repeat(130)}` as Hex } })).rejects.toThrow('Host v2 admission failed');
      await expect(client.admitV2({ ...envelope, delegation: { ...delegation,
        body: { ...body, controllerKey: randomId() } } })).rejects.toThrow('Host v2 admission failed');
      expect(started).not.toHaveBeenCalled();
      const accepted = await client.admitV2(envelope);
      expect(accepted.admission.body).toMatchObject({ runId: quote.runId,
        signedLeaseHash: hostMessageHash(lease), delegationHash: hashJson(delegation),
        openingBlockHash: opened.blockHash, envelopeHash: hashJson(envelope) });
      expect(started).toHaveBeenCalledTimes(1);
      const replay = await client.admitV2(envelope);
      expect(replay.admission).toEqual(accepted.admission);
      expect(started).toHaveBeenCalledTimes(1);
      await expect(client.admit(lease)).rejects.toThrow('Host Kit request failed (409)');
      await expect(client.admitV2({ ...envelope, delegation: { ...delegation,
        signature: `0x${'0'.repeat(130)}` as Hex } })).rejects.toThrow('Host v2 admission failed (409)');
      await expect(client.admitV2({ ...envelope, quoteSignature: `0x${'0'.repeat(130)}` as Hex }))
        .rejects.toThrow('Host v2 admission failed (409)');

      // The exclusive v2 binding refuses new v1 work through both entry points.
      expect((await client.command(lease, 'status')).runId).toBe(quote.runId);
      await client.command(lease, 'stop');
      const secondId = randomId(), secondIssuedAt = Date.now();
      const v1Lease = controller.sign('lease', leaseSchema.parse({ ...lease.body,
        runId: secondId, issuedAt: secondIssuedAt,
        expiresAt: secondIssuedAt + quote.maxSeconds * 1000, nonce: randomId() }));
      await expect(agent.admit(v1Lease)).rejects.toMatchObject({ code: 'v1_admission_disabled' });
      await expect(client.admit(v1Lease)).rejects.toThrow('Host Kit request failed (409)');
      const [v1Row] = await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, secondId));
      expect(v1Row).toBeUndefined();
      expect(started).toHaveBeenCalledTimes(1);
      await expect(client.admitV2({ ...envelope, lease: v1Lease })).rejects.toThrow('Host v2 admission failed');

      // The archive opening remains valid, but a changed current payment asset must block new admission.
      await local.test.mine({ blocks: 1 });
      await local.test.setCode({ address: local.pins.tokenAddress, bytecode: '0x60016000f3' });
      await expect(authority.verify(envelope, journal.identity.publicKey, controller.publicKey))
        .rejects.toThrow('Host v2 current contract code differs from reviewed pins');

      const [originalBinding] = await journal.db.select().from(hostBinding);
      expect(originalBinding?.slot).toBe('cpu1');

      await agent.close(); originalClosed = true;
      await new Promise<void>(resolveClosed => server!.close(() => resolveClosed())); server = undefined;
      await journal.close(); originalJournalClosed = true;
      reopenedJournal = await openHostJournal(directory);
      expect(reopenedJournal.identity.publicKey).toBe(accepted.admission.body.hostKey);
      expect((await reopenedJournal.db.select().from(hostBinding))[0]).toEqual(originalBinding);
      const persisted = await reopenedJournal.db.select().from(hostRuns).where(eq(hostRuns.runId, quote.runId));
      expect(persisted[0]?.v2Admission).toEqual(accepted.admission);
      expect(persisted[0]?.v2Admission?.signature).toBe(accepted.admission.signature);
      expect(persisted[0]?.v2Admission?.body.envelopeHash).toBe(hashJson(envelope));
      const plainRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
      const plainInitialize = vi.spyOn(plainRuntime, 'initialize');
      const plainCleanup = vi.spyOn(plainRuntime, 'cleanupOrphans');
      const plainStart = vi.spyOn(plainRuntime, 'start');
      const plainAgent = new HostKitAgent(reopenedJournal, plainRuntime, controller.publicKey,
        new Set([image]));
      try {
        await expect(plainAgent.initialize()).rejects.toThrow('permanently bound CPU journal');
        expect(plainAgent.identity().ready).toBe(false);
        await expect(plainAgent.admit(v1Lease)).rejects.toMatchObject({ code: 'host_unavailable' });
        expect(plainInitialize).not.toHaveBeenCalled();
        expect(plainCleanup).not.toHaveBeenCalled();
        expect(plainStart).not.toHaveBeenCalled();
        expect(await reopenedJournal.db.select().from(hostRuns).where(eq(hostRuns.runId, secondId)))
          .toHaveLength(0);
      } finally { await plainAgent.close(); }
      const recoveredRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
      const recoveredStart = vi.spyOn(recoveredRuntime, 'start');
      recoveredAgent = new HostKitAgent(reopenedJournal, recoveredRuntime, controller.publicKey,
        new Set([image]), Date.now, undefined, authority);
      await recoveredAgent.initialize();
      const recovered = await recoveredAgent.admitV2(envelope);
      expect(recovered.admission).toEqual(accepted.admission);
      expect(recoveredStart).not.toHaveBeenCalled();
      await recoveredAgent.close(); recoveredAgent = undefined;

      // An old v1 row from the former downgrade path cannot silently survive
      // startup under the permanent v2 host binding.
      await reopenedJournal.db.insert(hostRuns).values({ runId: secondId, owner: v1Lease.body.owner,
        leaseHash: hostMessageHash(v1Lease), lease: v1Lease, state: 'completed', cleanupConfirmed: true });
      recoveredAgent = new HostKitAgent(reopenedJournal,
        new LocalProcessFixtureRuntime('test-fixture-only'), controller.publicKey,
        new Set([image]), Date.now, undefined, authority);
      await expect(recoveredAgent.initialize()).rejects.toThrow('exclusive journal contains a v1 admission');
      await recoveredAgent.close(); recoveredAgent = undefined;
      await reopenedJournal.db.delete(hostRuns).where(eq(hostRuns.runId, secondId));

      // A malformed on-disk receipt must prevent startup, even after another close/reopen.
      await reopenedJournal.db.update(hostRuns).set({ v2Admission: {
        ...accepted.admission, body: { ...accepted.admission.body, delegationHash: randomId() },
      } }).where(eq(hostRuns.runId, quote.runId));
      await reopenedJournal.close(); reopenedJournal = undefined;
      reopenedJournal = await openHostJournal(directory);
      recoveredAgent = new HostKitAgent(reopenedJournal,
        new LocalProcessFixtureRuntime('test-fixture-only'), controller.publicKey,
        new Set([image]), Date.now, undefined, authority);
      await expect(recoveredAgent.initialize()).rejects.toThrow('Original Host v2 admission journal cannot be verified');
    } finally {
      if (recoveredAgent) await recoveredAgent.close();
      if (reopenedJournal) await reopenedJournal.close();
      if (!originalClosed) await agent.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      if (!originalJournalClosed) await journal.close();
      await store.close(); await local.close();
      if (dirname(resolve(directory)) !== resolve(process.cwd())
        || !basename(directory).startsWith('.host-v2-test-')) throw new Error('Unexpected v2 test directory');
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
