import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { CystService } from './service.js';
import { CYST_CAPABILITIES, cystAddressSchema, cystIdSchema, cystIdempotencySchema } from './types.js';
import { CYST_QUOTA_HEADER, cystQuotaVersion } from './quota.js';

export function createCystRoutes(service: CystService, owner: (context: Context) => Promise<string>): Hono {
  const router = new Hono();
  router.use('*', bodyLimit({ maxSize: CYST_CAPABILITIES.maxUploadBodyBytes,
    onError: context => context.json({ type: 'about:blank', title: 'payload_too_large', status: 413,
      detail: 'Checkpoint request exceeds the published byte limit.' }, 413, { 'Content-Type': 'application/problem+json' }) }));
  router.get('/capabilities', async context => { await owner(context); return context.json(service.capabilities(cystQuotaVersion(context.req.header(CYST_QUOTA_HEADER)))); });
  router.get('/', async context => {
    const query = z.object({ agent: cystAddressSchema.optional(), cursor: cystIdSchema.optional() }).strict().parse(context.req.query());
    return context.json(await service.list(await owner(context), {
      quotaVersion: cystQuotaVersion(context.req.header(CYST_QUOTA_HEADER)),
      ...(query.agent === undefined ? {} : { agent: query.agent }), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) }));
  });
  router.post('/', async context => {
    const authenticatedOwner = await owner(context);
    const key = cystIdempotencySchema.parse(context.req.header('Idempotency-Key'));
    const result = await service.upload(authenticatedOwner, await context.req.json(), key, cystQuotaVersion(context.req.header(CYST_QUOTA_HEADER)));
    return context.json(result, result.replayed ? 200 : 201);
  });
  router.get('/:id/blob', async context => context.json(await service.download(await owner(context), cystIdSchema.parse(context.req.param('id')))));
  router.get('/:id', async context => context.json(await service.metadata(await owner(context), cystIdSchema.parse(context.req.param('id')))));
  return router;
}
