// Disposable PostgreSQL only: exercise the frozen Cyst service at its exact byte quota.
import {randomBytes,createHash} from 'node:crypto';
import {writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {openStore} from '/opt/telomere-mainnet-pilot/app/dist/src/store.js';
import {CystService} from '/opt/telomere-mainnet-pilot/app/dist/src/cysts/service.js';
import {encryptCheckpoint,decryptCheckpoint} from '/opt/telomere-mainnet-pilot/app/dist/src/sdk/cysts.js';
import pg from '/opt/telomere-mainnet-pilot/app/node_modules/pg/lib/index.js';
import {fingerprints} from './table-fingerprints.mjs';
const [folder,url]=process.argv.slice(2);
if(!/^\/opt\/telomere-mainnet-pilot\/private\/capacity-fixture-[0-9a-f]{16}$/.test(folder)||!/^postgresql:\/\/fixture@127\.0\.0\.1:[0-9]{1,5}\/fixture$/.test(url))throw Error('Isolated fixture arguments');
const store=await openStore({DATABASE_URL:url,DATA_DIR:folder});const client=new pg.Client({connectionString:url});
const check=(value,message)=>{if(!value)throw Error(message)};
try{
  await client.connect();
  const service=new CystService(store.db,join(folder,'source-cysts'),{globalBytes:1073741824});await service.initialize();
  let saved=0;let last;
  for(let ownerIndex=1;ownerIndex<=32;ownerIndex++){
    const owner='0x'+ownerIndex.toString(16).padStart(40,'0');
    for(let checkpoint=0;checkpoint<16;checkpoint++){
      const plaintext=randomBytes(2*1024**2-16);
      const {envelope,recoveryKey}=await encryptCheckpoint(plaintext,{owner,applicationSchema:'capacity.v1'});
      await service.upload(owner,envelope,'capacity-'+ownerIndex+'-'+checkpoint);
      if(last)last.recoveryKey.fill(0);
      last={envelope,recoveryKey,plaintextHash:createHash('sha256').update(plaintext).digest('hex')};saved++;
    }
    process.stdout.write(JSON.stringify({phase:'cysts',owners:ownerIndex,checkpoints:saved})+'\n');
  }
  const extra=await encryptCheckpoint(new Uint8Array([1]),{owner:'0x'+(33).toString(16).padStart(40,'0'),applicationSchema:'capacity.v1'});
  let rejected=false;
  try{await service.upload(extra.envelope.owner,extra.envelope,'capacity-over-limit')}catch(error){if(error.code==='cyst_global_capacity')rejected=true;else throw error}finally{extra.recoveryKey.fill(0)}
  check(rejected,'Global quota overflow accepted');
  const downloaded=await service.download(last.envelope.owner,last.envelope.id);
  check(createHash('sha256').update(await decryptCheckpoint({...last.envelope,ciphertext:downloaded.ciphertext},last.recoveryKey)).digest('hex')===last.plaintextHash,'Full quota checkpoint readability');
  last.recoveryKey.fill(0);
  await client.query('CREATE TABLE capacity_fixture (id integer PRIMARY KEY, payload bytea NOT NULL)');
  for(let offset=0;offset<3328;offset+=16){
    const values=[],parameters=[];
    for(let i=0;i<16;i++){values.push(offset+i,randomBytes(65536));parameters.push('($'+(2*i+1)+',$'+(2*i+2)+')')}
    await client.query('INSERT INTO capacity_fixture(id,payload) VALUES '+parameters.join(','),values);
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot={fingerprints:await fingerprints(client),references:(await client.query('SELECT owner,sha256,ciphertext_bytes,state FROM cysts ORDER BY owner,id')).rows};
  const total=snapshot.references.reduce((sum,row)=>sum+row.ciphertext_bytes,0);
  check(snapshot.references.length===512&&total===1073741824,'Exact Cyst quota fixture');
  await writeFile(join(folder,'snapshot.json'),JSON.stringify(snapshot,null,2)+'\n');await chmod(join(folder,'snapshot.json'),0o600);
  await client.query('ROLLBACK');
  const report={scope:'full Cyst backup quota fixture',cystBytes:total,checkpoints:saved,owners:32,quotaOverflowRejected:rejected,existingCheckpointDecryptedAtFullQuota:true,randomDatabasePayloadBytes:3328*65536,mainnetTransactions:0,mainnetSignerLoaded:false};
  await writeFile(join(folder,'fixture.json'),JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report)+'\n');
}finally{await client.end();await store.close()}
