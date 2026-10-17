import { createServer, request as nodeRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { Problem } from '../src/common.js';
import { openStore } from '../src/store.js';
import { TelomereClient } from '../src/sdk/index.js';
import { createTelomereMcpHttp, createTelomereReadOnlyMcpServer, type McpHttpLimits, type McpHttpOptions } from '../src/mcp/http.js';

const owner = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const runId = '0x' + 'a'.repeat(64), protocol = '2025-11-25';
const compatibilityUri = 'telomere://mcp/compatibility';
const initialize = (id: string | number = 1, version = protocol) => ({ jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'http-acceptance', version: '1.0.0' } } });
const message = (id: string | number, name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('actual Streamable HTTP MCP with real owner-cookie authentication', () => {
  let store: Awaited<ReturnType<typeof openStore>>, auth: Auth, httpMcp: ReturnType<typeof createTelomereMcpHttp>, app: Hono, server: Server;
  let origin: string, token: string, otherToken: string, sameOwnerToken: string, clock: number, reads: number, responseDelay: number;
  let requests: { method: string; path: string; cookie: string | undefined }[], clients: TelomereClient[], failingFactory: boolean, apiFailure: boolean, operationSize: number;
  const balance = { available: '123456789012345678901234', reserved: '9' };
  beforeEach(async () => {
    reads = 0; responseDelay = 0; clock = Date.now(); requests = []; clients = []; failingFactory = false; apiFailure = false; operationSize = 4;
    app = new Hono();
    app.onError((error, c) => c.json({ title: error instanceof Problem ? error.code : 'fixture_failure' }, error instanceof Problem ? error.status : 503));
    app.use('/api/*', async (c, next) => { requests.push({ method: c.req.method, path: c.req.path, cookie: c.req.header('cookie') }); await next(); });
    app.get('/api/me', async c => c.json({ address: await auth.owner(getCookie(c, 'telomere_session')), demo: true }));
    app.get('/api/balance', async c => {
      const address = await auth.owner(getCookie(c, 'telomere_session')); reads++;
      if (responseDelay) await delay(responseDelay);
      return c.json(address.toLowerCase() === owner ? balance : { available: '777', reserved: '0' });
    });
    app.get('/api/runs/:id', async c => {
      const address = await auth.owner(getCookie(c, 'telomere_session'));
      if (address.toLowerCase() !== owner || c.req.param('id') !== runId) throw new Problem(404, 'run_not_found', 'Run not found.');
      return c.json({ id: runId, owner, leashId: runId, task: { kind: 'sha256', text: 'owned' }, maxSeconds: 3,
        status: 'completed', charged: '100', refund: '200', billableSeconds: 1, errorCode: null, output: { sha256: 'x' },
        createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() });
    });
    app.get('/api/operations', async c => {
      await auth.owner(getCookie(c, 'telomere_session'));
      if (apiFailure) return c.json({ title: 'fixture_private_failure', detail: token }, 503);
      return c.json({ status: 'ready', diagnostic: 'x'.repeat(operationSize) });
    });
    app.all('/mcp', c => httpMcp.handle(c.req.raw));
    server = createServer(getRequestListener(app.fetch)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
    origin = `http://127.0.0.1:${address.port}`;
    const config = loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, SIGNER_PRIVATE_KEY: '0x' + '1'.repeat(64),
      DEMO_PRIVATE_KEY: '0x' + '2'.repeat(64), ESCROW_ADDRESS: owner, TOKEN_ADDRESS: other });
    store = await openStore(config); auth = new Auth(store.db, config);
    token = await auth.session(owner); otherToken = await auth.session(other); sameOwnerToken = await auth.session(owner);
    reset();
  });
  function reset(limits?: Partial<McpHttpLimits>, createSessionServer?: McpHttpOptions['createServer']) {
    httpMcp = createTelomereMcpHttp({ publicOrigin: origin, auth, now: () => clock, ...(limits ? { limits } : {}),
      ...(createSessionServer ? { createServer: createSessionServer } : {}),
      createClient: cookie => { if (failingFactory) throw new Error('private fixture factory detail');
        const value = new TelomereClient({ baseUrl: origin, sessionToken: cookie }); clients.push(value); return value; } });
  }
  afterEach(async () => {
    await httpMcp?.close(); server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await store?.close();
    vi.restoreAllMocks();
  });
  function post(value: unknown, session?: string, cookie = token, headers: Record<string, string> = {}) {
    return fetch(origin + '/mcp', { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
      Origin: origin, Cookie: `telomere_session=${cookie}`, ...(session ? { 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': protocol } : {}), ...headers },
      body: JSON.stringify(value), redirect: 'error' });
  }
  async function session(cookie = token) {
    const result = await post(initialize(), undefined, cookie); expect(result.status).toBe(200);
    const id = result.headers.get('mcp-session-id'); expect(id).toMatch(/^[0-9a-f-]{36}$/); if (!id) throw new Error('Missing MCP session');
    expect(await result.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: protocol } });
    const ready = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, id, cookie); expect(ready.status).toBe(202); expect(await ready.text()).toBe('');
    return id;
  }

  it('negotiates with the official HTTP client, advertises bounded paid CPU actions and terminates', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Origin: origin, Cookie: `telomere_session=${token}` }, redirect: 'error' } });
    const client = new Client({ name: 'official-http', version: '1.0.0' });
    try {
      // SDK 1.x declares a sessionId getter as string|undefined while Transport's optional field excludes explicit undefined.
      // Forward the documented transport operations/callbacks rather than asserting away that exact-optional mismatch.
      const compatible: Transport = { start: () => transport.start(), send: (value, options) => transport.send(value, options), close: () => transport.close() };
      transport.onmessage = value => compatible.onmessage?.(value);
      transport.onerror = error => compatible.onerror?.(error); transport.onclose = () => compatible.onclose?.();
      await client.connect(compatible); const list = await client.listTools(); expect(list.tools).toHaveLength(16);
      const resources = await client.listResources();
      expect(resources.resources).toMatchObject([{ uri: compatibilityUri, name: 'telomere_mcp_compatibility', mimeType: 'application/json' }]);
      const compatibility = await client.readResource({ uri: compatibilityUri });
      const content = compatibility.contents[0];
      if (!content || !('text' in content)) throw new Error('Missing text compatibility resource');
      const profile = JSON.parse(content.text);
      expect(profile).toMatchObject({ schemaVersion: 1, profile: 'owner-cpu',
        protocol: { era: 'initialize-session', discovery: 'initialize', latestVersion: protocol },
        transport: { responseMode: 'json', sessionful: true, standaloneGetStream: false },
        authority: { authentication: 'same-origin-owner-cookie', walletSubmission: 'external' }, toolCatalog: 'tools/list' });
      expect(profile.protocol.sdkNegotiatedVersions).toContain(protocol);
      expect(profile.protocol.sdkNegotiatedVersions).not.toContain('2026-07-28');
      expect(list.tools.filter(tool => tool.annotations?.readOnlyHint === false).map(tool => tool.name).sort())
        .toEqual(['telomere_quote', 'telomere_admit_confirmed_run'].sort());
      expect(list.tools.find(tool => tool.name === 'telomere_admit_confirmed_run')?.annotations)
        .toMatchObject({ destructiveHint: true, idempotentHint: true, openWorldHint: true });
      expect(list.tools.find(tool => tool.name === 'telomere_stop_plan')?.annotations?.readOnlyHint).toBe(true);
      expect(list.tools.map(tool => tool.name).some(name => /deposit|save|spawn|kill/.test(name))).toBe(false);
      expect(await client.callTool({ name: 'telomere_balance', arguments: {} })).toMatchObject({ structuredContent: { data: balance } });
      expect(await client.callTool({ name: 'telomere_session_status', arguments: {} })).toMatchObject({ structuredContent: { data: { address: owner } } });
      expect(requests.every(request => request.method === 'GET')).toBe(true);
      const id = transport.sessionId; expect(id).toBeTruthy(); await transport.terminateSession();
      expect((await post(message(100, 'telomere_balance'), id)).status).toBe(404);
    } finally { await client.close(); }
  });
  it('retains an explicit trusted read-only factory for restricted integrations', async () => {
    await httpMcp.close(); reset(undefined, client => createTelomereReadOnlyMcpServer(client));
    const id = await session();
    const listed = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, id)).json();
    expect(listed.result.tools).toHaveLength(13);
    expect(listed.result.tools.every((tool: { annotations?: { readOnlyHint?: boolean } }) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const compatibility = await (await post({ jsonrpc: '2.0', id: 3, method: 'resources/read',
      params: { uri: compatibilityUri } }, id)).json();
    expect(JSON.parse(compatibility.result.contents[0].text)).toMatchObject({ profile: 'owner-read-only' });
  });
  it('keeps compatibility metadata cookie-scoped and rejects a modern discovery probe without advertising 2026', async () => {
    const probe = await post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }, undefined, token, { 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' });
    expect(probe.status).toBe(400);
    expect(await probe.json()).toMatchObject({ error: { message: 'mcp_initialize_required' } });
    expect(clients).toHaveLength(0);
    const id = await session();
    const read = { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: compatibilityUri } };
    expect((await post(read, id, otherToken)).status).toBe(404);
    expect((await post(read, id, sameOwnerToken)).status).toBe(404);
    await auth.logout(token);
    expect((await post(read, id)).status).toBe(401);
    expect(requests).toHaveLength(0);
  });
  it('supplies the trusted factory with a fresh origin-checked client and exact current cookie for each isolated session', async () => {
    await httpMcp.close();
    const created: { client: TelomereClient; cookie: string; server: McpServer }[] = [];
    reset(undefined, (client, cookie) => {
      const custom = new McpServer({ name: 'trusted-session-fixture', version: '1.0.0' });
      created.push({ client, cookie, server: custom });
      custom.registerTool('fixture_balance', { inputSchema: z.object({}).strict() }, async () => ({
        content: [{ type: 'text', text: JSON.stringify(await client.balance()) }],
      }));
      return custom;
    });
    expect((await post(initialize(), undefined, '')).status).toBe(401); expect(created).toHaveLength(0);
    const first = await session(), sameOwner = await session(sameOwnerToken), anotherOwner = await session(otherToken);
    expect(created.map(value => value.cookie)).toEqual([token, sameOwnerToken, otherToken]);
    expect(created.map(value => value.client)).toEqual(clients);
    expect(new Set(created.map(value => value.client)).size).toBe(3);
    expect(new Set(created.map(value => value.server)).size).toBe(3);
    expect(created.every(value => value.client.origin === origin)).toBe(true);
    const tools = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, first)).json();
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['fixture_balance']);
    for (const [id, cookie, available] of [[first, token, balance.available], [sameOwner, sameOwnerToken, balance.available],
      [anotherOwner, otherToken, '777']] as const) {
      const result = await (await post(message(3, 'fixture_balance'), id, cookie)).json();
      expect(JSON.parse(result.result.content[0].text)).toMatchObject({ available });
      expect((await post(message(4, 'fixture_balance'), id, cookie === token ? sameOwnerToken : token)).status).toBe(404);
    }
    expect(requests.map(value => value.cookie)).toEqual([token, sameOwnerToken, otherToken].map(cookie => 'telomere_session=' + cookie));
  });
  it('redacts trusted factory and connect failures, closes failed servers and releases initialization capacity', async () => {
    await httpMcp.close();
    let failure: 'factory' | 'connect' | undefined = 'factory', calls = 0;
    const closed: ReturnType<typeof vi.spyOn>[] = [];
    reset({ maxSessions: 1, maxSessionsPerOwner: 1 }, (_client, cookie) => {
      calls++;
      if (failure === 'factory') throw new Error('private factory credential ' + cookie);
      const custom = new McpServer({ name: 'recoverable-session-fixture', version: '1.0.0' });
      if (failure === 'connect') {
        vi.spyOn(custom, 'connect').mockRejectedValueOnce(new Error('private connect credential ' + cookie));
        closed.push(vi.spyOn(custom, 'close'));
      }
      return custom;
    });
    for (const mode of ['factory', 'connect'] as const) {
      failure = mode; const result = await post(initialize()); expect(result.status).toBe(503);
      const body = await result.text(); expect(body).toContain('mcp_unavailable');
      expect(body).not.toContain(token); expect(body).not.toContain('private');
    }
    expect(closed).toHaveLength(1); expect(closed[0]).toHaveBeenCalledTimes(1);
    failure = undefined; const id = await session(); expect(calls).toBe(3);
    expect((await post(initialize(2))).status).toBe(429); expect(calls).toBe(3);
    expect((await fetch(origin + '/mcp', { method: 'DELETE', headers: { Origin: origin,
      Cookie: `telomere_session=${token}`, 'Mcp-Session-Id': id } })).status).toBe(200);
    expect(await session()).not.toBe(id); expect(calls).toBe(4);
  });
  it('rejects a client with another origin before invoking the trusted server factory', async () => {
    await httpMcp.close(); let called = false;
    httpMcp = createTelomereMcpHttp({ publicOrigin: origin, auth,
      createClient: cookie => new TelomereClient({ baseUrl: 'https://other.example', sessionToken: cookie }),
      createServer: () => { called = true; return new McpServer({ name: 'must-not-start', version: '1.0.0' }); },
    });
    const result = await post(initialize()); expect(result.status).toBe(503);
    expect(await result.text()).not.toContain(token); expect(called).toBe(false); expect(requests).toHaveLength(0);
    await httpMcp.close(); reset();
    const id = await session();
    const tools = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, id)).json();
    expect(tools.result.tools).toHaveLength(16);
  });
  it('requires current authentication on initialize, calls, replay, GET and termination without leaking cookies', async () => {
    expect((await post(initialize(), undefined, '')).status).toBe(401);
    const id = await session(); const call = message(2, 'telomere_balance'); expect((await post(call, id)).status).toBe(200); expect(reads).toBe(1);
    await auth.logout(token);
    for (const method of ['GET', 'DELETE'] as const) {
      const result = await fetch(origin + '/mcp', { method, headers: { Origin: origin, Cookie: `telomere_session=${token}`, 'Mcp-Session-Id': id } });
      expect(result.status).toBe(401); expect(await result.text()).not.toContain(token);
    }
    expect((await post(call, id)).status).toBe(401); expect(reads).toBe(1);
    expect((await post(initialize(), undefined, token, { Authorization: 'Bearer ' + token })).status).toBe(401);
  });
  it('binds sessions to owner and exact cookie, including another login by the same owner', async () => {
    const id = await session();
    for (const cookie of [otherToken, sameOwnerToken]) {
      expect((await post(message(2, 'telomere_session_status'), id, cookie)).status).toBe(404);
      expect((await post(message(3, 'telomere_quote', { leashId: runId, task: { kind: 'sha256', text: 'blocked' },
        maxSeconds: 3, idempotencyKey: 'blocked_quote_001' }), id, cookie)).status).toBe(404);
      expect((await fetch(origin + '/mcp', { method: 'DELETE', headers: { Origin: origin, Cookie: `telomere_session=${cookie}`, 'Mcp-Session-Id': id } })).status).toBe(404);
    }
    const otherId = await session(otherToken);
    expect(await (await post(message(2, 'telomere_balance'), otherId, otherToken)).json()).toMatchObject({ result: { structuredContent: { data: { available: '777' } } } });
    expect(await (await post(message(2, 'telomere_balance'), id)).json()).toMatchObject({ result: { structuredContent: { data: balance } } });
    expect(clients).toHaveLength(2);
    expect((await post(message(3, 'telomere_run_status', { runId }), otherId, otherToken)).status).toBe(200);
    const denied = await (await post(message(4, 'telomere_run_status', { runId }), otherId, otherToken)).text();
    expect(denied).toContain('run_not_found'); expect(denied).not.toContain('owned');
  });
  it('rejects DNS rebinding, cross-origin and missing-origin browser POST/DELETE and duplicate cookies', async () => {
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const result = await post(initialize(), undefined, token, headers); expect(result.status, JSON.stringify(headers)).toBe(403); expect(await result.text()).not.toContain(token);
    }
    // Native fetch normalizes Host to its URL. Send the actual attack with Node's raw HTTP client.
    const rebound = await new Promise<number>((resolve, reject) => {
      const value = nodeRequest(origin + '/mcp', { method: 'POST', headers: { Host: 'evil.example', Origin: origin,
        Cookie: `telomere_session=${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' } }, result => {
        result.resume(); resolve(result.statusCode ?? 0);
      }); value.once('error', reject); value.end(JSON.stringify(initialize()));
    }); expect(rebound).toBe(403);
    expect((await post(initialize(), undefined, token, { Cookie: `telomere_session=${token}; telomere_session=${otherToken}` })).status).toBe(401);
    const missing = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Cookie: `telomere_session=${token}` }, body: JSON.stringify(initialize()) });
    expect(missing.status).toBe(403);
    const id = await session();
    const deletion = await fetch(origin + '/mcp', { method: 'DELETE', headers: { Cookie: `telomere_session=${token}`, 'Mcp-Session-Id': id } }); expect(deletion.status).toBe(403);
    expect(reads).toBe(0); expect(requests).toHaveLength(0);
  });
  it('implements singleflight exact retries without re-reading and rejects changed reuse of an RPC identifier', async () => {
    const id = await session(); responseDelay = 80;
    const first = message('original_read', 'telomere_balance');
    const answers = await Promise.all(Array.from({ length: 6 }, () => post(first, id).then(answer => answer.text())));
    expect(new Set(answers).size).toBe(1); expect(reads).toBe(1);
    balance.available = '123456789012345678901235';
    expect(await (await post(first, id)).text()).toBe(answers[0]); expect(reads).toBe(1);
    expect((await post(message('original_read', 'telomere_operations'), id)).status).toBe(409);
    const fresh = await (await post(message('new_read', 'telomere_balance'), id)).json(); expect(fresh).toMatchObject({ result: { structuredContent: { data: balance } } });
    expect(reads).toBe(2); balance.available = '123456789012345678901234';
  });
  it('preserves an original read after a real disconnected HTTP response without dispatching it twice', async () => {
    const id = await session(); responseDelay = 100;
    const controller = new AbortController();
    const first = fetch(origin + '/mcp', { method: 'POST', headers: { Origin: origin, Cookie: `telomere_session=${token}`,
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Mcp-Session-Id': id, 'Mcp-Protocol-Version': protocol },
      body: JSON.stringify(message(2, 'telomere_balance')), signal: controller.signal }).catch(() => undefined);
    await delay(30); controller.abort(); await first;
    expect(await (await post(message(2, 'telomere_balance'), id)).json()).toMatchObject({ result: { structuredContent: { data: balance } } });
    expect(reads).toBe(1);
  });
  it('requires initialization/ready, negotiated version and one JSON-RPC object; does not offer unsolicited SSE', async () => {
    expect((await post(message(2, 'telomere_balance'))).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'initialize' })).status).toBe(400);
    const initialized = await post(initialize()); const id = initialized.headers.get('mcp-session-id'); expect(id).toBeTruthy(); if (!id) throw new Error('Missing session');
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: 'invalid' } }, id)).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, id)).status).toBe(202);
    expect((await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: {} } }, id)).status).toBe(202);
    expect((await post(message(2, 'telomere_balance'), id)).status).toBe(400);
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, id)).status).toBe(200);
    expect((await post(initialize(4), id)).status).toBe(400);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, id);
    expect((await post(message(5, 'telomere_balance'), id, token, { 'Mcp-Protocol-Version': '2026-07-28' })).status).toBe(400);
    expect((await post(message(5, 'telomere_balance'), id, token, { 'Mcp-Protocol-Version': '2025-06-18' })).status).toBe(400);
    expect((await post([message(5, 'telomere_balance')], id)).status).toBe(400);
    const get = await fetch(origin + '/mcp', { headers: { Cookie: `telomere_session=${token}`, 'Mcp-Session-Id': id, Accept: 'text/event-stream', 'Last-Event-ID': 'another-stream' } });
    expect(get.status).toBe(405); expect(get.headers.get('content-type')).not.toBe('text/event-stream');
    const unsupported = await post(initialize('unsupported', '2099-01-01')); expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ result: { protocolVersion: protocol } });
  });
  it('enforces MIME/Accept, streamed and declared bounds, UTF-8, structure limits and stalled-body timeout', async () => {
    for (const [headers, status] of [[{ Accept: 'application/json' }, 406], [{ Accept: 'application/json;q=0, text/event-stream' }, 406], [{ 'Content-Type': 'text/plain' }, 415], [{ 'Content-Encoding': 'gzip' }, 415]] as const) {
      expect((await post(initialize(), undefined, token, headers)).status).toBe(status);
    }
    await httpMcp.close(); reset({ maxBodyBytes: 512, bodyTimeoutMs: 50 });
    const bodyHeaders = { Origin: origin, Cookie: `telomere_session=${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    expect((await fetch(origin + '/mcp', { method: 'POST', headers: bodyHeaders, body: ' '.repeat(513) })).status).toBe(413);
    const raw = (parts: Uint8Array[], finish: boolean) => new Promise<number>((resolve, reject) => {
      const request = nodeRequest(origin + '/mcp', { method: 'POST', headers: bodyHeaders }, result => { result.resume(); resolve(result.statusCode ?? 0); request.destroy(); });
      request.once('error', reject); for (const part of parts) request.write(part); if (finish) request.end();
    });
    expect(await raw([Buffer.alloc(300, 32), Buffer.alloc(300, 32)], true)).toBe(413);
    expect(await raw([new Uint8Array([0xc3, 0x28])], true)).toBe(400);
    expect(await raw([Buffer.from('{')], false)).toBe(408);
    let nested: unknown = {}; for (let index = 0; index < 20; index++) nested = { child: nested };
    expect((await post({ ...initialize(), params: { nested } })).status).toBe(400);
  });
  it('bounds total/owner sessions, evicts expiry, clears on shutdown and does not retain failed initialization slots', async () => {
    await httpMcp.close(); reset({ maxSessions: 2, maxSessionsPerOwner: 1, idleMs: 100, lifetimeMs: 1000 });
    failingFactory = true; expect((await post(initialize())).status).toBe(503); failingFactory = false;
    const id = await session(); expect((await post(initialize(2))).status).toBe(429);
    const otherId = await session(otherToken); expect(otherId).not.toBe(id);
    clock += 101; expect((await post(message(2, 'telomere_balance'), id)).status).toBe(404);
    const replacement = await session(); expect(replacement).not.toBe(id);
    await httpMcp.close(); expect((await post(message(2, 'telomere_balance'), replacement)).status).toBe(503);
  });
  it('bounds distinct request history and concurrent reads while retaining original retry identity', async () => {
    await httpMcp.close(); reset({ maxRequestsPerSession: 3, maxPendingPerSession: 1 });
    const id = await session(); responseDelay = 100;
    const first = post(message(2, 'telomere_balance'), id); await delay(25);
    expect((await post(message(3, 'telomere_balance'), id)).status).toBe(429);
    expect((await first).status).toBe(200);
    expect((await post(message(3, 'telomere_balance'), id)).status).toBe(200);
    expect((await post(message(4, 'telomere_balance'), id)).status).toBe(429);
    expect((await post(message(2, 'telomere_balance'), id)).status).toBe(200); expect(reads).toBe(2);
  });
  it('redacts factory/upstream errors and rejects malformed paid actions before a backend call', async () => {
    const id = await session();
    for (const [index, [name, args]] of ([
      ['telomere_quote', { leashId: runId, task: { kind: 'sha256', text: 'work' }, maxSeconds: 3 }],
      ['telomere_quote', { leashId: runId, task: { kind: 'sha256', text: 'work' }, maxSeconds: 3,
        nearPrompt: 'not a CPU-only MCP quote', idempotencyKey: 'mcp_quote_001' }],
      ['telomere_admit_confirmed_run', { runId, txHash: 'not-a-hash' }],
      ['telomere_stop_plan', { runId, privateKey: 'secret' }],
      ['telomere_deposit_plan', {}],
    ] as const).entries()) {
      const denied = await (await post(message(index + 2, name, args), id)).text(); expect(denied).toContain('error'); expect(denied).not.toContain(token);
    }
    const extra = await (await post(message(10, 'telomere_balance', { owner: other, privateKey: 'secret' }), id)).text(); expect(extra).toContain('isError');
    expect(reads).toBe(0); expect(requests).toHaveLength(0);
    apiFailure = true; const failed = await (await post(message(11, 'telomere_operations'), id)).text();
    expect(failed).toContain('fixture_private_failure'); expect(failed).not.toContain(token);
  });
  it('terminates a session on bounded read timeout instead of replaying an unresolved operation', async () => {
    await httpMcp.close(); reset({ requestTimeoutMs: 75 }); const id = await session(); responseDelay = 200;
    expect((await post(message(2, 'telomere_balance'), id)).status).toBe(504);
    expect((await post(message(2, 'telomere_balance'), id)).status).toBe(404);
    await delay(210); expect(reads).toBe(1);
  });
  it('grants only the paid command tool its reviewed longer transport deadline', async () => {
    await httpMcp.close();
    let dispatches = 0;
    httpMcp = createTelomereMcpHttp({ publicOrigin: origin, auth, limits: { requestTimeoutMs: 75 },
      extendedToolTimeout: { name: 'telomere_platform_session_command', timeoutMs: 400 },
      createClient: cookie => new TelomereClient({ baseUrl: origin, sessionToken: cookie }),
      createServer: () => {
        const custom = new McpServer({ name: 'paid-timeout-fixture', version: '1.0.0' });
        const action = async () => { dispatches++; await delay(175); return { content: [{ type: 'text' as const, text: 'completed' }] }; };
        custom.registerTool('telomere_platform_session_command', { inputSchema: z.object({}).strict() }, action);
        custom.registerTool('fixture_short_deadline', { inputSchema: z.object({}).strict() }, action);
        return custom;
      } });
    const id = await session();
    const paid = await post(message(2, 'telomere_platform_session_command'), id);
    expect(paid.status).toBe(200); expect(await paid.text()).toContain('completed');
    expect((await post(message(2, 'telomere_platform_session_command'), id)).status).toBe(200);
    expect(dispatches).toBe(1);
    expect((await post(message(3, 'fixture_short_deadline'), id)).status).toBe(504);
    expect((await post(message(3, 'fixture_short_deadline'), id)).status).toBe(404);
    await delay(180); expect(dispatches).toBe(2);
  });
  it('closes in-flight transport reads promptly and never resurrects the session after DELETE', async () => {
    const id = await session(); responseDelay = 200;
    const call = post(message(2, 'telomere_balance'), id); await delay(30);
    expect((await fetch(origin + '/mcp', { method: 'DELETE', headers: { Origin: origin, Cookie: `telomere_session=${token}`, 'Mcp-Session-Id': id } })).status).toBe(200);
    expect((await call).status).toBe(404);
    expect((await post(message(2, 'telomere_balance'), id)).status).toBe(404); await delay(210); expect(reads).toBe(1);
  });
  it('bounds response and replay bytes, retiring the session when it cannot retain another exact result', async () => {
    await httpMcp.close(); reset({ maxResponseBytes: 1024, maxReplayBytesPerSession: 2048 }); const id = await session(); operationSize = 1024;
    expect((await post(message(2, 'telomere_operations'), id)).status).toBe(413);
    expect((await post(message(2, 'telomere_operations'), id)).status).toBe(404);
    await httpMcp.close(); reset({ maxReplayBytesPerSession: 1024 }); operationSize = 300; const next = await session();
    expect((await post(message(2, 'telomere_operations'), next)).status).toBe(200);
    expect((await post(message(3, 'telomere_balance'), next)).status).toBe(404);
  });
});
