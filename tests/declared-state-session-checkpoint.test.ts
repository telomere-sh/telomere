import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import files, { type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical, randomId } from '../src/common.js';
import { captureDeclaredStateCheckpoint, DECLARED_STATE_CHECKPOINT_MAX_BYTES } from '../src/sdk/declared-state-checkpoint.js';
import { restoreDeclaredStateBundle } from '../src/sdk/declared-state-restore.js';
import { DECLARED_STATE_RECEIPT } from '../src/cysts/declared-state-protocol.js';
import { PaidSessionCheckpointRunner } from '../src/agents/paid-session-checkpoint.js';
import { CystCheckpointCoordinator } from '../src/sdk/cyst-checkpoints.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { CystClient } from '../src/sdk/cysts.js';
import { ApiTransport } from '../src/sdk/transport.js';
import { CystService } from '../src/cysts/service.js';
import { createCystRoutes } from '../src/cysts/routes.js';
import { openStore } from '../src/store.js';
import { createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { createDockerHostedHostKit, createHostedHostKit } from '../src/host-kit/hosted.js';
import { inspectHostInventory } from '../src/host-kit/docker-inventory.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { hostSessions, openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, imageDigestSchema, type HostLease } from '../src/host-kit/protocol.js';
import { LocalSessionFixtureBackend } from '../src/host-kit/sessions/backends.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PAID_SESSION_ARGV, paidSessionPolicy } from '../src/host-kit/sessions/paid-protocol.js';
import { sessionCommandSchema } from '../src/host-kit/sessions/types.js';

const roots: string[] = [], owner = '0x' + '1'.repeat(40), sourceRunId = '0x' + '2'.repeat(64);
const loader = pathToFileURL(resolve('node_modules/tsx/dist/esm/index.mjs')).href;
const moduleUrl = new URL('../src/sdk/declared-state-checkpoint.ts', import.meta.url).href;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const socket = process.env.TELOMERE_ACCEPTANCE_GVISOR_SOCKET, actualImage = process.env.TELOMERE_ACCEPTANCE_GVISOR_IMAGE;
if (Boolean(socket) !== Boolean(actualImage) || socket && (process.platform !== 'linux'
  || !/^\/run\/telomere-[a-z0-9-]+\/docker\.sock$/.test(socket))) throw new Error('Use the explicitly isolated Linux acceptance daemon and image together');
if (actualImage) imageDigestSchema.parse(actualImage);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('telomere-declared-checkpoint-')
      || (await files.lstat(absolute)).isSymbolicLink()) throw new Error('Unexpected cleanup scope');
    await files.rm(absolute, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await files.mkdtemp(join(tmpdir(), 'telomere-declared-checkpoint-')); roots.push(root);
  const sourceDirectory = join(root, 'application'), scratchDirectory = join(root, 'scratch');
  await files.mkdir(sourceDirectory, { mode: 0o700 }); await files.mkdir(scratchDirectory, { mode: 0o700 });
  await files.mkdir(join(sourceDirectory, 'nested'), { mode: 0o700 });
  await files.mkdir(join(sourceDirectory, 'empty'), { mode: 0o700 });
  await files.writeFile(join(sourceDirectory, 'nested', 'state.json'), '{"counter":7,"secret":"declared-cell-state"}', { mode: 0o600 });
  return { root, sourceDirectory, scratchDirectory, sourceRunId, operationId: 'cyst-hook-' + '3'.repeat(64) };
}

function options(input: Awaited<ReturnType<typeof fixture>>) { const { root: _root, ...value } = input; return value; }

it('returns an existing-port checkpoint containing nested data/empty directories, restores it into a fresh directory', async () => {
  const input = await fixture(), output = await captureDeclaredStateCheckpoint(options(input));
  expect(output).toMatchObject({ protocol: 'telomere-paid-app-checkpoint-v1', sourceRunId, operationId: input.operationId });
  const bundle = Buffer.from(output.stateBase64, 'base64'); expect(bundle.length).toBeLessThanOrEqual(4096);
  expect(await files.readdir(input.scratchDirectory)).toEqual([]);
  const bundlePath = join(input.root, 'owner-state.bin'); await files.writeFile(bundlePath, bundle, { mode: 0o600 });
  const destinationDirectory = join(input.root, 'fresh-target');
  const restored = await restoreDeclaredStateBundle({ bundlePath, destinationDirectory, expectedSha256: sha(bundle), expectedBytes: bundle.length });
  expect(restored.manifest.directories).toEqual(['empty', 'nested']);
  expect(JSON.parse(await files.readFile(join(destinationDirectory, 'nested', 'state.json'), 'utf8'))).toEqual({ counter: 7, secret: 'declared-cell-state' });
  expect(await files.readdir(join(destinationDirectory, 'empty'))).toEqual([]); bundle.fill(0);
});

async function filePrototype(path: string) { const probe = await files.open(path, 'r'); const prototype: Pick<FileHandle, 'sync'> = Object.getPrototypeOf(probe); await probe.close(); return prototype; }
async function retainedPath(input: Awaited<ReturnType<typeof fixture>>) {
  const child = (await files.readdir(input.scratchDirectory)).find(name => name.startsWith('.capture-'));
  return child ? join(input.scratchDirectory, child, 'state.bin') : undefined;
}

it('overwrites the exact published scratch inode with zeros before unlinking it', async () => {
  const input = await fixture(), prototype = await filePrototype(join(input.sourceDirectory, 'nested/state.json'));
  const sync = prototype.sync; let observedWipe = false;
  vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    await sync.call(this); const path = await retainedPath(input);
    if (path && await files.lstat(path).then(() => true).catch(() => false)) {
      const named = await files.lstat(path, { bigint: true }), actual = await this.stat({ bigint: true });
      if (named.ino === actual.ino && named.dev === actual.dev) { const raw = await files.readFile(path); observedWipe = raw.length > 0 && raw.every(byte => byte === 0); }
    }
  });
  await captureDeclaredStateCheckpoint(options(input)); expect(observedWipe).toBe(true);
  expect(await files.readdir(input.scratchDirectory)).toEqual([]);
});

it('refuses a whole bundle above4096 bytes without changing its application or retaining scratch output', async () => {
  const input = await fixture(); await files.writeFile(join(input.sourceDirectory, 'large.bin'), Buffer.alloc(4096, 0x71), { mode: 0o600 });
  await expect(captureDeclaredStateCheckpoint(options(input))).rejects.toThrow();
  expect((await files.readFile(join(input.sourceDirectory, 'large.bin'))).length).toBe(4096);
  expect(await files.readdir(input.scratchDirectory)).toEqual([]); expect(DECLARED_STATE_CHECKPOINT_MAX_BYTES).toBe(4096);
});

it('refuses cancellation before capture and during the final wipe without returning success', async () => {
  const input = await fixture(), controller = new AbortController(); controller.abort();
  await expect(captureDeclaredStateCheckpoint({ ...options(input), signal: controller.signal })).rejects.toThrow();
  expect(await files.readdir(input.scratchDirectory)).toEqual([]);
  const late = new AbortController(), prototype = await filePrototype(join(input.sourceDirectory, 'nested/state.json')), sync = prototype.sync;
  let abortedDuringWipe = false;
  vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    await sync.call(this); const path = await retainedPath(input);
    if (path) {
      const named = await files.lstat(path, { bigint: true }).catch(() => undefined), actual = await this.stat({ bigint: true });
      if (named && named.ino === actual.ino && named.dev === actual.dev) { abortedDuringWipe = true; late.abort(); }
    }
  });
  await expect(captureDeclaredStateCheckpoint({ ...options(input), signal: late.signal })).rejects.toThrow();
  expect(abortedDuringWipe).toBe(true); expect(await files.readdir(input.scratchDirectory)).toEqual([]);
});

it('preserves a foreign file replacing the captured name during awaited close', async () => {
  const input = await fixture(), prototype = await filePrototype(join(input.sourceDirectory, 'nested/state.json')), sync = prototype.sync;
  let foreignPath: string | undefined;
  vi.spyOn(prototype, 'sync').mockImplementation(async function(this: FileHandle) {
    await sync.call(this); const path = await retainedPath(input);
    if (!path || foreignPath) return;
    const named = await files.lstat(path, { bigint: true }).catch(() => undefined), actual = await this.stat({ bigint: true });
    if (named && named.ino === actual.ino && named.dev === actual.dev) {
      const close = this.close.bind(this); this.close = async () => {
        await close(); foreignPath = path;
        await files.rename(path, path + '.original'); await files.writeFile(path, 'foreign-keep', { mode: 0o600, flag: 'wx' });
      };
    }
  });
  await expect(captureDeclaredStateCheckpoint(options(input))).rejects.toThrow('checkpoint refused');
  expect(foreignPath).toBeDefined(); expect(await files.readFile(foreignPath!, 'utf8')).toBe('foreign-keep');
});

it('refuses completion markers and traversal-like names rather than silently filtering the captured tree', async () => {
  const input = await fixture(); await files.writeFile(join(input.sourceDirectory, DECLARED_STATE_RECEIPT), '{}', { mode: 0o600 });
  await expect(captureDeclaredStateCheckpoint(options(input))).rejects.toThrow();
  await files.unlink(join(input.sourceDirectory, DECLARED_STATE_RECEIPT));
  await files.writeFile(join(input.sourceDirectory, 'CON'), 'refused', { mode: 0o600 });
  await expect(captureDeclaredStateCheckpoint(options(input))).rejects.toThrow();
  expect(await files.readdir(input.scratchDirectory)).toEqual([]);
});

it.skipIf(process.platform === 'win32')('refuses source/scratch symlinks and executable data', async () => {
  const input = await fixture(), alias = join(input.root, 'alias'); await files.symlink(input.sourceDirectory, alias);
  await expect(captureDeclaredStateCheckpoint({ ...options(input), sourceDirectory: alias })).rejects.toThrow();
  await files.unlink(alias); await files.symlink(input.scratchDirectory, alias);
  await expect(captureDeclaredStateCheckpoint({ ...options(input), scratchDirectory: alias })).rejects.toThrow();
  await files.chmod(join(input.sourceDirectory, 'nested', 'state.json'), 0o700);
  await expect(captureDeclaredStateCheckpoint(options(input))).rejects.toThrow();
  expect(await files.readdir(input.scratchDirectory)).toEqual([]);
});

it('rejects selectable CLI paths and malformed run/operation arguments before touching fixed Cell directories', async () => {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', loader, 'scripts/declared-state-cell-capture.ts', sourceRunId, 'valid', '/host/path'],
      { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI fixture deadline')); }, 10_000);
    let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
  expect(result).toEqual({ code: 1, stdout: '', stderr: 'Declared state checkpoint refused\n' });
}, 15_000);

it(`uses actual signed HTTP HostKit commands and encrypted Cyst upload, replaying the original tree after source cleanup (${socket ? 'real gVisor' : 'local process fixture'})`, async () => {
  const input = await fixture(), cells = join(input.root, 'cells'); await files.mkdir(cells, { mode: 0o700 });
  const journal = await openHostJournal(':memory:'), control = new Ed25519Identity();
  const image = actualImage ?? 'fixture/session@sha256:' + 'a'.repeat(64), node = socket ? '/usr/local/bin/node' : process.execPath;
  const backend = new LocalSessionFixtureBackend(cells, 'test-fixture-only');
  const hosted = socket ? createDockerHostedHostKit({ journal, controlKey: control.publicKey, reviewedImages: new Set([image]),
    isolation: 'gvisor', socketPath: socket }) : createHostedHostKit({ journal, runtime: new LocalProcessFixtureRuntime('test-fixture-only'), backend,
    controlKey: control.publicKey, reviewedImages: new Set([image]), scope: { version: 1, hostKey: journal.identity.publicKey,
      controlKey: control.publicKey, isolation: 'local_process_fixture', runtime: canonical(['declared-checkpoint-fixture', input.root]),
      sessionBackend: backend.identity }, inventory: async () => [] });
  let paid: PaidHostSessionAgent | undefined, server: Server | undefined, vault: CystCheckpointFileVault | undefined;
  let meterTimer: ReturnType<typeof setInterval> | undefined, meterFlight: Promise<void> | undefined, meterFailure: unknown;
  const store = await openStore({ DATA_DIR: join(input.root, 'db') }), masterKey = randomBytes(32);
  try {
    await hosted.initialize(); paid = new PaidHostSessionAgent(journal, hosted.sessions, control.publicKey); await paid.initialize();
    const cysts = new CystService(store.db, join(input.root, 'cysts')); await cysts.initialize();
    const app = new Hono();
    app.get('/api/me', context => context.json({ address: owner, demo: false }));
    app.route('/api/cysts', createCystRoutes(cysts, async () => owner));
    // Separate host origin has its normal /v1 routes; Cyst fixture authenticates
    // one fixed test owner. No chain reservation, hardware isolation or public provider is claimed.
    app.route('/', createHostKitRoutes(hosted.agent, paid));
    server = createServer(getRequestListener(app.fetch)); await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const origin = `http://127.0.0.1:${address.port}`, host = new HostKitClient(origin, journal.identity.publicKey, control, !socket);
    const runId = randomId(), now = Date.now(), spec = { version: 1 as const, sessionId: runId, image, lifetimeSeconds: 60, policy: paidSessionPolicy(4) };
    const body: HostLease = { version: 1, hostKey: journal.identity.publicKey, runId, owner, image, argv: [...PAID_SESSION_ARGV],
      stdin: JSON.stringify({ spec, quoteHash: randomId(), admissionTx: randomId() }), issuedAt: now,
      expiresAt: now + 60_000, maxSeconds: 60, nonce: randomId() };
    const lease = control.sign('lease', body); await host.sessionAdmit(lease);
    const meter = new HostMeterVerifier(lease.body, control);
    const acknowledge = async () => {
      const status = await host.sessionControl(lease, { action: 'status' });
      for (const tick of status.ticks.slice(status.acks.length)) await host.sessionControl(lease, { action: 'ack', ack: meter.accept(tick) });
    };
    await acknowledge();
    meterTimer = setInterval(() => {
      if (!meterFlight) meterFlight = acknowledge().catch(error => { meterFailure = error; }).finally(() => { meterFlight = undefined; });
    }, 1000).unref();
    const application = socket ? '/tmp/telomere-declared-application' : 'application';
    const directories = [application, application + '/nested', application + '/empty', ...(socket ? [] : ['scratch'])];
    const write = `const fs=require('node:fs');for(const p of ${JSON.stringify(directories)})fs.mkdirSync(p,{mode:448});fs.writeFileSync(${JSON.stringify(application + '/nested/state.json')},'{"counter":7,"secret":"declared-cell-state"}',{mode:384});`;
    expect((await host.sessionControl(lease, { action: 'execute', command: { commandId: 'application-write', argv: [node, '-e', write] } })).command?.state).toBe('completed');
    let loseResponse = true;
    const client = { command: async (_run: string, command: unknown) => {
      const response = await host.sessionControl(lease, { action: 'execute', command: sessionCommandSchema.parse(command) });
      if (loseResponse) { loseResponse = false; throw new Error('Lost checkpoint response'); }
      if (!response.command) throw new Error('Missing signed command'); return response.command;
    } };
    const program = `import(${JSON.stringify(moduleUrl)}).then(async m=>{const p=await import('node:path');const [sourceRunId,operationId]=process.argv.slice(1);process.stdout.write(JSON.stringify(await m.captureDeclaredStateCheckpoint({sourceDirectory:p.resolve('application'),scratchDirectory:p.resolve('scratch'),sourceRunId,operationId})));}).catch(()=>{process.stderr.write('refused');process.exitCode=1})`;
    const argvPrefix = socket ? [node, '/opt/telomere/declared-state-cell-capture.cjs'] : [node, '--import', loader, '-e', program];
    const runner = new PaidSessionCheckpointRunner({ client, argvPrefix, maxBytes: 4096 });
    const vaultPath = join(input.root, 'owner-vault'); await files.mkdir(vaultPath, { mode: 0o700 });
    vault = new CystCheckpointFileVault({ directory: vaultPath, masterKey });
    const coordinator = () => new CystCheckpointCoordinator({ owner, agent: owner, applicationSchema: 'declared-small.v1',
      cysts: new CystClient(new ApiTransport(origin)), vault: vault!, onCyst: ({ operationId }) => runner.checkpoint(runId, operationId) });
    await expect(coordinator().snapshot()).rejects.toThrow('Lost checkpoint response');
    const [saved] = await journal.db.select().from(hostSessions), retained = saved?.record?.commands.find(row => row.command.commandId.startsWith('cp'));
    expect(retained?.state).toBe('completed'); const capturedOutput = retained?.stdout;
    await host.sessionControl(lease, { action: 'execute', command: { commandId: 'application-mutate',
      argv: [node, '-e', `require('node:fs').writeFileSync(${JSON.stringify(application + '/nested/state.json')},'changed',{mode:384})`] } });
    clearInterval(meterTimer); await meterFlight; if (meterFailure) throw meterFailure;
    await host.sessionControl(lease, { action: 'stop' });
    vault.close(); vault = new CystCheckpointFileVault({ directory: vaultPath, masterKey });
    expect(await coordinator().retryPending()).toMatchObject({ status: 'uploaded' });
    const state = await coordinator().restoreLatest(), bundlePath = join(input.root, 'recovered.bin');
    await files.writeFile(bundlePath, state, { mode: 0o600 });
    await restoreDeclaredStateBundle({ bundlePath, destinationDirectory: join(input.root, 'fresh-directory'), expectedBytes: state.length, expectedSha256: sha(state) });
    state.fill(0); expect((await cysts.list(owner)).usage.checkpoints).toBe(1);
    expect(JSON.parse(await files.readFile(join(input.root, 'fresh-directory/nested/state.json'), 'utf8'))).toMatchObject({ counter: 7 });
    if (socket) expect(await inspectHostInventory({ hostKey: journal.identity.publicKey, socketPath: socket })).toEqual([]);
    else expect(await files.readdir(join(cells, runId.slice(2), 'scratch'))).toEqual([]);
    const [replayed] = await journal.db.select().from(hostSessions);
    expect(replayed?.record?.commands.find(row => row.command.commandId.startsWith('cp'))?.stdout).toBe(capturedOutput);
    expect(replayed?.record?.commands).toHaveLength(3);
    for (const name of await files.readdir(join(input.root, 'cysts'))) expect((await files.readFile(join(input.root, 'cysts', name))).toString()).not.toContain('declared-cell-state');
  } finally {
    clearInterval(meterTimer); await meterFlight;
    vault?.close(); masterKey.fill(0); await paid?.close().catch(() => undefined); await hosted.close().catch(() => undefined);
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
    await journal.close(); await store.close();
  }
}, socket ? 120_000 : 30_000);
