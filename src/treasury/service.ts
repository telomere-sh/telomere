import { randomBytes } from 'node:crypto';
import { keccak256, type Hex, type TransactionSerialized } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, Problem, sameAddress, signatureSchema } from '../common.js';
import type { BaseTopUpPort } from './base-credit.js';
import { FileTopUpLedger, type TopUpJournal } from './ledger.js';
import { encodeBase58, SolanaTopUpReader } from './solana-reader.js';
import { amountSchema, sourceCreditNonce, topUpRecordSchema, type TopUpProfile, type TopUpRecord } from './types.js';

const requestSchema = z.object({ clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/), amountMicros: amountSchema }).strict();
export class TreasuryTopUpService {
  constructor(readonly profile: TopUpProfile, readonly policyHash: Hex, private readonly ledger: FileTopUpLedger,
    private readonly solana: SolanaTopUpReader, private readonly base: BaseTopUpPort, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  async initialize(): Promise<void> {
    if (hashJson(this.profile) !== this.policyHash || this.ledger.policyHash !== this.policyHash) throw new Error('Original top-up policy hash differs');
    await this.solana.check(); const observation = await this.base.check();
    const ceiling = BigInt(observation.balanceMicros) < BigInt(this.profile.maxTotalCreditMicros) ? observation.balanceMicros : this.profile.maxTotalCreditMicros;
    await this.ledger.initialize(ceiling);
    if (BigInt((await this.ledger.read()).inventoryCeilingMicros) > BigInt(this.profile.maxTotalCreditMicros)) throw new Error('Retained inventory ceiling exceeds its original policy');
  }
  private active(): void {
    if (hashJson(this.profile) !== this.policyHash) throw new Error('Original top-up policy changed');
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < this.profile.notBefore || now >= this.profile.expiresAt) throw new Problem(409, 'topup_policy_inactive', 'The reviewed top-up policy is outside its finite window.');
  }
  private async owner(ownerValue: string) {
    const owner = addressSchema.parse(ownerValue), observation = await this.base.check();
    if (!sameAddress(owner, observation.owner)) throw new Problem(403, 'topup_owner_required', 'Use the registered human owner session.');
    return { ...observation, owner };
  }
  private record(journal: TopUpJournal, owner: string, id: string): TopUpRecord {
    const record = journal.records.find(value => value.id === bytes32Schema.parse(id) && sameAddress(owner, value.owner));
    if (!record) throw new Problem(404, 'topup_not_found', 'Top-up invoice not found.'); return record;
  }
  private view(record: TopUpRecord) {
    const amount = BigInt(record.amountMicros), decimal = `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, '0')}`;
    return { id: record.id, clientId: record.clientId, state: record.state, owner: record.owner, agentId: record.agentId,
      vault: record.vault, amountMicros: record.amountMicros, feeBps: 0 as const, policyHash: this.policyHash,
      createdAt: record.createdAt, expiresAt: record.expiresAt, reference: record.reference,
      solanaPayUrl: `solana:${this.profile.solana.recipient}?amount=${decimal}&spl-token=${this.profile.solana.mint}&reference=${record.reference}`,
      source: record.source, authorization: record.authorization, transactionHash: record.transactionHash,
      creditedBlockHash: record.creditedBlockHash, creditedBlockNumber: record.creditedBlockNumber,
      refundConfirmed: false as const, sourceProofKind: 'reviewed-rpc-finalized-observation' as const };
  }
  private async refresh(record: TopUpRecord): Promise<void> {
    if (!record.rawTransaction) return;
    const result = await this.base.inspect(record);
    if (result.state === 'credited') {
      if (!result.blockHash || result.blockNumber === undefined) throw new Error('Canonical top-up credit anchor is unavailable');
      record.state = 'credited'; record.creditedBlockHash = result.blockHash; record.creditedBlockNumber = result.blockNumber;
    } else { record.state = result.state === 'reverted' ? 'base_reverted' : 'base_pending'; record.creditedBlockHash = null; record.creditedBlockNumber = null; }
  }
  async create(ownerValue: string, value: unknown) {
    const input = requestSchema.parse(value), observed = await this.owner(ownerValue);
    return this.ledger.transact(async journal => {
      const previous = journal.records.find(record => sameAddress(record.owner, observed.owner) && record.clientId === input.clientId);
      if (previous) {
        if (previous.amountMicros !== input.amountMicros) throw new Problem(409, 'topup_idempotency_conflict', 'Reuse this key only for the original invoice amount.');
        await this.refresh(previous); return { invoice: this.view(previous), replayed: true };
      }
      this.active();
      await this.solana.check();
      for (const record of journal.records.filter(record => record.state === 'credited')) {
        await this.refresh(record);
      }
      const currentInventory = await this.base.check(observed.owner);
      const issued = journal.records.reduce((total, record) => total + BigInt(record.amountMicros), 0n);
      const held = journal.records.filter(record => record.state !== 'credited').reduce((total, record) => total + BigInt(record.amountMicros), 0n);
      if (held + BigInt(input.amountMicros) > BigInt(currentInventory.vaultCapacityMicros)) {
        throw new Problem(409, 'topup_vault_capacity', 'The registered Vault cannot cover the retained top-up reservations within its managed-exposure cap.');
      }
      if (BigInt(input.amountMicros) > BigInt(this.profile.maxInvoiceMicros) || issued + BigInt(input.amountMicros) > BigInt(journal.inventoryCeilingMicros)
        || held + BigInt(input.amountMicros) > BigInt(currentInventory.balanceMicros) || journal.records.length >= this.profile.maxInvoices
        || journal.records.filter(record => record.state === 'waiting_source').length >= this.profile.maxWaitingInvoices) {
        throw new Problem(409, 'topup_inventory_limit', 'The reviewed policy or uncommitted Base inventory cannot cover another invoice.');
      }
      const now = this.now(), expiresAt = Math.min(this.profile.expiresAt, now + this.profile.invoiceSeconds);
      if (expiresAt - now < 60) throw new Problem(409, 'topup_policy_expiring', 'The finite top-up policy has too little time remaining.');
      const id = hashJson({ domain: 'TelomereSolanaInvoiceV1', policyHash: this.policyHash, owner: observed.owner, clientId: input.clientId });
      const record = topUpRecordSchema.parse({ id, clientId: input.clientId, owner: observed.owner, agentId: this.profile.base.agentId,
        vault: this.profile.base.payTo, reference: encodeBase58(randomBytes(32)), amountMicros: input.amountMicros, createdAt: now, expiresAt,
        source: null, authorization: null, signature: null, rawTransaction: null, transactionHash: null, relayerNonce: null,
        state: 'waiting_source', creditedBlockHash: null, creditedBlockNumber: null });
      journal.records.push(record); return { invoice: this.view(record), replayed: false };
    });
  }
  async get(ownerValue: string, id: string) {
    const { owner } = await this.owner(ownerValue), record = this.record(await this.ledger.read(), owner, id);
    return record.rawTransaction ? this.reconcile(owner, id) : this.view(record);
  }
  async observe(ownerValue: string, id: string, signature: string) {
    const observed = await this.owner(ownerValue);
    return this.ledger.transact(async journal => {
      const record = this.record(journal, observed.owner, id);
      if (record.source) {
        if (record.source.signature !== signature) throw new Problem(409, 'topup_source_conflict', 'This invoice retains its original source transfer.');
        await this.refresh(record); return this.view(record);
      }
      this.active();
      const proof = await this.solana.verify(signature, record), nonce = sourceCreditNonce(proof);
      if (journal.records.some(other => other.source && sourceCreditNonce(other.source) === nonce)) throw new Problem(409, 'topup_source_used', 'This source transfer already belongs to a top-up invoice.');
      const validAfter = Math.max(0, observed.timestamp - 1), validBefore = Math.min(this.profile.expiresAt, observed.timestamp + this.profile.authorizationSeconds);
      if (validBefore <= validAfter + 10) throw new Problem(409, 'topup_policy_expiring', 'The original credit authorization has too little time remaining.');
      record.source = proof; record.authorization = { from: this.profile.base.treasury, to: record.vault, value: record.amountMicros, validAfter, validBefore, nonce };
      record.state = 'source_finalized'; return this.view(record);
    });
  }
  async authorize(ownerValue: string, id: string, value: unknown) {
    const signature = signatureSchema.parse(value), { owner } = await this.owner(ownerValue);
    return this.ledger.transact(async journal => {
      const record = this.record(journal, owner, id);
      if (record.signature && record.signature !== signature) throw new Problem(409, 'topup_authorization_conflict', 'The original treasury authorization is immutable.');
      if (record.rawTransaction) { await this.refresh(record); return { invoice: this.view(record), transaction: null }; }
      this.active(); if (!record.source) throw new Problem(409, 'topup_source_required', 'Verify the original finalized source transfer first.');
      const proof = await this.solana.verify(record.source.signature, record);
      if (hashJson(proof) !== hashJson(record.source)) throw new Error('Original Solana funding proof changed');
      const transaction = await this.base.validateAuthorization(record, signature);
      record.signature = signature; record.state = 'authorization_recorded';
      return { invoice: this.view(record), transaction: { ...transaction, chainId: this.profile.base.chainId,
        from: this.profile.base.facilitator, value: '0', maxGas: this.profile.maxRelayerGas, maxFeePerGas: this.profile.maxRelayerFeePerGas } };
    });
  }
  async submit(ownerValue: string, id: string, rawValue: unknown) {
    const raw = z.string().regex(/^0x[0-9a-fA-F]+$/).min(4).max(4096).refine(value => value.length % 2 === 0).parse(rawValue);
    const { owner } = await this.owner(ownerValue);
    const prepared = await this.ledger.transact(async journal => {
      const record = this.record(journal, owner, id);
      if (record.rawTransaction) {
        if (record.transactionHash !== keccak256(raw as Hex)) throw new Problem(409, 'topup_transaction_conflict', 'Reconcile the original signed credit transaction.');
        return { record, relay: false };
      }
      this.active(); if (!record.source || !record.signature) throw new Problem(409, 'topup_authorization_required', 'Provide the original treasury authorization first.');
      if (journal.records.some(other => other.id !== record.id && other.state === 'base_pending')) throw new Problem(409, 'topup_relayer_busy', 'Reconcile the original pending credit before claiming another relayer nonce.');
      const proof = await this.solana.verify(record.source.signature, record);
      if (hashJson(proof) !== hashJson(record.source)) throw new Error('Original Solana funding proof changed');
      // REASON: the bounded hex boundary is followed by full EVM transaction decoding.
      const transaction = await this.base.validateTransaction(record, raw as TransactionSerialized);
      record.rawTransaction = raw; record.transactionHash = transaction.hash; record.relayerNonce = transaction.nonce; record.state = 'base_pending';
      return { record, relay: this.profile.broadcastEnabled };
    });
    if (prepared.relay) {
      // The exact bytes, source and finite reserve have been durably retained.
      // Unknown delivery outcomes never create another transaction or release inventory.
      try { await this.base.broadcast(prepared.record); } catch { return { invoice: this.view(prepared.record), delivery: 'unknown' as const }; }
    }
    return { invoice: await this.reconcile(owner, id), delivery: prepared.relay ? 'submitted' as const : 'external_relay_required' as const };
  }
  async reconcile(ownerValue: string, id: string) {
    const { owner } = await this.owner(ownerValue);
    return this.ledger.transact(async journal => {
      const record = this.record(journal, owner, id);
      if (!record.rawTransaction) return this.view(record);
      await this.refresh(record);
      return this.view(record);
    });
  }
  /** Explicit recovery only: re-send the original bytes after confirming the
   * source and still-unused original authorization. Never amend fees or nonce. */
  async rebroadcast(ownerValue: string, id: string) {
    const { owner } = await this.owner(ownerValue);
    const reconciled = await this.reconcile(owner, id);
    if (reconciled.state !== 'base_pending') return { invoice: reconciled, delivery: 'not_required' as const };
    const record = await this.ledger.transact(async journal => {
      const original = this.record(journal, owner, id); this.active();
      if (!this.profile.broadcastEnabled || !original.rawTransaction || !original.signature || !original.source || original.state !== 'base_pending') {
        throw new Problem(409, 'topup_rebroadcast_unavailable', 'The original signed credit cannot be relayed in this state.');
      }
      const proof = await this.solana.verify(original.source.signature, original);
      if (hashJson(proof) !== hashJson(original.source)) throw new Error('Original Solana funding proof changed');
      await this.base.validateAuthorization(original, original.signature); return original;
    });
    try { await this.base.broadcast(record); }
    catch { return { invoice: this.view(record), delivery: 'unknown' as const }; }
    return { invoice: await this.reconcile(owner, id), delivery: 'submitted' as const };
  }
}
