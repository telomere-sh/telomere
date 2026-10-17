import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {faultProxy} from './fixture-rpc-proxy.mjs';
test('RPC fixture distinguishes failures from a forwarded transaction with a lost acknowledgement',async()=>{
  let upstreamCalls=0;
  const upstream=createServer(async(req,res)=>{for await(const _chunk of req){}upstreamCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:'fixture'}))});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const proxy=faultProxy('http://127.0.0.1:'+upstream.address().port);await new Promise(resolve=>proxy.server.listen(0,'127.0.0.1',resolve));
  async function call(method,params=[]){return fetch('http://127.0.0.1:'+proxy.server.address().port,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})}
  try{
    proxy.state.offline=true;assert.equal((await call('eth_blockNumber')).status,503);assert.equal(upstreamCalls,0);proxy.state.offline=false;
    proxy.state.failFinalized=true;assert.equal((await call('eth_getBlockByNumber',['finalized',false])).status,503);assert.equal(upstreamCalls,0);
    assert.equal((await call('eth_getBlockByNumber',['latest',false])).status,200);proxy.state.failFinalized=false;
    proxy.state.failReceipt=true;assert.equal((await call('eth_getTransactionReceipt',['0xfixture'])).status,503);proxy.state.failReceipt=false;
    proxy.state.dropSendReply=true;assert.equal((await call('eth_sendRawTransaction',['fixture'])).status,503);assert.equal(upstreamCalls,2);
    assert.equal((await call('eth_getTransactionReceipt',['0xfixture'])).status,200);
    assert.deepEqual(proxy.stats,{refused:1,finalityFailures:1,receiptFailures:1,forwardedBroadcasts:1,droppedAcknowledgements:1});
  }finally{await new Promise(resolve=>proxy.server.close(resolve));await new Promise(resolve=>upstream.close(resolve))}
});
