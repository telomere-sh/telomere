import { and, eq, sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { keccak256, toHex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, canonical, hashJson, sameAddress } from '../common.js';
import { hostMessageHash, verifyHostMessage } from '../host-kit/protocol.js';
import { PAID_SESSION_ARGV } from '../host-kit/sessions/paid-protocol.js';
import { hostV2AdmissionEnvelopeSchema, hostV2AdmissionReceiptSchema } from '../host-kit/v2-admission.js';
import type { Database } from '../store.js';
import { platformV2EvidenceCoreSchema, platformV2EvidenceDigest, platformV2ReceiptHash,
  verifyPlatformV2EvidenceCore, type PlatformV2EvidenceCore,
  type PlatformV2HistoricalAuthority } from './platform-v2.js';

/** Private witness: the signed lease may contain argv and stdin. Never serve this row as a public core. */
export const platformV2AdmissionWitnessSchema = z.object({
  protocol: z.literal('telomere-platform-v2-admission-witness'),
  receiptHash: bytes32Schema, evidenceCoreDigest: bytes32Schema,
  openingTransactionHash: bytes32Schema, openingBlockHash: bytes32Schema,
  envelope: hostV2AdmissionEnvelopeSchema, admission: hostV2AdmissionReceiptSchema,
}).strict();
export type PlatformV2AdmissionWitness = z.infer<typeof platformV2AdmissionWitnessSchema>;

/**
 * Checks host testimony against the original private envelope and the unchanged
 * public v2 core. The supplied historical authority/opening must be checked by
 * the archive reader separately; this witness has no independent timestamp.
 */
export async function verifyPlatformV2AdmissionWitness(raw: unknown,
  coreValue: PlatformV2EvidenceCore, historical: PlatformV2HistoricalAuthority,
  opening: { transactionHash: string; blockHash: string }) {
  const witness = platformV2AdmissionWitnessSchema.parse(raw);
  const core = platformV2EvidenceCoreSchema.parse(coreValue);
  const { envelope, admission } = witness;
  const lease = envelope.lease, delegation = core.delegation.body, body = admission.body;
  const receiptHash = platformV2ReceiptHash(core);
  const evidenceCoreDigest = platformV2EvidenceDigest(core);
  if (witness.receiptHash !== receiptHash || witness.evidenceCoreDigest !== evidenceCoreDigest
    || witness.openingTransactionHash !== bytes32Schema.parse(opening.transactionHash)
    || witness.openingBlockHash !== bytes32Schema.parse(opening.blockHash)
    || envelope.admissionTx !== witness.openingTransactionHash
    || canonical(envelope.quote) !== canonical(core.quote)
    || envelope.quoteSignature !== core.quoteSignature
    || canonical(envelope.delegation) !== canonical(core.delegation)
    || core.hostAdmission && canonical(admission) !== canonical(core.hostAdmission)) {
    throw new Error('Platform v2 admission witness differs from the original core or opening');
  }
  await verifyPlatformV2EvidenceCore(core, receiptHash, historical);
  const signedLeaseHash = hostMessageHash(lease);
  const meterLeaseHash = hostMessageHash({ body: lease.body, signature: '' });
  if (!verifyHostMessage(delegation.controllerKey, 'lease', lease)
    || lease.body.runId !== delegation.runId || lease.body.hostKey !== delegation.hostKey
    || !sameAddress(lease.body.owner, core.quote.payer)
    || lease.body.maxSeconds !== delegation.maxSeconds
    || keccak256(toHex(lease.body.image.split('@')[1]!)) !== core.quote.imageHash
    || (lease.body.argv.length === PAID_SESSION_ARGV.length
      && lease.body.argv.every((value, index) => value === PAID_SESSION_ARGV[index]))
    || lease.body.issuedAt !== delegation.leaseIssuedAtMs
    || lease.body.expiresAt !== delegation.leaseExpiresAtMs
    || signedLeaseHash !== delegation.signedLeaseHash
    || meterLeaseHash !== delegation.meterLeaseHash) {
    throw new Error('Platform v2 admission witness has a different original signed lease');
  }
  if (!verifyHostMessage(delegation.hostKey, 'v2-admission', admission)
    || body.chainId !== delegation.chainId
    || !sameAddress(body.escrow, delegation.escrow)
    || !sameAddress(body.hostRegistry, delegation.hostRegistry)
    || body.runId !== delegation.runId || body.hostId !== delegation.hostId
    || body.hostKey !== delegation.hostKey || body.controllerKey !== delegation.controllerKey
    || !sameAddress(body.owner, core.quote.payer)
    || body.admissionTx !== witness.openingTransactionHash
    || body.openingBlockHash !== witness.openingBlockHash
    || body.quoteHash !== delegation.quoteHash
    || body.signedLeaseHash !== signedLeaseHash || body.meterLeaseHash !== meterLeaseHash
    || body.delegationHash !== hashJson(core.delegation)
    || body.envelopeHash !== hashJson(envelope)
    || body.acceptedAtMs < lease.body.issuedAt - 5_000
    || body.acceptedAtMs > lease.body.expiresAt
    || body.acceptedAtMs > historical.cutoff * 1000
    || body.acceptedAtMs > core.ticks[0]!.body.timestamp) {
    throw new Error('Platform v2 host admission signature, scope or tick ordering changed');
  }
  return { witness, witnessHash: hashJson(witness), receiptHash, evidenceCoreDigest,
    hostAdmissionVerified: true as const, onchainReceiptVerified: false as const,
    independentlyPublished: false as const, historicalDelegationIssuanceTimeProven: false as const };
}

export const platformV2AdmissionWitnessRows = pgTable('platform_v2_admission_witnesses', {
  scope: text().notNull(), runId: text().notNull(), witnessHash: text().notNull(),
  witness: jsonb().$type<PlatformV2AdmissionWitness>().notNull(),
}, table => [primaryKey({ columns: [table.scope, table.runId] })]);
const ddl = `CREATE TABLE IF NOT EXISTS platform_v2_admission_witnesses (
 scope text NOT NULL, run_id text NOT NULL, witness_hash text NOT NULL,
 witness jsonb NOT NULL, PRIMARY KEY(scope,run_id)
);`;

/** Opt-in idempotency fence for one private host admission witness per run. */
export class PlatformV2AdmissionWitnessJournal {
  readonly scope: string;
  constructor(private readonly db: Database, chainId: number, escrow: string, hostRegistry: string) {
    if (![31337, 8453, 84532].includes(chainId)) throw new Error('Invalid Platform v2 witness chain');
    this.scope = hashJson({ protocol: 'telomere-platform-v2-admission-witness-scope', chainId,
      escrow: addressSchema.parse(escrow).toLowerCase(),
      hostRegistry: addressSchema.parse(hostRegistry).toLowerCase() });
  }
  async initialize(): Promise<void> { await this.db.execute(sql.raw(ddl)); }
  private assertScope(witness: PlatformV2AdmissionWitness, historical: PlatformV2HistoricalAuthority): void {
    const body = witness.envelope.delegation.body;
    const scope = hashJson({ protocol: 'telomere-platform-v2-admission-witness-scope',
      chainId: historical.chainId, escrow: addressSchema.parse(historical.escrow).toLowerCase(),
      hostRegistry: addressSchema.parse(historical.hostRegistry).toLowerCase() });
    if (scope !== this.scope || body.chainId !== historical.chainId
      || !sameAddress(body.escrow, historical.escrow)
      || !sameAddress(body.hostRegistry, historical.hostRegistry)) {
      throw new Error('Platform v2 admission witness belongs to a different deployment scope');
    }
  }
  async record(raw: unknown, core: PlatformV2EvidenceCore, historical: PlatformV2HistoricalAuthority,
    opening: { transactionHash: string; blockHash: string }) {
    const checked = await verifyPlatformV2AdmissionWitness(raw, core, historical, opening);
    this.assertScope(checked.witness, historical);
    const runId = checked.witness.envelope.quote.runId;
    await this.db.insert(platformV2AdmissionWitnessRows).values({ scope: this.scope, runId,
      witnessHash: checked.witnessHash, witness: checked.witness }).onConflictDoNothing();
    const saved = await this.get(runId, core, historical, opening);
    if (!saved || saved.witnessHash !== checked.witnessHash
      || canonical(saved.witness) !== canonical(checked.witness)) {
      throw new Error('Platform v2 admission witness conflicts with the original durable admission');
    }
    return saved;
  }
  async get(runValue: string, core: PlatformV2EvidenceCore, historical: PlatformV2HistoricalAuthority,
    opening: { transactionHash: string; blockHash: string }) {
    const runId = bytes32Schema.parse(runValue);
    const [row] = await this.db.select().from(platformV2AdmissionWitnessRows)
      .where(and(eq(platformV2AdmissionWitnessRows.scope, this.scope), eq(platformV2AdmissionWitnessRows.runId, runId))).limit(1);
    if (!row) return undefined;
    const checked = await verifyPlatformV2AdmissionWitness(row.witness, core, historical, opening);
    this.assertScope(checked.witness, historical);
    if (row.runId !== checked.witness.envelope.quote.runId || row.witnessHash !== checked.witnessHash) {
      throw new Error('Platform v2 durable admission witness changed after insertion');
    }
    return checked;
  }
}
