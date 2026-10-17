import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { hashJson, Problem } from '../src/common.js';
import { GolemFinanceHttpProtocol, parseGolemFinanceWirePayment } from '../src/suppliers/golem-finance-http.js';
import { golemOriginalBinding, golemOriginalRunSchema } from '../src/suppliers/golem-finance-types.js';

const apiKey = 'local-yagna-private-fixture-key';
const payer = '0x1111111111111111111111111111111111111111';
const provider = '0x2222222222222222222222222222222222222222';
const requestor = '0x3333333333333333333333333333333333333333';
const payee = '0x4444444444444444444444444444444444444444';
const timestamp = '2026-10-15T00:00:00.000000001Z';
const original = golemOriginalRunSchema.parse({ authorityId: hashJson('original-authority'), owner: payer,
  runId: hashJson('original-run'), authorizationHash: hashJson('original-authorization'), active: true, asOfMs: 1_800_000_000_000,
  requestorId: requestor, providerId: provider, payerAddr: payer, payeeAddr: payee, paymentPlatform: 'erc20-polygon-glm',
  allocationId: 'original-allocation', agreementId: 'original-agreement', activityId: 'original-activity',
  imageDigest: hashJson('image'), spendUntilMs: 1_800_000_060_000, maxGlmBaseUnits: '10000000000000000000', maxUsdcMicros: '1000000' });
const binding = golemOriginalBinding(original);
const parties = { issuerId: provider, recipientId: requestor, payerAddr: payer, payeeAddr: payee,
  paymentPlatform: 'erc20-polygon-glm', agreementId: binding.agreementId, timestamp, status: 'RECEIVED' };
const debit = { ...parties, debitNoteId: 'debit-1', activityId: binding.activityId,
  totalAmountDue: '1E-7', usageCounterVector: [1, 2, 3], officialAnnotation: { untrusted: true } };
const invoice = { ...parties, invoiceId: 'invoice-1', activityIds: [binding.activityId], amount: '2.500000000000000000', paymentDueDate: timestamp };
const payment = { paymentId: 'payment-1', payerId: requestor, payeeId: provider, payerAddr: payer, payeeAddr: payee,
  paymentPlatform: 'erc20-polygon-glm', amount: '1E-18', timestamp, details: 'driver-details-are-not-finality',
  agreementPayments: [], activityPayments: [{ activityId: binding.activityId, amount: '1E-18', allocationId: binding.allocationId }],
  signature: [0, 1, 255], signedBytes: [1, 2, 3] };
type Call = { method: string; path: string; authorization: string | undefined; body: string };
type Handler = (request: IncomingMessage, response: ServerResponse, call: Call) => Promise<void> | void;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(handler?: Handler, timeoutMs = 500) {
  const calls: Call[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 4096) throw new Error('Fixture request limit'); }
      const call = { method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization, body };
      calls.push(call);
      if (handler) { await handler(request, response, call); return; }
      response.setHeader('content-type', 'application/json');
      if (call.method !== 'GET') {
        if (call.path.endsWith('/terminate')) response.writeHead(204).end(); else response.end('null');
      } else response.end(JSON.stringify(call.path.includes('/debitNotes/') ? debit : call.path.includes('/invoices/') ? invoice : payment));
    })().catch(() => response.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address');
  const endpoint = 'http://127.0.0.1:' + address.port;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { calls, endpoint, protocol: new GolemFinanceHttpProtocol({ endpoint, apiKey, allowLocalHttp: true, timeoutMs }) };
}
const signal = () => new AbortController().signal;
async function rejected(call: Promise<unknown>, code: string) {
  try { await call; throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(Problem);
    if (!(error instanceof Problem)) throw error;
    expect(error.code).toBe(code);
    expect(error.message + JSON.stringify(error)).not.toContain(apiKey);
    expect(error.message).not.toMatch(/127\.0\.0\.1|provider-secret|postgresql|Bearer/);
  }
}

describe('Production Golem financial HTTP transport on an actual local HTTP fixture', () => {
  it('normalizes official optional debit fields, scientific decimals and metadata into the original strict DTO', async () => {
    const f = await fixture();
    const value = await f.protocol.document('debit', 'debit-1', signal());
    expect(value).toEqual({ ...parties, debitNoteId: 'debit-1', activityId: binding.activityId,
      totalAmountDue: '0.0000001', previousDebitNoteId: null, paymentDueDate: null });
    expect(f.calls).toEqual([{ method: 'GET', path: '/payment-api/v1/debitNotes/debit-1', authorization: 'Bearer ' + apiKey, body: '' }]);
    expect(JSON.stringify(f.protocol)).not.toContain(apiKey);
  });

  it('reads invoice and explicitly attributed payment without trusting flattened official signatures', async () => {
    const f = await fixture();
    expect(await f.protocol.document('invoice', 'invoice-1', signal())).toEqual({ ...invoice, amount: '2.5' });
    expect(await f.protocol.payment('payment-1', signal())).toEqual({ ...payment, amount: '0.000000000000000001',
      activityPayments: [{ ...payment.activityPayments[0]!, amount: '0.000000000000000001' }], signature: undefined, signedBytes: undefined });
  });

  it('preserves omitted allocation IDs as read-only wire observations and refuses lifecycle attribution', async () => {
    const wire = { ...payment, activityPayments: [{ activityId: binding.activityId, amount: '1E-18' }] };
    const parsed = parseGolemFinanceWirePayment(wire);
    expect(parsed.activityPayments).toEqual([{ activityId: binding.activityId, amount: '0.000000000000000001' }]);
    expect(parsed).not.toHaveProperty('signature'); expect(parsed).not.toHaveProperty('signedBytes');
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(wire)); });
    await rejected(f.protocol.payment('payment-1', signal()), 'golem_http_payment_unattributed');
    expect(f.calls).toHaveLength(1);
  });

  it('sends only the five pinned official mutation methods, paths and finite exact acceptance bodies', async () => {
    const f = await fixture();
    await f.protocol.mutate('accept_debit', binding, 'debit-1', '1E-18', signal());
    await f.protocol.mutate('accept_invoice', binding, 'invoice-1', '2.50', signal());
    await f.protocol.mutate('destroy_activity', binding, binding.activityId, undefined, signal());
    await f.protocol.mutate('terminate_agreement', binding, binding.agreementId, undefined, signal());
    await f.protocol.mutate('release_allocation', binding, binding.allocationId, undefined, signal());
    expect(f.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'POST', path: '/payment-api/v1/debitNotes/debit-1/accept', body: JSON.stringify({ totalAmountAccepted: '0.000000000000000001', allocationId: binding.allocationId }) },
      { method: 'POST', path: '/payment-api/v1/invoices/invoice-1/accept', body: JSON.stringify({ totalAmountAccepted: '2.5', allocationId: binding.allocationId }) },
      { method: 'DELETE', path: '/activity-api/v1/activity/' + binding.activityId, body: '' },
      { method: 'POST', path: '/market-api/v1/agreements/' + binding.agreementId + '/terminate', body: '' },
      { method: 'DELETE', path: '/payment-api/v1/allocations/' + binding.allocationId, body: '' },
    ]);
    expect(f.calls.every(call => call.authorization === 'Bearer ' + apiKey && !call.body.includes('autoAcceptTo'))).toBe(true);
  });

  it('rejects cross-run cleanup IDs, unexpected amounts, excess authority and path injection before any request', async () => {
    const f = await fixture();
    for (const action of ['destroy_activity', 'terminate_agreement', 'release_allocation'] as const) {
      await rejected(f.protocol.mutate(action, binding, 'other-resource', undefined, signal()), 'golem_http_request_invalid');
    }
    await rejected(f.protocol.mutate('release_allocation', binding, binding.allocationId, '0', signal()), 'golem_http_request_invalid');
    await rejected(f.protocol.mutate('accept_invoice', binding, 'invoice-1', '10.000000000000000001', signal()), 'golem_http_request_invalid');
    await rejected(f.protocol.mutate('accept_invoice', binding, 'invoice-1', undefined, signal()), 'golem_http_request_invalid');
    await rejected(f.protocol.document('debit', '../payment', signal()), 'golem_http_request_invalid');
    expect(f.calls).toEqual([]);
  });

  it.each(['http://example.com', 'http://localhost:7465', 'https://user:provider-secret@example.com',
    'https://example.com/payment-api/v1', 'https://example.com/?key=provider-secret', 'https://example.com/#fragment'])
  ('rejects unreviewed endpoint form %s without reading a network', endpoint => {
    expect(() => new GolemFinanceHttpProtocol({ endpoint, apiKey })).toThrow(Problem);
  });

  it('requires explicit local HTTP opt-in and sanitizes invalid configuration without exposing application keys', () => {
    for (const value of [{ endpoint: 'http://127.0.0.1:7465', apiKey },
      { endpoint: 'https://reviewed.example', apiKey: apiKey + '\r\nInjected: provider-secret' }]) {
      try { new GolemFinanceHttpProtocol(value); throw new Error('Expected invalid configuration'); }
      catch (error) { expect(error).toBeInstanceOf(Problem); expect(String(error)).not.toContain(apiKey); }
    }
    expect(() => new GolemFinanceHttpProtocol({ endpoint: 'https://reviewed.example', apiKey })).not.toThrow();
  });

  it.each(['1E-18', '1.2300e+2', '1000e-3', '0E+72'])('normalizes exact representable scientific amount %s', async value => {
    const expected = new Map([['1E-18', '0.000000000000000001'], ['1.2300e+2', '123'], ['1000e-3', '1'], ['0E+72', '0']]);
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...debit, totalAmountDue: value })); });
    expect(await f.protocol.document('debit', 'debit-1', signal())).toMatchObject({ totalAmountDue: expected.get(value) });
  });

  it.each(['1E-19', '1E+99', '1e999', '-1', 'NaN', 'Infinity', '1.0000000000000000001', 0.1])
  ('rejects unsupported amount %s without rounding', async value => {
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...debit, totalAmountDue: value })); });
    await rejected(f.protocol.document('debit', 'debit-1', signal()), 'golem_http_read_failed');
  });

  it.each([{ activityIds: [] }, { activityIds: [binding.activityId, 'other-activity'] }])('refuses an unbound invoice activity set %j', async ({ activityIds }) => {
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...invoice, activityIds })); });
    await rejected(f.protocol.document('invoice', 'invoice-1', signal()), 'golem_http_read_failed');
  });

  it('checks the exact requested identity on each read', async () => {
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...debit, debitNoteId: 'different-debit' })); });
    await rejected(f.protocol.document('debit', 'debit-1', signal()), 'golem_http_read_failed');
  });

  it('rejects duplicate financial JSON keys and invalid UTF-8', async () => {
    let invalidUtf8 = false;
    const f = await fixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(invalidUtf8 ? Buffer.from([0xff]) : JSON.stringify(debit).replace('{', '{"totalAmountDue":"5",'));
    });
    await rejected(f.protocol.document('debit', 'debit-1', signal()), 'golem_http_read_failed');
    invalidUtf8 = true;
    await rejected(f.protocol.document('debit', 'debit-1', signal()), 'golem_http_read_failed');
  });

  it.each(['size', 'encoding', 'headers'])('bounds response %s before accepting financial data', async mode => {
    const f = await fixture((_request, response) => {
      response.setHeader('content-type', 'application/json');
      if (mode === 'size') response.setHeader('content-length', '1048577');
      if (mode === 'encoding') response.setHeader('content-encoding', 'gzip');
      if (mode === 'headers') response.setHeader('x-excessive', 'x'.repeat(20_000));
      response.end('{}');
    });
    await rejected(f.protocol.document('debit', 'debit-1', signal()), 'golem_http_read_failed');
    expect(f.calls).toHaveLength(1);
  });

  it('bounds chunked response bytes without trusting an absent Content-Length', async () => {
    const f = await fixture((_request, response) => { response.setHeader('content-type', 'application/json'); response.write('{'); response.end(' '.repeat(1_048_577)); });
    await rejected(f.protocol.document('debit', 'debit-1', signal()), 'golem_http_read_failed');
  });

  it('never follows redirects or forwards a bearer to the redirected target', async () => {
    const target = await fixture();
    const f = await fixture((_request, response) => { response.writeHead(307, { location: target.endpoint + '/stolen' }).end('provider-secret'); });
    await rejected(f.protocol.mutate('accept_invoice', binding, 'invoice-1', '1', signal()), 'golem_http_write_unknown');
    await rejected(f.protocol.document('debit', 'debit-1', signal()), 'golem_http_read_failed');
    expect(target.calls).toEqual([]); expect(f.calls).toHaveLength(2);
  });

  it.each([404, 410, 500, 504])('keeps a mutation HTTP%s outcome unknown and never retries', async status => {
    const f = await fixture((_request, response) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'provider-secret ' + apiKey })); });
    await rejected(f.protocol.mutate('release_allocation', binding, binding.allocationId, undefined, signal()), 'golem_http_write_unknown');
    expect(f.calls).toHaveLength(1);
  });

  it('does not replay a submitted mutation when the provider drops its response', async () => {
    const f = await fixture(request => { request.socket.destroy(); });
    await rejected(f.protocol.mutate('accept_invoice', binding, 'invoice-1', '1', signal()), 'golem_http_write_unknown');
    expect(f.calls).toHaveLength(1);
  });

  it('covers incomplete response bodies with one absolute deadline and closes the actual socket', async () => {
    let seen!: () => void, closed!: () => void;
    const received = new Promise<void>(resolve => { seen = resolve; }), disconnected = new Promise<void>(resolve => { closed = resolve; });
    const f = await fixture((request, response) => { request.socket.once('close', closed); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); seen(); }, 100);
    const operation = f.protocol.document('debit', 'debit-1', signal());
    await received;
    await rejected(operation, 'golem_http_read_failed'); await disconnected;
    expect(f.calls).toHaveLength(1);
  });

  it('propagates caller abort through a live write body and never claims that abort undid its effects', async () => {
    let seen!: () => void;
    const received = new Promise<void>(resolve => { seen = resolve; });
    const f = await fixture((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); seen(); });
    const abort = new AbortController();
    const operation = f.protocol.mutate('accept_invoice', binding, 'invoice-1', '1', abort.signal);
    await received; abort.abort(new Error('provider-secret ' + apiKey));
    await rejected(operation, 'golem_http_write_unknown'); expect(f.calls).toHaveLength(1);
  });

  it('does not send an already aborted request', async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort();
    await rejected(f.protocol.document('debit', 'debit-1', abort.signal), 'golem_http_read_failed');
    expect(f.calls).toEqual([]);
  });

  it.each([200, 204])('accepts the pinned market terminate acknowledgement HTTP%s without claiming stop proof', async status => {
    const f = await fixture((_request, response) => { response.writeHead(status).end(); });
    await expect(f.protocol.mutate('terminate_agreement', binding, binding.agreementId, undefined, signal())).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(1);
  });

  it('requires the exact supported success statuses rather than treating any 2xx as payment/stop proof', async () => {
    const f = await fixture((_request, response, call) => { response.writeHead(call.path.endsWith('/terminate') ? 202 : 204).end(); });
    await rejected(f.protocol.mutate('terminate_agreement', binding, binding.agreementId, undefined, signal()), 'golem_http_write_unknown');
    await rejected(f.protocol.mutate('accept_debit', binding, 'debit-1', '1', signal()), 'golem_http_write_unknown');
    expect(f.calls).toHaveLength(2);
  });
});
