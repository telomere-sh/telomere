import { decodeFunctionData, domainSeparator, encodeAbiParameters, encodeFunctionData, getAbiItem, getFunctionSelector, hashTypedData,
  keccak256, parseAbi, parseEventLogs, recoverTypedDataAddress, type Hex, type PublicClient } from 'viem';
import { addressSchema, canonical, sameAddress } from '../common.js';
import { canonicalPlatformReceipt, checkPlatformAsset } from '../platform-runtime/read-only.js';
import { platformEscrowAbi, platformQuoteTypes, typedPlatformQuote, type PlatformPins, type PlatformQuote } from '../platform-runtime/types.js';
import { requirementsSchema } from './protocol.js';
import { EIP3009_TYPES, PERMIT2_TYPES } from './gateway.js';
import { spendPermissionLeashTermsHash } from './spend-permissions.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';

export { CPU_PERMIT2, CPU_UPTO_PROXY, X402_RESERVATION_DOMAIN, x402CpuProfileSchema, x402CpuRequestSchema, x402ReservationSchema, x402CpuPaymentSchema } from './cpu-reservation-types.js';
export type { X402CpuReservation, X402CpuPayment } from './cpu-reservation-types.js';
import { CPU_PERMIT2, CPU_UPTO_PROXY, X402_RESERVATION_DOMAIN, x402ReservationSchema, x402CpuPaymentSchema, type X402CpuReservation, type X402CpuPayment } from './cpu-reservation-types.js';
const witnessType = 'Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)';
export const RECEIVE_AUTHORIZATION_TYPES = { ReceiveWithAuthorization: EIP3009_TYPES.TransferWithAuthorization } as const;
export function decodeX402CpuPaymentHeader(value: string): X402CpuPayment {
  if (value.length > 32_768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid bounded CPU payment header');
  return x402CpuPaymentSchema.parse(incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64'))));
}
export const x402CpuEscrowAbi = parseAbi([
  'struct CpuQuote { bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry; }',
  'struct CpuReservation { bytes32 requestHash; bytes32 salt; bytes32 leashTermsHash; }',
  'struct ReceiveAuthorization { address from; address to; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; }',
  'struct TokenPermissions { address token; uint256 amount; }',
  'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
  'function openRunFromX402Exact(CpuQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof,CpuReservation reservation,ReceiveAuthorization authorization,bytes paymentSignature)',
  'function openRunFromX402Upto(CpuQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof,CpuReservation reservation,PermitTransferFrom authorization,uint256 validAfter,bytes paymentSignature)',
  'function permit2() view returns(address)', 'function permit2CodeHash() view returns(bytes32)',
  'function x402UptoProxy() view returns(address)', 'function x402UptoProxyCodeHash() view returns(bytes32)',
  'function X402_RESERVATION_DOMAIN() view returns(bytes32)', 'function x402LeashTermsHash(bytes32) view returns(bytes32)',
  'function eip712Domain() view returns(bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)',
  'event X402RunFunded(bytes32 indexed runId,bytes32 indexed authorizationNonce,address indexed payer,uint96 amount,uint8 scheme,bytes32 requestHash,bytes32 leashTermsHash)',
]);
export const x402ExactSelector = getFunctionSelector(getAbiItem({ abi: x402CpuEscrowAbi, name: 'openRunFromX402Exact' }));
export const x402UptoSelector = getFunctionSelector(getAbiItem({ abi: x402CpuEscrowAbi, name: 'openRunFromX402Upto' }));
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
  'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function authorizationState(address,bytes32) view returns(bool)',
  'function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns(bytes32)',
  'event Transfer(address indexed from,address indexed to,uint256 value)', 'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
const permitAbi = parseAbi(['function DOMAIN_SEPARATOR() view returns(bytes32)', 'function nonceBitmap(address,uint256) view returns(uint256)']);
const proxyAbi = parseAbi(['function PERMIT2() view returns(address)', 'function WITNESS_TYPE_STRING() view returns(string)', 'event Settled()']);
export function x402QuoteHash(pins: PlatformPins, quote: PlatformQuote): Hex {
  return hashTypedData({ domain: { name: 'TelomerePlatformEscrow', version: '4', chainId: pins.chainId, verifyingContract: pins.escrowAddress },
    types: platformQuoteTypes, primaryType: 'PlatformQuote', message: typedPlatformQuote(quote) });
}
export function x402AuthorizationNonce(pins: PlatformPins, quote: PlatformQuote, reservation: X402CpuReservation): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' },
    { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
  [X402_RESERVATION_DOMAIN, BigInt(pins.chainId), pins.escrowAddress, x402QuoteHash(pins, quote), reservation.leashTermsHash,
    reservation.requestHash, reservation.salt, reservation.scheme === 'exact' ? 0 : 1]));
}
export function x402CpuRequired(pins: PlatformPins, quote: PlatformQuote, ceiling: string, raw: X402CpuReservation) {
  const reservation = x402ReservationSchema.parse(raw), profile = pins.x402CpuProfile;
  if (!profile || reservation.validBefore !== quote.quoteExpiry || BigInt(reservation.maximum) < BigInt(ceiling)
    || reservation.scheme === 'exact' && reservation.maximum !== ceiling) throw new Error('Invalid original x402 CPU challenge');
  const nonce = x402AuthorizationNonce(pins, quote, reservation);
  const accepted = requirementsSchema.parse({ scheme: reservation.scheme, network: `eip155:${pins.chainId}`, asset: pins.tokenAddress,
    amount: reservation.maximum, payTo: pins.escrowAddress, maxTimeoutSeconds: Math.max(1, reservation.validBefore - reservation.validAfter),
    extra: { name: profile.tokenName, version: profile.tokenVersion, assetTransferMethod: reservation.scheme === 'exact' ? 'eip3009' : 'permit2',
      facilitatorAddress: pins.escrowAddress, telomere: { challengeId: reservation.challengeId, nonce, requestHash: reservation.requestHash } } });
  return { x402Version: 2 as const, resource: { url: reservation.resourceUrl }, accepts: [accepted],
    extensions: { 'telomere-cpu-reservation': { version: 1 as const,
      authorizationType: reservation.scheme === 'exact' ? 'ReceiveWithAuthorization' as const : 'PermitWitnessTransferFrom' as const,
      runId: quote.runId, quoteHash: x402QuoteHash(pins, quote), leashTermsHash: reservation.leashTermsHash, requestHash: reservation.requestHash,
      settlementModel: 'upfront_ceiling_then_escrow_refund' as const, reservationCeiling: ceiling, refundBeneficiary: quote.payer, externalWalletGas: true as const } } };
}
export function x402CpuAuthorization(pins: PlatformPins, quote: PlatformQuote, ceiling: string, reservation: X402CpuReservation) {
  const nonce = x402AuthorizationNonce(pins, quote, reservation), profile = pins.x402CpuProfile;
  if (!profile) throw new Error('Missing reviewed x402 CPU profile');
  if (reservation.scheme === 'exact') return { signatureType: 'ReceiveWithAuthorization' as const, authorization: {
    from: quote.payer, to: pins.escrowAddress, value: ceiling, validAfter: reservation.validAfter.toString(),
    validBefore: reservation.validBefore.toString(), nonce } };
  return { signatureType: 'PermitWitnessTransferFrom' as const, permit2Authorization: { from: quote.payer,
    permitted: { token: pins.tokenAddress, amount: reservation.maximum }, spender: profile.proxyAddress,
    nonce: BigInt(nonce).toString(), deadline: reservation.validBefore.toString(),
    witness: { to: pins.escrowAddress, facilitator: pins.escrowAddress, validAfter: reservation.validAfter.toString() } } };
}
export function x402CpuTypedData(pins: PlatformPins, quote: PlatformQuote, ceiling: string, reservation: X402CpuReservation) {
  const authorization = x402CpuAuthorization(pins, quote, ceiling, reservation), profile = pins.x402CpuProfile!;
  if (authorization.signatureType === 'ReceiveWithAuthorization') {
    const a = authorization.authorization;
    return { domain: { name: profile.tokenName, version: profile.tokenVersion, chainId: pins.chainId, verifyingContract: pins.tokenAddress },
      types: RECEIVE_AUTHORIZATION_TYPES, primaryType: 'ReceiveWithAuthorization' as const,
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) } };
  }
  const a = authorization.permit2Authorization;
  return { domain: { name: 'Permit2', chainId: pins.chainId, verifyingContract: profile.permit2Address },
    types: PERMIT2_TYPES, primaryType: 'PermitWitnessTransferFrom' as const, message: { ...a,
      permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline),
      witness: { ...a.witness, validAfter: BigInt(a.witness.validAfter) } } };
}
export function x402CpuOpenCall(pins: PlatformPins, quote: PlatformQuote, quoteSignature: Hex, imageProof: Hex[], regionProof: Hex[],
  ceiling: string, reservation: X402CpuReservation, rawPayment: unknown): Hex {
  const payment = x402CpuPaymentSchema.parse(rawPayment), required = x402CpuRequired(pins, quote, ceiling, reservation),
    auth = x402CpuAuthorization(pins, quote, ceiling, reservation);
  if (canonical(payment.accepted).toLowerCase() !== canonical(required.accepts[0]).toLowerCase()
    || canonical(payment.resource) !== canonical(required.resource) || canonical(payment.extensions).toLowerCase() !== canonical(required.extensions).toLowerCase()) {
    throw new Error('Payment changed the original CPU challenge');
  }
  const metadata = { requestHash: reservation.requestHash, salt: reservation.salt, leashTermsHash: reservation.leashTermsHash };
  if (auth.signatureType === 'ReceiveWithAuthorization') {
    if (!('authorization' in payment.payload) || canonical(payment.payload.authorization).toLowerCase() !== canonical(auth.authorization).toLowerCase()) {
      throw new Error('Exact CPU payment requires the original ReceiveWithAuthorization extension');
    }
    const a = payment.payload.authorization;
    return encodeFunctionData({ abi: x402CpuEscrowAbi, functionName: 'openRunFromX402Exact', args: [typedPlatformQuote(quote), quoteSignature,
      imageProof, regionProof, metadata, { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, payment.payload.signature] });
  }
  if (!('permit2Authorization' in payment.payload) || canonical(payment.payload.permit2Authorization).toLowerCase() !== canonical(auth.permit2Authorization).toLowerCase()) {
    throw new Error('Upto CPU payment changed its original Permit2 witness');
  }
  const a = payment.payload.permit2Authorization;
  return encodeFunctionData({ abi: x402CpuEscrowAbi, functionName: 'openRunFromX402Upto', args: [typedPlatformQuote(quote), quoteSignature,
    imageProof, regionProof, metadata, { permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) },
    BigInt(a.witness.validAfter), payment.payload.signature] });
}
export async function checkX402CpuDeploymentAt(client: PublicClient, pins: PlatformPins, blockHash: Hex) {
  const profile = pins.x402CpuProfile; if (!profile) return;
  if (pins.financialProfile || pins.spendPermissionProfile || pins.chainId !== 31337 &&
    (!sameAddress(profile.permit2Address, CPU_PERMIT2) || !sameAddress(profile.proxyAddress, CPU_UPTO_PROXY))) throw new Error('Unsupported x402 CPU profile');
  const state = { blockHash, requireCanonical: true } as const;
  const [escrowCode, permitCode, proxyCode, permit2, permitHash, proxy, proxyHash, domain, tokenDomain, permitDomain, proxyPermit, witness, receiveType, tag] = await Promise.all([
    client.getCode({ address: pins.escrowAddress, ...state }), client.getCode({ address: profile.permit2Address, ...state }), client.getCode({ address: profile.proxyAddress, ...state }),
    client.readContract({ address: pins.escrowAddress, abi: x402CpuEscrowAbi, functionName: 'permit2', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: x402CpuEscrowAbi, functionName: 'permit2CodeHash', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: x402CpuEscrowAbi, functionName: 'x402UptoProxy', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: x402CpuEscrowAbi, functionName: 'x402UptoProxyCodeHash', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: x402CpuEscrowAbi, functionName: 'eip712Domain', ...state }),
    client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
    client.readContract({ address: profile.permit2Address, abi: permitAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
    client.readContract({ address: profile.proxyAddress, abi: proxyAbi, functionName: 'PERMIT2', ...state }),
    client.readContract({ address: profile.proxyAddress, abi: proxyAbi, functionName: 'WITNESS_TYPE_STRING', ...state }),
    client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'RECEIVE_WITH_AUTHORIZATION_TYPEHASH', ...state }),
    client.readContract({ address: pins.escrowAddress, abi: x402CpuEscrowAbi, functionName: 'X402_RESERVATION_DOMAIN', ...state }),
  ]);
  if (!escrowCode || keccak256(escrowCode) !== pins.escrowCodeHash || !permitCode || keccak256(permitCode) !== profile.permit2CodeHash
    || !proxyCode || keccak256(proxyCode) !== profile.proxyCodeHash || !sameAddress(permit2, profile.permit2Address) || permitHash !== profile.permit2CodeHash
    || !sameAddress(proxy, profile.proxyAddress) || proxyHash !== profile.proxyCodeHash || !sameAddress(proxyPermit, profile.permit2Address)
    || witness !== witnessType || tag !== X402_RESERVATION_DOMAIN || domain[0] !== '0x0f' || domain[1] !== 'TelomerePlatformEscrow' || domain[2] !== '4'
    || domain[3] !== BigInt(pins.chainId) || !sameAddress(domain[4], pins.escrowAddress) || domain[6].length
    || receiveType !== keccak256(new TextEncoder().encode('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'))
    || tokenDomain !== domainSeparator({ domain: { name: profile.tokenName, version: profile.tokenVersion, chainId: pins.chainId, verifyingContract: pins.tokenAddress } })
    || permitDomain !== domainSeparator({ domain: { name: 'Permit2', chainId: pins.chainId, verifyingContract: profile.permit2Address } })) {
    throw new Error('X402 CPU deployment, asset domain or official Permit2/proxy pins changed');
  }
}
export async function readX402CpuFunds(client: PublicClient, pins: PlatformPins, owner: string, scheme: 'exact' | 'upto') {
  if (!pins.x402CpuProfile) throw new Error('Missing x402 CPU deployment');
  const latest = await client.getBlock(), depth = pins.chainId === 31337 ? 0n : 12n;
  if (latest.number < depth) throw new Error('Confirmed x402 CPU state unavailable');
  const block = await client.getBlock({ blockNumber: latest.number - depth }), state = { blockHash: block.hash, requireCanonical: true } as const;
  await checkPlatformAsset(client, pins, block.hash); await checkX402CpuDeploymentAt(client, pins, block.hash);
  const account = addressSchema.parse(owner), [code, balance, allowance] = await Promise.all([
    client.getCode({ address: account, ...state }), client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'balanceOf', args: [account], ...state }),
    scheme === 'upto' ? client.readContract({ address: pins.tokenAddress, abi: tokenAbi, functionName: 'allowance', args: [account, pins.x402CpuProfile.permit2Address], ...state }) : Promise.resolve(2n ** 256n - 1n),
  ]);
  if (code && code !== '0x' || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('X402 CPU requires a canonical original EOA payer');
  return { available: (balance < allowance ? balance : allowance).toString() };
}
export async function validateX402CpuPayment(pins: PlatformPins, quote: PlatformQuote, quoteSignature: Hex,
  imageProof: Hex[], regionProof: Hex[], ceiling: string, reservation: X402CpuReservation, raw: unknown): Promise<Hex> {
  const payment = x402CpuPaymentSchema.parse(raw), call = x402CpuOpenCall(pins, quote, quoteSignature, imageProof, regionProof, ceiling, reservation, payment);
  const typedData = x402CpuTypedData(pins, quote, ceiling, reservation);
  const recovered = typedData.primaryType === 'ReceiveWithAuthorization'
    ? await recoverTypedDataAddress({ ...typedData, signature: payment.payload.signature })
    : await recoverTypedDataAddress({ ...typedData, signature: payment.payload.signature });
  if (!sameAddress(recovered, quote.payer)) throw new Error('X402 CPU payment signature does not authorize the original EOA');
  return call;
}
export async function verifyX402CpuPayment(client: PublicClient, pins: PlatformPins, quote: PlatformQuote, quoteSignature: Hex,
  imageProof: Hex[], regionProof: Hex[], ceiling: string, reservation: X402CpuReservation, raw: unknown): Promise<Hex> {
  const call = await validateX402CpuPayment(pins, quote, quoteSignature, imageProof, regionProof, ceiling, reservation, raw);
  const block = await client.getBlock();
  await checkPlatformAsset(client, pins, block.hash); await checkX402CpuDeploymentAt(client, pins, block.hash);
  if (block.timestamp <= BigInt(reservation.validAfter) || block.timestamp >= BigInt(reservation.validBefore)) throw new Error('Original x402 CPU authorization expired or is not active');
  const leash = await client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getLeash', args: [quote.leashId], blockHash: block.hash, requireCanonical: true });
  if (!sameAddress(leash.owner, quote.payer) || leash.killed || spendPermissionLeashTermsHash(leash) !== reservation.leashTermsHash) throw new Error('Original x402 CPU Leash scope changed');
  await client.call({ account: quote.payer, to: pins.escrowAddress, data: call, blockHash: block.hash });
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('X402 CPU simulation snapshot changed');
  return call;
}

/** Historical proof only: used/cancelled nonces never substitute for a funded RunOpened. */
export async function verifyX402CpuOpening(client: PublicClient, pins: PlatformPins, quote: PlatformQuote, ceiling: string,
  hash: Hex, metadata: X402CpuReservation, expectedIntentHash: Hex): Promise<void> {
  const reservation = x402ReservationSchema.parse(metadata), receipt = await canonicalPlatformReceipt(client, pins, hash, pins.escrowAddress),
    transaction = await client.getTransaction({ hash }), head = await client.getBlockNumber({ cacheTime: 0 });
  if (transaction.hash !== hash || !transaction.to || !sameAddress(transaction.to, pins.escrowAddress) || transaction.value !== 0n
    || transaction.chainId !== pins.chainId || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber
    || keccak256(transaction.input) !== expectedIntentHash || head < receipt.blockNumber || pins.chainId !== 31337 && head - receipt.blockNumber + 1n < 12n
    || receipt.logs.some(log => log.removed || log.transactionHash !== hash || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber)) {
    throw new Error('X402 CPU admission differs from the original canonical wallet intent');
  }
  await checkX402CpuDeploymentAt(client, pins, receipt.blockHash);
  const decoded = decodeFunctionData({ abi: x402CpuEscrowAbi, data: transaction.input }), name = reservation.scheme === 'exact' ? 'openRunFromX402Exact' : 'openRunFromX402Upto';
  if (decoded.functionName !== name || encodeFunctionData({ abi: x402CpuEscrowAbi, functionName: decoded.functionName, args: decoded.args }) !== transaction.input) throw new Error('X402 CPU opening changed original payment selector');
  const q = decoded.args[0], r = decoded.args[4], nonce = x402AuthorizationNonce(pins, quote, reservation);
  if (canonical({ ...q, maxSeconds: Number(q.maxSeconds), pricePerSecond: q.pricePerSecond.toString(), inferencePrice: q.inferencePrice.toString(), quoteExpiry: Number(q.quoteExpiry) }).toLowerCase() !== canonical(quote).toLowerCase()
    || r.requestHash !== reservation.requestHash || r.salt !== reservation.salt || r.leashTermsHash !== reservation.leashTermsHash) throw new Error('X402 CPU opening changed its signed resource or Leash');
  const events = parseEventLogs({ abi: x402CpuEscrowAbi, eventName: 'X402RunFunded', logs: receipt.logs.filter(log => sameAddress(log.address, pins.escrowAddress)) });
  const openings = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunOpened', logs: receipt.logs.filter(log => sameAddress(log.address, pins.escrowAddress)) });
  const transfers = parseEventLogs({ abi: tokenAbi, eventName: 'Transfer', logs: receipt.logs.filter(log => sameAddress(log.address, pins.tokenAddress)) });
  const run = await client.readContract({ address: pins.escrowAddress, abi: platformEscrowAbi, functionName: 'getRun', args: [quote.runId], blockHash: receipt.blockHash, requireCanonical: true });
  const event = events[0]?.args, opened = openings[0]?.args;
  if (events.length !== 1 || openings.length !== 1 || !event || !opened || event.runId !== quote.runId || event.authorizationNonce !== nonce
    || !sameAddress(event.payer, quote.payer) || event.amount.toString() !== ceiling || event.scheme !== (reservation.scheme === 'exact' ? 0 : 1)
    || event.requestHash !== reservation.requestHash || event.leashTermsHash !== reservation.leashTermsHash || opened.runId !== quote.runId
    || opened.leashId !== quote.leashId || opened.hostId !== quote.hostId || !sameAddress(opened.payer, quote.payer) || opened.ceiling.toString() !== ceiling
    || opened.maxSeconds !== BigInt(quote.maxSeconds) || run.status === 0 || !sameAddress(run.payer, quote.payer) || run.leashId !== quote.leashId
    || run.hostId !== quote.hostId || run.hwClass !== quote.hwClass || run.regionHash !== quote.regionHash || run.imageHash !== quote.imageHash
    || run.workloadHash !== quote.workloadHash || run.maxSeconds !== BigInt(quote.maxSeconds) || run.pricePerSecond.toString() !== quote.pricePerSecond
    || run.inferencePrice !== 0n || run.sealedHost || run.ceiling.toString() !== ceiling || run.openedAt !== opened.openedAt
    || transfers.filter(log => sameAddress(log.args.from, quote.payer) && sameAddress(log.args.to, pins.escrowAddress) && log.args.value.toString() === ceiling).length !== 1
    || transfers.filter(log => sameAddress(log.args.to, pins.escrowAddress)).reduce((total, log) => total + log.args.value, 0n) !== BigInt(ceiling)
    || transfers.some(log => sameAddress(log.args.from, pins.escrowAddress))) throw new Error('X402 CPU opening lacks exact funded reservation conservation');
  if (reservation.scheme === 'exact') {
    const used = parseEventLogs({ abi: tokenAbi, eventName: 'AuthorizationUsed', logs: receipt.logs.filter(log => sameAddress(log.address, pins.tokenAddress)) });
    if (used.length !== 1 || !sameAddress(used[0]!.args.authorizer, quote.payer) || used[0]!.args.nonce !== nonce) throw new Error('X402 exact authorization was not atomically used');
  } else {
    const settled = parseEventLogs({ abi: proxyAbi, eventName: 'Settled', logs: receipt.logs.filter(log => sameAddress(log.address, pins.x402CpuProfile!.proxyAddress)) });
    const bitmap = await client.readContract({ address: pins.x402CpuProfile!.permit2Address, abi: permitAbi, functionName: 'nonceBitmap',
      args: [quote.payer, BigInt(nonce) >> 8n], blockHash: receipt.blockHash, requireCanonical: true });
    if (settled.length !== 1 || !(bitmap & 1n << (BigInt(nonce) & 255n))) throw new Error('X402 upto official proxy/Permit2 spend evidence unavailable');
  }
  if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('X402 CPU opening became noncanonical');
}
