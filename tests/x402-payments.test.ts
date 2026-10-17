import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import solc from 'solc';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestClient, createWalletClient, http, keccak256, maxUint256, padHex, parseEther, parseTransaction, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../scripts/local-chain.js';
import { projectRoot } from '../scripts/compile-contracts.js';
import { localChain } from '../src/chain/chains.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT } from '../src/payments/circle-usdc.js';
import { openStore } from '../src/store.js';
import { EIP3009_TYPES, PERMIT2_TYPES, EvmPaymentChain, X402PaymentService, authorizationKey, canonical,
  createFacilitatorRoutes, createPaidResourceRoutes, decodePaymentHeader, encodePaymentHeader, paymentChallenges,
  paymentJournal, paymentResourceResults, requestBinding, type PaymentChain, type PaymentPayload, type PaymentPins,
  type PaymentRequired, type PreparedPayment, type Scheme } from '../src/payments/index.js';

type Artifact = { abi: Abi; bytecode: Hex };
type Account = ReturnType<typeof privateKeyToAccount>;
const fixtureRoot = resolve(projectRoot, 'tests/fixtures/x402-reference');
function compileFixtures(): Record<string, Artifact> {
  const provenance = JSON.parse(readFileSync(resolve(fixtureRoot, 'provenance.json'), 'utf8')) as {
    files: { path: string; sha256: string }[]; compiled: { path: string; sha256: string } };
  for (const file of [...provenance.files, provenance.compiled]) {
    expect(createHash('sha256').update(readFileSync(resolve(fixtureRoot, file.path))).digest('hex')).toBe(file.sha256);
  }
  const compiled = JSON.parse(readFileSync(resolve(fixtureRoot, provenance.compiled.path), 'utf8')) as Artifact;
  const paths = ['x402/contracts/evm/src/x402UptoPermit2Proxy.sol', 'LocalEip3009Token.sol'];
  const input = { language: 'Solidity', sources: Object.fromEntries(paths.map(path => [path, { content: readFileSync(resolve(fixtureRoot, path), 'utf8') }])),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (path: string) => {
    if (path.includes('..')) return { error: 'Unsupported import' };
    if (path.startsWith('@openzeppelin/contracts/')) return { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') };
    if (path.startsWith('x402/contracts/evm/src/')) return { contents: readFileSync(resolve(fixtureRoot, path), 'utf8') };
    return { error: 'Unsupported import' };
  } })) as { errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  return { Permit2: compiled, ...Object.fromEntries(paths.flatMap(path => Object.entries(output.contracts[path] ?? {}).map(([name, contract]) =>
    [name, { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex }]))) };
}

describe('x402 v2 exact EIP3009 and actual upstream Permit2 upto, durable facilitator', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>, test: ReturnType<typeof createTestClient>;
  let artifacts: Record<string, Artifact>, owner: Account, payer: Account, receiver: Account, facilitator: Account, outsider: Account;
  let asset: Address, permit2: Address, proxy: Address, pins: PaymentPins, chain: EvmPaymentChain;
  let snapshot: Hex, clock: number, service: X402PaymentService, store: Awaited<ReturnType<typeof openStore>>;
  let directory: string | undefined;
  const resource = { url: 'https://resource.example/compute' }, binding = requestBinding('POST', resource.url, Buffer.from('cpu=10'));
  const artifact = (name: string): Artifact => { const found = artifacts[name]; if (!found) throw new Error(`Missing ${name}`); return found; };
  const wallet = (account: Account) => createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl, { retryCount: 0 }) });
  async function deploy(name: string, args: readonly unknown[] = []) {
    const source = artifact(name), hash = await wallet(owner).deployContract({ abi: source.abi, bytecode: source.bytecode, args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('Fixture deployment failed'); return receipt.contractAddress;
  }
  async function write(account: Account, name: string, address: Address, functionName: string, args: readonly unknown[] = []) {
    const hash = await wallet(account).writeContract({ address, abi: artifact(name).abi, functionName, args });
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Fixture ${functionName} reverted`); return hash;
  }
  async function read<T>(name: string, address: Address, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return await local.publicClient.readContract({ address, abi: artifact(name).abi, functionName, args }) as T;
  }
  async function makePayment(scheme: Scheme = 'exact', required?: PaymentRequired): Promise<PaymentPayload> {
    const challenge = required ?? await service.challenge({ scheme, resource, requestHash: binding, amount: '1000000' });
    const accepted = challenge.accepts[0]!;
    const now = (await local.publicClient.getBlock({ blockTag: 'latest' })).timestamp;
    if (scheme === 'exact') {
      const authorization = { from: payer.address, to: receiver.address, value: accepted.amount, validAfter: (now - 1n).toString(),
        validBefore: (now + 240n).toString(), nonce: accepted.extra.telomere.nonce };
      const signature = await payer.signTypedData({ domain: { name: 'Local EIP3009 Fixture', version: '1', chainId: 31337, verifyingContract: asset },
        types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: { ...authorization, value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) } });
      return { x402Version: 2, resource: challenge.resource, accepted, payload: { signature, authorization } };
    }
    const permit2Authorization = { from: payer.address, permitted: { token: asset, amount: accepted.amount }, spender: proxy,
      nonce: BigInt(accepted.extra.telomere.nonce).toString(), deadline: (now + 240n).toString(),
      witness: { to: receiver.address, facilitator: facilitator.address, validAfter: (now - 1n).toString() } };
    const signature = await payer.signTypedData({ domain: { name: 'Permit2', chainId: 31337, verifyingContract: permit2 }, types: PERMIT2_TYPES,
      primaryType: 'PermitWitnessTransferFrom', message: { ...permit2Authorization, permitted: { token: asset, amount: BigInt(accepted.amount) },
        nonce: BigInt(permit2Authorization.nonce), deadline: BigInt(permit2Authorization.deadline),
        witness: { ...permit2Authorization.witness, validAfter: BigInt(permit2Authorization.witness.validAfter) } } });
    return { x402Version: 2, resource: challenge.resource, accepted, payload: { signature, permit2Authorization } };
  }
  function wrapper(overrides: Partial<PaymentChain>): PaymentChain {
    return { pins: chain.pins, verify: chain.verify.bind(chain), prepare: chain.prepare.bind(chain), broadcast: chain.broadcast.bind(chain),
      inspect: chain.inspect.bind(chain), ...overrides };
  }
  beforeAll(async () => {
    artifacts = compileFixtures(); local = await startLocalChain(); test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    [owner, payer, receiver, facilitator, outsider] = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey())) as [Account, Account, Account, Account, Account];
    for (const account of [owner, payer, receiver, facilitator, outsider]) await test.setBalance({ address: account.address, value: parseEther('10') });
    asset = await deploy('LocalEip3009Token'); permit2 = await deploy('Permit2'); proxy = await deploy('x402UptoPermit2Proxy', [permit2]);
    await write(owner, 'LocalEip3009Token', asset, 'faucet', [payer.address, 100_000_000n]);
    await write(payer, 'LocalEip3009Token', asset, 'approve', [permit2, maxUint256]);
    const hash = async (address: Address) => keccak256((await local.publicClient.getCode({ address }))!);
    pins = { chainId: 31337, asset, reviewedTokenKind: 'immutable', tokenCodeHash: await hash(asset), payTo: receiver.address, facilitator: facilitator.address, confirmations: 1,
      exact: { reviewedEip3009: true, name: 'Local EIP3009 Fixture', version: '1' },
      upto: { name: 'Local EIP3009 Fixture', version: '1', permit2, permit2CodeHash: await hash(permit2), proxy, proxyCodeHash: await hash(proxy) } };
    chain = new EvmPaymentChain(local.publicClient, wallet(facilitator), pins); snapshot = await test.snapshot();
  }, 60_000);
  beforeEach(async () => {
    await test.revert({ id: snapshot }); snapshot = await test.snapshot();
    clock = Number((await local.publicClient.getBlock({ blockTag: 'latest' })).timestamp) * 1000;
    store = await openStore({ DATA_DIR: ':memory:' }); service = new X402PaymentService(store.db, chain, () => clock); await service.initialize();
  });
  afterEach(async () => { await store?.close(); if (directory) {
    const owned = resolve(directory);
    if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('telomere-x402-')) throw new Error('Unexpected owned payment fixture directory');
    await rm(owned, { recursive: true, force: true }); directory = undefined;
  } });
  afterAll(async () => { await local?.close(); });

  it('checks pinned unchanged upstream source and compiled Permit2 provenance offline', () => {
    const compiled = JSON.parse(readFileSync(resolve(fixtureRoot, 'Permit2.compiled.json'), 'utf8')) as { compiler: { version: string; sha256: string } };
    expect(compiled.compiler.version).toBe('0.8.17+commit.8df45f5f.Emscripten.clang');
    expect(compiled.compiler.sha256).toBe('0x617828e63be485c7cc2dbcbdd5a22b582b40fafaa41016ad595637b83c90656c');
  });
  it.each(['exact', 'upto'] as const)('verify %s is read-only and validates a real onchain simulation', async scheme => {
    const payment = await makePayment(scheme), before = await local.publicClient.getTransactionCount({ address: facilitator.address });
    const challenges = await store.db.select().from(paymentChallenges);
    expect(await service.verify(payment, binding)).toMatchObject({ isValid: true, payer: payer.address });
    expect(await local.publicClient.getTransactionCount({ address: facilitator.address })).toBe(before);
    expect(await store.db.select().from(paymentJournal)).toHaveLength(0);
    expect(await store.db.select().from(paymentChallenges)).toEqual(challenges);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(0n);
  });
  it('settles standard EIP3009 exactly once and conserves token balances', async () => {
    const payment = await makePayment(), response = await service.settle(payment, { amount: '1000000', requestHash: binding });
    expect(response).toMatchObject({ success: true, amount: '1000000', network: 'eip155:31337' });
    expect(response.transaction).toMatch(/^0x[0-9a-f]{64}$/); expect(response.errorReason).toBeUndefined();
    expect(await service.settle(payment, { amount: '1000000', requestHash: binding })).toEqual(response);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(1_000_000n);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [payer.address])).toBe(99_000_000n);
    expect((await service.verify(payment)).invalidReason).toBe('authorization_already_used');
    const [journal] = await store.db.select().from(paymentJournal); expect(journal?.state).toBe('settled');
    expect(journal?.raw).toMatch(/^0x/); expect(JSON.stringify(response)).not.toContain(journal?.raw);
  });
  it('settles a partial upto using the actual upstream proxy and Permit2 signed witness', async () => {
    const payment = await makePayment('upto'), response = await service.settle(payment, { amount: '350000', requestHash: binding });
    expect(response.success).toBe(true); expect(response.amount).toBe('350000');
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(350_000n);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [payer.address])).toBe(99_650_000n);
    await expect(service.settle(payment, { amount: '350001', requestHash: binding })).rejects.toMatchObject({ code: 'payment_idempotency_conflict' });
  });
  it('upto zero consumes the durable challenge without sending a transaction', async () => {
    const payment = await makePayment('upto'), nonce = await local.publicClient.getTransactionCount({ address: facilitator.address });
    expect(await service.settle(payment, { amount: '0', requestHash: binding })).toMatchObject({ success: true, transaction: '', amount: '0' });
    expect(await local.publicClient.getTransactionCount({ address: facilitator.address })).toBe(nonce);
    await expect(service.settle(payment, { amount: '1', requestHash: binding })).rejects.toMatchObject({ code: 'payment_idempotency_conflict' });
  });
  it.each(['exact', 'upto'] as const)('rejects exceeding maximum, wrong body, and replaced unsigned challenge metadata for %s', async scheme => {
    const payment = await makePayment(scheme);
    await expect(service.settle(payment, { amount: '1000001', requestHash: binding })).rejects.toMatchObject({ code: 'settlement_amount_invalid' });
    expect((await service.verify(payment, requestBinding('POST', resource.url, Buffer.from('cpu=11')))).invalidReason).toBe('payment_request_mismatch');
    const other = await makePayment(scheme), altered = structuredClone(payment); altered.accepted.extra.telomere = other.accepted.extra.telomere;
    expect((await service.verify(altered)).isValid).toBe(false);
    expect(await store.db.select().from(paymentJournal)).toHaveLength(0);
  });
  it('requires exact charge equality and a valid untampered EIP3009 signature', async () => {
    const payment = await makePayment();
    await expect(service.settle(payment, { amount: '999999', requestHash: binding })).rejects.toMatchObject({ code: 'settlement_amount_invalid' });
    if (!('authorization' in payment.payload)) throw new Error('Expected exact');
    payment.payload.authorization.from = outsider.address;
    expect((await service.verify(payment)).invalidReason).toBe('invalid_signature');
  });
  it('requires pre-existing Permit2 allowance and never auto-approves the payer', async () => {
    await write(payer, 'LocalEip3009Token', asset, 'approve', [permit2, 0n]);
    const payment = await makePayment('upto'); expect((await service.verify(payment)).invalidReason).toBe('PERMIT2_ALLOWANCE_REQUIRED');
    expect(await read<bigint>('LocalEip3009Token', asset, 'allowance', [payer.address, permit2])).toBe(0n);
  });
  it.each(['to', 'facilitator', 'spender'] as const)('rejects altered Permit2 signed %s', async field => {
    const payment = await makePayment('upto'); if (!('permit2Authorization' in payment.payload)) throw new Error('Expected upto');
    if (field === 'spender') payment.payload.permit2Authorization.spender = outsider.address;
    else payment.payload.permit2Authorization.witness[field] = outsider.address;
    expect((await service.verify(payment)).invalidReason).toBe('authorization_mismatch');
  });
  it('actual upstream proxy rejects settlement from an unrelated facilitator', async () => {
    const payment = await makePayment('upto'); if (!('permit2Authorization' in payment.payload)) throw new Error('Expected upto');
    const auth = payment.payload.permit2Authorization;
    await expect(write(outsider, 'x402UptoPermit2Proxy', proxy, 'settle', [
      { permitted: { token: asset, amount: BigInt(auth.permitted.amount) }, nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline) },
      350_000n, payer.address, { ...auth.witness, validAfter: BigInt(auth.witness.validAfter) }, payment.payload.signature,
    ])).rejects.toThrow();
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(0n);
  });
  it.each(['exact', 'upto'] as const)('rejects expired authorizations for %s', async scheme => {
    const payment = await makePayment(scheme); await test.increaseTime({ seconds: 241 }); await test.mine({ blocks: 1 });
    expect((await service.verify(payment)).invalidReason).toBe('authorization_time_invalid');
  });
  it('fails closed for wrong chain, code, token domain or missing explicit asset capability', async () => {
    const payment = await makePayment();
    const zeroHash = `0x${'00'.repeat(32)}` as Hex;
    for (const patch of [{ tokenCodeHash: zeroHash }, { exact: { reviewedEip3009: true as const, name: 'USDG', version: '1' } }]) {
      const invalid = new X402PaymentService(store.db, new EvmPaymentChain(local.publicClient, wallet(facilitator), { ...pins, ...patch }), () => clock);
      expect((await invalid.verify(payment)).isValid).toBe(false);
    }
    const noExact = { ...pins }; delete noExact.exact;
    const invalid = new X402PaymentService(store.db, new EvmPaymentChain(local.publicClient, wallet(facilitator), noExact), () => clock);
    await expect(invalid.challenge({ scheme: 'exact', resource, requestHash: binding, amount: '1' })).rejects.toMatchObject({ code: 'unsupported_payment_scheme' });
  });
  it('two independent service instances concurrently settle one authorization only once', async () => {
    const payment = await makePayment(), other = new X402PaymentService(store.db, chain, () => clock);
    const responses = await Promise.all([service.settle(payment, { amount: '1000000', requestHash: binding }),
      other.settle(payment, { amount: '1000000', requestHash: binding })]);
    expect(responses[0]?.transaction).toBe(responses[1]?.transaction);
    expect((await other.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
    expect(await store.db.select().from(paymentJournal)).toHaveLength(1);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(1_000_000n);
  });
  it('persists raw bytes before a dropped broadcast response, then recovers across disk restart', async () => {
    await store.close(); directory = await mkdtemp(join(tmpdir(), 'telomere-x402-'));
    store = await openStore({ DATA_DIR: directory }); let observed: PreparedPayment | undefined;
    const ambiguous = wrapper({ broadcast: async raw => {
      // Reconciliation holds the database lock while sending. PGlite uses one
      // connection, so an outside query here would wait on this callback.
      observed = { raw, hash: keccak256(raw), nonce: parseTransaction(raw as Parameters<typeof parseTransaction>[0]).nonce! };
      await chain.broadcast(raw); throw new Error('Injected RPC response loss');
    } });
    let inspectCalls = 0;
    const uncertain = { ...ambiguous, inspect: async (prepared: PreparedPayment, payment: PaymentPayload, amount: string) => {
      inspectCalls += 1; if (inspectCalls > 1) throw new Error('Injected RPC outage after ambiguous send');
      return chain.inspect(prepared, payment, amount);
    } };
    service = new X402PaymentService(store.db, uncertain, () => clock); await service.initialize();
    const payment = await makePayment(), pending = await service.settle(payment, { amount: '1000000', requestHash: binding });
    expect(pending).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: observed!.hash });
    expect((await store.db.select().from(paymentJournal))[0]).toMatchObject({ state: 'prepared', ...observed });
    await store.close(); store = await openStore({ DATA_DIR: directory }); service = new X402PaymentService(store.db, chain, () => clock); await service.initialize();
    const settled = await service.settle(payment, { amount: '1000000', requestHash: binding });
    expect(settled.success).toBe(true); expect(settled.transaction).toBe(observed!.hash);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(1_000_000n);
  });
  it('blocks a second payment while a dedicated signer has an unresolved persisted nonce', async () => {
    const paused = wrapper({ broadcast: async () => { throw new Error('offline'); } });
    service = new X402PaymentService(store.db, paused, () => clock);
    const one = await makePayment(), two = await makePayment('upto');
    const pending = await service.settle(one, { amount: '1000000', requestHash: binding });
    expect(pending.success).toBe(false); expect(pending.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    await expect(service.settle(two, { amount: '1', requestHash: binding })).rejects.toMatchObject({ code: 'facilitator_reconciliation_required' });
    expect(await store.db.select().from(paymentJournal)).toHaveLength(1);
    service = new X402PaymentService(store.db, chain, () => clock);
    expect((await service.settle(one, { amount: '1000000', requestHash: binding })).success).toBe(true);
    expect((await service.settle(two, { amount: '1', requestHash: binding })).success).toBe(true);
  });
  it('waits for configured canonical confirmations without claiming a pending plan settled', async () => {
    const confirmed = new EvmPaymentChain(local.publicClient, wallet(facilitator), { ...pins, confirmations: 2 });
    service = new X402PaymentService(store.db, confirmed, () => clock); const payment = await makePayment();
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).errorReason).toBe('settlement_pending');
    await test.mine({ blocks: 1 });
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
  });
  it('uses bounded standard HTTP headers and rejects malformed or oversized payloads', async () => {
    const payment = await makePayment(); expect(decodePaymentHeader(encodePaymentHeader(payment))).toEqual(payment);
    for (const header of ['***', 'A'.repeat(40_000), Buffer.from('{}').toString('base64')]) expect(() => decodePaymentHeader(header)).toThrow();
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(requestBinding('GET', resource.url)).not.toBe(binding);
  });
  it('exposes facilitator discovery/read-only verify and authenticates variable-charge settle', async () => {
    const app = createFacilitatorRoutes(service, context => context.req.header('authorization') === 'Bearer local-resource-fixture');
    expect(await (await app.request('/supported')).json()).toMatchObject({ extensions: ['telomere-request-binding'] });
    const payment = await makePayment('upto'), body = { x402Version: 2, paymentPayload: payment, paymentRequirements: payment.accepted };
    expect(await (await app.request('/verify', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json()).toMatchObject({ isValid: true });
    body.paymentRequirements = { ...payment.accepted, amount: '300000' };
    expect((await app.request('/settle', { method: 'POST', body: JSON.stringify(body) })).status).toBe(401);
    const response = await app.request('/settle', { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer local-resource-fixture' } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ success: true, amount: '300000' });
  });
  it('HTTP402 resource executes once, charges server-computed upto, and replays cached response', async () => {
    let executions = 0;
    const app = new Hono(); app.route('/compute', createPaidResourceRoutes(service, { url: resource.url, scheme: 'upto', maximum: '1000000',
      execute: async ({ body, idempotencyKey }) => { executions += 1; expect(idempotencyKey).toMatch(/^0x/);
        return { amount: '240000', result: { cpu: Buffer.from(body).toString(), computed: 55 } }; } }));
    const unpaid = await app.request('/compute', { method: 'POST', body: 'cpu=10' }); expect(unpaid.status).toBe(402);
    const required = JSON.parse(Buffer.from(unpaid.headers.get('PAYMENT-REQUIRED')!, 'base64').toString()) as PaymentRequired;
    const payment = await makePayment('upto', required), request = { method: 'POST', body: 'cpu=10', headers: { 'PAYMENT-SIGNATURE': encodePaymentHeader(payment) } };
    const response = await app.request('/compute', request); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cpu: 'cpu=10', computed: 55 });
    expect(JSON.parse(Buffer.from(response.headers.get('PAYMENT-RESPONSE')!, 'base64').toString())).toMatchObject({ success: true, amount: '240000' });
    expect((await app.request('/compute', request)).status).toBe(200); expect(executions).toBe(1);
    expect((await app.request('/compute', { ...request, body: 'cpu=11' })).status).toBe(409);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(240_000n);
    expect(await store.db.select().from(paymentResourceResults)).toHaveLength(1);
  });
  it('does not rerun uncertain resource work after a crash between intent and durable result', async () => {
    const payment = await makePayment(), execute = async () => { throw new Error('Injected resource crash'); };
    await expect(service.runResource(payment, binding, execute)).rejects.toThrow('Injected resource crash');
    let executions = 0;
    await expect(service.runResource(payment, binding, async () => { executions += 1; return { amount: '1000000', result: {} }; }))
      .rejects.toMatchObject({ code: 'resource_reconciliation_required' });
    expect(executions).toBe(0); expect(await store.db.select().from(paymentJournal)).toHaveLength(0);
  });
  it('journals a canonical reverted tx as failed and never interprets nonce consumption as payment', async () => {
    const payment = await makePayment();
    const malformed = wrapper({ prepare: async (input, amount) => {
      const prepared = await chain.prepare(input, amount);
      // Authorization is now consumed by a third-party relay before the committed tx is broadcast.
      if (!('authorization' in input.payload)) throw new Error('Expected exact');
      const auth = input.payload.authorization, sig = input.payload.signature;
      await write(outsider, 'LocalEip3009Token', asset, 'transferWithAuthorization', [auth.from, auth.to, BigInt(auth.value),
        BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, Number.parseInt(sig.slice(130), 16), `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);
      return prepared;
    } });
    service = new X402PaymentService(store.db, malformed, () => clock);
    const response = await service.settle(payment, { amount: '1000000', requestHash: binding });
    expect(response).toMatchObject({ success: false, errorReason: 'transaction_reverted' });
    expect((await store.db.select().from(paymentJournal))[0]?.state).toBe('reverted');
    expect(await service.settle(payment, { amount: '1000000', requestHash: binding })).toEqual(response);
  });
  it('authorization key is independent of unsigned metadata, and accepted terms cannot be rewritten', async () => {
    const payment = await makePayment('upto'), altered = structuredClone(payment); altered.resource.url = 'https://attacker.example/';
    expect(authorizationKey(altered)).toBe(authorizationKey(payment));
    expect((await service.verify(altered)).invalidReason).toBe('payment_request_mismatch');
    await store.db.execute(sql`SELECT 1`);
    expect(await store.db.select().from(paymentJournal).where(eq(paymentJournal.key, authorizationKey(payment)))).toHaveLength(0);
  });
  it('accepts the standard hexadecimal Permit2 nonce and optional echoed extension', async () => {
    const payment = await makePayment('upto'); if (!('permit2Authorization' in payment.payload)) throw new Error('Expected upto');
    payment.payload.permit2Authorization.nonce = `0x${BigInt(payment.payload.permit2Authorization.nonce).toString(16)}`;
    payment.extensions = { 'telomere-request-binding': { version: 1, requestHash: binding } };
    expect((await service.verify(payment)).isValid).toBe(true);
    expect((await service.settle(payment, { amount: '7', requestHash: binding })).success).toBe(true);
  });
  it.each(['exact', 'upto'] as const)('rejects onchain consumed %s nonce even without a prior local payment journal', async scheme => {
    const payment = await makePayment(scheme), prepared = await chain.prepare(payment, '1000000');
    await chain.broadcast(prepared.raw);
    expect(await store.db.select().from(paymentJournal)).toHaveLength(0);
    expect((await service.verify(payment)).invalidReason).toBe('authorization_already_used');
  });
  it('does not accept a receipt orphaned before the configured confirmations', async () => {
    const stable = new EvmPaymentChain(local.publicClient, wallet(facilitator), { ...pins, confirmations: 3 });
    service = new X402PaymentService(store.db, stable, () => clock);
    const payment = await makePayment(), before = await test.snapshot();
    const pending = await service.settle(payment, { amount: '1000000', requestHash: binding }); expect(pending.success).toBe(false);
    const [journal] = await store.db.select().from(paymentJournal);
    await test.revert({ id: before });
    const prepared = { raw: journal!.raw as Hex, hash: journal!.hash as Hex, nonce: journal!.nonce! };
    expect(await stable.inspect(prepared, payment, '1000000')).toBe('pending');
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(false);
    await test.mine({ blocks: 2 });
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(1_000_000n);
  });
  it('checks EIP1967 implementation pins and refuses an unreviewed proxy configuration', async () => {
    expect(() => new EvmPaymentChain(local.publicClient, wallet(facilitator), { ...pins, reviewedTokenKind: 'eip1967' })).toThrow();
    const incorrect = new EvmPaymentChain(local.publicClient, wallet(facilitator), { ...pins, reviewedTokenKind: 'eip1967',
      assetImplementation: { address: asset, codeHash: pins.tokenCodeHash } });
    const invalid = new X402PaymentService(store.db, incorrect, () => clock);
    expect((await invalid.verify(await makePayment())).invalidReason).toBe('asset_implementation_pin_mismatch');
  });
  it('rejects a Circle proxy upgrade before rebroadcasting a prepared signed payment', async () => {
    const payment = await makePayment(), prepared = await chain.prepare(payment, '1000000');
    const reviewed = new EvmPaymentChain(local.publicClient, wallet(facilitator), { ...pins,
      reviewedTokenKind: 'circle_proxy', assetImplementation: { address: asset, codeHash: pins.tokenCodeHash } });
    await test.setStorageAt({ address: asset, index: CIRCLE_PROXY_IMPLEMENTATION_SLOT,
      value: padHex(asset, { size: 32 }) });
    await test.mine({ blocks: 1 });
    await expect(reviewed.verify(payment, payment.accepted)).resolves.toBeUndefined();
    await test.setStorageAt({ address: asset, index: CIRCLE_PROXY_IMPLEMENTATION_SLOT,
      value: padHex(outsider.address, { size: 32 }) });
    await test.mine({ blocks: 1 });
    const broadcast = vi.spyOn(local.publicClient, 'sendRawTransaction');
    try {
      await expect(reviewed.broadcast(prepared.raw)).rejects.toMatchObject({ code: 'asset_implementation_pin_mismatch' });
      expect(broadcast).not.toHaveBeenCalled();
    } finally { broadcast.mockRestore(); }
  });
  it('rejects a receipt whose authorization facet differed at the payment block', async () => {
    const payment = await makePayment(), prepared = await chain.prepare(payment, '1000000');
    await chain.broadcast(prepared.raw);
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: prepared.hash });
    await test.mine({ blocks: 1 });
    const client = new Proxy(local.publicClient, { get(target, property, receiver) {
      if (property !== 'readContract') return Reflect.get(target, property, receiver);
      return async (request: { functionName?: string; blockHash?: Hex }) => {
        if (request.functionName === 'getFacet') return request.blockHash === receipt.blockHash ? outsider.address : asset;
        return target.readContract(request as never);
      };
    } });
    const reviewed = new EvmPaymentChain(client, wallet(facilitator), { ...pins,
      assetFacet: { address: asset, codeHash: pins.tokenCodeHash } });
    await expect(reviewed.inspect(prepared, payment, '1000000')).rejects.toMatchObject({ code: 'asset_facet_pin_mismatch' });
    const unchanged = new Proxy(local.publicClient, { get(target, property, receiver) {
      if (property !== 'readContract') return Reflect.get(target, property, receiver);
      return async (request: { functionName?: string }) => request.functionName === 'getFacet' ? asset : target.readContract(request as never);
    } });
    const unchangedChain = new EvmPaymentChain(unchanged, wallet(facilitator), { ...pins,
      assetFacet: { address: asset, codeHash: pins.tokenCodeHash } });
    expect(await unchangedChain.inspect(prepared, payment, '1000000')).toBe('settled');
  });
  it('refuses to queue behind an untracked pending transaction from the dedicated facilitator', async () => {
    const payment = await makePayment();
    await test.setAutomine(false);
    try {
      await wallet(facilitator).sendTransaction({ to: outsider.address, value: 0n, gas: 21_000n });
      await expect(service.settle(payment, { amount: '1000000', requestHash: binding })).rejects.toMatchObject({ code: 'facilitator_pending_nonce' });
      expect(await store.db.select().from(paymentJournal)).toHaveLength(0);
    } finally { await test.setAutomine(true); await test.mine({ blocks: 1 }); }
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
  });
  it('never rebroadcasts an unfinished journal under changed recipient or signer configuration', async () => {
    service = new X402PaymentService(store.db, wrapper({ broadcast: async () => { throw new Error('offline'); } }), () => clock);
    const payment = await makePayment();
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(false);
    let broadcasts = 0;
    const changed = wrapper({ pins: { ...chain.pins, payTo: outsider.address }, broadcast: async () => { broadcasts += 1; throw new Error('must not broadcast'); } });
    const replacement = new X402PaymentService(store.db, changed, () => clock);
    await expect(replacement.settle(payment, { amount: '1000000', requestHash: binding })).rejects.toMatchObject({ code: 'payment_configuration_mismatch' });
    expect(broadcasts).toBe(0); expect((await store.db.select().from(paymentJournal))[0]?.state).toBe('prepared');
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(0n);
  });
  it('refuses a journal whose persisted signed bytes do not match the committed transaction hash', async () => {
    service = new X402PaymentService(store.db, wrapper({ broadcast: async () => { throw new Error('offline'); } }), () => clock);
    const payment = await makePayment(); await service.settle(payment, { amount: '1000000', requestHash: binding });
    const [journal] = await store.db.select().from(paymentJournal);
    await store.db.update(paymentJournal).set({ raw: '0x00' }).where(eq(paymentJournal.key, journal!.key));
    service = new X402PaymentService(store.db, chain, () => clock);
    await expect(service.settle(payment, { amount: '1000000', requestHash: binding })).rejects.toMatchObject({ code: 'payment_journal_corrupt' });
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(0n);
    await store.db.update(paymentJournal).set({ raw: journal!.raw }).where(eq(paymentJournal.key, journal!.key));
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
  });

  it('invalidates cached success after an actual reorg, refuses a replacement authorization nonce and resumes original bytes after disk restart', async () => {
    await store.close(); directory = await mkdtemp(join(tmpdir(), 'telomere-x402-'));
    store = await openStore({ DATA_DIR: directory }); service = new X402PaymentService(store.db, chain, () => clock); await service.initialize();
    const payment = await makePayment(), branch = await test.snapshot();
    const first = await service.settle(payment, { amount: '1000000', requestHash: binding }); expect(first.success).toBe(true);
    const original = (await store.db.select().from(paymentJournal))[0]!;
    await test.revert({ id: branch }); const replacement = await makePayment();
    await expect(service.settle(replacement, { amount: '1000000', requestHash: binding })).rejects.toMatchObject({ code: 'facilitator_nonce_reconciliation_required' });
    expect(await store.db.select().from(paymentJournal)).toHaveLength(1);
    const lost = await service.settle(payment, { amount: '1000000', requestHash: binding });
    expect(lost).toMatchObject({ success: false, errorReason: 'settlement_pending', transaction: original.hash });
    expect(await local.publicClient.getTransactionCount({ address: facilitator.address })).toBe(0);
    const pending = (await store.db.select().from(paymentJournal))[0]!;
    expect(pending).toMatchObject({ state: 'prepared', raw: original.raw, hash: original.hash, nonce: original.nonce });
    await store.close(); store = await openStore({ DATA_DIR: directory }); service = new X402PaymentService(store.db, chain, () => clock); await service.initialize();
    expect(await service.settle(payment, { amount: '1000000', requestHash: binding })).toEqual(first);
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(1_000_000n);
    expect(await local.publicClient.getTransactionCount({ address: facilitator.address })).toBe(1);
    const completed = (await store.db.select().from(paymentJournal))[0]!;
    expect(completed).toMatchObject({ state: 'settled', raw: original.raw, hash: original.hash, nonce: original.nonce });
  });

  it('withdraws a previously successful result when confirmation depth drops, without broadcasting during reinspection', async () => {
    const stable = new EvmPaymentChain(local.publicClient, wallet(facilitator), { ...pins, confirmations: 3 }); let broadcasts = 0;
    service = new X402PaymentService(store.db, { ...wrapper({}), pins: stable.pins, verify: stable.verify.bind(stable), prepare: stable.prepare.bind(stable),
      inspect: stable.inspect.bind(stable), broadcast: async raw => { broadcasts++; return stable.broadcast(raw); } }, () => clock);
    const payment = await makePayment(); expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(false);
    const shallow = await test.snapshot(); await test.mine({ blocks: 2 });
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true); expect(broadcasts).toBe(1);
    await test.revert({ id: shallow });
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(false); expect(broadcasts).toBe(1);
    expect((await store.db.select().from(paymentJournal))[0]!.state).toBe('prepared');
    await test.mine({ blocks: 2 }); expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true); expect(broadcasts).toBe(1);
  });

  it('fails closed on finalized RPC outages without rerunning cached resource work, and inspects old settlements after authorization expiry', async () => {
    const payment = await makePayment(); let executions = 0;
    const execute = async () => { executions++; return { amount: '1000000', result: { completed: true } }; };
    expect((await service.runResource(payment, binding, execute)).payment.success).toBe(true);
    const original = (await store.db.select().from(paymentJournal))[0]!;
    service = new X402PaymentService(store.db, wrapper({ inspect: async () => { throw new Error('private-provider-sentinel'); } }), () => clock);
    await expect(service.runResource(payment, binding, execute)).rejects.toMatchObject({ code: 'payment_finality_unavailable' });
    expect(executions).toBe(1); expect((await store.db.select().from(paymentJournal))[0]).toEqual(original);
    clock += 600_000; service = new X402PaymentService(store.db, chain, () => clock);
    expect((await service.runResource(payment, binding, execute)).payment.success).toBe(true); expect(executions).toBe(1);
  });

  it('checks current configuration even for finalized nonzero and zero-charge journals', async () => {
    const payment = await makePayment(); expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
    const zero = await makePayment('upto'); expect((await service.settle(zero, { amount: '0', requestHash: binding })).success).toBe(true);
    service = new X402PaymentService(store.db, wrapper({ pins: { ...pins, payTo: outsider.address } }), () => clock);
    await expect(service.settle(payment, { amount: '1000000', requestHash: binding })).rejects.toMatchObject({ code: 'payment_configuration_mismatch' });
    await expect(service.settle(zero, { amount: '0', requestHash: binding })).rejects.toMatchObject({ code: 'payment_configuration_mismatch' });
  });

  it('refuses to downgrade or rebroadcast an orphaned terminal payment while another authorization owns the signer reservation', async () => {
    const first = await makePayment(), branch = await test.snapshot();
    expect((await service.settle(first, { amount: '1000000', requestHash: binding })).success).toBe(true);
    const second = await makePayment(); service = new X402PaymentService(store.db, wrapper({ broadcast: async () => { throw new Error('offline'); } }), () => clock);
    expect((await service.settle(second, { amount: '1000000', requestHash: binding })).success).toBe(false);
    const original = await store.db.select().from(paymentJournal); await test.revert({ id: branch }); let broadcasts = 0;
    service = new X402PaymentService(store.db, wrapper({ broadcast: async raw => { broadcasts++; return chain.broadcast(raw); } }), () => clock);
    await expect(service.settle(first, { amount: '1000000', requestHash: binding })).rejects.toMatchObject({ code: 'payment_finality_reconciliation_required' });
    expect(broadcasts).toBe(0); expect(await store.db.select().from(paymentJournal)).toEqual(original);
  });

  it('serializes a terminal reorg inspection against a concurrent new authorization reservation', async () => {
    const first = await makePayment(), second = await makePayment(), branch = await test.snapshot();
    expect((await service.settle(first, { amount: '1000000', requestHash: binding })).success).toBe(true);
    await test.revert({ id: branch });
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
    service = new X402PaymentService(store.db, wrapper({ inspect: async (prepared, payment, amount) => { entered(); await gate; return chain.inspect(prepared, payment, amount); } }), () => clock);
    const old = service.settle(first, { amount: '1000000', requestHash: binding }); await inside;
    const newer = service.settle(second, { amount: '1000000', requestHash: binding }).catch((error: unknown) => error); release();
    expect((await old).success).toBe(false); expect(await newer).toMatchObject({ code: 'facilitator_reconciliation_required' });
    const rows = await store.db.select().from(paymentJournal); expect(rows).toHaveLength(1); expect(rows[0]!.state).toBe('prepared');
    expect(await local.publicClient.getTransactionCount({ address: facilitator.address })).toBe(0);
  });

  it('rejects a prepared journal with forged success before any RPC fallback can expose it', async () => {
    service = new X402PaymentService(store.db, wrapper({ broadcast: async () => { throw new Error('offline'); } }), () => clock);
    const payment = await makePayment(); await service.settle(payment, { amount: '1000000', requestHash: binding });
    const [journal] = await store.db.select().from(paymentJournal);
    await store.db.update(paymentJournal).set({ response: { ...journal!.response, success: true } }).where(eq(paymentJournal.key, journal!.key));
    service = new X402PaymentService(store.db, wrapper({ inspect: async () => { throw new Error('RPC failure'); } }), () => clock);
    await expect(service.settle(payment, { amount: '1000000', requestHash: binding })).rejects.toMatchObject({ code: 'payment_journal_corrupt' });
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(0n);
  });

  it('atomically bounds concurrent challenge issuance while existing payments remain verifiable and payable', async () => {
    service = new X402PaymentService(store.db, chain, () => clock, { maximumChallenges: 2 });
    const other = new X402PaymentService(store.db, chain, () => clock, { maximumChallenges: 2 });
    const input = { scheme: 'exact' as const, resource, requestHash: binding, amount: '1000000' };
    const issued = await Promise.allSettled([service.challenge(input), other.challenge(input), service.challenge(input)]);
    const accepted = issued.filter((result): result is PromiseFulfilledResult<PaymentRequired> => result.status === 'fulfilled');
    const refused = issued.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(accepted).toHaveLength(2); expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: 'payment_challenge_capacity_reached' });
    expect(await store.db.select().from(paymentChallenges)).toHaveLength(2);
    expect(await store.db.select().from(paymentJournal)).toHaveLength(0);
    expect(await local.publicClient.getTransactionCount({ address: facilitator.address })).toBe(0);
    const payment = await makePayment('exact', accepted[0]!.value);
    expect((await service.verify(payment, binding)).isValid).toBe(true);
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
    await expect(service.challenge(input)).rejects.toMatchObject({ code: 'payment_challenge_capacity_reached' });
    expect(await store.db.select().from(paymentChallenges)).toHaveLength(2);
  });

  it('retains the challenge bound across disk restart and expiry without discarding pending payment evidence', async () => {
    await store.close(); directory = await mkdtemp(join(tmpdir(), 'telomere-x402-'));
    store = await openStore({ DATA_DIR: directory });
    service = new X402PaymentService(store.db, wrapper({ broadcast: async () => { throw new Error('offline'); } }), () => clock, { maximumChallenges: 1 });
    const payment = await makePayment(); expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(false);
    const original = (await store.db.select().from(paymentJournal))[0]!;
    clock += 600_000; await store.close(); store = await openStore({ DATA_DIR: directory });
    service = new X402PaymentService(store.db, chain, () => clock, { maximumChallenges: 1 });
    await expect(service.challenge({ scheme: 'exact', resource, requestHash: binding, amount: '1' }))
      .rejects.toMatchObject({ code: 'payment_challenge_capacity_reached' });
    expect(await store.db.select().from(paymentChallenges)).toHaveLength(1);
    expect((await service.settle(payment, { amount: '1000000', requestHash: binding })).success).toBe(true);
    expect((await store.db.select().from(paymentJournal))[0]).toMatchObject({ raw: original.raw, hash: original.hash, nonce: original.nonce });
    expect(await read<bigint>('LocalEip3009Token', asset, 'balanceOf', [receiver.address])).toBe(1_000_000n);
  });
});
