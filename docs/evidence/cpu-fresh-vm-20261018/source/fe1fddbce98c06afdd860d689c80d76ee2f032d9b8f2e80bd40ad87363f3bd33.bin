// Restored immutable application, fresh database and generated loopback accounts.
// No mainnet profile is read. The containing VM has no external network device.
import {createServer} from 'node:http';
import {spawn,fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPublicClient,createTestClient,createWalletClient,http,parseEther} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/index.js';
import {generatePrivateKey,privateKeyToAccount} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/accounts/index.js';
import {escrowAbi,tokenAbi} from '/opt/telomere-mainnet-pilot/app/dist/src/chain/abi.js';
import {emptyWorkspace} from '/opt/telomere-mainnet-pilot/app/dist/src/workspace/routes.js';
const BASE='/opt/telomere-mainnet-pilot',WORK=BASE+'/data/fresh-vm-smoke',docker=promisify(execFile);
const check=(value,message)=>{if(!value)throw Error(message)};
async function port(){const s=createServer();await new Promise((ok,no)=>s.listen(0,'127.0.0.1',ok).once('error',no));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function save(name,value){const p=WORK+'/'+name;await writeFile(p+'.next',JSON.stringify(value,null,2)+'\n');await rename(p+'.next',p)}
const namespace=process.env.TELOMERE_ACCEPTANCE_NAMESPACE;check(/^[0-9a-f]{16}$/.test(namespace),'Namespace');
const chainPort=await port(),chainUrl='http://127.0.0.1:'+chainPort;
const anvil=spawn(BASE+'/operator/acceptance-tools/anvil',['--host','127.0.0.1','--port',String(chainPort),'--chain-id','31337','--accounts','0','--silent'],{stdio:'ignore'});
let pilot,db,volume,created=false,volumeCreated=false,phase='local-chain';const began=performance.now();
try{
  const direct=createPublicClient({transport:http(chainUrl,{retryCount:0,timeout:10000}),cacheTime:0});
  for(let i=0;i<180;i++){try{if(await direct.getChainId()===31337)break}catch{}await delay(500)}
  check(await direct.getChainId()===31337,'Offline chain');
  const chain={id:31337,name:'Clean recovery acceptance',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[chainUrl]}}};
  const test=createTestClient({chain,mode:'anvil',transport:http(chainUrl)});
  const keys={owner:generatePrivateKey(),other:generatePrivateKey(),signer:generatePrivateKey(),treasury:generatePrivateKey()};
  const accounts=Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,privateKeyToAccount(v)]));
  for(const account of Object.values(accounts))await test.setBalance({address:account.address,value:parseEther('10')});
  const wallet=createWalletClient({account:accounts.owner,chain,transport:http(chainUrl,{retryCount:0,timeout:15000})});
  const receipt=async hash=>{const r=await direct.waitForTransactionReceipt({hash,timeout:60000});check(r.status==='success','Local transaction');return r};
  const artifact=async name=>JSON.parse(await readFile(BASE+'/app/contracts/artifacts/'+name+'.json','utf8'));
  const tokenArtifact=await artifact('MockToken'),escrowArtifact=await artifact('TelomereRunEscrow');
  const token=(await receipt(await wallet.deployContract({abi:tokenArtifact.abi,bytecode:tokenArtifact.bytecode}))).contractAddress;
  const escrow=(await receipt(await wallet.deployContract({abi:escrowArtifact.abi,bytecode:escrowArtifact.bytecode,args:[token,accounts.signer.address,accounts.signer.address,accounts.treasury.address]}))).contractAddress;
  check(token&&escrow,'Local contract deployment');phase='new-database';
  const databasePort=await port(),password=randomUUID().replaceAll('-','');
  db='telomere-load-postgres-'+namespace;volume=db+'-data';
  await docker('/usr/bin/docker',['volume','create','--label','telomere.load.database='+db,volume],{timeout:20000});volumeCreated=true;
  await docker('/usr/bin/docker',['run','-d','--name',db,'--label','telomere.load.database='+db,'--runtime','runc','--network','host','--memory','512m','--pids-limit','128',
    '--mount','type=volume,source='+volume+',target=/var/lib/postgresql/data','-e','POSTGRES_USER=load','-e','POSTGRES_DB=load','-e','POSTGRES_PASSWORD','-e','PGPORT='+databasePort,
    process.env.ACCEPTANCE_POSTGRES_IMAGE,'postgres','-c','listen_addresses=127.0.0.1','-p',String(databasePort)],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:60000});created=true;
  let ready=false;for(let i=0;i<120;i++){try{await docker('/usr/bin/docker',['exec',db,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U load -d load'],{timeout:10000});ready=true;break}catch{await delay(1000)}}check(ready,'PostgreSQL readiness');
  const httpPort=await port(),origin='http://127.0.0.1:'+httpPort;
  const settings={MODE:'demo',CHAIN_ID:'31337',RPC_URL:chainUrl,SIGNER_PRIVATE_KEY:keys.signer,DEMO_PRIVATE_KEY:keys.owner,TOKEN_ADDRESS:token,ESCROW_ADDRESS:escrow,
    DATA_DIR:WORK+'/db',DATABASE_URL:'postgresql://load:'+password+'@127.0.0.1:'+databasePort+'/load',CPU_MODE:'docker',CPU_IMAGE:process.env.CPU_IMAGE,
    HOST:'127.0.0.1',PORT:String(httpPort),PUBLIC_ORIGIN:origin,WALLET_ACCESS:'public',TRUST_LOOPBACK_PROXY:'true',CYSTS_ENABLED:'true',CYSTS_DIR:WORK+'/cysts',LOG_LEVEL:'error'};
  async function start(){
    const child=fork(BASE+'/operator/cpu-launch/load-worker.mjs',[],{stdio:['ignore','ignore','ignore','ipc']});
    const exited=new Promise(resolve=>child.once('exit',resolve));
    const started=new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error('Application startup '+m.errorType)));child.once('exit',()=>reject(Error('Application exited before ready')))});
    child.send(settings);await Promise.race([started,delay(90000,undefined,{ref:false}).then(()=>{throw Error('Application readiness deadline')})]);
    return {child,async close(){child.kill('SIGTERM');await Promise.race([exited,delay(15000,undefined,{ref:false})]);if(child.exitCode===null){child.kill('SIGKILL');await exited}}};
  }
  pilot=await start();phase='https';await save('progress.json',{state:'ready-for-https',httpOrigin:origin});
  let https=false;for(let i=0;i<180;i++){try{https=JSON.parse(await readFile(WORK+'/https-checked.json','utf8')).passed;if(https)break}catch{}await delay(1000)}check(https,'HTTPS proxy acceptance');
  async function call(client,path,method='GET',body,extra={}){
    const response=await fetch(origin+path,{method,headers:{origin,'content-type':'application/json','x-real-ip':client.ip,...(client.cookie?{cookie:client.cookie}:{}),...extra},signal:AbortSignal.timeout(30000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {response,data:await response.json()};
  }
  async function login(account,index){const c={account,ip:'198.18.0.'+index};const challenge=await call(c,'/api/auth/challenge','POST',{address:account.address});check(challenge.response.status===200,'Wallet challenge');
    const signature=await account.signMessage({message:challenge.data.message});const v=await call(c,'/api/auth/verify','POST',{address:account.address,nonce:challenge.data.nonce,signature});check(v.response.status===200,'Wallet sign-in');c.cookie=v.response.headers.get('set-cookie').split(';')[0];return c}
  phase='wallet-and-workspace';const owner=await login(accounts.owner,1),other=await login(accounts.other,2);
  const document=emptyWorkspace();document.budget=17;check((await call(owner,'/api/workspace','PUT',{revision:0,document})).response.status===200,'Workspace write');
  check((await call(owner,'/api/workspace')).data.document.budget===17,'Workspace read');check((await call(other,'/api/workspace')).data.document.budget!==17,'Workspace isolation');
  const send=async tx=>receipt(await wallet.sendTransaction({to:tx.to,data:tx.data,value:0n}));
  phase='deposit-and-cpu';await receipt(await wallet.writeContract({address:token,abi:tokenArtifact.abi,functionName:'faucet',args:[accounts.owner.address,1000000n]}));
  await receipt(await wallet.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[escrow,1000000n]}));
  await receipt(await wallet.writeContract({address:escrow,abi:escrowAbi,functionName:'deposit',args:[1000000n]}));
  const leash=await call(owner,'/api/leashes','POST',{maxPerHour:'1000000',maxPerDay:'1000000',expiry:Math.floor(Date.now()/1000)+3600});check(leash.response.status===201,'Leash');await send(leash.data.transaction);
  const quote=await call(owner,'/api/quotes','POST',{leashId:leash.data.leashId,task:{kind:'hash_chain',text:'clean-vm-recovery',iterations:2000},maxSeconds:60},{'idempotency-key':randomUUID()});check(quote.response.status===201,'CPU quote');
  const opening=await send(quote.data.transaction);check((await call(owner,'/api/runs','POST',{runId:quote.data.quote.runId,txHash:opening.transactionHash})).response.status===202,'CPU admission');
  let job;for(let i=0;i<300;i++){const r=await call(owner,'/api/runs/'+quote.data.quote.runId);check(r.response.status===200,'CPU read');job=r.data;if(job.status==='completed')break;check(!['failed','cancelled','timed_out','refunded'].includes(job.status),'CPU terminal failure '+job.status);await delay(1000)}
  check(job.status==='completed','Paid CPU completion');
  const verified=await call(owner,'/api/receipts/verify','POST',{receipt:job.receipt});check(verified.data.valid&&verified.data.anchored,'Anchored local receipt');
  const balance=await call(owner,'/api/balance'),charged=BigInt(job.charged);check(charged>0n&&balance.data.reserved==='0'&&BigInt(balance.data.available)+charged===1000000n,'Exact settlement accounting');
  check(await direct.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.treasury.address]})===charged,'Distinct local treasury');
  check((await call(other,'/api/runs/'+job.id)).response.status===404,'Other account job isolation');
  phase='application-restart';await pilot.close();pilot=await start();
  const reopened=await call(owner,'/api/runs/'+job.id);check(reopened.response.status===200&&reopened.data.settlementTxHash===job.settlementTxHash,'Original receipt after application restart');
  check((await call(owner,'/api/workspace')).data.document.budget===17,'Workspace after restart');
  const withdrawal=await call(owner,'/api/transactions/withdraw?amount='+balance.data.available);check(withdrawal.response.status===200,'Withdrawal intent');await send(withdrawal.data.transaction);
  check((await call(owner,'/api/balance')).data.available==='0','Escrow emptied');
  check(await direct.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.owner.address]})+charged===1000000n,'Owner withdrawal conservation');
  const result={passed:true,chainId:31337,generatedAccounts:true,mainnetTransactions:0,mainnetSignerLoaded:false,realGvisorCpuRuns:1,
    authenticatedOwners:2,workspaceIsolation:true,restoredApplicationRestart:true,originalSettlementHashPreserved:true,anchoredReceipt:true,
    depositAtomicTestTokens:'1000000',chargedAtomicTestTokens:charged.toString(),withdrawnAtomicTestTokens:balance.data.available,remainingEscrowAtomicTestTokens:'0',elapsedSeconds:(performance.now()-began)/1000};
  await save('result.json',result);await save('progress.json',{state:'completed'});
}catch(error){await save('progress.json',{state:'failed',phase,errorType:error.name,message:error.message});process.exitCode=1}
finally{
  await pilot?.close();anvil.kill('SIGTERM');
  if(created){const label=await docker('/usr/bin/docker',['inspect','--format','{{index .Config.Labels "telomere.load.database"}}',db]);check(label.stdout.trim()===db,'Owned database');await docker('/usr/bin/docker',['rm','-f',db],{timeout:30000})}
  if(volumeCreated){const label=await docker('/usr/bin/docker',['volume','inspect','--format','{{index .Labels "telomere.load.database"}}',volume]);check(label.stdout.trim()===db,'Owned volume');await docker('/usr/bin/docker',['volume','rm',volume],{timeout:30000})}
}
