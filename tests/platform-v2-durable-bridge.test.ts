import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEventLogs, type Hex } from 'viem';
import { compileContracts, projectRoot, type ContractArtifact } from '../scripts/compile-contracts.js';
import { randomId } from '../src/common.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, type HostLease } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { platformHostLeases, platformRuns } from '../src/platform-runtime/schema.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformEscrowAbi, platformHostSchema, typedPlatformSettlement } from '../src/platform-runtime/types.js';
import { PlatformPublicFinancialReader } from '../src/platform-runtime/public-financial.js';
import { createPlatformReadOnlyBridge } from '../src/platform-runtime/read-only.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { PlatformV2AdmissionJournal } from '../src/receipts/platform-v2-admission.js';
import { verifyPlatformV2CombinedEvidence } from '../src/receipts/platform-v2-combined.js';
import { createPlatformV2Routes } from '../src/receipts/platform-v2-routes.js';
import type { PlatformV2HistoricalAuthority } from '../src/receipts/platform-v2.js';
import { confirmPlatformV2DurableSettlement, preparePlatformV2FromDurableRun,
  requirePlatformV2DurableHash } from '../src/receipts/platform-v2-durable.js';
import { openStore } from '../src/store.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const execFileAsync = promisify(execFile);

class ShaFixture extends LocalProcessFixtureRuntime {
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    const program = "let body='';process.stdin.on('data',x=>body+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({echo:JSON.parse(body).text})));";
    return super.start({ ...lease, argv: [process.execPath, '-e', program] }, heartbeat);
  }
}

describe('default-off v2 bridge from a real paid Anvil/HostKit run', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); });

  it('derives the complete ordered package from durable rows and refuses to relabel the current v1 settlement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-v2-durable-'));
    const hostJournal = await openHostJournal(':memory:');
    const controller = new Ed25519Identity();
    const image = `fixture/node@sha256:${'1'.repeat(64)}`;
    const agent = new HostKitAgent(hostJournal, new ShaFixture(), controller.publicKey, new Set([image]));
    let server: Server | undefined;
    let local: Awaited<ReturnType<typeof deployPlatformRuntime>> | undefined;
    let store: Awaited<ReturnType<typeof openStore>> | undefined;
    try {
      await agent.initialize();
      server = createServer(getRequestListener(createHostKitRoutes(agent).fetch));
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const bound = server.address(); if (!bound || typeof bound === 'string') throw new Error('Missing fixture port');
      const client = new HostKitClient(`http://127.0.0.1:${bound.port}`, hostJournal.identity.publicKey, controller, true);
      local = await deployPlatformRuntime(hostJournal.identity.publicKey as Hex, artifacts);
      store = await openStore({ DATA_DIR: join(directory, 'db') });
      const host = platformHostSchema.parse({ hostId: local.hostId, hostKey: hostJournal.identity.publicKey,
        hardwareClass: 'cpu', region: 'local-test', image, imageDigest: image.split('@')[1],
        sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000,
        strikes: 0, stake: '300000000', availableAt: 0 });
      const bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl,
        signerPrivateKey: local.keys.signer });
      const admissionJournal = new PlatformV2AdmissionJournal(store.db, bridge);
      await admissionJournal.initialize();
      const originalAdmit = client.admit.bind(client);
      const admit = vi.spyOn(client, 'admit').mockImplementation(async signedLease => {
        const saved = await admissionJournal.get(signedLease.body.runId);
        expect(saved?.signedLeaseHash).toBe(hostMessageHash(signedLease));
        expect(saved?.delegation.body.controllerKey).toBe(controller.publicKey);
        const request = { owner: signedLease.body.owner, hostId: host.hostId,
          controllerKey: controller.publicKey, lease: signedLease };
        await expect(admissionJournal.issueBeforeHostAdmission({ ...request,
          hostId: randomId() })).rejects.toThrow('pre-admission');
        await expect(admissionJournal.issueBeforeHostAdmission({ ...request,
          controllerKey: randomId() })).rejects.toThrow('pre-admission');
        const [original] = await store!.db.select().from(platformRuns)
          .where(eq(platformRuns.id, signedLease.body.runId));
        await store!.db.update(platformRuns).set({ quote: { ...original!.quote,
          workloadHash: randomId() } }).where(eq(platformRuns.id, signedLease.body.runId));
        await expect(admissionJournal.issueBeforeHostAdmission(request))
          .rejects.toThrow('quote or workload');
        await store!.db.update(platformRuns).set({ quote: original!.quote,
          admissionTx: randomId() }).where(eq(platformRuns.id, signedLease.body.runId));
        await expect(admissionJournal.issueBeforeHostAdmission(request)).rejects.toThrow();
        await store!.db.update(platformRuns).set({ admissionTx: original!.admissionTx })
          .where(eq(platformRuns.id, signedLease.body.runId));
        const stopped = await local!.test.snapshot();
        await local!.confirmed(local!.owner.writeContract({ address: local!.pins.escrowAddress,
          abi: local!.artifact('PlatformRunEscrow').abi, functionName: 'requestStop',
          args: [signedLease.body.runId] }));
        await expect(admissionJournal.issueBeforeHostAdmission(request))
          .rejects.toThrow('no longer runnable');
        await local!.test.revert({ id: stopped });
        const killed = await local!.test.snapshot();
        await local!.confirmed(local!.owner.writeContract({ address: local!.pins.escrowAddress,
          abi: local!.artifact('PlatformRunEscrow').abi, functionName: 'killLeash',
          args: [leashId] }));
        await expect(admissionJournal.issueBeforeHostAdmission(request))
          .rejects.toThrow('no longer runnable');
        await local!.test.revert({ id: killed });
        return originalAdmit(signedLease);
      });
      const executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]), admissionJournal);
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
        args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n,
          maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
          imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(await bridge.now() + 86_400) }] }));
      const prepared = await service.quote(local.accounts.owner.address,
        { leashId, task: { kind: 'sha256', text: 'original-v2-hostkit-evidence' },
          maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'v2-durable-real');
      const opened = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, value: 0n }));
      const openLogs = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunOpened', logs: opened.logs });
      expect(openLogs.some(event => event.args.runId === prepared.quote.runId)).toBe(true);
      await service.admit(local.accounts.owner.address,
        { runId: prepared.quote.runId, transactionHash: opened.transactionHash }, 'v2-durable-admit');
      // Isolated v2 pre-settlement experiment: hold the normal v1 financial record.
      const heldV1Record = vi.spyOn(receipts, 'record').mockResolvedValue(undefined);
      await service.drain();
      heldV1Record.mockRestore();
      expect(admit).toHaveBeenCalledTimes(1);
      const [row] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, prepared.quote.runId));
      const [lease] = await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, prepared.quote.runId));
      expect(row?.status).toBe('receipt_pending');
      expect(lease?.cleanupConfirmed).toBe(1);
      expect(lease?.ticks.length).toBeGreaterThan(0);
      expect(lease?.ticks.length).toBe(lease?.acknowledgments.length);
      const canonical = await bridge.run(prepared.quote.runId);
      const historical: PlatformV2HistoricalAuthority = {
        chainId: 31337, escrow: local.pins.escrowAddress,
        hostRegistry: local.pins.hostRegistryAddress, quoteSigner: local.accounts.signer.address,
        runId: prepared.quote.runId, hostId: canonical.hostId, hostKey: host.hostKey as Hex,
        payer: canonical.payer, leashId: canonical.leashId, hwClass: 0,
        regionHash: canonical.regionHash, imageHash: canonical.imageHash,
        workloadHash: canonical.workloadHash, pricePerSecond: canonical.pricePerSecond.toString(),
        inferencePrice: canonical.inferencePrice.toString(), quoteExpiry: prepared.quote.quoteExpiry,
        maxSeconds: Number(canonical.maxSeconds), openedAt: Number(canonical.openedAt),
        cutoff: Math.min(Number(canonical.acceptedExpiry),
          Number(canonical.openedAt + canonical.maxSeconds)),
      };
      const savedDelegation = await admissionJournal.get(prepared.quote.runId);
      expect(savedDelegation?.admissionTx).toBe(opened.transactionHash);
      const delegation = savedDelegation!.delegation;
      const salt = randomId();
      const candidate = await preparePlatformV2FromDurableRun(store.db, prepared.quote.runId,
        local.accounts.owner.address, delegation, salt, historical);
      expect(candidate.receiptVersion).toBe('v1-existing');
      expect(candidate.originalV1Hash).toBe(row!.settlement!.receiptHash);
      expect(candidate.candidate.receiptHash).not.toBe(row!.settlement!.receiptHash);
      expect(candidate.candidate.core.hostPairCount).toBe(lease!.ticks.length);
      expect(candidate.candidate.core.ticks).toEqual(lease!.ticks);
      expect(candidate.candidate.core.acknowledgments).toEqual(lease!.acknowledgments);
      expect(candidate.onchainReceiptVerified).toBe(false);
      expect(() => requirePlatformV2DurableHash(candidate)).toThrow('does not commit');
      const replay = await preparePlatformV2FromDurableRun(store.db, prepared.quote.runId,
        local.accounts.owner.address, delegation, salt, historical);
      expect(replay).toEqual(candidate);
      const publicRoutes = createPlatformV2Routes(bridge, 1);
      const verifyHttp = (settlementTransactionHash: string, core: unknown = candidate.candidate.core) =>
        publicRoutes.request('http://localhost/verify', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            openTransactionHash: opened.transactionHash, settlementTransactionHash, core }) });
      // The same real run can settle with its original v1 commitment, but that
      // financial proof must never make the different v2 candidate valid.
      const beforeV1 = await local.test.snapshot();
      const v1Settlement = row!.settlement!;
      const v1Leaf = await bridge.public.readContract({ address: local.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'receiptLeaf', args: [typedPlatformSettlement(v1Settlement)] });
      const v1Hour = Math.floor(v1Settlement.endedAt / 3600);
      await local.test.setNextBlockTimestamp({ timestamp: BigInt(Math.max(await bridge.now() + 1, (v1Hour + 1) * 3600)) });
      await local.test.mine({ blocks: 1 });
      await local.confirmed(bridge.wallet.writeContract({ address: local.pins.receiptRootAddress,
        abi: local.artifact('ReceiptRoot').abi, functionName: 'postRoot', args: [BigInt(v1Hour), v1Leaf, 1] }));
      const v1Settled = await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'settleRun', args: [typedPlatformSettlement(v1Settlement), BigInt(v1Hour), []] }));
      expect(await new PlatformPublicFinancialReader(bridge, 1).verify(prepared.quote.runId,
        v1Settled.transactionHash)).toMatchObject({ kind: 'settlement', receiptHash: candidate.originalV1Hash });
      expect((await verifyHttp(v1Settled.transactionHash)).status).not.toBe(200);
      await local.test.revert({ id: beforeV1 });
      const v2Settlement = { ...row!.settlement!, receiptHash: candidate.candidate.receiptHash };
      await store.db.update(platformRuns).set({ settlement: v2Settlement })
        .where(eq(platformRuns.id, prepared.quote.runId));
      if (await bridge.now() <= v2Settlement.endedAt) {
        await local.test.setNextBlockTimestamp({ timestamp: BigInt(v2Settlement.endedAt + 1) });
        await local.test.mine({ blocks: 1 });
      }
      await receipts.record(local.accounts.owner.address, v2Settlement);
      const beforePublication = await local.test.snapshot();
      const hour = Math.floor(v2Settlement.endedAt / 3600);
      await local.test.setNextBlockTimestamp({ timestamp: BigInt(Math.max(await bridge.now() + 1, (hour + 1) * 3600)) });
      await local.test.mine({ blocks: 1 });
      await receipts.publish(hour);
      const proof = await receipts.proof(local.accounts.owner.address, prepared.quote.runId);
      expect(proof).toBeDefined();
      const settled = await bridge.settle(v2Settlement, hour, proof!.proof, proof!.transactionHash);
      await store.db.update(platformRuns).set({ status: 'completed', settlementTx: settled.transactionHash,
        charged: settled.charged, refund: settled.refund }).where(eq(platformRuns.id, prepared.quote.runId));
      const locallyAnchored = requirePlatformV2DurableHash(await preparePlatformV2FromDurableRun(
        store.db, prepared.quote.runId, local.accounts.owner.address, delegation, salt, historical));
      const confirmed = await confirmPlatformV2DurableSettlement(locallyAnchored, bridge, receipts,
        local.accounts.owner.address);
      expect(confirmed).toMatchObject({ receiptVersion: 'v2-local-commitment',
        onchainReceiptVerified: true, financialRootVerified: true,
        independentlyPublished: false, historicalAuthoritySource: 'caller-supplied' });
      const combined = await verifyPlatformV2CombinedEvidence(bridge, opened.transactionHash,
        settled.transactionHash, candidate.candidate.core, 1);
      expect(combined).toMatchObject({ runId: prepared.quote.runId,
        receiptHash: candidate.candidate.receiptHash, hostPairCount: lease!.ticks.length,
        historicalAuthoritySource: 'archive-rpc', onchainReceiptVerified: true,
        committedTickAckSequenceVerified: true, physicalTickStreamCompletenessProven: false,
        historicalDelegationIssuanceTimeProven: false, independentlyPublished: false,
        executionStatusProven: false, outputVerified: false,
        financial: { kind: 'settlement', transactionHash: settled.transactionHash,
          receiptHash: candidate.candidate.receiptHash, proofVerified: true } });
      const publicResponse = await verifyHttp(settled.transactionHash);
      expect(publicResponse.status).toBe(200);
      expect(publicResponse.headers.get('Cache-Control')).toBe('no-store');
      expect(await publicResponse.json()).toMatchObject({ runId: prepared.quote.runId,
        receiptHash: candidate.candidate.receiptHash, historicalAuthoritySource: 'archive-rpc',
        committedTickAckSequenceVerified: true, onchainReceiptVerified: true,
        historicalDelegationIssuanceTimeProven: false, independentlyPublished: false,
        outputVerified: false, opening: { blockNumber: opened.blockNumber.toString(),
          confirmations: combined.opening.confirmations.toString() } });
      expect((await verifyHttp(settled.transactionHash, { ...candidate.candidate.core,
        ticks: [...candidate.candidate.core.ticks].reverse() })).status).not.toBe(200);
      const independent = createPlatformReadOnlyBridge(local.pins, local.local.rpcUrl);
      expect('wallet' in independent || 'account' in independent || 'transactions' in independent).toBe(false);
      expect(await verifyPlatformV2CombinedEvidence(independent, opened.transactionHash,
        settled.transactionHash, candidate.candidate.core, 1)).toMatchObject({
        receiptHash: candidate.candidate.receiptHash, onchainReceiptVerified: true,
        historicalAuthoritySource: 'archive-rpc', independentlyPublished: false });
      const pinsPath = join(directory, 'public-pins.json'), corePath = join(directory, 'public-core.json');
      await writeFile(pinsPath, JSON.stringify(local.pins), { mode: 0o600 });
      await writeFile(corePath, JSON.stringify(candidate.candidate.core), { mode: 0o600 });
      const cliArgs = ['--import', 'tsx', 'scripts/platform-v2-verify.ts', '--pins', pinsPath, '--core', corePath,
        '--rpc-url', local.local.rpcUrl, '--open-transaction', opened.transactionHash,
        '--settlement-transaction', settled.transactionHash, '--confirmations', '1'];
      const cli = () => execFileAsync(process.execPath, cliArgs, { cwd: projectRoot, windowsHide: true,
        timeout: 30_000, maxBuffer: 65_536, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP, TMP: process.env.TMP } });
      const nonceBeforeCli = await bridge.public.getTransactionCount({ address: local.accounts.signer.address });
      const cliResult = await cli();
      expect(JSON.parse(cliResult.stdout)).toMatchObject({ readOnly: true, status: 'verified',
        receiptHash: candidate.candidate.receiptHash, onchainReceiptVerified: true,
        independentlyPublished: false, historicalDelegationIssuanceTimeProven: false,
        opening: { blockNumber: opened.blockNumber.toString() } });
      expect(cliResult.stderr).toBe('');
      expect(await bridge.public.getTransactionCount({ address: local.accounts.signer.address })).toBe(nonceBeforeCli);
      await writeFile(pinsPath, JSON.stringify({ ...local.pins, tokenCodeHash: randomId() }), { mode: 0o600 });
      await expect(cli()).rejects.toMatchObject({ code: 1,
        stdout: JSON.stringify({ readOnly: true, status: 'rejected', phase: 'chain', code: 'platform_v2_unverified' }) + '\n' });
      await writeFile(pinsPath, JSON.stringify(local.pins), { mode: 0o600 });
      await expect(verifyPlatformV2CombinedEvidence(bridge, opened.transactionHash,
        opened.transactionHash, candidate.candidate.core, 1)).rejects.toThrow();
      await expect(verifyPlatformV2CombinedEvidence(bridge, opened.transactionHash,
        settled.transactionHash, { ...candidate.candidate.core,
          billableSeconds: candidate.candidate.core.billableSeconds + 1 }, 1))
        .rejects.toThrow('differs from its canonical CPU financial settlement');
      const firstTick = candidate.candidate.core.ticks[0]!;
      await expect(verifyPlatformV2CombinedEvidence(bridge, opened.transactionHash,
        settled.transactionHash, { ...candidate.candidate.core,
          ticks: [{ ...firstTick, body: { ...firstTick.body,
            cpuMs: firstTick.body.cpuMs + 1 } }, ...candidate.candidate.core.ticks.slice(1)] }, 1))
        .rejects.toThrow();
      await expect(confirmPlatformV2DurableSettlement(locallyAnchored, bridge,
        { proof: async (owner, runId) => {
          const original = await receipts.proof(owner, runId);
          return original && { ...original, leaf: randomId() };
        } }, local.accounts.owner.address)).rejects.toThrow('financial proof differs');
      await store.db.update(platformHostLeases).set({ ticks: [...lease!.ticks].reverse() })
        .where(eq(platformHostLeases.runId, prepared.quote.runId));
      await expect(preparePlatformV2FromDurableRun(store.db, prepared.quote.runId,
        local.accounts.owner.address, delegation, salt, historical)).rejects.toThrow();
      await local.test.revert({ id: beforePublication });
      await expect(confirmPlatformV2DurableSettlement(locallyAnchored, bridge, receipts,
        local.accounts.owner.address)).rejects.toThrow();
      await expect(verifyPlatformV2CombinedEvidence(bridge, opened.transactionHash,
        settled.transactionHash, candidate.candidate.core, 1)).rejects.toThrow();
      expect((await verifyHttp(settled.transactionHash)).status).not.toBe(200);
      await expect(cli()).rejects.toMatchObject({ code: 1 });
      const denied = vi.spyOn(admissionJournal, 'issueBeforeHostAdmission')
        .mockRejectedValue(new Error('test certificate storage unavailable'));
      const second = await service.quote(local.accounts.owner.address,
        { leashId, task: { kind: 'sha256', text: 'must-never-reach-host' },
          maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'v2-gate-denied');
      const secondOpened = await local.confirmed(local.owner.sendTransaction({ to: second.transaction.to,
        data: second.transaction.data as Hex, value: 0n }));
      await service.admit(local.accounts.owner.address,
        { runId: second.quote.runId, transactionHash: secondOpened.transactionHash }, 'v2-gate-denied-admit');
      await expect(service.drain()).rejects.toThrow('Platform execution requires original-lease recovery');
      expect(admit).toHaveBeenCalledTimes(1);
      expect((await store.db.select().from(platformHostLeases)
        .where(eq(platformHostLeases.runId, second.quote.runId))).length).toBe(0);
      denied.mockRestore();
    } finally {
      await agent.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      await hostJournal.close();
      await store?.close(); await local?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
