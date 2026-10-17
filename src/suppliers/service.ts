import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, Problem } from '../common.js';
import { akashAddressSchema, akashDseqSchema, akashQuantitySchema,
  type AkashBid, type AkashDeployment, type AkashDeploymentCloseClient,
  type AkashLeaseWriteClient, type AkashReadClient,
  type AkashSettings } from './akash-console.js';
import { FileSupplierLedger, supplierReserveHeld, type SupplierRecord } from './ledger.js';
import { FileSupplierSharedReserve } from './shared-reserve.js';
import { akashBindingPinsSchema, verifyAkashSignedBinding, type AkashSignedBinding,
  type ExpectedAkashBinding } from './akash-signed-binding.js';
import { verifyAkashExactBid, type AkashExactBidReader } from './akash-exact-bid.js';
import { akashPriceAtoms, canonicalAkashPrice, reservedAkashUact, sameAkashPrice } from './akash-price.js';

const positiveMoney = akashQuantitySchema.refine(value => BigInt(value) > 0n);
const planSchema = z.object({
  owner: addressSchema, runId: bytes32Schema, akashOwner: akashAddressSchema,
  dseq: akashDseqSchema, gseq: z.number().int().positive().safe(),
  oseq: z.number().int().positive().safe(), plannedSeconds: z.number().int().min(1).max(86_400),
  maxSpendUsdcMicros: positiveMoney.refine(value => BigInt(value) <= 250_000_000n),
}).strict();
const treasurySnapshotSchema = z.object({
  availableUact: positiveMoney, usdcMicrosPerMillionUact: positiveMoney,
  asOfMs: z.number().int().nonnegative(), source: z.string().min(1).max(256),
}).strict();
export type TreasurySnapshot = z.infer<typeof treasurySnapshotSchema>;
const approvedRunSchema = z.object({ owner: addressSchema, runId: bytes32Schema,
  hardwareClass: z.literal('cpu'), active: z.boolean(),
  maxSeconds: z.number().int().min(1).max(86_400), maxSpendUsdcMicros: positiveMoney,
  /** From the original signed quote, checked by the authoritative admitted-run source. */
  quoteDigest: bytes32Schema.optional(),
  /** Required at lease activation; optional for read-only reservation planning. */
  expiresAtMs: z.number().int().positive().safe().optional(),
}).strict();
export type ApprovedSupplierRun = z.infer<typeof approvedRunSchema>;
const activationRunSchema = approvedRunSchema.extend({ expiresAtMs: z.number().int().positive().safe() });
export interface SupplierPolicy {
  /** Operator-approved Akash addresses. An empty list admits nobody. */
  approvedProviders: string[];
  /** Conservative admission projection, not a chain-enforced maximum. */
  maxBlocksPerHour: number;
  /** Must be at most 300 (3%). */
  inventoryBufferBps: number;
  maxOpenReservedUsdcMicros: string;
  minProviderUptime30d?: number;
  /** Private operator switch. Defaults off. The caller still needs an approved run and Console credits. */
  leaseCreationEnabled?: boolean;
  /** Private operator switch. Defaults off; a close does not confirm refund or final provider cost. */
  deploymentCloseEnabled?: boolean;
  /** Opt-in owner EIP-712 authorization for the exact Akash provider/deployment/cost tuple. */
  requireSignedBinding?: boolean;
  bindingPins?: z.infer<typeof akashBindingPinsSchema>;
}
export interface SupplierDependencies {
  akash: AkashReadClient;
  /** Optional read-only full-BidID check; never enables a paid lease by itself. */
  exactBidReader?: AkashExactBidReader;
  leaseWriter?: AkashLeaseWriteClient;
  closeWriter?: AkashDeploymentCloseClient;
  ledger: FileSupplierLedger;
  sharedReserve: FileSupplierSharedReserve;
  /** Authoritative Telomere escrow/admission check, not user-provided form data. */
  approvedRun(owner: string, runId: string): Promise<ApprovedSupplierRun>;
  /** Trusted operator-side source; never accepted from a public caller. */
  treasurySnapshot(): Promise<TreasurySnapshot>;
  /** Trusted private store of the owner's original binding and platform quote. */
  signedBinding?(owner: string, runId: string): Promise<AkashSignedBinding>;
  policy: SupplierPolicy;
  now?: () => number;
}
const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const LEASE_POST_WINDOW_MS = 120_000;
const policySchema = z.object({ approvedProviders: z.array(akashAddressSchema).max(64),
  maxBlocksPerHour: z.number().int().min(3600).max(100_000),
  inventoryBufferBps: z.number().int().min(0).max(300),
  maxOpenReservedUsdcMicros: positiveMoney, minProviderUptime30d: z.number().min(0).max(1).optional(),
  leaseCreationEnabled: z.boolean().optional(),
  deploymentCloseEnabled: z.boolean().optional(),
  requireSignedBinding: z.boolean().optional(), bindingPins: akashBindingPinsSchema.optional(),
}).strict();

function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
function sameBid(bid: AkashBid, input: z.infer<typeof planSchema>): boolean {
  return bid.id.owner === input.akashOwner && bid.id.dseq === input.dseq && bid.id.gseq === input.gseq
    && bid.id.oseq === input.oseq && bid.state === 'open' && bid.price.denom === 'uact'
    && akashPriceAtoms(bid.price.amount) > 0n;
}

function pinnedDeployment(deployment: AkashDeployment, settings: AkashSettings, record: SupplierRecord): boolean {
  return deployment.deployment.id.owner === record.akashOwner
    && deployment.deployment.id.dseq === record.dseq
    && deployment.deployment.hash === record.deploymentHash
    && deployment.deployment.state === 'active'
    && settings.dseq === record.dseq && settings.autoTopUpEnabled
    && settings.runtimeLimitHours === record.runtimeHours && settings.runtimeEndsAt === null;
}

function exactLease(deployment: AkashDeployment, record: SupplierRecord): boolean {
  const lease = deployment.leases[0];
  return deployment.deployment.id.owner === record.akashOwner
    && deployment.deployment.id.dseq === record.dseq
    && deployment.deployment.hash === record.deploymentHash
    && deployment.deployment.state === 'active'
    && deployment.leases.length === 1 && lease?.id.owner === record.akashOwner
    && lease.id.dseq === record.dseq && lease.id.gseq === record.gseq
    && lease.id.oseq === record.oseq && lease.id.provider === record.provider
    && lease.state === 'active' && lease.price.denom === 'uact'
    && sameAkashPrice(lease.price.amount, record.pricePerBlockUact);
}

/** Pre-approved Akash CPU reservations, opt-in lease submission, and read-only reconciliation. */
export class SupplierService {
  private readonly policy: z.infer<typeof policySchema>;
  constructor(private readonly dependencies: SupplierDependencies) {
    this.policy = policySchema.parse(dependencies.policy);
    if (dependencies.sharedReserve.akash !== dependencies.ledger)
      throw new Error('Akash ledger differs from the shared supplier reserve');
    if (new Set(this.policy.approvedProviders).size !== this.policy.approvedProviders.length)
      throw new Error('Duplicate approved Akash provider');
    if (this.policy.requireSignedBinding && (!this.policy.bindingPins || !dependencies.signedBinding))
      throw new Error('Signed Akash supplier binding requires reviewed pins and a trusted private source');
  }
  private now(): number { return this.dependencies.now?.() ?? Date.now(); }

  private async binding(expected: ExpectedAkashBinding): Promise<`0x${string}` | undefined> {
    if (!this.policy.requireSignedBinding) return undefined;
    try {
      const raw = await this.dependencies.signedBinding!(expected.owner, expected.runId);
      return await verifyAkashSignedBinding(raw, this.policy.bindingPins!, expected);
    } catch {
      throw new Problem(409, 'supplier_binding_invalid', 'The exact admitted run and owner-signed Akash terms must agree.');
    }
  }

  private publicRecord(record: SupplierRecord) {
    return { ...record, network: 'akash' as const,
      leaseCreationEnabled: this.policy.leaseCreationEnabled === true && this.dependencies.leaseWriter !== undefined,
      deploymentCloseEnabled: this.policy.deploymentCloseEnabled === true && this.dependencies.closeWriter !== undefined,
      reserveHeldUact: supplierReserveHeld(record) ? record.reservedUact : '0',
      reserveHeldUsdcMicros: supplierReserveHeld(record) ? record.reservedUsdcMicros : '0',
      billableSeconds: 0 as const, meterEligible: false as const,
      refundConfirmed: false as const };
  }
  async get(ownerValue: string, idValue: string) {
    const owner = addressSchema.parse(ownerValue), id = bytes32Schema.parse(idValue);
    const record = (await this.dependencies.ledger.read()).records.find(item => item.owner === owner && item.id === id);
    if (!record) throw new Problem(404, 'supplier_not_found', 'Supplier reservation not found.');
    return this.publicRecord(record);
  }
  async list(ownerValue: string) {
    const owner = addressSchema.parse(ownerValue);
    return { reservations: (await this.dependencies.ledger.read()).records.filter(item => item.owner === owner)
      .map(record => this.publicRecord(record)) };
  }

  async plan(value: unknown, keyValue: string) {
    const input = planSchema.parse(value), key = keySchema.parse(keyValue);
    const requestHash = hashJson(input), id = hashJson({ domain: 'telomere.supplier.akash.v1', owner: input.owner, key });
    const old = (await this.dependencies.ledger.read()).records.find(item => item.id === id);
    if (old) {
      if (old.requestHash !== requestHash) throw new Problem(409, 'supplier_idempotency_conflict', 'A different supplier request already owns this key.');
      return { reservation: this.publicRecord(old), replayed: true };
    }
    const approvedRun = approvedRunSchema.parse(await this.dependencies.approvedRun(input.owner, input.runId));
    if (approvedRun.owner !== input.owner || approvedRun.runId !== input.runId || !approvedRun.active
      || approvedRun.maxSeconds < input.plannedSeconds
      || BigInt(approvedRun.maxSpendUsdcMicros) < BigInt(input.maxSpendUsdcMicros))
      throw new Problem(409, 'supplier_run_invalid', 'Use an active approved CPU run with enough time and escrow budget.');
    if (this.policy.approvedProviders.length === 0) throw new Problem(409, 'supplier_disabled', 'No Akash providers are approved.');
    const [providers, bids, deployment, settings, rawSnapshot] = await Promise.all([
      this.dependencies.akash.providers(this.policy.approvedProviders), this.dependencies.akash.bids(input.dseq),
      this.dependencies.akash.deployment(input.dseq), this.dependencies.akash.settings(input.dseq),
      this.dependencies.treasurySnapshot(),
    ]);
    const snapshot = treasurySnapshotSchema.parse(rawSnapshot), now = this.now();
    if (snapshot.asOfMs > now + 5000 || now - snapshot.asOfMs > 60_000)
      throw new Problem(409, 'supplier_treasury_stale', 'Treasury inventory or price snapshot is stale.');
    if (deployment.deployment.id.owner !== input.akashOwner || deployment.deployment.id.dseq !== input.dseq
      || deployment.deployment.state !== 'active' || deployment.leases.length !== 0
      || settings.dseq !== input.dseq || !settings.autoTopUpEnabled || settings.runtimeLimitHours === null
      || settings.runtimeLimitHours > 24 || settings.runtimeLimitHours * 3600 < input.plannedSeconds
      || settings.runtimeLimitHours * 3600 > approvedRun.maxSeconds
      || settings.runtimeEndsAt !== null) {
      throw new Problem(409, 'supplier_deployment_invalid', 'Use an owned, empty Akash deployment with a bounded runtime limit.');
    }
    const approved = new Set(this.policy.approvedProviders);
    const eligible = bids.filter(bid => sameBid(bid, input) && approved.has(bid.id.provider))
      .filter(bid => providers.some(provider => provider.owner === bid.id.provider && provider.isOnline
        && provider.isAudited && provider.isValidVersion
        && provider.uptime30d >= (this.policy.minProviderUptime30d ?? 0.95)));
    eligible.sort((left, right) => {
      const difference = akashPriceAtoms(left.price.amount) - akashPriceAtoms(right.price.amount);
      return difference < 0n ? -1 : difference > 0n ? 1 : left.id.provider.localeCompare(right.id.provider);
    });
    const bid = eligible[0];
    if (!bid) throw new Problem(409, 'supplier_bid_unavailable', 'No open bid from an approved healthy Akash provider.');
    const pricePerBlockUact = canonicalAkashPrice(bid.price.amount);
    const blocks = BigInt(this.policy.maxBlocksPerHour * settings.runtimeLimitHours);
    const reservedUact = reservedAkashUact(pricePerBlockUact, blocks, BigInt(this.policy.inventoryBufferBps));
    const reservedUsdcMicros = ceil(reservedUact * BigInt(snapshot.usdcMicrosPerMillionUact), 1_000_000n);
    if (reservedUact.toString().length > 30 || reservedUsdcMicros > BigInt(input.maxSpendUsdcMicros))
      throw new Problem(409, 'supplier_budget_exceeded', 'The bounded Akash projection exceeds the run ceiling.');
    const bindingDigest = await this.binding({ owner: input.owner, runId: input.runId,
      approvedQuoteDigest: approvedRun.quoteDigest, approvedMaxSeconds: approvedRun.maxSeconds,
      approvedMaxSpendUsdcMicros: approvedRun.maxSpendUsdcMicros,
      akashOwner: input.akashOwner, dseq: input.dseq, gseq: input.gseq, oseq: input.oseq,
      provider: bid.id.provider, deploymentHash: deployment.deployment.hash,
      pricePerBlockUact, runtimeHours: settings.runtimeLimitHours,
      maxBlocksPerHour: this.policy.maxBlocksPerHour, maxSpendUsdcMicros: reservedUsdcMicros.toString(), nowMs: now });
    const record: SupplierRecord = { id, owner: input.owner, runId: input.runId, idemKey: key, requestHash,
      akashOwner: input.akashOwner, dseq: input.dseq, gseq: input.gseq, oseq: input.oseq,
      provider: bid.id.provider, deploymentHash: deployment.deployment.hash,
      pricePerBlockUact, runtimeHours: settings.runtimeLimitHours,
      reservedUact: reservedUact.toString(), reservedUsdcMicros: reservedUsdcMicros.toString(),
      quoteSource: snapshot.source, quoteAsOfMs: snapshot.asOfMs,
      usdcMicrosPerMillionUact: snapshot.usdcMicrosPerMillionUact,
      maxBlocksPerHour: this.policy.maxBlocksPerHour, state: 'planned', version: 0,
      ...(bindingDigest ? { signedBindingDigest: bindingDigest } : {}),
      createdAt: now, updatedAt: now, lastObservedAt: null, reason: null };
    return this.dependencies.sharedReserve.admit({ network: 'akash', owner: input.owner, runId: input.runId,
      reservedUsdcMicros: reservedUsdcMicros.toString() }, () => this.dependencies.ledger.transact(file => {
      const previous = file.records.find(item => item.id === id);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Problem(409, 'supplier_idempotency_conflict', 'A different supplier request already owns this key.');
        return { reservation: this.publicRecord(previous), replayed: true };
      }
      if (file.records.length >= 128 || file.records.some(item => item.owner === input.owner && item.runId === input.runId))
        throw new Problem(409, 'supplier_quota', 'Supplier journal is full or the run is already reserved.');
      if (file.records.some(item => item.akashOwner === input.akashOwner && item.dseq === input.dseq))
        throw new Problem(409, 'supplier_deployment_reserved', 'The Akash deployment already belongs to a supplier reservation.');
      const open = file.records.reduce((sum, item) => sum + (supplierReserveHeld(item) ? BigInt(item.reservedUact) : 0n), 0n);
      const openUsdc = file.records.reduce((sum, item) => sum + (supplierReserveHeld(item) ? BigInt(item.reservedUsdcMicros) : 0n), 0n);
      if (open + reservedUact > BigInt(snapshot.availableUact)
        || openUsdc + reservedUsdcMicros > BigInt(this.policy.maxOpenReservedUsdcMicros))
        throw new Problem(409, 'supplier_treasury_insufficient', 'Uncommitted treasury inventory is insufficient.');
      file.records.push(record);
      return { reservation: this.publicRecord(record), replayed: false };
    }));
  }

  /** Operator-only local cancellation after observing the exact deployment still has no lease. */
  async cancelPlanned(ownerValue: string, idValue: string) {
    const current = await this.get(ownerValue, idValue);
    if (current.state === 'canceled_unsubmitted') return { reservation: current, replayed: true as const };
    if (current.state !== 'planned')
      throw new Problem(409, 'supplier_cancellation_unsafe', 'The lease may have been submitted; its reserve must stay held.');
    const [deployment, settings] = await Promise.all([
      this.dependencies.akash.deployment(current.dseq), this.dependencies.akash.settings(current.dseq),
    ]);
    if (!pinnedDeployment(deployment, settings, current) || deployment.leases.length !== 0)
      throw new Problem(409, 'supplier_cancellation_unsafe', 'The pinned deployment is no longer empty; its reserve must stay held.');
    return this.dependencies.ledger.transact(file => {
      const index = file.records.findIndex(row => row.owner === current.owner && row.id === current.id);
      const record = file.records[index];
      if (!record) throw new Problem(404, 'supplier_not_found', 'Supplier reservation not found.');
      if (record.state === 'canceled_unsubmitted') return { reservation: this.publicRecord(record), replayed: true as const };
      if (record.state !== 'planned')
        throw new Problem(409, 'supplier_cancellation_unsafe', 'The lease may have been submitted; its reserve must stay held.');
      if (record.version !== current.version)
        throw new Problem(409, 'supplier_concurrent_update', 'Supplier reservation changed before cancellation.');
      const updated: SupplierRecord = { ...record, state: 'canceled_unsubmitted',
        reason: 'operator_canceled_before_submission', version: record.version + 1, updatedAt: this.now() };
      file.records[index] = updated;
      return { reservation: this.publicRecord(updated), replayed: false as const };
    });
  }

  /** Operator-only, single-attempt POST. The durable pending state is never automatically replayed. */
  async activate(ownerValue: string, idValue: string) {
    if (!this.policy.leaseCreationEnabled || !this.dependencies.leaseWriter)
      throw new Problem(409, 'supplier_lease_creation_disabled', 'Akash lease creation is disabled.');
    const current = await this.get(ownerValue, idValue);
    if (current.state !== 'planned')
      throw new Problem(409, 'supplier_lease_already_attempted', 'This reservation cannot submit another lease.');
    if (current.signedBindingDigest && !this.policy.requireSignedBinding)
      throw new Problem(409, 'supplier_binding_invalid', 'A signed Akash reservation cannot drop its owner-binding policy.');
    const approved = activationRunSchema.parse(await this.dependencies.approvedRun(current.owner, current.runId));
    const [providers, bids, deployment, settings, rawSnapshot] = await Promise.all([
      this.dependencies.akash.providers([current.provider]), this.dependencies.akash.bids(current.dseq),
      this.dependencies.akash.deployment(current.dseq), this.dependencies.akash.settings(current.dseq),
      this.dependencies.treasurySnapshot(),
    ]);
    const snapshot = treasurySnapshotSchema.parse(rawSnapshot), now = this.now();
    if (approved.owner !== current.owner || approved.runId !== current.runId || !approved.active
      || approved.maxSeconds < current.runtimeHours * 3600
      || approved.expiresAtMs <= now + current.runtimeHours * 3_600_000 + LEASE_POST_WINDOW_MS
      || BigInt(approved.maxSpendUsdcMicros) < BigInt(current.reservedUsdcMicros))
      throw new Problem(409, 'supplier_run_invalid', 'The approved CPU run no longer covers the full lease.');
    if (snapshot.asOfMs > now + 5000 || now - snapshot.asOfMs > 60_000
      || ceil(BigInt(current.reservedUact) * BigInt(snapshot.usdcMicrosPerMillionUact), 1_000_000n)
        > BigInt(current.reservedUsdcMicros))
      throw new Problem(409, 'supplier_treasury_stale', 'The fresh treasury quote exceeds the reserved USDC ceiling.');
    if (!this.policy.approvedProviders.includes(current.provider)
      || !providers.some(provider => provider.owner === current.provider && provider.isOnline
        && provider.isAudited && provider.isValidVersion
        && provider.uptime30d >= (this.policy.minProviderUptime30d ?? 0.95))
      || !bids.some(bid => bid.id.owner === current.akashOwner && bid.id.dseq === current.dseq
        && bid.id.gseq === current.gseq && bid.id.oseq === current.oseq
        && bid.id.provider === current.provider && bid.state === 'open'
        && bid.price.denom === 'uact' && sameAkashPrice(bid.price.amount, current.pricePerBlockUact)))
      throw new Problem(409, 'supplier_bid_unavailable', 'The pinned Akash bid or provider is no longer eligible.');
    if (!pinnedDeployment(deployment, settings, current) || deployment.leases.length !== 0)
      throw new Problem(409, 'supplier_deployment_invalid', 'The pinned empty deployment or runtime limit changed.');
    const bindingDigest = await this.binding({ owner: current.owner, runId: current.runId,
      approvedQuoteDigest: approved.quoteDigest, approvedMaxSeconds: approved.maxSeconds,
      approvedMaxSpendUsdcMicros: approved.maxSpendUsdcMicros,
      akashOwner: current.akashOwner, dseq: current.dseq, gseq: current.gseq, oseq: current.oseq,
      provider: current.provider, deploymentHash: current.deploymentHash,
      pricePerBlockUact: current.pricePerBlockUact, runtimeHours: current.runtimeHours,
      maxBlocksPerHour: current.maxBlocksPerHour, maxSpendUsdcMicros: current.reservedUsdcMicros, nowMs: now });
    if (this.policy.requireSignedBinding && (!current.signedBindingDigest || bindingDigest !== current.signedBindingDigest))
      throw new Problem(409, 'supplier_binding_invalid', 'The original owner-signed Akash terms changed before lease submission.');
    if (this.policy.requireSignedBinding) {
      if (this.dependencies.exactBidReader) {
        const matching = bids.filter(bid => bid.id.owner === current.akashOwner
          && bid.id.dseq === current.dseq && bid.id.gseq === current.gseq
          && bid.id.oseq === current.oseq && bid.id.provider === current.provider
          && bid.state === 'open' && bid.price.denom === 'uact'
          && sameAkashPrice(bid.price.amount, current.pricePerBlockUact));
        try {
          if (matching.length !== 1 || matching[0]?.id.bseq === undefined)
            throw new Error('No unique exact Akash bid sequence');
          const bidId = { owner: current.akashOwner, dseq: current.dseq,
            gseq: current.gseq, oseq: current.oseq, provider: current.provider,
            bseq: matching[0].id.bseq };
          verifyAkashExactBid(await this.dependencies.exactBidReader.getBid(bidId),
            { ...bidId, pricePerBlockUact: current.pricePerBlockUact });
        } catch {
          throw new Problem(409, 'supplier_exact_bid_unverified',
            'The full Akash chain bid identity and price could not be verified.');
        }
        throw new Problem(409, 'supplier_atomic_budget_unavailable',
          'The exact bid fixes unit price but Akash lease creation does not bound lifetime spend or USDC reserve.');
      }
      throw new Problem(409, 'supplier_atomic_price_unavailable',
        'The Akash Console lease API cannot atomically select the owner-approved exact bid and price.');
    }
    const pending = await this.dependencies.ledger.transact(file => {
      const index = file.records.findIndex(row => row.id === current.id && row.owner === current.owner);
      const record = file.records[index];
      if (!record || record.version !== current.version || record.state !== 'planned')
        throw new Problem(409, 'supplier_concurrent_update', 'Supplier reservation changed before lease submission.');
      const heldUact = file.records.reduce((sum, row) => sum + (supplierReserveHeld(row) ? BigInt(row.reservedUact) : 0n), 0n);
      const heldUsdc = file.records.reduce((sum, row) => sum + (supplierReserveHeld(row) ? BigInt(row.reservedUsdcMicros) : 0n), 0n);
      if (heldUact > BigInt(snapshot.availableUact)
        || heldUsdc > BigInt(this.policy.maxOpenReservedUsdcMicros))
        throw new Problem(409, 'supplier_treasury_insufficient', 'Akash credit inventory no longer covers open reserves.');
      const updated: SupplierRecord = { ...record, state: 'lease_submission_pending', reason: 'lease_post_outcome_unknown',
        version: record.version + 1, updatedAt: now };
      file.records[index] = updated;
      return updated;
    });
    try {
      const response = await this.dependencies.leaseWriter.createLease({ dseq: pending.dseq,
        gseq: pending.gseq, oseq: pending.oseq, provider: pending.provider });
      if (!exactLease(response, pending)) throw new Error('Akash lease POST returned changed identity or terms');
    } catch {
      // Even a network or response-parse error can follow a successful remote lease.
      throw new Problem(409, 'supplier_lease_outcome_unknown',
        'Lease submission may have succeeded; reconcile the exact deployment before operator recovery.');
    }
    return { reservation: this.publicRecord(pending), submitted: true as const };
  }

  /** Operator-only, single-attempt close. A lost response must be reconciled, never replayed. */
  async requestClose(ownerValue: string, idValue: string) {
    if (!this.policy.deploymentCloseEnabled || !this.dependencies.closeWriter)
      throw new Problem(409, 'supplier_deployment_close_disabled', 'Akash deployment closure is disabled.');
    const current = await this.get(ownerValue, idValue);
    if (current.state !== 'active')
      throw new Problem(409, 'supplier_close_already_attempted', 'This reservation cannot submit a deployment close.');
    const [deployment, settings] = await Promise.all([
      this.dependencies.akash.deployment(current.dseq), this.dependencies.akash.settings(current.dseq),
    ]);
    if (!exactLease(deployment, current) || settings.dseq !== current.dseq
      || settings.runtimeLimitHours !== current.runtimeHours)
      throw new Problem(409, 'supplier_deployment_changed', 'The pinned active Akash lease or runtime limit changed.');
    const pending = await this.dependencies.ledger.transact(file => {
      const index = file.records.findIndex(row => row.owner === current.owner && row.id === current.id);
      const record = file.records[index];
      if (!record || record.version !== current.version || record.state !== 'active')
        throw new Problem(409, 'supplier_concurrent_update', 'Supplier reservation changed before deployment closure.');
      const updated: SupplierRecord = { ...record, state: 'closure_submission_pending',
        reason: 'deployment_delete_outcome_unknown', version: record.version + 1, updatedAt: this.now() };
      file.records[index] = updated;
      return updated;
    });
    try { await this.dependencies.closeWriter.closeDeployment(pending.dseq); }
    catch {
      throw new Problem(409, 'supplier_close_outcome_unknown',
        'Deployment close may have succeeded; reconcile the exact deployment before operator recovery.');
    }
    return { reservation: this.publicRecord(pending), submitted: true as const };
  }

  /** Never bills from a remote lease status. Missing or changed external facts quarantine the reservation. */
  async reconcile(ownerValue: string, idValue: string) {
    const current = await this.get(ownerValue, idValue);
    if (current.state === 'canceled_unsubmitted') return current;
    const [deployment, settings] = await Promise.all([
      this.dependencies.akash.deployment(current.dseq), this.dependencies.akash.settings(current.dseq),
    ]);
    const now = this.now();
    return this.dependencies.ledger.transact(file => {
      const index = file.records.findIndex(item => item.id === current.id && item.owner === current.owner);
      const record = file.records[index];
      if (!record || record.version !== current.version) throw new Problem(409, 'supplier_concurrent_update', 'Supplier reservation changed during reconciliation.');
      let state: SupplierRecord['state'] = record.state;
      let reason: string | null = record.reason;
      const matching = deployment.leases.filter(lease => lease.id.owner === record.akashOwner && lease.id.dseq === record.dseq
        && lease.id.gseq === record.gseq && lease.id.oseq === record.oseq);
      if (record.state === 'quarantined') {
        // Quarantine is sticky. An operator must inspect external spend and clear it out of band.
      } else if (deployment.deployment.id.owner !== record.akashOwner || deployment.deployment.id.dseq !== record.dseq
        || deployment.deployment.hash !== record.deploymentHash || settings.dseq !== record.dseq
        || !settings.autoTopUpEnabled || settings.runtimeLimitHours !== record.runtimeHours
        || deployment.leases.length !== matching.length || matching.length > 1
        || matching.some(lease => lease.id.provider !== record.provider || lease.price.denom !== 'uact'
          || !sameAkashPrice(lease.price.amount, record.pricePerBlockUact))) {
        state = 'quarantined'; reason = 'external_identity_or_terms_changed';
      } else if (deployment.deployment.state === 'closed' || matching[0]?.state === 'closed') {
        state = 'closed_unsettled'; reason = 'external_close_observed';
      } else if (record.state === 'closed_unsettled') {
        state = 'quarantined'; reason = 'closed_lease_reappeared';
      } else if (record.state === 'closure_submission_pending' && matching.length === 1
        && matching[0]!.state === 'active' && deployment.deployment.state === 'active') {
        state = 'closure_submission_pending'; reason = record.reason;
      } else if (matching.length === 1 && matching[0]!.state === 'active'
        && deployment.deployment.state === 'active' && settings.runtimeEndsAt !== null
        && new Date(settings.runtimeEndsAt).getTime() > now) {
        state = 'active'; reason = null;
      } else if (matching.length === 0
        && (record.state === 'planned' || record.state === 'lease_submission_pending')
        && deployment.deployment.state === 'active'
        && settings.runtimeEndsAt === null) {
        state = record.state; reason = record.state === 'planned' ? null : record.reason;
      } else {
        state = 'quarantined'; reason = 'lease_status_ambiguous';
      }
      const updated: SupplierRecord = { ...record, state, reason, version: record.version + 1,
        lastObservedAt: now, updatedAt: now };
      file.records[index] = updated;
      return this.publicRecord(updated);
    });
  }
}
