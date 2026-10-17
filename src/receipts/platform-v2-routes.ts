import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import { verifyPlatformV2CombinedEvidence, verifyPlatformV2PublishedEvidence } from './platform-v2-combined.js';
import type { PlatformV2PublishedEvidenceReader } from './platform-v2-publication.js';
import { PLATFORM_V2_CORE_MAX_BYTES, platformV2EvidenceCoreSchema } from './platform-v2.js';

const BODY_MAX_BYTES = 300 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;
const VERIFICATION_TIMEOUT_MS = 30_000;
const MAX_IN_FLIGHT = 4;
const inputSchema = z.object({
  openTransactionHash: bytes32Schema,
  settlementTransactionHash: bytes32Schema,
  core: platformV2EvidenceCoreSchema,
}).strict();
const emptyQuerySchema = z.object({}).strict();

type ReadOnlyBridge = Parameters<typeof verifyPlatformV2CombinedEvidence>[0];
type CombinedResult = Awaited<ReturnType<typeof verifyPlatformV2CombinedEvidence>>;
type CombinedVerifier = (bridge: ReadOnlyBridge, openHash: string, settlementHash: string,
  core: unknown, minConfirmations: number) => Promise<CombinedResult>;

export type PlatformV2PublicVerification = Omit<CombinedResult, 'opening'> & {
  opening: Omit<CombinedResult['opening'], 'blockNumber' | 'confirmations'> & {
    blockNumber: string; confirmations: string;
  };
};

/** The archive opening reader uses bigint internally; the HTTP result uses decimal strings. */
export function platformV2PublicVerification(result: CombinedResult): PlatformV2PublicVerification {
  return { ...result, opening: { ...result.opening,
    blockNumber: result.opening.blockNumber.toString(),
    confirmations: result.opening.confirmations.toString() } };
}

class RequestFailure extends Error {
  constructor(readonly status: 400 | 408 | 413, readonly code: string) { super(code); }
}

function problem(context: Context, status: 400 | 408 | 413 | 415 | 422 | 429 | 503,
  title: string, detail: string) {
  return context.json({ type: 'about:blank', title, status, detail }, status,
    { 'Content-Type': 'application/problem+json' });
}

async function readBoundedBody(request: Request, onPendingCleanup: (cleanup: Promise<void>) => void): Promise<unknown> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > BODY_MAX_BYTES)) {
    throw new RequestFailure(413, 'payload_too_large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestFailure(400, 'invalid_json');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BODY_MAX_BYTES) throw new RequestFailure(413, 'payload_too_large');
      chunks.push(chunk.value);
    }
    complete = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new RequestFailure(400, 'invalid_json'); }
  };
  const readFlight = read();
  try {
    return await Promise.race([readFlight, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RequestFailure(408, 'request_timeout')), BODY_READ_TIMEOUT_MS);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (complete) reader.releaseLock();
    else {
      const cancellation = Promise.resolve().then(() => reader.cancel());
      onPendingCleanup(Promise.allSettled([readFlight, cancellation]).then(() => { reader.releaseLock(); }));
    }
  }
}

/** Read-only verification of a caller-presented, onchain-committed v2 core. */
export function createPlatformV2Routes(bridge: ReadOnlyBridge, minConfirmations = 12,
  verify: CombinedVerifier = verifyPlatformV2CombinedEvidence,
  published?: Pick<PlatformV2PublishedEvidenceReader, 'retrieve'>,
  verifyPublished: typeof verifyPlatformV2PublishedEvidence = verifyPlatformV2PublishedEvidence) {
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 128) {
    throw new Error('Platform v2 public confirmation depth is invalid');
  }
  const routes = new Hono();
  let inFlight = 0;
  routes.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  routes.get('/runs/:runId', async context => {
    const input = z.object({ runId: bytes32Schema,
      query: z.object({ settlementTransactionHash: bytes32Schema }).strict() }).strict()
      .safeParse({ runId: context.req.param('runId'), query: context.req.query() });
    if (!input.success) return problem(context, 422, 'invalid_input', 'The v2 evidence request is invalid.');
    if (!published) return problem(context, 503, 'publication_unavailable', 'Public evidence storage is unavailable.');
    if (inFlight >= MAX_IN_FLIGHT) return problem(context, 429, 'capacity_unavailable', 'The v2 verifier is at capacity. Retry later.');
    inFlight++;
    const work = Promise.resolve().then(() => verifyPublished(bridge, published, input.data.runId,
      input.data.query.settlementTransactionHash, minConfirmations));
    void work.then(() => { inFlight--; }, () => { inFlight--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('verification_timeout')), VERIFICATION_TIMEOUT_MS);
      })]);
      return context.json({ ...result, verification: platformV2PublicVerification(result.verification) });
    } catch {
      return problem(context, 503, 'verification_unavailable', 'The published v2 proof could not be verified.');
    } finally { if (timer) clearTimeout(timer); }
  });
  routes.post('/verify', async context => {
    if (!emptyQuerySchema.safeParse(context.req.query()).success) {
      return problem(context, 422, 'invalid_input', 'The v2 verification request is invalid.');
    }
    if (context.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return problem(context, 415, 'unsupported_media_type', 'A JSON request body is required.');
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      return problem(context, 429, 'capacity_unavailable', 'The v2 verifier is at capacity. Retry later.');
    }
    inFlight += 1;
    let verifierStarted = false;
    let bodyCleanup: Promise<void> | undefined;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight -= 1; } };
    try {
      const raw = await readBoundedBody(context.req.raw, cleanup => { bodyCleanup = cleanup; });
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) return problem(context, 422, 'invalid_input', 'The v2 verification request is invalid.');
      if (Buffer.byteLength(JSON.stringify(parsed.data.core), 'utf8') > PLATFORM_V2_CORE_MAX_BYTES) {
        return problem(context, 413, 'payload_too_large', 'The v2 evidence core exceeds its public bound.');
      }
      verifierStarted = true;
      const work = Promise.resolve().then(() => verify(bridge, parsed.data.openTransactionHash,
        parsed.data.settlementTransactionHash, parsed.data.core, minConfirmations));
      void work.then(release, release);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('verification_timeout')), VERIFICATION_TIMEOUT_MS);
        })]);
        return context.json(platformV2PublicVerification(result));
      } catch {
        // Cryptographic rejection and RPC uncertainty have no reliable typed
        // distinction at this boundary. Neither exposes verifier internals.
        return problem(context, 503, 'verification_unavailable', 'The v2 proof could not be verified.');
      } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      if (error instanceof RequestFailure) {
        const detail = error.status === 413 ? 'The v2 verification request exceeds 300 KiB.'
          : error.status === 408 ? 'The v2 verification body was not received within five seconds.'
            : 'The request body must be valid JSON.';
        return problem(context, error.status, error.code, detail);
      }
      return problem(context, 503, 'verification_unavailable', 'The v2 proof could not be verified.');
    } finally {
      // A timed-out verifier keeps its slot until RPC work actually settles.
      if (!verifierStarted) {
        if (bodyCleanup) void bodyCleanup.then(release, release);
        else release();
      }
    }
  });
  return routes;
}
