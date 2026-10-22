import { z } from 'zod';

import { decodeFunctionData, formatUnits, getAddress, isAddress, toHex, type Address, type Hex } from 'viem';
import { escrowAbi, tokenAbi } from '../src/chain/abi.js';

import type { workspaceSchema } from '../src/workspace/routes.js';
import { chooseWallet, rememberWallet, savedWallet, walletError, type WalletOption, type WalletProvider } from './wallet-picker.js';

type Document = z.infer<typeof workspaceSchema>;

const address = z.string().refine(isAddress).transform(v => getAddress(v));

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform(v => v as Hex);

const txSchema = z.object({to:address,data:hex.optional(),value:z.enum(['0','0x0']).optional()});

const transactionHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v as Hex);
const journalEntry = z.object({operation:z.string().min(1).max(160),hash:transactionHash.optional(),runId:transactionHash.optional(),intent:txSchema.optional(),submittedAt:z.number().int().nonnegative().safe().optional()}).strict();
const recoveryResult = z.object({hash:transactionHash,owner:address,chainId:z.number().int(),transaction:txSchema,method:z.string(),status:z.enum(['pending','confirmed','reverted']),leashId:transactionHash.optional(),runId:transactionHash.optional()});
type JournalEntry = z.infer<typeof journalEntry>;
const recoveryState = z.object({owner:address,chainId:z.number().int(),latestNonce:z.string().regex(/^\d+$/),pendingNonce:z.string().regex(/^\d+$/),ethBalanceWei:z.string().regex(/^\d+$/)});
const reservationRecovery = z.discriminatedUnion('state',[
  z.object({state:z.literal('transaction_found'),owner:address,chainId:z.number().int(),runId:transactionHash,transaction:txSchema,hash:transactionHash}),
  z.object({state:z.enum(['expired_unused','awaiting_wallet']),owner:address,chainId:z.number().int(),runId:transactionHash,transaction:txSchema,
    quoteExpiry:z.string().regex(/^\d+$/),chainTimestamp:z.string().regex(/^\d+$/),latestNonce:z.string().regex(/^\d+$/),pendingNonce:z.string().regex(/^\d+$/)})
]);
function rejectedForGas(error:unknown):boolean {
  const seen=new Set<object>();
  const visit=(value:unknown,depth:number):boolean=>{
    if(!value||typeof value!=='object'||depth>4||seen.has(value))return false;
    seen.add(value);const code:unknown=Reflect.get(value,'code'),message:unknown=Reflect.get(value,'message');
    if([-32000,-32003,-32603].includes(Number(code))&&typeof message==='string'&&/\binsufficient funds\b|not enough ETH (?:for|to pay).*gas/i.test(message))return true;
    return ['cause','data','originalError','error'].some(key=>visit(Reflect.get(value,key),depth+1));
  };
  return visit(error,0);
}
function rejectedByWallet(error:unknown):boolean {
  const seen=new Set<object>();
  const visit=(value:unknown,depth:number):boolean=>{
    if(!value||typeof value!=='object'||depth>4||seen.has(value))return false;
    seen.add(value);if(Reflect.get(value,'code')===4001)return true;
    return ['cause','data','originalError','error'].some(key=>visit(Reflect.get(value,key),depth+1));
  };
  return visit(error,0);
}


const configSchema = z.object({mode:z.string(),chain:z.object({id:z.number(),name:z.string(),rpcUrl:z.string(),explorerUrl:z.string().optional()}),

  token:z.object({address,symbol:z.string(),decimals:z.literal(6)}),escrowAddress:address,cpuMode:z.string(),

  prices:z.object({cpuPerSecond:z.string(),maxSeconds:z.number().int().min(1).max(120)}),
  receiptSigner:address.optional(),nearAvailable:z.boolean().default(false),
  platform:z.object({agentLifecycle:z.boolean(),receiptRootAddress:address.nullable().default(null)}),cystsAvailable:z.boolean()});

type Config = z.infer<typeof configSchema>;

type EventProvider = WalletProvider;

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
  connecting = false;
  private connectionOwner: Address | undefined;
  private workspaceMutation = 0;
  private workspaceRead = 0;
  private unsentReview: { key:string; snapshot:string; nonce:string; balance:string; since:number } | undefined;

  document: Document | undefined;
  readonly channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('telomere-wallet-session-v1') : undefined;

  constructor(readonly changed:(doc:Document|undefined,reason?:'saved'|'session-ready')=>void,readonly notice:(text:string)=>void) {if(this.channel)this.channel.onmessage=event=>{if(this.address && event.data?.owner!==this.address.toLowerCase()){this.clear();this.notice('Wallet session changed in another tab. Sign in again.')}}}

  async request(path:string,body?:unknown,method='POST'):Promise<unknown> {

    const version=this.version;

    const r=await fetch(path,{signal:AbortSignal.timeout(30000),credentials:'same-origin',cache:'no-store',headers:{...(this.address?{'X-Telomere-Owner':this.address}:{})},...(body===undefined?{}:{method,headers:{...(this.address?{'X-Telomere-Owner':this.address}:{}),'Content-Type':'application/json','Idempotency-Key':path==='/api/cysts'?'checkpoint-'+z.object({id:z.string()}).parse(body).id:crypto.randomUUID()},body:JSON.stringify(body)})});

    const data:unknown=await r.json();

    if(version!==this.version)throw Error('The account changed. Review the action again.');

    if(!r.ok){if(this.address&&(r.status===401||z.object({title:z.literal('session_owner_changed')}).safeParse(data).success))this.clear();throw Error(z.object({detail:z.string()}).safeParse(data).data?.detail??`Request failed (${r.status}).`)}

    return data;

  }

  clear(){this.version++;this.workspaceMutation++;this.workspaceRead++;this.unsentReview=undefined;this.address=undefined;this.document=undefined;this.revision=0;this.saveFailed=false;this.changed(undefined)}
  cancelWorkspaceReload(){this.workspaceRead++}

  async start(){if(this.connecting||this.financialBusy)return;const generation=this.version,read=this.workspaceRead;try{this.config=configSchema.parse(await this.request('/api/config'));if(this.connecting||read!==this.workspaceRead)return;const me=z.object({address}).parse(await this.request('/api/me'));if(read!==this.workspaceRead)return;await this.load(me.address)}catch(error){if(generation!==this.version||this.connecting)return;if(this.address)throw error;this.changed(undefined)}}

  async load(owner:Address){
    const generation=this.version,read=++this.workspaceRead,mutation=this.workspaceMutation;
    await this.saving;
    if(generation!==this.version||read!==this.workspaceRead||mutation!==this.workspaceMutation)return;
    const doc=z.object({owner:address,revision:z.number(),document:z.unknown()}).parse(await this.request('/api/workspace'));

    if(doc.owner.toLowerCase()!==owner.toLowerCase())throw Error('Session owner mismatch.');

    if(generation!==this.version||read!==this.workspaceRead||mutation!==this.workspaceMutation)return;
    this.address=owner;this.revision=doc.revision;this.document=doc.document as Document;this.saveFailed=false;if(!this.connecting)this.changed(this.document)}

  accountChanged=(accounts:unknown)=>{const expected=this.address??this.connectionOwner;if(Array.isArray(accounts)&&typeof accounts[0]==='string'&&accounts[0].toLowerCase()===expected?.toLowerCase())return;this.clear();void this.request('/api/auth/logout',{}).catch(()=>{});this.notice('Wallet changed. Sign in again to open its workspace.')};

  async connect(selection?:WalletOption){
    if(this.financialBusy)throw Error('Wait for the pending wallet operation.');
    if(this.connecting)throw Error('A wallet connection is already open. Complete or close it first.');
    this.connecting=true;
    try{
      const chosen=selection??await chooseWallet();if(!chosen)return;
      this.provider?.removeListener?.('accountsChanged',this.accountChanged);
      this.clear();this.provider=chosen.provider;const provider=chosen.provider,generation=this.version;
      if(!this.config)this.config=configSchema.parse(await this.request('/api/config'));
      this.notice('Unlock '+chosen.name+' and approve the connection request.');
      const accounts=z.array(address).parse(await this.signInRequest(()=>provider.request({method:'eth_requestAccounts'})));
      if(generation!==this.version)throw Error('Wallet changed during sign-in.');
      const owner=accounts[0];if(!owner)throw Error('No wallet account selected. Unlock your wallet and try again.');
      this.connectionOwner=owner;provider.on?.('accountsChanged',this.accountChanged);
      const challenge=z.object({nonce:z.string(),message:z.string()}).parse(await this.request('/api/auth/challenge',{address:owner}));
      this.notice('Sign the login message in '+chosen.name+'. No transaction is requested.');
      const signature=await this.signInRequest(()=>provider.request({method:'personal_sign',params:[toHex(challenge.message),owner]}));
      if(generation!==this.version)throw Error('Wallet changed during sign-in.');
      await this.request('/api/auth/verify',{address:owner,nonce:challenge.nonce,signature});
      const current=z.array(address).parse(await this.signInRequest(()=>provider.request({method:'eth_accounts'})));
      if(generation!==this.version)throw Error('Wallet changed during sign-in.');
      if(current[0]?.toLowerCase()!==owner.toLowerCase()){this.accountChanged(current);throw Error('Wallet changed during sign-in.')}
      await this.load(owner);rememberWallet(chosen);this.channel?.postMessage({owner:owner.toLowerCase()});this.notice('Signed in. Your workspace is private to this wallet.');
    }catch(error){throw Error(walletError(error))}
    finally{this.connectionOwner=undefined;this.connecting=false;if(this.address&&this.document)this.changed(this.document,'session-ready')}
  }
  private async signInRequest(request:()=>Promise<unknown>):Promise<unknown>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([request(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Wallet request timed out. Open your wallet, dismiss any old request, then connect again.')),90000)})])}
    finally{if(timer)clearTimeout(timer)}
  }

  async demo(){if(this.config?.mode!=='demo')throw Error('Demo login is disabled.');const me=z.object({address}).parse(await this.request('/api/auth/demo',{}));await this.load(me.address)}
  async logout(){await this.request('/api/auth/logout',{});this.clear();this.channel?.postMessage({owner:null})}

  save(document:Document){

    if(!this.address)throw Error('Connect and sign in to save your workspace.');

    const generation=this.version,mutation=++this.workspaceMutation,copy=structuredClone(document);

    this.saving=this.saving.then(async()=>{

      if(generation!==this.version)return;

      if(this.saveFailed)throw Error('Reload your workspace before saving more changes.');

      const result=z.object({revision:z.number()}).parse(await this.request('/api/workspace',{revision:this.revision,document:copy},'PUT'));

      if(generation!==this.version)return;
      this.revision=result.revision;
      if(mutation===this.workspaceMutation){this.document=copy;this.changed(copy,'saved')}

    }).catch(error=>{if(generation===this.version){this.saveFailed=true;this.notice(error instanceof Error?error.message:'Workspace save failed.')}});

    return this.saving;

  }

  async currentWallet(){

    if(!this.address||!this.config)throw Error('Connect your wallet to approve this action.');
    // A signed session survives reloads; recover the already connected injected wallet.
    if(!this.provider && typeof window !== 'undefined') {
      const chosen=savedWallet()??await chooseWallet();
      if(chosen){this.provider=chosen.provider;rememberWallet(chosen);this.provider.on?.('accountsChanged',this.accountChanged)}
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

  pending(){const raw=localStorage.getItem(this.journalKey())??'[]';if(raw.length>65536)throw Error('The wallet journal needs review before continuing.');return z.array(journalEntry).max(10).parse(JSON.parse(raw)).map(entry=>{
    // Older journals can retain the exact openRun call without its runId field.
    if(!entry.hash&&!entry.runId&&entry.operation==='CPU reservation'&&entry.intent&&this.config&&entry.intent.to.toLowerCase()===this.config.escrowAddress.toLowerCase()){
      try{const call=decodeFunctionData({abi:escrowAbi,data:entry.intent.data??'0x'});if(call.functionName==='openRun'&&call.args[0].payer.toLowerCase()===this.address?.toLowerCase())return {...entry,runId:call.args[0].runId}}catch{}
    }
    return entry;
  })}

  async transaction(raw:unknown,operation:string,runId?:Hex){

    if(this.financialBusy)throw Error('Another wallet operation is pending.');

    const tx=txSchema.parse(raw);if(!this.config||![this.config.token.address,this.config.escrowAddress].some(a=>a.toLowerCase()===tx.to.toLowerCase()))throw Error('Unexpected transaction destination.');

    if(!navigator.locks)throw Error('This wallet browser cannot safely lock transactions. Use a current OKX browser or desktop wallet.');

    this.financialBusy=true;

    try{return await navigator.locks.request('telomere-wallet-transaction',{ifAvailable:true},async lock=>{

      if(!lock)throw Error('Another tab is using the wallet.');

      const identity=await this.currentWallet(),key=this.journalKey();

      const entries=this.pending();if(entries.length)throw Error('A previous transaction needs confirmation. Use Check pending transactions first.');

      const entry:JournalEntry={operation,intent:tx,...(runId?{runId}:{})};entries.push(entry);

      localStorage.setItem(key,JSON.stringify(entries));

      let hash:Hex;

      try{hash=transactionHash.parse(await identity.provider.request({method:'eth_sendTransaction',params:[{from:identity.owner,to:tx.to,data:tx.data??'0x',value:'0x0',chainId:toHex(this.config!.chain.id)}]}))}

      catch(error){const gas=rejectedForGas(error),cancelled=rejectedByWallet(error);if(cancelled||gas){this.archivePending(key,entry,gas?'insufficient_gas':'wallet_cancelled','wallet_rejected');localStorage.removeItem(key)}if(gas)throw Error('Insufficient ETH on Base for network fees. Add ETH, then retry. The wallet rejected this request before sending.');if(cancelled)throw Error('Wallet request rejected or cancelled before sending. The failed request was closed automatically.');throw error}

      entry.hash=hash;entry.submittedAt=Date.now();localStorage.setItem(key,JSON.stringify(entries));

      this.notice(`Transaction submitted: ${hash}. Waiting for confirmation.`);

      if(identity.version!==this.version)throw Error('Account changed. The submitted transaction is retained for review.');

      await this.confirm(entry);this.archivePending(key,entry,'confirmed','wallet_receipt');localStorage.removeItem(key);return hash;

    })}finally{this.financialBusy=false}

  }

  async confirm(entry:Pick<JournalEntry,'hash'|'runId'>){

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

  private archivePending(key:string,entry:JournalEntry,status:string,method:string){
    const historyKey=key+':resolved',raw=localStorage.getItem(historyKey)??'[]';
    if(raw.length>262144)throw Error('Recovery history needs review before continuing.');
    const history=z.array(z.record(z.unknown())).max(100).parse(JSON.parse(raw));
    const confirmationMs=status==='confirmed'&&entry.submittedAt!==undefined?Math.max(0,Date.now()-entry.submittedAt):undefined;
    localStorage.setItem(historyKey,JSON.stringify([...history.filter(item=>!entry.hash||item.hash!==entry.hash).slice(-99),{...entry,status,method,resolvedAt:new Date().toISOString(),...(confirmationMs!==undefined?{confirmationMs}:{})}]));
  }
  async walletRecoveryState(){
    const owner=this.address,chainId=this.config?.chain.id;if(!owner||!chainId)throw Error('Sign in before reviewing a wallet request.');
    const state=recoveryState.parse(await this.request('/api/transactions/recovery-state'));
    if(state.owner.toLowerCase()!==owner.toLowerCase()||state.chainId!==chainId)throw Error('Wallet recovery state does not match this account.');
    return state;
  }
  async fundingState(){
    const owner=this.address,chainId=this.config?.chain.id,token=this.config?.token.address;if(!owner||!chainId||!token)throw Error('Sign in before checking wallet funds.');
    const state=z.object({owner:address,chainId:z.number().int(),tokenAddress:address,ethBalanceWei:z.string().regex(/^\d+$/),usdcAtomic:z.string().regex(/^\d+$/)}).parse(await this.request('/api/wallet/funding'));
    if(state.owner.toLowerCase()!==owner.toLowerCase()||state.chainId!==chainId||state.tokenAddress.toLowerCase()!==token.toLowerCase())throw Error('Wallet funding state does not match this account.');
    return state;
  }
  async ensureDepositFunds(amount:string){
    const required=BigInt(z.string().regex(/^[1-9]\d*$/).parse(amount)),state=await this.fundingState();
    if(BigInt(state.usdcAtomic)<required)throw Error('Your wallet has '+formatUnits(BigInt(state.usdcAtomic),6)+' USDC on Base. Add at least '+formatUnits(required,6)+' USDC before depositing. ETH only pays network fees. No transaction was requested.');
    if(BigInt(state.ethBalanceWei)===0n)throw Error('Add ETH on Base for network fees before depositing USDC. No transaction was requested.');
    return state;
  }
  async ensureGas(){if(BigInt((await this.walletRecoveryState()).ethBalanceWei)===0n)throw Error('Add ETH on Base for network fees before creating a Leash. USDC is not used to pay gas. No transaction was requested.')}
  async ensureCpuFunds(ceiling:string){
    const required=BigInt(z.string().regex(/^\d+$/).parse(ceiling));
    const balance=z.object({available:z.string().regex(/^\d+$/)}).parse(await this.request('/api/balance'));
    if(BigInt(balance.available)<required)throw Error('Deposit at least '+formatUnits(required,6)+' USDC into your Base account before approving this CPU reservation. No wallet transaction was requested.');
  }
  private async reservationRecovery(entry:JournalEntry){
    if(!entry.runId||entry.hash||entry.operation!=='CPU reservation')throw Error('Choose the CPU reservation without a transaction hash.');
    const result=reservationRecovery.parse(await this.request('/api/runs/'+entry.runId+'/recovery'));
    if(result.owner.toLowerCase()!==this.address?.toLowerCase()||result.chainId!==this.config?.chain.id||result.runId.toLowerCase()!==entry.runId.toLowerCase())throw Error('Reservation recovery identity does not match this account.');
    if(entry.intent&&(entry.intent.to.toLowerCase()!==result.transaction.to.toLowerCase()||(entry.intent.data??'0x').toLowerCase()!==(result.transaction.data??'0x').toLowerCase()))throw Error('Recovery does not match the original transaction. The journal is retained.');
    return result;
  }
  async checkPendingCpu(){
    const entry=this.pending()[0];if(!entry||this.pending().length!==1)throw Error('Review one CPU reservation at a time.');
    return this.reservationRecovery(entry);
  }
  async discardExpiredReservation(confirmed:boolean){
    if(!confirmed)throw Error('Close the old wallet request and confirm before clearing it.');
    return this.expireUnusedReservation();
  }
  private async expireUnusedReservation(){
    if(this.financialBusy)throw Error('Another wallet operation is pending.');
    if(!navigator.locks)throw Error('Use a current wallet browser to lock transaction recovery.');
    this.financialBusy=true;
    try{return await navigator.locks.request('telomere-wallet-transaction',{ifAvailable:true},async lock=>{
      if(!lock)throw Error('Another tab is using the wallet.');
      const key=this.journalKey(),snapshot=localStorage.getItem(key),entries=this.pending(),entry=entries[0];
      if(entries.length!==1||!entry)throw Error('Review one CPU reservation at a time.');
      const result=await this.reservationRecovery(entry);
      if(result.state!=='expired_unused'||BigInt(result.chainTimestamp)<=BigInt(result.quoteExpiry))throw Error('This reservation is still active or already submitted. Check its existing transaction.');
      if(result.pendingNonce!==result.latestNonce)throw Error('Base reports a pending wallet transaction. Wait for it to finish before clearing this request.');
      if(localStorage.getItem(key)!==snapshot)throw Error('The wallet journal changed in another tab. Check it again.');
      this.archivePending(key,entry,'expired_quote_not_reserved','canonical_quote_expiry');localStorage.removeItem(key);
      return result;
    })}finally{this.financialBusy=false}
  }
  async reconcilePending(){
    if(this.financialBusy||this.connecting)return {state:'busy' as const};
    const entries=this.pending();if(!entries.length)return {state:'none' as const};
    if(entries.every(entry=>!!entry.hash)){const results=await this.recover();return {state:'resolved' as const,results}}
    const entry=entries[0];
    if(entries.length===1&&entry?.operation==='CPU reservation'&&entry.runId&&!entry.hash){
      const result=await this.checkPendingCpu();
      if(result.state==='transaction_found'){const results=await this.recover(result.hash);return {state:'resolved' as const,results}}
      // Expiry makes this exact signed quote unusable, even if an old wallet
      // prompt is approved later. Timeouts alone never release a deposit.
      if(result.state==='expired_unused'&&result.latestNonce===result.pendingNonce){await this.expireUnusedReservation();return {state:'expired_unused' as const}}
      return {state:'awaiting_wallet' as const};
    }
    return {state:'unknown_submission' as const};
  }
  async discardUnsentLeash(confirmed:boolean){
    if(!confirmed)throw Error('Confirm that the wallet rejected the request before sending and that you closed it.');
    if(this.financialBusy)throw Error('Another wallet operation is pending.');
    if(!navigator.locks)throw Error('Use a current wallet browser to lock transaction recovery.');
    this.financialBusy=true;
    try{return await navigator.locks.request('telomere-wallet-transaction',{ifAvailable:true},async lock=>{
      if(!lock)throw Error('Another tab is using the wallet.');
      const key=this.journalKey(),snapshot=localStorage.getItem(key),entries=this.pending(),entry=entries[0];
      if(entries.length!==1||!entry||entry.hash||entry.runId||!entry.operation.startsWith('Leash '))throw Error('Only an unsent Leash request without a hash can be cleared here.');
      const state=await this.walletRecoveryState();
      if(state.pendingNonce!==state.latestNonce)throw Error('Base reports a pending wallet transaction. Verify its hash before clearing this request.');
      if(localStorage.getItem(key)!==snapshot)throw Error('The wallet journal changed in another tab. Check it again.');
      this.archivePending(key,entry,'not_broadcast_reported','user_confirmed_wallet_rejection');
      localStorage.removeItem(key);this.notice('Failed Leash request cleared and retained in history. No transaction was sent.');
      return state;
    })}finally{this.financialBusy=false}
  }

  private unsentEntry(){
    const entries=this.pending(),entry=entries[0];
    if(entries.length!==1||!entry||entry.hash||entry.runId||!(entry.operation.startsWith('Leash ')||['Revoke Leash','deposit USDC','withdraw USDC'].includes(entry.operation)))throw Error('This request needs its original transaction or CPU reservation check. The journal is retained.');
    if(entry.intent){
      const token=entry.intent.to.toLowerCase()===this.config?.token.address.toLowerCase(),escrow=entry.intent.to.toLowerCase()===this.config?.escrowAddress.toLowerCase();
      try{
        if(token){const call=decodeFunctionData({abi:tokenAbi,data:entry.intent.data??'0x'});if(entry.operation!=='deposit USDC'||call.functionName!=='approve'||call.args[0].toLowerCase()!==this.config!.escrowAddress.toLowerCase())throw Error('action')}
        else if(escrow){const call=decodeFunctionData({abi:escrowAbi,data:entry.intent.data??'0x'});const allowed=entry.operation.startsWith('Leash ')?['createLeash','updateLeash']:entry.operation==='Revoke Leash'?['killLeash']:entry.operation==='deposit USDC'?['deposit']:['withdraw'];if(!allowed.includes(call.functionName))throw Error('action')}
        else throw Error('destination');
      }catch{throw Error('The saved request does not match this wallet action. The journal is retained.')}
    }
    return entry;
  }
  async checkUnsentRequest(){
    this.unsentEntry();const key=this.journalKey(),snapshot=localStorage.getItem(key)??'[]';
    try{
      const state=await this.walletRecoveryState();
      const balance=z.object({available:z.string().regex(/^\d+$/),reserved:z.string().regex(/^\d+$/).default('0')}).parse(await this.request('/api/balance'));
      if(key!==this.journalKey()||(localStorage.getItem(key)??'[]')!==snapshot)throw Error('The wallet journal changed. Check the current request again.');
      const encoded=JSON.stringify(balance),prior=this.unsentReview;
      const same=prior?.key===key&&prior.snapshot===snapshot&&prior.nonce===state.latestNonce&&prior.balance===encoded;
      this.unsentReview=state.pendingNonce===state.latestNonce?{key,snapshot,nonce:state.latestNonce,balance:encoded,since:same?prior.since:Date.now()}:undefined;
      return {...state,...balance,canClose:!!this.unsentReview&&Date.now()-this.unsentReview.since>=10000};
    }catch(error){this.unsentReview=undefined;throw error}
  }
  async discardUnsentRequest(confirmed:boolean){
    if(!confirmed)throw Error('Confirm that the wallet rejected or cancelled this request before sending, and that you closed it.');
    if(this.financialBusy)throw Error('Another wallet operation is pending.');
    if(!navigator.locks)throw Error('Use a current wallet browser to lock transaction recovery.');
    this.financialBusy=true;
    try{return await navigator.locks.request('telomere-wallet-transaction',{ifAvailable:true},async lock=>{
      if(!lock)throw Error('Another tab is using the wallet.');
      const entry=this.unsentEntry(),key=this.journalKey(),snapshot=localStorage.getItem(key);
      const state=await this.checkUnsentRequest();
      if(!state.canClose)throw Error('Wait for two consistent Base checks with no pending transaction. The request is retained.');
      if(key!==this.journalKey()||localStorage.getItem(key)!==snapshot)throw Error('The wallet journal changed. Check it again.');
      // A quiet nonce is not proof of non-broadcast. Record the owner's explicit
      // report, never label this as a chain-confirmed cancellation or retry it.
      this.archivePending(key,entry,'user_reported_not_sent','user_confirmed_wallet_rejection');
      localStorage.removeItem(key);this.unsentReview=undefined;return state;
    })}finally{this.financialBusy=false}
  }

  async recover(suppliedHash?:string){
    if(this.financialBusy)throw Error('Another wallet operation is pending.');
    if(!navigator.locks)throw Error('Use a current wallet browser to lock transaction recovery.');
    this.financialBusy=true;
    try{return await navigator.locks.request('telomere-wallet-transaction',{ifAvailable:true},async lock=>{
      if(!lock)throw Error('Another tab is using the wallet.');
      const key=this.journalKey(),owner=this.address!,chainId=this.config!.chain.id;
      let snapshot=localStorage.getItem(key)??'[]';const entries=this.pending(),results=[];
      if(suppliedHash&&(entries.length!==1||entries[0]!.hash))throw Error('A hash can only recover one operation that is missing its wallet response.');
      for(const entry of entries){
        let hash=entry.hash??(suppliedHash?transactionHash.parse(suppliedHash.trim()):undefined);
        if(!hash&&entry.runId&&entry.operation==='CPU reservation'){
          const reservation=await this.reservationRecovery(entry);
          if(reservation.state==='transaction_found')hash=reservation.hash;
          else throw Error(reservation.state==='expired_unused'?'The quote expired without an on-chain reservation. Check the reservation and clear the expired request.':'No reservation found yet. Close or complete the wallet request, then check again. No new transaction was sent.');
        }
        if(!hash)throw Error('The wallet did not return a transaction hash. Paste its Base transaction hash from wallet history. Nothing will be sent again.');
        const result=recoveryResult.parse(await this.request('/api/transactions/'+hash));
        if(result.hash.toLowerCase()!==hash.toLowerCase()||result.owner.toLowerCase()!==owner.toLowerCase()||result.chainId!==chainId)throw Error('Recovered transaction identity does not match this session.');
        if(entry.intent){
          if(entry.intent.to.toLowerCase()!==result.transaction.to.toLowerCase()||(entry.intent.data??'0x').toLowerCase()!==(result.transaction.data??'0x').toLowerCase())throw Error('This hash does not match the original transaction. The journal is retained.');
        }else{
          const allowed=entry.operation.startsWith('Leash ')?['createLeash','updateLeash']:entry.operation==='Revoke Leash'?['killLeash']:entry.operation==='deposit USDC'?['approve','deposit']:entry.operation==='withdraw USDC'?['withdraw']:entry.operation==='CPU reservation'?['openRun']:entry.operation==='stop run'?['requestStop']:entry.operation==='refund run'?['refundRun']:[];
          if(!allowed.includes(result.method))throw Error('This hash belongs to a different wallet action. The journal is retained.');
        }
        if(entry.runId&&(result.method!=='openRun'||result.runId?.toLowerCase()!==entry.runId.toLowerCase()))throw Error('Recovered transaction belongs to a different CPU reservation.');
        if((localStorage.getItem(key)??'[]')!==snapshot)throw Error('The wallet journal changed in another tab. Check it again.');
        if(!entry.hash){entry.hash=hash;const current=this.pending();current[0]!.hash=hash;localStorage.setItem(key,JSON.stringify(current));snapshot=localStorage.getItem(key)!}
        if(result.status==='pending')throw Error('This transaction is still pending on Base. No new transaction was sent. Check again after confirmation.');
        if(result.status==='confirmed'&&entry.runId)await this.request('/api/runs',{runId:entry.runId,txHash:hash});
        if((localStorage.getItem(key)??'[]')!==snapshot)throw Error('The wallet journal changed in another tab. Check it again.');
        this.archivePending(key,entry,result.status,result.method);
        const remaining=this.pending();remaining.shift();
        if(remaining.length)localStorage.setItem(key,JSON.stringify(remaining));else localStorage.removeItem(key);
        snapshot=localStorage.getItem(key)??'[]';results.push(result);
      }
      this.notice(results.some(result=>result.status==='reverted')?'A reverted transaction was resolved. No automatic retry was sent.':'Existing transactions verified. No new transaction was sent.');
      return results;
    })}finally{this.financialBusy=false}
  }

}


export { encryptCheckpoint, decryptCheckpoint, exportCystRecoveryKey, importCystRecoveryKey } from '../src/sdk/cysts.js';

export function planningHourlySpend(rate:number,minutes:number,lane:string):number {
  return rate*Math.min(Math.max(minutes,0)/60,1)*(lane==='Sealed'?1.12:1.09);
}
