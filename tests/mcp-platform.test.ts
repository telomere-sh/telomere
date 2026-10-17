import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { addressSchema, canonical } from '../src/common.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { PlatformVaultRuntimeClient, platformVaultRuntimeConfigSchema } from '../src/platform-runtime/vault-client.js';
import { platformPreparedSchema } from '../src/platform-runtime/types.js';
import { createPlatformMcpServer } from '../src/mcp/platform.js';
import { commandResultSchema, sessionCommandSchema } from '../src/host-kit/sessions/types.js';

const vectorSchema = z.object({ prepared: platformPreparedSchema, run: z.record(z.unknown()), admissionHash: z.string(),
  actions: z.object({ stop: platformPreparedSchema.shape.transaction, refund: platformPreparedSchema.shape.transaction }) });
const fixtureSchema = z.object({ epoch: z.number(), owner: addressSchema, agent: addressSchema,
  config: platformVaultRuntimeConfigSchema.omit({ binding: true, vaultPins: true }), vaultConfig: platformVaultRuntimeConfigSchema,
  eoa: vectorSchema, vault: vectorSchema });
const dataSchema = z.object({ structuredContent: z.object({ data: z.unknown() }) }).passthrough();
const data = (value: unknown) => dataSchema.parse(value).structuredContent.data;
const ownerToken = 'a'.repeat(64), agentToken = 'b'.repeat(64), outsiderToken = 'c'.repeat(64), secret = 'private-fixture-detail-never-return';

describe('financial MCP with official paired transports, cookie-bound HTTP clients and real viem signatures', () => {
  let fixture: z.infer<typeof fixtureSchema>, api: Server, origin: string;
  let mutate: (path: string, value: unknown) => unknown, forcedStatus: number | undefined;
  const calls: { path: string; method: string; headers: IncomingMessage['headers']; body: unknown }[] = [];
  const quotes = new Map<string, string>(), admissions = new Set<string>();
  const runningSessions = new Set<string>(), commands = new Map<string, { input: string; result: unknown }>();
  let quoteWrites = 0, workStarts = 0, commandWrites = 0;
  const connect = async (sessionToken = ownerToken, factory?: (vault: string) => PlatformVaultRuntimeClient, supportVault = true) => {
    const client = new PlatformRuntimeClient({ baseUrl: origin, pins: fixture.config.pins, sessionToken, nowSeconds: () => fixture.epoch });
    const server = createPlatformMcpServer({ client, ...(supportVault ? { createVaultClient: factory ?? (vault => new PlatformVaultRuntimeClient({
      baseUrl: origin, pins: fixture.config.pins, vaultPins: fixture.vaultConfig.vaultPins, vault, sessionToken, nowSeconds: () => fixture.epoch })) } : {}) });
    const peer = new Client({ name: 'platform-test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await peer.connect(clientTransport);
    return { peer, server, async close() { await Promise.allSettled([peer.close(), server.close()]); } };
  };
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '', method = request.method ?? 'GET', chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), body: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined;
    calls.push({ path, method, headers: { ...request.headers }, body });
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    const fail = (status: number) => { response.statusCode = status; response.end(JSON.stringify({ title: secret, detail: secret })); };
    const token = request.headers.cookie?.match(/^telomere_session=([a-f0-9]{64})$/)?.[1];
    const principal = token === ownerToken ? fixture.owner : token === agentToken ? fixture.agent : token === outsiderToken ? '0x1111111111111111111111111111111111111111' : undefined;
    if (!principal) { fail(401); return; }
    if (forcedStatus !== undefined) { fail(forcedStatus); return; }
    if (method === 'POST' && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json'
      || !/^[a-zA-Z0-9:_-]{1,128}$/.test(String(request.headers['idempotency-key'] ?? '')))) { fail(403); return; }
    if (path === '/api/me') { response.end(JSON.stringify(mutate(path, { address: principal, demo: false }))); return; }
    const match = path.match(/^\/api\/platform\/vaults\/(0x[0-9a-fA-F]{40})(\/.*)$/), isVault = match !== null;
    const vault = isVault ? addressSchema.parse(match[1]) : undefined, suffix = isVault ? match[2] : path.slice('/api/platform'.length);
    if (isVault && principal !== fixture.owner && principal !== fixture.agent) { fail(404); return; }
    if (isVault && (suffix === '/quotes' || (suffix === '/runs' && method === 'POST')) && principal !== fixture.agent) { fail(404); return; }
    if (isVault && suffix?.endsWith('/commands') && principal !== fixture.agent) { fail(404); return; }
    if (isVault && suffix?.endsWith('/stop') && principal !== fixture.owner) { fail(404); return; }
    const vector = isVault ? fixture.vault : fixture.eoa;
    let result: unknown;
    if (suffix === '/config') result = isVault ? { ...fixture.vaultConfig, binding: { ...fixture.vaultConfig.binding, vault } } : fixture.config;
    else if (suffix === '/balance') result = { available: '1000000' };
    else if (suffix === '/quotes' && method === 'POST') {
      const key = String(vault ?? principal) + ':' + String(request.headers['idempotency-key']), input = canonical(body), previous = quotes.get(key);
      if (previous !== undefined && previous !== input) { fail(409); return; }
      if (previous === undefined) { quotes.set(key, input); quoteWrites += 1; }
      result = vector.prepared;
    } else if (suffix === '/runs' && method === 'POST') {
      const admission = z.object({ runId: z.string(), transactionHash: z.string() }).strict().parse(body);
      if (admission.runId !== vector.prepared.quote.runId || admission.transactionHash !== vector.admissionHash) { fail(409); return; }
      if (!admissions.has(admission.runId)) { admissions.add(admission.runId); workStarts += 1; }
      result = vector.run;
    } else if (suffix === '/runs') result = { runs: [vector.run] };
    else if (suffix === '/runs/' + vector.prepared.quote.runId) result = runningSessions.has(vector.prepared.quote.runId)
      ? { ...vector.run, status: 'running' } : vector.run;
    else if (suffix === '/runs/' + vector.prepared.quote.runId + '/commands' && method === 'POST') {
      if (!runningSessions.has(vector.prepared.quote.runId)) { fail(409); return; }
      const command = sessionCommandSchema.parse(body), key = vector.prepared.quote.runId + ':' + command.commandId;
      const original = commands.get(key), input = canonical(command);
      if (original && original.input !== input) { fail(409); return; }
      if (!original) {
        const commandResult = commandResultSchema.parse({ command, inputHash: createHash('sha256').update(input).digest('hex'),
          state: 'completed', stdout: 'ok', stderr: '', exitCode: 0, reason: 'exited', outputBytes: 2 });
        commands.set(key, { input, result: commandResult }); commandWrites++;
      }
      result = commands.get(key)?.result;
    } else if (suffix?.startsWith('/runs/' + vector.prepared.quote.runId + '/events?')) {
      if (!runningSessions.has(vector.prepared.quote.runId)) { fail(409); return; }
      const params = new URLSearchParams(suffix.split('?')[1]), after = Number(params.get('after')), limit = Number(params.get('limit'));
      const all = [{ sequence: 0, kind: 'started', commandId: 'mcp-paid-1' },
        { sequence: 1, kind: 'output', commandId: 'mcp-paid-1', stream: 'stdout', text: 'ok' },
        { sequence: 2, kind: 'command_exit', commandId: 'mcp-paid-1', exitCode: 0, reason: 'exited' }];
      const events = all.slice(after + 1, after + 1 + limit);
      result = { events, nextSequence: events.at(-1)?.sequence ?? after, eventCount: all.length, state: 'running' };
    }
    else if (suffix === '/runs/' + vector.prepared.quote.runId + '/stop') result = vector.actions.stop;
    else if (suffix === '/runs/' + vector.prepared.quote.runId + '/refund') result = vector.actions.refund;
    else { fail(404); return; }
    response.end(JSON.stringify(mutate(path, result)));
  }
  beforeAll(async () => {
    fixture = fixtureSchema.parse(JSON.parse(await readFile('python/tests/fixtures/platform-typescript.json', 'utf8')));
    api = createServer((request, response) => { void handle(request, response).catch(() => { response.statusCode = 503; response.end(JSON.stringify({ title: secret })); }); });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const address = api.address(); if (!address || typeof address === 'string') throw new Error('Missing authenticated fixture API address');
    origin = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(() => { mutate = (_path, value) => value; forcedStatus = undefined; calls.length = 0; quotes.clear(); admissions.clear();
    runningSessions.clear(); commands.clear(); quoteWrites = 0; workStarts = 0; commandWrites = 0; });
  afterAll(async () => { api?.closeAllConnections(); if (api) await new Promise<void>(resolve => api.close(() => resolve())); });

  it('discovers mounted paid job tools with truthful mutations and read-only wallet-plan annotations', async () => {
    const connection = await connect();
    try {
      const tools = (await connection.peer.listTools()).tools;
      expect(tools.map(tool => tool.name).sort()).toEqual([
        ...['config', 'balance', 'runs', 'run_status', 'quote', 'admit_confirmed_run',
          'session_command', 'session_events', 'stop_plan', 'refund_plan'].map(name => 'telomere_platform_' + name),
        ...['job_create', 'job_status', 'job_replan', 'job_approve', 'job_cancel', 'job_finish', 'reliability']
          .map(name => 'telomere_paid_cpu_' + name),
      ].sort());
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true, openWorldHint: false,
          readOnlyHint: !['telomere_platform_quote', 'telomere_platform_admit_confirmed_run',
            'telomere_platform_session_command', 'telomere_paid_cpu_job_create', 'telomere_paid_cpu_job_replan',
            'telomere_paid_cpu_job_approve', 'telomere_paid_cpu_job_cancel', 'telomere_paid_cpu_job_finish'].includes(tool.name) });
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
      expect(tools.find(tool => tool.name === 'telomere_platform_quote')?.description).toContain('Does not reserve funds');
      expect(tools.find(tool => tool.name === 'telomere_platform_quote')?.description).toContain('near_inference');
      expect(tools.find(tool => tool.name === 'telomere_platform_admit_confirmed_run')?.description).toContain('managed NEAR inference');
      expect(tools.some(tool => /sign|broadcast|fund/.test(tool.name.replace('refund', '')))).toBe(false);
      expect(tools.find(tool => tool.name === 'telomere_paid_cpu_job_approve')?.description).toContain('Funding/admission');
      expect(tools.find(tool => tool.name === 'telomere_paid_cpu_job_finish')?.inputSchema.properties)
        .toHaveProperty('expectedSourceRunId');
      expect(tools.find(tool => tool.name === 'telomere_paid_cpu_job_finish')?.description).toContain('Human owner declares application completion');
      expect(calls).toHaveLength(0);
    } finally { await connection.close(); }
  });
  it('reads checked EOA and Vault metadata/balances/runs without work or wallet calls', async () => {
    for (const vaultMode of [false, true]) {
      const connection = await connect(vaultMode ? agentToken : ownerToken), args = vaultMode ? { vault: fixture.vaultConfig.binding.vault } : {};
      const vector = vaultMode ? fixture.vault : fixture.eoa;
      try {
        const config = data(await connection.peer.callTool({ name: 'telomere_platform_config', arguments: args }));
        expect(config).toMatchObject({ pins: fixture.config.pins });
        expect(data(await connection.peer.callTool({ name: 'telomere_platform_balance', arguments: args }))).toEqual({ available: '1000000' });
        expect(data(await connection.peer.callTool({ name: 'telomere_platform_runs', arguments: args }))).toMatchObject({ runs: [{ id: vector.prepared.quote.runId }] });
        expect(data(await connection.peer.callTool({ name: 'telomere_platform_run_status', arguments: { ...args, runId: vector.prepared.quote.runId } }))).toMatchObject({ id: vector.prepared.quote.runId });
      } finally { await connection.close(); }
    }
    expect(workStarts).toBe(0); expect(quoteWrites).toBe(0); expect(calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('refuses session commands before a paid run is running and rejects out-of-range event cursors locally', async () => {
    const connection = await connect();
    try {
      const runId = fixture.eoa.prepared.quote.runId;
      const command = await connection.peer.callTool({ name: 'telomere_platform_session_command',
        arguments: { runId, commandId: 'audit', argv: ['/bin/echo', 'never-start'] } });
      expect(command.isError).toBe(true); expect(data(command)).toEqual({ error: 'operation_failed' });
      const cursor = await connection.peer.callTool({ name: 'telomere_platform_session_events',
        arguments: { runId, afterSequence: 4096 } });
      expect(cursor.isError).toBe(true);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
      expect(workStarts).toBe(0);
    } finally { await connection.close(); }
  });
  it('executes and replays one paid command through checked EOA and Vault MCP clients', async () => {
    for (const vaultMode of [false, true]) {
      const vector = vaultMode ? fixture.vault : fixture.eoa, runId = vector.prepared.quote.runId;
      runningSessions.add(runId);
      const connection = await connect(vaultMode ? agentToken : ownerToken);
      const args = { runId, commandId: 'mcp-paid-1', argv: ['/bin/echo', 'ok'],
        ...(vaultMode ? { vault: fixture.vaultConfig.binding.vault } : {}) };
      try {
        const first = await connection.peer.callTool({ name: 'telomere_platform_session_command', arguments: args });
        expect(first.isError).not.toBe(true);
        expect(commandResultSchema.parse(data(first))).toMatchObject({ command: { commandId: 'mcp-paid-1' }, stdout: 'ok', exitCode: 0 });
        expect(data(await connection.peer.callTool({ name: 'telomere_platform_session_command', arguments: args }))).toEqual(data(first));
        const events = await connection.peer.callTool({ name: 'telomere_platform_session_events',
          arguments: { runId, ...(vaultMode ? { vault: fixture.vaultConfig.binding.vault } : {}) } });
        expect(data(events)).toMatchObject({ eventCount: 3, nextSequence: 2, events: [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }] });
        const changed = await connection.peer.callTool({ name: 'telomere_platform_session_command',
          arguments: { ...args, argv: ['/bin/echo', 'changed'] } });
        expect(changed.isError).toBe(true); expect(data(changed)).toEqual({ error: 'operation_conflict' });
      } finally { await connection.close(); }
    }
    expect(commandWrites).toBe(2);
    const posts = calls.filter(call => call.path.endsWith('/commands'));
    expect(posts).toHaveLength(6);
    expect(posts.every(call => call.headers['idempotency-key'] === 'mcp-paid-1')).toBe(true);
    expect(workStarts).toBe(0);
  });
  it('returns real signed EOA/Vault full-proof quote plans and retains durable original keys across retries', async () => {
    for (const vaultMode of [false, true]) {
      const connection = await connect(vaultMode ? agentToken : ownerToken), vector = vaultMode ? fixture.vault : fixture.eoa;
      const args = { ...vector.prepared.input, ...(vaultMode ? { vault: fixture.vaultConfig.binding.vault } : {}), idempotencyKey: 'original-mcp-quote' };
      try {
        const [one, two] = await Promise.all([connection.peer.callTool({ name: 'telomere_platform_quote', arguments: args }), connection.peer.callTool({ name: 'telomere_platform_quote', arguments: args })]);
        expect(platformPreparedSchema.parse(data(one))).toEqual(vector.prepared); expect(data(two)).toEqual(data(one));
        expect(vector.prepared.imageProof.length).toBeGreaterThan(0); expect(vector.prepared.regionProof.length).toBeGreaterThan(0);
        const changed = await connection.peer.callTool({ name: 'telomere_platform_quote', arguments: { ...args, maxSpend: '332' } });
        expect(changed.isError).toBe(true); expect(data(changed)).toEqual({ error: 'operation_failed' });
      } finally { await connection.close(); }
    }
    expect(quoteWrites).toBe(2); expect(workStarts).toBe(0);
    const posts = calls.filter(call => call.method === 'POST'); expect(posts).toHaveLength(2);
    for (const post of posts) { expect(post.headers.origin).toBe(origin); expect(post.headers['idempotency-key']).toBe('original-mcp-quote'); }
  });
  it('admits only the original externally confirmed transaction and repeats without a second work start', async () => {
    for (const vaultMode of [false, true]) {
      const connection = await connect(vaultMode ? agentToken : ownerToken), vector = vaultMode ? fixture.vault : fixture.eoa;
      const args = { runId: vector.prepared.quote.runId, transactionHash: vector.admissionHash, idempotencyKey: 'original-mcp-admission',
        ...(vaultMode ? { vault: fixture.vaultConfig.binding.vault } : {}) };
      try {
        const one = await connection.peer.callTool({ name: 'telomere_platform_admit_confirmed_run', arguments: args });
        expect(one.isError).not.toBe(true); expect(data(one)).toMatchObject({ admissionTx: vector.admissionHash, status: 'queued' });
        expect(data(await connection.peer.callTool({ name: 'telomere_platform_admit_confirmed_run', arguments: args }))).toEqual(data(one));
        const unrelated = await connection.peer.callTool({ name: 'telomere_platform_admit_confirmed_run', arguments: { ...args, transactionHash: '0x' + 'ab'.repeat(32) } });
        expect(unrelated.isError).toBe(true); expect(data(unrelated)).toEqual({ error: 'operation_conflict' });
      } finally { await connection.close(); }
    }
    expect(workStarts).toBe(2); expect(quoteWrites).toBe(0);
  });
  it('returns exact read-only EOA/Vault owner stop and refund plans without admission or broadcasting', async () => {
    const connection = await connect(ownerToken);
    try {
      for (const vaultMode of [false, true]) {
        const vector = vaultMode ? fixture.vault : fixture.eoa, args = { runId: vector.prepared.quote.runId, idempotencyKey: 'exact-mcp-wallet-plan',
          ...(vaultMode ? { vault: fixture.vaultConfig.binding.vault } : {}) };
        for (const action of ['stop', 'refund'] as const) {
          const result = await connection.peer.callTool({ name: 'telomere_platform_' + action + '_plan', arguments: args });
          expect(result.isError).not.toBe(true); expect(data(result)).toEqual(vector.actions[action]);
        }
      }
      expect(workStarts).toBe(0); expect(quoteWrites).toBe(0);
      expect(calls.filter(call => call.method === 'POST').every(call => /\/(stop|refund)$/.test(call.path))).toBe(true);
      expect(calls.some(call => /eth_send|demo|transaction|approve|auth/.test(call.path))).toBe(false);
    } finally { await connection.close(); }
  });
  it('honors Vault roles and exposes generic errors without private server details', async () => {
    const owner = await connect(ownerToken), agent = await connect(agentToken), outsider = await connect(outsiderToken);
    const vault = fixture.vaultConfig.binding.vault, runId = fixture.vault.prepared.quote.runId;
    runningSessions.add(runId);
    try {
      const ownerQuote = await owner.peer.callTool({ name: 'telomere_platform_quote', arguments: { ...fixture.vault.prepared.input, vault, idempotencyKey: 'owner-cannot-run' } });
      expect(ownerQuote.isError).toBe(true); expect(data(ownerQuote)).toEqual({ error: 'operation_failed' });
      const agentStop = await agent.peer.callTool({ name: 'telomere_platform_stop_plan', arguments: { vault, runId, idempotencyKey: 'agent-cannot-stop' } });
      expect(agentStop.isError).toBe(true); expect(data(agentStop)).toEqual({ error: 'operation_failed' });
      const ownerCommand = await owner.peer.callTool({ name: 'telomere_platform_session_command',
        arguments: { vault, runId, commandId: 'owner-cannot-run', argv: ['/bin/echo', 'never'] } });
      expect(ownerCommand.isError).toBe(true); expect(data(ownerCommand)).toEqual({ error: 'operation_failed' });
      const denied = await outsider.peer.callTool({ name: 'telomere_platform_balance', arguments: { vault } });
      expect(denied.isError).toBe(true); expect(data(denied)).toEqual({ error: 'resource_unavailable' });
      expect(JSON.stringify([ownerQuote, agentStop, denied])).not.toContain(secret); expect(workStarts).toBe(0);
    } finally { await Promise.allSettled([owner.close(), agent.close(), outsider.close()]); }
  });
  it('rejects tampered financial SDK outputs instead of exposing unsigned changed payments', async () => {
    for (const pathSuffix of ['/quotes', '/stop']) {
      mutate = (path, raw) => {
        if (!path.endsWith(pathSuffix)) return raw;
        const value = z.record(z.unknown()).parse(structuredClone(raw));
        if (pathSuffix === '/quotes') {
          const prepared = platformPreparedSchema.parse(value); prepared.transaction.data += '00'; return prepared;
        }
        return { ...value, to: fixture.owner };
      };
      const connection = await connect();
      try {
        const args = pathSuffix === '/quotes' ? { ...fixture.eoa.prepared.input, idempotencyKey: 'tampered-mcp-plan' }
          : { runId: fixture.eoa.prepared.quote.runId, idempotencyKey: 'tampered-mcp-plan' };
        const result = await connection.peer.callTool({ name: pathSuffix === '/quotes' ? 'telomere_platform_quote' : 'telomere_platform_stop_plan', arguments: args });
        expect(result.isError).toBe(true); expect(data(result)).toEqual({ error: 'operation_failed' });
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally { await connection.close(); }
    }
    expect(workStarts).toBe(0);
  });
  it('requires strict operation inputs and durable keys before contacting the API', async () => {
    const connection = await connect();
    try {
      for (const [name, args] of [
        ['telomere_platform_config', { unexpected: true }], ['telomere_platform_run_status', { runId: 'invalid' }],
        ['telomere_platform_quote', fixture.eoa.prepared.input],
        ['telomere_platform_admit_confirmed_run', { runId: fixture.eoa.prepared.quote.runId, transactionHash: fixture.eoa.admissionHash }],
        ['telomere_platform_stop_plan', { runId: fixture.eoa.prepared.quote.runId }],
        ['telomere_platform_refund_plan', { runId: fixture.eoa.prepared.quote.runId, idempotencyKey: 'bad key' }],
        ['telomere_platform_quote', { ...fixture.eoa.prepared.input, maxSeconds: true, idempotencyKey: 'invalid-boolean' }],
        ['telomere_platform_quote', { ...fixture.eoa.prepared.input, nearPrompt: 'unpriced', idempotencyKey: 'invalid-provider' }],
      ] as const) {
        const result = await connection.peer.callTool({ name, arguments: args }); expect(result.isError).toBe(true);
      }
      expect(calls).toHaveLength(0); expect(workStarts).toBe(0);
    } finally { await connection.close(); }
  });
  it('bounds tool input structure below the HTTP envelope limit', async () => {
    const connection = await connect();
    try {
      const result = await connection.peer.callTool({ name: 'telomere_platform_quote', arguments: { ...fixture.eoa.prepared.input,
        task: { kind: 'sort', numbers: Array.from({ length: 4001 }, () => 1) }, idempotencyKey: 'too-many-elements' } });
      expect(result.isError).toBe(true); expect(calls).toHaveLength(0); expect(workStarts).toBe(0);
    } finally { await connection.close(); }
  });
  it('rejects absent, cross-origin and misbound Vault factories without sending credentials elsewhere', async () => {
    const vault = fixture.vaultConfig.binding.vault;
    const missing = await connect(ownerToken, undefined, false);
    const wrongOrigin = await connect(ownerToken, address => new PlatformVaultRuntimeClient({ baseUrl: 'https://other.example',
      pins: fixture.config.pins, vaultPins: fixture.vaultConfig.vaultPins, vault: address, sessionToken: ownerToken }));
    const wrongVault = await connect(ownerToken, () => new PlatformVaultRuntimeClient({ baseUrl: origin,
      pins: fixture.config.pins, vaultPins: fixture.vaultConfig.vaultPins, vault: fixture.owner, sessionToken: ownerToken }));
    try {
      expect(data(await missing.peer.callTool({ name: 'telomere_platform_config', arguments: { vault } }))).toEqual({ error: 'vault_mode_unavailable' });
      for (const connection of [wrongOrigin, wrongVault]) {
        const result = await connection.peer.callTool({ name: 'telomere_platform_config', arguments: { vault } });
        expect(result.isError).toBe(true); expect(data(result)).toEqual({ error: 'vault_client_scope_mismatch' });
      }
      expect(calls).toHaveLength(0);
    } finally { await Promise.allSettled([missing.close(), wrongOrigin.close(), wrongVault.close()]); }
  });
  it('retains at most sixteen distinct Vault clients with normalized reuse and no eviction', async () => {
    let created = 0;
    const connection = await connect(ownerToken, vault => { created += 1; return new PlatformVaultRuntimeClient({ baseUrl: origin,
      pins: fixture.config.pins, vaultPins: fixture.vaultConfig.vaultPins, vault, sessionToken: ownerToken, nowSeconds: () => fixture.epoch }); });
    const addresses = Array.from({ length: 17 }, (_value, index) => '0x' + (index + 1).toString(16).padStart(40, '0'));
    try {
      for (const vault of addresses.slice(0, 16)) {
        const value = await connection.peer.callTool({ name: 'telomere_platform_config', arguments: { vault } }); expect(value.isError).not.toBe(true);
      }
      expect(created).toBe(16);
      const limit = await connection.peer.callTool({ name: 'telomere_platform_config', arguments: { vault: addresses[16] } });
      expect(limit.isError).toBe(true); expect(data(limit)).toEqual({ error: 'vault_client_limit' }); expect(created).toBe(16);
      const retained = await connection.peer.callTool({ name: 'telomere_platform_balance', arguments: { vault: addresses[0] } });
      expect(retained.isError).not.toBe(true); expect(created).toBe(16);
    } finally { await connection.close(); }
  });
  it('redacts known HTTP failures and unexpected private factory exceptions', async () => {
    for (const [status, code] of [[401, 'wallet_auth_required'], [403, 'operation_forbidden'], [404, 'resource_unavailable'],
      [409, 'operation_conflict'], [422, 'invalid_response_or_input'], [429, 'capacity_unavailable'], [503, 'service_unavailable']] as const) {
      forcedStatus = status; const connection = await connect();
      try {
        const result = await connection.peer.callTool({ name: 'telomere_platform_balance', arguments: {} });
        expect(result.isError).toBe(true); expect(data(result)).toEqual({ error: code }); expect(JSON.stringify(result)).not.toContain(secret);
      } finally { await connection.close(); }
    }
    forcedStatus = undefined;
    const connection = await connect(ownerToken, () => { throw new Error(secret + ownerToken); });
    try {
      const result = await connection.peer.callTool({ name: 'telomere_platform_config', arguments: { vault: fixture.vaultConfig.binding.vault } });
      expect(result.isError).toBe(true); expect(data(result)).toEqual({ error: 'operation_failed' }); expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain(ownerToken);
    } finally { await connection.close(); }
  });
});
