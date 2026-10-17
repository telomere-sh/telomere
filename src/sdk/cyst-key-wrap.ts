import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { z } from 'zod';
import { cystAddressSchema, cystIdSchema } from '../cysts/types.js';

const publicKeySchema = z.string().regex(/^[0-9a-f]{64}$/).refine(value => value !== '00'.repeat(32), 'Invalid recipient public key');
const scopeSchema = z.object({ owner: cystAddressSchema, agent: cystAddressSchema, checkpointId: cystIdSchema }).strict();
const wrappingSchema = z.object({ recipient: z.enum(['owner', 'agent']), recipientPublicKey: publicKeySchema,
  ephemeralPublicKey: publicKeySchema, salt: z.string().regex(/^[0-9a-f]{64}$/), nonce: z.string().regex(/^[0-9a-f]{48}$/),
  ciphertext: z.string().regex(/^[0-9a-f]{96}$/) }).strict();
export const wrappedCystKeySchema = scopeSchema.extend({ version: z.literal(1),
  algorithm: z.literal('x25519-hkdf-sha256-xchacha20poly1305'), wrappings: z.array(wrappingSchema).length(2) }).strict()
  .refine(value => value.wrappings[0]?.recipient !== value.wrappings[1]?.recipient, 'Wrap for one owner and one agent');
export type WrappedCystKey = z.infer<typeof wrappedCystKeySchema>;
export type CystKeyScope = z.infer<typeof scopeSchema>;
export interface CystWrappingIdentity { readonly publicKey: string; readonly privateKey: CryptoKey }
export const CYST_KEY_WRAP_MAX_BYTES = 2048;
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/.{2}/g) ?? [], item => Number.parseInt(item, 16));
function aad(scope: CystKeyScope, wrapping: Omit<z.infer<typeof wrappingSchema>, 'ciphertext'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['telomere.cyst-key-wrap', 1, 'x25519-hkdf-sha256-xchacha20poly1305',
    scope.owner, scope.agent, scope.checkpointId, wrapping.recipient, wrapping.recipientPublicKey,
    wrapping.ephemeralPublicKey, wrapping.salt, wrapping.nonce]));
}
async function derive(privateKey: CryptoKey, publicKey: string, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  if (privateKey.type !== 'private' || privateKey.algorithm.name !== 'X25519' || !privateKey.usages.includes('deriveBits')) throw new Error('Use the client X25519 private key');
  const imported = await crypto.subtle.importKey('raw', unhex(publicKeySchema.parse(publicKey)), { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: imported }, privateKey, 256));
  try {
    if (shared.every(byte => byte === 0)) throw new Error('Invalid X25519 agreement');
    const hkdf = await crypto.subtle.importKey('raw', Uint8Array.from(shared).buffer, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: Uint8Array.from(salt).buffer,
      info: Uint8Array.from(info).buffer }, hkdf, 256));
  } finally { shared.fill(0); }
}
export async function generateCystWrappingIdentity(): Promise<CystWrappingIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
  return Object.freeze({ publicKey: hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), privateKey: pair.privateKey });
}
/** Owner-side wrapping only; recoveryKey is copied and remains unchanged for the caller. */
export async function wrapCystRecoveryKey(recoveryKey: Uint8Array, scopeValue: CystKeyScope,
  recipients: { ownerPublicKey: string; agentPublicKey: string }): Promise<WrappedCystKey> {
  if (!(recoveryKey instanceof Uint8Array) || recoveryKey.byteLength !== 32) throw new Error('Use a 32-byte checkpoint recovery key');
  const scope = scopeSchema.parse(scopeValue), ownerPublicKey = publicKeySchema.parse(recipients.ownerPublicKey), agentPublicKey = publicKeySchema.parse(recipients.agentPublicKey);
  const key = Uint8Array.from(recoveryKey), wrappings: z.infer<typeof wrappingSchema>[] = [];
  try {
    for (const recipient of ['owner', 'agent'] as const) {
      const ephemeral = await generateCystWrappingIdentity();
      const header = { recipient, recipientPublicKey: recipient === 'owner' ? ownerPublicKey : agentPublicKey,
        ephemeralPublicKey: ephemeral.publicKey, salt: hex(crypto.getRandomValues(new Uint8Array(32))), nonce: hex(crypto.getRandomValues(new Uint8Array(24))) };
      const additionalData = aad(scope, header);
      const kek = await derive(ephemeral.privateKey, header.recipientPublicKey, unhex(header.salt), additionalData);
      try { wrappings.push({ ...header, ciphertext: hex(xchacha20poly1305(kek, unhex(header.nonce), additionalData).encrypt(key)) }); }
      finally { kek.fill(0); }
    }
    return wrappedCystKeySchema.parse({ ...scope, version: 1, algorithm: 'x25519-hkdf-sha256-xchacha20poly1305', wrappings });
  } finally { key.fill(0); }
}
/** Requires an independently selected scope, role and recipient public key; a bundle cannot choose its own trust context. */
export async function unwrapCystRecoveryKey(value: unknown, expectedScope: CystKeyScope, recipient: 'owner' | 'agent',
  identity: CystWrappingIdentity): Promise<Uint8Array> {
  const bundle = wrappedCystKeySchema.parse(value), scope = scopeSchema.parse(expectedScope), publicKey = publicKeySchema.parse(identity.publicKey);
  if (bundle.owner !== scope.owner || bundle.agent !== scope.agent || bundle.checkpointId !== scope.checkpointId) throw new Error('Wrapped checkpoint key scope changed');
  const wrapping = bundle.wrappings.find(item => item.recipient === recipient);
  if (!wrapping || wrapping.recipientPublicKey !== publicKey) throw new Error('Wrapped checkpoint recipient changed');
  const additionalData = aad(scope, wrapping); let kek: Uint8Array | undefined;
  try {
    kek = await derive(identity.privateKey, wrapping.ephemeralPublicKey, unhex(wrapping.salt), additionalData);
    const key = xchacha20poly1305(kek, unhex(wrapping.nonce), additionalData).decrypt(unhex(wrapping.ciphertext));
    if (key.byteLength !== 32) { key.fill(0); throw new Error('length'); } return key;
  } catch { throw new Error('Checkpoint key authentication failed'); }
  finally { kek?.fill(0); }
}
export function serializeWrappedCystKey(value: WrappedCystKey): string {
  const serialized = JSON.stringify(wrappedCystKeySchema.parse(value));
  if (new TextEncoder().encode(serialized).byteLength > CYST_KEY_WRAP_MAX_BYTES) throw new Error('Wrapped checkpoint key exceeds its size limit');
  return serialized;
}
export function parseWrappedCystKey(serialized: string): WrappedCystKey {
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > CYST_KEY_WRAP_MAX_BYTES) throw new Error('Wrapped checkpoint key exceeds its size limit');
  const bundle = wrappedCystKeySchema.parse(JSON.parse(serialized));
  // The exported wire format is canonical JSON: this also rejects duplicate-property documents before trust decisions.
  if (JSON.stringify(bundle) !== serialized) throw new Error('Use canonical wrapped checkpoint key JSON');
  return bundle;
}
