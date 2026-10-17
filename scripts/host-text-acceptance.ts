import { createServer, type Server } from 'node:http';
import { chmod, lstat, mkdtemp, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { hashJson, randomId } from '../src/common.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient, HostKitCommandExecutor, type HostKitObserver } from '../src/host-kit/client.js';
import { DockerHostRuntime } from '../src/host-kit/docker-runtime.js';
import { hostRuns, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, verifyHostMessage, type SignedHostLease } from '../src/host-kit/protocol.js';
import { validateCpuResult } from '../src/runtime/validation.js';

const IMAGE = '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe';
const DOCKER_SOCKET = '/var/run/telomere-host-docker/docker.sock';
const PRIVATE_ROOT = '/opt/telomere-host-runtime';
const EXISTING_HOST_KEY = '0xe11487bd43e613c421f7eaffcb79d97cd8b507f9b16f33d36bcadeebbbc3874c';
const OWNER = '0x1111111111111111111111111111111111111111';
const MAX_SECONDS = 20;
const INVALID_TEXT = '[telomere: invalid UTF-8 or NUL in stdout]';
const CASES = [
  { name: 'split_utf8_and_bom', program: 'process.stdout.write(Buffer.from([239,187,191,240,159]),()=>setTimeout(()=>process.stdout.write(Buffer.from([167,172,10])),250));',
    output: '🧬\n', state: 'completed', exitCode: 0 },
  { name: 'nul_stdout', program: 'process.stdout.write(Buffer.from([65,0,66]));', output: INVALID_TEXT, state: 'failed', exitCode: -1 },
  { name: 'incomplete_utf8_stdout', program: 'process.stdout.write(Buffer.from([240,159]));', output: INVALID_TEXT, state: 'failed', exitCode: -1 },
  { name: 'following_valid_utf8', program: 'process.stdout.write("после ошибок 🧬\\n");', output: 'после ошибок 🧬\n', state: 'completed', exitCode: 0 },
] as const;

class AcceptanceFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new AcceptanceFailure(code); }
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { server.closeAllConnections(); reject(new AcceptanceFailure('http_shutdown_unconfirmed')); }, 5000);
    server.close(error => { clearTimeout(timer); if (error) reject(new AcceptanceFailure('http_shutdown_unconfirmed')); else done(); });
    server.closeIdleConnections();
  });
}

/** Importing this module does not start a server, contact Docker or touch the existing HostKit daemon. */
export async function hostTextAcceptance(): Promise<Record<string, unknown>> {
  let stage = 'preflight', directory: string | undefined, journal: HostJournal | undefined;
  let server: Server | undefined, agent: HostKitAgent | undefined, runtime: DockerHostRuntime | undefined, hostKey: string | undefined;
  let report: Record<string, unknown> | undefined, shutdownConfirmed = true, cleanupConfirmed = true;
  const previousMask = process.umask(0o077);
  try {
    check(process.platform === 'linux', 'linux_gvisor_required');
    const [root, socket] = await Promise.all([lstat(PRIVATE_ROOT), lstat(DOCKER_SOCKET)]);
    check(root.isDirectory() && !root.isSymbolicLink() && socket.isSocket() && !socket.isSymbolicLink(), 'reviewed_runtime_paths_unavailable');
    directory = await mkdtemp(join(PRIVATE_ROOT, 'host-text-')); await chmod(directory, 0o700);
    journal = await openHostJournal(join(directory, 'host')); hostKey = journal.identity.publicKey;
    const control = new Ed25519Identity();
    check(hostKey !== EXISTING_HOST_KEY && hostKey !== control.publicKey, 'isolated_identity_required');
    await writeFile(join(directory, 'control.pem'), control.exportPrivatePem(), { mode: 0o600, flag: 'wx' });
    runtime = new DockerHostRuntime({ isolation: 'gvisor', socketPath: DOCKER_SOCKET });
    agent = new HostKitAgent(journal, runtime, control.publicKey, new Set([IMAGE]));
    stage = 'isolated_gvisor_initialize';
    const recovery = await agent.initialize();
    check(recovery.orphanedCells.length === 0 && recovery.faultedRuns.length === 0, 'fresh_host_inventory_not_empty');
    server = createServer(getRequestListener(createHostKitRoutes(agent).fetch));
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
    const address = server.address(); check(address && typeof address !== 'string', 'loopback_http_unavailable');
    const client = new HostKitClient(`http://127.0.0.1:${address.port}`, hostKey, control);
    const snapshots = new Map<string, string>();
    const outcomes: Record<string, unknown>[] = [];
    async function persist(value: unknown): Promise<void> {
      const file = await open(join(directory!, 'controller-evidence.jsonl'), 'a', 0o600);
      try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
    }
    for (const fixture of CASES) {
      stage = fixture.name;
      const input = { runId: randomId(), maxSeconds: MAX_SECONDS, argv: ['/usr/local/bin/node', '-e', fixture.program] };
      let lease: SignedHostLease | undefined;
      const observer: HostKitObserver = {
        onLease: async value => {
          check(verifyHostMessage(control.publicKey, 'lease', value) && value.body.runId === input.runId
            && value.body.hostKey === hostKey && value.body.owner === OWNER && value.body.image === IMAGE
            && value.body.maxSeconds === MAX_SECONDS && JSON.stringify(value.body.argv) === JSON.stringify(input.argv)
            && value.body.stdin === undefined, 'original_command_lease_changed');
          await persist({ kind: 'lease', lease: value }); lease = value;
        },
        onEvidence: async (tick, ack) => {
          check(verifyHostMessage(hostKey!, 'tick', tick) && verifyHostMessage(control.publicKey, 'ack', ack)
            && tick.body.runId === input.runId && ack.body.runId === input.runId, 'signed_command_evidence_invalid');
          await persist({ kind: 'evidence', tick, ack });
        },
      };
      const result = await new HostKitCommandExecutor(client, OWNER, IMAGE, observer).run(input, AbortSignal.timeout(30_000));
      validateCpuResult(result, input.runId, MAX_SECONDS);
      check(lease && result.output === fixture.output && result.status === fixture.state && result.exitCode === fixture.exitCode, 'command_text_result_mismatch');
      const status = await client.command(lease, 'status');
      check(status.isolation === 'gvisor' && status.state === fixture.state && status.cleanupConfirmed
        && status.output === fixture.output && status.exitCode === fixture.exitCode, 'signed_terminal_status_mismatch');
      check(status.billableSeconds === result.billableSeconds, 'signed_terminal_billing_mismatch');
      check(status.ticks.length > 0 && status.ticks.length === status.acks.length, 'signed_terminal_evidence_incomplete');
      const rows = await journal.db.select().from(hostRuns), row = rows.find(value => value.runId === input.runId);
      check(row && row.state === fixture.state && row.output === fixture.output && row.exitCode === fixture.exitCode && row.cleanupConfirmed
        && row.owner === OWNER && row.leaseHash === hostMessageHash(lease) && hostMessageHash(row.lease) === hostMessageHash(lease)
        && hashJson(row.ticks) === hashJson(status.ticks) && hashJson(row.acks) === hashJson(status.acks), 'durable_terminal_journal_mismatch');
      snapshots.set(input.runId, JSON.stringify(row));
      check((await runtime.cleanupOrphans(hostKey)).length === 0, 'unexpected_owned_cell_after_terminal');
      outcomes.push({ name: fixture.name, state: result.status, executorValidated: true, signedGvisorStatusVerified: true, durableCleanupConfirmed: true });
    }
    stage = 'durable_journal_reopen';
    await agent.close(); agent = undefined; await closeServer(server); server = undefined;
    await journal.close(); journal = undefined;
    journal = await openHostJournal(join(directory, 'host'));
    check(journal.identity.publicKey === hostKey, 'durable_host_identity_changed');
    const restored = await journal.db.select().from(hostRuns);
    check(restored.length === CASES.length && restored.every(row => snapshots.get(row.runId) === JSON.stringify(row)
      && row.cleanupConfirmed && !['starting', 'running'].includes(row.state)), 'durable_journal_reopen_changed');
    check((await runtime.cleanupOrphans(hostKey)).length === 0, 'unexpected_owned_cell_after_reopen');
    report = { status: 'passed', checkedAt: new Date().toISOString(), isolation: 'gvisor', image: IMAGE,
      dedicatedDockerSocket: true, freshHostIdentity: true, existingHostKitDaemonUnchanged: true, actualLoopbackHttp: true,
      splitUtf8Preserved: true, initialUtf8BomNormalized: true, nulStdoutRejectedDurably: true, incompleteUtf8RejectedDurably: true,
      subsequentValidCommandCompleted: true, journalCloseReopenVerified: true, cases: outcomes,
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  } catch (error) {
    report = { status: 'failed', checkedAt: new Date().toISOString(), stage,
      code: error instanceof AcceptanceFailure ? error.code : 'acceptance_dependency_failed',
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  } finally {
    try { await agent?.close(); } catch { shutdownConfirmed = false; }
    try { if (server) await closeServer(server); } catch { shutdownConfirmed = false; }
    try { if (runtime && hostKey) await runtime.cleanupOrphans(hostKey); } catch { cleanupConfirmed = false; }
    try { await journal?.close(); } catch { shutdownConfirmed = false; }
    process.umask(previousMask);
  }
  check(report, 'acceptance_report_missing');
  if (!shutdownConfirmed || !cleanupConfirmed) report = { status: 'failed', checkedAt: new Date().toISOString(), stage: 'isolated_shutdown',
    code: 'isolated_cleanup_unconfirmed', publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  const finalReport = { ...report, isolatedHttpAndJournalStopped: shutdownConfirmed, isolatedCellsCleanupConfirmed: cleanupConfirmed };
  if (directory) {
    try { await writeFile(join(directory, 'acceptance.json'), JSON.stringify(finalReport, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch { return { status: 'failed', stage: 'private_report_write', code: 'private_report_write_failed',
      isolatedHttpAndJournalStopped: shutdownConfirmed, isolatedCellsCleanupConfirmed: cleanupConfirmed,
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false }; }
  }
  return finalReport;
}

// Public output contains only fixed validation facts and generic failure codes.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = process.argv.length === 2 ? await hostTextAcceptance()
    : { status: 'failed', stage: 'preflight', code: 'acceptance_arguments_invalid',
      publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
  process.stdout.write(JSON.stringify(report) + '\n'); if (report.status !== 'passed') process.exitCode = 1;
}
