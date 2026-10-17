import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createWalletClient, decodeFunctionData, encodeFunctionData, http, keccak256, parseSignature, toHex, type Hex } from 'viem';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { hashJson, Problem, randomId } from '../src/common.js';
import { localChain } from '../src/chain/chains.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { X402CpuReservationClient } from '../src/platform-runtime/x402-client.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { platformRuns, platformX402Challenges } from '../src/platform-runtime/schema.js';
import { platformHostSchema, platformQuoteTypes, typedPlatformQuote, type PlatformQuote, type PlatformX402Challenge } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { platformReceiptEntries } from '../src/receipts/platform-schema.js';
import { encodePaymentHeader } from '../src/payments/protocol.js';
import { EIP3009_TYPES } from '../src/payments/gateway.js';
import { spendPermissionLeashTermsHash } from '../src/payments/spend-permissions.js';
import { x402AuthorizationNonce, x402CpuAuthorization, x402CpuEscrowAbi, x402CpuOpenCall, x402CpuRequired, x402CpuTypedData,
  verifyX402CpuOpening, type X402CpuPayment, type X402CpuReservation } from '../src/payments/cpu-reservations.js';
import { openStore } from '../src/store.js';
import { compileX402CpuFixtures, deployX402CpuRuntime } from './fixtures/platform-x402-cpu.js';

let artifacts: ReturnType<typeof compileX402CpuFixtures>;
beforeAll(() => { artifacts = compileX402CpuFixtures(); }, 120_000);
const zero = `0x${'0'.repeat(64)}` as Hex, imageDigest = 'sha256:' + 'd'.repeat(64), image = 'fixture/x402-cpu@' + imageDigest;
type Fixture = Awaited<ReturnType<typeof deployX402CpuRuntime>>;
type Scheme = 'exact' | 'upto';
class Cpu extends LocalProcessFixtureRuntime {
  starts = 0;
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++;
    const code = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({sha256:require('node:crypto').createHash('sha256').update(JSON.parse(s).text).digest('hex')})),12000));";
    return super.start({ ...lease, argv: [process.execPath, '-e', code] }, heartbeat);
  }
}
async function leash(f: Fixture, cap = 100_000n) {
  const id = randomId(), block = await f.local.publicClient.getBlock();
  const terms = { agent: f.accounts.owner.address, maxPerHour: cap, maxPerDay: 1_000_000n, classMask: 1n,
    sealedOnly: false, imageAllowRoot: zero, regionAllowRoot: zero, expiry: block.timestamp + 86_400n };
  await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformX402EscrowV1').abi, functionName: 'createLeash', args: [id, terms] }));
  return { id, terms };
}
async function signed(f: Fixture, scope: Awaited<ReturnType<typeof leash>>, scheme: Scheme, overrides: Partial<PlatformQuote> = {}) {
  const block = await f.local.publicClient.getBlock(), quote: PlatformQuote = { runId: randomId(), leashId: scope.id, hostId: f.hostId, payer: f.accounts.owner.address,
    hwClass: 0, regionHash: keccak256(toHex('x402-local')), imageHash: keccak256(toHex(imageDigest)), workloadHash: randomId(),
    maxSeconds: 25, pricePerSecond: '100', inferencePrice: '0', quoteExpiry: Number(block.timestamp) + 120, ...overrides };
  const signature = await f.accounts.signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '4', chainId: 31337, verifyingContract: f.pins.escrowAddress },
    primaryType: 'PlatformQuote', types: platformQuoteTypes, message: typedPlatformQuote(quote) });
  const reservation: X402CpuReservation = { challengeId: '16eca51a-de2b-4937-91de-d9a63d158de8', scheme, resourceUrl: 'https://cpu.example/api/platform/cells',
    requestHash: randomId(), salt: randomId(), leashTermsHash: spendPermissionLeashTermsHash(scope.terms), maximum: scheme === 'exact' ? '2725' : '10000',
    validAfter: Number(block.timestamp) - 1, validBefore: quote.quoteExpiry };
  return { quote, signature, reservation, ceiling: '2725' };
}
async function payment(f: Fixture, q: Pick<PlatformX402Challenge, 'quote' | 'signature' | 'ceiling' | 'reservation'>): Promise<X402CpuPayment> {
  const typed = x402CpuTypedData(f.pins, q.quote, q.ceiling, q.reservation), signature = typed.primaryType === 'ReceiveWithAuthorization'
    ? await f.accounts.owner.signTypedData(typed) : await f.accounts.owner.signTypedData(typed);
  const authorization = x402CpuAuthorization(f.pins, q.quote, q.ceiling, q.reservation), required = x402CpuRequired(f.pins, q.quote, q.ceiling, q.reservation);
  return { x402Version: 2, resource: required.resource, accepted: required.accepts[0]!, extensions: required.extensions,
    payload: authorization.signatureType === 'ReceiveWithAuthorization' ? { signature, authorization: authorization.authorization }
      : { signature, permit2Authorization: authorization.permit2Authorization } };
}
async function send(f: Fixture, data: Hex, outsider = false) {
  const account = outsider ? f.accounts.outsider : f.accounts.owner, wallet = createWalletClient({ account, chain: localChain, transport: http(f.local.rpcUrl) });
  const hash = await wallet.sendTransaction({ to: f.pins.escrowAddress, data, gas: 2_000_000n });
  return f.local.publicClient.waitForTransactionReceipt({ hash });
}
async function balances(f: Fixture) {
  const read = (address: Hex) => f.local.publicClient.readContract({ address: f.pins.tokenAddress, abi: f.artifact('LocalReceiveToken').abi, functionName: 'balanceOf', args: [address] });
  return [await read(f.accounts.owner.address), await read(f.pins.escrowAddress)];
}
async function setup() {
  const journal = await openHostJournal(':memory:'), control = new Ed25519Identity(), cpu = new Cpu(), servers: Server[] = [];
  const hostAgent = new HostKitAgent(journal, cpu, control.publicKey, new Set([image])); await hostAgent.initialize();
  const listen = async (app: Hono) => { const server = createServer(getRequestListener(app.fetch)); servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address missing'); return 'http://127.0.0.1:' + address.port; };
  const hostClient = new HostKitClient(await listen(createHostKitRoutes(hostAgent)), journal.identity.publicKey, control, true);
  const f = await deployX402CpuRuntime(journal.identity.publicKey as Hex, artifacts), scope = await leash(f), store = await openStore({ DATA_DIR: ':memory:' });
  const bridge = new PlatformBridge(store.db, { pins: f.pins, rpcUrl: f.local.rpcUrl, signerPrivateKey: f.keys.signer });
  const host = platformHostSchema.parse({ hostId: f.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu', region: 'x402-local', image, imageDigest,
    sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
  let service: PlatformRuntimeService;
  const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: f.pins.escrowAddress, receiptRootAddress: f.pins.receiptRootAddress,
    publicClient: bridge.public, submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
  service = new PlatformRuntimeService(store.db, bridge, [host], new PlatformHostExecutor(store.db, new Map([[f.hostId, hostClient]])), receipts); await service.initialize();
  const app = new Hono(); let auth: Auth, origin = '';
  app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503));
  const principal = async (context: Parameters<Parameters<typeof createPlatformRuntimeRoutes>[1]>[0]) => auth.owner(getCookie(context, 'telomere_session'));
  app.get('/api/me', async context => context.json({ address: await principal(context), demo: false }));
  // The reviewed URL is selected after binding the disposable listener, never from a Host header.
  origin = await listen(app); app.route('/api/platform', createPlatformRuntimeRoutes(service, principal, { x402ResourceUrl: origin + '/api/platform/cells' }));
  auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: f.local.rpcUrl, SIGNER_PRIVATE_KEY: f.keys.signer,
    DEMO_PRIVATE_KEY: f.keys.owner, ESCROW_ADDRESS: f.pins.escrowAddress, TOKEN_ADDRESS: f.pins.tokenAddress }));
  const sessionToken = await auth.session(f.accounts.owner.address), now = await bridge.now();
  const sdk = new X402CpuReservationClient({ baseUrl: origin, pins: f.pins, sessionToken, nowSeconds: () => now });
  const request = (scheme: Scheme) => ({ extension: 'telomere-cpu-reservation-v1' as const, scheme,
    input: { leashId: scope.id, task: { kind: 'sha256' as const, text: 'x402-actual-cpu' }, maxSeconds: 25, deadline: now + 300, maxSpend: '10000', regions: ['x402-local'] } });
  const post = (body: unknown, key: string, header?: string) => fetch(origin + '/api/platform/cells', { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: 'telomere_session=' + sessionToken, 'Idempotency-Key': key, ...(header ? { 'PAYMENT-SIGNATURE': header } : {}) }, body: JSON.stringify(body) });
  return { f, scope, store, bridge, service, receipts, cpu, sdk, request, post, origin,
    async close() { await hostAgent.close(); for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await store.close(); await f.close(); await journal.close(); } };
}

it.each(['exact', 'upto'] as const)('%s extension funds an undeposited EOA CPU reservation over HTTP, admits a copied canonical call, executes once and settles/refunds its real work', async scheme => {
  const env = await setup();
  try {
    const { f, sdk, service, bridge } = env, request = env.request(scheme), challenge = await sdk.challenge(request, 'paid-cpu');
    expect(await bridge.balance(f.accounts.owner.address)).toEqual({ available: '0' }); expect(env.cpu.starts).toBe(0);
    expect(challenge.disclosure).toMatchObject({ immediateDebit: '2725', refundBeneficiary: f.accounts.owner.address, externalWalletGas: true });
    expect((await env.store.db.select().from(platformRuns))).toHaveLength(1); expect((await env.store.db.select().from(platformX402Challenges))).toHaveLength(1);
    const typed = await sdk.typedData(challenge, request), signature = typed.primaryType === 'ReceiveWithAuthorization'
      ? await f.accounts.owner.signTypedData(typed) : await f.accounts.owner.signTypedData(typed), payload = await sdk.payment(challenge, request, signature);
    const intent = await sdk.intent(request, payload, 'paid-cpu');
    const before = await balances(f), opened = await send(f, intent.transaction.data as Hex, true);
    expect(opened.status).toBe('success'); expect((await send(f, intent.transaction.data as Hex)).status).toBe('reverted');
    expect(await balances(f)).toEqual([BigInt(z.bigint().parse(before[0])) - 2725n, 2725n]);
    const replay = await sdk.intent(request, payload, 'paid-cpu'); expect(replay.state).toBe('retained_external_wallet_intent'); expect(replay.transaction).toEqual(intent.transaction);
    const headerReplay = await env.post({ request }, 'paid-cpu', encodePaymentHeader(payload)); expect(headerReplay.status).toBe(200);
    expect((await headerReplay.json() as { transaction: unknown }).transaction).toEqual(intent.transaction);
    const decoded = decodeFunctionData({ abi: x402CpuEscrowAbi, data: intent.transaction.data as Hex });
    expect(decoded.functionName).toBe(scheme === 'exact' ? 'openRunFromX402Exact' : 'openRunFromX402Upto');
    const changedTerms = { ...env.scope.terms, maxPerHour: 200_000n };
    await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformX402EscrowV1').abi, functionName: 'updateLeash', args: [env.scope.id, changedTerms] }));
    await verifyX402CpuOpening(bridge.public, f.pins, challenge.quote, challenge.ceiling, opened.transactionHash, challenge.reservation, keccak256(intent.transaction.data as Hex));
    await expect(verifyX402CpuOpening(bridge.public, { ...f.pins, tokenCodeHash: zero }, challenge.quote, challenge.ceiling, opened.transactionHash, challenge.reservation, keccak256(intent.transaction.data as Hex))).rejects.toThrow('asset code pin');
    expect((await sdk.admit(intent, opened.transactionHash, 'admit')).status).toBe('queued');
    expect((await sdk.admit(intent, opened.transactionHash, 'admit')).status).toBe('queued');
    await service.drain(); expect(env.cpu.starts).toBe(1);
    const result = await service.get(f.accounts.owner.address, challenge.quote.runId); expect(result.status).toBe('receipt_pending');
    expect(JSON.parse(result.result!.output)).toEqual({ sha256: createHash('sha256').update('x402-actual-cpu').digest('hex') });
    const chainTimestamp = (await f.local.publicClient.getBlock()).timestamp, endedAt = BigInt(result.settlement!.endedAt),
      closed = ((chainTimestamp > endedAt ? chainTimestamp : endedAt) / 3600n + 1n) * 3600n + 2n;
    await f.test.setNextBlockTimestamp({ timestamp: closed }); await f.test.mine({ blocks: 1 }); await service.drain();
    const completed = await service.get(f.accounts.owner.address, challenge.quote.runId);
    expect(completed.status, JSON.stringify({ error: completed.errorCode, endedAt: result.settlement!.endedAt, chainNow: await bridge.now() })).toBe('completed'); expect(BigInt(completed.charged!)).toBeGreaterThan(0n);
    expect(BigInt(completed.charged!) + BigInt(completed.refund!)).toBe(2725n);
    expect((await service.get(f.accounts.owner.address, challenge.quote.runId)).charged).toBe(completed.charged); await service.drain(); expect(env.cpu.starts).toBe(1);
    const ownerBefore = z.bigint().parse((await balances(f))[0]);
    await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformX402EscrowV1').abi, functionName: 'withdraw', args: [BigInt(completed.refund!)] }));
    expect(z.bigint().parse((await balances(f))[0]) - ownerBefore).toBe(BigInt(completed.refund!));
    expect((await sdk.intent(request, payload, 'paid-cpu')).transaction).toEqual(intent.transaction);
  } finally { await env.close(); }
}, 120_000);

it.each(['exact', 'upto'] as const)('%s original authorization survives failed admissions atomically and cannot be extracted, redirected, cancelled into credit or reused across methods', async scheme => {
  const f = await deployX402CpuRuntime(randomId(), artifacts);
  try {
    const scope = await leash(f), q = await signed(f, scope, scheme), payload = await payment(f, q), call = x402CpuOpenCall(f.pins, q.quote, q.signature, [], [], q.ceiling, q.reservation, payload),
      before = await balances(f), snapshot = await f.test.snapshot();
    const writeToken = async (name: string, args: readonly unknown[]) => f.local.publicClient.waitForTransactionReceipt({ hash: await f.owner.writeContract({ address: f.pins.tokenAddress,
      abi: f.artifact('LocalReceiveToken').abi, functionName: name, args, gas: 1_000_000n }) });
    if ('authorization' in payload.payload) {
      const a = payload.payload.authorization, signature = parseSignature(payload.payload.signature), args = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(signature.v), signature.r, signature.s];
      expect((await writeToken('receiveWithAuthorization', args)).status).toBe('reverted');
      expect((await writeToken('transferWithAuthorization', args)).status).toBe('reverted');
      const wrongTypeSignature = await f.accounts.owner.signTypedData({ domain: { name: 'Local Receive Fixture', version: '1', chainId: 31337, verifyingContract: f.pins.tokenAddress },
        primaryType: 'TransferWithAuthorization', types: EIP3009_TYPES, message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } });
      const wrongPayload = { ...payload, payload: { ...payload.payload, signature: wrongTypeSignature } };
      expect((await send(f, x402CpuOpenCall(f.pins, q.quote, q.signature, [], [], q.ceiling, q.reservation, wrongPayload))).status).toBe('reverted');
    } else {
      const a = payload.payload.permit2Authorization;
      const direct = await f.owner.writeContract({ address: f.proxy, abi: f.artifact('x402UptoPermit2Proxy').abi, functionName: 'settle', gas: 1_000_000n,
        args: [{ permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) }, 2725n, a.from,
          { ...a.witness, validAfter: BigInt(a.witness.validAfter) }, payload.payload.signature] });
      expect((await f.local.publicClient.waitForTransactionReceipt({ hash: direct })).status).toBe('reverted');
    }
    expect(await balances(f)).toEqual(before);
    const otherReservation = { ...q.reservation, scheme: scheme === 'exact' ? 'upto' as const : 'exact' as const,
      maximum: scheme === 'exact' ? '10000' : '2725' }, otherPayment = await payment(f, { ...q, reservation: otherReservation });
    expect((await send(f, x402CpuOpenCall(f.pins, q.quote, q.signature, [], [], q.ceiling, otherReservation,
      { ...otherPayment, payload: { ...otherPayment.payload, signature: payload.payload.signature } }))).status).toBe('reverted');
    expect(await balances(f)).toEqual(before);
    await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformX402EscrowV1').abi, functionName: 'updateLeash', args: [scope.id, { ...scope.terms, maxPerHour: 200_000n }] }));
    expect((await send(f, call)).status).toBe('reverted'); expect(await balances(f)).toEqual(before);
    await f.test.revert({ id: snapshot });
    const expiredSnapshot = await f.test.snapshot();
    await f.test.setNextBlockTimestamp({ timestamp: BigInt(q.quote.quoteExpiry + 1) }); await f.test.mine({ blocks: 1 });
    expect((await send(f, call)).status).toBe('reverted'); expect(await balances(f)).toEqual(before);
    await f.test.revert({ id: expiredSnapshot });
    const capSnapshot = await f.test.snapshot(), cap = 500_000_000_000n;
    await f.confirmed(f.owner.writeContract({ address: f.pins.tokenAddress, abi: f.artifact('LocalReceiveToken').abi, functionName: 'faucet', args: [f.accounts.owner.address, cap] }));
    await f.confirmed(f.owner.writeContract({ address: f.pins.tokenAddress, abi: f.artifact('LocalReceiveToken').abi, functionName: 'approve', args: [f.pins.escrowAddress, cap] }));
    await f.confirmed(f.owner.writeContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformX402EscrowV1').abi, functionName: 'deposit', args: [cap] }));
    const capBalances = await balances(f); expect((await send(f, call)).status).toBe('reverted'); expect(await balances(f)).toEqual(capBalances);
    await f.test.revert({ id: capSnapshot });
    const invalidQuote = { ...q.quote, workloadHash: randomId() }, decoded = decodeFunctionData({ abi: x402CpuEscrowAbi, data: call });
    let changedCall: Hex;
    if (decoded.functionName === 'openRunFromX402Exact') changedCall = encodeFunctionData({ abi: x402CpuEscrowAbi, functionName: decoded.functionName,
      args: [typedPlatformQuote(invalidQuote), decoded.args[1], decoded.args[2], decoded.args[3], decoded.args[4], decoded.args[5], decoded.args[6]] });
    else if (decoded.functionName === 'openRunFromX402Upto') changedCall = encodeFunctionData({ abi: x402CpuEscrowAbi, functionName: decoded.functionName,
      args: [typedPlatformQuote(invalidQuote), decoded.args[1], decoded.args[2], decoded.args[3], decoded.args[4], decoded.args[5], decoded.args[6], decoded.args[7]] });
    else throw new Error('Fixture opening selector missing');
    expect((await send(f, changedCall)).status).toBe('reverted'); expect(await balances(f)).toEqual(before);
    const low = await leash(f, 2500n), lowQuote = await signed(f, low, scheme), lowPayment = await payment(f, lowQuote), lowCall = x402CpuOpenCall(f.pins, lowQuote.quote, lowQuote.signature, [], [], lowQuote.ceiling, lowQuote.reservation, lowPayment);
    expect((await send(f, lowCall)).status).toBe('reverted'); expect(await balances(f)).toEqual(before);
    const nonce = x402AuthorizationNonce(f.pins, q.quote, q.reservation);
    if (scheme === 'exact') {
      const signature = await f.accounts.owner.signTypedData({ domain: { name: 'Local Receive Fixture', version: '1', chainId: 31337, verifyingContract: f.pins.tokenAddress },
        primaryType: 'CancelAuthorization', types: { CancelAuthorization: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }] }, message: { authorizer: f.accounts.owner.address, nonce } });
      const sig = parseSignature(signature); await f.confirmed(f.owner.writeContract({ address: f.pins.tokenAddress, abi: f.artifact('LocalReceiveToken').abi,
        functionName: 'cancelAuthorization', args: [f.accounts.owner.address, nonce, Number(sig.v), sig.r, sig.s] }));
    } else await f.confirmed(f.owner.writeContract({ address: f.permit2, abi: f.artifact('Permit2').abi, functionName: 'invalidateUnorderedNonces', args: [BigInt(nonce) >> 8n, 1n << (BigInt(nonce) & 255n)] }));
    expect((await send(f, call)).status).toBe('reverted'); expect(await balances(f)).toEqual(before);
    expect(await f.local.publicClient.readContract({ address: f.pins.escrowAddress, abi: f.artifact('PlatformX402EscrowV1').abi, functionName: 'availableBalance', args: [f.accounts.owner.address] })).toBe(0n);
  } finally { await f.close(); }
}, 120_000);

it.each(['exact', 'upto'] as const)('%s reorg after real CPU execution cannot replace original funded admission with an identical balance-funded run or publish/settle its result', async scheme => {
  const env = await setup();
  try {
    const request = env.request(scheme), challenge = await env.sdk.challenge(request, 'reorg'), payload = await payment(env.f, challenge), intent = await env.sdk.intent(request, payload, 'reorg'), snapshot = await env.f.test.snapshot();
    const opened = await send(env.f, intent.transaction.data as Hex); await env.sdk.admit(intent, opened.transactionHash, 'admit'); await env.service.drain();
    expect(env.cpu.starts).toBe(1); expect((await env.service.get(env.f.accounts.owner.address, challenge.quote.runId)).status).toBe('receipt_pending');
    await env.f.test.revert({ id: snapshot });
    await env.f.confirmed(env.f.owner.writeContract({ address: env.f.pins.tokenAddress, abi: env.f.artifact('LocalReceiveToken').abi, functionName: 'approve', args: [env.f.pins.escrowAddress, 2725n] }));
    await env.f.confirmed(env.f.owner.writeContract({ address: env.f.pins.escrowAddress, abi: env.f.artifact('PlatformX402EscrowV1').abi, functionName: 'deposit', args: [2725n] }));
    await env.f.confirmed(env.f.owner.writeContract({ address: env.f.pins.escrowAddress, abi: env.f.artifact('PlatformX402EscrowV1').abi, functionName: 'openRun',
      args: [typedPlatformQuote(challenge.quote), challenge.signature, challenge.imageProof, challenge.regionProof] }));
    const observed = await env.service.get(env.f.accounts.owner.address, challenge.quote.runId);
    expect(observed.status).toBe('reconciliation'); expect(observed.charged).toBeNull(); expect(observed.refund).toBeNull();
    const closed = ((await env.f.local.publicClient.getBlock()).timestamp / 3600n + 1n) * 3600n + 2n;
    await env.f.test.setNextBlockTimestamp({ timestamp: closed }); await env.f.test.mine({ blocks: 1 }); await env.service.drain();
    expect(env.cpu.starts).toBe(1); expect((await env.store.db.select().from(platformReceiptEntries).where(eq(platformReceiptEntries.runId, challenge.quote.runId)))).toHaveLength(0);
    expect((await env.service.get(env.f.accounts.owner.address, challenge.quote.runId)).charged).toBeNull();
    const replay = await env.sdk.intent(request, payload, 'reorg'); expect(replay.transaction).toEqual(intent.transaction);
    expect(replay.challenge.reservation).toEqual(challenge.reservation); expect(hashJson(payload)).toBe(replay.paymentHash);
    expect((await env.store.db.select().from(platformX402Challenges))).toHaveLength(1); expect((await env.store.db.select().from(platformRuns))).toHaveLength(1);
  } finally { await env.close(); }
}, 120_000);
