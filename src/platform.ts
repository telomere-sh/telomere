import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Service } from './service.js';
import { receiptSettlement, signedReceiptSchema } from './service.js';
import { addressSchema, bytes32Schema, Problem, sameAddress } from './common.js';
import { jobs } from './store.js';
import type { CystService } from './cysts/service.js';
import { AgentLifecycleService } from './agents/service.js';
import { createAgentRuntimeBinding } from './agents/runtime-binding.js';
import { createPaidAgentLifecycle } from './agents/platform-runtime.js';
import { createVaultPaidAgentLifecycle } from './agents/vault-runtime.js';
import type { PlatformRuntimeService } from './platform-runtime/service.js';
import { agents, agentBilling } from './agents/schema.js';
import { HourReceiptService } from './receipts/service.js';
import { createReceiptRootReader } from './receipts/verifier.js';
import { SelectionIndexer } from './selection/indexer.js';
import { createSelectionReader } from './selection/rpc.js';
import { SelectionDataset } from './selection/dataset.js';
import { SelectionReputation } from './selection/reputation.js';
import type { SelectionReputationPublisher } from './selection/reputation-publisher.js';

/** Authoritative controller bindings; no lifecycle endpoint can invent a paid run or billing record. */
export function createControllerPlatform(service: Service, cysts?: CystService, paidRuntime?: PlatformRuntimeService) {
  const { bridge, config, db } = service;
  const receipts = new HourReceiptService(db, { chainId: config.CHAIN_ID, escrowAddress: config.ESCROW_ADDRESS,
    tokenAddress: config.TOKEN_ADDRESS, receiptSigner: bridge.account.address,
    ...(config.RECEIPT_ROOT_ADDRESS ? { receiptRootAddress: config.RECEIPT_ROOT_ADDRESS } : {}) });
  if (config.AGENT_RUNTIME !== 'legacy' && (!cysts || !paidRuntime)) throw new Error('Reviewed paid runtime and Cysts are required for agent lifecycle');
  const paidLifecycle = cysts && paidRuntime ? config.AGENT_RUNTIME === 'platform' ? createPaidAgentLifecycle(db, cysts, paidRuntime)
    : config.AGENT_RUNTIME === 'platform_vault' ? createVaultPaidAgentLifecycle(db, cysts, paidRuntime) : undefined : undefined;
  const legacyBinding = !paidLifecycle ? createAgentRuntimeBinding(db, { protocol: 'legacy', chainId: config.CHAIN_ID,
    escrow: config.ESCROW_ADDRESS, token: config.TOKEN_ADDRESS }) : undefined;
  const lifecycle = paidLifecycle?.agents ?? (cysts ? new AgentLifecycleService(db, { cysts,
    ...(legacyBinding ? { ensureReady: legacyBinding.ensureReady } : {}),
    balance: async owner => (await bridge.balance(addressSchema.parse(owner))).available,
    reservedRun: async (owner, agent, runId) => {
      const job = await service.requireJob(addressSchema.parse(owner), runId);
      const [run, leash] = await Promise.all([bridge.run(bytes32Schema.parse(runId)), bridge.leash(bytes32Schema.parse(job.leashId))]);
      if (!job.agentAddress || !sameAddress(addressSchema.parse(job.agentAddress), addressSchema.parse(agent))
        || !sameAddress(leash.agent, addressSchema.parse(agent)) || !sameAddress(leash.owner, addressSchema.parse(owner))
        || !sameAddress(run.payer, addressSchema.parse(owner)) || run.status !== 1 || run.stopAt !== 0n || leash.killed
        || run.workloadHash !== job.quote.workloadHash || run.ceiling.toString() !== job.ceiling
        || !['queued', 'running'].includes(job.status)) {
        throw new Problem(409, 'agent_reservation_invalid', 'Use an admitted, active reservation bound to this owner and agent.');
      }
      const until = [run.openedAt + run.maxSeconds, run.acceptedExpiry, leash.expiry].reduce((a, b) => a < b ? a : b);
      return { id: runId, owner: run.payer.toLowerCase(), agent: job.agentAddress, reserved: true as const,
        leaseUntil: new Date(Number(until) * 1000) };
    } }) : undefined);
  const receiptReader = config.RECEIPT_ROOT_ADDRESS ? createReceiptRootReader(config.RPC_URL) : undefined;
  const selectionReader = config.SELECTION_ENABLED ? createSelectionReader(config.RPC_URL) : undefined;
  const selection = selectionReader && config.SELECTION_REGISTRY_ADDRESS && config.SELECTION_CODE_HASH && config.SELECTION_START_BLOCK !== undefined
    ? new SelectionIndexer(db, { reviewed: true, chainId: config.CHAIN_ID, registryAddress: config.SELECTION_REGISTRY_ADDRESS,
      registryCodeHash: config.SELECTION_CODE_HASH, startBlock: BigInt(config.SELECTION_START_BLOCK), confirmations: config.SELECTION_CONFIRMATIONS },
    selectionReader) : undefined;
  const selectionDataset = selection && selectionReader ? new SelectionDataset(db, selection, selectionReader) : undefined;
  const selectionReputation = selection && selectionReader ? new SelectionReputation(db, selection, selectionReader) : undefined;
  let reputationPublisher: SelectionReputationPublisher | undefined;
  let publisherReadiness: { state: 'pending' | 'ready' | 'unavailable'; code?: string } | undefined;
  function attachReputationPublisher(publisher: SelectionReputationPublisher): void {
    if (!selection || !selectionReputation || reputationPublisher) throw new Error('Canonical Selection publisher attachment is unavailable');
    reputationPublisher = publisher;
    publisherReadiness = { state: 'pending' };
  }
  function reputationPublisherReadiness() { return publisherReadiness && { ...publisherReadiness }; }
  function publisherUnavailable(error: unknown): void {
    if (!reputationPublisher) return;
    const code = error instanceof Problem && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
      ? error.code : 'selection_reputation_publication_unavailable';
    publisherReadiness = { state: 'unavailable', code };
  }
  let running: Promise<void> | undefined;
  async function maintain(): Promise<void> {
    if (running) return running;
    const operation = async () => {
      try { await initialize(); } catch (error) { publisherUnavailable(error); throw error; }
      const accounting = async () => {
        if (paidLifecycle) await paidLifecycle.maintain();
        if (lifecycle && !paidLifecycle) {
          const pending = await db.select({ job: jobs }).from(jobs)
            .innerJoin(agents, and(eq(agents.owner, jobs.owner), eq(agents.agent, jobs.agentAddress)))
            .leftJoin(agentBilling, and(eq(agentBilling.owner, jobs.owner), eq(agentBilling.receiptId, jobs.id)))
            .where(and(inArray(jobs.status, ['completed', 'failed', 'cancelled', 'timed_out']),
              isNotNull(jobs.receipt), isNotNull(jobs.settlementTxHash), isNull(agentBilling.receiptId)))
            .orderBy(asc(jobs.updatedAt), asc(jobs.id)).limit(100);
          for (const { job } of pending) {
            const receipt = signedReceiptSchema.parse(job.receipt);
            const charged = BigInt(receipt.settlement.billableSeconds) * BigInt(job.quote.pricePerSecond) + BigInt(receipt.settlement.inferenceCharge);
            if (!job.agentAddress || job.charged === null || !(await service.verifyReceipt(receipt)).valid
              || receipt.settlement.runId !== job.id || !sameAddress(addressSchema.parse(receipt.body.payer), job.quote.payer)
              || receipt.body.leashId !== job.leashId || charged.toString() !== job.charged
              || BigInt(job.ceiling) - charged !== BigInt(job.refund ?? '-1')) throw new Error('Agent billing receipt differs from its durable reservation');
            const settledAt = await bridge.confirmedSettlement(receiptSettlement(receipt), bytes32Schema.parse(job.settlementTxHash));
            // Chain clocks ahead of the controller are retried instead of assigning a fabricated settlement time.
            if (settledAt.getTime() > Date.now()) continue;
            await lifecycle.appendSettledCharge(job.owner, job.agentAddress, job.id, job.charged, settledAt);
          }
        }
      };
      // A billing reconciliation must not starve unrelated receipt batches or canonical Selection indexing.
      const results = await Promise.allSettled([accounting(), receipts.seal(), selection?.sync()]);
      // A canonical sync must finish first. Billing and receipt errors do not starve publication.
      let publicationError: unknown;
      if (results[2]?.status === 'rejected') publisherUnavailable(results[2].reason);
      if (results[2]?.status === 'fulfilled' && reputationPublisher) {
        try {
          await reputationPublisher.maintain();
          publisherReadiness = { state: 'ready' };
        } catch (error) {
          publicationError = error;
          publisherUnavailable(error);
        }
      }
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (publicationError) throw publicationError;
    };
    running = operation();
    try { await running; } finally { running = undefined; }
  }
  function start(logger: Logger): { close(): Promise<void> } {
    const tick = () => { void maintain().catch(error => logger.warn({ errorCode: error instanceof Problem ? error.code
      : error instanceof Error ? error.name : 'unknown' }, 'platform_maintenance_pending')); };
    tick(); const timer = setInterval(tick, 30_000).unref();
    return { async close() { clearInterval(timer); await running?.catch(() => undefined); } };
  }
  async function initialize(): Promise<void> {
    await (paidLifecycle?.initialize() ?? legacyBinding?.ensureReady());
  }
  return { receipts, ...(lifecycle ? { agents: lifecycle } : {}), ...(receiptReader ? { receiptReader } : {}),
    ...(selection ? { selection } : {}), ...(selectionDataset ? { selectionDataset } : {}),
    ...(selectionReputation ? { selectionReputation } : {}),
    agentRuntimeScope: paidLifecycle?.scope ?? legacyBinding?.scope ?? null,
    attachReputationPublisher, reputationPublisherReadiness, initialize, maintain, start };
}
export type ControllerPlatform = ReturnType<typeof createControllerPlatform>;
