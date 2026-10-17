// Caller owns a repeatable-read transaction. Cursor bounds Node memory for large tables.
import {createHash} from 'node:crypto';
export async function fingerprints(client) {
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result=[];
  for(const {tablename:name} of tables){
    if(!/^[a-z][a-z0-9_]*$/.test(name))throw Error('Unreviewed table identifier');
    const hash=createHash('sha256');let rows=0;
    await client.query('DECLARE telomere_fingerprint NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM public."'+name+'" t ORDER BY to_jsonb(t)::text');
    try {
      for(;;){const page=(await client.query('FETCH FORWARD 256 FROM telomere_fingerprint')).rows;if(!page.length)break;for(const item of page){hash.update(item.row+'\n');rows++}}
    } finally {await client.query('CLOSE telomere_fingerprint')}
    result.push({table:name,rows,sha256:hash.digest('hex')});
  }
  return result;
}
