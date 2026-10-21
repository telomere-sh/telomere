import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, TransactionReceiptNotFoundError } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { escrowAbi, tokenAbi } from '../src/chain/abi.js';
import { inspectWalletTransaction, walletRecoveryState } from '../src/chain/wallet-recovery.js';

const owner='0x1111111111111111111111111111111111111111', escrow='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333';
const hash=`0x${'ab'.repeat(32)}` as const, blockHash=`0x${'cd'.repeat(32)}` as const;
function setup(){
  const config=loadConfig({MODE:'demo',CHAIN_ID:'31337',SIGNER_PRIVATE_KEY:generatePrivateKey(),DEMO_PRIVATE_KEY:generatePrivateKey(),ESCROW_ADDRESS:escrow,TOKEN_ADDRESS:token,DATA_DIR:':memory:'});
  const bridge=new ChainBridge(config);
  const tx={hash,from:owner,to:escrow,value:0n,chainId:31337,blockHash,blockNumber:1n,input:encodeFunctionData({abi:escrowAbi,functionName:'createLeash',args:[hash,owner,100n,1000n,2000000000n]})};
  const receipt={transactionHash:hash,from:owner,to:escrow,blockHash,blockNumber:1n,status:'success'};
  vi.spyOn(bridge.public,'getChainId').mockResolvedValue(31337);
  // Only fields consumed by the verifier are required in these RPC fixtures.
  vi.spyOn(bridge.public,'getTransaction').mockImplementation(async()=>tx as never);
  const getReceipt=vi.spyOn(bridge.public,'getTransactionReceipt').mockImplementation(async()=>receipt as never);
  vi.spyOn(bridge.public,'getBlock').mockResolvedValue({hash:blockHash} as never);
  const pins=vi.spyOn(bridge,'assertReceiptAssetPins').mockResolvedValue();
  return {bridge,tx,receipt,getReceipt,pins};
}
afterEach(()=>vi.restoreAllMocks());
describe('read-only wallet transaction recovery',()=>{
  it('verifies the original Leash call in its canonical receipt block',async()=>{
    const {bridge,pins}=setup();expect(await inspectWalletTransaction(bridge,owner,hash)).toMatchObject({status:'confirmed',method:'createLeash',leashId:hash,owner,chainId:31337});expect(pins).toHaveBeenCalledWith(blockHash,1n);
  });
  it.each(['from','to','chainId','value'] as const)('rejects a wrong transaction %s',async field=>{
    const {bridge,tx}=setup();Object.assign(tx,{[field]:field==='chainId'?1:field==='value'?1n:'0x4444444444444444444444444444444444444444'});
    await expect(inspectWalletTransaction(bridge,owner,hash)).rejects.toMatchObject({code:'transaction_scope'});
  });
  it('only accepts a token approval to the configured escrow',async()=>{
    const {bridge,tx,receipt}=setup();tx.to=token;receipt.to=token;tx.input=encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[escrow,100n]});
    expect(await inspectWalletTransaction(bridge,owner,hash)).toMatchObject({method:'approve',status:'confirmed'});
    tx.input=encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[owner,100n]});await expect(inspectWalletTransaction(bridge,owner,hash)).rejects.toMatchObject({code:'transaction_action'});
  });
  it('keeps an unmined transaction pending and propagates RPC outages',async()=>{
    const {bridge,getReceipt}=setup();getReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({hash}));expect(await inspectWalletTransaction(bridge,owner,hash)).toMatchObject({status:'pending'});
    getReceipt.mockRejectedValue(Error('RPC unavailable'));await expect(inspectWalletTransaction(bridge,owner,hash)).rejects.toThrow('RPC unavailable');
  });
  it('distinguishes a reverted result from a confirmed successful call',async()=>{
    const {bridge,receipt}=setup();receipt.status='reverted';expect(await inspectWalletTransaction(bridge,owner,hash)).toMatchObject({status:'reverted'});
  });
  it('rejects an inconsistent receipt and a changed canonical block',async()=>{
    const {bridge,receipt}=setup();receipt.blockNumber=2n;await expect(inspectWalletTransaction(bridge,owner,hash)).rejects.toMatchObject({code:'transaction_receipt'});
    receipt.blockNumber=1n;vi.spyOn(bridge.public,'getBlock').mockResolvedValue({hash} as never);await expect(inspectWalletTransaction(bridge,owner,hash)).rejects.toMatchObject({code:'chain_reorg'});
  });
  it('does not accept a result if the pinned assets fail verification',async()=>{
    const {bridge,pins}=setup();pins.mockRejectedValue(Error('Asset pin changed'));await expect(inspectWalletTransaction(bridge,owner,hash)).rejects.toThrow('Asset pin changed');
  });
  it('checks wallet nonce and ETH without signing a transaction',async()=>{
    const {bridge}=setup();vi.spyOn(bridge.public,'getBalance').mockResolvedValue(0n);vi.spyOn(bridge.public,'getTransactionCount').mockResolvedValue(0);
    expect(await walletRecoveryState(bridge,owner)).toEqual({owner,chainId:31337,latestNonce:'0',pendingNonce:'0',ethBalanceWei:'0'});
    vi.spyOn(bridge.public,'getTransactionCount').mockImplementation(async args=>args?.blockTag==='latest'?2:1);
    await expect(walletRecoveryState(bridge,owner)).rejects.toMatchObject({code:'rpc_state'});
  });
});
