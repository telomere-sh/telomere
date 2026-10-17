import { createHash } from 'node:crypto';
import { Problem } from '../../common.js';
import { CYST_INPUT_STREAM_CHUNK_BYTES, type CystInputDescriptor } from './cyst-input-protocol.js';

/** Consume an exact duplicate body before acknowledging an existing staged or
 * published file. Cancelling a still-uploading HTTP request can close its
 * socket before the result is delivered. This never writes or replaces data.
 */
export async function verifyDuplicateCystInput(input: ReadableStream<Uint8Array>, expected: CystInputDescriptor,
  signal: AbortSignal, assertActive: () => void): Promise<void> {
  const reader = input.getReader(), hash = createHash('sha256'); let length = 0;
  const aborted = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); assertActive();
      const value = await reader.read(); signal.throwIfAborted(); assertActive();
      if (value.done) break;
      if (value.value.byteLength > CYST_INPUT_STREAM_CHUNK_BYTES || value.value.byteLength > expected.plaintextBytes - length) {
        throw new Problem(422, 'cyst_input_length', 'Duplicate paid file bytes exceed their original declaration.');
      }
      hash.update(value.value); length += value.value.byteLength;
    }
    if (length !== expected.plaintextBytes || hash.digest('hex') !== expected.plaintextSha256) {
      throw new Problem(422, 'cyst_input_integrity', 'Duplicate paid file bytes differ from their original declaration.');
    }
    signal.throwIfAborted(); assertActive();
  } finally {
    signal.removeEventListener('abort', aborted);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([reader.cancel().catch(() => undefined), new Promise<void>(done => { timer = setTimeout(done, 1000); })]); }
    finally { clearTimeout(timer); reader.releaseLock(); }
  }
}
