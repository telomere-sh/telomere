import { encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, hashJson } from '../common.js';
import { incomeStrictJson } from '../selection/income-endpoints/json.js';
import { golemAmountToBaseUnits, golemOriginalRunSchema } from './golem-finance-types.js';
import { parseGolemFinanceWirePayment } from './golem-finance-http.js';

/** Official Yagna c256fce config; an address is not approval of proxy code/history. */
export const GOLEM_POLYGON_GLM = addressSchema.parse('0x0B220b82F3eA3B7F6d9A1D8ab58930C064A2b5Bf');
export const golemPaymentChainPolicySchema = z.object({ version: z.literal(1),
  mode: z.literal('direct-erc20-observation-v1'), chainId: z.union([z.literal(137), z.literal(31337)]),
  tokenAddress: addressSchema.refine(value => !/^0x0{40}$/i.test(value)), tokenRuntimeCodeHash: bytes32Schema,
  tokenDecimals: z.literal(18), minimumConfirmations: z.number().int().min(1).max(1024),
  rpcUrl: z.string().url().max(2048), timeoutMs: z.number().int().min(100).max(30_000),
  maxResponseBytes: z.number().int().min(4096).max(524_288),
}).strict().superRefine((value, context) => {
  if (value.chainId === 137 && value.tokenAddress !== GOLEM_POLYGON_GLM)
    context.addIssue({ code: 'custom', message: 'Canonical Polygon GLM address required' });
});
export type GolemPaymentChainPolicy = z.infer<typeof golemPaymentChainPolicySchema>;
const bindingSchema = golemOriginalRunSchema.omit({ active: true, asOfMs: true });
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/);
const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(262_146).transform(value => value.toLowerCase() as Hex);
const logSchema = z.object({ address: addressSchema, topics: z.array(bytes32Schema).max(4), data: hex,
  blockHash: bytes32Schema, blockNumber: quantity, transactionHash: bytes32Schema,
  transactionIndex: quantity, logIndex: quantity, removed: z.literal(false) });
const receiptSchema = z.object({ transactionHash: bytes32Schema, transactionIndex: quantity,
  blockHash: bytes32Schema, blockNumber: quantity, from: addressSchema, to: addressSchema,
  status: z.enum(['0x0', '0x1']), logs: z.array(logSchema).max(128) });
const transactionSchema = z.object({ hash: bytes32Schema, from: addressSchema, to: addressSchema,
  blockHash: bytes32Schema, blockNumber: quantity, transactionIndex: quantity,
  chainId: quantity, value: quantity, input: hex });
const blockSchema = z.object({ hash: bytes32Schema, number: quantity,
  transactions: z.array(bytes32Schema).max(4096) });
const transferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddress = (address: string) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();

/** Pinned Yagna uses standard base64 of the raw32-byte hash, not hex/JSON. */
export function decodeGolemPaymentTransactionHash(details: unknown): Hex {
  if (typeof details !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(details)) throw new Error('Unsupported Golem payment details');
  const bytes = Buffer.from(details, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== details) throw new Error('Unsupported Golem payment details');
  return bytes32Schema.parse('0x' + bytes.toString('hex'));
}

/** Stable across canonical block/log-index changes. This mode accepts exactly
 * one GLM Transfer in the entire transaction. A ledger must persist this reference
 * globally across payment IDs; observing it does not consume it. */
export function golemDirectSettlementReference(chainId: number, tokenAddress: string, transactionHash: string): Hex {
  return hashJson({ domain: 'telomere.golem.direct-erc20-settlement.v1', chainId: z.union([z.literal(137), z.literal(31337)]).parse(chainId),
    tokenAddress: addressSchema.parse(tokenAddress).toLowerCase(), transactionHash: bytes32Schema.parse(transactionHash) });
}

const observationBoundary = { observationOnly: true, settlementAuthorityEligible: false,
  allocationAttribution: 'not-established' } as const;
export type GolemPaymentChainObservation = typeof observationBoundary & ({ state: 'unconfirmed';
  reason: 'missing' | 'nonfinal' | 'reverted' | 'unsupported' | 'changed'; transactionHash: Hex;
} | { state: 'observed'; transactionHash: Hex; settlementReference: Hex; paymentHash: Hex; bindingHash: Hex;
  chainId: 137 | 31337; tokenAddress: Hex; tokenRuntimeCodeHash: Hex; amountBaseUnits: string;
  blockNumber: string; blockHash: Hex; confirmations: number; proofHash: Hex; asOfMs: number });

/** Read-only trusted-RPC observations, never a production settlement authority.
 * In particular Polygon's proxy implementation/storage and historical deployment
 * provenance are NOT established by an outer runtime-code hash. No API is mounted
 * and no GolemFinanceAuthorities implementation is implicitly created here. */
export class GolemPaymentChainObserver {
  readonly policy: Readonly<GolemPaymentChainPolicy>;
  readonly observationOnly = true;
  readonly settlementAuthorityEligible = false;
  constructor(policy: GolemPaymentChainPolicy, private readonly fetchImpl: typeof fetch = fetch) {
    this.policy = Object.freeze(golemPaymentChainPolicySchema.parse(policy));
    const url = new URL(this.policy.rpcUrl);
    if (url.username || url.password || url.hash || url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      throw new Error('Reviewed Golem read-only RPC transport required');
  }
  async observe(bindingInput: unknown, paymentInput: unknown, callerSignal: AbortSignal): Promise<GolemPaymentChainObservation> {
    const binding = bindingSchema.parse(bindingInput), payment = parseGolemFinanceWirePayment(paymentInput);
    const transactionHash = decodeGolemPaymentTransactionHash(payment.details), amount = golemAmountToBaseUnits(payment.amount);
    if (payment.payerId !== binding.requestorId || payment.payeeId !== binding.providerId
      || payment.payerAddr !== binding.payerAddr || payment.payeeAddr !== binding.payeeAddr
      || payment.paymentPlatform !== binding.paymentPlatform || amount === 0n)
      throw new Error('Golem payment original parties differ');
    // This narrow observation cannot attribute a mixed agreement/activity batch.
    // Even a supplied allocation ID is only an API claim, never its authority.
    const shares = [...payment.agreementPayments.map(share => ({ ...share, matches: share.agreementId === binding.agreementId })),
      ...payment.activityPayments.map(share => ({ ...share, matches: share.activityId === binding.activityId }))];
    if (shares.length !== 1 || shares.some(share => !share.matches || golemAmountToBaseUnits(share.amount) !== amount
      || share.allocationId != null && share.allocationId !== binding.allocationId)) throw new Error('Golem payment original scope differs');
    if (!(callerSignal instanceof AbortSignal)) throw new Error('Golem observation cancellation signal required');
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.policy.timeoutMs)]);
    signal.throwIfAborted();
    const bounded = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('Golem observation cancelled')); };
      signal.addEventListener('abort', aborted, { once: true });
      void work.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => {
        signal.removeEventListener('abort', aborted); reject(error);
      });
      if (signal.aborted) aborted();
    });
    const checked = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
      const result = schema.safeParse(value);
      if (!result.success) throw new Error('Golem RPC observation shape unsupported'); return result.data;
    };
    let requestId = 0;
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      const id = ++requestId;
      try {
        signal.throwIfAborted();
        const response = await bounded(this.fetchImpl(this.policy.rpcUrl, { method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(value => {
          if (signal.aborted) void value.body?.cancel().catch(() => undefined); return value;
        }));
        if (!response.ok || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') || !response.body
          || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
          void response.body?.cancel().catch(() => undefined); throw new Error('Unavailable');
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^[0-9]+$/.test(declared) || BigInt(declared) > BigInt(this.policy.maxResponseBytes))) {
          void response.body.cancel().catch(() => undefined); throw new Error('Bound');
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) {
          signal.throwIfAborted(); const part = await bounded(reader.read()); signal.throwIfAborted(); if (part.done) break;
          size += part.value.length; if (size > this.policy.maxResponseBytes) throw new Error('Bound'); chunks.push(part.value);
        } } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
        const value = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(id), result: z.unknown() }).strict()
          .parse(incomeStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
        if (!Object.hasOwn(value, 'result')) throw new Error('Missing result');
        signal.throwIfAborted(); return value.result;
      } catch { throw new Error('Golem read-only RPC observation unavailable'); }
    };
    const unconfirmed = (reason: Extract<GolemPaymentChainObservation, { state: 'unconfirmed' }>['reason']): GolemPaymentChainObservation =>
      ({ ...observationBoundary, state: 'unconfirmed', reason, transactionHash });
    if (BigInt(checked(quantity, await rpc('eth_chainId', []))) !== BigInt(this.policy.chainId)) throw new Error('Golem payment RPC chain differs');
    const firstRaw = await rpc('eth_getTransactionReceipt', [transactionHash]);
    if (firstRaw === null) return unconfirmed('missing');
    const receipt = checked(receiptSchema, firstRaw);
    if (receipt.status !== '0x1') return unconfirmed('reverted');
    const txRaw = await rpc('eth_getTransactionByHash', [transactionHash]);
    if (txRaw === null) return unconfirmed('missing');
    const tx = checked(transactionSchema, txRaw), blockNumber = BigInt(receipt.blockNumber);
    const calldata = encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [payment.payeeAddr, amount] });
    const transfers = receipt.logs.filter(log => log.address === this.policy.tokenAddress && log.topics[0] === transferTopic);
    const transfer = transfers[0];
    if (tx.hash !== transactionHash || receipt.transactionHash !== transactionHash || tx.from !== payment.payerAddr
      || receipt.from !== payment.payerAddr || tx.to !== this.policy.tokenAddress || receipt.to !== this.policy.tokenAddress
      || tx.value !== '0x0' || BigInt(tx.chainId) !== BigInt(this.policy.chainId) || tx.input !== calldata.toLowerCase()
      || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || tx.transactionIndex !== receipt.transactionIndex
      || transfers.length !== 1 || !transfer || transfer.topics.length !== 3 || transfer.topics[1] !== topicAddress(payment.payerAddr)
      || transfer.topics[2] !== topicAddress(payment.payeeAddr) || transfer.data !== '0x' + amount.toString(16).padStart(64, '0')
      || receipt.logs.some(log => log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber
        || log.transactionHash !== transactionHash || log.transactionIndex !== receipt.transactionIndex)) return unconfirmed('unsupported');
    const block = checked(blockSchema, await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]));
    const included = (value: z.infer<typeof blockSchema>) => value.hash === receipt.blockHash && value.number === receipt.blockNumber
      && value.transactions.filter(hash => hash === transactionHash).length === 1
      && value.transactions[Number(BigInt(receipt.transactionIndex))] === transactionHash;
    if (!included(block)) return unconfirmed('changed');
    const historicalBlock = { blockHash: receipt.blockHash, requireCanonical: true };
    const code = checked(hex, await rpc('eth_getCode', [this.policy.tokenAddress, historicalBlock]));
    if (code === '0x' || keccak256(code) !== this.policy.tokenRuntimeCodeHash) return unconfirmed('unsupported');
    const decimals = checked(hex, await rpc('eth_call', [{ to: this.policy.tokenAddress, data: '0x313ce567' }, historicalBlock]));
    if (decimals !== '0x' + '12'.padStart(64, '0')) return unconfirmed('unsupported');
    const head = checked(blockSchema, await rpc('eth_getBlockByNumber', ['latest', false]));
    if (BigInt(head.number) < blockNumber || BigInt(head.number) - blockNumber + 1n < BigInt(this.policy.minimumConfirmations)) return unconfirmed('nonfinal');
    const currentCode = checked(hex, await rpc('eth_getCode', [this.policy.tokenAddress, { blockHash: head.hash, requireCanonical: true }]));
    if (keccak256(currentCode) !== this.policy.tokenRuntimeCodeHash) return unconfirmed('unsupported');
    // No retries: a changed/missing receipt is an explicit uncertainty. These
    // final observations catch a reorg during awaited historical/code reads.
    const lastRaw = await rpc('eth_getTransactionReceipt', [transactionHash]);
    if (lastRaw === null) return unconfirmed('changed');
    const last = checked(receiptSchema, lastRaw), lastBlock = checked(blockSchema, await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]));
    const lastHead = checked(blockSchema, await rpc('eth_getBlockByNumber', ['latest', false]));
    if (hashJson(last) !== hashJson(receipt) || !included(lastBlock) || BigInt(lastHead.number) < BigInt(head.number)) return unconfirmed('changed');
    const confirmations = BigInt(lastHead.number) - blockNumber + 1n;
    if (confirmations < BigInt(this.policy.minimumConfirmations) || confirmations > 1_000_000n) return unconfirmed('nonfinal');
    signal.throwIfAborted();
    const facts = { transactionHash, settlementReference: golemDirectSettlementReference(this.policy.chainId, this.policy.tokenAddress, transactionHash),
      paymentHash: hashJson(payment), bindingHash: hashJson(binding), chainId: this.policy.chainId, tokenAddress: this.policy.tokenAddress,
      tokenRuntimeCodeHash: this.policy.tokenRuntimeCodeHash, amountBaseUnits: amount.toString(), blockNumber: blockNumber.toString(),
      blockHash: receipt.blockHash, confirmations: Number(confirmations) };
    return { ...observationBoundary, state: 'observed', ...facts, proofHash: hashJson({ domain: 'telomere.golem.direct-erc20-observation.v1',
      policy: { ...this.policy, rpcUrl: undefined }, ...facts, receipt, blockHash: block.hash, headHash: lastHead.hash }), asOfMs: Date.now() };
  }
}
