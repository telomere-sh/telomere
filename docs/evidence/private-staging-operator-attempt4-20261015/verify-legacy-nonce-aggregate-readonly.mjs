
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const release='/opt/telomere-pilot/releases/354fe7af62ea6701faafc3b04522abb1b4524d2d-launch03';
const {parseProfile}=await import(release+'/dist/src/operator/profile.js');
const {loadConfig}=await import(release+'/dist/src/config.js');
const require=createRequire(release+'/package.json');
const {Client}=require('pg');
let client;
try {
 const env=parseProfile(await readFile('/opt/telomere-pilot/config/staging.env','utf8'));
 const config=loadConfig(env);
 if(config.MODE!=='demo'||config.CHAIN_ID!==31337) throw new Error('profile_scope');
 client=new Client({connectionString:config.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:5000});
 await client.connect(); await client.query('BEGIN READ ONLY');
 const columns=(await client.query("SELECT udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='transaction_journal' AND column_name='nonce' LIMIT 2")).rows;
 if(columns.length!==1||!['int4','int8'].includes(columns[0].udt_name)) throw new Error('nonce_schema');
 const row=(await client.query('SELECT count(*)::integer AS total,count(nonce)::integer AS present,count(*) FILTER (WHERE nonce IS NULL)::integer AS missing FROM transaction_journal')).rows[0];
 await client.query('ROLLBACK');
 console.log(JSON.stringify({schemaVersion:1,kind:'readonly_legacy_transaction_nonce_aggregate',result:'verified',columnPresent:true,typeInt4:columns[0].udt_name==='int4',typeInt8:columns[0].udt_name==='int8',total:row.total,nonNull:row.present,null:row.missing,allFiveOriginalNonNull:row.total===5&&row.present===5&&row.missing===0,rowsOrCredentialsReturned:false,readOnlyTransaction:true}));
} catch { console.log(JSON.stringify({result:'refused',reason:'readonly_nonce_aggregate_failed'}));process.exitCode=1; }
finally { await client?.end().catch(()=>undefined); }
