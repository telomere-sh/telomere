// Maintenance requires the controller to release its exclusive database lock.
// Signs archive metadata locally; contains no transaction broadcast operation.
import {readFile} from 'node:fs/promises';
import {parseProfile} from '/opt/telomere-mainnet-pilot/app/dist/src/operator/profile.js';
import {loadConfig} from '/opt/telomere-mainnet-pilot/app/dist/src/config.js';
import {ChainBridge} from '/opt/telomere-mainnet-pilot/app/dist/src/bridge.js';
import {openStore} from '/opt/telomere-mainnet-pilot/app/dist/src/store.js';
if(process.argv.length!==3||process.argv[2]!=='--archive-finalized')throw Error('Explicit archive maintenance mode required');
const config=loadConfig(parseProfile(await readFile('/opt/telomere-mainnet-pilot/private/mainnet.env','utf8')));
const bridge=new ChainBridge(config);await bridge.check();
const store=await openStore(config);
try{
  const before=await bridge.public.getTransactionCount({address:bridge.account.address,blockTag:'latest'});
  const result=await bridge.archiveJournal(store.db,{force:true,batchSize:8});await bridge.verifyJournalArchive(store.db);
  const after=await bridge.public.getTransactionCount({address:bridge.account.address,blockTag:'latest'});
  if(before!==after)throw Error('Signer nonce changed during maintenance');
  process.stdout.write(JSON.stringify({...result,...await bridge.journalArchiveStatus(store.db),signerNonceBefore:before,signerNonceAfter:after,broadcast:false})+'\n');
}finally{await store.close()}
