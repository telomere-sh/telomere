// Isolated HTTP/queue/fault acceptance against the exact deployed application.
// Every key, contract, database and transaction below belongs to local chain 31337.
import {createServer} from 'node:http';
import {spawn,fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdtemp,rename} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const APP=process.env.ACCEPTANCE_RELEASE_DIR;
if(!/^\/opt\/telomere-mainnet-pilot\/releases\/[0-9a-f]{40}$/.test(APP||''))throw Error('Pinned physical release required');
const {escrowAbi,tokenAbi}=await import(APP+'/dist/src/chain/abi.js');
const {emptyWorkspace}=await import(APP+'/dist/src/workspace/routes.js');
const {createPublicClient,createTestClient,createWalletClient,http,parseEther}=await import(APP+'/node_modules/viem/_esm/index.js');
const {generatePrivateKey,privateKeyToAccount}=await import(APP+'/node_modules/viem/_esm/accounts/index.js');
const BASE='/opt/telomere-mainnet-pilot',WORK=await mkdtemp(BASE+'/data/cpu-launch-acceptance-20261017/http-load-');
const check=(value,message)=>{if(!value)throw Error(message)};
const HISTORY=Number(process.env.ACCEPTANCE_STRESS_HISTORY||10000);check([256,10000].includes(HISTORY),'Reviewed history size');
async function listen(server){await new Promise((ok,no)=>server.listen(0,'127.0.0.1',ok).once('error',no));return server.address().port}
async function port(){const s=createServer(),p=await listen(s);await new Promise(r=>s.close(r));return p}
const chainPort=await port(),chainUrl='http://127.0.0.1:'+chainPort;
const anvil=spawn(BASE+'/operator/acceptance-tools/anvil',['--host','127.0.0.1','--port',String(chainPort),'--chain-id','31337','--accounts','0','--prune-history','16','--transaction-block-keeper','32768','--silent'],{stdio:'ignore'});
let observer,seedLeash,seedSummary,pilot,proxy,databaseContainer,databaseVolume,databaseRequested=false,volumeCreated=false,offline=false,phase='local_chain';const observations=[],checks=[];
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
  const {faultProxy}=await import('./fixture-rpc-proxy.mjs');const faults=faultProxy(chainUrl);proxy=faults.server;
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
    phase='seed_10000_canonical_settlements';process.stdout.write(JSON.stringify({phase})+'\n');
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
      const seedStarted=performance.now();
      await seedHistory({APP,settings,store:seedStore,bridge,owner:wallet,signer:accounts.signer,publicClient:direct,leashId:seedLeash,count:HISTORY,
        progress:value=>process.stdout.write(JSON.stringify({phase,...value})+'\n')});
      seedSummary={settlements:HISTORY,syntheticMeteringFixtures:true,realLocalContractSettlements:true,seedElapsedSeconds:(performance.now()-seedStarted)/1000};
      await test.mine({blocks:128});const archiving=performance.now();let archived=0;
      while(archived<HISTORY-256){const result=await bridge.archiveJournal(seedStore.db,{force:true,batchSize:Math.min(256,HISTORY-256-archived)});check(result.archived>0,'Large archive progress');archived+=result.archived}
      await bridge.verifyJournalArchive(seedStore.db);seedSummary.archivedRows=archived;seedSummary.activeRows=256;seedSummary.archiveElapsedSeconds=(performance.now()-archiving)/1000;
      check(await direct.getTransactionCount({address:accounts.signer.address})===HISTORY,'Archiving spent signer nonce');
    }finally{await seedStore.close()}
    observer=new pg.Client({connectionString:settings.DATABASE_URL});await observer.connect();
  }
  async function archiveStatus(){
    const value=(await observer.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE archive_batch_id IS NOT NULL)::int AS archived FROM transaction_journal')).rows[0];
    const batches=(await observer.query('SELECT count(*)::int AS n FROM settlement_journal_archive_batches')).rows[0].n;

    return {retainedRows:value.total,archivedRows:value.archived,activeRows:value.total-value.archived,batches};
  }
  async function application(options={}){
    const child=fork(BASE+'/operator/cpu-launch/archive-load-worker.mjs',[],{stdio:['ignore','ignore','ignore','ipc']});
    let exited=false;const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal})}));
    const ready=new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error('Acceptance worker startup failed: '+m.errorType)));child.once('exit',()=>reject(Error('Acceptance worker exited before readiness')))});
    child.send({settings,paused:options.paused===true});await Promise.race([ready,delay(30000).then(()=>{throw Error('Acceptance worker readiness deadline')})]);
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

  const {archiveScenarios}=await import('./journal-stress-scenarios.mjs');
  const outcome=await archiveScenarios({APP,BASE,WORK,HISTORY,check,settings,seedSummary,seedLeash,observer,archiveStatus,clients,accounts,wallet,chain,direct,test,
    token,escrow,tokenAbi,escrowAbi,tokenArtifact,receipt,call,docker,databaseContainer,faults,application,getPilot:()=>pilot,setPilot:value=>{pilot=value}});
  const result={passed:true,observedAt:new Date().toISOString(),releaseId:APP.split('/').at(-1),mainnetTransactions:0,mainnetSignerLoaded:false,...outcome};
  await writeFile(WORK+'/result.json',JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify({...result,report:WORK+'/result.json'})+'\n');

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
