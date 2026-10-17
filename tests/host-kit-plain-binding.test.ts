import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, http } from 'viem';
import { randomId } from '../src/common.js';
import { HostAdmissionCoordinator } from '../src/host-kit/admission.js';
import { HostKitAgent } from '../src/host-kit/agent.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { hostBinding, hostPaidPreemptions, hostPaidSessions, hostRuns,
  openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, leaseSchema } from '../src/host-kit/protocol.js';
import { ArchiveHostV2AdmissionAuthority } from '../src/host-kit/v2-admission.js';
import type { PlatformPins } from '../src/platform-runtime/types.js';

const image = `fixture/plain@sha256:${'a'.repeat(64)}`;
const owner = '0x1111111111111111111111111111111111111111';

function v2Authority() {
  const address = (digit: string) => `0x${digit.repeat(40)}` as const;
  const pins: PlatformPins = { chainId: 31337, escrowAddress: address('1'), tokenAddress: address('2'),
    quoteSigner: address('3'), receiptRootAddress: address('4'), hostRegistryAddress: address('5'),
    feeRouterAddress: address('6'), tokenCodeHash: randomId(), reviewedTokenKind: 'immutable',
    escrowCodeHash: randomId(), receiptRootCodeHash: randomId(), hostRegistryCodeHash: randomId(),
    feeRouterCodeHash: randomId() };
  return new ArchiveHostV2AdmissionAuthority(
    createPublicClient({ transport: http('http://127.0.0.1:1') }), pins, 1);
}

function sharedCoordinator(journal: HostJournal, controller: Ed25519Identity,
  runtime: LocalProcessFixtureRuntime) {
  return new HostAdmissionCoordinator(journal, runtime, undefined, {
    version: 1, hostKey: journal.identity.publicKey, controlKey: controller.publicKey,
    isolation: runtime.isolation, runtime: 'plain-binding-test', sessionBackend: null,
  }, async () => []);
}

describe('permanent plain HostKit CPU mode binding', () => {
  it('claims cpu1 before cleanup and prevents later v2 or shared startup', async () => {
    const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const plain = new HostKitAgent(journal, runtime, controller.publicKey, new Set([image]));
    const v2Runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const v2 = new HostKitAgent(journal, v2Runtime, controller.publicKey, new Set([image]),
      Date.now, undefined, v2Authority());
    const shared = sharedCoordinator(journal, controller, new LocalProcessFixtureRuntime('test-fixture-only'));
    const v2Initialize = vi.spyOn(v2Runtime, 'initialize');
    try {
      await plain.initialize();
      const [binding] = await journal.db.select().from(hostBinding);
      expect(binding).toMatchObject({ slot: 'cpu1', scope: { version: 1,
        kind: 'host-v1-plain-cpu', hostKey: journal.identity.publicKey,
        controlKey: controller.publicKey, isolation: runtime.isolation } });
      await expect(v2.initialize()).rejects.toMatchObject({ code: 'host_unavailable' });
      await expect(shared.initialize()).rejects.toThrow('Shared host admission or cleanup is incomplete');
      expect(v2Initialize).not.toHaveBeenCalled();
      expect(await journal.db.select().from(hostBinding)).toEqual([binding]);
      const now = Date.now();
      const capacity = await plain.capacity(controller.sign('capacity-challenge', {
        version: 1 as const, hostKey: journal.identity.publicKey, image,
        kind: 'one_shot' as const, nonce: randomId(), issuedAt: now, expiresAt: now + 5_000 }));
      expect(capacity.body.available).toBe(true);
      await journal.db.update(hostBinding).set({ scopeHash: randomId() }).where(eq(hostBinding.slot, 'cpu1'));
      const challengeAt = Date.now();
      const changedChallenge = controller.sign('capacity-challenge', {
        version: 1 as const, hostKey: journal.identity.publicKey, image,
        kind: 'one_shot' as const, nonce: randomId(), issuedAt: challengeAt, expiresAt: challengeAt + 5_000 });
      await expect(plain.capacity(changedChallenge)).rejects.toThrow('permanently bound CPU journal');
      const issuedAt = Date.now();
      const lease = controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: journal.identity.publicKey, runId: randomId(), owner, image,
        argv: [process.execPath, '-e', "process.stdout.write('blocked')"],
        issuedAt, expiresAt: issuedAt + 20_000, maxSeconds: 20, nonce: randomId() }));
      await expect(plain.admit(lease)).rejects.toThrow('permanently bound CPU journal');
      expect(await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, lease.body.runId)))
        .toHaveLength(0);
    } finally { await plain.close(); await v2.close(); shared.closeAdmission(); await journal.close(); }
  });

  it.each(['v2', 'shared'] as const)('lets only one mode claim cpu1 during concurrent plain/%s startup', async mode => {
    for (const first of ['plain', 'other'] as const) {
      const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
      const plainRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
      const plain = new HostKitAgent(journal, plainRuntime, controller.publicKey, new Set([image]));
      const otherRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
      const v2 = mode === 'v2' ? new HostKitAgent(journal, otherRuntime, controller.publicKey,
        new Set([image]), Date.now, undefined, v2Authority()) : undefined;
      const shared = mode === 'shared' ? sharedCoordinator(journal, controller, otherRuntime) : undefined;
      try {
        let plainFlight: ReturnType<HostKitAgent['initialize']>;
        let otherFlight: Promise<unknown>;
        if (first === 'plain') {
          plainFlight = plain.initialize(); otherFlight = v2 ? v2.initialize() : shared!.initialize();
        } else {
          otherFlight = v2 ? v2.initialize() : shared!.initialize(); plainFlight = plain.initialize();
        }
        const [plainResult, otherResult] = await Promise.allSettled([plainFlight, otherFlight]);
        expect([plainResult, otherResult].filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect([plainResult, otherResult].filter(result => result.status === 'rejected')).toHaveLength(1);
        const bindings = await journal.db.select().from(hostBinding);
        expect(bindings).toHaveLength(1);
        expect(bindings[0]?.slot).toBe('cpu1');
        if (plainResult.status === 'fulfilled') {
          expect(bindings[0]?.scope).toMatchObject({ kind: 'host-v1-plain-cpu' });
          expect(plain.identity().ready).toBe(true);
        } else {
          expect(bindings[0]?.scope).not.toMatchObject({ kind: 'host-v1-plain-cpu' });
          expect(plain.identity().ready).toBe(false);
        }
      } finally { await plain.close(); await v2?.close(); shared?.closeAdmission(); await journal.close(); }
    }
  });

  it('refuses paid-session history before and after plain binding', async () => {
    const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const plain = new HostKitAgent(journal, runtime, controller.publicKey, new Set([image]));
    const now = Date.now();
    const lease = controller.sign('lease', leaseSchema.parse({ version: 1,
      hostKey: journal.identity.publicKey, runId: randomId(), owner, image,
      argv: [process.execPath, '-e', "process.stdout.write('paid')"],
      issuedAt: now, expiresAt: now + 20_000, maxSeconds: 20, nonce: randomId() }));
    try {
      await journal.db.insert(hostPaidSessions).values({ sessionId: lease.body.runId, owner,
        leaseHash: hostMessageHash(lease), lease, state: 'completed', cleanupConfirmed: true });
      await expect(plain.initialize()).rejects.toThrow('permanently bound CPU journal');
      expect(await journal.db.select().from(hostBinding)).toHaveLength(0);
      await journal.db.delete(hostPaidSessions);
      await plain.initialize();
      await plain.close();
      await journal.db.insert(hostPaidPreemptions).values({ sessionId: randomId(),
        optIn: {}, optInHash: randomId(), optInNonce: randomId() });
      const reopened = new HostKitAgent(journal, new LocalProcessFixtureRuntime('test-fixture-only'),
        controller.publicKey, new Set([image]));
      try {
        await expect(reopened.initialize()).rejects.toThrow('permanently bound CPU journal');
        expect(reopened.identity().ready).toBe(false);
      } finally { await reopened.close(); }
    } finally { await plain.close(); await journal.close(); }
  });

  it('adopts legacy plain runs, reopens the same scope, and rejects a changed scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-plain-binding-'));
    const controller = new Ed25519Identity();
    let journal: HostJournal | undefined;
    let agent: HostKitAgent | undefined;
    try {
      journal = await openHostJournal(directory);
      const now = Date.now();
      const lease = controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: journal.identity.publicKey, runId: randomId(), owner, image,
        argv: [process.execPath, '-e', "process.stdout.write('legacy')"],
        issuedAt: now, expiresAt: now + 20_000, maxSeconds: 20, nonce: randomId() }));
      await journal.db.insert(hostRuns).values({ runId: lease.body.runId, owner,
        leaseHash: hostMessageHash(lease), lease, state: 'completed', cleanupConfirmed: true });
      expect(await journal.db.select().from(hostBinding)).toHaveLength(0);
      await journal.close(); journal = await openHostJournal(directory);
      agent = new HostKitAgent(journal, new LocalProcessFixtureRuntime('test-fixture-only'),
        controller.publicKey, new Set([image]));
      await agent.initialize();
      expect(await journal.db.select().from(hostBinding)).toHaveLength(1);
      expect(await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, lease.body.runId)))
        .toHaveLength(1);
      await agent.close(); agent = undefined;
      await journal.close(); journal = await openHostJournal(directory);
      agent = new HostKitAgent(journal, new LocalProcessFixtureRuntime('test-fixture-only'),
        controller.publicKey, new Set([image]));
      await agent.initialize();
      expect(agent.identity().ready).toBe(true);
      await agent.close(); agent = undefined;
      const changed = new HostKitAgent(journal, new LocalProcessFixtureRuntime('test-fixture-only'),
        new Ed25519Identity().publicKey, new Set([image]));
      await expect(changed.initialize()).rejects.toThrow('permanently bound CPU journal');
      expect(changed.identity().ready).toBe(false);
      await changed.close();
    } finally { await agent?.close(); await journal?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['lease hash', 'owner', 'run identifier', 'signature'] as const)(
    'refuses to claim a legacy journal with an altered %s', async field => {
      const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
      const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
      const agent = new HostKitAgent(journal, runtime, controller.publicKey, new Set([image]));
      const initialize = vi.spyOn(runtime, 'initialize'), cleanup = vi.spyOn(runtime, 'cleanupOrphans');
      const now = Date.now();
      const lease = controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: journal.identity.publicKey, runId: randomId(), owner, image,
        argv: [process.execPath, '-e', "process.stdout.write('legacy')"],
        issuedAt: now, expiresAt: now + 20_000, maxSeconds: 20, nonce: randomId() }));
      const storedLease = field === 'signature' ? { ...lease, signature: new Ed25519Identity().sign('lease', lease.body).signature } : lease;
      try {
        await journal.db.insert(hostRuns).values({
          runId: field === 'run identifier' ? randomId() : lease.body.runId,
          owner: field === 'owner' ? '0x2222222222222222222222222222222222222222' : owner,
          leaseHash: field === 'lease hash' ? randomId() : hostMessageHash(storedLease),
          lease: storedLease, state: 'completed', cleanupConfirmed: true,
        });
        await expect(agent.initialize()).rejects.toThrow('original run journal cannot be verified');
        expect(await journal.db.select().from(hostBinding)).toHaveLength(0);
        expect(initialize).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
      } finally { await agent.close(); await journal.close(); }
    });

  it('allows only one agent to initialize and clean up a journal at a time', async () => {
    const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const firstRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
    const secondRuntime = new LocalProcessFixtureRuntime('test-fixture-only');
    const first = new HostKitAgent(journal, firstRuntime, controller.publicKey, new Set([image]));
    const second = new HostKitAgent(journal, secondRuntime, controller.publicKey, new Set([image]));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const originalInitialize = firstRuntime.initialize.bind(firstRuntime);
    vi.spyOn(firstRuntime, 'initialize').mockImplementation(async key => {
      entered(); await held; await originalInitialize(key);
    });
    const secondInitialize = vi.spyOn(secondRuntime, 'initialize');
    const secondCleanup = vi.spyOn(secondRuntime, 'cleanupOrphans');
    try {
      const opening = first.initialize();
      await started;
      await expect(second.initialize()).rejects.toMatchObject({ code: 'host_unavailable' });
      await expect(first.initialize()).rejects.toThrow('already initialized');
      expect(secondInitialize).not.toHaveBeenCalled();
      expect(secondCleanup).not.toHaveBeenCalled();
      const closing = first.close();
      await expect(second.initialize()).rejects.toMatchObject({ code: 'host_unavailable' });
      release();
      await opening;
      await closing;
      await second.initialize();
      expect(second.identity().ready).toBe(true);
      expect(secondInitialize).toHaveBeenCalledTimes(1);
      await expect(first.admit(controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: journal.identity.publicKey, runId: randomId(), owner, image,
        argv: [process.execPath, '-e', "process.stdout.write('stale')"],
        issuedAt: Date.now(), expiresAt: Date.now() + 20_000,
        maxSeconds: 20, nonce: randomId() })))).rejects.toMatchObject({ code: 'host_unavailable' });
    } finally { release(); await first.close(); await second.close(); await journal.close(); }
  });

  it('does not let a refused shared agent close the live coordinator', async () => {
    const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const admission = sharedCoordinator(journal, controller, runtime);
    const first = new HostKitAgent(journal, runtime, controller.publicKey, new Set([image]),
      Date.now, admission);
    const refused = new HostKitAgent(journal, runtime, controller.publicKey, new Set([image]),
      Date.now, admission);
    try {
      await first.initialize();
      await expect(refused.initialize()).rejects.toMatchObject({ code: 'host_unavailable' });
      await refused.close();
      expect(first.identity().ready).toBe(true);
      expect(admission.available()).toBe(true);
    } finally { await refused.close(); await first.close(); await journal.close(); }
  });

  it('rejects another admission while close drains an in-flight dispatch', async () => {
    const journal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const agent = new HostKitAgent(journal, runtime, controller.publicKey, new Set([image]));
    let entered!: () => void;
    let release!: () => void;
    let complete!: (result: { output: string; exitCode: number }) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const wait = new Promise<{ output: string; exitCode: number }>(resolve => { complete = resolve; });
    const start = vi.spyOn(runtime, 'start').mockImplementation(async () => {
      entered(); await held;
      return { wait, sample: async () => ({ running: true, cpuMs: 0 }),
        stop: async () => { complete({ output: '', exitCode: -1 }); await wait; } };
    });
    const signed = () => {
      const now = Date.now();
      return controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: journal.identity.publicKey, runId: randomId(), owner, image,
        argv: [process.execPath, '-e', "process.stdout.write('held')"],
        issuedAt: now, expiresAt: now + 20_000, maxSeconds: 20, nonce: randomId() }));
    };
    try {
      await agent.initialize();
      const admitting = agent.admit(signed());
      await started;
      const closing = agent.close();
      expect(agent.identity().ready).toBe(false);
      const rejected = expect(agent.admit(signed())).rejects.toMatchObject({ code: 'host_unavailable' });
      expect(start).toHaveBeenCalledTimes(1);
      release();
      await admitting;
      await rejected;
      await closing;
      expect(start).toHaveBeenCalledTimes(1);
    } finally { release(); complete({ output: '', exitCode: -1 }); await agent.close(); await journal.close(); }
  });
});
