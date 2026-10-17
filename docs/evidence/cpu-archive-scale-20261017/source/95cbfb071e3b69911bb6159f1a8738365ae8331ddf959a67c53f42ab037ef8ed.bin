import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
export function faultProxy(url){
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))throw Error('Disposable RPC only');
  const state={offline:false,failFinalized:false,failReceipt:false,dropSendReply:false,delayMs:0};
  const stats={refused:0,finalityFailures:0,receiptFailures:0,forwardedBroadcasts:0,droppedAcknowledgements:0};
  const server=createServer(async(req,res)=>{try{
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('Fixture request size');chunks.push(chunk)}
    const body=Buffer.concat(chunks),call=JSON.parse(body);
    if(state.offline){stats.refused++;res.writeHead(503);res.end();return}
    if(state.failFinalized&&call.method==='eth_getBlockByNumber'&&call.params?.[0]==='finalized'){
      stats.finalityFailures++;res.writeHead(503);res.end();return;
    }
    if(state.failReceipt&&call.method==='eth_getTransactionReceipt'){stats.receiptFailures++;res.writeHead(503);res.end();return}
    if(state.delayMs)await delay(state.delayMs);
    if(call.method==='eth_sendRawTransaction')stats.forwardedBroadcasts++;
    const reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(10000)});
    const data=await reply.text();
    if(state.dropSendReply&&call.method==='eth_sendRawTransaction'){
      state.dropSendReply=false;stats.droppedAcknowledgements++;res.writeHead(503);res.end();return;
    }
    res.writeHead(reply.status,{'content-type':'application/json'});res.end(data);
  }catch{res.writeHead(503);res.end()}});
  return {server,state,stats};
}
