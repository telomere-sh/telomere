// Read-only financial checkpoint for a controlled backend release.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseProfile} from '/opt/telomere-mainnet-pilot/app/dist/src/operator/profile.js';
import {loadConfig} from '/opt/telomere-mainnet-pilot/app/dist/src/config.js';
import {ChainBridge} from '/opt/telomere-mainnet-pilot/app/dist/src/bridge.js';
import {tokenAbi} from '/opt/telomere-mainnet-pilot/app/dist/src/chain/abi.js';
import pg from '/opt/telomere-mainnet-pilot/app/node_modules/pg/lib/index.js';
const config=loadConfig(parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8'))),bridge=new ChainBridge(config);
await bridge.check();
const connection=new pg.Client({connectionString:config.DATABASE_URL});await connection.connect();
try{
  await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const count=(await connection.query('SELECT count(*)::text AS n FROM transaction_journal')).rows[0].n;
  // This audit is for the small current production snapshot. Never materialize
  // arbitrary future history here; the operational backup has a cursor verifier.
  if(BigInt(count)>256n)throw Error('Use the streaming backup verifier for this history');
  const rows=(await connection.query('SELECT run_id,raw,hash,nonce,extract(epoch FROM created_at)::text AS created_epoch FROM transaction_journal ORDER BY run_id')).rows;
  const states=(await connection.query('SELECT status,count(*)::integer AS count FROM jobs GROUP BY status ORDER BY status')).rows;
  await connection.query('COMMIT');
  const owner='0xA67c6a174409B9b44e67D24cdd386a31D44Edb1d';
  const balance=async address=>String(await bridge.public.readContract({address:config.TOKEN_ADDRESS,abi:tokenAbi,functionName:'balanceOf',args:[address]}));
  process.stdout.write(JSON.stringify({readOnly:true,observedAt:new Date().toISOString(),chainId:config.CHAIN_ID,journalRows:count,
    originalJournalSha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),states,
    signerNonce:await bridge.public.getTransactionCount({address:bridge.account.address,blockTag:'latest'}),
    operatorEthWei:String(await bridge.public.getBalance({address:bridge.account.address})),ownerUsdcAtomic:await balance(owner),
    escrowUsdcAtomic:await balance(config.ESCROW_ADDRESS),ownerAvailableUsdcAtomic:(await bridge.balance(owner)).available,broadcast:false})+'\n');
}finally{await connection.end()}
