import type { HostLease } from './protocol.js';

export type InitHeartbeat = { sequence: number; elapsedMs: number };
export type HostCell = { sample(): Promise<{ running: boolean; cpuMs: number }>;
  wait: Promise<{ output: string; exitCode: number }>; stop(): Promise<void> };
export interface HostCellRuntime {
  readonly isolation: 'gvisor' | 'kata' | 'docker_development' | 'local_process_fixture';
  initialize(hostKey: string): Promise<void>;
  cleanupOrphans(hostKey: string): Promise<string[]>;
  start(lease: HostLease, heartbeat: (value: InitHeartbeat) => void): Promise<HostCell>;
}

// Parent init frames ordinary child stdout separately from its heartbeat stream.
export const HOST_INIT_PROGRAM = String.raw`
'use strict';
const {spawn}=require('node:child_process');
let input='',bytes=0;
const frame=value=>process.stdout.write(JSON.stringify(value)+'\n');
process.stdin.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)process.exit(2);input+=chunk;});
process.stdin.on('end',()=>{try{
 const {runId,argv,stdin}=JSON.parse(input);if(!Array.isArray(argv)||!argv.length||typeof runId!=='string'||(stdin!==undefined&&typeof stdin!=='string'))throw Error();
 const start=performance.now();let seq=0,total=0,exited=false;
 const child=spawn(argv[0],argv.slice(1),{shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:'/tmp'}});
 child.stdin.on('error',()=>{});child.stdin.end(stdin??'');
 if(child.pid)frame({kind:'started',pid:child.pid});
 const heartbeat=()=>{if(!exited)frame({kind:'heartbeat',runId,sequence:seq++,elapsedMs:Math.floor(performance.now()-start)});};
 heartbeat();const timer=setInterval(heartbeat,1000);
 const output=(stream,chunk)=>{total+=chunk.length;if(total>16384){child.kill('SIGKILL');process.exitCode=2;return;}frame({kind:'output',stream,data:chunk.toString('base64')});};
 child.stdout.on('data',chunk=>output('stdout',chunk));child.stderr.on('data',chunk=>output('stderr',chunk));
 child.on('error',()=>{exited=true;clearInterval(timer);frame({kind:'exit',code:127});process.exitCode=127;});
 child.on('exit',code=>{exited=true;clearInterval(timer);frame({kind:'exit',code:code??-1});process.exitCode=code??1;});
 process.on('SIGTERM',()=>{child.kill('SIGKILL');});
}catch{process.exitCode=2;}});
`;
