import { Hono, type Context } from 'hono';
import { Problem } from '../../common.js';
import { incomeStrictJson } from './json.js';
import { incomeAddressSchema, incomeHashSchema, incomeIdempotencySchema } from './types.js';
import { incomeDeclareInputSchema, incomeExpectedRevisionSchema, type IncomeEndpointService } from './service.js';

async function body(context: Context): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(context.req.header('content-type') ?? '')) throw new Problem(422, 'json_required', 'Send application/json.');
  const length = context.req.header('content-length');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 8192)) throw new Problem(422, 'income_endpoint_body_limit', 'Endpoint requests may contain at most 8 KiB.');
  const reader = context.req.raw.body?.getReader(); if (!reader) throw new Problem(422, 'invalid_input', 'Send a JSON object.');
  const chunks: Uint8Array[] = []; let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Problem(422, 'income_endpoint_body_timeout', 'The endpoint request body did not finish.'));
    void reader.cancel().catch(() => undefined);
  }, 5000); });
  try {
    while (true) { const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
      size += item.value.byteLength; if (size > 8192) { void reader.cancel().catch(() => undefined); throw new Problem(422, 'income_endpoint_body_limit', 'Endpoint requests may contain at most 8 KiB.'); }
      chunks.push(item.value);
    }
    try { return incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Problem(422, 'invalid_input', 'Send unambiguous UTF-8 JSON.'); }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Mount under a dedicated /api/selection/income-endpoints prefix with global Origin and trusted-IP rate middleware. */
export function createIncomeEndpointRoutes(service: IncomeEndpointService, authenticate: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { incomePrincipal: string } }>();
  routes.use('*', async (context, next) => {
    if (context.req.url.includes('?')) throw new Problem(422, 'income_endpoint_query_unsupported', 'Endpoint routes do not accept query parameters.');
    context.set('incomePrincipal', incomeAddressSchema.parse(await authenticate(context)));
    context.header('Cache-Control', 'no-store'); await next();
  });
  const agent = (context: Context) => incomeHashSchema.parse(context.req.param('agentId'));
  const endpoint = (context: Context) => incomeHashSchema.parse(context.req.param('endpointId'));
  const key = (context: Context) => incomeIdempotencySchema.parse(context.req.header('idempotency-key'));
  routes.get('/config', context => context.json(service.publicConfig()));
  routes.get('/agents/:agentId/endpoints', async context => context.json(await service.list(context.get('incomePrincipal'), agent(context))));
  routes.get('/agents/:agentId/endpoints/:endpointId', async context => context.json(await service.get(context.get('incomePrincipal'), agent(context), endpoint(context))));
  routes.post('/agents/:agentId/endpoints', async context => {
    const operationKey = key(context), input = incomeDeclareInputSchema.parse(await body(context));
    return context.json(await service.declare(context.get('incomePrincipal'), agent(context), input, operationKey));
  });
  routes.post('/agents/:agentId/endpoints/:endpointId/challenge', async context => {
    const operationKey = key(context), input = incomeExpectedRevisionSchema.parse(await body(context));
    return context.json(await service.challenge(context.get('incomePrincipal'), agent(context), endpoint(context), input, operationKey));
  });
  routes.post('/agents/:agentId/endpoints/:endpointId/verify', async context => {
    const operationKey = key(context), input = incomeExpectedRevisionSchema.parse(await body(context));
    return context.json(await service.verify(context.get('incomePrincipal'), agent(context), endpoint(context), input, operationKey));
  });
  routes.post('/agents/:agentId/endpoints/:endpointId/revoke', async context => {
    const operationKey = key(context), input = incomeExpectedRevisionSchema.parse(await body(context));
    return context.json(await service.revoke(context.get('incomePrincipal'), agent(context), endpoint(context), input, operationKey));
  });
  return routes;
}
