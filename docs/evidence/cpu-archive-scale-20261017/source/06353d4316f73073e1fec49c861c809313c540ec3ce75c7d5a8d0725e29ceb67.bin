// Canonical metering fixtures on a disposable chain. No claimed CPU execution.
import {setTimeout as delay} from 'node:timers/promises';
export async function seedHistory({APP,settings,store,bridge,owner,signer,publicClient,leashId,count,progress}){
  if(settings.MODE!=='demo'||settings.CHAIN_ID!=='31337'||!/^http:\/\/127\.0\.0\.1:\d+$/.test(settings.RPC_URL)
    ||!Number.isInteger(count)||count<1||count>10000)throw Error('Isolated bounded history required');
  const {hashJson,jsonSafe,typedQuote}=await import(APP+'/dist/src/common.js');
  const {jobs,transactions}=await import(APP+'/dist/src/store.js');
  const {escrowAbi}=await import(APP+'/dist/src/chain/abi.js');
  const {encodeFunctionData,keccak256}=await import(APP+'/node_modules/viem/_esm/index.js');
  const fees={gas:500000n,maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n};
  let ownerNonce=await publicClient.getTransactionCount({address:owner.account.address}),signerNonce=await publicClient.getTransactionCount({address:signer.address}),buffer=[];
  const samples=[];
  async function receipt(hash){for(let attempt=0;attempt<500;attempt++){
    try{const value=await publicClient.getTransactionReceipt({hash});if(value.status!=='success')throw Error('Historical fixture reverted');return value}
    catch(error){if(error.name!=='TransactionReceiptNotFoundError')throw error;await delay(10)}
  }throw Error('Historical fixture mining deadline')}
  async function flush(){if(!buffer.length)return;await store.db.transaction(async tx=>{
    await tx.insert(jobs).values(buffer.map(row=>row.job));await tx.insert(transactions).values(buffer.map(row=>row.journal));
  });buffer=[]}
  for(let i=0;i<count;i++){
    const runId=hashJson({leashId,history:i}),input={leashId,task:{kind:'sha256',text:'historical metering fixture'},maxSeconds:2};
    const quote={runId,leashId,payer:owner.account.address,workloadHash:hashJson(input),maxSeconds:2,pricePerSecond:'1',inferencePrice:'0',quoteExpiry:Math.floor(Date.now()/1000)+3600};
    const signature=await bridge.signQuote(typedQuote(quote));
    await receipt(await owner.sendTransaction({to:settings.ESCROW_ADDRESS,data:bridge.openTransaction(typedQuote(quote),signature).data,nonce:ownerNonce++,...fees}));
    const body={runId,payer:owner.account.address,leashId,workloadHash:quote.workloadHash,status:'completed',
      cpu:{billableSeconds:1,measuredSeconds:1,pricePerSecond:'1'},near:null,billing:{token:settings.TOKEN_ADDRESS,ceiling:'2',charged:'1',refund:'1'}};
    const settlement={runId,billableSeconds:1n,inferenceCharge:0n,receiptHash:hashJson(body)},signed=await bridge.signSettlement(settlement);
    const nonce=signerNonce++,raw=await signer.signTransaction({chainId:31337,to:settings.ESCROW_ADDRESS,
      data:encodeFunctionData({abi:escrowAbi,functionName:'settleRun',args:[settlement,signed]}),nonce,...fees,type:'eip1559'}),hash=keccak256(raw);
    await receipt(await publicClient.sendRawTransaction({serializedTransaction:raw}));
    const saved={body,receiptHash:settlement.receiptHash,settlement:jsonSafe(settlement),signature:signed,signer:signer.address,domain:bridge.domain};
    buffer.push({job:{id:runId,owner:owner.account.address.toLowerCase(),leashId,idemKey:runId,inputHash:hashJson(input),input,quote,signature,
      ceiling:'2',status:'completed',targetStatus:'completed',receipt:saved,charged:'1',refund:'1',settlementTxHash:hash,
      createdAt:new Date(Date.now()-2*86400000),updatedAt:new Date(Date.now()-2*86400000)},journal:{runId,raw,hash,nonce}});
    if(i===0||i===count-1)samples.push({runId,hash,settlement,signature:signed});
    if(buffer.length===64)await flush();if(i%500===499)progress?.({settlements:i+1});
  }
  await flush();return {settlements:count,charged:BigInt(count),samples};
}
