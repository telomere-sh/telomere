import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { addressSchema, bytes32Schema, Problem } from '../common.js';
import { PaidCpuJobService } from './paid-jobs.js';

/** All job approvals and lane consent require the authenticated human owner. */
export function createPaidCpuJobRoutes(service: PaidCpuJobService, authenticate: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { paidCpuOwner: string } }>();
  const prefix = '/vaults/:vault/cpu-jobs';
  routes.use('/vaults/:vault/cpu-jobs/*', async (context, next) => {
    context.set('paidCpuOwner', await authenticate(context)); context.header('Cache-Control', 'no-store'); await next();
  });
  routes.use(prefix, async (context, next) => {
    context.set('paidCpuOwner', await authenticate(context)); context.header('Cache-Control', 'no-store'); await next();
  });
  routes.use('/vaults/:vault/cpu-jobs/*', bodyLimit({ maxSize: 32768 }));
  routes.use(prefix, bodyLimit({ maxSize: 32768 }));
  const scope = (context: Context) => ({ owner: context.get('paidCpuOwner') as string,
    vault: addressSchema.parse(context.req.param('vault')), id: bytes32Schema.parse(context.req.param('id')) });
  const key = (context: Context) => {
    const value = context.req.header('Idempotency-Key');
    if (!value) throw new Problem(422, 'idempotency_required', 'Use the original operation key.'); return value;
  };
  routes.post(prefix, async context => context.json(await service.create(context.get('paidCpuOwner'),
    addressSchema.parse(context.req.param('vault')), await context.req.json(), key(context))));
  routes.get(prefix + '/:id', async context => { const s = scope(context); return context.json(await service.get(s.owner, s.vault, s.id)); });
  routes.post(prefix + '/:id/replan', async context => { const s = scope(context);
    return context.json(await service.replan(s.owner, s.vault, s.id, await context.req.json(), key(context))); });
  routes.post(prefix + '/:id/approve', async context => { const s = scope(context);
    return context.json(await service.approve(s.owner, s.vault, s.id, await context.req.json())); });
  routes.post(prefix + '/:id/cancel', async context => { const s = scope(context);
    return context.json(await service.cancel(s.owner, s.vault, s.id)); });
  routes.post(prefix + '/:id/finish', async context => { const s = scope(context), body = await context.req.text();
    return context.json(await service.finish(s.owner, s.vault, s.id, body.length === 0 ? {} : JSON.parse(body))); });
  routes.get(prefix + '/reliability/:hostId/:lane', async context => {
    const lane = context.req.param('lane');
    if (lane !== 'standard' && lane !== 'interruptible') throw new Problem(422, 'invalid_lane', 'Use a reviewed CPU lane.');
    return context.json(await service.reliability(context.get('paidCpuOwner'), addressSchema.parse(context.req.param('vault')),
      bytes32Schema.parse(context.req.param('hostId')), lane));
  });
  return routes;
}
