import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { Problem, randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { receiptPair } from '../src/receipts/merkle.js';
import { PlatformReceiptService, platformReceiptRootAbi } from '../src/receipts/platform-service.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { platformHostLeases, platformRuns } from '../src/platform-runtime/schema.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { platformEscrowAbi, platformHostSchema, platformPinsSchema, platformPreparedSchema, typedPlatformQuote, type PlatformPrepared } from '../src/platform-runtime/types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

describe('real platform HTTP client, owner authentication and signed openRun scopes', () => {
  let fixture: Awaited<ReturnType<typeof deployPlatformRuntime>>, store: Awaited<ReturnType<typeof openStore>>;
  let bridge: PlatformBridge, service: PlatformRuntimeService, receipts: PlatformReceiptService, auth: Auth, server: Server, app: Hono;
  let token: string, otherToken: string, origin: string, now: number, client: PlatformRuntimeClient;
  let leashId: Hex, prepared: PlatformPrepared;
  let capacityReserved: PlatformPrepared, capacityTransaction: Hex;
  const digest = 'sha256:' + 'a'.repeat(64), region = 'test-one';
  const input = () => ({ leashId, task: { kind: 'sha256' as const, text: 'real scoped owner application' }, maxSeconds: 3,
    deadline: now + 90, maxSpend: '331', regions: [region] });
  const leaf = (value: Hex) => keccak256(keccak256(value));
  const factory = (mutate?: (path: string, value: unknown) => unknown, sessionToken = token) => new PlatformRuntimeClient({
    baseUrl: origin, pins: fixture.pins, sessionToken, nowSeconds: () => now,
    ...(mutate ? { fetch: async (url, init) => {
      const response = await fetch(url, init), value: unknown = await response.json();
      return new Response(JSON.stringify(mutate(new URL(String(url)).pathname, value)), { status: response.status, headers: response.headers });
    } } : {}),
  });
  beforeAll(async () => {
    fixture = await deployPlatformRuntime(randomId());
    store = await openStore({ DATA_DIR: ':memory:' });
    bridge = new PlatformBridge(store.db, { pins: fixture.pins, rpcUrl: fixture.local.rpcUrl, signerPrivateKey: fixture.keys.signer });
    now = (Math.floor(await bridge.now() / 3600) + 1) * 3600 + 300;
    await fixture.test.setNextBlockTimestamp({ timestamp: BigInt(now) }); await fixture.test.mine({ blocks: 1 });
    leashId = randomId();
    const imageHash = keccak256(toHex(digest)), imageSibling = leaf(keccak256(toHex('sha256:' + 'b'.repeat(64))));
    const regionHash = keccak256(toHex(region)), regionSibling = leaf(keccak256(toHex('test-other')));
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: fixture.artifact('PlatformRunEscrow').abi,
      functionName: 'createLeash', args: [leashId, { agent: fixture.accounts.owner.address, maxPerHour: 1_000_000n,
        maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false, imageAllowRoot: receiptPair(leaf(imageHash), imageSibling),
        regionAllowRoot: receiptPair(leaf(regionHash), regionSibling), expiry: BigInt(now + 3600) }] }));
    const host = platformHostSchema.parse({ hostId: fixture.hostId, hostKey: (await bridge.host(fixture.hostId)).hostKey,
      hardwareClass: 'cpu', region, imageDigest: digest, image: 'telomere/test@' + digest, sealed: false, lane: 'standard',
      pricePerSecond: '101', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: now,
      imageProof: [imageSibling], regionProof: [regionSibling] });
    receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: fixture.pins.escrowAddress,
      receiptRootAddress: fixture.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    await receipts.initialize();
    const executor = new PlatformHostExecutor(store.db, new Map());
    // This SDK fixture has no HostKit service; transport admission is covered by platform-runtime.test.ts.
    vi.spyOn(executor, 'capacityAvailable').mockResolvedValue(true);
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts);
    await service.initialize();
    app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_input' : 'service_unavailable' },
      error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Wrong owner origin');
      await next();
    });
    app.get('/api/me', async context => context.json({ address: await auth.owner(getCookie(context, 'telomere_session')), demo: true }));
    app.route('/api/platform', createPlatformRuntimeRoutes(service, context => auth.owner(getCookie(context, 'telomere_session'))));
    server = createServer(getRequestListener(app.fetch)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing actual HTTP address');
    origin = 'http://127.0.0.1:' + address.port;
    const config = loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: fixture.local.rpcUrl,
      SIGNER_PRIVATE_KEY: fixture.keys.signer, DEMO_PRIVATE_KEY: fixture.keys.owner,
      ESCROW_ADDRESS: fixture.pins.escrowAddress, TOKEN_ADDRESS: fixture.pins.tokenAddress });
    auth = new Auth(store.db, config); token = await auth.session(fixture.accounts.owner.address); otherToken = await auth.session(fixture.accounts.outsider.address);
    client = factory(); prepared = await client.quote(input(), 'real-quote');
  }, 120000);
  afterAll(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await store?.close(); await fixture?.close();
  });
  it('reads reviewed config and real token balance; verifies signed quote, rounded fee and both nonempty proofs without an owner transaction', async () => {
    const nonce = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.owner.address });
    expect((await client.config()).pins).toEqual(platformPinsSchema.parse(fixture.pins)); expect(await client.balance()).toEqual({ available: '1000000' });
    prepared = await client.quote(input(), 'real-quote');
    expect(prepared.ceiling).toBe('331'); expect(prepared.imageProof).toHaveLength(1); expect(prepared.regionProof).toHaveLength(1);
    expect(await bridge.ceiling(prepared.quote, false)).toBe(331n); expect(await client.openPlan(prepared)).toEqual(prepared.transaction);
    expect(Object.isFrozen(prepared.quote)).toBe(true); expect(Object.isFrozen(prepared.imageProof)).toBe(true);
    expect(await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.owner.address })).toBe(nonce);
    expect((await bridge.run(prepared.quote.runId)).status).toBe(0);
    const serialized = JSON.stringify(await client.config()); expect(serialized).not.toContain(fixture.keys.signer); expect(serialized).not.toContain('endpoint');
  });
  it('rejects a signed wallet plan that selects a host excluded by its quote input', async () => {
    const excluded = { ...prepared, input: { ...prepared.input, excludedHostIds: [prepared.quote.hostId] } };
    await expect(factory().openPlan(excluded)).rejects.toThrow('quote changed');
    await expect(factory().quote({ ...input(), excludedHostIds: [prepared.quote.hostId] }, 'exclude-only-host'))
      .rejects.toMatchObject({ code: 'deadline_infeasible' });
  });
  it('requires the explicit NEAR inference marker when the API advertises a NEAR configuration', async () => {
    const changed = factory((path, value) => path.endsWith('/config')
      ? { ...(value as object), near: { model: 'reviewed-model', maxTokens: 16, policySha256: randomId(), inferencePrice: '1' } }
      : value);
    await expect(changed.config()).rejects.toThrow('nearInferenceTask');
  });
  it('singleflights the same request and preserves server idempotency after a lost HTTP response', async () => {
    const [one, two] = await Promise.all([client.quote(input(), 'same-work'), client.quote(input(), 'same-work')]);
    expect(one.quote.runId).toBe(two.quote.runId);
    await expect(client.quote({ ...input(), maxSpend: '332' }, 'same-work')).rejects.toThrow('different work');
    let dropped = false;
    const retry = factory((path, value) => { if (path.endsWith('/quotes') && !dropped) { dropped = true; throw new Error('Lost acknowledged HTTP response'); } return value; });
    await expect(retry.quote(input(), 'lost-http')).rejects.toThrow('Lost acknowledged');
    const resumed = await retry.quote(input(), 'lost-http');
    expect((await service.quote(fixture.accounts.owner.address, input(), 'lost-http')).quote.runId).toBe(resumed.quote.runId);
  });
  it.each(['escrowAddress', 'tokenAddress', 'quoteSigner', 'receiptRootAddress', 'hostRegistryAddress', 'feeRouterAddress',
    'tokenCodeHash', 'escrowCodeHash', 'receiptRootCodeHash', 'hostRegistryCodeHash', 'feeRouterCodeHash', 'chainId'] as const)('rejects changed reviewed pin %s before preparing a quote', async key => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/config')) return value;
      const response = structuredClone(service.publicConfig());
      if (key === 'chainId') response.pins.chainId = 84532;
      else if (key.endsWith('CodeHash')) Reflect.set(response.pins, key, randomId());
      else Reflect.set(response.pins, key, fixture.accounts.outsider.address);
      return response;
    });
    await expect(changed.quote(input(), 'bad-pin-' + key)).rejects.toThrow(key === 'chainId' ? 'reviewed deployment pins' : 'reviewed pins');
  });
  it.each(['signature', 'payer', 'task', 'inputSpend', 'price', 'ceiling', 'host', 'image', 'region', 'expiry', 'inference',
    'imageProof', 'regionProof', 'destination', 'chain', 'calldata', 'value'])('rejects response tampering: %s', async kind => {
    let mutated = false;
    const changed = factory((path, value) => {
      if (!path.endsWith('/quotes')) return value;
      const response = platformPreparedSchema.parse(value); mutated = true;
      switch (kind) {
        case 'signature': response.signature = '0x' + '1'.repeat(130) as Hex; break;
        case 'payer': response.quote.payer = fixture.accounts.outsider.address; break;
        case 'task': response.input.task = { kind: 'sha256', text: 'other work' }; break;
        case 'inputSpend': response.input.maxSpend = '999999'; break;
        case 'price': response.quote.pricePerSecond = '102'; break;
        case 'ceiling': response.ceiling = '330'; break;
        case 'host': response.quote.hostId = randomId(); break;
        case 'image': response.quote.imageHash = randomId(); break;
        case 'region': response.quote.regionHash = randomId(); break;
        case 'expiry': response.quote.quoteExpiry = now - 1; break;
        case 'inference': Reflect.set(response.quote, 'inferencePrice', '1'); break;
        case 'imageProof': response.imageProof = []; break;
        case 'regionProof': response.regionProof = []; break;
        case 'destination': response.transaction.to = fixture.accounts.outsider.address; break;
        case 'chain': response.transaction.chainId = 84532; break;
        case 'calldata': response.transaction.data += '00'; break;
        case 'value': Reflect.set(response.transaction, 'value', '1'); break;
      }
      return response;
    });
    await expect(changed.quote(input(), 'tamper-' + kind)).rejects.toThrow();
    expect(mutated).toBe(true);
  });
  it('opens exactly the reviewed reservation explicitly in the fixture wallet, admits and reads only its owner', async () => {
    const plan = await client.openPlan(prepared);
    const transaction = await fixture.confirmed(fixture.owner.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n }));
    const result = await client.admit({ runId: prepared.quote.runId, transactionHash: transaction.transactionHash }, 'admit-original');
    expect(result.status).toBe('queued'); expect(result.admissionTx).toBe(transaction.transactionHash);
    expect((await bridge.run(prepared.quote.runId)).status).toBe(1); expect(await client.balance()).toEqual({ available: '999669' });
    expect((await client.get(prepared.quote.runId)).quote.runId).toBe(prepared.quote.runId);
    expect((await client.list()).runs.some(run => run.id === prepared.quote.runId)).toBe(true);
    await expect(factory(undefined, otherToken).get(prepared.quote.runId)).rejects.toMatchObject({ status: 404 });
    expect((await factory(undefined, otherToken).list()).runs).toEqual([]);
    const nonce = await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.owner.address });
    expect((await client.stopPlan(prepared.quote.runId, 'stop-plan')).data).toBe(encodeFunctionData({ abi: platformEscrowAbi, functionName: 'requestStop', args: [prepared.quote.runId] }));
    expect((await client.refundPlan(prepared.quote.runId, 'refund-plan')).data).toBe(encodeFunctionData({ abi: platformEscrowAbi, functionName: 'refundRun', args: [prepared.quote.runId] }));
    expect(await fixture.local.publicClient.getTransactionCount({ address: fixture.accounts.owner.address })).toBe(nonce);
  });
  it('rejects altered owner stop/refund transactions without invoking a signer', async () => {
    const changed = factory((path, value) => path.endsWith('/stop') || path.endsWith('/refund')
      ? { chainId: 31337, to: fixture.pins.escrowAddress, data: encodeFunctionData({ abi: platformEscrowAbi, functionName: 'refundRun', args: [randomId()] }), value: '0' } : value);
    await expect(changed.stopPlan(prepared.quote.runId, 'bad-stop')).rejects.toThrow('calldata');
    await expect(changed.refundPlan(prepared.quote.runId, 'bad-refund')).rejects.toThrow('calldata');
  });
  it('rejects an API run DTO with an inference charge absent from its signed quote', async () => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/runs/' + prepared.quote.runId)) return value;
      return { ...(value as object), settlement: { runId: prepared.quote.runId, billableSeconds: 1,
        endedAt: now, inferenceCharge: '1', receiptHash: randomId() } };
    });
    await expect(changed.get(prepared.quote.runId)).rejects.toThrow('inference charge');
  });
  it('rejects CPU-second billing in a NEAR inference-only run DTO', async () => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/runs/' + prepared.quote.runId)) return value;
      return { ...(value as object), executionKind: 'near_inference', settlement: { runId: prepared.quote.runId,
        billableSeconds: 1, endedAt: now, inferenceCharge: '0', receiptHash: randomId() } };
    });
    await expect(changed.get(prepared.quote.runId)).rejects.toThrow('cannot bill CPU seconds');
  });
  it('requires actual auth and idempotency; enforces declared/streamed 32KiB and strict owner request fields', async () => {
    expect((await fetch(origin + '/api/platform/config')).status).toBe(401);
    const headers = { Origin: origin, Cookie: 'telomere_session=' + token, 'Content-Type': 'application/json' };
    expect((await fetch(origin + '/api/platform/quotes', { method: 'POST', headers, body: JSON.stringify(input()) })).status).toBe(422);
    expect((await fetch(origin + '/api/platform/quotes', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'extra-owner' },
      body: JSON.stringify({ ...input(), owner: fixture.accounts.outsider.address }) })).status).toBe(422);
    const oversized = await app.request(origin + '/api/platform/quotes', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'large', 'Content-Length': '32769' }, body: '{}' });
    expect(oversized.status).toBe(422); expect(await oversized.json()).toMatchObject({ title: 'platform_body_limit' });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32769)); controller.close(); } });
    const streamOptions: RequestInit & { duplex: 'half' } = { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'stream-large' }, body: stream, duplex: 'half' };
    const streamed = await app.fetch(new Request(origin + '/api/platform/quotes', streamOptions));
    expect(streamed.status).toBe(422); expect(await streamed.json()).toMatchObject({ title: 'platform_body_limit' });
    await auth.logout(otherToken); await expect(factory(undefined, otherToken).config()).rejects.toMatchObject({ status: 401 });
  });
  it('calldata independently contains the exact new quote and both allowlist proofs', () => {
    expect(prepared.transaction.data).toBe(encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun',
      args: [typedPlatformQuote(prepared.quote), prepared.signature, prepared.imageProof, prepared.regionProof] }));
  });
  it('guards33 real accepted outcomes against premature sealing and drains every page to conserved settlement', async () => {
    const accepted = [prepared.quote.runId];
    for (let index = 0; index < 32; index++) {
      const next = await service.quote(fixture.accounts.owner.address, input(), 'sealing-page-' + index);
      const transaction = await fixture.confirmed(fixture.owner.sendTransaction({ to: next.transaction.to, data: next.transaction.data as Hex, value: 0n }));
      await service.admit(fixture.accounts.owner.address, { runId: next.quote.runId, transactionHash: transaction.transactionHash }, 'sealing-admit-' + index);
      accepted.push(next.quote.runId);
    }
    // Fault injection: crash after the durable claim and before any signed host lease/admission.
    await store.db.update(platformRuns).set({ status: 'running' }).where(inArray(platformRuns.id, accepted));
    await service.initialize();
    const outcomes = await store.db.select().from(platformRuns).where(inArray(platformRuns.id, accepted));
    expect(outcomes).toHaveLength(33);
    const hour = Math.floor(now / 3600);
    for (const row of outcomes) {
      expect(row.status).toBe('receipt_pending'); expect(row.settlement?.billableSeconds).toBe(0);
      expect(Math.floor((row.settlement?.endedAt ?? 0) / 3600)).toBe(hour);
    }
    for (const row of outcomes.slice(0, 32)) {
      if (!row.settlement) throw new Error('Real recovered outcome missing'); await receipts.record(row.owner, row.settlement);
    }
    await fixture.test.setNextBlockTimestamp({ timestamp: BigInt((hour + 1) * 3600 + 1) }); await fixture.test.mine({ blocks: 1 });
    expect(await service.canSeal(hour)).toBe(false); await receipts.publish(hour);
    expect((await bridge.public.readContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'getRoot', args: [BigInt(hour)] })).count).toBe(0);
    await service.drain(); expect(await service.canSeal(hour)).toBe(false);
    expect((await bridge.public.readContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'getRoot', args: [BigInt(hour)] })).count).toBe(0);
    await service.drain();
    expect((await bridge.public.readContract({ address: fixture.pins.receiptRootAddress, abi: platformReceiptRootAbi, functionName: 'getRoot', args: [BigInt(hour)] })).count).toBe(33);
    await service.drain();
    const finished = await store.db.select().from(platformRuns).where(inArray(platformRuns.id, accepted));
    expect(finished.every(row => row.status === 'completed' && row.charged === '0' && row.refund === '331')).toBe(true);
    expect(await bridge.balance(fixture.accounts.owner.address)).toEqual({ available: '1000000' });
    expect(await bridge.public.readContract({ address: fixture.pins.escrowAddress, abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'totalReserved' })).toBe(0n);
    expect((await bridge.host(fixture.hostId)).openRuns).toBe(0n);
    const last = outcomes[32]; if (!last?.settlement) throw new Error('The33rd real recovered outcome is missing');
    const [unchanged] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, last.id));
    expect(unchanged?.settlement).toEqual(last.settlement);
  }, 60000);
  it('excludes expired unopened quote inventory from the owner64 cap and keeps the original idempotent quote immutable', async () => {
    now = await bridge.now(); const request = input();
    const original = await service.quote(fixture.accounts.owner.address, request, 'expired-policy-original');
    await fixture.test.setNextBlockTimestamp({ timestamp: BigInt(original.quote.quoteExpiry + 1) }); await fixture.test.mine({ blocks: 1 });
    now = await bridge.now();
    const [source] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, original.quote.runId));
    if (!source) throw new Error('Actual prepared quote was not durable');
    // Nonfinancial inventory fixtures exercise only the SQL cap predicate. They are never signed/admitted/executed.
    const ids = Array.from({ length: 64 }, () => randomId());
    await store.db.insert(platformRuns).values(ids.map((id, index) => ({ ...source, id, idemKey: 'test-expired-inventory-' + index,
      quote: { ...source.quote, runId: id, quoteExpiry: now - 1 } })));
    try {
      const next = await service.quote(fixture.accounts.owner.address, input(), 'expired-policy-next');
      expect(next.quote.runId).not.toBe(original.quote.runId);
      expect(await service.quote(fixture.accounts.owner.address, request, 'expired-policy-original')).toEqual(original);
      await expect(service.quote(fixture.accounts.owner.address, { ...request, maxSpend: '332' }, 'expired-policy-original'))
        .rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
      expect((await bridge.run(original.quote.runId)).status).toBe(0);
      expect(await bridge.balance(fixture.accounts.owner.address)).toEqual({ available: '1000000' });
    } finally { await store.db.delete(platformRuns).where(inArray(platformRuns.id, ids)); }
  });
  it('enforces the global256 admission cap on a real funded reservation without queuing or dispatching it', async () => {
    now = await bridge.now();
    capacityReserved = await service.quote(fixture.accounts.owner.address, input(), 'capacity-real-quote');
    const receipt = await fixture.confirmed(fixture.owner.sendTransaction({ to: capacityReserved.transaction.to,
      data: capacityReserved.transaction.data as Hex, value: 0n }));
    capacityTransaction = receipt.transactionHash;
    const [source] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, capacityReserved.quote.runId));
    if (!source) throw new Error('Actual funded quote was not durable');
    // Synthetic rows represent count-only global inventory, not financial or execution acceptance.
    const ids = Array.from({ length: 256 }, () => randomId());
    await store.db.insert(platformRuns).values(ids.map((id, index) => ({ ...source, id,
      owner: fixture.accounts.outsider.address.toLowerCase(), idemKey: 'test-global-inventory-' + index,
      quote: { ...source.quote, runId: id, payer: fixture.accounts.outsider.address }, status: 'queued' as const })));
    try {
      await bridge.verifyAdmission(capacityReserved.quote, capacityReserved.ceiling, capacityTransaction);
      await expect(service.admit(fixture.accounts.owner.address, { runId: capacityReserved.quote.runId, transactionHash: capacityTransaction }, 'capacity-real-admit'))
        .rejects.toMatchObject({ status: 429, code: 'platform_capacity_limit' });
      const [unchanged] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, capacityReserved.quote.runId));
      expect(unchanged?.status).toBe('prepared'); expect(unchanged?.admissionTx).toBeNull();
      expect(await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, capacityReserved.quote.runId))).toEqual([]);
      expect((await bridge.run(capacityReserved.quote.runId)).status).toBe(1);
      expect(await bridge.balance(fixture.accounts.owner.address)).toEqual({ available: '999669' });
      expect((await store.db.select().from(platformRuns).where(inArray(platformRuns.status,
        ['queued', 'running', 'receipt_pending', 'settling', 'reconciliation']))).length).toBe(256);
    } finally { await store.db.delete(platformRuns).where(inArray(platformRuns.id, ids)); }
  });
  it('rejects late admission into an already published financial hour and preserves the real timeout refund', async () => {
    now = await bridge.now();
    const witness = await service.quote(fixture.accounts.owner.address, input(), 'late-hour-witness');
    const transaction = await fixture.confirmed(fixture.owner.sendTransaction({ to: witness.transaction.to, data: witness.transaction.data as Hex, value: 0n }));
    await service.admit(fixture.accounts.owner.address, { runId: witness.quote.runId, transactionHash: transaction.transactionHash }, 'late-witness-admit');
    await store.db.update(platformRuns).set({ status: 'running' }).where(eq(platformRuns.id, witness.quote.runId)); await service.initialize();
    const [row] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, witness.quote.runId));
    if (!row?.settlement) throw new Error('Actual late-hour witness outcome is missing');
    const hour = Math.floor(row.settlement.endedAt / 3600);
    const reservedRun = await bridge.run(capacityReserved.quote.runId);
    expect(Math.floor(Number(reservedRun.openedAt) / 3600)).toBe(hour);
    await fixture.test.setNextBlockTimestamp({ timestamp: BigInt((hour + 1) * 3600 + 1) }); await fixture.test.mine({ blocks: 1 });
    await receipts.record(row.owner, row.settlement); await receipts.publish(hour); await service.drain();
    expect(await bridge.hourPublished(hour)).toBe(true);
    await expect(service.admit(fixture.accounts.owner.address, { runId: capacityReserved.quote.runId, transactionHash: capacityTransaction }, 'late-real-admit'))
      .rejects.toMatchObject({ status: 409, code: 'platform_admission_late' });
    const [pending] = await store.db.select().from(platformRuns).where(eq(platformRuns.id, capacityReserved.quote.runId));
    expect(pending?.status).toBe('prepared'); expect(pending?.admissionTx).toBeNull();
    expect(await store.db.select().from(platformHostLeases).where(eq(platformHostLeases.runId, capacityReserved.quote.runId))).toEqual([]);
    const reservation = await bridge.run(capacityReserved.quote.runId);
    await fixture.test.setNextBlockTimestamp({ timestamp: reservation.openedAt + reservation.maxSeconds + 21601n }); await fixture.test.mine({ blocks: 1 });
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'refundRun', args: [capacityReserved.quote.runId] }));
    expect((await bridge.run(capacityReserved.quote.runId)).status).toBe(3);
    expect(await bridge.balance(fixture.accounts.owner.address)).toEqual({ available: '1000000' });
  }, 60000);
});
