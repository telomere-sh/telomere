// Hold one PostgreSQL snapshot for pg_dump and every table fingerprint.
import {readFile} from 'node:fs/promises';
import {fingerprints as tableFingerprints} from './table-fingerprints.mjs';
import {createInterface} from 'node:readline';
import {parseProfile} from '/opt/telomere-mainnet-pilot/app/dist/src/operator/profile.js';
import {createPublicClient,http} from '/opt/telomere-mainnet-pilot/app/node_modules/viem/_esm/index.js';
import pg from '/opt/telomere-mainnet-pilot/app/node_modules/pg/lib/index.js';
const env=parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8'));
const c=new pg.Client({connectionString:env.DATABASE_URL});await c.connect();
try{
  // Observe chain before the database snapshot, so a recovery scan overlaps the
  // snapshot boundary. RPC failure must not prevent an otherwise valid DB backup.
  let chainCursor=null;
  try {
    const client=createPublicClient({transport:http(env.RPC_URL,{retryCount:0,timeout:3000}),cacheTime:0});
    const chainId=await client.getChainId(),block=await client.getBlock();
    if(chainId===Number(env.CHAIN_ID)&&block.number!==null&&block.hash)chainCursor={chainId,escrow:env.ESCROW_ADDRESS,blockNumber:block.number.toString(),blockHash:block.hash};
  }catch{}
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await c.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const fingerprints=await tableFingerprints(c);
  const references=(await c.query('SELECT owner,sha256,ciphertext_bytes,state FROM cysts')).rows;
  process.stdout.write(JSON.stringify({snapshot,fingerprints,references,chainCursor})+'\n');
  for await(const line of createInterface({input:process.stdin})){if(line==='done')break}
  await c.query('ROLLBACK');
}finally{await c.end()}
