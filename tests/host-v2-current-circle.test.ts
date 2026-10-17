import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, domainSeparator, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { hashJson, randomId } from '../src/common.js';
import { Ed25519Identity, hostMessageHash, leaseSchema } from '../src/host-kit/protocol.js';
import { ArchiveHostV2AdmissionAuthority } from '../src/host-kit/v2-admission.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT } from '../src/payments/circle-usdc.js';
import { platformPinsSchema, platformQuoteSchema, platformQuoteTypes,
  typedPlatformQuote } from '../src/platform-runtime/types.js';
import { platformV2DelegationSchema, platformV2DelegationTypedData } from '../src/receipts/platform-v2.js';
import { readPlatformV2OpeningAuthority, recheckPlatformV2Opening } from '../src/receipts/platform-v2-history.js';

vi.mock('../src/receipts/platform-v2-history.js', () => ({
  readPlatformV2OpeningAuthority: vi.fn(), recheckPlatformV2Opening: vi.fn(),
}));

describe('HostKit v2 current native Base USDC authority', () => {
  it('checks the Circle legacy slot, implementation code and exact native EIP-712 metadata before admission', async () => {
    const host = new Ed25519Identity(), controller = new Ed25519Identity();
    const signer = privateKeyToAccount(randomId()), owner = '0x1111111111111111111111111111111111111111';
    const address = (digit: string) => `0x${digit.repeat(40)}` as const;
    const code = '0x60016000f3' as const, codeHash = keccak256(code);
    const pins = platformPinsSchema.parse({ chainId: 84532, escrowAddress: address('2'),
      tokenAddress: baseSepoliaUsdc, quoteSigner: signer.address,
      receiptRootAddress: address('3'), hostRegistryAddress: address('4'), feeRouterAddress: address('5'),
      tokenCodeHash: codeHash, reviewedTokenKind: 'circle_proxy',
      assetImplementation: { address: address('6'), codeHash },
      escrowCodeHash: codeHash, receiptRootCodeHash: codeHash,
      hostRegistryCodeHash: codeHash, feeRouterCodeHash: codeHash });
    const issuedAt = 1_700_000_000_000, image = `fixture/cpu@sha256:${'a'.repeat(64)}`;
    const quote = platformQuoteSchema.parse({ runId: randomId(), leashId: randomId(), hostId: randomId(),
      payer: owner, hwClass: 0, regionHash: randomId(), imageHash: keccak256(toHex(image.split('@')[1]!)),
      workloadHash: randomId(), maxSeconds: 20, pricePerSecond: '100', inferencePrice: '0',
      quoteExpiry: issuedAt / 1000 + 300 });
    const quoteSignature = await signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
      chainId: pins.chainId, verifyingContract: pins.escrowAddress }, types: platformQuoteTypes,
    primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
    const lease = controller.sign('lease', leaseSchema.parse({ version: 1, hostKey: host.publicKey,
      runId: quote.runId, owner, image, argv: ['/app/run'], issuedAt,
      expiresAt: issuedAt + 20_000, maxSeconds: 20, nonce: randomId() }));
    const body = platformV2DelegationSchema.parse({ version: 2, chainId: pins.chainId,
      escrow: pins.escrowAddress, hostRegistry: pins.hostRegistryAddress,
      runId: quote.runId, hostId: quote.hostId, hostKey: host.publicKey, controllerKey: controller.publicKey,
      quoteHash: hashJson(quote), signedLeaseHash: hostMessageHash(lease),
      meterLeaseHash: hostMessageHash({ body: lease.body, signature: '' }), leaseIssuedAtMs: issuedAt,
      leaseExpiresAtMs: lease.body.expiresAt, maxSeconds: 20, nonce: randomId() });
    const delegation = { body, signature: await signer.signTypedData(platformV2DelegationTypedData(body)) };
    const admissionTx = randomId(), blockHash = randomId();
    const envelope = { version: 2 as const, admissionTx, lease, quote, quoteSignature, delegation };
    vi.mocked(readPlatformV2OpeningAuthority).mockResolvedValue({ authority: {
      chainId: pins.chainId, escrow: pins.escrowAddress, hostRegistry: pins.hostRegistryAddress,
      quoteSigner: signer.address, runId: quote.runId, hostId: quote.hostId, hostKey: host.publicKey as Hex,
      payer: owner, leashId: quote.leashId, hwClass: 0, regionHash: quote.regionHash,
      imageHash: quote.imageHash, workloadHash: quote.workloadHash, pricePerSecond: quote.pricePerSecond,
      inferencePrice: '0', quoteExpiry: quote.quoteExpiry, maxSeconds: 20,
      openedAt: issuedAt / 1000, cutoff: issuedAt / 1000 + 20,
    }, opening: { transactionHash: admissionTx, blockHash, blockNumber: 100n, logIndex: 0, confirmations: 12n } });
    vi.mocked(recheckPlatformV2Opening).mockResolvedValue();
    const implementation = pins.assetImplementation!;
    const slotCalls: unknown[] = [], canonicalReads: unknown[] = [];
    let changed = '';
    const metadata: Record<string, unknown> = { name: 'USDC', symbol: 'USDC', version: '2', decimals: 6,
      DOMAIN_SEPARATOR: domainSeparator({ domain: { name: 'USDC', version: '2', chainId: 84532,
        verifyingContract: pins.tokenAddress } }) };
    const noNetwork = createPublicClient({ transport: custom({ request: async () => {
      throw new Error('Unexpected network request in current Circle admission fixture');
    } }) });
    const client = new Proxy(noNetwork, { get(target, key, receiver) {
      if (key === 'getChainId') return async () => pins.chainId;
      if (key === 'getBlock') return async () => ({ hash: blockHash, number: 100n, timestamp: BigInt(issuedAt / 1000 + 1) });
      if (key === 'getCode') return async (args: Parameters<PublicClient['getCode']>[0]) => {
        canonicalReads.push(args);
        return changed === 'code' && args.address === implementation.address ? '0x60026000f3' : code;
      };
      if (key === 'getStorageAt') return async (args: Parameters<PublicClient['getStorageAt']>[0]) => {
        slotCalls.push(args); canonicalReads.push(args);
        return `0x${'0'.repeat(24)}${(changed === 'slot' ? address('7') : implementation.address).slice(2)}`;
      };
      if (key !== 'readContract') return Reflect.get(target, key, receiver);
      return async (args: Parameters<PublicClient['readContract']>[0]) => {
        canonicalReads.push(args);
        const fn = args.functionName;
        if (fn in metadata) return changed === fn ? (fn === 'decimals' ? 18 : randomId()) : metadata[fn];
        if (fn === 'token') return pins.tokenAddress;
        if (fn === 'quoteSigner') return signer.address;
        if (fn === 'receiptRoot' || fn === 'evidenceRoot') return pins.receiptRootAddress;
        if (fn === 'hostRegistry') return pins.hostRegistryAddress;
        if (fn === 'feeRouter') return pins.feeRouterAddress;
        if (fn === 'controller') return pins.escrowAddress;
        if (fn === 'MAX_RUN_CEILING') return 250_000_000n;
        if (fn === 'MAX_LEASH_DAY') return 1_000_000_000n;
        if (fn === 'MAX_TOTAL_ESCROW') return 500_000_000_000n;
        if (fn === 'getRun') return { ...typedPlatformQuote(quote), status: 1, stopAt: 0n,
          hostReleased: false, openedAt: BigInt(issuedAt / 1000), acceptedExpiry: BigInt(quote.quoteExpiry),
          sealedHost: false, hostOperator: owner };
        if (fn === 'getLeash') return { owner, killed: false, expiry: BigInt(quote.quoteExpiry) };
        if (fn === 'getHost') return { hostKey: host.publicKey, active: true, unbondAt: 0n,
          kind: 0, gpu: false, operator: owner };
        throw new Error(`Unexpected current Circle fixture contract function ${fn}`);
      };
    } });
    const authority = new ArchiveHostV2AdmissionAuthority(client, pins, 12);
    expect(await authority.verify(envelope, host.publicKey, controller.publicKey))
      .toEqual({ openingBlockHash: blockHash, cutoffMs: issuedAt + 20_000 });
    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0]).toMatchObject({ slot: CIRCLE_PROXY_IMPLEMENTATION_SLOT,
      address: pins.tokenAddress, blockHash, requireCanonical: true });
    for (const change of ['slot', 'code', 'name', 'symbol', 'version', 'decimals', 'DOMAIN_SEPARATOR']) {
      changed = change;
      await expect(authority.verify(envelope, host.publicKey, controller.publicKey))
        .rejects.toThrow('current native USDC implementation or domain');
    }
    for (const read of canonicalReads) expect(read).toMatchObject({ blockHash, requireCanonical: true });
  });
});
