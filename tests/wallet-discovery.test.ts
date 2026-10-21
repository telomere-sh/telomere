import {describe,it,expect,vi,afterEach} from 'vitest';
import {WalletRegistry,savedWallet,rememberWallet,walletError,type WalletHost} from '../public/wallet-picker.js';

function wallet(flags:Record<string,unknown>={}) {return {...flags,request:vi.fn(async()=>[])};}
function host():WalletHost {return new EventTarget();}
function announce(target:WalletHost,value:unknown) {target.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:value}));}
afterEach(()=>vi.unstubAllGlobals());
describe('explicit wallet discovery',()=>{
  it('lists EIP-6963 providers independently without opening a wallet or signing',()=>{
    const target=host(),okx=wallet(),rainbow=wallet(),registry=new WalletRegistry(target);
    announce(target,{info:{uuid:'okx',name:'OKX Wallet',rdns:'com.okx'},provider:okx});
    announce(target,{info:{uuid:'rainbow',name:'Rainbow',rdns:'me.rainbow'},provider:rainbow});
    expect(registry.list().map(x=>x.name)).toEqual(['OKX Wallet','Rainbow']);
    expect(okx.request).not.toHaveBeenCalled();expect(rainbow.request).not.toHaveBeenCalled();
  });
  it('deduplicates legacy aliases and upgrades them to the announced identity',()=>{
    const target=host(),okx=wallet();target.okxwallet=okx;target.ethereum=okx;
    const registry=new WalletRegistry(target);expect(registry.list()).toHaveLength(1);
    announce(target,{info:{uuid:'okx',name:'OKX Wallet',rdns:'com.okx'},provider:okx});registry.refresh();
    expect(registry.list()).toMatchObject([{id:'eip6963:okx',key:'com.okx'}]);
  });
  it('notifies an open chooser when a provider arrives later',()=>{
    const target=host(),registry=new WalletRegistry(target),listener=vi.fn();registry.subscribe(listener);
    announce(target,{info:{uuid:'late',name:'MetaMask',rdns:'io.metamask'},provider:wallet()});
    expect(listener).toHaveBeenCalledOnce();expect(registry.list()[0]?.name).toBe('MetaMask');
  });
  it('reads a legacy providers array and identifies Rainbow before its MetaMask compatibility flag',()=>{
    const target=host();target.ethereum={providers:[wallet({isMetaMask:true,isRainbow:true}),wallet({isMetaMask:true})]};
    expect(new WalletRegistry(target).list().map(x=>x.name)).toEqual(['MetaMask','Rainbow']);
  });
  it('rediscovers a replaced legacy injection rather than retaining the old default',()=>{
    const target=host();target.ethereum=wallet({isRainbow:true});const registry=new WalletRegistry(target);
    target.ethereum=wallet({isMetaMask:true});registry.refresh();expect(registry.list().map(x=>x.name)).toEqual(['MetaMask']);
  });
  it('ignores invalid announcements and caps extension-provided entries',()=>{
    const target=host(),registry=new WalletRegistry(target);
    for(const detail of [null,{}, {info:{uuid:'bad',name:'Broken'},provider:{}},{info:{uuid:'',name:'x'},provider:wallet()}])announce(target,detail);
    expect(registry.list()).toEqual([]);
    for(let i=0;i<45;i++)announce(target,{info:{uuid:String(i),name:'Wallet '+i},provider:wallet()});
    expect(registry.list()).toHaveLength(32);
  });
  it('restores the chosen wallet by its persistent identity, never by injection order',()=>{
    const target=host(),rainbow=wallet({isRainbow:true}),okx=wallet({isOkxWallet:true}),entries=new Map<string,string>();
    target.ethereum=rainbow;target.okxwallet=okx;vi.stubGlobal('window',target);
    vi.stubGlobal('localStorage',{getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>entries.set(k,v)});
    expect(savedWallet()).toBeUndefined();
    rememberWallet({id:'legacy:okx',key:'okx',name:'OKX Wallet',provider:okx as never});
    expect(savedWallet()?.provider).toBe(okx);expect(rainbow.request).not.toHaveBeenCalled();
  });
  it('reports wallet cancellation and pending requests with a next step',()=>{
    expect(walletError({code:4001})).toContain('cancelled');expect(walletError({code:-32002})).toContain('already open');
  });
});
