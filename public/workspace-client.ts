import { z } from 'zod';

import { getAddress, isAddress, toHex, type EIP1193Provider, type Address, type Hex } from 'viem';

import type { workspaceSchema } from '../src/workspace/routes.js';

type Document = z.infer<typeof workspaceSchema>;

const address = z.string().refine(isAddress).transform(v => getAddress(v));

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform(v => v as Hex);

const txSchema = z.object({to:address,data:hex.optional(),value:z.enum(['0','0x0']).optional()});

const configSchema = z.object({mode:z.string(),chain:z.object({id:z.number(),name:z.string(),rpcUrl:z.string(),explorerUrl:z.string().optional()}),

  token:z.object({address,symbol:z.string(),decimals:z.literal(6)}),escrowAddress:address,cpuMode:z.string(),

  prices:z.object({cpuPerSecond:z.string(),maxSeconds:z.number().int().min(1).max(120)}),
  receiptSigner:address.optional(),nearAvailable:z.boolean().default(false),
  platform:z.object({agentLifecycle:z.boolean(),receiptRootAddress:address.nullable().default(null)}),cystsAvailable:z.boolean()});

type Config = z.infer<typeof configSchema>;

type EventProvider = EIP1193Provider & {on?:(name:string,handler:(data:unknown)=>void)=>void;removeListener?:(name:string,handler:(data:unknown)=>void)=>void};

declare global { interface Window { okxwallet?: EventProvider } }

export class WorkspaceClient {

  address: Address | undefined;

  config: Config | undefined;

  revision = 0;

  version = 0;

  provider: EventProvider | undefined;

  saving = Promise.resolve();

  saveFailed = false;

  financialBusy = false;

  document: Document | undefined;
  readonly channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('telomere-wallet-session-v1') : undefined;

  constructor(readonly changed:(doc:Document|undefined)=>void,readonly notice:(text:string)=>void) {if(this.channel)this.channel.onmessage=event=>{if(this.address && event.data?.owner!==this.address.toLowerCase()){this.clear();this.notice('Wallet session changed in another tab. Sign in again.')}}}

  async request(path:string,body?:unknown,method='POST'):Promise<unknown> {

    const version=this.version;

    const r=await fetch(path,{credentials:'same-origin',cache:'no-store',headers:{...(this.address?{'X-Telomere-Owner':this.address}:{})},...(body===undefined?{}:{method,headers:{...(this.address?{'X-Telomere-Owner':this.address}:{}),'Content-Type':'application/json','Idempotency-Key':path==='/api/cysts'?'checkpoint-'+z.object({id:z.string()}).parse(body).id:crypto.randomUUID()},body:JSON.stringify(body)})});

    const data:unknown=await r.json();

    if(version!==this.version)throw Error('The account changed. Review the action again.');

    if(!r.ok){if(this.address&&(r.status===401||z.object({title:z.literal('session_owner_changed')}).safeParse(data).success))this.clear();throw Error(z.object({detail:z.string()}).safeParse(data).data?.detail??`Request failed (${r.status}).`)}

    return data;

  }

  clear(){this.version++;this.address=undefined;this.document=undefined;this.revision=0;this.saveFailed=false;this.changed(undefined)}

  async start(){this.config=configSchema.parse(await this.request('/api/config'));try{const me=z.object({address}).parse(await this.request('/api/me'));await this.load(me.address)}catch(error){if(this.address)throw error;this.changed(undefined)}}

  async load(owner:Address){const doc=z.object({owner:address,revision:z.number(),document:z.unknown()}).parse(await this.request('/api/workspace'));

    if(doc.owner.toLowerCase()!==owner.toLowerCase())throw Error('Session owner mismatch.');

    this.address=owner;this.revision=doc.revision;this.document=doc.document as Document;this.changed(this.document)}

  accountChanged=()=>{this.clear();void this.request('/api/auth/logout',{}).catch(()=>{});this.notice('Wallet changed. Sign in again to open its workspace.')};

  async connect(){

    if(this.financialBusy)throw Error('Wait for the pending wallet operation.');

    const found=window.okxwallet??window.ethereum;

    if(!found)throw Error('Open this page in OKX Wallet’s DApp browser, or enable your browser wallet.');

    const provider=found as EventProvider;

    this.provider?.removeListener?.('accountsChanged',this.accountChanged);

    this.clear();this.provider=provider;provider.on?.('accountsChanged',this.accountChanged);

    const accounts=z.array(address).parse(await provider.request({method:'eth_requestAccounts'}));const owner=accounts[0];if(!owner)throw Error('No wallet selected.');

    const generation=this.version;

    const challenge=z.object({nonce:z.string(),message:z.string()}).parse(await this.request('/api/auth/challenge',{address:owner}));

    const signature=await provider.request({method:'personal_sign',params:[toHex(challenge.message),owner]});

    if(generation!==this.version)throw Error('Wallet changed during sign-in.');

    await this.request('/api/auth/verify',{address:owner,nonce:challenge.nonce,signature});

    const current=z.array(address).parse(await provider.request({method:'eth_accounts'}));

    if(current[0]?.toLowerCase()!==owner.toLowerCase()){this.accountChanged();throw Error('Wallet changed during sign-in.')}

    await this.load(owner);this.channel?.postMessage({owner:owner.toLowerCase()});this.notice('Signed in. Your workspace is private to this wallet.');

  }

  async demo(){if(this.config?.mode!=='demo')throw Error('Demo login is disabled.');const me=z.object({address}).parse(await this.request('/api/auth/demo',{}));await this.load(me.address)}
  async logout(){await this.request('/api/auth/logout',{});this.clear();this.channel?.postMessage({owner:null})}

  save(document:Document){

    if(!this.address)throw Error('Connect and sign in to save your workspace.');

    const generation=this.version,copy=structuredClone(document);

    this.saving=this.saving.then(async()=>{

      if(generation!==this.version)return;

      if(this.saveFailed)throw Error('Reload your workspace before saving more changes.');

      const result=z.object({revision:z.number()}).parse(await this.request('/api/workspace',{revision:this.revision,document:copy},'PUT'));

      this.revision=result.revision;this.document=copy;

    }).catch(error=>{if(generation===this.version){this.saveFailed=true;this.notice(error instanceof Error?error.message:'Workspace save failed.')}});

    return this.saving;

  }

  async currentWallet(){

    if(!this.address||!this.config)throw Error('Connect your wallet to approve this action.');
    // A signed session survives reloads; recover the already connected injected wallet.
    if(!this.provider && typeof window !== 'undefined') {
      const injected=window.okxwallet??window.ethereum;
      if(injected){this.provider=injected as EventProvider;this.provider.on?.('accountsChanged',this.accountChanged)}
    }
    if(!this.provider)throw Error('Connect your wallet to approve this action.');

    const owner=this.address,version=this.version,provider=this.provider;

    const accounts=z.array(address).parse(await provider.request({method:'eth_accounts'}));

    if(version!==this.version||accounts[0]?.toLowerCase()!==owner.toLowerCase())throw Error('Wallet account changed. Sign in again.');

    const target=toHex(this.config.chain.id);const chain=await provider.request({method:'eth_chainId'});

    if(BigInt(chain)!==BigInt(target)){

      try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:target}]})}

      catch(error){if((error as {code?:number}).code!==4902)throw error;await provider.request({method:'wallet_addEthereumChain',params:[{chainId:target,chainName:this.config.chain.name,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[this.config.chain.rpcUrl],blockExplorerUrls:[this.config.chain.explorerUrl!]}]})}

    }

    if(version!==this.version||BigInt(await provider.request({method:'eth_chainId'}))!==BigInt(target))throw Error('Select the configured Base network first.');

    const latest=z.array(address).parse(await provider.request({method:'eth_accounts'}));

    if(version!==this.version||latest[0]?.toLowerCase()!==owner.toLowerCase())throw Error('Wallet account changed.');

    return {owner,version,provider};

  }

  journalKey(){if(!this.address||!this.config)throw Error('Sign in first.');return `telomere-transactions-v1:${this.config.chain.id}:${this.address.toLowerCase()}`}

  pending(){return JSON.parse(localStorage.getItem(this.journalKey())??'[]') as {operation:string;hash?:Hex;runId?:Hex}[]}

  async transaction(raw:unknown,operation:string,runId?:Hex){

    if(this.financialBusy)throw Error('Another wallet operation is pending.');

    const tx=txSchema.parse(raw);if(!this.config||![this.config.token.address,this.config.escrowAddress].some(a=>a.toLowerCase()===tx.to.toLowerCase()))throw Error('Unexpected transaction destination.');

    if(!navigator.locks)throw Error('This wallet browser cannot safely lock transactions. Use a current OKX browser or desktop wallet.');

    this.financialBusy=true;

    try{return await navigator.locks.request('telomere-wallet-transaction',{ifAvailable:true},async lock=>{

      if(!lock)throw Error('Another tab is using the wallet.');

      const identity=await this.currentWallet(),key=this.journalKey();

      const entries=this.pending();if(entries.length)throw Error('A previous transaction needs confirmation. Use Check pending transactions first.');

      const entry:{operation:string;hash?:Hex;runId?:Hex}={operation,...(runId?{runId}:{})};entries.push(entry);

      localStorage.setItem(key,JSON.stringify(entries));

      let hash:Hex;

      try{hash=hex.parse(await identity.provider.request({method:'eth_sendTransaction',params:[{from:identity.owner,to:tx.to,data:tx.data??'0x',value:'0x0',chainId:toHex(this.config!.chain.id)}]}))}

      catch(error){if((error as {code?:number}).code===4001)localStorage.removeItem(key);throw error}

      entry.hash=hash;localStorage.setItem(key,JSON.stringify(entries));

      this.notice(`Transaction submitted: ${hash}. Waiting for confirmation.`);

      if(identity.version!==this.version)throw Error('Account changed. The submitted transaction is retained for review.');

      await this.confirm(entry);localStorage.removeItem(key);return hash;

    })}finally{this.financialBusy=false}

  }

  async confirm(entry:{operation:string;hash?:Hex;runId?:Hex}){

    if(!entry.hash)throw Error('Wallet submission outcome is unknown. Inspect wallet history before retrying.');

    const identity=await this.currentWallet();const deadline=Date.now()+120000;

    while(Date.now()<deadline){

      const receipt=await identity.provider.request({method:'eth_getTransactionReceipt',params:[entry.hash]});

      if(identity.version!==this.version)throw Error('Account changed during confirmation.');

      if(receipt){if(BigInt(receipt.status)!==1n){localStorage.removeItem(this.journalKey());throw Error('Transaction reverted. No automatic retry was made.')}

        if(entry.runId)await this.request('/api/runs',{runId:entry.runId,txHash:entry.hash});return;}

      await new Promise(r=>setTimeout(r,1800));

    }

    throw Error('Transaction is still pending. Use Check pending transactions. It will not be sent again.');

  }

  async recover(){const key=this.journalKey();for(const entry of this.pending())await this.confirm(entry);localStorage.removeItem(key);this.notice('Pending transactions checked. Refreshing workspace.')}

}


export { encryptCheckpoint, decryptCheckpoint, exportCystRecoveryKey, importCystRecoveryKey } from '../src/sdk/cysts.js';

export function planningHourlySpend(rate:number,minutes:number,lane:string):number {
  return rate*Math.min(Math.max(minutes,0)/60,1)*(lane==='Sealed'?1.12:1.09);
}
