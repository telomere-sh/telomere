import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openStore, nonces } from '../src/store.js';
import { Service } from '../src/service.js';
import { ChainBridge } from '../src/bridge.js';
import { createApp } from '../src/app.js';
import { emptyWorkspace } from '../src/workspace/routes.js';

describe('public wallet accounts and private workspace repository', () => {
  const alice = privateKeyToAccount(generatePrivateKey()), bob = privateKeyToAccount(generatePrivateKey());
  const base = loadConfig({SIGNER_PRIVATE_KEY:generatePrivateKey(),DEMO_PRIVATE_KEY:generatePrivateKey(),ESCROW_ADDRESS:alice.address,TOKEN_ADDRESS:bob.address,DATA_DIR:':memory:'});
  const config = {...base, MODE:'testnet' as const, WALLET_ACCESS:'public' as const};
  let store:Awaited<ReturnType<typeof openStore>>, auth:Auth, app:ReturnType<typeof createApp>;
  let aliceCookie:string,bobCookie:string;
  const request=(path:string,method='GET',body?:unknown,cookie='',origin=config.PUBLIC_ORIGIN)=>app.request(path,{method,headers:{cookie,origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function login(account:typeof alice){
    const c=await request('/api/auth/challenge','POST',{address:account.address});expect(c.status).toBe(200);
    const challenge=await c.json() as {message:string;nonce:string};
    const signature=await account.signMessage({message:challenge.message});
    const r=await request('/api/auth/verify','POST',{address:account.address,nonce:challenge.nonce,signature});
    expect(r.status).toBe(200);return r.headers.get('set-cookie')!.split(';')[0]!;
  }
  beforeAll(async()=>{store=await openStore(config);auth=new Auth(store.db,config);app=createApp(new Service(store.db,new ChainBridge(base),config,false),auth,pino({level:'silent'}));aliceCookie=await login(alice);bobCookie=await login(bob)},30000);
  afterAll(async()=>store?.close());
  it('allows a new independently signed wallet without a pilot entry',async()=>{expect((await request('/api/me','GET',undefined,bobCookie)).status).toBe(200)});
  it('keeps allowlist mode closed and denies unapproved sessions too',async()=>{
    const restricted=new Auth(store.db,{...config,WALLET_ACCESS:'allowlist',PILOT_ALLOWED_OWNERS:alice.address});
    await expect(restricted.challenge(bob.address)).rejects.toMatchObject({code:'pilot_access'});
    await expect(restricted.session(bob.address)).rejects.toMatchObject({code:'pilot_access'});
  });
  it('requires a signature from the challenged address and consumes nonce only once',async()=>{
    const c=await auth.challenge(alice.address);
    await expect(auth.verify(alice.address,c.nonce,await bob.signMessage({message:c.message}))).rejects.toMatchObject({code:'invalid_signature'});
    const signature=await alice.signMessage({message:c.message});
    const outcomes=await Promise.allSettled([auth.verify(alice.address,c.nonce,signature),auth.verify(alice.address,c.nonce,signature)]);
    expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  });
  it('rejects an expired challenge',async()=>{const c=await auth.challenge(alice.address);await store.db.update(nonces).set({expiresAt:new Date(0)}).where(eq(nonces.nonce,c.nonce));await expect(auth.verify(alice.address,c.nonce,await alice.signMessage({message:c.message}))).rejects.toMatchObject({code:'invalid_signature'})});
  it('persists Alice’s document and never returns it to Bob',async()=>{
    const document=emptyWorkspace();document.budget=123;
    expect((await request('/api/workspace','PUT',{revision:0,document},aliceCookie)).status).toBe(200);
    expect(await (await request('/api/workspace','GET',undefined,aliceCookie)).json()).toMatchObject({revision:1,document:{budget:123}});
    expect(await (await request('/api/workspace','GET',undefined,bobCookie)).json()).toMatchObject({revision:0,document:{budget:0}});
  });
  it('rejects stale revisions and concurrent first writes rather than losing changes',async()=>{
    expect((await request('/api/workspace','PUT',{revision:0,document:emptyWorkspace()},aliceCookie)).status).toBe(409);
    const results=await Promise.all([request('/api/workspace','PUT',{revision:0,document:emptyWorkspace()},bobCookie),request('/api/workspace','PUT',{revision:0,document:emptyWorkspace()},bobCookie)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  });
  it('rejects client supplied owner, forged balances and oversized plans',async()=>{
    expect((await request('/api/workspace','PUT',{owner:alice.address,revision:1,document:emptyWorkspace()},bobCookie)).status).toBe(422);
    expect((await request('/api/workspace','PUT',{revision:1,document:{...emptyWorkspace(),available:'99999'}},bobCookie)).status).toBe(422);
    expect((await request('/api/workspace','PUT',{revision:1,document:{...emptyWorkspace(),plans:Array(101).fill({})}},bobCookie)).status).toBe(422);
  });
  it('rejects a stale tab’s reads and writes after a different account replaced its cookie',async()=>{
    for(const method of ['GET','PUT']){
      const r=await app.request('/api/workspace',{method,headers:{cookie:bobCookie,origin:config.PUBLIC_ORIGIN,'Content-Type':'application/json','X-Telomere-Owner':alice.address},...(method==='PUT'?{body:JSON.stringify({revision:1,document:{...emptyWorkspace(),budget:999}})}:{})});
      expect(r.status).toBe(409);expect(await r.json()).toMatchObject({title:'session_owner_changed'});
    }
    expect(await (await request('/api/workspace','GET',undefined,bobCookie)).json()).toMatchObject({document:{budget:0}});
  });
  it('requires same-origin JSON and authenticated sessions; revokes on logout',async()=>{
    expect((await request('/api/workspace')).status).toBe(401);
    expect((await request('/api/workspace','PUT',{revision:1,document:emptyWorkspace()},bobCookie,'https://attacker.invalid')).status).toBe(403);
    expect((await request('/api/auth/logout','POST',{},bobCookie)).status).toBe(200);
    expect((await request('/api/workspace','GET',undefined,bobCookie)).status).toBe(401);
    expect((await request('/api/workspace','GET',undefined,aliceCookie)).headers.get('cache-control')).toBe('no-store');
  });
});
