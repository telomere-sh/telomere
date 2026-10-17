import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSelectionReader } from '../src/selection/rpc.js';

const contract = '0x' + '11'.repeat(20), blockHash = '0x' + '22'.repeat(32), parentHash = '0x' + '33'.repeat(32);
const limit = 8 * 1024 * 1024;

describe('bounded Selection JSON-RPC transport', () => {
  let server: Server, origin: string;
  let mode: 'valid' | 'wrong-id' | 'wrong-block' | 'oversized-header' | 'oversized-stream' | 'invalid-utf8' | 'stalled' | 'rpc-error';
  const calls: { method: string; params: unknown[] }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: unknown[] };
        calls.push({ method: body.method, params: body.params });
        response.setHeader('Content-Type', 'application/json');
        if (mode === 'oversized-header') { response.setHeader('Content-Length', String(limit + 1)); response.end('{}'); return; }
        if (mode === 'oversized-stream') {
          response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
          for (let index = 0; index < 129; index++) {
            if (!response.write(Buffer.alloc(65_536, 32))) await once(response, 'drain');
          }
          response.end(); return;
        }
        if (mode === 'invalid-utf8') { response.end(Buffer.from([0xff])); return; }
        if (mode === 'stalled') { response.writeHead(200); response.write('{'); return; }
        if (mode === 'rpc-error') { response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'private-provider-sentinel' } })); return; }
        const result = body.method === 'eth_chainId' ? '0x7a69' : body.method === 'eth_blockNumber' ? '0x9'
          : body.method === 'eth_getBlockByNumber' ? { number: mode === 'wrong-block' ? '0x8' : '0x9', hash: blockHash, parentHash, timestamp: '0x6af00000' }
            : body.method === 'eth_getLogs' ? [] : body.method === 'eth_getCode' ? '0x60006000'
              : body.method === 'eth_call' ? '0x' + '0'.repeat(63) + '7' : null;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: mode === 'wrong-id' ? body.id + 1 : body.id, result }));
      })().catch(() => { response.destroy(); });
    });
    server.keepAliveTimeout = 60_000;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing RPC fixture address');
    origin = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(() => { mode = 'valid'; calls.length = 0; });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  it('reads actual bounded JSON-RPC quantities, exact requested blocks, code, logs and balances', async () => {
    const reader = createSelectionReader(origin);
    expect(await reader.chainId()).toBe(31337); expect(await reader.head()).toBe(9n);
    expect(await reader.block(9n)).toEqual({ height: 9n, hash: blockHash, parentHash, timestamp: 0x6af00000n });
    expect(await reader.logs(2n, 9n, [contract])).toEqual([]);
    expect(await reader.codeHash(contract)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await reader.spendableBalance(contract, 9n)).toBe('7');
    expect(calls[2]).toEqual({ method: 'eth_getBlockByNumber', params: ['0x9', false] });
    expect(calls[3]).toEqual({ method: 'eth_getLogs', params: [{ fromBlock: '0x2', toBlock: '0x9', address: [contract] }] });
  });

  it.each(['wrong-id', 'oversized-header', 'oversized-stream', 'invalid-utf8', 'rpc-error'] as const)
    ('rejects and redacts %s responses over actual HTTP', async value => {
      mode = value;
      await expect(createSelectionReader(origin).head()).rejects.toThrow(/^Selection RPC request failed$/);
    });

  it('refuses a provider returning a different block height', async () => {
    mode = 'wrong-block';
    await expect(createSelectionReader(origin).block(9n)).rejects.toThrow('changed requested block');
  });

  it('bounds an unfinished actual HTTP body and permits a following valid request', async () => {
    mode = 'stalled'; const reader = createSelectionReader(origin, { timeoutMs: 80 }), started = Date.now();
    await expect(reader.head()).rejects.toThrow(/^Selection RPC request failed$/);
    expect(Date.now() - started).toBeLessThan(1000);
    mode = 'valid'; expect(await reader.head()).toBe(9n);
  });

  it.each(['advertised', 'streamed'] as const)('does not wait for failed cleanup of a %s oversized injected body', async framing => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { if (framing === 'streamed') controller.enqueue(new Uint8Array(limit + 1)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const reader = createSelectionReader(origin, { timeoutMs: 80, fetch: async () => new Response(body,
      { headers: framing === 'advertised' ? { 'Content-Length': String(limit + 1) } : {} }) });
    const started = Date.now();
    await expect(reader.head()).rejects.toThrow(/^Selection RPC request failed$/);
    expect(Date.now() - started).toBeLessThan(1000); expect(cancelled).toBe(true);
  });

  it('retains a deadline when an injected response body does not observe fetch abort', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const reader = createSelectionReader(origin, { timeoutMs: 80, fetch: async () => new Response(body) });
    const started = Date.now();
    await expect(reader.head()).rejects.toThrow(/^Selection RPC request failed$/);
    expect(Date.now() - started).toBeLessThan(1000); expect(cancelled).toBe(true);
  });

  it('validates the reviewed RPC origin and timeout before any network request', () => {
    for (const url of ['http://unreviewed.example', 'https://user:password@example.com', 'https://example.com/#fragment']) {
      expect(() => createSelectionReader(url)).toThrow();
    }
    for (const timeoutMs of [9, 60_001, NaN, Infinity, 10.5]) expect(() => createSelectionReader(origin, { timeoutMs })).toThrow();
    expect(calls).toHaveLength(0);
  });
});
