import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditOpenedReservations} from './chain-recovery-audit.mjs';
const address='0x'+'a'.repeat(40),blockHash='0x'+'b'.repeat(64),unknown='0x'+'c'.repeat(64),known='0x'+'d'.repeat(64);
function fixture(overrides={}) {
  const calls=[];
  const client={
    async getChainId(){return 31337},async getBlockNumber(){return 20n},
    async getBlock({blockNumber}){return {number:blockNumber,hash:blockHash}},
    async getContractEvents(request){calls.push(request);return [{args:{runId:unknown},transactionHash:'0x'+'e'.repeat(64)},{args:{runId:known}}]},
    async readContract(){return {payer:address,status:1,ceiling:100n}},...overrides};
  return {calls,options:{client,address,abi:[],cursor:{chainId:31337,escrow:address,blockNumber:'10',blockHash},knownIds:[known]}};
}
test('unknown active reservation is found without submitting a transaction',async()=>{
  const {options,calls}=fixture();const report=await auditOpenedReservations(options);
  assert.equal(report.requiresOperatorReconciliation,true);assert.equal(report.transactionsSubmitted,0);
  assert.equal(report.missing.length,1);assert.equal(report.missing[0].runId,unknown);
  assert.equal(calls[0].fromBlock,10n);assert.equal(calls[0].toBlock,20n);
});
test('an unknown already-refunded reservation needs no new payment',async()=>{
  const {options}=fixture({async readContract(){return {payer:address,status:3,ceiling:100n}}});
  assert.equal((await auditOpenedReservations(options)).requiresOperatorReconciliation,false);
});
test('chain mismatch, reorg and excessive scan ranges fail closed',async()=>{
  for(const overrides of [{async getChainId(){return 1}},{async getBlock(){return {hash:'0x'+'f'.repeat(64)}}},{async getBlockNumber(){return 20000n}}]) {
    const {options,calls}=fixture(overrides);await assert.rejects(auditOpenedReservations(options));assert.equal(calls.length,0);
  }
});
test('head reorg during event scan rejects the result',async()=>{
  let read=0;
  const {options}=fixture({async getBlock({blockNumber}){if(blockNumber===20n&&++read===2)return {hash:'0x'+'f'.repeat(64)};return {hash:blockHash}}});
  await assert.rejects(auditOpenedReservations(options),/canonicality changed/);
});
test('missing or malformed snapshot cursor is rejected',async()=>{
  const {options}=fixture();
  for(const cursor of [null,{...options.cursor,blockNumber:'-1'},{...options.cursor,blockHash:'../data'}])await assert.rejects(auditOpenedReservations({...options,cursor}));
});
test('RPC errors do not produce a clear reconciliation report',async()=>{
  const {options}=fixture({async getContractEvents(){throw Error('RPC unavailable')}});
  await assert.rejects(auditOpenedReservations(options),/RPC unavailable/);
});
