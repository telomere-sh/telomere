// Modest read-only production-edge probe: no login challenges or wallet state.
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const target='https://telomere.sh',samples=[],started=performance.now();
let completed=0;
await Promise.all(Array.from({length:50},async()=>{
  for(let i=0;i<2;i++){
    const began=performance.now(),response=await fetch(target+'/api/me',{signal:AbortSignal.timeout(15000)});
    const value=await response.json();
    if(response.status!==401||value.status!==401)throw Error('Unexpected unauthenticated public API response');
    samples.push(performance.now()-began);completed++;
  }
}));
samples.sort((a,b)=>a-b);
const result={passed:true,observedAt:new Date().toISOString(),target,endpoint:'/api/me',method:'GET',
  requests:completed,concurrency:50,expectedUnauthorized:401,unexpectedResponses:0,p95Ms:samples[Math.floor(samples.length*.95)],
  p99Ms:samples[Math.floor(samples.length*.99)],elapsedSeconds:(performance.now()-started)/1000,
  clientLocation:'external Windows PC; trusted public TLS; no SSH tunnel',authenticationChallengesCreated:0,
  workspaceMutations:0,mainnetTransactions:0};
if(!process.argv[2])throw Error('Sanitized result path required');
await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result)+'\n');
