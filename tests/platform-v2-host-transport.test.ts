import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { randomId } from '../src/common.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { hostBinding, openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, leaseSchema, type HostLease } from '../src/host-kit/protocol.js';
import { ArchiveHostV2AdmissionAuthority } from '../src/host-kit/v2-admission.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { platformHostLeases, platformRuns } from '../src/platform-runtime/schema.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { PlatformV2AdmissionJournal, platformV2HostAdmissions } from '../src/receipts/platform-v2-admission.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

class CpuFixture extends LocalProcessFixtureRuntime {
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    return super.start({ ...lease, argv: [process.execPath, '-e',
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('transport-output'));" ] }, heartbeat);
  }
}

describe('paid CPU v2 exact HostKit transport and response journal', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol',
    'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); });

  it('uses v2 admission, saves testimony before ticks, and recovers a lost reply only after stopping the original run', async () => {
    const hostJournal = await openHostJournal(':memory:'), controller = new Ed25519Identity();
    const store = await openStore({ DATA_DIR: ':memory:' });
    const local = await deployPlatformRuntime(hostJournal.identity.publicKey as Hex, artifacts);
    const bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl,
      signerPrivateKey: local.keys.signer });
    const runtime = new CpuFixture(), start = vi.spyOn(runtime, 'start');
    const image = `fixture/node@sha256:${'1'.repeat(64)}`;
    const agent = new HostKitAgent(hostJournal, runtime, controller.publicKey, new Set([image]),
      Date.now, undefined, new ArchiveHostV2AdmissionAuthority(bridge.public, local.pins, 1));
    let server: Server | undefined;
    try {
      await agent.initialize();
      server = createServer(getRequestListener(createHostKitRoutes(agent).fetch));
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing host port');
      const client = new HostKitClient(`http://127.0.0.1:${address.port}`, hostJournal.identity.publicKey, controller, true);
      const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: hostJournal.identity.publicKey,
        hardwareClass: 'cpu', region: 'local-test', image, imageDigest: image.split('@')[1],
        sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000,
        strikes: 0, stake: '300000000', availableAt: 0 });
      expect(await client.capacity(image, 'one_shot')).toBe(true);
      expect(await client.capacity(image, 'session')).toBe(false);
      const [binding] = await hostJournal.db.select().from(hostBinding);
      await hostJournal.db.update(hostBinding).set({ scopeHash: randomId() });
      await expect(client.capacity(image, 'one_shot')).rejects.toThrow('capacity request failed');
      await hostJournal.db.update(hostBinding).set({ scopeHash: binding!.scopeHash });

      const admission = new PlatformV2AdmissionJournal(store.db, bridge, true);
      await admission.initialize();
      const executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]), admission);
      let service: PlatformRuntimeService;
      const receipts = new PlatformReceiptService(store.db, { chainId: 31337,
        escrowAddress: local.pins.escrowAddress, receiptRootAddress: local.pins.receiptRootAddress,
        publicClient: bridge.public, submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data),
        canSeal: hour => service.canSeal(hour) });
      service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts);
      await service.initialize();
      const leashId = randomId();
      await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'createLeash',
        args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
          classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`,
          regionAllowRoot: `0x${'0'.repeat(64)}`, expiry: BigInt(await bridge.now() + 86_400) }] }));
      const prepared = await service.quote(local.accounts.owner.address,
        { leashId, task: { kind: 'sha256', text: 'private-input' }, maxSeconds: 25,
          deadline: await bridge.now() + 300, maxSpend: '10000' }, 'v2-transport');
      if (prepared.input.task.kind !== 'sha256') throw new Error('Unexpected fixture task');
      const opened = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      await service.admit(local.accounts.owner.address, { runId: prepared.quote.runId,
        transactionHash: opened.transactionHash }, 'v2-transport-admit');
      await store.db.update(platformRuns).set({ status: 'running', receiptVersion: 2 })
        .where(eq(platformRuns.id, prepared.quote.runId));
      const originalV2 = client.admitV2.bind(client);
      const plain = vi.spyOn(client, 'admit'), v2 = vi.spyOn(client, 'admitV2');
      let observed = 0;
      const result = await executor.run(local.accounts.owner.address, host, {
        runId: prepared.quote.runId, task: prepared.input.task, maxSeconds: prepared.quote.maxSeconds,
      }, new AbortController().signal, async () => {
        observed++;
        expect((await admission.originalHostAdmission(prepared.quote.runId))?.admission).toBeDefined();
      });
      expect(result.status).toBe('completed');
      expect(observed).toBeGreaterThan(0);
      expect(plain).not.toHaveBeenCalled();
      expect(v2).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      const original = await admission.originalHostAdmission(prepared.quote.runId);
      expect(original?.admission).toBeDefined();
      const [hostLease] = await store.db.select().from(platformHostLeases)
        .where(eq(platformHostLeases.runId, prepared.quote.runId));
      expect(hostLease?.cleanupConfirmed).toBe(1);
      expect(hostLease!.ticks[0]!.body.timestamp).toBeGreaterThanOrEqual(original!.admission!.body.acceptedAtMs);
      await expect(admission.recordHostAdmission(original!.envelope, { ...original!.admission!,
        body: { ...original!.admission!.body, quoteHash: randomId() } })).rejects.toThrow('signature or exact envelope');
      await expect(admission.recordHostAdmission({ ...original!.envelope,
        admissionTx: randomId() }, original!.admission!)).rejects.toThrow('signature or exact envelope');

      // Lost response after dispatch: no new lease/delegation is created, and
      // an exact replay is allowed only after STOP proves the original host row exists.
      await store.db.update(platformV2HostAdmissions).set({ admission: null });
      const order: string[] = [], originalCommand = client.command.bind(client);
      vi.spyOn(client, 'command').mockImplementation(async (...args) => {
        order.push(args[1]); return originalCommand(...args);
      });
      v2.mockImplementation(async envelope => { order.push('admit-v2'); return originalV2(envelope); });
      const recovered = await executor.recover(local.accounts.owner.address, host, prepared.quote.runId, 25);
      expect(recovered?.output).toBe('transport-output');
      expect(order).toEqual(['stop', 'admit-v2']);
      expect(start).toHaveBeenCalledTimes(1);
      expect((await admission.originalHostAdmission(prepared.quote.runId))?.admission).toEqual(original!.admission);
      await store.db.update(platformV2HostAdmissions).set({ admission: { ...original!.admission!,
        body: { ...original!.admission!.body, openingBlockHash: randomId() } } });
      await expect(admission.originalHostAdmission(prepared.quote.runId)).rejects.toThrow('signature or exact envelope');
      await store.db.update(platformV2HostAdmissions).set({ admission: original!.admission! });
      await store.db.delete(platformV2HostAdmissions);
      order.length = 0;
      await expect(executor.recover(local.accounts.owner.address, host, prepared.quote.runId, 25))
        .rejects.toThrow('journal is required');
      expect(order).toEqual([]);

      const unstarted = await service.quote(local.accounts.owner.address,
        { leashId, task: { kind: 'sha256', text: 'never-dispatch-during-recovery' }, maxSeconds: 25,
          deadline: await bridge.now() + 300, maxSpend: '10000' }, 'v2-unstarted');
      const unstartedOpen = await local.confirmed(local.owner.sendTransaction({ to: unstarted.transaction.to,
        data: unstarted.transaction.data as Hex, value: 0n }));
      await service.admit(local.accounts.owner.address, { runId: unstarted.quote.runId,
        transactionHash: unstartedOpen.transactionHash }, 'v2-unstarted-admit');
      const issuedAt = Date.now();
      const unstartedLease = controller.sign('lease', leaseSchema.parse({ version: 1,
        hostKey: host.hostKey, runId: unstarted.quote.runId, owner: local.accounts.owner.address.toLowerCase(),
        image, argv: ['/usr/local/bin/node', '/opt/telomere/task-runner.mjs'],
        stdin: JSON.stringify(unstarted.input.task), issuedAt, expiresAt: issuedAt + 25_000,
        maxSeconds: 25, nonce: randomId() }));
      const request = { owner: local.accounts.owner.address, hostId: host.hostId,
        controllerKey: controller.publicKey, lease: unstartedLease };
      // An enabled v2 transport leaves original v1 rows on their original path.
      expect(await admission.prepareHostAdmission(request)).toBeUndefined();
      await store.db.update(platformRuns).set({ status: 'running', receiptVersion: 2 })
        .where(eq(platformRuns.id, unstarted.quote.runId));
      await store.db.insert(platformHostLeases).values({ runId: unstarted.quote.runId, hostId: host.hostId,
        owner: unstartedLease.body.owner, lease: unstartedLease, leaseHash: hostMessageHash(unstartedLease) });
      expect(await admission.prepareHostAdmission(request)).toBeDefined();
      order.length = 0;
      await expect(executor.recover(local.accounts.owner.address, host, unstarted.quote.runId, 25))
        .rejects.toThrow('Host Kit request failed');
      expect(order).toEqual(['stop']);
      expect(start).toHaveBeenCalledTimes(1);
      expect(v2).toHaveBeenCalledTimes(2);
    } finally {
      await agent.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await hostJournal.close(); await store.close(); await local.close();
    }
  }, 180_000);
});
