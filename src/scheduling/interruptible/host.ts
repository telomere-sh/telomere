import { and, eq, sql } from 'drizzle-orm';
import { hashJson, Problem } from '../../common.js';
import type { Database } from '../../store.js';
import { Ed25519Identity, hostMessageHash, verifyHostMessage } from '../../host-kit/protocol.js';
import { hostPreemptionNotices } from './schema.js';
import { approvedInterruptibleRunSchema, interruptibleKeySchema, interruptibleOwnerSchema, PREEMPTION_MAX_NOTICE_MS,
  PREEMPTION_MIN_NOTICE_MS, signedPreemptionNoticeSchema, type ApprovedInterruptibleRun } from './types.js';

export interface HostPreemptionDependencies {
  /** Host-local, authoritative active lease plus durable owner opt-in; no caller-supplied capacity assertions. */
  activeOptedInRun(owner: string, runId: string): Promise<ApprovedInterruptibleRun>;
  /** Idempotent for noticeId; target exactly this owner/run, confirm actual removal or already-absent owned cell. */
  stopNoticedRun(owner: string, runId: string, noticeId: string): Promise<{ cleanupConfirmed: boolean }>;
  now?: () => number;
}
/** Host-side signer. This stores one immutable notice per run before making it available for delivery. */
export class HostPreemptionService {
  private enforcing: Promise<{ enforced: string[] }> | undefined;
  constructor(private readonly db: Database, private readonly identity: Ed25519Identity,
    private readonly dependencies: HostPreemptionDependencies) {}
  async issue(ownerValue: string, runId: string, value: { noticeMilliseconds: number; reason: 'maintenance' | 'capacity' }, keyValue: string) {
    const owner = interruptibleOwnerSchema.parse(ownerValue), key = interruptibleKeySchema.parse(keyValue);
    const milliseconds = value.noticeMilliseconds;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < PREEMPTION_MIN_NOTICE_MS || milliseconds > PREEMPTION_MAX_NOTICE_MS
      || !['maintenance', 'capacity'].includes(value.reason)) throw new Problem(422, 'preemption_notice_invalid', 'Give between 30 and 120 seconds of notice.');
    const id = hashJson({ domain: 'telomere.host-preemption.v1', owner, runId, key });
    const requestHash = hashJson({ runId, ...value });
    // An exact retry recovers the original issue time, including after the run was stopped or the process restarted.
    const [previous] = await this.db.select().from(hostPreemptionNotices).where(eq(hostPreemptionNotices.id, id)).limit(1);
    if (previous) {
      if (previous.owner !== owner || previous.hostKey !== this.identity.publicKey || previous.requestHash !== requestHash)
        throw new Problem(409, 'preemption_idempotency_conflict', 'Keep the original notice on retries.');
      return { notice: previous.notice, replayed: true };
    }
    const run = approvedInterruptibleRunSchema.parse(await this.dependencies.activeOptedInRun(owner, runId));
    const now = this.dependencies.now?.() ?? Date.now(), interruptAt = now + milliseconds;
    if (run.owner !== owner || run.runId !== runId || !run.active || run.capacity.lane !== 'interruptible'
      || run.hostKey !== this.identity.publicKey || !run.sourceLease || run.leaseUntil < interruptAt
      || run.sourceLease.body.expiresAt < interruptAt || run.sourceLease.body.runId !== runId
      || run.sourceLease.body.owner !== owner || run.sourceLease.body.hostKey !== this.identity.publicKey)
      throw new Problem(409, 'preemption_run_unavailable', 'A matching active opted-in host lease must cover the notice period.');
    const notice = signedPreemptionNoticeSchema.parse(this.identity.sign('control', { domain: 'telomere-interruptible/v1', version: 1,
      noticeId: id, owner, agent: run.agent, runId, hostKey: this.identity.publicKey,
      leaseHash: hostMessageHash(run.sourceLease), issuedAt: now, interruptAt, reason: value.reason }));
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${runId}), 26418)`);
      const [existing] = await tx.select().from(hostPreemptionNotices).where(and(eq(hostPreemptionNotices.hostKey, this.identity.publicKey),
        eq(hostPreemptionNotices.runId, runId))).limit(1);
      if (existing) {
        if (existing.id !== id || existing.requestHash !== requestHash) throw new Problem(409, 'preemption_notice_conflict', 'This run already has an immutable notice.');
        return { notice: existing.notice, replayed: true };
      }
      const rows = await tx.select({ id: hostPreemptionNotices.id }).from(hostPreemptionNotices).limit(4096);
      if (rows.length >= 4096) throw new Problem(503, 'preemption_journal_full', 'Archive host notice history before issuing further notices.');
      await tx.insert(hostPreemptionNotices).values({ id, owner, runId, hostKey: this.identity.publicKey, requestHash, notice, createdAt: new Date(now) });
      return { notice, replayed: false };
    });
  }
  /** Host watchdog/startup recovery. Run at least once per second; a missing owner client cannot extend its notice. */
  enforceDue(): Promise<{ enforced: string[] }> {
    if (this.enforcing) return this.enforcing;
    this.enforcing = this.enforce().finally(() => { this.enforcing = undefined; }); return this.enforcing;
  }
  private async enforce() {
    const now = this.dependencies.now?.() ?? Date.now();
    const rows = await this.db.select().from(hostPreemptionNotices).where(and(eq(hostPreemptionNotices.hostKey, this.identity.publicKey),
      eq(hostPreemptionNotices.cleanupConfirmed, 0), sql`(${hostPreemptionNotices.notice}->'body'->>'interruptAt')::numeric <= ${now}`)).limit(32);
    const enforced: string[] = [];
    for (const row of rows) {
      const notice = signedPreemptionNoticeSchema.parse(row.notice), body = notice.body;
      if (!verifyHostMessage(this.identity.publicKey, 'control', notice) || body.hostKey !== this.identity.publicKey
        || body.noticeId !== row.id || body.owner !== row.owner || body.runId !== row.runId
        || body.interruptAt - body.issuedAt < PREEMPTION_MIN_NOTICE_MS || body.interruptAt - body.issuedAt > PREEMPTION_MAX_NOTICE_MS)
        throw new Problem(409, 'preemption_journal_invalid', 'Host watchdog rejected a corrupted durable notice.');
      const cleanup = await this.dependencies.stopNoticedRun(row.owner, row.runId, row.id);
      if (cleanup.cleanupConfirmed !== true) throw new Problem(503, 'preemption_cleanup_unconfirmed', 'Preempted run removal is not confirmed.');
      await this.db.update(hostPreemptionNotices).set({ cleanupConfirmed: 1, enforcedAt: new Date(now) }).where(eq(hostPreemptionNotices.id, row.id));
      enforced.push(row.runId);
    }
    return { enforced };
  }
}
