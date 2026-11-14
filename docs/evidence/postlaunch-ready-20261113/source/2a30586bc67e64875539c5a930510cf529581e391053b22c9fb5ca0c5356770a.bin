import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import pino from 'pino';
import {loadConfig} from '../src/config.js';
import {openStore} from '../src/store.js';
import {ChainBridge} from '../src/bridge.js';
import {Service} from '../src/service.js';
import {Auth} from '../src/auth.js';
import {createApp} from '../src/app.js';
import {POSTLAUNCH_IDS} from '../src/updates/features.js';
const base={MODE:'demo',DEMO_PRIVATE_KEY:'0x'+'12'.repeat(32),SIGNER_PRIVATE_KEY:'0x'+'13'.repeat(32),ESCROW_ADDRESS:'0x'+'11'.repeat(20),TOKEN_ADDRESS:'0x'+'22'.repeat(20),DATA_DIR:':memory:',RPC_URL:'http://127.0.0.1:9',PUBLIC_ORIGIN:'http://127.0.0.1:4257'};
describe('postlaunch application boundaries',()=>{
 let store:Awaited<ReturnType<typeof openStore>>;
 beforeAll(async()=>{store=await openStore(loadConfig(base))});afterAll(async()=>{await store.close();vi.restoreAllMocks()});
 function app(flags='') {const config=loadConfig({...base,POSTLAUNCH_FEATURES:flags}),bridge=new ChainBridge(config);vi.spyOn(bridge,'check').mockResolvedValue();return createApp(new Service(store.db,bridge,config,false),new Auth(store.db,config),pino({level:'silent'}));}
 it('keeps every optional endpoint absent by default',async()=>{const a=app();expect(await (await a.request('/api/public/features')).json()).toEqual({enabled:[]});for(const path of ['/api/public/insights/refunds','/api/public/insights/prices','/api/receipt-links','/api/insights/runway','/api/insights/accounting','/api/public/selection/explorer','/api/public/selection/agents/0x'+'aa'.repeat(32),'/api/public/status','/api/public/changelog'])expect((await a.request(path)).status,path).toBe(404)});
 it('publishes only validated flags in both configuration surfaces',async()=>{const a=app(POSTLAUNCH_IDS.join(','));expect(await (await a.request('/api/public/features')).json()).toEqual({enabled:POSTLAUNCH_IDS});const config=await(await a.request('/api/config')).json();expect(config.postLaunch.enabled).toEqual(POSTLAUNCH_IDS);expect(JSON.stringify(config)).not.toMatch(/PRIVATE_KEY|DATABASE_URL|SIGNER_PRIVATE/)});
 it('requires owner authentication for every private accounting or sharing action',async()=>{const a=app('runway,accounting,receipt-links');for(const path of ['/api/insights/runway','/api/insights/accounting?month=2026-11','/api/insights/accounting.csv?month=2026-11'])expect((await a.request(path)).status,path).toBe(401);const response=await a.request('/api/receipt-links',{method:'POST',headers:{origin:base.PUBLIC_ORIGIN,'content-type':'application/json'},body:JSON.stringify({runId:'0x'+'aa'.repeat(32),publish:true})});expect(response.status).toBe(401)});
 it('reports missing Selection honestly and keeps enabled release catalog scoped',async()=>{const a=app('fossils,agent-economics,status-changelog');for(const path of ['/api/public/selection/explorer','/api/public/selection/agents/0x'+'aa'.repeat(32)]){const r=await a.request(path);expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toMatch(/PRIVATE_KEY|127.0.0.1:9/)}const r=await a.request('/api/public/changelog');expect(r.status).toBe(200);const report=await r.json();expect(report.entries.map((e:{id:number})=>e.id)).toEqual([1,8,9,12]);expect(report.state).toBe('partial');const status=await(await a.request('/api/public/status')).json();expect(status.components.find((c:{id:string})=>c.id==='chain').state).toBe('ready');expect(status.components.find((c:{id:string})=>c.id==='explorer').state).toBe('not_configured')});
});
