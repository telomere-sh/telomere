import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEventLog, type Hex } from 'viem';
import { z } from 'zod';
import { startPilot } from '../src/main.js';
import { EIP3009_TYPES } from '../src/payments/gateway.js';
import { encodePaymentHeader, requirementsSchema, resourceSchema, type PaymentPayload } from '../src/payments/protocol.js';
import { paymentChallenges, paymentJournal, paymentResourceResults } from '../src/payments/schema.js';
import * as storeModule from '../src/store.js';
import { deployVaultIncomeMainFixture, vaultIncomeMainConfig } from './fixtures/vault-income-main.js';

const requiredSchema = z.object({ x402Version: z.literal(2), resource: resourceSchema, accepts: z.array(requirementsSchema).length(1) }).passthrough();
const realOpenStore = storeModule.openStore;
describe('actual main optional fixed-price Vault payment intake', () => {
  let deployed: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>, snapshot: Hex, directory: string;
  let configured: Awaited<ReturnType<typeof vaultIncomeMainConfig>>, pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  let ownerCookie: string, agentCookie: string, outsiderCookie: string;
  const trackedClose: ReturnType<typeof vi.fn<() => Promise<void>>>[] = [];
  beforeAll(async () => { deployed = await deployVaultIncomeMainFixture(); snapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot();
    directory = await mkdtemp(join(tmpdir(), 'telomere-vault-income-main-'));
    configured = await vaultIncomeMainConfig(deployed, directory); trackedClose.length = 0;
    vi.spyOn(storeModule, 'openStore').mockImplementation(async input => {
      const actual = await realOpenStore(input), close = vi.fn(async () => actual.close()); trackedClose.push(close); return { db: actual.db, close };
    });
    pilot = await startPilot(configured.config);
    ownerCookie = await session(deployed.accounts.owner); agentCookie = await session(deployed.vault.account); outsiderCookie = await session(deployed.accounts.outsider);
  }, 30_000);
  afterEach(async () => {
    await pilot?.close(); pilot = undefined;
    for (const close of trackedClose) if (!close.mock.calls.length) await close(); vi.restoreAllMocks();
    if (directory) { const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-income-main-')) throw new Error('Unsafe disposable main fixture path');
      await rm(target, { recursive: true, force: true }); }
  });
  afterAll(async () => deployed?.close());
  const url = () => configured.config.PUBLIC_ORIGIN;
  const admin = '/api/payments/vault-income';
  const post = (path: string, value: unknown, cookie = ownerCookie, origin = url()) => fetch(url() + path,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(value) });
  const get = (path: string, cookie = ownerCookie) => fetch(url() + path, { headers: { Cookie: cookie } });
  async function session(account: typeof deployed.accounts.owner) {
    const response = await post('/api/auth/challenge', { address: account.address }, ''); expect(response.status).toBe(200);
    const input = z.object({ nonce: z.string(), message: z.string() }).parse(await response.json());
    const verified = await post('/api/auth/verify', { address: account.address, nonce: input.nonce, signature: await account.signMessage({ message: input.message }) }, '');
    expect(verified.status).toBe(200); const cookie = verified.headers.get('set-cookie')?.match(/telomere_session=[a-f0-9]{64}/)?.[0];
    if (!cookie) throw new Error('Actual main session missing'); return cookie;
  }
  async function offer() {
    const response = await post('/x402/vault-income', {}, ''); expect(response.status).toBe(402);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return requiredSchema.parse(JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED') ?? '', 'base64').toString('utf8')));
  }
  async function signed(required: Awaited<ReturnType<typeof offer>>, payer = deployed.payer): Promise<PaymentPayload> {
    const accepted = required.accepts[0]!, current = (await deployed.local.publicClient.getBlock()).timestamp;
    const authorization = { from: payer.address, to: deployed.vault.agent.vault, value: BigInt(accepted.amount),
      validAfter: current - 1n, validBefore: BigInt(Math.floor(Date.now() / 1000)) + 120n, nonce: accepted.extra.telomere.nonce };
    const signature = await payer.signTypedData({ domain: { name: 'Local EIP3009 Fixture', version: '1', chainId: 31337,
      verifyingContract: deployed.pins.tokenAddress }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
    return { x402Version: 2, resource: required.resource, accepted, payload: { signature, authorization: { ...authorization,
      value: authorization.value.toString(), validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString() } } };
  }
  const paid = (payment: PaymentPayload, cookie = '') => fetch(url() + '/x402/vault-income', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentHeader(payment), Cookie: cookie }, body: '{}' });
  const envelope = (payment: PaymentPayload) => ({ x402Version: 2, paymentPayload: payment, paymentRequirements: payment.accepted });
  async function amount(address: string) { return deployed.local.publicClient.readContract({ address: deployed.pins.tokenAddress,
    abi: deployed.artifact('MockToken').abi, functionName: 'balanceOf', args: [address] }) as Promise<bigint>; }
  function paymentResponse(response: Response) { return z.object({ success: z.boolean(), transaction: z.string(), amount: z.string(), payer: z.string() }).passthrough()
    .parse(JSON.parse(Buffer.from(response.headers.get('PAYMENT-RESPONSE') ?? '', 'base64').toString('utf8'))); }

  it('accepts an external signed payer without a session and returns only a fixed inbound receipt after canonical settlement', async () => {
    expect((await get('/api/config', '')).status).toBe(200);
    expect(await (await get('/api/config', '')).json()).toMatchObject({ vaultIncomeAvailable: true });
    expect((await get('/health/ready', '')).status).toBe(200);
    const payment = await signed(await offer()), before = { payer: await amount(deployed.payer.address), vault: await amount(deployed.vault.agent.vault), treasury: await amount(deployed.accounts.outsider.address) };
    const response = await paid(payment, outsiderCookie); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'vault-payment-receipt', agentId: deployed.agentId,
      vault: configured.profile.pins.payTo, asset: configured.profile.pins.asset, grossAmount: '101' });
    const settled = paymentResponse(response); expect(settled).toMatchObject({ success: true, amount: '101', payer: deployed.payer.address });
    expect(await amount(deployed.payer.address)).toBe(before.payer - 101n); expect(await amount(deployed.vault.agent.vault)).toBe(before.vault + 99n);
    expect(await amount(deployed.accounts.outsider.address)).toBe(before.treasury + 2n);
    const receipt = await deployed.local.publicClient.getTransactionReceipt({ hash: settled.transaction as Hex });
    const events = receipt.logs.filter(log => log.address.toLowerCase() === deployed.vault.registryAddress.toLowerCase())
      .map(log => decodeEventLog({ abi: deployed.artifact('PlatformSelectionRegistry').abi, data: log.data, topics: log.topics }));
    expect(events.map(event => event.eventName)).toContain('Income');
    const repeat = await paid(payment); expect(repeat.status).toBe(200); expect(paymentResponse(repeat).transaction).toBe(settled.transaction);
    expect(await pilot!.service.db.select().from(paymentJournal)).toHaveLength(1); expect(await pilot!.service.db.select().from(paymentResourceResults)).toHaveLength(1);
  });

  it('preserves original owner subsidy while refusing outsider administrative settlement and foreign Origin', async () => {
    expect((await get(admin + '/supported', '')).status).toBe(401);
    expect((await get(admin + '/supported', outsiderCookie)).status).toBe(403);
    expect((await get(admin + '/supported', agentCookie)).status).toBe(200);
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.pins.tokenAddress, abi: deployed.artifact('MockToken').abi,
      functionName: 'faucet', args: [deployed.accounts.owner.address, 101n] }));
    const payment = await signed(await offer(), deployed.accounts.owner), request = envelope(payment);
    const nonce = await deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address });
    expect((await post(admin + '/settle', request, outsiderCookie)).status).toBe(403);
    expect((await post(admin + '/settle', request, ownerCookie, 'https://foreign.invalid')).status).toBe(403);
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address })).toBe(nonce);
    const verified = await post(admin + '/verify', request, agentCookie); expect(await verified.json()).toMatchObject({ isValid: true });
    const treasury = await amount(deployed.accounts.outsider.address), before = await amount(deployed.vault.agent.vault);
    const response = await post(admin + '/settle', request, agentCookie); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ success: true });
    expect(await amount(deployed.vault.agent.vault)).toBe(before + 101n); expect(await amount(deployed.accounts.outsider.address)).toBe(treasury);
  });

  it('recovers the exact durable pending transaction and ready receipt across actual server/store restart', async () => {
    await pilot?.close(); pilot = undefined;
    configured.profile.pins.confirmations = 2; configured.profile.pins.selection.confirmations = 2;
    await writeFile(configured.profilePath, JSON.stringify(configured.profile)); pilot = await startPilot(configured.config);
    const payment = await signed(await offer()), pending = await paid(payment); expect(pending.status).toBe(202);
    const first = paymentResponse(pending); expect(first.success).toBe(false);
    const [journal] = await pilot.service.db.select().from(paymentJournal); expect(journal?.state).toBe('prepared');
    await pilot.close(); pilot = undefined; await deployed.test.mine({ blocks: 2 }); pilot = await startPilot(configured.config);
    const response = await paid(payment); expect(response.status).toBe(200); expect(paymentResponse(response)).toMatchObject({ success: true, transaction: first.transaction });
    const [recovered] = await pilot.service.db.select().from(paymentJournal); expect(recovered).toMatchObject({ state: 'settled', raw: journal?.raw, hash: journal?.hash, nonce: journal?.nonce });
    expect(await pilot.service.db.select().from(paymentChallenges)).toHaveLength(1);
  });

  it('withdraws a previously successful receipt after a real reorg and only recovers its original prepared bytes', async () => {
    const payment = await signed(await offer()), before = await deployed.test.snapshot(), response = await paid(payment); expect(response.status).toBe(200);
    const initial = paymentResponse(response); await deployed.test.revert({ id: before });
    const orphaned = await paid(payment); expect(orphaned.status).toBe(202); expect(paymentResponse(orphaned).success).toBe(false);
    const recovered = await paid(payment); expect(recovered.status).toBe(200); expect(paymentResponse(recovered)).toMatchObject({ success: true, transaction: initial.transaction });
    expect(await pilot!.service.db.select().from(paymentJournal)).toHaveLength(1);
  });

  it('rejects changed fixed amounts, duplicate/query/UTF-8/header inputs before creating a resource result or payment journal', async () => {
    const payment = await signed(await offer()); payment.accepted.amount = '100';
    if ('authorization' in payment.payload) payment.payload.authorization.value = '100';
    expect((await paid(payment)).status).toBe(409);
    expect((await post('/x402/vault-income?x=1&x=2', {}, '')).status).toBe(422);
    for (const body of ['{"x":1,"x":2}', '{"work":"anything"}', Buffer.from([0x7b, 0xff, 0x7d])]) {
      const response = await fetch(url() + '/x402/vault-income', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); expect(response.status).toBe(422);
    }
    const header = await fetch(url() + '/x402/vault-income', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Large': 'a'.repeat(8192) }, body: '{}' });
    expect(header.status).toBe(422); expect(header.headers.get('cache-control')).toBe('no-store');
    expect(await pilot!.service.db.select().from(paymentResourceResults)).toHaveLength(0); expect(await pilot!.service.db.select().from(paymentJournal)).toHaveLength(0);
  });

  it('retains historical canonical receipts after an actual guardian freeze and later Death', async () => {
    const payment = await signed(await offer()), settled = await paid(payment); expect(settled.status).toBe(200);
    const original = paymentResponse(settled), registry = deployed.vault.registryAddress, abi = deployed.artifact('PlatformSelectionRegistry').abi;
    await deployed.confirmed(deployed.vault.guardianWallet.writeContract({ address: registry, abi, functionName: 'setFrozen',
      args: [deployed.agentId, true, 'disposable acceptance', '0x' + '1'.repeat(64)] }));
    await deployed.test.mine({ blocks: 2 });
    const frozen = await paid(payment); expect(frozen.status).toBe(200); expect(paymentResponse(frozen).transaction).toBe(original.transaction);
    await deployed.confirmed(deployed.owner.writeContract({ address: deployed.vault.agent.vault, abi: deployed.artifact('PlatformAgentVault').abi,
      functionName: 'ownerWithdraw', args: [await amount(deployed.vault.agent.vault)] }));
    await deployed.test.increaseTime({ seconds: 3 * 86_400 + 1 }); await deployed.test.mine({ blocks: 1 });
    await deployed.confirmed(deployed.owner.writeContract({ address: registry, abi, functionName: 'declareDormant', args: [deployed.agentId] }));
    await deployed.test.increaseTime({ seconds: 30 * 86_400 + 1 }); await deployed.test.mine({ blocks: 1 });
    await deployed.confirmed(deployed.owner.writeContract({ address: registry, abi, functionName: 'declareDeath', args: [deployed.agentId] }));
    await deployed.test.mine({ blocks: 2 });
    const dead = await paid(payment); expect(dead.status).toBe(200); expect(paymentResponse(dead)).toMatchObject({ success: true, transaction: original.transaction });
    expect((await get(admin + '/supported', agentCookie)).status).toBe(200);
  });

  it('shares the trusted socket bucket with API traffic and ignores spoofed forwarded identities', async () => {
    for (let attempt = 0; attempt < 240; attempt++) {
      const response = await fetch(url() + '/x402/vault-income', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.' + (attempt % 250), 'X-Real-IP': '192.0.2.' + (attempt % 250) }, body: '{' });
      if (response.status === 429) break;
      expect(response.status).toBe(422);
    }
    expect((await get('/api/config', '')).status).toBe(429);
    expect(await pilot!.service.db.select().from(paymentChallenges)).toHaveLength(0);
  });

  async function streamed(path: string, unfinished: boolean, cookie = '') {
    const started = Date.now();
    return new Promise<{ status: number; elapsed: number; body: unknown }>((done, reject) => {
      let finished = false, trickle: ReturnType<typeof setInterval> | undefined;
      const timeout = setTimeout(() => finish(new Error('Actual payment deadline was not enforced')), 8500);
      const outgoing = request(url() + path, { method: 'POST', agent: false, headers: { Origin: url(), Cookie: cookie,
        'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('error', finish);
        response.on('end', () => { try { finish(undefined, { status: response.statusCode ?? 0, elapsed: Date.now() - started,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); } catch { finish(new Error('Main payment response was not JSON')); } });
      });
      function finish(error?: Error, value?: { status: number; elapsed: number; body: unknown }) { if (finished) return; finished = true;
        clearTimeout(timeout); clearInterval(trickle); outgoing.destroy(); if (error) reject(error); else if (value) done(value); }
      outgoing.on('error', finish); outgoing.flushHeaders(); outgoing.write('{');
      if (unfinished) trickle = setInterval(() => outgoing.write(' '), 100); else { outgoing.write(' '.repeat(8192)); outgoing.end(); }
    });
  }
  it('retains a five-second streamed deadline and 8 KiB bound on public and authenticated main mounts', async () => {
    const chainCheck = vi.spyOn(pilot!.vaultIncome!, 'check'), authorityCheck = vi.spyOn(pilot!.vaultIncome!, 'authorize');
    for (const [path, cookie] of [['/x402/vault-income', ''], [admin + '/settle', ownerCookie]]) {
      const over = await streamed(path!, false, cookie); expect(over.status).toBe(422); expect(over.body).toMatchObject({ title: 'vault_income_body_limit' });
      const slow = await streamed(path!, true, cookie); expect(slow.status).toBe(422); expect(slow.body).toMatchObject({ title: 'vault_income_body_timeout' });
      expect(slow.elapsed).toBeGreaterThanOrEqual(4500); expect(slow.elapsed).toBeLessThan(8500);
    }
    expect(chainCheck).not.toHaveBeenCalled(); expect(authorityCheck).not.toHaveBeenCalled();
    expect((await get('/health/ready', '')).status).toBe(200);
  }, 20_000);

  it('closes its real store and leaves the port free on bad startup configuration, and defaults to no payment routes', async () => {
    await pilot?.close(); pilot = undefined;
    for (const invalid of ['{"pins":{},"pins":{}}', JSON.stringify({ ...configured.profile, pins: { ...configured.profile.pins, tokenCodeHash: '0x' + 'f'.repeat(64) } })]) {
      await writeFile(configured.profilePath, invalid); const before = trackedClose.length;
      await expect(startPilot(configured.config)).rejects.toThrow('Vault income configuration or reviewed deployment is unavailable');
      expect(trackedClose).toHaveLength(before + 1); expect(trackedClose.at(-1)).toHaveBeenCalledTimes(1);
      const probe = createServer(); await new Promise<void>((done, reject) => probe.once('error', reject).listen(configured.config.PORT, '127.0.0.1', done));
      await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
    }
    const { VAULT_INCOME_CONFIG: _disabled, ...disabled } = configured.config; pilot = await startPilot(disabled);
    expect(pilot.vaultIncome).toBeUndefined(); expect(await (await get('/api/config', '')).json()).toMatchObject({ vaultIncomeAvailable: false });
    expect((await post('/x402/vault-income', {}, '')).status).toBe(404);
    expect((await get(admin + '/supported')).status).toBe(404);
  });
});
