import { Hono } from 'hono';
import type { Address } from 'viem';
import { bytes32Schema } from '../common.js';
import type { Context } from 'hono';
import { DeadlineService, deadlineIdempotencySchema } from './service.js';

export function createSchedulingRoutes(service: DeadlineService, owner: (context: Context) => Promise<Address>) {
  const app = new Hono();
  app.get('/prices', async context => { await owner(context); return context.json(await service.prices()); });
  app.get('/deadline', async context => context.json(await service.list(await owner(context))));
  app.get('/deadline/:id', async context => context.json(await service.get(await owner(context), bytes32Schema.parse(context.req.param('id')))));
  app.post('/deadline', async context => context.json(await service.prepare(await owner(context), await context.req.json(),
    deadlineIdempotencySchema.parse(context.req.header('Idempotency-Key')))));
  return app;
}
