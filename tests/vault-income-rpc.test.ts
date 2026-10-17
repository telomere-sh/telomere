import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vaultIncomeRpcFetch } from '../src/payments/vault-income-rpc.js';

const message = 'Vault income RPC is unavailable', secret = 'private-rpc-sentinel';
describe('retained bounded Vault income RPC headers and body transport', () => {
  let server: Server, origin: string, requests: number, redirected: number;
  const timers = new Set<ReturnType<typeof setInterval>>();
  beforeEach(async () => {
    requests = 0; redirected = 0;
    server = createServer((request, response) => {
      requests++; request.resume(); response.setHeader('Content-Type', 'application/json');
      const route = request.url?.split('/').at(-1);
      if (route === 'redirect') { response.writeHead(302, { Location: '/' + secret + '/sink' }); response.end(); return; }
      if (route === 'sink') redirected++;
      if (route === 'status') { response.writeHead(503); response.end(secret); return; }
      if (route === 'declared') { response.setHeader('Content-Length', '262145'); response.end('{}'); return; }
      if (route === 'streamed') { response.write(' '.repeat(131072)); response.end(' '.repeat(131073)); return; }
      if (route === 'headers') { response.setHeader('X-Private', 'a'.repeat(8192)); response.end('{}'); return; }
      if (route === 'header-count') { for (let index = 0; index < 41; index++) response.setHeader('X-' + index, 'a'); response.end('{}'); return; }
      if (route === 'duplicate') { response.end('{"id":1,"id":2}'); return; }
      if (route === 'invalid-utf8') { response.end(Buffer.from([0x7b, 0xff, 0x7d])); return; }
      if (route === 'incomplete-utf8') { response.end(Buffer.from([0xe2, 0x82])); return; }
      if (route === 'bom') { response.end('\uFEFF{}'); return; }
      if (route === 'trickle') {
        response.flushHeaders(); response.write('{');
        const timer = setInterval(() => response.write(' '), 100); timers.add(timer);
        response.once('close', () => { clearInterval(timer); timers.delete(timer); }); return;
      }
      const body = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"Привет 🧬"}');
      const split = body.indexOf(Buffer.from('🧬')) + 1;
      response.write(body.subarray(0, split)); setTimeout(() => response.end(body.subarray(split)), 5);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned RPC fixture address missing');
    origin = 'http://127.0.0.1:' + address.port + '/' + secret;
  });
  afterEach(async () => {
    vi.restoreAllMocks(); for (const timer of timers) clearInterval(timer); timers.clear();
    server?.closeAllConnections(); if (server) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  });
  it('accepts actual split Unicode JSON and returns a bounded JSON response', async () => {
    const result = await vaultIncomeRpcFetch(origin + '/valid', { method: 'POST', body: '{}' });
    expect(result.headers.get('Content-Type')).toBe('application/json');
    expect(await result.json()).toEqual({ jsonrpc: '2.0', id: 1, result: 'Привет 🧬' });
  });
  it.each(['declared', 'streamed', 'headers', 'header-count', 'duplicate', 'invalid-utf8', 'incomplete-utf8', 'bom', 'status'])(
    'refuses actual %s response with a fixed redacted diagnostic', async route => {
      try { await vaultIncomeRpcFetch(origin + '/' + route); throw new Error('Expected bounded RPC refusal'); }
      catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe(message); expect(String(error)).not.toContain(secret); }
    });
  it('refuses HTTP redirects without contacting their destination', async () => {
    await expect(vaultIncomeRpcFetch(origin + '/redirect')).rejects.toThrow(message);
    expect(requests).toBe(1); expect(redirected).toBe(0);
  });
  it('refuses an already aborted call without making any HTTP request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(vaultIncomeRpcFetch(origin + '/valid', { signal: controller.signal })).rejects.toThrow(message);
    expect(requests).toBe(0);
  });
  it('respects a Request signal during body read and permits the following request', async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 100);
    try { await expect(vaultIncomeRpcFetch(new Request(origin + '/trickle', { signal: controller.signal }))).rejects.toThrow(message); }
    finally { clearTimeout(timer); }
    expect((await vaultIncomeRpcFetch(origin + '/valid')).status).toBe(200);
  });
  it('retains a total ten-second deadline after actual HTTP headers despite a continuing body trickle', async () => {
    const started = Date.now(); await expect(vaultIncomeRpcFetch(origin + '/trickle')).rejects.toThrow(message);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9500); expect(Date.now() - started).toBeLessThan(14_000);
    expect((await vaultIncomeRpcFetch(origin + '/valid')).status).toBe(200);
  }, 18_000);
  it('does not await a stream cancellation promise that never resolves', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(262145)); },
      cancel() { canceled = true; return new Promise<void>(() => {}); } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    const started = Date.now(); await expect(vaultIncomeRpcFetch(origin + '/unused')).rejects.toThrow(message);
    expect(canceled).toBe(true); expect(Date.now() - started).toBeLessThan(1000); expect(requests).toBe(0);
  });
});
