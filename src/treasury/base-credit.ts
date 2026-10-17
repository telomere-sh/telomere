import { createPublicClient, decodeEventLog, domainSeparator, encodeFunctionData, http, keccak256, parseAbi, parseTransaction,
  recoverTransactionAddress, recoverTypedDataAddress, type Address, type Hex, type TransactionSerialized } from 'viem';
import { EIP3009_TYPES } from '../payments/gateway.js';
import { assertCircleUsdcArchiveHistory } from '../payments/circle-usdc-archive.js';
import { matchesCircleProxyPins, matchesNativeBaseUsdcMetadata, stableCircleProxyReceiptBlock } from '../payments/circle-usdc.js';
import { validateVaultIncomeReceipt, vaultIncomeAuthorizationRef, type VaultIncomePins } from '../payments/vault-income-chain.js';
import { vaultIncomeRpcFetch } from '../payments/vault-income-rpc.js';
import type { PaymentPayload } from '../payments/protocol.js';
import { RpcIncomeEndpointReader } from '../selection/income-endpoints/reader.js';
import { Problem, sameAddress } from '../common.js';
import type { TopUpAuthorization, TopUpProfile, TopUpRecord } from './types.js';

const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)',
  'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function authorizationState(address,bytes32) view returns(bool)']);
const vaultAbi = parseAbi(['function receiveFundsWithAuthorization(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
  'function usedIncomeAuthorization(bytes32) view returns(bool)', 'function treasury() view returns(address)',
  'function managedExposure() view returns(uint256)', 'function MAX_MANAGED_EXPOSURE() view returns(uint256)',
  'event FundsReceived(address indexed source,uint96 grossAmount,uint96 incomeFee,bytes32 paymentRef)']);
const subsidyAbi = parseAbi(['event Subsidy(bytes32 indexed agentId,uint96 amount,address indexed source,bytes32 paymentRef)',
  'function treasury() view returns(address)', 'function controller() view returns(address)']);
export type BaseCreditInspection = { state: 'pending' | 'credited' | 'reverted'; blockHash?: Hex; blockNumber?: string };
export interface BaseTopUpPort {
  check(owner?: string): Promise<{ owner: Address; timestamp: number; balanceMicros: string; vaultCapacityMicros: string }>;
  validateAuthorization(record: TopUpRecord, signature: Hex): Promise<{ to: Hex; data: Hex }>;
  validateTransaction(record: TopUpRecord, raw: TransactionSerialized): Promise<{ hash: Hex; nonce: number }>;
  broadcast(record: TopUpRecord): Promise<void>;
  inspect(record: TopUpRecord): Promise<BaseCreditInspection>;
}
function typedAuthorization(value: TopUpAuthorization) {
  return { ...value, value: BigInt(value.value), validAfter: BigInt(value.validAfter), validBefore: BigInt(value.validBefore) };
}
function incomePins(profile: TopUpProfile): VaultIncomePins {
  const { assetImplementation, assetFacet, ...pins } = profile.base;
  return { ...pins, ...(assetImplementation ? { assetImplementation } : {}), ...(assetFacet ? { assetFacet } : {}) };
}
function payment(record: TopUpRecord, profile: TopUpProfile): PaymentPayload {
  const authorization = record.authorization, signature = record.signature;
  if (!authorization || !signature) throw new Error('Treasury authorization is unavailable');
  return { x402Version: 2, resource: { url: 'https://topup.invalid/treasury-credit' },
    accepted: { scheme: 'exact', network: `eip155:${profile.base.chainId}`, asset: profile.base.asset,
      amount: record.amountMicros, payTo: record.vault, maxTimeoutSeconds: profile.authorizationSeconds,
      extra: { assetTransferMethod: 'eip3009', facilitatorAddress: profile.base.facilitator,
        name: profile.base.exact.name, version: profile.base.exact.version,
        telomere: { challengeId: '00000000-0000-4000-8000-000000000001', nonce: authorization.nonce, requestHash: record.id } } },
    payload: { signature, authorization: { ...authorization, validAfter: String(authorization.validAfter), validBefore: String(authorization.validBefore) } } };
}

/** Pinned read-only Base verifier and exact signed-byte relay. It holds no key
 * and never prepares or signs an EVM transaction or treasury authorization. */
export class BaseTopUpCredit implements BaseTopUpPort {
  readonly client;
  private readonly authority: RpcIncomeEndpointReader;
  constructor(readonly profile: TopUpProfile, rpcUrl: string) {
    this.client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10_000, fetchFn: vaultIncomeRpcFetch }), cacheTime: 0 });
    this.authority = new RpcIncomeEndpointReader({ rpcUrl, pins: profile.base.selection, asset: profile.base.asset });
  }
  private async asset(blockHash: Hex): Promise<void> {
    const pins = this.profile.base, state = { blockHash, requireCanonical: true } as const;
    const [code, decimals, separator] = await Promise.all([
      this.client.getCode({ address: pins.asset, ...state }),
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'decimals', ...state }),
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
    ]);
    if (!code || keccak256(code) !== pins.tokenCodeHash || decimals !== 6 || separator !== domainSeparator({
      domain: { name: pins.exact.name, version: pins.exact.version, chainId: pins.chainId, verifyingContract: pins.asset } })) throw new Error('Reviewed top-up asset differs');
    if (!this.profile.localFixture && (!pins.assetImplementation || !await matchesCircleProxyPins(this.client, pins.asset, pins.assetImplementation, state)
      || !await matchesNativeBaseUsdcMetadata(this.client, pins.chainId, pins.asset, state))) throw new Error('Reviewed native USDC implementation differs');
    if (this.profile.localFixture && pins.reviewedTokenKind !== 'immutable') throw new Error('Top-up local fixture must use an immutable token');
  }
  async initialize(): Promise<void> {
    if (!this.profile.localFixture) await assertCircleUsdcArchiveHistory(this.client, incomePins(this.profile));
    await this.check();
  }
  async check(owner?: string) {
    const pins = this.profile.base, snapshot = await this.authority.snapshot(pins.agentId);
    const state = { blockHash: snapshot.block.hash, requireCanonical: true } as const;
    if (!sameAddress(snapshot.binding.vault, pins.payTo) || ![1, 2].includes(snapshot.binding.status)
      || owner !== undefined && !sameAddress(owner, snapshot.binding.owner)) throw new Error('Top-up owner or registered Vault differs');
    const head = await this.client.getBlock({ blockTag: 'latest' });
    const [treasury, controller, treasuryCode, relayerCode, balance, confirmedBalance, exposure, confirmedExposure, exposureCap] = await Promise.all([
      this.client.readContract({ address: pins.selection.selectionRegistryAddress, abi: subsidyAbi, functionName: 'treasury', ...state }),
      this.client.readContract({ address: pins.selection.selectionRegistryAddress, abi: subsidyAbi, functionName: 'controller', ...state }),
      this.client.getCode({ address: pins.treasury, ...state }), this.client.getCode({ address: pins.facilitator, ...state }),
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'balanceOf', args: [pins.treasury], blockHash: head.hash, requireCanonical: true }),
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'balanceOf', args: [pins.treasury], ...state }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'managedExposure', blockHash: head.hash, requireCanonical: true }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'managedExposure', ...state }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'MAX_MANAGED_EXPOSURE', ...state }),
    ]);
    if (!sameAddress(treasury, pins.treasury) || treasuryCode && treasuryCode !== '0x' || relayerCode && relayerCode !== '0x'
      || [pins.treasury, controller, snapshot.binding.owner, snapshot.binding.agentWallet].some(address => sameAddress(address, pins.facilitator))) {
      throw new Error('Top-up requires a dedicated distinct pinned EOA relayer');
    }
    await this.asset(snapshot.block.hash); await this.asset(head.hash); await this.authority.canonical(snapshot.block);
    if ((await this.client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Base inventory anchor changed');
    if (head.timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Base block timestamp is outside its bound');
    const conservativeExposure = exposure > confirmedExposure ? exposure : confirmedExposure;
    return { owner: snapshot.binding.owner, timestamp: Number(head.timestamp), balanceMicros: (balance < confirmedBalance ? balance : confirmedBalance).toString(),
      vaultCapacityMicros: (conservativeExposure >= exposureCap ? 0n : exposureCap - conservativeExposure).toString() };
  }
  async validateAuthorization(record: TopUpRecord, signature: Hex): Promise<{ to: Hex; data: Hex }> {
    const auth = record.authorization, pins = this.profile.base;
    if (!auth || !record.source || auth.from !== pins.treasury || auth.to !== pins.payTo || auth.value !== record.amountMicros) throw new Error('Original treasury authorization differs');
    const observed = await this.check(record.owner);
    if (observed.timestamp <= auth.validAfter || observed.timestamp >= auth.validBefore || BigInt(observed.balanceMicros) < BigInt(record.amountMicros)) throw new Error('Treasury authorization expired or inventory unavailable');
    const signer = await recoverTypedDataAddress({ domain: { name: pins.exact.name, version: pins.exact.version,
      chainId: pins.chainId, verifyingContract: pins.asset }, types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization', message: typedAuthorization(auth), signature });
    if (!sameAddress(signer, pins.treasury)) throw new Error('Authorization is not signed by the pinned treasury');
    const ref = vaultIncomeAuthorizationRef(pins.chainId, pins.asset, pins.payTo, pins.treasury, auth.nonce);
    const [used, consumed] = await Promise.all([
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'authorizationState', args: [pins.treasury, auth.nonce] }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'usedIncomeAuthorization', args: [ref] }),
    ]);
    if (used || consumed) throw new Problem(409, used && !consumed ? 'topup_authorization_consumed_unclassified' : 'topup_authorization_already_used',
      'The original treasury authorization requires canonical reconciliation; keep its source and inventory reservation.');
    const vByte = Number.parseInt(signature.slice(130), 16);
    const data = encodeFunctionData({ abi: vaultAbi, functionName: 'receiveFundsWithAuthorization', args: [auth.from, BigInt(auth.value),
      BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, vByte < 27 ? vByte + 27 : vByte,
      `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`] });
    await this.client.call({ account: pins.facilitator, to: pins.payTo, data });
    return { to: pins.payTo, data };
  }
  async validateTransaction(record: TopUpRecord, raw: TransactionSerialized) {
    if (!record.signature) throw new Error('Original treasury signature is unavailable');
    const exact = await this.validateAuthorization(record, record.signature), transaction = parseTransaction(raw), pins = this.profile.base;
    if (transaction.type !== 'eip1559' || transaction.chainId !== pins.chainId || !transaction.to || !sameAddress(transaction.to, exact.to) || transaction.data !== exact.data
      || (transaction.value ?? 0n) !== 0n || transaction.nonce === undefined || !Number.isSafeInteger(transaction.nonce)
      || transaction.gas === undefined || transaction.gas > BigInt(this.profile.maxRelayerGas)
      || transaction.maxFeePerGas === undefined || transaction.maxFeePerGas > BigInt(this.profile.maxRelayerFeePerGas)
      || transaction.maxPriorityFeePerGas !== undefined && transaction.maxPriorityFeePerGas > BigInt(this.profile.maxRelayerFeePerGas)
      || !sameAddress(await recoverTransactionAddress({ serializedTransaction: raw }), pins.facilitator)) throw new Error('Signed top-up transaction exceeds its exact relay plan');
    const [pending, mined] = await Promise.all([
      this.client.getTransactionCount({ address: pins.facilitator, blockTag: 'pending' }),
      this.client.getTransactionCount({ address: pins.facilitator, blockTag: 'latest' }),
    ]);
    if (transaction.nonce !== pending || pending !== mined) throw new Error('Relayer nonce has unresolved external transactions');
    await this.client.call({ account: pins.facilitator, to: pins.payTo, data: exact.data, gas: transaction.gas });
    return { hash: keccak256(raw), nonce: transaction.nonce };
  }
  async broadcast(record: TopUpRecord): Promise<void> {
    if (!record.rawTransaction || !record.transactionHash || !this.profile.broadcastEnabled) throw new Error('Top-up signed relay is disabled');
    // REASON: transaction bytes were bounded and decoded before their durable claim.
    const hash = await this.client.sendRawTransaction({ serializedTransaction: record.rawTransaction as TransactionSerialized });
    if (hash !== record.transactionHash) throw new Error('Top-up relay response changed its original transaction');
  }
  async inspect(record: TopUpRecord): Promise<BaseCreditInspection> {
    if (!record.transactionHash || !record.rawTransaction || !record.authorization || !record.signature) throw new Error('Original prepared top-up credit is unavailable');
    const pins = this.profile.base;
    await this.check(record.owner);
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: record.transactionHash }); }
    catch (error) { if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return { state: 'pending' }; throw error; }
    if (receipt.transactionHash !== record.transactionHash || !sameAddress(receipt.from, pins.facilitator)
      || !receipt.to || !sameAddress(receipt.to, pins.payTo)) throw new Error('Top-up receipt identity differs');
    const [block, head] = await Promise.all([this.client.getBlock({ blockNumber: receipt.blockNumber }), this.client.getBlockNumber({ cacheTime: 0 })]);
    if (block.hash !== receipt.blockHash || head < receipt.blockNumber || head - receipt.blockNumber + 1n < BigInt(pins.confirmations)) return { state: 'pending' };
    await this.asset(receipt.blockHash);
    if (!this.profile.localFixture && (!pins.assetImplementation || !await stableCircleProxyReceiptBlock(this.client, pins.asset, pins.tokenCodeHash,
      pins.assetImplementation, receipt.blockHash, receipt.blockNumber))) throw new Error('Top-up receipt asset upgraded');
    const state = { blockHash: receipt.blockHash, requireCanonical: true } as const;
    const ref = vaultIncomeAuthorizationRef(pins.chainId, pins.asset, pins.payTo, pins.treasury, record.authorization.nonce);
    const [used, consumed, vaultCode, registryCode, implementationCode, historicalTreasury] = await Promise.all([
      this.client.readContract({ address: pins.asset, abi: tokenAbi, functionName: 'authorizationState', args: [pins.treasury, record.authorization.nonce], ...state }),
      this.client.readContract({ address: pins.payTo, abi: vaultAbi, functionName: 'usedIncomeAuthorization', args: [ref], ...state }),
      this.client.getCode({ address: pins.payTo, ...state }), this.client.getCode({ address: pins.selection.selectionRegistryAddress, ...state }),
      this.client.getCode({ address: pins.selection.vaultImplementationAddress, ...state }),
      this.client.readContract({ address: pins.selection.selectionRegistryAddress, abi: subsidyAbi, functionName: 'treasury', ...state }),
    ]);
    if (receipt.status === 'reverted') {
      if (used || consumed) throw new Error('Treasury authorization requires reconciliation');
      return { state: 'reverted' };
    }
    if (!used || !consumed || !vaultCode || vaultCode.toLowerCase() !== `0x363d3d373d3d3d363d73${pins.selection.vaultImplementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`.toLowerCase()
      || !registryCode || keccak256(registryCode) !== pins.selection.selectionRegistryCodeHash
      || !implementationCode || keccak256(implementationCode) !== pins.selection.vaultImplementationCodeHash
      || !sameAddress(historicalTreasury, pins.treasury)) throw new Error('Top-up historical Vault/treasury binding differs');
    validateVaultIncomeReceipt(receipt, payment(record, this.profile), incomePins(this.profile));
    const subsidies = receipt.logs.filter(log => sameAddress(log.address, pins.selection.selectionRegistryAddress)).flatMap(log => {
      try { const event = decodeEventLog({ abi: subsidyAbi, data: log.data, topics: log.topics }); return event.eventName === 'Subsidy' ? [event.args] : []; }
      catch { return []; }
    });
    if (subsidies.length !== 1 || !subsidies[0] || subsidies[0].agentId !== pins.agentId || !sameAddress(subsidies[0].source, pins.treasury)
      || subsidies[0].amount !== BigInt(record.amountMicros) || subsidies[0].paymentRef !== ref) throw new Error('Top-up must classify as one exact treasury Subsidy');
    if ((await this.client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) return { state: 'pending' };
    return { state: 'credited', blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString() };
  }
}
