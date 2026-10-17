import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashJson, randomId, type StoredQuote } from '../src/common.js';
import { jobs, openStore } from '../src/store.js';
import { validateCpuResult } from '../src/runtime/validation.js';
import type { MeterTick } from '../src/runtime/types.js';
import { ControllerHostKitCpu } from '../src/host-kit/controller.js';
import { controllerHostRuns } from '../src/host-kit/controller-schema.js';
import { createHostKitRoutes, Ed25519Identity, HostKitAgent, HostKitClient, hostMessageHash, openHostJournal,
  verifyHostMessage, type HostJournal, type HostLease, type InitHeartbeat, type SignedHostLease } from '../src/host-kit/index.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { projectRoot } from '../scripts/compile-contracts.js';

const owner='0x1111111111111111111111111111111111111111', other='0x2222222222222222222222222222222222222222';
const image=`registry.example/cpu@sha256:${'a'.repeat(64)}`;
const control=new Ed25519Identity();
class TaskImageFixture extends LocalProcessFixtureRuntime {
  constructor(private readonly longRunning=false) {super('test-fixture-only');}
  override start(value:HostLease,heartbeat:(value:InitHeartbeat)=>void) {
    const argv=this.longRunning?[process.execPath,'-e','setTimeout(()=>{},60000)']:[process.execPath,resolve(projectRoot,'infra/host-kit/task-runner.mjs')];
    return super.start({...value,argv},heartbeat);
  }
}
describe('durable controller Host Kit integration over actual loopback HTTP',()=>{
  let directory:string,store:Awaited<ReturnType<typeof openStore>>,journal:HostJournal,agent:HostKitAgent,server:Server,url:string;
  let runtime:TaskImageFixture, admissions:number, stops:number, dropStops:boolean, tamperCleanup:boolean, unsignedStatus:boolean;
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),'telomere-controller-host-'));store=await openStore({DATA_DIR:join(directory,'controller')});
    journal=await openHostJournal(':memory:');runtime=new TaskImageFixture();agent=new HostKitAgent(journal,runtime,control.publicKey,new Set([image]));await agent.initialize();
    server=createServer(getRequestListener(createHostKitRoutes(agent).fetch));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('HTTP fixture missing');url=`http://127.0.0.1:${address.port}`;
    admissions=0;stops=0;dropStops=false;tamperCleanup=false;unsignedStatus=false;
  });
  afterEach(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await agent.close();await journal.close();await store.close();await rm(directory,{recursive:true,force:true});});
  const request:typeof fetch=async(input,init)=>{
    const value=JSON.parse(String(init?.body)) as {body:Record<string,unknown>};
    if(String(input).endsWith('/v1/leases')){
      admissions++;const [saved]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,String(value.body.runId)));
      expect(saved?.leaseHash).toBe(hostMessageHash(value as unknown as SignedHostLease));
    }else if(value.body.action==='ack'){
      const ack=value.body.ack as {body:{sequence:number;tickHash:string}};
      const [saved]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,String(value.body.runId)));
      expect(saved?.acknowledgments[ack.body.sequence]?.body.tickHash).toBe(ack.body.tickHash);
      expect(saved?.ticks[ack.body.sequence]).toBeDefined();
    }else if(value.body.action==='stop'){
      if(dropStops)throw new Error('Control transport interrupted');stops++;
    }
    const response=await fetch(input,init);if(!response.ok)return response;
    if((tamperCleanup||unsignedStatus)&&value.body.action==='stop'){
      const result=await response.json() as {body:Record<string,unknown>;signature:string};
      if(tamperCleanup)result.body.cleanupConfirmed=false;
      const signed=journal.identity.sign('control',result.body);if(unsignedStatus)signed.signature=Buffer.alloc(64).toString('base64');
      return new Response(JSON.stringify(signed),{status:200,headers:{'Content-Type':'application/json'}});
    }
    return response;
  };
  function client(){return new HostKitClient(url,journal.identity.publicKey,control,true,request);}
  function controller(){return new ControllerHostKitCpu(store.db,client(),image);}
  async function insert(runId=randomId()){
    const leashId=randomId(),task={kind:'sha256' as const,text:'controller-host-evidence'},input={runId,task,maxSeconds:20};
    const quote:StoredQuote={runId,leashId,payer:owner,workloadHash:hashJson(input),maxSeconds:20,pricePerSecond:'100',inferencePrice:'0',quoteExpiry:Math.floor(Date.now()/1000)+300};
    await store.db.insert(jobs).values({id:runId,owner,leashId,idemKey:runId,inputHash:hashJson(input),input:{leashId,task,maxSeconds:20},quote,signature:`0x${'ab'.repeat(65)}`,ceiling:'2000',status:'running'});
    return input;
  }
  async function interrupted(){
    await agent.close();runtime=new TaskImageFixture(true);agent=new HostKitAgent(journal,runtime,control.publicKey,new Set([image]));await agent.initialize();
    await new Promise<void>(resolve=>server.close(()=>resolve()));server=createServer(getRequestListener(createHostKitRoutes(agent).fetch));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw new Error('HTTP fixture missing');url=`http://127.0.0.1:${address.port}`;
    const input=await insert(),ticks:MeterTick[]=[];dropStops=true;
    await expect(controller().run(input,new AbortController().signal,async tick=>{
      ticks.push(tick);await store.db.update(jobs).set({ticks:[...ticks],billableSeconds:tick.billableSeconds}).where(eq(jobs.id,input.runId));throw new Error('Controller persistence interrupted');
    })).rejects.toThrow('Controller persistence interrupted');
    dropStops=false;return input;
  }
  it('persists the original lease before admission and signed evidence before host acknowledgement',async()=>{
    const input=await insert(),ticks:MeterTick[]=[];
    const result=await controller().run(input,new AbortController().signal,async tick=>{
      ticks.push(tick);await store.db.update(jobs).set({ticks:[...ticks],billableSeconds:tick.billableSeconds}).where(eq(jobs.id,input.runId));
    });
    expect(validateCpuResult(result,input.runId,input.maxSeconds)).toEqual(result);expect(result.status).toBe('completed');expect(admissions).toBe(1);
    const [saved]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,input.runId));
    expect(saved).toMatchObject({owner,hostKey:journal.identity.publicKey,cleanupConfirmed:true});expect(saved?.lease.body.runId).toBe(input.runId);
    expect(saved?.ticks.length).toBeGreaterThan(0);expect(saved?.ticks.length).toBe(saved?.acknowledgments.length);
    expect(saved?.ticks.every(tick=>verifyHostMessage(journal.identity.publicKey,'tick',tick))).toBe(true);
    expect(saved?.acknowledgments.every(ack=>verifyHostMessage(control.publicKey,'ack',ack))).toBe(true);
  });
  it('reopens the real controller database and cleans a still-active orphan using its original lease without redispatch',async()=>{
    const input=await interrupted();const [before]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,input.runId));
    expect(before).toMatchObject({cleanupConfirmed:false});expect(before?.ticks).toHaveLength(1);expect(before?.acknowledgments).toHaveLength(1);
    expect((await client().command(before!.lease,'status')).state).toBe('running');
    await store.close();store=await openStore({DATA_DIR:join(directory,'controller')});await controller().cleanupOrphans();
    const [after]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,input.runId));
    expect(after?.lease).toEqual(before?.lease);expect(after?.cleanupConfirmed).toBe(true);expect(admissions).toBe(1);expect(stops).toBe(1);
    expect(await client().command(after!.lease,'status')).toMatchObject({state:'cancelled',cleanupConfirmed:true,billableSeconds:0});
    await expect(controller().run(input,new AbortController().signal)).rejects.toThrow('already owns');expect(admissions).toBe(1);
  });
  it.each(['unsigned','owner','runId','hostKey'] as const)('rejects %s durable lease metadata before any host cleanup request',async mode=>{
    const input=await insert(),now=Date.now();let body:HostLease={version:1,hostKey:journal.identity.publicKey,runId:input.runId,owner,image,argv:['/usr/local/bin/node','-e','0'],issuedAt:now,expiresAt:now+20000,maxSeconds:20,nonce:randomId()};
    if(mode==='runId')body={...body,runId:randomId()};if(mode==='hostKey')body={...body,hostKey:control.publicKey};
    const signed=control.sign('lease',body);if(mode==='unsigned')signed.signature=Buffer.alloc(64).toString('base64');
    await store.db.insert(controllerHostRuns).values({runId:input.runId,owner:mode==='owner'?other:owner,hostKey:journal.identity.publicKey,leaseHash:hostMessageHash(signed),lease:signed});
    await expect(controller().cleanupOrphans()).rejects.toThrow();expect(stops).toBe(0);
    const [saved]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,input.runId));expect(saved?.cleanupConfirmed).toBe(false);
  });
  it.each(['uncertain','unsigned'] as const)('fails closed on %s host cleanup confirmation and permits exact later reconciliation',async mode=>{
    const input=await interrupted();tamperCleanup=mode==='uncertain';unsignedStatus=mode==='unsigned';
    await expect(controller().cleanupOrphans()).rejects.toThrow();
    let [saved]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,input.runId));expect(saved?.cleanupConfirmed).toBe(false);expect(admissions).toBe(1);
    tamperCleanup=false;unsignedStatus=false;await controller().cleanupOrphans();
    [saved]=await store.db.select().from(controllerHostRuns).where(eq(controllerHostRuns.runId,input.runId));expect(saved?.cleanupConfirmed).toBe(true);expect(admissions).toBe(1);
  });
});
