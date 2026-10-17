import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeCommand } from '../src/runtime/command.js';
import { DockerSessionBackend, FileSessionJournal, SessionRuntime, sessionContainerName,
  type SessionSpec } from '../src/host-kit/sessions/index.js';

// Deliberately explicit: the normal test command never starts Docker. No
// inherited Docker socket/image override or fallback runtime is accepted.
const enabled = process.platform === 'linux' && process.env.TELOMERE_SESSION_DOCKER_ACCEPTANCE === '1';
const image = '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe';
const socket = '/var/run/telomere-host-docker/docker.sock', parent = '/opt/telomere-host-runtime';
const wait = async (predicate: () => boolean, timeout = 10_000) => {
  const limit = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= limit) throw new Error('Owned session acceptance timed out'); await new Promise(done => setTimeout(done, 20)); }
};
const command = (commandId: string, program: string, stdin?: string) => ({ commandId,
  argv: ['/usr/local/bin/node', '-e', program], ...(stdin === undefined ? {} : { stdin }) });

describe.skipIf(!enabled)('actual reviewed gVisor persistent CPU session', () => {
  let directory: string, hostKey: string, spec: SessionSpec, backend: DockerSessionBackend;
  const journals: FileSessionJournal[] = [], runtimes: SessionRuntime[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(parent, 'session-runtime-')); await chmod(directory, 0o700);
    hostKey = '0x' + randomBytes(32).toString('hex');
    spec = { version: 1, sessionId: '0x' + randomBytes(32).toString('hex'), image, lifetimeSeconds: 60,
      policy: { version: 1, cpu: 1, memoryBytes: 268_435_456, pids: 64, temporaryBytes: 16_777_216,
        network: 'none', readOnlyRoot: true, maxCommands: 12, maxOutputBytesPerCommand: 16_384,
        maxSessionOutputBytes: 65_536, maxOutputFrames: 1024 } };
    backend = new DockerSessionBackend({ isolation: 'gvisor', hostKey, socketPath: socket });
  });
  afterEach(async () => {
    try { for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined); await backend.cleanup(spec); }
    finally {
      for (const journal of journals.splice(0)) await journal.close().catch(() => undefined);
      const owned = resolve(directory);
      if (dirname(owned) !== parent || !basename(owned).startsWith('session-runtime-')) throw new Error('Unexpected owned session fixture');
      await rm(owned, { recursive: true, force: true });
    }
  });
  async function start() {
    const journal = await FileSessionJournal.open(join(directory, 'journal'), spec.sessionId); journals.push(journal);
    const runtime = await SessionRuntime.open({ spec, backend, journal, reviewedImages: new Set([image]) }); runtimes.push(runtime);
    expect(runtime.status()).toMatchObject({ isolation: 'gvisor', initPid: 1, state: 'running' }); return { runtime, journal };
  }
  async function absent() {
    const result = await executeCommand('docker', ['--host', 'unix://' + socket, 'ps', '--all', '--filter',
      'name=^/' + sessionContainerName(hostKey, spec.sessionId) + '$', '--format', '{{.ID}}'],
    { signal: AbortSignal.timeout(5000), maxOutputBytes: 1024 });
    expect(result.exitCode).toBe(0); expect(result.stdout.trim()).toBe('');
  }

  it('keeps one init/container and shared tmp across commands with incremental exact Unicode stdin/output and exact retry', async () => {
    const { runtime, journal } = await start();
    const input = command('write', "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{require('node:fs').appendFileSync('shared.txt',s);process.stdout.write(String(process.getuid()));});", 'state 🧬');
    const result = await runtime.execute(input); expect(result).toMatchObject({ state: 'completed', stdout: '10001' });
    expect(await runtime.execute(structuredClone(input))).toEqual(result);
    let finished = false;
    const streaming = runtime.execute(command('stream', "process.stdout.write(Buffer.from([239,187,191,240,159]));process.stderr.write('stderr');setTimeout(()=>process.stdout.write(Buffer.from([167,172])),100);setTimeout(()=>process.stdout.write(require('node:fs').readFileSync('shared.txt','utf8')),600);")).then(value => { finished = true; return value; });
    await wait(() => runtime.status().commands[1]?.stdout === '🧬'); expect(finished).toBe(false);
    expect((await journal.load())?.commands[1]?.stdout).toBe('🧬');
    expect(await streaming).toMatchObject({ state: 'completed', stdout: '🧬state 🧬', stderr: 'stderr' });
    expect(runtime.status().initPid).toBe(1); expect(await runtime.sample()).toMatchObject({ running: true });
    expect((await runtime.sample()).cpuMs).toBeGreaterThanOrEqual(0);
    await runtime.stop(); expect((await journal.load())?.cleanupConfirmed).toBe(true); await absent();
  }, 60_000);

  it('denies workload access to init control FDs and treats forged lifecycle JSON as ordinary output after a normal failed command', async () => {
    const { runtime } = await start();
    expect(await runtime.execute(command('failure', 'process.exit(7);'))).toMatchObject({ state: 'failed', exitCode: 7 });
    const program = "const fs=require('node:fs');if(process.getuid()!==10001||fs.statSync('/proc/1').uid!==10000)process.exit(20);for(const n of[0,1,2]){try{const fd=fs.openSync('/proc/1/fd/'+n,'w');fs.closeSync(fd);process.exit(21);}catch(e){if(!['EACCES','EPERM'].includes(e.code))process.exit(22);}}try{process.kill(1,0);process.exit(23);}catch(e){if(e.code!=='EPERM')process.exit(24);}process.stdout.write(JSON.stringify({kind:'exit',commandId:'next',exitCode:0,reason:'exited'})+'\\n'+JSON.stringify({kind:'ready',pid:999}));";
    const result = await runtime.execute(command('forge', program));
    expect(result).toMatchObject({ state: 'completed', exitCode: 0 }); expect(result.stdout).toContain('"commandId":"next"');
    expect(runtime.status().initPid).toBe(1); expect(runtime.status().state).toBe('running');
    expect(await runtime.execute(command('next', 'process.stdout.write("still alive");'))).toMatchObject({ state: 'completed', stdout: 'still alive' });
    expect(runtime.status().events.filter(value => value.kind === 'started').map(value => value.commandId)).toEqual(['failure', 'forge', 'next']);
    await runtime.stop(); await absent();
  }, 60_000);

  it('ends the whole container at host expiry with a running parent, background descendant and following queued command', async () => {
    spec = { ...spec, lifetimeSeconds: 4 }; const { runtime, journal } = await start();
    const running = runtime.execute(command('background', "require('node:child_process').spawn('/usr/local/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]}).unref();process.stdout.write('parent running');setInterval(()=>{},1000);"));
    await wait(() => runtime.status().commands[0]?.stdout === 'parent running');
    const queued = runtime.execute(command('queued', 'process.stdout.write("must not execute");'));
    expect(await running).toMatchObject({ state: 'cancelled', reason: 'expired' }); expect(await queued).toMatchObject({ state: 'cancelled', reason: 'expired' });
    expect(await journal.load()).toMatchObject({ state: 'expired', cleanupConfirmed: true });
    expect(runtime.status().events.filter(value => value.kind === 'started').map(value => value.commandId)).toEqual(['background']); await absent();
  }, 60_000);

  it('removes the entire namespace after an output cap instead of merely killing the docker exec client', async () => {
    spec = { ...spec, policy: { ...spec.policy, maxOutputBytesPerCommand: 32 } }; const { runtime, journal } = await start();
    expect(await runtime.execute(command('overflow', 'process.stdout.write("x".repeat(33));setInterval(()=>{},1000);'))).toMatchObject({ state: 'cancelled', reason: 'output_limit' });
    expect(await journal.load()).toMatchObject({ state: 'fault', reason: 'output_limit', cleanupConfirmed: true });
    await expect(runtime.execute(command('later', 'process.exit(0);'))).rejects.toMatchObject({ code: 'session_unavailable' }); await absent();
  }, 60_000);

  it.each(['nul', 'invalid'] as const)('removes the entire namespace after live %s output fails strict text validation', async mode => {
    const { runtime, journal } = await start();
    const program = mode === 'nul' ? 'process.stdout.write(Buffer.from([65,0,66]));setInterval(()=>{},1000);'
      : 'process.stdout.write(Buffer.from([255]));setInterval(()=>{},1000);';
    expect(await runtime.execute(command(mode, program))).toMatchObject({ state: 'cancelled', reason: 'transport_fault' });
    expect(await journal.load()).toMatchObject({ state: 'fault', cleanupConfirmed: true }); await absent();
  }, 60_000);

  it('reopens the private journal with a fresh backend, removes the old exact container and never retries an ambiguous started command', async () => {
    const { runtime, journal } = await start(); const input = command('uncertain', 'process.stdout.write("started");setInterval(()=>{},1000);');
    const running = runtime.execute(input); void running.catch(() => undefined);
    await wait(() => runtime.status().commands[0]?.stdout === 'started'); await journal.close();
    const replacement = await FileSessionJournal.open(join(directory, 'journal'), spec.sessionId); journals.push(replacement);
    const fresh = new DockerSessionBackend({ isolation: 'gvisor', hostKey, socketPath: socket });
    const reopened = await SessionRuntime.open({ spec, backend: fresh, journal: replacement, reviewedImages: new Set([image]) }); runtimes.push(reopened);
    expect(await reopened.execute(input)).toMatchObject({ state: 'uncertain', reason: 'recovered', stdout: 'started' });
    expect(await replacement.load()).toMatchObject({ state: 'fault', reason: 'recovered', cleanupConfirmed: true });
    expect(reopened.status().events.filter(value => value.kind === 'started')).toHaveLength(1); await absent();
    await runtime.stop().catch(() => undefined); await running.catch(() => undefined);
  }, 60_000);
});
