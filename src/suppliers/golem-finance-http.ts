import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { Problem } from '../common.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { golemAmountToBaseUnits, golemDebitNoteSchema, golemFinanceIdSchema, golemInvoiceSchema,
  golemOriginalRunSchema, golemPaymentSchema, type GolemFinanceAction, type GolemFinanceBinding,
  type GolemFinanceDocumentKind, type GolemFinanceProtocol } from './golem-finance-types.js';

const maximumBytes = 1_048_576;
const configSchema = z.object({ endpoint: z.string().min(1).max(2048),
  apiKey: z.string().min(1).max(512).regex(/^[A-Za-z0-9._~+/-]+={0,2}$/),
  allowLocalHttp: z.boolean().optional(), timeoutMs: z.number().int().min(10).max(5000).optional(),
}).strict();
export type GolemFinanceHttpOptions = z.infer<typeof configSchema>;
const bindingSchema = golemOriginalRunSchema.omit({ active: true, asOfMs: true });
const kindSchema = z.enum(['debit', 'invoice']);
const actionSchema = z.enum(['accept_debit', 'accept_invoice', 'destroy_activity', 'terminate_agreement', 'release_allocation']);
const invalidInput = () => new Problem(422, 'golem_http_request_invalid', 'The reviewed Yagna transport request is invalid.');
const failed = (write: boolean) => new Problem(503, write ? 'golem_http_write_unknown' : 'golem_http_read_failed', write
  ? 'The Yagna mutation outcome is unknown. Reconcile the retained original intent before any further write.'
  : 'The Yagna response is unavailable, unsupported or invalid.');

/** BigDecimal Display may emit 1E-18. Expand strings exactly; never round a JSON number. */
function amount(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) throw new Error('Unsupported Yagna amount');
  const match = /^(0|[1-9][0-9]{0,35})(?:\.([0-9]{1,36}))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(value);
  if (!match) throw new Error('Unsupported Yagna amount');
  const whole = match[1]!, fraction = match[2] ?? '';
  // The exponent is only a bounded string position, never a floating monetary value.
  const exponent = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  if (exponent < -72 || exponent > 72) throw new Error('Unsupported Yagna amount');
  const digits = whole + fraction, position = whole.length + exponent;
  const expanded = position <= 0 ? '0.' + '0'.repeat(-position) + digits
    : position >= digits.length ? digits + '0'.repeat(position - digits.length)
    : digits.slice(0, position) + '.' + digits.slice(position);
  const [rawWhole, rawFraction = ''] = expanded.split('.');
  const canonicalWhole = rawWhole!.replace(/^0+(?=[0-9])/, ''), canonicalFraction = rawFraction.replace(/0+$/, '');
  const canonical = canonicalWhole + (canonicalFraction ? '.' + canonicalFraction : '');
  golemAmountToBaseUnits(canonical); // Preserve the existing 18-decimal/36-base-unit-digit boundary.
  return canonical;
}
const wireAmount = z.preprocess(amount, golemInvoiceSchema.shape.amount);
const wireDebitSchema = golemDebitNoteSchema.extend({ totalAmountDue: wireAmount,
  previousDebitNoteId: golemDebitNoteSchema.shape.previousDebitNoteId.optional(),
  paymentDueDate: golemDebitNoteSchema.shape.paymentDueDate.optional(),
}).strip();
const wireInvoiceSchema = golemInvoiceSchema.extend({ amount: wireAmount }).strip();
const wireShare = z.object({ amount: wireAmount, allocationId: golemFinanceIdSchema.nullable().optional() });
const wirePaymentSchema = golemPaymentSchema.extend({ amount: wireAmount,
  agreementPayments: z.array(wireShare.extend({ agreementId: golemFinanceIdSchema })).max(32),
  activityPayments: z.array(wireShare.extend({ activityId: golemFinanceIdSchema })).max(32),
}).strip();
export type GolemFinanceWirePayment = z.infer<typeof wirePaymentSchema>;

/** Observation only: missing allocation IDs stay missing; signedBytes/signature extras establish no authority. */
export function parseGolemFinanceWirePayment(value: unknown): GolemFinanceWirePayment {
  return wirePaymentSchema.parse(value);
}

/** Explicit opt-in Yagna transport. Call only behind the existing durable financial controller.
 * API41e7d990 payment1.6.3: accept may initiate real payments. An HTTP acknowledgement,
 * accepted document or payment.details string proves neither allocation attribution nor finality.
 * This adapter is unmounted and never creates allocations/agreements/activities or retries a write. */
export class GolemFinanceHttpProtocol implements GolemFinanceProtocol {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  constructor(value: GolemFinanceHttpOptions) {
    try {
      const options = configSchema.parse(value), endpoint = new URL(options.endpoint);
      const local = options.allowLocalHttp === true && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
        || options.endpoint !== endpoint.origin && options.endpoint !== endpoint.origin + '/'
        || endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) throw invalidInput();
      this.#endpoint = endpoint.origin;
      this.#apiKey = options.apiKey;
      this.#timeoutMs = options.timeoutMs ?? 5000;
    } catch { throw new Problem(422, 'golem_http_config_invalid', 'Install an exact reviewed Yagna origin and a valid private application key.'); }
  }

  private request(method: 'GET' | 'POST' | 'DELETE', path: string, body: string | undefined,
    signal: AbortSignal, expectedStatuses: readonly (200 | 204)[]): Promise<unknown> {
    const write = method !== 'GET';
    if (!(signal instanceof AbortSignal)) return Promise.reject(failed(write));
    return new Promise<unknown>((resolve, reject) => {
      let request: ClientRequest | undefined, response: IncomingMessage | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined, complete = false;
      const finish = (error: boolean, value?: unknown) => {
        if (complete) return;
        complete = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        response?.destroy(); request?.destroy();
        if (error) reject(failed(write)); else resolve(value);
      };
      const onAbort = () => finish(true);
      try {
        if (!(signal instanceof AbortSignal) || signal.aborted) { finish(true); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(onAbort, this.#timeoutMs);
        if (signal.aborted || complete) { finish(true); return; }
        const url = new URL(this.#endpoint + path);
        const createRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
        request = createRequest(url, { method, agent: false, maxHeaderSize: 16_384,
          headers: { authorization: 'Bearer ' + this.#apiKey, accept: 'application/json', 'accept-encoding': 'identity',
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
        }, incoming => {
          response = incoming;
          if (complete) { incoming.destroy(); return; }
          const length = incoming.headers['content-length'];
          const type = incoming.headers['content-type'] ?? '';
          const encoding = incoming.headers['content-encoding'];
          const rawNames = incoming.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
          if (!expectedStatuses.some(status => incoming.statusCode === status) || encoding !== undefined && encoding !== 'identity'
            || length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximumBytes)
            || rawNames.filter(name => name === 'content-type').length > 1) { finish(true); return; }
          let bytes = 0;
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => {
            if (complete) return;
            bytes += chunk.byteLength;
            if (bytes > maximumBytes) { finish(true); return; }
            chunks.push(chunk);
          });
          incoming.on('error', onAbort); incoming.on('aborted', onAbort);
          incoming.on('end', () => {
            if (complete) return;
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
              if (method !== 'GET' && !text.trim()) { finish(false); return; }
              if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) { finish(true); return; }
              const value = incomeStrictJson(text);
              finish(false, value); // Acknowledgement contents are ignored by mutate(), never a finality proof.
            } catch { finish(true); }
          });
        });
        request.on('error', onAbort);
        request.end(body);
      } catch { finish(true); }
    });
  }

  async document(kindValue: GolemFinanceDocumentKind, idValue: string, signal: AbortSignal): Promise<unknown> {
    let kind: GolemFinanceDocumentKind, id: string;
    try { kind = kindSchema.parse(kindValue); id = golemFinanceIdSchema.parse(idValue); } catch { throw invalidInput(); }
    try {
      const value = await this.request('GET', '/payment-api/v1/' + (kind === 'debit' ? 'debitNotes' : 'invoices') + '/' + id, undefined, signal, [200]);
      if (kind === 'invoice') {
        const invoice = wireInvoiceSchema.parse(value);
        if (invoice.invoiceId !== id) throw failed(false);
        return golemInvoiceSchema.parse(invoice);
      }
      const debit = wireDebitSchema.parse(value);
      if (debit.debitNoteId !== id) throw failed(false);
      // Official optional fields are omitted for None; usageCounterVector and metadata are intentionally not financial authority.
      return golemDebitNoteSchema.parse({ ...debit, previousDebitNoteId: debit.previousDebitNoteId ?? null,
        paymentDueDate: debit.paymentDueDate ?? null });
    } catch { throw failed(false); }
  }

  async payment(idValue: string, signal: AbortSignal): Promise<unknown> {
    let id: string;
    try { id = golemFinanceIdSchema.parse(idValue); } catch { throw invalidInput(); }
    try {
      const payment = parseGolemFinanceWirePayment(await this.request('GET', '/payment-api/v1/payments/' + id, undefined, signal, [200]));
      if (payment.paymentId !== id) throw failed(false);
      // Pinned Yagna GET commonly omits ALL allocation IDs. Never invent attribution to satisfy the lifecycle DTO.
      if ([...payment.agreementPayments, ...payment.activityPayments].some(share => !share.allocationId)) {
        throw new Problem(503, 'golem_http_payment_unattributed', 'The Yagna payment does not independently identify its original allocation.');
      }
      return golemPaymentSchema.parse(payment);
    } catch (error) {
      if (error instanceof Problem && error.code === 'golem_http_payment_unattributed') throw error;
      throw failed(false);
    }
  }

  /** Raw authenticated observation for an independently installed allocation
   * attribution reader. Missing IDs remain missing; this creates no authority. */
  async wirePayment(idValue: string, signal: AbortSignal): Promise<GolemFinanceWirePayment> {
    let id: string;
    try { id = golemFinanceIdSchema.parse(idValue); } catch { throw invalidInput(); }
    try {
      const value = parseGolemFinanceWirePayment(await this.request('GET', '/payment-api/v1/payments/' + id, undefined, signal, [200]));
      if (value.paymentId !== id) throw failed(false); return value;
    } catch { throw failed(false); }
  }

  async mutate(actionValue: GolemFinanceAction, bindingValue: GolemFinanceBinding, resourceValue: string,
    totalAmountAccepted: string | undefined, signal: AbortSignal): Promise<void> {
    let action: GolemFinanceAction, binding: GolemFinanceBinding, resource: string, body: string | undefined;
    try {
      action = actionSchema.parse(actionValue); binding = bindingSchema.parse(bindingValue); resource = golemFinanceIdSchema.parse(resourceValue);
      if (action === 'accept_debit' || action === 'accept_invoice') {
        const accepted = amount(totalAmountAccepted);
        if (golemAmountToBaseUnits(accepted) > BigInt(binding.maxGlmBaseUnits)) throw invalidInput();
        body = JSON.stringify({ totalAmountAccepted: accepted, allocationId: binding.allocationId });
      } else if (totalAmountAccepted !== undefined || resource !== (action === 'destroy_activity' ? binding.activityId
        : action === 'terminate_agreement' ? binding.agreementId : binding.allocationId)) throw invalidInput();
    } catch { throw invalidInput(); }
    const path = action === 'accept_debit' ? '/payment-api/v1/debitNotes/' + resource + '/accept'
      : action === 'accept_invoice' ? '/payment-api/v1/invoices/' + resource + '/accept'
      : action === 'destroy_activity' ? '/activity-api/v1/activity/' + resource
      : action === 'terminate_agreement' ? '/market-api/v1/agreements/' + resource + '/terminate'
      : '/payment-api/v1/allocations/' + resource;
    // Pinned Yagna c256fce returns 200 empty; its retained ya-client specification declares 204.
    // Both are acknowledgements only, never independent evidence that execution stopped.
    await this.request(action === 'destroy_activity' || action === 'release_allocation' ? 'DELETE' : 'POST',
      path, body, signal, action === 'terminate_agreement' ? [200, 204] : [200]);
  }
}
