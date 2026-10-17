import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { padHex, type Address, type Hex } from 'viem';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { randomId } from '../src/common.js';
import { openStore } from '../src/store.js';
import { PlatformBridge } from '../src/platform-runtime/bridge.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { platformPinsSchema, type PlatformPins } from '../src/platform-runtime/types.js';
import { PlatformVaultRuntimeClient } from '../src/platform-runtime/vault-client.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
const zero = `0x${'0'.repeat(64)}` as Hex;

describe('platform payment asset deployment pins', () => {
  let fixture: Awaited<ReturnType<typeof deployPlatformRuntime>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let bridge: PlatformBridge;
  beforeAll(async () => {
    fixture = await deployPlatformRuntime(randomId());
    store = await openStore({ DATA_DIR: ':memory:' });
    bridge = new PlatformBridge(store.db, { pins: fixture.pins, rpcUrl: fixture.local.rpcUrl, signerPrivateKey: fixture.keys.signer });
  }, 120_000);
  afterAll(async () => { await store?.close(); await fixture?.close(); });

  it('requires the canonical Circle proxy and forbids an invented authorization facet on Base', () => {
    const pins = { ...fixture.pins, chainId: 84532, tokenAddress: baseSepoliaUsdc,
      reviewedTokenKind: 'circle_proxy', assetImplementation: { address: fixture.pins.hostRegistryAddress,
        codeHash: fixture.pins.hostRegistryCodeHash } };
    expect(platformPinsSchema.safeParse(pins).success).toBe(true);
    expect(platformPinsSchema.safeParse({ ...pins, assetImplementation: undefined }).success).toBe(false);
    expect(platformPinsSchema.safeParse({ ...pins, reviewedTokenKind: 'eip1967' }).success).toBe(false);
    expect(platformPinsSchema.safeParse({ ...pins, assetFacet: { address: fixture.pins.feeRouterAddress,
      codeHash: fixture.pins.feeRouterCodeHash } }).success).toBe(false);
    expect(platformPinsSchema.safeParse({ ...pins, tokenAddress: fixture.pins.tokenAddress }).success).toBe(false);
  });

  it('SDKs compare nested implementation and facet pins instead of object string representations', async () => {
    const pins: PlatformPins = { ...fixture.pins, reviewedTokenKind: 'eip1967',
      assetImplementation: { address: fixture.pins.hostRegistryAddress, codeHash: fixture.pins.hostRegistryCodeHash },
      assetFacet: { address: fixture.pins.feeRouterAddress, codeHash: fixture.pins.feeRouterCodeHash } };
    const changed = { ...pins, assetImplementation: { ...pins.assetImplementation!, codeHash: randomId() } };
    const config = { protocol: 'telomere-platform-v1', pins: changed, maxSeconds: 120, feeBps: 900,
      capacity: [{ hostId: fixture.hostId, hardwareClass: 'cpu', region: 'test-one',
        imageDigest: `sha256:${'a'.repeat(64)}`, lane: 'standard', pricePerSecond: '1' }] };
    const fetch = async () => new Response(JSON.stringify(config), { status: 200, headers: { 'content-type': 'application/json' } });
    const options = { baseUrl: 'http://127.0.0.1:51473', pins, fetch };
    await expect(new PlatformRuntimeClient(options).config()).rejects.toThrow('reviewed pins');
    const vaultPins = { registryAddress: fixture.pins.hostRegistryAddress, registryCodeHash: fixture.pins.hostRegistryCodeHash,
      implementationAddress: fixture.pins.feeRouterAddress, implementationCodeHash: fixture.pins.feeRouterCodeHash };
    const binding = { vault: fixture.accounts.owner.address, owner: fixture.accounts.owner.address,
      agentWallet: fixture.accounts.host.address, agentId: randomId(), leashId: randomId() };
    const vaultFetch = async () => new Response(JSON.stringify({ ...config, binding, vaultPins }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    await expect(new PlatformVaultRuntimeClient({ ...options, fetch: vaultFetch, vaultPins,
      vault: binding.vault, binding }).config()).rejects.toThrow('reviewed pins');
  });

  it('rejects immutable token bytecode replacement before signing a quote', async () => {
    const original = await bridge.public.getCode({ address: fixture.pins.tokenAddress });
    if (!original) throw new Error('Local token bytecode is missing');
    try {
      await fixture.test.setCode({ address: fixture.pins.tokenAddress, bytecode: '0x60006000fd' });
      await fixture.test.mine({ blocks: 1 });
      await expect(bridge.check()).rejects.toThrow('asset code pin changed');
    } finally {
      await fixture.test.setCode({ address: fixture.pins.tokenAddress, bytecode: original });
      await fixture.test.mine({ blocks: 1 });
    }
    await expect(bridge.check()).resolves.toBeUndefined();
  });

  it('rejects simulated EIP-1967 implementation and facet upgrades before admission and settlement', async () => {
    // MockToken holds ordinary balances; the test installs an EIP-1967 slot and
    // stubs only the USDG manager's getFacet view. All code/storage/receipt reads
    // otherwise use the disposable Anvil chain and its canonical block hashes.
    const implementation = fixture.pins.hostRegistryAddress, facet = fixture.pins.feeRouterAddress;
    const pins: PlatformPins = { ...fixture.pins, reviewedTokenKind: 'eip1967',
      assetImplementation: { address: implementation, codeHash: fixture.pins.hostRegistryCodeHash },
      assetFacet: { address: facet, codeHash: fixture.pins.feeRouterCodeHash } };
    await fixture.test.setStorageAt({ address: pins.tokenAddress, index: implementationSlot, value: padHex(implementation, { size: 32 }) });
    await fixture.test.mine({ blocks: 1 });
    const proxyBridge = new PlatformBridge(store.db, { pins, rpcUrl: fixture.local.rpcUrl, signerPrivateKey: fixture.keys.signer });
    const originalRead = proxyBridge.public.readContract.bind(proxyBridge.public);
    let routed: Address = facet;
    const spy = vi.spyOn(proxyBridge.public, 'readContract').mockImplementation(async (request: any) => {
      if (request.functionName === 'getFacet' && request.address.toLowerCase() === pins.tokenAddress.toLowerCase()) return routed;
      return (originalRead as (request: unknown) => Promise<unknown>)(request);
    });
    try {
      await expect(proxyBridge.check()).resolves.toBeUndefined();
      await fixture.test.setStorageAt({ address: pins.tokenAddress, index: implementationSlot,
        value: padHex(fixture.accounts.outsider.address, { size: 32 }) });
      await fixture.test.mine({ blocks: 1 });
      await expect(proxyBridge.check()).rejects.toThrow('implementation pin changed');
      await expect(proxyBridge.settle({ runId: randomId(), billableSeconds: 0, endedAt: 1,
        inferenceCharge: '0', receiptHash: randomId() }, 0, [], randomId())).rejects.toThrow('implementation pin changed');
      await fixture.test.setStorageAt({ address: pins.tokenAddress, index: implementationSlot, value: padHex(implementation, { size: 32 }) });
      await fixture.test.mine({ blocks: 1 });
      routed = fixture.accounts.outsider.address;
      await expect(proxyBridge.check()).rejects.toThrow('facet pin changed');
      const transaction = await fixture.confirmed(fixture.owner.writeContract({ address: pins.escrowAddress,
        abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'setOpensPaused', args: [false] }));
      await expect(proxyBridge.verifyAdmission({ runId: randomId(), leashId: randomId(), hostId: fixture.hostId,
        payer: fixture.accounts.owner.address, hwClass: 0, regionHash: randomId(), imageHash: randomId(),
        workloadHash: randomId(), maxSeconds: 1, pricePerSecond: '1', inferencePrice: '0', quoteExpiry: 1 },
      '2', transaction.transactionHash)).rejects.toThrow('facet pin changed');
      routed = facet;
      await expect(proxyBridge.check()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
      await fixture.test.setStorageAt({ address: pins.tokenAddress, index: implementationSlot, value: zero });
      await fixture.test.mine({ blocks: 1 });
    }
  });
});
