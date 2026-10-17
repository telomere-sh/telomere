// Additional acceptance phases. All settings and generated keys come from the isolated launcher.
import {cp,symlink,readFile,writeFile,stat} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from '/opt/telomere-mainnet-pilot/app/node_modules/pg/lib/index.js';

export async function scenarios(c) {
  const {BASE,WORK,check,clients,accounts,keys,wallet,test,direct,receipt,artifact,token,escrow,tokenArtifact,
    tokenAbi,escrowAbi,createWalletClient,http,parseEther,call,randomUUID,docker,databaseContainer,settings,
    application,setPilot,getPilot,setPhase,setBroadcastHold}=c;
  const phase=value=>{setPhase(value);process.stdout.write(JSON.stringify({phase:value,at:new Date().toISOString()})+'\n');writeFileSync(WORK+'/checkpoint.json',JSON.stringify({phase:value,outcome},null,2)+'\n')};
  const sql=new pg.Client({connectionString:settings.DATABASE_URL});await sql.connect();
  const outcome={scope:'isolated local chain 31337; exact production code except explicit release-candidate fixture',mainnetSignerLoaded:false,mainnetTransactions:0};
  const send=async(client,tx)=>receipt(await createWalletClient({account:client.account,chain:wallet.chain,transport:http(direct.transport.url,{retryCount:0})}).sendTransaction({to:tx.to,data:tx.data,value:0n}));
  const stop=async()=>{await getPilot().close()};
  const start=async(options={})=>{const p=await application(options);setPilot(p);return p};
  const row=async id=>(await sql.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  const funding=1000000n, funded=clients.slice(0,9), budgets=[];
  const jobInput=(leashId,iterations=250000,maxSeconds=10)=>({leashId,task:{kind:'hash_chain',text:'resilience',iterations},maxSeconds});
  const quote=async(client,input)=>{const r=await call(client,'/api/quotes','POST',input,{'idempotency-key':randomUUID()});check(r.response.status===201,'Quote refused '+r.response.status);return r.data};
  const open=async(client,q)=>{const r=await send(client,q.transaction);return {runId:q.quote.runId,txHash:r.transactionHash}};
  const admit=(client,reservation)=>call(client,'/api/runs','POST',reservation);
  async function completed(client,id,seconds=300){
    for(let i=0;i<seconds*4;i++){const r=await call(client,'/api/runs/'+id);check(r.response.status===200,'Run read');if(['completed','cancelled','failed','timed_out','refunded'].includes(r.data.status))return r.data;await delay(250)}
    throw Error('Queue completion deadline');
  }
  async function verify(client,job){const r=await call(client,'/api/receipts/verify','POST',{receipt:job.receipt});check(r.data.valid&&r.data.anchored,'Receipt not canonical')}
  async function conservation(){
    const sums=(await sql.query("SELECT owner,coalesce(sum(charged::numeric),0)::text AS charged FROM jobs WHERE status IN ('completed','cancelled','timed_out','failed') GROUP BY owner")).rows;
    let charged=0n;
    for(const client of funded){const r=await call(client,'/api/balance');const amount=BigInt(sums.find(x=>x.owner===client.account.address.toLowerCase())?.charged||'0');check(BigInt(r.data.available)+BigInt(r.data.reserved)+amount===funding,'Per-owner token conservation');charged+=amount}
    const treasury=await direct.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.treasury.address]});check(treasury===charged,'Independent local treasury conservation');return charged.toString();
  }
  async function dump(name){
    const began=performance.now();
    await docker('/usr/bin/docker',['exec',databaseContainer,'pg_dump','-U','load','-d','load','-Fc','-f','/tmp/'+name+'.dump'],{timeout:180000,maxBuffer:1024*1024});
    const size=Number((await docker('/usr/bin/docker',['exec',databaseContainer,'stat','-c','%s','/tmp/'+name+'.dump'])).stdout.trim());
    return {bytes:size,elapsedSeconds:(performance.now()-began)/1000};
  }
  async function restore(name){
    // Never runs against another container/database. Controller must be stopped first.
    check(getPilot().exited,'Controller must be stopped before a scratch restore');
    const began=performance.now();
    await docker('/usr/bin/docker',['exec',databaseContainer,'psql','-X','-U','load','-d','load','-v','ON_ERROR_STOP=1','-c','DROP SCHEMA public CASCADE; CREATE SCHEMA public;'],{timeout:30000,maxBuffer:1024*1024});
    await docker('/usr/bin/docker',['exec',databaseContainer,'pg_restore','-U','load','-d','load','--no-owner','--no-acl','--exit-on-error','/tmp/'+name+'.dump'],{timeout:240000,maxBuffer:1024*1024});
    return {elapsedSeconds:(performance.now()-began)/1000};
  }
  async function immutableFinancial(){return (await sql.query('SELECT id,settlement_tx_hash,charged,refund,receipt FROM jobs WHERE receipt IS NOT NULL ORDER BY id')).rows}
  async function journals(){return (await sql.query('SELECT run_id,hash,raw,nonce FROM transaction_journal ORDER BY run_id')).rows}
  try {
    phase('fund_nine_independent_local_accounts');
    for(const client of funded){
      await test.setBalance({address:client.account.address,value:parseEther('10')});
      await receipt(await wallet.writeContract({address:token,abi:tokenArtifact.abi,functionName:'faucet',args:[client.account.address,funding]}));
      const user=createWalletClient({account:client.account,chain:wallet.chain,transport:http(direct.transport.url,{retryCount:0})});
      await receipt(await user.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[escrow,funding]}));
      await receipt(await user.writeContract({address:escrow,abi:escrowAbi,functionName:'deposit',args:[funding]}));
      const leash=await call(client,'/api/leashes','POST',{maxPerHour:'1000000',maxPerDay:'10000000',expiry:Math.floor(Date.now()/1000)+86400});check(leash.response.status===201,'Leash');await send(client,leash.data.transaction);budgets.push(leash.data.leashId);
    }
    phase('queue_global_saturation');
    await stop();await start({paused:true});
    const spare=await quote(funded[8],jobInput(budgets[8]));
    const spareReservation=await open(funded[8],spare);
    // An old prepared row no longer occupies admission capacity; chain quote is still valid.
    await sql.query("UPDATE jobs SET created_at=now()-interval '6 minutes' WHERE id=$1",[spare.quote.runId]);
    const pending=[];
    // Equal creation timestamps deliberately stress FIFO tie handling across tenants.
    for(let owner=0;owner<8;owner++)for(let j=0;j<8;j++)pending.push({client:funded[owner],q:await quote(funded[owner],jobInput(budgets[owner],j===0?2000000:250000,j===0?20:10))});
    const overflow=await call(funded[8],'/api/quotes','POST',jobInput(budgets[8]),{'idempotency-key':randomUUID()});check(overflow.response.status===429&&overflow.data.title==='compute_capacity','Global quote backpressure');
    for(const p of pending)p.reservation=await open(p.client,p.q);
    const admissions=await Promise.all(pending.map(p=>admit(p.client,p.reservation)));check(admissions.every(r=>r.response.status===202),'Funded global queue admission');
    check((await sql.query("SELECT count(*)::int AS n FROM jobs WHERE status='queued'")).rows[0].n===64,'Exactly 64 queued jobs');
    const full=await admit(funded[8],spareReservation);check(full.response.status===429&&full.data.title==='compute_capacity','Already-paid reservation rejected safely at full capacity');
    check((await row(spare.quote.runId)).status==='prepared','Full queue changed paid reservation');
    const chainSpare=await direct.readContract({address:escrow,abi:escrowAbi,functionName:'getRun',args:[spare.quote.runId]});check(chainSpare.status===1,'Full queue lost on-chain reservation');
    const burst=[];
    await Promise.all(clients.map(async(client,i)=>{for(let j=0;j<10;j++){const at=performance.now(),r=await call(client,'/api/workspace');check(r.response.status===200&&r.data.document.budget===i+1,'Workspace under full queue');burst.push(performance.now()-at)}}));
    burst.sort((a,b)=>a-b);check(burst[Math.floor(burst.length*.95)]<2000,'Full queue API latency');
    // Cancel one task still waiting; its reservation is returned when the worker drains it.
    const cancelled=pending[1];const stopIntent=await call(cancelled.client,'/api/runs/'+cancelled.reservation.runId+'/stop','POST',{});check(stopIntent.response.status===200,'Queued stop intent');await send(cancelled.client,stopIntent.data.transaction);
    phase('drain_saturated_paid_queue');const drainStart=performance.now();await stop();await start();
    let maxRunning=0,samples=0,healthyReads=0;const queuedOrder=pending.map(p=>p.reservation.runId);
    for(let tick=0;tick<1800;tick++){
      const state=(await sql.query('SELECT id,status FROM jobs WHERE id=ANY($1::text[])',[queuedOrder])).rows;
      const active=state.filter(j=>j.status==='running').length;maxRunning=Math.max(maxRunning,active);check(active<=1,'More than one CPU worker active');
      if(tick%8===0){const r=await call(clients[20],'/api/workspace');check(r.response.status===200,'Reads blocked by CPU queue');healthyReads++}samples++;
      if(state.every(j=>['completed','cancelled','timed_out'].includes(j.status)))break;
      await delay(250);
    }
    for(const p of pending){const job=await completed(p.client,p.reservation.runId,1);check(job.status===(p===cancelled?'cancelled':'completed'),'Unexpected queued job outcome');await verify(p.client,job)}
    check((await completed(cancelled.client,cancelled.reservation.runId,1)).charged==='0','Queued cancellation charged CPU');
    const recovered=await admit(funded[8],spareReservation);check(recovered.response.status===202,'Paid admission retry after drain');
    const spareDone=await completed(funded[8],spare.quote.runId);check(spareDone.status==='completed','Recovered paid reservation');await verify(funded[8],spareDone);
    const replay=await admit(funded[8],spareReservation);check(replay.data.settlementTxHash===spareDone.settlementTxHash,'Duplicate paid admission changed receipt');
    outcome.queue={passed:true,fundedOwners:9,queued:64,quotesAtCapacityStatus:overflow.response.status,paidAdmissionAtCapacityStatus:full.response.status,
      resumedSameReservationWithoutSecondPayment:true,queuedCancellationCharge:'0',canonicalReceipts:65,maxRunning,samples,healthyReads,
      fullQueueReadRequests:burst.length,fullQueueReadP95Ms:burst[Math.floor(burst.length*.95)],drainElapsedSeconds:(performance.now()-drainStart)/1000,chargedAtomicTestTokens:await conservation()};
    check(maxRunning===1,'No genuine active CPU observed');

    phase('release_rollback_preserving_new_writes');
    await stop();
    const releases={};
    for(const name of ['a','b']){
      const root=WORK+'/release-'+name;await cp(BASE+'/app/dist',root+'/dist',{recursive:true});await symlink(BASE+'/app/node_modules',root+'/node_modules','dir');
      const path=root+'/dist/src/main.js',original=await readFile(path,'utf8');
      const next=original.replace('fetch: app.fetch,',`fetch: request => new URL(request.url).pathname === '/api/acceptance-release' ? new Response(JSON.stringify({release:'${name}'}), {headers:{'content-type':'application/json'}}) : app.fetch(request),`);
      check(next!==original,'Release marker injection');await writeFile(path,next);releases[name]={root,sha256:createHash('sha256').update(next).digest('hex')};
    }
    check(releases.a.sha256!==releases.b.sha256,'Two distinct fixture releases');
    await start({release:releases.a.root});check((await call(clients[0],'/api/acceptance-release')).data.release==='a','Release A');await stop();
    // A representative compatible additive migration; arbitrary destructive migrations require their own rehearsal.
    await sql.query('ALTER TABLE workspace_documents ADD COLUMN release_probe text');
    await start({release:releases.b.root});check((await call(clients[0],'/api/acceptance-release')).data.release==='b','Release B');
    const before=await call(clients[0],'/api/workspace');const document={...before.data.document,budget:777};
    check((await call(clients[0],'/api/workspace','PUT',{revision:before.data.revision,document})).response.status===200,'Release B write');
    await sql.query("UPDATE workspace_documents SET release_probe='candidate-write' WHERE owner=$1",[clients[0].account.address.toLowerCase()]);
    const newQuote=await quote(funded[0],jobInput(budgets[0],500000));const newReservation=await open(funded[0],newQuote);check((await admit(funded[0],newReservation)).response.status===202,'Candidate paid job');
    const newJob=await completed(funded[0],newReservation.runId);check(newJob.status==='completed','Candidate job outcome');await verify(funded[0],newJob);
    const retainedFinancial=JSON.stringify(await immutableFinancial()),retainedJournals=JSON.stringify(await journals());
    const nonceBeforeRollback=await direct.getTransactionCount({address:accounts.signer.address});
    await stop();await start({release:releases.a.root});
    const rolled=await call(clients[0],'/api/workspace');check(rolled.response.status===200&&rolled.data.document.budget===777,'Rollback lost newer Workspace write');
    check((await sql.query('SELECT release_probe FROM workspace_documents WHERE owner=$1',[clients[0].account.address.toLowerCase()])).rows[0].release_probe==='candidate-write','Rollback removed additive data');
    check(JSON.stringify(await immutableFinancial())===retainedFinancial&&JSON.stringify(await journals())===retainedJournals,'Rollback altered financial records');
    await verify(funded[0],await completed(funded[0],newReservation.runId,1));
    check(await direct.getTransactionCount({address:accounts.signer.address})===nonceBeforeRollback,'Rollback broadcast a second settlement');
    outcome.rollback={passed:true,fixtureReleaseHashes:[releases.a.sha256,releases.b.sha256],compatibleAdditiveMigration:true,newerWorkspaceAndFinancialRecordsRetained:true,settlementNonceUnchanged:true};

    phase('snapshot_before_settlement_broadcast');
    await stop();await start({paused:true});setBroadcastHold(true);
    const lagQuote=await quote(funded[0],jobInput(budgets[0],500000));const lagReservation=await open(funded[0],lagQuote); // owner transactions bypass held controller RPC
    check((await admit(funded[0],lagReservation)).response.status===202,'Lag fixture admission');
    getPilot().child.send({drain:true});
    let saved;
    for(let i=0;i<200;i++){saved=(await sql.query('SELECT * FROM transaction_journal WHERE run_id=$1',[lagReservation.runId])).rows[0];if(saved)break;await delay(100)}
    check(saved&&(await row(lagReservation.runId)).status==='settling','Durable pre-broadcast snapshot point');
    // Kill only this fixture child after the durable signed journal is present.
    getPilot().child.kill('SIGKILL');await getPilot().exit;
    const staleDump=await dump('stale');
    await start({paused:true});
    const absentQuote=await quote(funded[8],jobInput(budgets[8]));const absentReservation=await open(funded[8],absentQuote);
    await stop();
    const nonceBefore=await direct.getTransactionCount({address:accounts.signer.address});
    await receipt(await direct.sendRawTransaction({serializedTransaction:saved.raw}));
    const canonical=await direct.readContract({address:escrow,abi:escrowAbi,functionName:'getRun',args:[lagReservation.runId]});check(canonical.status===2,'Canonical settlement after snapshot');
    const nonceAfter=await direct.getTransactionCount({address:accounts.signer.address});check(nonceAfter===nonceBefore+1,'One canonical settlement');
    await restore('stale');check((await row(lagReservation.runId)).status==='settling','Stale snapshot did not restore pending status');
    const retained=(await sql.query('SELECT * FROM transaction_journal WHERE run_id=$1',[lagReservation.runId])).rows[0];check(retained.raw===saved.raw&&retained.hash===saved.hash,'Restored journal bytes changed');
    setBroadcastHold(false);await start();
    const reconciled=await completed(funded[0],lagReservation.runId);check(reconciled.status==='completed'&&reconciled.settlementTxHash===saved.hash,'Canonical mined outcome not recovered');await verify(funded[0],reconciled);
    check(await direct.getTransactionCount({address:accounts.signer.address})===nonceAfter,'Stale restore charged twice');
    const absentAdmission=await admit(funded[8],absentReservation);check(absentAdmission.response.status===404,'Missing post-snapshot job must fail closed');
    const missed=await direct.readContract({address:escrow,abi:escrowAbi,functionName:'getRun',args:[absentReservation.runId]});check(missed.status===1,'Missing database reservation lost');
    const refundAt=await direct.readContract({address:escrow,abi:escrowAbi,functionName:'refundAt',args:[absentReservation.runId]});
    await test.setNextBlockTimestamp({timestamp:refundAt+1n});await test.mine({blocks:1});
    await send(funded[8],{to:escrow,data:c.encodeFunctionData({abi:escrowAbi,functionName:'refundRun',args:[absentReservation.runId]})});
    check((await direct.readContract({address:escrow,abi:escrowAbi,functionName:'getRun',args:[absentReservation.runId]})).status===3,'Missing-row timeout refund');
    const knownCharge=await conservation();
    outcome.staleRestore={passed:true,snapshot:staleDump,restoredExactJournalBytes:true,chainAheadByOneSettlement:true,canonicalReceiptRecovered:true,noSecondBroadcastNonce:true,
      missingPostSnapshotRowStatus:404,missingRowReservationRefundedByOwnerOnLocalChain:true,automaticMissingRowReconstruction:false,chargedAtomicTestTokens:knownCharge};

    phase('large_database_seed');await stop();
    // Expired unpaid historical quotes. They are synthetic records, never receipts or claimed real payments.
    const beganSeed=performance.now();
    await sql.query(`INSERT INTO jobs(id,owner,leash_id,idem_key,input_hash,input,quote,signature,ceiling,status,created_at,updated_at)
      SELECT '0x'||md5('load-'||i)||md5('quote-'||i),
        CASE WHEN i<=25000 THEN $2 ELSE '0x'||substr(md5('owner-'||(i%1000)),1,32)||'12345678' END,
        j.leash_id,'historical-'||i,j.input_hash,j.input,
        j.quote || jsonb_build_object('runId','0x'||md5('load-'||i)||md5('quote-'||i),'quoteExpiry',1),j.signature,j.ceiling,'prepared',
        now()-interval '2 days'-(i||' milliseconds')::interval,now()-interval '2 days'
      FROM generate_series(1,250000) i CROSS JOIN jobs j WHERE j.id=$1`,[lagReservation.runId,clients[0].account.address.toLowerCase()]);
    await sql.query(`INSERT INTO workspace_documents(owner,revision,document)
      SELECT '0x'||substr(md5('workspace-'||i),1,32)||'12345678',1,$1::jsonb FROM generate_series(1,50000) i`,[JSON.stringify(rolled.data.document)]);
    await sql.query(`INSERT INTO auth_sessions(hash,address,expires_at)
      SELECT md5('session-'||i)||md5('token-'||i),'0x'||substr(md5('user-'||i),1,32)||'12345678',now()+interval '1 hour' FROM generate_series(1,100000) i`);
    await sql.query('ANALYZE');
    const databaseBytes=Number((await sql.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
    const tableCounts=(await sql.query("SELECT 'jobs' AS name,count(*)::int AS rows FROM jobs UNION ALL SELECT 'workspace_documents',count(*)::int FROM workspace_documents UNION ALL SELECT 'auth_sessions',count(*)::int FROM auth_sessions")).rows;
    outcome.largeDatabase={synthetic:true,historicalRows:400000,databaseBytes,seedSeconds:(performance.now()-beganSeed)/1000,tableCounts};
    phase('large_database_queries');await start();
    const latencies=[];
    for(let i=0;i<30;i++){const at=performance.now(),r=await call(clients[0],i%2?'/api/runs':'/api/workspace');check(r.response.status===200,'Large database API');latencies.push(performance.now()-at)}
    latencies.sort((a,b)=>a-b);check(latencies[Math.floor(latencies.length*.95)]<2000,'Large database API p95');
    const largeQuote=await quote(funded[0],jobInput(budgets[0]));const largeReservation=await open(funded[0],largeQuote);check((await admit(funded[0],largeReservation)).response.status===202,'Large database paid admission');
    const largeJob=await completed(funded[0],largeReservation.runId);check(largeJob.status==='completed','Large database CPU completion');await verify(funded[0],largeJob);await conservation();
    await stop();phase('large_database_consistent_snapshot');
    const {fingerprints}=await import('./table-fingerprints.mjs');
    const startFingerprint=performance.now();await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const beforeHashes=await fingerprints(sql);const snapshot=(await sql.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    await docker('/usr/bin/docker',['exec',databaseContainer,'pg_dump','-U','load','-d','load','-Fc','--snapshot',snapshot,'-f','/tmp/large.dump'],{timeout:180000,maxBuffer:1024*1024});
    await sql.query('ROLLBACK');const snapshotSeconds=(performance.now()-startFingerprint)/1000;
    await writeFile(WORK+'/large-fingerprints.json',JSON.stringify({fingerprints:beforeHashes},null,2)+'\n');
    await docker('/usr/bin/docker',['cp',databaseContainer+':/tmp/large.dump',WORK+'/large.dump'],{timeout:30000,maxBuffer:1024*1024});
    const archiveBytes=Number((await docker('/usr/bin/docker',['exec',databaseContainer,'stat','-c','%s','/tmp/large.dump'])).stdout.trim());
    const restoreStats=await restore('large');
    await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const afterHashes=await fingerprints(sql);await sql.query('ROLLBACK');
    check(JSON.stringify(beforeHashes)===JSON.stringify(afterHashes),'Large database restore row fingerprints differ');
    phase('large_database_boot_after_restore');await start();const reread=await call(clients[0],'/api/workspace');check(reread.data.document.budget===777,'Large restore lost current workspace');
    const finalJob=await completed(funded[0],largeReservation.runId,1);await verify(funded[0],finalJob);await conservation();
    outcome.largeDatabase={...outcome.largeDatabase,passed:true,requests:latencies.length,p95Ms:latencies[Math.floor(latencies.length*.95)],paidCpuWithCanonicalReceipt:true,
      tablesVerified:afterHashes.length,totalRowsVerified:afterHashes.reduce((n,t)=>n+t.rows,0),snapshotSeconds,archiveBytes,restoreSeconds:restoreStats.elapsedSeconds,
      allTableHashesMatch:true,restoredApplicationRead:true,peakHarnessRssBytes:process.resourceUsage().maxRSS*1024};
    phase('completed');return outcome;
  } finally {setBroadcastHold(false);await sql.end()}
}
