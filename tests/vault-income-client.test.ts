import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, http, type Hex } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { startPilot } from '../src/main.js';
import { encodePaymentHeader } from '../src/payments/protocol.js';
import { VaultIncomeClient } from '../src/sdk/vault-income/client.js';
import type { VaultIncomeFetch } from '../src/sdk/vault-income/http.js';
import { RpcVaultIncomeReader } from '../src/sdk/vault-income/reader.js';
import { vaultIncomeJournalStateSchema, type VaultIncomeJournal, type VaultIncomeJournalState,
  type VaultIncomePublicProfile, type VaultIncomeReader } from '../src/sdk/vault-income/types.js';
import { deployVaultIncomeMainFixture, vaultIncomeMainConfig } from './fixtures/vault-income-main.js';

/** Acceptance-only caller adapter: separate durable file, exclusive owner, flush-before-return.
 * This fixture establishes process reopen, not power-loss durability or production ACL policy. */
class DiskCallerJournal implements VaultIncomeJournal {
  private tail: Promise<unknown> = Promise.resolve();
  failSave = false;
  private constructor(readonly path: string, private readonly lock: Awaited<ReturnType<typeof open>>) {}
  static async open(path: string) { return new DiskCallerJournal(path, await open(path + '.lock', 'wx', 0o600)); }
  async exclusive<T>(_scope: Hex, callback: (tx: { load(): Promise<unknown>; save(state: VaultIncomeJournalState): Promise<void> }) => Promise<T>): Promise<T> {
    return this.transaction(callback);
  }
  async transaction<T>(callback: (tx: { load(): Promise<unknown>; save(state: VaultIncomeJournalState): Promise<void> }) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => callback({ load: async () => {
      try { return JSON.parse(await readFile(this.path, 'utf8')) as unknown; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }, save: async state => {
      if (this.failSave) { this.failSave = false; throw new Error('Disposable caller persistence failure'); }
      const file = await open(this.path + '.tmp', 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(this.path + '.tmp', this.path);
    } })); this.tail = run.catch(() => undefined); return run;
  }
  async state() { return vaultIncomeJournalStateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
  async close() { await this.tail; await this.lock.close(); await unlink(this.path + '.lock'); }
}

describe('checked Node Vault intake client against actual main and durable caller storage', () => {
  let deployed: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>, snapshot: Hex, directory: string;
  let configured: Awaited<ReturnType<typeof vaultIncomeMainConfig>>, pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  let journal: DiskCallerJournal, profile: VaultIncomePublicProfile;
  beforeAll(async () => { deployed = await deployVaultIncomeMainFixture(); snapshot = await deployed.test.snapshot(); }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: snapshot }); snapshot = await deployed.test.snapshot();
    directory = await mkdtemp(join(tmpdir(), 'telomere-vault-income-client-'));
    configured = await vaultIncomeMainConfig(deployed, directory);
    const { assetImplementation, ...pins } = configured.profile.pins;
    profile = { resourceUrl: configured.profile.resourceUrl, grossAmount: configured.profile.grossAmount,
      pins: { ...pins, ...(assetImplementation ? { assetImplementation } : {}) } };
    journal = await DiskCallerJournal.open(join(directory, 'caller.json'));
    pilot = await startPilot(configured.config);
  }, 30_000);
  afterEach(async () => {
    await pilot?.close(); pilot = undefined; await journal?.close();
    if (directory) { const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-income-client-')) throw new Error('Unsafe client fixture path');
      await rm(target, { recursive: true, force: true }); }
  });
  afterAll(async () => deployed?.close());
  function client(fetcher?: VaultIncomeFetch, reader: VaultIncomeReader = new RpcVaultIncomeReader({ rpcUrl: deployed.local.rpcUrl, profile })) {
    return new VaultIncomeClient({ profile, reader, journal, ...(fetcher ? { fetch: fetcher } : {}) });
  }
  async function reopen() {
    const path = journal.path; await journal.close(); journal = await DiskCallerJournal.open(path);
  }
  async function authorized(instance: VaultIncomeClient, id = 'payment-1') {
    const prepared = await instance.prepare(id, { payer: deployed.payer.address });
    await instance.authorize(id, await deployed.payer.signTypedData(prepared.typedData)); return prepared;
  }
  async function amount() { return deployed.local.publicClient.readContract({ address: deployed.pins.tokenAddress,
    abi: deployed.artifact('MockToken').abi, functionName: 'balanceOf', args: [deployed.payer.address] }) as Promise<bigint>; }

  it('persists immutable unsigned and signed plans before exposing them, reopens and independently proves the paid receipt', async () => {
    const requests: RequestInit[] = [], fetcher: VaultIncomeFetch = async (url, init) => { requests.push(init); return fetch(url, init); };
    const initial = client(fetcher), plan = await initial.prepare('payment-1', { payer: deployed.payer.address });
    expect((await journal.state()).attempts[0]!.plan).toEqual(plan.plan); expect(Object.isFrozen(plan.typedData.message)).toBe(true);
    expect(await initial.check('payment-1')).toEqual({ operationId: 'payment-1', status: 'planned' });
    await reopen(); const resumed = client(fetcher), same = await resumed.prepare('payment-1', { payer: deployed.payer.address });
    expect(same).toEqual(plan); expect(requests).toHaveLength(1);
    await resumed.authorize('payment-1', await deployed.payer.signTypedData(same.typedData));
    expect(await resumed.check('payment-1')).toEqual({ operationId: 'payment-1', status: 'authorized' });
    expect((await journal.state()).attempts[0]!.signedHeader).toBeTruthy(); await reopen();
    const before = await amount(), result = await client(fetcher).submit('payment-1');
    expect(result.status).toBe('settled'); expect(result.evidence).toMatchObject({ classification: 'income', grossAmount: '101', incomeFee: '2', netAmount: '99' });
    expect(await amount()).toBe(before - 101n);
    expect(await client(fetcher).retry('payment-1')).toEqual(result); expect(requests).toHaveLength(2);
    for (const request of requests) { expect(request.credentials).toBe('omit'); expect(request.body).toBe('{}');
      expect(request.redirect).toBe('error'); expect(new Headers(request.headers).has('Cookie')).toBe(false); }
  }, 30_000);

  it('recovers a lost paid HTTP response across both caller and main restart with exactly the original signature', async () => {
    let dropped = false; const paidHeaders: string[] = [];
    const fetcher: VaultIncomeFetch = async (url, init) => {
      const signature = new Headers(init.headers).get('PAYMENT-SIGNATURE'); if (signature) paidHeaders.push(signature);
      const response = await fetch(url, init);
      if (signature && !dropped) { dropped = true; await response.arrayBuffer(); throw new Error('Disposable lost HTTP response'); } return response;
    };
    const initial = client(fetcher); await authorized(initial); const before = await amount();
    await expect(initial.submit('payment-1')).rejects.toMatchObject({ code: 'vault_income_http_invalid' });
    expect((await journal.state()).attempts[0]).toMatchObject({ submitted: true }); expect(await amount()).toBe(before - 101n);
    await expect(initial.prepare('replacement-after-ambiguous', { payer: deployed.payer.address })).rejects.toMatchObject({ code: 'vault_income_payer_reconciliation_required' });
    await reopen(); await pilot!.close(); pilot = await startPilot(configured.config);
    const recovered = await client(fetcher).retry('payment-1'); expect(recovered.status).toBe('settled');
    expect(paidHeaders).toHaveLength(2); expect(paidHeaders[0]).toBe(paidHeaders[1]); expect(await amount()).toBe(before - 101n);
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address })).toBe(1);
  }, 35_000);

  it('journals a 202 candidate before RPC verification and resumes the same candidate after confirmations', async () => {
    await pilot!.close(); pilot = undefined;
    configured.profile.pins.confirmations = 2; configured.profile.pins.selection.confirmations = 2;
    await writeFile(configured.profilePath, JSON.stringify(configured.profile)); profile.pins.confirmations = 2; profile.pins.selection.confirmations = 2;
    pilot = await startPilot(configured.config); const statuses: number[] = [];
    const fetcher: VaultIncomeFetch = async (url, init) => { const response = await fetch(url, init); statuses.push(response.status); return response; };
    const initial = client(fetcher); await authorized(initial); const result = await initial.submit('payment-1');
    expect(statuses).toEqual([402, 202]); expect(result.status).toBe('pending');
    expect((await journal.state()).attempts[0]!.candidateHash).toBe(result.transactionHash);
    await reopen(); await deployed.test.mine({ blocks: 2 }); const resumed = await client(fetcher).check('payment-1');
    expect(resumed.status).toBe('settled'); expect(resumed.transactionHash).toBe(result.transactionHash); expect(statuses).toHaveLength(2);
  }, 35_000);

  it('withdraws previous success after a real reorg and recovers only the original transaction hash', async () => {
    const instance = client(); await authorized(instance); const branch = await deployed.test.snapshot();
    const result = await instance.submit('payment-1'); expect(result.status).toBe('settled');
    await deployed.test.revert({ id: branch }); await reopen(); const resumed = client();
    expect(await resumed.check('payment-1')).toMatchObject({ status: 'pending', transactionHash: result.transactionHash });
    expect((await journal.state()).attempts[0]!.observation!.status).toBe('pending');
    const first = await resumed.retry('payment-1'); expect(first.status).toBe('pending');
    const second = await resumed.retry('payment-1'); expect(second.status).toBe('settled'); expect(second.transactionHash).toBe(result.transactionHash);
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address })).toBe(1);
  }, 35_000);

  it('recovers two previously settled payments after one reorg without cross-attempt retry deadlock', async () => {
    const instance = client(); await authorized(instance, 'first-payment'); const branch = await deployed.test.snapshot();
    const first = await instance.submit('first-payment'); expect(first.status).toBe('settled');
    await authorized(instance, 'second-payment'); const second = await instance.submit('second-payment'); expect(second.status).toBe('settled');
    await deployed.test.revert({ id: branch }); await reopen(); const resumed = client();
    expect((await resumed.check('first-payment')).status).toBe('pending'); expect((await resumed.check('second-payment')).status).toBe('pending');
    for (const [id, original] of [['first-payment', first], ['second-payment', second]] as const) {
      expect((await resumed.retry(id)).status).toBe('pending');
      const recovered = await resumed.retry(id); expect(recovered.status).toBe('settled'); expect(recovered.transactionHash).toBe(original.transactionHash);
    }
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address })).toBe(2);
  }, 45_000);

  it('rejects wrong payer and altered signatures without sending a paid request, and preserves the original attempt', async () => {
    let calls = 0; const fetcher: VaultIncomeFetch = async (url, init) => { calls++; return fetch(url, init); };
    const instance = client(fetcher), prepared = await instance.prepare('payment-1', { payer: deployed.payer.address });
    await expect(instance.authorize('payment-1', await deployed.accounts.outsider.signTypedData(prepared.typedData))).rejects.toMatchObject({ code: 'vault_income_signature_mismatch' });
    const altered = { ...prepared.typedData, message: { ...prepared.typedData.message, value: 102n } };
    await expect(instance.authorize('payment-1', await deployed.payer.signTypedData(altered))).rejects.toMatchObject({ code: 'vault_income_signature_mismatch' });
    await expect(instance.prepare('payment-1', { payer: deployed.accounts.outsider.address })).rejects.toMatchObject({ code: 'vault_income_attempt_conflict' });
    expect(calls).toBe(1); expect((await journal.state()).attempts[0]!.signature).toBeUndefined();
  });

  it('rejects inconsistent custom-reader fee, net and reference fields while retaining a recoverable canonical candidate', async () => {
    const independent = new RpcVaultIncomeReader({ rpcUrl: deployed.local.rpcUrl, profile });
    let altered: 'incomeFee' | 'netAmount' | 'paymentRef' | undefined = 'incomeFee';
    const reader: VaultIncomeReader = { profile: independent.profile, check: () => independent.check(), inspect: async input => {
      const evidence = await independent.inspect(input);
      if (evidence.status !== 'settled' || !altered) return evidence;
      return { ...evidence, [altered]: altered === 'paymentRef' ? `0x${'f'.repeat(64)}` : '0' };
    } };
    const instance = client(undefined, reader); await authorized(instance); const before = await amount();
    await expect(instance.submit('payment-1')).rejects.toMatchObject({ code: 'vault_income_evidence_invalid' });
    for (const field of ['netAmount', 'paymentRef'] as const) {
      altered = field; await expect(instance.check('payment-1')).rejects.toMatchObject({ code: 'vault_income_evidence_invalid' });
      expect((await journal.state()).attempts[0]!.observation!.status).toBe('pending');
    }
    altered = undefined; expect((await instance.check('payment-1')).status).toBe('settled'); expect(await amount()).toBe(before - 101n);
  }, 30_000);

  it('blocks a replacement after a real outer revert until canonical authorization expiry and fresh unused-marker verification', async () => {
    let hash: Hex | undefined, calls = 0, clock = Date.now();
    const fetcher: VaultIncomeFetch = async (url, init) => {
      calls++; if (!new Headers(init.headers).has('PAYMENT-SIGNATURE')) return fetch(url, init);
      return new Response(JSON.stringify({ error: 'transaction_reverted' }), { status: 422, headers: {
        'Content-Type': 'application/json', 'PAYMENT-RESPONSE': encodePaymentHeader({ success: false, transaction: hash,
          network: 'eip155:31337', payer: deployed.payer.address, amount: '101', errorReason: 'transaction_reverted' }) } });
    };
    const instance = new VaultIncomeClient({ profile, journal, reader: new RpcVaultIncomeReader({ rpcUrl: deployed.local.rpcUrl, profile }), fetch: fetcher, now: () => clock });
    const prepared = await authorized(instance), signed = (await journal.state()).attempts[0]!.signature!, auth = prepared.plan.authorization;
    const wallet = createWalletClient({ account: deployed.facilitator, chain: localChain, transport: http(deployed.local.rpcUrl) });
    hash = await wallet.writeContract({ address: profile.pins.payTo, abi: deployed.artifact('PlatformAgentVault').abi,
      functionName: 'receiveFundsWithAuthorization', args: [auth.from, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore),
        auth.nonce, Number.parseInt(signed.slice(130, 132), 16), `0x${signed.slice(2, 66)}`, `0x${signed.slice(66, 130)}`], gas: 30_000n });
    expect((await deployed.local.publicClient.waitForTransactionReceipt({ hash })).status).toBe('reverted');
    expect((await instance.submit('payment-1')).status).toBe('reverted'); const priorCalls = calls;
    await expect(instance.prepare('replacement', { payer: deployed.payer.address })).rejects.toMatchObject({ code: 'vault_income_payer_reconciliation_required' });
    expect(calls).toBe(priorCalls);
    await deployed.test.setNextBlockTimestamp({ timestamp: BigInt(auth.validBefore) }); await deployed.test.mine({ blocks: 2 });
    clock = Number((await deployed.local.publicClient.getBlock()).timestamp) * 1000;
    const next = await instance.prepare('replacement', { payer: deployed.payer.address }); expect(next.plan.authorization.nonce).not.toBe(auth.nonce);
    expect((await journal.state()).attempts[0]!.candidateHash).toBe(hash); expect(calls).toBe(priorCalls + 1);
  }, 35_000);

  it('persists the first substituted candidate, refuses its different calldata and never adopts a replacement HTTP hash', async () => {
    const other = client(); await authorized(other, 'other-payment'); const otherResult = await other.submit('other-payment');
    let forged = true;
    const fetcher: VaultIncomeFetch = async (url, init) => {
      const response = await fetch(url, init); if (!new Headers(init.headers).has('PAYMENT-SIGNATURE') || !forged) return response;
      forged = false; const headers = new Headers(response.headers), value = JSON.parse(Buffer.from(headers.get('PAYMENT-RESPONSE')!, 'base64').toString('utf8'));
      value.transaction = otherResult.transactionHash; headers.set('PAYMENT-RESPONSE', encodePaymentHeader(value));
      return new Response(await response.arrayBuffer(), { status: response.status, headers });
    };
    const instance = client(fetcher); await authorized(instance);
    await expect(instance.submit('payment-1')).rejects.toThrow();
    expect((await journal.state()).attempts.find(item => item.plan.operationId === 'payment-1')!.candidateHash).toBe(otherResult.transactionHash);
    // Reader fails before any replacement response can be adopted, even on an explicit exact retry.
    await expect(instance.retry('payment-1')).rejects.toThrow();
    expect((await journal.state()).attempts.find(item => item.plan.operationId === 'payment-1')!.candidateHash).toBe(otherResult.transactionHash);
  }, 35_000);

  it('fails closed on durable callback failure before exposing a plan or sending a signature and bounds concurrency', async () => {
    let calls = 0; const fetcher: VaultIncomeFetch = async (url, init) => { calls++; return fetch(url, init); };
    const instance = client(fetcher); journal.failSave = true;
    await expect(instance.prepare('failed-plan', { payer: deployed.payer.address })).rejects.toThrow('Disposable caller persistence failure');
    await expect(journal.state()).rejects.toThrow(); expect(calls).toBe(1);
    await authorized(instance); journal.failSave = true; const before = await amount();
    await expect(instance.submit('payment-1')).rejects.toThrow('Disposable caller persistence failure'); expect(await amount()).toBe(before); expect(calls).toBe(2);
    const first = instance.prepare('concurrent-plan', { payer: deployed.payer.address });
    await expect(instance.prepare('second-plan', { payer: deployed.payer.address })).rejects.toMatchObject({ code: 'vault_income_client_busy' }); await first;
  }, 30_000);

  it('enforces retained journal capacity and rejects corrupt signed evidence before a network request', async () => {
    let calls = 0; const fetcher: VaultIncomeFetch = async (url, init) => { calls++; return fetch(url, init); };
    const instance = client(fetcher); await authorized(instance); const state = await journal.state(), original = state.attempts[0]!;
    original.signedHeader = 'corrupt'; await writeFile(journal.path, JSON.stringify(state));
    await expect(instance.retry('payment-1')).rejects.toMatchObject({ code: 'vault_income_journal_invalid' }); expect(calls).toBe(1);
    state.attempts = Array.from({ length: 128 }, (_, index) => ({ plan: { ...original.plan, operationId: `retained-${index}`,
      accepted: { ...original.plan.accepted, extra: { ...original.plan.accepted.extra, telomere: {
        ...original.plan.accepted.extra.telomere, challengeId: randomUUID(), nonce: `0x${index.toString(16).padStart(64, '0')}` as Hex } } },
      authorization: { ...original.plan.authorization, nonce: `0x${index.toString(16).padStart(64, '0')}` as Hex } }, submitted: false }));
    await writeFile(journal.path, JSON.stringify(state));
    await expect(instance.prepare('beyond-capacity', { payer: deployed.payer.address })).rejects.toMatchObject({ code: 'vault_income_journal_capacity' }); expect(calls).toBe(1);
  });
  it.each(['challengeId', 'nonce'] as const)('rejects a repeated untrusted offer %s without poisoning retained evidence', async field => {
    let previous: Response | undefined, repeat = false;
    const fetcher: VaultIncomeFetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!repeat) { previous = response.clone(); return response; }
      const current = JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8'));
      const old = JSON.parse(Buffer.from(previous!.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8'));
      current.accepts[0].extra.telomere[field] = old.accepts[0].extra.telomere[field];
      const headers = new Headers(response.headers); headers.set('PAYMENT-REQUIRED', encodePaymentHeader(current));
      return new Response(await response.arrayBuffer(), { status: response.status, headers });
    };
    const instance = client(fetcher); await instance.prepare('retained', { payer: deployed.payer.address });
    const original = await readFile(journal.path, 'utf8'); repeat = true;
    await expect(instance.prepare('reused', { payer: deployed.payer.address })).rejects.toMatchObject({ code: 'vault_income_offer_reused' });
    expect(await readFile(journal.path, 'utf8')).toBe(original); expect(await instance.check('retained')).toEqual({ operationId: 'retained', status: 'planned' });
    await previous!.body?.cancel();
  });
});
