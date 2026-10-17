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
import {createPublicClient,createTestClient,createWalletClient,http,parseEther,encodeFunctionData} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/index.js';
import {generatePrivateKey,privateKeyToAccount} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/accounts/index.js';
const BASE='/opt/telomere-mainnet-pilot',WORK=await mkdtemp(BASE+'/data/cpu-launch-acceptance-20261017/http-load-');
const check=(value,message)=>{if(!value)throw Error(message)};
async function listen(server){await new Promise((ok,no)=>server.listen(0,'127.0.0.1',ok).once('error',no));return server.address().port}
async function port(){const s=createServer(),p=await listen(s);await new Promise(r=>s.close(r));return p}
const chainPort=await port(),chainUrl='http://127.0.0.1:'+chainPort;
const anvil=spawn(BASE+'/operator/acceptance-tools/anvil',['--host','127.0.0.1','--port',String(chainPort),'--chain-id','31337','--accounts','0','--silent'],{stdio:'ignore'});
let pilot,proxy,databaseContainer,databaseVolume,databaseRequested=false,volumeCreated=false,offline=false,holdBroadcast=false,phase='local_chain';const observations=[],checks=[];
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
  proxy=createServer(async(req,res)=>{if(offline){res.writeHead(503);res.end();return}try{const chunks=[];for await(const chunk of req)chunks.push(chunk);if(holdBroadcast&&JSON.parse(Buffer.concat(chunks)).method==='eth_sendRawTransaction'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(Buffer.concat(chunks)).id,error:{code:-32000,message:'Acceptance held broadcast'}}));return}const r=await fetch(chainUrl,{method:'POST',headers:{'content-type':'application/json'},body:Buffer.concat(chunks)});res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text())}catch{res.writeHead(503);res.end()}});
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
  async function application(options={}){
    const child=fork(BASE+'/operator/cpu-launch/resilience-worker.mjs',[],{stdio:['ignore','ignore','ignore','ipc']});
    let exited=false;const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal})}));
    const ready=new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error('Acceptance worker startup failed: '+m.errorType)));child.once('exit',()=>reject(Error('Acceptance worker exited before readiness')))});
    child.send({settings,paused:options.paused===true,release:options.release||BASE+'/app'});await Promise.race([ready,delay(30000).then(()=>{throw Error('Acceptance worker readiness deadline')})]);
    return {child,exit,get exited(){return exited},async close(){if(exited)return;child.kill('SIGTERM');await Promise.race([exit,delay(10000)]);if(!exited){child.kill('SIGKILL');await exit}}};
  }
  pilot=await application();phase='signed_accounts';
  async function call(client,path,method='GET',body,extra={}){
    const start=performance.now(),headers={origin,'content-type':'application/json','x-real-ip':client.ip,...(client.cookie?{cookie:client.cookie}:{}),...extra};
    const response=await fetch(origin+path,{method,headers,signal:AbortSignal.timeout(20000),...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();observations.push({path,status:response.status,ms:performance.now()-start});return {response,data};
  }
  async function login(account,index){const client={account,ip:'198.18.0.'+(index+1)};const c=await call(client,'/api/auth/challenge','POST',{address:account.address});check(c.response.status===200,'Challenge');
    const signature=await account.signMessage({message:c.data.message});const v=await call(client,'/api/auth/verify','POST',{address:account.address,nonce:c.data.nonce,signature});check(v.response.status===200,'Sign in');client.cookie=v.response.headers.get('set-cookie').split(';')[0];return client}
  const clients=[];for(let i=0;i<50;i++)clients.push(await login(i===0?accounts.owner:privateKeyToAccount(generatePrivateKey()),i));
  for(const [i,c] of clients.entries()){const document=emptyWorkspace();document.budget=i+1;const r=await call(c,'/api/workspace','PUT',{revision:0,document});check(r.response.status===200,'Workspace create')}
  const {scenarios}=await import('./resilience-scenarios.mjs');
  const result=await scenarios({BASE,WORK,check,clients,accounts,keys,wallet,test,direct,receipt,artifact,token,escrow,tokenArtifact,
    tokenAbi,escrowAbi,createWalletClient,http,parseEther,call,randomUUID,docker,databaseContainer,settings,application,encodeFunctionData,
    setPilot:value=>{pilot=value},getPilot:()=>pilot,setPhase:value=>{phase=value},setBroadcastHold:value=>{holdBroadcast=value}});
  const final={passed:true,observedAt:new Date().toISOString(),...result};
  await writeFile(WORK+'/result.json',JSON.stringify(final,null,2)+'\n');process.stdout.write(JSON.stringify({...final,report:WORK+'/result.json'})+'\n');
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
