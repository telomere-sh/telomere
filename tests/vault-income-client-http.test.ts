import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { encodePaymentHeader } from '../src/payments/protocol.js';
import { VaultIncomePublicHttp } from '../src/sdk/vault-income/http.js';

const url = 'https://reviewed.example/x402/vault-income';
const json = (body = '{}', headers: HeadersInit = {}, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) } });
describe('bounded public Vault payer HTTP transport', () => {
  it('sends only the fixed body and payment header without cookie or authorization credentials', async () => {
    const http = new VaultIncomePublicHttp(url, async (actual, request) => {
      expect(actual).toBe(url); expect(request).toMatchObject({ method: 'POST', body: '{}', credentials: 'omit', redirect: 'error', cache: 'no-store' });
      expect(Object.fromEntries(new Headers(request.headers))).toEqual({ 'content-type': 'application/json', 'payment-signature': 'signed' });
      return json('{}', { 'PAYMENT-RESPONSE': encodePaymentHeader({ transaction: 'candidate' }) });
    });
    expect(await http.send('signed')).toEqual({ status: 200, payment: { transaction: 'candidate' }, body: {} });
  });
  it.each([
    ['duplicate body', () => json('{"x":1,"x":2}')],
    ['duplicate payment header JSON', () => json('{}', { 'PAYMENT-RESPONSE': Buffer.from('{"x":1,"x":2}').toString('base64') })],
    ['invalid header base64', () => json('{}', { 'PAYMENT-RESPONSE': 'e30' })],
    ['header limit', () => json('{}', { 'X-Large': 'a'.repeat(8193) })],
    ['field limit', () => json('{}', Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['X-' + i, 'a'])))],
    ['oversized Content-Length', () => json('{}', { 'Content-Length': '16385' })],
    ['malformed Content-Length', () => json('{}', { 'Content-Length': '01' })],
    ['oversized body', () => json(JSON.stringify('a'.repeat(16_384)))],
    ['invalid content type', () => json('{}', { 'Content-Type': 'text/html' })],
    ['empty body', () => new Response(null, { headers: { 'Content-Type': 'application/json' } })],
    ['NUL JSON', () => json('{"x":"\0"}')],
    ['BOM JSON', () => json('\ufeff{}')],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } })],
    ['lone surrogate string', () => json('{"x":"\\ud800"}')],
  ] as const)('rejects %s', async (_label, response) => {
    await expect(new VaultIncomePublicHttp(url, async () => response()).send()).rejects.toMatchObject({ code: 'vault_income_http_invalid' });
  });
  it('rejects overbound signed requests before invoking transport', async () => {
    let calls = 0; const http = new VaultIncomePublicHttp(url, async () => { calls++; return json(); });
    await expect(http.send('a'.repeat(8193))).rejects.toMatchObject({ code: 'vault_income_request_limit' }); expect(calls).toBe(0);
  });
  it('retains the actual streamed response deadline while bytes continue to arrive', async () => {
    let interval: ReturnType<typeof setInterval> | undefined, closed: Promise<void> | undefined;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"stream":"');
      interval = setInterval(() => response.write('a'), 100);
      closed = new Promise<void>(done => response.once('close', () => { clearInterval(interval); done(); }));
    }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Disposable HTTP port missing');
    try {
      const started = Date.now();
      await expect(new VaultIncomePublicHttp(`http://127.0.0.1:${address.port}/x402/vault-income`).send()).rejects.toMatchObject({ code: 'vault_income_http_timeout' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(9800); expect(Date.now() - started).toBeLessThan(12_000);
    } finally { clearInterval(interval); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    expect(closed).toBeDefined(); await closed;
  }, 15_000);
  it('preserves the limit error when cancellation never resolves', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{}')); }, cancel() { return new Promise(() => {}); } }),
      { headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' } });
    await expect(new VaultIncomePublicHttp(url, async () => response).send()).rejects.toMatchObject({ code: 'vault_income_http_invalid' });
  });
});
