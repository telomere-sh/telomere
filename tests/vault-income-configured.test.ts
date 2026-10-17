import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletClient, http, toHex, type Address, type Hex } from 'viem';
import { configuredVaultIncome, vaultIncomeProfileSchema } from '../src/payments/vault-income-configured.js';
import { openStore } from '../src/store.js';
import { baseMainnetUsdc, baseSepoliaUsdc, localChain } from '../src/chain/chains.js';
import { EIP3009_TYPES, EvmPaymentChain, type PaymentChain } from '../src/payments/gateway.js';
import { X402PaymentService } from '../src/payments/service.js';
import { paymentChallenges, paymentJournal, paymentResourceResults } from '../src/payments/schema.js';
import { deployVaultIncomeMainFixture, vaultIncomeMainConfig } from './fixtures/vault-income-main.js';

describe('private reviewed optional Vault income configuration', () => {
  let deployed: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>, directory: string;
  let fixture: Awaited<ReturnType<typeof vaultIncomeMainConfig>>, store: Awaited<ReturnType<typeof openStore>>;
  let chainSnapshot: Hex;
  beforeAll(async () => {
    deployed = await deployVaultIncomeMainFixture(); directory = await mkdtemp(join(tmpdir(), 'telomere-vault-income-config-'));
    fixture = await vaultIncomeMainConfig(deployed, directory); store = await openStore({ DATA_DIR: ':memory:' }); chainSnapshot = await deployed.test.snapshot();
  }, 90_000);
  beforeEach(async () => {
    await deployed.test.revert({ id: chainSnapshot }); chainSnapshot = await deployed.test.snapshot();
    await store.db.delete(paymentJournal); await store.db.delete(paymentResourceResults); await store.db.delete(paymentChallenges);
    await writeFile(fixture.profilePath, JSON.stringify(fixture.profile)); await writeFile(fixture.keyPath, deployed.facilitatorKey);
  });
  afterAll(async () => {
    await store?.close(); await deployed?.close(); if (directory) { const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-income-config-')) throw new Error('Unsafe disposable config fixture path');
      await rm(target, { recursive: true, force: true }); }
  });
  const load = () => configuredVaultIncome(fixture.config, store.db);
  const refused = async () => { await expect(load()).rejects.toThrow('Vault income configuration or reviewed deployment is unavailable'); };

  it('is disabled without a profile, performs no key/deployment work and exposes no main capability', async () => {
    const { VAULT_INCOME_CONFIG: _disabled, ...config } = fixture.config;
    expect(await configuredVaultIncome({ ...config, RPC_URL: 'https://not-requested.invalid' }, store.db)).toBeUndefined();
  });
  it('initializes only the actual reviewed native deployment and separately authorizes owner/agent sessions', async () => {
    const runtime = await load(); expect(runtime).toBeDefined();
    expect(runtime?.payments.supported().kinds).toEqual([{ x402Version: 2, scheme: 'exact', network: 'eip155:31337', extra: { facilitatorAddress: deployed.facilitator.address } }]);
    await runtime!.authorize(deployed.accounts.owner.address); await runtime!.authorize(deployed.vault.account.address);
    await expect(runtime!.authorize(deployed.accounts.outsider.address)).rejects.toMatchObject({ status: 403, code: 'vault_income_principal_required' });
  });
  it('refuses a public Circle USDC profile without a reviewed archive anchor before network access', async () => {
    const value = structuredClone(fixture.profile);
    value.localFixture = false; value.resourceUrl = 'https://pilot.example/x402/vault-income';
    value.pins.chainId = 84532; value.pins.asset = baseSepoliaUsdc; value.pins.selection.chainId = 84532;
    value.pins.reviewedTokenKind = 'circle_proxy';
    value.pins.assetImplementation = { address: '0xF0863D7A29a55d0c4263c11bFac754312ff078DF',
      codeHash: '0x72f197ff5ab8dcedf1244113dd91f245af65ae2c3354456d8bbfb6a3939ecd18' };
    value.pins.exact.name = 'USDC'; value.pins.exact.version = '2';
    await writeFile(fixture.profilePath, JSON.stringify(value));
    const requests = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(configuredVaultIncome({ ...fixture.config, MODE: 'testnet', CHAIN_ID: 84532,
        TOKEN_ADDRESS: baseSepoliaUsdc, PUBLIC_ORIGIN: 'https://pilot.example',
        RPC_URL: 'https://sepolia.base.org' }, store.db))
        .rejects.toThrow('Vault income configuration or reviewed deployment is unavailable');
      expect(requests).not.toHaveBeenCalled();
    } finally { requests.mockRestore(); }
  });
  it('allows a correctly scoped mainnet profile to reach the read-only archive preflight', async () => {
    const base = structuredClone(fixture.profile), pins = { ...base.pins, chainId: 8453, asset: baseMainnetUsdc,
      reviewedTokenKind: 'circle_proxy' as const,
      assetImplementation: { address: deployed.accounts.owner.address, codeHash: base.pins.tokenCodeHash },
      archiveAnchor: { number: '100', hash: base.pins.tokenCodeHash, timestamp: '1000' },
      exact: { reviewedEip3009: true as const, name: 'USD Coin', version: '2' },
      selection: { ...base.pins.selection, chainId: 8453 } };
    await writeFile(fixture.profilePath, JSON.stringify({ ...base, pins, localFixture: false,
      resourceUrl: 'https://pilot.example/x402/vault-income' }));
    const requests = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Read-only RPC unavailable'));
    try {
      await expect(configuredVaultIncome({ ...fixture.config, MODE: 'mainnet', CHAIN_ID: 8453,
        TOKEN_ADDRESS: baseMainnetUsdc, PUBLIC_ORIGIN: 'https://pilot.example',
        RPC_URL: 'https://mainnet.base.org' }, store.db))
        .rejects.toThrow('Vault income configuration or reviewed deployment is unavailable');
      expect(requests).toHaveBeenCalled();
    } finally { requests.mockRestore(); }
  });
  it.each(['invalid-json', 'duplicate-json', 'oversized-profile', 'unknown-field', 'zero-amount', 'uint96-overflow', 'capacity-zero', 'capacity-too-large',
    'unexpected-query', 'wrong-resource-path', 'environment-chain', 'environment-asset', 'fixture-disabled', 'relative-key-path'] as const)(
    'refuses unreviewed configuration: %s', async reason => {
      const value = structuredClone(fixture.profile);
      switch (reason) {
        case 'invalid-json': await writeFile(fixture.profilePath, '{bad'); return refused();
        case 'duplicate-json': await writeFile(fixture.profilePath, '{"pins":{},"pins":{}}'); return refused();
        case 'oversized-profile': await writeFile(fixture.profilePath, ' '.repeat(8193)); return refused();
        case 'unknown-field': await writeFile(fixture.profilePath, JSON.stringify({ ...value, upto: {} })); return refused();
        case 'zero-amount': value.grossAmount = '0'; break;
        case 'uint96-overflow': value.grossAmount = (2n ** 96n).toString(); break;
        case 'capacity-zero': value.maximumChallenges = 0; break;
        case 'capacity-too-large': value.maximumChallenges = 10_001; break;
        case 'unexpected-query': value.resourceUrl += '?x=1'; break;
        case 'wrong-resource-path': value.resourceUrl += '/'; break;
        case 'environment-chain': value.pins.chainId = 46630; break;
        case 'environment-asset': value.pins.asset = deployed.accounts.outsider.address; break;
        case 'fixture-disabled': value.localFixture = false; break;
        case 'relative-key-path': value.facilitatorKeyFile = 'facilitator.key'; break;
      }
      await writeFile(fixture.profilePath, JSON.stringify(value)); await refused();
    });
  it.each(['token-code', 'registry-code', 'vault-implementation-code', 'vault', 'agent', 'treasury', 'domain', 'depth-disagreement'] as const)(
    'checks actual independent canonical deployment pins: %s', async reason => {
      const value = structuredClone(fixture.profile), wrong = toHex(42, { size: 32 });
      switch (reason) {
        case 'token-code': value.pins.tokenCodeHash = wrong; break;
        case 'registry-code': value.pins.selection.selectionRegistryCodeHash = wrong; break;
        case 'vault-implementation-code': value.pins.selection.vaultImplementationCodeHash = wrong; break;
        case 'vault': value.pins.payTo = deployed.accounts.outsider.address; break;
        case 'agent': value.pins.agentId = wrong; break;
        case 'treasury': value.pins.treasury = deployed.accounts.owner.address; break;
        case 'domain': value.pins.exact.name = 'Not The Token'; break;
        case 'depth-disagreement': value.pins.confirmations = 2; break;
      }
      await writeFile(fixture.profilePath, JSON.stringify(value)); await refused();
    });
  it.each(['trailing-newline', 'bom', 'not-hex', 'wrong-key'] as const)('refuses malformed or mismatched dedicated private signer: %s', async reason => {
    const value = reason === 'trailing-newline' ? deployed.facilitatorKey + '\n' : reason === 'bom' ? '\ufeff' + deployed.facilitatorKey
      : reason === 'not-hex' ? 'z'.repeat(66) : deployed.keys.owner;
    await writeFile(fixture.keyPath, value); await refused();
  });
  it.each(['bridge', 'demo-owner', 'agent', 'treasury', 'other-platform-signer'] as const)(
    'requires a dedicated EOA distinct from all controller/agent/owner/treasury roles: %s', async role => {
      const value = structuredClone(fixture.profile);
      if (role === 'agent') {
        // Register an actual agent whose raw EOA key is deliberately the proposed facilitator key.
        const registry = deployed.vault.registryAddress, abi = deployed.artifact('PlatformSelectionRegistry').abi;
        const identity = await deployed.local.publicClient.readContract({ address: registry, abi, functionName: 'identityRegistry' }) as Address;
        await deployed.confirmed(deployed.owner.writeContract({ address: identity, abi: deployed.artifact('PlatformRuntimeIdentityFixture').abi,
          functionName: 'register', args: [2n, deployed.accounts.owner.address] }));
        await deployed.confirmed(deployed.owner.writeContract({ address: deployed.pins.tokenAddress, abi: deployed.artifact('MockToken').abi,
          functionName: 'faucet', args: [deployed.accounts.owner.address, 1100n] }));
        await deployed.confirmed(deployed.owner.writeContract({ address: registry, abi, functionName: 'enter', args: [{ identityId: 2n,
          agentWallet: deployed.facilitator.address, maxPerHour: 100n, maxPerDay: 1000n,
          expiry: (await deployed.local.publicClient.getBlock()).timestamp + 86_400n, cystHash: toHex(2, { size: 32 }), endowment: 1000n,
          scope: { classMask: 1n, sealedOnly: false, imageAllowRoot: toHex(0, { size: 32 }), regionAllowRoot: toHex(0, { size: 32 }) } }] }));
        value.pins.agentId = await deployed.local.publicClient.readContract({ address: registry, abi, functionName: 'identityAgent', args: [2n] }) as Hex;
        const agent = await deployed.local.publicClient.readContract({ address: registry, abi, functionName: 'getAgent', args: [value.pins.agentId] }) as { vault: Address };
        value.pins.payTo = agent.vault; await deployed.test.mine({ blocks: 2 });
        await writeFile(fixture.profilePath, JSON.stringify(value)); await refused(); return;
      }
      const account = role === 'bridge' ? deployed.accounts.signer : role === 'demo-owner' ? deployed.accounts.owner
        : role === 'treasury' ? deployed.accounts.outsider : deployed.facilitator;
      value.pins.facilitator = account.address;
      const key = role === 'bridge' ? deployed.keys.signer : role === 'demo-owner' ? deployed.keys.owner
        : role === 'treasury' ? deployed.keys.outsider : deployed.facilitatorKey;
      if (key) await writeFile(fixture.keyPath, key);
      await writeFile(fixture.profilePath, JSON.stringify(value));
      if (role === 'other-platform-signer') await expect(configuredVaultIncome(fixture.config, store.db, [account.address])).rejects.toThrow('Vault income configuration or reviewed deployment is unavailable');
      else await refused();
    });
  it('refuses reuse of a facilitator with a durable legacy token-transfer journal even before any broadcast', async () => {
    const wallet = createWalletClient({ account: deployed.facilitator, chain: localChain, transport: http(deployed.local.rpcUrl, { retryCount: 0 }) });
    const { assetImplementation, ...basePins } = fixture.profile.pins;
    const legacy = new EvmPaymentChain(deployed.local.publicClient, wallet, { ...basePins, ...(assetImplementation ? { assetImplementation } : {}) });
    const beforeSend: PaymentChain = { pins: legacy.pins, verify: legacy.verify.bind(legacy), prepare: legacy.prepare.bind(legacy),
      inspect: legacy.inspect.bind(legacy), broadcast: async () => { throw new Error('Disposable before-send interruption'); } };
    const payments = new X402PaymentService(store.db, beforeSend); await payments.initialize();
    const required = await payments.challenge({ resource: { url: fixture.profile.resourceUrl }, requestHash: toHex(5, { size: 32 }), amount: '101', scheme: 'exact' });
    const accepted = required.accepts[0]!, authorization = { from: deployed.payer.address, to: deployed.vault.agent.vault, value: 101n,
      validAfter: (await deployed.local.publicClient.getBlock()).timestamp - 1n, validBefore: BigInt(Math.floor(Date.now() / 1000)) + 120n,
      nonce: accepted.extra.telomere.nonce };
    const signature = await deployed.payer.signTypedData({ domain: { name: 'Local EIP3009 Fixture', version: '1', chainId: 31337,
      verifyingContract: deployed.pins.tokenAddress }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
    const payment = { x402Version: 2, resource: required.resource, accepted, payload: { signature, authorization: { ...authorization,
      value: '101', validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString() } } };
    const nonce = await deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address });
    expect(await payments.settle(payment, { amount: '101', requestHash: accepted.extra.telomere.requestHash })).toMatchObject({ success: false });
    expect(await store.db.select().from(paymentJournal)).toHaveLength(1);
    expect(await deployed.local.publicClient.getTransactionCount({ address: deployed.facilitator.address })).toBe(nonce);
    await refused();
  });
  it('bounds custom challenge capacity while retaining the same reviewed fixed-price schema', async () => {
    const value = vaultIncomeProfileSchema.parse({ ...fixture.profile, maximumChallenges: 1 });
    await writeFile(fixture.profilePath, JSON.stringify(value)); const runtime = await load();
    const request = { resource: { url: value.resourceUrl }, requestHash: toHex(1, { size: 32 }), amount: value.grossAmount, scheme: 'exact' as const };
    await runtime!.payments.challenge(request);
    await expect(runtime!.payments.challenge(request)).rejects.toMatchObject({ status: 503, code: 'payment_challenge_capacity_reached' });
  });
});
