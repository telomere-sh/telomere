import { and, asc, desc, eq, gt, isNull, isNotNull, or } from 'drizzle-orm';
import { parseEventLogs, recoverTypedDataAddress } from 'viem';
import { addressSchema, bytes32Schema, hashJson, Problem, sameAddress, signatureSchema } from '../common.js';
import type { CystService } from '../cysts/service.js';
import type { PlatformRuntimeService } from '../platform-runtime/service.js';
import { platformRuns } from '../platform-runtime/schema.js';
import { platformEscrowAbi, platformQuoteSchema, platformQuoteTypes, platformSettlementSchema, platformWorkloadHash,
  typedPlatformQuote, validatedPlatformQuoteInputSchema, platformQuoteDomainVersion } from '../platform-runtime/types.js';
import type { Database } from '../store.js';
import { agentBilling, agentBillingProvenance, agents } from './schema.js';
import { AgentLifecycleService } from './service.js';
import { createAgentRuntimeBinding } from './runtime-binding.js';
import { createCanonicalAgentBilling } from './paid-billing.js';
import { createPaidMetabolismReader } from './paid-metabolism.js';

type RunRow = typeof platformRuns.$inferSelect;
const unavailable = () => new Problem(503, 'agent_billing_unconfirmed',
  'Canonical paid billing must be restored before evaluating or increasing agent activity. Owner kill remains available.');

/** EOA-paid CPU reservations only. The owner runner still supplies actual checkpoint/stop/restore effects. */
export function createPaidAgentLifecycle(db: Database, cysts: CystService, runtime: PlatformRuntimeService) {
  const bridge = runtime.bridge;
  const binding = createAgentRuntimeBinding(db, { protocol: 'platform', chainId: bridge.pins.chainId,
    escrow: bridge.pins.escrowAddress, token: bridge.pins.tokenAddress });
  let maintenanceAfter: { owner: string; agent: string } | undefined;
  let lifecycle: AgentLifecycleService;
  async function checkedQuote(row: RunRow): Promise<void> {
    const input = validatedPlatformQuoteInputSchema.parse(row.input), quote = platformQuoteSchema.parse(row.quote);
    if (row.vaultBinding || row.id !== quote.runId || !sameAddress(addressSchema.parse(row.owner), quote.payer)
      || input.leashId !== quote.leashId || input.maxSeconds !== quote.maxSeconds || hashJson(input) !== row.inputHash
      || platformWorkloadHash(input) !== quote.workloadHash || BigInt(row.ceiling) <= 0n
      || BigInt(row.ceiling) > BigInt(input.maxSpend) || BigInt(row.ceiling) > 250_000_000n
      || BigInt(quote.quoteExpiry) + BigInt(quote.maxSeconds) > BigInt(input.deadline)) throw unavailable();
    const signer = await recoverTypedDataAddress({ domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(bridge.pins),
      chainId: bridge.pins.chainId, verifyingContract: bridge.pins.escrowAddress }, primaryType: 'PlatformQuote',
      types: platformQuoteTypes, message: typedPlatformQuote(quote), signature: signatureSchema.parse(row.signature) });
    if (!sameAddress(signer, bridge.pins.quoteSigner)) throw unavailable();
  }
  async function reservation(owner: string, agent: string, runId: string) {
    await binding.ensureReady();
    const [row] = await db.select().from(platformRuns).where(and(eq(platformRuns.owner, owner),
      eq(platformRuns.id, bytes32Schema.parse(runId)))).limit(1);
    if (!row || row.agent !== agent || row.vaultBinding || !row.admissionTx || !['queued', 'running'].includes(row.status)) {
      throw new Problem(409, 'agent_reservation_invalid', 'Use an admitted EOA-paid CPU run bound to this owner and agent.');
    }
    await checkedQuote(row); await bridge.check();
    await bridge.verifyAdmission(row.quote, row.ceiling, bytes32Schema.parse(row.admissionTx));
    const [run, leash] = await Promise.all([bridge.run(row.quote.runId), bridge.leash(row.quote.leashId)]);
    if (run.status !== 1 || run.stopAt !== 0n || leash.killed || !bridge.matches(row.quote, run)
      || !sameAddress(leash.owner, addressSchema.parse(owner)) || !sameAddress(leash.agent, addressSchema.parse(agent))) {
      throw new Problem(409, 'agent_reservation_invalid', 'The original paid run or Leash is no longer active.');
    }
    const until = [run.openedAt + run.maxSeconds, run.acceptedExpiry, leash.expiry,
      BigInt(row.input.deadline)].reduce((a, b) => a < b ? a : b);
    return { id: row.id, owner, agent, reserved: true as const, leaseUntil: new Date(Number(until) * 1000),
      paidPrice: { leaseSeconds: row.quote.maxSeconds, cpuPricePerSecond: row.quote.pricePerSecond, fixedInferencePrice: row.quote.inferencePrice },
      ...(row.input.task.kind === 'session' ? { resourceProfile: row.input.task.resourceProfile ?? 'full' } : {}) };
  }
  async function confirmedCharge(row: RunRow) {
    await checkedQuote(row);
    if (row.status !== 'completed' || !row.admissionTx || !row.settlementTx || !row.settlement || row.settlement.runId !== row.id
      || row.charged === null || row.refund === null) throw unavailable();
    const final = await runtime.get(row.owner, row.id);
    if (final.status !== 'completed' || final.charged !== row.charged || final.refund !== row.refund) throw unavailable();
    const admitted = await bridge.canonicalReceipt(bytes32Schema.parse(row.admissionTx), bridge.pins.escrowAddress);
    const opened = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunOpened', logs: admitted.logs.filter(log =>
      sameAddress(log.address, bridge.pins.escrowAddress)) });
    if (!opened.some(log => log.args.runId === row.quote.runId && log.args.leashId === row.quote.leashId
      && log.args.hostId === row.quote.hostId && sameAddress(log.args.payer, row.quote.payer)
      && log.args.ceiling.toString() === row.ceiling && log.args.maxSeconds === BigInt(row.quote.maxSeconds))) throw unavailable();
    const originalLeash = await bridge.openingLeash(row.quote, bytes32Schema.parse(row.admissionTx));
    if (!sameAddress(originalLeash.owner, addressSchema.parse(row.owner))
      || !sameAddress(originalLeash.agent, addressSchema.parse(row.agent))) throw unavailable();
    const settled = await bridge.confirmedSettlement(platformSettlementSchema.parse(row.settlement), bytes32Schema.parse(row.settlementTx));
    if (settled.charged !== row.charged || settled.refund !== row.refund
      || BigInt(row.charged) + BigInt(row.refund) !== BigInt(row.ceiling)) throw unavailable();
    const receipt = await bridge.canonicalReceipt(settled.transactionHash);
    const block = await bridge.public.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash || block.timestamp > BigInt(Math.floor(Date.now() / 1000))) throw unavailable();
    await bridge.canonicalReceipt(settled.transactionHash);
    return { amount: settled.charged, at: new Date(Number(block.timestamp) * 1000), provenance: {
      transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash } };
  }
  const { refreshBilling } = createCanonicalAgentBilling(db, bridge, {
    ensureReady: binding.ensureReady,
    pending: async (owner, agent) => (await db.select({ run: platformRuns }).from(platformRuns)
      .leftJoin(agentBilling, and(eq(agentBilling.owner, platformRuns.owner), eq(agentBilling.receiptId, platformRuns.id)))
      .where(and(eq(platformRuns.owner, owner), eq(platformRuns.agent, agent), eq(platformRuns.status, 'completed'),
        isNull(platformRuns.vaultBinding), isNull(agentBilling.receiptId)))
      .orderBy(asc(platformRuns.createdAt), asc(platformRuns.id)).limit(101)).map(row => row.run),
    confirm: confirmedCharge,
    append: (owner, agent, row, charge) => lifecycle.appendSettledCharge(owner, agent, row.id,
      charge.amount, charge.at, charge.provenance),
  });
  const metabolismPricing = createPaidMetabolismReader(runtime, {
    balanceAt: async (owner, _agent, blockNumber) => (await bridge.public.readContract({ address: bridge.pins.escrowAddress,
      abi: platformEscrowAbi, functionName: 'availableBalance', args: [addressSchema.parse(owner)], blockNumber })).toString(),
    original: async (owner, agent, currentRunId) => (await db.select().from(platformRuns).where(and(
      eq(platformRuns.owner, owner), eq(platformRuns.agent, agent), isNull(platformRuns.vaultBinding),
      currentRunId ? eq(platformRuns.id, currentRunId) : isNotNull(platformRuns.admissionTx)))
      .orderBy(desc(platformRuns.createdAt), desc(platformRuns.id)).limit(1))[0],
    verify: async (owner, agent, row) => {
      await checkedQuote(row);
      if (!row.admissionTx || row.owner !== owner || row.agent !== agent) throw unavailable();
      await bridge.verifyAdmission(row.quote, row.ceiling, bytes32Schema.parse(row.admissionTx));
      const original = await bridge.openingLeash(row.quote, bytes32Schema.parse(row.admissionTx));
      if (!sameAddress(original.owner, addressSchema.parse(owner)) || !sameAddress(original.agent, addressSchema.parse(agent))) throw unavailable();
    },
  });
  lifecycle = new AgentLifecycleService(db, { cysts, leasePolicy: 'paid_cpu', ensureReady: binding.ensureReady,
    now: () => new Date(Date.now()),
    refreshBilling, metabolismPricing, balance: async owner => { await bridge.check(); return (await bridge.balance(owner)).available; },
    reservedRun: reservation });
  return { agents: lifecycle, initialize: binding.ensureReady,
    scope: { ...binding.scope, ownerPayersOnly: true as const, maximumLeaseSeconds: 120 as const, rollBeforeSeconds: 30 as const },
    async maintain(): Promise<void> {
      await binding.ensureReady();
      const pending = await db.selectDistinct({ owner: agents.owner, agent: agents.agent }).from(agents)
        .innerJoin(platformRuns, and(eq(platformRuns.owner, agents.owner), eq(platformRuns.agent, agents.agent)))
        .leftJoin(agentBilling, and(eq(agentBilling.owner, platformRuns.owner), eq(agentBilling.receiptId, platformRuns.id)))
        .leftJoin(agentBillingProvenance, and(eq(agentBillingProvenance.owner, platformRuns.owner), eq(agentBillingProvenance.receiptId, platformRuns.id)))
        .where(and(eq(platformRuns.status, 'completed'), isNull(platformRuns.vaultBinding),
          or(isNull(agentBilling.receiptId), isNull(agentBillingProvenance.validatedAnchorHash)),
          maintenanceAfter ? or(gt(agents.owner, maintenanceAfter.owner), and(eq(agents.owner, maintenanceAfter.owner), gt(agents.agent, maintenanceAfter.agent))) : undefined))
        .orderBy(asc(agents.owner), asc(agents.agent)).limit(100);
      maintenanceAfter = pending.at(-1);
      let failed = false;
      for (const row of pending) { try { await refreshBilling(row.owner, row.agent); } catch { failed = true; } }
      if (failed) throw unavailable();
    } };
}
