import { decodeEventLog, domainSeparator, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, toHex, type Address, type Chain, type Hex, type LocalAccount, type PublicClient,
  type TransactionReceipt, type TransactionSerialized, type Transport, type WalletClient } from 'viem';
import { z } from 'zod';
import { RpcIncomeEndpointReader } from '../selection/income-endpoints/reader.js';
import { incomeAddressSchema, incomeEndpointPinsSchema, incomeHashSchema } from '../selection/income-endpoints/types.js';
import { EvmPaymentChain, type PaymentChain, type PreparedPayment } from './gateway.js';
import { assetFacetPinsSchema, matchesAssetFacetPins, stableAssetFacetReceiptBlock } from './asset-facets.js';
import { isNativeBaseUsdc, matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, nativeBaseUsdcName,
  stableCircleProxyReceiptBlock } from './circle-usdc.js';
import { canonical, PaymentError, paymentPayloadSchema, paymentPayer, requirementsSchema, type PaymentPayload, type PaymentRequirements } from './protocol.js';

const pinsSchema = z.object({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), asset: incomeAddressSchema,
  tokenCodeHash: incomeHashSchema, payTo: incomeAddressSchema, facilitator: incomeAddressSchema,
  reviewedTokenKind: z.enum(['immutable', 'eip1967', 'circle_proxy']),
  assetImplementation: z.object({ address: incomeAddressSchema, codeHash: incomeHashSchema }).strict().optional(),
  assetFacet: assetFacetPinsSchema.optional(),
  archiveAnchor: z.object({ number: z.string().regex(/^[1-9][0-9]{0,19}$/), hash: incomeHashSchema,
    timestamp: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict().optional(),
  confirmations: z.number().int().min(1).max(64),
  exact: z.object({ reviewedEip3009: z.literal(true), name: z.string().min(1).max(100), version: z.string().min(1).max(30) }).strict(),
  selection: incomeEndpointPinsSchema, agentId: incomeHashSchema, treasury: incomeAddressSchema,
}).strict().superRefine((value, context) => {
  if (![31337, 8453, 84532].includes(value.chainId)
    || value.chainId !== value.selection.chainId || value.confirmations !== value.selection.confirmations
    || value.reviewedTokenKind !== 'immutable' && !value.assetImplementation
    || value.reviewedTokenKind === 'immutable' && (value.assetImplementation || value.assetFacet)
    || value.reviewedTokenKind === 'circle_proxy' && !!value.assetFacet
    || value.chainId === 31337 && !!value.archiveAnchor
    || value.chainId !== 31337 && (!isNativeBaseUsdc(value.chainId, value.asset)
      || value.reviewedTokenKind !== 'circle_proxy' || !value.assetImplementation || !!value.assetFacet
      || !value.archiveAnchor || value.exact.name !== nativeBaseUsdcName(value.chainId)
      || value.exact.version !== '2')) context.addIssue({ code: 'custom', message: 'Reviewed income deployment differs.' });
});
export type VaultIncomePins = Omit<z.infer<typeof pinsSchema>, 'assetImplementation' | 'assetFacet'> & {
  assetImplementation?: { address: Address; codeHash: Hex };
  assetFacet?: { address: Address; codeHash: Hex } | undefined;
};
const vaultAbi = parseAbi([
  'function receiveFundsWithAuthorization(address from,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function usedIncomeAuthorization(bytes32) view returns(bool)',
  'event FundsReceived(address indexed source,uint96 grossAmount,uint96 incomeFee,bytes32 paymentRef)',
]);
const registryAbi = parseAbi([
  'function treasury() view returns(address)',
  'event Income(bytes32 indexed agentId,uint96 amount,uint96 fee,address indexed source,bytes32 paymentRef)',
  'event Subsidy(bytes32 indexed agentId,uint96 amount,address indexed source,bytes32 paymentRef)',
]);
const tokenAbi = parseAbi(['function authorizationState(address,bytes32) view returns(bool)',
  'function decimals() view returns(uint8)', 'function DOMAIN_SEPARATOR() view returns(bytes32)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const equal = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const domain = keccak256(toHex('TelomerePlatformVaultIncomeEip3009V1'));
function fail(code: string): never { throw new PaymentError(503, code); }
export function vaultIncomeAuthorizationRef(chainId: number, asset: Address, vault: Address, from: Address, nonce: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' },
    { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [domain, BigInt(chainId), asset, vault, from, nonce]));
}
function ingressCall(payment: PaymentPayload): { to: Address; data: Hex } {
  if (payment.accepted.scheme !== 'exact' || !('authorization' in payment.payload)) throw new PaymentError(422, 'unsupported_income_payment_scheme');
  const auth = payment.payload.authorization, signature = payment.payload.signature, vByte = Number.parseInt(signature.slice(130, 132), 16);
  if (BigInt(auth.value) === 0n || BigInt(auth.value) >= 2n ** 96n) throw new PaymentError(422, 'income_amount_out_of_bounds');
  return { to: auth.to, data: encodeFunctionData({ abi: vaultAbi, functionName: 'receiveFundsWithAuthorization', args: [auth.from,
    BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, vByte < 27 ? vByte + 27 : vByte,
    `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`] }) };
}

/** Validate per-transaction conservation from pinned contract events, never current balances. */
export function validateVaultIncomeReceipt(receipt: TransactionReceipt, payment: PaymentPayload, pins: VaultIncomePins): void {
  if (!('authorization' in payment.payload)) fail('income_receipt_mismatch');
  const payer = paymentPayer(payment), amount = BigInt(payment.payload.authorization.value);
  const ref = vaultIncomeAuthorizationRef(pins.chainId, pins.asset, pins.payTo, payer, payment.payload.authorization.nonce);
  let funds = 0, classified = 0, gross = 0n, incoming = 0n, outgoing = 0n, feeTransfer = 0n, expectedFee = 0n, fee = 0n;
  for (const log of receipt.logs) {
    if (log.removed || log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash
      || log.blockNumber !== receipt.blockNumber) fail('income_receipt_mismatch');
    if (equal(log.address, pins.asset)) {
      try {
        const event = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics });
        if (event.eventName === 'Transfer') {
          if (equal(event.args.to, pins.payTo)) incoming += event.args.value;
          if (equal(event.args.from, pins.payTo)) outgoing += event.args.value;
          if (equal(event.args.from, payer) && equal(event.args.to, pins.payTo)) gross += event.args.value;
          if (equal(event.args.from, pins.payTo) && equal(event.args.to, pins.treasury)) feeTransfer += event.args.value;
        }
      } catch (error) { if (error instanceof PaymentError) throw error; /* Other token events are not transfer evidence. */ }
    } else if (equal(log.address, pins.payTo)) {
      try {
        const event = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
        if (event.eventName === 'FundsReceived') {
          funds += 1;
          if (!equal(event.args.source, payer) || event.args.grossAmount !== amount || event.args.paymentRef !== ref) fail('income_receipt_mismatch');
          fee = event.args.incomeFee;
        }
      } catch (error) { if (error instanceof PaymentError) throw error; /* Other Vault events cannot classify ingress. */ }
    } else if (equal(log.address, pins.selection.selectionRegistryAddress)) {
      try {
        const event = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
        classified += 1;
        if (event.args.agentId !== pins.agentId || !equal(event.args.source, payer) || event.args.amount !== amount || event.args.paymentRef !== ref) fail('income_receipt_mismatch');
        expectedFee = event.eventName === 'Income' ? (amount * 100n + 9_999n) / 10_000n : 0n;
        if (event.eventName === 'Income' && event.args.fee !== expectedFee) fail('income_receipt_mismatch');
      } catch (error) { if (error instanceof PaymentError) throw error; /* Other registry events cannot classify ingress. */ }
    }
  }
  if (funds !== 1 || classified !== 1 || gross !== amount || incoming !== amount || fee !== expectedFee || feeTransfer !== fee || outgoing !== fee) fail('income_receipt_mismatch');
}

/** Exact-only native Vault ingress. Main remains disabled without an explicit reviewed private profile. */
export class EvmVaultIncomeChain implements PaymentChain {
  readonly pins: Readonly<VaultIncomePins>;
  private readonly legacyVerifier: EvmPaymentChain;
  private readonly authority: RpcIncomeEndpointReader;
  constructor(readonly publicClient: PublicClient, private readonly wallet: WalletClient<Transport, Chain, LocalAccount>,
    rawPins: VaultIncomePins, options: { rpcUrl: string }) {
    const pins = pinsSchema.parse(rawPins), { assetImplementation, assetFacet, ...base } = pins;
    this.pins = Object.freeze({ ...base, exact: Object.freeze(pins.exact), selection: Object.freeze(pins.selection),
      ...(assetImplementation ? { assetImplementation: Object.freeze(assetImplementation) } : {}),
      ...(assetFacet ? { assetFacet: Object.freeze(assetFacet) } : {}) });
    this.legacyVerifier = new EvmPaymentChain(publicClient, wallet, this.pins);
    this.authority = new RpcIncomeEndpointReader({ rpcUrl: options.rpcUrl, pins: pins.selection, asset: pins.asset });
  }
  private async assertAuthority(): Promise<void> {
    if (await this.publicClient.getChainId() !== this.pins.chainId) fail('chain_pin_mismatch');
    const snapshot = await this.authority.snapshot(this.pins.agentId);
    if (!equal(snapshot.binding.vault, this.pins.payTo)) fail('income_vault_binding_mismatch');
    const treasury = await this.publicClient.readContract({ address: this.pins.selection.selectionRegistryAddress,
      abi: registryAbi, functionName: 'treasury', blockHash: snapshot.block.hash, requireCanonical: true });
    if (!equal(treasury, this.pins.treasury)) fail('income_treasury_binding_mismatch');
  }
  private assertTerms(payment: PaymentPayload): void {
    if (payment.accepted.scheme !== 'exact' || !('authorization' in payment.payload)
      || payment.accepted.network !== `eip155:${this.pins.chainId}` || !equal(payment.accepted.asset, this.pins.asset)
      || !equal(payment.accepted.payTo, this.pins.payTo) || !equal(payment.payload.authorization.to, this.pins.payTo)
      || !equal(payment.accepted.extra.facilitatorAddress, this.pins.facilitator)
      || payment.accepted.extra.assetTransferMethod !== 'eip3009' || payment.accepted.extra.name !== this.pins.exact.name
      || payment.accepted.extra.version !== this.pins.exact.version || payment.payload.authorization.nonce !== payment.accepted.extra.telomere.nonce
      || payment.payload.authorization.value !== payment.accepted.amount) throw new PaymentError(422, 'payment_terms_mismatch');
  }
  private async assertAsset(blockHash: Hex): Promise<void> {
    const state = { blockHash, requireCanonical: true } as const;
    const code = await this.publicClient.getCode({ address: this.pins.asset, ...state });
    if (!code || keccak256(code) !== this.pins.tokenCodeHash) fail('asset_code_pin_mismatch');
    if (this.pins.reviewedTokenKind === 'eip1967') {
      const implementation = this.pins.assetImplementation; if (!implementation) fail('asset_implementation_pin_mismatch');
      const [slot, implementationCode] = await Promise.all([
        this.publicClient.getStorageAt({ address: this.pins.asset, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', ...state }),
        this.publicClient.getCode({ address: implementation.address, ...state }),
      ]);
      if (!slot || !equal(`0x${slot.slice(-40)}`, implementation.address) || !implementationCode || keccak256(implementationCode) !== implementation.codeHash) fail('asset_implementation_pin_mismatch');
    }
    if (this.pins.reviewedTokenKind === 'circle_proxy') {
      const implementation = this.pins.assetImplementation;
      if (!implementation || !await matchesCircleProxyPins(this.publicClient, this.pins.asset, implementation, state)) {
        fail('asset_implementation_pin_mismatch');
      }
      if (this.pins.chainId !== 31337 && !await matchesNativeBaseUsdcMetadata(this.publicClient,
        this.pins.chainId, this.pins.asset, state)) fail('asset_domain_pin_mismatch');
    }
    if (this.pins.assetFacet && !await matchesAssetFacetPins(this.publicClient, this.pins.asset, this.pins.assetFacet, state)) fail('asset_facet_pin_mismatch');
    const [decimals, separator] = await Promise.all([
      this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi, functionName: 'decimals', ...state }),
      this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
    ]);
    if (decimals !== 6) fail('unsupported_asset_decimals');
    if (separator !== domainSeparator({ domain: { name: this.pins.exact.name, version: this.pins.exact.version,
      chainId: this.pins.chainId, verifyingContract: this.pins.asset } })) fail('asset_domain_pin_mismatch');
  }
  private async assertReceiptCode(blockHash: Hex): Promise<void> {
    const state = { blockHash, requireCanonical: true } as const, pins = this.pins.selection;
    const [registry, implementation, vault, treasury] = await Promise.all([
      this.publicClient.getCode({ address: pins.selectionRegistryAddress, ...state }),
      this.publicClient.getCode({ address: pins.vaultImplementationAddress, ...state }),
      this.publicClient.getCode({ address: this.pins.payTo, ...state }),
      this.publicClient.readContract({ address: pins.selectionRegistryAddress, abi: registryAbi, functionName: 'treasury', ...state }),
    ]);
    const clone = `0x363d3d373d3d3d363d73${pins.vaultImplementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    if (!registry || keccak256(registry) !== pins.selectionRegistryCodeHash || !implementation
      || keccak256(implementation) !== pins.vaultImplementationCodeHash || !vault || !equal(vault, clone)
      || !equal(treasury, this.pins.treasury)) fail('income_historical_deployment_mismatch');
  }
  async verify(rawPayment: PaymentPayload, rawRequirements: PaymentRequirements): Promise<void> {
    const payment = paymentPayloadSchema.parse(rawPayment), requirements = requirementsSchema.parse(rawRequirements), call = ingressCall(payment);
    this.assertTerms(payment);
    if (canonical(requirements) !== canonical(payment.accepted)) throw new PaymentError(422, 'payment_terms_mismatch');
    await this.assertAuthority();
    await this.legacyVerifier.verify(payment, requirements);
    await this.publicClient.call({ account: this.pins.facilitator, ...call });
  }
  async prepare(rawPayment: PaymentPayload, amount: string): Promise<PreparedPayment> {
    const payment = paymentPayloadSchema.parse(rawPayment), call = ingressCall(payment);
    this.assertTerms(payment);
    if (amount !== payment.accepted.amount || !equal(call.to, this.pins.payTo)) throw new PaymentError(422, 'settlement_amount_invalid');
    await this.verify(payment, payment.accepted);
    const [nonce, minedNonce] = await Promise.all([
      this.publicClient.getTransactionCount({ address: this.pins.facilitator, blockTag: 'pending' }),
      this.publicClient.getTransactionCount({ address: this.pins.facilitator, blockTag: 'latest' }),
    ]);
    if (nonce !== minedNonce) fail('facilitator_pending_nonce');
    const request = await this.wallet.prepareTransactionRequest({ account: this.wallet.account, chain: this.wallet.chain, ...call, nonce });
    if (request.gas !== undefined) request.gas = request.gas * 13n / 10n + 50_000n;
    const raw = await this.wallet.signTransaction(request); return { raw, hash: keccak256(raw), nonce };
  }
  private async assertRaw(raw: Hex, payment?: PaymentPayload, prepared?: PreparedPayment): Promise<void> {
    const serialized = incomeRawSchema.parse(raw), transaction = parseTransaction(serialized);
    if (transaction.chainId !== this.pins.chainId || !transaction.to || !equal(transaction.to, this.pins.payTo)
      || (transaction.value ?? 0n) !== 0n || !transaction.data?.startsWith(ingressSelector) || transaction.data.length !== 522
      || !equal(await recoverTransactionAddress({ serializedTransaction: serialized }), this.pins.facilitator)
      || prepared && (keccak256(raw) !== prepared.hash || transaction.nonce !== prepared.nonce)) fail('income_journal_transaction_mismatch');
    if (payment && !equal(transaction.data, ingressCall(payment).data)) fail('income_journal_transaction_mismatch');
  }
  async broadcast(raw: Hex): Promise<Hex> {
    await this.assertRaw(raw); await this.assertAuthority();
    const block = await this.publicClient.getBlock({ blockTag: 'latest' }); await this.assertAsset(block.hash);
    return this.publicClient.sendRawTransaction({ serializedTransaction: raw });
  }
  async inspect(prepared: PreparedPayment, rawPayment: PaymentPayload, amount: string): Promise<'pending' | 'settled' | 'reverted'> {
    const payment = paymentPayloadSchema.parse(rawPayment);
    this.assertTerms(payment);
    if (amount !== payment.accepted.amount || !('authorization' in payment.payload)) fail('income_journal_transaction_mismatch');
    await this.assertRaw(prepared.raw, payment, prepared); await this.assertAuthority();
    const latest = await this.publicClient.getBlock({ blockTag: 'latest' }); await this.assertAsset(latest.hash);
    let receipt: TransactionReceipt;
    try { receipt = await this.publicClient.getTransactionReceipt({ hash: prepared.hash }); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error;
      const used = await this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi, functionName: 'authorizationState',
        args: [payment.payload.authorization.from, payment.payload.authorization.nonce] });
      if (used) fail('income_authorization_reconciliation_required'); return 'pending';
    }
    if (receipt.transactionHash !== prepared.hash || !equal(receipt.from, this.pins.facilitator) || !receipt.to || !equal(receipt.to, this.pins.payTo)) fail('income_receipt_mismatch');
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) return 'pending';
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    if (head - receipt.blockNumber + 1n < BigInt(this.pins.confirmations)) return 'pending';
    await this.assertAsset(receipt.blockHash);
    await this.assertReceiptCode(receipt.blockHash);
    if (this.pins.assetFacet && !await stableAssetFacetReceiptBlock(this.publicClient, this.pins.asset, this.pins.assetFacet,
      receipt.blockHash, receipt.blockNumber)) fail('asset_facet_pin_mismatch');
    if (this.pins.reviewedTokenKind === 'circle_proxy' && this.pins.assetImplementation
      && !await stableCircleProxyReceiptBlock(this.publicClient, this.pins.asset, this.pins.tokenCodeHash,
        this.pins.assetImplementation, receipt.blockHash, receipt.blockNumber)) fail('asset_implementation_pin_mismatch');
    if (receipt.status === 'reverted') {
      // A reverted transaction did not consume its authorization at that block.
      // The same still-valid authorization may have been used by another relay
      // later; definitive failure must not authorize a replacement payment.
      const latest = await this.publicClient.getBlock({ blockTag: 'latest' });
      await this.assertAsset(latest.hash); await this.assertReceiptCode(latest.hash);
      const ref = vaultIncomeAuthorizationRef(this.pins.chainId, this.pins.asset, this.pins.payTo,
        payment.payload.authorization.from, payment.payload.authorization.nonce);
      const [used, consumed] = await Promise.all([
        this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi, functionName: 'authorizationState',
          args: [payment.payload.authorization.from, payment.payload.authorization.nonce], blockHash: latest.hash, requireCanonical: true }),
        this.publicClient.readContract({ address: this.pins.payTo, abi: vaultAbi, functionName: 'usedIncomeAuthorization',
          args: [ref], blockHash: latest.hash, requireCanonical: true }),
      ]);
      const [finalBlock, finalLatest, finalHead, chainId] = await Promise.all([this.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
        this.publicClient.getBlock({ blockNumber: latest.number }), this.publicClient.getBlockNumber({ cacheTime: 0 }), this.publicClient.getChainId()]);
      if (chainId !== this.pins.chainId) fail('chain_pin_mismatch');
      if (finalLatest.hash !== latest.hash || finalHead < latest.number) return 'pending';
      if (used || consumed) fail('income_authorization_reconciliation_required');
      return finalBlock.hash === receipt.blockHash && finalHead - receipt.blockNumber + 1n >= BigInt(this.pins.confirmations) ? 'reverted' : 'pending';
    }
    validateVaultIncomeReceipt(receipt, payment, this.pins);
    const ref = vaultIncomeAuthorizationRef(this.pins.chainId, this.pins.asset, this.pins.payTo, payment.payload.authorization.from, payment.payload.authorization.nonce);
    const [used, consumed] = await Promise.all([
      this.publicClient.readContract({ address: this.pins.asset, abi: tokenAbi, functionName: 'authorizationState', args: [payment.payload.authorization.from,
        payment.payload.authorization.nonce], blockHash: receipt.blockHash, requireCanonical: true }),
      this.publicClient.readContract({ address: this.pins.payTo, abi: vaultAbi, functionName: 'usedIncomeAuthorization', args: [ref],
        blockHash: receipt.blockHash, requireCanonical: true }),
    ]);
    if (!used || !consumed) fail('income_receipt_mismatch');
    const [finalBlock, finalHead, finalChain] = await Promise.all([this.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
      this.publicClient.getBlockNumber({ cacheTime: 0 }), this.publicClient.getChainId()]);
    if (finalChain !== this.pins.chainId) fail('chain_pin_mismatch');
    if (finalBlock.hash !== receipt.blockHash || finalHead - receipt.blockNumber + 1n < BigInt(this.pins.confirmations)) return 'pending';
    return 'settled';
  }
}
// REASON: parseTransaction subsequently validates the signed transaction envelope and fields.
const incomeRawSchema = z.string().regex(/^0x[0-9a-fA-F]+$/).min(4).max(16_384).refine(value => value.length % 2 === 0).transform(value => value as TransactionSerialized);
const ingressSelector = encodeFunctionData({ abi: vaultAbi, functionName: 'receiveFundsWithAuthorization',
  args: ['0x0000000000000000000000000000000000000001', 1n, 0n, 1n, toHex(0, { size: 32 }), 27, toHex(0, { size: 32 }), toHex(0, { size: 32 })] }).slice(0, 10);
