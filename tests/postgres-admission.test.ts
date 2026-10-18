import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Auth } from '../src/auth.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { Service } from '../src/service.js';
import { jobs, nonces, openStore, sessions } from '../src/store.js';
import { createWorkspaceRoutes, emptyWorkspace } from '../src/workspace/routes.js';
import { workspaceDocuments } from '../src/workspace/schema.js';
import { bytes32Schema, Problem } from '../src/common.js';

// Only an explicitly selected disposable loopback database is accepted. No
// ambient DATABASE_URL, application .env, production keys or migrations are used.
const selected = process.env.TELOMERE_TEST_POSTGRES_URL;
function reviewedDatabase(value: string): string {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || !/^\/telomere_(?:ci|audit)(?:_|$)/.test(url.pathname) || url.search || url.hash) {
    throw new Error('PostgreSQL acceptance requires a disposable loopback telomere_ci/audit database');
  }
  return value;
}

describe.skipIf(!selected)('real PostgreSQL multi-connection admission and account isolation', () => {
  const actors = Array.from({ length: 10 }, () => privateKeyToAccount(generatePrivateKey()));
  const signer = generatePrivateKey();
  const leashIds = actors.map((_, index) => bytes32Schema.parse('0x' + (index + 1).toString(16).padStart(64, '0')));
  let store: Awaited<ReturnType<typeof openStore>>, service: Service, auth: Auth;
  const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', WALLET_ACCESS: 'public', SIGNER_PRIVATE_KEY: signer, DEMO_PRIVATE_KEY: generatePrivateKey(),
    ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666', TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777' });
  const input = { leashId: leashIds[0]!, task: { kind: 'sha256' as const, text: 'postgres-atomic-admission' }, maxSeconds: 10 };
  beforeAll(async () => {
    store = await openStore({ DATA_DIR: ':memory:', DATABASE_URL: reviewedDatabase(selected!) });
    // Only chain authorization is a fixture here. Admission, auth nonce consumption
    // and Workspace compare-and-swap use the actual pg pool and PostgreSQL server.
    ownerServices = actors.map((actor, index) => {
      const ownerBridge = new ChainBridge(config);
      vi.spyOn(ownerBridge, 'leash').mockImplementation(async id => {
        if (id !== leashIds[index]) throw new Error('Wrong owner Leash in PostgreSQL fixture');
        return { owner: actor.address, agent: actor.address, maxPerHour: 1_000_000n, maxPerDay: 1_000_000n,
          expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), killed: false, killedAt: 0n, hourKey: 0n, dayKey: 0n,
          spentHour: 0n, spentDay: 0n, pending: 0n };
      });
      return new Service(store.db, ownerBridge, config, false);
    });
    service = ownerServices[0]!; auth = new Auth(store.db, config);
  });
  let ownerServices: Service[];
  beforeEach(async () => {
    await store.db.delete(jobs); await store.db.delete(nonces); await store.db.delete(sessions); await store.db.delete(workspaceDocuments);
  });
  afterAll(async () => { vi.restoreAllMocks(); await store?.close(); });

  it('retains exclusive controller ownership without leaking the failed pool', async () => {
    await expect(openStore({ DATA_DIR: ':memory:', DATABASE_URL: reviewedDatabase(selected!) })).rejects.toThrow('already owns');
    expect(await service.listRuns(actors[0]!.address)).toEqual({ runs: [] });
  });
  it('concurrent retries create one signed quote before the per-owner capacity is consumed', async () => {
    const results = await Promise.all(Array.from({ length: 32 }, () => service.quote(actors[0]!.address, input, 'postgres-retry')));
    expect(new Set(results.map(result => result.quote.runId)).size).toBe(1);
    expect((await store.db.select().from(jobs))).toHaveLength(1);
    const next = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => service.quote(actors[0]!.address, input, 'next-' + i)));
    expect(next.filter(result => result.status === 'fulfilled')).toHaveLength(7);
    for (const result of next) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 429, code: 'compute_capacity' });
    expect((await store.db.select().from(jobs))).toHaveLength(8);
  });
  it('serializes global admission across ten independent owners at exactly 64 outstanding quotes', async () => {
    const attempts = await Promise.allSettled(actors.flatMap((actor, index) => Array.from({ length: 12 }, (_, slot) =>
      ownerServices[index]!.quote(actor.address, { ...input, leashId: leashIds[index]! }, `owner-${index}-slot-${slot}`))));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(64);
    for (const result of attempts) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 429, code: 'compute_capacity' });
    const rows = await store.db.select().from(jobs); expect(rows).toHaveLength(64);
    for (const actor of actors) expect(rows.filter(row => row.owner === actor.address.toLowerCase()).length).toBeLessThanOrEqual(8);
  });
  it('consumes a valid wallet challenge once across concurrent PostgreSQL connections', async () => {
    const actor = actors[0]!, challenge = await auth.challenge(actor.address), signature = await actor.signMessage({ message: challenge.message });
    const results = await Promise.allSettled([auth.verify(actor.address, challenge.nonce, signature), auth.verify(actor.address, challenge.nonce, signature)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await store.db.select().from(sessions)).toHaveLength(1); expect(await store.db.select().from(nonces)).toHaveLength(0);
  });
  it('uses real unique constraints and revision CAS while retaining per-owner Workspace isolation', async () => {
    const router = createWorkspaceRoutes(store.db, async () => actors[0]!.address);
    // The parent application's Problem translator is outside this router unit.
    router.onError((error, context) => error instanceof Problem && error.status === 409
      ? context.json({ title: error.code }, 409) : context.json({ title: 'unexpected_error' }, 500));
    const put = (revision: number, budget: number) => router.request('/', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, document: { ...emptyWorkspace(), budget } }) });
    expect((await Promise.all([put(0, 1), put(0, 2)])).map(result => result.status).sort()).toEqual([200, 409]);
    expect((await Promise.all([put(1, 3), put(1, 4)])).map(result => result.status).sort()).toEqual([200, 409]);
    const outsider = createWorkspaceRoutes(store.db, async () => actors[1]!.address);
    expect(await (await outsider.request('/')).json()).toMatchObject({ revision: 0, document: { budget: 0 } });
    expect(await (await router.request('/')).json()).toMatchObject({ revision: 2 });
  });
});
