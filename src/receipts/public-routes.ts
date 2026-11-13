import { Hono } from 'hono';
import type { Context } from 'hono';
import { publicReceiptInputSchema, type PublicReceiptReport } from './public-verifier.js';

export const PUBLIC_RECEIPT_MAX_BYTES = 131072;
class RequestError extends Error {
  constructor(readonly status: 400 | 408 | 413 | 422, readonly code: string, message: string) { super(message); }
}
function problem(context: Context, status: 400 | 408 | 413 | 422 | 429 | 503, title: string, detail: string) {
  return context.json({ type: 'about:blank', title, status, detail }, status, { 'Content-Type': 'application/problem+json' });
}
async function boundedJson(request: Request, cleanup: (pending: Promise<unknown>) => void): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > PUBLIC_RECEIPT_MAX_BYTES) throw new RequestError(413, 'payload_too_large', 'Receipt JSON must fit within 128 KiB.');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'invalid_input', 'A JSON body is required.');
  let complete = false, timer: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > PUBLIC_RECEIPT_MAX_BYTES) throw new RequestError(413, 'payload_too_large', 'Receipt JSON must fit within 128 KiB.');
      chunks.push(chunk.value);
    }
    complete = true;
    const result = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)) as unknown; }
    catch { throw new RequestError(400, 'invalid_json', 'Paste valid JSON or use a run ID.'); }
  })();
  try {
    return await Promise.race([reading, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RequestError(408, 'request_timeout', 'Receipt JSON was not received within 5 seconds.')), 5000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!complete) cleanup(Promise.allSettled([reading, Promise.resolve().then(() => reader.cancel())]));
  }
}
/** Prevent recursive hashing or schema processing of deeply nested attacker-controlled JSON. */
function boundedStructure(value: unknown): boolean {
  const stack = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const item = stack.pop(); if (!item || ++nodes > 8192 || item.depth > 24) return false;
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}
export function createPublicReceiptRoutes(verifier: { verify(input: ReturnType<typeof publicReceiptInputSchema.parse>): Promise<PublicReceiptReport> },
  verificationTimeoutMs = 30000) {
  const routes = new Hono(); let inFlight = 0;
  routes.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  routes.post('/verify', async context => {
    if (inFlight >= 2) return problem(context, 429, 'verification_busy', 'Receipt verification is busy. Retry shortly.');
    ++inFlight; let released = false, started = false, cleanup: Promise<unknown> | undefined;
    const release = (): void => { if (!released) { released = true; --inFlight; } };
    try {
      const value = await boundedJson(context.req.raw, pending => { cleanup = pending; });
      if (!boundedStructure(value)) throw new RequestError(422, 'receipt_too_complex', 'The receipt JSON has too many nested fields. Use the original receipt export.');
      const parsed = publicReceiptInputSchema.safeParse(value);
      if (!parsed.success) throw new RequestError(422, 'invalid_input', 'Submit either a 0x run ID or receipt JSON, not both.');
      started = true;
      const work = Promise.resolve().then(() => verifier.verify(parsed.data));
      void work.then(release, release);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return context.json(await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('verification_timeout')), verificationTimeoutMs);
        })]));
      } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      if (error instanceof RequestError) return problem(context, error.status, error.code, error.message);
      return problem(context, 503, 'verification_unavailable', 'Verification is temporarily unavailable. Retry the read-only check; no transaction was requested.');
    } finally {
      // Timed-out verification retains its slot until the underlying RPC work actually settles.
      if (!started) { if (cleanup) void cleanup.then(release, release); else release(); }
    }
  });
  return routes;
}
