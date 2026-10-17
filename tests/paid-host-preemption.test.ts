import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, randomId } from '../src/common.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createHostedHostKit } from '../src/host-kit/hosted.js';
import { hostPaidPreemptions, hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, verifyHostMessage, type HostLease } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PAID_SESSION_ARGV, paidSessionPolicy } from '../src/host-kit/sessions/paid-protocol.js';
import { PaidHostPreemptionService } from '../src/host-kit/sessions/paid-preemption.js';
import { paidPreemptionNoticeSchema } from '../src/host-kit/sessions/paid-preemption-protocol.js';

const image = 'fixture/session@sha256:' + 'a'.repeat(64);
const owner = '0x' + '1'.repeat(40);

describe('post-admission paid HostKit preemption', () => {
  let journal: HostJournal, directory: string, server: Server;
  let hosted: ReturnType<typeof createHostedHostKit>, paid: PaidHostSessionAgent;
  let preemption: PaidHostPreemptionService, controller: Ed25519Identity, client: HostKitClient;
  let now = Date.now(), base = '';
  afterEach(async () => {
    await preemption?.close().catch(() => undefined);
    await paid?.close().catch(() => undefined);
    await hosted?.close().catch(() => undefined);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await journal?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function setup(persistent = false) {
    now = Date.now();
    directory = await mkdtemp(join(tmpdir(), 'telomere-paid-preempt-'));
    const cells = join(directory, 'cells'); await mkdir(cells, { mode: 0o700 });
    journal = await openHostJournal(persistent ? join(directory, 'host-state') : ':memory:'); controller = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
    hosted = createHostedHostKit({ journal, runtime, backend, controlKey: controller.publicKey,
      reviewedImages: new Set([image]), scope: { version: 1, hostKey: journal.identity.publicKey,
        controlKey: controller.publicKey, isolation: 'local_process_fixture',
        runtime: canonical(['fixture-session-runtime', directory]), sessionBackend: backend.identity },
      inventory: async () => [] });
    await hosted.initialize();
    paid = new PaidHostSessionAgent(journal, hosted.sessions, controller.publicKey, () => now);
    await paid.initialize();
    preemption = new PaidHostPreemptionService(journal, paid, () => now);
    await preemption.initialize();
    server = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid, preemption).fetch));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test host port');
    base = `http://127.0.0.1:${address.port}`;
    client = new HostKitClient(base, journal.identity.publicKey, controller, true);
  }
  function lease() {
    const runId = randomId(), maxSeconds = 120;
    const spec = { version: 1 as const, sessionId: runId, image, lifetimeSeconds: maxSeconds,
      policy: paidSessionPolicy(4) };
    const body: HostLease = { version: 1, hostKey: journal.identity.publicKey, runId, owner, image,
      argv: [...PAID_SESSION_ARGV], stdin: JSON.stringify({ spec, quoteHash: randomId(), admissionTx: randomId() }),
      issuedAt: now, expiresAt: now + maxSeconds * 1000, maxSeconds, nonce: randomId() };
    return controller.sign('lease', body);
  }
  function optIn(original: ReturnType<typeof lease>, nonce = randomId()) {
    return controller.sign('paid-preemption-optin', {
      domain: 'telomere-paid-preemption-optin/v1', version: 1, hostKey: journal.identity.publicKey,
      owner, runId: original.body.runId, leaseHash: hostMessageHash(original), image,
      nonce, issuedAt: now, expiresAt: original.body.expiresAt,
    });
  }
  function request(original: ReturnType<typeof lease>, nonce = randomId(), reason: 'capacity' | 'maintenance' = 'capacity') {
    return controller.sign('paid-preemption-request', {
      domain: 'telomere-paid-preemption-request/v1', version: 1, hostKey: journal.identity.publicKey,
      owner, runId: original.body.runId, leaseHash: hostMessageHash(original), image,
      nonce, issuedAt: now, noticeMilliseconds: 30_000, reason,
    });
  }
  async function post(path: string, body: unknown) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  it('preserves only the exact missing-notice observation for a valid original lease', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    await expect(client.preemptionNotice(original)).rejects.toMatchObject({ status: 404, code: 'paid_preemption_notice_not_found' });
    for (const [status, body] of [[404, { title: 'paid_preemption_run_not_found' }],
      [404, { title: 'paid_preemption_notice_not_found', extra: true }],
      [503, { title: 'paid_preemption_notice_not_found' }]] as const) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
      const unavailable = new HostKitClient(base, journal.identity.publicKey, controller, true, fetcher);
      await expect(unavailable.preemptionNotice(original)).rejects.not.toMatchObject({ code: 'paid_preemption_notice_not_found' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('requires a controller-signed post-admission opt-in for the exact original lease', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    const route = `/v1/sessions/preemption/${original.body.runId}/notices`;
    expect((await post(route, request(original))).body.title).toBe('paid_preemption_optin_required');
    const forged = new Ed25519Identity().sign('paid-preemption-optin', optIn(original).body);
    expect((await post('/v1/sessions/preemption/opt-in', forged)).status).toBe(409);
    const changed = controller.sign('paid-preemption-optin', { ...optIn(original).body, leaseHash: randomId() });
    expect((await post('/v1/sessions/preemption/opt-in', changed)).status).toBe(409);
    const accepted = optIn(original), first = await post('/v1/sessions/preemption/opt-in', accepted);
    expect(first).toMatchObject({ status: 201, body: { optIn: accepted, replayed: false } });
    now += 6_000;
    const regenerated = controller.sign('paid-preemption-optin', { ...accepted.body, issuedAt: now });
    const replay = await post('/v1/sessions/preemption/opt-in', regenerated);
    expect(replay).toMatchObject({ status: 200, body: { optIn: accepted, replayed: true } });
    expect((await post('/v1/sessions/preemption/opt-in', optIn(original))).body.title).toBe('paid_preemption_optin_conflict');
  });

  it('serves only the original verified opt-in from the durable host journal', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    const route = `/v1/sessions/preemption/${original.body.runId}/opt-in`;
    const missing = await fetch(base + route);
    expect(missing.status).toBe(404);
    expect((await missing.json()).title).toBe('paid_preemption_optin_not_found');
    const accepted = optIn(original);
    expect((await post('/v1/sessions/preemption/opt-in', accepted)).status).toBe(201);
    now += 6_000;
    const replay = controller.sign('paid-preemption-optin', { ...accepted.body, issuedAt: now });
    expect((await post('/v1/sessions/preemption/opt-in', replay)).status).toBe(200);
    const evidence = await fetch(base + route);
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toEqual({ optIn: accepted });
    await journal.db.update(hostPaidPreemptions).set({ optInHash: randomId() })
      .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    const corrupted = await fetch(base + route);
    expect(corrupted.status).toBe(409);
    expect((await corrupted.json()).title).toBe('paid_preemption_invalid');
  });

  it('signs one immutable bounded notice, then proves exact-run cleanup at the watchdog deadline', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    const accepted = optIn(original); await post('/v1/sessions/preemption/opt-in', accepted);
    const route = `/v1/sessions/preemption/${original.body.runId}/notices`;
    const firstRequest = request(original), first = await post(route, firstRequest);
    expect(first.status).toBe(201);
    const notice = paidPreemptionNoticeSchema.parse(first.body.notice);
    expect(verifyHostMessage(journal.identity.publicKey, 'paid-preemption', notice)).toBe(true);
    expect(notice.body).toMatchObject({ runId: original.body.runId, hostKey: journal.identity.publicKey,
      owner, leaseHash: hostMessageHash(original), image, optInHash: hostMessageHash(accepted),
      interruptAt: now + 30_000 });
    expect((await (await fetch(base + route)).json()).notice).toEqual(notice);
    now += 6_000;
    const refreshed = controller.sign('paid-preemption-request', { ...firstRequest.body, issuedAt: now });
    expect(await post(route, refreshed)).toMatchObject({ status: 200, body: { notice, replayed: true } });
    const conflict = controller.sign('paid-preemption-request', { ...firstRequest.body, issuedAt: now, reason: 'maintenance' });
    expect((await post(route, conflict)).body.title).toBe('paid_preemption_notice_conflict');
    now = notice.body.interruptAt;
    expect(await preemption.enforceDue()).toEqual({ enforced: [original.body.runId] });
    now = Date.now();
    const status = await client.sessionControl(original, { action: 'status' });
    expect(status).toMatchObject({ state: 'stopped', cleanupConfirmed: true, runId: original.body.runId });
    expect(status.ticks.at(-1)?.body.state).toBe('STOPPED');
    const [record] = await journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, original.body.runId));
    expect(record?.record?.cleanupConfirmed).toBe(true);
    const [saved] = await journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    expect(saved?.cleanupConfirmed).toBe(true);
    expect(await preemption.enforceDue()).toEqual({ enforced: [] });
  });

  it('rejects notices beyond the original lease and leaves a failed cleanup unconfirmed for retry', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    await preemption.optIn(optIn(original));
    now = original.body.expiresAt - 29_000;
    await expect(preemption.issue(request(original))).rejects.toThrow();
    now = original.body.issuedAt + 1_000;
    const issued = await preemption.issue(request(original));
    now = issued.notice.body.interruptAt;
    const stop = vi.spyOn(paid, 'preemptExact').mockRejectedValueOnce(new Error('cleanup not confirmed'));
    await expect(preemption.enforceDue()).rejects.toMatchObject({ code: 'preemption_cleanup_uncertain' });
    const [pending] = await journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    expect(pending?.cleanupConfirmed).toBe(false);
    stop.mockRestore();
    expect(await preemption.enforceDue()).toEqual({ enforced: [original.body.runId] });
  });

  it('lets the host scheduler issue only after opt-in and recovers a due notice from disk', async () => {
    await setup(true); const original = lease(); await client.sessionAdmit(original);
    await expect(preemption.issueFromHost(original.body.runId,
      { noticeMilliseconds: 30_000, reason: 'capacity', key: 'host-capacity-1' })).rejects.toThrow();
    await preemption.optIn(optIn(original));
    const issued = await preemption.issueFromHost(original.body.runId,
      { noticeMilliseconds: 30_000, reason: 'capacity', key: 'host-capacity-1' });
    expect((await preemption.issueFromHost(original.body.runId,
      { noticeMilliseconds: 30_000, reason: 'capacity', key: 'host-capacity-1' })).notice).toEqual(issued.notice);
    await preemption.close(); await paid.close(); await hosted.close();
    await new Promise<void>(resolve => server.close(() => resolve())); await journal.close();
    preemption = undefined as unknown as PaidHostPreemptionService;
    paid = undefined as unknown as PaidHostSessionAgent;
    hosted = undefined as unknown as ReturnType<typeof createHostedHostKit>;
    server = undefined as unknown as Server;

    now = issued.notice.body.interruptAt;
    journal = await openHostJournal(join(directory, 'host-state'));
    expect(journal.identity.publicKey).toBe(issued.notice.body.hostKey);
    const cells = join(directory, 'cells');
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
    hosted = createHostedHostKit({ journal, runtime: new LocalProcessFixtureRuntime('test-fixture-only'),
      backend, controlKey: controller.publicKey, reviewedImages: new Set([image]),
      scope: { version: 1, hostKey: journal.identity.publicKey, controlKey: controller.publicKey,
        isolation: 'local_process_fixture', runtime: canonical(['fixture-session-runtime', directory]),
        sessionBackend: backend.identity }, inventory: async () => [] });
    await hosted.initialize();
    paid = new PaidHostSessionAgent(journal, hosted.sessions, controller.publicKey, () => now);
    await paid.initialize();
    preemption = new PaidHostPreemptionService(journal, paid, () => now);
    await preemption.initialize();
    const [recovered] = await journal.db.select().from(hostPaidPreemptions)
      .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    expect(recovered?.notice).toEqual(issued.notice);
    expect(recovered?.cleanupConfirmed).toBe(true);
  });

  it('retries a raw cleanup failure on the watchdog timer while blocking new issuance', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    await preemption.optIn(optIn(original));
    const input = { noticeMilliseconds: 30_000, reason: 'capacity' as const, key: 'host-watchdog-raw-error' };
    const issued = await preemption.issueFromHost(original.body.runId, input);
    let failed!: () => void;
    const firstFailure = new Promise<void>(resolve => { failed = resolve; });
    vi.spyOn(paid, 'preemptExact').mockImplementationOnce(async () => {
      failed(); throw new Error('raw backend cleanup error');
    });
    now = issued.notice.body.interruptAt;
    await Promise.race([firstFailure, new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Watchdog did not run')), 2_500))]);
    await new Promise(resolve => setTimeout(resolve, 30));
    const [pending] = await journal.db.select().from(hostPaidPreemptions)
      .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    expect(pending?.cleanupConfirmed).toBe(false);
    await expect(preemption.issueFromHost(original.body.runId, input)).rejects.toThrow();
    const deadline = Date.now() + 3_000;
    let cleaned = false;
    while (!cleaned && Date.now() < deadline) {
      const [row] = await journal.db.select().from(hostPaidPreemptions)
        .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
      cleaned = row?.cleanupConfirmed === true;
      if (!cleaned) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(cleaned).toBe(true);
    expect((await preemption.issueFromHost(original.body.runId, input)).notice).toEqual(issued.notice);
  }, 10_000);

  it('retries a transient journal read on the watchdog timer without accepting new notices', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    await preemption.optIn(optIn(original));
    const input = { noticeMilliseconds: 30_000, reason: 'capacity' as const, key: 'host-journal-read-error' };
    const issued = await preemption.issueFromHost(original.body.runId, input);
    const read = vi.spyOn(journal.db, 'select').mockImplementationOnce(() => { throw new Error('temporary journal read error'); });
    now = issued.notice.body.interruptAt;
    await expect(preemption.enforceDue()).rejects.toMatchObject({ code: 'preemption_cleanup_uncertain' });
    read.mockRestore();
    await expect(preemption.issueFromHost(original.body.runId, input)).rejects.toThrow();
    const deadline = Date.now() + 3_000;
    let cleaned = false;
    while (!cleaned && Date.now() < deadline) {
      const [row] = await journal.db.select().from(hostPaidPreemptions)
        .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
      cleaned = row?.cleanupConfirmed === true;
      if (!cleaned) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(cleaned).toBe(true);
    expect((await preemption.issueFromHost(original.body.runId, input)).notice).toEqual(issued.notice);
  }, 10_000);

  it('keeps a corrupted durable authority terminal even after the row is repaired', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    const accepted = optIn(original); await preemption.optIn(accepted);
    const issued = await preemption.issue(request(original));
    await journal.db.update(hostPaidPreemptions).set({ optInHash: randomId() })
      .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    now = issued.notice.body.interruptAt;
    await expect(preemption.enforceDue()).rejects.toMatchObject({ code: 'paid_preemption_invalid' });
    await journal.db.update(hostPaidPreemptions).set({ optInHash: hostMessageHash(accepted) })
      .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    await expect(preemption.enforceDue()).rejects.toMatchObject({ code: 'paid_preemption_unavailable' });
    const [pending] = await journal.db.select().from(hostPaidPreemptions)
      .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    expect(pending?.cleanupConfirmed).toBe(false);
  });

  it('fails closed on a changed durable notice before watchdog recovery', async () => {
    await setup(); const original = lease(); await client.sessionAdmit(original);
    await preemption.optIn(optIn(original)); const issued = await preemption.issue(request(original));
    await preemption.close();
    await journal.db.update(hostPaidPreemptions).set({ notice: { ...issued.notice,
      body: { ...issued.notice.body, image: 'fixture/other@sha256:' + 'b'.repeat(64) } } })
      .where(eq(hostPaidPreemptions.sessionId, original.body.runId));
    const recovered = new PaidHostPreemptionService(journal, paid, () => now);
    await expect(recovered.initialize()).rejects.toThrow();
  });
});
