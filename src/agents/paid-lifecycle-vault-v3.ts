import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../common.js';
import { cystEnvelopeSchema } from '../cysts/types.js';
import { CystCheckpointFileVault } from '../sdk/cyst-checkpoints-file-vault.js';
import type { CystCheckpointJournal, CystCheckpointRecord, CystCheckpointScope, CystCheckpointVault } from '../sdk/cyst-checkpoints.js';
import { decryptCheckpoint, encryptCheckpoint } from '../sdk/cysts.js';
import { PaidLifecycleClientVault } from './paid-lifecycle-runner.js';

/** Explicit owner storage budget. Record bytes include the encrypted file header
 * and key, but exclude filesystem directory/lock metadata. No history is removed. */
export const paidLifecycleVaultV3PolicySchema = z.object({ version: z.literal(3), buckets: z.literal(64),
  maxRecordsPerBucket: z.literal(512), maxEncodedRecordBytes: z.literal(32_768),
  maxJournalBytes: z.literal(1_073_741_824) }).strict();
export type PaidLifecycleVaultV3Policy = z.infer<typeof paidLifecycleVaultV3PolicySchema>;
const recordId = z.string().regex(/^cyst-hook-[a-f0-9]{64}$/);
const payloadSchema = z.object({ protocol: z.literal('telomere-paid-lifecycle-private-record-v3'),
  scope: z.object({ owner: z.string(), agent: z.string(), applicationSchema: z.string() }).strict(),
  operationId: recordId, envelope: cystEnvelopeSchema,
  recoveryKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).strict();
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** The original owner scope remains the cross-process lock. Only record storage
 * is partitioned; changing the lock per record would break concurrent stop safety. */
class PartitionedLifecycleJournal implements CystCheckpointVault {
  constructor(private readonly storage: CystCheckpointFileVault, private readonly policy: PaidLifecycleVaultV3Policy) {}
  private partition(scope: CystCheckpointScope, id: string): CystCheckpointScope {
    const hash = digest(['telomere-paid-lifecycle-bucket-v3', scope, recordId.parse(id)]);
    const bucket = Number.parseInt(hash.slice(0, 2), 16) % this.policy.buckets;
    return { owner: scope.owner, agent: scope.agent,
      applicationSchema: 'pl3.' + digest(['telomere-paid-lifecycle-bucket-scope-v3', scope, bucket]).slice(0, 60) };
  }
  private async decode(scope: CystCheckpointScope, id: string, outer: CystCheckpointRecord): Promise<CystCheckpointRecord> {
    let key: Uint8Array | undefined;
    const bytes = await decryptCheckpoint(outer.envelope, outer.recoveryKey);
    try {
      const payload = payloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      key = Uint8Array.from(Buffer.from(payload.recoveryKey, 'base64'));
      if (payload.operationId !== id || canonical(payload.scope) !== canonical(scope) || key.byteLength !== 32
        || Buffer.from(key).toString('base64') !== payload.recoveryKey
        || payload.envelope.owner !== scope.owner || payload.envelope.agent !== scope.agent
        || payload.envelope.applicationSchema !== scope.applicationSchema) throw new Error('Private lifecycle partition changed its original record');
      const plaintext = await decryptCheckpoint(payload.envelope, key); plaintext.fill(0);
      return { envelope: payload.envelope, recoveryKey: Uint8Array.from(key) };
    } finally { bytes.fill(0); key?.fill(0); }
  }
  private async read(scope: CystCheckpointScope, id: string): Promise<CystCheckpointRecord | undefined> {
    return this.storage.exclusive(this.partition(scope, id), async journal => {
      const outer = await journal.checkpoint(id);
      if (!outer) return undefined;
      try { return await this.decode(scope, id, outer); } finally { outer.recoveryKey.fill(0); }
    });
  }
  private async save(scope: CystCheckpointScope, id: string, value: CystCheckpointRecord): Promise<void> {
    await this.storage.exclusive(this.partition(scope, id), journal => this.saveLocked(scope, id, value, journal));
  }
  private async saveLocked(scope: CystCheckpointScope, id: string, value: CystCheckpointRecord, journal: CystCheckpointJournal): Promise<void> {
    const prior = await journal.checkpoint(id);
    if (prior) {
      try {
        const decoded = await this.decode(scope, id, prior);
        try {
          if (canonical(decoded.envelope) !== canonical(value.envelope)
            || !Buffer.from(decoded.recoveryKey).equals(Buffer.from(value.recoveryKey))) throw new Error('Private lifecycle record is immutable');
        } finally { decoded.recoveryKey.fill(0); }
      } finally { prior.recoveryKey.fill(0); }
      return;
    }
    const payload = payloadSchema.parse({ protocol: 'telomere-paid-lifecycle-private-record-v3', scope,
      operationId: id, envelope: value.envelope, recoveryKey: Buffer.from(value.recoveryKey).toString('base64') });
    const plaintext = Buffer.from(JSON.stringify(payload));
    let generated: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
    try {
      generated = await encryptCheckpoint(plaintext, this.partition(scope, id));
      // CystCheckpointFileVault stores envelope JSON, a 32-byte key and a
      // 32-byte authenticated file header. This is a conservative byte cap.
      if (Buffer.byteLength(JSON.stringify(generated.envelope)) + 64 > this.policy.maxEncodedRecordBytes) {
        throw new Error('Private lifecycle record exceeds its reviewed storage budget');
      }
      await journal.saveCheckpoint(id, generated);
      const saved = await journal.checkpoint(id);
      if (!saved) throw new Error('Private lifecycle partition did not retain its original record');
      try {
        const decoded = await this.decode(scope, id, saved);
        try {
          if (canonical(decoded.envelope) !== canonical(value.envelope)
            || !Buffer.from(decoded.recoveryKey).equals(Buffer.from(value.recoveryKey))) throw new Error('Private lifecycle partition readback differs');
        } finally { decoded.recoveryKey.fill(0); }
      } finally { saved.recoveryKey.fill(0); }
    } finally { plaintext.fill(0); generated?.recoveryKey.fill(0); }
  }
  private claimId(kind: string): string {
    return 'cyst-hook-' + createHash('sha256').update(JSON.stringify(['telomere-paid-lifecycle-vault-v1', 'claim', kind])).digest('hex');
  }
  async claimJson(scope: CystCheckpointScope, kind: string, value: unknown): Promise<void> {
    const id = this.claimId(kind);
    await this.storage.exclusive(this.partition(scope, id), async journal => {
      const outer = await journal.checkpoint(id);
      if (outer) {
        try {
          const decoded = await this.decode(scope, id, outer);
          try {
            const bytes = await decryptCheckpoint(decoded.envelope, decoded.recoveryKey);
            try {
              if (canonical(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) !== canonical(value)) {
                throw new Error('Paid lifecycle operation is already bound to different original facts');
              }
            } finally { bytes.fill(0); }
          } finally { decoded.recoveryKey.fill(0); }
        } finally { outer.recoveryKey.fill(0); }
        return;
      }
      const bytes = Buffer.from(JSON.stringify(value));
      let generated: Awaited<ReturnType<typeof encryptCheckpoint>> | undefined;
      try {
        generated = await encryptCheckpoint(bytes, scope);
        await this.saveLocked(scope, id, generated, journal);
      } finally { bytes.fill(0); generated?.recoveryKey.fill(0); }
    });
  }
  async readJson(scope: CystCheckpointScope, kind: string): Promise<unknown | undefined> {
    const record = await this.read(scope, this.claimId(kind));
    if (!record) return undefined;
    try {
      const bytes = await decryptCheckpoint(record.envelope, record.recoveryKey);
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
      finally { bytes.fill(0); }
    } finally { record.recoveryKey.fill(0); }
  }
  exclusive<T>(scope: CystCheckpointScope, operation: (journal: CystCheckpointJournal) => Promise<T>): Promise<T> {
    return this.storage.exclusive(scope, async () => operation({
      load: async () => { throw new Error('Lifecycle v3 journal does not store cadence state'); },
      save: async () => { throw new Error('Use a separate run-bound cadence journal'); },
      checkpoint: id => this.read(scope, recordId.parse(id)),
      saveCheckpoint: (id, value) => this.save(scope, recordId.parse(id), value),
    }));
  }
}

/** Opt-in replacement for new lifecycle operations. The v1 class and existing
 * files keep their original format and behavior. Do not switch an in-flight
 * v1 operation to v3; finish it with its original journal first. */
export class PaidLifecycleClientVaultV3 extends PaidLifecycleClientVault {
  private readonly storage: CystCheckpointFileVault;
  private readonly partitioned: PartitionedLifecycleJournal;
  private readonly policyVault: PaidLifecycleClientVault;
  private readonly operationScope: CystCheckpointScope;
  private policyCheck: Promise<void> | undefined;
  readonly policy: Readonly<PaidLifecycleVaultV3Policy>;
  constructor(options: { directory: string; masterKey: Uint8Array; owner: string; agent: string;
    applicationSchema: string; policy: PaidLifecycleVaultV3Policy; acquireTimeoutMs?: number }) {
    const policy = Object.freeze(paidLifecycleVaultV3PolicySchema.parse(options.policy));
    const storage = new CystCheckpointFileVault({ directory: options.directory, masterKey: options.masterKey,
      maxRecordsPerScope: policy.maxRecordsPerBucket,
      ...(options.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: options.acquireTimeoutMs }) });
    const partitioned = new PartitionedLifecycleJournal(storage, policy);
    super(partitioned, { owner: options.owner, agent: options.agent, applicationSchema: options.applicationSchema });
    Object.freeze(this.scope);
    this.storage = storage; this.partitioned = partitioned; this.policy = policy;
    this.policyVault = new PaidLifecycleClientVault(storage, { owner: this.scope.owner, agent: this.scope.agent,
      applicationSchema: 'pv3.' + digest(['telomere-paid-lifecycle-policy-v3', this.scope]).slice(0, 60) });
    this.operationScope = { owner: this.scope.owner, agent: this.scope.agent,
      applicationSchema: 'pv3.' + digest(['telomere-paid-lifecycle-operation-lock-v3', this.scope]).slice(0, 60) };
  }
  private reviewed(): Promise<void> {
    this.policyCheck ??= this.policyVault.claim('storage-policy', { scope: this.scope, policy: this.policy });
    return this.policyCheck;
  }
  override async claim(kind: string, value: unknown): Promise<void> { await this.reviewed(); await this.partitioned.claimJson(this.scope, kind, value); }
  override async read(kind: string): Promise<unknown | undefined> { await this.reviewed(); return this.partitioned.readJson(this.scope, kind); }
  override async putCheckpoint(intentId: string, envelope: Parameters<PaidLifecycleClientVault['putCheckpoint']>[1], key: Uint8Array): Promise<void> {
    await this.reviewed(); await super.putCheckpoint(intentId, envelope, key);
  }
  override async getCheckpoint(intentId: string) { await this.reviewed(); return super.getCheckpoint(intentId); }
  override async recoveryKey(checkpointId: string): Promise<Uint8Array> { await this.reviewed(); return super.recoveryKey(checkpointId); }
  override async exclusiveOperation<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9:_-]{1,256}$/.test(kind)) throw new Error('Invalid private lifecycle operation lock');
    await this.reviewed(); return this.storage.exclusive(this.operationScope, async () => operation());
  }
  close(): void { this.storage.close(); }
}
