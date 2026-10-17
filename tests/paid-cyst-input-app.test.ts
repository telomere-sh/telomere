import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import pino from 'pino';
import { expect, it } from 'vitest';
import { addressSchema, Problem } from '../src/common.js';
import { createApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import type { PaidCystInputService } from '../src/platform-runtime/paid-cyst-input.js';
import { Service } from '../src/service.js';
import { openStore } from '../src/store.js';
import { Ed25519Identity } from '../src/host-kit/protocol.js';
import { signedCystInputResultSchema } from '../src/host-kit/sessions/cyst-input-protocol.js';

// This is an explicit ingress fixture: no paid reservation, Cyst or Cell is executed.
it('streams the exact binary PUT through real app authentication/Origin guards while retaining JSON guards elsewhere', async () => {
  const database = await openStore({ DATA_DIR: ':memory:' }), server = createServer();
  let enteredResolve: (() => void) | undefined, bytes = 0, uploads = 0;
  const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Ingress fixture port unavailable');
    const origin = 'http://127.0.0.1:' + address.port, owner = addressSchema.parse('0x' + '11'.repeat(20));
    const config = loadConfig({ MODE: 'demo', PUBLIC_ORIGIN: origin, DATA_DIR: ':memory:',
      SIGNER_PRIVATE_KEY: '0x' + '44'.repeat(32), DEMO_PRIVATE_KEY: '0x' + '55'.repeat(32),
      ESCROW_ADDRESS: '0x' + '66'.repeat(20), TOKEN_ADDRESS: '0x' + '77'.repeat(20) });
    const auth = new Auth(database.db, config), session = await auth.session(owner);
    const body = Buffer.alloc(1_048_576, 0x6d), operationId = 'reviewed_file_1', runId = '0x' + '88'.repeat(32), vault = '0x' + '99'.repeat(20);
    const path = '/api/platform/vaults/' + vault + '/runs/' + runId + '/inputs/' + operationId;
    const fixture: Pick<PaidCystInputService, 'status' | 'upload'> = {
      async status() { throw new Problem(404, 'fixture_unknown', 'Explicit ingress-only fixture.'); },
      async upload(principal, receivedVault, receivedRun, operation, input) {
        expect(principal).toBe(owner); expect(receivedVault).toBe(vault); expect(receivedRun).toBe(runId); expect(operation).toBe(operationId);
        expect(input.contentType).toBe('application/octet-stream'); expect(input.contentLength).toBe(String(body.length));
        uploads++; enteredResolve?.();
        const digest = createHash('sha256'), reader = input.body.getReader();
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; digest.update(chunk.value); } }
        finally { reader.releaseLock(); }
        expect(digest.digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
        const identity = new Ed25519Identity();
        return signedCystInputResultSchema.parse(identity.sign('cyst-input-result', {
          version: 1, hostKey: identity.publicKey, runId: receivedRun, owner: receivedVault,
          leaseHash: '0x' + '1'.repeat(64), descriptorHash: '0x' + '2'.repeat(64), operationId: operation,
          state: 'ready', committed: true, plaintextBytes: bytes, plaintextSha256: createHash('sha256').update(body).digest('hex'),
          path: '/run/telomere-cyst/state.bin', requestNonce: '0x' + '3'.repeat(64),
        }));
      },
    };
    const parameters: Parameters<typeof createApp> = [new Service(database.db, new ChainBridge(config), config, false), auth, pino({ enabled: false })];
    parameters[18] = fixture;
    const app = createApp(...parameters); server.on('request', getRequestListener(app.fetch));
    const headers = { Origin: origin, Cookie: 'telomere_session=' + session, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length), 'Idempotency-Key': operationId };
    // Leave the body unfinished until the actual upload handler has entered.
    const response = new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(origin + path, { method: 'PUT', headers, agent: false }, incoming => {
        incoming.resume(); incoming.once('end', () => resolve(incoming.statusCode ?? 0)); incoming.once('error', reject);
      });
      outgoing.once('error', reject); outgoing.flushHeaders(); outgoing.write(body.subarray(0, 4096));
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([entered, new Promise<never>((_resolve, fail) => { timer = setTimeout(() => fail(new Error('App buffered the binary request')), 3000); })])
        .then(() => outgoing.end(body.subarray(4096))).catch(error => { outgoing.destroy(); reject(error); }).finally(() => clearTimeout(timer));
    });
    expect(await response).toBe(200); expect(bytes).toBe(body.length); expect(uploads).toBe(1);
    const put = (target: string, extra: Record<string, string> = {}) => fetch(origin + target, { method: 'PUT',
      headers: { ...headers, 'Content-Length': '1', ...extra }, body: Uint8Array.of(1) });
    expect((await put(path, { Cookie: '' })).status).toBe(401);
    expect((await put(path, { Origin: 'https://foreign.invalid' })).status).toBe(403);
    expect((await put(path, { 'Content-Type': 'application/json' })).status).toBe(400);
    expect((await put(path + '/extra')).status).toBe(400);
    expect((await put('/api/platform/quotes')).status).toBe(400);
    expect(uploads).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await database.close(); }
}, 30_000);
