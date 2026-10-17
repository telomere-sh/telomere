// Fixture controls live only in this disposable process; application bytes stay pinned.
import {pathToFileURL} from 'node:url';
let pilot, pending=false;
process.on('message', async message => {
  if (pending) return;
  pending=true;
  try {
    if (message.settings) {
      const settings=message.settings;
      if(settings.CHAIN_ID!=='31337'||!settings.DATABASE_URL.startsWith('postgresql://load:')||!/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.RPC_URL))throw Error('Isolated settings required');
      const root=message.release;
      if(!/^\/opt\/telomere-mainnet-pilot\/(app|data\/cpu-launch-acceptance-20261017\/http-load-[A-Za-z0-9]+\/release-[ab])$/.test(root))throw Error('Fixture release required');
      const {Worker}=await import(pathToFileURL(root+'/dist/src/worker.js'));
      if(message.paused)Worker.prototype.start=function(){};
      const {startPilot}=await import(pathToFileURL(root+'/dist/src/main.js'));
      const {loadConfig}=await import(pathToFileURL(root+'/dist/src/config.js'));
      pilot=await startPilot(loadConfig(settings));
      process.send({ready:true});
    } else if(message.drain) {
      await pilot.worker.drainOnce();process.send({drained:true});
    }
  } catch(error) {process.send({ready:false,errorType:error.name,message:error.message});process.exitCode=1;}
  finally {pending=false;}
});
process.once('SIGTERM',async()=>{try{await pilot?.close();process.exit(0)}catch{process.exit(1)}});
