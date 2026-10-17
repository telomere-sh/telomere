import { recoverTypedDataAddress, type Hex } from 'viem';
import { z } from 'zod';
import { digest, encodePaymentHeader, requirementsSchema, resourceSchema } from '../../payments/protocol.js';
import { vaultIncomeAuthorizationRef } from '../../payments/vault-income-chain.js';
import { incomeAddressSchema, incomeHashSchema } from '../../selection/income-endpoints/types.js';
import { VaultIncomePublicHttp, type VaultIncomeFetch } from './http.js';
import { assertVaultIncomeAttempt, assertVaultIncomePlan, immutable, reviewedVaultIncomeProfile, sameVaultIncomeValue,
  vaultIncomePayment, vaultIncomeTypedData } from './integrity.js';
import { VaultIncomeClientError, vaultIncomeInspectionSchema, vaultIncomeJournalStateSchema, vaultIncomePlanSchema,
  type VaultIncomeAttempt, type VaultIncomeInspection, type VaultIncomeJournal, type VaultIncomeJournalState,
  type VaultIncomePlan, type VaultIncomePublicProfile, type VaultIncomeReader, type VaultIncomeTypedData } from './types.js';

const offerSchema = z.object({ x402Version: z.literal(2), resource: resourceSchema,
  accepts: z.array(requirementsSchema).length(1), extensions: z.object({ 'telomere-request-binding':
    z.object({ version: z.literal(1), requestHash: incomeHashSchema }).strict() }).strict() }).strict();
const responseSchema = z.object({ success: z.boolean(), transaction: z.union([incomeHashSchema, z.literal('')]), network: z.string(),
  payer: incomeAddressSchema, amount: z.string(), errorReason: z.string().max(128).optional() }).strict();
const metadataSchema = z.object({ kind: z.literal('vault-payment-receipt'), agentId: incomeHashSchema,
  vault: incomeAddressSchema, asset: incomeAddressSchema, grossAmount: z.string() }).strict();
export type VaultIncomeClientResult = { operationId: string; status: 'planned' | 'authorized' | 'submitted' | 'pending' | 'settled' | 'reverted';
  transactionHash?: Hex; evidence?: VaultIncomeInspection };

/** Node payer client. An external signer supplies only EIP3009 signatures; a durable journal is mandatory. */
export class VaultIncomeClient {
  readonly profile: Readonly<VaultIncomePublicProfile>;
  private readonly profileHash: Hex;
  private readonly http: VaultIncomePublicHttp;
  private active = false;
  constructor(private readonly options: { profile: VaultIncomePublicProfile; reader: VaultIncomeReader; journal: VaultIncomeJournal;
    fetch?: VaultIncomeFetch; now?: () => number }) {
    this.profile = reviewedVaultIncomeProfile(options.profile); this.profileHash = digest(this.profile);
    if (!options.journal || typeof options.journal.exclusive !== 'function' || !options.reader
      || !sameVaultIncomeValue(reviewedVaultIncomeProfile(options.reader.profile), this.profile)) throw new VaultIncomeClientError('vault_income_client_configuration');
    this.http = new VaultIncomePublicHttp(this.profile.resourceUrl, options.fetch);
  }
  private async operation<T>(callback: (state: VaultIncomeJournalState, save: () => Promise<void>) => Promise<T>): Promise<T> {
    if (this.active) throw new VaultIncomeClientError('vault_income_client_busy'); this.active = true;
    try {
      return await this.options.journal.exclusive(this.profileHash, async journal => {
        const raw = await journal.load();
        if (raw !== undefined && raw !== null && Buffer.byteLength(JSON.stringify(raw)) > 1_048_576) throw new VaultIncomeClientError('vault_income_journal_limit');
        const state = raw === undefined || raw === null ? { version: 1 as const, profileHash: this.profileHash, attempts: [] }
          : vaultIncomeJournalStateSchema.parse(raw);
        if (state.profileHash !== this.profileHash || new Set(state.attempts.map(item => item.plan.operationId)).size !== state.attempts.length
          || new Set(state.attempts.map(item => item.plan.accepted.extra.telomere.challengeId)).size !== state.attempts.length
          || new Set(state.attempts.map(item => item.plan.authorization.nonce)).size !== state.attempts.length) throw new VaultIncomeClientError('vault_income_journal_invalid');
        for (const attempt of state.attempts) await assertVaultIncomeAttempt(attempt, this.profile);
        const save = async () => {
          const snapshot = vaultIncomeJournalStateSchema.parse(state);
          if (Buffer.byteLength(JSON.stringify(snapshot)) > 1_048_576) throw new VaultIncomeClientError('vault_income_journal_limit');
          await journal.save(snapshot);
        };
        return callback(state, save);
      });
    } finally { this.active = false; }
  }
  private attempt(state: VaultIncomeJournalState, operationId: string): VaultIncomeAttempt {
    const id = vaultIncomePlanSchema.shape.operationId.parse(operationId), attempt = state.attempts.find(value => value.plan.operationId === id);
    if (!attempt) throw new VaultIncomeClientError('vault_income_attempt_missing'); return attempt;
  }
  private async guardOtherAttempts(state: VaultIncomeJournalState, operationId: string, payer: string, save: () => Promise<void>): Promise<void> {
    for (const other of state.attempts) {
      if (other.plan.operationId === operationId || !other.submitted || other.plan.authorization.from.toLowerCase() !== payer.toLowerCase()) continue;
      const result = await this.inspect(other, save);
      if (result.status === 'settled') continue;
      if (result.status === 'reverted') {
        // A reverted outer transaction does not revoke its still-valid bearer authorization.
        const snapshot = await this.options.reader.check();
        if (BigInt(snapshot.block.timestamp) >= BigInt(other.plan.authorization.validBefore)
          && (await this.inspect(other, save)).status === 'reverted') continue;
      }
      throw new VaultIncomeClientError('vault_income_payer_reconciliation_required');
    }
  }
  async prepare(operationId: string, input: { payer: string; ttlSeconds?: number }): Promise<{ plan: VaultIncomePlan; typedData: VaultIncomeTypedData }> {
    const id = vaultIncomePlanSchema.shape.operationId.parse(operationId), payer = incomeAddressSchema.parse(input.payer);
    const ttl = z.number().int().min(1).max(120).parse(input.ttlSeconds ?? 120);
    return this.operation(async (state, save) => {
      const previous = state.attempts.find(item => item.plan.operationId === id);
      if (previous) {
        if (previous.plan.authorization.from !== payer) throw new VaultIncomeClientError('vault_income_attempt_conflict');
        return immutable({ plan: previous.plan, typedData: vaultIncomeTypedData(previous.plan, this.profile) });
      }
      if (state.attempts.length >= 128) throw new VaultIncomeClientError('vault_income_journal_capacity');
      await this.guardOtherAttempts(state, id, payer, save);
      const snapshot = await this.options.reader.check(), now = Math.floor((this.options.now ?? Date.now)() / 1000);
      if (!Number.isSafeInteger(now) || now < 1 || BigInt(now) - BigInt(snapshot.block.timestamp) > 299n
        || BigInt(snapshot.block.timestamp) > BigInt(now) + 30n) throw new VaultIncomeClientError('vault_income_clock_skew');
      const response = await this.http.send(); if (response.status !== 402 || response.required === undefined) throw new VaultIncomeClientError('vault_income_offer_required');
      const offer = offerSchema.parse(response.required), accepted = offer.accepts[0]!;
      if (offer.extensions['telomere-request-binding'].requestHash !== accepted.extra.telomere.requestHash) throw new VaultIncomeClientError('vault_income_offer_mismatch');
      const validBefore = BigInt(now + Math.min(ttl, accepted.maxTimeoutSeconds));
      const plan = vaultIncomePlanSchema.parse({ operationId: id, profileHash: this.profileHash, resource: offer.resource, accepted,
        authorization: { from: payer, to: this.profile.pins.payTo, value: this.profile.grossAmount, nonce: accepted.extra.telomere.nonce,
          validAfter: (BigInt(snapshot.block.timestamp) > 0n ? BigInt(snapshot.block.timestamp) - 1n : 0n).toString(), validBefore: validBefore.toString() } });
      assertVaultIncomePlan(plan, this.profile);
      if (state.attempts.some(item => item.plan.authorization.nonce === plan.authorization.nonce
        || item.plan.accepted.extra.telomere.challengeId === plan.accepted.extra.telomere.challengeId)) throw new VaultIncomeClientError('vault_income_offer_reused');
      state.attempts.push({ plan, submitted: false }); await save();
      return immutable({ plan, typedData: vaultIncomeTypedData(plan, this.profile) });
    });
  }
  async authorize(operationId: string, externalSignature: Hex): Promise<void> {
    const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).parse(externalSignature).toLowerCase() as Hex;
    return this.operation(async (state, save) => {
      const attempt = this.attempt(state, operationId);
      if (attempt.signature) {
        if (attempt.signature !== signature) throw new VaultIncomeClientError('vault_income_attempt_conflict'); return;
      }
      await this.guardOtherAttempts(state, operationId, attempt.plan.authorization.from, save);
      let signer: string; try { signer = await recoverTypedDataAddress({ ...vaultIncomeTypedData(attempt.plan, this.profile), signature }); }
      catch { throw new VaultIncomeClientError('vault_income_signature_mismatch'); }
      if (signer.toLowerCase() !== attempt.plan.authorization.from.toLowerCase()) throw new VaultIncomeClientError('vault_income_signature_mismatch');
      attempt.signature = signature; attempt.signedHeader = encodePaymentHeader(vaultIncomePayment(attempt.plan, signature)); await save();
    });
  }
  private async inspect(attempt: VaultIncomeAttempt, save: () => Promise<void>): Promise<VaultIncomeClientResult> {
    if (!attempt.candidateHash || !attempt.signature) return { operationId: attempt.plan.operationId,
      status: attempt.submitted ? 'submitted' : attempt.signature ? 'authorized' : 'planned' };
    // A previous success is withdrawn before the independent request, including RPC failure.
    attempt.observation = { status: 'pending', transactionHash: attempt.candidateHash }; await save();
    const evidence = vaultIncomeInspectionSchema.parse(await this.options.reader.inspect({ transactionHash: attempt.candidateHash,
      payment: vaultIncomePayment(attempt.plan, attempt.signature as Hex) }));
    if (evidence.transactionHash !== attempt.candidateHash) throw new VaultIncomeClientError('vault_income_hash_substitution');
    if (evidence.status === 'settled') {
      const gross = BigInt(this.profile.grossAmount), fee = evidence.classification === 'income' ? (gross * 100n + 9_999n) / 10_000n : 0n;
      const ref = vaultIncomeAuthorizationRef(this.profile.pins.chainId, this.profile.pins.asset, this.profile.pins.payTo,
        attempt.plan.authorization.from, attempt.plan.authorization.nonce);
      if (!evidence.block || !evidence.classification || evidence.grossAmount !== gross.toString()
        || evidence.payer?.toLowerCase() !== attempt.plan.authorization.from.toLowerCase() || evidence.paymentRef !== ref
        || evidence.incomeFee !== fee.toString() || evidence.netAmount !== (gross - fee).toString()) throw new VaultIncomeClientError('vault_income_evidence_invalid');
    }
    attempt.observation = evidence; await save();
    return immutable({ operationId: attempt.plan.operationId, status: evidence.status, transactionHash: attempt.candidateHash, evidence });
  }
  async check(operationId: string): Promise<VaultIncomeClientResult> {
    return this.operation(async (state, save) => this.inspect(this.attempt(state, operationId), save));
  }
  async submit(operationId: string): Promise<VaultIncomeClientResult> { return this.retry(operationId); }
  async retry(operationId: string): Promise<VaultIncomeClientResult> {
    return this.operation(async (state, save) => {
      const attempt = this.attempt(state, operationId);
      if (!attempt.signature || !attempt.signedHeader) throw new VaultIncomeClientError('vault_income_signature_required');
      if (!attempt.submitted) await this.guardOtherAttempts(state, operationId, attempt.plan.authorization.from, save);
      if (attempt.candidateHash) { const current = await this.inspect(attempt, save); if (current.status !== 'pending') return current; }
      await this.options.reader.check(); attempt.submitted = true; await save();
      const response = await this.http.send(attempt.signedHeader);
      if (response.payment === undefined) throw new VaultIncomeClientError('vault_income_result_ambiguous');
      const payment = responseSchema.parse(response.payment);
      if (payment.network !== `eip155:${this.profile.pins.chainId}` || payment.amount !== this.profile.grossAmount
        || payment.payer.toLowerCase() !== attempt.plan.authorization.from.toLowerCase()) throw new VaultIncomeClientError('vault_income_result_mismatch');
      if (payment.transaction) {
        if (attempt.candidateHash && attempt.candidateHash !== payment.transaction) throw new VaultIncomeClientError('vault_income_hash_substitution');
        attempt.candidateHash = payment.transaction; await save();
      }
      if (response.status === 200 && payment.success) {
        const metadata = metadataSchema.parse(response.body);
        if (metadata.agentId !== this.profile.pins.agentId || metadata.vault !== this.profile.pins.payTo
          || metadata.asset !== this.profile.pins.asset || metadata.grossAmount !== this.profile.grossAmount) throw new VaultIncomeClientError('vault_income_result_mismatch');
      } else if (![202, 422].includes(response.status) || payment.success) throw new VaultIncomeClientError('vault_income_result_ambiguous');
      return this.inspect(attempt, save);
    });
  }
}
