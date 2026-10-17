import { and, asc, eq, gt, isNull, isNotNull } from 'drizzle-orm';
import { bytes32Schema, hashJson, Problem } from '../common.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import type { Database } from '../store.js';
import { agentBilling, agentBillingProvenance, agentBillingAnchors } from './schema.js';
import { agentBillingFactsHash } from './service.js';
import { PAID_AGENT_POLICY } from './types.js';

export const paidBillingUnavailable = () => new Problem(503, 'agent_billing_unconfirmed',
  'Canonical paid billing must be restored before evaluating or increasing agent activity. Owner kill remains available.');
export type CanonicalAgentCharge = { amount: string; at: Date; provenance: {
  transactionHash: string; blockNumber: string; blockHash: string } };

/** Shared durable canonical-prefix protocol; adapters retain distinct payer and agent authority. */
export function createCanonicalAgentBilling<T>(db: Database, bridge: PlatformBridge, dependencies: {
  ensureReady(): Promise<void>;
  pending(owner: string, agent: string): Promise<T[]>;
  confirm(row: T): Promise<CanonicalAgentCharge>;
  append(owner: string, agent: string, row: T, charge: CanonicalAgentCharge): Promise<unknown>;
}) {
  const refreshing = new Map<string, Promise<void>>();
  async function anchor(owner: string, agent: string) {
    const [saved] = await db.select().from(agentBillingAnchors)
      .where(and(eq(agentBillingAnchors.owner, owner), eq(agentBillingAnchors.agent, agent))).limit(1);
    if (saved) {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(saved.blockNumber)
        || (await bridge.public.getBlock({ blockNumber: BigInt(saved.blockNumber) })).hash !== bytes32Schema.parse(saved.blockHash)) throw paidBillingUnavailable();
    } else if ((await db.select({ id: agentBillingProvenance.receiptId }).from(agentBillingProvenance)
      .innerJoin(agentBilling, and(eq(agentBilling.owner, agentBillingProvenance.owner), eq(agentBilling.receiptId, agentBillingProvenance.receiptId)))
      .where(and(eq(agentBilling.owner, owner), eq(agentBilling.agent, agent), isNotNull(agentBillingProvenance.validatedAnchorHash))).limit(1)).length) throw paidBillingUnavailable();
    return saved;
  }
  async function validateImported(owner: string, agent: string): Promise<void> {
    // A separate durable prefix anchor must survive partial imports. Raw provenance never advances it.
    const head = await bridge.public.getBlock({ blockTag: 'latest' }), before = await anchor(owner, agent);
    const pending = await db.select({ entry: agentBilling, proof: agentBillingProvenance }).from(agentBilling)
      .innerJoin(agentBillingProvenance, and(eq(agentBilling.owner, agentBillingProvenance.owner), eq(agentBilling.receiptId, agentBillingProvenance.receiptId)))
      .where(and(eq(agentBilling.owner, owner), eq(agentBilling.agent, agent), isNull(agentBillingProvenance.validatedAnchorHash)))
      .orderBy(asc(agentBilling.receiptId)).limit(100);
    if (!pending.length) return;
    let next = before ? { blockNumber: before.blockNumber, blockHash: before.blockHash } : undefined;
    for (const { entry, proof } of pending) {
      if (agentBillingFactsHash(entry, { transactionHash: bytes32Schema.parse(proof.transactionHash), blockNumber: proof.blockNumber,
        blockHash: bytes32Schema.parse(proof.blockHash) }) !== proof.factsHash || entry.settledAt.getTime() > Date.now()
        || BigInt(proof.blockNumber) > head.number
        || (await bridge.public.getBlock({ blockNumber: BigInt(proof.blockNumber) })).hash !== proof.blockHash) throw paidBillingUnavailable();
      if (!next || BigInt(proof.blockNumber) > BigInt(next.blockNumber)) next = { blockNumber: proof.blockNumber, blockHash: proof.blockHash };
    }
    // Recheck both the old prefix and the pinned head before making this batch visible to evaluations.
    const after = await anchor(owner, agent);
    if (hashJson(before ?? null) !== hashJson(after ?? null)
      || (await bridge.public.getBlock({ blockNumber: head.number })).hash !== head.hash || !next) throw paidBillingUnavailable();
    await db.transaction(async tx => {
      const [current] = await tx.select().from(agentBillingAnchors)
        .where(and(eq(agentBillingAnchors.owner, owner), eq(agentBillingAnchors.agent, agent))).for('update');
      if (hashJson(current ?? null) !== hashJson(before ?? null)) throw paidBillingUnavailable();
      for (const { entry, proof } of pending) {
        const [stored] = await tx.select({ entry: agentBilling, proof: agentBillingProvenance }).from(agentBilling)
          .innerJoin(agentBillingProvenance, and(eq(agentBilling.owner, agentBillingProvenance.owner), eq(agentBilling.receiptId, agentBillingProvenance.receiptId)))
          .where(and(eq(agentBilling.owner, owner), eq(agentBilling.receiptId, entry.receiptId))).for('update');
        if (!stored || hashJson(stored) !== hashJson({ entry, proof }) || stored.entry.settledAt.getTime() !== entry.settledAt.getTime()
          || agentBillingFactsHash(stored.entry, { transactionHash: bytes32Schema.parse(stored.proof.transactionHash),
            blockNumber: stored.proof.blockNumber, blockHash: bytes32Schema.parse(stored.proof.blockHash) }) !== stored.proof.factsHash) throw paidBillingUnavailable();
        await tx.update(agentBillingProvenance).set({ validatedAnchorHash: next.blockHash })
          .where(and(eq(agentBillingProvenance.owner, owner), eq(agentBillingProvenance.receiptId, entry.receiptId)));
      }
      await tx.insert(agentBillingAnchors).values({ owner, agent, ...next })
        .onConflictDoUpdate({ target: [agentBillingAnchors.owner, agentBillingAnchors.agent], set: next });
    });
  }
  async function checkAnchoredHistory(owner: string, agent: string): Promise<void> {
    const missing = await db.select({ id: agentBilling.receiptId }).from(agentBilling)
      .leftJoin(agentBillingProvenance, and(eq(agentBillingProvenance.owner, agentBilling.owner), eq(agentBillingProvenance.receiptId, agentBilling.receiptId)))
      .where(and(eq(agentBilling.owner, owner), eq(agentBilling.agent, agent), isNull(agentBillingProvenance.receiptId))).limit(1);
    if (missing.length) throw paidBillingUnavailable();
    const unvalidated = await db.select({ id: agentBillingProvenance.receiptId }).from(agentBillingProvenance)
      .innerJoin(agentBilling, and(eq(agentBilling.owner, agentBillingProvenance.owner), eq(agentBilling.receiptId, agentBillingProvenance.receiptId)))
      .where(and(eq(agentBilling.owner, owner), eq(agentBilling.agent, agent), isNull(agentBillingProvenance.validatedAnchorHash))).limit(1);
    if (unvalidated.length) throw paidBillingUnavailable();
    await anchor(owner, agent);
    const previous = await db.select({ entry: agentBilling, proof: agentBillingProvenance }).from(agentBilling)
      .innerJoin(agentBillingProvenance, and(eq(agentBillingProvenance.owner, agentBilling.owner), eq(agentBillingProvenance.receiptId, agentBilling.receiptId)))
      .where(and(eq(agentBilling.owner, owner), eq(agentBilling.agent, agent),
        gt(agentBilling.settledAt, new Date(Date.now() - PAID_AGENT_POLICY.trailingBurnSeconds * 1000)))).limit(2049);
    if (previous.length > 2048) throw paidBillingUnavailable();
    for (const { entry, proof } of previous) {
      if (entry.settledAt.getTime() > Date.now() || agentBillingFactsHash(entry, {
        transactionHash: bytes32Schema.parse(proof.transactionHash), blockNumber: proof.blockNumber,
        blockHash: bytes32Schema.parse(proof.blockHash) }) !== proof.factsHash) throw paidBillingUnavailable();
    }
  }
  async function refresh(owner: string, agent: string): Promise<void> {
    try {
      await dependencies.ensureReady(); await bridge.check();
      await anchor(owner, agent);
      const pending = await dependencies.pending(owner, agent);
      for (const row of pending.slice(0, 100)) {
        const canonical = await dependencies.confirm(row);
        await dependencies.append(owner, agent, row, canonical);
      }
      await validateImported(owner, agent);
      await checkAnchoredHistory(owner, agent);
      if (pending.length > 100) throw paidBillingUnavailable();
    } catch { throw paidBillingUnavailable(); }
  }
  async function refreshBilling(owner: string, agent: string): Promise<void> {
    const key = owner + ':' + agent;
    let task = refreshing.get(key);
    if (!task) { task = refresh(owner, agent); refreshing.set(key, task); }
    try { await task; } finally { if (refreshing.get(key) === task) refreshing.delete(key); }
  }
  return { refreshBilling };
}
