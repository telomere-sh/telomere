import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionJournal, LocalSessionFixtureBackend, SessionRuntime, sessionContainerName, sessionDockerCreateArgs,
  type SessionBackend, type SessionEvent, type SessionJournal, type SessionSpec } from '../src/host-kit/sessions/index.js';

const image = 'fixture/telomere@sha256:' + 'a'.repeat(64);
const spec = (values: Partial<SessionSpec> = {}): SessionSpec => ({ version: 1, sessionId: '0x' + 'b'.repeat(64), image,
  lifetimeSeconds: 10, policy: { version: 1, cpu: 1, memoryBytes: 268_435_456, pids: 64, temporaryBytes: 16_777_216,
    network: 'none', readOnlyRoot: true, maxCommands: 8, maxOutputBytesPerCommand: 16_384,
    maxSessionOutputBytes: 65_536, maxOutputFrames: 1024 }, ...values });
const command = (commandId: string, program: string, stdin?: string) => ({ commandId, argv: [process.execPath, '-e', program],
  ...(stdin === undefined ? {} : { stdin }) });
const wait = async (predicate: () => boolean, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Owned session condition timed out'); await new Promise(done => setTimeout(done, 20)); }
};

describe('real bounded persistent CPU session runtime', () => {
  let directory: string, journalDirectory: string, backend: LocalSessionFixtureBackend;
  const journals: FileSessionJournal[] = [], runtimes: SessionRuntime[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-session-runtime-')); journalDirectory = join(directory, 'journal');
    const temporary = join(directory, 'cells'); await mkdir(temporary, { mode: 0o700 }); backend = new LocalSessionFixtureBackend(temporary, 'test-fixture-only');
  });
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined);
    for (const journal of journals.splice(0)) await journal.close().catch(() => undefined);
    const owned = resolve(directory);
    if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('telomere-session-runtime-')) throw new Error('Unexpected owned session fixture directory');
    await rm(owned, { recursive: true, force: true });
  });
  async function start(value = spec(), custom?: SessionJournal, transport: SessionBackend = backend) {
    const journal = custom ?? await FileSessionJournal.open(journalDirectory, value.sessionId);
    if (journal instanceof FileSessionJournal) journals.push(journal);
    const runtime = await SessionRuntime.open({ spec: value, backend: transport, journal, reviewedImages: new Set([image]) });
    runtimes.push(runtime); return { runtime, journal };
  }

  it('keeps one actual init PID and writable temporary directory across separate commands', async () => {
    const { runtime } = await start(), pid = runtime.status().initPid;
    expect(pid).toBeGreaterThan(0); expect(runtime.status().isolation).toBe('local_process_fixture');
    const first = await runtime.execute(command('write', "require('node:fs').writeFileSync('state.txt','shared 🧬');process.stdout.write(String(process.ppid));"));
    const second = await runtime.execute(command('read', "process.stdout.write(require('node:fs').readFileSync('state.txt','utf8'));"));
    expect(first).toMatchObject({ state: 'completed', stdout: String(pid) }); expect(second.stdout).toBe('shared 🧬');
    expect(runtime.status().initPid).toBe(pid); expect(runtime.status().heartbeat).not.toBeNull();
    expect(await runtime.sample()).toEqual({ running: true, cpuMs: 0 });
    await runtime.stop(); expect(runtime.status()).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('streams durable stdout and stderr before completion and decodes split UTF-8 with BOM normalization', async () => {
    const { runtime, journal } = await start(); let completed = false;
    const result = runtime.execute(command('stream', "process.stdout.write(Buffer.from([239,187,191,240,159]));process.stderr.write('stderr 🧬');setTimeout(()=>process.stdout.write(Buffer.from([167,172])),100);setTimeout(()=>process.stdout.write(' tail'),500);")).then(value => { completed = true; return value; });
    const events: SessionEvent[] = [], controller = new AbortController();
    const consume = (async () => { for await (const event of runtime.events(-1, controller.signal)) {
      events.push(event); if (event.kind === 'output' && event.text?.includes('🧬') && event.stream === 'stdout') break;
    } })();
    await consume; expect(completed).toBe(false);
    expect((await journal.load())?.events).toEqual(expect.arrayContaining(events));
    expect(await result).toMatchObject({ state: 'completed', stdout: '🧬 tail', stderr: 'stderr 🧬' }); controller.abort();
    expect(runtime.readEvents(-1).some(value => value.kind === 'command_exit')).toBe(true);
  });

  it('serializes concurrent commands and exact command-ID retries without a second subprocess', async () => {
    const { runtime } = await start();
    const input = command('once', "require('node:fs').appendFileSync('count.txt','x');setTimeout(()=>process.stdout.write('done'),200);");
    const first = runtime.execute(input), duplicate = runtime.execute(structuredClone(input));
    const following = runtime.execute(command('following', "process.stdout.write(require('node:fs').readFileSync('count.txt','utf8'));"));
    await expect(runtime.execute({ ...input, argv: [process.execPath, '-e', 'process.exit(1)'] })).rejects.toMatchObject({ code: 'command_conflict' });
    expect(await first).toEqual(await duplicate); expect((await following).stdout).toBe('x');
    expect(runtime.status().events.filter(value => value.kind === 'started').map(value => value.commandId)).toEqual(['once', 'following']);
    expect(await runtime.execute(input)).toEqual(await first);
  });

  it('keeps the session alive after a failed command, invalid/NUL UTF-8 or bounded-output failure', async () => {
    const { runtime } = await start(spec({ policy: { ...spec().policy, maxOutputBytesPerCommand: 32 } }));
    expect(await runtime.execute(command('exit', 'process.exit(7);'))).toMatchObject({ state: 'failed', exitCode: 7 });
    expect(await runtime.execute(command('invalid', 'process.stdout.write(Buffer.from([240,159]));'))).toMatchObject({ state: 'failed', reason: 'invalid_output' });
    expect(await runtime.execute(command('nul', 'process.stderr.write(Buffer.from([65,0,66]));setTimeout(()=>{},100);'))).toMatchObject({ state: 'failed', reason: 'invalid_output' });
    expect(await runtime.execute(command('large', 'process.stdout.write("x".repeat(33));'))).toMatchObject({ state: 'failed', reason: 'output_limit' });
    expect(await runtime.execute(command('good', 'process.stdout.write("still alive 🧬");'))).toMatchObject({ state: 'completed', stdout: 'still alive 🧬' });
    expect(runtime.status().state).toBe('running');
  });

  it('enforces the host lifetime independently and cancels active and queued work with confirmed process cleanup', async () => {
    const { runtime } = await start(spec({ lifetimeSeconds: 1 })), pid = runtime.status().initPid;
    const running = runtime.execute(command('long', 'setTimeout(()=>process.stdout.write("late"),5000);'));
    const queued = runtime.execute(command('queued', 'process.stdout.write("must not start");'));
    expect(await running).toMatchObject({ state: 'cancelled', reason: 'expired' }); expect(await queued).toMatchObject({ state: 'cancelled', reason: 'expired' });
    expect(runtime.status()).toMatchObject({ state: 'expired', cleanupConfirmed: true }); expect(() => process.kill(pid!, 0)).toThrow();
    expect(runtime.status().events.filter(value => value.kind === 'started').map(value => value.commandId)).toEqual(['long']);
    await expect(runtime.execute(command('late', 'process.exit(0);'))).rejects.toMatchObject({ code: 'session_unavailable' });
  });

  it('reopens durable terminal state without starting another init or reexecuting completed commands', async () => {
    const { runtime, journal } = await start(); const input = command('done', 'process.stdout.write("saved");');
    const result = await runtime.execute(input); await runtime.stop(); await (journal as FileSessionJournal).close();
    const newJournal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(newJournal);
    const forbidden: SessionBackend = { isolation: 'local_process_fixture', identity: backend.identity, start: async () => { throw new Error('No restart permitted'); }, cleanup: async () => { throw new Error('No cleanup needed'); } };
    const reopened = await SessionRuntime.open({ spec: spec(), backend: forbidden, journal: newJournal, reviewedImages: new Set([image]) }); runtimes.push(reopened);
    expect(await reopened.execute(input)).toEqual(result); expect(reopened.status()).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    const copy = reopened.readEvents(-1); copy[0]!.kind = 'session_exit'; expect(reopened.readEvents(-1)[0]!.kind).toBe('ready');
  });

  it('refuses journal reopen under another backend identity or isolation before attempting cleanup', async () => {
    const { runtime, journal } = await start(); let cleanup = false;
    for (const replacement of [{ ...backend, isolation: 'gvisor' as const, identity: backend.identity },
      { ...backend, isolation: 'local_process_fixture' as const, identity: '0'.repeat(64) }]) {
      const wrong: SessionBackend = { ...replacement, start: async () => { throw new Error('Wrong backend must not start'); },
        cleanup: async () => { cleanup = true; } };
      await expect(SessionRuntime.open({ spec: spec(), backend: wrong, journal, reviewedImages: new Set([image]) })).rejects.toMatchObject({ code: 'session_conflict' });
    }
    expect(cleanup).toBe(false); expect(await runtime.sample()).toEqual({ running: true, cpuMs: 0 });
    expect((await runtime.execute(command('original', 'process.stdout.write("original alive");'))).stdout).toBe('original alive');
  });

  it('does not let a paused output consumer block command completion or heartbeats', async () => {
    const { runtime } = await start(); const iterator = runtime.events(); await iterator.next();
    const result = await runtime.execute(command('unread', 'let n=0;const timer=setInterval(()=>{process.stdout.write(String(n++));if(n===15)clearInterval(timer);},20);'));
    expect(result.state).toBe('completed'); expect(result.stdout).toContain('14'); expect(runtime.status().heartbeat).not.toBeNull();
    await iterator.return(undefined);
  });

  it('physically stops the process when a fast invalid-frame producer overflows pending work despite a blocked journal', async () => {
    let release!: () => void, blocked = false, hold = false, emit: ((value: unknown) => void) | undefined;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const journal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(journal);
    const slow: SessionJournal = { load: () => journal.load(), save: async value => {
      if (hold && value.events.some(event => event.kind === 'output')) { blocked = true; await barrier; } await journal.save(value);
    } };
    let handle: Awaited<ReturnType<SessionBackend['start']>> | undefined;
    const captured: SessionBackend = { isolation: backend.isolation, identity: backend.identity, cleanup: value => backend.cleanup(value),
      start: async (value, onFrame, onFault) => { emit = onFrame; handle = await backend.start(value, onFrame, onFault); return handle; } };
    const { runtime } = await start(spec(), slow, captured); hold = true;
    const running = runtime.execute(command('held', 'process.stdout.write("hold");setTimeout(()=>{},5000);')); void running.catch(() => undefined);
    await wait(() => blocked);
    for (let index = 0; index < 5000; index++) emit?.({ kind: 'heartbeat', sequence: index + 1, elapsedMs: index });
    let physicallyStopped = false;
    try {
      const limit = Date.now() + 4000;
      while (Date.now() < limit) {
        physicallyStopped = !(await handle!.sample()).running;
        if (physicallyStopped) break;
        await new Promise(done => setTimeout(done, 20));
      }
      expect(physicallyStopped).toBe(true); expect(blocked).toBe(true);
    } finally { release(); }
    await running; await wait(() => runtime.status().cleanupConfirmed);
  });

  it.each(['fault', 'expiry'] as const)('owns and removes a late startup resource after an early %s without publishing premature cleanup', async cause => {
    let entered = false, release!: () => void, cleaned = false, late: Awaited<ReturnType<SessionBackend['start']>> | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const journal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(journal);
    const delayed: SessionBackend = { isolation: backend.isolation, identity: backend.identity,
      cleanup: async () => { cleaned = true; }, start: async (value, onFrame, onFault) => {
        entered = true; if (cause === 'fault') onFault(); await gate;
        late = await backend.start(value, onFrame, onFault); return late;
      } };
    const opening = SessionRuntime.open({ spec: spec({ lifetimeSeconds: 1 }), backend: delayed, journal, reviewedImages: new Set([image]) });
    void opening.catch(() => undefined);
    try {
      await wait(() => entered); await wait(() => cleaned, 2500);
      expect((await journal.load())?.cleanupConfirmed).toBe(false);
    } finally { release(); }
    await expect(opening).rejects.toMatchObject({ code: 'session_unavailable' });
    expect(await late!.sample()).toMatchObject({ running: false });
    expect(await journal.load()).toMatchObject({ state: cause === 'expiry' ? 'expired' : 'fault', cleanupConfirmed: true });
  });

  it.each([false, true])('makes concurrent stop callers await the same durable terminal publication (failed=%s)', async failSave => {
    let blocked = false, release!: () => void, secondReturned = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const journal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(journal);
    const delayed: SessionJournal = { load: () => journal.load(), save: async value => {
      if (value.cleanupConfirmed) { blocked = true; await gate; if (failSave) throw new Error('Owned journal fault'); }
      await journal.save(value);
    } };
    const { runtime } = await start(spec(), delayed), pid = runtime.status().initPid;
    const first = runtime.stop(); void first.catch(() => undefined); await wait(() => blocked);
    const second = runtime.stop().then(() => { secondReturned = true; }); void second.catch(() => undefined);
    try {
      await new Promise(done => setTimeout(done, 40)); expect(secondReturned).toBe(false);
      expect(() => process.kill(pid!, 0)).toThrow(); expect((await journal.load())?.cleanupConfirmed).toBe(false);
    } finally { release(); }
    if (failSave) {
      await expect(first).rejects.toMatchObject({ code: 'session_journal_invalid' });
      await expect(second).rejects.toMatchObject({ code: 'session_journal_invalid' });
    } else { await Promise.all([first, second]); expect((await journal.load())?.cleanupConfirmed).toBe(true); }
  });

  it('rejects a waiting event stream when terminal journal persistence fails without publishing the unsaved exit', async () => {
    const journal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(journal);
    let rejectTerminal = false;
    const faulting: SessionJournal = { load: () => journal.load(), save: async value => {
      if (rejectTerminal && value.cleanupConfirmed) throw new Error('Owned terminal persistence fault');
      await journal.save(value);
    } };
    const { runtime } = await start(spec(), faulting), pid = runtime.status().initPid;
    const stream = runtime.events(runtime.status().events.length - 1);
    const next = stream.next().then(value => ({ value, code: '' }), error => ({ value: undefined, code: (error as { code: string }).code }));
    rejectTerminal = true;
    await expect(runtime.stop()).rejects.toMatchObject({ code: 'session_journal_invalid' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { expect(await Promise.race([next, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error('Failed journal left event stream waiting')), 1000);
    })])).toEqual({ value: undefined, code: 'session_journal_invalid' }); }
    finally { clearTimeout(timer); }
    expect(runtime.status().journalAvailable).toBe(false);
    expect(() => runtime.readEvents()).toThrow('session_journal_invalid');
    expect((await journal.load())?.cleanupConfirmed).toBe(false);
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('withholds pending output from polling and streams until its journal write completes', async () => {
    const journal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(journal);
    let blocked = false, hold = false, release!: () => void, published = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed: SessionJournal = { load: () => journal.load(), save: async value => {
      if (hold && value.events.some(event => event.kind === 'output')) { blocked = true; await gate; }
      await journal.save(value);
    } };
    const { runtime } = await start(spec(), delayed); hold = true;
    const cursor = runtime.readEvents().at(-1)!.sequence;
    const stream = runtime.events(cursor), output = (async () => {
      for await (const event of stream) if (event.kind === 'output') { published = true; return event; }
      throw new Error('Expected durable output');
    })();
    void output.catch(() => undefined);
    const running = runtime.execute(command('pending-write', 'process.stdout.write("durable only");'));
    void running.catch(() => undefined);
    try {
      await wait(() => blocked); await new Promise(done => setTimeout(done, 40));
      expect(published).toBe(false);
      expect(runtime.readEvents().some(event => event.kind === 'output')).toBe(false);
      expect((await journal.load())?.events.some(event => event.kind === 'output')).toBe(false);
    } finally { release(); }
    expect(await output).toMatchObject({ kind: 'output', text: 'durable only' });
    expect(await running).toMatchObject({ state: 'completed', stdout: 'durable only' });
    expect((await journal.load())?.events).toEqual(expect.arrayContaining(runtime.readEvents()));
  });

  it('refuses an exact command retry after its completed result and cleanup could not be saved', async () => {
    const journal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(journal);
    let rejectCompleted = false;
    const faulting: SessionJournal = { load: () => journal.load(), save: async value => {
      if (rejectCompleted && value.commands.some(command => command.state === 'completed')) throw new Error('Owned result persistence fault');
      await journal.save(value);
    } };
    const { runtime } = await start(spec(), faulting), pid = runtime.status().initPid;
    rejectCompleted = true;
    const input = command('unsaved-result', 'process.exit(0);');
    await expect(runtime.execute(input)).rejects.toMatchObject({ code: 'session_journal_invalid' });
    await expect(runtime.stop()).rejects.toMatchObject({ code: 'session_journal_invalid' });
    await expect(runtime.execute(structuredClone(input))).rejects.toMatchObject({ code: 'session_journal_invalid' });
    expect(runtime.status()).toMatchObject({ journalAvailable: false, cleanupConfirmed: true });
    expect((await journal.load())?.commands[0]?.state).toBe('running');
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('never reruns an actual started command after journal close/reopen and uncertain controller state', async () => {
    const { runtime, journal } = await start(); const input = command('ambiguous', "require('node:fs').appendFileSync('once.txt','x');process.stdout.write('started');setTimeout(()=>{},5000);");
    const original = runtime.execute(input); void original.catch(() => undefined);
    await wait(() => runtime.status().commands[0]?.stdout === 'started'); await (journal as FileSessionJournal).close();
    const newJournal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(newJournal);
    const reopened = await SessionRuntime.open({ spec: spec(), backend, journal: newJournal, reviewedImages: new Set([image]) }); runtimes.push(reopened);
    expect(reopened.status()).toMatchObject({ state: 'fault', reason: 'recovered', cleanupConfirmed: true });
    expect(await reopened.execute(input)).toMatchObject({ state: 'uncertain', reason: 'recovered' });
    expect(await readFile(join(directory, 'cells', spec().sessionId.slice(2), 'once.txt'), 'utf8')).toBe('x');
    await original.catch(() => undefined);
  });

  it('rejects unreviewed images, malformed policy/Unicode/shells and exhausted command capacity', async () => {
    const journal = await FileSessionJournal.open(journalDirectory, spec().sessionId); journals.push(journal);
    await expect(SessionRuntime.open({ spec: spec(), backend, journal, reviewedImages: new Set() })).rejects.toMatchObject({ code: 'invalid_session' });
    const { runtime } = await start(spec({ policy: { ...spec().policy, maxCommands: 1 } }), journal);
    for (const value of [command('bad', '\ud800'), { commandId: 'shell', argv: ['/bin/sh', '-c', 'true'] }, command('nul', 'process.exit(0)', '\0')]) {
      await expect(runtime.execute(value)).rejects.toMatchObject({ code: 'invalid_session' });
    }
    await runtime.execute(command('one', 'process.exit(0);'));
    await expect(runtime.execute(command('two', 'process.exit(0);'))).rejects.toMatchObject({ code: 'command_limit' });
    expect(() => runtime.readEvents(999)).toThrow();
  });

  it('fails closed before further writes when its private journal lock is replaced', async () => {
    const { runtime } = await start(); await unlink(join(journalDirectory, 'session.lock'));
    await writeFile(join(journalDirectory, 'session.lock'), '0'.repeat(64), { mode: 0o600, flag: 'wx' });
    await expect(runtime.execute(command('blocked', 'process.stdout.write("never");'))).rejects.toMatchObject({ code: 'session_unavailable' });
    await wait(() => runtime.status().cleanupConfirmed);
    expect(runtime.status().events.some(event => event.kind === 'started')).toBe(false);
  });

  it('uses one fixed gVisor/Kata container policy with no tenant Docker flags, mounts or network', () => {
    const hostKey = '0x' + 'c'.repeat(64), value = spec(), name = sessionContainerName(hostKey, value.sessionId);
    const args = sessionDockerCreateArgs(name, hostKey, value, 'gvisor');
    for (const pair of [['--runtime', 'runsc'], ['--network', 'none'], ['--cap-drop', 'ALL'], ['--user', '10000:10000'],
      ['--cpus', '1'], ['--memory', '256m'], ['--memory-swap', '256m'], ['--pids-limit', '64'], ['--workdir', '/tmp']]) expect(args[args.indexOf(pair[0]!) + 1]).toBe(pair[1]);
    expect(args).toContain('--read-only'); expect(args).not.toContain('--privileged'); expect(args).not.toContain('--volume');
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,noexec,nosuid,nodev,size=16m');
    expect(sessionDockerCreateArgs(name, hostKey, value, 'kata')[args.indexOf('--runtime') + 1]).toBe('kata-runtime');
    for (const quota of [0.5, 0.25] as const) {
      const reduced = sessionDockerCreateArgs(name, hostKey, { ...value, policy: { ...value.policy, cpu: quota } }, 'gvisor');
      expect(reduced[reduced.indexOf('--cpus') + 1]).toBe(String(quota));
      expect(reduced[reduced.indexOf('--network') + 1]).toBe('none');
      expect(reduced).not.toContain('--volume');
    }
  });
});
