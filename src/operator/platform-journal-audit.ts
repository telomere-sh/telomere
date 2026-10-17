import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, toHex,
  type Hex, type TransactionSerialized } from 'viem';
import { z } from 'zod';
import { hashJson } from '../common.js';

const hex = z.string().max(131_072).regex(/^0x(?:[0-9a-fA-F]{2})+$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const rowSchema = z.object({ key: z.string().min(1).max(180), chainId: z.number().int().positive(),
  sender: address, to: address, data: z.string().max(131_072).regex(/^0x(?:[0-9a-fA-F]{2})*$/), raw: hex,
  hash, nonce: z.number().int().nonnegative().safe() }).strict();
export type PlatformJournalAuditRow = z.infer<typeof rowSchema>;
export type PlatformJournalIssue = 'corrupt_intent' | 'receipt_missing' | 'nonce_consumed'
  | 'receipt_reverted' | 'receipt_noncanonical' | 'rpc_unavailable' | 'nonce_gap' | 'nonce_changed'
  | 'anchor_reorged' | 'receipt_outside_anchor';
export type PlatformJournalAuditResult = { status: 'ok' | 'critical'; rows: number;
  issueCounts: Record<PlatformJournalIssue, number> };
type Receipt = { transactionHash: Hex; to: string | null; blockNumber: bigint; blockHash: Hex;
  status: 'success' | 'reverted' };
export type PlatformJournalAuditRpc = {
  getReferenceBlock(): Promise<{ number: bigint; hash: Hex }>;
  getTransactionReceipt(hash: Hex): Promise<Receipt | null>;
  getBlockHash(blockNumber: bigint): Promise<Hex>;
  getLatestNonce(address: `0x${string}`, blockNumber?: bigint): Promise<number>;
};
export type PlatformJournalAuditPins = { chainId: number; signer: string; escrow: string;
  receiptRoot: string; initialNonce: number };
const selector = (signature: string) => keccak256(toHex(signature)).slice(0, 10).toLowerCase();
const settleSelector = selector('settleRun((bytes32,uint64,uint64,uint96,bytes32),uint64,bytes32[])');
const rootSelector = selector('postRoot(uint64,bytes32,uint32)');
const syncSelector = selector('syncRun(bytes32)');
/** Constrains the three operations this signer currently submits, including destination and key-bound argument. */
function recognizedIntent(row: PlatformJournalAuditRow, pins: PlatformJournalAuditPins): boolean {
  const data = row.data.toLowerCase(), destination = row.to.toLowerCase();
  if (data.length < 74) return false;
  const firstWord = `0x${data.slice(10, 74)}`;
  const settle = /^settle:(0x[0-9a-f]{64})$/i.exec(row.key);
  if (settle) return destination === pins.escrow.toLowerCase()
    && data.slice(0, 10) === settleSelector && firstWord === settle[1]?.toLowerCase();
  const root = /^platform-root:([0-9a-f]{64}):(0|[1-9][0-9]*)$/i.exec(row.key);
  if (root) {
    const scope = hashJson({ chainId: pins.chainId, escrow: pins.escrow.toLowerCase(),
      receiptRoot: pins.receiptRoot.toLowerCase() }).slice(2);
    return destination === pins.receiptRoot.toLowerCase() && data.slice(0, 10) === rootSelector
      && root[1]?.toLowerCase() === scope && BigInt(firstWord) === BigInt(root[2]!);
  }
  const sync = /^vault-sync:(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/i.exec(row.key);
  if (sync) return destination === sync[1]?.toLowerCase() && data.slice(0, 10) === syncSelector
    && firstWord === sync[2]?.toLowerCase();
  return false;
}

/** Bounded, read-only audit of the original signed bytes and canonical receipts. No row identity leaves this result. */
export async function auditPlatformJournal(rows: unknown[], expected: PlatformJournalAuditPins,
  rpc: PlatformJournalAuditRpc): Promise<PlatformJournalAuditResult> {
  if (!Number.isSafeInteger(expected.chainId) || expected.chainId <= 0 || rows.length > 4096
    || !Number.isSafeInteger(expected.initialNonce) || expected.initialNonce < 0) {
    throw new Error('Platform journal audit requires reviewed chain/nonce pins and at most 4096 rows');
  }
  const signer = getAddress(address.parse(expected.signer)).toLowerCase();
  getAddress(address.parse(expected.escrow)); getAddress(address.parse(expected.receiptRoot));
  const issueCounts: Record<PlatformJournalIssue, number> = { corrupt_intent: 0, receipt_missing: 0,
    nonce_consumed: 0, receipt_reverted: 0, receipt_noncanonical: 0, rpc_unavailable: 0,
    nonce_gap: 0, nonce_changed: 0, anchor_reorged: 0, receipt_outside_anchor: 0 };
  let latestNonce: number;
  let reference: { number: bigint; hash: Hex };
  try {
    reference = await rpc.getReferenceBlock();
    if (reference.number < 0n || !hash.safeParse(reference.hash).success) throw new Error('Invalid reference block');
    latestNonce = await rpc.getLatestNonce(signer as `0x${string}`, reference.number);
    if (!Number.isSafeInteger(latestNonce) || latestNonce < 0) throw new Error('Invalid reference nonce');
  } catch { issueCounts.rpc_unavailable++; return { status: 'critical', rows: rows.length, issueCounts }; }
  const validNonces = new Set<number>();
  for (const unknown of rows) {
    const parsed = rowSchema.safeParse(unknown);
    if (!parsed.success) { issueCounts.corrupt_intent++; continue; }
    const row = parsed.data;
    try {
      const raw = row.raw as TransactionSerialized;
      const transaction = parseTransaction(raw);
      if (row.chainId !== expected.chainId || row.sender.toLowerCase() !== signer
        || row.nonce < expected.initialNonce
        || transaction.chainId !== expected.chainId || transaction.nonce !== row.nonce
        || transaction.to?.toLowerCase() !== row.to.toLowerCase()
        || (transaction.data ?? '0x').toLowerCase() !== row.data.toLowerCase()
        || (transaction.value ?? 0n) !== 0n || keccak256(raw).toLowerCase() !== row.hash.toLowerCase()
        || !recognizedIntent(row, expected)
        || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== signer) {
        issueCounts.corrupt_intent++; continue;
      }
    } catch { issueCounts.corrupt_intent++; continue; }
    validNonces.add(row.nonce);
    try {
      const receipt = await rpc.getTransactionReceipt(row.hash as Hex);
      if (receipt) {
        if (receipt.blockNumber > reference.number) issueCounts.receipt_outside_anchor++;
        else if (receipt.transactionHash.toLowerCase() !== row.hash.toLowerCase()
          || receipt.to?.toLowerCase() !== row.to.toLowerCase()
          || (await rpc.getBlockHash(receipt.blockNumber)).toLowerCase() !== receipt.blockHash.toLowerCase()) {
          issueCounts.receipt_noncanonical++;
        } else if (receipt.status !== 'success') issueCounts.receipt_reverted++;
        continue;
      }
      issueCounts[latestNonce > row.nonce ? 'nonce_consumed' : 'receipt_missing']++;
    } catch { issueCounts.rpc_unavailable++; }
  }
  if (latestNonce < expected.initialNonce || latestNonce - expected.initialNonce > 4096) issueCounts.nonce_gap++;
  else {
    const covered = [...validNonces].filter(nonce => nonce >= expected.initialNonce && nonce < latestNonce).length;
    issueCounts.nonce_gap = latestNonce - expected.initialNonce - covered;
  }
  try {
    if (await rpc.getLatestNonce(signer as `0x${string}`) !== latestNonce) issueCounts.nonce_changed++;
    if ((await rpc.getBlockHash(reference.number)).toLowerCase() !== reference.hash.toLowerCase()) issueCounts.anchor_reorged++;
  } catch { issueCounts.rpc_unavailable++; }
  return { status: Object.values(issueCounts).some(value => value > 0) ? 'critical' : 'ok', rows: rows.length, issueCounts };
}
