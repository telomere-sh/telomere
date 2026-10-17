// Private observer only. No settlement, signing, admission or mutation methods.
import {readFile} from 'node:fs/promises';
import {parseProfile} from '/opt/telomere-mainnet-pilot/app/dist/src/operator/profile.js';
import {loadConfig} from '/opt/telomere-mainnet-pilot/app/dist/src/config.js';
import {ChainBridge} from '/opt/telomere-mainnet-pilot/app/dist/src/bridge.js';
import pg from '/opt/telomere-mainnet-pilot/app/node_modules/pg/lib/index.js';
import {drizzle} from '/opt/telomere-mainnet-pilot/app/node_modules/drizzle-orm/node-postgres/index.js';
const cfg=loadConfig(parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8')));
const c=new pg.Client({connectionString:cfg.DATABASE_URL});await c.connect();
try{
  const states=(await c.query("SELECT status,count(*)::integer AS count,coalesce(max(extract(epoch FROM now()-updated_at)),0)::integer AS oldest_seconds FROM jobs GROUP BY status")).rows;
  const invalid=(await c.query("SELECT count(*)::integer AS count FROM jobs WHERE status IN ('completed','failed','cancelled','timed_out','refunded') AND (charged IS NULL OR refund IS NULL OR charged::numeric+refund::numeric<>ceiling::numeric OR charged::numeric<0 OR refund::numeric<0)")).rows[0].count;
  const settlementJournalRows=(await c.query('SELECT count(*)::integer AS count FROM transaction_journal')).rows[0].count;
  const bridge=new ChainBridge(cfg);let rpc;
  try{await bridge.check();rpc={available:true,operatorGasWei:String(await bridge.public.getBalance({address:bridge.account.address}))}}
  catch(error){rpc={available:false,errorType:error.name}}
  let journalArchive;
  if(typeof bridge.journalArchiveStatus==='function'){
    try{journalArchive={supported:true,...await bridge.journalArchiveStatus(drizzle(c,{casing:'snake_case'}))}}
    catch(error){journalArchive={supported:true,latestCheckpointVerified:false,errorType:error.name}}
  }
  process.stdout.write(JSON.stringify({databaseAvailable:true,states,invalidFinancialRows:invalid,settlementJournalRows,rpc,...(journalArchive?{journalArchive}:{})})+'\n');
}finally{await c.end()}
