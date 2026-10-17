import { z } from 'zod';
import { paidInterruptibleCapabilitySchema } from '../scheduling/paid-lanes.js';
import { assertCpuLaneOffers, cpuLaneOffer, cpuLaneOffersSchema } from '../scheduling/cpu-offers.js';
import { cystInputMaxBytesSchema } from '../host-kit/sessions/cyst-input-protocol.js';
import { paidCpuJobApprovalSchema, paidCpuJobInputSchema, paidCpuJobReplanSchema, paidCpuJobFinishSchema, paidCpuJobSchema,
  paidCpuJobIntentHash, type PaidCpuJob } from '../scheduling/paid-job-types.js';
import { paidCpuReliabilitySchema } from '../scheduling/paid-reliability.js';
import { encodeFunctionData, keccak256, parseAbi, toHex, verifyTypedData } from 'viem';
import { addressSchema, bytes32Schema, canonical, hashJson, moneySchema } from '../common.js';
import { ApiTransport } from '../sdk/transport.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import { hostKeySchema, hostMessageHash, signedLeaseSchema, signedTickSchema, verifyHostMessage } from '../host-kit/protocol.js';
import { parsePaidSessionLease } from '../host-kit/sessions/paid-protocol.js';
import { paidPreemptionNoticeSchema, paidPreemptionOptInSchema,
  PAID_PREEMPTION_MAX_NOTICE_MS, PAID_PREEMPTION_MIN_NOTICE_MS } from '../host-kit/sessions/paid-preemption-protocol.js';
import { checkedSessionCommand, checkedSessionEvents, sessionCursor } from './session-client.js';
import type { FetchTransport } from '../sdk/types.js';
import type { PlatformRuntimeRun, PlatformWalletPlan } from './client.js';
import { platformAdmissionSchema, platformEscrowAbi, platformPinsSchema, platformPreparedSchema, validatedPlatformQuoteInputSchema,
  platformNearConfigSchema, platformQuoteSchema, platformQuoteTypes, platformSettlementSchema, platformWorkloadHash, platformSessionPricesSchema,
  typedPlatformQuote, platformFeeDiscountBpsSchema, platformNoDispatchSchema, platformQuoteDomainVersion, platformRunFeeBps, type PlatformPins, type PlatformPrepared } from './types.js';

export const platformVaultPinsSchema = z.object({ registryAddress: addressSchema, registryCodeHash: bytes32Schema,
  implementationAddress: addressSchema, implementationCodeHash: bytes32Schema }).strict();
export type PlatformVaultPins = z.infer<typeof platformVaultPinsSchema>;
export const platformVaultBindingSchema = z.object({ vault: addressSchema, owner: addressSchema, agentWallet: addressSchema,
  agentId: bytes32Schema, leashId: bytes32Schema }).strict();
export type PlatformVaultBinding = z.infer<typeof platformVaultBindingSchema>;
export const platformVaultSessionLeaseSchema = z.object({ hostId: bytes32Schema,
  controllerKey: hostKeySchema, leaseHash: bytes32Schema, lease: signedLeaseSchema }).strict();
export type PlatformVaultSessionLease = z.infer<typeof platformVaultSessionLeaseSchema>;
export const platformVaultRuntimeConfigSchema = z.object({ protocol: z.literal('telomere-platform-v1'), pins: platformPinsSchema,
  maxSeconds: z.literal(120), feeBps: z.literal(900), capacity: z.array(z.object({ hostId: bytes32Schema, hardwareClass: z.literal('cpu'),
    region: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).min(1).max(64), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    lane: z.enum(['standard', 'interruptible']), interruptible: paidInterruptibleCapabilitySchema.optional(), pricePerSecond: moneySchema, execEnabled: z.literal(true).optional(),
    sessionEnabled: z.literal(true).optional(), sessionPrices: platformSessionPricesSchema.optional(), cystInputMaxBytes: cystInputMaxBytesSchema.optional(),
    laneOffers: cpuLaneOffersSchema.optional() }).strict()).min(1).max(16), near: platformNearConfigSchema.optional(),
  nearInferenceTask: z.literal('near_inference').optional(),
  cpuReceiptVersion: z.literal(2).optional(),
  binding: platformVaultBindingSchema, vaultPins: platformVaultPinsSchema }).strict();
export type PlatformVaultRuntimeConfig = z.infer<typeof platformVaultRuntimeConfigSchema>;
export const platformVaultClientAbi = parseAbi([
  'struct PlatformQuote { bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry; }',
  'function payRun(PlatformQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof)', 'function requestStop(bytes32 runId)',
]);
const transactionSchema = platformPreparedSchema.shape.transaction;
const idemSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const balanceUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 2n ** 256n);
function boundedJson(value: unknown): boolean {
  let count = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++count > 16_384 || depth > 16) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= 131_072;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
    return typeof item === 'object' && Object.values(item).every(child => visit(child, depth + 1));
  }
  return visit(value, 0);
}
const runSchema = z.object({ id: bytes32Schema, status: z.enum(['prepared', 'queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'completed', 'refunded', 'reconciliation']),
  quote: platformQuoteSchema, ceiling: moneySchema, admissionTx: bytes32Schema.nullable(), settlementTx: bytes32Schema.nullable(),
  result: z.unknown().refine(boundedJson).nullable(), settlement: platformSettlementSchema.nullable(),
  charged: moneySchema.nullable(), refund: moneySchema.nullable(), errorCode: z.string().max(128).nullable(),
  nearResult: z.unknown().refine(boundedJson).nullable().optional(),
  feeDiscountBps: platformFeeDiscountBpsSchema.optional(),
  cpuDispatch: platformNoDispatchSchema.optional(),
  executionKind: z.literal('near_inference').optional() }).strict();
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Reviewed Vault plans only. The caller explicitly signs and broadcasts every wallet transaction. */
export class PlatformVaultRuntimeClient {
  readonly origin: string;
  readonly vault: string;
  private readonly transport: ApiTransport;
  private readonly pins: PlatformPins;
  private readonly vaultPins: PlatformVaultPins;
  private readonly expectedBinding: PlatformVaultBinding | undefined;
  private readonly now: () => number;
  private readonly quotes = new Map<string, { input: string; result: Promise<PlatformPrepared> }>();
  private minimumCpuReceiptVersion: 1 | 2;
  constructor(options: { baseUrl: string; pins: PlatformPins; vaultPins: PlatformVaultPins; vault: string;
    binding?: PlatformVaultBinding; sessionToken?: string; fetch?: FetchTransport; nowSeconds?: () => number; cpuReceiptVersion?: 1 | 2 }) {
    this.transport = new ApiTransport(options.baseUrl, { ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    this.origin = this.transport.origin; this.vault = addressSchema.parse(options.vault);
    this.pins = freeze(platformPinsSchema.parse(options.pins)); this.vaultPins = freeze(platformVaultPinsSchema.parse(options.vaultPins));
    const discountRegistry = this.pins.financialProfile?.discountVaultRegistry;
    if (discountRegistry && (!same(discountRegistry.address, this.vaultPins.registryAddress)
      || !same(discountRegistry.codeHash, this.vaultPins.registryCodeHash)
      || !same(discountRegistry.implementationAddress, this.vaultPins.implementationAddress)
      || !same(discountRegistry.implementationCodeHash, this.vaultPins.implementationCodeHash))) {
      throw new Error('Vault pins differ from the reviewed economics factory');
    }
    this.expectedBinding = options.binding === undefined ? undefined : freeze(platformVaultBindingSchema.parse(options.binding));
    if (this.expectedBinding && !same(this.expectedBinding.vault, this.vault)) throw new Error('Vault binding differs from the reviewed vault');
    this.now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.minimumCpuReceiptVersion = z.union([z.literal(1), z.literal(2)]).parse(options.cpuReceiptVersion ?? 1);
  }
  private path(suffix: string): string { return '/api/platform/vaults/' + this.vault + suffix; }
  async config(): Promise<PlatformVaultRuntimeConfig> {
    if (this.pins.spendPermissionProfile || this.pins.x402CpuProfile) throw new Error('This reviewed EOA funding domain does not support Vault bookkeeping');
    // Fetch binding afresh: an authenticated agent session must never reuse owner authorization from an earlier session.
    const config = platformVaultRuntimeConfigSchema.parse(await this.transport.request(this.path('/config')));
    if ((config.cpuReceiptVersion ?? 1) < this.minimumCpuReceiptVersion) throw new Error('Reviewed Vault CPU receipt protocol was downgraded');
    if (config.near && config.nearInferenceTask !== 'near_inference') {
      throw new Error('Reviewed NEAR configuration requires the explicit nearInferenceTask marker');
    }
    if (canonical(config.pins).toLowerCase() !== canonical(this.pins).toLowerCase()) {
      throw new Error('Platform deployment differs from reviewed pins');
    }
    for (const key of Object.keys(this.vaultPins) as (keyof PlatformVaultPins)[]) {
      if (!same(config.vaultPins[key], this.vaultPins[key])) throw new Error('Vault deployment differs from reviewed pins');
    }
    if (!same(config.binding.vault, this.vault) || (this.expectedBinding && canonical(config.binding) !== canonical(this.expectedBinding))) {
      throw new Error('Vault configuration changed its reviewed binding');
    }
    if (new Set(config.capacity.map(host => host.hostId)).size !== config.capacity.length) throw new Error('Platform capacity contains ambiguous hosts');
    config.capacity.forEach(assertCpuLaneOffers);
    if (config.cpuReceiptVersion === 2) this.minimumCpuReceiptVersion = 2;
    return freeze(config);
  }
  private async principal(config: PlatformVaultRuntimeConfig, role: 'read' | 'agent' | 'owner'): Promise<string> {
    const principal = z.object({ address: addressSchema, demo: z.boolean() }).strict().parse(await this.transport.request('/api/me')).address;
    const agent = same(principal, config.binding.agentWallet), owner = same(principal, config.binding.owner);
    if (role === 'agent' ? !agent : role === 'owner' ? !owner : !agent && !owner) throw new Error('Authenticated wallet is not authorized for this Vault action');
    return principal;
  }
  async balance(): Promise<{ available: string }> {
    const config = await this.config(); await this.principal(config, 'read');
    return z.object({ available: balanceUnits }).strict().parse(await this.transport.request(this.path('/balance')));
  }
  private async checkedPrepared(raw: unknown, requested: z.infer<typeof validatedPlatformQuoteInputSchema>, role?: 'agent' | 'owner', historical = false): Promise<PlatformPrepared> {
    const config = await this.config(); await this.principal(config, role ?? (requested.cpuScheduling?.lane === 'interruptible' ? 'owner' : 'agent'));
    const requiredVersion = config.cpuReceiptVersion === 2 && !requested.near && !['session', 'near_inference'].includes(requested.task.kind) ? 2 : 1;
    if ((platformPreparedSchema.parse(raw).receiptVersion ?? 1) !== requiredVersion) throw new Error('Prepared Vault run changed its reviewed CPU receipt version');
    const value = platformPreparedSchema.parse(raw), q = value.quote, host = config.capacity.find(candidate => candidate.hostId === q.hostId), now = this.now();
    const offer = host ? cpuLaneOffer(host, requested.cpuScheduling?.lane ?? 'standard') : undefined;
    const requestedNear = requested.near, reviewedNear = config.near;
    const nearMatches = requestedNear ? !!reviewedNear && requestedNear.model === reviewedNear.model
      && requestedNear.maxTokens === reviewedNear.maxTokens && requestedNear.policySha256 === reviewedNear.policySha256
      && q.inferencePrice === reviewedNear.inferencePrice : q.inferencePrice === '0';
    const base = BigInt(q.maxSeconds) * BigInt(q.pricePerSecond) + BigInt(q.inferencePrice);
    const ceiling = base + (base * 900n + 9999n) / 10000n;
    if (!host || !offer
      || requested.cpuScheduling?.job?.targetHostId && host.hostId !== requested.cpuScheduling.job.targetHostId
      || offer.lane === 'interruptible' && !offer.interruptible
      || requested.excludedHostIds?.includes(q.hostId) || !same(q.payer, this.vault)
      || canonical(value.input) !== canonical(requested) || q.leashId !== config.binding.leashId
      || !nearMatches
      || (requested.task.kind === 'exec' && (host.execEnabled !== true || requested.task.imageDigest !== host.imageDigest))
      || (requested.task.kind === 'session' && (host.sessionEnabled !== true || requested.task.imageDigest !== host.imageDigest))
      || requested.task.kind === 'session' && requested.task.cystInput && ((host.cystInputMaxBytes ?? 0) < requested.task.cystInput.plaintextBytes
        || requiredVersion !== 1 || requested.near || requested.task.cystInput.agentId !== config.binding.agentId
        || !same(requested.task.cystInput.checkpoint.owner, config.binding.owner) || !same(requested.task.cystInput.checkpoint.agent, config.binding.agentWallet))
      || q.leashId !== requested.leashId || q.maxSeconds !== requested.maxSeconds || q.pricePerSecond !== (requested.task.kind === 'session' && requested.task.resourceProfile
        && requested.task.resourceProfile !== 'full' ? offer.sessionPrices?.[requested.task.resourceProfile] : offer.pricePerSecond) || !Number.isSafeInteger(now)
      || !historical && (q.quoteExpiry < now || q.quoteExpiry > now + 120 || now + q.maxSeconds > requested.deadline)
      || q.quoteExpiry + q.maxSeconds > requested.deadline || (requested.regions.length > 0 && !requested.regions.includes(host.region))
      || q.regionHash !== keccak256(toHex(host.region)) || q.imageHash !== keccak256(toHex(host.imageDigest))
      || q.workloadHash !== platformWorkloadHash(requested) || base === 0n
      || ceiling.toString() !== value.ceiling || ceiling > BigInt(requested.maxSpend)) throw new Error('Platform Vault quote changed its payer, scope, deadline or fee ceiling');
    if (!await verifyTypedData({ address: this.pins.quoteSigner,
      domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(this.pins), chainId: this.pins.chainId, verifyingContract: this.pins.escrowAddress },
      types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(q), signature: value.signature })) {
      throw new Error('Platform Vault quote signature is invalid');
    }
    const data = encodeFunctionData({ abi: platformVaultClientAbi, functionName: 'payRun',
      args: [typedPlatformQuote(q), value.signature, value.imageProof, value.regionProof] });
    if (value.transaction.chainId !== this.pins.chainId || !same(value.transaction.to, this.vault)
      || value.transaction.data !== data || value.transaction.value !== '0') throw new Error('Vault payRun transaction differs from its signed quote and proofs');
    return freeze(value);
  }
  quote(raw: unknown, idempotencyKey: string): Promise<PlatformPrepared> {
    const input = validatedPlatformQuoteInputSchema.parse(raw), key = idemSchema.parse(idempotencyKey), hash = canonical(input), prior = this.quotes.get(key);
    if (prior) {
      if (prior.input !== hash) return Promise.reject(new Error('Platform Vault idempotency key belongs to different work'));
      return prior.result.then(value => this.checkedPrepared(value, input));
    }
    if (this.quotes.size >= 128) return Promise.reject(new Error('Platform Vault quote history is full; retain reservations and use a new client'));
    const result = this.config().then(async config => {
      await this.principal(config, input.cpuScheduling?.lane === 'interruptible' ? 'owner' : 'agent');
      if (input.leashId !== config.binding.leashId) throw new Error('Requested Leash differs from Vault binding');
      if (input.near && (!config.near || input.near.model !== config.near.model
        || input.near.maxTokens !== config.near.maxTokens || input.near.policySha256 !== config.near.policySha256)) {
        throw new Error('Reviewed NEAR inference is unavailable for this Vault request');
      }
      const task = input.task;
      if (task.kind === 'exec' && !config.capacity.some(host => host.execEnabled === true && host.imageDigest === task.imageDigest
        && !input.excludedHostIds?.includes(host.hostId)
        && (input.regions.length === 0 || input.regions.includes(host.region)))) throw new Error('No reviewed command capacity matches the requested image and regions');
      if (task.kind === 'session' && !config.capacity.some(host => host.sessionEnabled === true && host.imageDigest === task.imageDigest
        && !input.excludedHostIds?.includes(host.hostId)
        && (input.regions.length === 0 || input.regions.includes(host.region)))) throw new Error('No reviewed paid session capacity matches the requested image and regions');
      return this.transport.request(this.path('/quotes'), { method: 'POST', body: input, idempotencyKey: key });
    }).then(value => this.checkedPrepared(value, input));
    this.quotes.set(key, { input: hash, result });
    void result.catch(() => { if (this.quotes.get(key)?.result === result) this.quotes.delete(key); });
    return result;
  }
  private async checkedCpuJob(raw: unknown, historical = false): Promise<PaidCpuJob> {
    const value = paidCpuJobSchema.parse(raw), config = await this.config(); await this.principal(config, 'owner');
    if (canonical(value.binding) !== canonical(config.binding) || !same(value.vault, this.vault)
      || !same(value.owner, config.binding.owner) || value.input.leashId !== config.binding.leashId
      || value.intentHash !== paidCpuJobIntentHash(value.id, value.binding, value.input, value.createdAt, this.pins)
      || BigInt(value.charged) + BigInt(value.outstandingLiability) > BigInt(value.input.maxSpend)) {
      throw new Error('Owner CPU job changed its original Vault, chain, deadline or complete budget');
    }
    if (value.proposal && (value.proposal.jobId !== value.id || value.proposal.originalDeadline !== value.input.deadline
      || value.proposal.originalMaxSpend !== value.input.maxSpend || !value.input.lanes.includes(value.proposal.target.lane))) {
      throw new Error('CPU replacement proposal changed its original owner intent');
    }
    if (value.prepared) {
      const prepared = await this.checkedPrepared(value.prepared, value.prepared.input, 'owner', historical);
      if (prepared.quote.runId !== value.currentRunId || !value.runIds.includes(prepared.quote.runId)
        || prepared.input.cpuScheduling?.job?.jobId !== value.id
        || prepared.input.cpuScheduling.job.intentHash !== value.intentHash
        || prepared.input.deadline !== value.input.deadline || canonical(prepared.input.task) !== canonical(value.input.task)
        || value.approvalHash !== (prepared.input.cpuScheduling.job.decisionHash ?? null)) {
        throw new Error('The CPU job quote changed its exact owner approval or original workload');
      }
    }
    return freeze(value);
  }
  async createCpuJob(raw: unknown, idempotencyKey: string) {
    const input = paidCpuJobInputSchema.parse(raw), config = await this.config(); await this.principal(config, 'owner');
    const value = await this.checkedCpuJob(await this.transport.request(this.path('/cpu-jobs'),
      { method: 'POST', body: input, idempotencyKey: idemSchema.parse(idempotencyKey) }));
    if (canonical(value.input) !== canonical(input)) throw new Error('Owner CPU job changed its original input');
    return value;
  }
  async cpuJob(jobId: string) {
    const config = await this.config(); await this.principal(config, 'owner');
    return this.checkedCpuJob(await this.transport.request(this.path('/cpu-jobs/' + bytes32Schema.parse(jobId))), true);
  }
  async replanCpuJob(jobId: string, raw: unknown, idempotencyKey: string) {
    const config = await this.config(); await this.principal(config, 'owner');
    return this.checkedCpuJob(await this.transport.request(this.path('/cpu-jobs/' + bytes32Schema.parse(jobId) + '/replan'),
      { method: 'POST', body: paidCpuJobReplanSchema.parse(raw), idempotencyKey: idemSchema.parse(idempotencyKey) }), true);
  }
  async approveCpuJob(jobId: string, decisionHash: string) {
    const config = await this.config(); await this.principal(config, 'owner');
    return this.checkedCpuJob(await this.transport.request(this.path('/cpu-jobs/' + bytes32Schema.parse(jobId) + '/approve'),
      { method: 'POST', body: paidCpuJobApprovalSchema.parse({ decisionHash }) }));
  }
  async cancelCpuJob(jobId: string) {
    const config = await this.config(); await this.principal(config, 'owner');
    return this.checkedCpuJob(await this.transport.request(this.path('/cpu-jobs/' + bytes32Schema.parse(jobId) + '/cancel'),
      { method: 'POST', body: {} }), true);
  }
  async finishCpuJob(jobId: string, raw: unknown = {}) {
    const config = await this.config(); await this.principal(config, 'owner');
    return this.checkedCpuJob(await this.transport.request(this.path('/cpu-jobs/' + bytes32Schema.parse(jobId) + '/finish'),
      { method: 'POST', body: paidCpuJobFinishSchema.parse(raw) }), true);
  }
  async cpuReliability(hostId: string, lane: 'standard' | 'interruptible') {
    const config = await this.config(); await this.principal(config, 'owner');
    const id = bytes32Schema.parse(hostId), checkedLane = z.enum(['standard', 'interruptible']).parse(lane);
    const value = paidCpuReliabilitySchema.parse(await this.transport.request(this.path('/cpu-jobs/reliability/' + id + '/' + checkedLane)));
    if (value.hostId !== id || value.lane !== lane) throw new Error('CPU reliability response changed its original host and lane');
    return freeze(value);
  }
  async openPlan(raw: unknown): Promise<PlatformWalletPlan> {
    const value = platformPreparedSchema.parse(raw); return (await this.checkedPrepared(value, value.input)).transaction;
  }
  private checkedRun(raw: unknown, config: PlatformVaultRuntimeConfig, id?: string): PlatformRuntimeRun {
    const value = runSchema.parse(raw), maximum = BigInt(value.quote.maxSeconds) * BigInt(value.quote.pricePerSecond)
      + BigInt(value.quote.inferencePrice);
    const feeBps = platformRunFeeBps(this.pins, value);
    if (value.cpuDispatch && (value.cpuDispatch.admissionTx !== value.admissionTx
      || !['completed', 'refunded'].includes(value.status) || value.charged !== '0' || value.refund !== value.ceiling
      || value.settlement && value.settlement.billableSeconds !== 0)) throw new Error('No-dispatch observation lacks exact terminal zero-work accounting');
    if (!same(value.quote.payer, this.vault) || value.quote.leashId !== config.binding.leashId || value.id !== value.quote.runId
      || (id !== undefined && value.id !== id) || maximum + (maximum * 900n + 9999n) / 10000n !== BigInt(value.ceiling)
      || (value.settlement !== null && (value.settlement.runId !== value.id || value.settlement.billableSeconds > value.quote.maxSeconds))) {
      throw new Error('Platform Vault run changed its payer, binding, request or fee ceiling');
    }
    if ((value.charged !== null && BigInt(value.charged) > BigInt(value.ceiling))
      || (value.refund !== null && BigInt(value.refund) > BigInt(value.ceiling))
      || (value.charged !== null && value.refund !== null && BigInt(value.charged) + BigInt(value.refund) !== BigInt(value.ceiling))) {
      throw new Error('Platform Vault reported funds do not conserve the reservation');
    }
    if (value.settlement) {
      if (value.executionKind === 'near_inference' && value.settlement.billableSeconds !== 0) {
        throw new Error('NEAR inference-only run cannot bill CPU seconds');
      }
      const inference = BigInt(value.settlement.inferenceCharge), quoted = BigInt(value.quote.inferencePrice);
      const base = BigInt(value.settlement.billableSeconds) * BigInt(value.quote.pricePerSecond) + inference;
      const charged = base + (base * BigInt(feeBps) + 9999n) / 10000n;
      if ((inference !== 0n && inference !== quoted) || charged > BigInt(value.ceiling)
        || (value.charged !== null && BigInt(value.charged) !== charged)) {
        throw new Error('Platform Vault settlement inference charge or billed amount differs from the signed quote');
      }
    }
    if (value.status === 'completed' && (!value.settlement || value.charged === null || value.refund === null)) {
      throw new Error('Platform Vault completed run lacks its exact settlement accounting');
    }
    if (value.status === 'refunded' && (value.charged !== '0' || value.refund !== value.ceiling)) {
      throw new Error('Platform Vault refunded run differs from the original reservation');
    }
    return freeze(value);
  }
  async admit(raw: unknown, idempotencyKey: string): Promise<PlatformRuntimeRun> {
    const config = await this.config(); await this.principal(config, 'agent');
    const input = platformAdmissionSchema.parse(raw), value = this.checkedRun(await this.transport.request(this.path('/runs'), {
      method: 'POST', body: input, idempotencyKey: idemSchema.parse(idempotencyKey) }), config, input.runId);
    if (value.admissionTx !== input.transactionHash) throw new Error('Platform Vault admission changed its original reservation transaction');
    return value;
  }
  async list(): Promise<{ runs: PlatformRuntimeRun[] }> {
    const config = await this.config(); await this.principal(config, 'read');
    const value = z.object({ runs: z.array(runSchema).max(128) }).strict().parse(await this.transport.request(this.path('/runs')));
    return freeze({ runs: value.runs.map(run => this.checkedRun(run, config)) });
  }
  async get(runId: string): Promise<PlatformRuntimeRun> {
    const config = await this.config(); await this.principal(config, 'read'); const id = bytes32Schema.parse(runId);
    return this.checkedRun(await this.transport.request(this.path('/runs/' + id)), config, id);
  }
  async sessionLease(runId: string): Promise<PlatformVaultSessionLease> {
    const id = bytes32Schema.parse(runId), config = await this.config(); await this.principal(config, 'read');
    const run = await this.get(id);
    if (!run.admissionTx) throw new Error('Paid Vault session has no original admission');
    const evidence = platformVaultSessionLeaseSchema.parse(await this.transport.request(this.path('/runs/' + id + '/lease')));
    const host = config.capacity.find(value => value.hostId === evidence.hostId);
    const { lease, payload } = parsePaidSessionLease(evidence.lease);
    if (!host || host.sessionEnabled !== true || evidence.hostId !== run.quote.hostId
      || !same(lease.body.owner, this.vault) || lease.body.runId !== id
      || !lease.body.image.endsWith('@' + host.imageDigest)
      || lease.body.maxSeconds !== run.quote.maxSeconds
      || payload.quoteHash !== hashJson(run.quote) || payload.admissionTx !== run.admissionTx
      || platformWorkloadHash({ task: { kind: 'session', imageDigest: host.imageDigest,
        maxCommands: payload.spec.policy.maxCommands,
        ...(payload.spec.cystInput ? { cystInput: payload.spec.cystInput } : {}),
        ...(payload.resourceProfile === undefined ? {} : { resourceProfile: payload.resourceProfile }) },
        ...(payload.cpuScheduling ? { cpuScheduling: payload.cpuScheduling } : {}) }) !== run.quote.workloadHash
      || hostMessageHash(lease) !== evidence.leaseHash
      || !verifyHostMessage(evidence.controllerKey, 'lease', lease)) {
      throw new Error('Original paid Vault session lease differs from its signed reservation');
    }
    return freeze(evidence);
  }
  async preemptionOptIn(runId: string, idempotencyKey: string) {
    const id = bytes32Schema.parse(runId), key = idemSchema.parse(idempotencyKey);
    const config = await this.config(); await this.principal(config, 'owner');
    const evidence = await this.sessionLease(id);
    const value = z.object({ hostId: bytes32Schema, controllerKey: hostKeySchema,
      leaseHash: bytes32Schema, lease: signedLeaseSchema,
      optIn: paidPreemptionOptInSchema, replayed: z.boolean() }).strict().parse(await this.transport.request(
      this.path('/runs/' + id + '/preemption-opt-in'), { method: 'POST', body: {}, idempotencyKey: key }));
    const body = value.optIn.body;
    if (value.hostId !== evidence.hostId || value.controllerKey !== evidence.controllerKey
      || value.leaseHash !== evidence.leaseHash || hostMessageHash(value.lease) !== evidence.leaseHash
      || !verifyHostMessage(evidence.controllerKey, 'paid-preemption-optin', value.optIn)
      || body.hostKey !== evidence.lease.body.hostKey || body.owner !== evidence.lease.body.owner
      || body.runId !== id || body.leaseHash !== evidence.leaseHash || body.image !== evidence.lease.body.image
      || body.expiresAt > evidence.lease.body.expiresAt) {
      throw new Error('Paid preemption opt-in changed its original Vault lease binding');
    }
    return freeze(value);
  }
  async preemptionNotice(runId: string) {
    const id = bytes32Schema.parse(runId), evidence = await this.sessionLease(id);
    const value = z.object({ hostId: bytes32Schema, controllerKey: hostKeySchema,
      leaseHash: bytes32Schema, lease: signedLeaseSchema, notice: paidPreemptionNoticeSchema,
      optIn: paidPreemptionOptInSchema,
      terminalTick: signedTickSchema.nullable() }).strict().parse(
      await this.transport.request(this.path('/runs/' + id + '/preemption-notice')));
    const body = value.notice.body;
    if (value.hostId !== evidence.hostId || value.controllerKey !== evidence.controllerKey
      || value.leaseHash !== evidence.leaseHash || hostMessageHash(value.lease) !== evidence.leaseHash
      || !verifyHostMessage(evidence.lease.body.hostKey, 'paid-preemption', value.notice)
      || body.hostKey !== evidence.lease.body.hostKey || body.owner !== evidence.lease.body.owner
      || body.runId !== id || body.leaseHash !== evidence.leaseHash || body.image !== evidence.lease.body.image
      || body.interruptAt - body.issuedAt < PAID_PREEMPTION_MIN_NOTICE_MS
      || body.interruptAt - body.issuedAt > PAID_PREEMPTION_MAX_NOTICE_MS
      || body.interruptAt > evidence.lease.body.expiresAt) {
      throw new Error('Paid preemption notice changed its signed Vault lease binding');
    }
    const opted = value.optIn.body;
    if (!verifyHostMessage(evidence.controllerKey, 'paid-preemption-optin', value.optIn)
      || body.optInHash !== hostMessageHash(value.optIn)
      || opted.hostKey !== body.hostKey || opted.owner !== body.owner
      || opted.runId !== body.runId || opted.leaseHash !== body.leaseHash
      || opted.image !== body.image || opted.expiresAt > evidence.lease.body.expiresAt
      || opted.expiresAt <= opted.issuedAt || body.interruptAt > opted.expiresAt) {
      throw new Error('Paid preemption notice lacks its exact owner opt-in authority');
    }
    const tick = value.terminalTick;
    if (tick && (!verifyHostMessage(evidence.lease.body.hostKey, 'tick', tick)
      || tick.body.hostKey !== body.hostKey || tick.body.owner !== body.owner
      || tick.body.runId !== id
      || tick.body.leaseHash !== hostMessageHash({ body: evidence.lease.body, signature: '' }))) {
      throw new Error('Paid preemption terminal tick changed its original Vault lease binding');
    }
    return freeze(value);
  }
  async command(runId: string, raw: unknown) {
    const id = bytes32Schema.parse(runId), command = sessionCommandSchema.parse(raw);
    const config = await this.config(); await this.principal(config, 'agent');
    const run = await this.get(id);
    if (!run.admissionTx || ['prepared', 'queued'].includes(run.status)) throw new Error('Paid Vault session has not been admitted');
    return freeze(checkedSessionCommand(await this.transport.request(this.path('/runs/' + id + '/commands'),
      { method: 'POST', body: command, idempotencyKey: command.commandId, timeoutMs: 130_000 }), command));
  }
  async sessionEvents(runId: string, afterSequence = -1, limit = 8) {
    const id = bytes32Schema.parse(runId), cursor = sessionCursor(afterSequence, limit);
    const run = await this.get(id);
    if (!run.admissionTx) throw new Error('Paid Vault session has not been admitted');
    return freeze(checkedSessionEvents(await this.transport.request(this.path('/runs/' + id + '/events')
      + '?after=' + cursor.afterSequence + '&limit=' + cursor.limit), cursor.afterSequence, cursor.limit));
  }
  private async actionPlan(action: 'stop' | 'refund', runId: string, key: string): Promise<PlatformWalletPlan> {
    const config = await this.config(); await this.principal(config, action === 'stop' ? 'owner' : 'read');
    const id = bytes32Schema.parse(runId); this.checkedRun(await this.transport.request(this.path('/runs/' + id)), config, id);
    const plan = transactionSchema.parse(await this.transport.request(this.path('/runs/' + id + '/' + action),
      { method: 'POST', body: {}, idempotencyKey: idemSchema.parse(key) }));
    const data = action === 'stop'
      ? encodeFunctionData({ abi: platformVaultClientAbi, functionName: 'requestStop', args: [id] })
      : encodeFunctionData({ abi: platformEscrowAbi, functionName: 'refundRun', args: [id] });
    if (plan.chainId !== this.pins.chainId || !same(plan.to, action === 'stop' ? this.vault : this.pins.escrowAddress) || plan.data !== data || plan.value !== '0') {
      throw new Error('Platform Vault action changed destination, chain or calldata');
    }
    return freeze(plan);
  }
  stopPlan(runId: string, idempotencyKey: string) { return this.actionPlan('stop', runId, idempotencyKey); }
  refundPlan(runId: string, idempotencyKey: string) { return this.actionPlan('refund', runId, idempotencyKey); }
}
