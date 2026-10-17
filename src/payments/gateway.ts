import { decodeEventLog, encodeFunctionData, domainSeparator, keccak256, parseAbi, parseTransaction, recoverTypedDataAddress,
  type Address, type Chain, type Hex, type LocalAccount, type PublicClient, type Transport, type WalletClient } from 'viem';
import { PaymentError, paymentPayer, type PaymentPayload, type PaymentRequirements, type Scheme } from './protocol.js';
import { matchesAssetFacetPins, stableAssetFacetReceiptBlock, type AssetFacetPins } from './asset-facets.js';
import { isNativeBaseUsdc, matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, nativeBaseUsdcName,
  stableCircleProxyReceiptBlock } from './circle-usdc.js';
import { baseUsdcForChainId } from '../chain/chains.js';

export const EIP3009_TYPES = { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' }] } as const;
export const PERMIT2_TYPES = { PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' },
  { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  { name: 'witness', type: 'Witness' }], TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  Witness: [{ name: 'to', type: 'address' }, { name: 'facilitator', type: 'address' }, { name: 'validAfter', type: 'uint256' }] } as const;
const tokenAbi = parseAbi(['function decimals() view returns(uint8)', 'function DOMAIN_SEPARATOR() view returns(bytes32)',
  'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
  'function authorizationState(address,bytes32) view returns(bool)',
  'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const permitAbi = parseAbi(['function DOMAIN_SEPARATOR() view returns(bytes32)', 'function nonceBitmap(address,uint256) view returns(uint256)']);
const uptoAbi = parseAbi(['function PERMIT2() view returns(address)', 'function WITNESS_TYPE_STRING() view returns(string)',
  'struct TokenPermissions { address token; uint256 amount; }',
  'struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }',
  'struct Witness { address to; address facilitator; uint256 validAfter; }',
  'function settle(PermitTransferFrom permit,uint256 amount,address owner,Witness witness,bytes signature)']);
export type PaymentPins = { chainId: number; asset: Address; tokenCodeHash: Hex; payTo: Address; facilitator: Address;
  reviewedTokenKind: 'immutable' | 'eip1967' | 'circle_proxy'; assetImplementation?: { address: Address; codeHash: Hex }; assetFacet?: AssetFacetPins | undefined;
  confirmations: number; exact?: { reviewedEip3009: true; name: string; version: string };
  upto?: { name: string; version: string; permit2: Address; permit2CodeHash: Hex; proxy: Address; proxyCodeHash: Hex } };
export type PreparedPayment = { raw: Hex; hash: Hex; nonce: number };
export interface PaymentChain {
  readonly pins: Readonly<PaymentPins>;
  verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<void>;
  prepare(payment: PaymentPayload, amount: string): Promise<PreparedPayment>;
  broadcast(raw: Hex): Promise<Hex>;
  inspect(prepared: PreparedPayment, payment: PaymentPayload, amount: string): Promise<'pending' | 'settled' | 'reverted'>;
}
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function fail(code: string, status = 422): never { throw new PaymentError(status, code); }

/** EOA-only v2 subset. Every enabled asset and deployed contract must have reviewed pins. */
export class EvmPaymentChain implements PaymentChain {
  readonly pins: Readonly<PaymentPins>;
  constructor(readonly publicClient: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, LocalAccount>, pins: PaymentPins) {
    if (!Number.isSafeInteger(pins.chainId) || pins.chainId <= 0 || !Number.isSafeInteger(pins.confirmations) || pins.confirmations < 1
      || pins.confirmations > 64 || !equal(wallet.account.address, pins.facilitator) || wallet.chain.id !== pins.chainId
      || ![31337, 8453, 84532].includes(pins.chainId)
      || !['immutable', 'eip1967', 'circle_proxy'].includes(pins.reviewedTokenKind)
      || (pins.reviewedTokenKind === 'immutable') !== !pins.assetImplementation
      || (!pins.exact && !pins.upto)
      || (pins.chainId !== 31337 && (!isNativeBaseUsdc(pins.chainId, pins.asset)
        || pins.reviewedTokenKind !== 'circle_proxy' || !!pins.assetFacet || !pins.exact
        || pins.exact.name !== nativeBaseUsdcName(pins.chainId) || pins.exact.version !== '2'))
      || (pins.reviewedTokenKind === 'circle_proxy' && (!!pins.assetFacet || !pins.assetImplementation))
      || (baseUsdcForChainId(pins.chainId) && !pins.assetImplementation)) throw new Error('Invalid reviewed x402 configuration');
    if (pins.chainId !== 31337 && pins.upto && (!equal(pins.upto.permit2, '0x000000000022D473030F116dDEE9F6B43aC78BA3')
      || !equal(pins.upto.proxy, '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002'))) throw new Error('Canonical Permit2 and x402 upto proxy required outside local fixtures');
    this.pins = Object.freeze({ ...pins, ...(pins.exact ? { exact: Object.freeze({ ...pins.exact }) } : {}),
      ...(pins.upto ? { upto: Object.freeze({ ...pins.upto }) } : {}),
      ...(pins.assetImplementation ? { assetImplementation: Object.freeze({ ...pins.assetImplementation }) } : {}),
      ...(pins.assetFacet ? { assetFacet: Object.freeze({ ...pins.assetFacet }) } : {}) });
  }
  private async assertPins(scheme: Scheme, receiptBlock?: { hash: Hex; number: bigint }): Promise<void> {
    if (await this.publicClient.getChainId() !== this.pins.chainId) fail('chain_pin_mismatch', 503);
    const pinnedBlock = this.pins.assetFacet || this.pins.reviewedTokenKind === 'circle_proxy'
      ? receiptBlock ?? await this.publicClient.getBlock({ blockTag: 'latest' }) : undefined;
    const state = pinnedBlock ? { blockHash: pinnedBlock.hash, requireCanonical: true } as const : {};
    const tokenCode = await this.publicClient.getCode({ address: this.pins.asset, ...state });
    if (!tokenCode || !equal(keccak256(tokenCode), this.pins.tokenCodeHash)) fail('asset_code_pin_mismatch', 503);
    if (this.pins.reviewedTokenKind === 'eip1967') {
      const implementation = this.pins.assetImplementation!;
      const slot = await this.publicClient.getStorageAt({ address: this.pins.asset,
        slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', ...state });
      const code = await this.publicClient.getCode({ address: implementation.address, ...state });
      if (!slot || !equal(`0x${slot.slice(-40)}`, implementation.address) || !code || !equal(keccak256(code), implementation.codeHash)) fail('asset_implementation_pin_mismatch', 503);
    }
    if (this.pins.reviewedTokenKind === 'circle_proxy') {
      const implementation = this.pins.assetImplementation;
      if (!implementation || !await matchesCircleProxyPins(this.publicClient, this.pins.asset, implementation, state)) {
        fail('asset_implementation_pin_mismatch', 503);
      }
      if (this.pins.chainId !== 31337 && !await matchesNativeBaseUsdcMetadata(this.publicClient,
        this.pins.chainId, this.pins.asset, state)) fail('asset_domain_pin_mismatch', 503);
    }
    if (this.pins.assetFacet && (!pinnedBlock || !await matchesAssetFacetPins(this.publicClient, this.pins.asset, this.pins.assetFacet,
      { blockHash: pinnedBlock.hash, requireCanonical: true }))) fail('asset_facet_pin_mismatch', 503);
    if (await this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi, functionName: 'decimals', ...state }) !== 6) fail('unsupported_asset_decimals', 503);
    if (scheme === 'exact') {
      const capability = this.pins.exact;
      if (!capability || capability.reviewedEip3009 !== true) fail('unsupported_exact_asset', 503);
      const actual = await this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state });
      const expected = domainSeparator({ domain: { name: capability.name, version: capability.version,
        chainId: this.pins.chainId, verifyingContract: this.pins.asset } });
      if (!equal(actual, expected)) fail('asset_domain_pin_mismatch', 503);
    } else {
      const capability = this.pins.upto;
      if (!capability) fail('unsupported_upto_asset', 503);
      const [permitCode, proxyCode] = await Promise.all([this.publicClient.getCode({ address: capability.permit2, ...state }),
        this.publicClient.getCode({ address: capability.proxy, ...state })]);
      if (!permitCode || !proxyCode || !equal(keccak256(permitCode), capability.permit2CodeHash)
        || !equal(keccak256(proxyCode), capability.proxyCodeHash)) fail('permit2_code_pin_mismatch', 503);
      const [actualPermit, witness, domain] = await Promise.all([
        this.publicClient.readContract({ address: capability.proxy, abi: uptoAbi, functionName: 'PERMIT2', ...state }),
        this.publicClient.readContract({ address: capability.proxy, abi: uptoAbi, functionName: 'WITNESS_TYPE_STRING', ...state }),
        this.publicClient.readContract({ address: capability.permit2, abi: permitAbi, functionName: 'DOMAIN_SEPARATOR', ...state })]);
      if (!equal(actualPermit, capability.permit2) || witness !== 'Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)'
        || !equal(domain, domainSeparator({ domain: { name: 'Permit2', chainId: this.pins.chainId, verifyingContract: capability.permit2 } }))) {
        fail('permit2_domain_pin_mismatch', 503);
      }
    }
    if (pinnedBlock && !equal((await this.publicClient.getBlock({ blockNumber: pinnedBlock.number })).hash, pinnedBlock.hash)) fail('asset_implementation_pin_mismatch', 503);
  }
  private call(payment: PaymentPayload, amount: string): { to: Address; data: Hex } {
    if ('authorization' in payment.payload) {
      const auth = payment.payload.authorization, sig = payment.payload.signature;
      const vByte = Number.parseInt(sig.slice(130, 132), 16);
      const v = vByte < 27 ? vByte + 27 : vByte;
      return { to: this.pins.asset, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transferWithAuthorization',
        args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce,
          v, `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`] }) };
    }
    const auth = payment.payload.permit2Authorization, capability = this.pins.upto;
    if (!capability) fail('unsupported_upto_asset', 503);
    return { to: capability.proxy, data: encodeFunctionData({ abi: uptoAbi, functionName: 'settle', args: [
      { permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) }, nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline) },
      BigInt(amount), auth.from, { ...auth.witness, validAfter: BigInt(auth.witness.validAfter) }, payment.payload.signature] }) };
  }
  private async nonceUsed(payment: PaymentPayload): Promise<boolean> {
    if ('authorization' in payment.payload) return this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi,
      functionName: 'authorizationState', args: [payment.payload.authorization.from, payment.payload.authorization.nonce] });
    const capability = this.pins.upto;
    if (!capability) fail('unsupported_upto_asset', 503);
    const auth = payment.payload.permit2Authorization, nonce = BigInt(auth.nonce);
    const word = await this.publicClient.readContract({ address: capability.permit2, abi: permitAbi,
      functionName: 'nonceBitmap', args: [auth.from, nonce >> 8n] });
    return (word & (1n << (nonce & 255n))) !== 0n;
  }
  async verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<void> {
    const pins = this.pins, payer = paymentPayer(payment), terms = payment.accepted;
    if (terms.scheme !== requirements.scheme || terms.network !== `eip155:${pins.chainId}`
      || !equal(terms.asset, pins.asset) || !equal(terms.payTo, pins.payTo)
      || !equal(terms.extra.facilitatorAddress, pins.facilitator)) fail('payment_terms_mismatch');
    await this.assertPins(terms.scheme);
    if (await this.publicClient.getCode({ address: payer })) fail('unsupported_contract_wallet');
    if (equal(payer, pins.payTo) || equal(payer, pins.facilitator)) fail('circular_payment');
    const now = (await this.publicClient.getBlock({ blockTag: 'latest' })).timestamp;
    let recovered: Address;
    if (terms.scheme === 'exact') {
      if (!('authorization' in payment.payload)) fail('invalid_exact_payload');
      const auth = payment.payload.authorization, capability = pins.exact;
      if (!capability) fail('unsupported_exact_asset', 503);
      if (!equal(auth.to, pins.payTo) || auth.value !== requirements.amount || !equal(auth.nonce, terms.extra.telomere.nonce)
        || terms.extra.assetTransferMethod !== 'eip3009' || terms.extra.name !== capability.name || terms.extra.version !== capability.version) fail('authorization_mismatch');
      if (BigInt(auth.validAfter) >= now || BigInt(auth.validBefore) <= now + 2n
        || BigInt(auth.validBefore) > now + BigInt(requirements.maxTimeoutSeconds) + 5n) fail('authorization_time_invalid');
      recovered = await recoverTypedDataAddress({ domain: { name: capability.name, version: capability.version, chainId: pins.chainId,
        verifyingContract: pins.asset }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization',
        message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) }, signature: payment.payload.signature });
    } else {
      if (!('permit2Authorization' in payment.payload)) fail('invalid_upto_payload');
      const auth = payment.payload.permit2Authorization, capability = pins.upto;
      if (!capability) fail('unsupported_upto_asset', 503);
      if (!equal(auth.permitted.token, pins.asset) || auth.permitted.amount !== requirements.amount || !equal(auth.spender, capability.proxy)
        || !equal(auth.witness.to, pins.payTo) || !equal(auth.witness.facilitator, pins.facilitator)
        || BigInt(auth.nonce) !== BigInt(terms.extra.telomere.nonce) || terms.extra.assetTransferMethod !== 'permit2'
        || terms.extra.name !== capability.name || terms.extra.version !== capability.version) fail('authorization_mismatch');
      if (BigInt(auth.witness.validAfter) > now || BigInt(auth.deadline) <= now + 2n
        || BigInt(auth.deadline) > now + BigInt(requirements.maxTimeoutSeconds) + 5n) fail('authorization_time_invalid');
      const allowance = await this.publicClient.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'allowance', args: [payer, capability.permit2] });
      if (allowance < BigInt(requirements.amount)) fail('PERMIT2_ALLOWANCE_REQUIRED', 412);
      recovered = await recoverTypedDataAddress({ domain: { name: 'Permit2', chainId: pins.chainId, verifyingContract: capability.permit2 },
        types: PERMIT2_TYPES, primaryType: 'PermitWitnessTransferFrom', message: { permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
          spender: auth.spender, nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline), witness: { ...auth.witness, validAfter: BigInt(auth.witness.validAfter) } },
        signature: payment.payload.signature });
    }
    if (!equal(recovered, payer)) fail('invalid_signature');
    if (await this.nonceUsed(payment)) fail('authorization_already_used', 409);
    if (await this.publicClient.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'balanceOf', args: [payer] }) < BigInt(requirements.amount)) fail('insufficient_balance');
    // Read-only execution of the entire signed maximum catches token/proxy incompatibility.
    await this.publicClient.call({ account: pins.facilitator, ...this.call(payment, requirements.amount) });
  }
  async prepare(payment: PaymentPayload, amount: string): Promise<PreparedPayment> {
    const call = this.call(payment, amount);
    const [nonce, minedNonce] = await Promise.all([
      this.publicClient.getTransactionCount({ address: this.pins.facilitator, blockTag: 'pending' }),
      this.publicClient.getTransactionCount({ address: this.pins.facilitator, blockTag: 'latest' })]);
    if (nonce !== minedNonce) fail('facilitator_pending_nonce', 503);
    const request = await this.wallet.prepareTransactionRequest({ account: this.wallet.account, chain: this.wallet.chain, ...call, nonce });
    if (request.gas !== undefined) request.gas = request.gas * 13n / 10n + 50_000n;
    const raw = await this.wallet.signTransaction(request);
    return { raw, hash: keccak256(raw), nonce };
  }
  async broadcast(raw: Hex): Promise<Hex> {
    const transaction = parseTransaction(raw);
    if (transaction.chainId !== this.pins.chainId || !transaction.to) fail('journal_transaction_pin_mismatch', 503);
    if (equal(transaction.to, this.pins.asset)) await this.assertPins('exact');
    else if (this.pins.upto && equal(transaction.to, this.pins.upto.proxy)) await this.assertPins('upto');
    else fail('journal_transaction_pin_mismatch', 503);
    return this.publicClient.sendRawTransaction({ serializedTransaction: raw });
  }
  async inspect(prepared: PreparedPayment, payment: PaymentPayload, amount: string): Promise<'pending' | 'settled' | 'reverted'> {
    await this.assertPins(payment.accepted.scheme);
    let receipt;
    try { receipt = await this.publicClient.getTransactionReceipt({ hash: prepared.hash }); }
    catch (error) { if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return 'pending'; throw error; }
    const canonical = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (!equal(canonical.hash, receipt.blockHash)) return 'pending';
    const height = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    if (height - receipt.blockNumber + 1n < BigInt(this.pins.confirmations)) return 'pending';
    // Prove the actual receipt block used the reviewed implementation before accepting its logs.
    if (this.pins.assetFacet || this.pins.reviewedTokenKind === 'circle_proxy') {
      await this.assertPins(payment.accepted.scheme, { hash: receipt.blockHash, number: receipt.blockNumber });
      if (this.pins.assetFacet && !await stableAssetFacetReceiptBlock(this.publicClient, this.pins.asset, this.pins.assetFacet,
        receipt.blockHash, receipt.blockNumber)) fail('asset_facet_pin_mismatch', 503);
      if (this.pins.reviewedTokenKind === 'circle_proxy' && this.pins.assetImplementation
        && !await stableCircleProxyReceiptBlock(this.publicClient, this.pins.asset, this.pins.tokenCodeHash,
          this.pins.assetImplementation, receipt.blockHash, receipt.blockNumber)) fail('asset_implementation_pin_mismatch', 503);
    }
    if (receipt.status === 'reverted') {
      const finalBlock = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      return equal(finalBlock.hash, receipt.blockHash) ? 'reverted' : 'pending';
    }
    const payer = paymentPayer(payment); let transferred = 0n;
    for (const log of receipt.logs) {
      if (!equal(log.address, this.pins.asset)) continue;
      try {
        const event = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics });
        if (event.eventName === 'Transfer' && equal(event.args.from, payer) && equal(event.args.to, this.pins.payTo)) transferred += event.args.value;
      } catch { /* Other token events cannot prove a transfer. */ }
    }
    if (transferred !== BigInt(amount) || !await this.nonceUsed(payment)) fail('settlement_receipt_mismatch', 503);
    const finalBlock = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (!equal(finalBlock.hash, receipt.blockHash)) return 'pending';
    return 'settled';
  }
}
