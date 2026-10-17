import {createServer, type Server} from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {z} from 'zod';
import pino from 'pino';

const methods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash',
  'eth_getTransactionByHash','eth_getTransactionReceipt','eth_getTransactionCount','eth_getBalance',
  'eth_getCode','eth_getStorageAt','eth_call','eth_getLogs','eth_gasPrice','eth_maxPriorityFeePerGas',
  'eth_feeHistory','eth_estimateGas','eth_sendRawTransaction']);
const requestSchema=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string().max(128),z.number().int()]),
  method:z.string().refine(value=>methods.has(value)),params:z.array(z.unknown()).max(16).default([])}).strict();
type Request=z.infer<typeof requestSchema>;
const responseSchema=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number(),z.null()]),
  result:z.unknown().optional(),error:z.object({code:z.number().int(),message:z.string(),data:z.unknown().optional()}).passthrough().optional()})
  .passthrough().refine(value=>Object.hasOwn(value,'result')!==Object.hasOwn(value,'error'));
const primary='https://mainnet.base.org',secondary='https://base-mainnet.public.blastapi.io';
const transient=(code:number,message:string)=>[-32005,-32011,-32016,-32002,-32603].includes(code)
  || /rate.?limit|request limit|too many requests|temporar|timeout|header not found|missing trie node/i.test(message);
type Fetch=typeof fetch;
type Logger={warn:(data:Record<string,unknown>,message:string)=>void};

/** Relay responses unchanged; retry reads only. Signed broadcasts have exactly one upstream attempt. */
export async function routeBaseRpc(request:Request,send:Fetch=fetch,logger?:Logger):Promise<unknown>{
  const write=request.method==='eth_sendRawTransaction';
  const hosts=write?[primary]:request.method==='eth_getLogs'?[secondary,primary]:[primary,secondary];
  let last:unknown;
  for(const [index,url] of hosts.entries()){
    try{
      const response=await send(url,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify(request),signal:AbortSignal.timeout(index===0&&!write?2500:5000)});
      if(!response.ok)throw Error('Upstream HTTP unavailable');
      const text=await response.text();if(Buffer.byteLength(text)>4*1024*1024)throw Error('Upstream response too large');
      const payload=responseSchema.parse(JSON.parse(text));
      if(payload.id!==request.id)throw Error('Upstream response ID mismatch');
      last=payload;
      if(!write&&payload.error&&transient(payload.error.code,payload.error.message)&&index+1<hosts.length){
        logger?.warn({method:request.method,upstream:new URL(url).hostname,code:payload.error.code},'rpc_read_failover');continue;
      }
      return payload;
    }catch{
      logger?.warn({method:request.method,upstream:new URL(url).hostname},write?'rpc_broadcast_uncertain':'rpc_upstream_unavailable');
    }
  }
  return last??{jsonrpc:'2.0',id:request.id,error:{code:-32002,message:'Base RPC temporarily unavailable. Retain the original transaction hash.'}};
}

export function baseRpcServer(logger:Logger,send:Fetch=fetch):Server{
  let active=0;
  return createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/'||active>=64){res.writeHead(503);res.end();return}
    active++;
    try{
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=data.length;if(bytes>1024*1024)throw Error('Request too large');chunks.push(data)}
      const request=requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const response=await routeBaseRpc(request,send,logger);
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(response));
    }catch{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid RPC request'}}))}
    finally{active--}
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const logger=pino(),server=baseRpcServer(logger);
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.listen(18545,'127.0.0.1',()=>logger.info({host:'127.0.0.1',port:18545},'base_rpc_router_started'));
  server.on('error',()=>{logger.error('base_rpc_router_failed');process.exitCode=1});
  const close=()=>{server.close(()=>process.exit(0));setTimeout(()=>{server.closeAllConnections();process.exit(0)},10000).unref()};
  process.once('SIGTERM',close);process.once('SIGINT',close);
}
