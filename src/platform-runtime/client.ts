import { z } from 'zod';
import { paidInterruptibleCapabilitySchema } from '../scheduling/paid-lanes.js';
import { assertCpuLaneOffers, cpuLaneOffer, cpuLaneOffersSchema } from '../scheduling/cpu-offers.js';
import { cystInputMaxBytesSchema } from '../host-kit/sessions/cyst-input-protocol.js';
import { encodeFunctionData, keccak256, toHex, verifyTypedData } from 'viem';
import { addressSchema, bytes32Schema, canonical, moneySchema } from '../common.js';
import { ApiTransport } from '../sdk/transport.js';
import { spendPermissionHash, spendPermissionOpenCall } from '../payments/spend-permissions.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import { checkedSessionCommand, checkedSessionEvents, sessionCursor } from './session-client.js';
import type { FetchTransport } from '../sdk/types.js';
import { platformAdmissionSchema, platformEscrowAbi, platformPinsSchema, platformPreparedSchema, validatedPlatformQuoteInputSchema,
  platformNearConfigSchema, platformQuoteSchema, platformQuoteTypes, platformSettlementSchema, platformWorkloadHash,
  typedPlatformQuote, platformSessionPricesSchema, platformFeeDiscountBpsSchema, platformNoDispatchSchema, platformQuoteDomainVersion, platformRunFeeBps, type PlatformPins,
  type PlatformPrepared } from './types.js';

const configSchema = z.object({ protocol: z.literal('telomere-platform-v1'), pins: platformPinsSchema, maxSeconds: z.literal(120),
  feeBps: z.literal(900), capacity: z.array(z.object({ hostId: bytes32Schema, hardwareClass: z.literal('cpu'),
    region: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).min(1).max(64), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    lane: z.enum(['standard', 'interruptible']), interruptible: paidInterruptibleCapabilitySchema.optional(), pricePerSecond: moneySchema, execEnabled: z.literal(true).optional(),
    sessionEnabled: z.literal(true).optional(), sessionPrices: platformSessionPricesSchema.optional(), cystInputMaxBytes: cystInputMaxBytesSchema.optional(),
    laneOffers: cpuLaneOffersSchema.optional() }).strict()).min(1).max(16), near: platformNearConfigSchema.optional(),
  nearInferenceTask: z.literal('near_inference').optional(), cpuReceiptVersion: z.literal(2).optional() }).strict();
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
export type PlatformRuntimeRun = z.infer<typeof runSchema>;
export type PlatformRuntimeConfig = z.infer<typeof configSchema>;
export type PlatformWalletPlan = z.infer<typeof transactionSchema>;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Node SDK for paid CPU tasks and one-shot NEAR inference. Never signs or sends owner transactions. */
export class PlatformRuntimeClient {
  readonly origin: string;
  private readonly transport: ApiTransport;
  private readonly pins: PlatformPins;
  private readonly now: () => number;
  private readonly quotes = new Map<string, { input: string; result: Promise<PlatformPrepared> }>();
  private minimumCpuReceiptVersion: 1 | 2;
  constructor(options: { baseUrl: string; pins: PlatformPins; sessionToken?: string; fetch?: FetchTransport; nowSeconds?: () => number;
    /** Independently reviewed expected protocol. Observing v2 also prevents later in-process downgrade. */ cpuReceiptVersion?: 1 | 2 }) {
    this.transport = new ApiTransport(options.baseUrl, { ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    this.origin = this.transport.origin; this.pins = freeze(platformPinsSchema.parse(options.pins));
    this.now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.minimumCpuReceiptVersion = z.union([z.literal(1), z.literal(2)]).parse(options.cpuReceiptVersion ?? 1);
  }
  async config(): Promise<PlatformRuntimeConfig> {
    // Capacity is revocable: a cached opt-in must not authorize a later unsigned payment plan.
    const config = configSchema.parse(await this.transport.request('/api/platform/config'));
    if ((config.cpuReceiptVersion ?? 1) < this.minimumCpuReceiptVersion) throw new Error('Reviewed CPU receipt protocol was downgraded');
    if (config.near && config.nearInferenceTask !== 'near_inference') {
      throw new Error('Reviewed NEAR configuration requires the explicit nearInferenceTask marker');
    }
    if (canonical(config.pins).toLowerCase() !== canonical(this.pins).toLowerCase()) {
      throw new Error('Platform deployment differs from reviewed pins');
    }
    if ((this.pins.spendPermissionProfile || this.pins.x402CpuProfile) && config.cpuReceiptVersion === 2) {
      throw new Error('This reviewed EOA funding domain does not support CPU receipt-v2');
    }
    if (new Set(config.capacity.map(host => host.hostId)).size !== config.capacity.length) throw new Error('Platform capacity contains ambiguous hosts');
    config.capacity.forEach(assertCpuLaneOffers);
    if (config.cpuReceiptVersion === 2) this.minimumCpuReceiptVersion = 2;
    return freeze(config);
  }
  private async owner(): Promise<string> {
    return z.object({ address: addressSchema, demo: z.boolean() }).strict().parse(await this.transport.request('/api/me')).address;
  }
  async balance() { await this.config(); return z.object({ available: balanceUnits }).strict().parse(await this.transport.request('/api/platform/balance')); }
  private async checkedPrepared(raw: unknown, requested: z.infer<typeof validatedPlatformQuoteInputSchema>): Promise<PlatformPrepared> {
    const config = await this.config(), owner = await this.owner(), value = platformPreparedSchema.parse(raw), q = value.quote;
    const requiredVersion = config.cpuReceiptVersion === 2 && !requested.near && !['session', 'near_inference'].includes(requested.task.kind) ? 2 : 1;
    if ((value.receiptVersion ?? 1) !== requiredVersion) throw new Error('Prepared run changed its reviewed CPU receipt version');
    const host = config.capacity.find(candidate => candidate.hostId === q.hostId), now = this.now();
    const offer = host ? cpuLaneOffer(host, requested.cpuScheduling?.lane ?? 'standard') : undefined;
    const requestedNear = requested.near, reviewedNear = config.near;
    const nearMatches = requestedNear ? !!reviewedNear && requestedNear.model === reviewedNear.model
      && requestedNear.maxTokens === reviewedNear.maxTokens && requestedNear.policySha256 === reviewedNear.policySha256
      && q.inferencePrice === reviewedNear.inferencePrice : q.inferencePrice === '0';
    const base = BigInt(q.maxSeconds) * BigInt(q.pricePerSecond) + BigInt(q.inferencePrice);
    const ceiling = base + (base * 900n + 9999n) / 10000n;
    if (!host || !offer || offer.lane === 'interruptible' && !offer.interruptible
      || requested.excludedHostIds?.includes(q.hostId) || !same(q.payer, owner)
      || canonical(value.input) !== canonical(requested) || q.leashId !== requested.leashId
      || !nearMatches
      || (requested.task.kind === 'exec' && (host.execEnabled !== true || requested.task.imageDigest !== host.imageDigest))
      || (requested.task.kind === 'session' && (host.sessionEnabled !== true || requested.task.imageDigest !== host.imageDigest))
      || q.maxSeconds !== requested.maxSeconds || q.pricePerSecond !== (requested.task.kind === 'session' && requested.task.resourceProfile
        && requested.task.resourceProfile !== 'full' ? offer.sessionPrices?.[requested.task.resourceProfile] : offer.pricePerSecond) || !Number.isSafeInteger(now)
      || q.quoteExpiry < now || q.quoteExpiry > now + 120 || q.quoteExpiry + q.maxSeconds > requested.deadline
      || now + q.maxSeconds > requested.deadline || (requested.regions.length > 0 && !requested.regions.includes(host.region))
      || q.regionHash !== keccak256(toHex(host.region)) || q.imageHash !== keccak256(toHex(host.imageDigest))
      || q.workloadHash !== platformWorkloadHash(requested) || base === 0n
      || ceiling.toString() !== value.ceiling || ceiling > BigInt(requested.maxSpend)) throw new Error('Platform quote changed its owner, scope, deadline or fee ceiling');
    if (!await verifyTypedData({ address: this.pins.quoteSigner,
      domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(this.pins), chainId: this.pins.chainId, verifyingContract: this.pins.escrowAddress },
      types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(q), signature: value.signature })) {
      throw new Error('Platform quote signature is invalid');
    }
    const funding = requested.funding, profile = this.pins.spendPermissionProfile;
    if (funding && !profile) throw new Error('Spend permission funding lacks its independently reviewed profile');
    const expectedReview = funding && profile ? { kind: 'base_spend_permission_v1', fundingAccount: funding.permission.account,
      refundBeneficiary: q.payer, reservationCeiling: value.ceiling,
      permissionHash: spendPermissionHash(this.pins.chainId, profile.managerAddress, funding.permission), managerAddress: profile.managerAddress } : undefined;
    if (canonical(value.fundingReview ?? null).toLowerCase() !== canonical(expectedReview ?? null).toLowerCase()) {
      throw new Error('Spend permission funding account or EOA refund beneficiary differs from original approval');
    }
    const data = funding ? spendPermissionOpenCall(q, value.signature, value.imageProof, value.regionProof, funding.permission)
      : encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun',
        args: [typedPlatformQuote(q), value.signature, value.imageProof, value.regionProof] });
    if (value.transaction.chainId !== this.pins.chainId || !same(value.transaction.to, this.pins.escrowAddress)
      || value.transaction.data !== data || value.transaction.value !== '0') throw new Error('Platform openRun transaction differs from its signed quote and proofs');
    return freeze(value);
  }
  quote(raw: unknown, idempotencyKey: string): Promise<PlatformPrepared> {
    const input = validatedPlatformQuoteInputSchema.parse(raw), key = idemSchema.parse(idempotencyKey), hash = canonical(input), prior = this.quotes.get(key);
    if (input.task.kind === 'session' && input.task.cystInput) return Promise.reject(new Error('Declared Cyst file input requires the reviewed Vault session client'));
    if (input.funding && !this.pins.spendPermissionProfile) return Promise.reject(new Error('Spend permission funding requires its reviewed domain3 profile'));
    if (prior) {
      if (prior.input !== hash) return Promise.reject(new Error('Platform idempotency key belongs to different work'));
      return prior.result.then(value => this.checkedPrepared(value, input));
    }
    if (this.quotes.size >= 128) return Promise.reject(new Error('Platform client quote history is full; retain original reservations and use a new client'));
    const result = this.config().then(config => {
      const task = input.task;
      if (input.near && (!config.near || input.near.model !== config.near.model
        || input.near.maxTokens !== config.near.maxTokens || input.near.policySha256 !== config.near.policySha256)) {
        throw new Error('Reviewed NEAR inference is unavailable for this platform request');
      }
      if (task.kind === 'exec' && !config.capacity.some(host => host.execEnabled === true && host.imageDigest === task.imageDigest
        && !input.excludedHostIds?.includes(host.hostId)
        && (input.regions.length === 0 || input.regions.includes(host.region)))) throw new Error('No reviewed command capacity matches the requested image and regions');
      if (task.kind === 'session' && !config.capacity.some(host => host.sessionEnabled === true && host.imageDigest === task.imageDigest
        && !input.excludedHostIds?.includes(host.hostId)
        && (input.regions.length === 0 || input.regions.includes(host.region)))) throw new Error('No reviewed paid session capacity matches the requested image and regions');
      return this.transport.request('/api/platform/quotes', { method: 'POST', body: input, idempotencyKey: key });
    })
      .then(value => this.checkedPrepared(value, input));
    this.quotes.set(key, { input: hash, result });
    void result.catch(() => { if (this.quotes.get(key)?.result === result) this.quotes.delete(key); });
    return result;
  }
  async openPlan(raw: unknown): Promise<PlatformWalletPlan> {
    const value = platformPreparedSchema.parse(raw); return (await this.checkedPrepared(value, value.input)).transaction;
  }
  private async checkedRun(raw: unknown, id?: string, authenticatedOwner?: string): Promise<PlatformRuntimeRun> {
    const value = runSchema.parse(raw), owner = authenticatedOwner ?? await this.owner();
    const feeBps = platformRunFeeBps(this.pins, value);
    if (value.cpuDispatch && (value.cpuDispatch.admissionTx !== value.admissionTx
      || !['completed', 'refunded'].includes(value.status) || value.charged !== '0' || value.refund !== value.ceiling
      || value.settlement && value.settlement.billableSeconds !== 0)) throw new Error('No-dispatch observation lacks exact terminal zero-work accounting');
    const maximum = BigInt(value.quote.maxSeconds) * BigInt(value.quote.pricePerSecond) + BigInt(value.quote.inferencePrice);
    if (!same(value.quote.payer, owner) || value.id !== value.quote.runId || (id !== undefined && value.id !== id)
      || maximum + (maximum * 900n + 9999n) / 10000n !== BigInt(value.ceiling)
      || (value.settlement !== null && (value.settlement.runId !== value.id || value.settlement.billableSeconds > value.quote.maxSeconds))) {
      throw new Error('Platform run changed its owner, request or fee ceiling');
    }
    if (value.charged !== null && value.refund !== null && BigInt(value.charged) + BigInt(value.refund) !== BigInt(value.ceiling)) {
      throw new Error('Platform reported funds do not conserve the reservation');
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
        throw new Error('Platform settlement inference charge or billed amount differs from the signed quote');
      }
    }
    if (value.status === 'completed' && (!value.settlement || value.charged === null || value.refund === null)) {
      throw new Error('Platform completed run lacks its exact settlement accounting');
    }
    if (value.status === 'refunded' && (value.charged !== '0' || value.refund !== value.ceiling)) {
      throw new Error('Platform refunded run differs from the original reservation');
    }
    return freeze(value);
  }
  async admit(raw: unknown, idempotencyKey: string): Promise<PlatformRuntimeRun> {
    await this.config(); const input = platformAdmissionSchema.parse(raw);
    const value = await this.checkedRun(await this.transport.request('/api/platform/runs', { method: 'POST', body: input,
      idempotencyKey: idemSchema.parse(idempotencyKey) }), input.runId);
    if (value.admissionTx !== input.transactionHash) throw new Error('Platform admission changed its original reservation transaction');
    return value;
  }
  async list(): Promise<{ runs: PlatformRuntimeRun[] }> {
    await this.config(); const value = z.object({ runs: z.array(runSchema).max(128) }).strict().parse(await this.transport.request('/api/platform/runs'));
    const owner = await this.owner();
    return freeze({ runs: await Promise.all(value.runs.map(run => this.checkedRun(run, undefined, owner))) });
  }
  async get(runId: string): Promise<PlatformRuntimeRun> {
    await this.config(); const id = bytes32Schema.parse(runId);
    return this.checkedRun(await this.transport.request('/api/platform/runs/' + id), id);
  }
  async command(runId: string, raw: unknown) {
    const id = bytes32Schema.parse(runId), command = sessionCommandSchema.parse(raw);
    const run = await this.get(id);
    if (!run.admissionTx || ['prepared', 'queued'].includes(run.status)) throw new Error('Paid session has not been admitted');
    return freeze(checkedSessionCommand(await this.transport.request('/api/platform/runs/' + id + '/commands',
      { method: 'POST', body: command, idempotencyKey: command.commandId, timeoutMs: 130_000 }), command));
  }
  async sessionEvents(runId: string, afterSequence = -1, limit = 8) {
    const id = bytes32Schema.parse(runId), cursor = sessionCursor(afterSequence, limit);
    const run = await this.get(id);
    if (!run.admissionTx) throw new Error('Paid session has not been admitted');
    return freeze(checkedSessionEvents(await this.transport.request('/api/platform/runs/' + id + '/events'
      + '?after=' + cursor.afterSequence + '&limit=' + cursor.limit), cursor.afterSequence, cursor.limit));
  }
  private async actionPlan(action: 'stop' | 'refund', runId: string, key: string): Promise<PlatformWalletPlan> {
    await this.get(runId); const id = bytes32Schema.parse(runId);
    const plan = transactionSchema.parse(await this.transport.request('/api/platform/runs/' + id + '/' + action,
      { method: 'POST', body: {}, idempotencyKey: idemSchema.parse(key) }));
    const data = encodeFunctionData({ abi: platformEscrowAbi, functionName: action === 'stop' ? 'requestStop' : 'refundRun', args: [id] });
    if (plan.chainId !== this.pins.chainId || !same(plan.to, this.pins.escrowAddress) || plan.data !== data || plan.value !== '0') {
      throw new Error('Platform owner action changed destination, chain or calldata');
    }
    return freeze(plan);
  }
  stopPlan(runId: string, idempotencyKey: string) { return this.actionPlan('stop', runId, idempotencyKey); }
  refundPlan(runId: string, idempotencyKey: string) { return this.actionPlan('refund', runId, idempotencyKey); }
}
