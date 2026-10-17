import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { recoverMessageAddress } from 'viem';
import { z } from 'zod';
import { Problem } from '../../common.js';
import type { Database } from '../../store.js';
import { canonical, digest } from '../../payments/protocol.js';
import { assertIncomeEndpointUrl, probeIncomeEndpoint } from './http.js';
import { IncomeEndpointUnknownAgentError } from './reader.js';
import { incomeEndpointLock, incomeEndpointMigrationSQL, incomeEndpointOperations, incomeEndpoints } from './schema.js';
import { incomeAddressSchema, incomeChallengeSchema, incomeEndpointProfileSchema, incomeEndpointProofMessage,
  incomeHashSchema, incomeIdempotencySchema, incomePaymentRequiredSchema, incomeProofSchema, incomeRevisionSchema,
  type IncomeBinding, type IncomeChallenge, type IncomeEndpointProfile, type IncomeEndpointReader, type IncomeEndpointView,
  type IncomeSnapshot, type IncomeVerification } from './types.js';

type Row = typeof incomeEndpoints.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type OperationResult = typeof incomeEndpointOperations.$inferSelect.result;
export const incomeDeclareInputSchema = z.object({ url: z.string(), expectedRevision: incomeRevisionSchema }).strict();
export const incomeExpectedRevisionSchema = z.object({ expectedRevision: incomeRevisionSchema }).strict();
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
function authorityEqual(left: IncomeBinding, right: IncomeBinding): boolean {
  return ['agentId', 'owner', 'agentWallet', 'vault'].every(key => {
    // REASON: These four explicitly selected binding fields are all addresses or bytes32 strings.
    const field = key as 'agentId' | 'owner' | 'agentWallet' | 'vault'; return same(left[field], right[field]);
  });
}
function nextRevision(value: string): string {
  const next = BigInt(incomeRevisionSchema.parse(value)) + 1n;
  if (next >= 2n ** 64n) throw new Problem(409, 'income_endpoint_revision_exhausted', 'The declaration revision is exhausted.'); return next.toString();
}

/** Endpoint evidence only. No token transaction, custody, income counter or reputation mutation exists here. */
export class IncomeEndpointService {
  readonly profile: IncomeEndpointProfile;
  private readonly profileHash: string;
  constructor(private readonly db: Database, readonly reader: IncomeEndpointReader, profile: IncomeEndpointProfile,
    private readonly options: { clock?: () => number; probeTimeoutMs?: number } = {}) {
    this.profile = incomeEndpointProfileSchema.parse(profile);
    Object.freeze(this.profile.pins); Object.freeze(this.profile.allowedOrigins); Object.freeze(this.profile);
    this.profileHash = digest(this.profile);
    if (canonical(reader.pins) !== canonical(this.profile.pins) || !same(reader.asset, this.profile.asset)) throw new Error('Income endpoint reader differs from reviewed profile');
  }
  private now(): number {
    const now = this.options.clock?.() ?? Date.now(); if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Income endpoint clock unavailable'); return now;
  }
  async initialize(): Promise<void> {
    await this.reader.check();
    await this.db.transaction(async tx => { for (const statement of incomeEndpointMigrationSQL.split(';').map(value => value.trim()).filter(Boolean)) await tx.execute(sql.raw(statement)); });
  }
  publicConfig() {
    return { protocol: 'telomere-income-endpoint-v1' as const, pins: this.profile.pins, network: this.profile.network,
      asset: this.profile.asset, challengeTtlSeconds: this.profile.challengeTtlSeconds, verificationTtlSeconds: this.profile.verificationTtlSeconds,
      maxDeclarationsPerAgent: 16, incomeCredit: 'none' as const, paymentCapabilityVerified: false as const };
  }
  private async snapshot(principal: string, rawId: string, ownerOnly = false): Promise<IncomeSnapshot> {
    const account = incomeAddressSchema.parse(principal), agentId = incomeHashSchema.parse(rawId);
    let snapshot: IncomeSnapshot;
    try { snapshot = await this.reader.snapshot(agentId); }
    catch (error) {
      if (error instanceof IncomeEndpointUnknownAgentError) throw new Problem(404, 'income_agent_not_found', 'The Selection agent is not registered.');
      throw new Problem(503, 'income_authority_unavailable', 'The reviewed Selection authority is unavailable.');
    }
    if (!same(account, snapshot.binding.owner) && (ownerOnly || !same(account, snapshot.binding.agentWallet))) {
      throw new Problem(403, 'income_endpoint_forbidden', 'This Selection principal cannot access the declaration.');
    }
    return snapshot;
  }
  private live(snapshot: IncomeSnapshot): void {
    if (snapshot.binding.status === 3) throw new Problem(409, 'income_agent_dead', 'A dead agent cannot publish new endpoint evidence.');
  }
  private async row(agentId: string, rawId: string, source: Pick<Database, 'select'> = this.db): Promise<Row> {
    const id = incomeHashSchema.parse(rawId), [row] = await source.select().from(incomeEndpoints)
      .where(and(eq(incomeEndpoints.id, id), eq(incomeEndpoints.agentId, agentId.toLowerCase()))).limit(1);
    if (!row) throw new Problem(404, 'income_endpoint_not_found', 'The income endpoint declaration was not found.'); return row;
  }
  private current(row: Row, expectedRevision: string, active = true): void {
    if (row.revision !== incomeRevisionSchema.parse(expectedRevision)) throw new Problem(409, 'income_endpoint_revision_mismatch', 'Refresh the current declaration revision.');
    if (active && !row.active) throw new Problem(409, 'income_endpoint_revoked', 'The income endpoint declaration was revoked.');
  }
  private async view(row: Row, snapshot: IncomeSnapshot): Promise<IncomeEndpointView> {
    const now = this.now(), verifiedAt = row.verification ? Date.parse(row.verification.verifiedAt) : NaN;
    let verified = row.active && snapshot.binding.status !== 3 && authorityEqual(row.binding, snapshot.binding)
      && row.verification !== null && row.verification.profileHash === this.profileHash
      && row.verification.proof.challenge.revision === row.revision && Number.isSafeInteger(verifiedAt)
      && verifiedAt <= now && now - verifiedAt < this.profile.verificationTtlSeconds * 1000
      && BigInt(row.verification.expiresAt) * 1000n > BigInt(now);
    if (verified && row.verification) { try { await this.reader.canonical(row.verification.block); } catch { verified = false; } }
    await this.reader.canonical(snapshot.block);
    const verification = verified && row.verification ? row.verification : null;
    return { id: row.id, agentId: row.agentId, url: row.url, revision: row.revision, declared: row.active,
      declaredAt: row.declaredAt.toISOString(), binding: snapshot.binding, controlVerified: Boolean(verification),
      termsMatchReviewedProfile: Boolean(verification?.termsMatchReviewedProfile), verification: verification ? {
        verifiedAt: verification.verifiedAt, expiresAt: verification.expiresAt, block: verification.block, termsDigest: verification.termsDigest,
      } : null, incomeCredit: 'none', paymentCapabilityVerified: false };
  }
  async get(principal: string, agentId: string, endpointId: string): Promise<IncomeEndpointView> {
    const snapshot = await this.snapshot(principal, agentId); return this.view(await this.row(snapshot.binding.agentId, endpointId), snapshot);
  }
  async list(principal: string, agentId: string): Promise<{ endpoints: IncomeEndpointView[] }> {
    const snapshot = await this.snapshot(principal, agentId), rows = await this.db.select().from(incomeEndpoints)
      .where(eq(incomeEndpoints.agentId, snapshot.binding.agentId)).orderBy(asc(incomeEndpoints.id)).limit(17);
    if (rows.length > 16) throw new Problem(503, 'income_endpoint_capacity', 'The declaration collection exceeds its supported bound.');
    const endpoints: IncomeEndpointView[] = []; for (const row of rows) endpoints.push(await this.view(row, snapshot)); return { endpoints };
  }
  private operationIdentity(principal: string, key: string, operation: string, input: unknown) {
    return { key: digest({ principal: incomeAddressSchema.parse(principal).toLowerCase(), key: incomeIdempotencySchema.parse(key) }),
      inputHash: digest({ operation, input, profileHash: this.profileHash }) };
  }
  private async cached(identity: { key: string; inputHash: string }, source: Pick<Database, 'select'> = this.db): Promise<OperationResult | undefined> {
    const [existing] = await source.select().from(incomeEndpointOperations).where(eq(incomeEndpointOperations.key, identity.key)).limit(1);
    if (!existing) return undefined;
    if (existing.inputHash !== identity.inputHash) throw new Problem(409, 'income_endpoint_idempotency_conflict', 'Reuse an operation key only with its original input.'); return existing.result;
  }
  private async operation(identity: { key: string; inputHash: string }, apply: (tx: Transaction) => Promise<OperationResult>): Promise<OperationResult> {
    return this.db.transaction(async tx => {
      const locks = await tx.select().from(incomeEndpointLock).where(eq(incomeEndpointLock.id, 1)).for('update');
      if (locks.length !== 1) throw new Error('Income endpoints are not initialized');
      const existing = await this.cached(identity, tx); if (existing) return existing;
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(incomeEndpointOperations);
      if (!count || count.count >= 20_000) throw new Problem(503, 'income_endpoint_journal_capacity', 'The endpoint operation journal is full.');
      const result = await apply(tx);
      await tx.insert(incomeEndpointOperations).values({ ...identity, result, createdAt: new Date(this.now()) }); return result;
    });
  }
  async declare(principal: string, agentId: string, rawInput: unknown, key: string): Promise<IncomeEndpointView> {
    const input = incomeDeclareInputSchema.parse(rawInput), snapshot = await this.snapshot(principal, agentId, true); this.live(snapshot);
    assertIncomeEndpointUrl(input.url, this.profile);
    const id = digest({ agentId: snapshot.binding.agentId, url: input.url }), identity = this.operationIdentity(principal, key, 'declare', { agentId: snapshot.binding.agentId, ...input });
    await this.reader.canonical(snapshot.block);
    await this.operation(identity, async tx => {
      const [existing] = await tx.select().from(incomeEndpoints).where(eq(incomeEndpoints.id, id)).limit(1);
      if (existing) {
        this.current(existing, input.expectedRevision, false);
        await tx.update(incomeEndpoints).set({ binding: snapshot.binding, revision: nextRevision(existing.revision), active: true,
          declaredAt: new Date(this.now()), challenge: null, challengeUsed: false, verification: null }).where(eq(incomeEndpoints.id, id));
      } else {
        if (input.expectedRevision !== '0') throw new Problem(409, 'income_endpoint_revision_mismatch', 'A new declaration starts at revision zero.');
        const [agentCount] = await tx.select({ count: sql<number>`count(*)::integer` }).from(incomeEndpoints).where(eq(incomeEndpoints.agentId, snapshot.binding.agentId));
        const [globalCount] = await tx.select({ count: sql<number>`count(*)::integer` }).from(incomeEndpoints);
        if (!agentCount || !globalCount || agentCount.count >= 16 || globalCount.count >= 10_000) throw new Problem(503, 'income_endpoint_capacity', 'The declaration collection is full.');
        await tx.insert(incomeEndpoints).values({ id, agentId: snapshot.binding.agentId, url: input.url, binding: snapshot.binding,
          revision: '1', active: true, declaredAt: new Date(this.now()) });
      }
      return { id };
    });
    return this.get(principal, agentId, id);
  }
  async revoke(principal: string, agentId: string, endpointId: string, rawInput: unknown, key: string): Promise<IncomeEndpointView> {
    const input = incomeExpectedRevisionSchema.parse(rawInput), snapshot = await this.snapshot(principal, agentId, true);
    const identity = this.operationIdentity(principal, key, 'revoke', { agentId: snapshot.binding.agentId, endpointId, ...input });
    await this.operation(identity, async tx => {
      const row = await this.row(snapshot.binding.agentId, endpointId, tx); this.current(row, input.expectedRevision);
      await tx.update(incomeEndpoints).set({ active: false, revision: nextRevision(row.revision), challenge: null,
        challengeUsed: false, verification: null }).where(eq(incomeEndpoints.id, row.id)); return { id: row.id };
    }); return this.get(principal, agentId, endpointId);
  }
  async challenge(principal: string, agentId: string, endpointId: string, rawInput: unknown, key: string): Promise<{ challenge: IncomeChallenge; message: string }> {
    const input = incomeExpectedRevisionSchema.parse(rawInput), snapshot = await this.snapshot(principal, agentId, true); this.live(snapshot);
    const identity = this.operationIdentity(principal, key, 'challenge', { agentId: snapshot.binding.agentId, endpointId, ...input });
    const result = await this.operation(identity, async tx => {
      const row = await this.row(snapshot.binding.agentId, endpointId, tx); this.current(row, input.expectedRevision);
      if (!authorityEqual(row.binding, snapshot.binding)) throw new Problem(409, 'income_endpoint_binding_changed', 'Redeclare the endpoint against its current Selection binding.');
      const challenge = incomeChallengeSchema.parse({ protocol: 'telomere-income-endpoint-v1', chainId: this.profile.pins.chainId,
        selectionRegistryAddress: this.profile.pins.selectionRegistryAddress, agentId: snapshot.binding.agentId,
        owner: snapshot.binding.owner, agentWallet: snapshot.binding.agentWallet, vault: snapshot.binding.vault,
        url: row.url, revision: row.revision, nonce: '0x' + randomBytes(32).toString('hex'),
        expiresAt: String(Math.floor(this.now() / 1000) + this.profile.challengeTtlSeconds) });
      await tx.update(incomeEndpoints).set({ challenge, challengeUsed: false }).where(eq(incomeEndpoints.id, row.id)); return { id: row.id, challenge };
    });
    if (!result.challenge) throw new Error('Income endpoint challenge journal is corrupt'); return { challenge: result.challenge, message: incomeEndpointProofMessage(result.challenge) };
  }
  async verify(principal: string, agentId: string, endpointId: string, rawInput: unknown, key: string): Promise<IncomeEndpointView> {
    const input = incomeExpectedRevisionSchema.parse(rawInput), snapshot = await this.snapshot(principal, agentId, true); this.live(snapshot);
    const identity = this.operationIdentity(principal, key, 'verify', { agentId: snapshot.binding.agentId, endpointId, ...input });
    if (await this.cached(identity)) return this.get(principal, agentId, endpointId);
    const row = await this.row(snapshot.binding.agentId, endpointId); this.current(row, input.expectedRevision);
    const challenge = row.challenge;
    if (!challenge || row.challengeUsed || BigInt(challenge.expiresAt) * 1000n <= BigInt(this.now())) throw new Problem(409, 'income_endpoint_challenge_unavailable', 'Issue a fresh unexpired endpoint challenge.');
    if (!authorityEqual(row.binding, snapshot.binding)) throw new Problem(409, 'income_endpoint_binding_changed', 'Redeclare the endpoint against its current Selection binding.');
    const observed = await probeIncomeEndpoint(row.url, challenge.nonce, { ...this.profile,
      ...(this.options.probeTimeoutMs === undefined ? {} : { timeoutMs: this.options.probeTimeoutMs }) });
    const body = z.object({ proof: incomeProofSchema }).passthrough().parse(observed.body), proof = body.proof;
    if (canonical(proof.challenge) !== canonical(challenge)) throw new Problem(422, 'income_endpoint_proof_invalid', 'The endpoint proof does not match its issued challenge.');
    let signer: string;
    try { signer = await recoverMessageAddress({ message: incomeEndpointProofMessage(challenge), signature: proof.signature }); }
    catch { throw new Problem(422, 'income_endpoint_proof_invalid', 'The endpoint proof signature is invalid.'); }
    if (!same(signer, snapshot.binding.agentWallet)) throw new Problem(422, 'income_endpoint_proof_invalid', 'The endpoint proof must be signed by the registered agent key.');
    const terms = incomePaymentRequiredSchema.safeParse(observed.paymentRequired);
    const termsMatchReviewedProfile = terms.success && terms.data.resource.url === row.url && terms.data.accepts.some(term =>
      term.network === this.profile.network && same(term.asset, this.profile.asset) && same(term.payTo, snapshot.binding.vault));
    const fresh = await this.snapshot(principal, agentId, true); this.live(fresh);
    await this.reader.canonical(snapshot.block);
    if (!authorityEqual(snapshot.binding, fresh.binding) || BigInt(challenge.expiresAt) * 1000n <= BigInt(this.now())) throw new Problem(409, 'income_endpoint_binding_changed', 'The authority or challenge changed during verification.');
    const verification: IncomeVerification = { proof, block: fresh.block, profileHash: this.profileHash,
      termsDigest: digest(observed.paymentRequired ?? null), verifiedAt: new Date(this.now()).toISOString(),
      expiresAt: String(Math.min(Math.floor(this.now() / 1000) + this.profile.verificationTtlSeconds, Number(challenge.expiresAt))), termsMatchReviewedProfile };
    await this.operation(identity, async tx => {
      const current = await this.row(snapshot.binding.agentId, endpointId, tx); this.current(current, input.expectedRevision);
      if (current.challengeUsed || canonical(current.challenge) !== canonical(challenge)) throw new Problem(409, 'income_endpoint_challenge_unavailable', 'The challenge was replaced or consumed.');
      await tx.update(incomeEndpoints).set({ challengeUsed: true, verification }).where(eq(incomeEndpoints.id, current.id)); return { id: current.id };
    }); return this.get(principal, agentId, endpointId);
  }
}
