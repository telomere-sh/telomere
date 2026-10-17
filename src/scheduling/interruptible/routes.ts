import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { bytes32Schema } from '../../common.js';
import { interruptibleKeySchema } from './types.js';
import type { InterruptibleService } from './service.js';
import type { HostPreemptionService } from './host.js';

/** Mount behind owner/session and Origin checks. Authentication callback is mandatory for every route. */
export function createInterruptibleRoutes(service: InterruptibleService, owner: (context: Context) => Promise<string>) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 16_384 }));
  app.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  app.get('/', async context => context.json(await service.list(await owner(context))));
  app.post('/', async context => {
    const authenticated = await owner(context), result = await service.admit(authenticated, await context.req.json(),
      interruptibleKeySchema.parse(context.req.header('Idempotency-Key')));
    return context.json(result, result.replayed ? 200 : 201);
  });
  app.get('/:id', async context => context.json(await service.get(await owner(context), bytes32Schema.parse(context.req.param('id')))));
  app.post('/:id/targets', async context => {
    const authenticated = await owner(context), value = z.object({ runId: bytes32Schema }).strict().parse(await context.req.json());
    return context.json(await service.approveTarget(authenticated, bytes32Schema.parse(context.req.param('id')), value.runId));
  });
  app.post('/:id/notices', async context => context.json(await service.acceptNotice(await owner(context),
    bytes32Schema.parse(context.req.param('id')), await context.req.json())));
  app.post('/:id/advance', async context => context.json(await service.advance(await owner(context), bytes32Schema.parse(context.req.param('id')))));
  app.post('/:id/execution', async context => {
    const authenticated = await owner(context), value = z.object({ intentId: z.string().uuid(), phase: z.enum(['checkpoint', 'stop', 'attach', 'resume']) }).strict().parse(await context.req.json());
    return context.json(await service.validateClientStep(authenticated, bytes32Schema.parse(context.req.param('id')), value.intentId, value.phase));
  });
  return app;
}
/** Host-local operator authentication is supplied separately; never mount this unauthenticated on the public app. */
export function createHostPreemptionRoutes(service: HostPreemptionService, operator: (context: Context) => Promise<string>) {
  const app = new Hono(); app.use('*', bodyLimit({ maxSize: 1024 }));
  app.post('/:runId/notices', async context => {
    const authenticatedOwner = await operator(context), value = z.object({ noticeMilliseconds: z.number().int().min(30000).max(120000),
      reason: z.enum(['maintenance', 'capacity']) }).strict().parse(await context.req.json());
    const result = await service.issue(authenticatedOwner, bytes32Schema.parse(context.req.param('runId')), value,
      interruptibleKeySchema.parse(context.req.header('Idempotency-Key')));
    context.header('Cache-Control', 'no-store'); return context.json(result, result.replayed ? 200 : 201);
  }); return app;
}
