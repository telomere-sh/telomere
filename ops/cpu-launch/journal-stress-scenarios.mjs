import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fingerprints} from './table-fingerprints.mjs';
export async function archiveScenarios(c){
  const {APP,WORK,HISTORY=10000,check,settings,seedSummary,seedLeash,observer:db,archiveStatus,clients,accounts,wallet,chain,direct,test,
    token,escrow,tokenAbi,escrowAbi,tokenArtifact,call,docker,databaseContainer,faults,application,getPilot,setPilot}=c;
  // Anvil can acknowledge a send before its automined receipt is visible. Poll
  // that receipt directly; block-watcher polling can exhaust a five-minute quote.
  async function receipt(hash){for(let attempt=0;attempt<500;attempt++){
    try{const value=await direct.getTransactionReceipt({hash});check(value.status==='success','Local payment reverted');return value}
    catch(error){if(error.name!=='TransactionReceiptNotFoundError')throw error;await delay(10)}
  }throw Error('Automined payment receipt deadline')}
  const {createWalletClient,http,parseEther}=await import(APP+'/node_modules/viem/_esm/index.js');
  const {hashJson}=await import(APP+'/dist/src/common.js');
  const phase=name=>process.stdout.write(JSON.stringify({phase:name,observedAt:new Date().toISOString()})+'\n');
  const stop=()=>getPilot().close();
  async function start(paused=true){const began=performance.now();setPilot(await application({paused}));return (performance.now()-began)/1000}
  async function drain(expectFailure=false,retry){const child=getPilot().child;await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.off('message',listen);reject(Error('Manual fixture drain deadline'))},60000);
    function listen(message){if(message.drained){clearTimeout(timer);child.off('message',listen);Boolean(message.failed)===expectFailure?resolve():reject(Error('Unexpected fixture drain outcome'))}else if(message.ready===false){clearTimeout(timer);child.off('message',listen);reject(Error('Fixture drain failed'))}}
    child.on('message',listen);child.send(retry?{retry}:{drain:true});
  })}
  const row=async id=>(await db.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
  const input=id=>({leashId:id,task:{kind:'hash_chain',text:'archive-queue',iterations:250000},maxSeconds:10});
  const send=async(client,tx)=>receipt(await createWalletClient({chain,account:client.account,transport:http(direct.transport.url,{retryCount:0})}).sendTransaction({to:tx.to,data:tx.data,value:0n}));
  async function quote(client,leash){const value=await call(client,'/api/quotes','POST',input(leash),{'idempotency-key':randomUUID()});check(value.response.status===201,'Paid quote '+value.response.status);return value.data}
  async function open(client,q){const value=await send(client,q.transaction);return {runId:q.quote.runId,txHash:value.transactionHash}}
  const admit=(client,reservation)=>call(client,'/api/runs','POST',reservation);
  async function journalHash(){
    const hash=createHash('sha256');let rows=0;await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try{await db.query('DECLARE originals NO SCROLL CURSOR FOR SELECT run_id,raw,hash,nonce,extract(epoch FROM created_at)::text AS created_epoch FROM transaction_journal WHERE nonce<$1 ORDER BY run_id',[HISTORY]);
      for(;;){const page=(await db.query('FETCH FORWARD 128 FROM originals')).rows;if(!page.length)break;for(const row of page){hash.update(JSON.stringify(row)+'\n');rows++}}
      await db.query('CLOSE originals');await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error}
    check(rows===HISTORY,'Original history row count');return hash.digest('hex');
  }
  async function verify(client,job){const value=await call(client,'/api/receipts/verify','POST',{receipt:job.receipt});check(value.data.valid&&value.data.anchored,'Canonical financial receipt')}
  const retained=await journalHash(),result={history:{...seedSummary,originalJournalSha256:retained}};
  phase('large_history_fresh_start');await stop();result.history.freshBootSeconds=await start();
  const memory=(await import('node:fs/promises')).readFile;
  const rss=await memory('/proc/'+getPilot().child.pid+'/status','utf8');result.history.freshWorkerRssKiB=Number(rss.match(/VmRSS:\s+(\d+)/)[1]);
  result.history.freshWorkerPeakRssKiB=Number(rss.match(/VmHWM:\s+(\d+)/)[1]);
  check(result.history.freshWorkerRssKiB<768*1024,'Large-history worker memory');
  check(result.history.freshWorkerPeakRssKiB<768*1024,'Large-history startup peak memory');
  phase('fund_nine_owners_and_fill_64_paid_slots');
  const owners=clients.slice(0,9),leashes=[seedLeash];
  for(let i=1;i<owners.length;i++){
    const client=owners[i];await test.setBalance({address:client.account.address,value:parseEther('10')});
    await receipt(await wallet.writeContract({address:token,abi:tokenArtifact.abi,functionName:'faucet',args:[client.account.address,1000000n]}));
    const owner=createWalletClient({chain,account:client.account,transport:http(direct.transport.url,{retryCount:0})});
    await receipt(await owner.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[escrow,1000000n]}));
    await receipt(await owner.writeContract({address:escrow,abi:escrowAbi,functionName:'deposit',args:[1000000n]}));
    const leash=hashJson({owner:client.account.address,fixture:'archive-queue'});leashes.push(leash);
    await receipt(await owner.writeContract({address:escrow,abi:escrowAbi,functionName:'createLeash',args:[leash,client.account.address,1000000n,10000000n,BigInt(Math.floor(Date.now()/1000)+86400)]}));
  }
  const spare=await quote(owners[8],leashes[8]),spareReservation=await open(owners[8],spare);
  await db.query("UPDATE jobs SET created_at=now()-interval '6 minutes' WHERE id=$1",[spare.quote.runId]);
  const pending=[];
  for(let i=0;i<8;i++){
    for(let j=0;j<8;j++){const q=await quote(owners[i],leashes[i]);pending.push({client:owners[i],q})}
    if(i===0)check((await call(owners[0],'/api/quotes','POST',input(leashes[0]),{'idempotency-key':randomUUID()})).response.status===429,'Per-owner backpressure');
  }
  check((await call(owners[8],'/api/quotes','POST',input(leashes[8]),{'idempotency-key':randomUUID()})).response.status===429,'Global quote backpressure');
  for(const value of pending){value.reservation=await open(value.client,value.q);check((await admit(value.client,value.reservation)).response.status===202,'Queue admission')}
  check((await db.query("SELECT count(*)::int AS n FROM jobs WHERE status='queued'")).rows[0].n===64,'Queue is not full');
  check((await admit(owners[8],spareReservation)).response.status===429,'Paid overflow admission');
  phase('finalized_rpc_failure_during_automatic_archive');
  const before=await archiveStatus(),nonceBefore=await direct.getTransactionCount({address:accounts.signer.address});
  faults.state.failFinalized=true;await drain(true);faults.state.failFinalized=false;
  const waiting=(await db.query("SELECT * FROM jobs WHERE status='settling' ORDER BY created_at,id LIMIT 1")).rows[0];
  check(waiting&&waiting.cpu_result,'Durable CPU result after archive outage');const cpu=JSON.stringify(waiting.cpu_result);
  check(JSON.stringify(await archiveStatus())===JSON.stringify(before),'Finality outage changed checkpoint/journal');
  check(faults.stats.finalityFailures>0,'Finality fault was not reached');
  phase('receipt_rpc_failure_during_automatic_archive');faults.state.failReceipt=true;await drain(true,waiting.id);faults.state.failReceipt=false;
  check(JSON.stringify((await row(waiting.id)).cpu_result)===cpu&&JSON.stringify(await archiveStatus())===JSON.stringify(before),'Receipt outage altered original result/history');
  check(faults.stats.receiptFailures>0&&await direct.getTransactionCount({address:accounts.signer.address})===nonceBefore,'Receipt outage sent a transaction');
  phase('recover_after_broadcast_acknowledgement_loss');faults.state.dropSendReply=true;await drain(false,waiting.id);
  const first=await row(waiting.id);check(first.status==='completed'&&JSON.stringify(first.cpu_result)===cpu,'Recovery repeated or lost CPU result');
  check(faults.stats.droppedAcknowledgements===1&&await direct.getTransactionCount({address:accounts.signer.address})===nonceBefore+1,'Ambiguous broadcast repeated settlement');
  check((await archiveStatus()).archivedRows===before.archivedRows+8,'Automatic archive did not commit its batch');
  phase('full_rpc_outage_keeps_paid_reservation');faults.state.offline=true;
  // The server's confirmed-receipt wait is bounded to 15 seconds. Give this
  // intentional outage probe enough time to observe its final HTTP response.
  const outageResponse=await fetch(settings.PUBLIC_ORIGIN+'/api/runs',{method:'POST',headers:{origin:settings.PUBLIC_ORIGIN,
    'content-type':'application/json',cookie:owners[8].cookie,'x-real-ip':owners[8].ip},body:JSON.stringify(spareReservation),signal:AbortSignal.timeout(30000)});
  const outage={response:outageResponse,data:await outageResponse.json()};check(outage.response.status>=500,'Unavailable RPC admission');
  for(let i=0;i<20;i++)check((await call(clients[20],'/api/workspace')).response.status===200,'Workspace during RPC outage');
  check((await row(spare.quote.runId)).status==='prepared','RPC outage consumed reservation');faults.state.offline=false;
  result.rpcFaults={passed:true,finalizedFailures:faults.stats.finalityFailures,receiptFailures:faults.stats.receiptFailures,
    unchangedOriginalCpuResult:true,unchangedHistoryOnFailedArchive:true,acknowledgementLossRecovered:true,oneNewNonce:true,rpcOutageAdmissionStatus:outage.response.status};
  phase('drain_queue_while_archiving_and_rpc_is_delayed');faults.state.delayMs=10;await stop();await start(false);
  check((await admit(owners[8],spareReservation)).response.status===202,'Original paid overflow reservation retry');
  const ids=[...pending.map(value=>value.reservation.runId),spare.quote.runId],latencies=[];let maxRunning=0;
  const began=performance.now();
  for(let i=0;i<2400;i++){
    const rows=(await db.query('SELECT status FROM jobs WHERE id=ANY($1::text[])',[ids])).rows;
    maxRunning=Math.max(maxRunning,rows.filter(value=>value.status==='running').length);check(maxRunning<=1,'Concurrent CPU execution exceeds profile');
    if(i%4===0){const start=performance.now();check((await call(clients[20],'/api/workspace')).response.status===200,'HTTP under archive queue');latencies.push(performance.now()-start)}
    if(rows.every(value=>value.status==='completed'))break;await delay(250);
  }
  faults.state.delayMs=0;
  for(const value of pending){const job=await row(value.reservation.runId);check(job.status==='completed','Queue did not drain');await verify(value.client,job)}
  const spareDone=await row(spare.quote.runId);check(spareDone.status==='completed','Spare reservation did not complete');await verify(owners[8],spareDone);
  check((await admit(owners[8],spareReservation)).data.settlementTxHash===spareDone.settlement_tx_hash,'Repeated admission hash differs');
  let total=0n;
  for(const client of owners){
    const charged=(await db.query("SELECT coalesce(sum(charged::numeric),0)::text AS n FROM jobs WHERE owner=$1 AND status='completed'",[client.account.address.toLowerCase()])).rows[0].n;
    const available=await direct.readContract({address:escrow,abi:escrowAbi,functionName:'availableBalance',args:[client.account.address]});
    check(available+BigInt(charged)===1000000n,'Owner conservation');total+=BigInt(charged);
  }
  check(await direct.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[accounts.treasury.address]})===total,'Treasury conservation');
  check(await direct.getTransactionCount({address:accounts.signer.address})===HISTORY+65,'Queue created an extra settlement nonce');
  check(await journalHash()===retained,'Automatic archive changed original history');latencies.sort((a,b)=>a-b);
  check(latencies[Math.floor(latencies.length*.95)]<2000,'Queue HTTP latency');
  result.queue={passed:true,owners:9,capacity:64,canonicalCpuReceipts:65,maxRunning,delayedRpcMs:10,healthyReads:latencies.length,
    readP95Ms:latencies[Math.floor(latencies.length*.95)],elapsedSeconds:(performance.now()-began)/1000,archive:await archiveStatus(),chargedAtomicTestTokens:String(total),
    exactSettlementNonce:HISTORY+65};
  phase('dump_restore_all_large_history_tables');await stop();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');let beforeTables;
  try{
    const snapshot=(await db.query('SELECT pg_export_snapshot() AS id')).rows[0].id;beforeTables=await fingerprints(db);
    await docker('/usr/bin/docker',['exec',databaseContainer,'pg_dump','-U','load','-d','load','--snapshot',snapshot,'-Fc','-f','/tmp/archive-large.dump'],{timeout:180000});
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error}
  const restoreStarted=performance.now();
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await docker('/usr/bin/docker',['exec',databaseContainer,'pg_restore','-U','load','-d','load','--exit-on-error','--no-owner','--no-acl','/tmp/archive-large.dump'],{timeout:180000});
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const afterTables=await fingerprints(db);await db.query('COMMIT');
  check(JSON.stringify(afterTables)===JSON.stringify(beforeTables),'Restored table fingerprint differs');check(await journalHash()===retained,'Restore lost original signed bytes');
  const nonce=await direct.getTransactionCount({address:accounts.signer.address}),boot=await start();
  const replay=await admit(owners[8],spareReservation);check(replay.data.settlementTxHash===spareDone.settlement_tx_hash,'Restored replay lost transaction hash');
  await verify(owners[8],await row(spare.quote.runId));check(await direct.getTransactionCount({address:accounts.signer.address})===nonce,'Restore repeated settlement');
  result.restore={passed:true,tables:afterTables.length,rows:afterTables.reduce((sum,value)=>sum+value.rows,0),allFingerprintsMatch:true,
    elapsedSeconds:(performance.now()-restoreStarted)/1000,freshBootSeconds:boot,originalJournalBytesRetained:true,noNewNonce:true};
  result.rpcCounters=faults.stats;return result;
}
