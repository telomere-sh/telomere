import pino from "pino";
import { and, eq, sql } from "drizzle-orm";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256,
  type Address, type Hex, type TransactionSerialized } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ChainBridge } from "../src/bridge.js";
import { jobs, openStore, transactions, type Job } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { hashJson } from "../src/common.js";
import { Service, signedReceiptSchema } from "../src/service.js";
import { escrowAbi } from "../src/chain/abi.js";
import { AmbiguousProviderError, type NearCompletionResult, type NearProvider } from "../src/providers/index.js";
import type { CpuExecutor, CpuRunResult, MeterTick } from "../src/runtime/index.js";
import { outputHash } from '../src/runtime/meter.js';
import { CpuCleanupError } from '../src/runtime/index.js';

const runId: Hex = `0x${"22".repeat(32)}`, leashId: Hex = `0x${"33".repeat(32)}`;
const owner: Address = "0x1111111111111111111111111111111111111111";
const outsider: Address = "0x9999999999999999999999999999999999999999";
const txHash: Hex = `0x${"44".repeat(32)}`, zero: Hex = `0x${"00".repeat(32)}`;
const config = loadConfig({ MODE: "demo", DATA_DIR: ":memory:", SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  DEMO_PRIVATE_KEY: `0x${"55".repeat(32)}`, ESCROW_ADDRESS: "0x6666666666666666666666666666666666666666", TOKEN_ADDRESS: "0x7777777777777777777777777777777777777777",
  NEAR_ENDPOINT: 'https://cloud-api.near.ai/v1', NEAR_MODEL: 'operator/model', NEAR_API_KEY: 'test-key', NEAR_ALLOWED_MODELS: 'operator/model' });
const logger = pino({ enabled: false });
type ChainRun = Awaited<ReturnType<ChainBridge["run"]>>;
type ChainLeash = Awaited<ReturnType<ChainBridge["leash"]>>;

function tick(seconds: number, state: MeterTick["state"] = "completed"): MeterTick {
  const record = { runId, sequence: 0, timestamp: new Date().toISOString(), elapsedMs: seconds * 1000, billableSeconds: seconds,
    state, previousHash: null, ...(state === 'running' ? {} : { outputHash: outputHash('CPU result') }) };
  return { ...record, hash: outputHash(JSON.stringify(record)) };
}
function cpuResult(seconds = 5, status: CpuRunResult["status"] = "completed"): CpuRunResult {
  return { status, output: "CPU result", billableSeconds: seconds, ticks: [tick(seconds, status)], exitCode: status === "completed" ? 0 : -1 };
}
function nearResult(): NearCompletionResult {
  return { output: "model output", model: "operator/model", requestId: "completion-1",
    evidence: { verification: "provider_tls", endpoint: "https://cloud-api.near.ai/v1/chat/completions", receivedAt: new Date().toISOString(), requestHash: '11'.repeat(32), responseHash: '22'.repeat(32) } };
}

describe("durable worker with real disposable PostgreSQL semantics", () => {
  let store: Awaited<ReturnType<typeof openStore>>;
  let bridge: ChainBridge;
  let runState: ChainRun;
  let leashState: ChainLeash;
  let cpu: CpuExecutor;
  let near: NearProvider;

  async function insertJob(withNear = false, status: Job["status"] = "queued") {
    const input = { leashId, task: { kind: "sha256" as const, text: "hello" }, maxSeconds: 30, ...(withNear ? { nearPrompt: "Do one bounded inference" } : {}) };
    const quote = { runId, leashId, payer: owner, workloadHash: hashJson(input), maxSeconds: 30, pricePerSecond: "100", inferencePrice: withNear ? "10000" : "0", quoteExpiry: Math.floor(Date.now() / 1000) + 300 };
    const ceiling = withNear ? "13000" : "3000";
    await store.db.insert(jobs).values({ id: runId, owner: owner.toLowerCase(), leashId, idemKey: "worker-fixture", inputHash: hashJson(input), input, quote,
      signature: `0x${"ab".repeat(65)}`, ceiling, status, txHash });
    runState = { ...runState, workloadHash: quote.workloadHash, ceiling: BigInt(ceiling), inferencePrice: BigInt(quote.inferencePrice) };
  }
  async function job(): Promise<Job> {
    const row = (await store.db.select().from(jobs).where(eq(jobs.id, runId)))[0];
    if (!row) throw new Error("Fixture run is missing");
    return row;
  }
  const worker = () => new Worker(store.db, bridge, cpu, near, logger);
  async function signedSettlementRaw(id: Hex, nonce: number): Promise<Hex> {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'settleRun',
      args: [{ runId: id, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero }, '0x'] });
    return bridge.account.signTransaction({ type: 'eip1559', chainId: config.CHAIN_ID,
      to: config.ESCROW_ADDRESS, data, nonce, gas: 100_000n,
      maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  }

  beforeEach(async () => {
    store = await openStore({ DATA_DIR: ":memory:" });
    bridge = new ChainBridge(config);
    runState = { payer: owner, leashId, workloadHash: zero, openedAt: BigInt(Math.floor(Date.now() / 1000)) - 10n, acceptedExpiry: 10_000_000_000n, maxSeconds: 30n,
      pricePerSecond: 100n, inferencePrice: 0n, ceiling: 3000n, stopAt: 0n, status: 1, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero };
    leashState = { owner, agent: owner, maxPerHour: 100_000n, maxPerDay: 200_000n, expiry: 10_000_000_000n, killed: false,
      killedAt: 0n, hourKey: 0n, dayKey: 0n, spentHour: 0n, spentDay: 0n, pending: 3000n };
    vi.spyOn(bridge, "run").mockImplementation(async () => runState);
    vi.spyOn(bridge, "leash").mockImplementation(async () => leashState);
    type Block = Awaited<ReturnType<typeof bridge.public.getBlock>>;
    // REASON: the fixture replaces all blockchain transport; code consumes only
    // canonical block hash/timestamp and separately typed run state.
    vi.spyOn(bridge.public, "getBlock").mockResolvedValue({ hash: txHash, number: 100n, timestamp: 100n } as Block);
    vi.spyOn(bridge, "settle").mockImplementation(async (_db, settlement) => {
      runState = { ...runState, status: 2, receiptHash: settlement.receiptHash, billableSeconds: settlement.billableSeconds, inferenceCharge: settlement.inferenceCharge };
      return txHash;
    });
    cpu = { run: vi.fn<CpuExecutor["run"]>().mockImplementation(async (_input, _signal, onTick) => {
      const result = cpuResult(); for (const item of result.ticks) await onTick?.(item); return result;
    }) };
    near = { complete: vi.fn<NearProvider["complete"]>().mockResolvedValue(nearResult()) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); });

  it("persists the provider dispatch marker and never repeats an ambiguous paid request after restart", async () => {
    await insertJob(true);
    vi.mocked(near.complete).mockImplementation(async () => {
      expect((await job()).status).toBe("near_dispatching");
      throw new AmbiguousProviderError(runId, "timeout");
    });
    await worker().drainOnce();
    expect(await job()).toMatchObject({ status: "reconciliation", errorCode: "PROVIDER_OUTCOME_UNKNOWN", receipt: null });
    const restarted = worker(); await restarted.recover(); await restarted.drainOnce();
    expect(near.complete).toHaveBeenCalledTimes(1);
    expect(cpu.run).toHaveBeenCalledTimes(1);
    expect(bridge.settle).not.toHaveBeenCalled();
  });

  it("atomically claims one queued workload across concurrent drains", async () => {
    await insertJob(true);
    const sameWorker = worker();
    await Promise.all([sameWorker.drainOnce(), sameWorker.drainOnce()]);
    expect(cpu.run).toHaveBeenCalledTimes(1);
    expect(near.complete).toHaveBeenCalledTimes(1);
    expect(await job()).toMatchObject({ status: "completed", charged: "10500", refund: "2500" });
  });

  it("quarantines a crash between the persisted provider intent and its result", async () => {
    await insertJob(true, "near_dispatching");
    const restarted = worker(); await restarted.recover(); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: "reconciliation", errorCode: "PROVIDER_OUTCOME_UNKNOWN" });
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled(); expect(bridge.settle).not.toHaveBeenCalled();
  });

  it('settles a durably stored successful NEAR result after restart with no second dispatch', async () => {
    await insertJob(true, 'near_dispatching');
    const saved = cpuResult();
    await store.db.update(jobs).set({ cpuResult: saved, nearResult: nearResult(), billableSeconds: 5, ticks: saved.ticks }).where(eq(jobs.id, runId));
    const restarted = worker(); await restarted.recover(); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '10500', refund: '2500' });
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled(); expect(bridge.settle).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed CPU result across restart before receipt creation without another workload', async () => {
    await insertJob(false, 'running');
    const saved = cpuResult();
    await store.db.update(jobs).set({ cpuResult: saved, billableSeconds: 5, ticks: saved.ticks, output: saved.output }).where(eq(jobs.id, runId));
    const restarted = worker(); await restarted.recover(); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', output: 'CPU result', charged: '500', refund: '2500', errorCode: null });
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
  });

  it('retains valid saved CPU observations when a recovery RPC fails and recovers once RPC returns', async () => {
    await insertJob(false, 'running');
    const confirmed = tick(5, 'running');
    await store.db.update(jobs).set({ billableSeconds: 5, ticks: [confirmed] }).where(eq(jobs.id, runId));
    vi.mocked(bridge.run).mockRejectedValueOnce(new Error('RPC unavailable'));
    const restarted = worker(); await restarted.recover();
    expect(restarted.snapshot().state).toBe('idle');
    expect(await job()).toMatchObject({ status: 'receipt_pending', receipt: null, targetStatus: 'failed', errorCode: 'CONTROLLER_RESTART' });
    await restarted.recover(); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: 'failed', charged: '500', refund: '2500' });
    expect(cpu.run).not.toHaveBeenCalled();
  });

  it('retains a durable successful provider result when recovery RPC is unavailable', async () => {
    await insertJob(true, 'near_dispatching');
    const saved = cpuResult();
    await store.db.update(jobs).set({ cpuResult: saved, nearResult: nearResult(), billableSeconds: 5, ticks: saved.ticks }).where(eq(jobs.id, runId));
    vi.mocked(bridge.run).mockRejectedValueOnce(new Error('RPC unavailable'));
    const restarted = worker(); await restarted.recover();
    expect(await job()).toMatchObject({ status: 'receipt_pending', targetStatus: 'completed', errorCode: null });
    await restarted.recover(); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', charged: '10500', refund: '2500' });
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
  });

  it('restores the journal transaction hash when mining preceded the final database update', async () => {
    await insertJob();
    vi.mocked(bridge.settle).mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await expect(worker().drainOnce()).rejects.toThrow('Lost acknowledgement');
    const receipt = signedReceiptSchema.parse((await job()).receipt);
    runState = { ...runState, status: 2, receiptHash: receipt.receiptHash, billableSeconds: 5n, inferenceCharge: 0n };
    await store.db.insert(transactions).values({ runId, raw: '0x01020304', hash: txHash, nonce: 0 });
    await worker().drainOnce();
    expect(await job()).toMatchObject({ status: 'completed', settlementTxHash: txHash, charged: '500' });
    expect(cpu.run).toHaveBeenCalledTimes(1);
  });

  it('refuses tampered persisted observations and quarantines future CPU dispatch', async () => {
    await insertJob(false, 'running');
    const confirmed = tick(5, 'running');
    await store.db.update(jobs).set({ billableSeconds: 5, ticks: [{ ...confirmed, billableSeconds: 20 }] }).where(eq(jobs.id, runId));
    const restarted = worker(); await restarted.recover();
    expect(restarted.snapshot()).toMatchObject({ state: 'quarantined', reason: 'CPU_RECOVERY_REQUIRED' });
    expect(await job()).toMatchObject({ status: 'reconciliation', receipt: null });
    await store.db.update(jobs).set({ status: 'queued' }).where(eq(jobs.id, runId));
    await restarted.drainOnce(); expect(cpu.run).not.toHaveBeenCalled(); expect(bridge.settle).not.toHaveBeenCalled();
  });

  it('quarantines an unconfirmed container cleanup until exclusive startup cleanup succeeds', async () => {
    await insertJob();
    vi.mocked(cpu.run).mockRejectedValue(new CpuCleanupError('telomere-fixture-12345678'));
    const failed = worker(); await failed.drainOnce();
    expect(failed.snapshot().state).toBe('quarantined');
    const notCleaned = worker(); await notCleaned.recover(); expect(notCleaned.snapshot().state).toBe('quarantined');
    const cleaned = worker(); await cleaned.recover(true); await cleaned.drainOnce();
    expect(cleaned.snapshot().state).toBe('idle'); expect(await job()).toMatchObject({ status: 'failed', charged: '0', refund: '3000' });
  });

  it("holds funds when a successful provider result cannot be persisted instead of settling a false zero inference charge", async () => {
    await insertJob(true);
    await store.db.execute(sql.raw("ALTER TABLE jobs ADD CONSTRAINT simulate_result_disk_failure CHECK (near_result IS NULL)"));
    await worker().drainOnce();
    expect(await job()).toMatchObject({ status: "reconciliation", errorCode: "PROVIDER_OUTCOME_UNKNOWN", receipt: null });
    await worker().recover(); await worker().drainOnce();
    expect(near.complete).toHaveBeenCalledTimes(1); expect(bridge.settle).not.toHaveBeenCalled();
  });

  it("does not produce a zero-price receipt when CPU tick persistence fails after work ran", async () => {
    await insertJob();
    await store.db.execute(sql.raw("ALTER TABLE jobs ADD CONSTRAINT simulate_tick_disk_failure CHECK (billable_seconds = 0)"));
    await worker().drainOnce();
    expect(await job()).toMatchObject({ status: "reconciliation", errorCode: "CPU_RECOVERY_REQUIRED", billableSeconds: 0, charged: null, refund: null, receipt: null });
    expect(cpu.run).toHaveBeenCalledTimes(1); expect(bridge.settle).not.toHaveBeenCalled();
  });

  it("uses only already-persisted CPU ticks on restart without executing the workload again", async () => {
    await insertJob(false, "running");
    const confirmed = tick(5, "running");
    await store.db.update(jobs).set({ billableSeconds: 5, ticks: [confirmed] }).where(eq(jobs.id, runId));
    const restarted = worker(); await restarted.recover(); await restarted.drainOnce();
    expect(await job()).toMatchObject({ status: "failed", billableSeconds: 5, charged: "500", refund: "2500", errorCode: "CONTROLLER_RESTART" });
    expect(cpu.run).not.toHaveBeenCalled(); expect(near.complete).not.toHaveBeenCalled();
    expect(bridge.settle).toHaveBeenCalledWith(store.db, expect.objectContaining({ billableSeconds: 5n, inferenceCharge: 0n }), expect.any(String));
  });

  it("polls an onchain stop and cancels CPU execution before attempting NEAR", async () => {
    await insertJob(true);
    let observations = 0, cpuSawAbort = false;
    vi.mocked(bridge.run).mockImplementation(async () => {
      if (++observations >= 2) runState = { ...runState, stopAt: BigInt(Math.floor(Date.now() / 1000)) };
      return runState;
    });
    vi.mocked(cpu.run).mockImplementation(async (_input, signal, onTick) => {
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => { cpuSawAbort = true; resolve(); }, { once: true });
        if (signal.aborted) { cpuSawAbort = true; resolve(); }
      });
      const result = cpuResult(0, "cancelled"); await onTick?.(result.ticks[0]!); return result;
    });
    await worker().drainOnce();
    expect(cpuSawAbort).toBe(true);
    expect(await job()).toMatchObject({ status: "cancelled", charged: "0", refund: "13000" });
    expect(near.complete).not.toHaveBeenCalled();
  }, 10_000);

  it("passes an already-aborted CPU signal and never calls NEAR after the escrow refund deadline", async () => {
    await insertJob(true);
    runState = { ...runState, openedAt: BigInt(Math.floor(Date.now() / 1000)) - runState.maxSeconds - 21601n };
    let taskDispatches = 0;
    vi.mocked(cpu.run).mockImplementation(async (_input, signal, onTick) => {
      expect(signal.aborted).toBe(true);
      if (!signal.aborted) taskDispatches++;
      const result = cpuResult(0, "cancelled");
      const finalTick = result.ticks[0];
      if (!finalTick) throw new Error("Fixture tick missing");
      await onTick?.(finalTick);
      return result;
    });
    await worker().drainOnce();
    expect(taskDispatches).toBe(0);
    expect(near.complete).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: "cancelled", charged: "0", refund: "13000" });
  });

  it("permits new settlement signing when the latest mined nonce proves a prior journal consumed", async () => {
    await insertJob();
    const priorId: Hex = `0x${"88".repeat(32)}`;
    await store.db.insert(jobs).values({ ...(await job()), id: priorId, idemKey: "consumed-journal", status: "reconciliation" });
    const priorRaw = await signedSettlementRaw(priorId, 7);
    await store.db.insert(transactions).values({ runId: priorId, raw: priorRaw, hash: keccak256(priorRaw), nonce: 7 });
    vi.mocked(bridge.settle).mockRestore();
    const chainNonce = vi.spyOn(bridge.public, "getTransactionCount").mockResolvedValue(8);
    type Prepared = Awaited<ReturnType<typeof bridge.wallet.prepareTransactionRequest>>;
    // REASON: transport fixture verifies nonce admission and journal ownership;
    // execution/encoding of an actual signed EVM transaction is covered separately.
    const prepare = vi.spyOn(bridge.wallet, "prepareTransactionRequest").mockResolvedValue({ to: config.ESCROW_ADDRESS, nonce: 8, gas: 100000n } as Prepared);
    const signing = vi.spyOn(bridge.wallet, "signTransaction").mockRejectedValue(new Error("Fixture signing boundary reached"));
    const settlement = { runId, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero };
    await expect(bridge.settle(store.db, settlement, await bridge.signSettlement(settlement))).rejects.toThrow("Fixture signing boundary reached");
    expect(chainNonce).toHaveBeenCalledWith({ address: bridge.account.address, blockTag: "latest" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(signing).toHaveBeenCalledTimes(1);
  });

  it("blocks signing for an unresolved nonce even when its old job was externally refunded", async () => {
    await insertJob();
    const priorId: Hex = `0x${"88".repeat(32)}`;
    await store.db.insert(jobs).values({ ...(await job()), id: priorId, idemKey: "pending-refunded-journal", status: "refunded" });
    const priorRaw = await signedSettlementRaw(priorId, 7);
    await store.db.insert(transactions).values({ runId: priorId, raw: priorRaw, hash: keccak256(priorRaw), nonce: 7 });
    vi.mocked(bridge.settle).mockRestore();
    const chainNonce = vi.spyOn(bridge.public, "getTransactionCount").mockImplementation(async parameters => parameters.blockTag === "latest" ? 7 : 8);
    const prepare = vi.spyOn(bridge.wallet, "prepareTransactionRequest");
    const signing = vi.spyOn(bridge.wallet, "signTransaction");
    const settlement = { runId, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: zero };
    await expect(bridge.settle(store.db, settlement, await bridge.signSettlement(settlement))).rejects.toThrow("unresolved transaction nonce");
    expect(chainNonce).toHaveBeenCalledWith({ address: bridge.account.address, blockTag: "latest" });
    expect(prepare).not.toHaveBeenCalled(); expect(signing).not.toHaveBeenCalled();
    expect(await store.db.select().from(transactions).where(eq(transactions.runId, runId))).toEqual([]);
  });

  it("replays the identical durable settlement transaction after a lost acknowledgement without repeating CPU", async () => {
    await insertJob();
    vi.mocked(bridge.settle).mockRestore();
    // The durable journal checks the mined nonce before preparing or replaying bytes.
    // This transport fixture owns that boundary; it must never contact a local RPC.
    const nonce = vi.spyOn(bridge.public, "getTransactionCount").mockResolvedValue(0);
    type Prepared = Awaited<ReturnType<typeof bridge.wallet.prepareTransactionRequest>>;
    const signed: { raw?: TransactionSerialized; hash?: Hex } = {};
    // REASON: this local fixture supplies the nonce and gas while preserving the actual settlement call data.
    const prepare = vi.spyOn(bridge.wallet, "prepareTransactionRequest").mockImplementation(async request =>
      ({ ...request, chainId: config.CHAIN_ID, nonce: 0, gas: 100_000n } as Prepared));
    const signing = vi.spyOn(bridge.wallet, "signTransaction").mockImplementation(async request => {
      if (!request.data || request.nonce === undefined || request.gas === undefined) {
        throw new Error('Fixture settlement request is incomplete');
      }
      const raw = await bridge.account.signTransaction({ type: 'eip1559', chainId: config.CHAIN_ID,
        to: config.ESCROW_ADDRESS, data: request.data, nonce: request.nonce, gas: request.gas,
        maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
      // REASON: the local account signed an explicit EIP-1559 request, yielding serialized transaction bytes.
      signed.raw = raw as TransactionSerialized;
      signed.hash = keccak256(raw);
      return signed.raw;
    });
    const missing = new Error('Receipt not yet found');
    missing.name = 'TransactionReceiptNotFoundError';
    vi.spyOn(bridge.public, "getTransactionReceipt").mockRejectedValue(missing);
    const broadcast = vi.spyOn(bridge.public, "sendRawTransaction").mockImplementation(async ({ serializedTransaction }) => {
      if (!signed.raw || !signed.hash) throw new Error('Fixture transaction was not signed');
      const journal = (await store.db.select().from(transactions).where(eq(transactions.runId, runId)))[0];
      expect(journal).toMatchObject({ raw: signed.raw, hash: signed.hash });
      expect(serializedTransaction).toBe(signed.raw);
      return signed.hash;
    });
    const wait = vi.spyOn(bridge.public, "waitForTransactionReceipt").mockRejectedValueOnce(new Error("Lost acknowledgement"));
    await expect(worker().drainOnce()).rejects.toThrow("Lost acknowledgement");
    if (!signed.hash) throw new Error('Fixture transaction was not signed');
    const signedHash = signed.hash;
    expect((await job()).status).toBe("settling");
    type Receipt = Awaited<ReturnType<typeof bridge.public.waitForTransactionReceipt>>;
    // REASON: only status/hash are consumed at this transport boundary; real EVM verification
    // is independently exercised by contracts.test.ts and the service integration suite.
    const savedReceipt: unknown = (await job()).receipt;
    if (!savedReceipt || typeof savedReceipt !== "object" || !("receiptHash" in savedReceipt)) throw new Error("Fixture receipt missing");
    const receiptHash = String(savedReceipt.receiptHash);
    if (!/^0x[a-f0-9]{64}$/.test(receiptHash)) throw new Error("Fixture receipt hash invalid");
    // REASON: validated hash originates from the real worker's generated receipt.
    const typedReceiptHash = receiptHash as Hex;
    const topics = encodeEventTopics({ abi: escrowAbi, eventName: "RunSettled", args: { runId, receiptHash: typedReceiptHash } });
    const data = encodeAbiParameters([{ type: "uint64" }, { type: "uint96" }, { type: "uint96" }, { type: "uint96" }], [5n, 0n, 500n, 2500n]);
    wait.mockImplementation(async () => {
      runState = { ...runState, status: 2, receiptHash: typedReceiptHash, billableSeconds: 5n, inferenceCharge: 0n };
      return { status: "success", transactionHash: signedHash, from: bridge.account.address,
        to: config.ESCROW_ADDRESS, blockNumber: 100n, blockHash: txHash,
        logs: [{ address: config.ESCROW_ADDRESS, topics, data, logIndex: 0, transactionIndex: 0, transactionHash: signedHash, blockNumber: 100n, blockHash: txHash, removed: false }] } as Receipt;
    });
    await worker().recover(); await worker().drainOnce();
    expect(await job()).toMatchObject({ status: "completed", settlementTxHash: signedHash, charged: "500", refund: "2500" });
    expect(prepare).toHaveBeenCalledTimes(1); expect(signing).toHaveBeenCalledTimes(1); expect(broadcast).toHaveBeenCalledTimes(2);
    expect(nonce).toHaveBeenCalledWith({ address: bridge.account.address, blockTag: 'latest' });
    expect(cpu.run).toHaveBeenCalledTimes(1);
  });

  it("keeps another tenant's run, receipt and output inaccessible", async () => {
    await insertJob(); await worker().drainOnce();
    const service = new Service(store.db, bridge, config, true);
    await expect(service.requireJob(outsider, runId)).rejects.toMatchObject({ status: 404, code: "run_not_found" });
    expect(await service.listRuns(outsider)).toEqual({ runs: [] });
    expect(await service.requireJob(owner, runId)).toMatchObject({ status: "completed", output: "CPU result" });
    expect(await store.db.select().from(jobs).where(and(eq(jobs.owner, outsider.toLowerCase()), eq(jobs.id, runId)))).toEqual([]);
  });

  it('rejects noncanonical or misbound settlement receipts before treating a run as confirmed', async () => {
    const receiptHash = hashJson({ fixture: 'settlement-confirmation-boundary' });
    const settlement = { runId, billableSeconds: 5n, inferenceCharge: 0n, receiptHash };
    type Receipt = Awaited<ReturnType<typeof bridge.public.getTransactionReceipt>>;
    const topics = encodeEventTopics({ abi: escrowAbi, eventName: 'RunSettled', args: { runId, receiptHash } });
    const data = encodeAbiParameters([{ type: 'uint64' }, { type: 'uint96' }, { type: 'uint96' }, { type: 'uint96' }], [5n, 0n, 500n, 2500n]);
    // REASON: this RPC-boundary fixture supplies every receipt/log field consumed
    // by verification. The service suite separately checks actual EVM receipts.
    const receipt = { status: 'success', transactionHash: txHash, from: bridge.account.address,
      to: config.ESCROW_ADDRESS, blockNumber: 100n, blockHash: txHash,
      logs: [{ address: config.ESCROW_ADDRESS, topics, data, logIndex: 0, transactionIndex: 0,
        transactionHash: txHash, blockNumber: 100n, blockHash: txHash, removed: false }] } as Receipt;
    const settled = { ...runState, status: 2, receiptHash, billableSeconds: 5n };
    runState = settled;
    await expect(bridge.verifySettlementReceipt(settlement, receipt)).resolves.toBeUndefined();
    const mutations: Array<Partial<Receipt>> = [{ status: 'reverted' }, { to: outsider }, { from: outsider },
      { blockHash: zero }, { logs: [] }, { logs: receipt.logs.map(log => ({ ...log, address: outsider })) }];
    for (const change of mutations) {
      await expect(bridge.verifySettlementReceipt(settlement, { ...receipt, ...change })).rejects.toThrow();
    }
    for (const change of [{ status: 1 }, { receiptHash: zero }]) {
      runState = { ...settled, ...change };
      await expect(bridge.verifySettlementReceipt(settlement, receipt)).rejects.toThrow('Settlement state mismatch');
    }
    runState = settled;
    await expect(bridge.verifySettlementReceipt({ ...settlement, receiptHash: zero }, receipt)).rejects.toThrow();
  });
});
