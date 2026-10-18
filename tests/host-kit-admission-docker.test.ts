import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomId } from '../src/common.js';
import { admissionHash } from '../src/host-kit/admission.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient, HostKitCommandExecutor } from '../src/host-kit/client.js';
import { inspectHostInventory } from '../src/host-kit/docker-inventory.js';
import { createDockerHostedHostKit } from '../src/host-kit/hosted.js';
import { hostClaims, hostRuns, hostSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, verifyHostMessage, type SignedHostLease } from '../src/host-kit/protocol.js';
import { sessionContainerName } from '../src/host-kit/sessions/backends.js';
import type { SessionCommand, SessionSpec } from '../src/host-kit/sessions/types.js';
import { executeCommand } from '../src/runtime/command.js';
import { reviewedGvisorFixture } from './fixtures/isolated-gvisor.js';

// Explicit isolated acceptance only. No implicit image/socket override and no
// fixture runtime can satisfy these actual Docker/gVisor assertions.
const enabled = process.platform === 'linux' && process.env.TELOMERE_HOST_ADMISSION_DOCKER_ACCEPTANCE === '1';
const { image, socket, parent } = await reviewedGvisorFixture(enabled);
const owner = '0x1111111111111111111111111111111111111111', nextOwner = '0x2222222222222222222222222222222222222222';
const ownershipLog = resolve('.local/host-kit-admission-owned.jsonl');
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (!await predicate()) { if (performance.now() >= deadline) throw new Error('Owned shared admission acceptance timed out'); await pause(25); }
}
async function docker(args: string[], maximum = 16_384) {
  return executeCommand('docker', ['--host', 'unix://' + socket, ...args], { signal: AbortSignal.timeout(10_000), maxOutputBytes: maximum });
}
const command = (commandId: string, source: string): SessionCommand => ({ commandId, argv: ['/usr/local/bin/node', '-e', source] });
function spec(sessionId = randomId()): SessionSpec {
  return { version: 1, sessionId, image, lifetimeSeconds: 60,
    policy: { version: 1, cpu: 1, memoryBytes: 268_435_456, pids: 64, temporaryBytes: 16_777_216,
      network: 'none', readOnlyRoot: true, maxCommands: 12, maxOutputBytesPerCommand: 16_384,
      maxSessionOutputBytes: 65_536, maxOutputFrames: 1024 } };
}
function background(tag: string, running: boolean) {
  const grandchild = 'setInterval(()=>{},1000);';
  const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},${JSON.stringify(tag + '-grandchild')}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
  const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},${JSON.stringify(tag + '-child')}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
  return `require('node:fs').writeFileSync('/tmp/shared-state','state 🧬');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(parentSource)},${JSON.stringify(tag + '-parent')}],{detached:true,stdio:'ignore'}).unref();process.stdout.write('retained-background');${running ? 'setInterval(()=>{},1000);' : 'process.exit(7);'}`;
}
type Hosted = ReturnType<typeof createDockerHostedHostKit>;
type Fixture = { journal: HostJournal; hosted: Hosted; control: Ed25519Identity; path: string };
type Namespace = { hostKey: string; kind: 'oneshot' | 'session'; resourceId: string; name?: string };

describe.skipIf(!enabled)('actual reviewed gVisor shared Host Kit admission', () => {
  let directory: string, primary: Fixture;
  const hosts: Fixture[] = [], journals = new Set<HostJournal>(), servers: Server[] = [], children: ChildProcess[] = [];
  const childClosures = new WeakMap<ChildProcess, Promise<void>>();
  const namespaces: Namespace[] = [], hostKeys = new Set<string>();

  async function ownership(value: object) {
    await mkdir(dirname(ownershipLog), { recursive: true, mode: 0o700 });
    const file = await open(ownershipLog, 'a', 0o600);
    try { await file.writeFile(JSON.stringify({ directory: basename(directory), ...value }) + '\n'); await file.sync(); }
    finally { await file.close(); }
  }
  async function ownedNamespace(value: Namespace) { namespaces.push(value); await ownership(value); }
  async function make(path: string, control = new Ed25519Identity()) {
    const journal = await openHostJournal(path); journals.add(journal); hostKeys.add(journal.identity.publicKey);
    await ownership({ hostKey: journal.identity.publicKey, kind: 'host' });
    const hosted = createDockerHostedHostKit({ journal, controlKey: control.publicKey, reviewedImages: new Set([image]), isolation: 'gvisor', socketPath: socket });
    const fixture = { journal, hosted, control, path }; hosts.push(fixture); return fixture;
  }
  const inventory = (hostKey: string) => inspectHostInventory({ hostKey, socketPath: socket });
  async function inspectNamespace(value: Namespace) {
    const resources = await inventory(value.hostKey), actual = resources.find(item => item.kind === value.kind && item.resourceId === value.resourceId);
    expect(actual).toBeDefined(); expect(actual!.image).toBe(image);
    if (value.name) expect(actual!.name).toBe(value.name);
    const result = await docker(['inspect', '--format', '{"host":{{json .HostConfig}},"labels":{{json .Config.Labels}},"image":{{json .Config.Image}}}', actual!.name]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { host: Record<string, unknown>; labels: Record<string, string>; image: string };
    expect(parsed.image).toBe(image); expect(parsed.labels['telomere.host_key']).toBe(value.hostKey);
    expect(parsed.labels[value.kind === 'session' ? 'telomere.session' : 'telomere.hostkit']).toBe('true');
    expect(parsed.labels[value.kind === 'session' ? 'telomere.session_id' : 'telomere.run_id']).toBe(value.resourceId);
    expect(parsed.host).toMatchObject({ Runtime: 'runsc', NetworkMode: 'none', ReadonlyRootfs: true,
      Memory: 268_435_456, MemorySwap: 268_435_456, PidsLimit: 64, CapDrop: ['ALL'] });
    await ownership({ ...value, name: actual!.name }); return actual!.name;
  }
  async function descendants(name: string, tag: string) {
    const probe = "const f=require('node:fs');process.stdout.write(JSON.stringify(f.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)).flatMap(n=>{try{return f.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0');}catch{return[];}})));";
    await until(async () => {
      const result = await docker(['exec', name, '/usr/local/bin/node', '-e', probe]);
      if (result.exitCode !== 0) return false;
      const args = JSON.parse(result.stdout) as string[];
      return ['parent', 'child', 'grandchild'].every(kind => args.includes(tag + '-' + kind));
    }, 5000);
  }
  async function http(value = primary) {
    const server = createServer(getRequestListener(createHostKitRoutes(value.hosted.agent).fetch)); servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned shared HTTP address missing');
    const url = 'http://127.0.0.1:' + address.port;
    return { client: new HostKitClient(url, value.journal.identity.publicKey, value.control),
      admit: (signed: SignedHostLease) => fetch(url + '/v1/leases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) }), url };
  }
  function lease(value = primary, source = 'setInterval(()=>{},1000);', payer = owner) {
    const now = Date.now(); return value.control.sign('lease', { version: 1 as const, hostKey: value.journal.identity.publicKey,
      runId: randomId(), owner: payer, image, argv: ['/usr/local/bin/node', '-e', source], issuedAt: now,
      expiresAt: now + 30_000, maxSeconds: 30, nonce: randomId() });
  }
  async function startSession(requested: SessionSpec, value = primary) {
    await ownedNamespace({ hostKey: value.journal.identity.publicKey, kind: 'session', resourceId: requested.sessionId,
      name: sessionContainerName(value.journal.identity.publicKey, requested.sessionId) });
    return value.hosted.sessions.open(requested);
  }
  async function successor(value = primary) {
    expect(await inventory(value.journal.identity.publicKey)).toEqual([]);
    const api = await http(value), evidencePath = join(directory, 'controller-' + randomId().slice(2, 18) + '.jsonl');
    const persist = async (event: unknown) => { const file = await open(evidencePath, 'a', 0o600);
      try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync(); } finally { await file.close(); } };
    const runId = randomId();
    const result = await new HostKitCommandExecutor(api.client, nextOwner, image, {
      onLease: async signed => { await persist({ kind: 'lease', signed }); await ownedNamespace({ hostKey: signed.body.hostKey, kind: 'oneshot', resourceId: signed.body.runId }); },
      onEvidence: (tick, ack) => persist({ kind: 'evidence', tick, ack }),
    }).run({ runId, maxSeconds: 10, argv: ['/usr/local/bin/node', '-e', 'if(require("node:fs").existsSync("/tmp/shared-state"))process.exit(28);process.stdout.write("different-owner-ok");'] }, new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', output: 'different-owner-ok', exitCode: 0 });
    const [saved] = await value.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, runId));
    expect(saved).toMatchObject({ owner: nextOwner, cleanupConfirmed: true, state: 'completed' });
    expect(saved!.leaseHash).toBe(hostMessageHash(saved!.lease)); expect(saved!.ticks.length).toBe(saved!.acks.length);
    expect(saved!.ticks.length).toBeGreaterThan(0);
    expect(saved!.ticks.every(tick => verifyHostMessage(value.journal.identity.publicKey, 'tick', tick))).toBe(true);
    expect(saved!.acks.every(ack => verifyHostMessage(value.control.publicKey, 'ack', ack))).toBe(true);
    expect((await readFile(evidencePath, 'utf8')).trim().split('\n')).toHaveLength(1 + saved!.ticks.length);
    expect(await value.journal.db.select().from(hostClaims)).toEqual([]); expect(await inventory(value.journal.identity.publicKey)).toEqual([]);
  }
  async function childClosed(child: ChildProcess) {
    const closed = childClosures.get(child); if (!closed) throw new Error('Unknown fixture child');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => reject(new Error('Owned fixture child did not close')), 5000);
    })]); } finally { clearTimeout(timer); }
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(parent, 'host-kit-admission-cell-')); await chmod(directory, 0o700);
    primary = await make(join(directory, 'primary')); await primary.hosted.initialize();
  });
  afterEach(async () => {
    // Kill only children created by this test, before reopening/closing their journals.
    for (const child of children.splice(0)) { child.kill('SIGKILL'); await childClosed(child); }
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    let leaked = false;
    try {
      for (const value of hosts.splice(0).reverse()) await value.hosted.close().catch(() => undefined);
      for (const hostKey of hostKeys) {
        const remaining = await inventory(hostKey); leaked ||= remaining.length > 0;
        for (const resource of remaining) {
          // Emergency removal never adopts an unknown marker. Preserve this
          // occurrence in public fixture evidence and fail the acceptance case.
          if (!namespaces.some(value => value.hostKey === hostKey && value.kind === resource.kind && value.resourceId === resource.resourceId)
            || resource.image !== image) throw new Error('Unknown owned admission resource');
          await ownership({ hostKey, ...resource, kind: 'emergency-removal' });
          expect((await docker(['rm', '--force', '--volumes', resource.name])).exitCode).toBe(0);
        }
        expect(await inventory(hostKey)).toEqual([]);
      }
      expect(leaked).toBe(false);
    } finally {
      for (const journal of journals) await journal.close().catch(() => undefined); journals.clear(); hostKeys.clear(); namespaces.splice(0);
      const owned = resolve(directory);
      if (dirname(owned) !== parent || !basename(owned).startsWith('host-kit-admission-cell-')) throw new Error('Unexpected owned shared admission fixture');
      await rm(owned, { recursive: true, force: true });
    }
  });

  it('retains session tmp, nonzero command and detached descendants while excluding signed HTTP until full stop', async () => {
    const requested = spec(), session = await startSession(requested), tag = 'session-' + randomId().slice(2, 18);
    const input = command('write-failed', background(tag, false));
    expect(await session.execute(input)).toMatchObject({ state: 'failed', exitCode: 7, stdout: 'retained-background' });
    const name = await inspectNamespace({ hostKey: primary.journal.identity.publicKey, kind: 'session', resourceId: requested.sessionId });
    await descendants(name, tag); await pause(75);
    const [claim] = await primary.journal.db.select().from(hostClaims);
    expect(claim).toMatchObject({ kind: 'session', resourceId: requested.sessionId, original: requested, inputHash: admissionHash(requested) });
    const api = await http(), refused = lease(); expect((await api.admit(refused)).status).toBe(409);
    expect(await primary.journal.db.select().from(hostRuns)).toEqual([]);
    expect((await session.execute(command('read', "process.stdout.write(require('node:fs').readFileSync('/tmp/shared-state','utf8'));"))).stdout).toBe('state 🧬');
    expect(await session.execute(input)).toMatchObject({ state: 'failed', exitCode: 7 });
    expect(session.status()).toMatchObject({ state: 'running', cleanupConfirmed: false, initPid: 1 });
    expect((await inventory(primary.journal.identity.publicKey)).map(value => value.name)).toEqual([name]);
    await session.stop(); expect(session.status()).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    expect((await primary.journal.db.select().from(hostSessions))[0]!.record?.cleanupConfirmed).toBe(true);
    await successor(); expect((await fetch(api.url + '/v1/sessions')).status).toBe(404);
  }, 60_000);

  it('keeps the original signed one-shot claim exclusive until its actual namespace is removed', async () => {
    const tag = 'oneshot-' + randomId().slice(2, 18), signed = lease(primary, background(tag, true)), api = await http();
    await ownedNamespace({ hostKey: signed.body.hostKey, kind: 'oneshot', resourceId: signed.body.runId });
    expect((await api.client.admit(signed)).state).toBe('running');
    const name = await inspectNamespace({ hostKey: signed.body.hostKey, kind: 'oneshot', resourceId: signed.body.runId }); await descendants(name, tag);
    const [claim] = await primary.journal.db.select().from(hostClaims);
    expect(claim).toMatchObject({ kind: 'oneshot', resourceId: signed.body.runId, original: signed, inputHash: admissionHash(signed) });
    await expect(primary.hosted.sessions.open(spec())).rejects.toMatchObject({ code: 'host_busy' });
    expect(await primary.journal.db.select().from(hostSessions)).toEqual([]);
    expect(await api.client.command(signed, 'stop')).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    expect(await inventory(primary.journal.identity.publicKey)).toEqual([]); expect(await primary.journal.db.select().from(hostClaims)).toEqual([]);
    const requested = spec(), session = await startSession(requested);
    expect(await session.execute(command('next', 'if(require("node:fs").existsSync("/tmp/shared-state"))process.exit(28);process.stdout.write("session-after-oneshot");'))).toMatchObject({ state: 'completed', stdout: 'session-after-oneshot' });
    await session.stop(); expect(await inventory(primary.journal.identity.publicKey)).toEqual([]);
  }, 60_000);

  it('recovers a genuinely crashed disk-journal session by original scope without removing another host or rerunning its command', async () => {
    const foreign = await make(join(directory, 'foreign')); await foreign.hosted.initialize();
    const foreignSpec = spec(), sentinel = await startSession(foreignSpec, foreign);
    expect((await sentinel.execute(command('sentinel', "require('node:fs').writeFileSync('/tmp/sentinel','foreign-kept');"))).state).toBe('completed');
    const foreignName = await inspectNamespace({ hostKey: foreign.journal.identity.publicKey, kind: 'session', resourceId: foreignSpec.sessionId });
    const requested = spec(), tag = 'crash-' + randomId().slice(2, 18), input = command('original-nonzero', background(tag, false));
    const path = join(directory, 'crash'), control = new Ed25519Identity();
    const source = `
      import { open } from 'node:fs/promises';
      import { createDockerHostedHostKit } from ${JSON.stringify(pathToFileURL(resolve('src/host-kit/hosted.ts')).href)};
      import { openHostJournal } from ${JSON.stringify(pathToFileURL(resolve('src/host-kit/journal.ts')).href)};
      import { sessionContainerName } from ${JSON.stringify(pathToFileURL(resolve('src/host-kit/sessions/backends.ts')).href)};
      const requested=${JSON.stringify(requested)}, command=${JSON.stringify(input)};
      try {
        const journal=await openHostJournal(${JSON.stringify(path)}), hostKey=journal.identity.publicKey;
        const ownership={directory:${JSON.stringify(basename(directory))},hostKey,kind:'session',resourceId:requested.sessionId,name:sessionContainerName(hostKey,requested.sessionId)};
        const owned=await open(${JSON.stringify(ownershipLog)},'a',0o600);
        try { await owned.writeFile(JSON.stringify(ownership)+'\\n'); await owned.sync(); } finally { await owned.close(); }
        process.send({...ownership,kind:'identity'});
        const host=createDockerHostedHostKit({journal,controlKey:${JSON.stringify(control.publicKey)},reviewedImages:new Set([${JSON.stringify(image)}]),isolation:'gvisor',socketPath:${JSON.stringify(socket)}});
        await host.initialize(); const session=await host.sessions.open(requested), result=await session.execute(command);
        process.send({kind:'ready',hostKey,result});
      } catch { process.send({kind:'fault'}); process.exitCode=1; }
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), windowsHide: true,
      shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); children.push(child);
    childClosures.set(child, new Promise<void>(done => child.once('close', () => done())));
    const ready = await new Promise<{ hostKey: string; result: unknown }>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned crash fixture did not become ready')), 20_000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Owned crash fixture failed')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned crash fixture exited before ready')); });
      child.on('message', raw => {
        const message = raw as { kind?: string; hostKey?: string; name?: string; result?: unknown };
        if (message.kind === 'identity' && message.hostKey && /^0x[a-f0-9]{64}$/.test(message.hostKey)) {
          hostKeys.add(message.hostKey); namespaces.push({ hostKey: message.hostKey, kind: 'session', resourceId: requested.sessionId,
            name: sessionContainerName(message.hostKey, requested.sessionId) });
        }
        if (message.kind === 'ready' && message.hostKey) { clearTimeout(timer); done({ hostKey: message.hostKey, result: message.result }); }
        if (message.kind === 'fault') { clearTimeout(timer); reject(new Error('Owned crash fixture failed')); }
      });
    });
    expect(ready.result).toMatchObject({ state: 'failed', exitCode: 7, stdout: 'retained-background' });
    const name = await inspectNamespace({ hostKey: ready.hostKey, kind: 'session', resourceId: requested.sessionId }); await descendants(name, tag);
    expect(child.kill('SIGKILL')).toBe(true); await childClosed(child); expect(child.signalCode).toBe('SIGKILL');
    expect((await inventory(ready.hostKey)).map(value => value.name)).toEqual([name]);
    const replacement = await make(path, control); expect(replacement.journal.identity.publicKey).toBe(ready.hostKey);
    expect(await replacement.hosted.initialize()).toHaveProperty('recoveredSessions', [requested.sessionId]);
    expect(await inventory(ready.hostKey)).toEqual([]); expect(await replacement.journal.db.select().from(hostClaims)).toEqual([]);
    const [saved] = await replacement.journal.db.select().from(hostSessions);
    expect(saved).toMatchObject({ spec: requested, specHash: admissionHash(requested), record: { state: 'fault', reason: 'recovered', cleanupConfirmed: true } });
    const replay = await replacement.hosted.sessions.open(requested); expect(await replay.execute(input)).toEqual(ready.result);
    expect(replay.status().events.filter(value => value.kind === 'started')).toHaveLength(1); expect(await inventory(ready.hostKey)).toEqual([]);
    expect((await inventory(foreign.journal.identity.publicKey)).map(value => value.name)).toEqual([foreignName]);
    expect((await sentinel.execute(command('still-foreign', "process.stdout.write(require('node:fs').readFileSync('/tmp/sentinel','utf8'));"))).stdout).toBe('foreign-kept');
    await successor(replacement); await sentinel.stop();
  }, 60_000);

  it.each(['oneshot', 'session'] as const)('shutdown removes the actual %s namespace and descendants while synchronously fencing both modes', async mode => {
    const tag = 'shutdown-' + randomId().slice(2, 18), api = await http();
    let running: Promise<unknown> | undefined, requested: SessionSpec | undefined, signed: SignedHostLease | undefined;
    if (mode === 'oneshot') {
      signed = lease(primary, background(tag, true)); await ownedNamespace({ hostKey: signed.body.hostKey, kind: 'oneshot', resourceId: signed.body.runId });
      expect((await api.client.admit(signed)).state).toBe('running');
      await descendants(await inspectNamespace({ hostKey: signed.body.hostKey, kind: 'oneshot', resourceId: signed.body.runId }), tag);
    } else {
      requested = spec(); const session = await startSession(requested); running = session.execute(command('running', background(tag, true)));
      void running.catch(() => undefined); await until(() => session.status().commands[0]?.stdout === 'retained-background');
      await descendants(await inspectNamespace({ hostKey: primary.journal.identity.publicKey, kind: 'session', resourceId: requested.sessionId }), tag);
    }
    expect(await primary.journal.db.select().from(hostClaims)).toHaveLength(1);
    const closing = primary.hosted.close(); expect(primary.hosted.agent.identity().ready).toBe(false);
    expect(() => primary.hosted.sessions.open(spec())).toThrow(); expect((await api.admit(lease())).status).toBe(503);
    await closing; if (running) expect(await running).toMatchObject({ state: 'cancelled', reason: 'requested' });
    expect(await inventory(primary.journal.identity.publicKey)).toEqual([]); expect(await primary.journal.db.select().from(hostClaims)).toEqual([]);
    if (signed) expect((await primary.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, signed.body.runId)))[0]).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    if (requested) expect((await primary.journal.db.select().from(hostSessions).where(eq(hostSessions.sessionId, requested.sessionId)))[0]!.record).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
  }, 60_000);
});
