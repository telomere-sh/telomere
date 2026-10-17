import { decodeEventLog, encodeFunctionData, hashTypedData, keccak256, parseAbi, verifyTypedData,
  type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson, signatureSchema, sameAddress } from '../common.js';
import { canonicalPlatformReceipt, checkPlatformAsset, checkPlatformDeployment } from '../platform-runtime/read-only.js';
import { platformPinsSchema } from '../platform-runtime/types.js';

const uint256 = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 1n << 256n);
const uint96 = uint256.refine(value => BigInt(value) < 1n << 96n);
const positive = uint96.refine(value => BigInt(value) > 0n);
export const burnQuoteSchema = z.object({ operationId: bytes32Schema, week: z.number().int().nonnegative().safe(),
  amountIn: positive, minAmountOut: uint256.refine(value => BigInt(value) > 0n),
  validAfter: z.number().int().positive().safe(), deadline: z.number().int().positive().safe() }).strict();
export const buyAndBurnPinsSchema = z.object({ platform: platformPinsSchema, burner: addressSchema, burnerCodeHash: bytes32Schema,
  utilityToken: addressSchema, utilityCodeHash: bytes32Schema, swapRouter: addressSchema, swapRouterCodeHash: bytes32Schema,
  quoteSigner: addressSchema, poolFee: z.number().int().min(1).max(0xff_ffff), maxPerSwap: positive,
  maxPerWeek: positive, maxQuoteLifetime: z.number().int().positive().safe() }).strict().refine(value =>
  BigInt(value.maxPerWeek) >= BigInt(value.maxPerSwap), 'Weekly burn maximum must cover one swap');
export type BuyAndBurnPins = z.infer<typeof buyAndBurnPinsSchema>;
export type BurnQuote = z.infer<typeof burnQuoteSchema>;
export const burnQuoteTypes = { BurnQuote: [{ name: 'operationId', type: 'bytes32' }, { name: 'week', type: 'uint64' },
  { name: 'amountIn', type: 'uint96' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'validAfter', type: 'uint64' },
  { name: 'deadline', type: 'uint64' }] } as const;
export const buyAndBurnAbi = parseAbi([
  'struct BurnQuote { bytes32 operationId; uint64 week; uint96 amountIn; uint256 minAmountOut; uint64 validAfter; uint64 deadline; }',
  'function execute(BurnQuote quote,bytes signature)', 'function fundWeek(uint64 week)',
  'function paymentToken() view returns (address)', 'function utilityToken() view returns (address)',
  'function feeRouter() view returns (address)', 'function feeRouterCodeHash() view returns (bytes32)',
  'function swapRouter() view returns (address)', 'function swapRouterCodeHash() view returns (bytes32)',
  'function quoteSigner() view returns (address)', 'function poolFee() view returns (uint24)',
  'function maxPerSwap() view returns (uint96)', 'function maxPerWeek() view returns (uint96)',
  'function maxQuoteLifetime() view returns (uint64)', 'function executedOperation(bytes32) view returns (bool)',
  'function burnWeeks(uint64) view returns (uint256 funded,uint256 spent,bool fundingRecorded)',
  'event BoughtAndBurned(bytes32 indexed operationId,uint64 indexed week,uint96 paymentAmount,uint256 utilityAmount,bytes32 quoteDigest)',
]);
const routerAbi = parseAbi(['function buyAndBurn() view returns (address)', 'function economicsVersion() view returns (uint16)',
  'function token() view returns (address)', 'function controller() view returns (address)']);
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const typed = (quote: BurnQuote) => ({ ...quote, week: BigInt(quote.week), amountIn: BigInt(quote.amountIn),
  minAmountOut: BigInt(quote.minAmountOut), validAfter: BigInt(quote.validAfter), deadline: BigInt(quote.deadline) });
export function burnQuoteTypedData(pins: BuyAndBurnPins, quote: BurnQuote) {
  return { domain: { name: 'TelomereBuyAndBurn', version: '1', chainId: pins.platform.chainId,
    verifyingContract: pins.burner }, primaryType: 'BurnQuote' as const, types: burnQuoteTypes, message: typed(quote) };
}

async function checkBurnProfile(client: PublicClient, pins: BuyAndBurnPins, blockHash: Hex) {
  if (await client.getChainId() !== pins.platform.chainId) throw new Error('Buy-and-burn chain differs from reviewed pins');
  const state = { blockHash, requireCanonical: true } as const;
  await checkPlatformAsset(client, pins.platform, blockHash);
  for (const [address, expected] of [[pins.burner, pins.burnerCodeHash], [pins.utilityToken, pins.utilityCodeHash],
    [pins.swapRouter, pins.swapRouterCodeHash], [pins.platform.feeRouterAddress, pins.platform.feeRouterCodeHash]] as const) {
    const code = await client.getCode({ address, ...state });
    if (!code || code === '0x' || keccak256(code) !== expected) throw new Error('Buy-and-burn contract code differs from reviewed pins');
  }
  const readAddress = (functionName: 'paymentToken' | 'utilityToken' | 'feeRouter' | 'swapRouter' | 'quoteSigner') =>
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName, ...state });
  const [paymentToken, utilityToken, feeRouter, swapRouter, quoteSigner, feeRouterCodeHash, swapRouterCodeHash,
    poolFee, maxPerSwap, maxPerWeek, maxQuoteLifetime, recipient, economicsVersion, routerToken, routerController] = await Promise.all([
    readAddress('paymentToken'), readAddress('utilityToken'), readAddress('feeRouter'), readAddress('swapRouter'), readAddress('quoteSigner'),
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'feeRouterCodeHash', ...state }),
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'swapRouterCodeHash', ...state }),
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'poolFee', ...state }),
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'maxPerSwap', ...state }),
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'maxPerWeek', ...state }),
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'maxQuoteLifetime', ...state }),
    client.readContract({ address: pins.platform.feeRouterAddress, abi: routerAbi, functionName: 'buyAndBurn', ...state }),
    client.readContract({ address: pins.platform.feeRouterAddress, abi: routerAbi, functionName: 'economicsVersion', ...state }),
    client.readContract({ address: pins.platform.feeRouterAddress, abi: routerAbi, functionName: 'token', ...state }),
    client.readContract({ address: pins.platform.feeRouterAddress, abi: routerAbi, functionName: 'controller', ...state }),
  ]);
  if (!sameAddress(paymentToken, pins.platform.tokenAddress) || !sameAddress(utilityToken, pins.utilityToken)
    || !sameAddress(feeRouter, pins.platform.feeRouterAddress) || !sameAddress(swapRouter, pins.swapRouter)
    || !sameAddress(quoteSigner, pins.quoteSigner) || !sameAddress(recipient, pins.burner)
    || !sameAddress(routerToken, pins.platform.tokenAddress) || !sameAddress(routerController, pins.platform.escrowAddress)
    || feeRouterCodeHash !== pins.platform.feeRouterCodeHash || swapRouterCodeHash !== pins.swapRouterCodeHash
    || economicsVersion !== 2 || poolFee !== pins.poolFee || maxPerSwap !== BigInt(pins.maxPerSwap)
    || maxPerWeek !== BigInt(pins.maxPerWeek) || maxQuoteLifetime !== BigInt(pins.maxQuoteLifetime)) {
    throw new Error('Buy-and-burn immutable configuration differs from reviewed pins');
  }
}

/** Only prepares exact unsigned calldata. Signing, durable raw-tx journaling and
 * broadcasting remain the caller's reviewed financial boundary. */
export async function prepareBuyAndBurn(client: PublicClient, rawPins: BuyAndBurnPins, rawQuote: BurnQuote, rawSignature: Hex) {
  const pins = buyAndBurnPinsSchema.parse(rawPins), quote = burnQuoteSchema.parse(rawQuote), signature = signatureSchema.parse(rawSignature);
  await checkPlatformDeployment(client, pins.platform);
  const block = await client.getBlock(); await checkBurnProfile(client, pins, block.hash);
  const [executed, week] = await Promise.all([
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'executedOperation', args: [quote.operationId], blockHash: block.hash }),
    client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'burnWeeks', args: [BigInt(quote.week)], blockHash: block.hash }),
  ]);
  if (executed) throw new Error('Buy-and-burn operation already executed; reconcile its canonical receipt');
  if (quote.operationId === `0x${'0'.repeat(64)}` || BigInt(quote.amountIn) > BigInt(pins.maxPerSwap)
    || quote.deadline <= quote.validAfter || quote.deadline - quote.validAfter > pins.maxQuoteLifetime
    || BigInt(quote.validAfter) > block.timestamp || BigInt(quote.deadline) < block.timestamp
    || !week[2] || week[1] + BigInt(quote.amountIn) > week[0] || week[1] + BigInt(quote.amountIn) > BigInt(pins.maxPerWeek)
    || !await verifyTypedData({ ...burnQuoteTypedData(pins, quote), address: pins.quoteSigner, signature })) {
    throw new Error('Buy-and-burn quote is unauthorized, expired or above its funded limits');
  }
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Buy-and-burn preflight snapshot reorged');
  return { protocol: 'telomere-buy-and-burn-prepared-v1' as const, pinsDigest: hashJson(pins),
    operationId: quote.operationId, quoteDigest: hashTypedData(burnQuoteTypedData(pins, quote)),
    transaction: { chainId: pins.platform.chainId, to: pins.burner,
      data: encodeFunctionData({ abi: buyAndBurnAbi, functionName: 'execute', args: [typed(quote), signature] }), value: '0' as const } };
}

/** Exact receipt reconciliation; successful retry reads the same operation,
 * never manufactures a second swap or signs a replacement economic quote. */
export async function reconcileBuyAndBurn(client: PublicClient, rawPins: BuyAndBurnPins, rawQuote: BurnQuote,
  rawSignature: Hex, rawHash: Hex, minConfirmations = 12) {
  const pins = buyAndBurnPinsSchema.parse(rawPins), quote = burnQuoteSchema.parse(rawQuote);
  const signature = signatureSchema.parse(rawSignature), hash = bytes32Schema.parse(rawHash);
  if (!Number.isInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 128) throw new Error('Invalid burn confirmation depth');
  await checkPlatformDeployment(client, pins.platform);
  const current = await client.getBlock(); await checkBurnProfile(client, pins, current.hash);
  const receipt = await canonicalPlatformReceipt(client, pins.platform, hash, pins.burner);
  await checkBurnProfile(client, pins, receipt.blockHash);
  const [transaction, block, head] = await Promise.all([client.getTransaction({ hash }),
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 })]);
  const data = encodeFunctionData({ abi: buyAndBurnAbi, functionName: 'execute', args: [typed(quote), signature] });
  if (!transaction.to || !sameAddress(transaction.to, pins.burner) || transaction.input.toLowerCase() !== data.toLowerCase()
    || transaction.chainId !== pins.platform.chainId || transaction.value !== 0n || transaction.blockHash !== receipt.blockHash
    || block.hash !== receipt.blockHash || head < receipt.blockNumber || head - receipt.blockNumber + 1n < BigInt(minConfirmations)
    || block.timestamp < BigInt(quote.validAfter) || block.timestamp > BigInt(quote.deadline)
    || !await verifyTypedData({ ...burnQuoteTypedData(pins, quote), address: pins.quoteSigner, signature })) {
    throw new Error('Buy-and-burn receipt differs from the exact authorized confirmed transaction');
  }
  const events = receipt.logs.flatMap(log => {
    if (!sameAddress(log.address, pins.burner)) return [];
    try { const decoded = decodeEventLog({ abi: buyAndBurnAbi, data: log.data, topics: log.topics });
      return decoded.eventName === 'BoughtAndBurned' ? [decoded.args] : []; } catch { return []; }
  }).filter(event => event.operationId === quote.operationId);
  const event = events[0], digest = hashTypedData(burnQuoteTypedData(pins, quote));
  if (events.length !== 1 || !event || event.week !== BigInt(quote.week) || event.paymentAmount !== BigInt(quote.amountIn)
    || event.utilityAmount < BigInt(quote.minAmountOut) || event.quoteDigest !== digest) throw new Error('Buy-and-burn event differs from approved quote');
  const transfers = (token: Address) => receipt.logs.flatMap(log => {
    if (!sameAddress(log.address, token)) return [];
    try { return [decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics }).args]; } catch { return []; }
  });
  const burned = transfers(pins.utilityToken).filter(transfer => sameAddress(transfer.from, pins.burner)
    && sameAddress(transfer.to, '0x0000000000000000000000000000000000000000') && transfer.value === event.utilityAmount);
  // V3 pays the pool in its callback; the reviewed router is the spender, not
  // necessarily the token recipient. The pinned route enforces the destination.
  const paid = transfers(pins.platform.tokenAddress).filter(transfer => sameAddress(transfer.from, pins.burner)
    && transfer.value === BigInt(quote.amountIn));
  const executed = await client.readContract({ address: pins.burner, abi: buyAndBurnAbi, functionName: 'executedOperation',
    args: [quote.operationId], blockHash: receipt.blockHash, requireCanonical: true });
  if (burned.length !== 1 || paid.length !== 1 || !executed
    || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Buy-and-burn transfer evidence or canonicality changed');
  return { protocol: 'telomere-buy-and-burn-receipt-v1' as const, operationId: quote.operationId, quoteDigest: digest,
    transactionHash: hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    paymentAmount: quote.amountIn, burnedUtilityAmount: event.utilityAmount.toString(),
    confirmations: (head - receipt.blockNumber + 1n).toString(), supplyBurnVerified: true as const };
}
