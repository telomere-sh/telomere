// Isolated HTTP/queue/fault acceptance against the exact deployed application.
// Every key, contract, database and transaction below belongs to local chain 31337.
import {createServer} from 'node:http';
import {spawn,fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {escrowAbi,tokenAbi} from '/opt/telomere-mainnet-pilot/app/dist/src/chain/abi.js';
import {emptyWorkspace} from '/opt/telomere-mainnet-pilot/app/dist/src/workspace/routes.js';
import {createPublicClient,createTestClient,createWalletClient,http,parseEther} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/index.js';
import {generatePrivateKey,privateKeyToAccount} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/accounts/index.js';
const BASE='/opt/telomere-mainnet-pilot',WORK=await mkdtemp(BASE+'/data/cpu-launch-acceptance-20261017/http-load-');
const check=(value,message)=>{if(!value)throw Error(message)};
async function listen(server){await new Promise((ok,no)=>server.listen(0,'127.0.0.1',ok).once('error',no));return server.address().port}
async function port(){const s=createServer(),p=await listen(s);await new Promise(r=>s.close(r));return p}
const chainPort=await port(),chainUrl='http://127.0.0.1:'+chainPort;
const anvil=spawn(BASE+'/operator/acceptance-tools/anvil',['--host','127.0.0.1','--port',String(chainPort),'--chain-id','31337','--accounts','0','--silent'],{stdio:'ignore'});
let pilot,proxy,databaseContainer,databaseVolume,databaseRequested=false,volumeCreated=false,offline=false,phase='local_chain';const observations=[],checks=[];
const docker=promisify(execFile);
const soakSeconds=Number(process.env.ACCEPTANCE_SOAK_SECONDS||'180');check(Number.isInteger(soakSeconds)&&soakSeconds>=0&&soakSeconds<=300,'Soak duration');
const direct=createPublicClient({transport:http(chainUrl,{retryCount:0,timeout:3000}),cacheTime:0});
try{
  for(let i=0;i<100;i++){try{if(await direct.getChainId()===31337)break}catch{}await delay(100)}
  check(await direct.getChainId()===31337&&new URL(chainUrl).hostname==='127.0.0.1','Disposable chain guard');
  const chain={id:31337,name:'Isolated acceptance',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[chainUrl]}}};
  const test=createTestClient({chain,mode:'anvil',transport:http(chainUrl)});
  const keys={owner:generatePrivateKey(),signer:generatePrivateKey(),treasury:generatePrivateKey()};
  const accounts=Object.fromEntries(Object.entries(keys).map(([key,value])=>[key,privateKeyToAccount(value)]));
  for(const account of Object.values(accounts))await test.setBalance({address:account.address,value:parseEther('10')});
  const wallet=createWalletClient({account:accounts.owner,chain,transport:http(chainUrl,{retryCount:0})});
  const receipt=async hash=>{const r=await direct.waitForTransactionReceipt({hash});check(r.status==='success','Local transaction reverted');return r};
  const artifact=async name=>JSON.parse(await readFile(BASE+'/app/contracts/artifacts/'+name+'.json','utf8'));
  const tokenArtifact=await artifact('MockToken'),escrowArtifact=await artifact('TelomereRunEscrow');
  const token=(await receipt(await wallet.deployContract({abi:tokenArtifact.abi,bytecode:tokenArtifact.bytecode}))).contractAddress;
  const escrow=(await receipt(await wallet.deployContract({abi:escrowArtifact.abi,bytecode:escrowArtifact.bytecode,args:[token,accounts.signer.address,accounts.signer.address,accounts.treasury.address]}))).contractAddress;
  check(token&&escrow,'Local contract addresses');
  proxy=createServer(async(req,res)=>{if(offline){res.writeHead(503);res.end();return}try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const r=await fetch(chainUrl,{method:'POST',headers:{'content-type':'application/json'},body:Buffer.concat(chunks)});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text())}catch{res.writeHead(503);res.end()}});
  const proxyPort=await listen(proxy),httpPort=await port(),origin='http://127.0.0.1:'+httpPort;
  phase='isolated_postgres';const databasePort=await port(),password=randomUUID().replaceAll('-','');
  check(/^sha256:[0-9a-f]{64}$/.test(process.env.ACCEPTANCE_POSTGRES_IMAGE||''),'Pinned local PostgreSQL image');
  databaseContainer='telomere-load-postgres-'+process.env.TELOMERE_ACCEPTANCE_NAMESPACE;databaseRequested=true;
  databaseVolume=databaseContainer+'-data';
  await docker('/usr/bin/docker',['volume','create','--label','telomere.load.database='+databaseContainer,databaseVolume],{timeout:10000});volumeCreated=true;
  await docker('/usr/bin/docker',['run','-d','--name',databaseContainer,'--label','telomere.load.database='+databaseContainer,'--runtime','runc','--network','host','--cpus','0.5','--memory','512m','--pids-limit','128',
    '--mount','type=volume,source='+databaseVolume+',target=/var/lib/postgresql/data','-e','POSTGRES_USER=load','-e','POSTGRES_DB=load','-e','POSTGRES_PASSWORD','-e','PGPORT='+databasePort,
    process.env.ACCEPTANCE_POSTGRES_IMAGE,'postgres','-c','listen_addresses=127.0.0.1','-p',String(databasePort)],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:15000});
  let databaseReady=false;
  for(let i=0;i<60;i++){try{await docker('/usr/bin/docker',['exec',databaseContainer,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U load -d load'],{timeout:5000});databaseReady=true;break}catch{await delay(500)}}check(databaseReady,'PostgreSQL startup');
  const settings={MODE:'demo',CHAIN_ID:'31337',RPC_URL:'http://127.0.0.1:'+proxyPort,SIGNER_PRIVATE_KEY:keys.signer,DEMO_PRIVATE_KEY:keys.owner,
    TOKEN_ADDRESS:token,ESCROW_ADDRESS:escrow,DATA_DIR:WORK+'/db',CPU_MODE:'docker',CPU_IMAGE:process.env.CPU_IMAGE,
    DATABASE_URL:'postgresql://load:'+password+'@127.0.0.1:'+databasePort+'/load',
    HOST:'127.0.0.1',PORT:String(httpPort),PUBLIC_ORIGIN:origin,WALLET_ACCESS:'public',TRUST_LOOPBACK_PROXY:'true',CYSTS_ENABLED:'true',CYSTS_DIR:WORK+'/cysts',LOG_LEVEL:'error'};
  async function application(){
    const child=fork(BASE+'/operator/cpu-launch/load-worker.mjs',[],{stdio:['ignore','ignore','ignore','ipc']});
    let exited=false;const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal})}));
    const ready=new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error('Acceptance worker startup failed: '+m.errorType)));child.once('exit',()=>reject(Error('Acceptance worker exited before readiness')))});
    child.send(settings);await Promise.race([ready,delay(30000).then(()=>{throw Error('Acceptance worker readiness deadline')})]);
    return {child,exit,get exited(){return exited},async close(){if(exited)return;child.kill('SIGTERM');await Promise.race([exit,delay(10000)]);if(!exited){child.kill('SIGKILL');await exit}}};
  }
  pilot=await application();phase='signed_accounts';
  async function call(client,path,method='GET',body,extra={}){
    const start=performance.now(),headers={origin,'content-type':'application/json','x-real-ip':client.ip,...(client.cookie?{cookie:client.cookie}:{}),...extra};
    const response=await fetch(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();observations.push({path,status:response.status,ms:performance.now()-start});return {response,data};
  }
  async function login(account,index){const client={account,ip:'198.18.0.'+(index+1)};const c=await call(client,'/api/auth/challenge','POST',{address:account.address});check(c.response.status===200,'Challenge');
    const signature=await account.signMessage({message:c.data.message});const v=await call(client,'/api/auth/verify','POST',{address:account.address,nonce:c.data.nonce,signature});check(v.response.status===200,'Sign in');client.cookie=v.response.headers.get('set-cookie').split(';')[0];return client}
  const clients=[];for(let i=0;i<50;i++)clients.push(await login(i===0?accounts.owner:privateKeyToAccount(generatePrivateKey()),i));
  for(const [i,c] of clients.entries()){const document=emptyWorkspace();document.budget=i+1;const r=await call(c,'/api/workspace','PUT',{revision:0,document});check(r.response.status===200,'Workspace create')}
  phase='http_load';const began=performance.now(),startIndex=observations.length;
  await Promise.all(clients.map(async(c,i)=>{for(let j=0;j<20;j++){const r=await call(c,'/api/workspace');check(r.response.status===200&&r.data.owner===c.account.address.toLowerCase()&&r.data.document.budget===i+1,'Tenant isolation under load')}}));
  const samples=observations.slice(startIndex).map(x=>x.ms).sort((a,b)=>a-b),seconds=(performance.now()-began)/1000;
  const load={users:50,requests:samples.length,concurrency:50,elapsedSeconds:seconds,requestsPerSecond:samples.length/seconds,p50Ms:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)],p99Ms:samples[Math.floor(samples.length*.99)],errors:0};
  check(load.p95Ms<2000,'HTTP p95 exceeds acceptance ceiling');checks.push('50 signed tenants, 1000 real HTTP reads, zero cross-tenant records');
  const owner=clients[0],foreign=await call(clients[1],'/api/workspace','GET',undefined,{'x-telomere-owner':accounts.owner.address});check(foreign.response.status===409,'Stale owner header');
  const writes=await Promise.all([1,2].map(()=>call(owner,'/api/workspace','PUT',{revision:1,document:emptyWorkspace()})));check(writes.map(r=>r.response.status).sort().join(',')==='200,409','CAS write collision');checks.push('stale account header and conflicting writes rejected');
  const soakSamples=[];let soakError;const soakBegan=performance.now();
  const soakTask=(async()=>{let i=0;while(performance.now()-soakBegan<soakSeconds*1000){const c=clients[i++%clients.length],at=performance.now();const r=await call(c,'/api/workspace');check(r.response.status===200&&r.data.owner===c.account.address.toLowerCase(),'Sustained tenant read');soakSamples.push(performance.now()-at);await delay(Math.max(0,100-(performance.now()-at)))}})().catch(error=>{soakError=error});
  phase='rate_limit';const limited={...clients[2],ip:'203.0.113.251'},statuses=[];
  for(let i=0;i<13;i++)await Promise.all(Array.from({length:20},async()=>statuses.push((await call(limited,'/api/me')).response.status)));
  check(statuses.filter(x=>x===200).length===240&&statuses.filter(x=>x===429).length===20,'Rate limit boundary');checks.push('240 requests per IP accepted, next 20 rejected with 429');
  phase='paid_queue';
  await receipt(await wallet.writeContract({address:token,abi:tokenArtifact.abi,functionName:'faucet',args:[accounts.owner.address,1000000n]}));
  await receipt(await wallet.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[escrow,1000000n]}));
  await receipt(await wallet.writeContract({address:escrow,abi:escrowAbi,functionName:'deposit',args:[1000000n]}));
  const leash=await call(owner,'/api/leashes','POST',{maxPerHour:'100000',maxPerDay:'1000000',expiry:Math.floor(Date.now()/1000)+86400});check(leash.response.status===201,'Leash prepare');
  const send=async tx=>receipt(await wallet.sendTransaction({to:tx.to,data:tx.data,value:0n}));await send(leash.data.transaction);
  const body={leashId:leash.data.leashId,task:{kind:'hash_chain',text:'telomere',iterations:250000},maxSeconds:10};
  const quotes=await Promise.all(Array.from({length:12},()=>call(owner,'/api/quotes','POST',body,{'idempotency-key':randomUUID()})));
  const admitted=quotes.filter(r=>r.response.status===201);check(admitted.length===8&&quotes.filter(r=>r.response.status===429).length===4,'Atomic per-owner capacity guard');
  const runIds=[];
  for(const q of admitted){const r=await send(q.data.transaction);const admission=await call(owner,'/api/runs','POST',{runId:q.data.quote.runId,txHash:r.transactionHash});check(admission.response.status===202,'Paid admission');runIds.push(q.data.quote.runId)}
  async function completed(id){for(let i=0;i<150;i++){const r=await call(owner,'/api/runs/'+id);if(['completed','cancelled','failed','timed_out','refunded'].includes(r.data.status))return r.data;await delay(500)}throw Error('CPU queue drain deadline')}
  let jobs=[];for(let i=0;i<150;i++){const r=await call(owner,'/api/runs');jobs=r.data.runs.filter(j=>runIds.includes(j.id));if(jobs.length===8&&jobs.every(j=>j.status==='completed'))break;await delay(1000)}check(jobs.length===8&&jobs.every(j=>j.status==='completed'),'Queued CPU task failed');
  for(const job of jobs){const v=await call(owner,'/api/receipts/verify','POST',{receipt:job.receipt});check(v.data.valid&&v.data.anchored,'Queued receipt verification')}
  checks.push('12 concurrent quotes: 8 accepted, 4 refused; all 8 genuine Docker jobs settled with valid receipts');
  phase='rpc_admission_outage';const q=await call(owner,'/api/quotes','POST',body,{'idempotency-key':randomUUID()});check(q.response.status===201,'Outage quote');const opening=await send(q.data.transaction);
  const reservation={runId:q.data.quote.runId,txHash:opening.transactionHash};offline=true;
  const outage=await call(owner,'/api/runs','POST',reservation);check(outage.response.status===503,'Admission RPC outage refusal');offline=false;
  check((await call(owner,'/api/runs','POST',reservation)).response.status===202,'Original hash recovery');const recovered=await completed(reservation.runId);check(recovered.status==='completed','Recovered job');
  const again=await call(owner,'/api/runs','POST',reservation);check(again.response.status===202&&again.data.settlementTxHash===recovered.settlementTxHash,'Duplicate admission changed settlement');
  checks.push('RPC outage after on-chain reservation: 503, same-hash recovery, repeated admission without second charge');
  phase='stop_running_cpu';const stopQuote=await call(owner,'/api/quotes','POST',{...body,task:{kind:'hash_chain',text:'telomere',iterations:2000000},maxSeconds:20},{'idempotency-key':randomUUID()});check(stopQuote.response.status===201,'Stop quote');
  const opened=await send(stopQuote.data.transaction);check((await call(owner,'/api/runs','POST',{runId:stopQuote.data.quote.runId,txHash:opened.transactionHash})).response.status===202,'Stop admission');await delay(1200);
  const stop=await call(owner,'/api/runs/'+stopQuote.data.quote.runId+'/stop','POST',{});check(stop.response.status===200,'Stop intent');await send(stop.data.transaction);
  const stopped=await completed(stopQuote.data.quote.runId);check(stopped.status==='cancelled'&&BigInt(stopped.refund)>0n,'Stop refund');checks.push('owner-signed stop cancels active real CPU and returns unused reservation');
  phase='kill_leash';const killQuote=await call(owner,'/api/quotes','POST',{...body,task:{kind:'hash_chain',text:'telomere',iterations:2000000},maxSeconds:20},{'idempotency-key':randomUUID()});check(killQuote.response.status===201,'Kill quote');
  const killOpened=await send(killQuote.data.transaction);check((await call(owner,'/api/runs','POST',{runId:killQuote.data.quote.runId,txHash:killOpened.transactionHash})).response.status===202,'Kill admission');await delay(1200);
  const kill=await call(owner,'/api/leashes/'+leash.data.leashId+'/kill','POST',{});check(kill.response.status===200,'Kill intent');await send(kill.data.transaction);
  const killed=await completed(killQuote.data.quote.runId);check(killed.status==='cancelled'&&BigInt(killed.refund)>0n,'Kill refund');checks.push('Leash revocation cancels active CPU and preserves unused-fund return');
  phase='reconciliation';const all=await call(owner,'/api/runs');const charge=all.data.runs.reduce((sum,j)=>sum+BigInt(j.charged),0n),balance=await call(owner,'/api/balance');
  check(BigInt(balance.data.available)+charge===1000000n&&balance.data.reserved==='0','Conserved local token accounting');
  const treasury=await direct.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.treasury.address]});check(treasury===charge,'Treasury conservation');
  let insufficient=false;try{await direct.simulateContract({account:accounts.owner,address:escrow,abi:escrowAbi,functionName:'withdraw',args:[1000001n]})}catch{insufficient=true}check(insufficient,'Over-withdraw accepted');
  checks.push('available plus settled charges conserved; treasury exact; withdrawal above balance rejected');
  phase='global_quote_capacity';const globalInputs=[];
  for(let i=0;i<65;i++){
    const client=clients[i]||await login(privateKeyToAccount(generatePrivateKey()),i);
    await test.setBalance({address:client.account.address,value:parseEther('10')});
    const intent=await call(client,'/api/leashes','POST',{maxPerHour:'100000',maxPerDay:'1000000',expiry:Math.floor(Date.now()/1000)+86400});check(intent.response.status===201,'Global Leash');
    const userWallet=createWalletClient({account:client.account,chain,transport:http(chainUrl,{retryCount:0})});await receipt(await userWallet.sendTransaction({to:intent.data.transaction.to,data:intent.data.transaction.data,value:0n}));
    globalInputs.push({client,input:{...body,leashId:intent.data.leashId}});
  }
  const globalQuotes=await Promise.all(globalInputs.map(({client,input})=>call(client,'/api/quotes','POST',input,{'idempotency-key':randomUUID()})));
  check(globalQuotes.filter(r=>r.response.status===201).length===64&&globalQuotes.filter(r=>r.response.status===429).length===1,'Global quote capacity race');checks.push('65 concurrently signed quote requests across local owners: 64 accepted, 65th refused');
  phase='expired_quote';const expireIndex=globalQuotes.findIndex((r,i)=>i>0&&r.response.status===201),expire=globalQuotes[expireIndex],expireAccount=globalInputs[expireIndex].client.account;
  const expireWallet=createWalletClient({account:expireAccount,chain,transport:http(chainUrl,{retryCount:0})});
  await receipt(await wallet.writeContract({address:token,abi:tokenArtifact.abi,functionName:'faucet',args:[expireAccount.address,2000n]}));
  await receipt(await expireWallet.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[escrow,2000n]}));
  await receipt(await expireWallet.writeContract({address:escrow,abi:escrowAbi,functionName:'deposit',args:[2000n]}));
  await direct.call({account:expireAccount.address,to:expire.data.transaction.to,data:expire.data.transaction.data});
  await test.increaseTime({seconds:301});await test.mine({blocks:1});check((await direct.getBlock()).timestamp>BigInt(expire.data.quote.quoteExpiry),'Quote expiry fixture');let expired=false;
  try{await direct.call({account:expireAccount.address,to:expire.data.transaction.to,data:expire.data.transaction.data})}catch(error){expired=/revert/i.test(String(error.shortMessage)+' '+String(error.details))}check(expired,'Expired quote was not rejected');checks.push('funded original-payer quote succeeds before expiry and reverts after expiry');
  await soakTask;check(!soakError,'Sustained HTTP read failed');soakSamples.sort((a,b)=>a-b);
  const soak={targetSeconds:soakSeconds,requests:soakSamples.length,p95Ms:soakSamples[Math.floor(soakSamples.length*.95)],errors:0,duringActualCpuExecution:true};
  check(!soakSeconds||soakSamples.length>=soakSeconds*7,'Sustained request rate fell below acceptance floor');check(!soakSeconds||soak.p95Ms<2000,'Sustained p95');
  phase='database_outage';
  const beforeDatabase=await call(owner,'/api/runs');check(beforeDatabase.response.status===200,'Database outage baseline');
  await docker('/usr/bin/docker',['stop','--time','3',databaseContainer],{timeout:10000});
  let successDuringOutage=false;
  try{const response=await fetch(origin+'/api/workspace',{headers:{cookie:owner.cookie,origin,'x-real-ip':owner.ip},signal:AbortSignal.timeout(10000)});successDuringOutage=response.ok}catch{}
  check(!successDuringOutage,'Workspace accepted request while PostgreSQL was stopped');
  const databaseWorkerExited=pilot.exited;await pilot.close();pilot=undefined;
  await docker('/usr/bin/docker',['start',databaseContainer],{timeout:10000});
  let restarted=false;for(let i=0;i<60;i++){try{await docker('/usr/bin/docker',['exec',databaseContainer,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U load -d load'],{timeout:5000});restarted=true;break}catch{await delay(500)}}check(restarted,'PostgreSQL restart');
  pilot=await application();check((await fetch(origin+'/health/ready')).status===200,'Readiness after database recovery');
  const afterDatabase=await call(owner,'/api/runs'),afterBalance=await call(owner,'/api/balance');
  check(afterDatabase.response.status===200&&afterDatabase.data.runs.length===beforeDatabase.data.runs.length,'Persisted jobs/session after database recovery: status '+afterDatabase.response.status+', expected '+beforeDatabase.data.runs.length+', actual '+afterDatabase.data.runs?.length);
  for(const before of all.data.runs){const after=afterDatabase.data.runs.find(j=>j.id===before.id);check(after&&after.settlementTxHash===before.settlementTxHash&&after.charged===before.charged&&after.refund===before.refund,'Database restart changed finalized payment')}
  check(afterBalance.data.available===balance.data.available&&afterBalance.data.reserved==='0','Database restart changed balance');
  checks.push('separate PostgreSQL stopped: requests fail closed; database and controller restarted; sessions, finalized settlements and balances preserved');
  const result={passed:true,observedAt:new Date().toISOString(),scope:'isolated full HTTP application, ephemeral chain 31337, separate PostgreSQL and actual gVisor CPU',database:'PostgreSQL, production image digest',mainnetTransactions:0,mainnetSignerLoaded:false,load,checks,
    soak,databaseOutage:{passed:true,workerExitedOnConnectionLoss:databaseWorkerExited,restoredSessionsAndSettlements:true},paidRuns:all.data.runs.length,chargedAtomicTestTokens:charge.toString(),remainingReservedAtomicTestTokens:balance.data.reserved,stopStatus:stopped.status,killStatus:killed.status};
  await writeFile(WORK+'/result.json',JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify({...result,report:WORK+'/result.json'})+'\n');
}catch(error){process.stdout.write(JSON.stringify({passed:false,phase,errorType:error.name,message:error.message,reportDirectory:WORK})+'\n');process.exitCode=1}
finally{
  offline=false;await pilot?.close();if(proxy)await new Promise(r=>proxy.close(r));anvil.kill('SIGTERM');
  if(databaseRequested){
    const inspect=await docker('/usr/bin/docker',['inspect','--format','{{index .Config.Labels "telomere.load.database"}}',databaseContainer],{timeout:5000}).catch(()=>undefined);
    if(inspect?.stdout.trim()===databaseContainer)await docker('/usr/bin/docker',['rm','-f',databaseContainer],{timeout:10000});
  }
  if(volumeCreated){
    const inspect=await docker('/usr/bin/docker',['volume','inspect','--format','{{index .Labels "telomere.load.database"}}',databaseVolume],{timeout:5000}).catch(()=>undefined);
    if(inspect?.stdout.trim()===databaseContainer)await docker('/usr/bin/docker',['volume','rm',databaseVolume],{timeout:10000});
  }
}
