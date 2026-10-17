import { z } from 'zod';
import { ApiTransport } from '../sdk/transport.js';
import type { FetchTransport } from '../sdk/types.js';
import { decryptCheckpoint } from '../sdk/cysts.js';
import { CYST_CAPABILITIES, cystEnvelopeSchema, cystHeaderSchema, cystIdempotencySchema, cystIdSchema,
  cystMetadataSchema, type CystEnvelope, type CystMetadata } from './types.js';
import { cystRegistryAddressSchema, cystRegistryCommitPreparedSchema, cystRegistryCommitTransaction,
  cystRegistryConfigSchema, cystRegistryDownloadSchema, cystRegistryHashSchema, cystRegistryMatches, cystRegistryPinsSchema,
  cystRegistryRetirePreparedSchema, cystRegistryRetireTransaction, cystRegistrySnapshotSchema,
  cystRegistryUint64Schema, cystRegistryVerificationSchema, type CystRegistryPins,
  type CystRegistryReader, type CystRegistrySnapshot } from './registry-types.js';

const agentIdSchema = cystRegistryHashSchema.refine(value => !/^0x0{64}$/.test(value));
const principalSchema = z.object({ address: cystRegistryAddressSchema, demo: z.boolean() }).strict();
type CommitPrepared = z.infer<typeof cystRegistryCommitPreparedSchema>;
type RetirePrepared = z.infer<typeof cystRegistryRetirePreparedSchema>;
type Verification = z.infer<typeof cystRegistryVerificationSchema>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Cannot compare an undefined CystRegistry value');
  return encoded;
}
function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function checkedCheckpoint(value: CystMetadata): CystMetadata {
  const checkpoint = cystMetadataSchema.parse(value);
  if (checkpoint.state !== 'ready' || checkpoint.ciphertextBytes !== checkpoint.plaintextBytes + 16) {
    throw new Error('Use the original ready encrypted checkpoint with its exact ciphertext length');
  }
  return checkpoint;
}
function sameSnapshot(api: CystRegistrySnapshot, independent: CystRegistrySnapshot): boolean {
  // The fresh trusted reader supplies the canonical block. Different API/read heads
  // are legitimate only when every substantive field remains exactly equal.
  const { block: _apiBlock, ...apiState } = api.current;
  const { block: _independentBlock, ...independentState } = independent.current;
  return equal(api.binding, independent.binding) && equal(apiState, independentState);
}

/** Checked, unsigned CystRegistry plans. The caller supplies an independent read-only chain boundary. */
export class CystRegistryClient {
  readonly origin: string;
  private readonly transport: ApiTransport;
  private readonly pins: CystRegistryPins;
  private readonly reader: CystRegistryReader;

  constructor(options: { baseUrl: string; pins: CystRegistryPins; reader: CystRegistryReader;
    sessionToken?: string; fetch?: FetchTransport }) {
    this.transport = new ApiTransport(options.baseUrl, {
      ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.origin = this.transport.origin;
    this.pins = freeze(cystRegistryPinsSchema.parse(options.pins));
    if (!options.reader || typeof options.reader.check !== 'function' || typeof options.reader.snapshot !== 'function'
      || !equal(this.pins, cystRegistryPinsSchema.parse(options.reader.pins))) {
      throw new Error('Supply an independent CystRegistry reader with the exact reviewed pins');
    }
    this.reader = options.reader;
  }

  async config(): Promise<z.infer<typeof cystRegistryConfigSchema>> {
    if (!equal(this.pins, cystRegistryPinsSchema.parse(this.reader.pins))) {
      throw new Error('CystRegistry reader differs from the reviewed pins');
    }
    await this.reader.check();
    const config = cystRegistryConfigSchema.parse(await this.transport.request('/api/cyst-registry/config'));
    if (!equal(config.pins, this.pins)) throw new Error('CystRegistry deployment differs from the reviewed pins');
    return freeze(config);
  }

  private async context(agentId: string, mode: 'read' | 'commit' | 'retire'): Promise<CystRegistrySnapshot> {
    await this.config();
    const principal = principalSchema.parse(await this.transport.request('/api/me')).address;
    const snapshot = cystRegistrySnapshotSchema.parse(await this.reader.snapshot(agentId));
    if (snapshot.binding.agentId !== agentId || snapshot.current.agentId !== agentId) {
      throw new Error('Independent CystRegistry reader changed the requested agent identity');
    }
    if (mode === 'read' ? principal !== snapshot.binding.owner && principal !== snapshot.binding.agentWallet
      : principal !== snapshot.binding.agentWallet) {
      throw new Error('CystRegistry principal is not authorized for the requested operation');
    }
    if (mode === 'commit' && snapshot.binding.status === 3) throw new Error('A dead agent cannot commit a new checkpoint');
    return snapshot;
  }

  private checkedSnapshot(raw: unknown, independent: CystRegistrySnapshot): CystRegistrySnapshot {
    const api = cystRegistrySnapshotSchema.parse(raw);
    if (!sameSnapshot(api, independent)) throw new Error('CystRegistry response differs from the independent current state');
    return freeze(independent);
  }

  private checkpointScope(checkpoint: CystMetadata, snapshot: CystRegistrySnapshot): void {
    if (checkpoint.owner !== snapshot.binding.owner.toLowerCase()
      || checkpoint.agent !== snapshot.binding.agentWallet.toLowerCase()) {
      throw new Error('Checkpoint labels differ from the authoritative Selection owner and agent wallet');
    }
  }

  async latest(agentIdValue: string): Promise<CystRegistrySnapshot> {
    const agentId = agentIdSchema.parse(agentIdValue);
    await this.context(agentId, 'read');
    const api = await this.transport.request('/api/cyst-registry/agents/' + agentId + '/latest');
    return this.checkedSnapshot(api, await this.context(agentId, 'read'));
  }

  async commitPlan(agentIdValue: string, expectedCheckpoint: CystMetadata, idempotencyKey: string): Promise<CommitPrepared> {
    const agentId = agentIdSchema.parse(agentIdValue), checkpoint = checkedCheckpoint(expectedCheckpoint);
    const key = cystIdempotencySchema.parse(idempotencyKey);
    this.checkpointScope(checkpoint, await this.context(agentId, 'commit'));
    const value = cystRegistryCommitPreparedSchema.parse(await this.transport.request(
      '/api/cyst-registry/agents/' + agentId + '/commit-plan', { method: 'POST',
        body: { checkpointId: cystIdSchema.parse(checkpoint.id) }, idempotencyKey: key }));
    const independent = await this.context(agentId, 'commit');
    this.checkpointScope(checkpoint, independent);
    this.checkedSnapshot({ binding: value.binding, current: value.current }, independent);
    if (!equal(value.checkpoint, checkpoint) || !equal(value.transaction,
      cystRegistryCommitTransaction(this.pins, independent.binding, checkpoint, independent.current.revision))) {
      throw new Error('CystRegistry commit plan changed the original checkpoint or exact unsigned transaction');
    }
    return freeze({ ...value, binding: independent.binding, current: independent.current });
  }

  async retirePlan(agentIdValue: string, expectedRevisionValue: string, idempotencyKey: string): Promise<RetirePrepared> {
    const agentId = agentIdSchema.parse(agentIdValue), revision = cystRegistryUint64Schema.parse(expectedRevisionValue);
    const key = cystIdempotencySchema.parse(idempotencyKey);
    const before = await this.context(agentId, 'retire');
    if (before.current.revision !== revision || revision === '0' || before.current.retired) {
      throw new Error('Retire requires the exact current live checkpoint revision');
    }
    const value = cystRegistryRetirePreparedSchema.parse(await this.transport.request(
      '/api/cyst-registry/agents/' + agentId + '/retire-plan', { method: 'POST', body: { expectedRevision: revision }, idempotencyKey: key }));
    const independent = await this.context(agentId, 'retire');
    this.checkedSnapshot({ binding: value.binding, current: value.current }, independent);
    if (independent.current.revision !== revision || independent.current.retired || !equal(value.transaction,
      cystRegistryRetireTransaction(this.pins, independent.binding, revision))) {
      throw new Error('CystRegistry retire plan changed the original revision or exact unsigned transaction');
    }
    return freeze({ ...value, binding: independent.binding, current: independent.current });
  }

  async verify(agentIdValue: string, expectedCheckpoint: CystMetadata): Promise<Verification> {
    const agentId = agentIdSchema.parse(agentIdValue), checkpoint = checkedCheckpoint(expectedCheckpoint);
    this.checkpointScope(checkpoint, await this.context(agentId, 'read'));
    const value = cystRegistryVerificationSchema.parse(await this.transport.request(
      '/api/cyst-registry/agents/' + agentId + '/verify', { method: 'POST', body: { checkpointId: checkpoint.id } }));
    const independent = await this.context(agentId, 'read');
    this.checkpointScope(checkpoint, independent);
    this.checkedSnapshot({ binding: value.binding, current: value.current }, independent);
    const matches = cystRegistryMatches(independent.current, checkpoint);
    if (!equal(value.checkpoint, checkpoint) || value.matches !== matches) {
      throw new Error('CystRegistry verification changed the original checkpoint or independent result');
    }
    return freeze({ binding: independent.binding, checkpoint, current: independent.current, matches });
  }

  async download(agentIdValue: string, expectedCheckpoint: CystMetadata): Promise<CystEnvelope> {
    const agentId = agentIdSchema.parse(agentIdValue), checkpoint = checkedCheckpoint(expectedCheckpoint);
    const before = await this.context(agentId, 'read');
    this.checkpointScope(checkpoint, before);
    if (!cystRegistryMatches(before.current, checkpoint)) throw new Error('Checkpoint is not the current published live revision');
    const value = cystRegistryDownloadSchema.parse(await this.transport.request(
      '/api/cyst-registry/agents/' + agentId + '/checkpoints/' + checkpoint.id + '/blob',
      { maxResponseBytes: CYST_CAPABILITIES.maxUploadBodyBytes }));
    const independent = await this.context(agentId, 'read');
    this.checkpointScope(checkpoint, independent);
    this.checkedSnapshot({ binding: value.binding, current: value.current }, independent);
    if (!equal(value.checkpoint, checkpoint) || !cystRegistryMatches(independent.current, checkpoint)) {
      throw new Error('Checkpoint download differs from the original current published checkpoint');
    }
    const envelope = cystEnvelopeSchema.parse({ ...cystHeaderSchema.parse({ version: checkpoint.version,
      algorithm: checkpoint.algorithm, id: checkpoint.id, owner: checkpoint.owner, agent: checkpoint.agent,
      applicationSchema: checkpoint.applicationSchema, plaintextBytes: checkpoint.plaintextBytes, nonce: checkpoint.nonce }),
      sha256: checkpoint.sha256, ciphertext: value.ciphertext });
    const bytes = Uint8Array.from(atob(envelope.ciphertext), item => item.charCodeAt(0));
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer));
    const digestHex = Array.from(digest, item => item.toString(16).padStart(2, '0')).join('');
    if (btoa(binary) !== envelope.ciphertext || bytes.byteLength !== checkpoint.ciphertextBytes || digestHex !== checkpoint.sha256) {
      throw new Error('Published checkpoint ciphertext failed its integrity check');
    }
    return freeze(envelope);
  }

  async restore(agentId: string, expectedCheckpoint: CystMetadata, recoveryKey: Uint8Array): Promise<Uint8Array> {
    return decryptCheckpoint(await this.download(agentId, expectedCheckpoint), recoveryKey);
  }
}
