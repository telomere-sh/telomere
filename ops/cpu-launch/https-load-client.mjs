// Run on an external machine. This file never receives a production wallet key.
import {readFile,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {emptyWorkspace} from '../../dist/src/workspace/routes.js';
const [accessFile,resultFile]=process.argv.slice(2);
if(!accessFile||!resultFile)throw Error('Access file and sanitized result path required');
const access=JSON.parse(await readFile(accessFile,'utf8'));
if(!/^[0-9a-f]{16}$/.test(access.namespace)||access.baseUrl!=='https://review.telomere.sh/_acceptance/'+access.namespace+'/'
  ||access.origin!=='https://review.telomere.sh'||!/^[0-9a-f]{64}$/.test(access.token)||access.mainnet!==false)throw Error('Bounded fixture access');
const check=(value,message)=>{if(!value)throw Error(message)};
async function call(client,path,method='GET',body,extra={}){
  const began=performance.now(),response=await fetch(access.baseUrl+path,{method,headers:{origin:access.origin,'x-telomere-acceptance':access.token,
    'content-type':'application/json',...(client?.cookie?{cookie:client.cookie}:{}),...extra},signal:AbortSignal.timeout(20000),
    ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data=null}
  return {response,data,ms:performance.now()-began};
}
const started=performance.now();
try{
  check((await call(null,'health/ready')).response.status===200,'Public fixture readiness');
  check((await fetch(access.baseUrl+'health/ready',{signal:AbortSignal.timeout(10000)})).status===404,'Missing fixture credential accepted');
  const clients=[];let windowStart=performance.now();
  for(let i=0;i<50;i++){
    if(i>0&&i%15===0){await delay(Math.max(0,60500-(performance.now()-windowStart)));windowStart=performance.now()}
    const account=privateKeyToAccount(generatePrivateKey()),challenge=await call(null,'api/auth/challenge','POST',{address:account.address});
    check(challenge.response.status===200,'Public challenge '+challenge.response.status);
    const signed=await account.signMessage({message:challenge.data.message});
    const verified=await call(null,'api/auth/verify','POST',{address:account.address,nonce:challenge.data.nonce,signature:signed});
    check(verified.response.status===200,'Public signature verification '+verified.response.status);
    const cookie=verified.response.headers.get('set-cookie');check(cookie&&/HttpOnly/i.test(cookie)&&/Secure/i.test(cookie)&&/SameSite=Strict/i.test(cookie),'HTTPS session cookie flags');
    clients.push({owner:account.address.toLowerCase(),cookie:cookie.split(';')[0]});
    if(i%15===14||i===49)process.stdout.write(JSON.stringify({phase:'public_https_signed_users',users:i+1})+'\n');
  }
  for(let i=0;i<50;i++){
    const document=emptyWorkspace();document.budget=i+1;
    check((await call(clients[i],'api/workspace','PUT',{revision:0,document})).response.status===200,'Public Workspace write');
  }
  const samples=[],burst=performance.now();
  await Promise.all(clients.map(async(client,index)=>{
    for(let i=0;i<3;i++){
      const value=await call(client,'api/workspace');check(value.response.status===200&&value.data.owner===client.owner&&value.data.document.budget===index+1,'HTTPS tenant isolation');samples.push(value.ms);
    }
  }));
  samples.sort((a,b)=>a-b);const elapsed=(performance.now()-burst)/1000,p95=samples[Math.floor(samples.length*.95)];
  check(p95<3000,'External authenticated HTTP p95');
  const document=emptyWorkspace();document.budget=123;
  const conflicts=await Promise.all([call(clients[0],'api/workspace','PUT',{revision:1,document}),call(clients[0],'api/workspace','PUT',{revision:1,document})]);
  check(conflicts.map(x=>x.response.status).sort().join(',')==='200,409','Public revision conflict');
  check((await call(clients[1],'api/workspace')).data.document.budget===2,'Cross-tenant write');
  check((await call(clients[0],'api/workspace','PUT',{revision:2,document},{origin:'https://invalid.example'})).response.status===403,'Public Origin enforcement');
  check((await call(clients[0],'api/workspace','PUT','x'.repeat(200*1024))).response.status===413,'Public body size bound');
  let boundary;
  for(let i=0;i<60;i++){
    const response=await call(clients[i%50],'api/workspace');
    if(response.response.status===429){boundary=i+1;break}
    check(response.response.status===200,'Unexpected public rate response');
  }check(boundary,'Public per-IP rate limit not reached');
  const spoof=await Promise.all(Array.from({length:20},(_,i)=>call(clients[i],'api/workspace','GET',undefined,
    {'x-real-ip':'198.18.0.'+(i+1),'x-forwarded-for':'198.18.1.'+(i+1),'forwarded':'for=198.18.2.'+(i+1)})));
  check(spoof.every(x=>x.response.status===429),'Forwarding headers bypassed public rate limit');
  process.stdout.write(JSON.stringify({phase:'public_https_rate_limit_confirmed',spoofedRequestsRejected:20})+'\n');
  await delay(61000);check((await call(clients[0],'api/workspace')).response.status===200,'Public rate window did not recover');
  const result={passed:true,namespace:access.namespace,observedAt:new Date().toISOString(),publicTls:true,
    origin:access.origin,clientLocation:'external Windows PC; no SSH tunnel or TLS verification bypass',signedUsers:50,workspaceWrites:50,
    burst:{reads:150,concurrency:50,elapsedSeconds:elapsed,p95Ms:p95,p99Ms:samples[Math.floor(samples.length*.99)],errors:0},
    tenantIsolation:true,revisionConflict:true,secureSessionCookie:true,originEnforced:true,bodyLimitEnforced:true,
    expectedRateLimit429:true,spoofedForwardingHeadersRejected:20,rateWindowRecovered:true,mainnetTransactions:0,
    elapsedSeconds:(performance.now()-started)/1000};
  await writeFile(resultFile,JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify({passed:true,report:resultFile})+'\n');
}catch(error){
  await writeFile(resultFile,JSON.stringify({passed:false,namespace:access.namespace,publicTls:true,errorType:error.name,message:error.message},null,2)+'\n');
  process.stdout.write(JSON.stringify({passed:false,errorType:error.name,message:error.message})+'\n');process.exitCode=1;
}
