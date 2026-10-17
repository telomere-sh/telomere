import { describe, expect, it } from 'vitest';
import { randomId } from '../src/common.js';
import { DockerHostRuntime, HostCellCleanupError } from '../src/host-kit/docker-runtime.js';
import type { HostLease } from '../src/host-kit/protocol.js';
import { DockerSessionBackend, sessionContainerName } from '../src/host-kit/sessions/backends.js';
import { SessionRuntime } from '../src/host-kit/sessions/runtime.js';
import type { SessionRecord, SessionSpec } from '../src/host-kit/sessions/types.js';
import type { CommandResult, DockerCommand } from '../src/runtime/command.js';

const hostKey = '0x' + 'a'.repeat(64), image = 'fixture/create-fence@sha256:' + 'b'.repeat(64);
const id = 'c'.repeat(64), socketPath = '/private/create-fence.sock';
const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const failure = (): CommandResult => ({ exitCode: 1, stdout: '', stderr: 'private simulated daemon error' });
type Outcome = 'lost' | 'nonzero' | 'malformed';
function lease(): HostLease { const now = Date.now(); return { version: 1, hostKey, image, runId: randomId(),
  owner: '0x1111111111111111111111111111111111111111', argv: ['/usr/local/bin/node', '-e', ''],
  issuedAt: now, expiresAt: now + 10_000, maxSeconds: 10, nonce: randomId() }; }
function spec(): SessionSpec { return { version: 1, sessionId: randomId(), image, lifetimeSeconds: 10,
  policy: { version: 1, cpu: 1, memoryBytes: 268_435_456, pids: 64, temporaryBytes: 16_777_216,
    network: 'none', readOnlyRoot: true, maxCommands: 8, maxOutputBytesPerCommand: 16_384,
    maxSessionOutputBytes: 65_536, maxOutputFrames: 1024 } }; }
function fixture(kind: 'oneshot' | 'session', requested: HostLease | SessionSpec, outcome: Outcome = 'lost') {
  const calls: string[][] = [];
  const state = { visible: false, appearsDuringCreate: false, removeFails: false, wrongScope: false, creates: 0, name: '', observedImage: image };
  const resourceId = 'runId' in requested ? requested.runId : requested.sessionId;
  const command: DockerCommand = async args => {
    calls.push([...args]);
    if (args[0] === 'info') return ok(JSON.stringify('/usr/local/bin/runsc'));
    if (args[0] === 'create') {
      state.creates++; state.name = args[args.indexOf('--name') + 1]!; state.visible = state.appearsDuringCreate;
      if (outcome === 'lost') throw new Error('Simulated lost create acknowledgement');
      return outcome === 'nonzero' ? failure() : ok('invalid-container-id');
    }
    if (args[0] === 'ps') return ok(state.visible ? (kind === 'oneshot' ? state.name : id) + '\n' : '');
    if (args[0] === 'inspect') {
      if (!state.visible) return failure();
      const labels = { [kind === 'oneshot' ? 'telomere.hostkit' : 'telomere.session']: 'true',
        'telomere.host_key': state.wrongScope ? '0x' + 'd'.repeat(64) : hostKey,
        [kind === 'oneshot' ? 'telomere.run_id' : 'telomere.session_id']: resourceId };
      return ok(JSON.stringify({ id, image: state.observedImage, labels, ...(kind === 'oneshot' ? { name: '/' + state.name } : { running: true }) }));
    }
    if (args[0] === 'rm') {
      if (!state.visible || state.removeFails) return failure();
      expect(args.at(-1)).toBe(id); state.visible = false; return ok(id + '\n');
    }
    throw new Error('Unexpected simulated Docker command');
  };
  return { state, calls, command };
}

describe('one-shot unresolved daemon create fence with simulated CLI', () => {
  it.each(['lost', 'nonzero', 'malformed'] as const)('does not adopt present absence after %s create acknowledgement', async outcome => {
    const requested = lease(), value = fixture('oneshot', requested, outcome);
    const runtime = new DockerHostRuntime({ isolation: 'gvisor', socketPath, command: value.command });
    await expect(runtime.start(requested, () => undefined)).rejects.toBeInstanceOf(HostCellCleanupError);
    await expect(runtime.cleanupOrphans(hostKey)).rejects.toBeInstanceOf(HostCellCleanupError);
    await expect(runtime.start(lease(), () => undefined)).rejects.toBeInstanceOf(HostCellCleanupError);
    expect(value.state.creates).toBe(1); expect(value.calls.some(args => args[0] === 'rm')).toBe(false);
  });

  it('clears uncertainty only after observing and removing a later exact original resource', async () => {
    const requested = lease(), value = fixture('oneshot', requested);
    const runtime = new DockerHostRuntime({ isolation: 'gvisor', socketPath, command: value.command });
    await expect(runtime.start(requested, () => undefined)).rejects.toBeInstanceOf(HostCellCleanupError);
    value.state.visible = true;
    expect(await runtime.cleanupOrphans(hostKey)).toEqual([value.state.name]); expect(value.state.visible).toBe(false);
    value.state.appearsDuringCreate = true;
    await expect(runtime.start(requested, () => undefined)).rejects.toThrow('Simulated lost create acknowledgement');
    expect(value.state.creates).toBe(2); expect(await runtime.cleanupOrphans(hostKey)).toEqual([]);
  });

  it('never removes a late name whose full original host binding changed', async () => {
    const requested = lease(), value = fixture('oneshot', requested);
    const runtime = new DockerHostRuntime({ isolation: 'gvisor', socketPath, command: value.command });
    await expect(runtime.start(requested, () => undefined)).rejects.toBeInstanceOf(HostCellCleanupError);
    value.state.visible = true; value.state.wrongScope = true;
    await expect(runtime.cleanupOrphans(hostKey)).rejects.toBeInstanceOf(HostCellCleanupError);
    expect(value.calls.some(args => args[0] === 'rm')).toBe(false); expect(value.state.visible).toBe(true);
    value.state.wrongScope = false; await runtime.cleanupOrphans(hostKey); expect(value.state.visible).toBe(false);
  });

  it('retains the fence when removal of the observed exact resource fails', async () => {
    const requested = lease(), value = fixture('oneshot', requested); value.state.appearsDuringCreate = true; value.state.removeFails = true;
    const runtime = new DockerHostRuntime({ isolation: 'gvisor', socketPath, command: value.command });
    await expect(runtime.start(requested, () => undefined)).rejects.toBeInstanceOf(HostCellCleanupError);
    await expect(runtime.cleanupOrphans(hostKey)).rejects.toBeInstanceOf(HostCellCleanupError);
    expect(value.state.visible).toBe(true); value.state.removeFails = false;
    await runtime.cleanupOrphans(hostKey); expect(value.state.visible).toBe(false);
  });
});

describe.skipIf(process.platform !== 'linux')('session unresolved daemon create fence with simulated CLI', () => {
  it.each(['lost', 'nonzero', 'malformed'] as const)('holds the session namespace after %s create acknowledgement', async outcome => {
    const requested = spec(), value = fixture('session', requested, outcome);
    const backend = new DockerSessionBackend({ isolation: 'gvisor', hostKey, socketPath, command: value.command });
    await expect(backend.start(requested, () => undefined, () => undefined)).rejects.toMatchObject({ code: 'session_cleanup_uncertain' });
    await expect(backend.cleanup(requested)).rejects.toMatchObject({ code: 'session_cleanup_uncertain' });
    await expect(backend.start(spec(), () => undefined, () => undefined)).rejects.toMatchObject({ code: 'session_cleanup_uncertain' });
    expect(value.state.creates).toBe(1); expect(value.calls.some(args => args[0] === 'rm')).toBe(false);
  });

  it('preserves uncertain terminal state in the actual session runtime instead of claiming absent cleanup', async () => {
    const requested = spec(), value = fixture('session', requested);
    const backend = new DockerSessionBackend({ isolation: 'gvisor', hostKey, socketPath, command: value.command });
    let saved: SessionRecord | undefined;
    await expect(SessionRuntime.open({ spec: requested, backend, reviewedImages: new Set([image]), journal: {
      load: async () => saved, save: async record => { saved = structuredClone(record); },
    } })).rejects.toMatchObject({ code: 'session_unavailable' });
    expect(saved).toMatchObject({ state: 'fault', cleanupConfirmed: false });
    value.state.visible = true; expect(value.state.name).toBe(sessionContainerName(hostKey, requested.sessionId));
    await backend.cleanup(requested); expect(value.state.visible).toBe(false);
  });

  it('rejects a late resource with changed full host binding before removal and retains uncertainty', async () => {
    const requested = spec(), value = fixture('session', requested);
    const backend = new DockerSessionBackend({ isolation: 'gvisor', hostKey, socketPath, command: value.command });
    await expect(backend.start(requested, () => undefined, () => undefined)).rejects.toMatchObject({ code: 'session_cleanup_uncertain' });
    value.state.visible = true; value.state.wrongScope = true;
    await expect(backend.cleanup(requested)).rejects.toMatchObject({ code: 'session_cleanup_uncertain' });
    expect(value.calls.some(args => args[0] === 'rm')).toBe(false); value.state.wrongScope = false;
    await backend.cleanup(requested); expect(value.state.visible).toBe(false);
  });

  it('can reconcile a resource already created before its acknowledgement was lost', async () => {
    const requested = spec(), value = fixture('session', requested); value.state.appearsDuringCreate = true;
    const backend = new DockerSessionBackend({ isolation: 'gvisor', hostKey, socketPath, command: value.command });
    await expect(backend.start(requested, () => undefined, () => undefined)).rejects.toThrow('Simulated lost create acknowledgement');
    expect(value.state.visible).toBe(false); await backend.cleanup(requested);
    await expect(backend.start(requested, () => undefined, () => undefined)).rejects.toThrow('Simulated lost create acknowledgement');
    expect(value.state.creates).toBe(2);
  });

  it('cannot replace the original unresolved spec with a matching changed-image cleanup input', async () => {
    const requested = spec(), value = fixture('session', requested);
    const backend = new DockerSessionBackend({ isolation: 'gvisor', hostKey, socketPath, command: value.command });
    await expect(backend.start(requested, () => undefined, () => undefined)).rejects.toMatchObject({ code: 'session_cleanup_uncertain' });
    value.state.visible = true; value.state.observedImage = 'fixture/other@sha256:' + 'e'.repeat(64);
    await expect(backend.cleanup({ ...requested, image: value.state.observedImage })).rejects.toMatchObject({ code: 'session_cleanup_uncertain' });
    expect(value.calls.some(args => args[0] === 'rm')).toBe(false); expect(value.state.visible).toBe(true);
    value.state.observedImage = image; await backend.cleanup(requested); expect(value.state.visible).toBe(false);
  });
});
