import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, domainSeparator, encodeAbiParameters, encodeFunctionData,
  keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepoliaUsdc } from '../src/chain/chains.js';
import { hashJson, randomId } from '../src/common.js';
import { HostMeterVerifier } from '../src/host-kit/meter.js';
import { Ed25519Identity, hostMessageHash, hostTickSchema, leaseSchema } from '../src/host-kit/protocol.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT } from '../src/payments/circle-usdc.js';
import { platformEscrowAbi, platformPinsSchema, platformQuoteSchema, platformQuoteTypes,
  typedPlatformQuote } from '../src/platform-runtime/types.js';
import { platformV2DelegationSchema, platformV2DelegationTypedData, platformV2ReceiptHash,
  preparePlatformV2EvidenceCore } from '../src/receipts/platform-v2.js';
import { readPlatformV2OpeningAuthority, verifyPlatformV2OpeningEvidence } from '../src/receipts/platform-v2-history.js';

async function fixture() {
  const host = new Ed25519Identity(), controller = new Ed25519Identity(), signer = privateKeyToAccount(randomId());
  const owner = '0x1111111111111111111111111111111111111111', address = (digit: string) => `0x${digit.repeat(40)}` as const;
  const code = '0x60016000f3' as const, codeHash = keccak256(code);
  const pins = platformPinsSchema.parse({ chainId: 84532, escrowAddress: address('2'), tokenAddress: baseSepoliaUsdc,
    quoteSigner: signer.address, receiptRootAddress: address('3'), hostRegistryAddress: address('4'), feeRouterAddress: address('5'),
    tokenCodeHash: codeHash, reviewedTokenKind: 'circle_proxy', assetImplementation: { address: address('6'), codeHash },
    escrowCodeHash: codeHash, receiptRootCodeHash: codeHash, hostRegistryCodeHash: codeHash, feeRouterCodeHash: codeHash });
  const issuedAt = 1_700_000_000_000, blockHash = randomId(), parentHash = randomId(), transactionHash = randomId();
  const blockNumber = 100n, openedAt = BigInt(issuedAt / 1000), image = `fixture/cpu@sha256:${'a'.repeat(64)}`;
  const hostId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'bytes32' }], [BigInt(pins.chainId), pins.hostRegistryAddress, owner, host.publicKey as Hex]));
  const quote = platformQuoteSchema.parse({ runId: randomId(), leashId: randomId(), hostId, payer: owner, hwClass: 0,
    regionHash: randomId(), imageHash: keccak256(toHex(image.split('@')[1]!)), workloadHash: randomId(), maxSeconds: 20,
    pricePerSecond: '100', inferencePrice: '0', quoteExpiry: issuedAt / 1000 + 300 });
  const quoteSignature = await signer.signTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '1',
    chainId: pins.chainId, verifyingContract: pins.escrowAddress }, types: platformQuoteTypes,
  primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
  const input = encodeFunctionData({ abi: platformEscrowAbi, functionName: 'openRun',
    args: [typedPlatformQuote(quote), quoteSignature, [], []] });
  const log = { blockHash, blockNumber, transactionHash, transactionIndex: 0, removed: false };
  const registryLog = { ...log, logIndex: 0, address: pins.hostRegistryAddress, data: '0x' as const,
    topics: [keccak256(toHex('RunOpened(bytes32,bytes32)')), quote.hostId, quote.runId] };
  const escrowLog = { ...log, logIndex: 1, address: pins.escrowAddress,
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint96' }, { type: 'uint64' }, { type: 'uint64' }],
      [owner, 2000n, openedAt, 20n]),
    topics: [keccak256(toHex('RunOpened(bytes32,bytes32,bytes32,address,uint96,uint64,uint64)')),
      quote.runId, quote.leashId, quote.hostId] };
  const receipt = { transactionHash, blockHash, blockNumber, status: 'success' as const,
    to: pins.escrowAddress, from: owner, logs: [registryLog, escrowLog] };
  const transaction = { hash: transactionHash, blockHash, blockNumber, to: pins.escrowAddress,
    from: owner, chainId: pins.chainId, value: 0n, input };
  const run = { ...typedPlatformQuote(quote), payer: owner, hostOperator: owner, sealedHost: false,
    openedAt, acceptedExpiry: openedAt + 300n, ceiling: 2000n, status: 1 };
  const metadata: Record<string, unknown> = { name: 'USDC', symbol: 'USDC', version: '2', decimals: 6,
    DOMAIN_SEPARATOR: domainSeparator({ domain: { name: 'USDC', version: '2', chainId: pins.chainId,
      verifyingContract: pins.tokenAddress } }) };
  const implementation = pins.assetImplementation!, reads: { method: string; args: unknown }[] = [];
  let changed = '', blockReads = 0;
  const noNetwork = createPublicClient({ transport: custom({ request: async () => {
    throw new Error('Unexpected network request in historical Circle opening fixture');
  } }) });
  const client = new Proxy(noNetwork, { get(target, key, receiver) {
    if (key === 'getChainId') return async () => pins.chainId;
    if (key === 'getTransactionReceipt') return async () => receipt;
    if (key === 'getTransaction') return async () => transaction;
    if (key === 'getBlockNumber') return async () => 116n;
    if (key === 'getBlock') return async (args: Parameters<PublicClient['getBlock']>[0]) => {
      const parent = args?.blockNumber === 99n;
      if (!parent) blockReads++;
      return { hash: parent ? parentHash : changed === 'reorg' && blockReads >= 3 ? randomId() : blockHash,
        number: parent ? 99n : 100n, timestamp: parent ? openedAt - 1n : openedAt };
    };
    if (key === 'getCode') return async (args: Parameters<PublicClient['getCode']>[0]) => {
      reads.push({ method: 'getCode', args });
      if (changed === 'parent-unavailable' && args.blockHash === parentHash) throw new Error('parent archive state unavailable');
      if (changed === 'implementation-code' && args.address === implementation.address
        || changed === 'parent-code' && args.address === pins.tokenAddress && args.blockHash === parentHash) return '0x60026000f3';
      return code;
    };
    if (key === 'getStorageAt') return async (args: Parameters<PublicClient['getStorageAt']>[0]) => {
      reads.push({ method: 'getStorageAt', args });
      const wrongSlot = changed === 'slot' || changed === 'parent-slot' && args.blockHash === parentHash;
      return `0x${'0'.repeat(24)}${(wrongSlot ? address('7') : implementation.address).slice(2)}`;
    };
    if (key === 'getLogs') return async (args: Parameters<PublicClient['getLogs']>[0]) => {
      reads.push({ method: 'getLogs', args });
      return changed === 'upgrade' ? [{ transactionHash: randomId() }] : [];
    };
    if (key !== 'readContract') return Reflect.get(target, key, receiver);
    return async (args: Parameters<PublicClient['readContract']>[0]) => {
      reads.push({ method: 'readContract', args });
      const fn = args.functionName;
      if (fn in metadata) return changed === fn ? (fn === 'decimals' ? 18 : randomId()) : metadata[fn];
      if (fn === 'getRun') return run;
      if (fn === 'getHost') return { hostKey: host.publicKey, operator: owner, kind: 0 };
      if (fn === 'quoteSigner') return signer.address;
      if (fn === 'token') return pins.tokenAddress;
      if (fn === 'hostRegistry') return pins.hostRegistryAddress;
      if (fn === 'receiptRoot' || fn === 'evidenceRoot') return pins.receiptRootAddress;
      if (fn === 'feeRouter') return pins.feeRouterAddress;
      if (fn === 'controller') return pins.escrowAddress;
      throw new Error(`Unexpected historical Circle fixture contract function ${fn}`);
    };
  } });
  return { client, pins, quote, quoteSignature, host, controller, signer, transactionHash, blockHash, parentHash,
    issuedAt, image, reads, mutate(value: string) { changed = value; blockReads = 0; } };
}

describe('historical native Base USDC Platform v2 opening authority', () => {
  it('accepts the exact native domain and stable Circle implementation at canonical opening and parent states', async () => {
    const value = await fixture();
    const opening = await readPlatformV2OpeningAuthority(value.client, value.pins, value.transactionHash, 12);
    expect(opening).toMatchObject({ authority: { chainId: 84532, runId: value.quote.runId,
      quoteSigner: value.pins.quoteSigner, hostKey: value.host.publicKey },
    opening: { transactionHash: value.transactionHash, blockHash: value.blockHash, confirmations: 17n, logIndex: 1 } });
    const slots = value.reads.filter(read => read.method === 'getStorageAt');
    expect(slots).toHaveLength(3);
    for (const read of slots) expect(read.args).toMatchObject({ address: value.pins.tokenAddress,
      slot: CIRCLE_PROXY_IMPLEMENTATION_SLOT, requireCanonical: true });
    expect(slots.some(read => (read.args as { blockHash: Hex }).blockHash === value.parentHash)).toBe(true);
    for (const read of value.reads.filter(read => read.method !== 'getLogs')) {
      expect(read.args).toMatchObject({ requireCanonical: true });
    }
  });

  it('rejects altered implementation, metadata, parent pins, same-block upgrade/rollback, unavailable archive and reorg', async () => {
    const value = await fixture();
    for (const changed of ['slot', 'implementation-code', 'name', 'symbol', 'version', 'decimals',
      'DOMAIN_SEPARATOR', 'parent-slot', 'parent-code', 'upgrade', 'reorg']) {
      value.mutate(changed);
      await expect(readPlatformV2OpeningAuthority(value.client, value.pins, value.transactionHash, 12))
        .rejects.toThrow('historical Circle USDC implementation or domain');
    }
    value.mutate('parent-unavailable');
    await expect(readPlatformV2OpeningAuthority(value.client, value.pins, value.transactionHash, 12))
      .rejects.toThrow('parent archive state unavailable');
  });

  it('binds the public host admission transaction and block to the canonical archive opening', async () => {
    const value = await fixture(), { quote, quoteSignature, host, controller, issuedAt, image } = value;
    const opening = await readPlatformV2OpeningAuthority(value.client, value.pins, value.transactionHash, 12);
    const lease = controller.sign('lease', leaseSchema.parse({ version: 1, hostKey: host.publicKey,
      runId: quote.runId, owner: quote.payer, image, argv: ['/app/run', 'PRIVATE_ARGV'], stdin: 'PRIVATE_STDIN',
      issuedAt, expiresAt: issuedAt + quote.maxSeconds * 1000, maxSeconds: quote.maxSeconds, nonce: randomId() }));
    const body = platformV2DelegationSchema.parse({ version: 2, chainId: value.pins.chainId,
      escrow: value.pins.escrowAddress, hostRegistry: value.pins.hostRegistryAddress,
      runId: quote.runId, hostId: quote.hostId, hostKey: host.publicKey, controllerKey: controller.publicKey,
      quoteHash: hashJson(quote), signedLeaseHash: hostMessageHash(lease),
      meterLeaseHash: hostMessageHash({ body: lease.body, signature: '' }), leaseIssuedAtMs: issuedAt,
      leaseExpiresAtMs: lease.body.expiresAt, maxSeconds: quote.maxSeconds, nonce: randomId() });
    const delegation = { body, signature: await value.signer.signTypedData(platformV2DelegationTypedData(body)) };
    const envelope = { version: 2 as const, admissionTx: value.transactionHash, lease, quote, quoteSignature, delegation };
    const hostAdmission = host.sign('v2-admission', { version: 2 as const, chainId: value.pins.chainId,
      escrow: value.pins.escrowAddress, hostRegistry: value.pins.hostRegistryAddress,
      runId: quote.runId, hostId: quote.hostId, hostKey: host.publicKey, controllerKey: controller.publicKey,
      owner: lease.body.owner, admissionTx: value.transactionHash, openingBlockHash: value.blockHash,
      quoteHash: hashJson(quote), signedLeaseHash: body.signedLeaseHash, meterLeaseHash: body.meterLeaseHash,
      delegationHash: hashJson(delegation), envelopeHash: hashJson(envelope), acceptedAtMs: issuedAt });
    const meter = new HostMeterVerifier(lease.body, controller, () => issuedAt + 1000);
    const tick = host.sign('tick', hostTickSchema.parse({ version: 1, hostKey: host.publicKey, runId: quote.runId,
      owner: quote.payer, leaseHash: meter.leaseHash, sequence: 0, timestamp: issuedAt + 1000,
      elapsedMs: 1000, cpuMs: 100, state: 'EXITED', previousHash: null, heartbeat: null,
      gpuUtil: 0, gpuMemoryBytes: 0, powerWatts: 0 }));
    const prepared = await preparePlatformV2EvidenceCore({ quote, quoteSignature, delegation, lease, hostAdmission,
      ticks: [tick], acknowledgments: [meter.accept(tick)], endedAt: issuedAt / 1000 + 1,
      billableSeconds: 0, inferenceCharge: '0', status: 'completed', output: 'PRIVATE_OUTPUT', outputSalt: randomId() }, opening.authority);
    expect(await verifyPlatformV2OpeningEvidence(value.client, value.pins, value.transactionHash,
      prepared.core, prepared.receiptHash, 12)).toMatchObject({ hostAdmissionVerified: true,
      historicalAuthoritySource: 'archive-rpc', historicalDelegationIssuanceTimeProven: false });
    for (const changed of [{ admissionTx: randomId() }, { openingBlockHash: randomId() }]) {
      const core = { ...prepared.core, hostAdmission: host.sign('v2-admission', { ...hostAdmission.body, ...changed }) };
      await expect(verifyPlatformV2OpeningEvidence(value.client, value.pins, value.transactionHash,
        core, platformV2ReceiptHash(core), 12)).rejects.toThrow('canonical opening transaction');
    }
  });
});
