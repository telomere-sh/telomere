import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import type { Logger } from 'pino';
import type { Database } from '../store.js';
import { Problem, addressSchema, bytes32Schema, hashJson, randomId, sameAddress, signatureSchema } from '../common.js';
import { MAX_HOUR_RECEIPTS, receiptPair } from '../receipts/merkle.js';
import { capacityIdentity, selectCapacity } from '../scheduling/planner.js';
import { assertPaidCpuCleanup } from '../scheduling/paid-cleanup.js';
import { paidCpuReliability } from '../scheduling/paid-reliability.js';
import { assertCpuLaneOffers, cpuLaneOffer } from '../scheduling/cpu-offers.js';
import { paidCpuJobs } from '../scheduling/paid-job-schema.js';
import { paidCpuJobIntentHash, paidCpuJobQuoteKey, paidCpuJobSchema } from '../scheduling/paid-job-types.js';
import { RunMeter } from '../runtime/meter.js';
import { sessionCommandSchema, sessionEventSchema, type SessionEvent } from '../host-kit/sessions/types.js';
import { validateCpuResult } from '../runtime/validation.js';
import type { CpuRunResult } from '../runtime/types.js';
import { ProviderRequestRejectedError, type NearCompletionResult, type NearProvider } from '../providers/near.js';
import { getNearProviderReadiness } from '../providers/readiness.js';
import { validateRecoveredNearResult } from '../providers/recovery.js';
import { PlatformBridge } from './bridge.js';
import { PlatformHostExecutor } from './host-executor.js';
import type { PlatformVaultBinding, PlatformVaultBridge } from './vault.js';
import { platformHostLeases, platformRuns, platformSignerLock, platformX402Challenges } from './schema.js';
import { platformReceiptEntries } from '../receipts/platform-schema.js';
import { agents, agentIntents, agentRuntimeBinding } from '../agents/schema.js';
import type { PlatformV2PublishedEvidenceReader } from '../receipts/platform-v2-publication.js';
import { PLATFORM_ZERO, platformAdmissionSchema, platformEscrowAbi, platformHostSchema, validatedPlatformQuoteInputSchema,
  platformNearConfigSchema, platformNearRequestHash, platformNearRequestUser, platformSettlementSchema, platformWorkloadHash,
  platformX402RequestSchema, platformX402ChallengeSchema,
  type PlatformHost, type PlatformNearConfig, type PlatformPrepared, type PlatformQuote, type PlatformQuoteInput, type PlatformSettlement } from './types.js';
import { readSpendPermissionFunding, spendPermissionHash, spendPermissionLeashTermsHash } from '../payments/spend-permissions.js';
import { readX402CpuFunds, validateX402CpuPayment, verifyX402CpuPayment, x402CpuPaymentSchema, x402CpuRequired, x402ReservationSchema,
  type X402CpuReservation } from '../payments/cpu-reservations.js';
import { canonical, challengeIdentity, requestBinding } from '../payments/protocol.js';
import type { PaidCystInputRuntimeScope } from './paid-cyst-input.js';

export interface PlatformReceiptPort {
  record(owner: string, settlement: PlatformSettlement): Promise<unknown>;
  publishClosed(): Promise<unknown>;
  publish(hour: number): Promise<unknown>;
  proof(owner: string, runId: string): Promise<{ hour: number; leaf: Hex; root: Hex; proof: Hex[]; transactionHash: Hex } | undefined>;
}
type Row = typeof platformRuns.$inferSelect;
type X402Draft = Pick<X402CpuReservation, 'challengeId' | 'scheme' | 'resourceUrl' | 'requestHash' | 'salt'>;
/** Optional one-shot CPU issuer. The original version is frozen at quote creation. */
export interface PlatformV2ReceiptPort {
  readonly minConfirmations?: number;
  readonly publishedEvidence?: Pick<PlatformV2PublishedEvidenceReader, 'retrieve'>;
  initialize(): Promise<void>;
  prepare(row: Row, result: CpuRunResult, draft: Omit<PlatformSettlement, 'receiptHash'>): Promise<PlatformSettlement>;
  assertPublished(row: Row): Promise<void>;
  assertReadable?(row: Row): Promise<void>;
}
export type PlatformNearRuntime = Readonly<{ provider: NearProvider; config: PlatformNearConfig;
  billingOperator: Hex; maxProviderSeconds: number }>;
// Must match the reviewed PlatformRunEscrow.MAX_RUN_CEILING. The contract remains
// authoritative at openRun; preselection avoids choosing an unopenable host.
const MAX_PLATFORM_RUN_CEILING = 250_000_000n;
/** Paid CPU and one-shot NEAR inference paths. Owner signatures/payment are never performed by the controller. */
export class PlatformRuntimeService {
  private readonly hosts: PlatformHost[];
  private queue: Promise<unknown> = Promise.resolve();
  private running: { id: string; abort: AbortController } | undefined;
  private closing = false;
  private ready = false;
  private readonly near?: PlatformNearRuntime;
  private readonly cystInputsEnabled: boolean;
  constructor(readonly db: Database, readonly bridge: PlatformBridge, hosts: readonly PlatformHost[],
    private readonly executor: PlatformHostExecutor, private readonly receipts: PlatformReceiptPort,
    readonly vaults?: PlatformVaultBridge, near?: PlatformNearRuntime,
    private readonly v2Receipts?: PlatformV2ReceiptPort, options: { cystInputsEnabled?: boolean } = {}) {
    this.cystInputsEnabled = options.cystInputsEnabled === true;
    if (bridge.pins.spendPermissionProfile && (vaults || v2Receipts)) {
      throw new Error('Spend permission domain3 requires the EOA CPU receipt-v1 runtime; Vault and CPUv2 profiles are unsupported');
    }
    if (bridge.pins.x402CpuProfile && (vaults || v2Receipts || near)) throw new Error('X402 CPU domain4 requires an EOA one-shot CPU receipt-v1 runtime');
    this.hosts = hosts.map(host => platformHostSchema.parse(host));
    this.hosts.forEach(assertCpuLaneOffers);
    if (!this.hosts.length || this.hosts.length > 16 || new Set(this.hosts.map(host => host.hostId)).size !== this.hosts.length) {
      throw new Error('Platform runtime requires one to sixteen distinct reviewed CPU hosts');
    }
    if (this.hosts.some(host => host.imageDigest !== host.image.split('@')[1])) throw new Error('Platform host image digest differs from its reviewed image');
    if (this.hosts.some(host => host.sessionPrices && (host.sessionEnabled !== true || host.sessionPrices.full !== host.pricePerSecond))) {
      throw new Error('CPU profile prices require a reviewed session host and its unchanged full price');
    }
    if (this.hosts.some(host => host.lane === 'interruptible' && (!host.interruptible || host.sessionEnabled !== true))) {
      throw new Error('Interruptible CPU requires a reviewed paid-session host and explicit preemption capability');
    }
    if (near) {
      if (!Number.isInteger(near.maxProviderSeconds) || near.maxProviderSeconds < 1 || near.maxProviderSeconds > 120) {
        throw new Error('Platform NEAR provider deadline must be bounded');
      }
      this.near = { provider: near.provider, config: Object.freeze(platformNearConfigSchema.parse(near.config)),
        billingOperator: addressSchema.parse(near.billingOperator), maxProviderSeconds: near.maxProviderSeconds };
    }
  }
  publicConfig() { return { protocol: 'telomere-platform-v1' as const, pins: this.bridge.pins, maxSeconds: 120 as const, feeBps: 900 as const,
    capacity: this.hosts.map(({ hostId, hardwareClass, region, imageDigest, lane, pricePerSecond, execEnabled, sessionEnabled, sessionPrices, interruptible, cystInputMaxBytes, laneOffers }) =>
      ({ hostId, hardwareClass, region, imageDigest, lane, pricePerSecond, ...(execEnabled === true ? { execEnabled: true as const } : {}),
        ...(sessionEnabled === true ? { sessionEnabled: true as const } : {}),
        ...(sessionPrices ? { sessionPrices } : {}), ...(interruptible ? { interruptible } : {}), ...(laneOffers ? { laneOffers } : {}),
        ...(this.cystInputsEnabled && cystInputMaxBytes !== undefined ? { cystInputMaxBytes } : {}) })),
    ...(this.near ? { near: this.near.config, nearInferenceTask: 'near_inference' as const } : {}),
    ...(this.v2Receipts ? { cpuReceiptVersion: 2 as const } : {}) }; }
  balance(owner: string) { return this.bridge.balance(owner); }
  publicV2EvidenceReader() { return this.v2Receipts?.publishedEvidence; }
  publicV2ConfirmationDepth() { return this.v2Receipts?.minConfirmations ?? 12; }
  async cpuLaneAttribution(runId: Hex) {
    const [row] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, runId)).limit(1);
    if (!row) return null;
    if (hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== row.quote.workloadHash) {
      throw new Problem(409, 'platform_price_board_lane_changed', 'Original controller lane attribution changed.');
    }
    return { lane: row.input.cpuScheduling?.lane ?? 'standard' as const,
      hostId: row.quote.hostId, workloadHash: row.quote.workloadHash };
  }
  private host(id: string) { const host = this.hosts.find(value => value.hostId === id); if (!host) throw new Error('Original reviewed platform host is unavailable'); return host; }
  private offeredHost(host: PlatformHost, lane: 'standard' | 'interruptible'): PlatformHost | undefined {
    const offer = cpuLaneOffer(host, lane);
    if (!offer) return undefined;
    // Missing profile rates/capabilities must not fall back to another lane's terms.
    const { sessionPrices: _prices, interruptible: _preemption, ...physical } = host;
    return { ...physical, ...offer };
  }
  private offers(host: PlatformHost): PlatformHost[] {
    return (host.laneOffers?.offers.map(offer => offer.lane) ?? [host.lane]).map(lane => this.offeredHost(host, lane)!);
  }
  private sessionPrice(host: PlatformHost, input: PlatformQuoteInput): string | undefined {
    if (input.task.kind !== 'session') return host.pricePerSecond;
    const profile = input.task.resourceProfile ?? 'full';
    return profile === 'full' ? host.pricePerSecond : host.sessionPrices?.[profile];
  }
  private idem(value: string) { if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(value)) throw new Problem(422, 'idempotency_required', 'Use a bounded unique Idempotency-Key.'); }
  private async row(owner: string, runId: string): Promise<Row> {
    const [row] = await this.db.select().from(platformRuns).where(and(eq(platformRuns.owner, addressSchema.parse(owner).toLowerCase()),
      eq(platformRuns.id, bytes32Schema.parse(runId)))).limit(1);
    if (!row) throw new Problem(404, 'platform_run_not_found', 'Platform run was not found.'); return row;
  }
  /** Original immutable quote for an authorized owner-side job. No admission or funding. */
  async preparedQuote(owner: string, runId: string) { return this.prepared(await this.row(owner, runId)); }
  async cpuQuoteLiability(owner: string, runId: string): Promise<string> {
    const row = await this.row(owner, runId);
    if (row.status !== 'prepared' || row.admissionTx) return row.ceiling;
    // An unadmitted signed quote remains a liability while it can still be
    // funded, or while an earlier payment may be waiting for HTTP admission.
    const head = await this.bridge.public.getBlockNumber({ cacheTime: 0 }), depth = this.bridge.pins.chainId === 31337 ? 0n : 12n;
    if (head < depth) return row.ceiling;
    const block = await this.bridge.public.getBlock({ blockNumber: head - depth });
    if (block.timestamp <= BigInt(row.quote.quoteExpiry)) return row.ceiling;
    const run = await this.bridge.public.readContract({ address: this.bridge.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'getRun', args: [bytes32Schema.parse(row.id)], blockNumber: block.number });
    const canonical = await this.bridge.public.getBlock({ blockNumber: block.number });
    return canonical.hash === block.hash && run.status === 0 ? '0' : row.ceiling;
  }
  /** Canonical financial finality plus retained original HostKit cleanup. */
  async paidCpuSource(owner: string, runId: string) {
    const row = await this.auditFinal(await this.row(owner, runId));
    if (row.status !== 'completed' || !row.settlement || !row.settlementTx || !row.admissionTx
      || row.charged === null || row.refund === null || BigInt(row.charged) + BigInt(row.refund) !== BigInt(row.ceiling)
      || row.input.task.kind !== 'session' || row.input.near || !row.vaultBinding
      || hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== row.quote.workloadHash) {
      throw new Problem(409, 'paid_cpu_source_pending', 'The original paid CPU source requires canonical settlement before replacement.');
    }
    const { result } = await this.terminalSession(row), evidence = await this.sessionLease(owner, runId);
    const [retained] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id));
    if (!retained) throw new Problem(409, 'paid_cpu_cleanup_unconfirmed', 'Original paid CPU cleanup is unavailable.');
    const terminalTick = assertPaidCpuCleanup({ ...retained, controllerKey: evidence.controllerKey,
      hostKey: evidence.lease.body.hostKey, billableSeconds: result.billableSeconds });
    return { row, terminalTick, controllerEvidence: 'retained-hostkit-cleanup' as const };
  }
  async cpuReliability(hostId: string, lane: 'standard' | 'interruptible', now = 0) {
    const until = now || await this.bridge.now(), from = Math.max(0, until - 30 * 86400);
    const rows = await this.db.select().from(platformRuns).where(and(eq(platformRuns.status, 'completed'),
      sql`${platformRuns.quote}->>'hostId' = ${hostId}`,
      sql`coalesce(${platformRuns.input}->'cpuScheduling'->>'lane','standard') = ${lane}`,
      sql`(${platformRuns.settlement}->>'endedAt')::bigint >= ${from}`,
      sql`(${platformRuns.settlement}->>'endedAt')::bigint <= ${until}`)).limit(2001);
    if (rows.length > 2000) throw new Problem(503, 'paid_cpu_reliability_limit', 'Verified thirty-day CPU history requires operator archival.');
    const records: { hostId: string; lane: 'standard' | 'interruptible'; endedAt: number; cleanOutcome: boolean }[] = [];
    let excluded = 0;
    for (const row of rows) {
      if (row.quote.hostId !== hostId || (row.input.cpuScheduling?.lane ?? 'standard') !== lane
        || row.input.task.kind !== 'session' || row.input.near || row.status === 'refunded') continue;
      try {
        const verified = await this.paidCpuSource(row.owner, row.id);
        records.push({ hostId, lane, endedAt: verified.row.settlement!.endedAt,
          cleanOutcome: verified.row.result!.status !== 'failed' });
      } catch { excluded++; }
    }
    return paidCpuReliability(hostId, lane, until, records, excluded);
  }
  /** Finite reviewed CPU offers only; every new quote repeats chain/slot/budget checks. */
  async paidCpuCatalogue(binding: PlatformVaultBinding, raw: PlatformQuoteInput,
    lanes: ('standard' | 'interruptible')[]) {
    const input = validatedPlatformQuoteInputSchema.parse(raw), now = await this.bridge.now();
    this.assertNewCystInputEnabled(input);
    this.assertCystInputScope(input, binding);
    if (input.task.kind !== 'session' || !this.vaults) throw new Problem(422, 'paid_cpu_job_scope', 'Paid CPU planning requires a reviewed Vault session.');
    await this.vaults.checkBinding(binding);
    const leash = await this.bridge.leash(input.leashId);
    if (!sameAddress(leash.owner, binding.vault) || input.leashId !== binding.leashId || leash.killed || leash.sealedOnly
      || !(leash.classMask & 1n) || BigInt(input.deadline) > leash.expiry || !await this.vaults.runnable(binding)
      || await this.logicalAgentKilled(binding.vault, binding.agentWallet, binding)) {
      throw new Problem(409, 'platform_leash_inactive', 'The original Vault and Leash must permit CPU work.');
    }
    const available = BigInt((await this.vaults.balance(binding.vault)).available);
    const capacity = [], chargeCeilings = [];
    for (const configured of this.hosts.flatMap(host => this.offers(host))) {
      if (!lanes.includes(configured.lane) || input.excludedHostIds?.includes(configured.hostId)
        || input.task.cystInput && (configured.cystInputMaxBytes ?? 0) < input.task.cystInput.plaintextBytes
        || configured.sessionEnabled !== true || configured.imageDigest !== input.task.imageDigest
        || input.regions.length && !input.regions.includes(configured.region)
        || configured.lane === 'interruptible' && (!configured.interruptible || input.maxSeconds <= 30)) continue;
      const pricePerSecond = this.sessionPrice(configured, input);
      if (!pricePerSecond) continue;
      const host = await this.bridge.host(configured.hostId);
      if (!host.active || host.unbondAt || host.kind === 2 || host.hostKey !== configured.hostKey) continue;
      const allow = (root: Hex, value: Hex, proof: Hex[]) => root === PLATFORM_ZERO || proof.reduce((node, sibling) => receiptPair(node, sibling),
        keccak256(keccak256(`0x${value.slice(2)}`))) === root;
      if (!allow(leash.imageAllowRoot, keccak256(toHex(configured.imageDigest)), configured.imageProof)
        || !allow(leash.regionAllowRoot, keccak256(toHex(configured.region)), configured.regionProof)) continue;
      const base = BigInt(pricePerSecond) * BigInt(input.maxSeconds);
      if (!base || base > MAX_PLATFORM_RUN_CEILING) continue;
      const ceiling = base + await this.bridge.fee(base, false);
      if (ceiling > MAX_PLATFORM_RUN_CEILING || ceiling > BigInt(input.maxSpend) || ceiling > available
        || leash.spentHour + leash.pending + ceiling > leash.maxPerHour || leash.spentDay + leash.pending + ceiling > leash.maxPerDay) continue;
      try { if (!await this.executor.capacityAvailable(configured, 'session', input.task.cystInput?.plaintextBytes)) continue; } catch { continue; }
      const reliability = await this.cpuReliability(configured.hostId, configured.lane, now);
      const row = { hostId: configured.hostId, hardwareClass: 'cpu' as const, region: configured.region,
        imageDigest: configured.imageDigest, sealed: false, lane: configured.lane, pricePerSecond,
        reliabilityBps: reliability.reliabilityBps, strikes: host.strikes, stake: host.collateral.toString(), availableAt: configured.availableAt };
      capacity.push(row); chargeCeilings.push({ capacityId: capacityIdentity(row), ceiling: ceiling.toString() });
    }
    const weights = this.bridge.pins.financialProfile ? await this.bridge.schedulingWeights([...new Set(capacity.map(row => row.hostId))]) : undefined;
    return { capacity, options: { chargeCeilings, ...(weights ? { schedulingWeights: weights.map(({ hostId, schedulingWeight }) =>
      ({ hostId, schedulingWeight })) } : {}) }, now };
  }
  private prepared(row: Row): PlatformPrepared {
    if (row.x402Funding) throw new Problem(409, 'platform_x402_original_challenge', 'Retain the original CPU payment challenge; a balance-funded plan cannot replace it.');
    if (hashJson(row.input) !== row.inputHash || row.input.excludedHostIds?.includes(row.quote.hostId)) {
      throw new Problem(409, 'platform_quote_scope_changed', 'The stored quote differs from its original host selection.');
    }
    return { input: row.input, quote: row.quote, signature: signatureSchema.parse(row.signature),
    ...(row.receiptVersion === 2 ? { receiptVersion: 2 as const } : {}),
    ceiling: row.ceiling, imageProof: row.imageProof.map(value => bytes32Schema.parse(value)), regionProof: row.regionProof.map(value => bytes32Schema.parse(value)),
    ...(row.input.funding ? { fundingReview: { kind: 'base_spend_permission_v1' as const,
      fundingAccount: row.input.funding.permission.account, refundBeneficiary: row.quote.payer, reservationCeiling: row.ceiling,
      permissionHash: spendPermissionHash(this.bridge.pins.chainId, this.bridge.pins.spendPermissionProfile!.managerAddress, row.input.funding.permission),
      managerAddress: this.bridge.pins.spendPermissionProfile!.managerAddress } } : {}),
    transaction: row.vaultBinding ? this.requireVaults().openPlan(row.vaultBinding, row.quote, signatureSchema.parse(row.signature),
      row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)))
      : this.bridge.openPlan(row.quote, signatureSchema.parse(row.signature), row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)), row.input.funding?.permission) };
  }
  private requireVaults(): PlatformVaultBridge {
    if (!this.vaults) throw new Problem(503, 'platform_vault_unavailable', 'The original reviewed Vault configuration is required.');
    return this.vaults;
  }
  private payerBalance(owner: string, binding?: PlatformVaultBinding | null) {
    return binding ? this.requireVaults().balance(binding.vault) : this.balance(owner);
  }
  private async quoteFunds(owner: string, input: PlatformQuoteInput, binding?: PlatformVaultBinding | null, x402?: X402Draft) {
    if (x402) return readX402CpuFunds(this.bridge.public, this.bridge.pins, owner, x402.scheme);
    if (!input.funding) return this.payerBalance(owner, binding);
    if (binding || !this.bridge.pins.spendPermissionProfile) throw new Problem(422, 'platform_funding_unsupported', 'Spend permission funding requires its reviewed EOA domain3 deployment.');
    try { return await readSpendPermissionFunding(this.bridge.public, this.bridge.pins, owner, input.leashId, input.funding); }
    catch { throw new Problem(409, 'platform_funding_unavailable', 'Original smart-account approval, period funds or refund-beneficiary Leash scope is unavailable.'); }
  }
  private async logicalAgentKilled(owner: string, agent: string, binding?: PlatformVaultBinding | null): Promise<boolean> {
    const [scope] = await this.db.select().from(agentRuntimeBinding).where(eq(agentRuntimeBinding.id, 1)).limit(1);
    if (!scope || scope.protocol !== (binding ? 'platform_vault' : 'platform')
      || scope.chainId !== this.bridge.pins.chainId || !sameAddress(scope.escrow, this.bridge.pins.escrowAddress)
      || !sameAddress(scope.token, this.bridge.pins.tokenAddress)) return false;
    const [registered] = await this.db.select({ killedAt: agents.killedAt }).from(agents).where(and(
      eq(agents.owner, (binding?.owner ?? owner).toLowerCase()),
      eq(agents.agent, (binding?.agentWallet ?? agent).toLowerCase()))).limit(1);
    if (registered?.killedAt) return true;
    return (await this.db.select({ id: agentIntents.id }).from(agentIntents).where(and(
      eq(agentIntents.owner, (binding?.owner ?? owner).toLowerCase()),
      eq(agentIntents.agent, (binding?.agentWallet ?? agent).toLowerCase()),
      eq(agentIntents.kind, 'kill'), ne(agentIntents.phase, 'done'))).limit(1)).length > 0;
  }
  private async cpuJob(input: PlatformQuoteInput, owner: string) {
    const reference = input.cpuScheduling?.job;
    if (!reference) return undefined;
    const [row] = await this.db.select().from(paidCpuJobs).where(and(eq(paidCpuJobs.id, reference.jobId),
      eq(paidCpuJobs.vault, owner.toLowerCase()))).limit(1);
    if (!row) throw new Problem(409, 'paid_cpu_job_scope_changed', 'The original owner-approved CPU job is unavailable.');
    const state = paidCpuJobSchema.parse(row.state);
    if (state.intentHash !== reference.intentHash || state.intentHash !== paidCpuJobIntentHash(state.id,
      state.binding, state.input, state.createdAt, this.bridge.pins)) {
      throw new Problem(409, 'paid_cpu_job_scope_changed', 'The owner-approved CPU job, chain or quote linkage changed.');
    }
    return state;
  }
  private async assertNewCpuJobQuote(input: PlatformQuoteInput, owner: string, key: string) {
    const state = await this.cpuJob(input, owner), scheduling = input.cpuScheduling;
    if (!state || !scheduling?.job) return;
    const replacement = scheduling.job.decisionHash, proposal = state.proposal;
    if (state.phase !== (replacement ? 'approved' : 'preparing') || key !== paidCpuJobQuoteKey(state.id, replacement)
      || input.leashId !== state.input.leashId || hashJson(input.task) !== hashJson(state.input.task)
      || input.deadline !== state.input.deadline || hashJson(input.regions) !== hashJson(state.input.regions)
      || !state.input.lanes.includes(scheduling.lane)
      || scheduling.lane === 'interruptible' && hashJson(scheduling.interruptibleConsent) !== hashJson(state.input.interruptibleConsent)
      || !replacement && (input.maxSeconds !== state.input.workSeconds || input.maxSpend !== state.input.maxSpend || input.excludedHostIds)
      || replacement && (!proposal || state.approvalHash !== replacement || proposal.decisionHash !== replacement
        || scheduling.job.sourceRunId !== proposal.sourceRunId || scheduling.job.sourceQuoteHash !== proposal.sourceQuoteHash
        || scheduling.job.targetHostId !== proposal.target.hostId || scheduling.lane !== proposal.target.lane
        || input.maxSeconds !== proposal.reservationSeconds || input.maxSpend !== proposal.remainingBudget
        || hashJson(input.excludedHostIds) !== hashJson([proposal.sourceHostId]))) {
      throw new Problem(409, 'paid_cpu_job_approval_changed', 'New paid CPU work must match its exact durable owner approval.');
    }
  }
  private async cpuJobAllowsExecution(row: Row): Promise<boolean> {
    const state = await this.cpuJob(row.input, row.owner);
    return !state || state.phase !== 'cancelled' && state.currentRunId === row.id && state.runIds.includes(bytes32Schema.parse(row.id));
  }
  async quote(ownerValue: string, raw: unknown, idemKey: string, binding?: PlatformVaultBinding): Promise<PlatformPrepared> {
    return this.prepared(await this.prepareRow(ownerValue, raw, idemKey, binding));
  }
  private async prepareRow(ownerValue: string, raw: unknown, idemKey: string, binding?: PlatformVaultBinding, x402?: X402Draft): Promise<Row> {
    if (!this.ready || this.closing) throw new Problem(503, 'platform_not_ready', 'Platform recovery must complete before preparing new work.');
    this.idem(idemKey); const owner = addressSchema.parse(ownerValue), input = validatedPlatformQuoteInputSchema.parse(raw), inputHash = hashJson(input);
    this.assertNewCystInputEnabled(input);
    this.assertCystInputScope(input, binding);
    if (x402) this.assertX402Scope(input, binding);
    if (input.funding && (binding || !this.bridge.pins.spendPermissionProfile)) throw new Problem(422, 'platform_funding_unsupported', 'Spend permission funding cannot bypass Vault bookkeeping or use an older deployment.');
    if (this.v2Receipts && (input.task.kind === 'session' || input.near && input.task.kind !== 'near_inference')) {
      throw new Problem(422, 'platform_v2_cpu_scope', 'These hosts support one-shot CPU evidence; use a separate reviewed route for paid sessions or CPU plus inference.');
    }
    if (binding) {
      if (this.v2Receipts) {
        const factory = this.bridge.pins.financialProfile?.discountVaultRegistry, configured = this.requireVaults().config;
        if (!factory || !sameAddress(factory.address, configured.registryAddress) || factory.codeHash !== configured.registryCodeHash
          || !sameAddress(factory.implementationAddress, configured.implementationAddress)
          || factory.implementationCodeHash !== configured.implementationCodeHash) {
          throw new Problem(503, 'platform_v2_vault_scope', 'CPU v2 Vault payments require the independently reviewed factory and implementation pins.');
        }
      }
      await this.requireVaults().checkBinding(binding);
      if (!sameAddress(owner, binding.vault) || input.leashId !== binding.leashId
        || !await this.requireVaults().runnable(binding)) throw new Problem(409, 'platform_vault_inactive', 'The original Vault and Leash must permit new work.');
    }
    const [prior] = await this.db.select().from(platformRuns).where(and(eq(platformRuns.owner, owner.toLowerCase()), eq(platformRuns.idemKey, idemKey)));
    if (prior) {
      if (!!prior.x402Funding !== !!x402 || x402 && (!prior.x402Funding || prior.x402Funding.challengeId !== x402.challengeId
        || prior.x402Funding.requestHash !== x402.requestHash || prior.x402Funding.salt !== x402.salt || prior.x402Funding.scheme !== x402.scheme
        || prior.x402Funding.resourceUrl !== x402.resourceUrl)) throw new Problem(409, 'platform_funding_method_changed', 'The original reservation funding method is immutable.');
      if (prior.inputHash !== inputHash || hashJson(prior.vaultBinding) !== hashJson(binding ?? null)) throw new Problem(409, 'idempotency_conflict', 'This key belongs to different work.');
      if (await this.logicalAgentKilled(prior.owner, prior.agent, prior.vaultBinding)) throw new Problem(409, 'agent_killed', 'The owner permanently stopped this registered agent.');
      if ((await this.cpuJob(prior.input, prior.owner))?.phase === 'cancelled') throw new Problem(409, 'paid_cpu_job_cancelled', 'The owner cancelled this CPU job.');
      return prior;
    }
    await this.assertNewCpuJobQuote(input, owner, idemKey);
    let nearPolicyUntil: number | undefined;
    if (input.near) {
      const configured = this.near?.config, requested = input.near;
      if (!configured || requested.model !== configured.model || requested.maxTokens !== configured.maxTokens
        || requested.policySha256 !== configured.policySha256) {
        throw new Problem(503, 'platform_near_unavailable', 'The original reviewed NEAR model and policy are unavailable.');
      }
      if (input.maxSeconds < this.near!.maxProviderSeconds + (input.task.kind === 'near_inference' ? 5 : 15)) {
        throw new Problem(422, 'platform_near_window',
          'Verified NEAR inference requires a bounded provider request within the original paid reservation.');
      }
      const readiness = await getNearProviderReadiness(this.near?.provider);
      nearPolicyUntil = readiness.policyExpiresAt ? Math.floor(Date.parse(readiness.policyExpiresAt) / 1000) : undefined;
      if (readiness.state !== 'ready' || readiness.verification !== 'enclave_verified'
        || nearPolicyUntil === undefined || !Number.isSafeInteger(nearPolicyUntil)) {
        throw new Problem(503, 'platform_near_unavailable', 'Verified NEAR inference is unavailable under the reviewed policy.');
      }
    }
    await this.bridge.check();
    const now = await this.bridge.now(), leash = await this.bridge.leash(input.leashId);
    if (!sameAddress(leash.owner, owner) || leash.killed || leash.expiry <= BigInt(now) || (leash.classMask & 1n) === 0n || leash.sealedOnly) {
      throw new Problem(409, 'platform_leash_inactive', 'An active owner-controlled CPU Leash is required.');
    }
    if (now + input.maxSeconds > input.deadline || BigInt(input.deadline) > leash.expiry) throw new Problem(409, 'deadline_infeasible', 'The run cannot fit its deadline and Leash expiry.');
    const owned = await this.db.select({ id: platformRuns.id }).from(platformRuns).where(and(eq(platformRuns.owner, owner.toLowerCase()),
      inArray(platformRuns.status, ['prepared', 'queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'reconciliation']),
      or(ne(platformRuns.status, 'prepared'), sql`(${platformRuns.quote}->>'quoteExpiry')::bigint >= ${now}`))).limit(65);
    if (owned.length >= 64) throw new Problem(429, 'platform_run_limit', 'Resolve existing platform work before adding more.');
    if ((await this.db.select({ id: platformRuns.id }).from(platformRuns).where(inArray(platformRuns.status,
      ['queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'reconciliation'])).limit(256)).length >= 256) {
      throw new Problem(429, 'platform_capacity_limit', 'The bounded platform recovery inventory is full.');
    }
    if (await this.logicalAgentKilled(owner, leash.agent, binding)) throw new Problem(409, 'agent_killed', 'The owner permanently stopped this registered agent.');
    const candidates: PlatformHost[] = []; let nearOperatorMismatch = false;
    for (const candidate of this.hosts.flatMap(host => this.offers(host))) {
      if (candidate.lane !== (input.cpuScheduling?.lane ?? 'standard')) continue;
      if (input.cpuScheduling?.job?.targetHostId && candidate.hostId !== input.cpuScheduling.job.targetHostId) continue;
      if (candidate.lane === 'interruptible' && (!candidate.interruptible || !input.cpuScheduling?.interruptibleConsent
        || input.task.kind !== 'session' || !binding)) continue;
      if (input.excludedHostIds?.includes(candidate.hostId)) continue;
      if (input.task.kind === 'exec' && (candidate.execEnabled !== true || candidate.imageDigest !== input.task.imageDigest)) continue;
      if (input.task.kind === 'session' && (candidate.sessionEnabled !== true || candidate.imageDigest !== input.task.imageDigest)) continue;
      if (input.task.kind === 'session' && input.task.cystInput && (candidate.cystInputMaxBytes ?? 0) < input.task.cystInput.plaintextBytes) continue;
      const offeredPrice = this.sessionPrice(candidate, input);
      if (offeredPrice === undefined) continue;
      const host = await this.bridge.host(candidate.hostId);
      if (!host.active || host.unbondAt !== 0n || host.kind === 2 || host.hostKey !== candidate.hostKey) continue;
      const imageHash = keccak256(toHex(candidate.imageDigest)), regionHash = keccak256(toHex(candidate.region));
      const allow = (root: Hex, value: Hex, proof: Hex[]) => root === PLATFORM_ZERO || proof.reduce((node, sibling) => receiptPair(node, sibling),
        keccak256(keccak256(`0x${value.slice(2)}`))) === root;
      if (!allow(leash.imageAllowRoot, imageHash, candidate.imageProof) || !allow(leash.regionAllowRoot, regionHash, candidate.regionProof)) continue;
      // Current escrow pays the entire CPU+inference base to HostRegistry.operator.
      if (input.near && !sameAddress(host.operator, this.near!.billingOperator)) { nearOperatorMismatch = true; continue; }
      candidates.push({ ...candidate, pricePerSecond: offeredPrice, strikes: host.strikes, stake: host.collateral.toString() });
    }
    if (!candidates.length) throw nearOperatorMismatch
      ? new Problem(503, 'platform_near_operator_mismatch', 'The reviewed host does not receive the NEAR inference payout.')
      : new Problem(409, 'deadline_infeasible', 'No admitted CPU host meets the Leash scope.');
    const available = BigInt((await this.quoteFunds(owner, input, binding, x402)).available);
    const budgeted: PlatformHost[] = [];
    const chargeCeilings = new Map<string, string>();
    for (const candidate of candidates) {
      const base = BigInt(candidate.pricePerSecond) * BigInt(input.maxSeconds)
        + BigInt(input.near ? this.near!.config.inferencePrice : '0');
      // quoteFee accepts uint96, while a schema-valid price multiplied by time
      // can overflow it. Zero base is rejected by the escrow as well.
      if (base === 0n || base > MAX_PLATFORM_RUN_CEILING) continue;
      const complete = base + await this.bridge.fee(base, false);
      if (complete <= MAX_PLATFORM_RUN_CEILING && complete <= BigInt(input.maxSpend) && complete <= available
        && leash.spentHour + leash.pending + complete <= leash.maxPerHour
        && leash.spentDay + leash.pending + complete <= leash.maxPerDay) {
        budgeted.push(candidate); chargeCeilings.set(capacityIdentity(candidate), complete.toString());
      }
    }
    if (!budgeted.length) throw new Problem(409, 'platform_budget_exceeded', 'The complete CPU ceiling including its platform fee exceeds available funds or budget.');
    // A signed, nonce-bound HostKit answer prevents new quotes to hosts already known
    // to be unavailable. It is only a placement hint: admission still owns the slot.
    const kind = input.task.kind === 'session' ? 'session' : 'one_shot';
    const probed = await Promise.all(budgeted.map(async candidate => {
      // An inference-only run uses this registered host only as the reviewed payout operator.
      // No HostKit CPU slot or lease is admitted for this task.
      if (input.task.kind === 'near_inference') return true;
      try { return await this.executor.capacityAvailable(candidate, kind, input.task.kind === 'session' ? input.task.cystInput?.plaintextBytes : undefined); } catch { return false; }
    }));
    const live = budgeted.filter((_, index) => probed[index]);
    if (!live.length) throw new Problem(503, 'platform_host_unavailable', 'No reviewed CPU host currently confirms free capacity.');
    // The planner accepts its strict capacity boundary, not private host transport and allowlist fields.
    const weights = this.bridge.pins.financialProfile ? await this.bridge.schedulingWeights(live.map(host => host.hostId)) : undefined;
    const reliability = await Promise.all(live.map(host => this.cpuReliability(host.hostId, host.lane, now)));
    const capacity = live.map(({ hostId, hardwareClass, region, imageDigest, sealed, lane, pricePerSecond, strikes, stake, availableAt }, index) =>
      ({ hostId, hardwareClass, region, imageDigest, sealed, lane, pricePerSecond, reliabilityBps: reliability[index]!.reliabilityBps,
        strikes: weights?.find(row => row.hostId === hostId)?.strikes ?? strikes, stake, availableAt }));
    const placement = selectCapacity({ hardwareClasses: ['cpu'], regions: input.regions, images: live.map(host => host.imageDigest),
      sealedOnly: false, lanes: [input.cpuScheduling?.lane ?? 'standard'], seconds: input.maxSeconds, maxSpend: input.maxSpend, deadline: input.deadline, now }, capacity,
      { chargeCeilings: capacity.map(row => ({ capacityId: capacityIdentity(row), ceiling: chargeCeilings.get(capacityIdentity(row))! })),
        ...(weights ? { schedulingWeights: weights.map(({ hostId, schedulingWeight }) => ({ hostId, schedulingWeight })) } : {}) });
    const selected = this.offeredHost(this.host(placement.host.hostId), placement.host.lane)!;
    const quote: PlatformQuote = { runId: randomId(), leashId: input.leashId, hostId: selected.hostId, payer: owner, hwClass: 0,
      regionHash: keccak256(toHex(selected.region)), imageHash: keccak256(toHex(selected.imageDigest)), workloadHash: platformWorkloadHash(input),
      maxSeconds: input.maxSeconds, pricePerSecond: placement.host.pricePerSecond,
      inferencePrice: input.near ? this.near!.config.inferencePrice : '0',
      quoteExpiry: Math.min(now + 120, input.deadline - input.maxSeconds, Number(leash.expiry) - input.maxSeconds,
        nearPolicyUntil === undefined ? Number.MAX_SAFE_INTEGER : nearPolicyUntil - input.maxSeconds) };
    if (quote.quoteExpiry <= now) throw new Problem(503, 'platform_near_unavailable', 'The reviewed NEAR policy expires before this reservation can finish.');
    await this.bridge.publicationReady(quote.quoteExpiry + quote.maxSeconds);
    const ceiling = await this.bridge.ceiling(quote, false);
    if (ceiling > MAX_PLATFORM_RUN_CEILING || ceiling > BigInt(input.maxSpend)
      || leash.spentHour + leash.pending + ceiling > leash.maxPerHour
      || leash.spentDay + leash.pending + ceiling > leash.maxPerDay || BigInt((await this.quoteFunds(owner, input, binding, x402)).available) < ceiling) {
      throw new Problem(409, 'platform_budget_exceeded', 'The complete CPU ceiling including its platform fee exceeds available funds or budget.');
    }
    const signature = await this.bridge.signQuote(quote);
    await this.db.transaction(async tx => {
      // Quote requests can race while the execution queue is busy. Enforce active quote limits atomically.
      if ((await tx.select().from(platformSignerLock).where(eq(platformSignerLock.id, 1)).for('update')).length !== 1) throw new Error('Platform runtime lock is unavailable');
      if ((await tx.select({ id: platformRuns.id }).from(platformRuns).where(and(eq(platformRuns.owner, owner.toLowerCase()), eq(platformRuns.idemKey, idemKey)))).length) return;
      const active = await tx.select({ id: platformRuns.id }).from(platformRuns).where(and(eq(platformRuns.owner, owner.toLowerCase()),
        inArray(platformRuns.status, ['prepared', 'queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'reconciliation']),
        or(ne(platformRuns.status, 'prepared'), sql`(${platformRuns.quote}->>'quoteExpiry')::bigint >= ${now}`))).limit(64);
      if (active.length >= 64) throw new Problem(429, 'platform_run_limit', 'Resolve existing platform work before adding more.');
      await tx.insert(platformRuns).values({ id: quote.runId, owner: owner.toLowerCase(), agent: leash.agent.toLowerCase(), idemKey, inputHash,
        input, quote, signature, ceiling: ceiling.toString(), imageProof: selected.imageProof, regionProof: selected.regionProof,
        vaultBinding: binding ?? null, status: 'prepared',
        ...(x402 ? { x402Funding: x402ReservationSchema.parse({ ...x402, leashTermsHash: spendPermissionLeashTermsHash(leash),
          maximum: x402.scheme === 'exact' ? ceiling.toString() : (BigInt(input.maxSpend) < MAX_PLATFORM_RUN_CEILING ? input.maxSpend : MAX_PLATFORM_RUN_CEILING.toString()),
          validAfter: Math.max(0, now - 1), validBefore: quote.quoteExpiry }) } : {}),
        receiptVersion: this.v2Receipts && !input.near && input.task.kind !== 'near_inference' && input.task.kind !== 'session' ? 2 : 1 }).onConflictDoNothing();
    });
    const [stored] = await this.db.select().from(platformRuns).where(and(eq(platformRuns.owner, owner.toLowerCase()), eq(platformRuns.idemKey, idemKey)));
    if (!stored || stored.inputHash !== inputHash || hashJson(stored.vaultBinding) !== hashJson(binding ?? null)) throw new Problem(409, 'idempotency_conflict', 'This key belongs to different work.');
    if (!!stored.x402Funding !== !!x402 || x402 && stored.x402Funding?.challengeId !== x402.challengeId) throw new Problem(409, 'platform_funding_method_changed', 'The original reservation funding method is immutable.');
    return stored;
  }
  private assertX402Scope(input: PlatformQuoteInput, binding?: PlatformVaultBinding) {
    if (!this.bridge.pins.x402CpuProfile || binding || this.vaults || this.v2Receipts || this.near || input.funding || input.near
      || input.task.kind === 'near_inference' || input.task.kind === 'session' || input.cpuScheduling) throw new Problem(422, 'platform_x402_scope',
      'This explicit x402 reservation extension supports EOA one-shot CPU receipt-v1 work only.');
  }
  private assertCystInputScope(input: PlatformQuoteInput, binding?: PlatformVaultBinding) {
    if (input.task.kind !== 'session' || !input.task.cystInput) return;
    const descriptor = input.task.cystInput;
    if (!binding || this.v2Receipts || input.near || descriptor.agentId !== binding.agentId
      || !sameAddress(descriptor.checkpoint.owner, binding.owner) || !sameAddress(descriptor.checkpoint.agent, binding.agentWallet)) {
      throw new Problem(422, 'platform_cyst_input_scope', 'Declared Cyst input requires its original Vault agent and CPU receipt-v1 session.');
    }
  }
  private assertNewCystInputEnabled(input: PlatformQuoteInput) {
    if (input.task.kind === 'session' && input.task.cystInput && !this.cystInputsEnabled) throw new Problem(503,
      'platform_cyst_input_disabled', 'New declared-file CPU reservations require the reviewed file-ingress runtime.');
  }
  private x402Prepared(row: Row) {
    const reservation = x402ReservationSchema.parse(row.x402Funding);
    if (hashJson(row.input) !== row.inputHash || row.receiptVersion !== 1 || row.vaultBinding || row.input.funding
      || platformWorkloadHash(row.input) !== row.quote.workloadHash || row.input.excludedHostIds?.includes(row.quote.hostId)) throw new Problem(409, 'platform_x402_original_scope', 'The original CPU payment scope changed.');
    return platformX402ChallengeSchema.parse({ input: row.input, quote: row.quote, signature: row.signature, ceiling: row.ceiling,
      imageProof: row.imageProof, regionProof: row.regionProof, reservation,
      disclosure: { extension: 'telomere-cpu-reservation-v1', immediateDebit: row.ceiling, refundBeneficiary: row.quote.payer,
        unusedFunds: 'escrow_balance_withdrawable_by_original_eoa', externalWalletGas: true, receiptVersion: 1 },
      paymentRequired: x402CpuRequired(this.bridge.pins, row.quote, row.ceiling, reservation) });
  }
  /** Durable original challenge is retained even after expiry or uncertain external submission. */
  async x402Challenge(ownerValue: string, raw: unknown, idemKey: string, resourceUrl: string) {
    const owner = addressSchema.parse(ownerValue).toLowerCase(), request = platformX402RequestSchema.parse(raw);
    this.idem(idemKey); this.assertX402Scope(request.input);
    const url = new URL(resourceUrl);
    if (url.username || url.password || url.hash || url.search || url.pathname !== '/api/platform/cells'
      || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('X402 CPU requires its fixed trusted resource URL');
    const inputHash = hashJson(request), requestHash = requestBinding('POST', url.href, Buffer.from(canonical(request)));
    const challenge = await this.db.transaction(async tx => {
      await tx.select().from(platformSignerLock).where(eq(platformSignerLock.id, 1)).for('update');
      const [prior] = await tx.select().from(platformX402Challenges).where(and(eq(platformX402Challenges.owner, owner), eq(platformX402Challenges.idemKey, idemKey))).limit(1);
      if (prior) {
        if (prior.inputHash !== inputHash || prior.requestHash !== requestHash || prior.resourceUrl !== url.href || prior.scheme !== request.scheme) throw new Problem(409, 'idempotency_conflict', 'This key retains a different original CPU payment request.');
        return prior;
      }
      const [collision] = await tx.select({ id: platformRuns.id }).from(platformRuns).where(and(eq(platformRuns.owner, owner), eq(platformRuns.idemKey, idemKey))).limit(1);
      if (collision) throw new Problem(409, 'platform_funding_method_changed', 'This key already retains a balance-funded reservation.');
      const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(platformX402Challenges);
      if (!count || count.total >= 4096) throw new Problem(503, 'platform_x402_capacity', 'The durable CPU payment challenge inventory is full.');
      const [owned] = await tx.select({ total: sql<number>`count(*)::integer` }).from(platformX402Challenges).where(eq(platformX402Challenges.owner, owner));
      // Includes failed, never-exposed drafts. One authenticated owner cannot
      // consume the shared immutable inventory by submitting invalid jobs.
      if (!owned || owned.total >= 64) throw new Problem(429, 'platform_x402_owner_capacity', 'This owner must retain and reconcile its bounded original CPU payment challenges.');
      const identity = challengeIdentity();
      const [created] = await tx.insert(platformX402Challenges).values({ id: identity.id, owner, idemKey, inputHash, requestHash,
        resourceUrl: url.href, scheme: request.scheme, salt: identity.nonce }).returning();
      if (!created) throw new Error('CPU payment challenge insert failed'); return created;
    });
    const row = await this.prepareRow(owner, request.input, idemKey, undefined, { challengeId: challenge.id, scheme: challenge.scheme,
      resourceUrl: challenge.resourceUrl, requestHash: bytes32Schema.parse(challenge.requestHash), salt: bytes32Schema.parse(challenge.salt) });
    await this.db.update(platformX402Challenges).set({ runId: row.id }).where(and(eq(platformX402Challenges.id, challenge.id),
      or(sql`${platformX402Challenges.runId} IS NULL`, eq(platformX402Challenges.runId, row.id))));
    return this.x402Prepared(row);
  }
  async x402Intent(owner: string, runId: string, rawPayment: unknown) {
    const row = await this.row(owner, runId), challenge = this.x402Prepared(row), payment = x402CpuPaymentSchema.parse(rawPayment);
    const [retained] = await this.db.select().from(platformX402Challenges).where(eq(platformX402Challenges.id, challenge.reservation.challengeId)).limit(1);
    const checked = await validateX402CpuPayment(this.bridge.pins, row.quote, signatureSchema.parse(row.signature),
      row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)), row.ceiling, challenge.reservation, payment);
    const paymentHash = hashJson(payment), intentHash = keccak256(checked);
    if (retained?.paymentHash || retained?.intentHash) {
      if (retained.runId !== row.id || retained.owner !== row.owner || retained.paymentHash !== paymentHash || retained.intentHash !== intentHash) throw new Problem(409, 'platform_x402_intent_conflict', 'The original CPU payment intent is immutable.');
      // This is an original wallet intent, never a claim that its nonce is still
      // spendable or that an unknown external transaction successfully paid.
      await this.auditFinal(row);
      return { challenge, paymentHash, state: 'retained_external_wallet_intent' as const, transaction: this.bridge.plan(checked) };
    }
    if (row.status !== 'prepared') throw new Problem(409, 'platform_x402_already_admitted', 'Retain the original admitted reservation and transaction hash.');
    const data = await verifyX402CpuPayment(this.bridge.public, this.bridge.pins, row.quote, signatureSchema.parse(row.signature),
      row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)), row.ceiling, challenge.reservation, payment);
    await this.db.transaction(async tx => {
      await tx.select().from(platformSignerLock).where(eq(platformSignerLock.id, 1)).for('update');
      const [original] = await tx.select().from(platformX402Challenges).where(eq(platformX402Challenges.id, challenge.reservation.challengeId)).limit(1);
      if (!original || original.runId !== row.id || original.owner !== row.owner || original.paymentHash && original.paymentHash !== paymentHash
        || original.intentHash && original.intentHash !== intentHash) throw new Problem(409, 'platform_x402_intent_conflict', 'The first original CPU payment intent is immutable.');
      await tx.update(platformX402Challenges).set({ paymentHash, intentHash }).where(eq(platformX402Challenges.id, original.id));
    });
    return { challenge, paymentHash, state: 'external_wallet_required' as const, transaction: this.bridge.plan(data) };
  }
  async admit(owner: string, raw: unknown, idemKey: string) {
    return this.exclusive(async () => {
    this.idem(idemKey); if (!this.ready || this.closing) throw new Problem(503, 'platform_not_ready', 'Platform execution is unavailable.');
    const input = platformAdmissionSchema.parse(raw), row = await this.row(owner, input.runId);
    if (row.status !== 'prepared') {
      if (row.admissionTx !== input.transactionHash) throw new Problem(409, 'platform_admission_conflict', 'The original reservation is immutable.');
      return this.get(owner, row.id);
    }
    this.assertNewCystInputEnabled(row.input);
    const job = await this.cpuJob(row.input, row.owner);
    if (job && job.phase !== 'cancelled' && (!job.runIds.includes(bytes32Schema.parse(row.id)) || job.currentRunId !== row.id)) {
      throw new Problem(409, 'paid_cpu_job_quote_pending', 'Recover the exact owner job quote before admitting its external payment.');
    }
    await this.bridge.check();
    if (row.vaultBinding) {
      await this.requireVaults().checkBinding(row.vaultBinding);
      await this.requireVaults().verifyAdmission(row.vaultBinding, row.quote, row.ceiling, input.transactionHash,
        signatureSchema.parse(row.signature), row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)));
    } else if (row.x402Funding) {
      const [original] = await this.db.select().from(platformX402Challenges).where(eq(platformX402Challenges.id, row.x402Funding.challengeId)).limit(1);
      if (!original || original.runId !== row.id || original.owner !== row.owner || !original.paymentHash || !original.intentHash) throw new Problem(409, 'platform_x402_intent_missing', 'The original external wallet intent must be retained before admission.');
      await this.bridge.verifyAdmission(row.quote, row.ceiling, input.transactionHash, null,
        { reservation: row.x402Funding, intentHash: bytes32Schema.parse(original.intentHash) });
    } else await this.bridge.verifyAdmission(row.quote, row.ceiling, input.transactionHash, row.input.funding ?? null);
    if (!row.vaultBinding) {
      const original = await this.bridge.openingLeash(row.quote, input.transactionHash);
      if (!sameAddress(original.owner, addressSchema.parse(row.owner)) || original.agent.toLowerCase() !== row.agent) {
        throw new Problem(409, 'platform_agent_changed', 'The Leash agent changed before the original run opened.');
      }
    }
    const leash = await this.bridge.leash(row.quote.leashId);
    if (leash.agent.toLowerCase() !== row.agent) throw new Problem(409, 'platform_agent_changed', 'The Leash agent changed after quote preparation.');
    if (await this.logicalAgentKilled(row.owner, row.agent, row.vaultBinding)) throw new Problem(409, 'agent_killed', 'The owner permanently stopped this registered agent. Retain the original reservation for refund.');
    if ((await this.db.select({ id: platformRuns.id }).from(platformRuns).where(inArray(platformRuns.status,
      ['queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'reconciliation'])).limit(256)).length >= 256) {
      throw new Problem(429, 'platform_capacity_limit', 'The bounded platform recovery inventory is full; retain the original reservation for later admission or refund.');
    }
    if ((await this.db.select({ id: platformRuns.id }).from(platformRuns).where(and(eq(platformRuns.owner, row.owner),
      inArray(platformRuns.status, ['queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'reconciliation']))).limit(64)).length >= 64) {
      throw new Problem(429, 'platform_run_limit', 'The owner recovery inventory is full; retain the original reservation for later admission or refund.');
    }
    const run = await this.bridge.run(row.quote.runId), now = await this.bridge.now();
    await this.bridge.publicationReady(now + row.quote.maxSeconds);
    if (leash.killed || run.stopAt || now + row.quote.maxSeconds > row.input.deadline || BigInt(now) >= run.acceptedExpiry) {
      const cutoff = Math.min(now, row.input.deadline, Number(run.acceptedExpiry), run.stopAt ? Number(run.stopAt) : now,
        leash.killed ? Number(leash.killedAt) : now);
      if (await this.bridge.hourPublished(Math.floor(cutoff / 3600))) {
        throw new Problem(409, 'platform_admission_late', 'The stopped or expired reservation belongs to an immutable published hour; use its original timeout refund.');
      }
    }
    await this.db.update(platformRuns).set({ admissionTx: input.transactionHash, status: 'queued', updatedAt: new Date() })
      .where(and(eq(platformRuns.id, row.id), eq(platformRuns.status, 'prepared')));
    return this.get(owner, row.id);
    });
  }
  async list(owner: string) {
    const rows = await this.db.select().from(platformRuns).where(eq(platformRuns.owner, addressSchema.parse(owner).toLowerCase()))
      .orderBy(asc(platformRuns.createdAt)).limit(128);
    const checked: Row[] = [];
    for (const row of rows) checked.push(await this.auditFinal(row));
    return { runs: await Promise.all(checked.map(row => this.dto(row))) };
  }
  private async visibleNear(row: Row): Promise<NearCompletionResult | null> {
    if (!row.input.near || !row.nearResult || !row.settlement
      || row.settlement.inferenceCharge !== row.quote.inferencePrice
      || !['receipt_pending', 'settling', 'completed'].includes(row.status)) return null;
    const near = await this.checkedNear(row, row.nearResult);
    if (!row.result || Date.parse(near.evidence.receivedAt) >= (row.settlement.endedAt + 1) * 1000) {
      throw new Error('Platform NEAR result arrived after its charged settlement');
    }
    const [lease] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id));
    const receiptHash = hashJson({ protocol: 'telomere-platform-receipt-v1', chainId: this.bridge.pins.chainId,
      escrow: this.bridge.pins.escrowAddress, quote: row.quote, endedAt: row.settlement.endedAt,
      billableSeconds: row.settlement.billableSeconds, output: row.result.output, status: row.result.status,
      ticks: row.result.ticks, hostLeaseHash: lease?.leaseHash ?? null,
      ...(row.input.task.kind === 'near_inference' ? { executionKind: 'near_inference' } : {}),
      nearEvidenceHash: hashJson(near), inferenceCharge: row.settlement.inferenceCharge });
    if (receiptHash !== row.settlement.receiptHash) throw new Error('Platform NEAR result differs from the committed receipt');
    return near;
  }
  private async dto(row: Row) { const nearResult = await this.visibleNear(row);
    const neverDispatched = row.input.task.kind === 'session' && row.admissionTx
      && ['completed', 'refunded'].includes(row.status) && row.charged === '0' && row.refund === row.ceiling
      && (!row.settlement || row.settlement.billableSeconds === 0)
      && !(await this.db.select({ runId: platformHostLeases.runId }).from(platformHostLeases)
        .where(eq(platformHostLeases.runId, row.id)).limit(1)).length;
    return { id: bytes32Schema.parse(row.id), status: row.status, quote: row.quote, ceiling: row.ceiling,
    admissionTx: row.admissionTx ? bytes32Schema.parse(row.admissionTx) : null,
    settlementTx: row.settlementTx ? bytes32Schema.parse(row.settlementTx) : null, result: row.result, settlement: row.settlement,
    charged: row.charged, refund: row.refund, errorCode: row.errorCode,
    ...(neverDispatched ? { cpuDispatch: { state: 'never_dispatched' as const, confirmed: true as const,
      admissionTx: bytes32Schema.parse(row.admissionTx!) } } : {}),
    ...(this.bridge.pins.financialProfile && row.admissionTx
      ? { feeDiscountBps: await this.bridge.feeDiscountBps(bytes32Schema.parse(row.id)) } : {}),
    ...(row.input.near ? { nearResult } : {}),
    ...(row.input.task.kind === 'near_inference' ? { executionKind: 'near_inference' as const } : {}) }; }
  async get(owner: string, runId: string) { return this.dto(await this.auditFinal(await this.row(owner, runId))); }
  /** Authenticated read-only evidence for the original fixed-policy paid lease.
   * No new HostKit action, payment or application command is issued. */
  async sessionLease(owner: string, runId: string) {
    const row = await this.auditFinal(await this.row(owner, runId));
    if (!row.vaultBinding || row.input.task.kind !== 'session' || !row.admissionTx) {
      throw new Problem(404, 'platform_session_lease_missing', 'Original Vault-paid session lease is unavailable.');
    }
    await this.requireVaults().verifyHistoricalAdmission(row.vaultBinding, row.quote, row.ceiling,
      bytes32Schema.parse(row.admissionTx), signatureSchema.parse(row.signature),
      row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)));
    return this.executor.originalSessionLease(row.owner, this.host(row.quote.hostId), row.id,
      { quoteHash: hashJson(row.quote), admissionTx: bytes32Schema.parse(row.admissionTx),
        maxCommands: row.input.task.maxCommands });
  }
  async authorizeCystInput(owner: string, runId: string, live: boolean): Promise<PaidCystInputRuntimeScope> {
    const row = await this.row(owner, runId);
    if (live) this.assertNewCystInputEnabled(row.input);
    if (!row.vaultBinding || row.receiptVersion !== 1 || row.input.task.kind !== 'session' || !row.input.task.cystInput || row.input.near || !row.admissionTx) {
      throw new Problem(409, 'platform_cyst_input_scope', 'The original declared Vault-paid Cyst session is required.');
    }
    this.assertCystInputScope(row.input, row.vaultBinding);
    if (hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== row.quote.workloadHash) throw new Problem(409, 'platform_workload_changed', 'The original declared Cyst workload changed.');
    const host = this.host(row.quote.hostId), descriptor = row.input.task.cystInput;
    if ((host.cystInputMaxBytes ?? 0) < descriptor.plaintextBytes || host.sealed || host.sessionEnabled !== true) throw new Problem(409, 'platform_cyst_input_host', 'The original host no longer permits this declared file size.');
    await this.sessionLease(owner, runId);
    if (live) {
      const current = await this.row(owner, runId);
      if (!this.ready || this.closing || current.status !== 'running') throw new Problem(409, 'platform_session_inactive', 'The original paid session is not running.');
      const [run, leash, now, runnable] = await Promise.all([this.bridge.run(bytes32Schema.parse(row.id)), this.bridge.leash(row.quote.leashId),
        this.bridge.now(), this.requireVaults().runnable(row.vaultBinding)]);
      if (!this.bridge.matches(row.quote, run) || run.status !== 1 || run.ceiling.toString() !== row.ceiling || run.stopAt || leash.killed || !runnable
        || !await this.cpuJobAllowsExecution(row) || await this.logicalAgentKilled(row.owner, row.agent, row.vaultBinding)
        || now >= row.input.deadline || BigInt(now) >= run.acceptedExpiry || BigInt(now) >= run.openedAt + run.maxSeconds) throw new Problem(409, 'platform_session_inactive', 'The original paid reservation no longer permits this file operation.');
    }
    return { owner: row.owner, runId: row.id, host, descriptor, binding: row.vaultBinding,
      expected: { quoteHash: hashJson(row.quote), admissionTx: bytes32Schema.parse(row.admissionTx), maxCommands: row.input.task.maxCommands } };
  }
  /** Post-admission owner opt-in changes only host stop policy. It cannot
   * alter the signed quote, payer, price, duration or original lease. */
  async preemptionOptIn(owner: string, runId: string, key: string) {
    this.idem(key);
    const row = await this.auditFinal(await this.row(owner, runId));
    if (!row.vaultBinding || row.input.task.kind !== 'session' || !row.admissionTx) {
      throw new Problem(409, 'platform_session_inactive', 'An admitted Vault-paid session is required for preemption opt-in.');
    }
    const evidence = { quoteHash: hashJson(row.quote), admissionTx: bytes32Schema.parse(row.admissionTx),
      maxCommands: row.input.task.maxCommands };
    if (row.status !== 'running') {
      // HostKit itself permits only the same previously stored nonce after
      // cleanup. This read-through recovers a lost owner acknowledgment; it
      // cannot create a new post-terminal opt-in.
      if (!['receipt_pending', 'settling', 'completed'].includes(row.status)) {
        throw new Problem(409, 'platform_session_inactive', 'The original Vault-paid session has no opt-in to replay.');
      }
      await this.requireVaults().verifyHistoricalAdmission(row.vaultBinding, row.quote, row.ceiling,
        evidence.admissionTx, signatureSchema.parse(row.signature),
        row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)));
      return this.executor.optInPreemption(row.owner, this.host(row.quote.hostId), row.id, evidence, key);
    }
    await this.requireVaults().verifyAdmission(row.vaultBinding, row.quote, row.ceiling,
      bytes32Schema.parse(row.admissionTx), signatureSchema.parse(row.signature),
      row.imageProof.map(value => bytes32Schema.parse(value)), row.regionProof.map(value => bytes32Schema.parse(value)));
    const [run, leash, now, runnable] = await Promise.all([this.bridge.run(bytes32Schema.parse(row.id)),
      this.bridge.leash(row.quote.leashId), this.bridge.now(), this.requireVaults().runnable(row.vaultBinding)]);
    if (!this.bridge.matches(row.quote, run) || run.status !== 1 || run.stopAt || leash.killed || !runnable
      || now >= row.input.deadline || BigInt(now) >= run.acceptedExpiry) {
      throw new Problem(409, 'platform_session_inactive', 'The original Vault-paid session no longer permits opt-in.');
    }
    return this.executor.optInPreemption(row.owner, this.host(row.quote.hostId), row.id, evidence, key);
  }
  async preemptionNotice(owner: string, runId: string) {
    const row = await this.row(owner, runId);
    if (!row.vaultBinding || row.input.task.kind !== 'session' || !row.admissionTx) {
      throw new Problem(404, 'platform_session_lease_missing', 'Original Vault-paid session lease is unavailable.');
    }
    await this.sessionLease(owner, runId);
    return this.executor.preemptionNotice(row.owner, this.host(row.quote.hostId), row.id,
      { quoteHash: hashJson(row.quote), admissionTx: bytes32Schema.parse(row.admissionTx),
        maxCommands: row.input.task.maxCommands });
  }
  private async terminalSession(row: Row) {
    if (!row.result || !row.settlement || !['receipt_pending', 'settling', 'completed', 'refunded'].includes(row.status)) {
      throw new Problem(409, 'platform_session_inactive', 'This paid session has no final host outcome.');
    }
    if (hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== row.quote.workloadHash) {
      throw new Problem(409, 'platform_workload_changed', 'The original signed session workload changed.');
    }
    if (row.status === 'completed' || row.status === 'refunded') {
      const audited = await this.auditFinal(row);
      if (audited.status !== row.status) {
        throw new Problem(409, 'platform_session_unavailable', 'Paid session finality requires reconciliation.');
      }
    }
    const [lease] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id));
    if (!lease?.cleanupConfirmed || !lease.sessionEvents) {
      throw new Problem(409, 'platform_session_unavailable', 'Paid session terminal history is unavailable.');
    }
    let result: CpuRunResult, settlement: PlatformSettlement, history: SessionEvent[];
    try {
      result = validateCpuResult(row.result, row.id, row.quote.maxSeconds);
      settlement = platformSettlementSchema.parse(row.settlement);
      history = sessionEventSchema.array().max(4096).parse(lease.sessionEvents);
    } catch {
      throw new Problem(409, 'platform_session_history_changed', 'Paid session outcome, settlement or event history changed.');
    }
    if (settlement.runId !== row.id || settlement.billableSeconds > result.billableSeconds
      || history.some((event, index) => event.sequence !== index) || history.at(-1)?.kind !== 'session_exit'
      || hashJson({ protocol: 'telomere-paid-session-events-v1', events: history }) !== result.output) {
      throw new Problem(409, 'platform_session_history_changed', 'Paid session events differ from the durable host outcome.');
    }
    const expectedReceipt = hashJson({ protocol: 'telomere-platform-receipt-v1', chainId: this.bridge.pins.chainId,
      escrow: this.bridge.pins.escrowAddress, quote: row.quote, endedAt: settlement.endedAt,
      billableSeconds: settlement.billableSeconds, output: result.output, status: result.status,
      ticks: result.ticks, hostLeaseHash: lease.leaseHash });
    if (expectedReceipt !== settlement.receiptHash) {
      throw new Problem(409, 'platform_session_history_changed', 'Paid session receipt differs from its durable outcome.');
    }
    return { result, history };
  }
  /** Each interactive command rechecks the original on-chain paid reservation and owner scope. */
  async command(owner: string, runId: string, raw: unknown) {
    const command = sessionCommandSchema.parse(raw), row = await this.row(owner, runId);
    if (row.input.task.kind !== 'session' || !row.admissionTx) {
      throw new Problem(409, 'platform_session_inactive', 'This paid session is not active.');
    }
    if (hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== row.quote.workloadHash) {
      throw new Problem(409, 'platform_workload_changed', 'The original signed session workload changed.');
    }
    if (row.status !== 'running') {
      const { result } = await this.terminalSession(row);
      return this.executor.replayCommand(row.owner, this.host(row.quote.hostId), row.id, command,
        { eventHash: result.output, quoteHash: hashJson(row.quote), admissionTx: row.admissionTx });
    }
    if (!this.ready || this.closing) {
      throw new Problem(503, 'platform_not_ready', 'Paid session recovery is incomplete.');
    }
    const [run, leash, now, runnable] = await Promise.all([this.bridge.run(bytes32Schema.parse(row.id)), this.bridge.leash(row.quote.leashId),
      this.bridge.now(), row.vaultBinding ? this.requireVaults().runnable(row.vaultBinding) : Promise.resolve(true)]);
    if (!this.bridge.matches(row.quote, run) || run.status !== 1 || run.ceiling.toString() !== row.ceiling
      || run.stopAt || leash.killed || !runnable || !await this.cpuJobAllowsExecution(row)
      || now >= row.input.deadline || BigInt(now) >= run.acceptedExpiry) {
      throw new Problem(409, 'platform_session_inactive', 'The paid reservation or Leash no longer permits commands.');
    }
    return this.executor.command(row.id, command);
  }
  async sessionEvents(owner: string, runId: string, afterSequence = -1, limit = 8) {
    if (!Number.isInteger(afterSequence) || afterSequence < -1 || afterSequence > 4095
      || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Problem(422, 'platform_event_cursor', 'Invalid session event cursor.');
    const row = await this.row(owner, runId);
    if (row.input.task.kind !== 'session' || !row.admissionTx) throw new Problem(409, 'platform_session_inactive', 'This is not an admitted paid session.');
    if (row.status === 'running') {
      if (!this.ready || this.closing) throw new Problem(503, 'platform_not_ready', 'Paid session recovery is incomplete.');
      return this.executor.events(row.id, afterSequence, limit);
    }
    const { result, history } = await this.terminalSession(row);
    const events = history.slice(afterSequence + 1, afterSequence + 1 + limit);
    return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence,
      eventCount: history.length, state: result.status };
  }
  private async auditFinal(row: Row): Promise<Row> {
    if (this.needsOriginalOpeningGuard(row) && row.admissionTx) {
      try { await this.verifyOriginalOpening(row); }
      catch {
        const [updated] = await this.db.update(platformRuns).set({ status: 'reconciliation', charged: null, refund: null,
          errorCode: 'platform_original_funding_uncertain', updatedAt: new Date() }).where(eq(platformRuns.id, row.id)).returning();
        return updated ?? row;
      }
    }
    if (row.status !== 'completed' && row.status !== 'refunded') return row;
    try {
      if (row.id !== row.quote.runId) throw new Error('Final platform quote belongs to a different reservation');
      if (row.input.near && row.settlement?.inferenceCharge === row.quote.inferencePrice
        && !await this.visibleNear(row)) throw new Error('Charged NEAR result is unavailable');
      const run = await this.bridge.run(row.quote.runId);
      if (!this.bridge.matches(row.quote, run) || run.ceiling.toString() !== row.ceiling) throw new Error('Final platform reservation changed');
      if (row.status === 'completed') {
        if (row.receiptVersion === 2) await this.requireV2Publication(row);
        if (run.status !== 2 || !row.settlement || row.settlement.runId !== row.id
          || !row.settlementTx || !await this.receipts.proof(row.owner, row.id)) throw new Error('Final platform proof is unavailable');
        const settled = await this.bridge.confirmedSettlement(row.settlement, bytes32Schema.parse(row.settlementTx));
        if (settled.charged !== row.charged || settled.refund !== row.refund) throw new Error('Final platform accounting changed');
      } else if (run.status !== 3 || row.charged !== '0' || row.refund !== row.ceiling) throw new Error('Final platform refund changed');
      if (row.vaultBinding && row.vaultSyncTx) {
        try { await this.requireVaults().verifyFinalized(row.vaultBinding, row.id, bytes32Schema.parse(row.vaultSyncTx)); }
        catch {
          const [updated] = await this.db.update(platformRuns).set({ vaultSyncTx: null,
            errorCode: 'platform_vault_sync_uncertain', updatedAt: new Date() }).where(eq(platformRuns.id, row.id)).returning();
          return updated ?? row;
        }
      }
      return row;
    } catch {
      const [updated] = await this.db.update(platformRuns).set({ status: 'reconciliation', charged: null, refund: null,
        vaultSyncTx: null, errorCode: 'platform_finality_uncertain', updatedAt: new Date() }).where(and(eq(platformRuns.id, row.id), eq(platformRuns.status, row.status))).returning();
      return updated ?? await this.row(row.owner, row.id);
    }
  }
  private needsOriginalOpeningGuard(row: Row) {
    return !row.vaultBinding && !!(row.x402Funding || row.input.funding || this.bridge.pins.spendPermissionProfile || this.bridge.pins.x402CpuProfile);
  }
  private async verifyOriginalOpening(row: Row) {
    if (!row.admissionTx) throw new Error('Original funded CPU opening is unavailable');
    if (!row.x402Funding) return this.bridge.verifyOriginalOpening(row.quote,row.ceiling,bytes32Schema.parse(row.admissionTx),row.input.funding ?? null);
    const [original] = await this.db.select().from(platformX402Challenges).where(eq(platformX402Challenges.id,row.x402Funding.challengeId)).limit(1);
    if (!original || original.owner !== row.owner || original.runId !== row.id || !original.paymentHash || !original.intentHash) throw new Error('Original x402 CPU intent journal is unavailable');
    await this.bridge.verifyOriginalOpening(row.quote,row.ceiling,bytes32Schema.parse(row.admissionTx),null,
      {reservation:row.x402Funding,intentHash:bytes32Schema.parse(original.intentHash)});
  }
  private async syncVault(row: Row): Promise<void> {
    if (!row.vaultBinding || !['completed', 'refunded'].includes(row.status)) return;
    try {
      const vaults = this.requireVaults();
      await vaults.checkBinding(row.vaultBinding);
      let synced;
      try { synced = row.vaultSyncTx ? await vaults.verifyFinalized(row.vaultBinding, row.id, bytes32Schema.parse(row.vaultSyncTx)) : undefined; }
      catch { synced = undefined; }
      synced ??= await vaults.syncRun(row.vaultBinding, row.id);
      if (synced.charged !== row.charged || synced.refunded !== (row.status === 'refunded')) throw new Error('Vault finalization differs from canonical runtime accounting');
      await this.db.update(platformRuns).set({ vaultSyncTx: synced.transactionHash, errorCode: null, updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
    } catch (error) {
      await this.db.update(platformRuns).set({ vaultSyncTx: null,
        errorCode: error instanceof Problem ? error.code : 'platform_vault_sync_uncertain', updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
    }
  }
  private async syncVaultFinals(): Promise<void> {
    // Rotate a bounded page, including known finalizations, to discover a lost sync transaction after reorg.
    const rows = await this.db.select().from(platformRuns).where(and(inArray(platformRuns.status, ['completed', 'refunded']),
      sql`${platformRuns.vaultBinding} IS NOT NULL`)).orderBy(asc(platformRuns.updatedAt), asc(platformRuns.id)).limit(32);
    for (const row of rows) {
      const canonical = await this.auditFinal(row);
      await this.syncVault(canonical);
    }
  }
  private async recoverUnadmittedRefunds(): Promise<void> {
    // A payer can open the prepared outer call and disconnect before HTTP admission. Never dispatch it
    // without that canonical intent; observe a later permissionless timeout refund for either payer route.
    const rows = await this.db.select().from(platformRuns).where(or(eq(platformRuns.status, 'prepared'),
      and(eq(platformRuns.status, 'reconciliation'), sql`${platformRuns.settlement} IS NULL`)))
      .orderBy(asc(platformRuns.updatedAt), asc(platformRuns.id)).limit(32);
    for (const row of rows) {
      if (row.x402Funding) continue; // An unknown external wallet hash is not original funding evidence.
      try {
        if (row.vaultBinding) await this.requireVaults().checkBinding(row.vaultBinding);
        const run = await this.bridge.run(row.quote.runId);
        if (run.status === 3) await this.reconcileFinal(row);
      } catch {
        await this.db.update(platformRuns).set({ errorCode: row.vaultBinding
          ? 'platform_vault_refund_uncertain' : 'platform_prepared_refund_uncertain' }).where(eq(platformRuns.id, row.id));
      } finally {
        await this.db.update(platformRuns).set({ updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
      }
    }
  }
  async stopPlan(owner: string, runId: string) { const row = await this.row(owner, runId); return this.bridge.plan(encodeFunctionData({
    abi: platformEscrowAbi, functionName: 'requestStop', args: [row.quote.runId] })); }
  async refundPlan(owner: string, runId: string) { const row = await this.row(owner, runId); return this.bridge.plan(encodeFunctionData({
    abi: platformEscrowAbi, functionName: 'refundRun', args: [row.quote.runId] })); }
  async canSeal(hour: number): Promise<boolean> {
    const rows = await this.db.select().from(platformRuns).where(inArray(platformRuns.status, ['queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'reconciliation'])).limit(257);
    if (rows.length > 256) return false;
    const scope = hashJson({ chainId: this.bridge.pins.chainId, escrow: this.bridge.pins.escrowAddress.toLowerCase(),
      receiptRoot: this.bridge.pins.receiptRootAddress.toLowerCase() });
    for (const row of rows) {
      if (this.needsOriginalOpeningGuard(row)) {
        try { await this.verifyOriginalOpening(row); } catch { return false; }
      }
      const run = await this.bridge.run(row.quote.runId);
      if (run.status === 1 && Number(run.openedAt) < (hour + 1) * 3600 && !row.settlement) return false;
      if (row.settlement && Math.floor(row.settlement.endedAt / 3600) === hour && run.status === 1) {
        const [entry] = await this.db.select().from(platformReceiptEntries).where(and(eq(platformReceiptEntries.scope, scope), eq(platformReceiptEntries.runId, row.id)));
        if (!entry || entry.owner !== row.owner || hashJson(entry.settlement) !== hashJson(row.settlement)) return false;
      }
    }
    // Every v2 leaf already recorded in this hour, including a completed run,
    // needs both original copies before the shared root can be broadcast/replayed.
    const v2Entries = await this.db.select({ row: platformRuns, settlement: platformReceiptEntries.settlement })
      .from(platformReceiptEntries).innerJoin(platformRuns, eq(platformReceiptEntries.runId, platformRuns.id))
      .where(and(eq(platformReceiptEntries.scope, scope), eq(platformReceiptEntries.hour, hour), eq(platformRuns.receiptVersion, 2)))
      .limit(MAX_HOUR_RECEIPTS + 1);
    if (v2Entries.length > MAX_HOUR_RECEIPTS) return false;
    for (const { row, settlement } of v2Entries) {
      if (!row.settlement || hashJson(row.settlement) !== hashJson(settlement) || !this.v2Receipts) return false;
      try {
        if (this.v2Receipts.assertReadable) await this.v2Receipts.assertReadable(row);
        else await this.v2Receipts.assertPublished(row);
      } catch { return false; }
    }
    return true;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
  }
  async initialize(): Promise<void> {
    if (!this.bridge.pins.x402CpuProfile && (await this.db.select({ id: platformRuns.id }).from(platformRuns)
      .where(sql`${platformRuns.x402Funding} IS NOT NULL`).limit(1)).length) throw new Error('Original x402 CPU reservations require their reviewed domain4 profile');
    if (!this.v2Receipts && (await this.db.select({ id: platformRuns.id }).from(platformRuns)
      .where(eq(platformRuns.receiptVersion, 2)).limit(1)).length) {
      throw new Error('Original Platform v2 runs require their original evidence publisher configuration');
    }
    if (!this.bridge.pins.financialProfile?.discountVaultRegistry && (await this.db.select({ id: platformRuns.id }).from(platformRuns)
      .where(and(eq(platformRuns.receiptVersion, 2), sql`${platformRuns.vaultBinding} IS NOT NULL`)).limit(1)).length) {
      throw new Error('Original Platform v2 Vault runs require their original reviewed factory and implementation authority');
    }
    await this.v2Receipts?.initialize();
    await this.bridge.check();
    const bindings = await this.db.select({ binding: platformRuns.vaultBinding }).from(platformRuns)
      .where(sql`${platformRuns.vaultBinding} IS NOT NULL`).orderBy(desc(platformRuns.updatedAt)).limit(256);
    if (bindings.length && !this.vaults) throw new Error('Persisted Vault runs require their original reviewed Vault configuration');
    // Recent history is checked here; all active payers are checked before dispatch and every API access.
    const reviewed = new Set<string>();
    for (const { binding } of bindings) if (binding && !reviewed.has(binding.vault.toLowerCase())) {
      await this.requireVaults().checkBinding(binding); reviewed.add(binding.vault.toLowerCase());
    }
    await this.vaults?.check();
    await this.exclusive(async () => {
      // Revalidate recent final outcomes on restart; older history is revalidated whenever it is read.
      const final = await this.db.select().from(platformRuns).where(inArray(platformRuns.status, ['completed', 'refunded']))
        .orderBy(desc(platformRuns.updatedAt)).limit(256);
      for (const row of final) await this.auditFinal(row);
      const rows = await this.db.select().from(platformRuns).where(eq(platformRuns.status, 'running')).limit(257);
      if (rows.length > 256) throw new Error('Platform recovery inventory requires review');
      for (const row of rows) {
        if (row.receiptVersion === 2) {
          const [host] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id)).limit(1);
          if (!host) { await this.retainV2Refund(row, 'platform_v2_unexecuted'); continue; }
        }
        const recovered = row.input.task.kind === 'near_inference' ? undefined
          : await this.executor.recover(row.owner, this.host(row.quote.hostId), row.id, row.quote.maxSeconds);
        if (row.receiptVersion === 2) {
          const [host] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id)).limit(1);
          if (host?.cleanupConfirmed === 1 && (!host.ticks.length || host.ticks.length !== host.acknowledgments.length
            || !['EXITED', 'STOPPED', 'FAULT'].includes(host.ticks.at(-1)!.body.state))) {
            await this.retainV2Refund(row, 'platform_v2_incomplete_meter'); continue;
          }
        }
        await this.persistOutcome(row, row.receiptVersion === 2 && row.result ? row.result
          : recovered ?? await this.zero(row.id, row.quote.maxSeconds), undefined,
          row.input.near ? 'platform_near_not_dispatched' : undefined);
      }
      const dispatches = await this.db.select().from(platformRuns).where(eq(platformRuns.status, 'near_dispatching')).limit(257);
      if (dispatches.length > 256) throw new Error('Platform NEAR recovery inventory requires review');
      for (const row of dispatches) {
        let near: NearCompletionResult | undefined;
        try {
          if (row.nearResult) near = await this.checkedNear(row, row.nearResult);
        } catch { /* Invalid or transplanted evidence never becomes billable output. */ }
        // A paid POST may have succeeded even if its acknowledgement was lost. Never send it twice;
        // settle the durable CPU work with zero inference charge so the receipt hour can close.
        await this.persistOutcome(row, row.result ?? await this.zero(row.id, row.quote.maxSeconds), near,
          near ? undefined : 'PROVIDER_OUTCOME_UNKNOWN');
      }
      await this.syncVaultFinals();
      await this.recoverUnadmittedRefunds();
    });
    this.ready = true;
  }
  private async zero(runId: string, maxSeconds: number): Promise<CpuRunResult> {
    const meter = new RunMeter(runId, maxSeconds); await meter.emit('cancelled', 0, ''); await meter.flush();
    return { output: '', status: 'cancelled', exitCode: -1, billableSeconds: 0, ticks: meter.ticks };
  }
  private async retainV2Refund(row: Row, code: 'platform_v2_unexecuted' | 'platform_v2_incomplete_meter'): Promise<void> {
    if (row.receiptVersion !== 2 || row.settlement) throw new Error('Platform v2 original receipt cannot be replaced by a refund intent');
    await this.db.update(platformRuns).set({ status: 'reconciliation', errorCode: code, updatedAt: new Date() })
      .where(and(eq(platformRuns.id, row.id), sql`${platformRuns.settlement} IS NULL`));
  }
  private async inferenceControlResult(runId: string, maxSeconds: number): Promise<CpuRunResult> {
    // A zero-duration controller record is required by the existing receipt schema.
    // It is not a CPU execution observation or a HostKit meter tick.
    const meter = new RunMeter(runId, maxSeconds); await meter.emit('completed', 0, ''); await meter.flush();
    return { output: '', status: 'completed', exitCode: 0, billableSeconds: 0, ticks: meter.ticks };
  }
  private async checkedNear(row: Row, raw: unknown): Promise<NearCompletionResult> {
    const requested = row.input.near;
    if (!requested || row.quote.inferencePrice === '0' || platformWorkloadHash(row.input) !== row.quote.workloadHash) {
      throw new Error('The original platform NEAR request is unavailable');
    }
    const result = await validateRecoveredNearResult(raw, { model: requested.model, maxTokens: requested.maxTokens });
    if (result.evidence.verification !== 'enclave_verified' || result.evidence.policySha256 !== requested.policySha256) {
      throw new Error('The platform NEAR result does not match its reviewed hardware policy');
    }
    if (result.evidence.requestHash !== platformNearRequestHash(row.id, requested)) {
      throw new Error('The signed NEAR request differs from the original platform prompt or token limit');
    }
    return result;
  }
  private async persistOutcome(row: Row, raw: CpuRunResult, nearRaw?: unknown, errorCode?: string): Promise<void> {
    if (this.needsOriginalOpeningGuard(row)) await this.verifyOriginalOpening(row);
    let result = validateCpuResult(raw, row.id, row.quote.maxSeconds);
    const run = await this.bridge.run(row.quote.runId), leash = await this.bridge.leash(row.quote.leashId);
    if (!this.bridge.matches(row.quote, run)) throw new Error('Platform run changed while executing');
    const near = nearRaw === undefined ? undefined : await this.checkedNear(row, nearRaw);
    if (near && result.status !== 'completed') throw new Error('A failed CPU run cannot charge NEAR inference');
    const [lease] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id));
    if (row.input.task.kind === 'near_inference' && (lease || result.billableSeconds !== 0 || result.output !== ''
      || !['completed', 'cancelled'].includes(result.status))) {
      throw new Error('Inference-only outcome cannot contain a CPU lease or billable CPU work');
    }
    if (lease && !lease.cleanupConfirmed) throw new Error('Platform outcome requires confirmed cleanup');
    if (row.receiptVersion === 2 && (!lease || !lease.ticks.length
      || lease.ticks.length !== lease.acknowledgments.length
      || !['EXITED', 'STOPPED', 'FAULT'].includes(lease.ticks.at(-1)!.body.state))) {
      await this.retainV2Refund(row, lease ? 'platform_v2_incomplete_meter' : 'platform_v2_unexecuted');
      return;
    }
    const observed = lease?.ticks.at(-1)?.body.timestamp;
    let endedAt = observed === undefined ? await this.bridge.now() : Math.max(Number(run.openedAt), Math.floor(observed / 1000));
    const cutoff = Math.min(Number(run.acceptedExpiry), row.input.deadline,
      Number(run.openedAt + BigInt(row.quote.maxSeconds)),
      run.stopAt ? Number(run.stopAt) : Number.MAX_SAFE_INTEGER, leash.killed ? Number(leash.killedAt) : Number.MAX_SAFE_INTEGER);
    const nearReceivedAt = near ? Date.parse(near.evidence.receivedAt) : undefined;
    if (near && (nearReceivedAt === undefined || !Number.isFinite(nearReceivedAt))) throw new Error('NEAR result time is invalid');
    if (nearReceivedAt !== undefined) endedAt = Math.max(endedAt, Math.floor(nearReceivedAt / 1000));
    endedAt = Math.min(endedAt, cutoff);
    if (endedAt < Number(run.openedAt)) throw new Error('Platform cutoff precedes its accepted reservation');
    const eligible = lease?.ticks.filter(tick => tick.body.timestamp <= (endedAt + 1) * 1000)
      .map(tick => lease.acknowledgments.find(ack => ack.body.sequence === tick.body.sequence)?.body.billableSeconds ?? 0) ?? [0];
    const billableSeconds = Math.min(result.billableSeconds, eligible.at(-1) ?? 0, endedAt - Number(run.openedAt) + 1);
    const inferenceCharge = near && nearReceivedAt !== undefined && nearReceivedAt <= cutoff * 1000
      ? row.quote.inferencePrice : '0';
    // The controller's completed dispatch marker is not a successful inference result.
    // Expose a cancelled zero-cost outcome whenever the one-shot call was not billable.
    if (row.input.task.kind === 'near_inference' && inferenceCharge === '0') {
      result = await this.zero(row.id, row.quote.maxSeconds);
    }
    const receiptHash = hashJson({ protocol: 'telomere-platform-receipt-v1', chainId: this.bridge.pins.chainId,
      escrow: this.bridge.pins.escrowAddress, quote: row.quote, endedAt, billableSeconds, output: result.output,
      status: result.status, ticks: result.ticks, hostLeaseHash: lease?.leaseHash ?? null,
      ...(row.input.task.kind === 'near_inference' ? { executionKind: 'near_inference' } : {}),
      ...(row.input.near ? { nearEvidenceHash: near ? hashJson(near) : null, inferenceCharge } : {}) });
    let settlement = platformSettlementSchema.parse({ runId: row.id, billableSeconds, endedAt, inferenceCharge, receiptHash });
    if (row.receiptVersion === 2) {
      if (!this.v2Receipts || near || row.input.near || row.input.task.kind === 'near_inference' || row.input.task.kind === 'session') {
        throw new Error('Original Platform v2 receipt issuer is unavailable for this CPU run');
      }
      // Publication can fail after execution. Retain the first terminal output and
      // controller observations before any store write, so restart never invents
      // a new terminal result or random-salt preimage.
      await this.db.update(platformRuns).set({ result, updatedAt: new Date() })
        .where(and(eq(platformRuns.id, row.id), eq(platformRuns.status, 'running'), sql`${platformRuns.result} IS NULL`));
      const [original] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, row.id)).limit(1);
      if (!original?.result || hashJson(original.result) !== hashJson(result)) throw new Error('Platform v2 original terminal outcome changed');
      settlement = await this.v2Receipts.prepare(original, result,
        { runId: bytes32Schema.parse(row.id), endedAt, billableSeconds, inferenceCharge: '0' });
    }
    await this.db.update(platformRuns).set({ result, ...(row.input.near ? { nearResult: near ?? null } : {}),
      settlement, status: 'receipt_pending', errorCode: errorCode ?? (near && inferenceCharge === '0' ? 'platform_near_late' : null),
      updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
  }
  private async dispatchNear(row: Row, result: CpuRunResult, signal: AbortSignal): Promise<void> {
    const requested = row.input.near, configured = this.near;
    if (!requested || result.status !== 'completed') throw new Error('NEAR dispatch requires an eligible original paid request');
    const readiness = await getNearProviderReadiness(configured?.provider);
    if (!configured || requested.model !== configured.config.model || requested.maxTokens !== configured.config.maxTokens
      || requested.policySha256 !== configured.config.policySha256
      || row.quote.inferencePrice !== configured.config.inferencePrice || readiness.state !== 'ready'
      || readiness.verification !== 'enclave_verified' || signal.aborted) {
      await this.persistOutcome(row, result, undefined, 'platform_near_not_dispatched');
      return;
    }
    const [run, leash, now, host] = await Promise.all([this.bridge.run(row.quote.runId), this.bridge.leash(row.quote.leashId),
      this.bridge.now(), this.bridge.host(row.quote.hostId)]);
    const cutoff = Math.min(row.input.deadline, Number(run.acceptedExpiry), Number(run.openedAt + BigInt(row.quote.maxSeconds)));
    // Reserve the configured provider timeout plus five seconds before an irreversible paid request.
    if (run.status !== 1 || run.stopAt || leash.killed || !sameAddress(host.operator, configured.billingOperator)
      || !sameAddress(run.hostOperator, configured.billingOperator)
      || Math.max(now, Math.floor(Date.now() / 1000)) + configured.maxProviderSeconds + 5 > cutoff) {
      await this.persistOutcome(row, result, undefined, 'platform_near_not_dispatched');
      return;
    }
    // The CPU outcome and external-dispatch intent are one durable transaction. Recovery never repeats a paid POST.
    const [intent] = await this.db.update(platformRuns).set({ result, status: 'near_dispatching', updatedAt: new Date() })
      .where(and(eq(platformRuns.id, row.id), eq(platformRuns.status, 'running'))).returning();
    if (!intent) throw new Error('Original platform NEAR intent was not persisted');
    const dispatchSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, cutoff * 1000 - Date.now() - 1000))]);
    try {
      const raw = await configured.provider.complete({ prompt: requested.prompt, maxTokens: requested.maxTokens,
        runId: row.id, requestUser: platformNearRequestUser(row.id) }, dispatchSignal);
      const near = await this.checkedNear(intent, raw);
      await this.db.update(platformRuns).set({ nearResult: near, updatedAt: new Date() })
        .where(and(eq(platformRuns.id, row.id), eq(platformRuns.status, 'near_dispatching')));
      await this.persistOutcome(intent, result, near);
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError) {
        await this.persistOutcome(intent, result, undefined, 'platform_near_rejected_before_dispatch');
        return;
      }
      // A successful result write may lose its acknowledgement. Inspect storage before declaring uncertainty.
      const [saved] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, row.id)).limit(1);
      if (saved?.nearResult) {
        let near: NearCompletionResult | undefined;
        try { near = await this.checkedNear(saved, saved.nearResult); } catch { /* Never bill invalid stored evidence. */ }
        if (near) {
          try { await this.persistOutcome(saved, result, near); return; }
          catch { this.ready = false; throw new Error('Platform NEAR recovery requires the original durable result'); }
        }
      }
      try { await this.persistOutcome(intent, result, undefined, 'PROVIDER_OUTCOME_UNKNOWN'); }
      catch { this.ready = false; throw new Error('Platform NEAR zero-charge recovery requires durable settlement'); }
    }
  }
  private async execute(row: Row): Promise<void> {
    if (this.needsOriginalOpeningGuard(row)) await this.verifyOriginalOpening(row);
    const run = await this.bridge.run(row.quote.runId), leash = await this.bridge.leash(row.quote.leashId), now = await this.bridge.now();
    if (!this.bridge.matches(row.quote, run) || run.ceiling.toString() !== row.ceiling) throw new Error('Platform reservation changed before dispatch');
    if (run.status !== 1) { await this.reconcileFinal(row); return; }
    await this.bridge.publicationReady(now + row.quote.maxSeconds);
    // All new admission RPCs run before claiming. A temporary failure retains a recoverable queued intent.
    const runnable = row.vaultBinding ? await this.requireVaults().runnable(row.vaultBinding) : true;
    const shouldExecute = !(leash.killed || run.stopAt || !await this.cpuJobAllowsExecution(row)
      || row.input.task.kind === 'session' && row.input.task.cystInput && !this.cystInputsEnabled
      || await this.logicalAgentKilled(row.owner, row.agent, row.vaultBinding) || now + row.quote.maxSeconds > row.input.deadline
      || BigInt(now) >= run.acceptedExpiry || !runnable);
    if (hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== row.quote.workloadHash) {
      throw new Problem(409, 'platform_workload_changed', 'The durable workload differs from its original signed quote.');
    }
    const originalHost = shouldExecute ? this.offeredHost(this.host(row.quote.hostId), row.input.cpuScheduling?.lane ?? 'standard') : undefined;
    if (shouldExecute && !originalHost) throw new Problem(409, 'platform_session_unavailable', 'The original reviewed CPU lane offer is unavailable.');
    if (originalHost && row.input.task.kind === 'exec' && (originalHost.execEnabled !== true || originalHost.imageDigest !== row.input.task.imageDigest
      || keccak256(toHex(originalHost.imageDigest)) !== row.quote.imageHash)) {
      throw new Problem(409, 'platform_exec_unavailable', 'The original reviewed host must still allow this exact command image.');
    }
    if (originalHost && row.input.task.kind === 'session' && (originalHost.sessionEnabled !== true
      || originalHost.lane !== (row.input.cpuScheduling?.lane ?? 'standard')
      || originalHost.lane === 'interruptible' && !originalHost.interruptible
      || originalHost.imageDigest !== row.input.task.imageDigest || keccak256(toHex(originalHost.imageDigest)) !== row.quote.imageHash
      || this.sessionPrice(originalHost, row.input) !== row.quote.pricePerSecond
      || !row.admissionTx)) throw new Problem(409, 'platform_session_unavailable', 'The original reviewed paid session host is unavailable.');
    const claimed = await this.db.update(platformRuns).set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(platformRuns.id, row.id), eq(platformRuns.status, 'queued'))).returning();
    if (!claimed.length || this.closing) return;
    const abort = new AbortController(); this.running = { id: row.id, abort };
    let checking = false;
    const monitor = setInterval(() => {
      if (checking) return; checking = true;
      void Promise.all([this.bridge.run(row.quote.runId), this.bridge.leash(row.quote.leashId), this.bridge.now(),
        row.vaultBinding ? this.requireVaults().runnable(row.vaultBinding) : Promise.resolve(true),
        this.logicalAgentKilled(row.owner, row.agent, row.vaultBinding), this.cpuJobAllowsExecution(row),
        this.needsOriginalOpeningGuard(row) ? this.verifyOriginalOpening(row) : Promise.resolve()])
        .then(([current, currentLeash, timestamp, runnable, killed, jobAllows]) => {
          if (current.status !== 1 || current.stopAt || currentLeash.killed || timestamp >= row.input.deadline
            || BigInt(timestamp) >= current.acceptedExpiry || BigInt(timestamp) >= current.openedAt + BigInt(row.quote.maxSeconds)
            || !runnable || killed || !jobAllows) abort.abort();
        }).catch(() => abort.abort()).finally(() => { checking = false; });
    }, 1000).unref();
    try {
      if (!originalHost) {
        await this.persistOutcome(row, await this.zero(row.id, row.quote.maxSeconds)); return;
      }
      if (row.input.task.kind === 'near_inference') {
        await this.dispatchNear(row, await this.inferenceControlResult(row.id, row.quote.maxSeconds), abort.signal);
        return;
      }
      const result = await this.executor.run(row.owner, originalHost, { runId: bytes32Schema.parse(row.id), task: row.input.task, maxSeconds: row.quote.maxSeconds,
        ...(row.input.cpuScheduling ? { cpuScheduling: row.input.cpuScheduling } : {}) }, abort.signal,
        async tick => { await this.db.transaction(async tx => {
          const [current] = await tx.select().from(platformRuns).where(eq(platformRuns.id, row.id)).for('update');
          if (!current || current.status !== 'running' || current.ticks.length !== tick.sequence) throw new Error('Platform observation chain changed');
          await tx.update(platformRuns).set({ ticks: [...current.ticks, tick], updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
        }); }, row.input.task.kind === 'session' && row.admissionTx
        ? { quoteHash: hashJson(row.quote), admissionTx: bytes32Schema.parse(row.admissionTx) } : undefined);
      if (row.input.near && result.status === 'completed') await this.dispatchNear(row, result, abort.signal);
      else await this.persistOutcome(row, result, undefined, row.input.near ? 'platform_near_not_dispatched' : undefined);
    } catch {
      // Keep the original running or NEAR intent if cleanup/evidence is uncertain. Neither task is dispatched twice.
      await this.db.update(platformRuns).set({ errorCode: 'platform_execution_uncertain', updatedAt: new Date() })
        .where(and(eq(platformRuns.id, row.id), inArray(platformRuns.status, ['running', 'near_dispatching'])));
      this.ready = false;
      throw new Error('Platform execution requires original-lease recovery');
    } finally { clearInterval(monitor); this.running = undefined; }
  }
  private async reconcileFinal(row: Row): Promise<boolean> {
    if (this.needsOriginalOpeningGuard(row)) await this.verifyOriginalOpening(row);
    if (row.id !== row.quote.runId || row.settlement && row.settlement.runId !== row.id) {
      throw new Error('Platform financial outcome belongs to a different reservation');
    }
    const run = await this.bridge.run(row.quote.runId);
    if (!this.bridge.matches(row.quote, run) || run.ceiling.toString() !== row.ceiling) throw new Error('Platform final reservation differs from its accepted quote');
    if (run.status === 2) {
      if (!row.settlement) throw new Error('Settled platform reservation has no durable financial outcome');
      if (row.receiptVersion === 2) await this.requireV2Publication(row);
      const proof = await this.receipts.proof(row.owner, row.id);
      if (!proof) throw new Error('Settled platform reservation has no canonical financial proof');
      let settled;
      try { settled = row.settlementTx ? await this.bridge.confirmedSettlement(row.settlement, bytes32Schema.parse(row.settlementTx))
        : await this.bridge.reconcileSettlement(row.settlement, proof.transactionHash); }
      catch { settled = await this.bridge.reconcileSettlement(row.settlement, proof.transactionHash); }
      await this.db.update(platformRuns).set({ status: 'completed', settlementTx: settled.transactionHash, charged: settled.charged,
        refund: settled.refund, errorCode: null, updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
      await this.syncVault({ ...row, status: 'completed', settlementTx: settled.transactionHash, charged: settled.charged, refund: settled.refund });
      return true;
    }
    if (run.status === 3) {
      const [lease] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, row.id));
      if (lease && !lease.cleanupConfirmed) await this.executor.recover(row.owner, this.host(row.quote.hostId), row.id, row.quote.maxSeconds);
      await this.db.update(platformRuns).set({ status: 'refunded', charged: '0', refund: row.ceiling,
        errorCode: null, updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
      await this.syncVault({ ...row, status: 'refunded', charged: '0', refund: row.ceiling });
      return true;
    }
    return false;
  }
  drain(): Promise<void> { return this.exclusive(async () => {
    if (!this.ready || this.closing) return;
    const queued = await this.db.select().from(platformRuns).where(eq(platformRuns.status, 'queued')).orderBy(asc(platformRuns.updatedAt), asc(platformRuns.createdAt)).limit(1);
    if (queued[0]) {
      try { await this.execute(queued[0]); }
      catch (error) {
        await this.db.update(platformRuns).set({ errorCode: error instanceof Problem ? error.code : 'platform_dispatch_unavailable', updatedAt: new Date() })
          .where(and(eq(platformRuns.id, queued[0].id), eq(platformRuns.status, 'queued')));
        // A pre-dispatch refusal must not starve financial/refund recovery for other original runs.
        if (!this.ready) throw error;
      }
    }
    const pending = await this.db.select().from(platformRuns).where(inArray(platformRuns.status, ['receipt_pending', 'settling', 'reconciliation']))
      .orderBy(asc(platformRuns.updatedAt)).limit(32);
    const chainNow = await this.bridge.now();
    const hours = new Set<number>();
    for (const row of pending) {
      try {
        if (await this.reconcileFinal(row) || !row.settlement) continue;
        if (row.receiptVersion === 2) await this.requireV2Publication(row);
        // A completed host observation may lead the latest mined block. Keep its original time and wait.
        if (row.settlement.endedAt <= chainNow) {
          await this.receipts.record(row.owner, platformSettlementSchema.parse(row.settlement));
          if (row.settlement.endedAt < Math.floor(chainNow / 3600) * 3600) hours.add(Math.floor(row.settlement.endedAt / 3600));
        }
        // Rotate every visited outcome so a full first page cannot starve the next financial entry.
        await this.db.update(platformRuns).set({ updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
      }
      catch (error) {
        await this.db.update(platformRuns).set({ status: 'reconciliation', errorCode: error instanceof Problem ? error.code : 'platform_receipt_uncertain',
          updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
        continue;
      }
    }
    // A known publication hash can become orphaned. Replay the original root intent for the visited
    // closed hours as well as publishing previously unsubmitted batches; never invent a replacement root.
    for (const hour of hours) {
      try { await this.receipts.publish(hour); }
      catch (error) {
        for (const row of pending) if (row.settlement && Math.floor(row.settlement.endedAt / 3600) === hour) {
          await this.db.update(platformRuns).set({ status: 'reconciliation', errorCode: error instanceof Problem ? error.code : 'platform_publication_uncertain', updatedAt: new Date() })
            .where(and(eq(platformRuns.id, row.id), inArray(platformRuns.status, ['receipt_pending', 'settling', 'reconciliation'])));
        }
      }
    }
    for (const row of pending) {
      try {
        if (!row.settlement || await this.reconcileFinal(row)) continue;
        if (row.receiptVersion === 2) await this.requireV2Publication(row);
        const proof = await this.receipts.proof(row.owner, row.id); if (!proof) continue;
        await this.db.update(platformRuns).set({ status: 'settling', updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
        const settled = await this.bridge.settle(platformSettlementSchema.parse(row.settlement), proof.hour, proof.proof, proof.transactionHash);
        await this.db.update(platformRuns).set({ status: 'completed', settlementTx: settled.transactionHash, charged: settled.charged,
          refund: settled.refund, errorCode: null, updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
        await this.syncVault({ ...row, status: 'completed', settlementTx: settled.transactionHash, charged: settled.charged, refund: settled.refund });
      } catch (error) {
        await this.db.update(platformRuns).set({ status: 'reconciliation', errorCode: error instanceof Problem ? error.code : 'platform_settlement_uncertain',
          updatedAt: new Date() }).where(eq(platformRuns.id, row.id));
      }
    }
    await this.syncVaultFinals();
    await this.recoverUnadmittedRefunds();
  }); }
  private async requireV2Publication(row: Row): Promise<void> {
    if (!this.v2Receipts) throw new Error('Original Platform v2 evidence publisher is unavailable');
    await this.v2Receipts.assertPublished(row);
  }
  start(logger: Logger) {
    let busy = false;
    const timer = setInterval(() => { if (busy || this.closing) return; busy = true;
      void this.drain().catch(error => logger.error({ code: error instanceof Problem ? error.code : 'platform_recovery_required' }, 'platform_drain_failed'))
        .finally(() => { busy = false; }); }, 1000).unref();
    return { close: async () => { this.closing = true; clearInterval(timer); this.running?.abort.abort(); await this.queue; } };
  }
}
