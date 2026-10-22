import { afterEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { inspectCpuReservation } from '../src/chain/wallet-recovery.js';
import { Problem, typedQuote, type StoredQuote } from '../src/common.js';
import type { Service } from '../src/service.js';

const owner='0x1111111111111111111111111111111111111111',escrow='0x2222222222222222222222222222222222222222';
const runId=('0x'+'ab'.repeat(32)) as Hex,leashId=('0x'+'cd'.repeat(32)) as Hex,blockHash=('0x'+'ef'.repeat(32)) as Hex;
const signature=('0x'+'12'.repeat(65)) as Hex;
function fixture(){
  const config=loadConfig({MODE:'demo',CHAIN_ID:'31337',SIGNER_PRIVATE_KEY:generatePrivateKey(),DEMO_PRIVATE_KEY:generatePrivateKey(),ESCROW_ADDRESS:escrow,TOKEN_ADDRESS:owner,DATA_DIR:':memory:'}),bridge=new ChainBridge(config);
  const quote:StoredQuote={runId,leashId,payer:owner,workloadHash:runId,maxSeconds:120,pricePerSecond:'100',inferencePrice:'0',quoteExpiry:1000};
  const job={id:runId,owner,quote,signature,txHash:null as string|null,status:'prepared',leashId,ceiling:'12000'};
  const block={number:200n,hash:blockHash,timestamp:1001n};
  const run={payer:zeroAddress,leashId,workloadHash:runId,ceiling:12000n,status:0,openedAt:900n};
  const requireJob=vi.fn(async()=>job);
  // Minimal service/RPC fixtures expose exactly the read-only recovery surface.
  const service={bridge,requireJob} as unknown as Service;
  vi.spyOn(bridge.public,'getChainId').mockResolvedValue(31337);
  const getBlock=vi.spyOn(bridge.public,'getBlock').mockImplementation(async args=>args?.blockTag==='latest'||args?.blockNumber===200n?block as never:{number:args?.blockNumber,hash:blockHash,timestamp:BigInt(args?.blockNumber??0)*5n} as never);
  const read=vi.spyOn(bridge.public,'readContract').mockImplementation(async()=>run as never);
  const pins=vi.spyOn(bridge,'assertReceiptAssetPins').mockResolvedValue();
  vi.spyOn(bridge.public,'getBalance').mockResolvedValue(1000n);
  const nonce=vi.spyOn(bridge.public,'getTransactionCount').mockResolvedValue(2);
  const logs=vi.spyOn(bridge.public,'getLogs').mockResolvedValue([]);
  vi.spyOn(bridge.public,'getTransaction').mockResolvedValue({hash:runId,from:owner,to:escrow,value:0n,chainId:31337,blockHash,blockNumber:180n,
    input:bridge.openTransaction(typedQuote(quote),signature).data} as never);
  vi.spyOn(bridge.public,'getTransactionReceipt').mockResolvedValue({transactionHash:runId,from:owner,to:escrow,blockHash,blockNumber:180n,status:'success'} as never);
  return {service,bridge,job,block,run,getBlock,read,pins,nonce,logs,requireJob};
}
afterEach(()=>vi.restoreAllMocks());
describe('hashless CPU reservation recovery',()=>{
  it('proves an unused quote expired in a pinned canonical block without signing or scanning history',async()=>{
    const f=fixture(),result=await inspectCpuReservation(f.service,owner,runId);
    expect(result).toMatchObject({owner,runId,chainId:31337,state:'expired_unused',quoteExpiry:'1000',chainTimestamp:'1001',latestNonce:'2',pendingNonce:'2'});
    expect(result.transaction).toEqual(f.bridge.openTransaction(typedQuote(f.job.quote),signature));
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({blockNumber:200n,functionName:'getRun',args:[runId]}));
    expect(f.pins).toHaveBeenCalledWith(blockHash,200n);expect(f.logs).not.toHaveBeenCalled();
  });
  it.each([999n,1000n])('retains a quote until strictly after its chain expiry (%s)',async timestamp=>{
    const f=fixture();f.block.timestamp=timestamp;expect(await inspectCpuReservation(f.service,owner,runId)).toMatchObject({state:'awaiting_wallet'});
  });
  it('never releases a non-prepared job or hides a pending wallet nonce',async()=>{
    const f=fixture();f.job.status='queued';expect(await inspectCpuReservation(f.service,owner,runId)).toMatchObject({state:'awaiting_wallet'});
    f.job.status='prepared';f.nonce.mockImplementation(async args=>args?.blockTag==='pending'?3:2);
    expect(await inspectCpuReservation(f.service,owner,runId)).toMatchObject({state:'expired_unused',latestNonce:'2',pendingNonce:'3'});
  });
  it('checks owner access before any RPC request',async()=>{
    const f=fixture();f.requireJob.mockRejectedValue(new Problem(404,'run_not_found','Run not found.'));
    await expect(inspectCpuReservation(f.service,owner,runId)).rejects.toMatchObject({code:'run_not_found'});expect(f.read).not.toHaveBeenCalled();
  });
  it('keeps the operation unresolved on RPC outage, wrong chain or failed asset pins',async()=>{
    const f=fixture();vi.spyOn(f.bridge.public,'getChainId').mockResolvedValue(1);
    await expect(inspectCpuReservation(f.service,owner,runId)).rejects.toMatchObject({code:'rpc_chain'});
    vi.spyOn(f.bridge.public,'getChainId').mockResolvedValue(31337);f.pins.mockRejectedValue(Error('pins'));
    await expect(inspectCpuReservation(f.service,owner,runId)).rejects.toThrow('pins');f.pins.mockResolvedValue();f.read.mockRejectedValue(Error('RPC'));
    await expect(inspectCpuReservation(f.service,owner,runId)).rejects.toThrow('RPC');
  });
  it('rejects an absence proof from a block that was reorganized',async()=>{
    const f=fixture();f.getBlock.mockImplementation(async args=>({...f.block,hash:args?.blockTag==='latest'?blockHash:runId}) as never);
    await expect(inspectCpuReservation(f.service,owner,runId)).rejects.toMatchObject({code:'chain_reorg'});
  });
  it.each(['payer','leashId','workloadHash','ceiling'] as const)('retains a reservation with mismatched %s',async field=>{
    const f=fixture();Object.assign(f.run,{payer:owner,status:1});
    Object.assign(f.run,{[field]:field==='ceiling'?1n:field==='payer'?escrow:field==='leashId'?runId:leashId});
    await expect(inspectCpuReservation(f.service,owner,runId)).rejects.toMatchObject({code:'reservation_scope'});
  });
  it('retains an opened run when its transaction log cannot be verified',async()=>{
    const f=fixture();Object.assign(f.run,{payer:owner,status:1});
    await expect(inspectCpuReservation(f.service,owner,runId)).rejects.toMatchObject({code:'reservation_lookup'});
    expect(f.logs).toHaveBeenCalledWith(expect.objectContaining({args:{runId,payer:owner},fromBlock:180n,toBlock:200n}));
  });
  it('finds the confirmed original transaction by run ID without a wallet-supplied hash',async()=>{
    const f=fixture();Object.assign(f.run,{payer:owner,status:1});f.logs.mockResolvedValue([{transactionHash:runId}] as never);
    expect(await inspectCpuReservation(f.service,owner,runId)).toMatchObject({state:'transaction_found',hash:runId,runId});
    expect(f.logs).toHaveBeenCalledOnce();
  });
  it('verifies an already admitted run through its saved hash without scanning logs',async()=>{
    const f=fixture();f.job.txHash=runId;
    expect(await inspectCpuReservation(f.service,owner,runId)).toMatchObject({state:'transaction_found',hash:runId});expect(f.read).not.toHaveBeenCalled();expect(f.logs).not.toHaveBeenCalled();
  });
});
