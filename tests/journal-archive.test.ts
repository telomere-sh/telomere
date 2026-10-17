import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseTransaction,
  TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { hashJson, jsonSafe } from '../src/common.js';
import { escrowAbi } from '../src/chain/abi.js';
import { jobs, transactions, journalArchiveBatches, openStore } from '../src/store.js';
import type { Settlement } from '../src/chain/typed-data.js';

const zero = `0x${'00'.repeat(32)}` as const;
const owner: Address = '0x1111111111111111111111111111111111111111';
const config = loadConfig({ MODE:'demo', DATA_DIR:':memory:', CHAIN_ID:'31337', RPC_URL:'http://127.0.0.1:1',
  SIGNER_PRIVATE_KEY:`0x${'11'.repeat(32)}`, DEMO_PRIVATE_KEY:`0x${'55'.repeat(32)}`, TOKEN_ADDRESS:'0x2222222222222222222222222222222222222222',
  ESCROW_ADDRESS:'0x3333333333333333333333333333333333333333' });
type Row = typeof jobs.$inferInsert;
type MinedReceipt = Awaited<ReturnType<ChainBridge['public']['getTransactionReceipt']>>;
type Run = Awaited<ReturnType<ChainBridge['run']>>;

describe('non-destructive finalized settlement journal archival', () => {
  let store: Awaited<ReturnType<typeof openStore>>, bridge: ChainBridge;
  let chainNonce: number, finalized: bigint, changedAnchor: boolean, next: number;
  let receipts: Map<Hex,MinedReceipt>, runs: Map<Hex,Run>;
  let settlementRecords: Map<Hex,{settlement:Settlement;signature:Hex}>;
  let broadcast: ReturnType<typeof wire>;

  function blockHash(number: bigint): Hex { return hashJson({ block:number.toString(), changed:changedAnchor }); }
  function mined(hash: Hex, settlement: Settlement, nonce: number): MinedReceipt {
    const amount=settlement.billableSeconds*100n+settlement.inferenceCharge;
    // REASON: this transport fixture populates every receipt field consumed by the real validator.
    return { transactionHash:hash, status:'success', from:bridge.account.address, to:config.ESCROW_ADDRESS,
      blockNumber:BigInt(nonce+1), blockHash:blockHash(BigInt(nonce+1)), logs:[{
        address:config.ESCROW_ADDRESS, topics:encodeEventTopics({abi:escrowAbi,eventName:'RunSettled',
          args:{runId:settlement.runId,receiptHash:settlement.receiptHash}}),
        data:encodeAbiParameters([{type:'uint64'},{type:'uint96'},{type:'uint96'},{type:'uint96'}],
          [settlement.billableSeconds,settlement.inferenceCharge,amount,1000n-amount]),
      }] } as MinedReceipt;
  }
  function wire(target: ChainBridge) {
    vi.spyOn(target.public,'getTransactionCount').mockImplementation(async()=>chainNonce);
    // REASON: deterministic canonical headers isolate journal behavior from a network provider.
    vi.spyOn(target.public,'getBlock').mockImplementation(async request=>{
      const number=request?.blockNumber??finalized;
      return {number,hash:blockHash(number),timestamp:1_800_000_000n} as never;
    });
    vi.spyOn(target.public,'getTransactionReceipt').mockImplementation(async({hash})=>{
      const result=receipts.get(hash);if(!result)throw new TransactionReceiptNotFoundError({hash});return result;
    });
    vi.spyOn(target.public,'waitForTransactionReceipt').mockImplementation(async({hash})=>{
      const result=receipts.get(hash);if(!result)throw new TransactionReceiptNotFoundError({hash});return result;
    });
    vi.spyOn(target,'run').mockImplementation(async id=>{
      const run=runs.get(id);if(!run)throw Error('Fixture run missing');return run;
    });
    // REASON: provide complete fee/nonce fields while signing the actual supplied calldata.
    vi.spyOn(target.wallet,'prepareTransactionRequest').mockImplementation(async request=>({
      ...request,chainId:31337,nonce:chainNonce,gas:200000n,maxFeePerGas:2n,maxPriorityFeePerGas:1n,type:'eip1559',
    }) as never);
    // Keep genuine local ECDSA signing; only replace the wallet transport's RPC chain check.
    vi.spyOn(target.wallet,'signTransaction').mockImplementation(async request=>{
      if(!request.to||!request.data||request.nonce===undefined||request.gas===undefined
        ||request.maxFeePerGas===undefined||request.maxPriorityFeePerGas===undefined)throw Error('Incomplete signing fixture');
      const raw=await target.account.signTransaction({chainId:31337,to:request.to,data:request.data,nonce:request.nonce,
        gas:request.gas,maxFeePerGas:request.maxFeePerGas,maxPriorityFeePerGas:request.maxPriorityFeePerGas,type:'eip1559'});
      if(!raw.startsWith('0x02'))throw Error('Unexpected fixture transaction type');
      // REASON: the actual local signer produced a prefix-checked EIP-1559 envelope.
      return raw as `0x02${string}`;
    });
    return vi.spyOn(target.public,'sendRawTransaction').mockImplementation(async({serializedTransaction})=>{
      const hash=keccak256(serializedTransaction);if(receipts.has(hash))return hash;
      const tx=parseTransaction(serializedTransaction);expect(tx.nonce).toBe(chainNonce);
      const record=[...settlementRecords.values()].find(({settlement,signature})=>encodeFunctionData({abi:escrowAbi,
        functionName:'settleRun',args:[settlement,signature]})===tx.data);
      if(!record)throw Error('Unknown fixture settlement');
      receipts.set(hash,mined(hash,record.settlement,chainNonce));chainNonce++;
      const run=runs.get(record.settlement.runId)!;runs.set(record.settlement.runId,{...run,status:2,
        billableSeconds:record.settlement.billableSeconds,inferenceCharge:record.settlement.inferenceCharge,receiptHash:record.settlement.receiptHash});
      return hash;
    });
  }

  async function record(completed=true,overrideId?:Hex) {
    const id=overrideId??hashJson({fixture:'archive',n:next++}),leashId=hashJson({fixture:'archive-leash'});
    const input={leashId,task:{kind:'sha256' as const,text:'archive'},maxSeconds:10};
    const quote={runId:id,leashId,payer:owner,workloadHash:hashJson(input),maxSeconds:10,
      pricePerSecond:'100',inferencePrice:'0',quoteExpiry:1_800_000_300};
    const body={runId:id,payer:owner,leashId,workloadHash:quote.workloadHash,
      cpu:{billableSeconds:1,measuredSeconds:1,pricePerSecond:'100'},near:null,
      billing:{token:config.TOKEN_ADDRESS,ceiling:'1000',charged:'100',refund:'900'}};
    const settlement={runId:id,billableSeconds:1n,inferenceCharge:0n,receiptHash:hashJson(body)};
    const signature=await bridge.signSettlement(settlement);
    const saved={body,receiptHash:settlement.receiptHash,settlement:jsonSafe(settlement),signature,signer:bridge.account.address,domain:bridge.domain};
    settlementRecords.set(id,{settlement,signature});
    runs.set(id,{payer:owner,leashId,workloadHash:quote.workloadHash,openedAt:1_800_000_000n,acceptedExpiry:1_800_086_400n,
      maxSeconds:10n,pricePerSecond:100n,inferencePrice:0n,ceiling:1000n,stopAt:0n,status:completed?2:1,
      billableSeconds:completed?1n:0n,inferenceCharge:0n,receiptHash:completed?settlement.receiptHash:zero});
    const job:Row={id,owner,leashId,idemKey:id,inputHash:hashJson(input),input,quote,signature,ceiling:'1000',
      status:completed?'completed':'settling',targetStatus:'completed',receipt:saved,charged:'100',refund:'900'};
    if(!completed)return {job,settlement,signature};
    const nonce=chainNonce++,raw=await bridge.account.signTransaction({chainId:31337,to:config.ESCROW_ADDRESS,
      data:encodeFunctionData({abi:escrowAbi,functionName:'settleRun',args:[settlement,signature]}),nonce,
      gas:200000n,maxFeePerGas:2n,maxPriorityFeePerGas:1n,type:'eip1559'});
    const hash=keccak256(raw);job.settlementTxHash=hash;receipts.set(hash,mined(hash,settlement,nonce));
    return {job,settlement,signature,journal:{runId:id,raw,hash,nonce}};
  }
  async function seed(count:number) {
    for(let start=0;start<count;start+=64){
      const batch=[];for(let i=0;i<Math.min(64,count-start);i++)batch.push(await record());
      await store.db.insert(jobs).values(batch.map(r=>r.job));
      await store.db.insert(transactions).values(batch.map(r=>r.journal!));
    }
  }
  async function bytes(){return (await store.db.select().from(transactions).orderBy(asc(transactions.runId)))
    .map(({archiveBatchId:_archived,...rest})=>rest)}
  async function hot(){return store.db.select().from(transactions).where(isNull(transactions.archiveBatchId))}

  beforeEach(async()=>{
    store=await openStore({DATA_DIR:':memory:'});bridge=new ChainBridge(config);
    chainNonce=0;finalized=10000n;changedAnchor=false;next=0;receipts=new Map();runs=new Map();settlementRecords=new Map();broadcast=wire(bridge);
  });
  afterEach(async()=>{vi.restoreAllMocks();await store.close()});

  it('retains original bytes and receipts in signed immutable batches',async()=>{
    await seed(3);const before=await bytes();
    const result=await bridge.archiveJournal(store.db,{force:true});expect(result.archived).toBe(3);
    expect(await bytes()).toEqual(before);expect(await hot()).toHaveLength(0);
    const fresh=new ChainBridge(config);wire(fresh);await fresh.verifyJournalArchive(store.db);
    const all=await store.db.select().from(journalArchiveBatches);expect(all).toHaveLength(1);
    await expect(store.db.update(transactions).set({raw:'0x01'})).rejects.toThrow();
    await expect(store.db.delete(transactions)).rejects.toThrow();
    await expect(store.db.update(journalArchiveBatches).set({body:{}})).rejects.toThrow();
    await expect(store.db.execute(sql`TRUNCATE transaction_journal`)).rejects.toThrow();
    expect(broadcast).not.toHaveBeenCalled();
  });
  it('observes a signed checkpoint without changing the database',async()=>{
    await seed(3);await bridge.archiveJournal(store.db,{force:true});const before=await bytes();
    expect(await bridge.journalArchiveStatus(store.db)).toMatchObject({activeRows:'0',archivedRows:'3',latestCheckpointVerified:true});
    expect(await bytes()).toEqual(before);changedAnchor=true;
    await expect(bridge.journalArchiveStatus(store.db)).rejects.toThrow('canonical anchor or nonce differs');
    expect(broadcast).not.toHaveBeenCalled();
  });
  it('signs one durable envelope for concurrent requests for the same run',async()=>{
    const item=await record(false);await store.db.insert(jobs).values(item.job);
    const other=new ChainBridge(config);wire(other);
    const results=await Promise.all([bridge.settle(store.db,item.settlement,item.signature),other.settle(store.db,item.settlement,item.signature)]);
    expect(results[0]).toBe(results[1]);expect(chainNonce).toBe(1);expect(await bytes()).toHaveLength(1);
    expect(vi.mocked(bridge.wallet.signTransaction).mock.calls.length+vi.mocked(other.wallet.signTransaction).mock.calls.length).toBe(1);
  });
  it('leaves nonfinalized and unsettled rows active',async()=>{
    await seed(2);finalized=0n;
    expect((await bridge.archiveJournal(store.db,{force:true})).archived).toBe(0);expect(await hot()).toHaveLength(2);
    finalized=10000n;await store.db.update(jobs).set({status:'reconciliation'});
    expect((await bridge.archiveJournal(store.db,{force:true})).archived).toBe(0);expect(await hot()).toHaveLength(2);
  });
  it('rolls back the checkpoint and every marker when a membership write fails',async()=>{
    await seed(3);const before=await bytes();
    await store.db.execute(sql.raw(`CREATE FUNCTION fail_archive_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'archive failure fixture'; END $$`));
    await store.db.execute(sql.raw('CREATE TRIGGER fail_archive_fixture BEFORE UPDATE ON transaction_journal FOR EACH ROW EXECUTE FUNCTION fail_archive_fixture()'));
    await expect(bridge.archiveJournal(store.db,{force:true})).rejects.toThrow();
    expect(await bytes()).toEqual(before);expect(await hot()).toHaveLength(3);expect(await store.db.select().from(journalArchiveBatches)).toHaveLength(0);
    await store.db.execute(sql.raw('DROP TRIGGER fail_archive_fixture ON transaction_journal'));
    expect((await bridge.archiveJournal(store.db,{force:true})).archived).toBe(3);
  });
  it('serializes concurrent archive attempts without duplicate membership',async()=>{
    await seed(4);const other=new ChainBridge(config);wire(other);
    const results=await Promise.all([bridge.archiveJournal(store.db,{force:true}),other.archiveJournal(store.db,{force:true})]);
    expect(results.reduce((sum,r)=>sum+r.archived,0)).toBe(4);expect(await store.db.select().from(journalArchiveBatches)).toHaveLength(1);
  });
  it('returns the old canonical transaction after restart and never rebroadcasts an unavailable archived receipt',async()=>{
    await seed(2);await bridge.archiveJournal(store.db,{force:true});const first=(await bytes())[0]!;
    const terms=settlementRecords.get(first.runId as Hex)!;const fresh=new ChainBridge(config),send=wire(fresh);
    expect(await fresh.settle(store.db,terms.settlement,terms.signature)).toBe(first.hash);expect(send).not.toHaveBeenCalled();
    receipts.delete(first.hash as Hex);
    await expect(fresh.settle(store.db,terms.settlement,terms.signature)).rejects.toThrow('Archived settlement receipt is unavailable');
    expect(send).not.toHaveBeenCalled();expect(chainNonce).toBe(2);
  });
  it('rejects an archive anchor reorg and a nonce regression before any new signature',async()=>{
    await seed(2);await bridge.archiveJournal(store.db,{force:true});const item=await record(false);await store.db.insert(jobs).values(item.job);
    const signing=vi.spyOn(bridge.wallet,'signTransaction');changedAnchor=true;
    await expect(bridge.settle(store.db,item.settlement,item.signature)).rejects.toThrow('no longer canonical');
    changedAnchor=false;chainNonce=0;
    await expect(bridge.settle(store.db,item.settlement,item.signature)).rejects.toThrow('behind the journal archive');
    expect(signing).not.toHaveBeenCalled();expect(broadcast).not.toHaveBeenCalled();
  });
  it('detects restored archive corruption even if a privileged restore bypassed its SQL trigger',async()=>{
    await seed(2);await bridge.archiveJournal(store.db,{force:true});
    // Deliberately emulate damaged imported data, not an application update path.
    await store.db.execute(sql.raw('ALTER TABLE transaction_journal DISABLE TRIGGER USER'));
    await store.db.update(transactions).set({raw:'0x01'});
    await store.db.execute(sql.raw('ALTER TABLE transaction_journal ENABLE TRIGGER USER'));
    const fresh=new ChainBridge(config);wire(fresh);
    await expect(fresh.verifyJournalArchive(store.db)).rejects.toThrow('original bytes or membership differ');
    expect(broadcast).not.toHaveBeenCalled();
  });
  it('rejects an imported invalid checkpoint signature before preparing a settlement',async()=>{
    await seed(2);await bridge.archiveJournal(store.db,{force:true});
    await store.db.execute(sql.raw('ALTER TABLE settlement_journal_archive_batches DISABLE TRIGGER USER'));
    await store.db.update(journalArchiveBatches).set({signature:`0x${'ab'.repeat(65)}`});
    await store.db.execute(sql.raw('ALTER TABLE settlement_journal_archive_batches ENABLE TRIGGER USER'));
    const fresh=new ChainBridge(config);wire(fresh);const item=await record(false);await store.db.insert(jobs).values(item.job);
    await expect(fresh.settle(store.db,item.settlement,item.signature)).rejects.toThrow();
    expect(fresh.wallet.prepareTransactionRequest).not.toHaveBeenCalled();expect(fresh.wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('checks unresolved nonces beyond the first two active-history pages',async()=>{
    await seed(130);finalized=0n;
    const pending=await record(false,`0x${'ff'.repeat(32)}`);await store.db.insert(jobs).values(pending.job);
    const raw=await bridge.account.signTransaction({chainId:31337,to:config.ESCROW_ADDRESS,
      data:encodeFunctionData({abi:escrowAbi,functionName:'settleRun',args:[pending.settlement,pending.signature]}),nonce:chainNonce,
      gas:200000n,maxFeePerGas:2n,maxPriorityFeePerGas:1n,type:'eip1559'});
    await store.db.insert(transactions).values({runId:pending.settlement.runId,raw,hash:keccak256(raw),nonce:chainNonce});
    const item=await record(false);await store.db.insert(jobs).values(item.job);
    await expect(bridge.settle(store.db,item.settlement,item.signature)).rejects.toThrow('unresolved transaction nonce');
    expect(bridge.wallet.signTransaction).not.toHaveBeenCalled();expect(broadcast).not.toHaveBeenCalled();
  });
  it('crosses 2000 retained settlements and preserves all original history after archival and replay',async()=>{
    await seed(2105);const before=await bytes();let archived=0;
    while((await hot()).length){archived+=(await bridge.archiveJournal(store.db,{force:true,batchSize:256})).archived}
    expect(archived).toBe(2105);expect(await bytes()).toEqual(before);
    const fresh=new ChainBridge(config),send=wire(fresh);await fresh.verifyJournalArchive(store.db);
    const item=await record(false);await store.db.insert(jobs).values(item.job);
    const minedHash=await fresh.settle(store.db,item.settlement,item.signature);
    expect(chainNonce).toBe(2106);expect(send).toHaveBeenCalledOnce();
    expect(await fresh.settle(store.db,item.settlement,item.signature)).toBe(minedHash);expect(chainNonce).toBe(2106);
    expect(await store.db.select().from(transactions)).toHaveLength(2106);
    expect((await store.db.select().from(transactions).where(and(eq(transactions.runId,item.settlement.runId),isNull(transactions.archiveBatchId))))).toHaveLength(1);
  },120000);
  it('has no 2000-row barrier while finality is delayed, and retains all unarchived nonce guards',async()=>{
    await seed(2002);finalized=0n;
    const item=await record(false);await store.db.insert(jobs).values(item.job);
    await bridge.settle(store.db,item.settlement,item.signature);expect(chainNonce).toBe(2003);
    expect(await hot()).toHaveLength(2003);expect(await store.db.select().from(journalArchiveBatches)).toHaveLength(0);
  },120000);
});
