import { spawn } from 'node:child_process';
import type { HostLease } from './protocol.js';
import { HOST_INIT_PROGRAM, type HostCell, type HostCellRuntime, type InitHeartbeat } from './runtime.js';
import { HostTextOutput, hostInitFrameSchema } from './text-output.js';

/** Explicit local test fixture. It provides no container or tenant security boundary. */
export class LocalProcessFixtureRuntime implements HostCellRuntime {
  readonly isolation = 'local_process_fixture' as const;
  private cells = new Map<string, HostCell>();
  constructor(allowUnsafeFixture: 'test-fixture-only') { if (allowUnsafeFixture !== 'test-fixture-only') throw new Error('Explicit fixture acknowledgement required'); }
  async initialize(_hostKey: string): Promise<void> {}
  async cleanupOrphans(_hostKey: string): Promise<string[]> {
    const names = [...this.cells.keys()]; for (const cell of this.cells.values()) await cell.stop(); this.cells.clear(); return names;
  }
  async start(lease: HostLease, heartbeat: (value: InitHeartbeat) => void): Promise<HostCell> {
    const child = spawn(process.execPath, ['-e', HOST_INIT_PROGRAM], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', total = 0, alive = true, exited = -1, childPid: number | undefined, protocolFailed = false;
    const output = new HostTextOutput();
    const wait = new Promise<{ output: string; exitCode: number }>(resolve => {
      const fail = () => {
        protocolFailed = true;
        if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
        child.kill('SIGKILL');
      };
      child.stdout.on('data', (bytes: Buffer) => {
        if (protocolFailed) return;
        total += bytes.length; if (total > 131_072) { fail(); return; }
        buffer += bytes.toString('utf8');
        for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const frame = hostInitFrameSchema.parse(JSON.parse(line));
            if (frame.kind === 'heartbeat') {
              if (frame.runId !== lease.runId) throw new Error('Cell heartbeat scope rejected');
              heartbeat({ sequence: frame.sequence, elapsedMs: frame.elapsedMs });
            } else if (frame.kind === 'output') output.append(frame.stream, frame.data);
            else if (frame.kind === 'exit') { exited = frame.code; childPid = undefined; }
            else if (frame.kind === 'started') childPid = frame.pid;
          } catch { fail(); return; }
        }
      });
      child.stderr.on('data', (bytes: Buffer) => { total += bytes.length; if (total > 131_072) fail(); });
      child.once('error', () => resolve(output.finish(-1)));
      child.once('close', code => { alive = false; resolve(output.finish(protocolFailed || buffer.length ? -1 : code === 0 ? exited : code ?? -1)); });
      child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify({ runId: lease.runId, argv: lease.argv, stdin: lease.stdin ?? '' }));
    });
    const cell: HostCell = { wait, sample: async () => ({ running: alive, cpuMs: 0 }), stop: async () => {
      if (alive) { if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} } child.kill('SIGKILL'); } await wait;
      this.cells.delete(lease.runId);
    } };
    this.cells.set(lease.runId, cell); return cell;
  }
}
