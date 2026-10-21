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
