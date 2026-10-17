import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { z } from 'zod';
import { bytes32Schema } from '../common.js';

export const RECEIPT_TREE_ALGORITHM = 'double-keccak-receipt-v1' as const;
export const MAX_HOUR_RECEIPTS = 4096;
export const ZERO_RECEIPT_ROOT = `0x${'0'.repeat(64)}` as Hex;
export const receiptHourSchema = z.number().int().min(0).max(2_399_999_999);
export function receiptLeaf(receiptHash: Hex): Hex {
  return keccak256(keccak256(encodeAbiParameters([{ type: 'bytes32' }], [bytes32Schema.parse(receiptHash)])));
}
export function receiptPair(left: Hex, right: Hex): Hex {
  const a = bytes32Schema.parse(left), b = bytes32Schema.parse(right);
  return keccak256(concat(a < b ? [a, b] : [b, a]));
}
export function receiptTree(input: readonly Hex[]): { root: Hex; leaves: Hex[]; proof(index: number): Hex[] } {
  if (input.length > MAX_HOUR_RECEIPTS) throw new Error('Receipt tree exceeds its leaf limit');
  const leaves = input.map(value => bytes32Schema.parse(value));
  if (new Set(leaves).size !== leaves.length) throw new Error('Receipt leaves must be unique');
  const levels: Hex[][] = [leaves];
  while ((levels.at(-1)?.length ?? 0) > 1) {
    const prior = levels.at(-1) ?? [], next: Hex[] = [];
    for (let index = 0; index < prior.length; index += 2) {
      const left = prior[index]; if (!left) throw new Error('Missing receipt leaf');
      const right = prior[index + 1]; next.push(right ? receiptPair(left, right) : left);
    }
    levels.push(next);
  }
  return { root: levels.at(-1)?.[0] ?? ZERO_RECEIPT_ROOT, leaves,
    proof(index: number): Hex[] {
      if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length) throw new Error('Invalid receipt leaf index');
      let position = index; const proof: Hex[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = level[position ^ 1]; if (sibling) proof.push(sibling);
        position = Math.floor(position / 2);
      }
      return proof;
    } };
}
export function verifyReceiptPath(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  if (proof.length > 12) return false;
  try { return proof.reduce((node, sibling) => receiptPair(node, sibling), bytes32Schema.parse(leaf)) === bytes32Schema.parse(root); }
  catch { return false; }
}
