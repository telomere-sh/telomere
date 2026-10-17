/** Operator-owned persistent init. Stdout is framing only; workloads never
 * receive the protocol pipe. This is software observation, not attestation. */
export const SESSION_INIT_PROGRAM = String.raw`
'use strict';
const {spawn}=require('node:child_process');
const {performance}=require('node:perf_hooks');
let buffer='',ready=false,stopping=false,child=null,current=null,heartbeatTimer,deadlineTimer;
let spec,operatorOnly=false,totalOutput=0,frames=0,sequence=0,startedAt=performance.now();
const seen=new Map();
const frame=value=>process.stdout.write(JSON.stringify(value)+'\n');
function killOwned(){
 if(!child)return Promise.resolve();
 const owned=child;
 if(process.platform==='win32')return new Promise(resolve=>{
  const killer=spawn('taskkill.exe',['/PID',String(owned.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
  const timer=setTimeout(()=>{killer.kill();owned.kill('SIGKILL');resolve();},2000);
  killer.once('error',()=>{clearTimeout(timer);owned.kill('SIGKILL');resolve();});killer.once('close',()=>{clearTimeout(timer);resolve();});
 });
 try{process.kill(-owned.pid,'SIGKILL');}catch{try{owned.kill('SIGKILL');}catch{}}
 return Promise.resolve();
}
async function stop(reason){
 if(stopping)return;stopping=true;clearInterval(heartbeatTimer);clearTimeout(deadlineTimer);
 await killOwned();frame({kind:'stopped',reason});process.stdin.destroy();process.exitCode=0;
}
function validCommand(value){
 return value&&typeof value.commandId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.commandId)
 &&Array.isArray(value.argv)&&value.argv.length>=1&&value.argv.length<=32
 &&value.argv.every(v=>typeof v==='string'&&v.length>=1&&v.length<=4096&&!v.includes('\0')&&Buffer.from(v).toString()===v)
 &&value.argv.reduce((n,v)=>n+Buffer.byteLength(v),0)<=8192&&!/^(?:.*\/)?(?:sh|bash|dash|zsh|ksh|fish|busybox)$/.test(value.argv[0])
 &&(value.stdin===undefined||typeof value.stdin==='string'&&value.stdin.length<=8192&&Buffer.byteLength(value.stdin)<=8192&&!value.stdin.includes('\0')&&Buffer.from(value.stdin).toString()===value.stdin);
}
function execute(value){
 if(!validCommand(value)||child||stopping||seen.has(value.commandId)||seen.size>=spec.policy.maxCommands)throw Error();
 seen.set(value.commandId,true);current={commandId:value.commandId,bytes:0,reason:'exited'};
 const owned=current;
 child=spawn(value.argv[0],value.argv.slice(1),{shell:false,detached:process.platform!=='win32',cwd:process.cwd(),
  env:{PATH:process.env.PATH,LANG:'C.UTF-8',HOME:process.cwd(),TMPDIR:process.cwd(),...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}: {})},stdio:['pipe','pipe','pipe']});
 const launched=child;
 if(launched.pid)frame({kind:'started',commandId:value.commandId,pid:launched.pid});
 launched.stdin.on('error',()=>{});launched.stdin.end(value.stdin??'');
 const output=(stream,chunk)=>{
  if(stopping||owned.reason!=='exited')return;
  for(let offset=0;offset<chunk.length;offset+=4096){const bytes=chunk.subarray(offset,offset+4096);
   if(owned.bytes+bytes.length>spec.policy.maxOutputBytesPerCommand||totalOutput+bytes.length>spec.policy.maxSessionOutputBytes||frames+1>spec.policy.maxOutputFrames){
    owned.reason='output_limit';void killOwned();return;}
   owned.bytes+=bytes.length;totalOutput+=bytes.length;frames++;frame({kind:'output',commandId:value.commandId,stream,data:bytes.toString('base64')});
  }
 };
 launched.stdout.on('data',chunk=>output('stdout',chunk));launched.stderr.on('data',chunk=>output('stderr',chunk));
 launched.once('error',()=>{owned.reason='spawn_failed';});
 launched.once('close',code=>{
  if(process.platform!=='win32'&&launched.pid){try{process.kill(-launched.pid,'SIGKILL');}catch{}}
  if(child===launched)child=null;current=null;
  frame({kind:'exit',commandId:value.commandId,exitCode:owned.reason==='exited'?(code??-1):-1,reason:owned.reason});
 });
}
function input(value){
 if(!ready){
  if(value.kind!=='initialize'||!value.spec||!Number.isInteger(value.spec.lifetimeSeconds)||value.spec.lifetimeSeconds<1||value.spec.lifetimeSeconds>120)throw Error();
  spec=value.spec;operatorOnly=value.operatorOnly===true;ready=true;startedAt=performance.now();
  frame({kind:'ready',pid:process.pid});
  const beat=()=>frame({kind:'heartbeat',sequence:sequence++,elapsedMs:Math.floor(performance.now()-startedAt)});beat();heartbeatTimer=setInterval(beat,1000);
  deadlineTimer=setTimeout(()=>{void stop('expired');},spec.lifetimeSeconds*1000);return;
 }
 if(value.kind==='execute'&&!operatorOnly)execute(value.command);
 else if(value.kind==='cancel'&&current&&value.commandId===current.commandId){current.reason='cancelled';void killOwned();}
 else if(value.kind==='stop')void stop(value.reason==='expired'?'expired':'requested');
 else throw Error();
}
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 buffer+=chunk;if(Buffer.byteLength(buffer)>65536){void stop('transport_fault');return;}
 for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
  try{input(JSON.parse(line));}catch{void stop('transport_fault');return;}}
});
process.stdin.on('end',()=>{void stop('transport_fault');});
process.stdin.on('error',()=>{void stop('transport_fault');});
process.on('SIGTERM',()=>{void stop('requested');});
process.on('SIGINT',()=>{void stop('requested');});
setTimeout(()=>{if(!ready)void stop('transport_fault');},5000).unref();
`;
