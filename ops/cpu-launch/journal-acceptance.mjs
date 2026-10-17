// Genuine EVM/PostgreSQL acceptance. Only generated accounts and chain 31337.
import {createServer} from 'node:http';
import {spawn,fork,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const BASE='/opt/telomere-mainnet-pilot',APP=process.env.CANDIDATE_APPLICATION_DIR;
if(!/^\/opt\/telomere-mainnet-pilot\/rehearsals\/journal-[0-9a-f]{16}$/.test(APP||''))throw Error('Root-owned candidate required');
if((await stat(APP)).uid!==0)throw Error('Candidate owner differs');
const {ChainBridge}=await import(APP+'/dist/src/bridge.js'),{loadConfig}=await import(APP+'/dist/src/config.js');
const {jobs,transactions,journalArchiveBatches,openStore}=await import(APP+'/dist/src/store.js');
const {Service}=await import(APP+'/dist/src/service.js'),{Worker}=await import(APP+'/dist/src/worker.js');
const {createDockerCpuExecutor}=await import(APP+'/dist/src/runtime/index.js');
const {hashJson,jsonSafe,typedQuote}=await import(APP+'/dist/src/common.js');
const {escrowAbi,tokenAbi}=await import(APP+'/dist/src/chain/abi.js');
const {createPublicClient,createWalletClient,createTestClient,http,parseEther,encodeFunctionData,keccak256,TransactionReceiptNotFoundError}=await import(APP+'/node_modules/viem/_esm/index.js');
const {generatePrivateKey,privateKeyToAccount}=await import(APP+'/node_modules/viem/_esm/accounts/index.js');
const {eq,asc,sql}=await import(APP+'/node_modules/drizzle-orm/index.js');
const {default:pg}=await import(APP+'/node_modules/pg/lib/index.js'),{default:pino}=await import(APP+'/node_modules/pino/pino.js');
const check=(condition,message)=>{if(!condition)throw Error(message)};
function isolated(settings){
  check(settings.CHAIN_ID==='31337'&&settings.MODE==='demo'&&/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.RPC_URL),'Disposable chain settings');
  const url=new URL(settings.DATABASE_URL);check(url.protocol==='postgresql:'&&url.hostname==='127.0.0.1'&&url.username==='load'&&url.pathname==='/load','Disposable PostgreSQL settings');
}
if(process.argv[2]==='--crash-controller'){
  process.once('message',async settings=>{try{isolated(settings);const store=await openStore(loadConfig(settings));const bridge=new ChainBridge(loadConfig(settings));
    process.send({ready:true});await bridge.archiveJournal(store.db,{force:true,batchSize:64});process.send({unexpectedCommit:true});await store.close();process.exit(1);
  }catch(error){process.send({failed:true,errorType:error.name});process.exit(1)}});
}else{
  const WORK=await mkdtemp(BASE+'/data/cpu-launch-acceptance-20261017/journal-');
  const namespace=process.env.TELOMERE_ACCEPTANCE_NAMESPACE;check(/^[0-9a-f]{16}$/.test(namespace||''),'Fixture namespace');
  const docker=promisify(execFile),databaseContainer='telomere-load-postgres-'+namespace,databaseVolume=databaseContainer+'-data';
  let anvil,store,connection,worker,volumeCreated=false,databaseCreated=false,phase='setup',releaseHeld;
  const report={scope:'candidate backend; actual local EVM settlements and PostgreSQL; one genuine gVisor CPU job',mainnetTransactions:0,mainnetSignerLoaded:false};
  const progress=value=>{phase=value;process.stdout.write(JSON.stringify({phase,observedAt:new Date().toISOString()})+'\n')};
  async function port(){const server=createServer();await new Promise((ok,no)=>server.listen(0,'127.0.0.1',ok).once('error',no));const p=server.address().port;await new Promise(ok=>server.close(ok));return p}
  try{
    const chainPort=await port(),rpcUrl='http://127.0.0.1:'+chainPort,dbPort=await port(),password=randomUUID().replaceAll('-','');
    anvil=spawn(BASE+'/operator/acceptance-tools/anvil',['--host','127.0.0.1','--port',String(chainPort),'--chain-id','31337','--accounts','0',
      '--prune-history','16','--transaction-block-keeper','8192','--silent'],{stdio:'ignore'});
    report.fixtureEvm={historicalStatesInMemory:16,retainedTransactionBlocks:8192,allTestTransactionReceiptsRetained:true};
    const chain={id:31337,name:'Journal acceptance',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}};
    const publicClient=createPublicClient({chain,transport:http(rpcUrl,{retryCount:0,timeout:10000}),cacheTime:0});
    for(let i=0;i<100;i++){try{if(await publicClient.getChainId()===31337)break}catch{}await delay(100)}check(await publicClient.getChainId()===31337,'Local chain guard');
    const test=createTestClient({chain,mode:'anvil',transport:http(rpcUrl,{retryCount:0})});
    const keys={owner:generatePrivateKey(),signer:generatePrivateKey(),treasury:generatePrivateKey()};
    const accounts=Object.fromEntries(Object.entries(keys).map(([key,value])=>[key,privateKeyToAccount(value)]));
    for(const account of Object.values(accounts))await test.setBalance({address:account.address,value:parseEther('10')});
    const owner=createWalletClient({chain,account:accounts.owner,transport:http(rpcUrl,{retryCount:0})});
    const fees={gas:500000n,maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n};
    const receipt=async hash=>{
      for(let attempt=0;attempt<100;attempt++){
        try{const r=await publicClient.getTransactionReceipt({hash});check(r.status==='success','Local transaction reverted');return r}
        catch(error){if(error.name!=='TransactionReceiptNotFoundError')throw error;await delay(10)}
      }
      throw Error('Automined fixture receipt deadline');
    };
    const artifact=async name=>JSON.parse(await readFile(APP+'/contracts/artifacts/'+name+'.json','utf8'));
    const tokenArtifact=await artifact('MockToken'),escrowArtifact=await artifact('TelomereRunEscrow');
    const token=(await receipt(await owner.deployContract({abi:tokenArtifact.abi,bytecode:tokenArtifact.bytecode,gas:6000000n}))).contractAddress;
    const escrow=(await receipt(await owner.deployContract({abi:escrowArtifact.abi,bytecode:escrowArtifact.bytecode,gas:6000000n,
      args:[token,accounts.signer.address,accounts.signer.address,accounts.treasury.address]}))).contractAddress;
    check(token&&escrow,'Local deployment');
    await docker('/usr/bin/docker',['volume','create','--label','telomere.load.database='+databaseContainer,databaseVolume]);volumeCreated=true;
    check(/^sha256:[0-9a-f]{64}$/.test(process.env.ACCEPTANCE_POSTGRES_IMAGE||''),'PostgreSQL image pin');
    await docker('/usr/bin/docker',['run','-d','--name',databaseContainer,'--label','telomere.load.database='+databaseContainer,
      '--runtime','runc','--network','host','--cpus','0.5','--memory','512m','--pids-limit','128',
      '--mount','type=volume,source='+databaseVolume+',target=/var/lib/postgresql/data','-e','POSTGRES_USER=load','-e','POSTGRES_DB=load','-e','POSTGRES_PASSWORD','-e','PGPORT='+dbPort,
      process.env.ACCEPTANCE_POSTGRES_IMAGE,'postgres','-c','listen_addresses=127.0.0.1','-p',String(dbPort)],{env:{...process.env,POSTGRES_PASSWORD:password}});databaseCreated=true;
    let ready=false;for(let i=0;i<60;i++){try{await docker('/usr/bin/docker',['exec',databaseContainer,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U load -d load']);ready=true;break}catch{await delay(500)}}check(ready,'PostgreSQL ready');
    const settings={MODE:'demo',CHAIN_ID:'31337',RPC_URL:rpcUrl,DATABASE_URL:'postgresql://load:'+password+'@127.0.0.1:'+dbPort+'/load',DATA_DIR:WORK+'/controller',
      SIGNER_PRIVATE_KEY:keys.signer,DEMO_PRIVATE_KEY:keys.owner,TOKEN_ADDRESS:token,ESCROW_ADDRESS:escrow,CPU_MODE:'docker',CPU_IMAGE:process.env.CPU_IMAGE};
    isolated(settings);const config=loadConfig(settings);store=await openStore(config);let bridge=new ChainBridge(config);await bridge.check();
    connection=new pg.Client({connectionString:settings.DATABASE_URL});await connection.connect();
    await receipt(await owner.writeContract({address:token,abi:tokenArtifact.abi,functionName:'faucet',args:[accounts.owner.address,1000000n],...fees}));
    await receipt(await owner.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[escrow,1000000n],...fees}));
    await receipt(await owner.writeContract({address:escrow,abi:escrowAbi,functionName:'deposit',args:[1000000n],...fees}));
    const leashId=hashJson({namespace,leash:true});await receipt(await owner.writeContract({address:escrow,abi:escrowAbi,functionName:'createLeash',
      args:[leashId,accounts.owner.address,1000000n,10000000n,BigInt(Math.floor(Date.now()/1000)+86400)],...fees}));
    progress('mine_2105_distinct_legacy_settlements');
    const count=2105,started=performance.now();let ownerNonce=await publicClient.getTransactionCount({address:accounts.owner.address}),signerNonce=0,buffer=[];const samples=[];
    async function flush(){if(!buffer.length)return;await store.db.insert(jobs).values(buffer.map(r=>r.job));await store.db.insert(transactions).values(buffer.map(r=>r.journal));buffer=[]}
    for(let i=0;i<count;i++){
      const runId=hashJson({namespace,i}),input={leashId,task:{kind:'sha256',text:'historical metering fixture'},maxSeconds:2};
      const quote={runId,leashId,payer:accounts.owner.address,workloadHash:hashJson(input),maxSeconds:2,pricePerSecond:'1',inferencePrice:'0',quoteExpiry:Math.floor(Date.now()/1000)+3600};
      const signature=await bridge.signQuote(typedQuote(quote));
      await receipt(await owner.sendTransaction({to:escrow,data:bridge.openTransaction(typedQuote(quote),signature).data,nonce:ownerNonce++,...fees}));
      const body={runId,payer:accounts.owner.address,leashId,workloadHash:quote.workloadHash,status:'completed',
        cpu:{billableSeconds:1,measuredSeconds:1,pricePerSecond:'1'},near:null,billing:{token,ceiling:'2',charged:'1',refund:'1'}};
      const settlement={runId,billableSeconds:1n,inferenceCharge:0n,receiptHash:hashJson(body)},settlementSignature=await bridge.signSettlement(settlement);
      const raw=await accounts.signer.signTransaction({chainId:31337,to:escrow,data:encodeFunctionData({abi:escrowAbi,functionName:'settleRun',args:[settlement,settlementSignature]}),
        nonce:signerNonce,...fees,type:'eip1559'});const hash=keccak256(raw);await receipt(await publicClient.sendRawTransaction({serializedTransaction:raw}));
      const saved={body,receiptHash:settlement.receiptHash,settlement:jsonSafe(settlement),signature:settlementSignature,signer:accounts.signer.address,domain:bridge.domain};
      buffer.push({job:{id:runId,owner:accounts.owner.address.toLowerCase(),leashId,idemKey:runId,inputHash:hashJson(input),input,quote,signature,
        ceiling:'2',status:'completed',targetStatus:'completed',receipt:saved,charged:'1',refund:'1',settlementTxHash:hash},journal:{runId,raw,hash,nonce:signerNonce++}});
      if(i===0||i===count-1)samples.push({runId,hash,settlement,signature:settlementSignature});
      if(buffer.length===64)await flush();if(i%200===199)process.stdout.write(JSON.stringify({phase,settlements:i+1})+'\n');
    }
    await flush();check(await publicClient.getTransactionCount({address:accounts.signer.address})===count,'Legacy signer nonce');
    check(await publicClient.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.treasury.address]})===BigInt(count),'Legacy treasury transfers');
    const original=async()=>{
      const rows=(await connection.query('SELECT run_id,raw,hash,nonce,created_at::text FROM transaction_journal ORDER BY run_id')).rows;
      return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };
    const originalHash=await original();report.history={settlements:count,elapsedSeconds:(performance.now()-started)/1000,realLocalTokenTransfers:count,
      generatedOwnerAndDistinctTreasury:true,historyRepresentsSyntheticMeteringFixtures:true,originalPayloadSha256:originalHash};
    const lastHistoricalBlock=await publicClient.getBlockNumber({cacheTime:0}),reorgSnapshot=await test.snapshot();await test.mine({blocks:128});
    check((await publicClient.getBlock({blockTag:'finalized'})).number>=lastHistoricalBlock,'All historical settlements must be finalized');
    report.fixtureEvm.finalityBlocksMined=128;
    progress('kill_archive_controller_inside_uncommitted_membership_write');await store.close();store=undefined;
    await connection.query("CREATE FUNCTION archive_fixture_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END $$");
    await connection.query('CREATE TRIGGER archive_fixture_wait BEFORE UPDATE ON transaction_journal FOR EACH ROW EXECUTE FUNCTION archive_fixture_wait()');
    const child=fork(fileURLToPath(import.meta.url),['--crash-controller'],{stdio:['ignore','ignore','ignore','ipc']});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let childFailure=false;child.on('message',m=>{if(m.failed||m.unexpectedCommit)childFailure=true});child.send(settings);
    let barrier=false;for(let i=0;i<600;i++){if(childFailure)break;const q=await connection.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='load' AND wait_event='PgSleep'");if(q.rows[0].n){barrier=true;break}await delay(100)}
    child.kill('SIGKILL');const killed=await exited;check(barrier&&!childFailure&&killed.signal==='SIGKILL','Archive crash barrier');
    await connection.query('DROP TRIGGER archive_fixture_wait ON transaction_journal');await connection.query('DROP FUNCTION archive_fixture_wait()');
    store=await openStore(config);bridge=new ChainBridge(config);
    check((await store.db.select().from(journalArchiveBatches)).length===0,'Uncommitted checkpoint survived crash');
    check((await connection.query('SELECT count(*)::int AS n FROM transaction_journal WHERE archive_batch_id IS NOT NULL')).rows[0].n===0,'Partial membership survived crash');
    check(await original()===originalHash,'Crash changed original history');report.crashAtomicity={passed:true,realControllerSigkill:true,allOriginalRowsRetained:true,noPartialCheckpointOrMembership:true};
    progress('archive_all_2105_without_a_transaction');const archiveStart=performance.now();let archived=0,batches=0;
    while(archived<count){const result=await bridge.archiveJournal(store.db,{force:true,batchSize:256});check(result.archived>0,'Archive made no progress');archived+=result.archived;batches++}
    check(await original()===originalHash&&archived===count,'Archive rewrote original payloads');
    check(await publicClient.getTransactionCount({address:accounts.signer.address})===count,'Archive sent a transaction');
    await store.close();store=await openStore(config);bridge=new ChainBridge(config);await bridge.verifyJournalArchive(store.db);
    const nonceBeforeReplay=await publicClient.getTransactionCount({address:accounts.signer.address});
    for(const sample of samples)check(await bridge.settle(store.db,sample.settlement,sample.signature)===sample.hash,'Archived replay changed hash');
    check(await publicClient.getTransactionCount({address:accounts.signer.address})===nonceBeforeReplay,'Archived replay spent another nonce');
    report.archive={passed:true,archivedRows:archived,batches,elapsedSeconds:(performance.now()-archiveStart)/1000,allOriginalBytesRetained:true,
      fullFreshProcessStyleVerification:true,oldCanonicalHashesRecovered:true,noExtraSignerNonce:true};
    progress('paid_gvisor_cpu_and_restore_of_pending_new_settlement');
    const service=new Service(store.db,bridge,config,false),cpu=createDockerCpuExecutor({image:config.CPU_IMAGE});let executions=0;
    const counted={async run(...args){executions++;return cpu.run(...args)}};
    const quote=await service.quote(accounts.owner.address,{leashId,task:{kind:'hash_chain',text:'archive after 2105',iterations:1000000},maxSeconds:20},randomUUID());
    const opening=await receipt(await owner.sendTransaction({to:quote.transaction.to,data:quote.transaction.data,...fees}));
    await service.admit(accounts.owner.address,quote.quote.runId,opening.transactionHash);
    const rawSend=bridge.public.sendRawTransaction;let held;
    const gate=new Promise(resolve=>{releaseHeld=resolve});bridge.public.sendRawTransaction=async args=>{held=args;await gate;return keccak256(args.serializedTransaction)};
    worker=new Worker(store.db,bridge,counted,undefined,pino({enabled:false}));const draining=worker.drainOnce();let drainError;draining.catch(error=>{drainError=error});
    for(let i=0;i<600&&!held&&!drainError;i++)await delay(100);check(held&&!drainError,'New signed settlement barrier');
    const pending=(await store.db.select().from(transactions).where(eq(transactions.runId,quote.quote.runId)))[0];check(pending&&pending.nonce===count,'New settlement nonce after archive');
    await docker('/usr/bin/docker',['exec',databaseContainer,'pg_dump','-U','load','-d','load','-Fc','-f','/tmp/archive-pending.dump'],{timeout:120000});
    await receipt(await publicClient.sendRawTransaction(held));releaseHeld();await draining;bridge.public.sendRawTransaction=rawSend;
    const completed=(await store.db.select().from(jobs).where(eq(jobs.id,quote.quote.runId)))[0];check(completed.status==='completed'&&BigInt(completed.charged)>0n,'Genuine paid CPU charge');
    await worker.stop();worker=undefined;await store.close();store=undefined;
    await connection.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await docker('/usr/bin/docker',['exec',databaseContainer,'pg_restore','-U','load','-d','load','--exit-on-error','--no-owner','--no-acl','/tmp/archive-pending.dump'],{timeout:120000});
    store=await openStore(config);bridge=new ChainBridge(config);await bridge.verifyJournalArchive(store.db);
    const persisted=(await store.db.select().from(transactions).where(eq(transactions.runId,quote.quote.runId)))[0];check(persisted.raw===pending.raw&&persisted.hash===pending.hash,'Restored raw bytes differ');
    const nonceBeforeRecover=await publicClient.getTransactionCount({address:accounts.signer.address});
    worker=new Worker(store.db,bridge,{async run(){throw Error('Restored settlement must not rerun CPU')}},undefined,pino({enabled:false}));
    await worker.recover(true);await worker.drainOnce();await worker.stop();worker=undefined;
    const recovered=(await store.db.select().from(jobs).where(eq(jobs.id,quote.quote.runId)))[0];
    check(recovered.status==='completed'&&recovered.settlementTxHash===pending.hash&&recovered.charged===completed.charged&&recovered.refund===completed.refund,'Restored settlement differs');
    check(await publicClient.getTransactionCount({address:accounts.signer.address})===nonceBeforeRecover,'Recovery charged another transaction');
    const verifier=new Service(store.db,bridge,config,false),verified=await verifier.verifyReceipt(recovered.receipt);check(verified.valid&&verified.anchored,'Recovered receipt verification');
    const treasury=await publicClient.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.treasury.address]});
    const available=(await bridge.balance(accounts.owner.address)).available;check(treasury===BigInt(count)+BigInt(recovered.charged)&&BigInt(available)+treasury===1000000n,'Final local token conservation');
    check(executions===1,'CPU executed twice');report.paidCpuRecovery={passed:true,executions,settlementNonce:pending.nonce,chargedAtomicTestTokens:recovered.charged,refundAtomicTestTokens:recovered.refund,
      recoveredOriginalTransactionHash:pending.hash,receiptValid:true,receiptAnchored:true,rawBytesIdentical:true,noAdditionalNonce:true,independentTreasuryExact:true,availableAtomicTestTokens:available};
    progress('missing_archived_receipt_must_never_broadcast');
    const sample=samples[0],originalRead=bridge.public.getTransactionReceipt,originalSend=bridge.public.sendRawTransaction;let unexpectedBroadcasts=0;
    bridge.public.getTransactionReceipt=async args=>{if(args.hash===sample.hash)throw new TransactionReceiptNotFoundError({hash:sample.hash});return originalRead(args)};
    bridge.public.sendRawTransaction=async args=>{unexpectedBroadcasts++;return originalSend(args)};
    let refused=false;try{await bridge.settle(store.db,sample.settlement,sample.signature)}catch(error){refused=/Archived settlement receipt is unavailable/.test(error.message)}
    check(refused&&unexpectedBroadcasts===0,'Archived outage rebroadcast');bridge.public.getTransactionReceipt=originalRead;
    report.archivedRpcOutage={passed:true,receiptUnavailabilityRefused:true,broadcasts:unexpectedBroadcasts};
    progress('reject_finalized_anchor_reorg_before_any_broadcast');await test.revert({id:reorgSnapshot});await test.increaseTime({seconds:123});await test.mine({blocks:128});
    let reorgRejected=false;try{await bridge.settle(store.db,sample.settlement,sample.signature)}catch{reorgRejected=true}
    check(reorgRejected&&unexpectedBroadcasts===0,'Archive anchor reorg did not halt');report.reorg={passed:true,actualLocalChainRevertAndReplacementBlocks:true,archivalAnchorRejected:true,broadcasts:0,
      positiveCpuBranchIntentionallyDiscardedAfterItsAssertions:true};
    const vm=await readFile('/proc/'+anvil.pid+'/status','utf8');report.fixtureEvm.peakRssKiB=Number(vm.match(/^VmHWM:\s+(\d+)/m)[1]);
    progress('passed');const result={passed:true,observedAt:new Date().toISOString(),...report};await writeFile(WORK+'/result.json',JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify({...result,report:WORK+'/result.json'})+'\n');
  }catch(error){process.exitCode=1;process.stdout.write(JSON.stringify({passed:false,phase,errorType:error.name,message:error.shortMessage||error.message,reportDirectory:WORK})+'\n')}
  finally{
    releaseHeld?.();await worker?.stop();await store?.close();await connection?.end();anvil?.kill('SIGTERM');
    if(databaseCreated){const label=(await docker('/usr/bin/docker',['inspect','--format','{{index .Config.Labels "telomere.load.database"}}',databaseContainer])).stdout.trim();check(label===databaseContainer,'Database cleanup scope');await docker('/usr/bin/docker',['rm','-f',databaseContainer])}
    if(volumeCreated){const label=(await docker('/usr/bin/docker',['volume','inspect','--format','{{index .Labels "telomere.load.database"}}',databaseVolume])).stdout.trim();check(label===databaseContainer,'Volume cleanup scope');await docker('/usr/bin/docker',['volume','rm',databaseVolume])}
  }
}
