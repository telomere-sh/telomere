// Operator command: point at snapshot.json from a verified/decrypted backup and
// configure the restored scratch database in TELOMERE_RECOVERY_DATABASE_URL.
import {readFile} from 'node:fs/promises';
import pg from '/opt/telomere-mainnet-pilot/app/node_modules/pg/lib/index.js';
import {createPublicClient,http} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/index.js';
import {escrowAbi} from '/opt/telomere-mainnet-pilot/app/dist/src/chain/abi.js';
import {auditOpenedReservations} from './chain-recovery-audit.mjs';

let database;
try {
  if(process.argv.length!==3)throw Error('One verified snapshot.json path is required');
  const snapshot=JSON.parse(await readFile(process.argv[2],'utf8'));
  const cursor=snapshot.chainCursor;
  if(cursor?.chainId!==8453)throw Error('A Base mainnet snapshot cursor is required');
  const connection=process.env.TELOMERE_RECOVERY_DATABASE_URL;
  if(!connection||!/^postgresql:\/\//.test(connection))throw Error('An explicit restored database URL is required');
  const rpc=process.env.TELOMERE_RECOVERY_RPC_URL;
  if(!rpc||!/^https?:\/\//.test(rpc))throw Error('An explicit read-only RPC URL is required');
  database=new pg.Client({connectionString:connection,statement_timeout:30000});await database.connect();
  await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const client=createPublicClient({transport:http(rpc,{retryCount:0,timeout:10000}),cacheTime:0});
  const result=await auditOpenedReservations({client,address:cursor.escrow,abi:escrowAbi,cursor,
    hasKnownId:async id=>(await database.query('SELECT id FROM jobs WHERE id=$1 LIMIT 1',[id])).rows.length===1});
  await database.query('ROLLBACK');process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.requiresOperatorReconciliation)process.exitCode=2;
}catch(error){process.stdout.write(JSON.stringify({passed:false,errorType:error.name,transactionsSubmitted:0})+'\n');process.exitCode=1}
finally{await database?.end()}
