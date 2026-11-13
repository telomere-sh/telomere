import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem, bytes32Schema } from '../common.js';
import { FinancialHistory, refundSnapshot } from './financial-history.js';
import type { configuredFinancialSource } from './financial-source.js';

export function createRefundInsightRoutes(history: FinancialHistory) {
  const routes = new Hono();
  routes.get('/refunds', async context => {
    const query = z.object({ period: z.enum(['24h', '7d', 'all']).default('all') }).strict().parse(context.req.query());
    if (new URL(context.req.url).searchParams.size > 1) throw new Problem(422, 'insight_query', 'Choose one period.');
    context.header('Cache-Control', 'no-store');
    return context.json(refundSnapshot(await history.snapshot(), history.source, query.period));
  });
  return routes;
}
export function createRefundReferenceRoutes(source: ReturnType<typeof configuredFinancialSource>, owner: (context: Context) => Promise<string>) {
  const routes = new Hono();
  routes.post('/refund-evidence', async context => {
    const address = await owner(context);
    const { runId, transactionHash } = z.object({ runId: bytes32Schema, transactionHash: bytes32Schema }).strict().parse(await context.req.json());
    try { await source.register(address, runId, transactionHash); }
    catch { throw new Problem(422, 'refund_evidence', 'Use your confirmed timeout-refund transaction from this escrow.'); }
    return context.json({ accepted: true, financialTransactionSent: false });
  });
  return routes;
}
