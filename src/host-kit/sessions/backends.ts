import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonical } from '../../common.js';
import { lstat, mkdir } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { executeCommand, type DockerCommand } from '../../runtime/command.js';
import { hostKeySchema } from '../protocol.js';
import { hostRuntimeInfoArgs } from '../docker-runtime.js';
import { SESSION_INIT_PROGRAM } from './init-program.js';
import { sessionCommandSchema, SessionRuntimeError, type SessionBackend, type SessionProcess, type SessionSpec } from './types.js';
import type { PaidCystInputSpool } from './cyst-input-spool.js';

function wire(child: ChildProcessWithoutNullStreams, onFrame: (frame: unknown) => void, onFault: () => void) {
  let buffer = '', bytes = 0, failed = false;
  const fault = () => { if (!failed) { failed = true; onFault(); } };
  child.stdout.on('data', (value: Buffer) => {
    if (failed) return;
    bytes += value.length;
    if (bytes > 2_097_152 || /[^\x09\x0a\x0d\x20-\x7e]/.test(value.toString('latin1'))) { fault(); return; }
    buffer += value.toString('ascii');
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) { if (buffer.length > 16_384) fault(); break; }
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.length > 16_384) { fault(); return; }
      try { onFrame(JSON.parse(line)); } catch { fault(); return; }
    }
  });
  child.stderr.on('data', (value: Buffer) => { bytes += value.length; if (bytes > 2_097_152) fault(); });
  child.once('error', fault);
  const closed = new Promise<void>(resolve => child.once('close', () => { if (buffer.length) fault(); resolve(); }));
  child.stdin.on('error', () => { if (child.exitCode === null && child.signalCode === null) fault(); });
  return { closed, send: async (value: unknown) => {
    const text = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(text) > 65_536 || child.exitCode !== null || child.signalCode !== null || failed) throw new SessionRuntimeError('session_unavailable');
    await new Promise<void>((resolve, reject) => child.stdin.write(text, error => error ? reject(new SessionRuntimeError('session_unavailable')) : resolve()));
  } };
}
async function waitClosed(closed: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Actual process/session behavior only. It is deliberately not a tenant,
 * filesystem, descendant-process or resource-isolation security boundary. */
export class LocalSessionFixtureBackend implements SessionBackend {
  readonly isolation = 'local_process_fixture' as const;
  readonly identity: string;
  private readonly processes = new Map<string, SessionProcess>();
  readonly cystInputs: PaidCystInputSpool | undefined;
  constructor(private readonly directory: string, acknowledgement: 'test-fixture-only', options: { cystInputs?: PaidCystInputSpool } = {}) {
    if (acknowledgement !== 'test-fixture-only' || !isAbsolute(directory)) throw new SessionRuntimeError('invalid_session');
    this.cystInputs = options.cystInputs;
    this.identity = createHash('sha256').update(JSON.stringify(['telomere-session-backend-v1', this.isolation, resolve(directory),
      ...(this.cystInputs ? [this.cystInputs.identity] : [])])).digest('hex');
  }
  async start(spec: SessionSpec, onFrame: (value: unknown) => void, onFault: (reason?: 'output_limit') => void): Promise<SessionProcess> {
    if (this.processes.has(spec.sessionId)) throw new SessionRuntimeError('session_conflict');
    if (spec.cystInput) {
      if (!this.cystInputs) throw new SessionRuntimeError('invalid_session');
      await this.cystInputs.readyDirectory(spec.sessionId, createHash('sha256').update(canonical(spec)).digest('hex'));
    }
    const directory = join(this.directory, spec.sessionId.slice(2));
    await mkdir(directory, { mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SessionRuntimeError('session_unavailable');
    const child = spawn(process.execPath, ['-e', SESSION_INIT_PROGRAM], { windowsHide: true, shell: false,
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    const framed = wire(child, onFrame, onFault); let stopped = false;
    const handle: SessionProcess = { ...framed, sample: async () => ({ running: child.exitCode === null && child.signalCode === null, cpuMs: 0 }),
      stop: async () => {
        if (stopped) return;
        await framed.send({ kind: 'stop', reason: 'requested' }).catch(() => undefined);
        if (!await waitClosed(framed.closed, 3000)) { child.kill('SIGKILL');
          if (!await waitClosed(framed.closed, 2000)) throw new SessionRuntimeError('session_cleanup_uncertain'); }
        if (spec.cystInput) {
          if (!this.cystInputs) throw new SessionRuntimeError('session_cleanup_uncertain');
          await this.cystInputs.cleanup(spec.sessionId);
        }
        stopped = true; this.processes.delete(spec.sessionId);
      } };
    this.processes.set(spec.sessionId, handle);
    await framed.send({ kind: 'initialize', spec }); return handle;
  }
  async cleanup(spec: SessionSpec): Promise<void> {
    const process = this.processes.get(spec.sessionId);
    if (!process) throw new SessionRuntimeError('session_cleanup_uncertain');
    await process.stop();
    if (spec.cystInput) await this.cystInputs?.cleanup(spec.sessionId);
  }
}

const inspectSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), image: z.string(),
  labels: z.record(z.string()), running: z.boolean() }).strict();
export function sessionContainerName(hostKey: string, sessionId: string): string {
  return 'tlmr-session-' + hostKeySchema.parse(hostKey).slice(2, 10) + '-' + sessionId.slice(2);
}
/** Pure policy digest used by read-only backup/scope verification tools. */
export function dockerSessionBackendIdentity(options: { isolation: 'gvisor' | 'kata'; hostKey: string;
  socketPath: string; dockerBinary?: string; cystInputIdentity?: string }): string {
  const hostKey = hostKeySchema.parse(options.hostKey), binary = options.dockerBinary ?? 'docker';
  if (!/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(options.socketPath) || options.socketPath.includes('..')
    || options.cystInputIdentity !== undefined && !/^[a-f0-9]{64}$/.test(options.cystInputIdentity)) throw new SessionRuntimeError('invalid_session');
  return createHash('sha256').update(JSON.stringify(['telomere-session-backend-v1', options.isolation, hostKey, options.socketPath, binary,
    ...(options.cystInputIdentity ? [options.cystInputIdentity] : [])])).digest('hex');
}
export function sessionDockerCreateArgs(name: string, hostKey: string, spec: SessionSpec, isolation: 'gvisor' | 'kata', readyDirectory?: string): string[] {
  if (name !== sessionContainerName(hostKey, spec.sessionId)) throw new SessionRuntimeError('invalid_session');
  if (spec.cystInput && (!readyDirectory || !/^\/[A-Za-z0-9_./-]+$/.test(readyDirectory)
    || readyDirectory.includes('..') || !readyDirectory.endsWith('/run-' + spec.sessionId.slice(2) + '/ready'))
    || !spec.cystInput && readyDirectory) throw new SessionRuntimeError('invalid_session');
  return ['create', '--name', name, '--label', 'telomere.session=true', '--label', 'telomere.host_key=' + hostKey,
    '--label', 'telomere.session_id=' + spec.sessionId, '--interactive', '--runtime', isolation === 'gvisor' ? 'runsc' : 'kata-runtime',
    '--network', 'none', '--read-only', '--pull', 'never', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '10000:10000',
    '--cpus', String(spec.policy.cpu), '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    ...(readyDirectory ? ['--mount', 'type=bind,src=' + readyDirectory + ',dst=/run/telomere-cyst,readonly,bind-propagation=rprivate'] : []),
    '--workdir', '/tmp', '--entrypoint', '/usr/local/bin/node',
    spec.image, '-e', SESSION_INIT_PROGRAM];
}
export class DockerSessionBackend implements SessionBackend {
  readonly isolation: 'gvisor' | 'kata';
  readonly identity: string;
  private readonly binary: string;
  private readonly socket: string;
  private readonly hostKey: string;
  private readonly prefix: string[];
  private readonly command: DockerCommand;
  private readonly unresolvedCreates = new Map<string, string>();
  readonly cystInputs: PaidCystInputSpool | undefined;
  constructor(options: { isolation: 'gvisor' | 'kata'; hostKey: string; socketPath: string; dockerBinary?: string; command?: DockerCommand;
    cystInputs?: PaidCystInputSpool }) {
    this.isolation = options.isolation; this.hostKey = hostKeySchema.parse(options.hostKey);
    this.socket = options.socketPath; this.binary = options.dockerBinary ?? 'docker';
    if (!/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(this.socket) || this.socket.includes('..')) throw new SessionRuntimeError('invalid_session');
    this.prefix = ['--host', 'unix://' + this.socket];
    this.cystInputs = options.cystInputs;
    this.identity = dockerSessionBackendIdentity({ isolation: this.isolation, hostKey: this.hostKey,
      socketPath: this.socket, dockerBinary: this.binary, ...(this.cystInputs ? { cystInputIdentity: this.cystInputs.identity } : {}) });
    this.command = options.command ?? ((args, input) => executeCommand(this.binary, [...this.prefix, ...args], input));
  }
  private async inspect(spec: SessionSpec) {
    const name = sessionContainerName(this.hostKey, spec.sessionId);
    const inventory = await this.command(['ps', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'],
      { signal: AbortSignal.timeout(5000), maxOutputBytes: 1024 });
    if (inventory.exitCode !== 0) throw new SessionRuntimeError('session_cleanup_uncertain');
    if (!inventory.stdout.trim()) return undefined;
    const result = await this.command(['inspect', '--format', '{"id":{{json .Id}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}', name],
      { signal: AbortSignal.timeout(5000), maxOutputBytes: 8192 });
    if (result.exitCode !== 0) throw new SessionRuntimeError('session_cleanup_uncertain');
    const value = inspectSchema.parse(JSON.parse(result.stdout));
    if (value.image !== spec.image || value.labels['telomere.session'] !== 'true'
      || value.labels['telomere.host_key'] !== this.hostKey || value.labels['telomere.session_id'] !== spec.sessionId
      || 'telomere.hostkit' in value.labels || 'telomere.run_id' in value.labels) throw new SessionRuntimeError('session_cleanup_uncertain');
    return value;
  }
  async cleanup(spec: SessionSpec): Promise<void> {
    const original = this.unresolvedCreates.get(spec.sessionId);
    if (original && original !== createHash('sha256').update(canonical(spec)).digest('hex')) throw new SessionRuntimeError('session_cleanup_uncertain');
    const owned = await this.inspect(spec);
    if (!owned) {
      if (this.unresolvedCreates.has(spec.sessionId)) throw new SessionRuntimeError('session_cleanup_uncertain');
      if (spec.cystInput) await this.cystInputs?.cleanup(spec.sessionId);
      return;
    }
    const removed = await this.command(['rm', '--force', '--volumes', owned.id], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 1024 });
    if (removed.exitCode !== 0 || await this.inspect(spec)) throw new SessionRuntimeError('session_cleanup_uncertain');
    this.unresolvedCreates.delete(spec.sessionId);
    if (spec.cystInput) await this.cystInputs?.cleanup(spec.sessionId);
  }
  private stats(id: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const call = request({ socketPath: this.socket, path: '/v1.41/containers/' + id + '/stats?stream=false', method: 'GET' }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (value: Buffer) => { bytes += value.length;
          if (bytes > 262_144) call.destroy(new Error('session_sample_unavailable')); else chunks.push(value); });
        response.on('error', reject);
        response.on('end', () => { try {
          if (response.statusCode !== 200) throw new Error('session_sample_unavailable');
          const value = z.object({ cpu_stats: z.object({ cpu_usage: z.object({ total_usage: z.number().int().nonnegative().safe() }) }) })
            .passthrough().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          resolve(Math.floor(value.cpu_stats.cpu_usage.total_usage / 1_000_000));
        } catch { reject(new SessionRuntimeError('session_unavailable')); } });
      });
      const timer = setTimeout(() => call.destroy(new Error('session_sample_unavailable')), 3000);
      call.on('error', () => reject(new SessionRuntimeError('session_unavailable'))); call.on('close', () => clearTimeout(timer)); call.end();
    });
  }
  async start(spec: SessionSpec, onFrame: (value: unknown) => void, onFault: (reason?: 'output_limit') => void): Promise<SessionProcess> {
    if (process.platform !== 'linux') throw new SessionRuntimeError('session_unavailable');
    if (this.unresolvedCreates.size) throw new SessionRuntimeError('session_cleanup_uncertain');
    const runtime = await this.command(hostRuntimeInfoArgs(this.isolation), { signal: AbortSignal.timeout(5000), maxOutputBytes: 1024 });
    const binary: unknown = runtime.stdout.trim() ? JSON.parse(runtime.stdout) : null;
    if (runtime.exitCode !== 0 || typeof binary !== 'string' || binary.split('/').at(-1) !== (this.isolation === 'gvisor' ? 'runsc' : 'kata-runtime')) throw new SessionRuntimeError('session_unavailable');
    const name = sessionContainerName(this.hostKey, spec.sessionId);
    if (await this.inspect(spec)) throw new SessionRuntimeError('session_conflict');
    if (this.unresolvedCreates.size) throw new SessionRuntimeError('session_cleanup_uncertain');
    let partial: SessionProcess | undefined;
    try {
      const readyDirectory = spec.cystInput
        ? await this.cystInputs?.readyDirectory(spec.sessionId, createHash('sha256').update(canonical(spec)).digest('hex')) : undefined;
      if (spec.cystInput && !readyDirectory) throw new SessionRuntimeError('invalid_session');
      // CLI cancellation does not prove that the daemon cancelled creation.
      // Until an ID or actual removal is acknowledged, absence stays uncertain.
      this.unresolvedCreates.set(spec.sessionId, createHash('sha256').update(canonical(spec)).digest('hex'));
      const created = await this.command(sessionDockerCreateArgs(name, this.hostKey, spec, this.isolation, readyDirectory), { signal: AbortSignal.timeout(10_000), maxOutputBytes: 1024 });
      if (created.exitCode !== 0 || !/^[a-f0-9]{64}\s*$/.test(created.stdout)) throw new SessionRuntimeError('session_unavailable');
      this.unresolvedCreates.delete(spec.sessionId);
      const id = created.stdout.trim(), child = spawn(this.binary, [...this.prefix, 'start', '--attach', '--interactive', id],
        { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const framed = wire(child, onFrame, onFault); let stopped = false, stopping = false, totalOutput = 0, outputFrames = 0;
      const executions = new Set<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }>();
      const seen = new Set<string>(); let activeCommand: string | undefined;
      const handle: SessionProcess = { closed: framed.closed, send: async raw => {
        if (stopped || stopping) throw new SessionRuntimeError('session_unavailable');
        const execute = z.object({ kind: z.literal('execute'), command: sessionCommandSchema }).strict().safeParse(raw);
        if (execute.success) {
          const command = execute.data.command;
          if (activeCommand || seen.has(command.commandId) || seen.size >= spec.policy.maxCommands) throw new SessionRuntimeError('session_unavailable');
          seen.add(command.commandId); activeCommand = command.commandId;
          // UID10000 init and UID10001 workloads have separate control/output
          // pipes. Only the trusted host frames the raw docker-exec streams.
          const exec = spawn(this.binary, [...this.prefix, 'exec', '--interactive', '--user', '10001:10001', '--workdir', '/tmp',
            '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'LANG=C.UTF-8', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
            '--', id, ...command.argv], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
          let bytes = 0, published = false, spawnFailed = false;
          const closed = new Promise<void>(resolve => exec.once('close', code => {
            activeCommand = undefined;
            if (!published && !stopping) { published = true; onFrame({ kind: 'exit', commandId: command.commandId,
              exitCode: spawnFailed || code === null || code < 0 || code > 255 ? -1 : code, reason: spawnFailed ? 'spawn_failed' : 'exited' }); }
            resolve();
          }));
          const owned = { child: exec, closed }; executions.add(owned); void closed.then(() => executions.delete(owned));
          const output = (stream: 'stdout' | 'stderr', value: Buffer) => {
            if (stopping || published) return;
            for (let offset = 0; offset < value.length; offset += 4096) {
              const part = value.subarray(offset, offset + 4096);
              if (bytes + part.length > spec.policy.maxOutputBytesPerCommand || totalOutput + part.length > spec.policy.maxSessionOutputBytes
                || outputFrames >= spec.policy.maxOutputFrames) { published = true; onFault('output_limit'); return; }
              bytes += part.length; totalOutput += part.length; outputFrames++;
              onFrame({ kind: 'output', commandId: command.commandId, stream, data: part.toString('base64') });
            }
          };
          exec.stdout.on('data', (value: Buffer) => output('stdout', value)); exec.stderr.on('data', (value: Buffer) => output('stderr', value));
          exec.once('error', () => { spawnFailed = true; }); exec.stdin.on('error', () => undefined);
          onFrame({ kind: 'started', commandId: command.commandId }); exec.stdin.end(command.stdin ?? ''); return;
        }
        const cancel = z.object({ kind: z.literal('cancel'), commandId: z.string() }).strict().safeParse(raw);
        if (cancel.success && activeCommand === cancel.data.commandId) { onFault(); return; }
        if (cancel.success) return;
        throw new SessionRuntimeError('session_unavailable');
      }, sample: async () => {
        const current = await this.inspect(spec);
        if (!current || current.id !== id) throw new SessionRuntimeError('session_unavailable');
        return { running: current.running, cpuMs: current.running ? await this.stats(id) : 0 };
      }, stop: async () => {
        if (stopped) return; stopping = true; let removed = false;
        try { await this.cleanup(spec); removed = true; }
        finally {
          child.kill('SIGKILL'); for (const execution of executions) execution.child.kill('SIGKILL');
          const closed = await Promise.all([waitClosed(framed.closed, 3000), ...[...executions].map(execution => waitClosed(execution.closed, 3000))]);
          if (!removed || closed.some(value => !value)) throw new SessionRuntimeError('session_cleanup_uncertain'); stopped = true;
        }
      } };
      partial = handle;
      await framed.send({ kind: 'initialize', spec, operatorOnly: true }); return handle;
    } catch (error) { if (partial) await partial.stop(); else await this.cleanup(spec); throw error; }
  }
}
