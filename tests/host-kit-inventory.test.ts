import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectHostInventory } from '../src/host-kit/docker-inventory.js';
import type { CommandOptions, CommandResult, DockerCommand } from '../src/runtime/command.js';

const hostKey = '0x' + 'a'.repeat(64), runId = '0x' + 'b'.repeat(64), sessionId = '0x' + 'c'.repeat(64);
const runContainer = '1'.repeat(64), sessionContainer = '2'.repeat(64);
const image = 'registry.example/cpu@sha256:' + 'd'.repeat(64), socketPath = '/private/engine.sock';
const runName = 'tlmr-hostkit-' + hostKey.slice(2, 10) + '-' + runId.slice(2, 18) + '-01234567';
const sessionName = 'tlmr-session-' + hostKey.slice(2, 10) + '-' + sessionId.slice(2);
const success = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
function run() { return { id: runContainer, name: '/' + runName, image,
  labels: { 'telomere.hostkit': 'true', 'telomere.host_key': hostKey, 'telomere.run_id': runId } as Record<string, string> }; }
function session() { return { id: sessionContainer, name: '/' + sessionName, image,
  labels: { 'telomere.session': 'true', 'telomere.host_key': hostKey, 'telomere.session_id': sessionId } as Record<string, string> }; }
function fixture(options: { oneshot?: string; sessions?: string; records?: Record<string, unknown> } = {}) {
  const calls: Array<{ args: string[]; options: CommandOptions }> = [];
  const records = options.records ?? { [runContainer]: run(), [sessionContainer]: session() };
  const command: DockerCommand = async (args, input) => {
    calls.push({ args: [...args], options: input });
    if (args[0] === 'ps') return success(args.includes('label=telomere.hostkit')
      ? options.oneshot ?? runContainer + '\n' : options.sessions ?? sessionContainer + '\n');
    if (args[0] === 'inspect') return success(JSON.stringify(records[args.at(-1)!]));
    throw new Error('Unexpected command');
  };
  return { calls, command, inspect: () => inspectHostInventory({ hostKey, socketPath, command }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('bounded read-only full-scope HostKit Docker inventory', () => {
  it('inspects both full-key namespaces without mutations and retains complete resource IDs', async () => {
    const value = fixture(); expect(await value.inspect()).toEqual([
      { kind: 'oneshot', resourceId: runId, image, name: runName },
      { kind: 'session', resourceId: sessionId, image, name: sessionName },
    ]);
    expect(value.calls).toHaveLength(4);
    for (const call of value.calls.slice(0, 2)) {
      expect(call.args).toContain('--all'); expect(call.args).toContain('--no-trunc');
      expect(call.args).toContain('label=telomere.host_key=' + hostKey); expect(call.options.maxOutputBytes).toBe(65_536);
    }
    expect(value.calls.slice(0, 2).map(call => call.args.filter(arg => arg.startsWith('label=telomere.')))).toEqual([
      ['label=telomere.hostkit', 'label=telomere.host_key=' + hostKey],
      ['label=telomere.session', 'label=telomere.host_key=' + hostKey],
    ]);
    expect(value.calls.slice(2).map(call => call.args.at(-1))).toEqual([runContainer, sessionContainer]);
    expect(value.calls.every(call => ['ps', 'inspect'].includes(call.args[0]!))).toBe(true);
    expect(value.calls.every(call => call.options.signal === value.calls[0]!.options.signal)).toBe(true);
    expect(value.calls.slice(2).every(call => call.options.maxOutputBytes === 8192)).toBe(true);
  });

  it('accepts an empty namespace only after querying both kinds', async () => {
    const value = fixture({ oneshot: '', sessions: '' }); expect(await value.inspect()).toEqual([]); expect(value.calls).toHaveLength(2);
  });

  it('accepts the exact combined resource bound with bounded per-container inspections', async () => {
    const records: Record<string, unknown> = {}, ids: string[] = [];
    for (let index = 0; index < 1000; index++) {
      const id = index.toString(16).padStart(64, '0'), logicalId = '0x' + id;
      ids.push(id); records[id] = { id, name: '/tlmr-hostkit-' + hostKey.slice(2, 10) + '-' + logicalId.slice(2, 18)
        + '-' + index.toString(16).padStart(8, '0'), image,
        labels: { 'telomere.hostkit': 'true', 'telomere.host_key': hostKey, 'telomere.run_id': logicalId } };
    }
    const value = fixture({ oneshot: ids.join('\n') + '\n', sessions: '', records });
    expect(await value.inspect()).toHaveLength(1000); expect(value.calls).toHaveLength(1002);
  });

  it('rejects a duplicate actual container across kinds before inspection', async () => {
    const value = fixture({ sessions: runContainer + '\n' }); await expect(value.inspect()).rejects.toThrow('Host inventory is unavailable');
    expect(value.calls).toHaveLength(2);
  });

  it.each(['short id', 'blank row', 'duplicate id', 'leading whitespace', 'uppercase id', 'too many resources'])(
    'refuses malformed or unbounded %s lists', async mode => {
      const oneshot = mode === 'short id' ? '1234\n' : mode === 'blank row' ? '\n' : mode === 'duplicate id' ? runContainer + '\n' + runContainer + '\n'
        : mode === 'leading whitespace' ? ' ' + runContainer + '\n' : mode === 'uppercase id' ? 'A'.repeat(64) + '\n'
          : Array.from({ length: 1001 }, (_, index) => index.toString(16).padStart(64, '0')).join('\n') + '\n';
      const value = fixture({ oneshot, sessions: '' }); await expect(value.inspect()).rejects.toThrow('Host inventory is unavailable');
      expect(value.calls.every(call => call.args[0] === 'ps')).toBe(true);
    });

  it.each(['dual marker', 'false opposite marker', 'cross-kind ID', 'foreign full key with same prefix', 'wrong requested ID',
    'missing full run ID', 'uppercase resource ID', 'wrong host name', 'wrong run name', 'missing name slash', 'mutable image', 'unknown fields'])(
    'refuses ambiguous one-shot descriptor: %s', async mode => {
      const record: Record<string, unknown> = run(), labels = record.labels as Record<string, string>;
      if (mode === 'dual marker') labels['telomere.session'] = 'true';
      if (mode === 'false opposite marker') labels['telomere.session'] = 'false';
      if (mode === 'cross-kind ID') labels['telomere.session_id'] = sessionId;
      if (mode === 'foreign full key with same prefix') labels['telomere.host_key'] = hostKey.slice(0, 10) + 'e'.repeat(56);
      if (mode === 'wrong requested ID') record.id = sessionContainer;
      if (mode === 'missing full run ID') delete labels['telomere.run_id'];
      if (mode === 'uppercase resource ID') labels['telomere.run_id'] = '0x' + 'B'.repeat(64);
      if (mode === 'wrong host name') record.name = '/tlmr-hostkit-eeeeeeee-' + runId.slice(2, 18) + '-01234567';
      if (mode === 'wrong run name') record.name = '/tlmr-hostkit-' + hostKey.slice(2, 10) + '-eeeeeeeeeeeeeeee-01234567';
      if (mode === 'missing name slash') record.name = runName;
      if (mode === 'mutable image') record.image = 'registry.example/cpu:latest';
      if (mode === 'unknown fields') record.unreviewed = true;
      await expect(fixture({ sessions: '', records: { [runContainer]: record } }).inspect()).rejects.toThrow('Host inventory is unavailable');
    });

  it.each(['truncated name', 'wrong full session ID', 'one-shot marker', 'one-shot resource label', 'missing marker', 'false marker'])(
    'refuses ambiguous session descriptor: %s', async mode => {
      const record = session();
      if (mode === 'truncated name') record.name = '/' + sessionName.slice(0, -1);
      if (mode === 'wrong full session ID') record.labels['telomere.session_id'] = sessionId.slice(0, -1) + 'e';
      if (mode === 'one-shot marker') record.labels['telomere.hostkit'] = 'true';
      if (mode === 'one-shot resource label') record.labels['telomere.run_id'] = runId;
      if (mode === 'missing marker') delete record.labels['telomere.session'];
      if (mode === 'false marker') record.labels['telomere.session'] = 'false';
      await expect(fixture({ oneshot: '', records: { [sessionContainer]: record } }).inspect()).rejects.toThrow('Host inventory is unavailable');
    });

  it('does not collapse a full one-shot ID into its truncated name prefix', async () => {
    const record = run(), fullId = runId.slice(0, 18) + 'e'.repeat(48); record.labels['telomere.run_id'] = fullId;
    expect(await fixture({ sessions: '', records: { [runContainer]: record } }).inspect()).toEqual([
      { kind: 'oneshot', resourceId: fullId, image, name: runName },
    ]); // Coordinator must compare this entire ID with its original signed lease.
  });

  it('refuses two containers claiming the same logical one-shot resource', async () => {
    const second = run(); second.id = sessionContainer; second.name = '/' + runName.slice(0, -8) + '89abcdef';
    await expect(fixture({ oneshot: runContainer + '\n' + sessionContainer + '\n', sessions: '',
      records: { [runContainer]: run(), [sessionContainer]: second } }).inspect()).rejects.toThrow('Host inventory is unavailable');
  });

  it.each(['list exit', 'inspect exit', 'list overflow', 'inspect overflow', 'invalid JSON', 'replacement text', 'surrogate', 'private command error'])(
    'redacts and refuses %s failures', async mode => {
      const value = fixture();
      const command: DockerCommand = async (args, input) => {
        if (mode === 'private command error') throw new Error('private socket and workload diagnostic');
        if (args[0] === 'ps' && mode === 'list exit' || args[0] === 'inspect' && mode === 'inspect exit') return { exitCode: 1, stdout: '', stderr: 'private diagnostic' };
        if (args[0] === 'ps' && mode === 'list overflow') return success(' '.repeat(65_537));
        if (args[0] === 'inspect') {
          if (mode === 'inspect overflow') return success(' '.repeat(8193));
          if (mode === 'invalid JSON') return success('{');
          if (mode === 'replacement text') return success(JSON.stringify({ ...run(), irrelevant: '\ufffd' }));
          if (mode === 'surrogate') return success('\ud800');
        }
        return value.command(args, input);
      };
      await expect(inspectHostInventory({ hostKey, socketPath, command })).rejects.toThrow(/^Host inventory is unavailable$/);
    });

  it.each(['host key', 'socket traversal', 'remote socket', 'empty binary', 'binary NUL'])(
    'rejects invalid operator scope before invoking a command: %s', async mode => {
      const command = vi.fn<DockerCommand>();
      const options = { hostKey: mode === 'host key' ? '0x1234' : hostKey,
        socketPath: mode === 'socket traversal' ? '/private/../engine.sock' : mode === 'remote socket' ? 'tcp://engine:2375' : socketPath,
        dockerBinary: mode === 'empty binary' ? '' : mode === 'binary NUL' ? 'docker\0private' : 'docker', command };
      await expect(inspectHostInventory(options)).rejects.toThrow(/^Host inventory is unavailable$/); expect(command).not.toHaveBeenCalled();
    });

  it.each(['first list', 'inspection'])('enforces one total deadline during a hanging %s', async stage => {
    vi.useFakeTimers(); const calls: CommandOptions[] = [], value = fixture();
    const command: DockerCommand = async (args, input) => {
      calls.push(input);
      if (stage === 'first list' || args[0] === 'inspect') return new Promise<CommandResult>(() => undefined);
      return value.command(args, input);
    };
    const operation = inspectHostInventory({ hostKey, socketPath, command });
    const failed = expect(operation).rejects.toThrow(/^Host inventory is unavailable$/);
    await vi.advanceTimersByTimeAsync(30_000); await failed;
    expect(calls.length).toBe(stage === 'first list' ? 1 : 3); expect(calls.every(input => input.signal?.aborted)).toBe(true);
  });

  it('retains the original deadline after earlier inventory calls consume time', async () => {
    vi.useFakeTimers(); const value = fixture({ sessions: '' }), calls: CommandOptions[] = [];
    const command: DockerCommand = async (args, input) => {
      calls.push(input);
      if (args[0] === 'inspect') return new Promise<CommandResult>(() => undefined);
      if (calls.length === 1) await new Promise<void>(done => setTimeout(done, 20_000));
      return value.command(args, input);
    };
    const operation = inspectHostInventory({ hostKey, socketPath, command });
    const failed = expect(operation).rejects.toThrow(/^Host inventory is unavailable$/);
    await vi.advanceTimersByTimeAsync(20_000); expect(calls).toHaveLength(3); expect(calls[0]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000); await failed; expect(calls.every(input => input.signal?.aborted)).toBe(true);
  });
});
