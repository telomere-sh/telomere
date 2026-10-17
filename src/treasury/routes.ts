import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import type { TreasuryTopUpService } from './service.js';

async function input(context: Context): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(context.req.header('content-type') ?? '')) throw new Problem(422, 'json_required', 'Send application/json.');
  const length = context.req.header('content-length');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 8192)) throw new Problem(422, 'topup_body_limit', 'Top-up requests may contain at most 8 KiB.');
  const reader = context.req.raw.body?.getReader(); if (!reader) throw new Problem(422, 'invalid_input', 'Send a JSON object.');
  let timer: ReturnType<typeof setTimeout> | undefined, size = 0; const chunks: Uint8Array[] = [];
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Problem(422, 'topup_body_timeout', 'The top-up request body did not finish.')); void reader.cancel().catch(() => undefined);
  }, 5000); });
  try {
    for (;;) { const item = await Promise.race([reader.read(), timeout]); if (item.done) break; size += item.value.length;
      if (size > 8192) { void reader.cancel().catch(() => undefined); throw new Problem(422, 'topup_body_limit', 'Top-up requests may contain at most 8 KiB.'); } chunks.push(item.value); }
    try { return incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Problem(422, 'invalid_input', 'Send unambiguous UTF-8 JSON.'); }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
export function createTreasuryTopUpRoutes(service: TreasuryTopUpService, authenticateOwner: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { topUpOwner: string } }>();
  routes.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (context.req.url.includes('?')) throw new Problem(422, 'topup_query_unsupported', 'Top-up routes do not accept query parameters.');
    context.set('topUpOwner', await authenticateOwner(context)); await next();
  });
  routes.post('/invoices', async context => context.json(await service.create(context.get('topUpOwner'), await input(context)), 201));
  routes.get('/invoices/:id', async context => context.json(await service.get(context.get('topUpOwner'), context.req.param('id'))));
  routes.post('/invoices/:id/observe', async context => {
    const body = z.object({ signature: z.string() }).strict().parse(await input(context));
    return context.json(await service.observe(context.get('topUpOwner'), context.req.param('id'), body.signature));
  });
  routes.post('/invoices/:id/authorization', async context => {
    const body = z.object({ signature: z.string() }).strict().parse(await input(context));
    return context.json(await service.authorize(context.get('topUpOwner'), context.req.param('id'), body.signature));
  });
  routes.post('/invoices/:id/submit', async context => {
    const body = z.object({ rawTransaction: z.string() }).strict().parse(await input(context));
    return context.json(await service.submit(context.get('topUpOwner'), context.req.param('id'), body.rawTransaction), 202);
  });
  routes.post('/invoices/:id/reconcile', async context => {
    z.object({}).strict().parse(await input(context)); return context.json(await service.reconcile(context.get('topUpOwner'), context.req.param('id')));
  });
  routes.post('/invoices/:id/rebroadcast', async context => {
    z.object({}).strict().parse(await input(context)); return context.json(await service.rebroadcast(context.get('topUpOwner'), context.req.param('id')), 202);
  });
  return routes;
}
