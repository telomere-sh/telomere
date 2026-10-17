import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { beforeAll, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, toHex, verifyTypedData, type Hex } from 'viem';
import { z } from 'zod';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { Problem, randomId } from '../src/common.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { openHostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { platformEscrowAbi, platformHostSchema, platformPinsSchema, platformQuoteDomainVersion, platformQuoteTypes,
  typedPlatformQuote, type PlatformQuote } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { readSpendPermissionFunding, spendPermissionExtraData, spendPermissionHash, spendPermissionLeashTermsHash,
  spendPermissionManagerAbi, spendPermissionOpenCall, typedSpendPermission, verifySpendPermissionOpening,
  type SpendPermission } from '../src/payments/spend-permissions.js';
import { openStore } from '../src/store.js';
import { compileSpendPermissionFixtures, deploySpendPermissionRuntime } from './fixtures/platform-spend-permission.js';

let artifacts: ReturnType<typeof compileSpendPermissionFixtures>;
beforeAll(() => { artifacts = compileSpendPermissionFixtures(); }, 120_000);
const zero = `0x${'0'.repeat(64)}` as const;
const imageDigest = 'sha256:' + 'a'.repeat(64), image = 'fixture/spend-permission@' + imageDigest;

class FundedCpuFixture extends LocalProcessFixtureRuntime {
  starts = 0;
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++;
    const program = "const{createHash}=require('node:crypto');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({sha256:createHash('sha256').update(JSON.parse(s).text).digest('hex')})),12000));";
    return super.start({ ...lease, argv: [process.execPath, '-e', program] }, heartbeat);
  }
}
type Fixture = Awaited<ReturnType<typeof deploySpendPermissionRuntime>>;
async function leash(local: Fixture, maxPerHour = 100_000n) {
  const id = randomId(), block = await local.local.publicClient.getBlock();
  const terms = { agent: local.accounts.owner.address, maxPerHour, maxPerDay: 1_000_000n, classMask: 1n,
    sealedOnly: false, imageAllowRoot: zero, regionAllowRoot: zero, expiry: block.timestamp + 86_400n };
  await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformSpendPermissionEscrowV1').abi,
    functionName: 'createLeash', args: [id, terms] }));
  return { id, terms };
}
async function permission(local: Fixture, scope: Awaited<ReturnType<typeof leash>>, overrides: Partial<SpendPermission> = {}): Promise<SpendPermission> {
  const block = await local.local.publicClient.getBlock();
  const value: SpendPermission = { account: local.fundingAccount, spender: local.pins.escrowAddress, token: local.pins.tokenAddress,
    allowance: '10000', period: 120, start: Number(block.timestamp) - 10, end: Number(block.timestamp) + 7200,
    salt: BigInt(randomId()).toString(), extraData: spendPermissionExtraData(31337, local.pins.escrowAddress,
      local.fundingAccount, local.accounts.owner.address, scope.id, spendPermissionLeashTermsHash(scope.terms)), ...overrides };
  await local.permissionAction('approve', value); return value;
}
async function quoted(local: Fixture, scope: Awaited<ReturnType<typeof leash>>, overrides: Partial<PlatformQuote> = {}) {
  const block = await local.local.publicClient.getBlock();
  const quote: PlatformQuote = { runId: randomId(), leashId: scope.id, hostId: local.hostId, payer: local.accounts.owner.address,
    hwClass: 0, regionHash: keccak256(toHex('spend-local')), imageHash: keccak256(toHex(imageDigest)),
    workloadHash: keccak256(toHex('permission-contract-admission')), maxSeconds: 25, pricePerSecond: '100', inferencePrice: '0',
    quoteExpiry: Number(block.timestamp) + 120, ...overrides };
  const signature = await local.accounts.signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '3',
    chainId: 31337, verifyingContract: local.pins.escrowAddress }, types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
  return { quote, signature, ceiling: BigInt(quote.maxSeconds) * BigInt(quote.pricePerSecond) * 109n / 100n };
}
const balance = async (local: Fixture, address: Hex): Promise<bigint> => z.bigint().parse(await local.local.publicClient.readContract({ address: local.pins.tokenAddress,
  abi: local.artifact('MockToken').abi, functionName: 'balanceOf', args: [address] }));
const period = (local: Fixture, value: SpendPermission) => local.local.publicClient.readContract({ address: local.manager,
  abi: spendPermissionManagerAbi, functionName: 'getCurrentPeriod', args: [typedSpendPermission(value)] });
const recordedSpend = async (local: Fixture, value: SpendPermission) => z.object({ spend: z.bigint() }).parse(await local.local.publicClient.readContract({
  address: local.manager, abi: local.artifact('SpendPermissionManager').abi, functionName: 'getLastUpdatedPeriod', args: [typedSpendPermission(value)] })).spend;

it('funds a real HTTP CPU admission from the official Manager into an undeposited EOA, settles and returns unused funds only to that approved EOA', async () => {
  const journal = await openHostJournal(':memory:'), control = new Ed25519Identity(), cpu = new FundedCpuFixture();
  const hostAgent = new HostKitAgent(journal, cpu, control.publicKey, new Set([image]));
  let local: Fixture | undefined, store: Awaited<ReturnType<typeof openStore>> | undefined;
  const servers: Server[] = [];
  const listen = async (app: Hono) => {
    const server = createServer(getRequestListener(app.fetch)); servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port absent'); return 'http://127.0.0.1:' + address.port;
  };
  try {
    await hostAgent.initialize();
    const hostClient = new HostKitClient(await listen(createHostKitRoutes(hostAgent)), journal.identity.publicKey, control, true);
    // REASON: HostKit's generated Ed25519 public key has exactly32 bytes.
    local = await deploySpendPermissionRuntime(journal.identity.publicKey as Hex, artifacts);
    const fixture = local, scope = await leash(fixture), fundingPermission = await permission(fixture, scope);
    expect(fixture.accounts.fundOwner.address).not.toBe(fixture.accounts.owner.address);
    expect(fixture.fundingAccount).not.toBe(fixture.accounts.owner.address);
    store = await openStore({ DATA_DIR: ':memory:' });
    const bridge = new PlatformBridge(store.db, { pins: fixture.pins, rpcUrl: fixture.local.rpcUrl, signerPrivateKey: fixture.keys.signer });
    const host = platformHostSchema.parse({ hostId: fixture.hostId, hostKey: journal.identity.publicKey, hardwareClass: 'cpu', region: 'spend-local',
      image, imageDigest, sealed: false, lane: 'standard', pricePerSecond: '100', reliabilityBps: 10000, strikes: 0, stake: '300000000', availableAt: 0 });
    let service: PlatformRuntimeService;
    const receipts = new PlatformReceiptService(store.db, { chainId: 31337, escrowAddress: fixture.pins.escrowAddress,
      receiptRootAddress: fixture.pins.receiptRootAddress, publicClient: bridge.public,
      submitTransaction: (key, to, data) => bridge.transactions.submit(key, to, data), canSeal: hour => service.canSeal(hour) });
    const executor = new PlatformHostExecutor(store.db, new Map([[fixture.hostId, hostClient]]));
    service = new PlatformRuntimeService(store.db, bridge, [host], executor, receipts); await service.initialize();
    const app = new Hono(); let auth: Auth;
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'invalid_input' },
      error instanceof Problem ? error.status : error instanceof z.ZodError ? 422 : 503));
    const principal = async (context: Parameters<Parameters<typeof createPlatformRuntimeRoutes>[1]>[0]) => auth.owner(getCookie(context, 'telomere_session'));
    app.get('/api/me', async context => context.json({ address: await principal(context), demo: false }));
    app.route('/api/platform', createPlatformRuntimeRoutes(service, principal));
    const origin = await listen(app);
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: fixture.local.rpcUrl,
      SIGNER_PRIVATE_KEY: fixture.keys.signer, DEMO_PRIVATE_KEY: fixture.keys.owner, ESCROW_ADDRESS: fixture.pins.escrowAddress, TOKEN_ADDRESS: fixture.pins.tokenAddress }));
    const sessionToken = await auth.session(fixture.accounts.owner.address);
    let now = await bridge.now();
    const sdk = new PlatformRuntimeClient({ baseUrl: origin, pins: fixture.pins, sessionToken, nowSeconds: () => now });
    expect(await sdk.balance()).toEqual({ available: '0' });
    const basic = { leashId: scope.id, task: { kind: 'sha256' as const, text: 'official-manager-funded-cpu' }, maxSeconds: 25,
      deadline: now + 300, maxSpend: '10000', regions: ['spend-local'] };
    await expect(sdk.quote(basic, 'no-prepaid-balance')).rejects.toThrow();
    now = await bridge.now();
    const funding = { kind: 'base_spend_permission_v1' as const, permission: fundingPermission };
    const prepared = await sdk.quote({ ...basic, deadline: now + 300, funding }, 'official-manager-funded-1');
    expect(prepared.receiptVersion ?? 1).toBe(1);
    expect(prepared.fundingReview).toMatchObject({ kind: 'base_spend_permission_v1', fundingAccount: fixture.fundingAccount,
      refundBeneficiary: fixture.accounts.owner.address, reservationCeiling: prepared.ceiling, managerAddress: fixture.manager,
      permissionHash: spendPermissionHash(31337, fixture.manager, fundingPermission) });
    expect(prepared.ceiling).toBe('2725');
    expect(decodeFunctionData({ abi: fixture.artifact('PlatformSpendPermissionEscrowV1').abi, data: prepared.transaction.data as Hex }).functionName)
      .toBe('openRunFromSpendPermission');
    expect(platformQuoteDomainVersion(fixture.pins)).toBe('3');
    for (const version of ['1', '2']) expect(await verifyTypedData({ address: fixture.accounts.signer.address,
      domain: { name: 'TelomerePlatformEscrow', version, chainId: 31337, verifyingContract: fixture.pins.escrowAddress },
      types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(prepared.quote), signature: prepared.signature })).toBe(false);
    expect(await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'availableBalance', args: [fixture.accounts.owner.address] })).toBe(0n);
    const before = await balance(fixture, fixture.fundingAccount);
    const opened = await fixture.confirmed(fixture.owner.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data as Hex, value: 0n }));
    expect(before - await balance(fixture, fixture.fundingAccount)).toBe(2725n);
    expect((await period(fixture, fundingPermission)).spend).toBe(2725n);
    await verifySpendPermissionOpening(fixture.local.publicClient, fixture.pins, prepared.quote, prepared.ceiling, opened.transactionHash, funding);
    const wrongAssetPins = platformPinsSchema.parse({ ...fixture.pins, tokenCodeHash: zero });
    await expect(readSpendPermissionFunding(fixture.local.publicClient, wrongAssetPins, fixture.accounts.owner.address, scope.id, funding))
      .rejects.toThrow('asset code pin');
    await expect(verifySpendPermissionOpening(fixture.local.publicClient, wrongAssetPins, prepared.quote, prepared.ceiling, opened.transactionHash, funding))
      .rejects.toThrow('asset code pin');
    await sdk.admit({ runId: prepared.quote.runId, transactionHash: opened.transactionHash }, 'official-manager-admit');
    await service.drain();
    const pending = await sdk.get(prepared.quote.runId);
    expect(cpu.starts).toBe(1); expect(pending.status).toBe('receipt_pending');
    expect(z.object({ output: z.string() }).parse(pending.result).output).toBe(JSON.stringify({ sha256: createHash('sha256').update(basic.task.text).digest('hex') }));
    if (!pending.settlement) throw new Error('Actual CPU settlement unavailable');
    const closed = BigInt((Math.floor(pending.settlement.endedAt / 3600) + 1) * 3600);
    await fixture.test.setNextBlockTimestamp({ timestamp: closed }); await fixture.test.mine({ blocks: 1 }); await service.drain();
    const final = await sdk.get(prepared.quote.runId);
    expect(final.status).toBe('completed'); expect(BigInt(final.charged!)).toBeGreaterThan(0n);
    expect(BigInt(final.charged!) + BigInt(final.refund!)).toBe(2725n);
    expect((await bridge.run(prepared.quote.runId)).payer).toBe(fixture.accounts.owner.address);
    const refund = BigInt(final.refund!), payerBefore = await balance(fixture, fixture.accounts.owner.address);
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: fixture.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'withdraw', args: [refund] }));
    expect(await balance(fixture, fixture.accounts.owner.address) - payerBefore).toBe(refund);
    expect(await balance(fixture, fixture.fundingAccount)).toBe(before - 2725n);
    // A signed quote retains its original funding method even when both
    // methods are financially possible onchain. Neither alternate selector
    // authorizes the controller to dispatch a different payment plan.
    now = await bridge.now();
    const freshPermission = await permission(fixture, scope);
    now = await bridge.now();
    const newInput = { ...basic, deadline: now + 300 };
    const expectedFunded = await sdk.quote({ ...newInput, funding: { ...funding, permission: freshPermission } }, 'funded-method-confusion');
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.tokenAddress, abi: fixture.artifact('MockToken').abi,
      functionName: 'faucet', args: [fixture.accounts.owner.address, 10_000n] }));
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.tokenAddress, abi: fixture.artifact('MockToken').abi,
      functionName: 'approve', args: [fixture.pins.escrowAddress, 10_000n] }));
    await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: fixture.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'deposit', args: [10_000n] }));
    const legacyOpening = await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress, abi: platformEscrowAbi,
      functionName: 'openRun', args: [typedPlatformQuote(expectedFunded.quote), expectedFunded.signature, [], []] }));
    await expect(sdk.admit({ runId: expectedFunded.quote.runId, transactionHash: legacyOpening.transactionHash }, 'wrong-legacy-method')).rejects.toThrow();
    now = await bridge.now();
    const expectedPrepaid = await sdk.quote({ ...newInput, deadline: now + 300 }, 'prepaid-method-confusion');
    const fundedOpening = await fixture.confirmed(fixture.owner.sendTransaction({ to: fixture.pins.escrowAddress,
      data: spendPermissionOpenCall(expectedPrepaid.quote, expectedPrepaid.signature, [], [], freshPermission) }));
    await expect(sdk.admit({ runId: expectedPrepaid.quote.runId, transactionHash: fundedOpening.transactionHash }, 'wrong-funded-method')).rejects.toThrow();
    expect(cpu.starts).toBe(1);
    const stranger = new PlatformRuntimeClient({ baseUrl: origin, pins: fixture.pins, sessionToken,
      fetch: async (input, init) => { const response = await fetch(input, init);
        if (String(input).endsWith('/api/platform/config')) return Response.json({ ...await response.json(), cpuReceiptVersion: 2 }); return response; } });
    await expect(stranger.config()).rejects.toThrow('does not support CPU receipt-v2');
  } finally {
    await hostAgent.close().catch(() => undefined);
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    await journal.close(); await store?.close(); await local?.close();
  }
}, 240_000);

it('uses the official Manager period, revocation and atomic rollback together with exact Leash binding and escrow global caps', async () => {
  const local = await deploySpendPermissionRuntime(randomId(), artifacts);
  try {
    const scope = await leash(local), basePermission = await permission(local, scope);
    const first = await quoted(local, scope);
    const call = (quote: PlatformQuote, signature: Hex, value: SpendPermission) => spendPermissionOpenCall(quote, signature, [], [], value);
    const spend = async (quote: PlatformQuote, signature: Hex, value: SpendPermission) => local.local.publicClient.waitForTransactionReceipt({
      hash: await local.owner.sendTransaction({ to: local.pins.escrowAddress, data: call(quote, signature, value), gas: 3_000_000n }) });
    const unchangedAfterRevert = async (value: SpendPermission, quote: PlatformQuote, signature: Hex) => {
      const before = await balance(local, local.fundingAccount), previous = await recordedSpend(local, value);
      const beforeEscrow = await balance(local, local.pins.escrowAddress);
      expect((await spend(quote, signature, value)).status).toBe('reverted');
      expect(await balance(local, local.fundingAccount)).toBe(before);
      expect(await balance(local, local.pins.escrowAddress)).toBe(beforeEscrow);
      expect(await recordedSpend(local, value)).toBe(previous);
      expect((await local.local.publicClient.readContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformSpendPermissionEscrowV1').abi,
        functionName: 'getRun', args: [quote.runId] }))).toMatchObject({ status: 0 });
    };
    const wrongSignature = await local.accounts.owner.signMessage({ message: 'wrong platform quote' });
    await unchangedAfterRevert(basePermission, first.quote, wrongSignature);
    for (const overrides of [{ extraData: spendPermissionExtraData(31337, local.pins.escrowAddress, local.fundingAccount,
      local.accounts.fundOwner.address, scope.id, spendPermissionLeashTermsHash(scope.terms)) }, { spender: local.accounts.owner.address },
      { allowance: '2724' }, { start: Number((await local.local.publicClient.getBlock()).timestamp) + 100 }]) {
      const changed = await permission(local, scope, overrides); const q = await quoted(local, scope); await unchangedAfterRevert(changed, q.quote, q.signature);
    }
    const revoked = await permission(local, scope); await local.permissionAction('revoke', revoked);
    const revokedQuote = await quoted(local, scope); await unchangedAfterRevert(revoked, revokedQuote.quote, revokedQuote.signature);
    expect((await spend(first.quote, first.signature, basePermission)).status).toBe('success');
    expect((await period(local, basePermission)).spend).toBe(2725n);
    const second = await quoted(local, scope);
    expect((await spend(second.quote, second.signature, basePermission)).status).toBe('success');
    expect((await period(local, basePermission)).spend).toBe(5450n);
    expect((await readSpendPermissionFunding(local.local.publicClient, local.pins, local.accounts.owner.address, scope.id,
      { kind: 'base_spend_permission_v1', permission: basePermission })).available).toBe('4550');
    await verifySpendPermissionOpening(local.local.publicClient, local.pins, second.quote, '2725',
      (await local.local.publicClient.getBlock({ blockTag: 'latest' })).transactions[0]!);
    const changedTerms = { ...scope.terms, maxPerHour: 200_000n };
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformSpendPermissionEscrowV1').abi,
      functionName: 'updateLeash', args: [scope.id, changedTerms] }));
    const changedQuote = await quoted(local, scope); await unchangedAfterRevert(basePermission, changedQuote.quote, changedQuote.signature);
    await expect(readSpendPermissionFunding(local.local.publicClient, local.pins, local.accounts.owner.address, scope.id,
      { kind: 'base_spend_permission_v1', permission: basePermission })).rejects.toThrow();
    const constrained = await leash(local, 2724n), constrainedPermission = await permission(local, constrained);
    const limitedQuote = await quoted(local, constrained); await unchangedAfterRevert(constrainedPermission, limitedQuote.quote, limitedQuote.signature);
    const periodScope = await leash(local), periodPermission = await permission(local, periodScope, { allowance: '2725', period: 60 });
    const periodFirst = await quoted(local, periodScope);
    expect((await spend(periodFirst.quote, periodFirst.signature, periodPermission)).status).toBe('success');
    const exhausted = await quoted(local, periodScope); await unchangedAfterRevert(periodPermission, exhausted.quote, exhausted.signature);
    const periodEnd = (await period(local, periodPermission)).end;
    await local.test.setNextBlockTimestamp({ timestamp: BigInt(periodEnd + 1) }); await local.test.mine({ blocks: 1 });
    const renewed = await quoted(local, periodScope); expect((await spend(renewed.quote, renewed.signature, periodPermission)).status).toBe('success');
    expect((await period(local, periodPermission)).spend).toBe(2725n);
    const expires = Number((await local.local.publicClient.getBlock()).timestamp) + 10;
    const expiredPermission = await permission(local, periodScope, { end: expires });
    await local.test.setNextBlockTimestamp({ timestamp: BigInt(expires + 1) }); await local.test.mine({ blocks: 1 });
    const expiredQuote = await quoted(local, periodScope); await unchangedAfterRevert(expiredPermission, expiredQuote.quote, expiredQuote.signature);
    const available = z.bigint().parse(await local.local.publicClient.readContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'totalAvailable' }));
    const reserved = z.bigint().parse(await local.local.publicClient.readContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'totalReserved' }));
    const maximum = 500_000_000_000n, deposit = maximum - available - reserved;
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress, abi: local.artifact('MockToken').abi,
      functionName: 'faucet', args: [local.accounts.owner.address, deposit] }));
    await local.confirmed(local.owner.writeContract({ address: local.pins.tokenAddress, abi: local.artifact('MockToken').abi,
      functionName: 'approve', args: [local.pins.escrowAddress, deposit] }));
    await local.confirmed(local.owner.writeContract({ address: local.pins.escrowAddress, abi: local.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'deposit', args: [deposit] }));
    const capPermission = await permission(local, periodScope);
    const capped = await quoted(local, periodScope);
    await expect(local.local.publicClient.simulateContract({ account: local.accounts.owner, address: local.pins.escrowAddress,
      abi: local.artifact('PlatformSpendPermissionEscrowV1').abi, functionName: 'openRunFromSpendPermission',
      args: [typedPlatformQuote(capped.quote), capped.signature, [], [], typedSpendPermission(capPermission)] })).rejects.toThrow('InvalidAmount');
    await unchangedAfterRevert(capPermission, capped.quote, capped.signature);
    const otherManager = await local.deploy('SpendPermissionManager', ['0x' + '00'.repeat(20), '0x' + '00'.repeat(20)]);
    const otherCode = await local.local.publicClient.getCode({ address: otherManager }); if (!otherCode) throw new Error('Second Manager absent');
    const otherPins = platformPinsSchema.parse({ ...local.pins, spendPermissionProfile: { ...local.pins.spendPermissionProfile!, managerAddress: otherManager, managerCodeHash: keccak256(otherCode) } });
    await expect(readSpendPermissionFunding(local.local.publicClient, otherPins, local.accounts.owner.address, periodScope.id,
      { kind: 'base_spend_permission_v1', permission: periodPermission })).rejects.toThrow('manager');
    expect(platformQuoteDomainVersion({ ...local.pins, spendPermissionProfile: undefined })).toBe('1');
    expect(platformQuoteDomainVersion({ ...local.pins, spendPermissionProfile: undefined,
      financialProfile: { kind: 'tlmr_economics_v2', stakingAddress: local.manager, stakingCodeHash: local.managerCodeHash,
        utilityTokenAddress: local.pins.tokenAddress, utilityTokenCodeHash: local.pins.tokenCodeHash } })).toBe('2');
    expect(platformPinsSchema.safeParse({ ...local.pins,
      financialProfile: { kind: 'tlmr_economics_v2', stakingAddress: local.manager, stakingCodeHash: local.managerCodeHash,
        utilityTokenAddress: local.pins.tokenAddress, utilityTokenCodeHash: local.pins.tokenCodeHash } }).success).toBe(false);
  } finally { await local.close(); }
}, 240_000);
