// Disposable acceptance child. Receives generated local-chain settings over IPC.
import {startPilot} from '/opt/telomere-mainnet-pilot/app/dist/src/main.js';
import {loadConfig} from '/opt/telomere-mainnet-pilot/app/dist/src/config.js';
let pilot;
process.once('message',async settings=>{
  try{
    if(settings.CHAIN_ID!=='31337'||!settings.DATABASE_URL.startsWith('postgresql://load:')||!settings.RPC_URL.startsWith('http://127.0.0.1:'))throw Error('Isolated settings required');
    pilot=await startPilot(loadConfig(settings));process.send({ready:true});
  }catch(error){process.send({ready:false,errorType:error.name});process.exitCode=1;process.disconnect()}
});
process.once('SIGTERM',async()=>{await pilot?.close();process.exit(0)});
