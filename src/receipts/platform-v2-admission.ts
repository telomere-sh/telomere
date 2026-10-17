import { and, eq, sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { keccak256, toHex, verifyTypedData } from 'viem';
import { addressSchema, bytes32Schema, canonical, hashJson, randomId, sameAddress, signatureSchema } from '../common.js';
import { hostMessageHash, signedLeaseSchema, verifyHostMessage, type SignedHostLease } from '../host-kit/protocol.js';
import type { PlatformBridge } from '../platform-runtime/bridge.js';
import { platformHostLeases, platformRuns } from '../platform-runtime/schema.js';
import { platformQuoteDomainVersion, platformQuoteSchema, platformQuoteTypes, platformWorkloadHash,
  typedPlatformQuote } from '../platform-runtime/types.js';
import type { Database } from '../store.js';
import { hostV2AdmissionEnvelopeSchema, hostV2AdmissionReceiptSchema,
  type HostV2AdmissionEnvelope, type SignedHostV2AdmissionReceipt } from '../host-kit/v2-admission.js';
import { platformV2DelegationSchema, platformV2DelegationTypedData,
  signedPlatformV2DelegationSchema, type SignedPlatformV2Delegation } from './platform-v2.js';

export type PlatformV2AdmissionRequest = Readonly<{ owner: string; hostId: string;
  controllerKey: string; lease: SignedHostLease }>;
export type PlatformV2AdmissionHook = Readonly<{
  issueBeforeHostAdmission(request: PlatformV2AdmissionRequest): Promise<SignedPlatformV2Delegation>;
  prepareHostAdmission?(request: PlatformV2AdmissionRequest): Promise<HostV2AdmissionEnvelope | undefined>;
  recordHostAdmission?(envelope: HostV2AdmissionEnvelope, admission: SignedHostV2AdmissionReceipt): Promise<void>;
  originalHostAdmission?(runId: string): Promise<{ envelope: HostV2AdmissionEnvelope;
    admission: SignedHostV2AdmissionReceipt | undefined } | undefined>;
}>;

/** Private exact transport intent. Contains argv/stdin and must never be returned by a public evidence route. */
export const platformV2HostAdmissions = pgTable('platform_v2_host_admissions', {
  scope: text().notNull(), runId: text().notNull(),
  envelope: jsonb().$type<HostV2AdmissionEnvelope>().notNull(),
  admission: jsonb().$type<SignedHostV2AdmissionReceipt>(),
}, table => [primaryKey({ columns: [table.scope, table.runId] })]);
const hostDdl = `CREATE TABLE IF NOT EXISTS platform_v2_host_admissions (
 scope text NOT NULL, run_id text NOT NULL, envelope jsonb NOT NULL,
 admission jsonb, PRIMARY KEY(scope,run_id)
);`;

/** Opt-in private certificate journal. Live migrations do not mount this table. */
export const platformV2AdmissionDelegations = pgTable('platform_v2_admission_delegations', {
  scope: text().notNull(), runId: text().notNull(), admissionTx: text().notNull(),
  signedLeaseHash: text().notNull(), delegation: jsonb().$type<SignedPlatformV2Delegation>().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.scope, table.runId] })]);
const ddl = `CREATE TABLE IF NOT EXISTS platform_v2_admission_delegations (
 scope text NOT NULL, run_id text NOT NULL, admission_tx text NOT NULL,
 signed_lease_hash text NOT NULL, delegation jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,run_id)
);`;

/**
 * The host executor calls this only after storing the signed lease and before
 * sending the first HostKit admission. The database time is operational audit
 * data, not an independently verifiable historical timestamp.
 */
export class PlatformV2AdmissionJournal implements PlatformV2AdmissionHook {
  readonly scope: string;
  constructor(private readonly db: Database, private readonly bridge: PlatformBridge,
    private readonly enableHostTransport = false) {
    const pins = bridge.pins;
    this.scope = hashJson({ protocol: 'telomere-platform-v2-admission', chainId: pins.chainId,
      escrow: pins.escrowAddress.toLowerCase(), hostRegistry: pins.hostRegistryAddress.toLowerCase() });
  }
  async initialize(): Promise<void> {
    await this.db.execute(sql.raw(ddl));
    if (this.enableHostTransport) await this.db.execute(sql.raw(hostDdl));
  }
  private checkHostReceipt(envelope: HostV2AdmissionEnvelope, raw: SignedHostV2AdmissionReceipt) {
    const admission = hostV2AdmissionReceiptSchema.parse(raw), body = admission.body;
    const delegation = envelope.delegation.body, lease = envelope.lease;
    if (!verifyHostMessage(delegation.hostKey, 'v2-admission', admission)
      || body.chainId !== delegation.chainId || !sameAddress(body.escrow, delegation.escrow)
      || !sameAddress(body.hostRegistry, delegation.hostRegistry)
      || body.runId !== delegation.runId || body.hostId !== delegation.hostId
      || body.hostKey !== delegation.hostKey || body.controllerKey !== delegation.controllerKey
      || body.owner !== lease.body.owner || body.admissionTx !== envelope.admissionTx
      || body.quoteHash !== hashJson(envelope.quote) || body.signedLeaseHash !== hostMessageHash(lease)
      || body.meterLeaseHash !== hostMessageHash({ body: lease.body, signature: '' })
      || body.delegationHash !== hashJson(envelope.delegation) || body.envelopeHash !== hashJson(envelope)
      || body.acceptedAtMs < lease.body.issuedAt - 5000 || body.acceptedAtMs > lease.body.expiresAt) {
      throw new Error('Platform v2 host admission signature or exact envelope changed');
    }
    return admission;
  }
  async originalHostAdmission(runValue: string) {
    if (!this.enableHostTransport) return undefined;
    const runId = bytes32Schema.parse(runValue);
    const [saved] = await this.db.select().from(platformV2HostAdmissions)
      .where(and(eq(platformV2HostAdmissions.scope, this.scope), eq(platformV2HostAdmissions.runId, runId))).limit(1);
    if (!saved) return undefined;
    const envelope = hostV2AdmissionEnvelopeSchema.parse(saved.envelope);
    const authority = await this.get(runId);
    const delegated = envelope.delegation.body, lease = envelope.lease.body;
    const [run] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, runId)).limit(1);
    const [host] = await this.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, runId)).limit(1);
    if (!authority || !run || !host || run.receiptVersion !== 2
      || envelope.quote.runId !== runId || envelope.admissionTx !== authority.admissionTx
      || run.admissionTx !== envelope.admissionTx || canonical(envelope.delegation) !== canonical(authority.delegation)
      || canonical(envelope.quote) !== canonical(run.quote) || envelope.quoteSignature !== run.signature
      || hashJson(run.input) !== run.inputHash || platformWorkloadHash(run.input) !== envelope.quote.workloadHash
      || run.input.near || run.nearResult || ['session', 'near_inference'].includes(run.input.task.kind)
      || host.leaseHash !== authority.signedLeaseHash || canonical(host.lease) !== canonical(envelope.lease)
      || host.hostId !== envelope.quote.hostId || host.owner !== run.owner
      || authority.signedLeaseHash !== hostMessageHash(envelope.lease)
      || delegated.quoteHash !== hashJson(envelope.quote) || delegated.runId !== runId
      || delegated.hostId !== host.hostId || delegated.hostKey !== lease.hostKey
      || delegated.meterLeaseHash !== hostMessageHash({ body: lease, signature: '' })
      || delegated.leaseIssuedAtMs !== lease.issuedAt || delegated.leaseExpiresAtMs !== lease.expiresAt
      || delegated.maxSeconds !== lease.maxSeconds || lease.maxSeconds !== envelope.quote.maxSeconds
      || lease.runId !== runId || lease.owner !== run.owner || !sameAddress(run.owner, envelope.quote.payer)
      || !verifyHostMessage(authority.delegation.body.controllerKey, 'lease', envelope.lease)) {
      throw new Error('Platform v2 original host admission transport journal changed');
    }
    const admission = saved.admission === null ? undefined : this.checkHostReceipt(envelope, saved.admission);
    if (admission && host.ticks[0] && admission.body.acceptedAtMs > host.ticks[0].body.timestamp) {
      throw new Error('Platform v2 host admission was recorded after the first signed tick');
    }
    return { envelope, admission };
  }
  async prepareHostAdmission(raw: PlatformV2AdmissionRequest) {
    if (!this.enableHostTransport) {
      await this.issueBeforeHostAdmission(raw);
      return undefined;
    }
    const runId = bytes32Schema.parse(raw.lease.body.runId);
    const [row] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, runId)).limit(1);
    if (!row) throw new Error('Platform v2 host admission requires the original paid run');
    if (row.receiptVersion === 1) return undefined;
    if (row.receiptVersion !== 2) throw new Error('Platform host admission receipt version is unsupported');
    const delegation = await this.issueBeforeHostAdmission(raw);
    const envelope = hostV2AdmissionEnvelopeSchema.parse({ version: 2,
      admissionTx: row.admissionTx, lease: raw.lease, quote: row.quote,
      quoteSignature: row.signature, delegation });
    await this.db.insert(platformV2HostAdmissions).values({ scope: this.scope, runId, envelope }).onConflictDoNothing();
    const saved = await this.originalHostAdmission(runId);
    if (!saved || canonical(saved.envelope) !== canonical(envelope)) {
      throw new Error('Platform v2 host admission conflicts with the original transport intent');
    }
    return saved.envelope;
  }
  async recordHostAdmission(envelopeValue: HostV2AdmissionEnvelope, admissionValue: SignedHostV2AdmissionReceipt): Promise<void> {
    if (!this.enableHostTransport) throw new Error('Platform v2 host admission transport is disabled');
    const envelope = hostV2AdmissionEnvelopeSchema.parse(envelopeValue), runId = envelope.quote.runId;
    const admission = this.checkHostReceipt(envelope, admissionValue);
    const original = await this.originalHostAdmission(runId);
    if (!original || canonical(original.envelope) !== canonical(envelope)
      || original.admission && canonical(original.admission) !== canonical(admission)) {
      throw new Error('Platform v2 host receipt conflicts with its original transport intent');
    }
    await this.db.update(platformV2HostAdmissions).set({ admission })
      .where(and(eq(platformV2HostAdmissions.scope, this.scope), eq(platformV2HostAdmissions.runId, runId),
        sql`${platformV2HostAdmissions.admission} IS NULL`));
    const saved = await this.originalHostAdmission(runId);
    if (!saved?.admission || canonical(saved.admission) !== canonical(admission)) {
      throw new Error('Platform v2 host admission response was not durably read back');
    }
  }
  async get(runValue: string) {
    const runId = bytes32Schema.parse(runValue);
    const [row] = await this.db.select().from(platformV2AdmissionDelegations)
      .where(and(eq(platformV2AdmissionDelegations.scope, this.scope),
        eq(platformV2AdmissionDelegations.runId, runId))).limit(1);
    if (!row) return undefined;
    const delegation = signedPlatformV2DelegationSchema.parse(row.delegation), body = delegation.body;
    const pins = this.bridge.pins;
    if (body.runId !== runId || body.chainId !== pins.chainId
      || !sameAddress(body.escrow, pins.escrowAddress)
      || !sameAddress(body.hostRegistry, pins.hostRegistryAddress)
      || row.signedLeaseHash !== body.signedLeaseHash
      || !await verifyTypedData({ address: pins.quoteSigner,
        ...platformV2DelegationTypedData(body), signature: delegation.signature })) {
      throw new Error('Platform v2 pre-admission certificate journal changed');
    }
    return { runId, admissionTx: bytes32Schema.parse(row.admissionTx),
      signedLeaseHash: bytes32Schema.parse(row.signedLeaseHash), delegation,
      createdAt: row.createdAt };
  }
  async issueBeforeHostAdmission(raw: PlatformV2AdmissionRequest): Promise<SignedPlatformV2Delegation> {
    const owner = addressSchema.parse(raw.owner), hostId = bytes32Schema.parse(raw.hostId);
    const lease = signedLeaseSchema.parse(raw.lease), runId = lease.body.runId;
    const controllerKey = bytes32Schema.parse(raw.controllerKey);
    const [row] = await this.db.select().from(platformRuns).where(eq(platformRuns.id, runId)).limit(1);
    const [persisted] = await this.db.select().from(platformHostLeases)
      .where(eq(platformHostLeases.runId, runId)).limit(1);
    if (row?.input.task.kind === 'session') {
      throw new Error('Platform v2 admission currently supports one-shot CPU runs, not paid sessions');
    }
    if (!row || !persisted || row.status !== 'running' || !row.admissionTx || row.result || row.settlement
      || row.input.near || row.nearResult || row.input.task.kind === 'near_inference'
      || !sameAddress(row.owner, owner) || !sameAddress(lease.body.owner, owner)
      || persisted.hostId !== hostId || persisted.owner !== owner.toLowerCase()
      || persisted.cleanupConfirmed !== 0 || persisted.ticks.length !== 0
      || persisted.acknowledgments.length !== 0 || !verifyHostMessage(controllerKey, 'lease', lease)
      || persisted.leaseHash !== hostMessageHash(lease)
      || canonical(persisted.lease) !== canonical(lease)) {
      throw new Error('Platform v2 delegation requires the original durable pre-admission HostKit lease');
    }
    const quote = platformQuoteSchema.parse(row.quote);
    if (row.id !== quote.runId || quote.hostId !== hostId || !sameAddress(quote.payer, owner)
      || lease.body.maxSeconds !== quote.maxSeconds || lease.body.hostKey !== persisted.lease.body.hostKey
      || hashJson(row.input) !== row.inputHash || platformWorkloadHash(row.input) !== quote.workloadHash
      || quote.inferencePrice !== '0'
      || keccak256(toHex(lease.body.image.split('@')[1]!)) !== quote.imageHash) {
      throw new Error('Platform v2 original quote or workload differs from the signed lease');
    }
    const pins = this.bridge.pins;
    await this.bridge.check();
    await this.bridge.verifyAdmission(quote, row.ceiling, bytes32Schema.parse(row.admissionTx));
    const stillRunnable = async () => {
      const [registered, run, leashState, block] = await Promise.all([
        this.bridge.host(hostId), this.bridge.run(runId), this.bridge.leash(quote.leashId),
        this.bridge.public.getBlock()]);
      if (!registered.active || registered.kind !== 0 || registered.gpu
        || registered.hostKey !== lease.body.hostKey || !this.bridge.matches(quote, run)
        || run.status !== 1 || run.stopAt !== 0n || run.hostReleased
        || !sameAddress(leashState.owner, owner) || leashState.killed
        || leashState.expiry <= block.timestamp || block.timestamp >= run.acceptedExpiry
        || block.timestamp >= run.openedAt + run.maxSeconds
        || block.timestamp >= BigInt(row.input.deadline)) {
        throw new Error('Platform v2 canonical run, leash or host authority is no longer runnable');
      }
      return run;
    };
    const run = await stillRunnable();
    if (lease.body.issuedAt < Number(run.openedAt) * 1000 - 5000
      || lease.body.issuedAt > Number(run.acceptedExpiry) * 1000
      || Math.abs(lease.body.issuedAt - Date.now()) > 5000
      || !await verifyTypedData({ address: pins.quoteSigner,
        domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(pins), chainId: pins.chainId,
          verifyingContract: pins.escrowAddress }, types: platformQuoteTypes,
        primaryType: 'PlatformQuote', message: typedPlatformQuote(quote),
        signature: signatureSchema.parse(row.signature) })) {
      throw new Error('Platform v2 canonical admission, host authority or quote signature changed');
    }
    const signedLeaseHash = hostMessageHash(lease), admissionTx = bytes32Schema.parse(row.admissionTx);
    const previous = await this.get(runId);
    if (previous) {
      const body = previous.delegation.body;
      if (previous.admissionTx !== admissionTx || previous.signedLeaseHash !== signedLeaseHash
        || body.hostId !== hostId || body.controllerKey !== controllerKey
        || body.quoteHash !== hashJson(quote)) {
        throw new Error('Platform v2 pre-admission certificate conflicts with the original lease');
      }
      await stillRunnable();
      return previous.delegation;
    }
    const body = platformV2DelegationSchema.parse({ version: 2, chainId: pins.chainId,
      escrow: pins.escrowAddress, hostRegistry: pins.hostRegistryAddress,
      runId, hostId, hostKey: lease.body.hostKey, controllerKey,
      quoteHash: hashJson(quote), signedLeaseHash,
      meterLeaseHash: hostMessageHash({ body: lease.body, signature: '' }),
      leaseIssuedAtMs: lease.body.issuedAt, leaseExpiresAtMs: lease.body.expiresAt,
      maxSeconds: lease.body.maxSeconds, nonce: randomId() });
    const delegation = signedPlatformV2DelegationSchema.parse({ body,
      signature: await this.bridge.account.signTypedData(platformV2DelegationTypedData(body)) });
    await this.db.insert(platformV2AdmissionDelegations).values({ scope: this.scope,
      runId, admissionTx, signedLeaseHash, delegation }).onConflictDoNothing();
    const saved = await this.get(runId);
    if (!saved || saved.admissionTx !== admissionTx || saved.signedLeaseHash !== signedLeaseHash
      || canonical(saved.delegation) !== canonical(delegation)) {
      throw new Error('Platform v2 certificate conflicts with an existing durable pre-admission record');
    }
    // One final current-chain read narrows the RPC-to-HostKit admission window.
    // A subsequent stop/kill still needs normal runtime monitoring and recovery.
    await stillRunnable();
    return saved.delegation;
  }
}
