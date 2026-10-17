import { getAddress, keccak256, recoverTypedDataAddress, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, moneySchema, signatureSchema } from '../common.js';
import { validatedPlatformQuoteInputSchema, platformQuoteSchema, platformQuoteTypes, platformWorkloadHash,
  typedPlatformQuote } from '../platform-runtime/types.js';
import { platformVaultBindingSchema } from '../platform-runtime/vault.js';

const rowSchema = z.object({
  id: bytes32Schema, owner: addressSchema, agent: addressSchema, inputHash: bytes32Schema,
  input: validatedPlatformQuoteInputSchema, quote: platformQuoteSchema, signature: signatureSchema,
  ceiling: moneySchema, vaultBinding: platformVaultBindingSchema.nullable(),
  status: z.literal('prepared'), admissionTx: z.null(), settlementTx: z.null(),
  settlement: z.null(), charged: z.null(), refund: z.null(),
}).strict();

export type PlatformPreparedAuditRow = z.output<typeof rowSchema>;
export type PlatformPreparedAuditPins = {
  chainId: number; escrow: string; escrowCodeHash: Hex; quoteSigner: string;
  token: string; receiptRoot: string; hostRegistry: string; feeRouter: string;
  referenceBlock: bigint; referenceHash: Hex;
};
export type PlatformPreparedRun = {
  status: number; payer: string; leashId: string; hostId: string; hwClass: number;
  regionHash: string; imageHash: string; workloadHash: string; sealedHost: boolean;
  maxSeconds: bigint; pricePerSecond: bigint; inferencePrice: bigint; ceiling: bigint;
};
export type PlatformPreparedAuditRpc = {
  getBlockHash(block: bigint): Promise<Hex>;
  getEscrowCode(block: bigint): Promise<Hex | undefined>;
  getEscrowIdentity(block: bigint): Promise<{ quoteSigner: string; token: string; receiptRoot: string;
    hostRegistry: string; feeRouter: string }>;
  getLeash(leashId: Hex, block: bigint): Promise<{ owner: string; agent: string }>;
  getRun(runId: Hex, block: bigint): Promise<PlatformPreparedRun>;
  getQuoteCeiling(quote: z.output<typeof platformQuoteSchema>, block: bigint): Promise<bigint>;
};

export type PlatformPreparedAuditCounts = {
  unopened: number; open_unadmitted: number; refunded_unrecorded: number; settled_unrecorded: number;
  quote_ceiling_mismatch: number; invalid_row: number; unexpected_status: number;
  leash_binding_mismatch: number;
  rpc_unavailable: number; pin_mismatch: number; anchor_reorged: number; database_changed: number;
};
export type PlatformPreparedAuditResult = { status: 'ok' | 'critical'; rows: number;
  counts: PlatformPreparedAuditCounts };

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const emptyCounts = (): PlatformPreparedAuditCounts => ({ unopened: 0, open_unadmitted: 0,
  refunded_unrecorded: 0, settled_unrecorded: 0, quote_ceiling_mismatch: 0,
  invalid_row: 0, unexpected_status: 0, leash_binding_mismatch: 0,
  rpc_unavailable: 0, pin_mismatch: 0, anchor_reorged: 0,
  database_changed: 0 });
const report = (rows: number, counts: PlatformPreparedAuditCounts): PlatformPreparedAuditResult => ({
  status: Object.entries(counts).some(([key, count]) => key !== 'unopened' && count > 0) ? 'critical' : 'ok',
  rows, counts,
});

function matchesRun(quote: z.output<typeof platformQuoteSchema>, ceiling: bigint, run: PlatformPreparedRun): boolean {
  return same(run.payer, quote.payer) && run.leashId.toLowerCase() === quote.leashId
    && run.hostId.toLowerCase() === quote.hostId && run.hwClass === quote.hwClass
    && run.regionHash.toLowerCase() === quote.regionHash && run.imageHash.toLowerCase() === quote.imageHash
    && run.workloadHash.toLowerCase() === quote.workloadHash && run.maxSeconds === BigInt(quote.maxSeconds)
    && run.pricePerSecond === BigInt(quote.pricePerSecond)
    && run.inferencePrice === BigInt(quote.inferencePrice)
    && !run.sealedHost && run.ceiling === ceiling;
}

/** Manual, bounded, read-only comparison of every prepared DB quote against one reviewed historical chain block. */
export async function auditPreparedPlatformRuns(rows: unknown[], pins: PlatformPreparedAuditPins,
  rpc: PlatformPreparedAuditRpc): Promise<PlatformPreparedAuditResult> {
  if (rows.length > 1024 || !Number.isSafeInteger(pins.chainId) || pins.chainId <= 0 || pins.referenceBlock < 0n
    || !hash.safeParse(pins.referenceHash).success || !hash.safeParse(pins.escrowCodeHash).success) {
    throw new Error('Prepared-run audit requires reviewed chain/block pins and at most 1024 rows');
  }
  for (const value of [pins.escrow, pins.quoteSigner, pins.token, pins.receiptRoot,
    pins.hostRegistry, pins.feeRouter]) getAddress(value);
  const counts = emptyCounts();
  try {
    const [blockHash, code, identity] = await Promise.all([
      rpc.getBlockHash(pins.referenceBlock), rpc.getEscrowCode(pins.referenceBlock),
      rpc.getEscrowIdentity(pins.referenceBlock),
    ]);
    if (!same(blockHash, pins.referenceHash)) counts.anchor_reorged++;
    if (!code || code === '0x' || !same(keccak256(code), pins.escrowCodeHash)
      || !same(identity.quoteSigner, pins.quoteSigner) || !same(identity.token, pins.token)
      || !same(identity.receiptRoot, pins.receiptRoot) || !same(identity.hostRegistry, pins.hostRegistry)
      || !same(identity.feeRouter, pins.feeRouter)) counts.pin_mismatch++;
  } catch { counts.rpc_unavailable++; }
  if (counts.anchor_reorged || counts.pin_mismatch || counts.rpc_unavailable) return report(rows.length, counts);

  const seen = new Set<string>();
  for (const unknown of rows) {
    const parsed = rowSchema.safeParse(unknown);
    if (!parsed.success) { counts.invalid_row++; continue; }
    const row = parsed.data, quote = row.quote, id = row.id.toLowerCase();
    if (seen.has(id)) { counts.invalid_row++; continue; }
    seen.add(id);
    if (id !== quote.runId || !same(row.owner, quote.payer) || row.inputHash !== hashJson(row.input)
      || row.input.leashId !== quote.leashId || row.input.maxSeconds !== quote.maxSeconds
      || platformWorkloadHash(row.input) !== quote.workloadHash
      || (row.input.near !== undefined) !== (BigInt(quote.inferencePrice) > 0n)
      || BigInt(row.ceiling) === 0n || BigInt(row.ceiling) > 250_000_000n
      || BigInt(row.ceiling) > BigInt(row.input.maxSpend)
      || BigInt(quote.quoteExpiry) + BigInt(quote.maxSeconds) > BigInt(row.input.deadline)
      || row.vaultBinding && (!same(row.vaultBinding.vault, quote.payer)
        || row.vaultBinding.leashId !== quote.leashId)) {
      counts.quote_ceiling_mismatch++; continue;
    }
    try {
      const signer = await recoverTypedDataAddress({
        domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: pins.chainId, verifyingContract: getAddress(pins.escrow) },
        primaryType: 'PlatformQuote', types: platformQuoteTypes, message: typedPlatformQuote(quote), signature: row.signature,
      });
      if (!same(signer, pins.quoteSigner)) { counts.quote_ceiling_mismatch++; continue; }
    } catch { counts.quote_ceiling_mismatch++; continue; }
    try {
      const leash = await rpc.getLeash(quote.leashId, pins.referenceBlock);
      if (!same(leash.owner, row.owner) || !same(leash.agent, row.agent)) {
        counts.leash_binding_mismatch++; continue;
      }
      const run = await rpc.getRun(row.id, pins.referenceBlock);
      if (run.status === 0) {
        const ceiling = await rpc.getQuoteCeiling(quote, pins.referenceBlock);
        counts[ceiling === BigInt(row.ceiling) ? 'unopened' : 'quote_ceiling_mismatch']++;
      } else if (![1, 2, 3].includes(run.status)) counts.unexpected_status++;
      else if (!matchesRun(quote, BigInt(row.ceiling), run)) counts.quote_ceiling_mismatch++;
      else counts[run.status === 1 ? 'open_unadmitted' : run.status === 2
        ? 'settled_unrecorded' : 'refunded_unrecorded']++;
    } catch { counts.rpc_unavailable++; }
  }
  try { if (!same(await rpc.getBlockHash(pins.referenceBlock), pins.referenceHash)) counts.anchor_reorged++; }
  catch { counts.rpc_unavailable++; }
  return report(rows.length, counts);
}
