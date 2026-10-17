import { createServer, type Server } from 'node:http';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { randomId } from '../src/common.js';
import { HostKitClient, HostKitCommandExecutor, hostCommandInputSchema, type HostKitObserver } from '../src/host-kit/client.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { Ed25519Identity, hostMessageHash, signedAckSchema, signedLeaseSchema, type SignedHostAck, type SignedHostLease, type SignedHostTick } from '../src/host-kit/protocol.js';
import { hostRuns, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { validateCpuResult } from '../src/runtime/validation.js';
import { HostTextOutput, hostInitFrameSchema } from '../src/host-kit/text-output.js';

const owner = '0x1111111111111111111111111111111111111111';
const image = `registry.example/telomere/cpu@sha256:${'a'.repeat(64)}`;

describe('bounded generic commands through real HostKit HTTP and child execution', () => {
  let journal: HostJournal | undefined, agent: HostKitAgent | undefined, server: Server | undefined, directory: string | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await agent?.close(); await journal?.close();
    if (directory) {
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-host-command-')) throw new Error('Fixture cleanup target rejected');
      await rm(target, { recursive: true, force: true });
    }
    journal = undefined; agent = undefined; server = undefined; directory = undefined;
  });
  async function start() {
    directory = await mkdtemp(join(tmpdir(), 'telomere-host-command-'));
    journal = await openHostJournal(join(directory, 'host'));
    const control = new Ed25519Identity(), runtime = new LocalProcessFixtureRuntime('test-fixture-only');
    agent = new HostKitAgent(journal, runtime, control.publicKey, new Set([image])); await agent.initialize();
    server = createServer(getRequestListener(createHostKitRoutes(agent).fetch));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Host HTTP address missing');
    const url = `http://127.0.0.1:${address.port}`, client = new HostKitClient(url, journal.identity.publicKey, control, true);
    return { client, control, runtime, url, journal, directory };
  }
  function command(program: string, maxSeconds = 20, stdin?: string) {
    return { runId: randomId(), maxSeconds, argv: [process.execPath, '-e', program], ...(stdin === undefined ? {} : { stdin }) };
  }
  async function saved(path: string, value: unknown) {
    const file = await open(path, 'a');
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  }

  it('executes arbitrary reviewed-image argv and Unicode stdin without a shell or fixed task runner', async () => {
    const fixture = await start(), stdin = 'Привет 🌍\nline two';
    const input = command('let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({input,arg:process.argv[1]})));');
    input.argv.push('argument with spaces; literal $(no-shell)');
    const executor = new HostKitCommandExecutor(fixture.client, owner, image);
    const result = await executor.run({ ...input, stdin }, new AbortController().signal);
    expect(result.status).toBe('completed'); expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ input: stdin, arg: 'argument with spaces; literal $(no-shell)' });
    expect(validateCpuResult(result, input.runId, input.maxSeconds)).toEqual(result);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.lease.body.argv).toEqual(input.argv); expect(row?.lease.body.stdin).toBe(stdin);
    expect(row?.cleanupConfirmed).toBe(true); expect(await fixture.runtime.cleanupOrphans(fixture.journal.identity.publicKey)).toEqual([]);
  });

  it('persists the original lease before admission and paired evidence before callbacks and host ACK', async () => {
    const fixture = await start(), path = join(fixture.directory, 'controller-evidence.jsonl');
    const entrySchema = z.object({ kind: z.string(), lease: signedLeaseSchema.optional(), ack: signedAckSchema.optional() }).passthrough();
    const entries = async () => (await readFile(path, 'utf8')).trim().split('\n').map(value => entrySchema.parse(JSON.parse(value)));
    let admissionChecks = 0, acknowledgementChecks = 0, observationChecks = 0;
    class DurabilityClient extends HostKitClient {
      override async admit(lease: SignedHostLease) {
        const records = await entries(); expect(records[0]?.kind).toBe('lease');
        expect(hostMessageHash(records[0]!.lease!)).toBe(hostMessageHash(lease)); admissionChecks++;
        return super.admit(lease);
      }
      override async command(lease: SignedHostLease, action: 'status' | 'stop' | 'ack', ack?: SignedHostAck) {
        if (action === 'ack') {
          const records = await entries(); expect(records.some(record => record.ack && hostMessageHash(record.ack) === hostMessageHash(ack!))).toBe(true);
          acknowledgementChecks++;
        }
        return super.command(lease, action, ack);
      }
    }
    const observer: HostKitObserver = {
      onLease: lease => saved(path, { kind: 'lease', lease }),
      onEvidence: (tick, ack) => saved(path, { kind: 'evidence', tick, ack }),
    };
    const client = new DurabilityClient(fixture.url, fixture.journal.identity.publicKey, fixture.control, true);
    const input = command('setTimeout(()=>process.stdout.write("generic-metered"),11000)');
    const result = await new HostKitCommandExecutor(client, owner, image, observer).run(input, new AbortController().signal, async () => {
      expect((await entries()).at(-1)?.kind).toBe('evidence'); observationChecks++;
    });
    expect(result.status).toBe('completed'); expect(result.output).toBe('generic-metered');
    expect(result.billableSeconds).toBeGreaterThanOrEqual(3); expect(result.billableSeconds).toBeLessThanOrEqual(10);
    expect(admissionChecks).toBe(1); expect(acknowledgementChecks).toBeGreaterThanOrEqual(3); expect(observationChecks).toBeGreaterThanOrEqual(2);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.billableSeconds).toBe(result.billableSeconds); expect(row?.cleanupConfirmed).toBe(true);
  }, 30_000);

  it('stops the original child on cancellation and confirms removal before returning', async () => {
    const fixture = await start(), abort = new AbortController(), input = command('setTimeout(()=>{},60000)');
    const result = await new HostKitCommandExecutor(fixture.client, owner, image).run(input, abort.signal, async tick => {
      if (tick.state === 'running') abort.abort();
    });
    expect(result.status).toBe('cancelled'); expect(result.billableSeconds).toBe(0);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.state).toBe('cancelled'); expect(row?.cleanupConfirmed).toBe(true);
    expect(await fixture.runtime.cleanupOrphans(fixture.journal.identity.publicKey)).toEqual([]);
  });

  it('drains a terminal tick revealed by the first ACK before returning the completed result', async () => {
    const fixture = await start(); let firstAckRevealedTerminal = false;
    class DelayedAdmissionClient extends HostKitClient {
      override async admit(lease: SignedHostLease) {
        const captured = await super.admit(lease);
        expect(captured.state).toBe('running'); expect(captured.ticks).toHaveLength(1); expect(captured.acks).toHaveLength(0);
        const deadline = Date.now() + 5000;
        for (;;) {
          const actual = await super.command(lease, 'status');
          if (!['starting', 'running'].includes(actual.state)) {
            expect(actual.state).toBe('completed'); expect(actual.cleanupConfirmed).toBe(true);
            expect(actual.ticks.length).toBeGreaterThan(captured.ticks.length); return captured;
          }
          if (Date.now() >= deadline) throw new Error('Original command did not reach its terminal state');
          await new Promise<void>(resolve => setTimeout(resolve, 25));
        }
      }
      override async command(lease: SignedHostLease, action: 'status' | 'stop' | 'ack', ack?: SignedHostAck) {
        const state = await super.command(lease, action, ack);
        if (action === 'ack' && ack?.body.sequence === 0) {
          firstAckRevealedTerminal = state.state === 'completed' && state.ticks.length > state.acks.length;
        }
        return state;
      }
    }
    const observed: { tick: SignedHostTick; ack: SignedHostAck }[] = [];
    const observer: HostKitObserver = { onLease: async () => undefined, onEvidence: async (tick, ack) => { observed.push({ tick, ack }); } };
    const client = new DelayedAdmissionClient(fixture.url, fixture.journal.identity.publicKey, fixture.control, true);
    const input = command('setTimeout(()=>process.stdout.write("terminal-race-ok"),500)');
    const result = await new HostKitCommandExecutor(client, owner, image, observer).run(input, new AbortController().signal);
    expect(firstAckRevealedTerminal).toBe(true); expect(result).toMatchObject({ status: 'completed', output: 'terminal-race-ok', exitCode: 0 });
    expect(validateCpuResult(result, input.runId, input.maxSeconds)).toEqual(result);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.cleanupConfirmed).toBe(true); expect(row?.ticks).toHaveLength(2); expect(row?.acks).toHaveLength(2);
    expect(observed).toHaveLength(2); expect(observed.at(-1)?.tick.body.state).toBe('EXITED');
    expect(row?.acks.map(ack => ack.body.tickHash)).toEqual(row?.ticks.map(hostMessageHash));
    expect(observed.map(item => hostMessageHash(item.tick))).toEqual(row?.ticks.map(hostMessageHash));
    expect(observed.map(item => hostMessageHash(item.ack))).toEqual(row?.acks.map(hostMessageHash));
  });

  it('does not admit a pre-aborted command or create a host lease', async () => {
    const fixture = await start(), abort = new AbortController(), input = command('process.stdout.write("must-not-run")');
    abort.abort(); const admit = vi.spyOn(fixture.client, 'admit'), lease = vi.fn(async () => undefined);
    const result = await new HostKitCommandExecutor(fixture.client, owner, image, { onLease: lease, onEvidence: async () => undefined }).run(input, abort.signal);
    expect(result.status).toBe('cancelled'); expect(result.output).toBe(''); expect(result.billableSeconds).toBe(0);
    expect(admit).not.toHaveBeenCalled(); expect(lease).not.toHaveBeenCalled();
    expect(await fixture.journal.db.select().from(hostRuns)).toEqual([]);
  });

  it('skips HostKit admission and rolls back an observed lease when cancelled during pre-admission work', async () => {
    const fixture = await start(), abort = new AbortController(), input = command('process.stdout.write("must-not-run")');
    const admit = vi.spyOn(fixture.client, 'admit');
    let persisted: SignedHostLease | undefined;
    const skipped = vi.fn(async (lease: SignedHostLease) => {
      expect(hostMessageHash(lease)).toBe(hostMessageHash(persisted!));
      persisted = undefined;
    });
    const observer: HostKitObserver = {
      onLease: async lease => { persisted = lease; abort.abort(); },
      onAdmissionSkipped: skipped,
      onEvidence: async () => undefined,
    };
    await expect(new HostKitCommandExecutor(fixture.client, owner, image, observer)
      .run(input, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(persisted).toBeUndefined();
    expect(admit).not.toHaveBeenCalled();
    expect(await fixture.journal.db.select().from(hostRuns)).toEqual([]);
  });

  it('bounds workload output and cleans up the failed cell', async () => {
    const fixture = await start(), input = command('process.stdout.write("x".repeat(20000));setTimeout(()=>{},60000)');
    const result = await new HostKitCommandExecutor(fixture.client, owner, image).run(input, new AbortController().signal);
    expect(result.status).toBe('failed'); expect(result.exitCode).not.toBe(0); expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(16_384);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.cleanupConfirmed).toBe(true); expect(await fixture.runtime.cleanupOrphans(fixture.journal.identity.publicKey)).toEqual([]);
  });

  it('preserves Unicode split across stdout frames', async () => {
    const fixture = await start(), input = command('process.stdout.write(Buffer.from([0xf0]));setTimeout(()=>process.stdout.write(Buffer.from([0x9f,0x8c,0x8d])),150)');
    const result = await new HostKitCommandExecutor(fixture.client, owner, image).run(input, new AbortController().signal);
    expect(result.status).toBe('completed'); expect(result.output).toBe('🌍'); expect(result.exitCode).toBe(0);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.output).toBe('🌍'); expect(row?.cleanupConfirmed).toBe(true);
    expect(validateCpuResult(result, input.runId, input.maxSeconds)).toEqual(result);
  });

  it('normalizes an optional initial UTF-8 BOM before signing and persisting stdout text', async () => {
    const fixture = await start(), input = command('process.stdout.write(Buffer.from([0xef,0xbb,0xbf,65]))');
    const result = await new HostKitCommandExecutor(fixture.client, owner, image).run(input, new AbortController().signal);
    expect(result).toMatchObject({ status: 'completed', output: 'A', exitCode: 0 });
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row).toMatchObject({ state: 'completed', output: 'A', cleanupConfirmed: true });
    expect(validateCpuResult(result, input.runId, input.maxSeconds)).toEqual(result);
  });

  it.each([{ name: 'NUL', bytes: [65, 0, 66] }, { name: 'invalid UTF-8', bytes: [0xc3, 0x28] },
    { name: 'incomplete UTF-8', bytes: [0xe2, 0x82] }])('persists a safe failed result for $name stdout and admits the next command after cleanup', async ({ bytes }) => {
    const fixture = await start(), executor = new HostKitCommandExecutor(fixture.client, owner, image);
    const input = command('process.stdout.write(Buffer.from(' + JSON.stringify(bytes) + '))');
    const result = await executor.run(input, new AbortController().signal);
    expect(result.status).toBe('failed'); expect(result.exitCode).not.toBe(0);
    expect(result.output).toBe('[telomere: invalid UTF-8 or NUL in stdout]'); expect(result.output).not.toContain('\0');
    expect(validateCpuResult(result, input.runId, input.maxSeconds)).toEqual(result);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row).toMatchObject({ state: 'failed', cleanupConfirmed: true, output: result.output, exitCode: result.exitCode });
    expect(agent?.identity().ready).toBe(true); expect(await fixture.runtime.cleanupOrphans(fixture.journal.identity.publicKey)).toEqual([]);
    const next = command('process.stdout.write("next-command-ok")');
    const after = await executor.run(next, new AbortController().signal);
    expect(after).toMatchObject({ status: 'completed', output: 'next-command-ok', exitCode: 0 });
    expect(agent?.identity().ready).toBe(true);
  });

  it('retains stdout-only result semantics while counting raw stderr against the output bound', async () => {
    const fixture = await start(), executor = new HostKitCommandExecutor(fixture.client, owner, image);
    const input = command('process.stderr.write(Buffer.from([0,0xff]));process.stdout.write("stdout-only")');
    expect(await executor.run(input, new AbortController().signal)).toMatchObject({ status: 'completed', output: 'stdout-only', exitCode: 0 });
    const output = new HostTextOutput(); output.append('stderr', Buffer.alloc(16_384).toString('base64'));
    expect(output.finish(0)).toEqual({ output: '', exitCode: 0 });
    expect(() => output.append('stdout', 'YQ==')).toThrow('output frame rejected');
  });

  it('rejects malformed init frames and noncanonical base64 without parsing workload text as control data', () => {
    for (const frame of [{ kind: 'output', stream: 'other', data: 'YQ==' }, { kind: 'started', pid: -1 },
      { kind: 'heartbeat', runId: randomId(), sequence: '0', elapsedMs: 0 }, { kind: 'exit', code: 0, extra: true }]) {
      expect(hostInitFrameSchema.safeParse(frame).success).toBe(false);
    }
    for (const encoded of ['%%%', 'YQ', 'YQ==\n', '_w==']) {
      expect(() => new HostTextOutput().append('stdout', encoded)).toThrow('output frame rejected');
    }
    const output = new HostTextOutput(); output.append('stdout', Buffer.from('{"kind":"heartbeat"}').toString('base64'));
    expect(output.finish(0)).toEqual({ output: '{"kind":"heartbeat"}', exitCode: 0 });
    const bom = new HostTextOutput(); bom.append('stdout', Buffer.from([0xef, 0xbb, 0xbf, 65]).toString('base64'));
    expect(bom.finish(0)).toEqual({ output: 'A', exitCode: 0 });
  });

  it('honors the signed command deadline and returns a verified timed-out outcome', async () => {
    const fixture = await start(), input = command('setTimeout(()=>{},60000)', 1);
    const result = await new HostKitCommandExecutor(fixture.client, owner, image).run(input, new AbortController().signal);
    expect(result.status).toBe('timed_out'); expect(result.billableSeconds).toBe(0);
    expect(validateCpuResult(result, input.runId, input.maxSeconds)).toEqual(result);
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.cleanupConfirmed).toBe(true);
  });

  it('refuses dispatch when the original lease cannot be persisted', async () => {
    const fixture = await start(), admit = vi.spyOn(fixture.client, 'admit');
    const executor = new HostKitCommandExecutor(fixture.client, owner, image, {
      onLease: async () => { throw new Error('controller lease storage unavailable'); }, onEvidence: async () => undefined,
    });
    await expect(executor.run(command('process.stdout.write("must-not-run")'), new AbortController().signal)).rejects.toThrow('controller lease storage unavailable');
    expect(admit).not.toHaveBeenCalled(); expect(await fixture.journal.db.select().from(hostRuns)).toEqual([]);
  });

  it('stops and confirms cleanup if controller evidence persistence fails', async () => {
    const fixture = await start(), input = command('setTimeout(()=>{},60000)');
    const executor = new HostKitCommandExecutor(fixture.client, owner, image, {
      onLease: async () => undefined, onEvidence: async () => { throw new Error('controller evidence storage unavailable'); },
    });
    await expect(executor.run(input, new AbortController().signal)).rejects.toThrow('controller evidence storage unavailable');
    const [row] = await fixture.journal.db.select().from(hostRuns).where(eq(hostRuns.runId, input.runId));
    expect(row?.state).toBe('cancelled'); expect(row?.cleanupConfirmed).toBe(true); expect(row?.acks).toEqual([]);
    expect(await fixture.runtime.cleanupOrphans(fixture.journal.identity.publicKey)).toEqual([]);
  });

  it('keeps the existing strict lease command bounds', async () => {
    const fixture = await start(), input = command('process.stdout.write("bounded")'), admit = vi.spyOn(fixture.client, 'admit');
    const executor = new HostKitCommandExecutor(fixture.client, owner, image);
    for (const changed of [{ maxSeconds: 121 }, { argv: ['/bin/sh', '-c', 'echo no'] }, { argv: ['node', 'bad\0arg'] },
      { argv: Array(33).fill('x') }, { argv: ['node', 'x'.repeat(4097)] }, { stdin: '🌍'.repeat(32769) }, { unexpected: true }]) {
      const invalid = { ...input, ...changed };
      expect(hostCommandInputSchema.safeParse(invalid).success).toBe(false);
      await expect(executor.run(invalid, new AbortController().signal)).rejects.toThrow();
    }
    expect(admit).not.toHaveBeenCalled(); expect(await fixture.journal.db.select().from(hostRuns)).toEqual([]);
  });
});
