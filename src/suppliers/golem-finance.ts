import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, Problem } from '../common.js';
import { FileGolemFinanceLedger, GOLEM_FINANCE_MAX_DOCUMENTS, GOLEM_FINANCE_MAX_INTENTS,
  GOLEM_FINANCE_MAX_PAYMENTS, GOLEM_FINANCE_MAX_RUNS,
  type GolemFinanceFile, type GolemFinanceIntent, type GolemFinanceRecord } from './golem-finance-ledger.js';
import { golemAmountToBaseUnits, golemBaseUnitsToAmount, golemDocumentSummary, golemFinanceIdSchema, golemFinanceIntentId,
  golemOriginalBinding, golemOriginalRunSchema, golemPaymentFinalitySchema, golemPaymentSchema,
  golemReleaseEvidenceSchema, golemStopEvidenceSchema, golemTreasuryEvidenceSchema,
  type GolemFinanceAction, type GolemFinanceAuthorities,
  type GolemFinanceDocumentKind, type GolemFinanceProtocol, type GolemTreasuryEvidence } from './golem-finance-types.js';

const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const maximum = (...values: bigint[]) => values.reduce((a, b) => a > b ? a : b, 0n);
const minimum = (a: bigint, b: bigint) => a < b ? a : b;
const denied = (code: string, detail: string) => new Problem(409, 'golem_' + code, detail);
const unsettledIntent = (intent: GolemFinanceIntent) => intent.status === 'pending' || intent.status === 'unknown';

/** Unmounted financial controller for one original allocation/agreement/activity.
 * No wallet, provider execution or token conversion is supplied here. An opt-in
 * HTTP transport may be injected. An allocation limits this controller's payment authority; it
 * is never represented as a cap on all external provider liabilities. */
export class GolemFinancialLifecycle {
  private readonly now: () => number;
  private readonly ioTimeoutMs: number;
  private readonly options: { ledger: FileGolemFinanceLedger; protocol: GolemFinanceProtocol;
    authorities: GolemFinanceAuthorities; now?: () => number; ioTimeoutMs?: number };
  private criticalTail: Promise<void> = Promise.resolve();
  private criticalCount = 0;
  constructor(options: { ledger: FileGolemFinanceLedger; protocol: GolemFinanceProtocol;
    authorities: GolemFinanceAuthorities; now?: () => number; ioTimeoutMs?: number }) {
    this.options = Object.freeze({ ...options });
    this.now = options.now ?? Date.now;
    this.ioTimeoutMs = z.number().int().min(10).max(5000).parse(options.ioTimeoutMs ?? 5000);
  }
  private async critical<T>(work: () => Promise<T>): Promise<T> {
    if (this.criticalCount >= 16) throw denied('operation_busy', 'The bounded local financial authorization queue is full.');
    const previous = this.criticalTail; let release!: () => void;
    this.criticalTail = new Promise<void>(resolve => { release = resolve; }); this.criticalCount++;
    try { await previous; return await work(); } finally { this.criticalCount--; release(); }
  }
  private get policy() { return this.options.ledger.policy; }
  private fresh(asOfMs: number) {
    if (asOfMs > this.now() + 5000 || this.now() - asOfMs > 60_000) throw denied('evidence_stale', 'Original financial authority is stale.');
  }
  private async io<T>(call: (signal: AbortSignal) => Promise<T>, deadline = performance.now() + 15_000): Promise<T> {
    const remaining = Math.min(this.ioTimeoutMs, Math.floor(deadline - performance.now()));
    if (remaining <= 0) throw denied('io_deadline', 'The bounded original financial operation expired.');
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([call(abort.signal), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(denied('io_deadline', 'The bounded original financial operation expired.')); }, remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  private async treasury(deadline?: number): Promise<GolemTreasuryEvidence> {
    const value = golemTreasuryEvidenceSchema.parse(await this.io(signal => this.options.authorities.treasury(signal), deadline));
    this.fresh(value.asOfMs);
    if (value.authorityId !== this.policy.treasuryAuthorityId || value.policyId !== this.policy.policyId
      || value.requestorId !== this.policy.requestorId || value.payerAddr !== this.policy.payerAddr
      || value.paymentPlatform !== this.policy.paymentPlatform) throw denied('treasury_scope', 'Treasury authority differs from the original profile.');
    return value;
  }
  async initializeFresh(): Promise<void> {
    if (this.now() >= this.policy.expiresAtMs || this.policy.expiresAtMs - this.now() > 86_400_000) {
      throw denied('policy_expired', 'Initialize only an explicitly reviewed finite policy of at most one day.');
    }
    const initial = await this.treasury();
    if (BigInt(initial.availableGlmBaseUnits) === 0n || BigInt(initial.availableUsdcMicros) === 0n) {
      throw denied('initial_inventory_empty', 'Initial tracked inventory must be independently available.');
    }
    await this.options.ledger.initializeFresh(initial);
  }
  private row(file: GolemFinanceFile, owner: string, runId: string): GolemFinanceRecord {
    const row = file.records.find(value => value.original.owner === owner && value.original.runId === runId);
    if (!row) throw new Problem(404, 'golem_run_missing', 'Original Golem financial reservation is unavailable.');
    return row;
  }
  private ownerRun(owner: string, runId: string) { return { owner: addressSchema.parse(owner), runId: bytes32Schema.parse(runId) }; }
  private invoice(row: GolemFinanceRecord) { return row.documents.find(value => value.kind === 'invoice'); }
  private finalReady(row: GolemFinanceRecord) {
    const invoice = this.invoice(row);
    return !row.disputed && !!row.stopProofHash && !!invoice?.accepted
      && BigInt(invoice.totalBaseUnits) === BigInt(row.settledBaseUnits)
      && row.paidBaseUnits === row.settledBaseUnits
      && !row.intents.some(value => value.action !== 'release_allocation' && unsettledIntent(value));
  }
  private view(row: GolemFinanceRecord) {
    const complete = !!row.releaseProofHash && this.finalReady(row);
    const state = row.disputed ? 'quarantined' : complete ? 'complete' : this.finalReady(row) ? 'settled'
      : row.stopRequestedAtMs !== null ? 'stopping' : row.intents.some(unsettledIntent) || this.invoice(row) ? 'held' : 'active';
    return { ...structuredClone(row), state,
      reserveHeldGlmBaseUnits: complete ? '0' : row.original.maxGlmBaseUnits,
      reserveHeldUsdcMicros: complete ? '0' : row.original.maxUsdcMicros,
      allocationIsExternalLiabilityCap: false as const, meterEligible: false as const, billableSeconds: 0 as const };
  }
  async get(ownerValue: string, runValue: string) {
    const { owner, runId } = this.ownerRun(ownerValue, runValue);
    return this.view(this.row(await this.options.ledger.read(), owner, runId));
  }
  private async original(owner: string, runId: string, deadline?: number) {
    const value = golemOriginalRunSchema.parse(await this.io(signal => this.options.authorities.originalRun(owner, runId, signal), deadline));
    this.fresh(value.asOfMs);
    if (value.owner !== owner || value.runId !== runId || value.authorityId !== this.policy.runAuthorityId
      || value.requestorId !== this.policy.requestorId || value.payerAddr !== this.policy.payerAddr
      || value.paymentPlatform !== this.policy.paymentPlatform || value.spendUntilMs > this.policy.expiresAtMs) {
      throw denied('run_scope', 'The independently approved original run differs.');
    }
    return value;
  }
  private inventory(file: GolemFinanceFile, current: GolemTreasuryEvidence, extraGlm = 0n, extraUsdc = 0n) {
    const issuedGlm = file.records.reduce((sum, row) => sum + BigInt(row.original.maxGlmBaseUnits), extraGlm);
    const issuedUsdc = file.records.reduce((sum, row) => sum + BigInt(row.original.maxUsdcMicros), extraUsdc);
    if (issuedGlm > minimum(BigInt(this.policy.maxLifetimeGlmBaseUnits), BigInt(file.initialTreasury.availableGlmBaseUnits))
      || issuedUsdc > minimum(BigInt(this.policy.maxLifetimeUsdcMicros), BigInt(file.initialTreasury.availableUsdcMicros))) {
      throw denied('lifetime_budget', 'Original lifetime authority is exhausted; closure and refunds never renew it.');
    }
    const heldGlm = file.records.reduce((sum, row) => sum + (row.releaseProofHash && this.finalReady(row)
      ? 0n : BigInt(row.original.maxGlmBaseUnits) - BigInt(row.settledBaseUnits)), extraGlm);
    const heldUsdc = file.records.reduce((sum, row) => sum + (row.releaseProofHash && this.finalReady(row) ? 0n : BigInt(row.original.maxUsdcMicros)), extraUsdc);
    if (heldGlm > BigInt(current.availableGlmBaseUnits) || heldUsdc > BigInt(current.availableUsdcMicros)) {
      throw denied('inventory_unavailable', 'Current independently available tracked inventory does not cover held authority.');
    }
  }
  async admit(ownerValue: string, runValue: string, keyValue: string) {
    const { owner, runId } = this.ownerRun(ownerValue, runValue), key = keySchema.parse(keyValue);
    return this.critical(() => this.options.ledger.transact(async file => {
      const old = file.records.find(row => row.original.owner === owner && row.original.runId === runId);
      if (old) { if (old.admissionKey !== key) throw denied('admission_conflict', 'The original run already has an admission identity.'); return this.view(old); }
      if (file.records.length >= GOLEM_FINANCE_MAX_RUNS || file.records.some(row => row.original.owner === owner && row.admissionKey === key)) {
        throw denied('quota', 'The finite Golem admission inventory or original key is exhausted.');
      }
      const original = await this.original(owner, runId), treasury = await this.treasury();
      if (!original.active || this.now() >= original.spendUntilMs || this.now() >= this.policy.expiresAtMs) throw denied('spend_disabled', 'The original approval cannot admit new authority.');
      if (file.records.some(row => row.original.allocationId === original.allocationId
        || row.original.agreementId === original.agreementId || row.original.activityId === original.activityId)) {
        throw denied('binding_reused', 'The allocation, agreement or activity already belongs to an original run.');
      }
      this.inventory(file, treasury, BigInt(original.maxGlmBaseUnits), BigInt(original.maxUsdcMicros));
      const binding = golemOriginalBinding(original);
      const row: GolemFinanceRecord = { original: binding, bindingHash: hashJson(binding), admissionKey: key,
        createdAtMs: this.now(), stopRequestedAtMs: null, disputed: false,
        acceptedBaseUnits: '0', paidBaseUnits: '0', settledBaseUnits: '0', documents: [], payments: [], intents: [],
        stopProofHash: null, releaseProofHash: null };
      file.records.push(row); return this.view(row);
    }));
  }
  private checkDocument(row: GolemFinanceRecord, summary: ReturnType<typeof golemDocumentSummary>) {
    const value = summary.value, binding = row.original;
    if (value.issuerId !== binding.providerId || value.recipientId !== binding.requestorId
      || value.payerAddr !== binding.payerAddr || value.payeeAddr !== binding.payeeAddr
      || value.paymentPlatform !== binding.paymentPlatform || value.agreementId !== binding.agreementId
      || ('activityId' in value ? value.activityId !== binding.activityId : value.activityIds[0] !== binding.activityId)) {
      throw denied('document_scope', 'Provider document differs from the original parties, activity or payment platform.');
    }
  }
  private observe(row: GolemFinanceRecord, summary: ReturnType<typeof golemDocumentSummary>) {
    this.checkDocument(row, summary);
    const old = row.documents.find(value => value.kind === summary.kind && value.id === summary.id);
    if (old) { if (old.hash !== summary.hash) throw denied('document_changed', 'The original document economic terms changed.'); return old; }
    if (row.documents.length >= GOLEM_FINANCE_MAX_DOCUMENTS) throw denied('document_quota', 'Original document inventory is full.');
    const invoice = this.invoice(row), largest = maximum(...row.documents.filter(value => value.kind === 'debit').map(value => BigInt(value.totalBaseUnits)));
    if (summary.kind === 'debit' && (invoice || BigInt(summary.totalBaseUnits) < largest)) {
      throw denied('debit_regression', 'A new debit cannot follow a final invoice or reduce the cumulative amount.');
    }
    if (summary.kind === 'invoice' && invoice) throw denied('invoice_changed', 'The original final invoice identity is immutable.');
    const document = { kind: summary.kind, id: summary.id, hash: summary.hash, totalBaseUnits: summary.totalBaseUnits, accepted: false };
    row.documents.push(document);
    if (BigInt(document.totalBaseUnits) > BigInt(row.original.maxGlmBaseUnits)
      || summary.kind === 'invoice' && (BigInt(document.totalBaseUnits) < maximum(largest, BigInt(row.acceptedBaseUnits))
        || (row.stopRequestedAtMs !== null || this.now() >= row.original.spendUntilMs || this.now() >= this.policy.expiresAtMs)
          && BigInt(document.totalBaseUnits) > BigInt(row.acceptedBaseUnits))) row.disputed = true;
    return document;
  }
  private confirmDocument(row: GolemFinanceRecord, summary: ReturnType<typeof golemDocumentSummary>) {
    const document = this.observe(row, summary);
    const intent = row.intents.find(value => value.action === (summary.kind === 'debit' ? 'accept_debit' : 'accept_invoice') && value.resourceId === summary.id);
    if (intent && intent.status !== 'aborted_before_send' && ['ACCEPTED', 'SETTLED'].includes(summary.status)
      && !row.disputed && BigInt(summary.totalBaseUnits) <= BigInt(row.original.maxGlmBaseUnits)) {
      intent.status = 'confirmed'; document.accepted = true;
      row.acceptedBaseUnits = maximum(BigInt(row.acceptedBaseUnits), BigInt(summary.totalBaseUnits)).toString();
    }
  }
  private createIntent(row: GolemFinanceRecord, action: GolemFinanceAction, resourceId: string, total: string | null, key: string) {
    const id = golemFinanceIntentId(row.bindingHash, action, resourceId);
    const requestHash = hashJson({ id, totalBaseUnits: total });
    const reused = row.intents.find(value => value.key === key);
    if (reused && reused.requestHash !== requestHash) throw denied('idempotency_conflict', 'A different original financial action owns this key.');
    const old = row.intents.find(value => value.id === id);
    if (old) { if (old.requestHash !== requestHash) throw denied('intent_changed', 'Original financial intent differs.'); return { intent: old, created: false }; }
    if (row.intents.length >= GOLEM_FINANCE_MAX_INTENTS) throw denied('intent_quota', 'Original single-attempt inventory is full.');
    const intent: GolemFinanceIntent = { id, key, requestHash, action, resourceId, totalBaseUnits: total, status: 'pending', createdAtMs: this.now() };
    row.intents.push(intent); return { intent, created: true };
  }
  private spendFence(row: GolemFinanceRecord, kind: GolemFinanceDocumentKind, target: string, active: boolean) {
    const stopped = row.stopRequestedAtMs !== null || !active || this.now() >= row.original.spendUntilMs || this.now() >= this.policy.expiresAtMs;
    if (row.disputed || stopped && (kind === 'debit' || BigInt(target) > BigInt(row.acceptedBaseUnits))) {
      throw denied('spend_disabled', 'No new liability may be accepted after stop or expiry; original debt remains held.');
    }
  }
  private async spendGuard(file: GolemFinanceFile, row: GolemFinanceRecord, kind: GolemFinanceDocumentKind, target: string, deadline: number) {
    const treasury = await this.treasury(deadline);
    const current = await this.original(row.original.owner, row.original.runId, deadline);
    if (hashJson(golemOriginalBinding(current)) !== row.bindingHash) throw denied('original_changed', 'Original financial binding changed.');
    this.spendFence(row, kind, target, current.active); this.inventory(file, treasury);
    return current.active;
  }
  private async accept(ownerValue: string, runValue: string, kind: GolemFinanceDocumentKind, idValue: string, keyValue: string) {
    const { owner, runId } = this.ownerRun(ownerValue, runValue), id = golemFinanceIdSchema.parse(idValue), key = keySchema.parse(keyValue);
    const deadline = performance.now() + 15_000;
    const retained = await this.critical(() => this.options.ledger.transact(async file => {
      const row = this.row(file, owner, runId), action = kind === 'debit' ? 'accept_debit' : 'accept_invoice';
      const old = row.intents.find(value => value.action === action && value.resourceId === id);
      if (old) { this.createIntent(row, action, id, old.totalBaseUnits, key); return { created: false, intent: structuredClone(old), binding: row.original, refused: false }; }
      if (row.intents.some(value => unsettledIntent(value) && value.action.startsWith('accept_'))) throw denied('acceptance_unknown', 'Reconcile the original acceptance before accepting another document.');
      const summary = golemDocumentSummary(kind, await this.io(signal => this.options.protocol.document(kind, id, signal), deadline));
      if (summary.id !== id) throw denied('document_scope', 'Provider returned another document identity.');
      const document = this.observe(row, summary);
      if (row.disputed) return { created: false, intent: null, binding: row.original, refused: true };
      if (summary.status !== 'RECEIVED') throw denied('untracked_acceptance', 'Only an original received document can create a new acceptance.');
      await this.spendGuard(file, row, kind, document.totalBaseUnits, deadline);
      const next = this.createIntent(row, action, id, document.totalBaseUnits, key);
      return { ...next, intent: structuredClone(next.intent), binding: row.original, refused: false };
    }));
    if (retained.refused) throw denied('invoice_disputed', 'Changed or excessive provider liability stays held for manual reconciliation.');
    if (!retained.created || !retained.intent) return this.get(owner, runId);
    const originalIntent = retained.intent;
    const outcome = await this.critical(() => this.options.ledger.authorize(async (file, uncertain) => {
      const row = this.row(file, owner, runId), intent = row.intents.find(value => value.id === originalIntent.id);
      if (!intent || intent.status !== 'pending') return 'retained' as const;
      let attempted = false;
      try {
        const active = await this.spendGuard(file, row, kind, intent.totalBaseUnits!, deadline);
        uncertain();
        await this.io(signal => {
          // No await or unlock between this fence and initial POST invocation.
          this.spendFence(row, kind, intent.totalBaseUnits!, active); attempted = true;
          return this.options.protocol.mutate(intent.action, retained.binding, id, golemBaseUnitsToAmount(intent.totalBaseUnits!), signal);
        }, deadline);
        const result = golemDocumentSummary(kind, await this.io(signal => this.options.protocol.document(kind, id, signal), deadline));
        if (result.id !== id) throw denied('document_scope', 'Acceptance acknowledgement changed document identity.');
        this.confirmDocument(row, result);
        if (row.intents.find(value => value.id === originalIntent.id)?.status !== 'confirmed') {
          throw denied('acceptance_unknown', 'The independent original document does not confirm acceptance.');
        }
        return 'confirmed' as const;
      } catch {
        intent.status = attempted ? 'unknown' : 'aborted_before_send';
        return attempted ? 'unknown' as const : 'aborted' as const;
      }
    }));
    if (outcome === 'unknown' || outcome === 'aborted') throw denied(outcome === 'unknown' ? 'outcome_unknown' : 'spend_disabled',
      outcome === 'unknown' ? 'The original acceptance may have committed. Reconcile without another mutation.' : 'Original authority was withdrawn before dispatch.');
    return this.get(owner, runId);
  }
  acceptDebit(owner: string, runId: string, id: string, key: string) { return this.accept(owner, runId, 'debit', id, key); }
  acceptInvoice(owner: string, runId: string, id: string, key: string) { return this.accept(owner, runId, 'invoice', id, key); }

  private async cleanupIntent(owner: string, runId: string, action: 'destroy_activity' | 'terminate_agreement' | 'release_allocation', key: string) {
    const retained = await this.critical(() => this.options.ledger.transact(file => {
      const row = this.row(file, owner, runId);
      if (action === 'release_allocation' && !this.finalReady(row)) throw denied('release_unproven', 'Confirmed stop, original final invoice and independent settlement are required.');
      const resource = action === 'destroy_activity' ? row.original.activityId : action === 'terminate_agreement' ? row.original.agreementId : row.original.allocationId;
      const next = this.createIntent(row, action, resource, null, key);
      return { ...next, intent: structuredClone(next.intent), binding: row.original };
    }));
    if (!retained.created) return;
    await this.critical(() => this.options.ledger.authorize(async (file, uncertain) => {
      const row = this.row(file, owner, runId), intent = row.intents.find(value => value.id === retained.intent.id);
      if (!intent || intent.status !== 'pending') return;
      if (action === 'release_allocation' && !this.finalReady(row)) { intent.status = 'aborted_before_send'; return; }
      uncertain();
      try { await this.io(signal => this.options.protocol.mutate(action, retained.binding, intent.resourceId, undefined, signal)); }
      catch { /* Retain the one original unknown operation; never retry it. */ }
      // HTTP acknowledgement proves neither physical stop nor allocation release.
      intent.status = 'unknown';
    }));
  }
  async requestStop(ownerValue: string, runValue: string, keyValue: string) {
    const { owner, runId } = this.ownerRun(ownerValue, runValue), key = keySchema.parse(keyValue);
    await this.critical(() => this.options.ledger.transact(file => { const row = this.row(file, owner, runId); row.stopRequestedAtMs ??= this.now(); }));
    await this.cleanupIntent(owner, runId, 'destroy_activity', hashJson({ key, action: 'destroy_activity' }));
    await this.cleanupIntent(owner, runId, 'terminate_agreement', hashJson({ key, action: 'terminate_agreement' }));
    return this.get(owner, runId);
  }
  async reconcile(ownerValue: string, runValue: string, input: { invoiceId?: string; paymentIds?: string[] } = {}) {
    const { owner, runId } = this.ownerRun(ownerValue, runValue);
    const checked = z.object({ invoiceId: golemFinanceIdSchema.optional(), paymentIds: z.array(golemFinanceIdSchema).max(GOLEM_FINANCE_MAX_PAYMENTS).optional() }).strict().parse(input);
    const deadline = performance.now() + 15_000;
    return this.critical(() => this.options.ledger.transact(async file => {
      const row = this.row(file, owner, runId);
      const ids = [...new Set([...row.payments.map(value => value.id), ...(checked.paymentIds ?? [])])];
      if (ids.length > GOLEM_FINANCE_MAX_PAYMENTS) throw denied('payment_quota', 'Original payment inventory is full.');
      const invoiceId = checked.invoiceId ?? this.invoice(row)?.id;
      const documents = [...row.intents.filter(value => value.action.startsWith('accept_')).map(value => ({
        kind: value.action === 'accept_debit' ? 'debit' as const : 'invoice' as const, id: value.resourceId })),
      ...(invoiceId ? [{ kind: 'invoice' as const, id: invoiceId }] : [])];
      const seen = new Set<string>();
      for (const document of documents) {
        const key = document.kind + ':' + document.id; if (seen.has(key)) continue; seen.add(key);
        const summary = golemDocumentSummary(document.kind, await this.io(signal => this.options.protocol.document(document.kind, document.id, signal), deadline));
        if (summary.id !== document.id) throw denied('document_scope', 'Original reconciliation document changed identity.');
        this.confirmDocument(row, summary);
      }
      const stop = golemStopEvidenceSchema.parse(await this.io(signal => this.options.authorities.stop(row.original, signal), deadline));
      this.checkProof(row, stop); row.stopProofHash = stop.confirmed ? stop.proofHash : null;
      if (stop.confirmed) {
        if (stop.activityId !== row.original.activityId || stop.agreementId !== row.original.agreementId
          || stop.activityStoppedAtMs > this.now() || stop.agreementTerminatedAtMs > this.now()) throw denied('stop_scope', 'Original physical stop proof differs.');
        // A later loss of finality restores the hold, never the old spend authority.
        row.stopRequestedAtMs ??= this.now();
        for (const intent of row.intents) if (['destroy_activity', 'terminate_agreement'].includes(intent.action)) intent.status = 'confirmed';
      }
      for (const id of ids) {
        const payment = golemPaymentSchema.parse(await this.io(signal => this.options.protocol.payment(id, signal), deadline));
        if (payment.paymentId !== id || payment.payerId !== row.original.requestorId || payment.payeeId !== row.original.providerId
          || payment.payerAddr !== row.original.payerAddr || payment.payeeAddr !== row.original.payeeAddr
          || payment.paymentPlatform !== row.original.paymentPlatform) throw denied('payment_scope', 'Original payment parties or platform differ.');
        const shares = [...payment.agreementPayments.map(value => ({ key: 'agreement:' + value.agreementId, id: value.agreementId, kind: 'agreement', ...value })),
          ...payment.activityPayments.map(value => ({ key: 'activity:' + value.activityId, id: value.activityId, kind: 'activity', ...value }))];
        if (new Set(shares.map(value => value.key)).size !== shares.length
          || shares.reduce((sum, value) => sum + golemAmountToBaseUnits(value.amount), 0n) !== golemAmountToBaseUnits(payment.amount)) throw denied('payment_shares', 'Payment shares are duplicated or do not conserve the payment total.');
        const matched = shares.filter(value => value.kind === 'agreement' ? value.id === row.original.agreementId : value.id === row.original.activityId);
        if (!matched.length || matched.some(value => value.allocationId !== row.original.allocationId)) throw denied('payment_allocation', 'Payment does not spend the original allocation.');
        const scoped = matched.reduce((sum, value) => sum + golemAmountToBaseUnits(value.amount), 0n), hash = hashJson(payment);
        const proof = golemPaymentFinalitySchema.parse(await this.io(signal => this.options.authorities.payment(row.original, payment, signal), deadline));
        this.checkProof(row, proof);
        if (proof.paymentId !== id || proof.paymentHash !== hash || proof.confirmed && proof.confirmations < this.policy.minimumConfirmations) throw denied('payment_finality', 'Independent payment proof differs or lacks confirmations.');
        const previous = row.payments.find(value => value.id === id);
        if (previous && (previous.hash !== hash || previous.scopedBaseUnits !== scoped.toString())) throw denied('payment_changed', 'Original payment evidence changed.');
        // A chain transfer has one permanent identity even when finality is lost.
        // Distinct API payment IDs must never turn that transfer into new funds.
        const retainedReferences = file.records.flatMap(value => value.payments)
          .filter(value => value.id === id && value.settlementReference !== null).map(value => value.settlementReference!);
        const settlementReference = proof.confirmed ? proof.settlementReference
          : previous?.settlementReference ?? retainedReferences[0] ?? null;
        if (settlementReference !== null && (retainedReferences.some(value => value !== settlementReference)
          || file.records.some(value => value.payments.some(payment => payment.id !== id
            && payment.settlementReference === settlementReference)))) {
          throw denied('settlement_reused', 'The original chain settlement already belongs to another payment identity.');
        }
        const next = { id, hash, scopedBaseUnits: scoped.toString(), totalBaseUnits: golemAmountToBaseUnits(payment.amount).toString(), confirmed: proof.confirmed,
          proofHash: proof.confirmed ? proof.proofHash : null, settlementReference, checkedAtMs: this.now() };
        if (previous) Object.assign(previous, next); else row.payments.push(next);
      }
      row.paidBaseUnits = row.payments.reduce((sum, value) => sum + BigInt(value.scopedBaseUnits), 0n).toString();
      row.settledBaseUnits = row.payments.reduce((sum, value) => sum + (value.confirmed ? BigInt(value.scopedBaseUnits) : 0n), 0n).toString();
      if (BigInt(row.paidBaseUnits) > BigInt(row.original.maxGlmBaseUnits)) throw denied('payment_exceeds_cap', 'Payment projection exceeds original authority; manual reconciliation is required.');
      if (this.finalReady(row) && row.intents.some(value => value.action === 'release_allocation')) {
        const release = golemReleaseEvidenceSchema.parse(await this.io(signal => this.options.authorities.release(row.original, signal), deadline));
        this.checkProof(row, release);
        if (release.confirmed) {
          if (release.allocationId !== row.original.allocationId) throw denied('release_scope', 'Independent release proof differs.');
          row.releaseProofHash = release.proofHash;
          for (const intent of row.intents) if (intent.action === 'release_allocation') intent.status = 'confirmed';
        } else {
          row.releaseProofHash = null;
          for (const intent of row.intents) if (intent.action === 'release_allocation' && intent.status !== 'aborted_before_send') intent.status = 'unknown';
        }
      }
      return this.view(row);
    }));
  }
  private checkProof(row: GolemFinanceRecord, proof: { authorityId: string; bindingHash: string; asOfMs: number }) {
    this.fresh(proof.asOfMs);
    if (proof.authorityId !== this.policy.finalityAuthorityId || proof.bindingHash !== row.bindingHash) throw denied('proof_scope', 'Independent original finality authority differs.');
  }
  async releaseAllocation(ownerValue: string, runValue: string, keyValue: string) {
    const { owner, runId } = this.ownerRun(ownerValue, runValue), key = keySchema.parse(keyValue);
    await this.reconcile(owner, runId);
    await this.cleanupIntent(owner, runId, 'release_allocation', key);
    return this.reconcile(owner, runId);
  }
}
