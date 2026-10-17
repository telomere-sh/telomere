import { access, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { keccak256 } from 'viem';
import { startPilot } from '../src/main.js';
import { hashJson } from '../src/common.js';
import { jobs, openStore, transactions } from '../src/store.js';
import { paymentChallenges, paymentJournal } from '../src/payments/schema.js';
import { platformTransactionJournal } from '../src/platform-runtime/schema.js';
import { deployVaultIncomeMainFixture } from './fixtures/vault-income-main.js';
import { SolanaTopUpRpcFixture, treasuryTopUpFixtureProfile } from './fixtures/treasury-topups.js';
type Fixture = Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>;

it('mounts the real owner-only top-up intake with private startup pins, Origin and streamed body guards without moving funds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-topup-main-')), source = new SolanaTopUpRpcFixture();
  let local: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>> | undefined;
  let pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  try {
    local = await deployVaultIncomeMainFixture(); await source.start();
    const configured = await treasuryTopUpFixtureProfile(local, directory, source);
    await local.test.mine({ blocks: configured.profile.base.confirmations + 1 });
    const origin = configured.config.PUBLIC_ORIGIN, path = '/api/treasury/topups/invoices';
    pilot = await startPilot(configured.config); expect(pilot.treasuryTopUps).toBeDefined();
    const post = (target: string, body: unknown, cookie = '', requestOrigin = origin) => fetch(origin + target, {
      method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const session = async (account: Fixture['accounts']['owner']) => {
      const response = await post('/api/auth/challenge', { address: account.address }); expect(response.status).toBe(200);
      const challenge = z.object({ nonce: z.string(), message: z.string() }).parse(await response.json());
      const verified = await post('/api/auth/verify', { address: account.address, nonce: challenge.nonce,
        signature: await account.signMessage({ message: challenge.message }) });
      expect(verified.status).toBe(200);
      const cookie = verified.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
      if (!cookie) throw new Error('Actual owner session unavailable'); return cookie;
    };
    const owner = await session(local.accounts.owner), outsider = await session(local.accounts.outsider);
    const balance = (address: string) => local!.local.publicClient.readContract({ address: local!.pins.tokenAddress,
      abi: local!.artifact('MockToken').abi, functionName: 'balanceOf', args: [address] });
    const before = { treasury: await balance(configured.profile.base.treasury), vault: await balance(configured.profile.base.payTo) };
    const input = { clientId: 'main-intake', amountMicros: '100000' };
    expect((await post(path, input)).status).toBe(401);
    expect((await post(path, input, outsider)).status).toBe(403);
    expect((await post(path, input, owner, 'https://unapproved.invalid')).status).toBe(403);
    expect((await post(path, { ...input, padding: 'x'.repeat(9000) }, owner)).status).toBe(422);
    const ambiguous = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: owner },
      body: '{"clientId":"first","clientId":"second","amountMicros":"100000"}' });
    expect(ambiguous.status).toBe(422);
    const slow = await new Promise<{ status: number; body: unknown; elapsed: number }>((done, reject) => {
      const started = Date.now(); let finished = false, trickle: ReturnType<typeof setInterval> | undefined;
      const timer = setTimeout(() => finish(new Error('Top-up streamed deadline was hidden by the main body middleware')), 8500);
      const outgoing = request(origin + path, { method: 'POST', agent: false,
        headers: { Origin: origin, Cookie: owner, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', finish);
        response.on('end', () => { try { finish(undefined, { status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, elapsed: Date.now() - started }); }
        catch { finish(new Error('Main top-up response was not JSON')); } });
      });
      function finish(error?: Error, value?: { status: number; body: unknown; elapsed: number }) {
        if (finished) return; finished = true; clearTimeout(timer); clearInterval(trickle); outgoing.destroy();
        if (error) reject(error); else if (value) done(value);
      }
      outgoing.on('error', finish); outgoing.flushHeaders(); outgoing.write('{');
      trickle = setInterval(() => outgoing.write(' '), 100);
    });
    expect(slow.status).toBe(422); expect(slow.body).toMatchObject({ title: 'topup_body_timeout' });
    expect(slow.elapsed).toBeLessThan(8000);
    const response = await post(path, input, owner); expect(response.status).toBe(201);
    const created = z.object({ invoice: z.object({ id: z.string(), state: z.literal('waiting_source'),
      amountMicros: z.literal('100000'), solanaPayUrl: z.string().startsWith('solana:'), policyHash: z.string() }).passthrough(), replayed: z.literal(false) })
      .parse(await response.json());
    expect(created.invoice.policyHash).toBe(pilot.treasuryTopUps!.policyHash);
    const replay = await post(path, input, owner); expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ invoice: { id: created.invoice.id }, replayed: true });
    expect((await post(path, { ...input, amountMicros: '100001' }, owner)).status).toBe(409);
    expect(await balance(configured.profile.base.treasury)).toBe(before.treasury);
    expect(await balance(configured.profile.base.payTo)).toBe(before.vault);
    expect(source.requests.length).toBeGreaterThan(0);
    expect(source.requests.every(method => ['getGenesisHash', 'getAccountInfo'].includes(method))).toBe(true);
    await pilot.close(); pilot = undefined;
    await expect(startPilot({ ...configured.config, TREASURY_TOPUP_CONFIG_SHA256: '0'.repeat(64) })).rejects.toThrow('Treasury top-up configuration');
    pilot = await startPilot(configured.config);
    expect(pilot.treasuryTopUps).toBeDefined();
  } finally {
    await pilot?.close(); await source.close(); await local?.close();
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-topup-main-')) throw new Error('Unsafe main top-up fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 120_000);

it('rejects a top-up relayer retained by each disabled financial module before creating a new budget journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-topup-main-')), source = new SolanaTopUpRpcFixture();
  let local: Fixture | undefined, store: Awaited<ReturnType<typeof openStore>> | undefined;
  try {
    local = await deployVaultIncomeMainFixture(); await source.start();
    const configured = await treasuryTopUpFixtureProfile(local, directory, source);
    expect(configured.config.VAULT_INCOME_CONFIG).toBeUndefined();
    expect(configured.config.PLATFORM_RUNTIME_CONFIG).toBeUndefined();
    const raw = await local.facilitator.signTransaction({ type: 'eip1559', chainId: 31337,
      to: local.accounts.owner.address, value: 0n, nonce: 0, gas: 21_000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const hash = keccak256(raw), id = hashJson({ retained: 'disabled-financial-module' });
    for (const module of ['x402', 'platform', 'legacy'] as const) {
      store = await openStore(configured.config);
      if (module === 'x402') {
        await store.db.insert(paymentChallenges).values({ id: 'retained-topup-sender', nonce: id, requestHash: id,
          resource: { url: 'https://old.example/resource' }, requirements: { scheme: 'exact', network: 'eip155:31337',
            asset: local.pins.tokenAddress, amount: '1', payTo: configured.profile.base.payTo, maxTimeoutSeconds: 60,
            extra: { assetTransferMethod: 'eip3009', facilitatorAddress: local.facilitator.address,
              telomere: { challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nonce: id, requestHash: id } } },
          expiresAt: new Date(Date.now() + 60_000) });
        await store.db.insert(paymentJournal).values({ key: id, challengeId: 'retained-topup-sender', attemptHash: id,
          signer: local.facilitator.address, network: 'eip155:31337', state: 'prepared', raw, hash, nonce: 0,
          response: { success: false, transaction: hash, network: 'eip155:31337', payer: local.accounts.owner.address, amount: '1' },
          createdAt: new Date() });
      } else if (module === 'platform') {
        await store.db.insert(platformTransactionJournal).values({ key: id, chainId: 31337, sender: local.facilitator.address,
          to: local.accounts.owner.address, data: '0x', raw, hash, nonce: 0 });
      } else {
        const input = { leashId: id, task: { kind: 'sha256' as const, text: 'retained source fixture' }, maxSeconds: 10 };
        await store.db.insert(jobs).values({ id, owner: local.accounts.owner.address, leashId: id, idemKey: id,
          inputHash: hashJson(input), input, quote: { runId: id, leashId: id, payer: local.accounts.owner.address,
            workloadHash: hashJson(input), maxSeconds: 10, pricePerSecond: '1', inferencePrice: '0',
            quoteExpiry: Math.floor(Date.now() / 1000) + 60 }, signature: `0x${'ab'.repeat(65)}`, ceiling: '10', status: 'prepared' });
        await store.db.insert(transactions).values({ runId: id, raw, hash, nonce: 0 });
      }
      await store.close(); store = undefined;
      await expect(startPilot(configured.config)).rejects.toThrow('Treasury top-up configuration');
      await expect(access(configured.profile.journalPath)).rejects.toThrow();
      await expect(access(configured.profile.journalPath + '.initialized')).rejects.toThrow();
      expect(await local.local.publicClient.getTransactionCount({ address: local.facilitator.address })).toBe(0);
      store = await openStore(configured.config);
      if (module === 'x402') { await store.db.delete(paymentJournal); await store.db.delete(paymentChallenges); }
      else if (module === 'platform') await store.db.delete(platformTransactionJournal);
      else { await store.db.delete(transactions); await store.db.delete(jobs); }
      await store.close(); store = undefined;
    }
  } finally {
    await store?.close(); await source.close(); await local?.close();
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-topup-main-')) throw new Error('Unsafe retained sender fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 180_000);
