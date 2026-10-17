import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { keccak256, type Hex } from 'viem';
import type { Database } from '../store.js';
import { authorizationKey, canonical, challengeIdentity, digest, PaymentError, paymentPayer, paymentPayloadSchema,
  requirementsSchema, resourceSchema, type PaymentPayload, type PaymentResource, type Scheme, type SettleResponse, type VerifyResponse } from './protocol.js';
import type { PaymentChain, PreparedPayment } from './gateway.js';
import { paymentChallenges, paymentJournal, paymentLock, paymentMigrationSQL, paymentResourceResults } from './schema.js';

type Journal = typeof paymentJournal.$inferSelect;
export type PaymentRequired = { x402Version: 2; resource: PaymentResource;
  accepts: PaymentPayload['accepted'][]; extensions: { 'telomere-request-binding': { version: 1; requestHash: Hex } } };

/** Dedicated signer, durable pre-broadcast journal, and server-issued signed nonce binding. */
export class X402PaymentService {
  private readonly maximumChallenges: number;
  constructor(private readonly db: Database, readonly chain: PaymentChain, private readonly clock: () => number = Date.now,
    options: { maximumChallenges?: number } = {}) {
    this.maximumChallenges = options.maximumChallenges ?? 10_000;
    if (!Number.isInteger(this.maximumChallenges) || this.maximumChallenges < 1 || this.maximumChallenges > 10_000) {
      throw new Error('Payment challenge capacity must be an integer from 1 through 10000');
    }
  }
  async initialize(): Promise<void> {
    await this.db.transaction(async tx => {
      for (const statement of paymentMigrationSQL.split(';').map(value => value.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
    });
  }
  supported() {
    const pins = this.chain.pins;
    return { kinds: (['exact', 'upto'] as const).filter(scheme => pins[scheme]).map(scheme => ({ x402Version: 2, scheme,
      network: `eip155:${pins.chainId}`, extra: { facilitatorAddress: pins.facilitator } })),
      extensions: ['telomere-request-binding'], signers: { 'eip155:*': [pins.facilitator] } };
  }
  async challenge(input: { resource: PaymentResource; requestHash: Hex; amount: string; scheme: Scheme; maxTimeoutSeconds?: number }): Promise<PaymentRequired> {
    const resource = resourceSchema.parse(input.resource), pins = this.chain.pins;
    if (!/^[1-9][0-9]{0,77}$/.test(input.amount)) throw new PaymentError(400, 'invalid_payment_maximum');
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.requestHash)) throw new PaymentError(400, 'invalid_request_binding');
    if (!pins[input.scheme]) throw new PaymentError(503, 'unsupported_payment_scheme');
    const identity = challengeIdentity(), timeout = input.maxTimeoutSeconds ?? 300;
    const requirements = requirementsSchema.parse({ scheme: input.scheme, network: `eip155:${pins.chainId}`,
      asset: pins.asset, payTo: pins.payTo, amount: input.amount, maxTimeoutSeconds: timeout,
      extra: { name: pins[input.scheme]!.name, version: pins[input.scheme]!.version,
        assetTransferMethod: input.scheme === 'exact' ? 'eip3009' : 'permit2', facilitatorAddress: pins.facilitator,
        telomere: { challengeId: identity.id, nonce: identity.nonce, requestHash: input.requestHash.toLowerCase() } } });
    await this.db.transaction(async tx => {
      const locks = await tx.select().from(paymentLock).where(eq(paymentLock.id, 1)).for('update');
      if (locks.length !== 1) throw new PaymentError(503, 'payment_service_unavailable');
      const [capacity] = await tx.select({ total: sql<number>`count(*)::integer` }).from(paymentChallenges);
      if (!capacity || capacity.total >= this.maximumChallenges) throw new PaymentError(503, 'payment_challenge_capacity_reached');
      // This limit is durable and shares the settlement lock. Expired/consumed
      // challenges are retained as original-payment evidence, never pruned here.
      await tx.insert(paymentChallenges).values({ id: identity.id, nonce: identity.nonce, requestHash: input.requestHash.toLowerCase(),
        resource, requirements, expiresAt: new Date(this.clock() + timeout * 1000) });
    });
    return { x402Version: 2, resource, accepts: [requirements],
      extensions: { 'telomere-request-binding': { version: 1, requestHash: input.requestHash } } };
  }
  private async bound(payment: PaymentPayload, expectedRequestHash?: Hex, reader: Pick<Database, 'select'> = this.db): Promise<void> {
    const binding = payment.accepted.extra.telomere;
    const [challenge] = await reader.select().from(paymentChallenges).where(eq(paymentChallenges.id, binding.challengeId)).limit(1);
    if (!challenge || canonical(payment.accepted) !== canonical(challenge.requirements)
      || canonical(payment.resource) !== canonical(challenge.resource) || binding.requestHash !== challenge.requestHash
      || (expectedRequestHash !== undefined && binding.requestHash !== expectedRequestHash.toLowerCase())) throw new PaymentError(409, 'payment_request_mismatch');
    if (payment.extensions && payment.extensions['telomere-request-binding'].requestHash !== binding.requestHash) throw new PaymentError(409, 'payment_request_mismatch');
    const deadline = 'authorization' in payment.payload ? payment.payload.authorization.validBefore : payment.payload.permit2Authorization.deadline;
    if (challenge.expiresAt.getTime() <= this.clock() || BigInt(deadline) * 1000n > BigInt(challenge.expiresAt.getTime())) throw new PaymentError(422, 'challenge_expired');
  }
  async verify(input: unknown, expectedRequestHash?: Hex): Promise<VerifyResponse> {
    try {
      const payment = paymentPayloadSchema.parse(input);
      await this.bound(payment, expectedRequestHash);
      const [used] = await this.db.select({ key: paymentJournal.key }).from(paymentJournal)
        .where(eq(paymentJournal.challengeId, payment.accepted.extra.telomere.challengeId)).limit(1);
      if (used) throw new PaymentError(409, 'authorization_already_used');
      await this.chain.verify(payment, payment.accepted);
      return { isValid: true, payer: paymentPayer(payment) };
    } catch (error) {
      return { isValid: false, invalidReason: error instanceof PaymentError ? error.code : 'verification_failed',
        invalidMessage: error instanceof PaymentError ? error.message : 'The payment could not be verified.' };
    }
  }
  /** Cached resource execution: a crash after intent creation requires operator reconciliation, never an automatic rerun. */
  async runResource(input: unknown, requestHash: Hex,
    execute: (idempotencyKey: Hex) => Promise<{ amount: string; result: unknown }>): Promise<{ payment: SettleResponse; result: unknown }> {
    const payment = paymentPayloadSchema.parse(input), challengeId = payment.accepted.extra.telomere.challengeId;
    const attemptHash = digest({ payment, requestHash: requestHash.toLowerCase() });
    const cached = await this.db.transaction(async tx => {
      await tx.select().from(paymentLock).where(eq(paymentLock.id, 1)).for('update');
      const [existing] = await tx.select().from(paymentResourceResults).where(eq(paymentResourceResults.challengeId, challengeId)).limit(1);
      if (existing) {
        if (existing.attemptHash !== attemptHash) throw new PaymentError(409, 'payment_idempotency_conflict');
        if (existing.state === 'executing') throw new PaymentError(503, 'resource_reconciliation_required');
        return existing;
      }
      await this.bound(payment, requestHash, tx);
      const [used] = await tx.select({ key: paymentJournal.key }).from(paymentJournal).where(eq(paymentJournal.challengeId, challengeId)).limit(1);
      if (used) throw new PaymentError(409, 'authorization_already_used');
      await this.chain.verify(payment, payment.accepted);
      await tx.insert(paymentResourceResults).values({ challengeId, attemptHash, state: 'executing' });
      return undefined;
    });
    let amount: string, result: unknown;
    if (cached) { amount = cached.amount!; result = cached.result; }
    else {
      const executed = await execute(authorizationKey(payment));
      if (!/^(0|[1-9][0-9]{0,77})$/.test(executed.amount) || BigInt(executed.amount) > BigInt(payment.accepted.amount)
        || (payment.accepted.scheme === 'exact' && executed.amount !== payment.accepted.amount)
        || executed.result === undefined || executed.result === null || Buffer.byteLength(JSON.stringify(executed.result)) > 262_144) {
        throw new PaymentError(503, 'resource_result_invalid');
      }
      amount = executed.amount; result = executed.result;
      await this.db.update(paymentResourceResults).set({ state: 'ready', amount, result }).where(eq(paymentResourceResults.challengeId, challengeId));
    }
    return { payment: await this.settle(payment, { amount, requestHash }), result };
  }
  /** amount and requestHash must come from the authenticated resource server, never its caller. */
  async settle(input: unknown, context: { amount: string; requestHash: Hex }): Promise<SettleResponse> {
    const payment = paymentPayloadSchema.parse(input), maximum = BigInt(payment.accepted.amount);
    if (!/^(0|[1-9][0-9]{0,77})$/.test(context.amount) || BigInt(context.amount) > maximum
      || (payment.accepted.scheme === 'exact' && context.amount !== payment.accepted.amount)) throw new PaymentError(422, 'settlement_amount_invalid');
    if (context.requestHash.toLowerCase() !== payment.accepted.extra.telomere.requestHash) throw new PaymentError(409, 'payment_request_mismatch');
    const key = authorizationKey(payment), attemptHash = digest({ payment, amount: context.amount, requestHash: context.requestHash.toLowerCase() });
    const journal = await this.db.transaction(async tx => {
      const locks = await tx.select().from(paymentLock).where(eq(paymentLock.id, 1)).for('update');
      if (locks.length !== 1) throw new Error('x402 service was not initialized');
      const [existing] = await tx.select().from(paymentJournal).where(eq(paymentJournal.key, key)).limit(1);
      if (existing) {
        if (existing.attemptHash !== attemptHash) throw new PaymentError(409, 'payment_idempotency_conflict');
        return existing;
      }
      const [otherChallenge] = await tx.select({ key: paymentJournal.key }).from(paymentJournal)
        .where(eq(paymentJournal.challengeId, payment.accepted.extra.telomere.challengeId)).limit(1);
      if (otherChallenge) throw new PaymentError(409, 'authorization_already_used');
      await this.bound(payment, context.requestHash, tx);
      await this.chain.verify(payment, payment.accepted);
      const signer = this.chain.pins.facilitator.toLowerCase();
      const [busy] = await tx.select({ key: paymentJournal.key }).from(paymentJournal).where(and(
        eq(paymentJournal.signer, signer), eq(paymentJournal.network, payment.accepted.network), eq(paymentJournal.state, 'prepared'))).limit(1);
      if (busy) throw new PaymentError(503, 'facilitator_reconciliation_required');
      const response: SettleResponse = { success: context.amount === '0', transaction: '', network: payment.accepted.network,
        payer: paymentPayer(payment), amount: context.amount, ...(context.amount === '0' ? {} : { errorReason: 'settlement_pending' }) };
      const prepared = context.amount === '0' ? undefined : await this.chain.prepare(payment, context.amount);
      if (prepared) {
        if (!Number.isInteger(prepared.nonce) || prepared.nonce < 0 || prepared.nonce > 2 ** 31 - 1
          || keccak256(prepared.raw).toLowerCase() !== prepared.hash.toLowerCase()) throw new PaymentError(503, 'payment_journal_corrupt');
        // A reorg must not reuse an operator nonce already signed for another
        // authorization. Rejected prepared bytes never leave this transaction.
        const [reserved] = await tx.select({ key: paymentJournal.key }).from(paymentJournal).where(and(
          eq(paymentJournal.signer, signer), eq(paymentJournal.network, payment.accepted.network),
          gte(paymentJournal.nonce, prepared.nonce))).limit(1);
        if (reserved) throw new PaymentError(503, 'facilitator_nonce_reconciliation_required');
      }
      if (prepared) response.transaction = prepared.hash;
      const [created] = await tx.insert(paymentJournal).values({ key, challengeId: payment.accepted.extra.telomere.challengeId,
        attemptHash, signer, network: payment.accepted.network, state: prepared ? 'prepared' : 'settled',
        raw: prepared?.raw ?? null, hash: prepared?.hash ?? null, nonce: prepared?.nonce ?? null, response,
        createdAt: new Date(this.clock()) }).returning();
      if (!created) throw new Error('Payment journal insert failed');
      return created;
    });
    return this.reconcile(journal, payment, context.amount);
  }
  private checkedJournal(journal: Journal, payment: PaymentPayload, amount: string): PreparedPayment | undefined {
    const pins = this.chain.pins;
    if (journal.signer !== pins.facilitator.toLowerCase() || journal.network !== `eip155:${pins.chainId}`
      || payment.accepted.asset.toLowerCase() !== pins.asset.toLowerCase()
      || payment.accepted.payTo.toLowerCase() !== pins.payTo.toLowerCase()
      || payment.accepted.extra.facilitatorAddress.toLowerCase() !== pins.facilitator.toLowerCase()) {
      throw new PaymentError(503, 'payment_configuration_mismatch');
    }
    if (journal.response.amount !== amount || journal.response.network !== journal.network
      || journal.response.payer.toLowerCase() !== paymentPayer(payment).toLowerCase()
      || journal.response.success !== (journal.state === 'settled')) throw new PaymentError(503, 'payment_journal_corrupt');
    if (amount === '0' && journal.state === 'settled' && journal.raw === null && journal.hash === null && journal.nonce === null
      && journal.response.success && journal.response.transaction === '') return undefined;
    if (!journal.raw || !journal.hash || journal.nonce === null) throw new PaymentError(503, 'payment_journal_corrupt');
    const prepared: PreparedPayment = { raw: journal.raw as Hex, hash: journal.hash as Hex, nonce: journal.nonce };
    if (keccak256(prepared.raw).toLowerCase() !== prepared.hash.toLowerCase()
      || journal.response.transaction.toLowerCase() !== prepared.hash.toLowerCase()) throw new PaymentError(503, 'payment_journal_corrupt');
    return prepared;
  }
  private async reconcile(journal: Journal, payment: PaymentPayload, amount: string): Promise<SettleResponse> {
    const prepared = this.checkedJournal(journal, payment, amount);
    if (!prepared) return journal.response;
    // Serialize every observation/transition, including prepared completion,
    // under the nonce reservation lock. A prepared->terminal->prepared ABA must
    // not let an older observation overwrite a fresh reorg downgrade.
    return this.db.transaction(async tx => {
      const locks = await tx.select().from(paymentLock).where(eq(paymentLock.id, 1)).for('update');
      if (locks.length !== 1) throw new PaymentError(503, 'payment_journal_corrupt');
      const [current] = await tx.select().from(paymentJournal).where(eq(paymentJournal.key, journal.key)).limit(1);
      if (!current || current.attemptHash !== journal.attemptHash || current.raw !== journal.raw
        || current.hash !== journal.hash || current.nonce !== journal.nonce) throw new PaymentError(503, 'payment_journal_corrupt');
      const committed = this.checkedJournal(current, payment, amount);
      if (!committed) throw new PaymentError(503, 'payment_journal_corrupt');
      if (current.state !== 'prepared') {
        // Never re-verify an expired or consumed payer authorization merely to
        // inspect its previously accepted canonical transaction.
        let observed: 'pending' | 'settled' | 'reverted';
        try { observed = await this.chain.inspect(committed, payment, amount); }
        catch (error) {
          if (error instanceof PaymentError && error.code === 'income_authorization_reconciliation_required') throw error;
          throw new PaymentError(503, 'payment_finality_unavailable');
        }
        if (observed === 'pending') {
          const [busy] = await tx.select({ key: paymentJournal.key }).from(paymentJournal).where(and(
            eq(paymentJournal.signer, current.signer), eq(paymentJournal.network, current.network),
            eq(paymentJournal.state, 'prepared'), ne(paymentJournal.key, current.key))).limit(1);
          if (busy) throw new PaymentError(503, 'payment_finality_reconciliation_required');
          const response: SettleResponse = { ...current.response, success: false, errorReason: 'settlement_pending' };
          await tx.update(paymentJournal).set({ state: 'prepared', response }).where(eq(paymentJournal.key, current.key));
          // Reinspection only. A later explicit retry may send the same original
          // bytes; this transition never broadcasts or adopts another hash.
          return response;
        }
        const response: SettleResponse = { ...current.response, success: observed === 'settled' };
        if (observed === 'settled') delete response.errorReason; else response.errorReason = 'transaction_reverted';
        await tx.update(paymentJournal).set({ state: observed, response }).where(eq(paymentJournal.key, current.key));
        return response;
      }
      let result: 'pending' | 'settled' | 'reverted';
      try {
        result = await this.chain.inspect(committed, payment, amount);
        if (result === 'pending') {
          // Only the exact bytes committed before the first network send may be retried.
          if ((await this.chain.broadcast(committed.raw)).toLowerCase() !== committed.hash.toLowerCase()) throw new Error('Broadcast hash mismatch');
          result = await this.chain.inspect(committed, payment, amount);
        }
      } catch {
        // A competing retry may have mined these same bytes while this RPC returned "already known".
        try { result = await this.chain.inspect(committed, payment, amount); }
        catch (error) {
          if (error instanceof PaymentError && error.code === 'income_authorization_reconciliation_required') {
            return { ...current.response, success: false, errorReason: error.code };
          }
          return current.response;
        }
      }
      if (result === 'pending') return current.response;
      const response: SettleResponse = { ...current.response, success: result === 'settled',
        ...(result === 'reverted' ? { errorReason: 'transaction_reverted' } : {}) };
      if (result === 'settled') delete response.errorReason;
      await tx.update(paymentJournal).set({ state: result, response }).where(eq(paymentJournal.key, current.key));
      return response;
    });
  }
}
