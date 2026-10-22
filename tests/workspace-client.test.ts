import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceClient, planningHourlySpend } from '../public/workspace-client.js';
import { emptyWorkspace } from '../src/workspace/routes.js';
import { loadConfig } from '../src/config.js';
import { ChainBridge } from '../src/bridge.js';
import { generatePrivateKey } from 'viem/accounts';
const owner='0x1111111111111111111111111111111111111111';
const escrow='0x2222222222222222222222222222222222222222';
const txHash=('0x'+'ab'.repeat(32)) as `0x${string}`;
function setup(){
  const changed=vi.fn(),notice=vi.fn(),entries=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>entries.set(k,v),removeItem:(k:string)=>entries.delete(k)});
  vi.stubGlobal('navigator',{locks:{request:async(_name:unknown,_options:unknown,run:(lock:object)=>unknown)=>run({})}});
  const provider={request:vi.fn(async({method}:{method:string})=>{
    if(method==='eth_accounts')return [owner];if(method==='eth_chainId')return '0x2105';if(method==='eth_sendTransaction')return txHash;if(method==='eth_getTransactionReceipt')return {status:'0x1'};throw Error('Unexpected method');
  })};
  const client=new WorkspaceClient(changed,notice);client.address=owner;client.provider=provider as never;
  client.config={mode:'mainnet',chain:{id:8453,name:'Base',rpcUrl:'https://mainnet.base.org'},token:{address:owner,symbol:'USDC',decimals:6},escrowAddress:escrow,cpuMode:'docker',prices:{cpuPerSecond:'100',maxSeconds:120},platform:{agentLifecycle:false,receiptRootAddress:null},nearAvailable:false,cystsAvailable:true};
  return {client,provider,changed,entries};
}
afterEach(()=>vi.unstubAllGlobals());
describe('workspace wallet safety',()=>{
  it('restores the injected wallet after page reload without requiring a second login',async()=>{
    const {client,provider}=setup();client.provider=undefined;
    const on=vi.fn();vi.stubGlobal('window',Object.assign(new EventTarget(),{okxwallet:Object.assign(provider,{on})}));
    await client.transaction({to:escrow,value:'0x0'},'restored session');
    expect(on).toHaveBeenCalledWith('accountsChanged',client.accountChanged);
    expect(provider.request.mock.calls.filter(([p])=>p.method==='eth_sendTransaction')).toHaveLength(1);
    expect(provider.request.mock.calls.some(([p])=>p.method==='eth_requestAccounts')).toBe(false);
  });
  it('allows a short CPU plan whose hourly spending fits the Leash even when its hourly rate is higher',()=>{
    expect(planningHourlySpend(0.36,1,'Standard')).toBeCloseTo(0.00654);
    expect(planningHourlySpend(0.36,1,'Standard')).toBeLessThan(0.01);
  });
  it('limits longer plans using their maximum one-hour projected spend',()=>{
    expect(planningHourlySpend(0.36,60,'Standard')).toBeGreaterThan(0.01);
    expect(planningHourlySpend(0.36,120,'Standard')).toBe(planningHourlySpend(0.36,60,'Standard'));
  });
  it.each(['0','0x0'])('accepts the zero ETH value %s',async value=>{
    const {client,provider}=setup();await client.transaction({to:escrow,value},'zero ETH');
    expect(provider.request.mock.calls.filter(([p])=>p.method==='eth_sendTransaction')).toHaveLength(1);
  });
  it.each(['1','0x1','-1',''])('rejects an unexpected ETH transfer value %s',async value=>{
    const {client,provider}=setup();await expect(client.transaction({to:escrow,value},'unexpected ETH')).rejects.toThrow();expect(provider.request).not.toHaveBeenCalled();
  });
  it('accepts the actual backend approve and deposit packets for exactly one USDC',async()=>{
    const {client,provider}=setup();const config=loadConfig({MODE:'demo',SIGNER_PRIVATE_KEY:generatePrivateKey(),DEMO_PRIVATE_KEY:generatePrivateKey(),ESCROW_ADDRESS:escrow,TOKEN_ADDRESS:owner,DATA_DIR:':memory:'});
    const bridge=new ChainBridge(config),packets=bridge.depositTransactions(1_000_000n);
    for(const packet of packets)await client.transaction(packet,'deposit USDC');
    const sent=provider.request.mock.calls.filter(([p])=>p.method==='eth_sendTransaction');
    expect(sent).toHaveLength(2);expect(packets.map(p=>p.value)).toEqual(['0x0','0x0']);
    expect(client.pending()).toEqual([]);
  });
  it('never broadcasts a transaction to a third party destination',async()=>{const {client,provider}=setup();await expect(client.transaction({to:'0x3333333333333333333333333333333333333333'},'withdraw')).rejects.toThrow('destination');expect(provider.request).not.toHaveBeenCalled()});
  it('rejects a wallet account different from the authenticated owner',async()=>{const {client,provider}=setup();provider.request.mockImplementation(async()=>['0x3333333333333333333333333333333333333333'] as never);await expect(client.transaction({to:escrow},'deposit')).rejects.toThrow('account changed');expect(provider.request).toHaveBeenCalledTimes(1)});
  it('retains an ambiguous submission and prevents resending after reload',async()=>{
    const {client,provider}=setup();provider.request.mockImplementation(async({method})=>{if(method==='eth_accounts')return [owner];if(method==='eth_chainId')return '0x2105';throw Error('wallet disconnected')});
    await expect(client.transaction({to:escrow},'deposit')).rejects.toThrow('disconnected');
    const sent=provider.request.mock.calls.filter(([p])=>p.method==='eth_sendTransaction').length;
    await expect(client.transaction({to:escrow},'deposit')).rejects.toThrow('previous transaction');
    expect(provider.request.mock.calls.filter(([p])=>p.method==='eth_sendTransaction')).toHaveLength(sent);
  });
  it('clears a rejected request so the user can explicitly try again',async()=>{
    const {client,provider}=setup();provider.request.mockImplementation(async({method})=>{if(method==='eth_accounts')return [owner];if(method==='eth_chainId')return '0x2105';throw Object.assign(Error('rejected'),{code:4001})});
    await expect(client.transaction({to:escrow},'deposit')).rejects.toThrow('rejected');expect(client.pending()).toEqual([]);
  });
  it('does not send again when admission failed after a confirmed reservation',async()=>{
    const {client,provider}=setup();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({detail:'Controller unavailable'},{status:503})));
    await expect(client.transaction({to:escrow},'reserve',txHash)).rejects.toThrow('Controller unavailable');
    expect(client.pending()).toMatchObject([{hash:txHash,runId:txHash}]);
    vi.stubGlobal('fetch',vi.fn(async path=>Response.json(String(path).startsWith('/api/transactions/')?{hash:txHash,owner,chainId:8453,status:'confirmed',method:'openRun',runId:txHash,transaction:{to:escrow,data:'0x',value:'0x0'}}:{status:'queued'})));await client.recover();expect(client.pending()).toEqual([]);
    expect(provider.request.mock.calls.filter(([p])=>p.method==='eth_sendTransaction')).toHaveLength(1);
  });
  it('discards an old account response after switching and skips queued old saves',async()=>{
    const {client,changed}=setup();let complete!:(r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{complete=r})));
    const read=client.request('/api/workspace');client.clear();complete(Response.json({owner,document:emptyWorkspace(),revision:1}));await expect(read).rejects.toThrow('account changed');expect(changed).toHaveBeenLastCalledWith(undefined);
    client.address=owner;const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const save=client.save(emptyWorkspace());client.clear();await save;expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('workspace sign-in lifecycle',()=>{
  function login(){
    const fixture=setup();fixture.client.address=undefined;
    let changed:((data:unknown)=>void)|undefined;
    const on=vi.fn((_name:string,handler:(data:unknown)=>void)=>{changed=handler});
    const selected={id:'chosen',key:'chosen',name:'Selected wallet',provider:Object.assign(fixture.provider,{on,removeListener:vi.fn()}) as never};
    fixture.provider.request.mockImplementation(async({method})=>{
      if(method==='eth_requestAccounts'||method==='eth_accounts')return [owner];
      if(method==='personal_sign'){changed?.([owner]);return '0x1234' as never;}
      throw Error('Unexpected method');
    });
    const request=vi.spyOn(fixture.client,'request').mockImplementation(async path=>{
      if(path==='/api/auth/challenge')return {nonce:'nonce',message:'Sign in'};
      if(path==='/api/workspace')return {owner,revision:1,document:emptyWorkspace()};
      return {};
    });
    return {...fixture,selected,request,emit:(accounts:unknown)=>changed?.(accounts)};
  }
  it('keeps the session when the wallet repeats its selected accounts during signing',async()=>{
    const {client,selected,request}=login();await client.connect(selected);
    expect(client.address).toBe(owner);expect(client.connecting).toBe(false);
    expect(request.mock.calls.some(([path])=>path==='/api/auth/logout')).toBe(false);
  });
  it('publishes the connected workspace after the Phantom sign-in lock is released',async()=>{
    const {client,selected,changed}=login();const phases:boolean[]=[];
    changed.mockImplementation(doc=>{if(doc)phases.push(client.connecting)});
    await client.connect({...selected,name:'Phantom'});
    expect(phases).toEqual([false]);expect(changed).toHaveBeenLastCalledWith(emptyWorkspace(),'session-ready');
  });
  it('rejects a changed owner during signing before verification or document loading',async()=>{
    const {client,provider,selected,request,emit}=login();provider.request.mockImplementation(async({method})=>{
      if(method==='eth_requestAccounts')return [owner];emit(['0x3333333333333333333333333333333333333333']);return '0x1234' as never;
    });
    await expect(client.connect(selected)).rejects.toThrow('changed');
    expect(request.mock.calls.some(([path])=>path==='/api/auth/verify')).toBe(false);expect(client.connecting).toBe(false);
  });
  it('serializes repeated clicks and releases the connection lock after rejection',async()=>{
    const {client,provider,selected}=login();let reject!:(reason:unknown)=>void;
    provider.request.mockImplementation(()=>new Promise((_,r)=>{reject=r}));
    const original=client.connect(selected);await expect(client.connect(selected)).rejects.toThrow('already open');
    reject({code:4001});await expect(original).rejects.toThrow('cancelled');expect(client.connecting).toBe(false);
    expect(provider.request).toHaveBeenCalledOnce();
  });
  it('does not let a stuck wallet leave the connect button busy indefinitely',async()=>{
    vi.useFakeTimers();
    try{const {client,provider,selected}=login();provider.request.mockImplementation(()=>new Promise(()=>{}));
      const pending=expect(client.connect(selected)).rejects.toThrow('timed out');await vi.advanceTimersByTimeAsync(90001);await pending;expect(client.connecting).toBe(false);
    }finally{vi.useRealTimers()}
  });
});

describe('workspace updates without a page reload',()=>{
  it('publishes the saved document to the UI after the write is confirmed',async()=>{
    const f=setup(),document={...emptyWorkspace(),budget:42};vi.spyOn(f.client,'request').mockResolvedValue({revision:1});
    await f.client.save(document);expect(f.client.document).toEqual(document);expect(f.changed).toHaveBeenLastCalledWith(document,'saved');
  });
  it('does not let an old background read overwrite a newly saved object',async()=>{
    const f=setup(),saved={...emptyWorkspace(),budget:42};let finishRead!:(value:unknown)=>void;
    vi.spyOn(f.client,'request').mockImplementation(async(_path,body)=>body===undefined?new Promise(resolve=>{finishRead=resolve}):{revision:2});
    const reading=f.client.load(owner);await Promise.resolve();await f.client.save(saved);
    finishRead({owner,revision:1,document:emptyWorkspace()});await reading;
    expect(f.client.revision).toBe(2);expect(f.client.document).toEqual(saved);expect(f.changed).toHaveBeenCalledOnce();
  });
  it('does not apply a focus-triggered reload after the user opens an editor',async()=>{
    const f=setup();let finishRead!:(value:unknown)=>void;
    vi.spyOn(f.client,'request').mockImplementation(async()=>new Promise(resolve=>{finishRead=resolve}));
    const reading=f.client.load(owner);await Promise.resolve();f.client.cancelWorkspaceReload();
    finishRead({owner,revision:10,document:{...emptyWorkspace(),budget:42}});await reading;
    expect(f.changed).not.toHaveBeenCalled();expect(f.client.revision).toBe(0);
  });
  it('cancels the startup read even if an editor opens before the workspace request begins',async()=>{
    const f=setup(),config=f.client.config;let finishMe!:(value:unknown)=>void;
    const request=vi.spyOn(f.client,'request').mockImplementation(async path=>path==='/api/config'?config:path==='/api/me'?new Promise(resolve=>{finishMe=resolve}):{owner,revision:1,document:emptyWorkspace()});
    const reading=f.client.start();await Promise.resolve();await Promise.resolve();f.client.cancelWorkspaceReload();finishMe({address:owner});await reading;
    expect(request.mock.calls.some(([path])=>path==='/api/workspace')).toBe(false);expect(f.changed).not.toHaveBeenCalled();
  });
  it('still reports an authenticated workspace reload failure',async()=>{
    const f=setup(),config=f.client.config;
    vi.spyOn(f.client,'request').mockImplementation(async path=>{if(path==='/api/config')return config;if(path==='/api/me')return {address:owner};throw Error('Workspace unavailable')});
    await expect(f.client.start()).rejects.toThrow('Workspace unavailable');
  });
  it('publishes only the newest of overlapping reloads',async()=>{
    const f=setup();const reads:Array<(value:unknown)=>void>=[];
    vi.spyOn(f.client,'request').mockImplementation(async()=>new Promise(resolve=>reads.push(resolve)));
    const first=f.client.load(owner);await Promise.resolve();const second=f.client.load(owner);await Promise.resolve();
    reads[1]!({owner,revision:2,document:{...emptyWorkspace(),budget:42}});await second;
    reads[0]!({owner,revision:1,document:emptyWorkspace()});await first;
    expect(f.client.revision).toBe(2);expect(f.client.document?.budget).toBe(42);expect(f.changed).toHaveBeenCalledOnce();
  });
  it('waits for queued saves before requesting a fresh document',async()=>{
    const f=setup();let finishWrite!:(value:unknown)=>void;
    const request=vi.spyOn(f.client,'request').mockImplementation(async(_path,body)=>body?new Promise(resolve=>{finishWrite=resolve}):{owner,revision:1,document:{...emptyWorkspace(),budget:42}});
    const saving=f.client.save({...emptyWorkspace(),budget:42});await Promise.resolve();const reading=f.client.load(owner);await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();finishWrite({revision:1});await saving;await reading;expect(f.client.document?.budget).toBe(42);
  });
  it('does not publish an earlier queued save over a newer one',async()=>{
    const f=setup();let revision=0;vi.spyOn(f.client,'request').mockImplementation(async()=>({revision:++revision}));
    const first=f.client.save({...emptyWorkspace(),budget:10}),second=f.client.save({...emptyWorkspace(),budget:20});await Promise.all([first,second]);
    expect(f.changed).toHaveBeenCalledOnce();expect(f.client.document?.budget).toBe(20);expect(f.client.revision).toBe(2);
  });
  it('preserves the previous UI document if a save fails and marks the failure',async()=>{
    const f=setup();vi.spyOn(f.client,'request').mockRejectedValue(Error('Save failed'));await f.client.save({...emptyWorkspace(),budget:42});
    expect(f.client.saveFailed).toBe(true);expect(f.changed).not.toHaveBeenCalled();
  });
  it('allows saving again after an explicit successful reload resolves a previous conflict',async()=>{
    const f=setup();f.client.saveFailed=true;
    vi.spyOn(f.client,'request').mockImplementation(async(_path,body)=>body?{revision:4}:{owner,revision:3,document:emptyWorkspace()});
    await f.client.load(owner);expect(f.client.saveFailed).toBe(false);await f.client.save({...emptyWorkspace(),budget:42});
    expect(f.client.document?.budget).toBe(42);expect(f.client.revision).toBe(4);
  });
});


describe('pending wallet recovery without rebroadcast',()=>{
  function recovery(entry:object={operation:'Leash first',hash:txHash}){
    const fixture=setup();fixture.entries.set(fixture.client.journalKey(),JSON.stringify([entry]));
    const result={hash:txHash,owner,chainId:8453,status:'confirmed',method:'createLeash',leashId:txHash,transaction:{to:escrow,data:'0x1234',value:'0x0'}};
    const state={owner,chainId:8453,latestNonce:'0',pendingNonce:'0',ethBalanceWei:'0'};
    const request=vi.spyOn(fixture.client,'request').mockImplementation(async path=>path.endsWith('/recovery-state')?state:result);
    return {...fixture,result,state,request};
  }
  it('verifies a confirmed legacy Leash without asking the wallet to send anything',async()=>{
    const {client,provider,entries}=recovery();expect(await client.recover()).toMatchObject([{status:'confirmed',method:'createLeash'}]);
    expect(client.pending()).toEqual([]);expect(provider.request).not.toHaveBeenCalled();
    expect(entries.get(client.journalKey()+':resolved')).toContain(txHash);
  });
  it('recovers a missing hash only after matching the original calldata',async()=>{
    const {client,provider}=recovery({operation:'Leash first',intent:{to:escrow,data:'0x1234'}});
    await expect(client.recover()).rejects.toThrow('did not return');expect(client.pending()).toHaveLength(1);
    await client.recover(txHash);expect(client.pending()).toEqual([]);expect(provider.request).not.toHaveBeenCalled();
  });
  it('keeps an unrelated hash out of a hashless entry',async()=>{
    const {client}=recovery({operation:'Leash first',intent:{to:escrow,data:'0x9999'}});
    await expect(client.recover(txHash)).rejects.toThrow('original transaction');expect(client.pending()[0]?.hash).toBeUndefined();
  });
  it.each([{owner:'0x3333333333333333333333333333333333333333'},{chainId:1},{hash:'0x'+'cd'.repeat(32)}])('retains the journal for a mismatched recovery identity %j',async wrong=>{
    const {client,result}=recovery();Object.assign(result,wrong);await expect(client.recover()).rejects.toThrow('identity');expect(client.pending()).toHaveLength(1);
  });
  it('rejects a different action for an old entry with no calldata',async()=>{
    const {client,result}=recovery();result.method='withdraw';await expect(client.recover()).rejects.toThrow('different wallet action');expect(client.pending()).toHaveLength(1);
  });
  it('retains pending and RPC-failed operations without another send',async()=>{
    const {client,result,request,provider}=recovery();result.status='pending';await expect(client.recover()).rejects.toThrow('still pending');
    request.mockRejectedValue(Error('RPC offline'));await expect(client.recover()).rejects.toThrow('RPC offline');expect(client.pending()).toHaveLength(1);expect(provider.request).not.toHaveBeenCalled();
  });
  it('archives a reverted operation, allowing only a subsequent explicit retry',async()=>{
    const {client,result,provider}=recovery();result.status='reverted';expect(await client.recover()).toMatchObject([{status:'reverted'}]);expect(client.pending()).toEqual([]);expect(provider.request).not.toHaveBeenCalled();
  });
  it('does not erase a journal changed while verification was in progress',async()=>{
    const {client,entries,request,result}=recovery();request.mockImplementation(async()=>{entries.set(client.journalKey(),JSON.stringify([{operation:'Leash another'}]));return result});
    await expect(client.recover()).rejects.toThrow('another tab');expect(client.pending()).toMatchObject([{operation:'Leash another'}]);
  });
  it('requires explicit acknowledgement to clear an old hashless Leash',async()=>{
    const {client,provider,entries}=recovery({operation:'Leash first'});
    await expect(client.discardUnsentLeash(false)).rejects.toThrow('Confirm');expect(client.pending()).toHaveLength(1);
    await client.discardUnsentLeash(true);expect(client.pending()).toEqual([]);expect(provider.request).not.toHaveBeenCalled();expect(entries.get(client.journalKey()+':resolved')).toContain('not_broadcast_reported');
  });
  it.each([{operation:'deposit USDC'},{operation:'Leash first',hash:txHash},{operation:'Leash first',runId:txHash}])('does not clear a submitted or monetary operation %j',async entry=>{
    const {client}=recovery(entry);await expect(client.discardUnsentLeash(true)).rejects.toThrow('Only an unsent Leash');expect(client.pending()).toHaveLength(1);
  });
  it('retains the failed request if Base still reports a pending nonce',async()=>{
    const {client,state}=recovery({operation:'Leash first'});state.pendingNonce='1';await expect(client.discardUnsentLeash(true)).rejects.toThrow('pending wallet transaction');expect(client.pending()).toHaveLength(1);
  });
  it('checks ETH before preparing a new Leash without writing a pending entry',async()=>{
    const {client,state,provider}=recovery();await client.recover();await expect(client.ensureGas()).rejects.toThrow('Add ETH');expect(client.pending()).toEqual([]);state.ethBalanceWei='100000000000000';await client.ensureGas();expect(provider.request).not.toHaveBeenCalled();
  });
  it('records an insufficient-gas rejection as unsent rather than blocking all future actions',async()=>{
    const {client,provider,entries}=setup();const original=provider.request.getMockImplementation()!;
    provider.request.mockImplementation(async args=>{if(args.method==='eth_sendTransaction')throw Object.assign(Error('insufficient funds for gas * price + value'),{code:-32000});return original(args)});
    await expect(client.transaction({to:escrow,data:'0x1234'},'Leash first')).rejects.toThrow('Insufficient ETH');expect(client.pending()).toEqual([]);expect(entries.get(client.journalKey()+':resolved')).toContain('insufficient_gas');
  });
  it('uses the same cross-tab lock for recovery and submission',async()=>{
    const {client,request}=recovery();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:(lock:null)=>unknown)=>run(null)}});
    await expect(client.recover()).rejects.toThrow('Another tab');expect(request).not.toHaveBeenCalled();expect(client.pending()).toHaveLength(1);
  });
});

describe('hashless CPU request recovery and funding preflight',()=>{
  function cpu(){
    const fixture=setup(),entry={operation:'CPU reservation',runId:txHash,intent:{to:escrow,data:'0x1234'}};
    fixture.entries.set(fixture.client.journalKey(),JSON.stringify([entry]));
    const result={state:'expired_unused',owner,chainId:8453,runId:txHash,transaction:entry.intent,quoteExpiry:'1000',chainTimestamp:'1001',latestNonce:'2',pendingNonce:'2',hash:txHash};
    const request=vi.spyOn(fixture.client,'request').mockImplementation(async()=>result);
    return {...fixture,entry,result,request};
  }
  it('checks Base without requiring a hash, asking the wallet or clearing the journal',async()=>{
    const f=cpu();expect(await f.client.checkPendingCpu()).toMatchObject({state:'expired_unused'});
    expect(f.request).toHaveBeenCalledWith('/api/runs/'+txHash+'/recovery');expect(f.provider.request).not.toHaveBeenCalled();expect(f.client.pending()).toHaveLength(1);
  });
  it('only clears an expired unused quote after explicit acknowledgement and fresh verification',async()=>{
    const f=cpu();await expect(f.client.discardExpiredReservation(false)).rejects.toThrow('Close');
    await f.client.discardExpiredReservation(true);expect(f.client.pending()).toEqual([]);expect(f.entries.get(f.client.journalKey()+':resolved')).toContain('expired_quote_not_reserved');
    expect(f.provider.request).not.toHaveBeenCalled();
  });
  it.each([{state:'awaiting_wallet'},{state:'transaction_found'},{chainTimestamp:'1000'},{pendingNonce:'3'},
    {owner:'0x3333333333333333333333333333333333333333'},{chainId:1},{runId:'0x'+'cd'.repeat(32)},{transaction:{to:escrow,data:'0x9999'}}])('retains the journal for an unsafe clear %j',async wrong=>{
    const f=cpu();Object.assign(f.result,wrong);await expect(f.client.discardExpiredReservation(true)).rejects.toThrow();expect(f.client.pending()).toHaveLength(1);expect(f.provider.request).not.toHaveBeenCalled();
  });
  it('retains the journal on RPC failure or a concurrent journal change',async()=>{
    const f=cpu();f.request.mockRejectedValueOnce(Error('RPC offline'));await expect(f.client.discardExpiredReservation(true)).rejects.toThrow('RPC offline');
    f.request.mockImplementation(async()=>{f.entries.set(f.client.journalKey(),JSON.stringify([{...f.entry,operation:'another action'}]));return f.result});
    await expect(f.client.discardExpiredReservation(true)).rejects.toThrow('another tab');expect(f.client.pending()).toHaveLength(1);
  });
  it('recovers the original CPU transaction automatically and resumes admission exactly once',async()=>{
    const f=cpu();f.result.state='transaction_found';f.request.mockImplementation(async path=>path.endsWith('/recovery')?f.result:path.startsWith('/api/transactions/')?
      {hash:txHash,owner,chainId:8453,method:'openRun',status:'confirmed',runId:txHash,transaction:f.entry.intent}:{status:'queued'});
    expect(await f.client.recover()).toMatchObject([{status:'confirmed',method:'openRun'}]);expect(f.client.pending()).toEqual([]);
    expect(f.request.mock.calls.filter(([path])=>path==='/api/runs')).toHaveLength(1);expect(f.provider.request).not.toHaveBeenCalled();
  });
  it('leaves a found hash in the journal if admission is temporarily unavailable',async()=>{
    const f=cpu();f.result.state='transaction_found';f.request.mockImplementation(async path=>{
      if(path.endsWith('/recovery'))return f.result;if(path==='/api/runs')throw Error('Admission offline');
      return {hash:txHash,owner,chainId:8453,method:'openRun',status:'confirmed',runId:txHash,transaction:f.entry.intent};
    });await expect(f.client.recover()).rejects.toThrow('Admission offline');expect(f.client.pending()).toMatchObject([{hash:txHash}]);expect(f.provider.request).not.toHaveBeenCalled();
  });
  it('blocks insufficient escrow funding before any wallet request or pending journal entry',async()=>{
    const f=setup();vi.spyOn(f.client,'request').mockResolvedValue({available:'0'});
    await expect(f.client.ensureCpuFunds('12000')).rejects.toThrow('0.012 USDC');expect(f.client.pending()).toEqual([]);expect(f.provider.request).not.toHaveBeenCalled();
  });
  it('uses the exact available amount and accepts a fully funded ceiling',async()=>{
    const f=setup();vi.spyOn(f.client,'request').mockResolvedValue({available:'12000',reserved:'999999'});await f.client.ensureCpuFunds('12000');expect(f.provider.request).not.toHaveBeenCalled();
  });
});

describe('deposit funding preflight',()=>{
  function funds(){const f=setup(),state={owner,chainId:8453,tokenAddress:owner,ethBalanceWei:'100000000000000',usdcAtomic:'1000000'};const request=vi.spyOn(f.client,'request').mockImplementation(async()=>state);return {...f,state,request}}
  it('stops a deposit with ETH but no USDC before requesting any wallet transaction',async()=>{
    const f=funds();f.state.usdcAtomic='0';await expect(f.client.ensureDepositFunds('1000000')).rejects.toThrow('ETH only pays');expect(f.client.pending()).toEqual([]);expect(f.provider.request).not.toHaveBeenCalled();
  });
  it('stops a deposit without ETH, even when USDC is available',async()=>{
    const f=funds();f.state.ethBalanceWei='0';await expect(f.client.ensureDepositFunds('1000000')).rejects.toThrow('Add ETH');expect(f.client.pending()).toEqual([]);expect(f.provider.request).not.toHaveBeenCalled();
  });
  it('accepts an exact six-decimal USDC balance',async()=>{const f=funds();await f.client.ensureDepositFunds('1000000');f.state.usdcAtomic='999999';await expect(f.client.ensureDepositFunds('1000000')).rejects.toThrow('0.999999 USDC');expect(f.provider.request).not.toHaveBeenCalled()});
  it.each([{owner:escrow},{chainId:1},{tokenAddress:escrow}])('rejects a funding response from the wrong account or network %j',async wrong=>{const f=funds();Object.assign(f.state,wrong);await expect(f.client.ensureDepositFunds('1000000')).rejects.toThrow('does not match');expect(f.client.pending()).toEqual([])});
  it('retains the journal unchanged when funding RPC fails',async()=>{const f=funds();f.request.mockRejectedValue(Error('RPC offline'));await expect(f.client.ensureDepositFunds('1')).rejects.toThrow('RPC offline');expect(f.client.pending()).toEqual([]);expect(f.provider.request).not.toHaveBeenCalled()});
});

describe('reported unsent wallet request recovery',()=>{
  function old(){const f=setup(),state={owner,chainId:8453,latestNonce:'2',pendingNonce:'2',ethBalanceWei:'1000'},balance={available:'0',reserved:'0'};f.entries.set(f.client.journalKey(),JSON.stringify([{operation:'deposit USDC'}]));const request=vi.spyOn(f.client,'request').mockImplementation(async path=>path==='/api/balance'?balance:state);vi.useFakeTimers();vi.setSystemTime(100000);return {...f,state,balance,request}}
  afterEach(()=>vi.useRealTimers());
  it('requires explicit wallet rejection acknowledgement and two spaced checks',async()=>{const f=old();await expect(f.client.discardUnsentRequest(false)).rejects.toThrow('Confirm');expect(await f.client.checkUnsentRequest()).toMatchObject({canClose:false});await expect(f.client.discardUnsentRequest(true)).rejects.toThrow('two consistent');vi.setSystemTime(110000);expect(await f.client.checkUnsentRequest()).toMatchObject({canClose:true});await f.client.discardUnsentRequest(true);expect(f.client.pending()).toEqual([]);expect(f.entries.get(f.client.journalKey()+':resolved')).toContain('user_reported_not_sent');expect(f.provider.request).not.toHaveBeenCalled()});
  it('never closes while a wallet transaction is pending',async()=>{const f=old();await f.client.checkUnsentRequest();vi.setSystemTime(110000);f.state.pendingNonce='3';await expect(f.client.discardUnsentRequest(true)).rejects.toThrow('two consistent');expect(f.client.pending()).toHaveLength(1);expect(f.provider.request).not.toHaveBeenCalled()});
  it.each(['nonce','balance','journal'])('restarts verification when %s changes',async change=>{const f=old();await f.client.checkUnsentRequest();vi.setSystemTime(110000);if(change==='nonce')f.state.latestNonce=f.state.pendingNonce='3';if(change==='balance')f.balance.available='1000000';if(change==='journal')f.entries.set(f.client.journalKey(),JSON.stringify([{operation:'deposit USDC',intent:{to:escrow,data:'0x1234'}}]));await expect(f.client.discardUnsentRequest(true)).rejects.toThrow();expect(f.client.pending()).toHaveLength(1)});
  it('retains a request on RPC failure and requires a fresh verification interval afterward',async()=>{const f=old();await f.client.checkUnsentRequest();vi.setSystemTime(110000);f.request.mockRejectedValueOnce(Error('RPC offline'));await expect(f.client.discardUnsentRequest(true)).rejects.toThrow('RPC offline');expect(await f.client.checkUnsentRequest()).toMatchObject({canClose:false});expect(f.client.pending()).toHaveLength(1)});
  it.each([{operation:'deposit USDC',hash:txHash},{operation:'CPU reservation',runId:txHash},{operation:'unknown'}])('retains a request outside this recovery path %j',async entry=>{const f=old();f.entries.set(f.client.journalKey(),JSON.stringify([entry]));await expect(f.client.discardUnsentRequest(true)).rejects.toThrow('original transaction');expect(f.client.pending()).toHaveLength(1)});
  it('rejects a mismatched transaction intent',async()=>{const f=old();f.entries.set(f.client.journalKey(),JSON.stringify([{operation:'deposit USDC',intent:{to:owner,data:'0x1234'}}]));await expect(f.client.checkUnsentRequest()).rejects.toThrow('does not match');expect(f.request).not.toHaveBeenCalled()});
  it('keeps the original entry if another tab changes it during the final check',async()=>{const f=old();await f.client.checkUnsentRequest();vi.setSystemTime(110000);f.request.mockImplementation(async path=>{if(path==='/api/balance'){f.entries.set(f.client.journalKey(),JSON.stringify([{operation:'withdraw USDC'}]));return f.balance}return f.state});await expect(f.client.discardUnsentRequest(true)).rejects.toThrow('journal changed');expect(f.client.pending()).toMatchObject([{operation:'withdraw USDC'}])});
  it('accepts the original approve and deposit intents, without broadcasting either',async()=>{const f=old();const config=loadConfig({MODE:'demo',SIGNER_PRIVATE_KEY:generatePrivateKey(),DEMO_PRIVATE_KEY:generatePrivateKey(),ESCROW_ADDRESS:escrow,TOKEN_ADDRESS:owner,DATA_DIR:':memory:'});const bridge=new ChainBridge(config);for(const intent of bridge.depositTransactions(1000000n)){f.entries.set(f.client.journalKey(),JSON.stringify([{operation:'deposit USDC',intent}]));await f.client.checkUnsentRequest();vi.setSystemTime(Date.now()+10000);await f.client.discardUnsentRequest(true);expect(f.client.pending()).toEqual([])}expect(f.provider.request).not.toHaveBeenCalled()});
  it('uses the wallet lock and refuses concurrent recovery',async()=>{const f=old();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:(lock:null)=>unknown)=>run(null)}});await expect(f.client.discardUnsentRequest(true)).rejects.toThrow('Another tab');expect(f.request).not.toHaveBeenCalled()});
});
