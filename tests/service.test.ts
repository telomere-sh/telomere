import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { createWalletClient, http } from 'viem';
import { startLocalChain, deployLocalContracts } from '../scripts/local-chain.js';
import { loadConfig } from '../src/config.js';
import { openStore, jobs } from '../src/store.js';
import { ChainBridge } from '../src/bridge.js';
import { Service } from '../src/service.js';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { Worker } from '../src/worker.js';
import { createDemoCpuExecutor } from '../src/runtime/index.js';
import { randomId, bytes32Schema, quoteSchema } from '../src/common.js';

describe('wallet → escrow → CPU → signed receipt → settlement', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let deployed: Awaited<ReturnType<typeof deployLocalContracts>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let bridge: ChainBridge;
  let service: Service;
  let auth: Auth;
  let app: ReturnType<typeof createApp>;
  let worker: Worker;
  let session: string;
  let leashId: ReturnType<typeof randomId>;
  const logger = pino({ level: 'silent' });
  beforeAll(async () => {
    local = await startLocalChain(); deployed = await deployLocalContracts(local);
    const config = loadConfig({ MODE: 'demo', RPC_URL: local.rpcUrl, CHAIN_ID: '31337', SIGNER_PRIVATE_KEY: deployed.keys.signer,
      DEMO_PRIVATE_KEY: deployed.keys.owner, ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress, DATA_DIR: ':memory:' });
    store = await openStore(config); bridge = new ChainBridge(config); await bridge.check();
    service = new Service(store.db, bridge, config, false); auth = new Auth(store.db, config);
    app = createApp(service, auth, logger); worker = new Worker(store.db, bridge, createDemoCpuExecutor(), undefined, logger);
    session = await auth.session(deployed.accounts.owner.address);
    const funded = await api('/api/demo/fund', {}); expect(funded.status).toBe(200);
    const created = await service.createLeash(deployed.accounts.owner.address, deployed.accounts.owner.address, 5_000_000n, 10_000_000n, BigInt(Math.floor(Date.now() / 1000) + 86400));
    leashId = bytes32Schema.parse(created.leashId);
    await send(created.transaction);
  }, 30000);
  afterAll(async () => { await worker?.stop(); await store?.close(); await local?.close(); });
  function api(path: string, body?: unknown, token = session, origin = 'http://127.0.0.1:3280') {
    return app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: 'telomere_session=' + token,
      origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'api-test-key-1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function send(tx: { to: `0x${string}`; data: `0x${string}`; value: string }) {
    if (!bridge.demo) throw new Error('Demo missing');
    const hash = await bridge.demo.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
    await bridge.public.waitForTransactionReceipt({ hash }); return hash;
  }
  it('sign-in challenges are bound to address, domain and chain, consumed once', async () => {
    const challenge = await auth.challenge(deployed.accounts.owner.address);
    expect(challenge.message).toContain('Chain ID: 31337');
    expect(challenge.message).toContain('127.0.0.1:3280');
    const signature = await deployed.accounts.owner.signMessage({ message: challenge.message });
    expect(await auth.owner(await auth.verify(deployed.accounts.owner.address, challenge.nonce, signature))).toBe(deployed.accounts.owner.address.toLowerCase());
    await expect(auth.verify(deployed.accounts.owner.address, challenge.nonce, signature)).rejects.toThrow();
  });
  it('rejects cross-origin mutations and unauthenticated reads', async () => {
    expect((await api('/api/demo/fund', {}, session, 'https://attacker.invalid')).status).toBe(403);
    expect((await api('/api/runs', undefined, 'invalid')).status).toBe(401);
  });
  it('reserves once, produces SHA-256 output and returns unused funds', async () => {
    const owner = deployed.accounts.owner.address;
    const input = { leashId, task: { kind: 'sha256' as const, text: 'hello' }, maxSeconds: 10 };
    const first = await service.quote(owner, input, 'same-request-123');
    const repeat = await service.quote(owner, input, 'same-request-123');
    expect(first.quote.runId).toBe(repeat.quote.runId);
    await expect(service.quote(owner, { ...input, maxSeconds: 11 }, 'same-request-123')).rejects.toThrow('different inputs');
    const before = BigInt((await bridge.balance(owner)).available);
    const txHash = await send(first.transaction);
    const admitted = await service.admit(owner, first.quote.runId, txHash);
    expect(admitted.status).toBe('queued');
    expect(BigInt((await bridge.balance(owner)).available)).toBe(before - BigInt(first.ceiling));
    expect((await service.admit(owner, first.quote.runId, txHash)).status).toBe('queued');
    await worker.drainOnce();
    const job = await service.requireJob(owner, first.quote.runId);
    expect(job.status).toBe('completed');
    expect(job.output).toContain('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(BigInt(job.charged ?? '-1') + BigInt(job.refund ?? '-1')).toBe(BigInt(first.ceiling));
    expect(BigInt((await bridge.balance(owner)).available)).toBe(before - BigInt(job.charged ?? '0'));
    expect((await service.verifyReceipt(job.receipt)).valid).toBe(true);
    expect((await service.verifyReceipt(job.receipt)).anchored).toBe(true);
    const altered = JSON.parse(JSON.stringify(job.receipt)); altered.body.status = 'forged';
    expect((await service.verifyReceipt(altered)).valid).toBe(false);
    const journal = (await store.db.select().from(jobs).where(eq(jobs.id, first.quote.runId)))[0];
    expect(journal?.settlementTxHash).toMatch(/^0x[a-f0-9]{64}$/);
  });
  it('wallet/tenant cannot admit or read another owner run', async () => {
    const quote = await service.quote(deployed.accounts.owner.address, { leashId, task: { kind: 'sort', numbers: [3, 1] }, maxSeconds: 5 }, 'tenant-test-123');
    await expect(service.requireJob(deployed.accounts.outsider.address, quote.quote.runId)).rejects.toThrow('not found');
    await expect(service.admit(deployed.accounts.outsider.address, quote.quote.runId, randomId())).rejects.toThrow('not found');
  });
  it('a stop before dispatch executes zero work and releases the reservation', async () => {
    const owner = deployed.accounts.owner.address;
    const quote = await service.quote(owner, { leashId, task: { kind: 'primes', limit: 2000000 }, maxSeconds: 30 }, 'stopped-test-123');
    const txHash = await send(quote.transaction); await service.admit(owner, quote.quote.runId, txHash);
    await send(bridge.stopTransaction(quote.quote.runId));
    await worker.drainOnce();
    const run = await service.requireJob(owner, quote.quote.runId);
    expect(run.status).toBe('cancelled'); expect(run.charged).toBe('0'); expect(run.refund).toBe(quote.ceiling);
  });
  it('contract confirmation is required before queue admission', async () => {
    const owner = deployed.accounts.owner.address;
    const quote = await service.quote(owner, { leashId, task: { kind: 'sort', numbers: [] }, maxSeconds: 3 }, 'bad-tx-test-123');
    const wallet = createWalletClient({ account: deployed.accounts.owner, chain: bridge.chain, transport: http(local.rpcUrl) });
    const unrelated = await wallet.sendTransaction({ to: owner, value: 0n });
    await bridge.public.waitForTransactionReceipt({ hash: unrelated });
    await expect(service.admit(owner, quote.quote.runId, unrelated)).rejects.toMatchObject({ status: 409, code: 'wrong_transaction' });
    expect((await service.requireJob(owner, quote.quote.runId)).status).toBe('prepared');
    expect(quoteSchema.parse(quote.quote).runId).toBe(quote.quote.runId);
  });
});
