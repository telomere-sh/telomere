import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { SelectionIndexer } from './indexer.js';
const cursorSchema = z.object({ cursor: z.string().regex(/^0x[0-9a-f]{64}$/).optional() }).strict();
/** Public fossils are deliberate on-chain views; owner registry/financial metrics remain authenticated. No write/signing route. */
export function createSelectionRoutes(indexer: SelectionIndexer, owner: (context: Context) => Promise<string>): Hono {
  const routes = new Hono();
  routes.get('/agents', async context => context.json(await indexer.list(await owner(context), cursorSchema.parse(context.req.query()).cursor)));
  routes.get('/agents/:id', async context => context.json(await indexer.get(await owner(context), context.req.param('id'))));
  routes.get('/fossils', async context => context.json(await indexer.fossils(cursorSchema.parse(context.req.query()).cursor)));
  routes.get('/fossils/:id', async context => context.json(await indexer.fossil(context.req.param('id'))));
  routes.get('/population', async context => context.json(await indexer.population()));
  return routes;
}
