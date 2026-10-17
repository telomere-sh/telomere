import { and, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { Problem, bytes32Schema, hashJson } from '../../common.js';
import { hostPaidPreemptions, hostPaidSessions, hostSessions, type HostJournal } from '../journal.js';
import { hostMessageHash, verifyHostMessage } from '../protocol.js';
import { admissionHash } from '../admission.js';
import type { PaidHostSessionAgent } from './paid-agent.js';
import { parsePaidSessionLease } from './paid-protocol.js';
import { PAID_PREEMPTION_MAX_NOTICE_MS, PAID_PREEMPTION_MIN_NOTICE_MS,
  paidPreemptionNoticeSchema, paidPreemptionOptInSchema, paidPreemptionRequestSchema,
  type SignedPaidPreemptionNotice, type SignedPaidPreemptionOptIn } from './paid-preemption-protocol.js';

type Paid = typeof hostPaidSessions.$inferSelect;
type Preemption = typeof hostPaidPreemptions.$inferSelect;
const invalid = () => new Problem(409, 'paid_preemption_invalid', 'The original paid lease or preemption authority changed.');

/** Host-local, default-off authority for one paid CPU session. A notice
 * cannot be created until the controller has durably attested authenticated
 * owner opt-in for the exact already-admitted signed lease. No settlement
 * claim is made here: only the original HostKit resource can be stopped.
 */
export class PaidHostPreemptionService {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ready = false;
  private accepting = false;
  constructor(readonly journal: HostJournal, private readonly paid: PaidHostSessionAgent,
    private readonly clock: () => number = Date.now) {
    if (paid.journal !== journal) throw new Error('Paid preemption requires the original host journal');
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private async paidRow(runId: string): Promise<Paid> {
    const id = bytes32Schema.safeParse(runId);
    if (!id.success) throw invalid();
    const [row] = await this.journal.db.select().from(hostPaidSessions).where(eq(hostPaidSessions.sessionId, id.data)).limit(1);
    if (!row) throw new Problem(404, 'paid_preemption_run_not_found', 'Original paid session was not found.');
    let parsed: ReturnType<typeof parsePaidSessionLease>;
    try { parsed = parsePaidSessionLease(row.lease); } catch { throw invalid(); }
    const { lease, payload } = parsed;
    if (row.leaseHash !== hostMessageHash(lease) || !verifyHostMessage(this.paid.controllerKey(), 'lease', lease)
      || lease.body.hostKey !== this.journal.identity.publicKey || lease.body.runId !== row.sessionId
      || lease.body.owner !== row.owner || lease.body.image !== payload.spec.image) throw invalid();
    return row;
  }
  private checked(row: Preemption, paid: Paid): { optIn: SignedPaidPreemptionOptIn; notice: SignedPaidPreemptionNotice | null } {
    let optIn: SignedPaidPreemptionOptIn;
    try { optIn = paidPreemptionOptInSchema.parse(row.optIn); } catch { throw invalid(); }
    const opt = optIn.body;
    if (!verifyHostMessage(this.paid.controllerKey(), 'paid-preemption-optin', optIn)
      || row.sessionId !== paid.sessionId || row.optInHash !== hostMessageHash(optIn) || row.optInNonce !== opt.nonce
      || opt.hostKey !== this.journal.identity.publicKey || opt.runId !== paid.sessionId
      || opt.owner !== paid.owner || opt.leaseHash !== paid.leaseHash || opt.image !== paid.lease.body.image
      || opt.expiresAt > paid.lease.body.expiresAt || opt.expiresAt <= opt.issuedAt) throw invalid();
    let notice: SignedPaidPreemptionNotice | null;
    try { notice = row.notice === null ? null : paidPreemptionNoticeSchema.parse(row.notice); } catch { throw invalid(); }
    if (notice) {
      const body = notice.body;
      if (!verifyHostMessage(this.journal.identity.publicKey, 'paid-preemption', notice)
        || body.hostKey !== opt.hostKey || body.owner !== opt.owner || body.runId !== opt.runId
        || body.leaseHash !== opt.leaseHash || body.image !== opt.image || body.optInHash !== row.optInHash
        || body.interruptAt - body.issuedAt < PAID_PREEMPTION_MIN_NOTICE_MS
        || body.interruptAt - body.issuedAt > PAID_PREEMPTION_MAX_NOTICE_MS
        || body.issuedAt < opt.issuedAt - 5_000 || body.interruptAt > opt.expiresAt
        || !row.requestHash || !row.requestNonce
        || body.noticeId !== hashJson({ domain: 'telomere-paid-preemption-notice-id/v1',
          requestHash: row.requestHash, optInHash: row.optInHash })) throw invalid();
    } else if (row.requestHash || row.requestNonce || row.cleanupConfirmed || row.enforcedAt) throw invalid();
    if (row.cleanupConfirmed !== Boolean(row.enforcedAt) || row.cleanupConfirmed && !notice) throw invalid();
    return { optIn, notice };
  }
  /** Verify the durable journal before any opt-in or notice is served. On
   * restart, PaidHostSessionAgent first proves orphaned resource cleanup.
   */
  async initialize(): Promise<void> {
    const records = await this.journal.db.select().from(hostPaidPreemptions).limit(257);
    if (records.length > 256) throw new Error('Paid preemption recovery inventory is full');
    for (const record of records) {
      const paid = await this.paidRow(record.sessionId);
      this.checked(record, paid);
      if (record.cleanupConfirmed) await this.assertCleaned(paid);
    }
    this.ready = true;
    this.accepting = true;
    try { await this.enforceDue(); }
    catch (error) {
      // An interrupted cleanup must still have a running watchdog after
      // restart. Corrupt authority remains a startup failure.
      if (!(error instanceof Problem && error.code === 'preemption_cleanup_uncertain')) throw error;
    }
    this.timer = setInterval(() => { void this.enforceDue().catch(() => undefined); }, 1000);
    this.timer.unref();
  }
  private async assertCleaned(paid: Paid): Promise<void> {
    const [session] = await this.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, paid.sessionId)).limit(1);
    let parsed: ReturnType<typeof parsePaidSessionLease>;
    try { parsed = parsePaidSessionLease(paid.lease); } catch { throw invalid(); }
    const { payload } = parsed;
    if (!paid.cleanupConfirmed || ['starting', 'running'].includes(paid.state)
      || !session?.record?.cleanupConfirmed || ['starting', 'running'].includes(session.record.state)
      || session.specHash !== admissionHash(payload.spec) || session.record.specHash !== session.specHash) throw invalid();
  }
  async optIn(raw: unknown): Promise<{ optIn: SignedPaidPreemptionOptIn; replayed: boolean }> {
    const signed = paidPreemptionOptInSchema.parse(raw), body = signed.body;
    return this.serial(async () => {
      if (!this.ready || !this.accepting || body.hostKey !== this.journal.identity.publicKey
        || !verifyHostMessage(this.paid.controllerKey(), 'paid-preemption-optin', signed)) throw invalid();
      const paid = await this.paidRow(body.runId);
      if (body.owner !== paid.owner || body.leaseHash !== paid.leaseHash || body.image !== paid.lease.body.image) throw invalid();
      const [prior] = await this.journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, body.runId)).limit(1);
      if (prior) {
        const original = this.checked(prior, paid).optIn.body;
        if (original.nonce !== body.nonce) throw new Problem(409, 'paid_preemption_optin_conflict', 'This paid run already has a different opt-in.');
        return { optIn: paidPreemptionOptInSchema.parse(prior.optIn), replayed: true };
      }
      const now = this.clock();
      if (Math.abs(body.issuedAt - now) > 5_000 || body.expiresAt <= now + PAID_PREEMPTION_MIN_NOTICE_MS
        || body.expiresAt > paid.lease.body.expiresAt || paid.state !== 'running' || paid.cleanupConfirmed
        || paid.lease.body.expiresAt <= now + PAID_PREEMPTION_MIN_NOTICE_MS) throw invalid();
      try {
        await this.journal.db.insert(hostPaidPreemptions).values({ sessionId: body.runId, optIn: signed,
          optInHash: hostMessageHash(signed), optInNonce: body.nonce, createdAt: new Date(now) });
      } catch { throw new Problem(409, 'paid_preemption_optin_conflict', 'This opt-in nonce or paid run was already used.'); }
      return { optIn: signed, replayed: false };
    });
  }
  private async issueChecked(paid: Paid, record: Preemption, requestHash: string, requestNonce: string,
    noticeMilliseconds: number, reason: 'maintenance' | 'capacity'): Promise<{ notice: SignedPaidPreemptionNotice; replayed: boolean }> {
    const { optIn, notice } = this.checked(record, paid);
    if (notice) {
      if (record.requestHash !== requestHash || record.requestNonce !== requestNonce) {
        throw new Problem(409, 'paid_preemption_notice_conflict', 'This paid run already has an immutable notice.');
      }
      return { notice, replayed: true };
    }
    const now = this.clock(), interruptAt = now + noticeMilliseconds;
    if (paid.state !== 'running' || paid.cleanupConfirmed || interruptAt > optIn.body.expiresAt
      || interruptAt > paid.lease.body.expiresAt) throw invalid();
    const generated = paidPreemptionNoticeSchema.parse(this.journal.identity.sign('paid-preemption', {
      domain: 'telomere-paid-preemption/v1', version: 1,
      noticeId: hashJson({ domain: 'telomere-paid-preemption-notice-id/v1',
        requestHash, optInHash: record.optInHash }),
      hostKey: this.journal.identity.publicKey, owner: paid.owner, runId: paid.sessionId,
      leaseHash: paid.leaseHash, image: paid.lease.body.image, optInHash: record.optInHash,
      issuedAt: now, interruptAt, reason,
    }));
    try {
      await this.journal.db.update(hostPaidPreemptions).set({ notice: generated, requestHash,
        requestNonce }).where(eq(hostPaidPreemptions.sessionId, paid.sessionId));
    } catch { throw new Problem(409, 'paid_preemption_notice_conflict', 'The notice nonce was already used.'); }
    return { notice: generated, replayed: false };
  }
  async issue(raw: unknown): Promise<{ notice: SignedPaidPreemptionNotice; replayed: boolean }> {
    const signed = paidPreemptionRequestSchema.parse(raw), body = signed.body;
    return this.serial(async () => {
      if (!this.ready || !this.accepting || body.hostKey !== this.journal.identity.publicKey
        || !verifyHostMessage(this.paid.controllerKey(), 'paid-preemption-request', signed)) throw invalid();
      const paid = await this.paidRow(body.runId);
      if (body.owner !== paid.owner || body.leaseHash !== paid.leaseHash || body.image !== paid.lease.body.image) throw invalid();
      const [record] = await this.journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, body.runId)).limit(1);
      if (!record) throw new Problem(409, 'paid_preemption_optin_required', 'The owner has not opted this paid lease into preemption.');
      const requestHash = hashJson({ domain: 'telomere-paid-preemption-request-semantics/v1',
        hostKey: body.hostKey, owner: body.owner, runId: body.runId, leaseHash: body.leaseHash,
        image: body.image, nonce: body.nonce, noticeMilliseconds: body.noticeMilliseconds, reason: body.reason });
      if (!record.notice && Math.abs(body.issuedAt - this.clock()) > 5_000) throw invalid();
      return this.issueChecked(paid, record, requestHash, body.nonce, body.noticeMilliseconds, body.reason);
    });
  }
  /** Direct host scheduler entry point. It has no remote route. The caller
   * must already run inside the reviewed host process, and opt-in remains
   * mandatory. A stable key recovers the same notice after response loss.
   */
  async issueFromHost(runId: string, value: { noticeMilliseconds: number; reason: 'maintenance' | 'capacity'; key: string }) {
    return this.serial(async () => {
      if (!this.ready || !this.accepting || !Number.isSafeInteger(value.noticeMilliseconds)
        || value.noticeMilliseconds < PAID_PREEMPTION_MIN_NOTICE_MS
        || value.noticeMilliseconds > PAID_PREEMPTION_MAX_NOTICE_MS
        || !['maintenance', 'capacity'].includes(value.reason)
        || !/^[A-Za-z0-9_-]{8,96}$/.test(value.key)) throw invalid();
      const paid = await this.paidRow(runId);
      const [record] = await this.journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, paid.sessionId)).limit(1);
      if (!record) throw new Problem(409, 'paid_preemption_optin_required', 'The owner has not opted this paid lease into preemption.');
      const requestNonce = hashJson({ domain: 'telomere-paid-preemption-local-key/v1', hostKey: this.journal.identity.publicKey,
        leaseHash: paid.leaseHash, runId: paid.sessionId, key: value.key });
      const requestHash = hashJson({ domain: 'telomere-paid-preemption-local-request/v1', requestNonce,
        noticeMilliseconds: value.noticeMilliseconds, reason: value.reason });
      return this.issueChecked(paid, record, requestHash, requestNonce, value.noticeMilliseconds, value.reason);
    });
  }
  async notice(runId: string): Promise<SignedPaidPreemptionNotice> {
    const paid = await this.paidRow(runId);
    const [record] = await this.journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, paid.sessionId)).limit(1);
    if (!record?.notice) throw new Problem(404, 'paid_preemption_notice_not_found', 'No paid preemption notice exists.');
    const { notice } = this.checked(record, paid);
    if (!notice) throw invalid();
    return notice;
  }
  /** Return the original durable owner opt-in, not a regenerated replay.
   * The signed lease and opt-in are revalidated before evidence is served.
   */
  async optInEvidence(runId: string): Promise<SignedPaidPreemptionOptIn> {
    const paid = await this.paidRow(runId);
    const [record] = await this.journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, paid.sessionId)).limit(1);
    if (!record) throw new Problem(404, 'paid_preemption_optin_not_found', 'No paid preemption opt-in exists.');
    return this.checked(record, paid).optIn;
  }
  enforceDue(): Promise<{ enforced: string[] }> {
    return this.serial(async () => {
      if (!this.ready) throw new Problem(503, 'paid_preemption_unavailable', 'Host preemption recovery is incomplete.');
      try {
        const now = this.clock(), rows = await this.journal.db.select().from(hostPaidPreemptions)
          .where(and(eq(hostPaidPreemptions.cleanupConfirmed, false), isNotNull(hostPaidPreemptions.notice))).limit(257);
        if (rows.length > 256) throw invalid();
        const enforced: string[] = [];
        for (const row of rows) {
          const paid = await this.paidRow(row.sessionId), { notice } = this.checked(row, paid);
          if (!notice || notice.body.interruptAt > now) continue;
          let result: Awaited<ReturnType<PaidHostSessionAgent['preemptExact']>>;
          try { result = await this.paid.preemptExact(row.sessionId, paid.leaseHash); }
          catch (error) {
            if (error instanceof Problem && error.code === 'session_control_rejected') throw invalid();
            // A runtime/transport/storage failure is not a cleanup proof. Keep
            // the durable notice pending and let the next watchdog tick retry.
            throw new Problem(503, 'preemption_cleanup_uncertain', 'Original paid session cleanup is unconfirmed.');
          }
          if (!result.cleanupConfirmed) throw new Problem(503, 'preemption_cleanup_uncertain', 'Original paid session cleanup is unconfirmed.');
          await this.assertCleaned(await this.paidRow(row.sessionId));
          try {
            await this.journal.db.update(hostPaidPreemptions).set({ cleanupConfirmed: true,
              enforcedAt: new Date(now) }).where(eq(hostPaidPreemptions.sessionId, row.sessionId));
          } catch { throw new Problem(503, 'preemption_cleanup_uncertain', 'Host cleanup journal write is unconfirmed.'); }
          enforced.push(row.sessionId);
        }
        this.accepting = true;
        return { enforced };
      } catch (error) {
        this.accepting = false;
        // Persisted authority corruption requires explicit recovery. A
        // transient journal read leaves the notice pending and the timer live.
        if (error instanceof Problem && ['paid_preemption_invalid', 'paid_preemption_run_not_found'].includes(error.code)) {
          this.ready = false;
          throw error;
        }
        throw new Problem(503, 'preemption_cleanup_uncertain', 'Original paid session cleanup is unconfirmed.');
      }
    });
  }
  async close(): Promise<void> { this.ready = false; this.accepting = false; if (this.timer) clearInterval(this.timer); await this.queue; }
}

/** The host listener is loopback-only in production. Mutating requests still
 * require the configured controller's dedicated Ed25519 signature.
 */
export function createPaidPreemptionRoutes(service: PaidHostPreemptionService): Hono {
  const routes = new Hono();
  routes.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'paid_preemption_request_invalid' },
    error instanceof Problem ? error.status : 422));
  routes.post('/opt-in', async context => {
    const result = await service.optIn(await context.req.json());
    return context.json(result, result.replayed ? 200 : 201);
  });
  routes.post('/:runId/notices', async context => {
    const raw = await context.req.json();
    const request = paidPreemptionRequestSchema.parse(raw);
    if (request.body.runId !== bytes32Schema.parse(context.req.param('runId'))) throw invalid();
    const result = await service.issue(request);
    return context.json(result, result.replayed ? 200 : 201);
  });
  routes.get('/:runId/notices', async context => context.json({ notice: await service.notice(context.req.param('runId')) }));
  routes.get('/:runId/opt-in', async context => context.json({ optIn: await service.optInEvidence(context.req.param('runId')) }));
  return routes;
}
