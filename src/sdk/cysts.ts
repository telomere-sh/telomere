import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { z } from 'zod';
import { ApiTransport } from './transport.js';
import { cystCapabilitiesV1Schema, cystCapabilitiesV2Schema } from '../cysts/quota-types.js';
import { CYST_CAPABILITIES, cystAddressSchema, cystAuthenticatedData, cystEnvelopeSchema, cystHeaderSchema,
  cystIdSchema, cystIdempotencySchema, cystMetadataSchema, type CystEnvelope, type CystHeader, type CystMetadata } from '../cysts/types.js';

function hex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); }
function unhex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Invalid checkpoint hexadecimal value');
  return Uint8Array.from(value.match(/.{2}/g) ?? [], item => Number.parseInt(item, 16));
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function unbase64(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value), item => item.charCodeAt(0));
  if (base64(bytes) !== value) throw new Error('Invalid checkpoint ciphertext encoding');
  return bytes;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  // Copy into an ordinary ArrayBuffer for browser and Node WebCrypto compatibility.
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)));
}
function checkedKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error('Use a 32-byte checkpoint recovery key');
  return Uint8Array.from(key);
}
function headerOf(value: CystEnvelope | CystMetadata): CystHeader {
  return cystHeaderSchema.parse({ version: value.version, algorithm: value.algorithm, id: value.id, owner: value.owner,
    agent: value.agent, applicationSchema: value.applicationSchema, plaintextBytes: value.plaintextBytes, nonce: value.nonce });
}
function sameHeader(a: CystEnvelope | CystMetadata, b: CystEnvelope | CystMetadata): boolean {
  return JSON.stringify(headerOf(a)) === JSON.stringify(headerOf(b)) && a.sha256 === b.sha256;
}
export function generateCystRecoveryKey(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }
export function exportCystRecoveryKey(key: Uint8Array): string {
  const temporary = checkedKey(key);
  try { return hex(temporary); } finally { temporary.fill(0); }
}
export function importCystRecoveryKey(value: string): Uint8Array {
  const temporary = unhex(z.string().regex(/^[0-9a-f]{64}$/).parse(value));
  try { return checkedKey(temporary); } finally { temporary.fill(0); }
}
export async function encryptCheckpoint(plaintext: Uint8Array,
  scope: { owner: string; agent?: string; applicationSchema: string }, recoveryKey?: Uint8Array): Promise<{ envelope: CystEnvelope; recoveryKey: Uint8Array }> {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength < 1 || plaintext.byteLength > CYST_CAPABILITIES.maxPlaintextBytes) {
    throw new Error('Application checkpoint must contain between 1 byte and 2 MiB');
  }
  const key = recoveryKey === undefined ? generateCystRecoveryKey() : checkedKey(recoveryKey);
  let returned = false;
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const owner = cystAddressSchema.parse(scope.owner);
    const header = cystHeaderSchema.parse({ version: 1, algorithm: 'xchacha20-poly1305',
      id: '0x' + hex(crypto.getRandomValues(new Uint8Array(32))), owner,
      agent: scope.agent === undefined ? owner : cystAddressSchema.parse(scope.agent), applicationSchema: scope.applicationSchema,
      plaintextBytes: plaintext.byteLength, nonce: hex(nonce) });
    const ciphertext = xchacha20poly1305(key, nonce, cystAuthenticatedData(header)).encrypt(Uint8Array.from(plaintext));
    const envelope = cystEnvelopeSchema.parse({ ...header, sha256: await sha256(ciphertext), ciphertext: base64(ciphertext) });
    returned = true;
    return { envelope, recoveryKey: key };
  } finally { if (!returned) key.fill(0); }
}
export async function decryptCheckpoint(value: unknown, recoveryKey: Uint8Array): Promise<Uint8Array> {
  const envelope = cystEnvelopeSchema.parse(value); const key = checkedKey(recoveryKey);
  try {
    const ciphertext = unbase64(envelope.ciphertext);
    if (ciphertext.byteLength !== envelope.plaintextBytes + 16 || await sha256(ciphertext) !== envelope.sha256) {
      throw new Error('Checkpoint ciphertext failed its integrity check');
    }
    try {
      const result = xchacha20poly1305(key, unhex(envelope.nonce), cystAuthenticatedData(headerOf(envelope))).decrypt(ciphertext);
      if (result.byteLength !== envelope.plaintextBytes) throw new Error('Invalid checkpoint length');
      return result;
    } catch { throw new Error('Checkpoint authentication failed; check the recovery key and original metadata'); }
  } finally { key.fill(0); }
}

export class CystClient {
  readonly quotaVersion: 1 | 2;
  constructor(private readonly transport: ApiTransport, options: { quotaVersion?: 2 } = {}) {
    this.quotaVersion = options.quotaVersion === undefined ? 1 : z.literal(2).parse(options.quotaVersion);
  }
  private request(path: string, options: Parameters<ApiTransport['request']>[1] = {}) {
    return this.transport.request(path, { ...options, ...(this.quotaVersion === 2 ? { cystQuotaVersion: 2 as const } : {}) });
  }
  private checkedCapabilities(value: unknown) {
    return this.quotaVersion === 2 ? cystCapabilitiesV2Schema.parse(value) : cystCapabilitiesV1Schema.parse(value);
  }
  async capabilities() {
    const value = this.checkedCapabilities(await this.request('/api/cysts/capabilities'));
    return Object.freeze(value);
  }
  async upload(envelope: CystEnvelope, idempotencyKey: string): Promise<{ checkpoint: CystMetadata; replayed: boolean }> {
    const checked = cystEnvelopeSchema.parse(envelope);
    const bytes = unbase64(checked.ciphertext);
    if (bytes.byteLength !== checked.plaintextBytes + 16 || await sha256(bytes) !== checked.sha256) throw new Error('Invalid checkpoint ciphertext');
    const result = z.object({ checkpoint: cystMetadataSchema, replayed: z.boolean() }).strict()
      .parse(await this.request('/api/cysts', { method: 'POST', body: checked,
        idempotencyKey: cystIdempotencySchema.parse(idempotencyKey) }));
    if (!sameHeader(checked, result.checkpoint) || result.checkpoint.state !== 'ready'
      || result.checkpoint.ciphertextBytes !== bytes.byteLength) throw new Error('Checkpoint upload response differs from the original ciphertext');
    return result;
  }
  async list(options: { agent?: string; cursor?: string } = {}) {
    const params = new URLSearchParams();
    const agent = options.agent === undefined ? undefined : cystAddressSchema.parse(options.agent);
    const cursor = options.cursor === undefined ? undefined : cystIdSchema.parse(options.cursor);
    if (agent !== undefined) params.set('agent', agent);
    if (cursor !== undefined) params.set('cursor', cursor);
    const suffix = params.size ? '?' + params.toString() : '';
    const result = z.object({ checkpoints: z.array(cystMetadataSchema).max(CYST_CAPABILITIES.listLimit), nextCursor: cystIdSchema.optional(),
      usage: z.object({ bytes: z.number().int().min(0).max(CYST_CAPABILITIES.maxOwnerBytes),
        checkpoints: z.number().int().min(0).max(this.quotaVersion === 2 ? 4096 : 512) }).strict(),
      capabilities: z.unknown(),
    }).strict().parse(await this.request('/api/cysts' + suffix));
    this.checkedCapabilities(result.capabilities);
    let previous = cursor;
    for (const checkpoint of result.checkpoints) {
      if ((agent !== undefined && checkpoint.agent !== agent) || (previous !== undefined && checkpoint.id <= previous)) {
        throw new Error('Checkpoint list differs from the requested agent or cursor');
      }
      previous = checkpoint.id;
    }
    if (result.nextCursor !== undefined && (result.checkpoints.length !== CYST_CAPABILITIES.listLimit || result.nextCursor !== previous)) {
      throw new Error('Checkpoint continuation cursor changed');
    }
    return result;
  }
  async metadata(id: string): Promise<CystMetadata> {
    const parsedId = cystIdSchema.parse(id);
    const value = cystMetadataSchema.parse(await this.request('/api/cysts/' + parsedId));
    if (value.id !== parsedId) throw new Error('Checkpoint metadata identifier changed');
    return value;
  }
  async download(id: string, scope: { owner: string; agent?: string }): Promise<CystEnvelope> {
    const parsedId = cystIdSchema.parse(id); const owner = cystAddressSchema.parse(scope.owner);
    const agent = scope.agent === undefined ? undefined : cystAddressSchema.parse(scope.agent);
    const result = z.object({ metadata: cystMetadataSchema, ciphertext: z.string().max(Math.ceil(CYST_CAPABILITIES.maxCiphertextBytes / 3) * 4) }).strict()
      .parse(await this.request('/api/cysts/' + parsedId + '/blob', { maxResponseBytes: CYST_CAPABILITIES.maxUploadBodyBytes }));
    if (result.metadata.state !== 'ready' || result.metadata.id !== parsedId || result.metadata.owner !== owner
      || (agent !== undefined && result.metadata.agent !== agent)) throw new Error('Checkpoint download scope changed');
    const envelope = cystEnvelopeSchema.parse({ ...headerOf(result.metadata), sha256: result.metadata.sha256, ciphertext: result.ciphertext });
    const bytes = unbase64(envelope.ciphertext);
    if (bytes.byteLength !== result.metadata.ciphertextBytes || bytes.byteLength !== envelope.plaintextBytes + 16
      || await sha256(bytes) !== envelope.sha256) throw new Error('Checkpoint ciphertext failed its integrity check');
    return envelope;
  }
  async restore(id: string, recoveryKey: Uint8Array, scope: { owner: string; agent?: string }): Promise<Uint8Array> {
    return decryptCheckpoint(await this.download(id, scope), recoveryKey);
  }
}
