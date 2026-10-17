import { and, asc, desc, eq, gt, isNull, isNotNull, or } from 'drizzle-orm';
import { recoverTypedDataAddress } from 'viem';
import { addressSchema, bytes32Schema, hashJson, Problem, sameAddress, signatureSchema } from '../common.js';
import type { CystService } from '../cysts/service.js';
import type { Database } from '../store.js';
import type { PlatformRuntimeService } from '../platform-runtime/service.js';
import { platformRuns } from '../platform-runtime/schema.js';
import { platformQuoteSchema, platformQuoteTypes, platformSettlementSchema, typedPlatformQuote,
  validatedPlatformQuoteInputSchema, platformWorkloadHash, platformQuoteDomainVersion } from '../platform-runtime/types.js';
import { platformVaultAbi, platformVaultBindingSchema, type PlatformVaultBinding } from '../platform-runtime/vault.js';
import { agents, agentBilling, agentBillingProvenance, agentVaultBindings } from './schema.js';
import { AgentLifecycleService } from './service.js';
import { createAgentRuntimeBinding } from './runtime-binding.js';
import { createCanonicalAgentBilling, paidBillingUnavailable } from './paid-billing.js';
import { createPaidMetabolismReader } from './paid-metabolism.js';

type RunRow = typeof platformRuns.$inferSelect;
const reservationInvalid = () => new Problem(409, 'agent_reservation_invalid',
  'Use an admitted CPU run funded by this owner and agent\'s original reviewed Vault.');
const normalized = (binding: PlatformVaultBinding) => ({ owner: binding.owner.toLowerCase(), agent: binding.agentWallet.toLowerCase(),
  vault: binding.vault.toLowerCase(), agentId: binding.agentId, leashId: binding.leashId });

/** Human-owner lifecycle and isolated per-agent Vault finances; the runner remains owner supplied. */
export function createVaultPaidAgentLifecycle(db: Database, cysts: CystService, runtime: PlatformRuntimeService) {
  const bridge = runtime.bridge, configuredVaults = runtime.vaults;
  if (!configuredVaults) throw new Error('Vault agent lifecycle requires the original reviewed Vault configuration');
  const vaults = configuredVaults;
  const scope = createAgentRuntimeBinding(db, { protocol: 'platform_vault', chainId: bridge.pins.chainId,
    escrow: bridge.pins.escrowAddress, token: bridge.pins.tokenAddress, vaultProfileHash: hashJson(vaults.config) });
  let lifecycle: AgentLifecycleService;
  let maintenanceAfter: { owner: string; agent: string } | undefined;
  async function resolve(owner: string, agent: string, registration = false): Promise<PlatformVaultBinding> {
    await scope.ensureReady();
    const actual = await vaults.forAgent(owner, agent);
    const [saved] = await db.select().from(agentVaultBindings)
      .where(and(eq(agentVaultBindings.owner, owner), eq(agentVaultBindings.agent, agent))).limit(1);
    if (saved ? hashJson(saved) !== hashJson(normalized(actual)) : !registration) throw paidBillingUnavailable();
    return actual;
  }
  async function rowBinding(row: RunRow, owner: string, agent: string) {
    const binding = platformVaultBindingSchema.parse(row.vaultBinding), actual = await resolve(owner, agent);
    if (hashJson(normalized(binding)) !== hashJson(normalized(actual)) || !sameAddress(row.owner, binding.vault)
      || !sameAddress(row.agent, binding.vault) || row.quote.leashId !== binding.leashId) throw paidBillingUnavailable();
    return binding;
  }
  async function checkedQuote(row: RunRow): Promise<void> {
    const quote = platformQuoteSchema.parse(row.quote), input = validatedPlatformQuoteInputSchema.parse(row.input);
    if (!row.vaultBinding || row.id !== quote.runId || !sameAddress(row.owner, quote.payer)
      || quote.leashId !== input.leashId || quote.maxSeconds !== input.maxSeconds || hashJson(input) !== row.inputHash
      || platformWorkloadHash(input) !== quote.workloadHash || BigInt(row.ceiling) <= 0n
      || BigInt(row.ceiling) > BigInt(input.maxSpend) || BigInt(row.ceiling) > 250_000_000n
      || BigInt(quote.quoteExpiry) + BigInt(quote.maxSeconds) > BigInt(input.deadline)) throw paidBillingUnavailable();
    const signer = await recoverTypedDataAddress({ domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(bridge.pins),
      chainId: bridge.pins.chainId, verifyingContract: bridge.pins.escrowAddress }, primaryType: 'PlatformQuote',
      types: platformQuoteTypes, message: typedPlatformQuote(quote), signature: signatureSchema.parse(row.signature) });
    if (!sameAddress(signer, bridge.pins.quoteSigner)) throw paidBillingUnavailable();
  }
  async function reservation(owner: string, agent: string, runId: string) {
    await scope.ensureReady();
    const [row] = await db.select().from(platformRuns).where(eq(platformRuns.id, bytes32Schema.parse(runId))).limit(1);
    if (!row?.vaultBinding || !row.admissionTx || !['queued', 'running'].includes(row.status)) throw reservationInvalid();
    const binding = platformVaultBindingSchema.parse(row.vaultBinding);
    if (!sameAddress(binding.owner, addressSchema.parse(owner)) || !sameAddress(binding.agentWallet, addressSchema.parse(agent))) throw reservationInvalid();
    // Registration can resolve an authoritative new binding before its atomic agent/binding insert.
    const actual = await resolve(owner, agent, true);
    if (hashJson(normalized(binding)) !== hashJson(normalized(actual))) throw reservationInvalid();
    await checkedQuote(row);
    await vaults.verifyAdmission(binding, row.quote, row.ceiling, bytes32Schema.parse(row.admissionTx),
      signatureSchema.parse(row.signature), row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)));
    const [run, leash, runnable] = await Promise.all([bridge.run(row.quote.runId), bridge.leash(binding.leashId), vaults.runnable(binding)]);
    if (!runnable || run.status !== 1 || run.stopAt !== 0n || leash.killed || !bridge.matches(row.quote, run)) throw reservationInvalid();
    const until = [run.openedAt + run.maxSeconds, run.acceptedExpiry, leash.expiry, BigInt(row.input.deadline)].reduce((a, b) => a < b ? a : b);
    return { id: row.id, owner, agent, reserved: true as const, leaseUntil: new Date(Number(until) * 1000),
      paidPrice: { leaseSeconds: row.quote.maxSeconds, cpuPricePerSecond: row.quote.pricePerSecond, fixedInferencePrice: row.quote.inferencePrice },
      ...(row.input.task.kind === 'session' ? { resourceProfile: row.input.task.resourceProfile ?? 'full' } : {}) };
  }
  async function confirmedCharge(row: RunRow) {
    const binding = platformVaultBindingSchema.parse(row.vaultBinding);
    await rowBinding(row, binding.owner.toLowerCase(), binding.agentWallet.toLowerCase());
    await checkedQuote(row);
    if (row.status !== 'completed' || !row.admissionTx || !row.settlement || row.settlement.runId !== row.id
      || !row.settlementTx || !row.vaultSyncTx || row.charged === null || row.refund === null) throw paidBillingUnavailable();
    const final = await runtime.get(row.owner, row.id);
    if (final.status !== 'completed' || final.charged !== row.charged || final.refund !== row.refund) throw paidBillingUnavailable();
    await vaults.verifyHistoricalAdmission(binding, row.quote, row.ceiling, bytes32Schema.parse(row.admissionTx),
      signatureSchema.parse(row.signature), row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)));
    const settled = await bridge.confirmedSettlement(platformSettlementSchema.parse(row.settlement), bytes32Schema.parse(row.settlementTx));
    const synced = await vaults.verifyFinalizedBurn(binding, row.id, bytes32Schema.parse(row.vaultSyncTx));
    if (synced.refunded || synced.charged !== settled.charged || settled.charged !== row.charged || settled.refund !== row.refund
      || BigInt(row.charged) + BigInt(row.refund) !== BigInt(row.ceiling)) throw paidBillingUnavailable();
    const [settlementReceipt, syncReceipt] = await Promise.all([bridge.canonicalReceipt(settled.transactionHash), bridge.canonicalReceipt(synced.transactionHash)]);
    if (syncReceipt.blockNumber < settlementReceipt.blockNumber) throw paidBillingUnavailable();
    const block = await bridge.public.getBlock({ blockNumber: syncReceipt.blockNumber });
    if (block.hash !== syncReceipt.blockHash || block.timestamp > BigInt(Math.floor(Date.now() / 1000))) throw paidBillingUnavailable();
    // The Selection paidAt event, rather than a delayed sync time, defines the rolling burn window.
    return { amount: synced.charged, at: new Date(Number(BigInt(synced.paidAt)) * 1000), provenance: {
      transactionHash: syncReceipt.transactionHash, blockNumber: syncReceipt.blockNumber.toString(), blockHash: syncReceipt.blockHash } };
  }
  const { refreshBilling } = createCanonicalAgentBilling(db, bridge, { ensureReady: scope.ensureReady,
    pending: async (owner, agent) => {
      const binding = await resolve(owner, agent);
      return (await db.select({ run: platformRuns }).from(platformRuns)
        .leftJoin(agentBilling, and(eq(agentBilling.owner, owner), eq(agentBilling.receiptId, platformRuns.id)))
        .where(and(eq(platformRuns.owner, binding.vault.toLowerCase()), isNotNull(platformRuns.vaultBinding),
          eq(platformRuns.status, 'completed'), isNull(agentBilling.receiptId)))
        .orderBy(asc(platformRuns.createdAt), asc(platformRuns.id)).limit(101)).map(row => row.run);
    }, confirm: confirmedCharge,
    append: (owner, agent, row, charge) => lifecycle.appendSettledCharge(owner, agent, row.id, charge.amount, charge.at, charge.provenance) });
  const metabolismPricing = createPaidMetabolismReader(runtime, {
    balanceAt: async (owner, agent, blockNumber) => {
      const binding = await resolve(owner, agent);
      return (await bridge.public.readContract({ address: binding.vault, abi: platformVaultAbi,
        functionName: 'spendableBalance', blockNumber })).toString();
    },
    original: async (owner, agent, currentRunId) => {
      const binding = await resolve(owner, agent);
      return (await db.select().from(platformRuns).where(and(eq(platformRuns.owner, binding.vault.toLowerCase()),
        isNotNull(platformRuns.vaultBinding), currentRunId ? eq(platformRuns.id, currentRunId) : isNotNull(platformRuns.admissionTx)))
        .orderBy(desc(platformRuns.createdAt), desc(platformRuns.id)).limit(1))[0];
    },
    verify: async (owner, agent, row) => {
      const binding = await rowBinding(row, owner, agent); await checkedQuote(row);
      if (!row.admissionTx) throw paidBillingUnavailable();
      await vaults.verifyHistoricalAdmission(binding, row.quote, row.ceiling, bytes32Schema.parse(row.admissionTx),
        signatureSchema.parse(row.signature), row.imageProof.map(value => bytes32Schema.parse(value)),
        row.regionProof.map(value => bytes32Schema.parse(value)));
    },
  });
  lifecycle = new AgentLifecycleService(db, { cysts, leasePolicy: 'paid_cpu', ensureReady: scope.ensureReady, metabolismPricing,
    now: () => new Date(Date.now()), refreshBilling, reservedRun: reservation,
    balance: async (owner, agent) => { const binding = await resolve(owner, agent); return (await vaults.balance(binding.vault)).available; },
    prepareRegistration: async (owner, agent) => {
      const binding = normalized(await resolve(owner, agent, true));
      return { async commit(tx, existing) {
        const [saved] = await tx.select().from(agentVaultBindings).where(and(eq(agentVaultBindings.owner, owner), eq(agentVaultBindings.agent, agent)));
        if (saved ? hashJson(saved) !== hashJson(binding) : existing) throw paidBillingUnavailable();
        if (!saved) await tx.insert(agentVaultBindings).values(binding);
      } };
    } });
  return { agents: lifecycle, initialize: scope.ensureReady, scope: { ...scope.scope,
    ownerPayersOnly: false as const, agentVaultsOnly: true as const, registry: vaults.config.registryAddress.toLowerCase(),
    maximumLeaseSeconds: 120 as const, rollBeforeSeconds: 30 as const },
    async maintain(): Promise<void> {
      await scope.ensureReady();
      const pending = await db.selectDistinct({ owner: agents.owner, agent: agents.agent }).from(agents)
        .innerJoin(agentVaultBindings, and(eq(agentVaultBindings.owner, agents.owner), eq(agentVaultBindings.agent, agents.agent)))
        .innerJoin(platformRuns, eq(platformRuns.owner, agentVaultBindings.vault))
        .leftJoin(agentBilling, and(eq(agentBilling.owner, agents.owner), eq(agentBilling.receiptId, platformRuns.id)))
        .leftJoin(agentBillingProvenance, and(eq(agentBillingProvenance.owner, agents.owner), eq(agentBillingProvenance.receiptId, platformRuns.id)))
        .where(and(eq(platformRuns.status, 'completed'), isNotNull(platformRuns.vaultBinding),
          or(isNull(agentBilling.receiptId), isNull(agentBillingProvenance.validatedAnchorHash)),
          maintenanceAfter ? or(gt(agents.owner, maintenanceAfter.owner), and(eq(agents.owner, maintenanceAfter.owner), gt(agents.agent, maintenanceAfter.agent))) : undefined))
        .orderBy(asc(agents.owner), asc(agents.agent)).limit(100);
      maintenanceAfter = pending.at(-1);
      let failed = false;
      for (const row of pending) { try { await refreshBilling(row.owner, row.agent); } catch { failed = true; } }
      if (failed) throw paidBillingUnavailable();
    } };
}
