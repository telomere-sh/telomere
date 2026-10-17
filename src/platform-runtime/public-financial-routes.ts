import { Hono } from 'hono';
import { z } from 'zod';
import { bytes32Schema } from '../common.js';
import type { PlatformPublicFinancialReader } from './public-financial.js';

const block = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);

/** Public, read-only chain evidence; no session, database lookup or signer operation. */
export function createPlatformPublicFinancialRoutes(reader: PlatformPublicFinancialReader) {
  const routes = new Hono();
  routes.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  routes.get('/receipts/:runId', async context => {
    const { transactionHash } = z.object({ transactionHash: bytes32Schema }).strict().parse(context.req.query());
    return context.json(await reader.verify(bytes32Schema.parse(context.req.param('runId')), transactionHash));
  });
  routes.get('/refund-rate', async context => {
    const { fromBlock, toBlock } = z.object({ fromBlock: block.optional(), toBlock: block.optional() }).strict().parse(context.req.query());
    return context.json(await reader.refundRate(fromBlock, toBlock));
  });
  routes.get('/cpu-price-board', async context => {
    z.object({}).strict().parse(context.req.query());
    return context.json(await reader.cpuPriceBoard());
  });
  return routes;
}
