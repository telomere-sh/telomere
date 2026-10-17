import crypto from 'node:crypto';
import { hchacha, xchacha20poly1305 } from '@noble/ciphers/chacha';

const maximumPlaintext = 4 * 1024 * 1024, maximumAad = 8192, tagBytes = 16;
const sigma = Uint32Array.from([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
// Availability is selected before any message is processed. Authentication or
// native-operation failures never trigger a retry through another backend.
const backend = crypto.getCiphers().includes('chacha20-poly1305') ? 'node' : 'noble';
export function cystChunkAeadBackend(): 'node' | 'noble' { return backend; }

function inputs(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array, decrypt: boolean): void {
  for (const value of [key, nonce, aad, data]) {
    if (!(value instanceof Uint8Array) || value.buffer instanceof SharedArrayBuffer) throw new Error('Cyst chunk input refused');
  }
  if (key.length !== 32 || nonce.length !== 24 || aad.length > maximumAad
    || data.length < (decrypt ? tagBytes : 0) || data.length > maximumPlaintext + (decrypt ? tagBytes : 0)) throw new Error('Cyst chunk input refused');
}

/** XChaCha construction from draft-irtf-cfrg-xchacha-03 §2.3, using
 * noble1.3's existing HChaCha implementation, not a new rounds implementation.
 * Explicit LE conversion also supports unaligned key/nonce views. */
function material(key: Uint8Array, nonce: Uint8Array) {
  const keyWords = new Uint32Array(8), nonceWords = new Uint32Array(4), outputWords = new Uint32Array(8);
  const subkey = Buffer.alloc(32), iv = Buffer.alloc(12);
  const clear = () => { keyWords.fill(0); nonceWords.fill(0); outputWords.fill(0); subkey.fill(0); iv.fill(0); };
  try {
    const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength), nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    for (let index = 0; index < keyWords.length; index++) keyWords[index] = keyView.getUint32(index * 4, true);
    for (let index = 0; index < nonceWords.length; index++) nonceWords[index] = nonceView.getUint32(index * 4, true);
    hchacha(sigma, keyWords, nonceWords, outputWords);
    for (let index = 0; index < outputWords.length; index++) subkey.writeUInt32LE(outputWords[index]!, index * 4);
    iv.set(nonce.subarray(16), 4); // Four fixed zero bytes followed by the original nonce's final eight bytes.
    return { subkey, iv, clear };
  } catch { clear(); throw new Error('Cyst chunk derivation failed'); }
}

/** Returns the existing ciphertext||16-byte-tag bytes; the caller retains the
 * original24-byte nonce prefix, AAD, header and manifest/HMAC format. */
export function encryptCystChunk(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  inputs(key, nonce, aad, plaintext, false);
  if (backend === 'noble') return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  const derived = material(key, nonce);
  try {
    const cipher = crypto.createCipheriv('chacha20-poly1305', derived.subkey, derived.iv, { authTagLength: tagBytes });
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  } catch { throw new Error('Cyst chunk encryption failed'); }
  finally { derived.clear(); }
}

/** Node may emit unauthenticated plaintext from update(). It remains local and
 * is never returned to the caller until final() authenticates the entire tag.
 * On failure that exact buffer is cleared before the error escapes. */
export function decryptCystChunk(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  inputs(key, nonce, aad, ciphertext, true);
  if (backend === 'noble') return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  const derived = material(key, nonce); let partial: Buffer | undefined;
  try {
    const decipher = crypto.createDecipheriv('chacha20-poly1305', derived.subkey, derived.iv, { authTagLength: tagBytes });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length - tagBytes }); decipher.setAuthTag(ciphertext.subarray(ciphertext.length - tagBytes));
    partial = decipher.update(ciphertext.subarray(0, ciphertext.length - tagBytes));
    const tail = decipher.final(); // Authentication must succeed before any plaintext publication.
    if (tail.length !== 0 || partial.length !== ciphertext.length - tagBytes) { tail.fill(0); throw new Error('Unexpected native output'); }
    const authenticated = partial; partial = undefined; return authenticated;
  } catch { partial?.fill(0); throw new Error('Cyst chunk authentication failed'); }
  finally { derived.clear(); }
}
