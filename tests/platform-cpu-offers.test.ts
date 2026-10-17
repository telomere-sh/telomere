import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertCpuLaneOffers, cpuLaneOffer, cpuLaneOffersSchema } from '../src/scheduling/cpu-offers.js';
import { addressSchema, bytes32Schema, hashJson } from '../src/common.js';
import { PlatformRuntimeClient } from '../src/platform-runtime/client.js';
import { PlatformVaultRuntimeClient, platformVaultClientAbi } from '../src/platform-runtime/vault-client.js';
import { platformEscrowAbi, platformPinsSchema, platformPreparedSchema, platformQuoteTypes, platformWorkloadHash,
  typedPlatformQuote, validatedPlatformQuoteInputSchema } from '../src/platform-runtime/types.js';

const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const address = (digit: string) => addressSchema.parse(`0x${digit.repeat(40)}`);
const id = (digit: string) => bytes32Schema.parse(`0x${digit.repeat(64)}`);
const capability = { protocol: 'telomere-paid-preemption/v1' as const, minimumNoticeSeconds: 30 as const, hostOptInRequired: true as const };
const standard = { lane: 'standard' as const, pricePerSecond: '200', sessionPrices: { full: '200', lean: '120', torpor: '60' } };
const interruptible = { lane: 'interruptible' as const, pricePerSecond: '100',
  sessionPrices: { full: '100', lean: '80', torpor: '40' }, interruptible: capability };
const catalogue = () => cpuLaneOffersSchema.parse({ protocol: 'telomere-cpu-lane-offers-v1', offers: [standard, interruptible] });
const host = () => ({ hostId: id('a'), hardwareClass: 'cpu' as const, region: 'test-one', imageDigest: 'sha256:' + 'b'.repeat(64),
  sessionEnabled: true as const, ...standard, laneOffers: catalogue() });
const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });

describe('reviewed CPU lane offers share one physical host', () => {
  it('keeps omitted single-lane configuration and old financial workload hashes unchanged', () => {
    const physical = host(), { laneOffers: _offers, ...legacy } = physical;
    assertCpuLaneOffers(legacy);
    expect(cpuLaneOffer(legacy, 'standard')).toEqual(standard);
    expect(cpuLaneOffer(legacy, 'interruptible')).toBeUndefined();
    const input = validatedPlatformQuoteInputSchema.parse({ leashId: id('1'), task: { kind: 'session', imageDigest: physical.imageDigest, maxCommands: 4 },
      maxSeconds: 60, deadline: 1000, maxSpend: '20000' });
    expect(platformWorkloadHash(input)).toBe(hashJson({ task: input.task }));
    expect(input).not.toHaveProperty('cpuScheduling');
    expect(input).not.toHaveProperty('laneOffers');
  });

  it('resolves exact lane/profile rates without duplicating or modifying physical metadata', () => {
    const physical = host();
    expect(cpuLaneOffer(physical, 'standard')).toEqual(standard);
    expect(cpuLaneOffer(physical, 'interruptible')).toEqual(interruptible);
    expect(physical.hostId).toBe(id('a')); expect(physical.pricePerSecond).toBe('200');
  });

  it.each(['missing_base', 'changed_base', 'base_profile', 'not_session', 'duplicate', 'zero', 'missing_capability', 'wrong_full', 'extra_field'])
  ('rejects ambiguous or unsupported reviewed catalogue %s', kind => {
    const physical = host();
    let raw: unknown = physical;
    if (kind === 'missing_base') raw = { ...physical, laneOffers: { ...physical.laneOffers, offers: [interruptible] } };
    if (kind === 'changed_base') raw = { ...physical, pricePerSecond: '201' };
    if (kind === 'base_profile') raw = { ...physical, sessionPrices: { ...standard.sessionPrices, lean: '121' } };
    if (kind === 'not_session') raw = { ...physical, sessionEnabled: false };
    if (kind === 'duplicate') raw = { ...physical, laneOffers: { ...physical.laneOffers, offers: [standard, standard] } };
    if (kind === 'zero') raw = { ...physical, laneOffers: { ...physical.laneOffers, offers: [standard, { ...interruptible, pricePerSecond: '0' }] } };
    if (kind === 'missing_capability') raw = { ...physical, laneOffers: { ...physical.laneOffers, offers: [standard, { lane: 'interruptible', pricePerSecond: '100' }] } };
    if (kind === 'wrong_full') raw = { ...physical, laneOffers: { ...physical.laneOffers, offers: [standard, { ...interruptible, sessionPrices: standard.sessionPrices }] } };
    if (kind === 'extra_field') raw = { ...physical, laneOffers: { ...physical.laneOffers, offers: [standard, { ...interruptible, hostId: id('c') }] } };
    // The asserted host shape is the caller's already parsed physical boundary; malicious nested catalogues are reparsed independently.
    expect(() => assertCpuLaneOffers(Object.assign(physical, raw))).toThrow();
  });

  it('never inherits another lane profile when a reviewed offer omits reduced-quota prices', () => {
    const physical = host();
    physical.laneOffers = cpuLaneOffersSchema.parse({ ...physical.laneOffers, offers: [standard,
      { lane: 'interruptible', pricePerSecond: '100', interruptible: capability }] });
    expect(cpuLaneOffer(physical, 'interruptible')?.sessionPrices).toBeUndefined();
    expect(cpuLaneOffer(physical, 'standard')?.sessionPrices?.lean).toBe('120');
  });

  it('requires original signed lane consent rather than a caller-supplied offer catalogue', () => {
    const input = { leashId: id('1'), task: { kind: 'session', imageDigest: host().imageDigest, maxCommands: 4 },
      maxSeconds: 60, deadline: 1000, maxSpend: '20000' };
    expect(() => validatedPlatformQuoteInputSchema.parse({ ...input, cpuScheduling: { version: 1, lane: 'interruptible' } })).toThrow();
    expect(() => validatedPlatformQuoteInputSchema.parse({ ...input, laneOffers: catalogue() })).toThrow();
  });
});

async function walletFixture(vault: boolean, unsupportedLegacy = false) {
  const epoch = 1_800_000_000, owner = address('1'), agent = address('2'), vaultAddress = address('3');
  const pins = platformPinsSchema.parse({ chainId: 31337, escrowAddress: address('4'), tokenAddress: address('5'), quoteSigner: signer.address,
    receiptRootAddress: address('6'), hostRegistryAddress: address('7'), feeRouterAddress: address('8'), reviewedTokenKind: 'immutable',
    tokenCodeHash: id('1'), escrowCodeHash: id('2'), receiptRootCodeHash: id('3'), hostRegistryCodeHash: id('4'), feeRouterCodeHash: id('5') });
  const vaultPins = { registryAddress: address('9'), registryCodeHash: id('6'), implementationAddress: address('a'), implementationCodeHash: id('7') };
  const binding = { vault: vaultAddress, owner, agentWallet: agent, agentId: id('b'), leashId: id('c') };
  // EOA standard uses the non-base lane on an interruptible physical host; Vault interruptible uses the non-base lane on a standard host.
  const physical = vault ? host() : { ...host(), ...interruptible };
  if (unsupportedLegacy) {
    Reflect.deleteProperty(physical, 'laneOffers'); Reflect.deleteProperty(physical, 'interruptible');
  }
  const input = validatedPlatformQuoteInputSchema.parse({ leashId: binding.leashId,
    task: { kind: 'session', imageDigest: physical.imageDigest, maxCommands: 4, resourceProfile: 'lean' },
    maxSeconds: 60, deadline: epoch + 600, maxSpend: '20000', regions: ['test-one'],
    cpuScheduling: { version: 1, lane: vault || unsupportedLegacy ? 'interruptible' : 'standard',
      ...(vault || unsupportedLegacy ? { interruptibleConsent: { minimumNoticeSeconds: 30 } } : {}) } });
  const quote = { runId: id('d'), leashId: binding.leashId, hostId: physical.hostId, payer: vault ? vaultAddress : owner,
    hwClass: 0 as const, regionHash: keccak256(toHex(physical.region)), imageHash: keccak256(toHex(physical.imageDigest)),
    workloadHash: platformWorkloadHash(input), maxSeconds: 60, pricePerSecond: vault || unsupportedLegacy ? '80' : '120', inferencePrice: '0', quoteExpiry: epoch + 120 };
  async function signed(price = quote.pricePerSecond) {
    const q = { ...quote, pricePerSecond: price };
    const signature = await signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: 31337, verifyingContract: pins.escrowAddress },
      types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(q) });
    const base = BigInt(price) * 60n;
    return platformPreparedSchema.parse({ input, quote: q, signature, ceiling: (base + (base * 900n + 9999n) / 10000n).toString(),
      imageProof: [], regionProof: [], transaction: { chainId: 31337, to: vault ? vaultAddress : pins.escrowAddress, value: '0',
        data: vault ? encodeFunctionData({ abi: platformVaultClientAbi, functionName: 'payRun', args: [typedPlatformQuote(q), signature, [], []] })
          : encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun', args: [typedPlatformQuote(q), signature, [], []] }) } });
  }
  const config = { protocol: 'telomere-platform-v1', pins, maxSeconds: 120, feeBps: 900, capacity: [physical],
    ...(vault ? { vaultPins, binding } : {}) };
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/me' ? { address: owner, demo: false } : config));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address(); if (!port || typeof port === 'string') throw new Error('Missing local SDK fixture address');
  close.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const options = { baseUrl: 'http://127.0.0.1:' + port.port, pins, nowSeconds: () => epoch };
  const client = vault ? new PlatformVaultRuntimeClient({ ...options, vaultPins, vault: vaultAddress, binding }) : new PlatformRuntimeClient(options);
  return { client, signed, config };
}

describe('Node SDK independently verifies non-base lane prices over actual local HTTP', () => {
  it.each([false, true])('checks exact signed lane/profile and unsigned payment calldata, vault=%s', async vault => {
    const f = await walletFixture(vault), prepared = await f.signed();
    expect((await f.client.config()).capacity).toHaveLength(1);
    expect(await f.client.openPlan(prepared)).toEqual(prepared.transaction);
    await expect(f.client.openPlan(await f.signed(vault ? '120' : '80'))).rejects.toThrow('quote changed');
    f.config.capacity[0]!.laneOffers.offers.reverse();
    expect(await f.client.openPlan(prepared)).toEqual(prepared.transaction);
  });

  it('refuses a retained signed plan after its exact offered rate is withdrawn', async () => {
    const f = await walletFixture(true), prepared = await f.signed();
    f.config.capacity[0]!.laneOffers = cpuLaneOffersSchema.parse({ ...f.config.capacity[0]!.laneOffers, offers: [standard] });
    await expect(f.client.openPlan(prepared)).rejects.toThrow('quote changed');
  });

  it('rejects duplicated physical hosts even when their nested offers and prices differ', async () => {
    const f = await walletFixture(true);
    f.config.capacity.push({ ...f.config.capacity[0]!, ...interruptible });
    await expect(f.client.config()).rejects.toThrow('ambiguous hosts');
  });

  it('refuses a real signed EOA interruptible plan whose legacy host omits preemption capability', async () => {
    const f = await walletFixture(false, true), prepared = await f.signed();
    expect((await f.client.config()).capacity[0]).not.toHaveProperty('laneOffers');
    await expect(f.client.openPlan(prepared)).rejects.toThrow('quote changed');
  });
});
