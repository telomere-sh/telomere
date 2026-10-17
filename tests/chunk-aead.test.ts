import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { afterEach, expect, it, vi } from 'vitest';
import { cystChunkAeadBackend, decryptCystChunk, encryptCystChunk } from '../src/cysts/chunk-aead.js';

// Public interoperability vectors, never user recovery keys.
const key = Uint8Array.from({ length: 32 }, (_, index) => 0x80 + index);
const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0x40 + index);
const aad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex');
const plaintext = Buffer.from('4c616469657320616e642047656e746c656d656e206f662074686520636c617373206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73637265656e20776f756c642062652069742e', 'hex');
const vector = Buffer.from('bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49', 'hex');
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

it('matches the published draft-irtf-cfrg-xchacha-03 AppendixA.1 AEAD vector exactly', () => {
  expect(cystChunkAeadBackend()).toBe('node');
  expect(Buffer.from(encryptCystChunk(key, nonce, aad, plaintext)).equals(vector)).toBe(true);
  expect(Buffer.from(decryptCystChunk(key, nonce, aad, vector)).equals(plaintext)).toBe(true);
});

it.each([0, 1, 15, 16, 17, 63, 64, 65, 65_537, 4 * 1024 * 1024])('preserves noble1.3 ciphertext/tag format bidirectionally for %i plaintext bytes', length => {
  const data = Buffer.alloc(length, 0x71), associated = Buffer.from('existing-header-index-length-aad/' + length);
  const oldCiphertext = xchacha20poly1305(key, nonce, associated).encrypt(data);
  const nativeCiphertext = encryptCystChunk(key, nonce, associated, data);
  expect(Buffer.from(nativeCiphertext).equals(oldCiphertext)).toBe(true);
  expect(Buffer.from(decryptCystChunk(key, nonce, associated, oldCiphertext)).equals(data)).toBe(true);
  expect(Buffer.from(xchacha20poly1305(key, nonce, associated).decrypt(nativeCiphertext)).equals(data)).toBe(true);
  expect(nativeCiphertext.length).toBe(length + 16);
});

it('accepts nonzero-offset unaligned typed-array views and preserves every caller-owned input', () => {
  const keyStorage = Buffer.concat([Buffer.from([4]), key, Buffer.from([5])]), nonceStorage = Buffer.concat([Buffer.from([6]), nonce, Buffer.from([7])]);
  const keyView = keyStorage.subarray(1, 33), nonceView = nonceStorage.subarray(1, 25), aadView = aad.subarray(1);
  const before = [Buffer.from(keyStorage), Buffer.from(nonceStorage), Buffer.from(aad), Buffer.from(plaintext)];
  const ciphertext = encryptCystChunk(keyView, nonceView, aadView, plaintext);
  expect(Buffer.from(decryptCystChunk(keyView, nonceView, aadView, ciphertext)).equals(plaintext)).toBe(true);
  expect([keyStorage, nonceStorage, aad, plaintext].every((bytes, index) => bytes.equals(before[index]!))).toBe(true);
});

it.each(['key', 'nonce', 'aad', 'ciphertext', 'tag', 'truncated', 'appended'] as const)('rejects %s tampering without returning plaintext', field => {
  const k = Buffer.from(key), n = Buffer.from(nonce), a = Buffer.from(aad); let c = Buffer.from(vector);
  if (field === 'key') k[0] = k[0]! ^ 1;
  else if (field === 'nonce') n[0] = n[0]! ^ 1;
  else if (field === 'aad') a[0] = a[0]! ^ 1;
  else if (field === 'ciphertext') c[0] = c[0]! ^ 1;
  else if (field === 'tag') c[c.length - 1] = c[c.length - 1]! ^ 1;
  else if (field === 'truncated') c = c.subarray(0, c.length - 1);
  else c = Buffer.concat([c, Buffer.from([1])]);
  expect(() => decryptCystChunk(k, n, a, c)).toThrow(/^Cyst chunk authentication failed$/);
});

it('uses the published HChaCha subkey and clears the exact native key/IV buffers after encryption', () => {
  const original = crypto.createCipheriv; let observedKey: Buffer | undefined, observedIv: Buffer | undefined, publicSubkey: Buffer | undefined;
  // REASON: the fixture intercepts the helper's byte-only ChaCha overload; all
  // real cryptography still runs through the original native implementation.
  vi.spyOn(crypto, 'createCipheriv').mockImplementation(((algorithm: string, nativeKey: crypto.CipherKey,
    iv: crypto.BinaryLike | null, options?: crypto.CipherChaCha20Poly1305Options) => {
    if (!Buffer.isBuffer(nativeKey) || !Buffer.isBuffer(iv)) throw new Error('Native byte inputs absent');
    observedKey = nativeKey; observedIv = iv; publicSubkey = Buffer.from(nativeKey);
    return original(algorithm, nativeKey, iv, options);
  }) as typeof crypto.createCipheriv);
  const hKey = Uint8Array.from({ length: 32 }, (_, index) => index), hNonce = Buffer.from('000000090000004a00000000314159270000000000000000', 'hex');
  encryptCystChunk(hKey, hNonce, aad, plaintext);
  expect(publicSubkey?.toString('hex')).toBe('82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
  expect(observedKey?.every(byte => byte === 0)).toBe(true); expect(observedIv?.every(byte => byte === 0)).toBe(true);
  expect(hKey.every((byte, index) => byte === index)).toBe(true);
});

it('clears the actual unauthenticated buffer emitted by native update when final rejects a bad tag', () => {
  const original = crypto.createDecipheriv; let emitted: Buffer | undefined, emittedRealPlaintext = false, observedKey: Buffer | undefined;
  // REASON: this observes the byte-only overload used by the helper and retains
  // its real returned buffer, never a fake authentication implementation.
  vi.spyOn(crypto, 'createDecipheriv').mockImplementation(((algorithm: string, nativeKey: crypto.CipherKey,
    iv: crypto.BinaryLike | null, options?: crypto.CipherChaCha20Poly1305Options) => {
    const decipher = original(algorithm, nativeKey, iv, options), update = decipher.update.bind(decipher);
    if (Buffer.isBuffer(nativeKey)) observedKey = nativeKey;
    // REASON: the helper calls only update(Uint8Array); encoded overloads are unused here.
    decipher.update = ((data: NodeJS.ArrayBufferView) => {
      const result = update(data); emitted = result; emittedRealPlaintext = result.equals(plaintext); return result;
    }) as typeof decipher.update;
    return decipher;
  }) as typeof crypto.createDecipheriv);
  const corrupted = Buffer.from(vector); corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  expect(() => decryptCystChunk(key, nonce, aad, corrupted)).toThrow(/^Cyst chunk authentication failed$/);
  expect(emittedRealPlaintext).toBe(true); expect(emitted?.length).toBe(plaintext.length);
  expect(emitted?.every(byte => byte === 0)).toBe(true); expect(observedKey?.every(byte => byte === 0)).toBe(true);
});

it('refuses a native failure for valid ciphertext and clears derived material instead of silently retrying through noble', () => {
  let captured: Buffer | undefined;
  vi.spyOn(crypto, 'createDecipheriv').mockImplementation((_algorithm, nativeKey) => {
    if (Buffer.isBuffer(nativeKey)) captured = nativeKey; throw new Error('private-native-failure-marker');
  });
  expect(() => decryptCystChunk(key, nonce, aad, vector)).toThrow(/^Cyst chunk authentication failed$/);
  expect(captured?.every(byte => byte === 0)).toBe(true);
});

it('selects the unchanged portable cipher only when native availability is absent before processing', async () => {
  vi.spyOn(crypto, 'getCiphers').mockReturnValue([]); vi.resetModules();
  const portable = await import('../src/cysts/chunk-aead.js'); expect(portable.cystChunkAeadBackend()).toBe('noble');
  expect(Buffer.from(portable.encryptCystChunk(key, nonce, aad, plaintext)).equals(vector)).toBe(true);
  expect(Buffer.from(portable.decryptCystChunk(key, nonce, aad, vector)).equals(plaintext)).toBe(true);
  const bad = Buffer.from(vector); bad[0] = bad[0]! ^ 1;
  expect(() => portable.decryptCystChunk(key, nonce, aad, bad)).toThrow();
});

it('rejects invalid sizes/types, oversized chunks/AAD and shared mutable buffers before cipher construction', () => {
  const encrypt = vi.spyOn(crypto, 'createCipheriv'), decrypt = vi.spyOn(crypto, 'createDecipheriv');
  for (const args of [
    [key.subarray(1), nonce, aad, plaintext], [key, nonce.subarray(1), aad, plaintext],
    [key, nonce, Buffer.alloc(8193), plaintext], [key, nonce, aad, Buffer.alloc(4 * 1024 * 1024 + 1)],
    [key, nonce, aad, new Uint8Array(new SharedArrayBuffer(1))], [Array.from(key), nonce, aad, plaintext],
  ]) expect(() => Reflect.apply(encryptCystChunk, undefined, args)).toThrow('input refused');
  expect(() => decryptCystChunk(key, nonce, aad, Buffer.alloc(15))).toThrow('input refused');
  expect(() => decryptCystChunk(key, nonce, aad, Buffer.alloc(4 * 1024 * 1024 + 17))).toThrow('input refused');
  expect(encrypt).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled();
});
