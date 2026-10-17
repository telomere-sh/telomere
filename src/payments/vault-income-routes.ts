import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { decodePaymentHeader, paymentPayloadSchema, PaymentError } from './protocol.js';
import { createFacilitatorRoutes, createPaidResourceRoutes } from './routes.js';
import { VAULT_INCOME_ADMIN_PATH, VAULT_INCOME_RESOURCE_PATH, type ConfiguredVaultIncome } from './vault-income-configured.js';

async function boundedBody(context: Context): Promise<{ bytes: Uint8Array; value: unknown }> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(context.req.header('content-type') ?? '')) throw new Problem(422, 'json_required', 'Send application/json.');
  const length = context.req.header('content-length');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 8192)) throw new Problem(422, 'vault_income_body_limit', 'Payment requests may contain at most 8 KiB.');
  const reader = context.req.raw.body?.getReader(); if (!reader) throw new Problem(422, 'invalid_input', 'Send a JSON object.');
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined; const chunks: Uint8Array[] = [];
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Problem(422, 'vault_income_body_timeout', 'The payment request body did not finish.'));
    void reader.cancel().catch(() => undefined);
  }, 5000); });
  try {
    while (true) { const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
      size += item.value.byteLength; if (size > 8192) { void reader.cancel().catch(() => undefined); throw new Problem(422, 'vault_income_body_limit', 'Payment requests may contain at most 8 KiB.'); }
      chunks.push(item.value);
    }
    const bytes = Buffer.concat(chunks);
    try { return { bytes, value: incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
    catch { throw new Problem(422, 'invalid_input', 'Send unambiguous UTF-8 JSON.'); }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
function headers(context: Context) {
  let total = 0, count = 0;
  for (const [name, value] of context.req.raw.headers) { total += Buffer.byteLength(name) + Buffer.byteLength(value); count++; }
  if (total > 8192 || count > 40) throw new Problem(422, 'vault_income_header_limit', 'Payment request headers exceed their limit.');
  if (context.req.url.includes('?')) throw new Problem(422, 'vault_income_query_unsupported', 'Payment routes do not accept a query.');
}
function fixedTerms(runtime: ConfiguredVaultIncome, payment: ReturnType<typeof paymentPayloadSchema.parse>) {
  if (payment.resource.url !== runtime.profile.resourceUrl || payment.accepted.scheme !== 'exact'
    || payment.accepted.amount !== runtime.profile.grossAmount || !('authorization' in payment.payload)
    || payment.payload.authorization.value !== runtime.profile.grossAmount) throw new PaymentError(409, 'payment_terms_mismatch');
}
function forwarded(context: Context, path: string, body?: Uint8Array, publicPayer = false) {
  const outgoing = new Headers(context.req.raw.headers); outgoing.delete('content-length'); outgoing.delete('transfer-encoding');
  if (publicPayer) { outgoing.delete('cookie'); outgoing.delete('authorization'); }
  return new Request(new URL(path, context.req.url), { method: context.req.method, headers: outgoing,
    ...(body ? { body: Buffer.from(body) } : {}) });
}

/** Public signatures authorize only this exact inbound payment; cookies never authorize payer transfers. */
export function createVaultIncomePublicRoutes(runtime: ConfiguredVaultIncome) {
  const routes = new Hono();
  routes.use(VAULT_INCOME_RESOURCE_PATH, async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  const paid = createPaidResourceRoutes(runtime.payments, { url: runtime.profile.resourceUrl, scheme: 'exact', maximum: runtime.profile.grossAmount,
    execute: async () => ({ amount: runtime.profile.grossAmount, result: { kind: 'vault-payment-receipt', agentId: runtime.profile.pins.agentId,
      vault: runtime.profile.pins.payTo, asset: runtime.profile.pins.asset, grossAmount: runtime.profile.grossAmount } }) });
  routes.post(VAULT_INCOME_RESOURCE_PATH, async context => {
    try {
      headers(context); const body = await boundedBody(context); z.object({}).strict().parse(body.value);
      const signature = context.req.header('PAYMENT-SIGNATURE'); if (signature) fixedTerms(runtime, decodePaymentHeader(signature));
      await runtime.check();
      return await paid.fetch(forwarded(context, '/', body.bytes, true));
    } catch (error) {
      if (error instanceof PaymentError) return context.json({ error: error.code }, error.status as 401 | 403 | 409 | 422 | 503);
      throw error;
    }
  });
  return routes;
}

/** Authenticated owner/agent administration; no public cookie-only settlement endpoint. */
export function createVaultIncomeAdminRoutes(runtime: ConfiguredVaultIncome, authenticate: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { vaultIncomePrincipal: string } }>();
  const facilitator = createFacilitatorRoutes(runtime.payments, async context => { await runtime.authorize(await authenticate(context)); return true; });
  routes.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store'); headers(context); context.set('vaultIncomePrincipal', await authenticate(context)); await next();
  });
  routes.get('/supported', async context => { await runtime.authorize(context.get('vaultIncomePrincipal')); return facilitator.fetch(forwarded(context, '/supported')); });
  for (const action of ['verify', 'settle'] as const) routes.post('/' + action, async context => {
    try {
      const body = await boundedBody(context);
      const request = z.object({ paymentPayload: paymentPayloadSchema, paymentRequirements: z.object({ amount: z.string() }).passthrough() }).passthrough().parse(body.value);
      fixedTerms(runtime, request.paymentPayload);
      if (request.paymentRequirements.amount !== runtime.profile.grossAmount) throw new PaymentError(409, 'payment_terms_mismatch');
      await runtime.authorize(context.get('vaultIncomePrincipal'));
      return await facilitator.fetch(forwarded(context, '/' + action, body.bytes));
    } catch (error) {
      if (error instanceof PaymentError) return context.json({ error: error.code }, error.status as 401 | 403 | 409 | 422 | 503);
      throw error;
    }
  });
  return routes;
}
export { VAULT_INCOME_ADMIN_PATH };
