import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomId, canonical, hashJson } from '../src/common.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createHostedHostKit } from '../src/host-kit/hosted.js';
import { hostPaidSessions, hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PAID_SESSION_ARGV, paidSessionPolicy } from '../src/host-kit/sessions/paid-protocol.js';

const image = 'fixture/session@sha256:' + 'a'.repeat(64), owner = '0x' + '1'.repeat(40);
describe('signed HostKit paid interactive session', () => {
  let journal: HostJournal, directory: string, server: Server;
  let hosted: ReturnType<typeof createHostedHostKit>, paid: PaidHostSessionAgent;
  let control: Ed25519Identity, client: HostKitClient;
  afterEach(async () => {
    await paid?.close().catch(() => undefined);
    await hosted?.close().catch(() => undefined);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await journal?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function setup() {
    directory = await mkdtemp(join(tmpdir(), 'telomere-paid-host-'));
    const cells = join(directory, 'cells'); await mkdir(cells, { mode: 0o700 });
    journal = await openHostJournal(':memory:'); control = new Ed25519Identity();
    const runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
    hosted = createHostedHostKit({ journal, runtime, backend, controlKey: control.publicKey,
      reviewedImages: new Set([image]), scope: { version: 1, hostKey: journal.identity.publicKey,
        controlKey: control.publicKey, isolation: 'local_process_fixture',
        runtime: canonical(['fixture-session-runtime', directory]), sessionBackend: backend.identity },
      inventory: async () => [] });
    await hosted.initialize(); paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey); await paid.initialize();
    server = createServer(getRequestListener(createHostKitRoutes(hosted.agent, paid).fetch));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test host port');
    client = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, control, true);
  }
  function signedLease() {
    const runId = randomId(), maxSeconds = 25, now = Date.now();
    const spec = { version: 1 as const, sessionId: runId, image, lifetimeSeconds: maxSeconds,
      policy: paidSessionPolicy(4) };
    const body: HostLease = { version: 1, hostKey: journal.identity.publicKey, runId, owner, image,
      argv: [...PAID_SESSION_ARGV], stdin: JSON.stringify({ spec, quoteHash: randomId(), admissionTx: randomId() }),
      issuedAt: now, expiresAt: now + maxSeconds * 1000, maxSeconds, nonce: randomId() };
    return control.sign('lease', body);
  }
  it('runs sequential owner-authorized commands in one persisted process and acknowledges signed metering', async () => {
    await setup(); const lease = signedLease();
    const admitted = await client.sessionAdmit(lease);
    expect(admitted).toMatchObject({ state: 'running', runId: lease.body.runId, isolation: 'local_process_fixture' });
    const first = await client.sessionControl(lease, { action: 'execute', command: { commandId: 'write',
      argv: [process.execPath, '-e', "require('node:fs').writeFileSync('shared.txt','persisted');process.stdout.write('first');"] } });
    expect(first.command).toMatchObject({ state: 'completed', stdout: 'first' });
    const second = await client.sessionControl(lease, { action: 'execute', command: { commandId: 'read',
      argv: [process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync('shared.txt','utf8'));" ] } });
    expect(second.command).toMatchObject({ state: 'completed', stdout: 'persisted' });
    const meter = new HostMeterVerifier(lease.body, control);
    let status = await client.sessionControl(lease, { action: 'status' });
    for (const tick of status.ticks) {
      const ack = meter.accept(tick); status = await client.sessionControl(lease, { action: 'ack', ack });
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      await new Promise(resolve => setTimeout(resolve, 5_300));
      status = await client.sessionControl(lease, { action: 'status' });
      for (const tick of status.ticks.slice(status.acks.length)) {
        const ack = meter.accept(tick); status = await client.sessionControl(lease, { action: 'ack', ack });
      }
    }
    expect(meter.billableSeconds).toBeGreaterThan(0);
    expect(status.events.some(event => event.kind === 'ready')).toBe(true);
    status = await client.sessionControl(lease, { action: 'stop' });
    expect(status.cleanupConfirmed).toBe(true);
    expect(status.state).toBe('stopped');
    expect(status.ticks.at(-1)?.body.state).toBe('STOPPED');
    expect(status.billableSeconds).toBe(meter.billableSeconds);
    expect((await client.sessionControl(lease, { action: 'execute', command: first.command!.command })).command).toEqual(first.command);
    await expect(client.sessionControl(lease, { action: 'execute', command: { ...first.command!.command,
      argv: [process.execPath, '-e', "process.stdout.write('changed')"] } })).rejects.toMatchObject({
      status: 409, code: 'platform_command_conflict' });
    await expect(client.sessionControl(lease, { action: 'execute', command: { commandId: 'late',
      argv: [process.execPath, '-e', 'process.exit(0)'] } })).rejects.toThrow();
  }, 30_000);
  it('rejects a command signed by another controller and a changed lease before execution', async () => {
    await setup(); const lease = signedLease(); await client.sessionAdmit(lease);
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test host port');
    const other = new HostKitClient(`http://127.0.0.1:${address.port}`, journal.identity.publicKey, new Ed25519Identity(), true);
    await expect(other.sessionControl(lease, { action: 'execute', command: { commandId: 'forbidden',
      argv: [process.execPath, '-e', 'process.exit(0)'] } })).rejects.toThrow();
    const changed = { ...lease, body: { ...lease.body, image: 'fixture/other@sha256:' + 'b'.repeat(64) } };
    await expect(client.sessionAdmit(changed)).rejects.toThrow();
    const status = await client.sessionControl(lease, { action: 'status' });
    expect(status.events.some(event => event.kind === 'started')).toBe(false);
  });
  it('rejects a terminal replay when its retained command result differs from the durable event history', async () => {
    await setup(); const lease = signedLease(); await client.sessionAdmit(lease);
    const command = { commandId: 'once', argv: [process.execPath, '-e', "process.stdout.write('original')"] };
    expect((await client.sessionControl(lease, { action: 'execute', command })).command?.stdout).toBe('original');
    await client.sessionControl(lease, { action: 'stop' });
    const [session] = await journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, lease.body.runId));
    if (!session?.record) throw new Error('Missing durable command result');
    const changed = structuredClone(session.record); changed.commands[0]!.stdout = 'forged';
    await journal.db.update(hostSessions).set({ record: changed }).where(eq(hostSessions.sessionId, lease.body.runId));
    await expect(client.sessionControl(lease, { action: 'execute', command })).rejects.toThrow();
  });
  it('signs only saved events while an output journal write is pending', async () => {
    await setup();
    let release!: () => void, held = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reserve = hosted.admission.session.bind(hosted.admission);
    vi.spyOn(hosted.admission, 'session').mockImplementation(async spec => {
      const original = await reserve(spec);
      return { ...original, journal: { load: () => original.journal.load(), save: async record => {
        if (!held && record.events.some(event => event.kind === 'output')) { held = true; await barrier; }
        await original.journal.save(record);
      } } };
    });
    const lease = signedLease(); await client.sessionAdmit(lease);
    const running = client.sessionControl(lease, { action: 'execute', command: { commandId: 'paused',
      argv: [process.execPath, '-e', "process.stdout.write('pending');setTimeout(()=>process.exit(0),300)"] } });
    void running.catch(() => undefined);
    try {
      const deadline = Date.now() + 5_000;
      while (!held && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
      expect(held).toBe(true);
      const signed = await client.sessionControl(lease, { action: 'status' });
      const [saved] = await journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, lease.body.runId));
      expect(saved?.record).toBeDefined();
      expect(signed.events).toEqual(saved!.record!.events);
      expect(signed.events.some(event => event.kind === 'output')).toBe(false);
      expect(signed.eventsHash).toBe(hashJson({ protocol: 'telomere-paid-session-events-v1', events: saved!.record!.events }));
    } finally { release(); }
    expect((await running).command?.stdout).toBe('pending');
  });
  it('refuses signed status after a session event journal failure', async () => {
    await setup(); let failed = false;
    const reserve = hosted.admission.session.bind(hosted.admission);
    vi.spyOn(hosted.admission, 'session').mockImplementation(async spec => {
      const original = await reserve(spec);
      return { ...original, journal: { load: () => original.journal.load(), save: async record => {
        if (!failed && record.events.some(event => event.kind === 'output')) { failed = true; throw new Error('simulated journal failure'); }
        await original.journal.save(record);
      } } };
    });
    const lease = signedLease(); await client.sessionAdmit(lease);
    const running = client.sessionControl(lease, { action: 'execute', command: { commandId: 'failed-save',
      argv: [process.execPath, '-e', "process.stdout.write('unsaved');setTimeout(()=>{},500)"] } });
    void running.catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (!failed && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    expect(failed).toBe(true);
    await expect(client.sessionControl(lease, { action: 'status' })).rejects.toThrow();
    await running.catch(() => undefined);
  });
  it('serializes concurrent ACK and stop without dropping evidence or cleanup', async () => {
    await setup(); const lease = signedLease();
    const admitted = await client.sessionAdmit(lease);
    const first = admitted.ticks[0]; if (!first) throw new Error('Initial signed meter tick missing');
    const meter = new HostMeterVerifier(lease.body, control), ack = meter.accept(first);
    await Promise.all([client.sessionControl(lease, { action: 'ack', ack }), client.sessionControl(lease, { action: 'stop' })]);
    const final = await client.sessionControl(lease, { action: 'status' });
    expect(final).toMatchObject({ state: 'stopped', cleanupConfirmed: true, billableSeconds: 0 });
    expect(final.acks).toEqual([ack]);
    expect(final.ticks.map(tick => tick.body.sequence)).toEqual([0, 1]);
    expect(final.ticks[1]?.body.previousHash).toBeDefined();
    expect(final.ticks[1]?.body.state).toBe('STOPPED');
  });
  it('rejects a changed durable signed meter before host recovery', async () => {
    await setup(); const lease = signedLease(); await client.sessionAdmit(lease);
    await client.sessionControl(lease, { action: 'stop' });
    await paid.close();
    await journal.db.update(hostPaidSessions).set({ billableSeconds: 1 }).where(eq(hostPaidSessions.sessionId, lease.body.runId));
    paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey);
    await expect(paid.initialize()).rejects.toThrow('meter or terminal state changed');
  });
});
