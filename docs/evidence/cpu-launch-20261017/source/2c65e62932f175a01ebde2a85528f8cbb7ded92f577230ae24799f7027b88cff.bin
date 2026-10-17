import {describe,it,expect,vi} from 'vitest';
import {routeBaseRpc,baseRpcServer} from '../scripts/base-rpc-router.js';

const request={jsonrpc:'2.0' as const,id:7,method:'eth_getCode',params:['0x123','latest']};
const response=(value:unknown)=>new Response(JSON.stringify({jsonrpc:'2.0',id:7,result:value}));
describe('Base RPC transport failover',()=>{
  it('passes canonical-state parameters and successful results through unchanged',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(response('0xabc'));
    expect(await routeBaseRpc(request,send)).toEqual({jsonrpc:'2.0',id:7,result:'0xabc'});
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toEqual(request);expect(send).toHaveBeenCalledTimes(1);
  });
  it('fails over rate-limited reads without substituting block selectors',async()=>{
    const pinned={...request,params:['0x123',{blockHash:'0xbeef',requireCanonical:true}]};
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:'2.0',id:7,error:{code:-32011,message:'request limit reached'}})))
      .mockResolvedValueOnce(response('0xabc'));
    expect(await routeBaseRpc(pinned,send)).toEqual({jsonrpc:'2.0',id:7,result:'0xabc'});
    expect(send).toHaveBeenCalledTimes(2);expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual(pinned);
  });
  it('routes event history to the compatible upstream first',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(response([]));await routeBaseRpc({...request,method:'eth_getLogs'},send);
    expect(send.mock.calls[0]?.[0]).toBe('https://base-rpc.publicnode.com');
  });
  it('keeps exact receipt-block logs on the compatible archive upstream',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValue(response([]));await routeBaseRpc({...request,method:'eth_getLogs',params:[{blockHash:'0xbeef'}]},send);
    expect(send.mock.calls[0]?.[0]).toBe('https://base-mainnet.public.blastapi.io');
  });
  it('fails over an HTTP log-range refusal without changing the filter',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('unavailable',{status:429})).mockResolvedValueOnce(new Response('range limit',{status:400})).mockResolvedValueOnce(response([]));
    const logs={...request,method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x100',topics:['0xtopic']}]};
    expect(await routeBaseRpc(logs,send)).toEqual({jsonrpc:'2.0',id:7,result:[]});expect(send).toHaveBeenCalledTimes(3);
    for(const call of send.mock.calls)expect(JSON.parse(String(call[1]?.body))).toEqual(logs);
  });
  it('bounds streamed upstream data before parsing',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('x'.repeat(4*1024*1024+1))).mockResolvedValueOnce(response('bounded'));
    expect(await routeBaseRpc(request,send)).toEqual({jsonrpc:'2.0',id:7,result:'bounded'});
  });
  it('does not retry contract reverts',async()=>{
    const payload={jsonrpc:'2.0',id:7,error:{code:3,message:'execution reverted',data:'0xdead'}};
    const send=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload)));
    expect(await routeBaseRpc({...request,method:'eth_call'},send)).toEqual(payload);expect(send).toHaveBeenCalledTimes(1);
  });
  it('never retries a signed broadcast even when its outcome is unknown',async()=>{
    const send=vi.fn<typeof fetch>().mockRejectedValue(Error('timeout'));
    const result=await routeBaseRpc({...request,method:'eth_sendRawTransaction',params:['0xsigned']},send);
    expect(result).toMatchObject({error:{code:-32002}});expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched upstream request IDs',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({jsonrpc:'2.0',id:8,result:'bad'}))).mockResolvedValueOnce(response('good'));
    expect(await routeBaseRpc(request,send)).toEqual({jsonrpc:'2.0',id:7,result:'good'});
  });
  it('rejects signing methods at the HTTP boundary',async()=>{
    const send=vi.fn<typeof fetch>(),server=baseRpcServer({warn:()=>undefined},send);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{const address=server.address();if(!address||typeof address==='string')throw Error('Missing test port');
      const r=await fetch('http://127.0.0.1:'+address.port,{method:'POST',body:JSON.stringify({...request,method:'eth_sign'})});expect(r.status).toBe(400);expect(send).not.toHaveBeenCalled();
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  });
});
