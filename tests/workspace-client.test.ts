import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceClient } from '../public/workspace-client.js';
import { emptyWorkspace } from '../src/workspace/routes.js';
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
  client.config={mode:'mainnet',chain:{id:8453,name:'Base',rpcUrl:'https://mainnet.base.org'},token:{address:owner,symbol:'USDC',decimals:6},escrowAddress:escrow,cpuMode:'docker',prices:{cpuPerSecond:'100',maxSeconds:120},platform:{agentLifecycle:false},cystsAvailable:true};
  return {client,provider,changed,entries};
}
afterEach(()=>vi.unstubAllGlobals());
describe('workspace wallet safety',()=>{
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
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({status:'queued'})));await client.recover();expect(client.pending()).toEqual([]);
    expect(provider.request.mock.calls.filter(([p])=>p.method==='eth_sendTransaction')).toHaveLength(1);
  });
  it('discards an old account response after switching and skips queued old saves',async()=>{
    const {client,changed}=setup();let complete!:(r:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{complete=r})));
    const read=client.request('/api/workspace');client.clear();complete(Response.json({owner,document:emptyWorkspace(),revision:1}));await expect(read).rejects.toThrow('account changed');expect(changed).toHaveBeenLastCalledWith(undefined);
    client.address=owner;const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const save=client.save(emptyWorkspace());client.clear();await save;expect(fetcher).not.toHaveBeenCalled();
  });
});
