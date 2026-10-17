import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { RunMeter } from '../src/runtime/meter.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { platformHostLeases, platformRuns, platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { platformEscrowAbi, platformHostSchema, typedPlatformSettlement, type PlatformPrepared } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { nearReadinessSnapshot } from '../src/providers/readiness.js';
import { AmbiguousProviderError, type NearCompletionInput, type NearCompletionResult, type NearProvider } from '../src/providers/near.js';
import { platformNearRequestHash } from '../src/platform-runtime/types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

/** Real subprocess fixture only. gVisor isolation has its separate Linux acceptance. */
class TaskFixture extends LocalProcessFixtureRuntime {
  starts = 0;
  delay = 0;
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++;
    const program = `const {createHash}=require('node:crypto');let data='';process.stdin.on('data',b=>data+=b);process.stdin.on('end',()=>setTimeout(()=>{const task=JSON.parse(data);process.stdout.write(JSON.stringify({sha256:createHash('sha256').update(task.text).digest('hex')}));},${this.delay}));`;
    return super.start({ ...lease, argv: [process.execPath, '-e', program] }, heartbeat);
  }
}
describe('full platform controller CPU admission, full financial proof and fee settlement', () => {
  let artifacts: Record<string, ContractArtifact>, local: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let store: Awaited<ReturnType<typeof openStore>>, journal: HostJournal, agent: HostKitAgent, server: Server;
  let root: string, runtime: TaskFixture, bridge: PlatformBridge, service: PlatformRuntimeService, executor: PlatformHostExecutor, receipts: PlatformReceiptService;
  let host: ReturnType<typeof platformHostSchema.parse>, client: HostKitClient, leashId: Hex;
  beforeAll(() => { artifacts = compileContracts(['PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telomere-full-platform-'));
    journal = await openHostJournal(':memory:'); const control = new Ed25519Identity(); runtime = new TaskFixture();
    agent = new HostKitAgent(journal, runtime, control.publicKey, new Set([`fixture/node@sha256:${'1'.repeat(64)}`])); await agent.initialize();
    server = createServer(getRequestListener(createHostKitRoutes(agent).fetch));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host fixture has no address');
    client = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true);
    local = await deployPlatformRuntime(journal.identity.publicKey as Hex, artifacts);
    store = await openStore({ DATA_DIR: join(root, 'db') });
    host = platformHostSchema.parse({ hostId: local.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu', region: 'local-test',
      image: `fixture/node@sha256:${'1'.repeat(64)}`, imageDigest: `sha256:${'1'.repeat(64)}`, sealed: false, lane: 'standard',
      pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    rebuild(); await service.initialize(); leashId = randomId();
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformRunEscrow').abi,
      functionName: 'createLeash', args: [leashId, { agent: local.accounts.owner.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
        classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
        expiry: BigInt(await bridge.now() + 86_400) }] }));
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await agent?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await journal?.close(); await store?.close(); await local?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  function rebuild() {
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
      receiptRootAddress: local.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    executor = new PlatformHostExecutor(store.db, new Map([[host.hostId, client]]));
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts);
  }
  async function prepare(idemKey = 'full-platform') {
    return service.quote(local.accounts.owner.address, { leashId, task: { kind: 'sha256', text: 'full-financial-proof' },
      maxSeconds: 25, deadline: await bridge.now() + 300, maxSpend: '10000' }, idemKey);
  }
  async function open(prepared: PlatformPrepared) {
    const tx = prepared.transaction;
    const receipt = await local.confirmed(local.owner.sendTransaction({ to: tx.to, data: tx.data as Hex, value: 0n }));
    await service.admit(local.accounts.owner.address, { runId: prepared.quote.runId, transactionHash: receipt.transactionHash }, 'admit-full-platform');
    return receipt;
  }
  async function closeHour(runId: Hex) {
    const [row] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, runId));
    if (!row?.settlement) throw new Error('No durable financial outcome');
    const next = BigInt((Math.floor(row.settlement.endedAt / 3600) + 1) * 3600);
    if (BigInt(await bridge.now()) < next) { await local.test.setNextBlockTimestamp({ timestamp: next }); await local.test.mine({ blocks: 1 }); }
  }
  async function nearFixture(complete?: (input: NearCompletionInput) => Promise<NearCompletionResult>,
    billingOperator = local.accounts.host.address) {
    const config = { model: 'test-model', maxTokens: 32, policySha256: randomId(), inferencePrice: '1000' };
    const signer = privateKeyToAccount(local.keys.signer);
    const request = () => ({ leashId, task: { kind: 'sha256' as const, text: 'near-bridge-input' },
      near: { model: config.model, maxTokens: config.maxTokens, policySha256: config.policySha256, prompt: 'reviewed NEAR prompt' },
      maxSeconds: 60, deadline: 0, maxSpend: '10000' });
    const signed = async (input: NearCompletionInput, hashRunId = input.runId, receivedAt = new Date().toISOString()) => {
      const output = 'attested NEAR output', requestHash = platformNearRequestHash(hashRunId,
        { ...request().near, prompt: input.prompt, maxTokens: input.maxTokens });
      const responseHash = `0x${createHash('sha256').update('signed response').digest('hex')}`;
      const signatureText = `${config.model}:${requestHash.slice(2)}:${responseHash.slice(2)}`;
      const verifiedAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
      return { output, model: config.model, requestId: 'signed-platform-output', evidence: {
        verification: 'enclave_verified' as const, endpoint: 'https://cloud-api.near.ai/v1/chat/completions',
        receivedAt, requestHash, responseHash, attestationRef: randomId(), policySha256: config.policySha256,
        providerEvidenceHash: randomId(), verifiedAt, expiresAt,
        outputHash: `0x${createHash('sha256').update(output).digest('hex')}`,
        signingAddress: signer.address, signatureText,
        signature: await signer.signMessage({ message: signatureText }) } };
    };
    let available = true;
    const provider: NearProvider = { readiness: async () => nearReadinessSnapshot(available ? 'ready' : 'unavailable',
      available ? 'CONFIGURATION_READY' : 'POLICY_EXPIRED', 'enclave_verified',
      new Date(Math.max(Date.now(), (await bridge.now()) * 1000) + 600_000).toISOString()),
      complete: vi.fn(async input => complete ? complete(input) : signed(input)) };
    const enable = async () => { service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, undefined,
      { provider, config, billingOperator, maxProviderSeconds: 30 }); await service.initialize(); };
    await enable();
    const quote = async (key: string) => service.quote(local.accounts.owner.address,
      { ...request(), deadline: await bridge.now() + 300 }, key);
    const quoteInference = async (key: string) => service.quote(local.accounts.owner.address,
      { ...request(), task: { kind: 'near_inference' as const }, deadline: await bridge.now() + 300 }, key);
    return { config, provider, signed, quote, quoteInference, enable, setAvailable: (value: boolean) => { available = value; } };
  }
  it('runs a standalone inference-only request without CPU admission and charges only its verified fixed price', async () => {
    const near = await nearFixture();
    const probe = vi.spyOn(executor, 'capacityAvailable').mockResolvedValue(false);
    const hostRun = vi.spyOn(executor, 'run');
    const prepared = await near.quoteInference('inference-only-success');
    expect(prepared.input.task).toEqual({ kind: 'near_inference' });
    expect(service.publicConfig()).toMatchObject({ nearInferenceTask: 'near_inference' });
    expect(probe).not.toHaveBeenCalled();
    await open(prepared); await service.drain();
    const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(pending).toMatchObject({ status: 'receipt_pending', executionKind: 'near_inference',
      result: { output: '', status: 'completed', billableSeconds: 0 },
      settlement: { billableSeconds: 0, inferenceCharge: '1000' },
      nearResult: { output: 'attested NEAR output' } });
    expect(runtime.starts).toBe(0); expect(hostRun).not.toHaveBeenCalled();
    expect(await store.db.select().from(platformHostLeases)).toHaveLength(0);
    expect(near.provider.complete).toHaveBeenCalledTimes(1);
    await closeHour(prepared.quote.runId); await service.drain();
    const final = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(final).toMatchObject({ status: 'completed', executionKind: 'near_inference', charged: '1090' });
    expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(BigInt(prepared.ceiling));
  }, 30000);
  it('settles an uncertain standalone inference request at zero and never retries its paid POST', async () => {
    const near = await nearFixture(async input => { throw new AmbiguousProviderError(input.runId, 'transport'); });
    const prepared = await near.quoteInference('inference-only-ambiguous');
    await open(prepared); await service.drain();
    const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(pending).toMatchObject({ status: 'receipt_pending', executionKind: 'near_inference',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN', nearResult: null,
      result: { status: 'cancelled', billableSeconds: 0 },
      settlement: { billableSeconds: 0, inferenceCharge: '0' } });
    expect(runtime.starts).toBe(0); expect(await store.db.select().from(platformHostLeases)).toHaveLength(0);
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await near.enable();
    expect(near.provider.complete).toHaveBeenCalledTimes(1);
    await closeHour(prepared.quote.runId); await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({
      status: 'completed', charged: '0', refund: prepared.ceiling });
  }, 30000);
  it('recovers an unconfirmed inference-only controller intent without contacting a CPU host or NEAR', async () => {
    const near = await nearFixture();
    const prepared = await near.quoteInference('inference-only-recovery');
    await open(prepared);
    await store.db.update(platformRuns).set({ status: 'running' }).where(eq(platformRuns.id, prepared.quote.runId));
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild();
    const recover = vi.spyOn(executor, 'recover'); await near.enable();
    expect(recover).not.toHaveBeenCalled(); expect(runtime.starts).toBe(0);
    expect(near.provider.complete).not.toHaveBeenCalled();
    const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(pending).toMatchObject({ executionKind: 'near_inference', status: 'receipt_pending',
      settlement: { billableSeconds: 0, inferenceCharge: '0' } });
    await closeHour(prepared.quote.runId); await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({
      status: 'completed', charged: '0', refund: prepared.ceiling });
  }, 30000);
  it('does not quote an inference-only task without a bounded reviewed NEAR request', async () => {
    await expect(service.quote(local.accounts.owner.address, { leashId, task: { kind: 'near_inference' },
      maxSeconds: 60, deadline: await bridge.now() + 300, maxSpend: '10000' }, 'inference-missing-near'))
      .rejects.toMatchObject({ name: 'ZodError' });
  });
  it('returns a typed unavailable response when platform NEAR has not been configured', async () => {
    await expect(service.quote(local.accounts.owner.address, { leashId,
      task: { kind: 'sha256', text: 'provider missing' }, maxSeconds: 60,
      deadline: await bridge.now() + 300, maxSpend: '10000',
      near: { model: 'test-model', maxTokens: 32, policySha256: randomId(), prompt: 'a reviewed prompt' } },
    'near-unconfigured')).rejects.toMatchObject({ code: 'platform_near_unavailable' });
  });
  it('replays a prepared NEAR quote after readiness expires without a second quote or provider call', async () => {
    const near = await nearFixture();
    const prepared = await near.quote('near-replay'); expect(prepared.quote.inferencePrice).toBe('1000');
    near.setAvailable(false);
    expect(await near.quote('near-replay')).toEqual(prepared);
    await expect(near.quote('near-new')).rejects.toMatchObject({ code: 'platform_near_unavailable' });
    expect(near.provider.complete).not.toHaveBeenCalled();
  });
  it('rejects NEAR quotes whose actual host payout operator does not bear the provider bill', async () => {
    const near = await nearFixture(undefined, local.accounts.signer.address);
    await expect(near.quote('near-unpaid-host')).rejects.toMatchObject({ code: 'platform_near_operator_mismatch' });
    expect(near.provider.complete).not.toHaveBeenCalled();
  });
  it('rechecks the host payout operator before a paid NEAR POST', async () => {
    const near = await nearFixture(), prepared = await near.quote('near-operator-drift');
    await open(prepared);
    const original = bridge.host.bind(bridge);
    vi.spyOn(bridge, 'host').mockImplementation(async id => ({ ...(await original(id)), operator: local.accounts.signer.address }));
    await service.drain();
    const run = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(run.settlement?.inferenceCharge).toBe('0'); expect(run.nearResult).toBeNull();
    expect(run.errorCode).toBe('platform_near_not_dispatched'); expect(near.provider.complete).not.toHaveBeenCalled();
  }, 30000);
  it('charges the exact fixed NEAR inference price only for signed original request evidence', async () => {
    const near = await nearFixture(); const prepared = await near.quote('near-success');
    await open(prepared); await service.drain();
    const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(pending.status).toBe('receipt_pending'); expect(pending.settlement?.inferenceCharge).toBe('1000');
    expect(pending.nearResult?.output).toBe('attested NEAR output'); expect(near.provider.complete).toHaveBeenCalledTimes(1);
    await closeHour(prepared.quote.runId); await service.drain();
    const final = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(final.status).toBe('completed');
    const base = BigInt(final.settlement!.billableSeconds) * 100n + 1000n;
    expect(final.charged).toBe((base + (base * 900n + 9999n) / 10000n).toString());
    await store.db.update(platformRuns).set({ nearResult: await near.signed({ prompt: 'reviewed NEAR prompt', maxTokens: 32,
      runId: prepared.quote.runId }, randomId()) }).where(eq(platformRuns.id, prepared.quote.runId));
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({
      status: 'reconciliation', errorCode: 'platform_finality_uncertain', nearResult: null });
  }, 30000);
  it('never repeats a paid ambiguous POST, settles CPU at zero inference charge, and frees the receipt hour', async () => {
    // Hold the disposable chain clock still while the real subprocess advances its terminal observation.
    await local.test.setBlockTimestampInterval({ interval: 0 }); runtime.delay = 1500;
    const near = await nearFixture(async input => { throw new AmbiguousProviderError(input.runId, 'transport'); });
    const prepared = await near.quote('near-ambiguous'); await open(prepared); await service.drain();
    const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(pending).toMatchObject({ status: 'receipt_pending', errorCode: 'PROVIDER_OUTCOME_UNKNOWN', nearResult: null });
    expect(pending.settlement?.inferenceCharge).toBe('0'); expect(near.provider.complete).toHaveBeenCalledTimes(1);
    const original = pending.settlement!, hour = Math.floor(original.endedAt / 3600);
    expect(original.endedAt).toBeGreaterThan(await bridge.now());
    expect(await service.canSeal(hour)).toBe(false);
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await near.enable();
    expect(await service.canSeal(hour)).toBe(false);
    // Preserve the original terminal time; recording waits for a canonical block at or after it.
    if (await bridge.now() < original.endedAt) {
      await local.test.setNextBlockTimestamp({ timestamp: BigInt(original.endedAt) }); await local.test.mine({ blocks: 1 });
    }
    await service.drain();
    expect((await service.get(local.accounts.owner.address, prepared.quote.runId)).settlement).toEqual(original);
    expect(await receipts.hasRecorded(local.accounts.owner.address, original)).toBe(true);
    expect(near.provider.complete).toHaveBeenCalledTimes(1);
    await closeHour(prepared.quote.runId);
    expect(await service.canSeal(hour)).toBe(true);
    await service.drain(); expect((await service.get(local.accounts.owner.address, prepared.quote.runId)).status).toBe('completed');
  }, 30000);
  it('recovers a crash after durable NEAR dispatch intent without another POST or blocked receipt hour', async () => {
    const near = await nearFixture(), prepared = await near.quote('near-crash-intent');
    const paid = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
      data: prepared.transaction.data as Hex, value: 0n }));
    const meter = new RunMeter(prepared.quote.runId, prepared.quote.maxSeconds);
    await meter.emit('cancelled', 0, ''); await meter.flush();
    await store.db.update(platformRuns).set({ status: 'near_dispatching', admissionTx: paid.transactionHash,
      result: { output: '', status: 'cancelled', exitCode: -1, billableSeconds: 0, ticks: meter.ticks } })
      .where(eq(platformRuns.id, prepared.quote.runId));
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await near.enable();
    const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(pending).toMatchObject({ status: 'receipt_pending', errorCode: 'PROVIDER_OUTCOME_UNKNOWN', nearResult: null });
    expect(pending.settlement?.inferenceCharge).toBe('0'); expect(near.provider.complete).not.toHaveBeenCalled();
    await service.drain(); await closeHour(prepared.quote.runId);
    expect(await service.canSeal(Math.floor(pending.settlement!.endedAt / 3600))).toBe(true);
    await service.drain(); expect((await service.get(local.accounts.owner.address, prepared.quote.runId)).status).toBe('completed');
  }, 30000);
  it('rejects a valid signature from another run without a paid retry', async () => {
    let fake: Awaited<ReturnType<typeof nearFixture>> | undefined;
    fake = await nearFixture(async input => fake!.signed(input, randomId()));
    const wrong = await fake.quote('near-wrong-run'); await open(wrong); await service.drain();
    const result = await service.get(local.accounts.owner.address, wrong.quote.runId);
    expect(result.settlement?.inferenceCharge).toBe('0'); expect(result.nearResult).toBeNull();
    expect(result.errorCode).toBe('PROVIDER_OUTCOME_UNKNOWN');
  }, 30000);
  it('does not expose an inference result received after the billable cutoff', async () => {
    let late: Awaited<ReturnType<typeof nearFixture>> | undefined;
    late = await nearFixture(async input => late!.signed(input, input.runId, new Date(Date.now() + 120_000).toISOString()));
    const prepared = await late.quote('near-late'); await open(prepared); await service.drain();
    const lateRun = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(lateRun.settlement?.inferenceCharge).toBe('0'); expect(lateRun.nearResult).toBeNull();
  }, 30000);
  it('requires a fresh host capacity answer for new quotes but returns an existing idempotent quote', async () => {
    const original = await prepare('capacity-original');
    const signed = vi.spyOn(bridge, 'signQuote');
    const probe = vi.spyOn(executor, 'capacityAvailable').mockResolvedValue(false);
    await expect(prepare('capacity-new')).rejects.toMatchObject({ code: 'platform_host_unavailable' });
    probe.mockRejectedValueOnce(new Error('Host transport unavailable'));
    await expect(prepare('capacity-transport')).rejects.toMatchObject({ code: 'platform_host_unavailable' });
    expect(signed).not.toHaveBeenCalled();
    expect(await prepare('capacity-original')).toEqual(original);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await store.db.select().from(platformRuns)).toHaveLength(1);
  });
  it.each([
    ['MAX_RUN_CEILING', 250_000_001n],
    ['MAX_LEASH_DAY', 1_000_000_001n],
    ['MAX_TOTAL_ESCROW', 500_000_000_001n],
  ] as const)('refuses a deployed platform escrow with a changed %s', async (name, wrong) => {
    const actual = bridge.public.readContract.bind(bridge.public);
    vi.spyOn(bridge.public, 'readContract').mockImplementation(async request => {
      if (request.functionName === name) return wrong as never;
      return actual(request as never) as never;
    });
    await expect(bridge.check()).rejects.toThrow('Platform escrow limits differ from reviewed policy');
  });
  it('executes one actual child, publishes its full leaf, charges the fee, refunds the ceiling and survives database reopen', async () => {
    runtime.delay = 11000;
    const prepared = await prepare(); expect(prepared.ceiling).toBe('2725'); await open(prepared);
    await service.drain(); const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(pending.status).toBe('receipt_pending'); expect(pending.settlement?.billableSeconds).toBeGreaterThanOrEqual(3);
    expect(pending.result?.output).toBe(JSON.stringify({ sha256: createHash('sha256').update('full-financial-proof').digest('hex') }));
    await closeHour(prepared.quote.runId); await service.drain();
    const completed = await service.get(local.accounts.owner.address, prepared.quote.runId);
    expect(completed.status).toBe('completed');
    const base = BigInt(completed.settlement!.billableSeconds) * 100n, fee = (base * 900n + 9999n) / 10000n;
    expect(completed.charged).toBe((base + fee).toString());
    expect(BigInt(completed.charged!) + BigInt(completed.refund!)).toBe(2725n);
    expect((await service.balance(local.accounts.owner.address)).available).toBe((1_000_000n - base - fee).toString());
    expect((await bridge.run(prepared.quote.runId)).hostReleased).toBe(true); expect((await bridge.host(host.hostId)).openRuns).toBe(0n);
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(2); expect(runtime.starts).toBe(1);
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await service.initialize(); await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toEqual(completed); expect(runtime.starts).toBe(1);
  }, 30000);
  it('never dispatches a stopped reservation and returns its complete fee-inclusive ceiling', async () => {
    const prepared = await prepare(); await open(prepared);
    await local.confirmed(local.owner.sendTransaction({ ...(await service.stopPlan(local.accounts.owner.address, prepared.quote.runId)), value: 0n }));
    await service.drain(); await closeHour(prepared.quote.runId); await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({ status: 'completed', charged: '0', refund: '2725' });
    expect(runtime.starts).toBe(0); expect((await service.balance(local.accounts.owner.address)).available).toBe('1000000');
  });
  it('recovers a direct payer refund after the open transaction loses its HTTP admission', async () => {
    const prepared = await prepare('lost-direct-admission');
    const paid = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to,
      data: prepared.transaction.data as Hex, value: 0n }));
    expect(paid.status).toBe('success');
    await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({ status: 'prepared', admissionTx: null });
    expect((await bridge.run(prepared.quote.runId)).status).toBe(1);
    expect(runtime.starts).toBe(0);

    await store.db.update(platformRuns).set({ errorCode: 'platform_prepared_refund_uncertain' })
      .where(eq(platformRuns.id, prepared.quote.runId));

    const refundAt = await bridge.public.readContract({ address: local.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'refundAt', args: [prepared.quote.runId] });
    await local.test.setNextBlockTimestamp({ timestamp: refundAt }); await local.test.mine({ blocks: 1 });
    await local.confirmed(local.owner.sendTransaction({ ...(await service.refundPlan(local.accounts.owner.address, prepared.quote.runId)), value: 0n }));
    await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({ status: 'refunded',
      admissionTx: null, charged: '0', refund: prepared.ceiling, errorCode: null });
    expect((await bridge.run(prepared.quote.runId)).hostReleased).toBe(true);
    expect((await service.balance(local.accounts.owner.address)).available).toBe('1000000');
    expect(runtime.starts).toBe(0);

    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await service.initialize(); await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({ status: 'refunded',
      admissionTx: null, charged: '0', refund: prepared.ceiling });
    expect(runtime.starts).toBe(0);
  });
  it('rejects substituted admission receipts, tenant access and fee-exclusive spending limits', async () => {
    const prepared = await prepare();
    await expect(service.get(local.accounts.outsider.address, prepared.quote.runId)).rejects.toMatchObject({ status: 404 });
    const unrelated = await local.confirmed(local.owner.sendTransaction({ to: local.accounts.outsider.address, value: 0n }));
    await expect(service.admit(local.accounts.owner.address, { runId: prepared.quote.runId, transactionHash: unrelated.transactionHash }, 'bad-admit')).rejects.toThrow();
    await expect(service.quote(local.accounts.owner.address, { ...prepared.input, maxSpend: '2500' }, 'exclusive-budget')).rejects.toMatchObject({ code: 'platform_budget_exceeded' });
    expect(runtime.starts).toBe(0); expect((await bridge.balance(local.accounts.owner.address)).available).toBe('1000000');
  });
  it.each([false, true])('uses actual log order for same-block Leash changes (change before opening: %s)', async changeBefore => {
    const prepared = await prepare('same-block-agent-' + changeBefore);
    const update = (agentAddress: Hex, nonce: number) => local.owner.writeContract({ address: local.pins.escrowAddress,
      abi: local.artifact('PlatformRunEscrow').abi, functionName: 'updateLeash', nonce, gas: 1_000_000n,
      args: [leashId, { agent: agentAddress, maxPerHour: 100_000n, maxPerDay: 1_000_000n, classMask: 1n,
        sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400) }] });
    let nonce = await bridge.public.getTransactionCount({ address: local.accounts.owner.address, blockTag: 'pending' });
    await local.test.setAutomine(false);
    try {
      const transactions: Hex[] = [];
      if (changeBefore) transactions.push(await update(local.accounts.outsider.address, nonce++));
      const admission = await local.owner.sendTransaction({ to: prepared.transaction.to,
        data: prepared.transaction.data as Hex, nonce: nonce++, gas: 2_000_000n, value: 0n });
      transactions.push(admission);
      transactions.push(await update(changeBefore ? local.accounts.owner.address : local.accounts.outsider.address, nonce++));
      await local.test.mine({ blocks: 1 });
      for (const transaction of transactions) await local.confirmed(Promise.resolve(transaction));
      const receipt = await bridge.public.getTransactionReceipt({ hash: admission });
      const last = await bridge.public.getTransactionReceipt({ hash: transactions.at(-1)! });
      expect(last.blockHash).toBe(receipt.blockHash);
      expect((await bridge.openingLeash(prepared.quote, admission)).agent).toBe(changeBefore ? local.accounts.outsider.address : local.accounts.owner.address);
      expect((await bridge.leash(leashId)).agent).toBe(changeBefore ? local.accounts.owner.address : local.accounts.outsider.address);
      await local.test.setAutomine(true);
      if (changeBefore) {
        await expect(service.admit(local.accounts.owner.address, { runId: prepared.quote.runId, transactionHash: admission }, 'wrong-original-agent'))
          .rejects.toMatchObject({ code: 'platform_agent_changed' });
      } else {
        await local.confirmed(update(local.accounts.owner.address, nonce++));
        expect(await service.admit(local.accounts.owner.address, { runId: prepared.quote.runId, transactionHash: admission }, 'right-original-agent'))
          .toMatchObject({ status: 'queued' });
      }
      expect(runtime.starts).toBe(0);
    } finally { await local.test.setAutomine(true); }
  });
  it('chooses an exact 250 USDC host and excludes over-cap, overflowing and zero-base alternatives', async () => {
    const tokenAbi = local.artifact('MockToken').abi, registryAbi = local.artifact('HostRegistry').abi;
    const escrowAbi = local.artifact('PlatformRunEscrow').abi, expensiveKey = new Ed25519Identity().publicKey as Hex;
    const outsider = local.accounts.outsider;
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress, abi: tokenAbi,
      functionName: 'faucet', args: [outsider.address, 300_000_000n] }));
    await local.confirmed(local.owner.writeContract({ account: outsider, address: local.pins.tokenAddress,
      abi: tokenAbi, functionName: 'approve', args: [local.pins.hostRegistryAddress, 300_000_000n] }));
    await local.confirmed(local.owner.writeContract({ account: outsider, address: local.pins.hostRegistryAddress,
      abi: registryAbi, functionName: 'register', args: [expensiveKey, 0, `0x${'0'.repeat(64)}`, 300_000_000n, false] }));
    const expensiveId = await bridge.public.readContract({ address: local.pins.hostRegistryAddress,
      abi: registryAbi, functionName: 'operatorHost', args: [outsider.address] }) as Hex;
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress, abi: tokenAbi,
      functionName: 'faucet', args: [local.accounts.owner.address, 300_000_000n] }));
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress, abi: tokenAbi,
      functionName: 'approve', args: [local.pins.escrowAddress, 300_000_000n] }));
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: escrowAbi,
      functionName: 'deposit', args: [300_000_000n] }));
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: escrowAbi,
      functionName: 'updateLeash', args: [leashId, { agent: local.accounts.owner.address,
        maxPerHour: 300_000_000n, maxPerDay: 300_000_000n, classMask: 1n, sealedOnly: false,
        imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`,
        expiry: BigInt(await bridge.now() + 86_400) }] }));
    host = platformHostSchema.parse({ ...host, pricePerSecond: '229357798', reliabilityBps: 5000 });
    const expensive = platformHostSchema.parse({ ...host, hostId: expensiveId, hostKey: expensiveKey,
      pricePerSecond: '229357799', reliabilityBps: 10000 });
    service = new PlatformRuntimeService(store.db, bridge, [host, expensive], executor, receipts);
    await service.initialize();
    const input = { leashId, task: { kind: 'sha256' as const, text: 'capped-placement' }, maxSeconds: 1,
      deadline: await bridge.now() + 300, maxSpend: '300000000' };
    const selected = await service.quote(local.accounts.owner.address, input, 'cap-two-hosts');
    expect(selected.quote.hostId).toBe(host.hostId);
    expect(selected.ceiling).toBe('250000000');
    service = new PlatformRuntimeService(store.db, bridge, [expensive], executor, receipts);
    await service.initialize();
    await expect(service.quote(local.accounts.owner.address, input, 'cap-only-expensive'))
      .rejects.toMatchObject({ code: 'platform_budget_exceeded' });
    const affordable = platformHostSchema.parse({ ...host, pricePerSecond: '100' });
    const backup = platformHostSchema.parse({ ...expensive, pricePerSecond: '101' });
    const live = vi.spyOn(executor, 'capacityAvailable').mockImplementation(async candidate => candidate.hostId === backup.hostId);
    service = new PlatformRuntimeService(store.db, bridge, [affordable, backup], executor, receipts);
    await service.initialize();
    expect((await service.quote(local.accounts.owner.address, { ...input, maxSeconds: 120 }, 'cap-live-backup')).quote.hostId)
      .toBe(backup.hostId);
    live.mockRestore();
    const huge = platformHostSchema.parse({ ...expensive, pricePerSecond: (10n ** 28n - 1n).toString() });
    const free = platformHostSchema.parse({ ...expensive, pricePerSecond: '0' });
    const longer = { ...input, maxSeconds: 120 };
    service = new PlatformRuntimeService(store.db, bridge, [affordable, huge], executor, receipts);
    await service.initialize();
    expect((await service.quote(local.accounts.owner.address, longer, 'cap-overflow-host')).quote.hostId).toBe(host.hostId);
    service = new PlatformRuntimeService(store.db, bridge, [affordable, free], executor, receipts);
    await service.initialize();
    expect((await service.quote(local.accounts.owner.address, longer, 'cap-zero-host')).quote.hostId).toBe(host.hostId);
    for (const [candidate, key] of [[huge, 'cap-only-overflow'], [free, 'cap-only-zero']] as const) {
      service = new PlatformRuntimeService(store.db, bridge, [candidate], executor, receipts);
      await service.initialize();
      await expect(service.quote(local.accounts.owner.address, longer, key))
        .rejects.toMatchObject({ code: 'platform_budget_exceeded' });
    }
    expect(await store.db.select().from(platformRuns)).toHaveLength(4);
  });
  it('recovers the original completed lease after a crash without running CPU twice', async () => {
    const prepared = await prepare(); await open(prepared);
    const original = executor.run.bind(executor);
    vi.spyOn(executor, 'run').mockImplementationOnce(async (...args) => {
      await original(...args); throw new Error('Simulated interruption after original host cleanup, before controller outcome persistence');
    });
    await expect(service.drain()).rejects.toThrow('original-lease recovery'); expect(runtime.starts).toBe(1);
    expect((await service.get(local.accounts.owner.address, prepared.quote.runId)).settlement).toBeNull();
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await service.initialize();
    await closeHour(prepared.quote.runId); await service.drain();
    expect((await service.get(local.accounts.owner.address, prepared.quote.runId)).status).toBe('completed'); expect(runtime.starts).toBe(1);
    expect((await store.db.select().from(platformHostLeases))[0]?.cleanupConfirmed).toBe(1);
  });
  it('rejects an altered signed transaction journal before it can broadcast', async () => {
    const key = 'integrity-approval', data = encodeFunctionData({ abi: local.artifact('MockToken').abi, functionName: 'approve', args: [local.accounts.outsider.address, 1n] });
    await bridge.transactions.submit(key, local.pins.tokenAddress, data);
    const [row] = await store.db.select().from(platformTransactionJournal).where(eq(platformTransactionJournal.key, key)); expect(row).toBeDefined();
    const nonce = await bridge.public.getTransactionCount({ address: bridge.account.address });
    await store.db.update(platformTransactionJournal).set({ hash: keccak256(toHex('substituted')) }).where(eq(platformTransactionJournal.key, key));
    await expect(bridge.transactions.submit(key, local.pins.tokenAddress, data)).rejects.toThrow('journal intent');
    expect(await bridge.public.getTransactionCount({ address: bridge.account.address })).toBe(nonce);
  });
  it('reconciles a genuine permissionless third-party settlement without signing a duplicate payment', async () => {
    const prepared = await prepare(); await open(prepared); await service.drain(); await closeHour(prepared.quote.runId);
    const pending = await service.get(local.accounts.owner.address, prepared.quote.runId);
    if (!pending.settlement) throw new Error('Durable platform outcome unavailable');
    await receipts.record(local.accounts.owner.address, pending.settlement);
    await receipts.publishClosed();
    const proof = await receipts.proof(local.accounts.owner.address, prepared.quote.runId);
    if (!proof || !pending.settlement) throw new Error('Canonical platform outcome proof unavailable');
    const external = await local.confirmed(local.owner.sendTransaction({ account: local.accounts.outsider, to: local.pins.escrowAddress,
      data: encodeFunctionData({ abi: platformEscrowAbi, functionName: 'settleRun',
        args: [typedPlatformSettlement(pending.settlement), BigInt(proof.hour), proof.proof] }) }));
    await expect(bridge.confirmedSettlement({ ...pending.settlement, billableSeconds: 25 }, external.transactionHash)).rejects.toThrow('financial evidence');
    await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({ status: 'completed', settlementTx: external.transactionHash });
    expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(1);
    expect(runtime.starts).toBe(1); expect((await bridge.run(prepared.quote.runId)).hostReleased).toBe(true);
  });
  it('invalidates a completed local marker after a real chain reorg and restores the original financial intents without redispatch', async () => {
    const prepared = await prepare(); await open(prepared); await service.drain();
    const snapshot = await local.test.snapshot();
    await closeHour(prepared.quote.runId); await service.drain();
    const completed = await service.get(local.accounts.owner.address, prepared.quote.runId); expect(completed.status).toBe('completed');
    await local.test.revert({ id: snapshot });
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toMatchObject({ status: 'reconciliation', charged: null, refund: null,
      errorCode: 'platform_finality_uncertain' });
    expect((await bridge.run(prepared.quote.runId)).status).toBe(1);
    await closeHour(prepared.quote.runId); await service.drain();
    expect(await service.get(local.accounts.owner.address, prepared.quote.runId)).toEqual(completed);
    expect(runtime.starts).toBe(1); expect(await store.db.select().from(platformTransactionJournal)).toHaveLength(2);
  });
  it('rejects another genuinely settled run even when both financial amounts match, including recovery', async () => {
    const first = await prepare('first-equal-cost'), second = await prepare('second-equal-cost');
    await open(first); await open(second); await service.drain(); await service.drain();
    await closeHour(first.quote.runId); await service.drain();
    const original = await service.get(local.accounts.owner.address, first.quote.runId);
    const substitute = await service.get(local.accounts.owner.address, second.quote.runId);
    expect(original.status).toBe('completed'); expect(substitute.status).toBe('completed');
    expect(original.charged).toBe(substitute.charged); expect(original.refund).toBe(substitute.refund);
    expect(original.settlementTx).not.toBe(substitute.settlementTx);
    const nonce = await bridge.public.getTransactionCount({ address: bridge.account.address });
    await store.db.update(platformRuns).set({ settlement: substitute.settlement, settlementTx: substitute.settlementTx })
      .where(eq(platformRuns.id, first.quote.runId));
    expect(await service.get(local.accounts.owner.address, first.quote.runId)).toMatchObject({ status: 'reconciliation',
      charged: null, refund: null, errorCode: 'platform_finality_uncertain' });
    await service.drain();
    expect(await service.get(local.accounts.owner.address, first.quote.runId)).toMatchObject({ status: 'reconciliation', charged: null, refund: null });
    await store.close(); store = await openStore({ DATA_DIR: join(root, 'db') }); rebuild(); await service.initialize(); await service.drain();
    expect(await service.get(local.accounts.owner.address, first.quote.runId)).toMatchObject({ status: 'reconciliation', charged: null, refund: null });
    expect(await service.get(local.accounts.owner.address, second.quote.runId)).toEqual(substitute);
    expect(await bridge.public.getTransactionCount({ address: bridge.account.address })).toBe(nonce);
    expect(runtime.starts).toBe(2);
  }, 30000);
});
