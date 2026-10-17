import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { Problem, randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { compileContracts } from '../scripts/compile-contracts.js';
import { receiptPair } from '../src/receipts/merkle.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { PlatformVaultRuntimeClient, platformVaultClientAbi, platformVaultRuntimeConfigSchema, type PlatformVaultBinding } from '../src/platform-runtime/vault-client.js';
import { platformEscrowAbi, platformHostSchema, platformPreparedSchema, type PlatformPrepared } from '../src/platform-runtime/types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

describe('Vault Node SDK over authenticated real HTTP and immutable Selection contracts', () => {
  let fixture: Awaited<ReturnType<typeof deployPlatformRuntime>>, vault: Awaited<ReturnType<typeof deployPlatformVault>>;
  let store: Awaited<ReturnType<typeof openStore>>, bridge: PlatformBridge, service: PlatformRuntimeService, vaults: PlatformVaultBridge;
  let wrapper: PlatformVaultRuntimeService, receipts: PlatformReceiptService, auth: Auth, app: Hono, server: Server;
  let ownerToken: string, agentToken: string, outsiderToken: string, origin: string, now: number;
  let binding: PlatformVaultBinding, prepared: PlatformPrepared, admittedTx: Hex;
  const digest = 'sha256:' + 'a'.repeat(64), region = 'test-one';
  const input = () => ({ leashId: binding.leashId, task: { kind: 'sha256' as const, text: 'agent selects real scoped CPU host' },
    maxSeconds: 3, deadline: now + 90, maxSpend: '331', regions: [region] });
  const factory = (mutate?: (path: string, value: unknown) => unknown, sessionToken = agentToken) => new PlatformVaultRuntimeClient({
    baseUrl: origin, pins: fixture.pins, vaultPins: vault.pins, vault: binding.vault, binding, sessionToken, nowSeconds: () => now,
    ...(mutate ? { fetch: async (url, init) => {
      const response = await fetch(url, init), value: unknown = await response.json();
      return new Response(JSON.stringify(mutate(new URL(String(url)).pathname, value)), { status: response.status, headers: response.headers });
    } } : {}),
  });
  beforeAll(async () => {
    const artifacts = compileContracts(); artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
    fixture = await deployPlatformRuntime(randomId(), artifacts); vault = await deployPlatformVault(fixture);
    store = await openStore({ DATA_DIR: ':memory:' });
    bridge = new PlatformBridge(store.db, { pins: fixture.pins, rpcUrl: fixture.local.rpcUrl, signerPrivateKey: fixture.keys.signer });
    now = (Math.floor(await bridge.now() / 3600) + 1) * 3600 + 300;
    await fixture.test.setNextBlockTimestamp({ timestamp: BigInt(now) }); await fixture.test.mine({ blocks: 1 });
    vaults = new PlatformVaultBridge(bridge, vault.pins); binding = await vaults.authorize(vault.account.address, vault.agent.vault, 'run');
    const leaf = (value: Hex) => keccak256(keccak256(value));
    const imageHash = keccak256(toHex(digest)), imageSibling = leaf(keccak256(toHex('sha256:' + 'b'.repeat(64))));
    const regionHash = keccak256(toHex(region)), regionSibling = leaf(keccak256(toHex('test-other')));
    await fixture.confirmed(fixture.owner.writeContract({ address: binding.vault, abi: fixture.artifact('PlatformAgentVault').abi,
      functionName: 'setScope', args: [{ classMask: 1n, sealedOnly: false, imageAllowRoot: receiptPair(leaf(imageHash), imageSibling),
        regionAllowRoot: receiptPair(leaf(regionHash), regionSibling) }] }));
    const host = platformHostSchema.parse({ hostId: fixture.hostId, hostKey: (await bridge.host(fixture.hostId)).hostKey,
      hardwareClass: 'cpu', region, imageDigest: digest, image: 'telomere/test@' + digest, sealed: false, lane: 'standard',
      pricePerSecond: '101', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: now,
      imageProof: [imageSibling], regionProof: [regionSibling] });
    receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: fixture.pins.escrowAddress,
      receiptRootAddress: fixture.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    await receipts.initialize();
    const executor = new PlatformHostExecutor(store.db, new Map());
    // This SDK fixture has no HostKit service; transport admission is covered by paid runtime tests.
    vi.spyOn(executor, 'capacityAvailable').mockResolvedValue(true);
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts, vaults);
    await service.initialize(); wrapper = new PlatformVaultRuntimeService(service, vaults);
    app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_input' : 'service_unavailable' },
      error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Wrong API origin');
      await next();
    });
    app.get('/api/me', async context => context.json({ address: await auth.owner(getCookie(context, 'telomere_session')), demo: true }));
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(wrapper, context => auth.owner(getCookie(context, 'telomere_session'))));
    server = createServer(getRequestListener(app.fetch)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing actual HTTP address');
    origin = 'http://127.0.0.1:' + address.port;
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: fixture.local.rpcUrl,
      SIGNER_PRIVATE_KEY: fixture.keys.signer, DEMO_PRIVATE_KEY: fixture.keys.owner, ESCROW_ADDRESS: fixture.pins.escrowAddress, TOKEN_ADDRESS: fixture.pins.tokenAddress }));
    ownerToken = await auth.session(binding.owner); agentToken = await auth.session(binding.agentWallet); outsiderToken = await auth.session(fixture.accounts.outsider.address);
    prepared = await factory().quote(input(), 'original-vault-quote');
  }, 150000);
  afterAll(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await store?.close(); await fixture?.close();
  });
  it('reads actual spendable cash, exact immutable bindings, and prepares a signed payRun with both scoped proofs without paying', async () => {
    const client = factory(), nonce = await fixture.local.publicClient.getTransactionCount({ address: vault.account.address });
    expect((await client.config()).binding).toEqual(binding); expect(await client.balance()).toEqual({ available: '1000000' });
    expect(await factory(undefined, ownerToken).balance()).toEqual({ available: '1000000' });
    const quote = await client.quote(input(), 'original-vault-quote');
    expect(quote.quote.payer).toBe(binding.vault); expect(quote.transaction.to).toBe(binding.vault); expect(quote.ceiling).toBe('331');
    expect(quote.imageProof).toHaveLength(1); expect(quote.regionProof).toHaveLength(1);
    expect(await client.openPlan(quote)).toEqual(quote.transaction); expect(Object.isFrozen(quote.quote)).toBe(true);
    expect(await fixture.local.publicClient.getTransactionCount({ address: vault.account.address })).toBe(nonce);
    expect((await bridge.run(quote.quote.runId)).status).toBe(0);
  });
  it('rejects a wallet plan whose signed host is excluded by the owner request', async () => {
    const excluded = { ...prepared, input: { ...prepared.input, excludedHostIds: [prepared.quote.hostId] } };
    await expect(factory().openPlan(excluded)).rejects.toThrow('quote changed');
    await expect(factory().quote({ ...input(), excludedHostIds: [prepared.quote.hostId] }, 'exclude-only-host'))
      .rejects.toMatchObject({ code: 'deadline_infeasible' });
  });
  it('requires the explicit NEAR inference marker when the Vault API advertises a NEAR configuration', async () => {
    const changed = factory((path, value) => path.endsWith('/config')
      ? { ...(value as object), near: { model: 'reviewed-model', maxTokens: 16, policySha256: randomId(), inferencePrice: '1' } }
      : value);
    await expect(changed.config()).rejects.toThrow('nearInferenceTask');
  });
  it('retains idempotency after a lost HTTP response and refuses changed work for the same client key', async () => {
    const client = factory();
    const [a, b] = await Promise.all([client.quote(input(), 'same-vault-work'), client.quote(input(), 'same-vault-work')]);
    expect(a.quote.runId).toBe(b.quote.runId);
    await expect(client.quote({ ...input(), maxSpend: '332' }, 'same-vault-work')).rejects.toThrow('different work');
    let dropped = false;
    const retry = factory((path, value) => { if (path.endsWith('/quotes') && !dropped) { dropped = true; throw new Error('Lost Vault response'); } return value; });
    await expect(retry.quote(input(), 'lost-vault-http')).rejects.toThrow('Lost Vault response');
    const resumed = await retry.quote(input(), 'lost-vault-http');
    expect((await wrapper.quote(binding.agentWallet, binding.vault, input(), 'lost-vault-http')).quote.runId).toBe(resumed.quote.runId);
  });
  it.each(['registryAddress', 'registryCodeHash', 'implementationAddress', 'implementationCodeHash'] as const)('rejects changed Vault deployment pin %s', async key => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/config')) return value;
      const config = platformVaultRuntimeConfigSchema.parse(value);
      Reflect.set(config.vaultPins, key, key.endsWith('CodeHash') ? randomId() : fixture.accounts.outsider.address); return config;
    });
    await expect(changed.quote(input(), 'pin-' + key)).rejects.toThrow('reviewed pins');
  });
  it.each(['vault', 'owner', 'agentWallet', 'agentId', 'leashId'] as const)('rejects changed reviewed binding %s', async key => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/config')) return value;
      const config = platformVaultRuntimeConfigSchema.parse(value);
      Reflect.set(config.binding, key, key.endsWith('Id') ? randomId() : fixture.accounts.outsider.address); return config;
    });
    await expect(changed.quote(input(), 'binding-' + key)).rejects.toThrow('binding');
  });
  it.each(['signature', 'payer', 'task', 'inputSpend', 'price', 'ceiling', 'host', 'leash', 'image', 'region', 'expiry', 'inference',
    'imageProof', 'regionProof', 'destination', 'directEscrow', 'chain', 'calldata', 'value'])('rejects tampered Vault quote response: %s', async kind => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/quotes')) return value;
      const response = platformPreparedSchema.parse(value);
      switch (kind) {
        case 'signature': response.signature = '0x' + '1'.repeat(130) as Hex; break;
        case 'payer': response.quote.payer = binding.agentWallet; break;
        case 'task': response.input.task = { kind: 'sha256', text: 'substituted work' }; break;
        case 'inputSpend': response.input.maxSpend = '999999'; break;
        case 'price': response.quote.pricePerSecond = '102'; break;
        case 'ceiling': response.ceiling = '330'; break;
        case 'host': response.quote.hostId = randomId(); break;
        case 'leash': response.quote.leashId = randomId(); break;
        case 'image': response.quote.imageHash = randomId(); break;
        case 'region': response.quote.regionHash = randomId(); break;
        case 'expiry': response.quote.quoteExpiry = now - 1; break;
        case 'inference': Reflect.set(response.quote, 'inferencePrice', '1'); break;
        case 'imageProof': response.imageProof = []; break;
        case 'regionProof': response.regionProof = []; break;
        case 'destination': response.transaction.to = fixture.accounts.outsider.address; break;
        case 'directEscrow': response.transaction.to = fixture.pins.escrowAddress; break;
        case 'chain': response.transaction.chainId = 84532; break;
        case 'calldata': response.transaction.data += '00'; break;
        case 'value': Reflect.set(response.transaction, 'value', '1'); break;
      }
      return response;
    });
    await expect(changed.quote(input(), 'quote-tamper-' + kind)).rejects.toThrow();
  });
  it('allows only the agent session to quote/admit, only the owner to stop, and denies unrelated reads', async () => {
    await expect(factory(undefined, ownerToken).quote(input(), 'owner-cannot-run')).rejects.toThrow('not authorized');
    await expect(factory(undefined, ownerToken).admit({ runId: prepared.quote.runId, transactionHash: randomId() }, 'owner-admit')).rejects.toThrow('not authorized');
    await expect(factory().stopPlan(prepared.quote.runId, 'agent-stop')).rejects.toThrow('not authorized');
    await expect(factory(undefined, outsiderToken).balance()).rejects.toMatchObject({ status: 404 });
    await expect(factory(undefined, outsiderToken).get(prepared.quote.runId)).rejects.toMatchObject({ status: 404 });
    await expect(factory().quote({ ...input(), leashId: randomId() }, 'other-leash')).rejects.toThrow('Leash');
    const original = factory((path, value) => path === '/api/me' ? { address: binding.owner, demo: true } : value);
    await expect(original.openPlan(prepared)).rejects.toThrow('not authorized');
  });
  it('explicitly pays from the fixture agent, admits the canonical outer Vault transaction and conserves the reservation', async () => {
    const client = factory(), plan = await client.openPlan(prepared);
    const paid = await fixture.confirmed(vault.wallet.sendTransaction({ to: plan.to, data: plan.data as Hex, value: 0n })); admittedTx = paid.transactionHash;
    const run = await client.admit({ runId: prepared.quote.runId, transactionHash: admittedTx }, 'vault-admit-original');
    expect(run.status).toBe('queued'); expect(run.admissionTx).toBe(admittedTx); expect((await bridge.run(run.id)).payer).toBe(binding.vault);
    expect(await client.balance()).toEqual({ available: '999669' });
    expect((await client.list()).runs.some(value => value.id === run.id)).toBe(true);
    expect((await factory(undefined, ownerToken).get(run.id)).id).toBe(run.id);
    expect((await client.admit({ runId: run.id, transactionHash: admittedTx }, 'vault-admit-retry')).admissionTx).toBe(admittedTx);
  });
  it('returns exact owner Vault stop and permissionless escrow refund plans, and rejects changed action destinations', async () => {
    const owner = factory(undefined, ownerToken), runId = prepared.quote.runId;
    const stop = await owner.stopPlan(runId, 'owner-stop-plan'), refund = await factory().refundPlan(runId, 'refund-plan');
    expect(stop.to).toBe(binding.vault); expect(stop.data).toBe(encodeFunctionData({ abi: platformVaultClientAbi, functionName: 'requestStop', args: [runId] }));
    expect(refund.to.toLowerCase()).toBe(fixture.pins.escrowAddress.toLowerCase()); expect(refund.data).toBe(encodeFunctionData({ abi: platformEscrowAbi, functionName: 'refundRun', args: [runId] }));
    for (const action of ['stop', 'refund'] as const) {
      const changed = factory((path, value) => path.endsWith('/' + action) && typeof value === 'object' && value !== null
        ? { ...value, to: fixture.accounts.outsider.address } : value, ownerToken);
      await expect(changed[action === 'stop' ? 'stopPlan' : 'refundPlan'](runId, 'wrong-' + action)).rejects.toThrow('destination');
    }
  });
  it('rejects an API Vault run DTO with an inference charge absent from its signed quote', async () => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/runs/' + prepared.quote.runId)) return value;
      return { ...(value as object), settlement: { runId: prepared.quote.runId, billableSeconds: 1,
        endedAt: now, inferenceCharge: '1', receiptHash: randomId() } };
    });
    await expect(changed.get(prepared.quote.runId)).rejects.toThrow('inference charge');
  });
  it('rejects CPU-second billing in a Vault NEAR inference-only run DTO', async () => {
    const changed = factory((path, value) => {
      if (!path.endsWith('/runs/' + prepared.quote.runId)) return value;
      return { ...(value as object), executionKind: 'near_inference', settlement: { runId: prepared.quote.runId,
        billableSeconds: 1, endedAt: now, inferenceCharge: '0', receiptHash: randomId() } };
    });
    await expect(changed.get(prepared.quote.runId)).rejects.toThrow('cannot bill CPU seconds');
  });
  it('rejects tampered run ownership, leash, amount conservation and original admission hash', async () => {
    const id = prepared.quote.runId;
    for (const kind of ['payer', 'leash', 'funds', 'admission'] as const) {
      const changed = factory((path, value) => {
        if (!path.endsWith('/runs') && !path.endsWith('/runs/' + id)) return value;
        const response = structuredClone(value);
        if (typeof response !== 'object' || response === null || !('quote' in response)) return value;
        const quote = platformPreparedSchema.shape.quote.parse(response.quote);
        if (kind === 'payer') quote.payer = binding.agentWallet;
        if (kind === 'leash') quote.leashId = randomId();
        Reflect.set(response, 'quote', quote);
        if (kind === 'funds') { Reflect.set(response, 'charged', '100'); Reflect.set(response, 'refund', '1'); }
        if (kind === 'admission') Reflect.set(response, 'admissionTx', randomId());
        return response;
      });
      if (kind === 'admission') await expect(changed.admit({ runId: id, transactionHash: admittedTx }, 'changed-admission')).rejects.toThrow('original reservation');
      else await expect(changed.get(id)).rejects.toThrow();
    }
  });
  it('enforces HTTP JSON limits, path and body schemas, origin, authentication and no-store', async () => {
    const path = '/api/platform/vaults/' + binding.vault, headers = { Origin: origin, Cookie: 'telomere_session=' + agentToken,
      'Content-Type': 'application/json', 'Idempotency-Key': 'strict-boundary' };
    const valid = await fetch(origin + path + '/config', { headers }); expect(valid.status).toBe(200); expect(valid.headers.get('cache-control')).toBe('no-store');
    const unauthenticated = await fetch(origin + path + '/balance'); expect(unauthenticated.status).toBe(401); expect(unauthenticated.headers.get('cache-control')).toBe('no-store');
    const wrongOrigin = await fetch(origin + path + '/quotes', { method: 'POST', headers: { ...headers, Origin: 'https://other.invalid' }, body: JSON.stringify(input()) });
    expect(wrongOrigin.status).toBe(403);
    for (const [suffix, body, status] of [['/quotes', JSON.stringify({ ...input(), unexpected: true }), 422],
      ['/quotes', '{', 422], ['/quotes', ' '.repeat(32_769), 422], ['/runs/' + prepared.quote.runId + '/refund', '{"unexpected":true}', 422]] as const) {
      const response = await fetch(origin + path + suffix, { method: 'POST', headers, body }); expect(response.status).toBe(status);
    }
    const badVault = await fetch(origin + '/api/platform/vaults/not-address/config', { headers }); expect(badVault.status).toBe(422);
    const badRun = await fetch(origin + path + '/runs/not-id', { headers }); expect(badRun.status).toBe(422);
    const wrongType = await fetch(origin + path + '/quotes', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' }); expect(wrongType.status).toBe(422);
    const invalidUtf8 = await fetch(origin + path + '/quotes', { method: 'POST', headers, body: new Uint8Array([0xff]) }); expect(invalidUtf8.status).toBe(422);
    const missingIdem = await fetch(origin + path + '/quotes', { method: 'POST', headers: { Origin: origin, Cookie: headers.Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input()) }); expect(missingIdem.status).toBe(422);
    // No declared content length: the streaming cap must independently reject an oversized chunk.
    const streamed = await app.request(path + '/quotes', { method: 'POST', headers, body: ' '.repeat(32_769) }); expect(streamed.status).toBe(422);
  });
  it('cancels an authenticated JSON body that never finishes within the five-second budget', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
    const init = { method: 'POST', headers: { Origin: origin, Cookie: 'telomere_session=' + agentToken,
      'Content-Type': 'application/json', 'Idempotency-Key': 'body-deadline' }, body, duplex: 'half' };
    const response = await app.request(new Request(origin + '/api/platform/vaults/' + binding.vault + '/quotes', init));
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ title: 'platform_body_timeout' }); expect(cancelled).toBe(true);
  }, 10000);
});
