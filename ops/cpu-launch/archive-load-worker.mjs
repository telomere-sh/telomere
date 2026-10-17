// This worker accepts only generated fixture settings for the pinned release.
const APP=process.env.ACCEPTANCE_RELEASE_DIR;
if(!/^\/opt\/telomere-mainnet-pilot\/releases\/[0-9a-f]{40}$/.test(APP||''))throw Error('Physical reviewed release required');
let pilot,pending=false;
process.on('message',async message=>{
  if(pending)return;pending=true;
  try{
    if(message.settings){
      const s=message.settings,url=new URL(s.DATABASE_URL);
      if(s.MODE!=='demo'||s.CHAIN_ID!=='31337'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(s.RPC_URL)
        ||url.hostname!=='127.0.0.1'||url.username!=='load'||url.pathname!=='/load')throw Error('Disposable settings required');
      const {Worker}=await import(APP+'/dist/src/worker.js');if(message.paused)Worker.prototype.start=function(){};
      const {startPilot}=await import(APP+'/dist/src/main.js'),{loadConfig}=await import(APP+'/dist/src/config.js');
      pilot=await startPilot(loadConfig(s));process.send({ready:true});
    }else if(message.drain){await pilot.worker.drainOnce();process.send({drained:true})}
    else if(message.retry){
      if(!/^0x[0-9a-f]{64}$/.test(message.retry))throw Error('Fixture run ID');
      const {jobs}=await import(APP+'/dist/src/store.js'),{eq}=await import(APP+'/node_modules/drizzle-orm/index.js');
      const row=(await pilot.service.db.select().from(jobs).where(eq(jobs.id,message.retry)))[0];
      if(!row||row.status!=='settling')throw Error('Fixture settlement state');
      // Exercise the same worker settlement path, keeping unrelated queued CPU
      // tasks paused while a specific RPC fault is injected.
      await pilot.worker.settle(row);process.send({drained:true});
    }
  }catch(error){
    if(message.drain||message.retry)process.send({drained:true,failed:true,errorType:error.name});
    else{process.send({ready:false,errorType:error.name});process.exitCode=1}
  }
  finally{pending=false}
});
process.once('SIGTERM',async()=>{try{await pilot?.close();process.exit(0)}catch{process.exit(1)}});
