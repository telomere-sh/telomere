import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { CystService } from '../src/cysts/service.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema, typedPlatformSettlement } from '../src/platform-runtime/types.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { createPaidAgentLifecycle } from '../src/agents/platform-runtime.js';
import { createAgentRuntimeBinding } from '../src/agents/runtime-binding.js';
import { AgentLifecycleService } from '../src/agents/service.js';
import { agentBilling, agentBillingAnchors, agentBillingProvenance, agentRuntimeBinding } from '../src/agents/schema.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

describe('EOA paid CPU lifecycle and canonical Metabolism', () => {
  let artifacts: Record<string, ContractArtifact>;
  let local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let store: Awaited<ReturnType<typeof openStore>>, journal: HostJournal, hostAgent: HostKitAgent, hostServer: Server;
  let root: string, bridge: PlatformBridge, runtime: PlatformRuntimeService, cysts: CystService;
  let lifecycle: ReturnType<typeof createPaidAgentLifecycle>, client: HostKitClient;
  let receipts: PlatformReceiptService;
  let host: ReturnType<typeof platformHostSchema.parse>;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol',
    'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); }, 90_000);
  afterEach(async () => {
    vi.restoreAllMocks(); await hostAgent?.close();
    if (hostServer) { hostServer.closeAllConnections(); await new Promise<void>(resolve => hostServer.close(() => resolve())); }
    await journal?.close(); await store?.close(); await local?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  function rebuild() {
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
    const executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]));
    runtime = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts);
    cysts = new CystService(store.db, join(root, 'cysts'));
    lifecycle = createPaidAgentLifecycle(store.db, cysts, runtime);
  }
  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'telomere-paid-lifecycle-'));
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity();
    const digest = `sha256:${'a'.repeat(64)}`, image = 'fixture/node@' + digest;
    hostAgent = new HostKitAgent(journal, new LocalProcessFixtureRuntime('test-fixture-only'), control.publicKey, new Set([image]));
    await hostAgent.initialize();
    hostServer = createServer(getRequestListener(createHostKitRoutes(hostAgent).fetch));
    await new Promise<void>(resolve => hostServer.listen(0, '127.0.0.1', resolve));
    const address = hostServer.address(); if (!address || typeof address === 'string') throw new Error('No host fixture port');
    client = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true);
    // REASON: The Ed25519 journal identity is a generated validated bytes32 public key.
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu',
      region: 'local-test', image, imageDigest: digest, execEnabled: true, sealed: false, lane: 'standard',
      pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    rebuild(); await cysts.initialize(); await runtime.initialize(); await lifecycle.initialize();
  }
  it('uses a real funded run, exact fee-inclusive settled burn and immutable scope across restart, then blocks on a real reorg while retaining kill', async () => {
    await setup();
    const owner = local.accounts.owner.address, agent = owner, leashId = randomId();
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
      abi: local.artifact('PlatformRunEscrow').abi, functionName: 'createLeash', args: [leashId,
        { agent, maxPerHour: 100_000n, maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
          imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(await bridge.now() + 86_400) }] }));
    const prepared = await runtime.quote(owner, { leashId, task: { kind: 'exec', imageDigest: host.imageDigest,
      argv: [process.execPath, '-e', "setTimeout(()=>process.stdout.write('42'),11000)"] },
      maxSeconds: 120, maxSpend: '20000', deadline: await bridge.now() + 600 }, 'paid-lifecycle');
    await expect(lifecycle.agents.register(owner, { agent, runId: prepared.quote.runId })).rejects.toMatchObject({ code: 'agent_reservation_invalid' });
    const opened = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
      // REASON: Prepared transaction data is produced by the checked platform quote encoder.
      data: prepared.transaction.data as Hex, value: 0n }));
    await runtime.admit(owner, { runId: prepared.quote.runId, transactionHash: opened.transactionHash }, 'admit-lifecycle');
    await expect(lifecycle.agents.register(owner, { agent: local.accounts.outsider.address, runId: prepared.quote.runId }))
      .rejects.toMatchObject({ code: 'agent_reservation_invalid' });
    const registered = await lifecycle.agents.register(owner, { agent, runId: prepared.quote.runId });
    expect(registered.agent.currentRunId).toBe(prepared.quote.runId);
    expect((await lifecycle.agents.get(owner, agent)).policy).toMatchObject({ maximumLeaseSeconds: 120, rollBeforeSeconds: 30 });
    expect(await lifecycle.agents.evaluate(owner, agent)).toMatchObject({ mode: 'full', trailing24hBurn: '0', rollDue: false });
    // The new explicit policy uses the real current signed price even before the first settled charge.
    // This one-shot exec has no reviewed smaller session profiles, so insufficient full runway freezes it.
    expect(await lifecycle.agents.evaluate(owner, agent, 2)).toMatchObject({ mode: 'cyst', metabolismVersion: 2,
      trailing24hBurn: '0', runwaySeconds: null, currentBurnPerHour: '392400',
      pricing: { current: { cpuPricePerSecond: '100', completeLeaseCost: '13080' } } });
    await runtime.drain(); const pending = await runtime.get(owner, prepared.quote.runId);
    expect(pending.result?.output).toBe('42'); expect(pending.status).toBe('receipt_pending');
    if (!pending.settlement) throw new Error('Real paid result has no settlement');
    // The original agent at opening remains the burn recipient despite a later Leash update.
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
      abi: local.artifact('PlatformRunEscrow').abi, functionName: 'updateLeash', args: [leashId,
        { agent: local.accounts.outsider.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
          classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(await bridge.now() + 86_400) }] }));
    const beforeSettlement = await local.test.snapshot();
    const closed = BigInt((Math.floor(pending.settlement.endedAt / 3600) + 1) * 3600);
    await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 });
    // Fixed acceptance clock follows the mined future hour; production uses wall time and rejects a leading chain clock.
    vi.spyOn(Date, 'now').mockReturnValue((Number(closed) + 60) * 1000);
    await runtime.drain(); const final = await runtime.get(owner, prepared.quote.runId);
    expect(final.status).toBe('completed'); expect(BigInt(final.charged ?? '0')).toBeGreaterThan(0n);
    const originalAppend = lifecycle.agents.appendSettledCharge.bind(lifecycle.agents);
    const interrupted = vi.spyOn(lifecycle.agents, 'appendSettledCharge').mockImplementationOnce(async (...args) => {
      await originalAppend(...args); throw new Error('Crash after durable ingestion, before prefix validation');
    });
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    expect((await store.db.select().from(agentBillingProvenance))[0]?.validatedAnchorHash).toBeNull();
    interrupted.mockRestore();
    await lifecycle.maintain();
    expect((await store.db.select().from(agentBillingProvenance))[0]?.validatedAnchorHash).not.toBeNull();
    const evaluated = await lifecycle.agents.evaluate(owner, agent);
    expect(evaluated.trailing24hBurn).toBe(final.charged);
    expect(evaluated.balance).toBe((await bridge.balance(owner)).available);
    await lifecycle.maintain(); expect(await store.db.select().from(agentBilling)).toHaveLength(1);
    const [charge] = await store.db.select().from(agentBilling);
    expect(charge?.amount).toBe(final.charged); expect(charge?.agent).toBe(agent.toLowerCase());
    expect(await store.db.select().from(agentBillingProvenance)).toHaveLength(1);
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') });
    rebuild(); await cysts.initialize(); await runtime.initialize(); await lifecycle.initialize();
    expect((await lifecycle.agents.evaluate(owner, agent)).trailing24hBurn).toBe(final.charged);
    expect((await store.db.select().from(agentRuntimeBinding))[0]?.escrow).toBe(local.pins.escrowAddress.toLowerCase());
    await expect(createAgentRuntimeBinding(store.db, { protocol: 'legacy', chainId: 31337,
      escrow: local.pins.escrowAddress, token: local.pins.tokenAddress }).ensureReady()).rejects.toThrow('different reviewed runtime');
    await store.db.update(agentBilling).set({ amount: '1' }).where(eq(agentBilling.receiptId, prepared.quote.runId));
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    await store.db.update(agentBilling).set({ amount: final.charged! }).where(eq(agentBilling.receiptId, prepared.quote.runId));
    vi.mocked(Date.now).mockReturnValue((Number(closed) + 2 * 86_400) * 1000);
    expect((await lifecycle.agents.evaluate(owner, agent)).trailing24hBurn).toBe('0');
    await local.test.revert({ id: beforeSettlement });
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    const state = await lifecycle.agents.get(owner, agent);
    await expect(lifecycle.agents.evaluate(owner, agent, 2)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    const killed = await lifecycle.agents.plan(owner, agent, { action: 'kill', expectedVersion: state.agent.version }, 'kill-after-reorg');
    expect(killed.evaluation).toBeNull(); expect(killed.intent.kind).toBe('kill'); expect(killed.agent.killedAt).not.toBeNull();
  }, 60_000);
  it('never promotes a newer canonical charge over an orphaned billing prefix during import or after restart', async () => {
    await setup();
    const owner = local.accounts.owner.address, agent = owner, leashId = randomId();
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
      abi: local.artifact('PlatformRunEscrow').abi, functionName: 'createLeash', args: [leashId,
        { agent, maxPerHour: 100_000n, maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
          imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
          expiry: BigInt(await bridge.now() + 86_400) }] }));
    const prepare = async (key: string, delay: number) => {
      const prepared = await runtime.quote(owner, { leashId, task: { kind: 'exec', imageDigest: host.imageDigest,
        argv: [process.execPath, '-e', `setTimeout(()=>process.stdout.write('42'),${delay})`] },
        maxSeconds: 120, maxSpend: '20000', deadline: await bridge.now() + 600 }, key);
      const opened = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
        // REASON: The prepared encoder has already validated this transaction's Hex data.
        data: prepared.transaction.data as Hex, value: 0n }));
      await runtime.admit(owner, { runId: prepared.quote.runId, transactionHash: opened.transactionHash }, 'admit-' + key);
      return prepared.quote.runId;
    };
    const firstId = await prepare('prefix-first', 11000), secondId = await prepare('prefix-second', 10);
    await lifecycle.agents.register(owner, { agent, runId: firstId });
    await runtime.drain(); await runtime.drain();
    const first = await runtime.get(owner, firstId), second = await runtime.get(owner, secondId);
    if (!first.settlement || !second.settlement) throw new Error('Expected two real pending CPU outcomes');
    const closed = BigInt((Math.floor(Math.max(first.settlement.endedAt, second.settlement.endedAt) / 3600) + 1) * 3600);
    await local.test.setNextBlockTimestamp({ timestamp: closed }); await local.test.mine({ blocks: 1 });
    vi.spyOn(Date, 'now').mockReturnValue((Number(closed) + 60) * 1000);
    // Publish the shared immutable receipt tree before taking the branch point. Both financial settlements remain optional.
    await receipts.record(owner, first.settlement); await receipts.record(owner, second.settlement);
    await receipts.publishClosed();
    const firstProof = await receipts.proof(owner, firstId), secondProof = await receipts.proof(owner, secondId);
    if (!firstProof || !secondProof) throw new Error('Expected two canonical financial proofs');
    const branchPoint = await local.test.snapshot();
    const settle = async (id: string, settlement: NonNullable<typeof first.settlement>, proof: typeof firstProof) => {
      const receipt = await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress,
        abi: local.artifact('PlatformRunEscrow').abi, functionName: 'settleRun',
        args: [typedPlatformSettlement(settlement), BigInt(proof.hour), proof.proof] }));
      const checked = await bridge.confirmedSettlement(settlement, receipt.transactionHash);
      await store.db.update(platformRuns).set({ status: 'completed', settlementTx: receipt.transactionHash,
        charged: checked.charged, refund: checked.refund }).where(eq(platformRuns.id, id));
      return receipt;
    };
    const firstReceipt = await settle(firstId, first.settlement, firstProof);
    const burn = (await lifecycle.agents.evaluate(owner, agent)).trailing24hBurn;
    expect(BigInt(burn)).toBeGreaterThan(0n);
    const [originalAnchor] = await store.db.select().from(agentBillingAnchors);
    expect(originalAnchor?.blockHash).toBe(firstReceipt.blockHash);
    await settle(secondId, second.settlement, secondProof);
    let changedBranch = false;
    const originalGetBlock = bridge.public.getBlock.bind(bridge.public);
    const getBlock = vi.spyOn(bridge.public, 'getBlock').mockImplementation(async args => {
      const block = await originalGetBlock(args);
      if (!changedBranch && args?.blockNumber === firstReceipt.blockNumber) {
        changedBranch = true;
        // The pre-import prefix check observes A, then A is orphaned before the later B charge is read.
        await local.test.revert({ id: branchPoint });
        await local.test.setNextBlockTimestamp({ timestamp: closed + 30n }); await local.test.mine({ blocks: 1 });
        await settle(secondId, second.settlement!, secondProof);
      }
      return block;
    });
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    getBlock.mockRestore();
    expect(changedBranch).toBe(true);
    expect(await store.db.select().from(agentBilling)).toHaveLength(2);
    expect(await store.db.select().from(agentBillingAnchors)).toEqual([originalAnchor]);
    expect((await store.db.select().from(agentBillingProvenance)
      .where(eq(agentBillingProvenance.receiptId, secondId)))[0]?.validatedAnchorHash).toBeNull();
    expect((await bridge.run(first.settlement.runId)).status).toBe(1);
    expect((await runtime.get(owner, secondId)).status).toBe('completed');
    // A retry and process/database reopen cannot reinterpret B as proof that the earlier orphan A was canonical.
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') });
    rebuild(); await cysts.initialize(); await runtime.initialize(); await lifecycle.initialize();
    await expect(lifecycle.agents.evaluate(owner, agent)).rejects.toMatchObject({ code: 'agent_billing_unconfirmed' });
    const state = await lifecycle.agents.get(owner, agent);
    const killed = await lifecycle.agents.plan(owner, agent, { action: 'kill', expectedVersion: state.agent.version }, 'kill-orphan-prefix');
    expect(killed.evaluation).toBeNull(); expect(killed.agent.killedAt).not.toBeNull();
  }, 75_000);
  it('does not reinterpret unmarked existing lifecycle records as paid-platform agents', async () => {
    await setup();
    await store.db.delete(agentRuntimeBinding);
    const plain = new AgentLifecycleService(store.db, { cysts, balance: async () => '0',
      reservedRun: async () => { throw new Error('No reservation fixture'); } });
    await plain.register(local.accounts.owner.address, { agent: local.accounts.owner.address });
    await expect(createAgentRuntimeBinding(store.db, { protocol: 'platform', chainId: 31337,
      escrow: local.pins.escrowAddress, token: local.pins.tokenAddress }).ensureReady()).rejects.toThrow('original legacy');
  }, 30_000);
});
