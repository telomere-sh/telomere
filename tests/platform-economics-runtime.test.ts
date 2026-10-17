import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { decodeFunctionData, keccak256, parseEther, toHex, verifyTypedData, type Hex } from 'viem';
import { expect, it } from 'vitest';
import { compileContracts } from '../scripts/compile-contracts.js';
import { Auth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { Problem, randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { HostKitAgent, createHostKitRoutes } from '../src/host-kit/agent.js';
import { HostKitClient } from '../src/host-kit/client.js';
import { openHostJournal } from '../src/host-kit/journal.js';
import { LocalProcessFixtureRuntime } from '../src/host-kit/fixture-runtime.js';
import { Ed25519Identity, type HostLease } from '../src/host-kit/protocol.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { PlatformHostExecutor } from '../src/platform-runtime/host-executor.js';
import { PlatformRuntimeService } from '../src/platform-runtime/service.js';
import { createPlatformRuntimeRoutes } from '../src/platform-runtime/routes.js';
import { PlatformVaultBridge } from '../src/platform-runtime/vault.js';
import { PlatformVaultRuntimeService } from '../src/platform-runtime/vault-service.js';
import { createPlatformVaultRuntimeRoutes } from '../src/platform-runtime/vault-routes.js';
import { platformRuns } from '../src/platform-runtime/schema.js';
import { platformEscrowAbi, platformHostSchema, platformPinsSchema, platformQuoteTypes, typedPlatformQuote } from '../src/platform-runtime/types.js';
import { PlatformReceiptService } from '../src/receipts/platform-service.js';
import { deployPlatformEconomicsRuntime } from './fixtures/platform-economics-runtime.js';
import { deployPlatformVault, platformVaultIdentityArtifact } from './fixtures/platform-vault-runtime.js';

class EconomicsCpuFixture extends LocalProcessFixtureRuntime {
  starts = 0;
  constructor() { super('test-fixture-only'); }
  override start(lease: HostLease, heartbeat: Parameters<LocalProcessFixtureRuntime['start']>[1]) {
    this.starts++;
    const program = "const{createHash}=require('node:crypto');let d='';process.stdin.on('data',b=>d+=b);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify({sha256:createHash('sha256').update(JSON.parse(d).text).digest('hex')})),11000));";
    return super.start({ ...lease, argv: [process.execPath, '-e', program] }, heartbeat);
  }
}

it('routes real economics-v2 EOA/Vault work over HTTP, applies canonical stake placement and locks admission fee tiers', async () => {
  const journals = [await openHostJournal(':memory:'), await openHostJournal(':memory:')];
  const hostAgents: HostKitAgent[] = [], servers: Server[] = [], stores: Awaited<ReturnType<typeof openStore>>[] = [];
  let fixture: Awaited<ReturnType<typeof deployPlatformEconomicsRuntime>> | undefined;
  const children: EconomicsCpuFixture[] = [], clients: HostKitClient[] = [];
  const imageDigest = 'sha256:' + 'a'.repeat(64), image = 'fixture/node@' + imageDigest;
  const listen = async (app: Hono) => {
    const server = createServer(getRequestListener(app.fetch)); servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing economics HTTP port');
    return 'http://127.0.0.1:' + address.port;
  };
  try {
    for (const journal of journals) {
      const control = new Ed25519Identity(), child = new EconomicsCpuFixture(); children.push(child);
      const agent = new HostKitAgent(journal, child, control.publicKey, new Set([image])); hostAgents.push(agent); await agent.initialize();
      clients.push(new HostKitClient(await listen(createHostKitRoutes(agent)), journal.identity.publicKey, control, true));
    }
    const first = journals[0], second = journals[1]; if (!first || !second) throw new Error('Missing economics host journals');
    const artifacts = compileContracts(['PlatformRunEscrowEconomicsV2.sol', 'FeeRouterEconomicsV2.sol', 'HostRegistry.sol',
      'ReceiptRoot.sol', 'MockToken.sol', 'TlmrBurnableToken.sol', 'TlmrRewardStaking.sol', 'TlmrBuyAndBurn.sol', 'TestReviewedV3Router.sol',
      'PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'PlatformRunEscrow.sol', 'FeeRouter.sol', 'TlmrToken.sol', 'TlmrStaking.sol']);
    artifacts.PlatformRuntimeIdentityFixture = platformVaultIdentityArtifact();
    // REASON: HostKit generates verified 32-byte public keys.
    fixture = await deployPlatformEconomicsRuntime([first.identity.publicKey as Hex, second.identity.publicKey as Hex], artifacts);
    const local = fixture, store = await openStore({ DATA_DIR: ':memory:' }); stores.push(store);
    let bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    await bridge.check();
    await local.write(local.utility, 'TlmrBurnableToken', 'approve', [local.staking, parseEther('1000')], local.host);
    const hostStakeId = keccak256(toHex('actual-host-priority'));
    await local.write(local.staking, 'TlmrRewardStaking', 'stake', [hostStakeId, parseEther('1000')], local.host);
    const ownerStakeId = keccak256(toHex('actual-owner-tier'));
    await local.write(local.utility, 'TlmrBurnableToken', 'approve', [local.staking, parseEther('500')]);
    await local.write(local.staking, 'TlmrRewardStaking', 'stake', [ownerStakeId, parseEther('500')]);
    const vault = await deployPlatformVault(local);
    await local.write(local.pins.escrowAddress, 'PlatformRunEscrowEconomicsV2', 'setOpensPaused', [true]);
    await local.write(local.pins.escrowAddress, 'PlatformRunEscrowEconomicsV2', 'configureDiscountVaultRegistry',
      [vault.registryAddress, vault.pins.registryCodeHash]);
    await local.write(local.pins.escrowAddress, 'PlatformRunEscrowEconomicsV2', 'setOpensPaused', [false]);
    local.pins = platformPinsSchema.parse({ ...local.pins, financialProfile: { ...local.pins.financialProfile!,
      discountVaultRegistry: { address: vault.registryAddress, codeHash: vault.pins.registryCodeHash,
        implementationAddress: vault.pins.implementationAddress, implementationCodeHash: vault.pins.implementationCodeHash } } });
    bridge = new PlatformBridge(store.db, { pins: local.pins, rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
    await bridge.check();
    const vaults = new PlatformVaultBridge(bridge, vault.pins);
    const binding = await vaults.authorize(vault.account.address, vault.agent.vault, 'run');
    expect(await local.local.publicClient.readContract({ address: local.pins.escrowAddress,
      abi: local.artifact('PlatformRunEscrowEconomicsV2').abi, functionName: 'discountBeneficiary', args: [binding.vault] }))
      .toBe(local.accounts.owner.address);
    const makeHosts = (higherPrice: string) => [local.hostId, local.secondHostId].map((hostId, index) => platformHostSchema.parse({
      hostId, hostKey: journals[index]!.identity.publicKey, hardwareClass: 'cpu', region: 'local-economics', image, imageDigest,
      sealed: false, lane: 'standard', pricePerSecond: index === 0 ? higherPrice : '100', reliabilityBps: 10000,
      strikes: 0, stake: '300000000', availableAt: 0 }));
    const hostClients = new Map([[local.hostId, clients[0]!], [local.secondHostId, clients[1]!]]);
    const build = async (ownedStore: typeof store, higherPrice: string) => {
      const ownBridge = ownedStore === store ? bridge : new PlatformBridge(ownedStore.db, { pins: local.pins,
        rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
      let runtime: PlatformRuntimeService;
      const receipts = new PlatformReceiptService(ownedStore.db, { chainId: 31337, escrowAddress: local.pins.escrowAddress,
        receiptRootAddress: local.pins.receiptRootAddress, publicClient: ownBridge.public,
        submitTransaction: (key, to, data) => ownBridge.transactions.submit(key, to, data), canSeal: hour => runtime.canSeal(hour) });
      runtime = new PlatformRuntimeService(ownedStore.db, ownBridge, makeHosts(higherPrice),
        new PlatformHostExecutor(ownedStore.db, hostClients), receipts, ownedStore === store ? vaults : undefined);
      await runtime.initialize(); return runtime;
    };
    const runtime = await build(store, '104'), wrapped = new PlatformVaultRuntimeService(runtime, vaults);
    let now = await bridge.now(); const leashId = randomId();
    await local.write(local.pins.escrowAddress, 'PlatformRunEscrowEconomicsV2', 'createLeash', [leashId, {
      agent: local.accounts.owner.address, maxPerHour: 1_000_000n, maxPerDay: 1_000_000n, classMask: 1n, sealedOnly: false,
      imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}`, expiry: BigInt(now + 86400) }]);
    const input = { leashId, task: { kind: 'sha256' as const, text: 'actual economics CPU' },
      maxSeconds: 60, deadline: now + 300, maxSpend: '10000', regions: ['local-economics'] };
    const weights = await bridge.schedulingWeights([local.hostId, local.secondHostId]);
    expect(weights?.map(value => value.schedulingWeight)).toEqual([parseEther('1000').toString(), '0']);
    const otherStore = await openStore({ DATA_DIR: ':memory:' }); stores.push(otherStore);
    const beyond = await build(otherStore, '106');
    expect((await beyond.quote(local.accounts.owner.address, input, 'outside-five-percent')).quote.hostId).toBe(local.secondHostId);

    let origin: string, auth: Auth;
    const app = new Hono();
    app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code
      : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_input' : 'service_unavailable' },
    error instanceof Problem ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 422 : 503));
    app.use('/api/*', async (context, next) => {
      if (context.req.method === 'POST' && context.req.header('origin') !== origin) throw new Problem(403, 'origin_mismatch', 'Wrong origin');
      await next();
    });
    app.get('/api/me', async context => context.json({ address: await auth.owner(getCookie(context, 'telomere_session')), demo: true }));
    // Specific Vault routes are mounted first; root EOA routes authenticate their exact principal.
    app.route('/api/platform', createPlatformVaultRuntimeRoutes(wrapped, context => auth.owner(getCookie(context, 'telomere_session'))));
    app.route('/api/platform', createPlatformRuntimeRoutes(runtime, context => auth.owner(getCookie(context, 'telomere_session'))));
    origin = await listen(app);
    auth = new Auth(store.db, loadConfig({ DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin, RPC_URL: local.local.rpcUrl,
      SIGNER_PRIVATE_KEY: local.keys.signer, DEMO_PRIVATE_KEY: local.keys.owner, ESCROW_ADDRESS: local.pins.escrowAddress, TOKEN_ADDRESS: local.pins.tokenAddress }));
    const ownerToken = await auth.session(local.accounts.owner.address), agentToken = await auth.session(binding.agentWallet);
    const eoa = new PlatformRuntimeClient({ baseUrl: origin, pins: local.pins, sessionToken: ownerToken, nowSeconds: () => now });
    const agent = new PlatformVaultRuntimeClient({ baseUrl: origin, pins: local.pins, vaultPins: vault.pins,
      vault: binding.vault, binding, sessionToken: agentToken, nowSeconds: () => now });
    // createLeash mined a block after the earlier snapshot. A fast Anvil can
    // advance chain time beyond wall time, so use the current canonical clock.
    now = await bridge.now();
    const prepared = await eoa.quote(input, 'within-five-percent');
    expect(prepared.quote.hostId).toBe(local.hostId); expect(prepared.quote.pricePerSecond).toBe('104');
    expect(prepared.ceiling).toBe('6802');
    const domain = { name: 'TelomerePlatformEscrow', version: '2', chainId: 31337, verifyingContract: local.pins.escrowAddress };
    expect(await verifyTypedData({ address: local.pins.quoteSigner, domain, types: platformQuoteTypes,
      primaryType: 'PlatformQuote', message: typedPlatformQuote(prepared.quote), signature: prepared.signature })).toBe(true);
    expect(await verifyTypedData({ address: local.pins.quoteSigner, domain: { ...domain, version: '1' }, types: platformQuoteTypes,
      primaryType: 'PlatformQuote', message: typedPlatformQuote(prepared.quote), signature: prepared.signature })).toBe(false);
    now = await bridge.now();
    const vaultPrepared = await agent.quote({ ...input, leashId: binding.leashId,
      task: { kind: 'sha256', text: 'actual economics Vault CPU' }, excludedHostIds: [local.hostId] }, 'real-vault-economics');
    expect(vaultPrepared.quote.hostId).toBe(local.secondHostId); expect(vaultPrepared.ceiling).toBe('6540');
    expect(decodeFunctionData({ abi: platformEscrowAbi, data: prepared.transaction.data as Hex }).functionName).toBe('openRun');
    const opened = await local.confirmed(local.owner.sendTransaction({ to: prepared.transaction.to, data: prepared.transaction.data as Hex, value: 0n }));
    const vaultOpened = await local.confirmed(vault.wallet.sendTransaction({ to: vaultPrepared.transaction.to,
      data: vaultPrepared.transaction.data as Hex, value: 0n }));
    expect(await bridge.feeDiscountBps(prepared.quote.runId)).toBe(100);
    expect(await bridge.feeDiscountBps(vaultPrepared.quote.runId)).toBe(100);
    expect(await local.local.publicClient.readContract({ address: local.utility, abi: local.artifact('TlmrBurnableToken').abi,
      functionName: 'balanceOf', args: [binding.vault] })).toBe(0n);
    await local.write(local.utility, 'TlmrBurnableToken', 'transfer', [local.accounts.outsider.address, parseEther('500')]);
    await local.write(local.staking, 'TlmrRewardStaking', 'requestUnstake', [ownerStakeId, parseEther('500')]);
    expect(await local.local.publicClient.readContract({ address: local.staking, abi: local.artifact('TlmrRewardStaking').abi,
      functionName: 'feeDiscountBps', args: [local.accounts.owner.address] })).toBe(0);
    expect((await eoa.admit({ runId: prepared.quote.runId, transactionHash: opened.transactionHash }, 'actual-eoa-admit')).feeDiscountBps).toBe(100);
    expect((await agent.admit({ runId: vaultPrepared.quote.runId, transactionHash: vaultOpened.transactionHash }, 'actual-vault-admit')).feeDiscountBps).toBe(100);
    // The production drain intentionally dispatches one queued run per pass.
    await runtime.drain(); await runtime.drain();
    const rows = await store.db.select().from(platformRuns);
    const settled = rows.filter(value => value.id === prepared.quote.runId || value.id === vaultPrepared.quote.runId);
    expect(settled).toHaveLength(2);
    const endedAt = Math.max(...settled.map(value => { if (!value.settlement) throw new Error('Actual economics CPU settlement absent: '
      + JSON.stringify(settled.map(row => ({ id: row.id, status: row.status, errorCode: row.errorCode })))); return value.settlement.endedAt; }));
    await local.test.setNextBlockTimestamp({ timestamp: BigInt((Math.floor(endedAt / 3600) + 1) * 3600) });
    await local.test.mine({ blocks: 1 }); now = await bridge.now(); await runtime.drain();
    const final = await eoa.get(prepared.quote.runId), vaultFinal = await agent.get(vaultPrepared.quote.runId);
    expect(final.status).toBe('completed'); expect(vaultFinal.status).toBe('completed');
    expect(final.feeDiscountBps).toBe(100); expect(vaultFinal.feeDiscountBps).toBe(100);
    for (const [run, rate, discount, text] of [[final, 104n, 100n, input.task.text],
      [vaultFinal, 100n, 100n, 'actual economics Vault CPU']] as const) {
      if (!run.settlement || !run.charged || !run.refund) throw new Error('Actual economics accounting absent');
      expect(run.settlement.billableSeconds).toBeGreaterThan(0);
      const base = BigInt(run.settlement.billableSeconds) * rate, fee = (base * (900n - discount) + 9999n) / 10000n;
      expect(run.charged).toBe((base + fee).toString()); expect(BigInt(run.charged) + BigInt(run.refund)).toBe(BigInt(run.ceiling));
      expect(run.result).toMatchObject({ output: JSON.stringify({ sha256: createHash('sha256').update(text).digest('hex') }) });
      expect(await bridge.confirmedSettlement(run.settlement, run.settlementTx!)).toMatchObject({ charged: run.charged, refund: run.refund });
    }
    expect(children.map(child => child.starts)).toEqual([1, 1]);
    // Independent reviewed legacy profiles cannot silently consume this new deployment.
    const { financialProfile: _financial, ...legacyPins } = local.pins;
    await expect(new PlatformRuntimeClient({ baseUrl: origin, pins: legacyPins, sessionToken: ownerToken }).config()).rejects.toThrow('reviewed pins');
    await expect(new PlatformVaultRuntimeClient({ baseUrl: origin, pins: legacyPins, vaultPins: vault.pins, vault: binding.vault,
      binding, sessionToken: agentToken }).config()).rejects.toThrow('reviewed pins');
    for (const wrong of ['stakingCodeHash', 'utilityTokenCodeHash'] as const) {
      const changed = new PlatformBridge(store.db, { pins: { ...local.pins, financialProfile: { ...local.pins.financialProfile!, [wrong]: randomId() } },
        rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
      await expect(changed.check()).rejects.toThrow();
    }
    const profile = local.pins.financialProfile!;
    const { discountVaultRegistry: _discountRegistry, ...withoutRegistry } = profile;
    for (const changedProfile of [withoutRegistry,
      { ...profile, discountVaultRegistry: { ...profile.discountVaultRegistry!, address: vault.registryAddress, codeHash: randomId() } },
      { ...profile, discountVaultRegistry: { ...profile.discountVaultRegistry!, address: local.utility, codeHash: await local.codeHash(local.utility) } }]) {
      const changed = new PlatformBridge(store.db, { pins: { ...local.pins, financialProfile: changedProfile },
        rpcUrl: local.local.rpcUrl, signerPrivateKey: local.keys.signer });
      await expect(changed.check()).rejects.toThrow();
    }
    expect((await store.db.select().from(platformRuns).where(eq(platformRuns.id, prepared.quote.runId)))[0]?.charged).toBe(final.charged);
  } finally {
    for (const agent of hostAgents) await agent.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    for (const journal of journals) await journal.close();
    for (const store of stores) await store.close();
    await fixture?.close();
  }
}, 130_000);
