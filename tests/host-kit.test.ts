import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashJson, randomId, type StoredQuote } from '../src/common.js';
import { createHostKitRoutes, Ed25519Identity, HostKitAgent, HostKitClient, HostKitCpuExecutor, HostMeterVerifier, hostDockerCreateArgs, hostRuntimeInfoArgs,
  hostMessageHash, hostRuns, leaseSchema, openHostJournal, verifyHostMessage, type HostJournal, type HostLease,
  type SignedHostTick, type HostCellRuntime, type InitHeartbeat } from '../src/host-kit/index.js';
import { validateCpuResult } from '../src/runtime/validation.js';
import { Worker } from '../src/worker.js';
import { openStore, jobs } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { ChainBridge } from '../src/bridge.js';
import { projectRoot } from '../scripts/compile-contracts.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { HostCellCleanupError } from '../src/host-kit/docker-runtime.js';

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const image = `registry.example/telomere/cpu@sha256:${'a'.repeat(64)}`;
const control = new Ed25519Identity(), host = new Ed25519Identity();
function lease(hostKey = host.publicKey): HostLease {
  const now = Date.now(); return { version: 1, hostKey, runId: randomId(), owner, image,
    argv: [process.execPath, '-e', 'process.stdout.write("fixture-ok")'], issuedAt: now, expiresAt: now + 20_000, maxSeconds: 20, nonce: randomId() };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe('Ed25519 host and control-plane evidence', () => {
  it('binds domain, message kind, host key, and all lease fields', () => {
    const body = lease(), signed = control.sign('lease', body);
    expect(verifyHostMessage(control.publicKey, 'lease', signed)).toBe(true);
    expect(verifyHostMessage(control.publicKey, 'tick', signed)).toBe(false);
    expect(verifyHostMessage(host.publicKey, 'lease', signed)).toBe(false);
    expect(verifyHostMessage(control.publicKey, 'lease', { ...signed, body: { ...body, owner: other } })).toBe(false);
    expect(new Ed25519Identity(host.exportPrivatePem()).publicKey).toBe(host.publicKey);
  });
  it('requires reviewed digest references, bounded argv, and an explicit non-shell entrypoint', () => {
    const body = lease(); expect(leaseSchema.parse(body)).toEqual(body);
    for (const argv of [['/bin/sh', '-c', 'echo unsafe'], ['/bin/bash'], Array(33).fill('x'), ['node', 'x'.repeat(4097)], ['node', 'bad\0arg']]) {
      expect(leaseSchema.safeParse({ ...body, argv }).success).toBe(false);
    }
    expect(leaseSchema.safeParse({ ...body, image: 'node:22-alpine' }).success).toBe(false);
  });
  function ticks() {
    const body = lease(); let now = body.issuedAt; const meter = new HostMeterVerifier(body, control, () => now); let previous: SignedHostTick | undefined;
    return { body, meter, advance: (ms: number) => { now += ms; }, tick: (elapsedMs: number, overrides: Record<string, unknown> = {}) => {
      const signed = host.sign('tick', { version: 1 as const, hostKey: host.publicKey, runId: body.runId, owner,
        leaseHash: meter.leaseHash, sequence: previous ? previous.body.sequence + 1 : 0, timestamp: now,
        elapsedMs, cpuMs: elapsedMs, state: 'RUNNING' as const, previousHash: previous ? hostMessageHash(previous) : null,
        heartbeat: { sequence: elapsedMs / 1000, elapsedMs, receivedAt: now }, gpuUtil: 0 as const, gpuMemoryBytes: 0 as const, powerWatts: 0 as const,
        ...overrides }); previous = signed as SignedHostTick; return signed;
    } };
  }
  it('bills only complete seconds between two consecutive RUNNING ticks with fresh init heartbeats', () => {
    const fixture = ticks(); const first = fixture.meter.accept(fixture.tick(0)); expect(first.body.billableSeconds).toBe(0);
    fixture.advance(5000); const second = fixture.meter.accept(fixture.tick(5000)); expect(second.body.billableDelta).toBe(5);
    expect(verifyHostMessage(control.publicKey, 'ack', second)).toBe(true);
    fixture.advance(5000); const missing = fixture.meter.accept(fixture.tick(10000, { heartbeat: null })); expect(missing.body.billableDelta).toBe(0);
    fixture.advance(5000); const final = fixture.meter.accept(fixture.tick(15000, { state: 'EXITED' })); expect(final.body.billableDelta).toBe(0);
    expect(fixture.meter.billableSeconds).toBe(5);
  });
  it('faults after three missed ticks and prevents resumed billing', () => {
    const fixture = ticks(); fixture.meter.accept(fixture.tick(0)); fixture.advance(15_000);
    expect(fixture.meter.missing()).toBe(true); expect(() => fixture.meter.accept(fixture.tick(15000))).toThrow('missed');
    expect(fixture.meter.billableSeconds).toBe(0);
  });
  it('rejects replay and restores the same monotonic evidence state', () => {
    const fixture = ticks(); const first = fixture.tick(0); fixture.meter.accept(first);
    expect(() => fixture.meter.accept(first)).toThrow('replay'); fixture.advance(5000);
    const second = fixture.tick(5000); fixture.meter.accept(second);
    const restored = new HostMeterVerifier(fixture.body, control, () => second.body.timestamp, fixture.meter.exportState());
    expect(restored.billableSeconds).toBe(5); expect(() => restored.accept(second)).toThrow('replay');
  });
  it.each(['runId','owner','hostKey','leaseHash','previousHash','sequence','timestamp','cpuMs','elapsedMs'] as const)('rejects signed but invalid %s evidence', field => {
    const fixture = ticks(); fixture.meter.accept(fixture.tick(0)); fixture.advance(5000);
    const changed = field === 'runId' || field === 'leaseHash' || field === 'previousHash' ? randomId()
      : field === 'owner' ? other : field === 'hostKey' ? control.publicKey : field === 'sequence' ? 9
        : field === 'timestamp' ? fixture.body.issuedAt - 20_000 : field === 'cpuMs' ? -1 : 20_000;
    expect(() => fixture.meter.accept(fixture.tick(5000, { [field]: changed }))).toThrow(); expect(fixture.meter.billableSeconds).toBe(0);
  });
  it('never grants billing for stale/reused heartbeats or accelerated elapsed counters', () => {
    for (const mode of ['stale','reused','accelerated']) {
      const fixture = ticks(); fixture.meter.accept(fixture.tick(0)); fixture.advance(5000);
      const heartbeat = { sequence: mode === 'reused' ? 0 : 5, elapsedMs: 5000,
        receivedAt: fixture.body.issuedAt + (mode === 'stale' ? 0 : 5000) };
      if (mode === 'accelerated') expect(() => fixture.meter.accept(fixture.tick(12000, { heartbeat }))).toThrow('monotonically');
      else expect(fixture.meter.accept(fixture.tick(5000, { heartbeat })).body.billableDelta).toBe(0);
    }
  });
  it('builds fixed restricted runtime arguments without host mounts, ports, shell, or runtime fallback', () => {
    const body = lease(), name = `tlmr-hostkit-${host.publicKey.slice(2,10)}-${body.runId.slice(2,18)}-01234567`;
    const args = hostDockerCreateArgs(name, body, 'gvisor');
    for (const value of ['runsc','none','--read-only','ALL','no-new-privileges:true','10001:10001','--pids-limit','--memory-swap']) expect(args).toContain(value);
    for (const value of ['--privileged','--mount','--volume','--publish','--device']) expect(args).not.toContain(value);
    expect(hostDockerCreateArgs(name, body, 'kata')).toContain('kata-runtime');
    expect(hostDockerCreateArgs(name, body, 'docker_development')).not.toContain('--runtime');
  });
  it('rejects remote plaintext, embedded credentials, and mutable transport query configuration', () => {
    for (const url of ['http://host.example:13290','https://user:secret@host.example','http://127.0.0.1:13290?token=secret']) {
      expect(() => new HostKitClient(url, host.publicKey, control)).toThrow();
    }
  });
  it('queries only the selected runtime path instead of unbounded Docker runtime feature inventories', () => {
    expect(hostRuntimeInfoArgs('gvisor')).toEqual(['info','--format','{{with index .Runtimes "runsc"}}{{json .Path}}{{end}}']);
    expect(hostRuntimeInfoArgs('kata').join(' ')).toContain('kata-runtime');
    expect(hostRuntimeInfoArgs('docker_development')).toEqual(['info','--format','{{json .ServerVersion}}']);
  });
});

describe('actual local HTTP host protocol with explicitly unsafe child-process fixture', () => {
  let journal: HostJournal | undefined, agent: HostKitAgent | undefined, server: Server | undefined, directory: string | undefined;
  afterEach(async () => { vi.restoreAllMocks(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); await agent?.close(); await journal?.close();
    if (directory) await rm(directory, { recursive: true, force: true }); server = undefined; agent = undefined; journal = undefined; directory = undefined; });
  async function start(runtime: HostCellRuntime = new LocalProcessFixtureRuntime('test-fixture-only')) {
    journal = await openHostJournal(':memory:');
    agent = new HostKitAgent(journal, runtime, control.publicKey, new Set([image])); await agent.initialize();
    server = createServer(getRequestListener(createHostKitRoutes(agent).fetch)); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP fixture unavailable');
    const url = `http://127.0.0.1:${address.port}`;
    return { client: new HostKitClient(url, journal.identity.publicKey, control, true), url, runtime };
  }
  it('executes a real child, receives init heartbeats, countersigns signed host ticks, and conserves confirmed billing', async () => {
    const fixture = await start(), body = { ...lease(journal!.identity.publicKey),
      argv: [process.execPath, '-e', 'setTimeout(()=>process.stdout.write("actual-child-ok"),11000)'] };
    const signed = control.sign('lease', body), meter = new HostMeterVerifier(body, control); let state = await fixture.client.admit(signed), sequence = 0;
    const timeout = Date.now() + 20_000;
    for (;;) {
      for (const tick of state.ticks.slice(sequence)) { state = await fixture.client.command(signed, 'ack', meter.accept(tick)); sequence++; }
      if (!['starting','running'].includes(state.state)) break;
      if (Date.now() > timeout) throw new Error('HTTP fixture execution timeout'); await pause(250); state = await fixture.client.command(signed, 'status');
    }
    expect(state.state).toBe('completed'); expect(state.output).toBe('actual-child-ok'); expect(state.isolation).toBe('local_process_fixture');
    expect(state.billableSeconds).toBe(meter.billableSeconds); expect(state.billableSeconds).toBeGreaterThanOrEqual(3); expect(state.billableSeconds).toBeLessThanOrEqual(10);
    expect(state.acks.every(ack => verifyHostMessage(control.publicKey, 'ack', ack))).toBe(true);
    expect(await fixture.runtime.cleanupOrphans(journal!.identity.publicKey)).toEqual([]);
  }, 30_000);
  it('enforces tenant scope, one active run, exact replay, reviewed image, and explicit fixture consent', async () => {
    const fixture = await start(), body = { ...lease(journal!.identity.publicKey), argv: [process.execPath, '-e', 'setTimeout(()=>{},60000)'] };
    const signed = control.sign('lease', body); await fixture.client.admit(signed);
    expect((await fixture.client.admit(signed)).runId).toBe(body.runId);
    await expect(fixture.client.admit(control.sign('lease', { ...body, runId: randomId(), nonce: randomId() }))).rejects.toThrow('(409)');
    const foreign = control.sign('control', { version: 1, hostKey: body.hostKey, runId: body.runId, owner: other, action: 'status', nonce: randomId(), issuedAt: Date.now() });
    expect((await fetch(fixture.url+'/v1/control', { method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(foreign) })).status).toBe(404);
    const unauthenticated = host.sign('control', { ...foreign.body, owner });
    expect((await fetch(fixture.url+'/v1/control', { method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(unauthenticated) })).status).toBe(403);
    const productionClient = new HostKitClient(fixture.url, body.hostKey, control);
    await expect(productionClient.command(signed, 'status')).rejects.toThrow('isolation');
    expect((await fixture.client.command(signed,'stop')).state).toBe('cancelled');
    await expect(fixture.client.admit(control.sign('lease', { ...lease(body.hostKey), image: image.replace(/a{64}/,'b'.repeat(64)) }))).rejects.toThrow('(403)');
    expect(await fixture.runtime.cleanupOrphans(body.hostKey)).toEqual([]);
  });
  it('rejects repeated signed control nonces and oversized HTTP payloads', async () => {
    const fixture = await start(), signed = control.sign('lease', { ...lease(journal!.identity.publicKey), argv: [process.execPath,'-e','setTimeout(()=>{},60000)'] });
    await fixture.client.admit(signed);
    const command = control.sign('control', { version:1, hostKey:signed.body.hostKey,runId:signed.body.runId,owner,action:'status',nonce:randomId(),issuedAt:Date.now() });
    const call=()=>fetch(fixture.url+'/v1/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)});
    expect((await call()).status).toBe(200); expect((await call()).status).toBe(409);
    expect((await fetch(fixture.url+'/v1/leases',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(196609)})).status).toBe(413);
  });
  it('rejects countersigned first-tick charging and reconciles an exact repeated acknowledgement', async () => {
    const fixture=await start(), signed=control.sign('lease',{...lease(journal!.identity.publicKey),argv:[process.execPath,'-e','setTimeout(()=>{},60000)']});
    const state=await fixture.client.admit(signed), tick=state.ticks[0]; expect(tick).toBeDefined();
    const meter=new HostMeterVerifier(signed.body,control), ack=meter.accept(tick);
    await expect(fixture.client.command(signed,'ack',control.sign('ack',{...ack.body,billableDelta:1,billableSeconds:1}))).rejects.toThrow('(403)');
    expect((await fixture.client.command(signed,'ack',ack)).billableSeconds).toBe(0);
    expect((await fixture.client.command(signed,'ack',ack)).acks).toHaveLength(1);
    expect((await fixture.client.command(signed,'stop')).state).toBe('cancelled');
  });
  it('fails closed after an ambiguous create whose cleanup was not confirmed', async () => {
    journal=await openHostJournal(':memory:');
    class BrokenRuntime extends LocalProcessFixtureRuntime { override async start(): Promise<never> { throw new HostCellCleanupError(); } }
    agent=new HostKitAgent(journal,new BrokenRuntime('test-fixture-only'),control.publicKey,new Set([image])); await agent.initialize();
    const first=control.sign('lease',lease(journal.identity.publicKey)); expect((await agent.admit(first)).state).toBe('fault');
    expect(agent.identity().ready).toBe(false);
    await expect(agent.admit(control.sign('lease',lease(journal.identity.publicKey)))).rejects.toMatchObject({status:503,code:'host_unavailable'});
  });
  it('never lets an old completed lease stop a later tenant or clear its deadline', async () => {
    const fixture=await start(), first=control.sign('lease',{...lease(journal!.identity.publicKey),argv:[process.execPath,'-e','process.stdout.write("first")']});
    await fixture.client.admit(first); let firstState=await fixture.client.command(first,'status');
    while (['starting','running'].includes(firstState.state)) { await pause(50); firstState=await fixture.client.command(first,'status'); }
    expect(firstState.cleanupConfirmed).toBe(true);
    const second=control.sign('lease',{...lease(journal!.identity.publicKey),owner:other,argv:[process.execPath,'-e','setTimeout(()=>{},60000)']});
    expect((await fixture.client.admit(second)).state).toBe('running');
    expect((await fixture.client.command(first,'stop')).state).toBe('completed');
    expect(await fixture.client.command(second,'status')).toMatchObject({state:'running',owner:other,cleanupConfirmed:false});
    expect(await fixture.client.command(second,'stop')).toMatchObject({state:'cancelled',cleanupConfirmed:true});
  });
  class TaskImageFixture extends LocalProcessFixtureRuntime {
    constructor(private readonly program?: string) { super('test-fixture-only'); }
    override start(value:HostLease, heartbeat:(value:InitHeartbeat)=>void) {
      const argv=this.program ? [process.execPath,'-e',this.program] : [process.execPath,resolve(projectRoot,'infra/host-kit/task-runner.mjs')];
      return super.start({...value,argv},heartbeat);
    }
  }
  it('adapts a real task to strict standard CPU observations and preserves Worker recovery compatibility', async () => {
    const fixture=await start(new TaskImageFixture()), order:string[]=[];
    const observer={onLease:async()=>{order.push('lease');},onEvidence:async()=>{order.push('evidence');}};
    const executor=new HostKitCpuExecutor(fixture.client,owner,image,observer), runId=randomId();
    const input={runId,task:{kind:'sha256' as const,text:'adapter-recovery'},maxSeconds:20};
    const result=await executor.run(input,new AbortController().signal,async()=>{expect(order.at(-1)).toBe('evidence');order.push('tick');});
    expect(order[0]).toBe('lease'); expect(result.output).toBe(JSON.stringify({sha256:createHash('sha256').update('adapter-recovery').digest('hex')}));
    expect(validateCpuResult(JSON.parse(JSON.stringify(result)),runId,20)).toEqual(result);
    expect(result.ticks.at(-1)?.state).toBe('completed'); expect(result.ticks.every(tick=>/^[a-f0-9]{64}$/.test(tick.hash))).toBe(true);
    directory=await mkdtemp(join(tmpdir(),'telomere-host-worker-')); const controllerPath=join(directory,'controller');
    const config=loadConfig({MODE:'demo',DATA_DIR:controllerPath,SIGNER_PRIVATE_KEY:`0x${'11'.repeat(32)}`,DEMO_PRIVATE_KEY:`0x${'55'.repeat(32)}`,
      ESCROW_ADDRESS:'0x6666666666666666666666666666666666666666',TOKEN_ADDRESS:'0x7777777777777777777777777777777777777777'});
    let store=await openStore(config);
    try {
      const leashId=randomId(), quote:StoredQuote={runId,leashId,payer:owner,workloadHash:randomId(),maxSeconds:20,pricePerSecond:'100',inferencePrice:'0',quoteExpiry:Math.floor(Date.now()/1000)+300};
      await store.db.insert(jobs).values({id:runId,owner,leashId,idemKey:'host-worker-recovery',inputHash:hashJson(input),input:{leashId,task:input.task,maxSeconds:20},
        quote,signature:`0x${'ab'.repeat(65)}`,ceiling:'2000',status:'running',cpuResult:result,ticks:result.ticks,billableSeconds:result.billableSeconds});
      await store.close(); store=await openStore(config);
      const bridge=new ChainBridge(config); vi.spyOn(bridge,'run').mockRejectedValue(new Error('Temporary receipt RPC failure'));
      vi.spyOn(bridge,'leash').mockRejectedValue(new Error('Temporary receipt RPC failure'));
      const redispatch=vi.fn().mockRejectedValue(new Error('CPU must not run again'));
      const worker=new Worker(store.db,bridge,{run:redispatch},undefined,pino({enabled:false})); await worker.recover(true);
      const [saved]=await store.db.select().from(jobs).where(eq(jobs.id,runId)); expect(saved).toMatchObject({status:'receipt_pending',targetStatus:'completed',cpuResult:result});
      expect(worker.snapshot().state).not.toBe('quarantined'); expect(redispatch).not.toHaveBeenCalled();
    } finally {await store.close();}
  });
  it.each(['cancelled','timed_out'] as const)('emits a valid %s final observation and confirms process cleanup', async status => {
    const fixture=await start(new TaskImageFixture('setTimeout(()=>{},60000)')), abort=new AbortController();
    const executor=new HostKitCpuExecutor(fixture.client,owner,image), input={runId:randomId(),task:{kind:'sha256' as const,text:'x'},maxSeconds:status==='timed_out'?1:20};
    const timer=status==='cancelled'?setTimeout(()=>abort.abort(),300):undefined;
    try {const result=await executor.run(input,abort.signal);expect(result.status).toBe(status);expect(validateCpuResult(result,input.runId,input.maxSeconds)).toEqual(result);}
    finally {if(timer)clearTimeout(timer);}
    expect(await fixture.runtime.cleanupOrphans(journal!.identity.publicKey)).toEqual([]);
  });
  it('stops the real cell when durable evidence persistence fails before confirming an acknowledgement', async () => {
    const fixture=await start(new TaskImageFixture('setTimeout(()=>{},60000)'));
    const executor=new HostKitCpuExecutor(fixture.client,owner,image,{onLease:async()=>undefined,onEvidence:async()=>{throw new Error('Durable evidence unavailable');}});
    const runId=randomId();await expect(executor.run({runId,task:{kind:'sha256',text:'x'},maxSeconds:20},new AbortController().signal)).rejects.toThrow('Durable evidence');
    const [saved]=await journal!.db.select().from(hostRuns).where(eq(hostRuns.runId,runId));expect(saved).toMatchObject({state:'cancelled',cleanupConfirmed:true,billableSeconds:0});expect(saved?.acks).toHaveLength(0);
  });
  it('rejects a terminal response without signed confirmation that cleanup completed', async () => {
    const fixture=await start(new TaskImageFixture());
    const fetcher:typeof fetch=async(input,init)=>{
      const response=await fetch(input,init);if(!response.ok)return response;
      const value=await response.json() as {body:Record<string,unknown>;signature:string};
      if (!['starting','running'].includes(String(value.body.state))) value.body.cleanupConfirmed=false;
      return new Response(JSON.stringify(journal!.identity.sign('control',value.body)),{status:response.status,headers:{'Content-Type':'application/json'}});
    };
    const client=new HostKitClient(fixture.url,journal!.identity.publicKey,control,true,fetcher);
    const executor=new HostKitCpuExecutor(client,owner,image);
    await expect(executor.run({runId:randomId(),task:{kind:'sha256',text:'x'},maxSeconds:20},new AbortController().signal)).rejects.toThrow('cleanup was not confirmed');
  });
  it('returns a recoverable zero-cost terminal result when cancellation precedes admission', async () => {
    const client=new HostKitClient('http://127.0.0.1:65534',host.publicKey,control,true), onLease=vi.fn(async()=>undefined), onEvidence=vi.fn(async()=>undefined);
    const executor=new HostKitCpuExecutor(client,owner,image,{onLease,onEvidence}), abort=new AbortController();abort.abort();
    const input={runId:randomId(),task:{kind:'sha256' as const,text:'x'},maxSeconds:20},result=await executor.run(input,abort.signal);
    expect(validateCpuResult(result,input.runId,20)).toEqual(result);expect(result.status).toBe('cancelled');expect(onLease).not.toHaveBeenCalled();expect(onEvidence).not.toHaveBeenCalled();
  });
  it('retains a private host key and confirmed billing across real journal restart, cleaning owned orphan processes first', async () => {
    directory=await mkdtemp(join(tmpdir(),'telomere-hostkit-')); journal=await openHostJournal(directory);
    const key=journal.identity.publicKey, body={...lease(key),argv:[process.execPath,'-e','setTimeout(()=>{},60000)']};
    body.issuedAt-=5000; body.expiresAt-=5000;
    const signed=control.sign('lease',body), runtime=new LocalProcessFixtureRuntime('test-fixture-only');
    await runtime.start(body,()=>undefined); await pause(200);
    let meterTime=body.issuedAt; const meter=new HostMeterVerifier(body,control,()=>meterTime), ticks:SignedHostTick[]=[];
    for (let sequence=0;sequence<2;sequence++) {
      const tick=journal.identity.sign('tick',{version:1 as const,hostKey:key,runId:body.runId,owner,leaseHash:meter.leaseHash,
        sequence,timestamp:meterTime,elapsedMs:sequence*5000,cpuMs:0,state:'RUNNING' as const,previousHash:ticks[0]?hostMessageHash(ticks[0]):null,
        heartbeat:{sequence:sequence*5,elapsedMs:sequence*5000,receivedAt:meterTime},gpuUtil:0 as const,gpuMemoryBytes:0 as const,powerWatts:0 as const}); ticks.push(tick); meterTime+=5000;
    }
    meterTime=body.issuedAt; const firstAck=meter.accept(ticks[0]); meterTime+=5000; const secondAck=meter.accept(ticks[1]);
    await journal.db.insert(hostRuns).values({runId:body.runId,owner,leaseHash:hostMessageHash(signed),lease:signed,state:'running',ticks,acks:[firstAck,secondAck],billableSeconds:meter.billableSeconds});
    await expect(openHostJournal(directory)).rejects.toThrow('owns'); await journal.close();
    journal=await openHostJournal(directory); expect(journal.identity.publicKey).toBe(key);
    agent=new HostKitAgent(journal,runtime,control.publicKey,new Set([image]));
    expect(await agent.initialize()).toEqual({orphanedCells:[body.runId],faultedRuns:[body.runId]});
    const [saved]=await journal.db.select().from(hostRuns).where(eq(hostRuns.runId,body.runId)); expect(saved).toMatchObject({state:'fault',billableSeconds:5});
    expect(await runtime.cleanupOrphans(key)).toEqual([]);
  });
});
