import { Hono } from 'hono';
import type { Address } from 'viem';
import type { Context } from 'hono';
import { bytes32Schema } from '../common.js';
import type { AkashControllerReadiness } from './controller-readiness.js';

export function createAkashReadinessRoutes(readiness: AkashControllerReadiness, owner: (context: Context) => Promise<Address>) {
  const app = new Hono();
  app.get('/runs/:id/readiness', async context => context.json(await readiness.run(
    await owner(context), bytes32Schema.parse(context.req.param('id')))));
  return app;
}
