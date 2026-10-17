import { createPublicClient, decodeEventLog, domainSeparator, encodeFunctionData, http, keccak256, MethodNotFoundRpcError, parseAbi,
  parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, serializeTransaction, toHex, type Address, type Hex, type TransactionReceipt, type TransactionSerialized } from 'viem';
import { z } from 'zod';
import { matchesAssetFacetPins, stableAssetFacetReceiptBlock } from '../../payments/asset-facets.js';
import { assertCircleUsdcArchiveHistory } from '../../payments/circle-usdc-archive.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, stableCircleProxyReceiptBlock } from '../../payments/circle-usdc.js';
import { digest, paymentPayloadSchema, type PaymentPayload } from '../../payments/protocol.js';
import { validateVaultIncomeReceipt, vaultIncomeAuthorizationRef } from '../../payments/vault-income-chain.js';
import { vaultIncomeRpcFetch } from '../../payments/vault-income-rpc.js';
import { RpcIncomeEndpointReader } from '../../selection/income-endpoints/reader.js';
import { incomeBlockSchema, incomeHashSchema, type IncomeBlock, type IncomeSnapshot } from '../../selection/income-endpoints/types.js';
import { assertVaultIncomePlan, reviewedVaultIncomeProfile, vaultIncomeTypedData } from './integrity.js';
import { VaultIncomeClientError,
  type VaultIncomeInspection, type VaultIncomePublicProfile, type VaultIncomeReader } from './types.js';

const selectionAbi = parseAbi([
  'struct Agent { uint256 identityId; address owner; address agentWallet; address vault; bytes32 leashId; bytes32 parent; bytes32 family; bytes32 cystHash; uint64 enteredAt; uint64 dormantAt; uint64 diedAt; uint64 lastPaidRun; uint64 lastActivationAt; uint64 deathAt; uint256 lifetimeIncome; uint256 lifetimeBurn; uint256 lifetimeSubsidy; uint256 lifetimeIncomeFees; uint8 livingChildren; uint8 status; bool frozen; }',
  'function getAgent(bytes32) view returns (Agent)', 'function agentWalletAgent(address) view returns(bytes32)',
  'function vaultAgent(address) view returns(bytes32)', 'function token() view returns(address)',
  'function escrow() view returns(address)', 'function controller() view returns(address)',
  'function treasury() view returns(address)', 'function vaultImplementation() view returns(address)',
  'event Income(bytes32 indexed agentId,uint96 amount,uint96 fee,address indexed source,bytes32 paymentRef)',
  'event Subsidy(bytes32 indexed agentId,uint96 amount,address indexed source,bytes32 paymentRef)',
]);
const vaultAbi = parseAbi(['function token() view returns(address)', 'function escrow() view returns(address)',
  'function controller() view returns(address)', 'function registry() view returns(address)', 'function treasury() view returns(address)',
  'function owner() view returns(address)', 'function agentWallet() view returns(address)', 'function agentId() view returns(bytes32)',
  'function usedIncomeAuthorization(bytes32) view returns(bool)',
  'function receiveFundsWithAuthorization(address from,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
const tokenAbi = parseAbi(['function decimals() view returns(uint8)', 'function DOMAIN_SEPARATOR() view returns(bytes32)',
  'function authorizationState(address,bytes32) view returns(bool)']);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unavailable = () => new VaultIncomeClientError('vault_income_chain_unavailable');
function fail(code: string): never { throw new VaultIncomeClientError(code); }
const rpcQuantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/);
const rpcAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const rpcHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const rpcType2 = z.object({ type: z.literal('0x2'), hash: rpcHash, from: rpcAddress, chainId: rpcQuantity, nonce: rpcQuantity,
  gas: rpcQuantity, to: rpcAddress, value: rpcQuantity, input: z.string().max(16_384).regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  accessList: z.array(z.object({ address: rpcAddress, storageKeys: z.array(rpcHash).max(64) }).strict()).max(64),
  maxFeePerGas: rpcQuantity, maxPriorityFeePerGas: rpcQuantity, yParity: z.enum(['0x0', '0x1']),
  r: z.union([rpcQuantity, rpcHash]), s: z.union([rpcQuantity, rpcHash]), v: z.enum(['0x0', '0x1']).optional(),
});
/** Reconstruct only an explicitly signed EIP-1559 envelope. RPC metadata is
 * not evidence: the resulting bytes still undergo hash and signer checks. */
function reconstructType2(value: unknown, hash: Hex, chainId: number, facilitator: Address): Hex {
  const parsed = rpcType2.safeParse(value); if (!parsed.success) fail('income_transaction_mismatch');
  const tx = parsed.data, chain = BigInt(tx.chainId), nonce = BigInt(tx.nonce), gas = BigInt(tx.gas);
  const r = BigInt(tx.r), s = BigInt(tx.s), curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  if (!equal(tx.hash, hash) || !equal(tx.from, facilitator) || chain !== BigInt(chainId) || nonce > BigInt(Number.MAX_SAFE_INTEGER)
    || gas === 0n || gas >= 2n ** 64n || BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)
    || r === 0n || r >= curveOrder || s === 0n || s > curveOrder / 2n || tx.v !== undefined && tx.v !== tx.yParity) fail('income_transaction_mismatch');
  return serializeTransaction({ type: 'eip1559', chainId, nonce: Number(nonce), gas, to: tx.to as Address,
    value: BigInt(tx.value), data: tx.input as Hex, maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    accessList: tx.accessList.map(item => ({ address: item.address as Address, storageKeys: item.storageKeys as Hex[] })) },
  { r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }), yParity: tx.yParity === '0x0' ? 0 : 1 });
}
async function checkedPayment(raw: PaymentPayload, profile: Readonly<VaultIncomePublicProfile>): Promise<PaymentPayload> {
  const payment = paymentPayloadSchema.parse(raw);
  if (!('authorization' in payment.payload)) fail('payment_terms_mismatch');
  const plan = { operationId: 'reader', profileHash: digest(profile), resource: payment.resource, accepted: payment.accepted,
    authorization: payment.payload.authorization };
  assertVaultIncomePlan(plan, profile);
  if (payment.extensions && payment.extensions['telomere-request-binding'].requestHash !== plan.accepted.extra.telomere.requestHash) fail('payment_terms_mismatch');
  if (!equal(await recoverTypedDataAddress({ ...vaultIncomeTypedData(plan, profile), signature: payment.payload.signature }), plan.authorization.from)) fail('vault_income_signature_mismatch');
  return payment;
}
function calldata(payment: PaymentPayload): Hex {
  if (!('authorization' in payment.payload)) fail('payment_terms_mismatch');
  const auth = payment.payload.authorization, signature = payment.payload.signature, byte = Number.parseInt(signature.slice(130, 132), 16);
  return encodeFunctionData({ abi: vaultAbi, functionName: 'receiveFundsWithAuthorization', args: [auth.from, BigInt(auth.value),
    BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, byte < 27 ? byte + 27 : byte,
    `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`] });
}

/** Independent read-only chain evidence. An explicitly unsupported raw RPC may
 * use complete signed type-2 fields; reconstructed bytes must prove the hash
 * and signer. Neither HTTP success nor an RPC `from` field is proof. */
export class RpcVaultIncomeReader implements VaultIncomeReader {
  readonly profile: Readonly<VaultIncomePublicProfile>;
  private readonly client;
  private readonly authority: RpcIncomeEndpointReader;
  constructor(options: { rpcUrl: string; profile: VaultIncomePublicProfile }) {
    try {
      this.profile = reviewedVaultIncomeProfile(options.profile);
      const url = new URL(options.rpcUrl);
      if (url.username || url.password || url.hash || url.protocol !== 'https:'
        && !(this.profile.pins.chainId === 31337 && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) fail('vault_income_rpc_required');
      this.client = createPublicClient({ transport: http(url.href, { retryCount: 0, timeout: 10_000, fetchFn: vaultIncomeRpcFetch }), cacheTime: 0 });
      this.authority = new RpcIncomeEndpointReader({ rpcUrl: url.href, pins: this.profile.pins.selection, asset: this.profile.pins.asset });
    } catch (error) { throw error instanceof VaultIncomeClientError ? error : unavailable(); }
  }
  private async canonical(block: IncomeBlock, confirmations = 0): Promise<boolean> {
    const [chain, current, head] = await Promise.all([this.client.getChainId(), this.client.getBlock({ blockNumber: BigInt(block.number) }),
      this.client.getBlockNumber({ cacheTime: 0 })]);
    if (chain !== this.profile.pins.chainId) fail('chain_pin_mismatch');
    return current.number === BigInt(block.number) && equal(current.hash, block.hash) && current.timestamp.toString() === block.timestamp
      && head >= BigInt(block.number) && (confirmations === 0 || head - BigInt(block.number) + 1n >= BigInt(confirmations));
  }
  private async latest(): Promise<IncomeBlock> {
    const value = await this.client.getBlock({ blockTag: 'latest' });
    return incomeBlockSchema.parse({ number: value.number.toString(), hash: value.hash, timestamp: value.timestamp.toString() });
  }
  private async asset(blockHash: Hex): Promise<void> {
    const pins = this.profile.pins, state = { blockHash, requireCanonical: true } as const;
    const [code, decimals, separator] = await Promise.all([
      this.client.getCode({ address: pins.asset, ...state }),
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'decimals', ...state }),
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
    ]);
    if (!code || keccak256(code) !== pins.tokenCodeHash || decimals !== 6 || separator !== domainSeparator({ domain: {
      name: pins.exact.name, version: pins.exact.version, chainId: pins.chainId, verifyingContract: pins.asset } })) fail('asset_pin_mismatch');
    if (pins.reviewedTokenKind === 'eip1967') {
      const implementation = pins.assetImplementation; if (!implementation) fail('asset_pin_mismatch');
      const [slot, implCode] = await Promise.all([
        this.client.getStorageAt({ address: pins.asset, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', ...state }),
        this.client.getCode({ address: implementation.address, ...state }),
      ]);
      if (!slot || !equal(`0x${slot.slice(-40)}`, implementation.address) || !implCode || keccak256(implCode) !== implementation.codeHash) fail('asset_pin_mismatch');
    }
    if (pins.reviewedTokenKind === 'circle_proxy') {
      const implementation = pins.assetImplementation;
      if (!implementation || !await matchesCircleProxyPins(this.client, pins.asset, implementation, state)
        || pins.chainId !== 31337 && !await matchesNativeBaseUsdcMetadata(this.client,
          pins.chainId, pins.asset, state)) fail('asset_pin_mismatch');
    }
    if (pins.assetFacet && !await matchesAssetFacetPins(this.client, pins.asset, pins.assetFacet, state)) fail('asset_pin_mismatch');
  }
  private async deployment(blockHash: Hex): Promise<void> {
    const pins = this.profile.pins, selection = pins.selection, state = { blockHash, requireCanonical: true } as const;
    const registry = selection.selectionRegistryAddress, implementation = selection.vaultImplementationAddress;
    const agent = await this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'getAgent', args: [pins.agentId], ...state });
    if (agent.status === 0 || !equal(agent.vault, pins.payTo)) fail('income_vault_binding_mismatch');
    const [registryCode, implementationCode, cloneCode, signerCode, token, escrow, controller, treasury, actualImplementation,
      walletId, vaultId, implToken, implEscrow, implController, implRegistry, implTreasury, owner, wallet, cloneId] = await Promise.all([
      this.client.getCode({ address: registry, ...state }), this.client.getCode({ address: implementation, ...state }),
      this.client.getCode({ address: pins.payTo, ...state }), this.client.getCode({ address: pins.facilitator, ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'token', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'escrow', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'controller', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'treasury', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'vaultImplementation', ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'agentWalletAgent', args: [agent.agentWallet], ...state }),
      this.client.readContract({ address: registry, abi: selectionAbi, functionName: 'vaultAgent', args: [pins.payTo], ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'token', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'escrow', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'controller', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'registry', ...state }),
      this.client.readContract({ address: implementation, abi: vaultAbi, functionName: 'treasury', ...state }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'owner', ...state }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'agentWallet', ...state }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'agentId', ...state }),
    ]);
    const clone = `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    if (!registryCode || keccak256(registryCode) !== selection.selectionRegistryCodeHash || !implementationCode
      || keccak256(implementationCode) !== selection.vaultImplementationCodeHash || !cloneCode || !equal(cloneCode, clone)
      || signerCode && signerCode !== '0x' || !equal(token, pins.asset) || !equal(actualImplementation, implementation)
      || !equal(treasury, pins.treasury) || !equal(implToken, token) || !equal(implEscrow, escrow) || !equal(implController, controller)
      || !equal(implRegistry, registry) || !equal(implTreasury, treasury) || walletId !== pins.agentId || vaultId !== pins.agentId
      || cloneId !== pins.agentId || !equal(owner, agent.owner) || !equal(wallet, agent.agentWallet)
      || [controller, treasury, owner, wallet].some(value => equal(value, pins.facilitator))) fail('income_deployment_pin_mismatch');
  }
  async check(): Promise<IncomeSnapshot> {
    try {
      if (this.profile.pins.chainId !== 31337) await assertCircleUsdcArchiveHistory(this.client, this.profile.pins);
      const snapshot = await this.authority.snapshot(this.profile.pins.agentId), latest = await this.latest();
      await Promise.all([this.asset(snapshot.block.hash), this.asset(latest.hash), this.deployment(snapshot.block.hash), this.deployment(latest.hash)]);
      await this.authority.canonical(snapshot.block);
      if (!await this.canonical(latest)) fail('chain_canonical_history_changed');
      return snapshot;
    } catch (error) { throw error instanceof VaultIncomeClientError ? error : unavailable(); }
  }
  private async latestConsumption(payment: PaymentPayload): Promise<boolean> {
    if (!('authorization' in payment.payload)) fail('payment_terms_mismatch');
    const pins = this.profile.pins, auth = payment.payload.authorization, block = await this.latest();
    await Promise.all([this.asset(block.hash), this.deployment(block.hash)]);
    const ref = vaultIncomeAuthorizationRef(pins.chainId, pins.asset, pins.payTo, auth.from, auth.nonce);
    const [used, consumed] = await Promise.all([
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'authorizationState',
        args: [auth.from, auth.nonce], blockHash: block.hash, requireCanonical: true }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'usedIncomeAuthorization',
        args: [ref], blockHash: block.hash, requireCanonical: true }),
    ]);
    if (!await this.canonical(block)) fail('chain_canonical_history_changed');
    return used || consumed;
  }
  private async missing(hash: Hex, payment: PaymentPayload): Promise<VaultIncomeInspection> {
    if (await this.latestConsumption(payment)) fail('income_authorization_reconciliation_required');
    return { status: 'pending', transactionHash: hash };
  }
  async inspect(input: { transactionHash: Hex; payment: PaymentPayload }): Promise<VaultIncomeInspection> {
    try {
      const transactionHash = incomeHashSchema.parse(input.transactionHash), payment = await checkedPayment(input.payment, this.profile), pins = this.profile.pins;
      if (!('authorization' in payment.payload)) fail('payment_terms_mismatch');
      await this.check();
      let raw: Hex;
      try { raw = await this.client.getRawTransaction({ hash: transactionHash }); }
      catch (error) {
        if (error instanceof Error && error.name === 'TransactionNotFoundError') return await this.missing(transactionHash, payment);
        if (!(error instanceof MethodNotFoundRpcError) || error.code !== -32601) throw error;
        const value = await this.client.request({ method: 'eth_getTransactionByHash', params: [transactionHash] });
        if (value === null) return await this.missing(transactionHash, payment);
        raw = reconstructType2(value, transactionHash, pins.chainId, pins.facilitator);
      }
      if (!/^0x[0-9a-fA-F]+$/.test(raw) || raw.length > 16_384 || raw.length % 2 !== 0 || !equal(keccak256(raw), transactionHash)) fail('income_transaction_mismatch');
      const transaction = parseTransaction(raw as TransactionSerialized);
      if (transaction.chainId !== pins.chainId || !transaction.to || !equal(transaction.to, pins.payTo) || (transaction.value ?? 0n) !== 0n
        || !transaction.data || !equal(transaction.data, calldata(payment))
        || !equal(await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }), pins.facilitator)) fail('income_transaction_mismatch');
      let receipt: TransactionReceipt;
      try { receipt = await this.client.getTransactionReceipt({ hash: transactionHash }); }
      catch (error) { if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return await this.missing(transactionHash, payment); throw error; }
      if (!equal(receipt.transactionHash, transactionHash) || !equal(receipt.from, pins.facilitator) || !receipt.to || !equal(receipt.to, pins.payTo)
        || !['success', 'reverted'].includes(receipt.status)) fail('income_receipt_mismatch');
      const value = await this.client.getBlock({ blockNumber: receipt.blockNumber });
      if (!equal(value.hash, receipt.blockHash)) return await this.missing(transactionHash, payment);
      const block = incomeBlockSchema.parse({ number: value.number.toString(), hash: value.hash, timestamp: value.timestamp.toString() });
      if (!await this.canonical(block, pins.confirmations)) return { status: 'pending', transactionHash };
      await Promise.all([this.asset(block.hash), this.deployment(block.hash)]);
      if (pins.assetFacet && !await stableAssetFacetReceiptBlock(this.client, pins.asset, pins.assetFacet,
        block.hash, value.number)) fail('asset_pin_mismatch');
      if (pins.reviewedTokenKind === 'circle_proxy' && (!pins.assetImplementation
        || !await stableCircleProxyReceiptBlock(this.client, pins.asset, pins.tokenCodeHash,
          pins.assetImplementation, block.hash, value.number))) fail('asset_pin_mismatch');
      const auth = payment.payload.authorization, paymentRef = vaultIncomeAuthorizationRef(pins.chainId, pins.asset, pins.payTo, auth.from, auth.nonce);
      const [used, consumed] = await Promise.all([
        this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'authorizationState', args: [auth.from, auth.nonce], blockHash: block.hash, requireCanonical: true }),
        this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'usedIncomeAuthorization', args: [paymentRef], blockHash: block.hash, requireCanonical: true }),
      ]);
      if (receipt.status === 'reverted') {
        if (used || consumed) fail('income_authorization_reconciliation_required');
        await this.check();
        if (await this.latestConsumption(payment)) fail('income_authorization_reconciliation_required');
        return { status: await this.canonical(block, pins.confirmations) ? 'reverted' : 'pending', transactionHash };
      }
      validateVaultIncomeReceipt(receipt, payment, pins);
      if (!used || !consumed) fail('income_receipt_mismatch');
      let classification: 'income' | 'subsidy' | undefined;
      for (const log of receipt.logs) if (equal(log.address, pins.selection.selectionRegistryAddress)) {
        try { const event = decodeEventLog({ abi: selectionAbi, data: log.data, topics: log.topics });
          if (event.eventName === 'Income') classification = 'income'; else if (event.eventName === 'Subsidy') classification = 'subsidy';
        } catch { /* The validated receipt contains exactly one classification event. */ }
      }
      if (!classification) fail('income_receipt_mismatch');
      const gross = BigInt(auth.value), fee = classification === 'income' ? (gross * 100n + 9_999n) / 10_000n : 0n;
      await this.check();
      if (!await this.canonical(block, pins.confirmations)) return { status: 'pending', transactionHash };
      return { status: 'settled', transactionHash, block, classification, grossAmount: gross.toString(), incomeFee: fee.toString(),
        netAmount: (gross - fee).toString(), paymentRef, payer: auth.from as Address };
    } catch (error) { throw error instanceof VaultIncomeClientError ? error : unavailable(); }
  }
}
