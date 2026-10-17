import { createPublicClient, decodeEventLog, decodeFunctionData, defineChain, http, keccak256, parseAbi, type Hex } from 'viem';
import { z } from 'zod';
import { bytes32Schema, Problem, sameAddress } from '../common.js';
import { tokenAbi } from '../chain/abi.js';
import { hostMessageHash, signedTickSchema, verifyHostMessage } from '../host-kit/protocol.js';
import { matchesAssetFacetPins, stableAssetFacetReceiptBlock } from '../payments/asset-facets.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, stableCircleProxyReceiptBlock } from '../payments/circle-usdc.js';
import { PLATFORM_ZERO, platformEscrowAbi, platformHostRegistryAbi, platformPinsSchema,
  type PlatformPins } from './types.js';

const settlementCalls = parseAbi([
  'struct Settlement { bytes32 runId; uint64 billableSeconds; uint64 endedAt; uint96 inferenceCharge; bytes32 receiptHash; }',
  'struct SettlementInput { Settlement settlement; uint64 hour; bytes32[] proof; }',
  'function settleRun(Settlement settlement,uint64 hour,bytes32[] proof)',
  'function settleBatch(SettlementInput[] batch)',
]);
const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

/** Transferable public fields only. A HostKit lease can contain private argv/stdin. */
export const presentedMeterBundleSchema = z.object({ protocol: z.literal('telomere-presented-host-ticks-v1'),
  runId: bytes32Schema, transactionHash: bytes32Schema,
  ticks: signedTickSchema.array().min(1).max(100) }).strict();
export type PresentedMeterBundle = z.infer<typeof presentedMeterBundleSchema>;
export const PRESENTED_METER_MAX_BYTES = 96 * 1024;

export function preparePresentedMeterBundle(runId: string, transactionHash: string, rawTicks: unknown): PresentedMeterBundle {
  const bundle = presentedMeterBundleSchema.parse({ protocol: 'telomere-presented-host-ticks-v1',
    runId, transactionHash, ticks: rawTicks });
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > PRESENTED_METER_MAX_BYTES) {
    throw new Problem(422, 'platform_meter_bundle_limit', 'The redacted signed-tick bundle exceeds 96 KiB.');
  }
  return bundle;
}

/**
 * Checks only the signatures and scope of the *presented* ticks against a
 * canonical paid run. There is no onchain commitment to the complete HostKit
 * tick array, so this deliberately does not attest completeness or billing.
 */
export async function verifyPresentedMeterBundle(raw: unknown, rawPins: unknown, rpcUrl: string,
  minConfirmations = 12) {
  const bundle = presentedMeterBundleSchema.parse(raw), pins: PlatformPins = platformPinsSchema.parse(rawPins);
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > PRESENTED_METER_MAX_BYTES) {
    throw new Problem(422, 'platform_meter_bundle_limit', 'The redacted signed-tick bundle exceeds 96 KiB.');
  }
  if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 128) {
    throw new Error('Invalid presented-meter confirmation depth');
  }
  const url = new URL(rpcUrl);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Presented-meter RPC requires HTTPS or loopback');
  }
  if (pins.chainId === 31337 && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Local presented-meter chain requires loopback');
  }
  const chain = defineChain({ id: pins.chainId, name: 'Telomere reviewed platform',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url.href] } } });
  const rpc = createPublicClient({ chain, transport: http(url.href, { timeout: 10_000, retryCount: 0 }) });
  if (await rpc.getChainId() !== pins.chainId) throw new Problem(409, 'platform_meter_chain', 'Chain ID differs from reviewed pins.');
  const receipt = await rpc.getTransactionReceipt({ hash: bundle.transactionHash });
  const blockNumber = receipt.blockNumber, blockHash = receipt.blockHash;
  const head = await rpc.getBlockNumber({ cacheTime: 0 });
  if (receipt.transactionHash !== bundle.transactionHash || receipt.status !== 'success'
    || !receipt.to || !sameAddress(receipt.to, pins.escrowAddress)
    || head < blockNumber || head - blockNumber + 1n < BigInt(minConfirmations)
    || (await rpc.getBlock({ blockNumber })).hash !== blockHash) {
    throw new Problem(409, 'platform_meter_finalization', 'Settlement transaction is not sufficiently confirmed and canonical.');
  }
  for (const [address, expected] of [[pins.escrowAddress, pins.escrowCodeHash],
    [pins.hostRegistryAddress, pins.hostRegistryCodeHash], [pins.receiptRootAddress, pins.receiptRootCodeHash],
    [pins.feeRouterAddress, pins.feeRouterCodeHash], [pins.tokenAddress, pins.tokenCodeHash]] as const) {
    const code = await rpc.getCode({ address, blockHash, requireCanonical: true });
    if (!code || keccak256(code) !== expected) {
      throw new Problem(409, 'platform_meter_pin_changed', 'Historical Platform contract or payment asset code differs from reviewed pins.');
    }
  }
  const state = { blockHash, requireCanonical: true } as const;
  if (pins.reviewedTokenKind === 'eip1967') {
    const implementation = pins.assetImplementation;
    if (!implementation) throw new Problem(409, 'platform_meter_pin_changed', 'Historical payment implementation pin is missing.');
    const [slot, code] = await Promise.all([
      rpc.getStorageAt({ address: pins.tokenAddress, slot: EIP1967_IMPLEMENTATION_SLOT, ...state }),
      rpc.getCode({ address: implementation.address, ...state }),
    ]);
    if (!slot || !sameAddress(`0x${slot.slice(-40)}`, implementation.address)
      || !code || keccak256(code) !== implementation.codeHash) {
      throw new Problem(409, 'platform_meter_pin_changed', 'Historical payment implementation differs from reviewed pins.');
    }
  }
  if (pins.reviewedTokenKind === 'circle_proxy') {
    const implementation = pins.assetImplementation;
    if (!implementation || !await matchesCircleProxyPins(rpc, pins.tokenAddress, implementation, state)
      || pins.chainId !== 31337 && !await matchesNativeBaseUsdcMetadata(rpc, pins.chainId, pins.tokenAddress, state)
      || !await stableCircleProxyReceiptBlock(rpc, pins.tokenAddress, pins.tokenCodeHash, implementation, blockHash, blockNumber)) {
      throw new Problem(409, 'platform_meter_pin_changed', 'Historical Circle USDC implementation or domain differs from reviewed pins.');
    }
  }
  if (pins.assetFacet && (!await matchesAssetFacetPins(rpc, pins.tokenAddress, pins.assetFacet, state)
    || !await stableAssetFacetReceiptBlock(rpc, pins.tokenAddress, pins.assetFacet, blockHash, blockNumber))) {
    throw new Problem(409, 'platform_meter_pin_changed', 'Historical payment authorization facet differs from reviewed pins.');
  }
  if (await rpc.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'decimals', ...state }) !== 6) {
    throw new Problem(409, 'platform_meter_pin_changed', 'Historical payment asset decimals differ from reviewed pins.');
  }
  const transaction = await rpc.getTransaction({ hash: bundle.transactionHash });
  if (transaction.hash !== bundle.transactionHash || transaction.blockHash !== blockHash
    || !transaction.to || !sameAddress(transaction.to, pins.escrowAddress)
    || transaction.chainId !== pins.chainId || transaction.value !== 0n) {
    throw new Problem(409, 'platform_meter_transaction', 'Transaction differs from the canonical paid escrow settlement.');
  }
  let call: ReturnType<typeof decodeFunctionData<typeof settlementCalls>>;
  try { call = decodeFunctionData({ abi: settlementCalls, data: transaction.input }); }
  catch { throw new Problem(409, 'platform_meter_transaction', 'Transaction is not a supported Platform settlement.'); }
  const settlements = call.functionName === 'settleRun' ? [call.args[0]]
    : call.functionName === 'settleBatch' ? call.args[0].map(item => item.settlement) : [];
  const matches = settlements.filter(item => item.runId === bundle.runId);
  if (matches.length !== 1) throw new Problem(409, 'platform_meter_run', 'Transaction does not settle this run exactly once.');
  const settled = matches[0]!;
  const run = await rpc.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi,
    functionName: 'getRun', args: [bundle.runId], ...state });
  if (run.status !== 2 || !run.hostReleased || run.hostId === PLATFORM_ZERO
    || run.receiptHash !== settled.receiptHash || run.billableSeconds !== settled.billableSeconds
    || run.inferenceCharge !== settled.inferenceCharge || settled.receiptHash === PLATFORM_ZERO) {
    throw new Problem(409, 'platform_meter_run', 'Historical paid run differs from the settlement calldata.');
  }
  const settledEvents = receipt.logs.flatMap(log => {
    if (!sameAddress(log.address, pins.escrowAddress)) return [];
    try {
      const decoded = decodeEventLog({ abi: platformEscrowAbi, data: log.data, topics: log.topics });
      return decoded.eventName === 'RunSettled' && decoded.args.runId === bundle.runId ? [decoded.args] : [];
    } catch { return []; }
  });
  if (settledEvents.length !== 1 || settledEvents[0]!.receiptHash !== run.receiptHash) {
    throw new Problem(409, 'platform_meter_run', 'Canonical RunSettled event differs from the paid run.');
  }
  const host = await rpc.readContract({ address: pins.hostRegistryAddress, abi: platformHostRegistryAbi,
    functionName: 'getHost', args: [run.hostId], ...state });
  if (host.hostKey === PLATFORM_ZERO || !sameAddress(host.operator, run.hostOperator)) {
    throw new Problem(409, 'platform_meter_host', 'Historical HostRegistry attribution differs from the paid run.');
  }
  let previous: PresentedMeterBundle['ticks'][number] | undefined;
  let leaseHash: Hex | undefined;
  for (const [index, tick] of bundle.ticks.entries()) {
    const body = tick.body;
    if (!verifyHostMessage(host.hostKey, 'tick', tick) || body.hostKey !== host.hostKey
      || body.runId !== bundle.runId || body.owner !== run.payer.toLowerCase()
      || body.sequence !== index || body.previousHash !== (previous ? hostMessageHash(previous) : null)
      || body.leaseHash === PLATFORM_ZERO || leaseHash !== undefined && body.leaseHash !== leaseHash
      || body.elapsedMs > Number(run.maxSeconds) * 1000
      || previous && (previous.body.state !== 'RUNNING' || body.timestamp <= previous.body.timestamp
        || body.elapsedMs < previous.body.elapsedMs || body.cpuMs < previous.body.cpuMs
        || body.elapsedMs - previous.body.elapsedMs > body.timestamp - previous.body.timestamp + 1000)) {
      throw new Problem(409, 'platform_meter_tick', 'Presented HostKit tick signature, scope or sequence is invalid.');
    }
    leaseHash = body.leaseHash;
    previous = tick;
  }
  const finalHead = await rpc.getBlockNumber({ cacheTime: 0 });
  if (finalHead < blockNumber || finalHead - blockNumber + 1n < BigInt(minConfirmations)
    || (await rpc.getBlock({ blockNumber })).hash !== blockHash) {
    throw new Problem(409, 'platform_meter_reorg', 'The paid settlement lost canonical confirmation during verification.');
  }
  return { verification: 'presented-host-signatures-only' as const, chainId: pins.chainId,
    escrowAddress: pins.escrowAddress, hostRegistryAddress: pins.hostRegistryAddress,
    runId: bundle.runId, transactionHash: bundle.transactionHash,
    blockNumber: blockNumber.toString(), blockHash, confirmations: (finalHead - blockNumber + 1n).toString(),
    hostId: run.hostId, hostKey: host.hostKey, payer: run.payer, leaseBodyHash: leaseHash!,
    receiptHash: run.receiptHash, presentedTickCount: bundle.ticks.length,
    presentedTickSignaturesVerified: true as const, completeTickHistoryVerified: false as const,
    billableSecondsVerifiedFromTicks: false as const, outputVerified: false as const,
    onchainTickCommitment: false as const };
}
