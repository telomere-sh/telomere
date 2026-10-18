// Isolated HTTP/queue/fault acceptance against the exact deployed application.
// Every key, contract, database and transaction below belongs to local chain 31337.
import {createServer} from 'node:http';
import {spawn,fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdtemp,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const APP=process.env.ACCEPTANCE_RELEASE_DIR;
if(!/^\/opt\/telomere-mainnet-pilot\/releases\/[0-9a-f]{40}$/.test(APP||''))throw Error('Pinned physical release required');
const {escrowAbi,tokenAbi}=await import(APP+'/dist/src/chain/abi.js');
const {emptyWorkspace}=await import(APP+'/dist/src/workspace/routes.js');
const {createPublicClient,createTestClient,createWalletClient,http,parseEther}=await import(APP+'/node_modules/viem/_esm/index.js');
const {generatePrivateKey,privateKeyToAccount}=await import(APP+'/node_modules/viem/_esm/accounts/index.js');
const BASE='/opt/telomere-mainnet-pilot',WORK=await mkdtemp(BASE+'/data/cpu-launch-acceptance-20261017/http-load-');
const check=(value,message)=>{if(!value)throw Error(message)};
async function listen(server){await new Promise((ok,no)=>server.listen(0,'127.0.0.1',ok).once('error',no));return server.address().port}
async function port(){const s=createServer(),p=await listen(s);await new Promise(r=>s.close(r));return p}
const chainPort=await port(),chainUrl='http://127.0.0.1:'+chainPort;
const anvil=spawn(BASE+'/operator/acceptance-tools/anvil',['--host','127.0.0.1','--port',String(chainPort),'--chain-id','31337','--accounts','0','--prune-history','16','--transaction-block-keeper','8192','--silent'],{stdio:'ignore'});
let observer,seedLeash,pilot,proxy,databaseContainer,databaseVolume,databaseRequested=false,volumeCreated=false,offline=false,phase='local_chain';const observations=[],checks=[];
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
  const artifact=async name=>JSON.parse(await readFile(APP+'/contracts/artifacts/'+name+'.json','utf8'));
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

  async function seed(){
    phase='seed_256_canonical_settlements';
    const {openStore}=await import(APP+'/dist/src/store.js'),{loadConfig}=await import(APP+'/dist/src/config.js');
    const {ChainBridge}=await import(APP+'/dist/src/bridge.js'),{hashJson}=await import(APP+'/dist/src/common.js');
    const {default:pg}=await import(APP+'/node_modules/pg/lib/index.js');
    const {seedHistory}=await import('./seed-history.mjs');
    const seedStore=await openStore(loadConfig(settings)),bridge=new ChainBridge(loadConfig(settings));
    try{
      await receipt(await wallet.writeContract({address:token,abi:tokenArtifact.abi,functionName:'faucet',args:[accounts.owner.address,1000000n]}));
      await receipt(await wallet.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[escrow,1000000n]}));
      await receipt(await wallet.writeContract({address:escrow,abi:escrowAbi,functionName:'deposit',args:[1000000n]}));
      seedLeash=hashJson({namespace:process.env.ACCEPTANCE_NAMESPACE});
      await receipt(await wallet.writeContract({address:escrow,abi:escrowAbi,functionName:'createLeash',
        args:[seedLeash,accounts.owner.address,1000000n,10000000n,BigInt(Math.floor(Date.now()/1000)+90000)]}));
      await seedHistory({APP,settings,store:seedStore,bridge,owner:wallet,signer:accounts.signer,publicClient:direct,leashId:seedLeash,count:256});
      await test.mine({blocks:128});await bridge.verifyJournalArchive(seedStore.db);
    }finally{await seedStore.close()}
    observer=new pg.Client({connectionString:settings.DATABASE_URL});await observer.connect();
  }
  async function archiveStatus(){
    const value=(await observer.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE archive_batch_id IS NOT NULL)::int AS archived FROM transaction_journal')).rows[0];
    const batches=(await observer.query('SELECT count(*)::int AS n FROM settlement_journal_archive_batches')).rows[0].n;
    check(value.total===256+cpuRuns||value.total===257+cpuRuns,'Retained settlement history count differs');
    return {retainedRows:value.total,archivedRows:value.archived,activeRows:value.total-value.archived,batches};
  }
  async function application(){
    const child=fork(BASE+'/operator/cpu-launch/archive-load-worker.mjs',[],{stdio:['ignore','ignore','ignore','ipc']});
    let exited=false;const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal})}));
    const ready=new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error('Acceptance worker startup failed: '+m.errorType)));child.once('exit',()=>reject(Error('Acceptance worker exited before readiness')))});
    child.send({settings});await Promise.race([ready,delay(30000).then(()=>{throw Error('Acceptance worker readiness deadline')})]);
    return {child,exit,get exited(){return exited},async close(){if(exited)return;child.kill('SIGTERM');await Promise.race([exit,delay(10000)]);if(!exited){child.kill('SIGKILL');await exit}}};
  }
  phase='signed_accounts';
  async function call(client,path,method='GET',body,extra={}){
    const start=performance.now(),headers={origin,'content-type':'application/json','x-real-ip':client.ip,...(client.cookie?{cookie:client.cookie}:{}),...extra};
    const response=await fetch(origin+path,{method,headers,signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();observations.push({path,status:response.status,ms:performance.now()-start});if(observations.length>2000)observations.shift();return {response,data};
  }
  async function login(account,index){const client={account,ip:'198.18.0.'+(index+1)};const c=await call(client,'/api/auth/challenge','POST',{address:account.address});check(c.response.status===200,'Challenge');
    const signature=await account.signMessage({message:c.data.message});const v=await call(client,'/api/auth/verify','POST',{address:account.address,nonce:c.data.nonce,signature});check(v.response.status===200,'Sign in');client.cookie=v.response.headers.get('set-cookie').split(';')[0];return client}
  await seed();pilot=await application();const clients=[];for(let i=0;i<50;i++)clients.push(await login(i===0?accounts.owner:privateKeyToAccount(generatePrivateKey()),i));
  for(const [i,c] of clients.entries()){const document=emptyWorkspace();document.budget=i+1;const r=await call(c,'/api/workspace','PUT',{revision:0,document});check(r.response.status===200,'Workspace create')}
  phase='http_load';const began=performance.now(),startIndex=observations.length;
  await Promise.all(clients.map(async(c,i)=>{for(let j=0;j<20;j++){const r=await call(c,'/api/workspace');check(r.response.status===200&&r.data.owner===c.account.address.toLowerCase()&&r.data.document.budget===i+1,'Tenant isolation under load')}}));
  const samples=observations.slice(startIndex).map(x=>x.ms).sort((a,b)=>a-b),seconds=(performance.now()-began)/1000;
  const load={users:50,requests:samples.length,concurrency:50,elapsedSeconds:seconds,requestsPerSecond:samples.length/seconds,p50Ms:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)],p99Ms:samples[Math.floor(samples.length*.99)],errors:0};
  check(load.p95Ms<2000,'HTTP p95 exceeds acceptance ceiling');checks.push('50 signed tenants, 1000 real HTTP reads, zero cross-tenant records');

  const duration=Number(process.env.ACCEPTANCE_DURATION_SECONDS||43200);
  check(Number.isInteger(duration)&&duration>=60&&duration<=86400,'Duration bounds');
  const owner=clients[0];
  const send=async tx=>receipt(await wallet.sendTransaction({to:tx.to,data:tx.data,value:0n}));
  const bounds=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,Infinity],histogram=bounds.map(()=>0);
  let requests=0,writes=0,cpuRuns=0,charge=256n,sessionRefreshes=0,maxLatencyMs=0,maxWorkerRssKiB=0,index=0;
  const refreshMs=Number(process.env.ACCEPTANCE_SESSION_REFRESH_SECONDS||14400)*1000;check(Number.isInteger(refreshMs)&&refreshMs>=30000&&refreshMs<=14400000,'Refresh duration');
  let nextCpu=0,lastProgress=-Infinity,nextRefresh=refreshMs,pendingCpu,cpuError,readsWhileCpuPending=0,readsWhileCpuRunning=0,activeCpu=false;
  const startedAt=new Date().toISOString(),started=performance.now();
  const percentile=percentage=>{if(!requests)return null;let sum=0;for(let i=0;i<histogram.length;i++){sum+=histogram[i];if(sum>=requests*percentage)return Number.isFinite(bounds[i])?bounds[i]:null}return null};
  const status=async(state,error)=>{
    const proc=await readFile('/proc/'+pilot.child.pid+'/status','utf8').catch(()=> '');
    maxWorkerRssKiB=Math.max(maxWorkerRssKiB,Number(/VmRSS:\s+(\d+)/.exec(proc)?.[1]||0));
    const report={schemaVersion:1,state,startedAt,observedAt:new Date().toISOString(),targetSeconds:duration,elapsedSeconds:(performance.now()-started)/1000,
      scope:'pinned archive release; 256 genuine historical local settlements; automatic archival; gVisor CPU',releaseId:APP.split('/').at(-1),archive:await archiveStatus(),users:50,burst:load,requests,writes,cpuRuns,chargedAtomicTestTokens:(charge-256n).toString(),historicalChargeAtomicTestTokens:"256",
      sessionRefreshes,readsWhileCpuPending,readsWhileCpuRunning,errors:error?1:0,errorCode:error?.message,p95UpperBoundMs:percentile(.95),p99UpperBoundMs:percentile(.99),maxLatencyMs,maxWorkerRssKiB,
      mainnetTransactions:0,mainnetSignerLoaded:false,reportDirectory:WORK};
    const target=BASE+'/data/cpu-launch-acceptance-20261017/soak-'+process.env.ACCEPTANCE_NAMESPACE+'.json';
    await writeFile(target+'.tmp',JSON.stringify(report,null,2)+'\n');await rename(target+'.tmp',target);
    await writeFile(WORK+'/progress.json',JSON.stringify(report,null,2)+'\n');
    process.stdout.write(JSON.stringify(report)+'\n');return report;
  };
  const runCpu=async()=>{
        const q=await call(owner,'/api/quotes','POST',{leashId:seedLeash,task:{kind:'hash_chain',text:'sustained-'+cpuRuns,iterations:500000},maxSeconds:10},{'idempotency-key':randomUUID()});
        check(q.response.status===201,'Sustained paid quote');const opening=await send(q.data.transaction);
        check((await call(owner,'/api/runs','POST',{runId:q.data.quote.runId,txHash:opening.transactionHash})).response.status===202,'Sustained paid admission');
        let job;for(let attempt=0;attempt<120;attempt++){const r=await call(owner,'/api/runs/'+q.data.quote.runId);check(r.response.status===200,'Sustained run read');job=r.data;activeCpu=job.status==='running';if(job.status==='completed')break;check(!['failed','cancelled','timed_out','refunded'].includes(job.status),'Sustained CPU terminal failure');await delay(500)}
        check(job.status==='completed','Sustained settlement deadline');
        const verified=await call(owner,'/api/receipts/verify','POST',{receipt:job.receipt});check(verified.data.valid&&verified.data.anchored,'Sustained receipt');
        activeCpu=false;cpuRuns++;charge+=BigInt(job.charged);
        const balance=await call(owner,'/api/balance');check(balance.data.reserved==='0'&&BigInt(balance.data.available)+charge===1000000n,'Sustained balance conservation');
        check(await direct.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.treasury.address]})===charge,'Sustained treasury conservation');
  };
  phase='long_soak';await status('running');
  try{
    while(performance.now()-started<duration*1000){
      const cycle=performance.now();if(cpuError)throw cpuError;
      if(cycle-started>=nextRefresh){
        await pendingCpu;if(cpuError)throw cpuError;
        for(let i=0;i<clients.length;i++){
          check((await call(clients[i],'/api/auth/logout','POST',{})).response.status===200,'Session refresh logout');
          Object.assign(clients[i],await login(clients[i].account,i));sessionRefreshes++;
        }
        nextRefresh+=refreshMs;
      }
      await Promise.all(Array.from({length:10},async()=>{
        const i=index++%clients.length,c=clients[i],at=performance.now();
        const r=await call(c,'/api/workspace');
        check(r.response.status===200&&r.data.owner===c.account.address.toLowerCase()&&r.data.document.budget===i+1,'Sustained tenant isolation');
        const ms=performance.now()-at;requests++;if(pendingCpu)readsWhileCpuPending++;if(activeCpu)readsWhileCpuRunning++;maxLatencyMs=Math.max(maxLatencyMs,ms);histogram[bounds.findIndex(b=>ms<=b)]++;
        if(index%100===0){const w=await call(c,'/api/workspace','PUT',{revision:r.data.revision,document:r.data.document});check(w.response.status===200,'Sustained CAS write');writes++}
      }));
      if(!pendingCpu&&cycle-started>=nextCpu){
        pendingCpu=runCpu().catch(error=>{cpuError=error}).finally(()=>{pendingCpu=undefined});nextCpu+=300000;
      }
      if(cycle-started-lastProgress>=60000){await status('running');check(maxWorkerRssKiB<768*1024,'Worker memory exceeds production ceiling');lastProgress=cycle-started}
      await delay(Math.max(0,1000-(performance.now()-cycle)));
    }
    await pendingCpu;if(cpuError)throw cpuError;check(readsWhileCpuRunning>0,'Concurrent read and running CPU coverage');
    check((await archiveStatus()).archivedRows>0,'Automatic archive did not run');check(requests>=duration*7,'Sustained request-rate floor');check(percentile(.95)!==null&&percentile(.95)<=2000,'Sustained p95 ceiling');
    await status('completed');
  }catch(error){await pendingCpu;await status('failed',error);throw error}
}catch(error){process.stdout.write(JSON.stringify({passed:false,phase,errorType:error.name,message:error.message,reportDirectory:WORK})+'\n');process.exitCode=1}
finally{
  offline=false;await pilot?.close();if(proxy)await new Promise(r=>proxy.close(r));anvil.kill('SIGTERM');await observer?.end();
  if(databaseRequested){
    const inspect=await docker('/usr/bin/docker',['inspect','--format','{{index .Config.Labels "telomere.load.database"}}',databaseContainer],{timeout:5000}).catch(()=>undefined);
    if(inspect?.stdout.trim()===databaseContainer)await docker('/usr/bin/docker',['rm','-f',databaseContainer],{timeout:10000});
  }
  if(volumeCreated){
    const inspect=await docker('/usr/bin/docker',['volume','inspect','--format','{{index .Labels "telomere.load.database"}}',databaseVolume],{timeout:5000}).catch(()=>undefined);
    if(inspect?.stdout.trim()===databaseContainer)await docker('/usr/bin/docker',['volume','rm',databaseVolume],{timeout:10000});
  }
}
