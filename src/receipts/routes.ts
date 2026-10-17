import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import type { HourReceiptService } from './service.js';
import { verifyHourlyReceipt, type ReceiptRootReader } from './verifier.js';

/** Mount below the controller's authenticated, Origin-checked, bounded JSON middleware. */
export function createReceiptRoutes(service: HourReceiptService, owner: (context: Context) => Promise<string>, reader?: ReceiptRootReader): Hono {
  const router = new Hono();
  router.get('/', async context => {
    const authenticatedOwner = await owner(context);
    const query = z.object({ cursor: bytes32Schema.optional() }).strict().parse(context.req.query());
    return context.json(await service.list(authenticatedOwner, query.cursor));
  });
  router.get('/:runId/proof', async context => context.json(await service.proof(await owner(context), bytes32Schema.parse(context.req.param('runId')))));
  router.post('/verify', async context => {
    await owner(context);
    const body = z.object({ proof: z.unknown() }).strict().parse(await context.req.json());
    return context.json(await verifyHourlyReceipt(body.proof, service.pins, reader));
  });
  return router;
}
