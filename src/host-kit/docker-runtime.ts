import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { z } from 'zod';
import { executeCommand, type DockerCommand } from '../runtime/command.js';
import { HOST_INIT_PROGRAM, type HostCell, type HostCellRuntime, type InitHeartbeat } from './runtime.js';
import type { HostLease } from './protocol.js';
import { HostTextOutput, hostInitFrameSchema } from './text-output.js';

type Isolation = 'gvisor' | 'kata' | 'docker_development';
export function hostRuntimeInfoArgs(isolation: Isolation): string[] {
  const template = isolation === 'gvisor' ? '{{with index .Runtimes "runsc"}}{{json .Path}}{{end}}'
    : isolation === 'kata' ? '{{with index .Runtimes "kata-runtime"}}{{json .Path}}{{end}}' : '{{json .ServerVersion}}';
  return ['info', '--format', template];
}
const namePattern = /^tlmr-hostkit-[a-f0-9]{8}-[a-f0-9]{16}-[a-f0-9]{8}$/;
export class HostCellCleanupError extends Error {
  constructor() { super('Cell failed and cleanup could not be confirmed'); this.name = 'HostCellCleanupError'; }
}
export function hostDockerCreateArgs(name: string, lease: HostLease, isolation: Isolation): string[] {
  if (!namePattern.test(name)) throw new Error('Invalid owned cell name');
  return ['create', '--name', name, '--label', 'telomere.hostkit=true', '--label', `telomere.host_key=${lease.hostKey}`,
    '--label', `telomere.run_id=${lease.runId}`, '--interactive',
    ...(isolation === 'docker_development' ? [] : ['--runtime', isolation === 'gvisor' ? 'runsc' : 'kata-runtime']),
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--user', '10001:10001', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--entrypoint', '/usr/local/bin/node', lease.image, '-e', HOST_INIT_PROGRAM];
}
export class DockerHostRuntime implements HostCellRuntime {
  readonly isolation: Isolation;
  private readonly command: DockerCommand;
  private readonly unresolvedCreates = new Map<string, { hostKey: string; runId: string; image: string }>();
  constructor(options: { isolation: Isolation; dockerBinary?: string; command?: DockerCommand; socketPath?: string }) {
    this.isolation = options.isolation;
    this.binary = options.dockerBinary ?? 'docker'; this.socket = options.socketPath ?? '/var/run/docker.sock';
    if (!/^\/[a-zA-Z0-9_./\-]{1,200}\.sock$/.test(this.socket) || this.socket.includes('..')) throw new Error('Docker socket path rejected');
    this.prefix = ['--host', `unix://${this.socket}`];
    this.command = options.command ?? ((args, input) => executeCommand(this.binary, [...this.prefix, ...args], input));
  }
  private readonly binary: string; private readonly socket: string;
  private readonly prefix: string[];
  async initialize(_hostKey: string): Promise<void> {
    if (process.platform !== 'linux') throw new Error('Container Host Kit requires Linux');
    const info = await this.command(hostRuntimeInfoArgs(this.isolation), { signal: AbortSignal.timeout(10_000), maxOutputBytes: 1024 });
    if (info.exitCode !== 0) throw new Error('Docker runtime inventory unavailable');
    const configuredPath: unknown = info.stdout.trim() ? JSON.parse(info.stdout) : null;
    const required = this.isolation === 'gvisor' ? 'runsc' : this.isolation === 'kata' ? 'kata-runtime' : null;
    if (required && (typeof configuredPath !== 'string' || configuredPath.split('/').at(-1) !== required)) throw new Error('Required isolated runtime is unavailable or has an unexpected path; no Docker fallback is allowed');
  }
  private async remove(name: string): Promise<void> {
    if (!namePattern.test(name)) throw new Error('Cell cleanup scope rejected');
    let target = name;
    const unresolved = this.unresolvedCreates.get(name);
    if (unresolved) {
      const inspection = await this.command(['inspect', '--format', '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}}}', name],
        { signal: AbortSignal.timeout(5000), maxOutputBytes: 8192 });
      if (inspection.exitCode !== 0) throw new HostCellCleanupError();
      const owned = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), image: z.string(), labels: z.record(z.string()) }).strict().parse(JSON.parse(inspection.stdout));
      if (owned.name !== '/' + name || owned.image !== unresolved.image || owned.labels['telomere.hostkit'] !== 'true'
        || owned.labels['telomere.host_key'] !== unresolved.hostKey || owned.labels['telomere.run_id'] !== unresolved.runId
        || 'telomere.session' in owned.labels || 'telomere.session_id' in owned.labels) throw new HostCellCleanupError();
      target = owned.id;
    }
    const result = await this.command(['rm', '--force', '--volumes', target], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 16_384 });
    if (result.exitCode === 0) { this.unresolvedCreates.delete(name); return; }
    // A lost create acknowledgement may leave a daemon request in flight.
    // Absence now cannot establish that this request will never create later.
    if (this.unresolvedCreates.has(name)) throw new HostCellCleanupError();
    if (!await this.absenceConfirmed(name)) throw new Error('Owned cell cleanup could not be confirmed');
  }
  private absenceConfirmed(name: string): Promise<boolean> {
    // A deadline sweep may remove the resource before start() returns its
    // handle. CLI failure alone is not proof that the exact resource is gone.
    return new Promise(resolve => {
      const call = request({ socketPath: this.socket, path: `/v1.41/containers/${name}/json`, method: 'GET',
        signal: AbortSignal.timeout(2500), maxHeaderSize: 8192 }, response => {
        let bytes = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024) { resolve(false); call.destroy(); } else chunks.push(chunk);
        });
        response.on('error', () => resolve(false));
        response.on('aborted', () => resolve(false));
        response.on('end', () => {
          try {
            const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            resolve(response.statusCode === 404 && !!value && typeof value === 'object' && !Array.isArray(value)
              && Object.keys(value).length === 1 && 'message' in value && value.message === `No such container: ${name}`);
          } catch { resolve(false); }
        });
      });
      call.on('error', () => resolve(false)); call.end();
    });
  }
  async cleanupOrphans(hostKey: string): Promise<string[]> {
    const result = await this.command(['ps', '--all', '--filter', 'label=telomere.hostkit=true',
      '--filter', `label=telomere.host_key=${hostKey}`, '--format', '{{.Names}}'], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 65_536 });
    const names = result.stdout.split(/\r?\n/).filter(Boolean);
    if (result.exitCode !== 0 || names.length > 1000 || names.some(name => !namePattern.test(name) || !name.startsWith(`tlmr-hostkit-${hostKey.slice(2, 10)}-`))) throw new Error('Owned cell inventory rejected');
    for (const name of names) await this.remove(name);
    if ([...this.unresolvedCreates.values()].some(value => value.hostKey === hostKey)) throw new HostCellCleanupError();
    return names;
  }
  private stats(id: string): Promise<number> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Container identity rejected');
    return new Promise((resolve, reject) => {
      const call = request({ socketPath: this.socket, path: `/v1.41/containers/${id}/stats?stream=false`, method: 'GET', timeout: 2500 }, response => {
        let size = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 262_144) { call.destroy(); reject(new Error('Stats response exceeds limit')); } else chunks.push(chunk); });
        response.on('end', () => { try {
          if (response.statusCode !== 200) throw new Error('CPU counter unavailable');
          const parsed = z.object({ cpu_stats: z.object({ cpu_usage: z.object({ total_usage: z.number().int().nonnegative().safe() }) }) }).passthrough().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          resolve(Math.floor(parsed.cpu_stats.cpu_usage.total_usage / 1_000_000));
        } catch (error) { reject(error); } });
      });
      call.on('timeout', () => call.destroy(new Error('CPU counter timed out'))); call.on('error', reject); call.end();
    });
  }
  async start(lease: HostLease, heartbeat: (value: InitHeartbeat) => void): Promise<HostCell> {
    if (this.unresolvedCreates.size) throw new HostCellCleanupError();
    const name = `tlmr-hostkit-${lease.hostKey.slice(2, 10)}-${lease.runId.slice(2, 18)}-${randomBytes(4).toString('hex')}`;
    try {
      this.unresolvedCreates.set(name, { hostKey: lease.hostKey, runId: lease.runId, image: lease.image });
      const result = await this.command(hostDockerCreateArgs(name, lease, this.isolation), { signal: AbortSignal.timeout(10_000), maxOutputBytes: 16_384 });
      if (result.exitCode !== 0 || !/^[a-f0-9]{64}\s*$/.test(result.stdout)) throw new Error('Cell creation failed');
      this.unresolvedCreates.delete(name);
      const id = result.stdout.trim(), child = spawn(this.binary, [...this.prefix, 'start', '--attach', '--interactive', name],
        { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', total = 0, stopped = false, reportedExit = -1, protocolFailed = false;
      const output = new HostTextOutput();
      const wait = new Promise<{ output: string; exitCode: number }>(resolve => {
        const fail = () => { protocolFailed = true; reportedExit = -1; child.kill('SIGKILL'); };
        child.stdout.on('data', (bytes: Buffer) => {
          if (protocolFailed) return;
          total += bytes.length; if (total > 131_072) { fail(); return; } buffer += bytes.toString('utf8');
          for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
              const frame = hostInitFrameSchema.parse(JSON.parse(line));
              if (frame.kind === 'heartbeat') {
                if (frame.runId !== lease.runId) throw new Error('Cell heartbeat scope rejected');
                heartbeat({ sequence: frame.sequence, elapsedMs: frame.elapsedMs });
              } else if (frame.kind === 'output') output.append(frame.stream, frame.data);
              else if (frame.kind === 'exit') reportedExit = frame.code;
              else if (frame.kind === 'started') { /* PID is inside the cell; never act on it from the host. */ }
            } catch { fail(); return; }
          }
        });
        child.stderr.on('data', (bytes: Buffer) => { total += bytes.length; if (total > 131_072) fail(); });
        child.once('error', () => resolve(output.finish(-1)));
        child.once('close', code => resolve(output.finish(protocolFailed || buffer.length ? -1 : code === 0 ? reportedExit : code ?? -1)));
        child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify({ runId: lease.runId, argv: lease.argv, stdin: lease.stdin ?? '' }));
      });
      return { wait, sample: async () => {
        const state = await this.command(['inspect', '--format', '{{json .State.Running}}', name], { signal: AbortSignal.timeout(2500), maxOutputBytes: 1024 });
        if (state.exitCode !== 0 || !['true', 'false'].includes(state.stdout.trim())) throw new Error('Cell running state unavailable');
        const running = state.stdout.trim() === 'true'; return { running, cpuMs: running ? await this.stats(id) : 0 };
      }, stop: async () => { if (stopped) return; await this.remove(name); stopped = true; child.kill('SIGKILL'); await wait; } };
    } catch (error) {
      // A lost create acknowledgement can leave a container; cleanup is attempted even before its ID is known.
      try { await this.remove(name); } catch { throw new HostCellCleanupError(); }
      throw error;
    }
  }
}
