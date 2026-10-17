import { describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { auditPlatformJournal, type PlatformJournalAuditRpc } from '../src/operator/platform-journal-audit.js';
import { platformEscrowAbi } from '../src/platform-runtime/types.js';
import { hashJson } from '../src/common.js';

const account = privateKeyToAccount(`0x${'17'.repeat(32)}`);
const destination = `0x${'28'.repeat(20)}` as Hex;
const receiptRoot = `0x${'48'.repeat(20)}` as Hex;
const blockHash = `0x${'39'.repeat(32)}` as Hex;
const chainId = 31337;
async function original() {
  const runId = `0x${'49'.repeat(32)}` as Hex;
  const data = encodeFunctionData({ abi: platformEscrowAbi, functionName: 'settleRun', args: [
    { runId, billableSeconds: 1n, endedAt: 1n, inferenceCharge: 0n, receiptHash: `0x${'50'.repeat(32)}` },
    0n, []] });
  const raw = await account.signTransaction({ chainId, nonce: 7, to: destination, data, value: 0n,
    gas: 100_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n, type: 'eip1559' });
  return { key: `settle:${runId}`, chainId, sender: account.address.toLowerCase(), to: destination.toLowerCase(),
    data, raw, hash: keccak256(raw), nonce: 7 };
}
function rpc(row: Awaited<ReturnType<typeof original>>): PlatformJournalAuditRpc {
  return { getReferenceBlock: async () => ({ number: 20n, hash: blockHash }),
    getTransactionReceipt: async () => ({ transactionHash: row.hash, to: destination,
      blockNumber: 12n, blockHash, status: 'success' }),
    getBlockHash: async () => blockHash, getLatestNonce: async () => 8 };
}
const expected = { chainId, signer: account.address, escrow: destination, receiptRoot, initialNonce: 7 };

describe('read-only platform signer journal audit', () => {
  it('accepts only the original signed intent with a successful canonical receipt', async () => {
    const row = await original();
    const result = await auditPlatformJournal([row], expected, rpc(row));
    expect(result.status).toBe('ok');
    expect(result.rows).toBe(1);
    expect(Object.values(result.issueCounts).every(count => count === 0)).toBe(true);
  });
  it('detects tampered signed bytes, destination, nonce and reviewed signer before trusting RPC', async () => {
    const row = await original();
    let calls = 0;
    const guarded: PlatformJournalAuditRpc = { ...rpc(row), getTransactionReceipt: async () => { calls++; return null; } };
    const rows = [{ ...row, hash: `0x${'00'.repeat(32)}` }, { ...row, to: account.address },
      { ...row, nonce: 8 }, { ...row, sender: destination }];
    const result = await auditPlatformJournal(rows, expected, guarded);
    expect(result.issueCounts.corrupt_intent).toBe(4);
    expect(calls).toBe(0);
  });
  it('rejects a genuinely signed, mined but unapproved destination and exposes an omitted signer nonce', async () => {
    const row = await original(), other = `0x${'51'.repeat(20)}` as Hex;
    const raw = await account.signTransaction({ chainId, nonce: 7, to: other, data: row.data as Hex,
      value: 0n, gas: 100_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n,
      type: 'eip1559' });
    const unauthorized = { ...row, to: other, raw, hash: keccak256(raw) };
    expect((await auditPlatformJournal([unauthorized], expected, rpc(unauthorized))).issueCounts.corrupt_intent).toBe(1);
    expect((await auditPlatformJournal([row], expected,
      { ...rpc(row), getLatestNonce: async () => 9 })).issueCounts.nonce_gap).toBe(1);
    expect((await auditPlatformJournal([], expected,
      { ...rpc(row), getLatestNonce: async () => 8 })).issueCounts.nonce_gap).toBe(1);
  });
  it('fails when the signer nonce changes while canonical receipts are being scanned', async () => {
    const row = await original();
    let reads = 0;
    const result = await auditPlatformJournal([row], expected,
      { ...rpc(row), getLatestNonce: async () => ++reads === 1 ? 8 : 9 });
    expect(result.status).toBe('critical');
    expect(result.issueCounts.nonce_changed).toBe(1);
    expect(reads).toBe(2);
  });
  it('fails if the reference block reorgs or a receipt arrives only after that block', async () => {
    const row = await original();
    const changed = `0x${'61'.repeat(32)}` as Hex;
    const reorged = await auditPlatformJournal([row], expected,
      { ...rpc(row), getBlockHash: async number => number === 20n ? changed : blockHash });
    expect(reorged.issueCounts.anchor_reorged).toBe(1);
    const future = await auditPlatformJournal([row], expected, { ...rpc(row),
      getTransactionReceipt: async () => ({ transactionHash: row.hash, to: destination,
        blockNumber: 21n, blockHash: changed, status: 'success' }) });
    expect(future.issueCounts.receipt_outside_anchor).toBe(1);
  });
  it('recognizes only root and Vault sync calls with their key-bound arguments', async () => {
    const row = await original();
    const rootData = encodeFunctionData({ abi: parseAbi(['function postRoot(uint64 hour,bytes32 root,uint32 count)']),
      functionName: 'postRoot', args: [23n, `0x${'55'.repeat(32)}`, 1] });
    const vaultData = encodeFunctionData({ abi: parseAbi(['function syncRun(bytes32 runId)']),
      functionName: 'syncRun', args: [row.key.slice(7) as Hex] });
    const scope = hashJson({ chainId, escrow: destination.toLowerCase(), receiptRoot: receiptRoot.toLowerCase() }).slice(2);
    for (const [key, to, data] of [[`platform-root:${scope}:23`, receiptRoot, rootData],
      [`vault-sync:${destination}:${row.key.slice(7)}`, destination, vaultData]] as const) {
      const raw = await account.signTransaction({ chainId, nonce: 7, to, data, value: 0n, gas: 100_000n,
        maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n, type: 'eip1559' });
      const candidate = { ...row, key, to, data, raw, hash: keccak256(raw) };
      expect((await auditPlatformJournal([candidate], expected,
        { ...rpc(candidate), getTransactionReceipt: async () => ({ transactionHash: candidate.hash,
          to, blockNumber: 12n, blockHash, status: 'success' }) })).status).toBe('ok');
      const wrongKey = { ...candidate, key: key.replace(/:23$/, ':24') };
      if (key.startsWith('platform-root:')) expect((await auditPlatformJournal([wrongKey], expected, rpc(candidate)))
        .issueCounts.corrupt_intent).toBe(1);
    }
  });
  it('blocks release for an absent receipt and distinguishes consumed nonce from retriable nonce', async () => {
    const row = await original();
    const missing = { ...rpc(row), getTransactionReceipt: async () => null, getLatestNonce: async () => 7 };
    const consumed = { ...missing, getLatestNonce: async () => 8 };
    expect((await auditPlatformJournal([row], expected, missing)).issueCounts.receipt_missing).toBe(1);
    expect((await auditPlatformJournal([row], expected, consumed)).issueCounts.nonce_consumed).toBe(1);
  });
  it('detects a reverted receipt, a reorged block, and an unavailable RPC without leaking row data', async () => {
    const row = await original();
    const reverted = { ...rpc(row), getTransactionReceipt: async () => ({ transactionHash: row.hash,
      to: destination, blockNumber: 12n, blockHash, status: 'reverted' as const }) };
    const reorged = { ...rpc(row), getBlockHash: async () => `0x${'40'.repeat(32)}` as Hex };
    const unavailable = { ...rpc(row), getTransactionReceipt: async () => { throw new Error('private RPC URL'); } };
    expect((await auditPlatformJournal([row], expected, reverted)).issueCounts.receipt_reverted).toBe(1);
    expect((await auditPlatformJournal([row], expected, reorged)).issueCounts.receipt_noncanonical).toBe(1);
    const result = await auditPlatformJournal([row], expected, unavailable);
    expect(result.issueCounts.rpc_unavailable).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private RPC URL');
    expect(JSON.stringify(result)).not.toContain(row.key);
  });
  it('refuses an incomplete audit when the journal exceeds the bounded scan', async () => {
    await expect(auditPlatformJournal(new Array(4097).fill({}), expected, rpc(await original())))
      .rejects.toThrow('at most 4096 rows');
  });
});
