// Hold one PostgreSQL snapshot for pg_dump and every table fingerprint.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {parseProfile} from '/opt/telomere-mainnet-pilot/app/dist/src/operator/profile.js';
import pg from '/opt/telomere-mainnet-pilot/app/node_modules/pg/lib/index.js';
const env=parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8'));
const c=new pg.Client({connectionString:env.DATABASE_URL});await c.connect();
try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await c.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const fingerprints=[];
  for(const {tablename:name} of tables){
    if(!/^[a-z][a-z0-9_]*$/.test(name))throw Error('Unreviewed table identifier');
    const rows=(await c.query('SELECT to_jsonb(t)::text AS row FROM public."'+name+'" t ORDER BY to_jsonb(t)::text')).rows;
    const h=createHash('sha256');for(const row of rows)h.update(row.row+'\n');
    fingerprints.push({table:name,rows:rows.length,sha256:h.digest('hex')});
  }
  const references=(await c.query('SELECT owner,sha256,ciphertext_bytes,state FROM cysts')).rows;
  process.stdout.write(JSON.stringify({snapshot,fingerprints,references})+'\n');
  for await(const line of createInterface({input:process.stdin})){if(line==='done')break}
  await c.query('ROLLBACK');
}finally{await c.end()}
