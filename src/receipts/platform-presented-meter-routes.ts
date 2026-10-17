import { Hono } from 'hono';
import type { Context } from 'hono';
import type { PlatformPins } from '../platform-runtime/types.js';
import { PRESENTED_METER_MAX_BYTES, verifyPresentedMeterBundle } from '../platform-runtime/presented-meter.js';

const BODY_READ_TIMEOUT_MS = 5_000;
const VERIFICATION_TIMEOUT_MS = 30_000;
const MAX_IN_FLIGHT = 4;

class PresentedMeterRequestError extends Error {
  constructor(readonly status: 400 | 408 | 413, readonly code: string, message: string) {
    super(message);
  }
}

function problem(context: Context, status: 400 | 408 | 413 | 429 | 503, title: string, detail: string) {
  return context.json({ type: 'about:blank', title, status, detail }, status,
    { 'Content-Type': 'application/problem+json' });
}

async function readBoundedBody(request: Request, onPendingCleanup: (cleanup: Promise<void>) => void): Promise<unknown> {
  const reportedLength = Number(request.headers.get('Content-Length'));
  if (reportedLength > PRESENTED_METER_MAX_BYTES) {
    throw new PresentedMeterRequestError(413, 'payload_too_large',
      'The presented meter bundle exceeds 96 KiB.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new PresentedMeterRequestError(400, 'invalid_input', 'A JSON body is required.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  let readPromise: Promise<unknown> | undefined;
  try {
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > PRESENTED_METER_MAX_BYTES) {
          throw new PresentedMeterRequestError(413, 'payload_too_large',
            'The presented meter bundle exceeds 96 KiB.');
        }
        chunks.push(chunk.value);
      }
      complete = true;
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
      catch { throw new PresentedMeterRequestError(400, 'invalid_input', 'The body must be valid JSON.'); }
    };
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PresentedMeterRequestError(408, 'request_timeout',
        'The presented meter body was not received within 5 seconds.')), BODY_READ_TIMEOUT_MS);
    });
    readPromise = read();
    return await Promise.race([readPromise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!complete) {
      const cancellation = Promise.resolve().then(() => reader.cancel());
      onPendingCleanup(Promise.allSettled([readPromise, cancellation]).then(() => undefined));
    }
  }
}

/** Public, read-only verification of a caller-presented subset of signed HostKit ticks. */
export function createPlatformPresentedMeterRoutes(pins: PlatformPins, rpcUrl: string, minConfirmations = 12,
  verify: typeof verifyPresentedMeterBundle = verifyPresentedMeterBundle) {
  const routes = new Hono();
  let inFlight = 0;
  routes.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  routes.post('/verify', async context => {
    if (inFlight >= MAX_IN_FLIGHT) return problem(context, 429, 'capacity_unavailable',
      'The presented meter verifier is at capacity. Retry later.');
    inFlight += 1;
    let verifierStarted = false;
    let bodyCleanup: Promise<void> | undefined;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight -= 1; } };
    try {
      const body = await readBoundedBody(context.req.raw, cleanup => { bodyCleanup = cleanup; });
      verifierStarted = true;
      const verification = Promise.resolve().then(() => verify(body, pins, rpcUrl, minConfirmations));
      void verification.then(release, release);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('verification_timeout')), VERIFICATION_TIMEOUT_MS);
      });
      try {
        return context.json(await Promise.race([verification, deadline]));
      } catch (error) {
        if (error instanceof Error && error.message === 'verification_timeout') {
          return problem(context, 503, 'verification_timeout',
            'The presented meter verification exceeded 30 seconds. Retry later.');
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof PresentedMeterRequestError) {
        return problem(context, error.status, error.code, error.message);
      }
      throw error;
    } finally {
      // Timed-out verification keeps its slot until its RPC work actually stops.
      if (!verifierStarted) {
        if (bodyCleanup) void bodyCleanup.then(release, release);
        else release();
      }
    }
  });
  return routes;
}
