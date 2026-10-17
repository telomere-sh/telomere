import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, Problem } from '../common.js';
import { FileNosanaLedger, type NosanaReservation } from './nosana-ledger.js';
import { nosanaCidSchema, nosanaJobSchema, nosanaMarketSchema, solanaAddressSchema,
  type NosanaReadClient } from './nosana-reader.js';
import { FileSupplierSharedReserve } from './shared-reserve.js';

const amount = z.string().regex(/^(0|[1-9][0-9]{0,29})$/).refine(value => BigInt(value) > 0n);
const inputSchema = z.object({ owner: addressSchema, runId: bytes32Schema, jobAddress: solanaAddressSchema }).strict();
const approvedRunSchema = z.object({ owner: addressSchema, runId: bytes32Schema,
  hardwareClass: z.literal('gpu'), active: z.boolean(), maxSeconds: z.number().int().min(1).max(86_400),
  maxSpendUsdcMicros: amount.refine(value => BigInt(value) <= 250_000_000n),
  /** Canonical escrow opening and the earliest of run, Leash, and stop cutoffs. */
  openedAtSeconds: z.number().int().positive().safe(), expiresAtSeconds: z.number().int().positive().safe(),
  solanaPayer: solanaAddressSchema, market: solanaAddressSchema, ipfsJob: nosanaCidSchema,
}).strict();
export type ApprovedNosanaRun = z.infer<typeof approvedRunSchema>;
const treasurySchema = z.object({ availableNosBaseUnits: amount,
  /** Direct NOS-to-USDC observation. One million NOS base units equal one NOS. */
  usdcMicrosPerMillionNosBaseUnits: amount,
  asOfMs: z.number().int().nonnegative(), source: z.string().min(1).max(256),
}).strict();
export type NosanaTreasurySnapshot = z.infer<typeof treasurySchema>;
const policySchema = z.object({ approvedNodes: z.array(solanaAddressSchema).max(64),
  approvedMarkets: z.array(solanaAddressSchema).max(64),
  maxNosBaseUnitsPerSecond: amount, inventoryBufferBps: z.number().int().min(0).max(300),
  maxOpenReservedUsdcMicros: amount,
}).strict();
export type NosanaPolicy = z.infer<typeof policySchema>;
export interface NosanaDependencies {
  reader: NosanaReadClient;
  ledger: FileNosanaLedger;
  sharedReserve: FileSupplierSharedReserve;
  approvedRun(owner: string, runId: string): Promise<ApprovedNosanaRun>;
  treasurySnapshot(): Promise<NosanaTreasurySnapshot>;
  policy: NosanaPolicy;
  now?: () => number;
}
const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const nowSeconds = (milliseconds: number) => Math.floor(milliseconds / 1000);

/** Adopts a pre-existing running Nosana GPU job on an approved node; never creates or bills one. */
export class NosanaSupplierService {
  private readonly policy: NosanaPolicy;
  constructor(private readonly dependencies: NosanaDependencies) {
    this.policy = policySchema.parse(dependencies.policy);
    if (dependencies.sharedReserve.nosana !== dependencies.ledger)
      throw new Error('Nosana ledger differs from the shared supplier reserve');
    if (new Set(this.policy.approvedNodes).size !== this.policy.approvedNodes.length
      || new Set(this.policy.approvedMarkets).size !== this.policy.approvedMarkets.length)
      throw new Error('Duplicate Nosana node or market allowlist entry');
  }
  private now() { return this.dependencies.now?.() ?? Date.now(); }
  private publicRecord(record: NosanaReservation) {
    return { ...record, network: 'nosana' as const, jobPostingEnabled: false as const,
      meterEligible: false as const, billableSeconds: 0 as const, refundConfirmed: false as const };
  }
  async get(ownerValue: string, idValue: string) {
    const owner = addressSchema.parse(ownerValue), id = bytes32Schema.parse(idValue);
    const row = (await this.dependencies.ledger.read()).records.find(item => item.owner === owner && item.id === id);
    if (!row) throw new Problem(404, 'nosana_reservation_not_found', 'Nosana reservation not found.');
    return this.publicRecord(row);
  }
  async list(ownerValue: string) {
    const owner = addressSchema.parse(ownerValue);
    return { reservations: (await this.dependencies.ledger.read()).records.filter(item => item.owner === owner)
      .map(item => this.publicRecord(item)) };
  }
  async admit(value: unknown, keyValue: string) {
    const input = inputSchema.parse(value), key = keySchema.parse(keyValue);
    const requestHash = hashJson(input), id = hashJson({ domain: 'telomere.supplier.nosana.v1', owner: input.owner, key });
    const old = (await this.dependencies.ledger.read()).records.find(item => item.id === id);
    if (old) {
      if (old.requestHash !== requestHash) throw new Problem(409, 'nosana_idempotency_conflict', 'A different Nosana job owns this key.');
      return { reservation: this.publicRecord(old), replayed: true };
    }
    if (!this.policy.approvedNodes.length || !this.policy.approvedMarkets.length)
      throw new Problem(409, 'nosana_disabled', 'No Nosana nodes or markets are approved.');
    const approved = approvedRunSchema.parse(await this.dependencies.approvedRun(input.owner, input.runId));
    if (approved.owner !== input.owner || approved.runId !== input.runId || !approved.active
      || !this.policy.approvedMarkets.includes(approved.market)
      || approved.expiresAtSeconds <= approved.openedAtSeconds
      || approved.expiresAtSeconds > approved.openedAtSeconds + approved.maxSeconds
      || nowSeconds(this.now()) >= approved.expiresAtSeconds)
      throw new Problem(409, 'nosana_run_invalid', 'Use an active approved GPU run and market.');
    const [rawJob, rawMarket, rawSnapshot] = await Promise.all([
      this.dependencies.reader.job(input.jobAddress), this.dependencies.reader.market(approved.market),
      this.dependencies.treasurySnapshot(),
    ]);
    const job = nosanaJobSchema.parse(rawJob), market = nosanaMarketSchema.parse(rawMarket);
    const snapshot = treasurySchema.parse(rawSnapshot), now = this.now();
    if (nowSeconds(now) >= approved.expiresAtSeconds)
      throw new Problem(409, 'nosana_run_invalid', 'The approved GPU run expired while the provider was observed.');
    if (snapshot.asOfMs > now + 5000 || now - snapshot.asOfMs > 60_000)
      throw new Problem(409, 'nosana_treasury_stale', 'NOS inventory or direct NOS-to-USDC quote is stale.');
    if (job.state !== 1 || job.address !== input.jobAddress || job.payer !== approved.solanaPayer
      || job.market !== approved.market || job.ipfsJob !== approved.ipfsJob
      || !this.policy.approvedNodes.includes(job.node) || market.address !== approved.market
      || market.type !== 'PREMIUM' || job.timeout > approved.maxSeconds
      || BigInt(job.price) > BigInt(this.policy.maxNosBaseUnitsPerSecond)
      || job.timeStart <= 0 || job.timeEnd !== 0
      || job.timeStart < approved.openedAtSeconds
      || job.timeStart + job.timeout > approved.expiresAtSeconds
      || job.timeStart * 1000 > now + 5000 || (job.timeStart + job.timeout) * 1000 <= now) {
      throw new Problem(409, 'nosana_job_invalid', 'The running job must match the approved payer, workload, market, node, price, and timeout.');
    }
    const baseNos = BigInt(job.price) * BigInt(job.timeout);
    const reserveNos = ceil(baseNos * BigInt(10_000 + this.policy.inventoryBufferBps), 10_000n);
    const reserveUsdc = ceil(reserveNos * BigInt(snapshot.usdcMicrosPerMillionNosBaseUnits), 1_000_000n);
    if (reserveUsdc > BigInt(approved.maxSpendUsdcMicros))
      throw new Problem(409, 'nosana_budget_exceeded', 'The bounded NOS-to-USDC projection exceeds the approved run ceiling.');
    const record: NosanaReservation = { id, owner: input.owner, runId: input.runId, idemKey: key,
      requestHash, jobAddress: job.address, payer: job.payer, market: job.market, node: job.node,
      ipfsJob: job.ipfsJob, priceNosBaseUnitsPerSecond: String(job.price), timeoutSeconds: job.timeout,
      timeStartSeconds: job.timeStart, reservedNosBaseUnits: reserveNos.toString(),
      reservedUsdcMicros: reserveUsdc.toString(), quoteSource: snapshot.source,
      quoteAsOfMs: snapshot.asOfMs,
      usdcMicrosPerMillionNosBaseUnits: snapshot.usdcMicrosPerMillionNosBaseUnits,
      state: 'active_observed', reason: null, version: 0, createdAt: now, updatedAt: now,
      lastObservedAt: now };
    return this.dependencies.sharedReserve.admit({ network: 'nosana', owner: input.owner, runId: input.runId,
      reservedUsdcMicros: reserveUsdc.toString() }, () => this.dependencies.ledger.transact(file => {
      const previous = file.records.find(item => item.id === id);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new Problem(409, 'nosana_idempotency_conflict', 'A different Nosana job owns this key.');
        return { reservation: this.publicRecord(previous), replayed: true };
      }
      if (file.records.length >= 128 || file.records.some(item => item.owner === input.owner && item.runId === input.runId))
        throw new Problem(409, 'nosana_quota', 'Nosana journal is full or the Telomere run is already reserved.');
      if (file.records.some(item => item.jobAddress === input.jobAddress))
        throw new Problem(409, 'nosana_job_reserved', 'The Nosana job already belongs to a reservation.');
      const openNos = file.records.reduce((sum, item) => sum + BigInt(item.reservedNosBaseUnits), 0n);
      const openUsdc = file.records.reduce((sum, item) => sum + BigInt(item.reservedUsdcMicros), 0n);
      if (openNos + reserveNos > BigInt(snapshot.availableNosBaseUnits)
        || openUsdc + reserveUsdc > BigInt(this.policy.maxOpenReservedUsdcMicros))
        throw new Problem(409, 'nosana_treasury_insufficient', 'Uncommitted NOS or USDC treasury limit is insufficient.');
      file.records.push(record);
      return { reservation: this.publicRecord(record), replayed: false };
    }));
  }
  async reconcile(ownerValue: string, idValue: string) {
    const current = await this.get(ownerValue, idValue);
    const [rawJob, rawMarket] = await Promise.all([
      this.dependencies.reader.job(current.jobAddress), this.dependencies.reader.market(current.market),
    ]);
    const job = nosanaJobSchema.parse(rawJob), market = nosanaMarketSchema.parse(rawMarket);
    const now = this.now();
    return this.dependencies.ledger.transact(file => {
      const index = file.records.findIndex(item => item.owner === current.owner && item.id === current.id);
      const record = file.records[index];
      if (!record || record.version !== current.version)
        throw new Problem(409, 'nosana_concurrent_update', 'Nosana reservation changed during reconciliation.');
      let state: NosanaReservation['state'] = record.state, reason: string | null = record.reason;
      if (record.state === 'quarantined') {
        // Sticky until an operator verifies the external spend and resolves it out of band.
      } else if (job.address !== record.jobAddress || job.payer !== record.payer || job.market !== record.market
        || job.node !== record.node || job.ipfsJob !== record.ipfsJob
        || String(job.price) !== record.priceNosBaseUnitsPerSecond
        || job.timeout !== record.timeoutSeconds || job.timeStart !== record.timeStartSeconds
        || market.address !== record.market || market.type !== 'PREMIUM') {
        state = 'quarantined'; reason = 'external_identity_or_terms_changed';
      } else if (job.state === 2 || job.state === 3) {
        if (job.timeEnd <= 0 || job.timeEnd < job.timeStart || job.timeEnd > job.timeStart + job.timeout
          || job.timeEnd > nowSeconds(now)) {
          state = 'quarantined'; reason = 'terminal_time_unconfirmed';
        } else { state = 'closed_unsettled'; reason = 'external_stop_observed'; }
      } else if (record.state === 'closed_unsettled') {
        state = 'quarantined'; reason = 'closed_job_reappeared';
      } else if (job.state === 1 && job.timeEnd === 0 && (job.timeStart + job.timeout) * 1000 > now) {
        state = 'active_observed'; reason = null;
      } else {
        state = 'quarantined'; reason = 'job_status_ambiguous';
      }
      const updated: NosanaReservation = { ...record, state, reason, version: record.version + 1,
        lastObservedAt: now, updatedAt: now };
      file.records[index] = updated;
      return this.publicRecord(updated);
    });
  }
}
