import { Hono, type Context } from 'hono';
import { addressSchema, bytes32Schema, Problem } from '../common.js';
import { cystInputDescriptorSchema } from '../host-kit/sessions/cyst-input-protocol.js';
import type { PaidCystInputService } from './paid-cyst-input.js';

/** Mount under /api/platform with the existing Origin/socket-rate protections.
 * Only this exact PUT path bypasses the ordinary JSON body-size middleware.
 */
export function createPaidCystInputRoutes(service: Pick<PaidCystInputService, 'status' | 'upload'>, authenticate: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { principal: string } }>();
  routes.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.set('principal', addressSchema.parse(await authenticate(context))); await next();
  });
  const parameters = (context: Context) => ({ vault: addressSchema.parse(context.req.param('vault')),
    runId: bytes32Schema.parse(context.req.param('id')),
    operationId: cystInputDescriptorSchema.shape.operationId.parse(context.req.param('operationId')) });
  const path = '/vaults/:vault/runs/:id/inputs/:operationId';
  routes.get(path, async context => {
    const { vault, runId, operationId } = parameters(context);
    return context.json(await service.status(context.get('principal'), vault, runId, operationId));
  });
  routes.put(path, async context => {
    const { vault, runId, operationId } = parameters(context);
    if (context.req.header('idempotency-key') !== operationId || !context.req.raw.body) {
      throw new Problem(422, 'cyst_input_idempotency', 'The declared operation ID and exact binary body are required.');
    }
    return context.json(await service.upload(context.get('principal'), vault, runId, operationId, {
      body: context.req.raw.body, signal: context.req.raw.signal, contentLength: context.req.header('content-length'),
      contentType: context.req.header('content-type'), contentEncoding: context.req.header('content-encoding') }));
  });
  return routes;
}
