import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AgentLifecycleService } from './service.js';
import { agentAddressSchema, intentIdSchema, lifecycleIdempotencySchema } from './types.js';

/** Mount below authenticated /api/agents with the application's Origin, JSON and request-size middleware. */
export function createAgentRoutes(service: AgentLifecycleService, owner: (context: Context) => Promise<string>): Hono {
  const router = new Hono();
  router.get('/', async context => context.json(await service.list(await owner(context))));
  router.post('/', async context => {
    const result = await service.register(await owner(context), await context.req.json());
    return context.json(result, result.replayed ? 200 : 201);
  });
  router.get('/:agent', async context => context.json(await service.get(await owner(context), agentAddressSchema.parse(context.req.param('agent')))));
  router.get('/:agent/evaluation', async context => {
    const version = z.literal('2').optional().parse(context.req.query('metabolismVersion'));
    return context.json(await service.evaluate(await owner(context), agentAddressSchema.parse(context.req.param('agent')), version === '2' ? 2 : undefined));
  });
  router.post('/:agent/transitions', async context => {
    const authenticatedOwner = await owner(context);
    return context.json(await service.plan(authenticatedOwner, agentAddressSchema.parse(context.req.param('agent')),
      await context.req.json(), lifecycleIdempotencySchema.parse(context.req.header('Idempotency-Key'))));
  });
  router.post('/intents/:id/ack', async context => {
    const authenticatedOwner = await owner(context);
    const body = z.object({ expectedVersion: z.number().int().nonnegative(), acknowledgment: z.unknown() }).strict().parse(await context.req.json());
    return context.json(await service.acknowledge(authenticatedOwner, intentIdSchema.parse(context.req.param('id')),
      body.expectedVersion, body.acknowledgment));
  });
  router.post('/intents/:id/execution', async context => {
    const authenticatedOwner = await owner(context);
    const body = z.object({ expectedVersion: z.number().int().nonnegative(), phase: z.string() }).strict().parse(await context.req.json());
    return context.json(await service.validateExecution(authenticatedOwner, intentIdSchema.parse(context.req.param('id')), body.expectedVersion, body.phase));
  });
  return router;
}
