import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import { cystRegistryHashSchema } from './registry-types.js';
import type { LargeCystPublicationService } from './large-publication-service.js';
import { cystAddressSchema, cystIdempotencySchema, cystIdSchema } from './types.js';

const partIndexSchema = z.string().regex(/^(0|[1-9][0-9]{0,2})$/).transform(Number)
  .pipe(z.number().int().min(0).max(511));

async function boundedBody(context: Context): Promise<unknown> {
  const contentLength = context.req.header('content-length');
  if (contentLength !== undefined && (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > 512)) {
    throw new Problem(413, 'cyst_publication_body_limit', 'Publication request exceeds 512 bytes.');
  }
  const reader = context.req.raw.body?.getReader();
  if (!reader) throw new Problem(422, 'invalid_input', 'Send a JSON object.');
  const chunks: Uint8Array[] = [];
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, complete = false;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Problem(503, 'cyst_publication_body_timeout', 'Publication request timed out.'));
  }, 5000); });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) { complete = true; break; }
      count += result.value.byteLength;
      if (count > 512) throw new Problem(413, 'cyst_publication_body_limit', 'Publication request exceeds 512 bytes.');
      chunks.push(result.value);
    }
    if (contentLength !== undefined && Number(contentLength) !== count) throw new Problem(422, 'invalid_input', 'Publication request length changed.');
    const bytes = Buffer.concat(chunks, count);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Problem(422, 'invalid_input', 'Send a UTF-8 JSON object.'); }
  } finally {
    clearTimeout(timer);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Mount behind normal Origin, session and socket-rate middleware. */
export function createLargeCystPublicationRoutes(service: LargeCystPublicationService,
  authenticate: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { principal: string } }>();
  routes.use('*', async (context, next) => {
    context.set('principal', cystAddressSchema.parse(await authenticate(context)));
    context.header('Cache-Control', 'no-store');
    await next();
  });
  routes.post('/agents/:agentId/jobs', async context => {
    const agentId = cystRegistryHashSchema.parse(context.req.param('agentId'));
    const key = cystIdempotencySchema.parse(context.req.header('idempotency-key'));
    const body = z.object({ checkpointId: cystIdSchema }).strict().parse(await boundedBody(context));
    return context.json(await service.submit(context.get('principal'), agentId, body.checkpointId, key), 202);
  });
  routes.get('/agents/:agentId/checkpoints/current', async context => {
    const agentId = cystRegistryHashSchema.parse(context.req.param('agentId'));
    const resolved = await service.current(context.get('principal'), agentId);
    const bytes = Buffer.from(JSON.stringify(resolved), 'utf8');
    if (bytes.byteLength > 147_456) throw new Problem(503, 'cyst_manifest_limit',
      'Current checkpoint response exceeds the limit.');
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(bytes.byteLength), 'Cache-Control': 'no-store' } });
  });
  routes.get('/agents/:agentId/checkpoints/:checkpointId/manifest', async context => {
    const agentId = cystRegistryHashSchema.parse(context.req.param('agentId'));
    const checkpointId = cystIdSchema.parse(context.req.param('checkpointId'));
    const manifest = await service.manifest(context.get('principal'), agentId, checkpointId);
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (bytes.byteLength > 131_072) throw new Problem(503, 'cyst_manifest_limit', 'Checkpoint manifest exceeds the response limit.');
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(bytes.byteLength), 'Cache-Control': 'no-store' } });
  });
  routes.get('/agents/:agentId/checkpoints/:checkpointId/parts/:index', async context => {
    const agentId = cystRegistryHashSchema.parse(context.req.param('agentId'));
    const checkpointId = cystIdSchema.parse(context.req.param('checkpointId'));
    const index = partIndexSchema.parse(context.req.param('index'));
    const { bytes, release } = await service.part(context.get('principal'), agentId, checkpointId, index);
    try {
      let offset = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { clearTimeout(timer); release(); };
      const body = new ReadableStream<Uint8Array>({
        start(controller) { timer = setTimeout(() => {
          controller.error(new Error('Agent checkpoint download timed out'));
          finish();
        }, 60_000); },
        pull(controller) {
          if (offset >= bytes.length) { controller.close(); finish(); return; }
          const next = Math.min(bytes.length, offset + 65_536);
          controller.enqueue(Uint8Array.from(bytes.subarray(offset, next)));
          offset = next;
        },
        cancel() { finish(); },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length), 'Cache-Control': 'no-store' } });
    } catch (error) { release(); throw error; }
  });
  routes.get('/agents/:agentId/jobs/:jobId', async context => {
    const agentId = cystRegistryHashSchema.parse(context.req.param('agentId'));
    const job = await service.get(context.get('principal'), context.req.param('jobId'), agentId);
    return context.json(job);
  });
  routes.post('/agents/:agentId/jobs/:jobId/cancel', async context => {
    const agentId = cystRegistryHashSchema.parse(context.req.param('agentId'));
    z.object({}).strict().parse(await boundedBody(context));
    const job = await service.cancel(context.get('principal'), context.req.param('jobId'), agentId);
    return context.json(job);
  });
  return routes;
}
