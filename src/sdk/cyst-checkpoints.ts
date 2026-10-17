import { z } from 'zod';
import { cystAddressSchema, cystEnvelopeSchema, cystHeaderSchema, cystMetadataSchema,
  type CystEnvelope, type CystMetadata } from '../cysts/types.js';
import { CystClient, decryptCheckpoint, encryptCheckpoint } from './cysts.js';

export const DEFAULT_CYST_CHECKPOINT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const timestamp = z.number().int().nonnegative().safe().max(8_640_000_000_000_000);
const interval = z.number().int().min(1000).max(MAX_INTERVAL_MS);
const operationId = z.string().regex(/^cyst-hook-[a-f0-9]{64}$/);
const trigger = z.enum(['periodic', 'owner_request', 'preemption', 'budget_exhaustion', 'metabolism_step_down']);
const scopeSchema = z.object({ owner: cystAddressSchema, agent: cystAddressSchema,
  applicationSchema: cystHeaderSchema.shape.applicationSchema }).strict();
const readyMetadata = cystMetadataSchema.refine(value => value.state === 'ready'
  && value.ciphertextBytes === value.plaintextBytes + 16);
const pendingSchema = z.object({ operationId, trigger, startedAtMs: timestamp }).strict();
const latestSchema = z.object({ operationId, trigger, completedAtMs: timestamp, checkpoint: readyMetadata }).strict();
const stateSchema = z.object({ version: z.literal(1), scope: scopeSchema, intervalMs: interval,
  paused: z.boolean(), nextDueAtMs: timestamp, pending: pendingSchema.nullable(), latest: latestSchema.nullable() }).strict();
const recordSchema = z.object({ envelope: cystEnvelopeSchema,
  recoveryKey: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength === 32) }).strict();

export type CystCheckpointTrigger = z.infer<typeof trigger>;
export type CystCheckpointScope = z.infer<typeof scopeSchema>;
export type CystCheckpointState = z.infer<typeof stateSchema>;
export type CystCheckpointRecord = z.infer<typeof recordSchema>;

export interface CystCheckpointJournal {
  /** Reads return independent copies, including fresh owning recovery-key arrays. */
  load(): Promise<CystCheckpointState | undefined>;
  /** Each write is atomic and durable before returning, independently of later callback failures. */
  save(state: CystCheckpointState): Promise<void>;
  checkpoint(operationId: string): Promise<CystCheckpointRecord | undefined>;
  /** Immutable/idempotent for an operationId, including the exact envelope and key.
   * Retain previous records until the owner applies their own retention policy.
   * Copy inputs: the coordinator clears its key copy immediately after use.
   */
  saveCheckpoint(operationId: string, record: CystCheckpointRecord): Promise<void>;
}
export interface CystCheckpointVault {
  /** Lock only: never roll back durable writes when operation throws. Serialize
   * this scope across every participating coordinator/process. A process-local
   * mutex is sufficient only when this client vault has one owning process.
   */
  exclusive<T>(scope: CystCheckpointScope, operation: (journal: CystCheckpointJournal) => Promise<T>): Promise<T>;
}
export type CystCheckpointResult = { status: 'idle' | 'paused' | 'no_pending'; nextDueAtMs: number }
  | { status: 'uploaded'; operationId: string; trigger: CystCheckpointTrigger; checkpoint: CystMetadata;
      replayed: boolean; nextDueAtMs: number };

function header(value: CystEnvelope | CystMetadata) {
  return cystHeaderSchema.parse({ version: value.version, algorithm: value.algorithm, id: value.id,
    owner: value.owner, agent: value.agent, applicationSchema: value.applicationSchema,
    plaintextBytes: value.plaintextBytes, nonce: value.nonce });
}
function exactEnvelope(left: CystEnvelope, right: CystEnvelope): boolean {
  return JSON.stringify(cystEnvelopeSchema.parse(left)) === JSON.stringify(cystEnvelopeSchema.parse(right));
}
function clearRecord(value: unknown): void {
  if (value !== null && typeof value === 'object' && 'recoveryKey' in value && value.recoveryKey instanceof Uint8Array) {
    value.recoveryKey.fill(0);
  }
}

/** Owner-side application-state checkpoints; no timer, wallet or chain calls.
 * The embedding runtime calls tick() and explicit snapshot(trigger) events.
 */
export class CystCheckpointCoordinator {
  private readonly scope: CystCheckpointScope;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly cysts: CystClient;
  private readonly vault: CystCheckpointVault;
  private readonly onCyst: (context: { operationId: string; trigger: CystCheckpointTrigger }) => Promise<Uint8Array>;
  private readonly fixedOperationId: string | undefined;
  private flight: Promise<CystCheckpointResult> | undefined;

  constructor(options: { owner: string; agent: string; applicationSchema: string; cysts: CystClient;
    vault: CystCheckpointVault; intervalMs?: number; now?: () => number;
    /** Must return an owning state copy and be idempotent for operationId after
     * an incomplete durable begin. Quiesce application state as required; do not
     * recursively await this coordinator from the hook. The returned bytes are
     * cleared by the coordinator after encryption, including failure paths.
     */
    onCyst: (context: { operationId: string; trigger: CystCheckpointTrigger }) => Promise<Uint8Array>;
    /** A caller-owned durable event may choose one exact ID for crash recovery. */
    fixedOperationId?: string }) {
    this.scope = scopeSchema.parse({ owner: options.owner, agent: options.agent, applicationSchema: options.applicationSchema });
    this.intervalMs = interval.parse(options.intervalMs ?? DEFAULT_CYST_CHECKPOINT_INTERVAL_MS);
    this.now = options.now ?? Date.now;
    this.cysts = options.cysts;
    this.vault = options.vault;
    this.onCyst = options.onCyst;
    this.fixedOperationId = options.fixedOperationId === undefined ? undefined : operationId.parse(options.fixedOperationId);
    if (!options.vault || typeof options.vault.exclusive !== 'function' || typeof options.onCyst !== 'function'
      || !options.cysts || typeof options.cysts.upload !== 'function' || typeof options.cysts.download !== 'function') {
      throw new Error('Supply an authenticated owner CystClient, durable exclusive client vault and onCyst hook');
    }
    this.time();
  }

  private time(): number { return timestamp.parse(this.now()); }
  private next(time: number): number { return timestamp.parse(time + this.intervalMs); }
  private matchesScope(value: CystEnvelope | CystMetadata): void {
    if (value.owner !== this.scope.owner || value.agent !== this.scope.agent || value.applicationSchema !== this.scope.applicationSchema) {
      throw new Error('Durable checkpoint changed owner, agent or application schema');
    }
  }
  private async state(journal: CystCheckpointJournal, initialize: boolean): Promise<CystCheckpointState | undefined> {
    const raw = await journal.load();
    if (raw === undefined) {
      if (!initialize) return undefined;
      const value: CystCheckpointState = { version: 1, scope: { ...this.scope }, intervalMs: this.intervalMs,
        paused: false, nextDueAtMs: this.next(this.time()), pending: null, latest: null };
      await journal.save(value);
      return value;
    }
    const value = stateSchema.parse(raw);
    if (JSON.stringify(value.scope) !== JSON.stringify(this.scope) || value.intervalMs !== this.intervalMs) {
      throw new Error('Durable checkpoint scope or cadence differs from this coordinator');
    }
    if (value.latest) this.matchesScope(value.latest.checkpoint);
    if (value.pending && value.pending.operationId === value.latest?.operationId) {
      throw new Error('Durable checkpoint operation is both pending and completed');
    }
    return value;
  }
  private async record(journal: CystCheckpointJournal, id: string): Promise<CystCheckpointRecord | undefined> {
    const raw = await journal.checkpoint(operationId.parse(id));
    if (raw === undefined) return undefined;
    try {
      const value = recordSchema.parse(raw);
      this.matchesScope(value.envelope);
      return value;
    } catch (error) { clearRecord(raw); throw error; }
  }
  private exactMetadata(envelope: CystEnvelope, metadata: CystMetadata): void {
    if (JSON.stringify(header(envelope)) !== JSON.stringify(header(metadata)) || envelope.sha256 !== metadata.sha256
      || metadata.state !== 'ready' || metadata.ciphertextBytes !== envelope.plaintextBytes + 16) {
      throw new Error('Checkpoint metadata differs from the original durable ciphertext');
    }
  }

  private async process(mode: 'tick' | 'snapshot' | 'retry', requestedTrigger: CystCheckpointTrigger): Promise<CystCheckpointResult> {
    return this.vault.exclusive({ ...this.scope }, async journal => {
      const state = (await this.state(journal, true))!;
      if (this.fixedOperationId && state.pending && state.pending.operationId !== this.fixedOperationId) {
        throw new Error('A different checkpoint operation is already pending');
      }
      if (this.fixedOperationId && !state.pending && state.latest?.operationId === this.fixedOperationId) {
        if (state.latest.trigger !== requestedTrigger) throw new Error('Fixed checkpoint trigger changed');
        return { status: 'uploaded', operationId: state.latest.operationId, trigger: state.latest.trigger,
          checkpoint: state.latest.checkpoint, replayed: true, nextDueAtMs: state.nextDueAtMs };
      }
      if (state.paused && mode !== 'retry') return { status: 'paused', nextDueAtMs: state.nextDueAtMs };
      if (!state.pending && mode === 'retry') return { status: 'no_pending', nextDueAtMs: state.nextDueAtMs };
      if (!state.pending && mode === 'tick' && this.time() < state.nextDueAtMs) return { status: 'idle', nextDueAtMs: state.nextDueAtMs };
      if (!state.pending) {
        const random = this.fixedOperationId ? undefined : crypto.getRandomValues(new Uint8Array(32));
        const id = this.fixedOperationId ?? 'cyst-hook-' + Array.from(random!, byte => byte.toString(16).padStart(2, '0')).join('');
        state.pending = { operationId: id, trigger: requestedTrigger, startedAtMs: this.time() };
        await journal.save(state);
      }
      const pending = state.pending;
      let record = await this.record(journal, pending.operationId);
      try {
        if (!record) {
          const plaintext = await this.onCyst({ operationId: pending.operationId, trigger: pending.trigger });
          let generated: CystCheckpointRecord | undefined;
          try {
            const encrypted = await encryptCheckpoint(plaintext, this.scope);
            generated = encrypted;
            await journal.saveCheckpoint(pending.operationId, encrypted);
            record = await this.record(journal, pending.operationId);
            if (!record || !exactEnvelope(record.envelope, encrypted.envelope)
              || !record.recoveryKey.every((byte, index) => byte === encrypted.recoveryKey[index])) {
              throw new Error('Client vault did not retain the exact durable checkpoint before upload');
            }
          } finally { if (plaintext instanceof Uint8Array) plaintext.fill(0); clearRecord(generated); }
        }
        // Authenticate the separately persisted recovery key before publishing
        // an envelope that could otherwise become irrecoverable.
        const verified = await decryptCheckpoint(record.envelope, record.recoveryKey);
        verified.fill(0);
        const result = await this.cysts.upload(record.envelope, pending.operationId);
        const checkpoint = readyMetadata.parse(result.checkpoint);
        this.exactMetadata(record.envelope, checkpoint);
        if (typeof result.replayed !== 'boolean') throw new Error('Invalid checkpoint upload replay status');
        const completedAtMs = this.time();
        state.latest = { operationId: pending.operationId, trigger: pending.trigger, completedAtMs, checkpoint };
        state.pending = null;
        state.nextDueAtMs = this.next(completedAtMs);
        await journal.save(state);
        return { status: 'uploaded', operationId: pending.operationId, trigger: pending.trigger,
          checkpoint: cystMetadataSchema.parse(checkpoint), replayed: result.replayed, nextDueAtMs: state.nextDueAtMs };
      } finally { clearRecord(record); }
    });
  }
  private singleflight(mode: 'tick' | 'snapshot' | 'retry', requestedTrigger: CystCheckpointTrigger): Promise<CystCheckpointResult> {
    if (this.flight) return this.flight.then(result => {
      // An idle cadence read must not swallow a concurrent explicit request.
      if (mode === 'snapshot' && (result.status === 'idle' || result.status === 'no_pending')) {
        return this.singleflight(mode, requestedTrigger);
      }
      if (mode === 'retry' && result.status === 'paused') return this.singleflight(mode, requestedTrigger);
      if (mode === 'retry' && result.status === 'idle') return { status: 'no_pending', nextDueAtMs: result.nextDueAtMs };
      return result;
    });
    const flight = this.process(mode, requestedTrigger).finally(() => { if (this.flight === flight) this.flight = undefined; });
    this.flight = flight;
    return flight;
  }

  /** First tick durably schedules the first checkpoint for now + interval.
   * Later ticks retry pending work, or capture once when due. No catch-up loop.
   */
  tick(): Promise<CystCheckpointResult> { return this.singleflight('tick', 'periodic'); }
  snapshot(reason: CystCheckpointTrigger = 'owner_request'): Promise<CystCheckpointResult> {
    return this.singleflight('snapshot', trigger.parse(reason));
  }
  /** Explicit recovery is permitted while paused; it never creates a new operation. */
  retryPending(): Promise<CystCheckpointResult> { return this.singleflight('retry', 'owner_request'); }
  async pause(): Promise<void> {
    await this.vault.exclusive({ ...this.scope }, async journal => {
      const state = (await this.state(journal, true))!;
      state.paused = true;
      await journal.save(state);
    });
  }
  async resume(): Promise<void> {
    await this.vault.exclusive({ ...this.scope }, async journal => {
      const state = (await this.state(journal, true))!;
      state.paused = false;
      await journal.save(state);
    });
  }
  /** A read never initiates checkpoint capture/upload. Keys remain in the client vault. */
  async restoreLatest(): Promise<Uint8Array> {
    return this.vault.exclusive({ ...this.scope }, async journal => {
      const state = await this.state(journal, false);
      if (!state?.latest) throw new Error('Client vault has no completed checkpoint to restore');
      const record = await this.record(journal, state.latest.operationId);
      if (!record) throw new Error('Client vault has no saved checkpoint recovery record');
      try {
        this.exactMetadata(record.envelope, state.latest.checkpoint);
        const downloaded = await this.cysts.download(state.latest.checkpoint.id, { owner: this.scope.owner, agent: this.scope.agent });
        if (!exactEnvelope(downloaded, record.envelope)) throw new Error('Downloaded checkpoint differs from the exact saved original envelope');
        return await decryptCheckpoint(downloaded, record.recoveryKey);
      } finally { clearRecord(record); }
    });
  }
}
