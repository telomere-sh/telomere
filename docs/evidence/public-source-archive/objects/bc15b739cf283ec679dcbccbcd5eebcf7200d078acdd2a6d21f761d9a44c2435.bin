import { createServer, type Server } from 'node:http';
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomId } from '../src/common.js';
import { createHostKitRoutes, HostKitAgent } from '../src/host-kit/agent.js';
import { HostKitClient, HostKitCommandExecutor } from '../src/host-kit/client.js';
import { DockerHostRuntime } from '../src/host-kit/docker-runtime.js';
import { hostRuns, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, signedLeaseSchema, verifyHostMessage,
  type HostLease, type SignedHostLease } from '../src/host-kit/protocol.js';
import type { HostCell, HostCellRuntime, InitHeartbeat } from '../src/host-kit/runtime.js';
import { executeCommand } from '../src/runtime/command.js';

// Explicit acceptance only: no inherited socket/image override or Docker fallback.
const enabled = process.platform === 'linux' && process.env.TELOMERE_HOST_STARTUP_DOCKER_ACCEPTANCE === '1';
const image = '127.0.0.1:15002/telomere-cpu@sha256:6839949540d11906cbdbc614867ac3a825fa0e6f8cbed90c79773979517b4bbe';
const socket = '/var/run/telomere-host-docker/docker.sock', parent = '/opt/telomere-host-runtime';
const owner = '0x1111111111111111111111111111111111111111';
const nextOwner = '0x2222222222222222222222222222222222222222';
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function until(predicate: () => boolean | Promise<boolean>, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (!await predicate()) { if (performance.now() >= deadline) throw new Error('Owned HostKit acceptance timed out'); await pause(25); }
}
async function docker(args: string[], maximum = 16_384) {
  return executeCommand('docker', ['--host', 'unix://' + socket, ...args], { signal: AbortSignal.timeout(5000), maxOutputBytes: maximum });
}

describe.skipIf(!enabled)('actual reviewed gVisor HostKit signed startup deadlines', () => {
  let directory: string, journal: HostJournal, control: Ed25519Identity, runtime: ObservedRuntime;
  let agent: HostKitAgent, server: Server, client: HostKitClient;
  const flights: Promise<unknown>[] = [];
  let arrivals: { runId: string; at: number }[];

  class ObservedRuntime implements HostCellRuntime {
    readonly isolation = 'gvisor' as const;
    readonly release = gate(); readonly entered = gate();
    readonly starts: string[] = []; readonly stopAttempts: string[] = []; readonly stopCompleted: string[] = [];
    readonly createNames: string[] = []; readonly inventoriesBeforeCreate: string[][] = [];
    readonly cells: HostCell[] = [];
    heldRunId: string | undefined; mode: 'before' | 'after' | 'none' = 'none'; cleanupCalls = 0;
    readonly underlying = new DockerHostRuntime({ isolation: 'gvisor', socketPath: socket,
      command: async (args, options) => {
        if (args[0] === 'create') this.createNames.push(args[args.indexOf('--name') + 1]!);
        return executeCommand('docker', ['--host', 'unix://' + socket, ...args], options);
      } });
    initialize(hostKey: string) { return this.underlying.initialize(hostKey); }
    cleanupOrphans(hostKey: string) { this.cleanupCalls++; return this.underlying.cleanupOrphans(hostKey); }
    async inventory() {
      const value = await docker(['ps', '--all', '--filter', 'label=telomere.hostkit=true',
        '--filter', 'label=telomere.host_key=' + journal.identity.publicKey, '--format', '{{.Names}}']);
      expect(value.exitCode).toBe(0);
      const names = value.stdout.trim() ? value.stdout.trim().split('\n') : [];
      expect(names.every(name => name.startsWith('tlmr-hostkit-' + journal.identity.publicKey.slice(2, 10) + '-'))).toBe(true);
      return names;
    }
    async start(lease: HostLease, heartbeat: (value: InitHeartbeat) => void): Promise<HostCell> {
      this.starts.push(lease.runId);
      if (lease.runId === this.heldRunId && this.mode === 'before') { this.entered.release(); await this.release.promise; }
      this.inventoriesBeforeCreate.push(await this.inventory());
      const actual = await this.underlying.start(lease, heartbeat);
      const cell: HostCell = { wait: actual.wait, sample: () => actual.sample(), stop: async () => {
        this.stopAttempts.push(lease.runId); await actual.stop(); this.stopCompleted.push(lease.runId);
      } }; this.cells.push(cell);
      if (lease.runId === this.heldRunId && this.mode === 'after') { this.entered.release(); await this.release.promise; }
      return cell;
    }
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(parent, 'host-kit-startup-cell-')); await chmod(directory, 0o700);
    journal = await openHostJournal(join(directory, 'host')); control = new Ed25519Identity(); runtime = new ObservedRuntime();
    // Public fixture ownership only, so the isolated runner can recover its own
    // exact namespaces after a killed test process without reading any key file.
    await mkdir(resolve('.local'), { recursive: true, mode: 0o700 });
    await appendFile(resolve('.local/host-kit-startup-owned.jsonl'), JSON.stringify({
      hostKey: journal.identity.publicKey, directory: basename(directory),
    }) + '\n', { mode: 0o600 });
    agent = new HostKitAgent(journal, runtime, control.publicKey, new Set([image])); await agent.initialize();
    arrivals = [];
    // Record actual HTTP handler arrival before entering the real signed agent queue.
    const routes = new Hono(); routes.use('*', async (context, next) => {
      if (context.req.path === '/v1/leases') { const lease = signedLeaseSchema.parse(await context.req.json()); arrivals.push({ runId: lease.body.runId, at: Date.now() }); }
      await next();
    }); routes.route('/', createHostKitRoutes(agent));
    server = createServer(getRequestListener(routes.fetch)); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned HostKit HTTP address missing');
    client = new HostKitClient('http://127.0.0.1:' + address.port, journal.identity.publicKey, control);
  });
  afterEach(async () => {
    runtime?.release.release();
    try {
      await Promise.allSettled(flights.splice(0)); await agent?.close();
      if (runtime) {
        for (const cell of runtime.cells) await cell.stop().catch(() => undefined);
        await runtime.underlying.cleanupOrphans(journal.identity.publicKey); expect(await runtime.inventory()).toEqual([]);
      }
    } finally {
      if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
      await journal?.close();
      if (directory) {
        const owned = resolve(directory);
        if (dirname(owned) !== parent || !basename(owned).startsWith('host-kit-startup-cell-')) throw new Error('Unexpected owned HostKit fixture');
        await rm(owned, { recursive: true, force: true });
      }
    }
  });

  function lease(maxSeconds = 20, expiresAfter = maxSeconds * 1000, argv = ['/usr/local/bin/node', '-e', 'setInterval(()=>{},1000);']) {
    const now = Date.now(); return control.sign('lease', { version: 1 as const, hostKey: journal.identity.publicKey,
      runId: randomId(), owner, image, argv, issuedAt: now, expiresAt: now + expiresAfter, maxSeconds, nonce: randomId() });
  }
  function admission(value: SignedHostLease) { const request = client.admit(value); flights.push(request); void request.catch(() => undefined); return request; }
  async function row(value: SignedHostLease) { return (await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, value.body.runId)))[0]; }
  async function terminal(value: SignedHostLease) {
    await until(async () => { const valueRow = await row(value); return Boolean(valueRow && !['starting', 'running'].includes(valueRow.state)); });
    const result = await client.command(value, 'status'); expect(result.cleanupConfirmed).toBe(true);
    expect(result.billableSeconds).toBe(0); expect((await row(value))?.leaseHash).toBe(hostMessageHash(value));
    expect(await runtime.inventory()).toEqual([]); return result;
  }
  async function successor() {
    const path = join(directory, 'controller-evidence.jsonl');
    const persist = async (value: unknown) => { const file = await open(path, 'a', 0o600);
      try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); } };
    const input = { runId: randomId(), maxSeconds: 10, argv: ['/usr/local/bin/node', '-e', 'process.stdout.write("next-owner-ok");'] };
    const result = await new HostKitCommandExecutor(client, nextOwner, image, {
      onLease: value => persist({ kind: 'lease', lease: value }),
      onEvidence: (tick, ack) => persist({ kind: 'evidence', tick, ack }),
    }).run(input, new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', output: 'next-owner-ok', exitCode: 0 });
    const saved = (await journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId)))[0]!;
    expect(saved.owner).toBe(nextOwner); expect(saved.cleanupConfirmed).toBe(true); expect(saved.ticks.length).toBe(saved.acks.length);
    expect(saved.ticks.every(value => verifyHostMessage(journal.identity.publicKey, 'tick', value))).toBe(true);
    expect(saved.acks.every(value => verifyHostMessage(control.publicKey, 'ack', value))).toBe(true);
    const evidence = (await readFile(path, 'utf8')).trim().split('\n'); expect(evidence.length).toBe(1 + saved.ticks.length);
    expect(runtime.inventoriesBeforeCreate.every(value => value.length === 0)).toBe(true);
    expect(await runtime.inventory()).toEqual([]);
  }
  function backgroundLease(seconds: number) {
    const tag = 'owned-' + randomId().slice(2, 18);
    const grandchild = 'setInterval(()=>{},1000);';
    const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},${JSON.stringify(tag + '-grandchild')}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
    const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},${JSON.stringify(tag + '-child')}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`;
    return { tag, signed: lease(seconds, seconds * 1000, ['/usr/local/bin/node', '-e', program, tag + '-parent']) };
  }
  async function descendants(tag: string) {
    const name = runtime.createNames.at(-1)!; expect(name).toBeDefined();
    const inspected = await docker(['inspect', '--format', '{{json .HostConfig}}', name]); expect(inspected.exitCode).toBe(0);
    const config = JSON.parse(inspected.stdout) as Record<string, unknown>;
    expect(config).toMatchObject({ Runtime: 'runsc', NetworkMode: 'none', ReadonlyRootfs: true,
      Memory: 268_435_456, MemorySwap: 268_435_456, PidsLimit: 64, CapDrop: ['ALL'] });
    const probe = "const f=require('node:fs');process.stdout.write(JSON.stringify(f.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)).flatMap(n=>{try{return f.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0');}catch{return[];}})));";
    await until(async () => { const value = await docker(['exec', name, '/usr/local/bin/node', '-e', probe]);
      if (value.exitCode !== 0) return false; const args = JSON.parse(value.stdout) as string[];
      return ['parent', 'child', 'grandchild'].every(kind => args.includes(tag + '-' + kind)); }, 4000);
    return name;
  }

  it('rejects a signed lease that actually expires in the admission queue without reserving or starting it', async () => {
    const first = lease(); runtime.mode = 'after'; runtime.heldRunId = first.body.runId;
    const running = admission(first); await runtime.entered.promise;
    const queued = lease(1, 500), waiting = admission(queued); await until(() => arrivals.some(value => value.runId === queued.body.runId));
    expect(arrivals.find(value => value.runId === queued.body.runId)!.at).toBeLessThan(queued.body.expiresAt);
    await pause(Math.max(0, queued.body.expiresAt - Date.now() + 100)); runtime.release.release();
    expect((await running).state).toBe('running'); await expect(waiting).rejects.toThrow('(403)');
    expect(await row(queued)).toBeUndefined(); expect(runtime.starts).toEqual([first.body.runId]);
    expect(await client.command(first, 'stop')).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    await successor();
  }, 30_000);

  it('removes the actual parent and detached descendants at deadline while the created handle is still withheld', async () => {
    const { signed, tag } = backgroundLease(6); runtime.mode = 'after'; runtime.heldRunId = signed.body.runId;
    const pending = admission(signed); await runtime.entered.promise; await descendants(tag);
    await until(async () => runtime.cleanupCalls >= 2 && (await runtime.inventory()).length === 0, 9000);
    expect(agent.identity().ready).toBe(false); expect((await row(signed))?.cleanupConfirmed).toBe(false);
    const next = control.sign('lease', { ...lease().body, owner: nextOwner });
    const contender = admission(next).then(value => { expect(value.state).toBe('running'); return 'admitted'; }, error => {
      expect(error).toBeInstanceOf(Error); expect((error as Error).message).toMatch(/\((409|503)\)/); return 'rejected';
    });
    await until(() => arrivals.some(value => value.runId === next.body.runId)); await pause(75);
    expect(runtime.starts).toEqual([signed.body.runId]); runtime.release.release();
    expect(await pending).toMatchObject({ state: 'timed_out', cleanupConfirmed: true });
    const outcome = await contender;
    if (outcome === 'admitted') expect(await client.command(next, 'stop')).toMatchObject({ cleanupConfirmed: true });
    expect(runtime.stopCompleted).toContain(signed.body.runId); expect(agent.identity().ready).toBe(true);
    await terminal(signed); await successor();
  }, 30_000);

  it('cleans a real container created only after startup expiry before releasing the slot to a successor', async () => {
    const signed = lease(1); runtime.mode = 'before'; runtime.heldRunId = signed.body.runId;
    const pending = admission(signed); await runtime.entered.promise;
    await until(() => runtime.cleanupCalls >= 2, 3000);
    expect(runtime.createNames).toEqual([]); expect(agent.identity().ready).toBe(false);
    expect((await row(signed))?.cleanupConfirmed).toBe(false); runtime.release.release();
    expect(await pending).toMatchObject({ state: 'timed_out', cleanupConfirmed: true });
    expect(runtime.createNames).toHaveLength(1); expect(runtime.stopCompleted).toContain(signed.body.runId);
    await terminal(signed); await successor();
  }, 30_000);

  it('charges startup delay against the original lease budget and does not grant a fresh runtime window', async () => {
    const signed = lease(4); runtime.mode = 'before'; runtime.heldRunId = signed.body.runId;
    const pending = admission(signed); await runtime.entered.promise;
    await pause(Math.max(0, signed.body.expiresAt - Date.now() - 1500)); runtime.release.release();
    const admitted = await pending; expect(['running', 'timed_out']).toContain(admitted.state);
    const result = await terminal(signed); expect(result.state).toBe('timed_out');
    // A restarted four-second timer would exceed this bound by more than a second.
    expect(Date.now() - signed.body.expiresAt).toBeLessThan(2000);
    expect(runtime.stopCompleted).toContain(signed.body.runId); await successor();
  }, 30_000);
});
