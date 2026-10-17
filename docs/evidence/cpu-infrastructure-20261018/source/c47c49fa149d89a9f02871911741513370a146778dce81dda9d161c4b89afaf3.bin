import {fork} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,open,unlink,readdir,statfs} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
export async function infrastructureScenarios(c){
  const {APP,BASE,WORK,HISTORY,check,settings,seedSummary,accounts,direct,docker,databaseContainer,
    application,getPilot,setPilot,getObserver,setObserver}=c;
  const {default:pg}=await import(APP+'/node_modules/pg/lib/index.js');
  const {openStore}=await import(APP+'/dist/src/store.js'),{loadConfig}=await import(APP+'/dist/src/config.js');
  const {ChainBridge}=await import(APP+'/dist/src/bridge.js'),config=loadConfig(settings);
  const namespace=process.env.TELOMERE_ACCEPTANCE_NAMESPACE;
  check(/^[0-9a-f]{16}$/.test(namespace||''),'Fixture namespace');
  const phase=name=>process.stdout.write(JSON.stringify({phase:name,observedAt:new Date().toISOString(),reportDirectory:WORK})+'\n');
  async function connect(){const db=new pg.Client({connectionString:settings.DATABASE_URL});db.on('error',()=>{});await db.connect();return db}
  async function financial(){
    const db=getObserver(),rows=(await db.query('SELECT run_id,raw,hash,nonce,created_at::text FROM transaction_journal ORDER BY run_id')).rows;
    const counts=(await db.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE archive_batch_id IS NOT NULL)::int AS archived FROM transaction_journal')).rows[0];
    const batches=(await db.query('SELECT count(*)::int AS n FROM settlement_journal_archive_batches')).rows[0].n;
    return {sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),...counts,batches,
      nonce:await direct.getTransactionCount({address:accounts.signer.address})};
  }
  async function worker(allowAbruptExit=false){
    const child=fork(BASE+'/operator/cpu-launch/archive-fault-worker.mjs',[],{stdio:['ignore','ignore','ignore','ipc']});
    let result,exited=false;
    const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal})}));
    const done=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Archive fault worker deadline'))},30000);
      child.on('message',value=>{if(value.finished){result=value;clearTimeout(timer);resolve(value)}});
      child.once('exit',(code,signal)=>{if(!result){clearTimeout(timer);
        if(allowAbruptExit)resolve({finished:true,passed:false,codes:[],processExit:{code,signal},resultUnavailable:true});
        else reject(Error('Archive worker exited without a result'))}});
    });
    // Avoid an unhandled rejection while the coordinator waits for the SQL barrier.
    done.catch(()=>{});child.send(settings);
    return {child,done,exit,get exited(){return exited}};
  }
  async function barrier(db){
    for(let i=0;i<40;i++){
      const row=(await db.query("SELECT pid FROM pg_stat_activity WHERE datname='load' AND wait_event='PgSleep' AND query LIKE 'update%transaction_journal%' LIMIT 1")).rows[0];
      if(row)return row.pid;await delay(100);
    }throw Error('Archive membership barrier not reached');
  }
  async function trap(){await getObserver().query("CREATE FUNCTION infrastructure_archive_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(20); RETURN NEW; END $$");
    await getObserver().query('CREATE TRIGGER infrastructure_archive_wait BEFORE UPDATE OF archive_batch_id ON transaction_journal FOR EACH ROW EXECUTE FUNCTION infrastructure_archive_wait()')}
  async function untrap(){await getObserver().query('DROP TRIGGER infrastructure_archive_wait ON transaction_journal');await getObserver().query('DROP FUNCTION infrastructure_archive_wait()')}
  const result={history:seedSummary,postgresFaults:[]};
  await writeFile(WORK+'/https-ready.json',JSON.stringify({namespace,port:Number(settings.PORT)})+'\n');
  phase('waiting_for_external_authenticated_https_load');
  let external;
  if(process.env.ACCEPTANCE_RETAINED_HTTPS_REPORT){
    external=JSON.parse(await readFile(process.env.ACCEPTANCE_RETAINED_HTTPS_REPORT,'utf8'));
    result.publicHttpsAcceptanceFromSeparateFixture=true;
  }
  for(let i=0;!external&&i<900;i++){
    try{external=JSON.parse(await readFile(WORK+'/https-client-result.json','utf8'));break}catch(error){if(error.code!=='ENOENT')throw error}
    await delay(1000);
  }
  check(external?.passed===true&&(external.namespace===namespace||result.publicHttpsAcceptanceFromSeparateFixture)&&external.publicTls===true,'External HTTPS acceptance');
  result.https=external;await getPilot().close();
  const baseline=await financial();check(baseline.total===HISTORY&&baseline.nonce===HISTORY,'Initial financial scope');

  phase('postgres_archive_lock_timeout');
  const lock=await connect();await lock.query('BEGIN');await lock.query('UPDATE settlement_journal_lock SET id=id WHERE id=1');
  try{
    const started=performance.now(),job=await worker(),failure=await job.done;await job.exit;
    check(!failure.passed&&failure.codes.includes('57014'),'Real PostgreSQL statement timeout');
    result.postgresFaults.push({case:'journal_lock_timeout',passed:true,codes:failure.codes,elapsedSeconds:(performance.now()-started)/1000});
  }finally{await lock.query('ROLLBACK');await lock.end()}
  check(JSON.stringify(await financial())===JSON.stringify(baseline),'Lock timeout changed history');

  phase('postgres_connection_terminated_inside_archive_membership');await trap();
  try{
    const job=await worker(),pid=await barrier(getObserver());
    check((await getObserver().query('SELECT pg_terminate_backend($1) AS terminated',[pid])).rows[0].terminated,'Backend termination');
    const failure=await job.done;await job.exit;check(!failure.passed,'Terminated archive committed');
    check(JSON.stringify(await financial())===JSON.stringify(baseline),'Connection loss left partial archive');
    result.postgresFaults.push({case:'backend_termination_during_membership',passed:true,codes:failure.codes,noPartialCheckpoint:true});
  }finally{await untrap()}

  phase('postgres_sigkill_restart_inside_archive_membership');await trap();
  const crashing=await worker(true);await barrier(getObserver());await getObserver().end();setObserver(undefined);
  await docker('/usr/bin/docker',['kill','--signal','KILL',databaseContainer],{timeout:15000});
  const crashResult=await crashing.done;await crashing.exit;check(!crashResult.passed,'Killed PostgreSQL committed archive');
  await docker('/usr/bin/docker',['start',databaseContainer],{timeout:15000});
  let connected;
  for(let i=0;i<100;i++){try{connected=await connect();break}catch{await delay(100)}}check(connected,'PostgreSQL crash recovery readiness');setObserver(connected);
  check(JSON.stringify(await financial())===JSON.stringify(baseline),'PostgreSQL crash left partial archive');await untrap();
  result.postgresFaults.push({case:'postgres_sigkill_and_wal_recovery',passed:true,codes:crashResult.codes,
    ...(crashResult.processExit?{archiveProcessExit:crashResult.processExit}:{}),noPartialCheckpoint:true});

  phase('postgres_actual_enospc_during_archive_membership');
  await docker('/usr/bin/docker',['exec',databaseContainer,'chown','postgres:postgres','/archive-full']);
  await getObserver().query("CREATE TABLESPACE infrastructure_full LOCATION '/archive-full'");
  await getObserver().query('CREATE TABLE infrastructure_disk_filler(payload text) TABLESPACE infrastructure_full');
  await getObserver().query("CREATE FUNCTION infrastructure_disk_error() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO infrastructure_disk_filler VALUES(repeat('x',1048576)); RETURN NEW; END $$");
  await getObserver().query('CREATE TRIGGER infrastructure_disk_error BEFORE UPDATE OF archive_batch_id ON transaction_journal FOR EACH ROW EXECUTE FUNCTION infrastructure_disk_error()');
  const full=await docker('/usr/bin/docker',['exec',databaseContainer,'dd','if=/dev/zero','of=/archive-full/filler','bs=1M','count=20','status=none']).then(()=>({unexpectedSuccess:true}),error=>({exitCode:error.code,noSpace:/No space left on device/.test(error.stderr)}));
  check(full.noSpace,'Bounded PostgreSQL tablespace was not full');
  try{
    const job=await worker(),failure=await job.done;await job.exit;
    check(!failure.passed&&failure.codes.includes('53100'),'PostgreSQL physical disk-full error');
    check(JSON.stringify(await financial())===JSON.stringify(baseline),'Disk failure committed partial archive');
    result.postgresFaults.push({case:'actual_tablespace_enospc_during_membership',passed:true,codes:failure.codes,limitBytes:16777216,noPartialCheckpoint:true});
  }finally{
    await docker('/usr/bin/docker',['exec',databaseContainer,'rm','-f','/archive-full/filler']);
    await getObserver().query('DROP TRIGGER infrastructure_disk_error ON transaction_journal');await getObserver().query('DROP FUNCTION infrastructure_disk_error()');
    await getObserver().query('DROP TABLE infrastructure_disk_filler');await getObserver().query('DROP TABLESPACE infrastructure_full');
  }
  phase('successful_archive_after_all_postgres_faults');
  const retry=await worker(),success=await retry.done;await retry.exit;check(success.passed&&success.result.archived===8,'Original archive recovery');
  const recovered=await financial();check(recovered.sha256===baseline.sha256&&recovered.nonce===HISTORY&&recovered.total===HISTORY&&recovered.archived===8&&recovered.batches===1,'Recovered archive provenance');
  result.archiveRecovery={passed:true,originalJournalSha256:baseline.sha256,retainedRows:HISTORY,archivedRows:8,nonce:HISTORY,noNewTransaction:true};

  phase('actual_filesystem_enospc_preserves_cysts_and_idempotent_retry');
  const directory=BASE+'/rehearsals/disk-'+namespace;
  const fs=await statfs(directory);check(fs.bsize*fs.blocks<=16777216,'Bounded filesystem');
  const store=await openStore(config);
  try{
    const {CystService}=await import(APP+'/dist/src/cysts/service.js');
    const {encryptCheckpoint,decryptCheckpoint}=await import(APP+'/dist/src/sdk/cysts.js');
    const service=new CystService(store.db,directory,{globalBytes:1073741824});await service.initialize();
    const owner=accounts.owner.address.toLowerCase(),first=await encryptCheckpoint(new TextEncoder().encode('retained checkpoint'),{owner,applicationSchema:'acceptance.v1'});
    await service.upload(owner,first.envelope,'first-'+namespace);
    const next=await encryptCheckpoint(new Uint8Array(524288).fill(7),{owner,applicationSchema:'acceptance.v1'}),key='retry-'+namespace;
    const filler=directory+'/filler';const handle=await open(filler,'wx',0o600);let written=0,fullError;
    try{for(let i=0;i<100;i++){await handle.writeFile(Buffer.alloc(262144));written+=262144}}
    catch(error){fullError=error.code}finally{await handle.close()}
    check(fullError==='ENOSPC','Real filesystem ENOSPC');
    let failure;try{await service.upload(owner,next.envelope,key)}catch(error){failure=error.code||error.name}
    check(failure,'Full filesystem upload accepted');
    const pending=(await getObserver().query('SELECT state FROM cysts WHERE owner=$1 AND id=$2',[owner,next.envelope.id])).rows[0];
    check(pending?.state==='pending','Failed ciphertext published ready');
    const usage=(await getObserver().query('SELECT used_bytes,checkpoints FROM cyst_owners WHERE owner=$1',[owner])).rows[0];
    const old=await service.download(owner,first.envelope.id);check(old.ciphertext===first.envelope.ciphertext,'Existing checkpoint lost');
    check(!(await readdir(directory)).some(name=>name.startsWith('.tmp-')),'Leaked temporary ciphertext');
    await unlink(filler);const complete=await service.upload(owner,next.envelope,key);check(complete.replayed&&complete.checkpoint.state==='ready','Original upload retry');
    const after=(await getObserver().query('SELECT used_bytes,checkpoints FROM cyst_owners WHERE owner=$1',[owner])).rows[0];check(JSON.stringify(after)===JSON.stringify(usage),'Retry charged quota twice');
    const downloaded=await service.download(owner,next.envelope.id);check((await decryptCheckpoint({...next.envelope,ciphertext:downloaded.ciphertext},next.recoveryKey)).length===524288,'Recovered ciphertext decryption');
    result.diskFull={passed:true,kernelError:fullError,uploadError:failure,filesystemLimitBytes:16777216,filledBytesAtLeast:written,pendingUntilDurable:true,
      existingCheckpointReadable:true,temporaryFilesRemoved:true,idempotentRetry:true,quotaChargedOnce:true,decryptedBytes:524288};
    await new ChainBridge(config).verifyJournalArchive(store.db);
  }finally{await store.close()}
  phase('fresh_application_after_infrastructure_recovery');setPilot(await application({paused:true}));
  const response=await fetch('http://127.0.0.1:'+settings.PORT+'/health/ready');check(response.status===200,'Post-fault readiness');
  check((await financial()).sha256===baseline.sha256&&await direct.getTransactionCount({address:accounts.signer.address})===HISTORY,'Infrastructure recovery changed financial history');
  result.freshStart={passed:true,ready:true,originalJournalRetained:true,noNewNonce:true};return result;
}
