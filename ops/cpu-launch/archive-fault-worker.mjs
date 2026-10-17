// One real archive transaction in an isolated process, so lost PostgreSQL
// connections never terminate the acceptance coordinator.
const APP=process.env.ACCEPTANCE_RELEASE_DIR;
if(!/^\/opt\/telomere-mainnet-pilot\/releases\/[0-9a-f]{40}$/.test(APP||''))throw Error('Pinned release');
let store,finished=false;
function codes(error){const values=[];for(let e=error,i=0;e&&i<8;e=e.cause,i++)if(typeof e.code==='string')values.push(e.code);return values}
async function finish(value){if(finished)return;finished=true;try{await store?.close()}catch{}process.send(value,()=>process.exit(value.passed?0:2))}
process.once('uncaughtException',error=>{void finish({finished:true,passed:false,errorType:error.name,codes:codes(error)})});
process.once('unhandledRejection',error=>{void finish({finished:true,passed:false,errorType:error?.name||'Error',codes:codes(error)})});
process.once('message',async settings=>{
  try{
    const db=new URL(settings.DATABASE_URL);
    if(settings.MODE!=='demo'||settings.CHAIN_ID!=='31337'||db.hostname!=='127.0.0.1'||db.username!=='load'||db.pathname!=='/load'
      ||!/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.RPC_URL))throw Error('Disposable scope');
    const {openStore}=await import(APP+'/dist/src/store.js'),{loadConfig}=await import(APP+'/dist/src/config.js'),{ChainBridge}=await import(APP+'/dist/src/bridge.js');
    const config=loadConfig(settings);store=await openStore(config);process.send({ready:true});
    const result=await new ChainBridge(config).archiveJournal(store.db,{force:true,batchSize:8});
    await finish({finished:true,passed:true,result});
  }catch(error){await finish({finished:true,passed:false,errorType:error.name,codes:codes(error)})}
});
