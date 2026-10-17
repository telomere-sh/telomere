import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { randomId } from '../src/common.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { hostRuntimeInfoArgs } from '../src/host-kit/docker-runtime.js';
import { createDockerHostedHostKit } from '../src/host-kit/hosted.js';
import { hostPaidPreemptions, hostPaidSessions, hostSessions, openHostJournal,
  type HostJournal } from '../src/host-kit/journal.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { Ed25519Identity, hostMessageHash, imageDigestSchema, verifyHostMessage,
  type HostLease } from '../src/host-kit/protocol.js';
import { sessionContainerName } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PAID_SESSION_ARGV, paidSessionPolicy } from '../src/host-kit/sessions/paid-protocol.js';
import { PaidHostPreemptionService } from '../src/host-kit/sessions/paid-preemption.js';
import { executeCommand } from '../src/runtime/command.js';

type Options = { image: string; dockerSocket: string; dockerBinary?: string };
type Report = Record<string, unknown>;
class AcceptanceFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new AcceptanceFailure(code); }
const pause = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));

/** Standalone real-gVisor watchdog acceptance. All identities and state are disposable. */
export async function paidPreemptionGvisorAcceptance(options: Options): Promise<Report> {
  let stage = 'preflight', work: string | undefined, journal: HostJournal | undefined;
  let host: ReturnType<typeof createDockerHostedHostKit> | undefined;
  let paid: PaidHostSessionAgent | undefined, preemption: PaidHostPreemptionService | undefined;
  let server: Server | undefined, hostKey: string | undefined, containerName: string | undefined;
  let ownedRunId: string | undefined;
  let report: Report | undefined, cleaned = true;
  const previousMask = process.umask(0o077);
  try {
    check(process.platform === 'linux', 'linux_gvisor_required');
    const image = imageDigestSchema.parse(options.image), socket = options.dockerSocket;
    check(/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(socket) && !socket.includes('..')
      && !['/var/run/docker.sock', '/run/docker.sock'].includes(socket), 'dedicated_docker_socket_required');
    const socketStat = await lstat(socket);
    check(socketStat.isSocket() && !socketStat.isSymbolicLink(), 'docker_socket_invalid');
    const binary = options.dockerBinary ?? 'docker';
    const docker = (args: string[], maxOutputBytes = 16_384) => executeCommand(binary,
      ['--host', 'unix://' + socket, ...args], { signal: AbortSignal.timeout(10_000), maxOutputBytes });
    const runtime = await docker(hostRuntimeInfoArgs('gvisor'));
    check(runtime.exitCode === 0 && runtime.stdout.trim()
      && JSON.parse(runtime.stdout).split('/').at(-1) === 'runsc', 'runsc_unavailable');
    check((await docker(['image', 'inspect', image, '--format', '{{json .Id}}'])).exitCode === 0,
      'reviewed_image_not_local');
    work = await mkdtemp(join(tmpdir(), 'telomere-paid-preempt-gvisor-'));
    journal = await openHostJournal(join(work, 'host'));
    hostKey = journal.identity.publicKey;
    const controller = new Ed25519Identity();
    host = createDockerHostedHostKit({ journal, controlKey: controller.publicKey,
      reviewedImages: new Set([image]), isolation: 'gvisor', socketPath: socket, dockerBinary: binary });
    await host.initialize();
    paid = new PaidHostSessionAgent(journal, host.sessions, controller.publicKey);
    await paid.initialize();
    preemption = new PaidHostPreemptionService(journal, paid);
    await preemption.initialize();
    server = createServer(getRequestListener(createHostKitRoutes(host.agent, paid, preemption).fetch));
    await new Promise<void>((done, reject) => server!.listen(0, '127.0.0.1', done).once('error', reject));
    const address = server.address();
    check(address && typeof address !== 'string', 'host_loopback_bind_failed');
    const client = new HostKitClient('http://127.0.0.1:' + address.port, hostKey, controller);
    const issuedAt = Date.now(), runId = randomId(), owner = '0x' + randomBytes(20).toString('hex');
    ownedRunId = runId;
    const maxSeconds = 90;
    const spec = { version: 1 as const, sessionId: runId, image, lifetimeSeconds: maxSeconds,
      policy: paidSessionPolicy(2) };
    const body: HostLease = { version: 1, hostKey, runId, owner, image,
      argv: [...PAID_SESSION_ARGV], stdin: JSON.stringify({ spec, quoteHash: randomId(), admissionTx: randomId() }),
      issuedAt, expiresAt: issuedAt + maxSeconds * 1000, maxSeconds, nonce: randomId() };
    const lease = controller.sign('lease', body);
    containerName = sessionContainerName(hostKey, runId);
    stage = 'admit_real_gvisor_paid_cell';
    const admitted = await client.sessionAdmit(lease);
    check(admitted.state === 'running' && admitted.isolation === 'gvisor', 'paid_gvisor_admission_failed');
    const inspected = await docker(['inspect', '--format',
      '{"id":{{json .Id}},"name":{{json .Name}},"runtime":{{json .HostConfig.Runtime}},"network":{{json .HostConfig.NetworkMode}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}}}', containerName]);
    check(inspected.exitCode === 0, 'paid_cell_not_found');
    const cell = JSON.parse(inspected.stdout) as { id?: string; name?: string; runtime?: string; network?: string;
      readOnly?: boolean; running?: boolean; labels?: Record<string, string> };
    check(cell.id && /^[a-f0-9]{64}$/.test(cell.id) && cell.name === '/' + containerName
      && cell.runtime === 'runsc' && cell.network === 'none' && cell.readOnly === true && cell.running === true
      && cell.labels?.['telomere.session'] === 'true' && cell.labels['telomere.host_key'] === hostKey
      && cell.labels['telomere.session_id'] === runId, 'paid_cell_isolation_invalid');
    const probe = await client.sessionControl(lease, { action: 'execute', command: {
      commandId: 'preemption-probe', argv: ['/usr/local/bin/node', '-e', "process.stdout.write('cell-active')"] } });
    check(probe.command?.state === 'completed' && probe.command.stdout === 'cell-active',
      'paid_cell_probe_failed');
    const sameCell = await docker(['inspect', '--format', '{{json .Id}}', containerName]);
    check(sameCell.exitCode === 0 && JSON.parse(sameCell.stdout) === cell.id, 'paid_cell_changed_before_notice');
    stage = 'signed_owner_opt_in_and_notice';
    const optIn = await client.preemptionOptIn(lease, 'gvisor-owner-optin-001');
    check(!optIn.replayed && verifyHostMessage(controller.publicKey, 'paid-preemption-optin', optIn.optIn),
      'owner_opt_in_signature_invalid');
    check(hostMessageHash(await client.preemptionOptInEvidence(lease)) === hostMessageHash(optIn.optIn),
      'durable_owner_opt_in_changed');
    const requested = await client.requestPreemptionNotice(lease, 30_000, 'capacity', 'gvisor-host-notice-001');
    const notice = requested.notice;
    check(!requested.replayed && verifyHostMessage(hostKey, 'paid-preemption', notice)
      && notice.body.runId === runId && notice.body.owner === owner
      && notice.body.leaseHash === hostMessageHash(lease) && notice.body.optInHash === hostMessageHash(optIn.optIn)
      && notice.body.image === image && notice.body.interruptAt - notice.body.issuedAt === 30_000
      && notice.body.interruptAt <= lease.body.expiresAt, 'signed_notice_scope_invalid');
    const replay = await client.requestPreemptionNotice(lease, 30_000, 'capacity', 'gvisor-host-notice-001');
    check(replay.replayed && hostMessageHash(replay.notice) === hostMessageHash(notice)
      && hostMessageHash(await client.preemptionNotice(lease)) === hostMessageHash(notice),
      'notice_replay_changed');
    stage = 'watchdog_deadline_stop';
    const meter = new HostMeterVerifier(lease.body, controller);
    let acked = 0, terminalObservedAt = 0;
    let status = admitted;
    const deadline = notice.body.interruptAt + 8_000;
    while (Date.now() < deadline) {
      status = await client.sessionControl(lease, { action: 'status' });
      while (acked < status.ticks.length) {
        const tick = status.ticks[acked]!;
        check(verifyHostMessage(hostKey, 'tick', tick), 'signed_meter_tick_invalid');
        const ack = meter.accept(tick);
        status = await client.sessionControl(lease, { action: 'ack', ack });
        check(status.acks.some(value => hostMessageHash(value) === hostMessageHash(ack)), 'signed_meter_ack_missing');
        acked++;
      }
      if (status.state !== 'running') { terminalObservedAt = Date.now(); break; }
      await pause(500);
    }
    check(status.state === 'stopped' && status.cleanupConfirmed && terminalObservedAt >= notice.body.interruptAt
      && terminalObservedAt <= deadline && terminalObservedAt < lease.body.expiresAt,
    'watchdog_did_not_stop_at_notice_deadline');
    check(acked === status.ticks.length && status.acks.length === status.ticks.length
      && status.ticks.filter(tick => tick.body.state === 'STOPPED').length === 1
      && status.ticks.every(tick => verifyHostMessage(hostKey!, 'tick', tick)), 'duplicate_or_unsigned_terminal_tick');
    stage = 'exact_physical_cleanup_and_durable_enforcement';
    const absent = await docker(['ps', '--all', '--filter', 'name=^/' + containerName + '$', '--format', '{{.ID}}']);
    check(absent.exitCode === 0 && absent.stdout.trim() === '', 'original_gvisor_cell_remains');
    const [paidRow] = await journal.db.select().from(hostPaidSessions).where(eq(hostPaidSessions.sessionId, runId));
    const [preemptionRow] = await journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, runId));
    const [sessionRow] = await journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, runId));
    check(paidRow?.state === 'stopped' && paidRow.cleanupConfirmed && paidRow.leaseHash === hostMessageHash(lease)
      && preemptionRow?.cleanupConfirmed && preemptionRow.enforcedAt
      && sessionRow?.record?.cleanupConfirmed && !['starting', 'running'].includes(sessionRow.record.state),
    'durable_preemption_cleanup_missing');
    const enforcedAt = preemptionRow.enforcedAt.getTime(), tickCount = paidRow.ticks.length;
    await pause(2200);
    check((await preemption.enforceDue()).enforced.length === 0, 'watchdog_reenforced_terminal_run');
    const [after] = await journal.db.select().from(hostPaidPreemptions).where(eq(hostPaidPreemptions.sessionId, runId));
    const [afterPaid] = await journal.db.select().from(hostPaidSessions).where(eq(hostPaidSessions.sessionId, runId));
    check(after?.enforcedAt?.getTime() === enforcedAt && afterPaid?.ticks.length === tickCount
      && afterPaid.ticks.filter(tick => tick.body.state === 'STOPPED').length === 1,
    'duplicate_preemption_stop');
    report = { status: 'passed', checkedAt: new Date().toISOString(), protocol: 'telomere-paid-preemption/v1',
      isolation: 'gvisor', image, runId, hostKey, noticeId: notice.body.noticeId,
      signedOptIn: true, signedNotice: true, noticeMilliseconds: 30_000,
      noticeDeadline: new Date(notice.body.interruptAt).toISOString(),
      terminalObservedAt: new Date(terminalObservedAt).toISOString(),
      watchdogStopLatencyMs: terminalObservedAt - notice.body.interruptAt,
      exactCellIdVerified: true, physicalCleanupConfirmed: true, durableEnforcementConfirmed: true,
      probeCommandExecuted: true,
      signedTicks: status.ticks.length, signedAcks: status.acks.length, oneTerminalStop: true,
      duplicateEnforcement: false, publicTransactions: 0, privateKeysIncluded: false };
  } catch (error) {
    report = { status: 'failed', checkedAt: new Date().toISOString(), stage,
      code: error instanceof AcceptanceFailure ? error.code : 'preemption_acceptance_dependency_failed',
      publicTransactions: 0, privateKeysIncluded: false };
  } finally {
    try { await preemption?.close(); } catch { cleaned = false; }
    try { await paid?.close(); } catch { cleaned = false; }
    try { await host?.close(); } catch { cleaned = false; }
    try { if (server) { server.closeAllConnections(); await new Promise<void>((done, reject) =>
      server!.close(error => error ? reject(error) : done())); } } catch { cleaned = false; }
    try { await journal?.close(); } catch { cleaned = false; }
    if (hostKey) {
      try {
        const binary = options.dockerBinary ?? 'docker';
        const docker = (args: string[]) => executeCommand(binary,
          ['--host', 'unix://' + options.dockerSocket, ...args], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 16_384 });
        const inventory = async () => docker(['ps', '--all', '--no-trunc', '--filter', 'label=telomere.session=true',
          '--filter', 'label=telomere.host_key=' + hostKey, '--format', '{{.ID}} {{.Names}}']);
        const found = await inventory();
        if (found.exitCode !== 0) cleaned = false;
        else for (const row of found.stdout.trim().split(/\r?\n/).filter(Boolean)) {
          const pair = /^([a-f0-9]{64}) (tlmr-session-[a-f0-9]{8}-[a-f0-9]{64})$/.exec(row);
          if (!pair || pair[2] !== containerName) { cleaned = false; continue; }
          const inspect = await docker(['inspect', '--format',
            '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}}}', pair[1]!]);
          if (inspect.exitCode !== 0) { cleaned = false; continue; }
          const value = JSON.parse(inspect.stdout) as { id?: string; name?: string; image?: string; labels?: Record<string, string> };
          if (value.id !== pair[1] || value.name !== '/' + containerName || value.image !== options.image
            || value.labels?.['telomere.session'] !== 'true' || value.labels['telomere.host_key'] !== hostKey
            || value.labels['telomere.session_id'] !== ownedRunId) {
            cleaned = false; continue;
          }
          if ((await docker(['rm', '--force', '--volumes', pair[1]!])).exitCode !== 0) cleaned = false;
          cleaned = false; // A Cell surviving normal shutdown is an acceptance failure even if forced removal succeeds.
        }
        const after = await inventory();
        if (after.exitCode !== 0 || after.stdout.trim() !== '') cleaned = false;
      } catch { cleaned = false; }
    }
    try { if (work) await rm(work, { recursive: true, force: true }); } catch { cleaned = false; }
    process.umask(previousMask);
  }
  if (!cleaned) report = { status: 'failed', checkedAt: new Date().toISOString(), stage: 'disposable_shutdown',
    code: 'owned_resource_cleanup_unconfirmed', publicTransactions: 0, privateKeysIncluded: false };
  return { ...report, disposableHostAndAcceptanceResourcesStopped: cleaned };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), valid = (args.length === 4 || args.length === 6)
    && args[0] === '--image' && args[2] === '--docker-socket'
    && (args.length === 4 || args[4] === '--docker-binary');
  const report = valid ? await paidPreemptionGvisorAcceptance({ image: args[1]!, dockerSocket: args[3]!,
    ...(args[5] ? { dockerBinary: args[5] } : {}) })
    : { status: 'failed', stage: 'preflight', code: 'acceptance_arguments_invalid',
      publicTransactions: 0, privateKeysIncluded: false, disposableHostAndAcceptanceResourcesStopped: true };
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.status !== 'passed') process.exitCode = 1;
}
