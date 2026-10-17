// Read-only scan: no wallet client, signer, transaction creation or database mutation.
export async function auditOpenedReservations({client,address,abi,cursor,knownIds=[],hasKnownId,maxBlocks=10000n}) {
  if(!cursor||!/^0x[0-9a-fA-F]{40}$/.test(address)||!/^\d+$/.test(cursor.blockNumber)||!/^0x[0-9a-fA-F]{64}$/.test(cursor.blockHash))throw Error('A canonical snapshot cursor is required');
  const from=BigInt(cursor.blockNumber),chainId=await client.getChainId();
  if(chainId!==cursor.chainId||address.toLowerCase()!==cursor.escrow.toLowerCase())throw Error('Snapshot chain binding differs');
  const first=await client.getBlock({blockNumber:from});
  if(first.hash!==cursor.blockHash)throw Error('Snapshot block is no longer canonical');
  const head=await client.getBlockNumber({cacheTime:0});
  if(head<from||head-from>maxBlocks)throw Error('Recovery scan needs a reviewed block range');
  const headBlock=await client.getBlock({blockNumber:head});
  const missing=[],known=new Set(knownIds.map(id=>id.toLowerCase()));let scannedEvents=0;
  for(let start=from;start<=head;start+=1000n){
    const logs=await client.getContractEvents({address,abi,eventName:'RunOpened',fromBlock:start,toBlock:start+999n<head?start+999n:head,strict:true});
    for(const event of logs){
      scannedEvents++;
      if(scannedEvents>100000)throw Error('Recovery event count requires a narrower range');
      const id=event.args.runId;
      if(!(hasKnownId?await hasKnownId(id):known.has(id.toLowerCase()))){
        const run=await client.readContract({address,abi,functionName:'getRun',args:[id],blockNumber:head});
        missing.push({runId:id,payer:run.payer,chainStatus:run.status,ceiling:run.ceiling.toString(),openedInTransaction:event.transactionHash});
      }
    }
  }
  if((await client.getBlock({blockNumber:from})).hash!==cursor.blockHash||(await client.getBlock({blockNumber:head})).hash!==headBlock.hash)throw Error('Recovery scan canonicality changed');
  return {chainId,fromBlock:from.toString(),throughBlock:head.toString(),scannedEvents,missing,
    requiresOperatorReconciliation:missing.some(run=>run.chainStatus!==3),transactionsSubmitted:0};
}
