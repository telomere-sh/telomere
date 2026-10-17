import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem, addressSchema, bytes32Schema, canonical } from '../common.js';
import { platformAdmissionSchema, validatedPlatformQuoteInputSchema, platformX402RequestSchema } from './types.js';
import { encodePaymentHeader } from '../payments/protocol.js';
import { decodeX402CpuPaymentHeader, x402CpuPaymentSchema } from '../payments/cpu-reservations.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import type { PlatformRuntimeService } from './service.js';

export type PlatformRuntimeRouteService = Pick<PlatformRuntimeService,
  'publicConfig' | 'balance' | 'quote' | 'admit' | 'list' | 'get' | 'stopPlan' | 'refundPlan' | 'command' | 'sessionEvents'>
  & Partial<Pick<PlatformRuntimeService, 'x402Challenge' | 'x402Intent'>>;
const idem = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const empty = z.object({}).strict();

/** Mount under /api/platform, retaining the existing trusted-origin, socket rate and secure-header middleware. */
export function createPlatformRuntimeRoutes(service: PlatformRuntimeRouteService, authenticate: (context: Context) => Promise<string>,
  options: { x402ResourceUrl?: string } = {}) {
  const routes = new Hono<{ Variables: { platformOwner: string } }>();
  routes.use('*', async (context, next) => {
    context.set('platformOwner', addressSchema.parse(await authenticate(context)).toLowerCase());
    context.header('Cache-Control', 'no-store');
    await next();
  });
  async function body(context: Context, strict = false): Promise<unknown> {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(context.req.header('content-type') ?? '')) {
      throw new Problem(422, 'json_required', 'Send application/json.');
    }
    const length = context.req.header('content-length');
    if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 32_768)) {
      throw new Problem(422, 'platform_body_limit', 'Platform requests may contain at most 32 KiB.');
    }
    const reader = context.req.raw.body?.getReader();
    if (!reader) throw new Problem(422, 'invalid_input', 'Send a JSON object.');
    const chunks: Uint8Array[] = []; let bytes = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      reject(new Problem(422, 'platform_body_timeout', 'The request body did not finish.'));
      void reader.cancel().catch(() => undefined);
    }, 5000); });
    try {
      while (true) {
        const value = await Promise.race([reader.read(), timeout]); if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > 32_768) { void reader.cancel().catch(() => undefined); throw new Problem(422, 'platform_body_limit', 'Platform requests may contain at most 32 KiB.'); }
        chunks.push(value.value);
      }
      const joined = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      if (strict) {
        try { return incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
        catch { throw new Problem(422, 'platform_x402_json', 'Send one unambiguous UTF-8 JSON CPU payment request.'); }
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
    } finally { clearTimeout(timer); reader.releaseLock(); }
  }
  routes.get('/config', context => context.json(service.publicConfig()));
  routes.get('/balance', async context => context.json(await service.balance(context.get('platformOwner'))));
  routes.post('/quotes', async context => {
    const key = idem.parse(context.req.header('idempotency-key'));
    return context.json(await service.quote(context.get('platformOwner'), validatedPlatformQuoteInputSchema.parse(await body(context)), key), 201);
  });
  if (options.x402ResourceUrl) {
    const resourceUrl = options.x402ResourceUrl;
    if (!service.x402Challenge || !service.x402Intent) throw new Error('X402 CPU resource requires its reviewed service methods');
    const challenge = service.x402Challenge.bind(service), intent = service.x402Intent.bind(service);
    routes.post('/cells', async context => {
      if (new URL(context.req.url).search) throw new Problem(422, 'platform_x402_query_unsupported', 'CPU payment requests do not accept query parameters.');
      const key = idem.parse(context.req.header('idempotency-key')), raw = await body(context, true), owner = context.get('platformOwner');
      const payload = z.object({ request: platformX402RequestSchema, payment: x402CpuPaymentSchema.optional() }).strict().parse(raw);
      const paymentHeader = context.req.header('PAYMENT-SIGNATURE'); let headerPayment;
      try { headerPayment = paymentHeader ? decodeX402CpuPaymentHeader(paymentHeader) : undefined; }
      catch { throw new Problem(422, 'platform_x402_payment_header', 'Send one valid bounded payment signature header for the explicit CPU reservation extension.'); }
      if (payload.payment && headerPayment && canonical(payload.payment) !== canonical(headerPayment)) throw new Problem(409, 'platform_x402_payment_sources', 'Payment header and body must retain the same original authorization.');
      const payment = headerPayment ?? payload.payment;
      const original = await challenge(owner, payload.request, key, resourceUrl);
      context.header('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED');
      if (!payment) {
        context.header('PAYMENT-REQUIRED', encodePaymentHeader(original.paymentRequired));
        return context.json({ error: 'payment_required', challenge: original }, 402);
      }
      return context.json(await intent(owner, original.quote.runId, payment), 200);
    });
  }
  routes.get('/runs', async context => context.json(await service.list(context.get('platformOwner'))));
  routes.post('/runs', async context => {
    const key = idem.parse(context.req.header('idempotency-key'));
    return context.json(await service.admit(context.get('platformOwner'), platformAdmissionSchema.parse(await body(context)), key));
  });
  routes.get('/runs/:id', async context => context.json(await service.get(context.get('platformOwner'), bytes32Schema.parse(context.req.param('id')))));
  routes.post('/runs/:id/commands', async context => {
    const key = idem.parse(context.req.header('idempotency-key'));
    const command = sessionCommandSchema.parse(await body(context));
    if (command.commandId !== key) throw new Problem(409, 'platform_command_idempotency', 'Idempotency-Key must equal commandId.');
    return context.json(await service.command(context.get('platformOwner'), bytes32Schema.parse(context.req.param('id')), command));
  });
  routes.get('/runs/:id/events', async context => {
    const after = context.req.query('after') ?? '-1', rawLimit = context.req.query('limit') ?? '8';
    if (!/^(?:-1|0|[1-9][0-9]{0,3})$/.test(after) || !/^[1-8]$/.test(rawLimit)) {
      throw new Problem(422, 'platform_event_cursor', 'Invalid session event cursor.');
    }
    return context.json(await service.sessionEvents(context.get('platformOwner'), bytes32Schema.parse(context.req.param('id')),
      Number(after), Number(rawLimit)));
  });
  for (const action of ['stop', 'refund'] as const) routes.post('/runs/:id/' + action, async context => {
    idem.parse(context.req.header('idempotency-key')); empty.parse(await body(context));
    return context.json(await service[action === 'stop' ? 'stopPlan' : 'refundPlan'](context.get('platformOwner'), bytes32Schema.parse(context.req.param('id'))));
  });
  return routes;
}
