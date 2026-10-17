import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { randomId } from '../src/common.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostSchema, typedPlatformQuote } from '../src/platform-runtime/types.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { platformReceiptEntries } from '../src/receipts/platform-schema.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { spendPermissionExtraData, spendPermissionLeashTermsHash, spendPermissionOpenCall, type SpendPermission } from '../src/payments/spend-permissions.js';
import { openStore } from '../src/store.js';
import { compileSpendPermissionFixtures, deploySpendPermissionRuntime } from './fixtures/platform-spend-permission.js';

let artifacts: ReturnType<typeof compileSpendPermissionFixtures>;
beforeAll(() => { artifacts = compileSpendPermissionFixtures(); }, 120_000);
class Cpu extends LocalProcessFixtureRuntime {
  starts = 0;
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++;
    return super.start({ ...lease, argv: [process.execPath, '-e', "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({sha256:require('node:crypto').createHash('sha256').update(JSON.parse(s).text).digest('hex')})),12000));"] }, heartbeat);
  }
}
it('holds a real domain3 Manager-paid CPU outcome after reorg instead of accepting the same quote opened from a prepaid balance', async () => {
  const journal = await openHostJournal(':memory:'), control = new Ed25519Identity(), cpu = new Cpu(), imageDigest = 'sha256:' + 'b'.repeat(64), image = 'fixture/funded-reorg@' + imageDigest,
    agent = new HostKitAgent(journal, cpu, control.publicKey, new Set([image]));
  await agent.initialize(); const hostApp = createHostKitRoutes(agent), server = createServer(getRequestListener(hostApp.fetch));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host fixture address absent');
  const f = await deploySpendPermissionRuntime(journal.identity.publicKey as Hex, artifacts), store = await openStore({ DATA_DIR: ':memory:' });
  try {
    const block = await f.local.publicClient.getBlock(), leashId = randomId(), zero = `0x${'0'.repeat(64)}` as Hex,
      terms = { agent: f.accounts.owner.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false, imageAllowRoot: zero, regionAllowRoot: zero, expiry: block.timestamp + 86_400n };
    await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'createLeash', args: [leashId, terms] }));
    const permission: SpendPermission = { account: f.fundingAccount, spender: f.pins.escrowAddress, token: f.pins.tokenAddress, allowance: '10000', period: 600,
      start: Number(block.timestamp) - 10, end: Number(block.timestamp) + 3600, salt: BigInt(randomId()).toString(),
      extraData: spendPermissionExtraData(31337, f.pins.escrowAddress, f.fundingAccount, f.accounts.owner.address, leashId, spendPermissionLeashTermsHash(terms)) };
    await f.permissionAction('approve', permission);
    const bridge = new PlatformBridge(store.db, { pins: f.pins, rpcUrl: f.local.rpcUrl, signerPrivateKey: f.keys.signer }), host = platformHostSchema.parse({ hostId: f.hostId, hostKey: journal.identity.publicKey,
      hardwareClass: 'cpu', region: 'funded-reorg', image, imageDigest, sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    const hostClient = new HostKitClient('http://127.0.0.1:' + address.port, journal.identity.publicKey, control, true);
    let service: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: f.pins.escrowAddress, receiptRootAddress: f.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    service = new PlatformRuntimeService(store.db, bridge, [host], new PlatformHostExecutor(store.db, new Map([[f.hostId, hostClient]])), receipts); await service.initialize();
    const prepared = await service.quote(f.accounts.owner.address, { leashId, task: { kind: 'sha256', text: 'original-spend-permission' }, maxSeconds: 25, deadline: await bridge.now() + 300,
      maxSpend: '10000', regions: ['funded-reorg'], funding: { kind: 'base_spend_permission_v1', permission } }, 'original-manager-run'), snapshot = await f.test.snapshot();
    const original = await f.confirmed(f.owner.sendTransaction({ to: f.pins.escrowAddress,
      data: spendPermissionOpenCall(prepared.quote, prepared.signature, [], [], permission) }));
    await service.admit(f.accounts.owner.address, { runId: prepared.quote.runId, transactionHash: original.transactionHash }, 'admit'); await service.drain();
    expect(cpu.starts).toBe(1); expect((await service.get(f.accounts.owner.address, prepared.quote.runId)).status).toBe('receipt_pending');
    await f.test.revert({ id: snapshot });
    await f.confirmed(f.owner.writeContract({ address: f.pins.tokenAddress, abi: f.artifact('MockToken').abi, functionName: 'faucet', args: [f.accounts.owner.address, 10_000n] }));
    await f.confirmed(f.owner.writeContract({ address: f.pins.tokenAddress, abi: f.artifact('MockToken').abi, functionName: 'approve', args: [f.pins.escrowAddress, 10_000n] }));
    await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'deposit', args: [10_000n] }));
    const replacement = await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'openRun',
      args: [typedPlatformQuote(prepared.quote), prepared.signature, [], []] }));
    await expect(bridge.verifyOriginalOpening(prepared.quote, prepared.ceiling, replacement.transactionHash, prepared.input.funding)).rejects.toThrow('funding method');
    expect((await service.get(f.accounts.owner.address, prepared.quote.runId)).status).toBe('reconciliation');
    const closed = ((await f.local.publicClient.getBlock()).timestamp / 3600n + 1n) * 3600n + 2n;
    await f.test.setNextBlockTimestamp({ timestamp: closed }); await f.test.mine({ blocks: 1 }); await service.drain();
    const held = await service.get(f.accounts.owner.address, prepared.quote.runId); expect(held.charged).toBeNull(); expect(held.refund).toBeNull(); expect(cpu.starts).toBe(1);
    expect((await store.db.select().from(platformReceiptEntries).where(eq(platformReceiptEntries.runId, prepared.quote.runId)))).toHaveLength(0);
    expect((await store.db.select().from(platformRuns))).toHaveLength(1);
  } finally { await agent.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.close(); await f.close(); await journal.close(); }
}, 120_000);
