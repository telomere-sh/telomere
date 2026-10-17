import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { canonical, decodePaymentHeader, encodePaymentHeader, PaymentError, paymentPayloadSchema,
  requestBinding, requirementsSchema, type Scheme } from './protocol.js';
import type { X402PaymentService } from './service.js';
import type { Hex } from 'viem';

const requestSchema = z.object({ x402Version: z.literal(2), paymentPayload: paymentPayloadSchema,
  paymentRequirements: requirementsSchema }).strict();
function problem(context: Context, error: unknown) {
  const known = error instanceof PaymentError;
  const malformed = error instanceof z.ZodError || error instanceof SyntaxError;
  return context.json({ error: known ? error.code : malformed ? 'invalid_payment_request' : 'payment_service_unavailable' },
    (known ? error.status : malformed ? 400 : 503) as 400 | 401 | 409 | 412 | 422 | 503);
}
export function createFacilitatorRoutes(service: X402PaymentService,
  authorizeSettlement: (context: Context) => boolean | Promise<boolean>) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 32_768 }));
  app.get('/supported', context => context.json(service.supported()));
  app.post('/verify', async context => {
    try {
      const request = requestSchema.parse(await context.req.json());
      if (canonical(request.paymentRequirements) !== canonical(request.paymentPayload.accepted)) throw new PaymentError(409, 'payment_terms_mismatch');
      return context.json(await service.verify(request.paymentPayload));
    } catch (error) { return problem(context, error); }
  });
  app.post('/settle', async context => {
    try {
      if (!await authorizeSettlement(context)) throw new PaymentError(401, 'resource_server_auth_required');
      const request = requestSchema.parse(await context.req.json());
      if (canonical({ ...request.paymentRequirements, amount: request.paymentPayload.accepted.amount }) !== canonical(request.paymentPayload.accepted)) {
        throw new PaymentError(409, 'payment_terms_mismatch');
      }
      const settled = await service.settle(request.paymentPayload, { amount: request.paymentRequirements.amount,
        requestHash: request.paymentPayload.accepted.extra.telomere.requestHash });
      return context.json(settled, settled.errorReason === 'settlement_pending' ? 202 : settled.success ? 200 : 422);
    } catch (error) { return problem(context, error); }
  });
  return app;
}
/** Default authorization flow: verify, execute once, charge the server-computed amount, disclose after finality. */
export function createPaidResourceRoutes(service: X402PaymentService, options: {
  url: string; scheme: Scheme; maximum: string;
  execute: (input: { body: Uint8Array; idempotencyKey: Hex }) => Promise<{ amount: string; result: unknown }>;
}) {
  const app = new Hono();
  const configured = new URL(options.url);
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.hash || configured.search) throw new Error('Invalid fixed resource URL');
  app.use('*', bodyLimit({ maxSize: 262_144 }));
  app.all('/', async context => {
    try {
      const observed = new URL(context.req.url);
      if (observed.search) throw new PaymentError(400, 'resource_query_unsupported');
      const body = new Uint8Array(await context.req.arrayBuffer());
      const binding = requestBinding(context.req.method, configured.href, body);
      const header = context.req.header('PAYMENT-SIGNATURE');
      context.header('Cache-Control', 'no-store');
      context.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
      if (!header) {
        const required = await service.challenge({ resource: { url: configured.href }, scheme: options.scheme,
          amount: options.maximum, requestHash: binding });
        context.header('PAYMENT-REQUIRED', encodePaymentHeader(required));
        return context.json({ error: 'payment_required' }, 402);
      }
      const payload = decodePaymentHeader(header);
      if (payload.resource.url !== configured.href) throw new PaymentError(409, 'payment_request_mismatch');
      const executed = await service.runResource(payload, binding, idempotencyKey => options.execute({ body, idempotencyKey }));
      context.header('PAYMENT-RESPONSE', encodePaymentHeader(executed.payment));
      if (!executed.payment.success) return context.json({ error: executed.payment.errorReason },
        executed.payment.errorReason === 'settlement_pending' ? 202 : 422);
      return context.json(executed.result as Record<string, unknown>);
    } catch (error) { return problem(context, error); }
  });
  return app;
}
