import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openStore, sessions } from '../src/store.js';
import { Service } from '../src/service.js';
import { ChainBridge } from '../src/bridge.js';
import { createApp } from '../src/app.js';
import { secretHash } from '../src/common.js';

describe('CPU public launch security boundaries', () => {
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  const origin = 'https://telomere.example';
  const base = loadConfig({ SIGNER_PRIVATE_KEY: generatePrivateKey(), DEMO_PRIVATE_KEY: generatePrivateKey(),
    ESCROW_ADDRESS: alice.address, TOKEN_ADDRESS: bob.address, DATA_DIR: ':memory:' });
  const config = { ...base, MODE: 'testnet' as const, WALLET_ACCESS: 'public' as const, PUBLIC_ORIGIN: origin };
  let store: Awaited<ReturnType<typeof openStore>>;
  let auth: Auth;
  function application() { return createApp(new Service(store.db, new ChainBridge(base), config, false), auth, pino({ level: 'silent' })); }
  beforeAll(async () => { store = await openStore(config); auth = new Auth(store.db, config); }, 30000);
  afterAll(async () => { await store?.close(); });
  const input = (body: unknown, cookie = '') => ({ method: 'POST', headers: { origin, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  async function signed(account = alice) { const c = await auth.challenge(account.address); return { address: account.address, nonce: c.nonce, signature: await account.signMessage({ message: c.message }) }; }

  it('stores session hashes and issues HTTPS-only HttpOnly strict cookies', async () => {
    const response = await application().request('/api/auth/verify', input(await signed()));
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie')!;
    expect(header).toMatch(/HttpOnly/i); expect(header).toMatch(/SameSite=Strict/i); expect(header).toMatch(/Secure/i);
    const token = header.split(';')[0]!.split('=')[1]!;
    const rows = await store.db.select().from(sessions).where(eq(sessions.hash, secretHash(token)));
    expect(rows).toHaveLength(1); expect(rows[0]!.hash).not.toBe(token);
  });
  it('replaces a supplied session rather than allowing fixation or retaining the old session', async () => {
    const old = await auth.session(bob.address);
    const r = await application().request('/api/auth/verify', input(await signed(), 'telomere_session=' + old));
    expect(r.status).toBe(200); await expect(auth.owner(old)).rejects.toMatchObject({ code: 'session_expired' });
    expect(await auth.owner(r.headers.get('set-cookie')!.split(';')[0]!.split('=')[1])).toBe(alice.address.toLowerCase());
  });
  it('rejects expired and forged sessions on every owner-scoped read', async () => {
    const expired = await auth.session(alice.address);
    await store.db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.hash, secretHash(expired)));
    const app = application();
    for (const token of [expired, 'a'.repeat(64), '../etc/passwd', '']) for (const path of ['/api/me', '/api/workspace', '/api/runs', '/api/balance', '/api/leashes', '/api/operations']) {
      const r = await app.request(path, { headers: { cookie: 'telomere_session=' + token } }); expect(r.status).toBe(401);
      expect(await r.text()).not.toMatch(/postgres|password|stack|private.key/i);
    }
  });
  it('checks exact Origin and JSON before changing authentication state', async () => {
    for (const site of ['https://attacker.example', origin + '.attacker.example', 'null', '']) {
      const r = await application().request('/api/auth/challenge', { ...input({ address: alice.address }), headers: { origin: site, 'content-type': 'application/json' } });
      expect(r.status).toBe(403);
    }
    const r = await application().request('/api/auth/challenge', { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(400);
  });
  it('rejects oversized JSON and malformed bodies without returning parser details', async () => {
    const app = application();
    const large = await app.request('/api/auth/challenge', input({ address: alice.address, padding: 'x'.repeat(196609) })); expect(large.status).toBe(413);
    const malformed = await app.request('/api/auth/challenge', { ...input({}), body: '{not json' });
    expect(malformed.status).toBe(422); expect(await malformed.text()).not.toContain('SyntaxError');
  });
  it('does not expose demo signing in public Base mode', async () => {
    const app = application();
    expect((await app.request('/api/auth/demo', input({}))).status).toBe(404);
    const token = await auth.session(alice.address);
    for (const path of ['/api/demo/fund', '/api/demo/transaction']) expect((await app.request(path, input({}, 'telomere_session=' + token))).status).toBe(403);
  });
  it('does not trust spoofed proxy identity when no trusted socket is present', async () => {
    const app = application();
    for (let i = 0; i < 31; i++) {
      const r = await app.request('/api/auth/challenge', { ...input({ address: alice.address }), headers: { origin, 'content-type': 'application/json', 'x-real-ip': '198.18.0.' + i, 'x-forwarded-for': '198.18.1.' + i } });
      expect(r.status).toBe(i < 30 ? 200 : 429);
    }
  });
  it('binds login signatures to the complete issued message and consumes challenges once', async () => {
    const c = await auth.challenge(alice.address);
    for (const message of [c.message.replace(origin, 'https://attacker.example'), c.message.replace('Chain ID: ' + config.CHAIN_ID, 'Chain ID: 1'), c.message + '\n']) {
      await expect(auth.verify(alice.address, c.nonce, await alice.signMessage({ message }))).rejects.toMatchObject({ code: 'invalid_signature' });
    }
    const signature = await alice.signMessage({ message: c.message });
    await auth.verify(alice.address, c.nonce, signature);
    await expect(auth.verify(alice.address, c.nonce, signature)).rejects.toMatchObject({ code: 'invalid_signature' });
  });
});
