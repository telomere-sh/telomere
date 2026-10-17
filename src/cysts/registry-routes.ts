import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import { cystAddressSchema, cystIdSchema, cystIdempotencySchema } from './types.js';
import { cystRegistryHashSchema, cystRegistryUint64Schema } from './registry-types.js';
import type { CystRegistryService } from './registry-service.js';

async function body(context: Context): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(context.req.header('content-type') ?? '')) {
    throw new Problem(422, 'json_required', 'Send application/json.');
  }
  const length = context.req.header('content-length');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 8192)) {
    throw new Problem(422, 'cyst_registry_body_limit', 'Registry requests may contain at most 8 KiB.');
  }
  const reader = context.req.raw.body?.getReader(); if (!reader) throw new Problem(422, 'invalid_input', 'Send a JSON object.');
  const chunks: Uint8Array[] = []; let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Problem(422, 'cyst_registry_body_timeout', 'The registry request body did not finish.'));
    void reader.cancel().catch(() => undefined);
  }, 5000); });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), timeout]); if (item.done) break;
      size += item.value.byteLength;
      if (size > 8192) { void reader.cancel().catch(() => undefined); throw new Problem(422, 'cyst_registry_body_limit', 'Registry requests may contain at most 8 KiB.'); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Problem(422, 'invalid_input', 'Send a UTF-8 JSON object.'); }
    return JSON.parse(decoded);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Mount under /api/cyst-registry with the existing trusted Origin, session and socket-rate middleware. */
export function createCystRegistryRoutes(service: CystRegistryService, authenticate: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { cystPrincipal: string } }>();
  routes.use('*', async (context, next) => {
    context.set('cystPrincipal', cystAddressSchema.parse(await authenticate(context)));
    context.header('Cache-Control', 'no-store'); await next();
  });
  routes.get('/config', context => context.json(service.publicConfig()));
  routes.get('/agents/:agentId/latest', async context => context.json(await service.latest(context.get('cystPrincipal'), cystRegistryHashSchema.parse(context.req.param('agentId')))));
  routes.get('/agents/:agentId/checkpoints/:checkpointId/blob', async context => context.json(await service.download(
    context.get('cystPrincipal'), cystRegistryHashSchema.parse(context.req.param('agentId')), cystIdSchema.parse(context.req.param('checkpointId')))));
  routes.post('/agents/:agentId/commit-plan', async context => {
    cystIdempotencySchema.parse(context.req.header('idempotency-key'));
    const input = z.object({ checkpointId: cystIdSchema }).strict().parse(await body(context));
    return context.json(await service.commitPlan(context.get('cystPrincipal'), cystRegistryHashSchema.parse(context.req.param('agentId')), input.checkpointId));
  });
  routes.post('/agents/:agentId/retire-plan', async context => {
    cystIdempotencySchema.parse(context.req.header('idempotency-key'));
    const input = z.object({ expectedRevision: cystRegistryUint64Schema }).strict().parse(await body(context));
    return context.json(await service.retirePlan(context.get('cystPrincipal'), cystRegistryHashSchema.parse(context.req.param('agentId')), input.expectedRevision));
  });
  routes.post('/agents/:agentId/verify', async context => {
    const input = z.object({ checkpointId: cystIdSchema }).strict().parse(await body(context));
    return context.json(await service.verify(context.get('cystPrincipal'), cystRegistryHashSchema.parse(context.req.param('agentId')), input.checkpointId));
  });
  return routes;
}
