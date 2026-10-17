import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { addressSchema, canonical } from '../src/common.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { PlatformVaultRuntimeClient, platformVaultClientAbi, platformVaultRuntimeConfigSchema } from '../src/platform-runtime/vault-client.js';
import { platformEscrowAbi, platformPreparedSchema, platformQuoteInputSchema, platformQuoteTypes, typedPlatformQuote,
  type PlatformPrepared } from '../src/platform-runtime/types.js';
import { createPlatformMcpServer } from '../src/mcp/platform.js';

const fixtureSchema = z.object({ epoch: z.number(), owner: addressSchema, agent: addressSchema,
  execConfig: platformVaultRuntimeConfigSchema.omit({ binding: true, vaultPins: true }), execVaultConfig: platformVaultRuntimeConfigSchema,
  execEoa: z.object({ prepared: platformPreparedSchema }), execVault: z.object({ prepared: platformPreparedSchema }) });
const ownerToken = 'a'.repeat(64), agentToken = 'b'.repeat(64);
const publicTestSigner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const toolData = (value: unknown) => z.object({ structuredContent: z.object({ data: z.unknown() }) }).passthrough().parse(value).structuredContent.data;

describe('checked command SDK and MCP interoperability with real signed viem vectors over HTTP', () => {
  let fixture: z.infer<typeof fixtureSchema>, api: Server, origin: string;
  let mutate: (path: string, value: unknown) => unknown;
  const calls: { path: string; method: string; body: unknown; key: string | undefined }[] = [];
  const posts = () => calls.filter(call => call.method === 'POST');
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '', method = request.method ?? 'GET', chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bytes = Buffer.concat(chunks), body: unknown = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined;
    calls.push({ path, method, body, key: typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined });
    response.setHeader('Content-Type', 'application/json');
    const principal = request.headers.cookie === 'telomere_session=' + ownerToken ? fixture.owner
      : request.headers.cookie === 'telomere_session=' + agentToken ? fixture.agent : undefined;
    const deny = (status: number) => { response.statusCode = status; response.end('{"title":"fixture-denied"}'); };
    if (!principal) { deny(401); return; }
    if (method === 'POST' && (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json'
      || !/^[a-zA-Z0-9:_-]{1,128}$/.test(String(request.headers['idempotency-key'] ?? '')))) { deny(403); return; }
    let value: unknown;
    if (path === '/api/me') value = { address: principal, demo: false };
    else {
      const isVault = path.startsWith('/api/platform/vaults/');
      if (isVault && !path.startsWith('/api/platform/vaults/' + fixture.execVaultConfig.binding.vault + '/')) { deny(404); return; }
      if (isVault && principal !== fixture.agent) { deny(403); return; }
      if (path.endsWith('/config')) value = isVault ? fixture.execVaultConfig : fixture.execConfig;
      else if (path.endsWith('/quotes') && method === 'POST') value = isVault ? fixture.execVault.prepared : fixture.execEoa.prepared;
      else { deny(404); return; }
    }
    response.end(JSON.stringify(mutate(path, structuredClone(value))));
  }
  beforeAll(async () => {
    fixture = fixtureSchema.parse(JSON.parse(await readFile('python/tests/fixtures/platform-typescript.json', 'utf8')));
    api = createServer((request, response) => { void handle(request, response).catch(() => { response.statusCode = 503; response.end('{}'); }); });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const address = api.address(); if (!address || typeof address === 'string') throw new Error('Missing command fixture HTTP address');
    origin = 'http://127.0.0.1:' + address.port;
  });
  beforeEach(() => { calls.length = 0; mutate = (_path, value) => value; });
  afterAll(async () => { api?.closeAllConnections(); if (api) await new Promise<void>(resolve => api.close(() => resolve())); });
  const factory = (vaultMode: boolean) => vaultMode ? new PlatformVaultRuntimeClient({ baseUrl: origin,
    pins: fixture.execConfig.pins, vaultPins: fixture.execVaultConfig.vaultPins, vault: fixture.execVaultConfig.binding.vault,
    binding: fixture.execVaultConfig.binding, sessionToken: agentToken, nowSeconds: () => fixture.epoch })
    : new PlatformRuntimeClient({ baseUrl: origin, pins: fixture.execConfig.pins, sessionToken: ownerToken, nowSeconds: () => fixture.epoch });
  async function signForHost(prepared: PlatformPrepared, host: z.infer<typeof fixtureSchema>['execConfig']['capacity'][number], vaultMode: boolean) {
    const value = structuredClone(prepared);
    value.quote.hostId = host.hostId; value.quote.imageHash = keccak256(toHex(host.imageDigest)); value.quote.regionHash = keccak256(toHex(host.region));
    value.quote.workloadHash = keccak256(toHex(canonical({ task: value.input.task })));
    value.signature = await publicTestSigner.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
      chainId: fixture.execConfig.pins.chainId, verifyingContract: fixture.execConfig.pins.escrowAddress },
      types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(value.quote) });
    const args = [typedPlatformQuote(value.quote), value.signature, value.imageProof, value.regionProof] as const;
    value.transaction.data = vaultMode ? encodeFunctionData({ abi: platformVaultClientAbi, functionName: 'payRun', args })
      : encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun', args });
    return value;
  }
  describe.each([{ name: 'EOA', vaultMode: false }, { name: 'Vault', vaultMode: true }])('$name', ({ vaultMode }) => {
    const vector = () => vaultMode ? fixture.execVault.prepared : fixture.execEoa.prepared;
    const input = () => structuredClone(vector().input);
    it('verifies exact command arguments, Unicode stdin, full fee ceiling and unsigned ABI plan without starting work', async () => {
      const client = factory(vaultMode), prepared = await client.quote(input(), 'reviewed-command');
      expect(prepared).toEqual(vector()); expect(prepared.ceiling).toBe('331');
      expect(prepared.quote.workloadHash).toBe(keccak256(toHex(canonical({ task: input().task }))));
      expect(await client.openPlan(prepared)).toEqual(vector().transaction);
      expect(Object.isFrozen(prepared.input.task)).toBe(true);
      expect(posts()).toEqual([{ path: vaultMode ? '/api/platform/vaults/' + fixture.execVaultConfig.binding.vault + '/quotes' : '/api/platform/quotes',
        method: 'POST', body: input(), key: 'reviewed-command' }]);
      expect(calls.every(call => /\/(config|me|quotes)$/.test(call.path))).toBe(true);
    });
    it.each(['argv', 'stdin', 'image'] as const)('refuses substituted %s in an otherwise signed prepared command', async field => {
      const changed = structuredClone(vector());
      if (changed.input.task.kind !== 'exec') throw new Error('Expected exec vector');
      if (field === 'argv') changed.input.task.argv.push('substituted argument');
      else if (field === 'stdin') changed.input.task.stdin = 'substituted input';
      else changed.input.task.imageDigest = 'sha256:' + 'b'.repeat(64);
      await expect(factory(vaultMode).openPlan(changed)).rejects.toThrow(); expect(posts()).toHaveLength(0);
    });
    it('keeps one reservation key bound to the exact command and stdin', async () => {
      const client = factory(vaultMode); await client.quote(input(), 'same-command');
      for (const field of ['argv', 'stdin'] as const) {
        const changed = input(); if (changed.task.kind !== 'exec') throw new Error('Expected exec vector');
        if (field === 'argv') changed.task.argv.push('different'); else changed.task.stdin = 'different';
        await expect(client.quote(changed, 'same-command')).rejects.toThrow('different work');
      }
      expect(posts()).toHaveLength(1);
    });
    it('rechecks revoked capability before reusing a quote or returning its unsigned payment plan', async () => {
      const client = factory(vaultMode), prepared = await client.quote(input(), 'revocable-command');
      mutate = (path, value) => {
        if (!path.endsWith('/config')) return value;
        const config = z.object({ capacity: z.array(z.record(z.unknown())) }).passthrough().parse(value);
        for (const host of config.capacity) delete host.execEnabled;
        return config;
      };
      await expect(client.openPlan(prepared)).rejects.toThrow('scope');
      await expect(client.quote(input(), 'revocable-command')).rejects.toThrow('scope');
      await expect(client.quote(input(), 'new-revoked-command')).rejects.toThrow('command capacity');
      expect(posts()).toHaveLength(1);
    });
    it('requires an explicitly enabled paid session image and rechecks it before exposing a payment plan', async () => {
      const source = vector(), prepared = structuredClone(source);
      const host = fixture.execConfig.capacity[0]; if (!host) throw new Error('Missing reviewed host');
      prepared.input.task = { kind: 'session', imageDigest: host.imageDigest, maxCommands: 4 };
      prepared.input.maxSeconds = 10; prepared.input.maxSpend = '1101';
      prepared.quote.maxSeconds = 10; prepared.ceiling = '1101';
      const signed = await signForHost(prepared, host, vaultMode);
      mutate = (path, value) => {
        if (path.endsWith('/config')) {
          const config = z.object({ capacity: z.array(z.record(z.unknown())) }).passthrough().parse(value);
          for (const candidate of config.capacity) candidate.sessionEnabled = true;
          return config;
        }
        return path.endsWith('/quotes') ? signed : value;
      };
      const client = factory(vaultMode);
      expect(await client.quote(signed.input, 'paid-session')).toEqual(signed);
      expect(await client.openPlan(signed)).toEqual(signed.transaction);
      mutate = (path, value) => path.endsWith('/config') ? value : path.endsWith('/quotes') ? signed : value;
      await expect(client.openPlan(signed)).rejects.toThrow('scope');
      await expect(client.quote(signed.input, 'paid-session')).rejects.toThrow('scope');
      await expect(factory(vaultMode).quote(signed.input, 'revoked-session')).rejects.toThrow('session capacity');
      expect(posts()).toHaveLength(1);
    });
    it('rejects sessions too short for authenticated host admission before a quote request', async () => {
      const host = fixture.execConfig.capacity[0]; if (!host) throw new Error('Missing reviewed host');
      expect(() => factory(vaultMode).quote({ ...input(), task: { kind: 'session', imageDigest: host.imageDigest,
        maxCommands: 4 }, maxSeconds: 5 }, 'too-short-session')).toThrow('at least ten seconds');
      expect(posts()).toHaveLength(0);
    });
    it('treats omitted optional stdin and explicit undefined as the same signed command', async () => {
      const prepared = structuredClone(vector()), host = fixture.execConfig.capacity[0];
      if (!host || prepared.input.task.kind !== 'exec') throw new Error('Missing command vector');
      delete prepared.input.task.stdin;
      const signed = await signForHost(prepared, host, vaultMode);
      mutate = (path, value) => path.endsWith('/quotes') ? signed : value;
      const client = factory(vaultMode), absent = await client.quote(prepared.input, 'optional-stdin');
      const explicit = { ...prepared.input, task: { ...prepared.input.task, stdin: undefined } };
      expect(await client.quote(explicit, 'optional-stdin')).toEqual(absent);
      expect(await client.openPlan({ ...signed, input: explicit })).toEqual(signed.transaction);
      expect(posts()).toHaveLength(1); expect(posts()[0]?.body).toEqual(prepared.input);
    });
    it.each(['absent', 'false', 'string', 'number'] as const)('rejects %s command opt-in before writing an intent', async kind => {
      mutate = (path, value) => {
        if (!path.endsWith('/config')) return value;
        const config = z.object({ capacity: z.array(z.record(z.unknown())) }).passthrough().parse(value);
        for (const host of config.capacity) {
          if (kind === 'absent') delete host.execEnabled;
          else host.execEnabled = kind === 'false' ? false : kind === 'string' ? 'true' : 1;
        }
        return config;
      };
      await expect(factory(vaultMode).quote(input(), 'opt-in-' + kind)).rejects.toThrow(); expect(posts()).toHaveLength(0);
    });
    it.each(['image', 'region'] as const)('requires matching reviewed command %s before writing an intent', async kind => {
      const changed = input(); if (changed.task.kind !== 'exec') throw new Error('Expected exec vector');
      if (kind === 'image') changed.task.imageDigest = 'sha256:' + 'b'.repeat(64); else changed.regions = ['other-region'];
      await expect(factory(vaultMode).quote(changed, 'no-capacity-' + kind)).rejects.toThrow('command capacity'); expect(posts()).toHaveLength(0);
    });
    it.each(['image', 'opt-in'] as const)('rejects a valid signer selecting a second host with the wrong %s', async kind => {
      const original = fixture.execConfig.capacity[0]; if (!original) throw new Error('Missing reviewed host');
      const other = { ...original, hostId: '0x' + 'ab'.repeat(32) as Hex };
      if (kind === 'image') other.imageDigest = 'sha256:' + 'b'.repeat(64); else delete other.execEnabled;
      const signed = await signForHost(vector(), other, vaultMode);
      mutate = (path, value) => path.endsWith('/config') ? { ...z.record(z.unknown()).parse(value), capacity: [original, other] }
        : path.endsWith('/quotes') ? signed : value;
      await expect(factory(vaultMode).quote(input(), 'wrong-selected-' + kind)).rejects.toThrow('scope'); expect(posts()).toHaveLength(1);
    });
    it('rejects unsupported execution controls and oversized or invalid input before any API request', async () => {
      for (const task of [
        { kind: 'exec', imageDigest: 'sha256:' + 'a'.repeat(64), argv: ['/bin/sh', '-c', 'echo hi'] },
        { kind: 'exec', imageDigest: 'sha256:' + 'a'.repeat(64), argv: ['/bin/echo'], stdin: 'x\u0000y' },
        { kind: 'exec', imageDigest: 'sha256:' + 'a'.repeat(64), argv: ['/bin/echo'], stdin: '🧬'.repeat(2049) },
        { kind: 'exec', imageDigest: 'sha256:' + 'a'.repeat(64), argv: ['/bin/echo', 'x'.repeat(4096), 'x'.repeat(4096)] },
        { kind: 'exec', imageDigest: 'sha256:' + 'a'.repeat(64), argv: ['/bin/echo'], env: { SECRET: 'x' } },
        { kind: 'exec', imageDigest: 'sha256:' + 'a'.repeat(64), argv: ['/bin/echo'], mounts: ['/host'] },
      ]) await expect(async () => factory(vaultMode).quote({ ...input(), task }, 'invalid-command')).rejects.toThrow();
      await expect(async () => factory(vaultMode).quote({ ...input(), maxSeconds: 121 }, 'too-long')).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
    it('exposes the same checked command quote through the official MCP transport and redacts substituted work', async () => {
      const token = vaultMode ? agentToken : ownerToken;
      const server = createPlatformMcpServer({ client: new PlatformRuntimeClient({ baseUrl: origin, pins: fixture.execConfig.pins,
        sessionToken: token, nowSeconds: () => fixture.epoch }), createVaultClient: vault => new PlatformVaultRuntimeClient({ baseUrl: origin,
        pins: fixture.execConfig.pins, vaultPins: fixture.execVaultConfig.vaultPins, vault, sessionToken: token, nowSeconds: () => fixture.epoch }) });
      const peer = new Client({ name: 'command-sdk-test', version: '0.1.0' }), [local, remote] = InMemoryTransport.createLinkedPair();
      await server.connect(local); await peer.connect(remote);
      const args = { ...input(), idempotencyKey: 'mcp-command', ...(vaultMode ? { vault: fixture.execVaultConfig.binding.vault } : {}) };
      try {
        const result = await peer.callTool({ name: 'telomere_platform_quote', arguments: args });
        expect(result.isError).not.toBe(true); expect(toolData(result)).toEqual(vector());
        mutate = (path, value) => {
          if (!path.endsWith('/quotes')) return value;
          const changed = platformPreparedSchema.parse(value); if (changed.input.task.kind !== 'exec') throw new Error('Expected command');
          changed.input.task.stdin = 'unreviewed-server-input'; return changed;
        };
        const rejected = await peer.callTool({ name: 'telomere_platform_quote', arguments: { ...args, idempotencyKey: 'tampered-command' } });
        expect(rejected.isError).toBe(true); expect(toolData(rejected)).toEqual({ error: 'operation_failed' });
        expect(posts()).toHaveLength(2);
        expect(platformQuoteInputSchema.parse(posts()[0]?.body)).toEqual(input());
      } finally { await Promise.allSettled([peer.close(), server.close()]); }
    });
  });
});
