import { describe, expect, it } from 'vitest';
import { decryptCheckpoint, encryptCheckpoint, generateCystRecoveryKey } from '../src/sdk/cysts.js';
import { CYST_KEY_WRAP_MAX_BYTES, generateCystWrappingIdentity, parseWrappedCystKey, serializeWrappedCystKey,
  unwrapCystRecoveryKey, wrapCystRecoveryKey, type WrappedCystKey } from '../src/sdk/cyst-key-wrap.js';

const owner = '0x1111111111111111111111111111111111111111', agent = '0x2222222222222222222222222222222222222222';
const checkpointId = '0x' + 'ab'.repeat(32), scope = { owner, agent, checkpointId };
async function fixture() {
  const ownerIdentity = await generateCystWrappingIdentity(), agentIdentity = await generateCystWrappingIdentity();
  const recoveryKey = generateCystRecoveryKey();
  const wrapped = await wrapCystRecoveryKey(recoveryKey, scope, { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
  return { ownerIdentity, agentIdentity, recoveryKey, wrapped };
}
describe('client-only X25519/HKDF/XChaCha checkpoint key wrapping', () => {
  it('lets independently generated owner and agent identities recover the same unchanged key', async () => {
    const f = await fixture(), original = Uint8Array.from(f.recoveryKey);
    const ownerKey = await unwrapCystRecoveryKey(f.wrapped, scope, 'owner', f.ownerIdentity);
    const agentKey = await unwrapCystRecoveryKey(f.wrapped, scope, 'agent', f.agentIdentity);
    expect(ownerKey).toEqual(original); expect(agentKey).toEqual(original); expect(f.recoveryKey).toEqual(original);
    expect(f.ownerIdentity.privateKey.extractable).toBe(false); expect(f.agentIdentity.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', f.ownerIdentity.privateKey)).rejects.toThrow();
    expect(f.wrapped.wrappings[0]?.ephemeralPublicKey).not.toBe(f.wrapped.wrappings[1]?.ephemeralPublicKey);
    expect(f.wrapped.wrappings[0]?.nonce).not.toBe(f.wrapped.wrappings[1]?.nonce);
    ownerKey.fill(0); agentKey.fill(0); f.recoveryKey.fill(0);
  });
  it('restores the actual encrypted application file independently with either recipient key', async () => {
    const ownerIdentity = await generateCystWrappingIdentity(), agentIdentity = await generateCystWrappingIdentity();
    const plaintext = new TextEncoder().encode(JSON.stringify({ counter: 74, hash: '00'.repeat(32), privateMemory: 'only-in-owner-and-agent-clients' }));
    const checkpoint = await encryptCheckpoint(plaintext, { owner, agent, applicationSchema: 'counter.v1' });
    const realScope = { owner, agent, checkpointId: checkpoint.envelope.id };
    const bundle = await wrapCystRecoveryKey(checkpoint.recoveryKey, realScope, { ownerPublicKey: ownerIdentity.publicKey, agentPublicKey: agentIdentity.publicKey });
    const encoded = serializeWrappedCystKey(bundle);
    expect(encoded).not.toContain(Buffer.from(checkpoint.recoveryKey).toString('hex')); expect(encoded).not.toContain('privateKey'); expect(encoded).not.toContain('privateMemory');
    for (const [role, identity] of [['owner', ownerIdentity], ['agent', agentIdentity]] as const) {
      const key = await unwrapCystRecoveryKey(parseWrappedCystKey(encoded), realScope, role, identity);
      expect(await decryptCheckpoint(checkpoint.envelope, key)).toEqual(plaintext); key.fill(0);
    }
    checkpoint.recoveryKey.fill(0); plaintext.fill(0);
  });
  it('uses fresh ephemeral agreements, salts and nonces for every wrap', async () => {
    const f = await fixture();
    const next = await wrapCystRecoveryKey(f.recoveryKey, scope, { ownerPublicKey: f.ownerIdentity.publicKey, agentPublicKey: f.agentIdentity.publicKey });
    expect(next.wrappings[0]?.ephemeralPublicKey).not.toBe(f.wrapped.wrappings[0]?.ephemeralPublicKey);
    expect(next.wrappings[0]?.salt).not.toBe(f.wrapped.wrappings[0]?.salt); expect(next.wrappings[0]?.ciphertext).not.toBe(f.wrapped.wrappings[0]?.ciphertext);
    f.recoveryKey.fill(0);
  });
  it('rejects the other recipient, a forged recipient-public-key claim and an unrelated private key', async () => {
    const f = await fixture(), third = await generateCystWrappingIdentity();
    await expect(unwrapCystRecoveryKey(f.wrapped, scope, 'owner', f.agentIdentity)).rejects.toThrow('recipient changed');
    await expect(unwrapCystRecoveryKey(f.wrapped, scope, 'agent', f.ownerIdentity)).rejects.toThrow('recipient changed');
    await expect(unwrapCystRecoveryKey(f.wrapped, scope, 'owner', { publicKey: f.ownerIdentity.publicKey, privateKey: third.privateKey })).rejects.toThrow('authentication failed');
    f.recoveryKey.fill(0);
  });
  it.each(['owner', 'agent', 'checkpointId'] as const)('binds the independently expected %s scope', async field => {
    const f = await fixture(); const changed = { ...scope, [field]: field === 'checkpointId' ? '0x' + 'cd'.repeat(32) : '0x' + 'ee'.repeat(20) };
    await expect(unwrapCystRecoveryKey(f.wrapped, changed, 'owner', f.ownerIdentity)).rejects.toThrow('scope changed');
    const altered = { ...f.wrapped, ...changed };
    await expect(unwrapCystRecoveryKey(altered, changed, 'owner', f.ownerIdentity)).rejects.toThrow('authentication failed');
    f.recoveryKey.fill(0);
  });
  it.each(['ephemeralPublicKey', 'salt', 'nonce', 'ciphertext'] as const)('authenticates %s against tampering', async field => {
    const f = await fixture(), bundle = structuredClone(f.wrapped), wrapping = bundle.wrappings[0]!;
    wrapping[field] = (wrapping[field].startsWith('00') ? '01' : '00') + wrapping[field].slice(2);
    await expect(unwrapCystRecoveryKey(bundle, scope, 'owner', f.ownerIdentity)).rejects.toThrow('authentication failed'); f.recoveryKey.fill(0);
  });
  it('rejects low-order recipient keys, wrong key lengths, duplicate roles, unknown fields and oversized wire documents', async () => {
    const f = await fixture();
    await expect(wrapCystRecoveryKey(new Uint8Array(31), scope, { ownerPublicKey: f.ownerIdentity.publicKey, agentPublicKey: f.agentIdentity.publicKey })).rejects.toThrow('32-byte');
    await expect(wrapCystRecoveryKey(f.recoveryKey, scope, { ownerPublicKey: '00'.repeat(32), agentPublicKey: f.agentIdentity.publicKey })).rejects.toThrow();
    await expect(wrapCystRecoveryKey(f.recoveryKey, scope, { ownerPublicKey: '01' + '00'.repeat(31), agentPublicKey: f.agentIdentity.publicKey })).rejects.toThrow();
    const duplicate = structuredClone(f.wrapped); duplicate.wrappings[1]!.recipient = 'owner';
    await expect(unwrapCystRecoveryKey(duplicate, scope, 'owner', f.ownerIdentity)).rejects.toThrow();
    await expect(unwrapCystRecoveryKey({ ...f.wrapped, recoveryKey: 'leak' }, scope, 'owner', f.ownerIdentity)).rejects.toThrow();
    expect(() => parseWrappedCystKey(' '.repeat(CYST_KEY_WRAP_MAX_BYTES + 1))).toThrow('size limit');
    const serialized = serializeWrappedCystKey(f.wrapped);
    expect(() => parseWrappedCystKey(serialized.replace('"version":1', '"version":1,"version":1'))).toThrow('canonical');
    expect(() => serializeWrappedCystKey({ ...f.wrapped, unknown: true } as WrappedCystKey)).toThrow(); f.recoveryKey.fill(0);
  });
});
