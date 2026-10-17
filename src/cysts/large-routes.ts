import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import { LARGE_CYST_MAX_PART_BYTES, largeCystPartBytes, parseLargeCystHeader,
  parseLargeCystManifest, LargeCystError, type LargeCystHeader, type LargeCystStore } from './large-checkpoints.js';
import { cystAddressSchema, cystIdSchema } from './types.js';

const indexSchema = z.string().regex(/^(0|[1-9][0-9]{0,2})$/).transform(Number).pipe(z.number().int().min(0).max(511));
const defaultRequestTimeoutMs = 60_000;
async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof LargeCystError) {
      if (error.code === 'quota_exceeded') throw new Problem(409, 'cyst_quota_exceeded', 'Large checkpoint storage quota is full.');
      if (error.code === 'conflict' || error.code === 'destination_exists') throw new Problem(409, 'cyst_conflict', 'Checkpoint differs from the immutable upload.');
      if (error.code === 'integrity_failed' || error.code === 'invalid_source' || error.code === 'invalid_key') throw new Problem(422, 'cyst_payload_invalid', 'Checkpoint payload failed validation.');
      if (error.code === 'incomplete') throw new Problem(409, 'cyst_pending', 'Checkpoint is incomplete.');
      throw new Problem(503, 'cyst_storage_unavailable', 'Checkpoint storage is unavailable.');
    }
    throw error;
  }
}

/** Reads one request body with a fixed upper bound, including chunked transfer.
 * A deadline cancels the reader so a stalled client cannot hold the upload open.
 */
async function boundedBody(context: Context, maxBytes: number, requestTimeoutMs: number): Promise<Buffer> {
  const encoding = context.req.header('content-encoding');
  if (encoding !== undefined && encoding !== 'identity') {
    throw new Problem(422, 'cyst_payload_invalid', 'Compressed checkpoint transport is not accepted.');
  }
  const claimed = context.req.header('content-length');
  if (claimed !== undefined && (!/^(0|[1-9][0-9]{0,9})$/.test(claimed) || Number(claimed) > maxBytes)) {
    throw new Problem(413, 'payload_too_large', 'Checkpoint request exceeds its byte limit.');
  }
  const reader = context.req.raw.body?.getReader();
  if (!reader) throw new Problem(422, 'cyst_payload_invalid', 'Checkpoint request body is missing.');
  const chunks: Uint8Array[] = []; let total = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Problem(503, 'cyst_upload_timeout', 'Checkpoint upload timed out.'));
    void reader.cancel().catch(() => undefined);
  }, requestTimeoutMs); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      if (next.value.byteLength > maxBytes - total) throw new Problem(413, 'payload_too_large', 'Checkpoint request exceeds its byte limit.');
      chunks.push(next.value); total += next.value.byteLength;
    }
    if (claimed !== undefined && total !== Number(claimed)) throw new Problem(422, 'cyst_payload_invalid', 'Checkpoint request length changed.');
    return Buffer.concat(chunks, total);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
async function boundedJson(context: Context, maxBytes: number, requestTimeoutMs: number): Promise<unknown> {
  const bytes = await boundedBody(context, maxBytes, requestTimeoutMs);
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new Problem(422, 'cyst_payload_invalid', 'Checkpoint JSON is invalid.'); }
}
async function ownedHeader(store: LargeCystStore, id: string, authenticatedOwner: string): Promise<LargeCystHeader> {
  const owner = cystAddressSchema.parse(authenticatedOwner), header = await guarded(() => store.header(cystIdSchema.parse(id)));
  if (!header || header.owner !== owner) throw new Problem(404, 'cyst_not_found', 'Checkpoint not found.');
  return header;
}

/** Binary multipart routes. Only ciphertext crosses this boundary; key and
 * plaintext remain with the owner-side SDK. Mount behind the normal owner auth,
 * origin check and rate limiter, with the generic JSON body limit bypassed.
 */
export function createLargeCystRoutes(store: LargeCystStore,
  owner: (context: Context) => Promise<string>, options: { requestTimeoutMs?: number } = {}): Hono {
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10 || requestTimeoutMs > defaultRequestTimeoutMs) {
    throw new Error('Invalid large Cyst request deadline');
  }
  const router = new Hono();
  let inFlight = 0, commitsInFlight = 0;
  const ownerInFlight = new Map<string, number>();
  function admitHeavy(ownerAddress: string, commit = false): () => void {
    const count = ownerInFlight.get(ownerAddress) ?? 0;
    if (inFlight >= 4 || count >= 2 || commit && commitsInFlight >= 1) {
      throw new Problem(429, 'cyst_transfer_busy', 'Too many large checkpoint transfers are active.');
    }
    inFlight++; if (commit) commitsInFlight++;
    ownerInFlight.set(ownerAddress, count + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      inFlight--;
      if (commit) commitsInFlight--;
      const current = ownerInFlight.get(ownerAddress) ?? 0;
      if (current <= 1) ownerInFlight.delete(ownerAddress);
      else ownerInFlight.set(ownerAddress, current - 1);
    };
  }
  router.post('/', async context => {
    const authenticated = cystAddressSchema.parse(await owner(context));
    const header = parseLargeCystHeader(await boundedJson(context, 2048, requestTimeoutMs));
    if (header.owner !== authenticated) throw new Problem(403, 'cyst_owner_mismatch', 'Checkpoint owner differs from the authenticated owner.');
    await guarded(() => store.begin(header));
    return context.json(header, 201);
  });
  router.get('/:id/header', async context => context.json(await ownedHeader(store, context.req.param('id'), await owner(context))));
  router.put('/:id/parts/:index', async context => {
    const header = await ownedHeader(store, context.req.param('id'), await owner(context));
    const release = admitHeavy(header.owner);
    try {
      if (context.req.header('content-type') !== 'application/octet-stream') {
        throw new Problem(422, 'cyst_payload_invalid', 'Send application/octet-stream for a ciphertext part.');
      }
      const index = indexSchema.parse(context.req.param('index'));
      const expectedBytes = largeCystPartBytes(header, index);
      const body = await boundedBody(context, Math.min(expectedBytes, LARGE_CYST_MAX_PART_BYTES), requestTimeoutMs);
      if (body.length !== expectedBytes) throw new Problem(422, 'cyst_payload_invalid', 'Checkpoint part length changed.');
      await guarded(() => store.putPart(header.id, index, body));
      return context.json({ index, bytes: body.length }, 201);
    } finally { release(); }
  });
  router.get('/:id/parts/:index', async context => {
    const header = await ownedHeader(store, context.req.param('id'), await owner(context));
    const release = admitHeavy(header.owner);
    try {
      const index = indexSchema.parse(context.req.param('index'));
      const part = await guarded(() => store.part(header.id, index));
      if (!part) throw new Problem(404, 'cyst_part_not_found', 'Checkpoint part not found.');
      let offset = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { clearTimeout(timer); release(); };
      const body = new ReadableStream<Uint8Array>({
        start(controller) { timer = setTimeout(() => {
          controller.error(new Error('Checkpoint download timed out'));
          finish();
        }, requestTimeoutMs); },
        pull(controller) {
          if (offset >= part.length) { controller.close(); finish(); return; }
          const next = Math.min(part.length, offset + 65_536);
          controller.enqueue(Uint8Array.from(part.subarray(offset, next)));
          offset = next;
        },
        cancel() { finish(); },
      });
      return new Response(body, { status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(part.length), 'Cache-Control': 'no-store' } });
    } catch (error) { release(); throw error; }
  });
  router.post('/:id/commit', async context => {
    const header = await ownedHeader(store, context.req.param('id'), await owner(context));
    const release = admitHeavy(header.owner, true);
    try {
      const manifest = parseLargeCystManifest(await boundedJson(context, 131_072, requestTimeoutMs));
      if (manifest.header.id !== header.id || JSON.stringify(manifest.header) !== JSON.stringify(header)) {
        throw new Problem(409, 'cyst_conflict', 'Checkpoint manifest differs from the immutable header.');
      }
      await guarded(() => store.commit(manifest));
      return context.json(manifest, 200);
    } finally { release(); }
  });
  router.get('/:id/manifest', async context => {
    const header = await ownedHeader(store, context.req.param('id'), await owner(context));
    const manifest = await guarded(() => store.manifest(header.id));
    if (!manifest) throw new Problem(409, 'cyst_pending', 'Checkpoint manifest is not committed.');
    return context.json(manifest);
  });
  return router;
}
