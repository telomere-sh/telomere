import { keccak256, parseAbi, toHex, verifyTypedData, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { bytes32Schema, hashJson, sameAddress, signatureSchema } from '../common.js';
import { tokenAbi } from '../chain/abi.js';
import { matchesAssetFacetPins } from '../payments/asset-facets.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata } from '../payments/circle-usdc.js';
import { readPlatformV2OpeningAuthority, recheckPlatformV2Opening } from '../receipts/platform-v2-history.js';
import { platformV2DelegationTypedData, signedPlatformV2DelegationSchema } from '../receipts/platform-v2.js';
import { platformEscrowAbi, platformHostRegistryAbi, platformPinsSchema, platformQuoteSchema,
  platformQuoteDomainVersion, platformQuoteTypes, typedPlatformQuote, type PlatformPins } from '../platform-runtime/types.js';
import { checkPlatformEconomicsAt, readPlatformFeeDiscount } from '../economics/profile.js';
import { PAID_SESSION_ARGV } from './sessions/paid-protocol.js';
import { hostKeySchema, hostMessageHash, signedLeaseSchema, verifyHostMessage } from './protocol.js';
export { hostV2AdmissionReceiptSchema, type SignedHostV2AdmissionReceipt } from './v2-admission-receipt.js';

const routerAbi = parseAbi(['function token() view returns (address)', 'function controller() view returns (address)']);
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

/** The opt-in HostKit route accepts one exact signed authorization envelope. */
export const hostV2AdmissionEnvelopeSchema = z.object({
  version: z.literal(2), admissionTx: bytes32Schema, lease: signedLeaseSchema,
  quote: platformQuoteSchema, quoteSignature: signatureSchema,
  delegation: signedPlatformV2DelegationSchema,
}).strict();
export type HostV2AdmissionEnvelope = z.infer<typeof hostV2AdmissionEnvelopeSchema>;

export type HostV2AdmissionAuthority = Readonly<{
  verify(envelope: HostV2AdmissionEnvelope, hostKey: string, controllerKey: string): Promise<{
    openingBlockHash: `0x${string}`; cutoffMs: number }>;
}>;

/**
 * Host-configured read-only chain authority. A request cannot supply RPC or deployment pins.
 * This does not supply an independently trusted clock for the offchain admission.
 */
export class ArchiveHostV2AdmissionAuthority implements HostV2AdmissionAuthority {
  readonly pins: PlatformPins;
  constructor(private readonly publicClient: PublicClient, rawPins: PlatformPins,
    private readonly minConfirmations = 12) {
    this.pins = platformPinsSchema.parse(rawPins);
    if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 128) {
      throw new Error('Host v2 opening confirmation depth is invalid');
    }
  }
  private async checkCurrentPins(blockHash: Hex): Promise<void> {
    const pins = this.pins, client = this.publicClient;
    const state = { blockHash, requireCanonical: true } as const;
    const codePins = [
      [pins.escrowAddress, pins.escrowCodeHash], [pins.hostRegistryAddress, pins.hostRegistryCodeHash],
      [pins.receiptRootAddress, pins.receiptRootCodeHash], [pins.feeRouterAddress, pins.feeRouterCodeHash],
      [pins.tokenAddress, pins.tokenCodeHash],
    ] as const;
    const codes = await Promise.all(codePins.map(([address]) => client.getCode({ address, ...state })));
    if (codes.some((code, index) => !code || code === '0x' || keccak256(code) !== codePins[index]![1])) {
      throw new Error('Host v2 current contract code differs from reviewed pins');
    }
    await checkPlatformEconomicsAt(client, pins, blockHash);
    if (pins.reviewedTokenKind === 'eip1967') {
      const implementation = pins.assetImplementation!;
      const [slot, code] = await Promise.all([
        client.getStorageAt({ address: pins.tokenAddress, slot: implementationSlot, ...state }),
        client.getCode({ address: implementation.address, ...state }),
      ]);
      if (!slot || !sameAddress(`0x${slot.slice(-40)}`, implementation.address)
        || !code || keccak256(code) !== implementation.codeHash) {
        throw new Error('Host v2 current asset implementation differs from reviewed pins');
      }
      if (pins.assetFacet && !await matchesAssetFacetPins(client, pins.tokenAddress, pins.assetFacet, state)) {
        throw new Error('Host v2 current asset facet differs from reviewed pins');
      }
    }
    if (pins.reviewedTokenKind === 'circle_proxy') {
      if (!pins.assetImplementation || !await matchesCircleProxyPins(client, pins.tokenAddress,
        pins.assetImplementation, state)
        || !await matchesNativeBaseUsdcMetadata(client, pins.chainId, pins.tokenAddress, state)) {
        throw new Error('Host v2 current native USDC implementation or domain differs from reviewed pins');
      }
    }
    const [token, signer, roots, hosts, router, registryToken, registryController, registryRoot,
      routerToken, routerController, decimals, maxRunCeiling, maxLeashDay, maxTotalEscrow] = await Promise.all([
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'token', ...state }),
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'quoteSigner', ...state }),
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'receiptRoot', ...state }),
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'hostRegistry', ...state }),
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'feeRouter', ...state }),
      client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'token', ...state }),
      client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'controller', ...state }),
      client.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi, functionName: 'evidenceRoot', ...state }),
      client.readContract({ address: pins.feeRouterAddress, abi: routerAbi, functionName: 'token', ...state }),
      client.readContract({ address: pins.feeRouterAddress, abi: routerAbi, functionName: 'controller', ...state }),
      client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'decimals', ...state }),
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'MAX_RUN_CEILING', ...state }),
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'MAX_LEASH_DAY', ...state }),
      client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'MAX_TOTAL_ESCROW', ...state }),
    ]);
    if (![[token, pins.tokenAddress], [signer, pins.quoteSigner], [roots, pins.receiptRootAddress],
      [hosts, pins.hostRegistryAddress], [router, pins.feeRouterAddress],
      [registryToken, pins.tokenAddress], [registryController, pins.escrowAddress],
      [registryRoot, pins.receiptRootAddress], [routerToken, pins.tokenAddress],
      [routerController, pins.escrowAddress]].every(([actual, expected]) => sameAddress(actual!, expected!))
      || decimals !== 6 || maxRunCeiling !== 250_000_000n || maxLeashDay !== 1_000_000_000n
      || maxTotalEscrow !== 500_000_000_000n) {
      throw new Error('Host v2 current contract relationships or financial limits differ from reviewed pins');
    }
  }
  async verify(raw: HostV2AdmissionEnvelope, hostKeyValue: string, controllerKeyValue: string): Promise<{
    openingBlockHash: `0x${string}`; cutoffMs: number }> {
    const envelope = hostV2AdmissionEnvelopeSchema.parse(raw), hostKey = hostKeySchema.parse(hostKeyValue);
    const controllerKey = hostKeySchema.parse(controllerKeyValue);
    const { lease, quote, delegation, quoteSignature, admissionTx } = envelope;
    const body = delegation.body, pins = this.pins;
    const signedLeaseHash = hostMessageHash(lease);
    const meterLeaseHash = hostMessageHash({ body: lease.body, signature: '' });
    if (!verifyHostMessage(controllerKey, 'lease', lease)
      || lease.body.runId !== quote.runId || lease.body.hostKey !== hostKey
      || !sameAddress(lease.body.owner, quote.payer)
      || lease.body.maxSeconds !== quote.maxSeconds
      || lease.body.argv.length === PAID_SESSION_ARGV.length
        && lease.body.argv.every((arg, index) => arg === PAID_SESSION_ARGV[index])
      || quote.inferencePrice !== '0' || quote.hwClass !== 0
      || keccak256(toHex(lease.body.image.split('@')[1]!)) !== quote.imageHash
      || body.chainId !== pins.chainId || !sameAddress(body.escrow, pins.escrowAddress)
      || !sameAddress(body.hostRegistry, pins.hostRegistryAddress)
      || body.runId !== quote.runId || body.hostId !== quote.hostId
      || body.hostKey !== hostKey || body.controllerKey !== controllerKey
      || body.quoteHash !== hashJson(quote) || body.signedLeaseHash !== signedLeaseHash
      || body.meterLeaseHash !== meterLeaseHash || body.leaseIssuedAtMs !== lease.body.issuedAt
      || body.leaseExpiresAtMs !== lease.body.expiresAt || body.maxSeconds !== lease.body.maxSeconds) {
      throw new Error('Host v2 exact quote, lease, or delegation scope differs');
    }
    let validDelegation = false, validQuote = false;
    try {
      [validDelegation, validQuote] = await Promise.all([
        verifyTypedData({ address: pins.quoteSigner,
          ...platformV2DelegationTypedData(body), signature: delegation.signature }),
        verifyTypedData({ address: pins.quoteSigner,
          domain: { name: 'TelomerePlatformEscrow', version: platformQuoteDomainVersion(pins), chainId: pins.chainId,
            verifyingContract: pins.escrowAddress }, types: platformQuoteTypes,
          primaryType: 'PlatformQuote', message: typedPlatformQuote(quote), signature: quoteSignature }),
      ]);
    } catch { /* Invalid signatures fail closed. */ }
    if (!validDelegation || !validQuote) throw new Error('Host v2 EOA authorization is invalid');
    const opening = await readPlatformV2OpeningAuthority(this.publicClient, pins,
      admissionTx, this.minConfirmations);
    const historical = opening.authority;
    if (historical.runId !== quote.runId || historical.hostId !== quote.hostId
      || historical.hostKey !== hostKey || !sameAddress(historical.payer, quote.payer)
      || historical.leashId !== quote.leashId || historical.regionHash !== quote.regionHash
      || historical.imageHash !== quote.imageHash || historical.workloadHash !== quote.workloadHash
      || historical.maxSeconds !== quote.maxSeconds || historical.quoteExpiry !== quote.quoteExpiry
      || historical.pricePerSecond !== quote.pricePerSecond || historical.inferencePrice !== '0'
      || lease.body.issuedAt < historical.openedAt * 1000 - 5000
      || lease.body.issuedAt > historical.cutoff * 1000) {
      throw new Error('Host v2 envelope differs from canonical opening authority');
    }
    const snapshot = await this.publicClient.getBlock();
    if (await this.publicClient.getChainId() !== pins.chainId) {
      throw new Error('Host v2 current chain differs from reviewed pins');
    }
    const state = { blockHash: snapshot.hash, requireCanonical: true } as const;
    await this.checkCurrentPins(snapshot.hash);
    if (pins.financialProfile && historical.feeDiscountBps !== await readPlatformFeeDiscount(
      this.publicClient, pins, quote.runId, snapshot.hash)) throw new Error('Host v2 locked admission fee tier changed');
    const [run, leash, host] = await Promise.all([
      this.publicClient.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi,
        functionName: 'getRun', args: [quote.runId], ...state }),
      this.publicClient.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi,
        functionName: 'getLeash', args: [quote.leashId], ...state }),
      this.publicClient.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi,
        functionName: 'getHost', args: [quote.hostId], ...state }),
    ]);
    if (run.status !== 1 || run.stopAt !== 0n || run.hostReleased
      || run.hostId !== quote.hostId || run.leashId !== quote.leashId
      || !sameAddress(run.payer, quote.payer) || run.workloadHash !== quote.workloadHash
      || run.imageHash !== quote.imageHash || run.regionHash !== quote.regionHash
      || run.hwClass !== 0 || run.maxSeconds !== BigInt(quote.maxSeconds)
      || run.openedAt !== BigInt(historical.openedAt)
      || run.pricePerSecond !== BigInt(quote.pricePerSecond) || run.inferencePrice !== 0n
      || !sameAddress(leash.owner, quote.payer) || leash.killed
      || leash.expiry <= snapshot.timestamp || run.acceptedExpiry <= snapshot.timestamp
      || run.openedAt + run.maxSeconds <= snapshot.timestamp
      || host.hostKey !== hostKey || !host.active || host.unbondAt !== 0n
      || host.kind !== 0 || host.gpu || run.sealedHost
      || !sameAddress(host.operator, run.hostOperator)
      || (await this.publicClient.getBlock({ blockNumber: snapshot.number })).hash !== snapshot.hash) {
      throw new Error('Host v2 canonical run, leash, or registered host is no longer runnable');
    }
    await recheckPlatformV2Opening(this.publicClient, opening.opening, this.minConfirmations);
    return { openingBlockHash: opening.opening.blockHash, cutoffMs: historical.cutoff * 1000 };
  }
}
