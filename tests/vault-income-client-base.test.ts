import { beforeEach, describe, expect, it, vi } from 'vitest';
import { domainSeparator, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, keccak256,
  padHex, parseAbi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseMainnetUsdc, baseSepoliaUsdc } from '../src/chain/chains.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT } from '../src/payments/circle-usdc.js';
import { digest, encodePaymentHeader, requestBinding } from '../src/payments/protocol.js';
import { vaultIncomeAuthorizationRef } from '../src/payments/vault-income-chain.js';
import { VaultIncomeClient } from '../src/sdk/vault-income/client.js';
import { vaultIncomePayment, vaultIncomeTypedData } from '../src/sdk/vault-income/integrity.js';
import { RpcVaultIncomeReader } from '../src/sdk/vault-income/reader.js';
import { vaultIncomePlanSchema, type VaultIncomeJournal, type VaultIncomeJournalState,
  type VaultIncomePublicProfile } from '../src/sdk/vault-income/types.js';

const hooks = vi.hoisted(() => ({ client: undefined as unknown, snapshot: undefined as unknown,
  create: vi.fn(), canonical: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(),
  createPublicClient: (...args: unknown[]) => { hooks.create(...args); return hooks.client; } }));
// REASON: This suite isolates asset verification from the independently tested Selection RPC reader.
vi.mock('../src/selection/income-endpoints/reader.js', () => ({ RpcIncomeEndpointReader: class {
  async snapshot() { return hooks.snapshot; }
  async canonical(...args: unknown[]) { hooks.canonical(...args); }
} }));

const payer = privateKeyToAccount(`0x${'11'.repeat(32)}`), facilitator = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`);
const tokenImpl = address('1'), registry = address('2'), vaultImpl = address('3'), vault = address('4'),
  owner = address('5'), wallet = address('6'), controller = address('7'), treasury = address('8'), escrow = address('9');
const hash = (number: bigint | number) => padHex(`0x${number.toString(16)}`, { size: 32 });
const proxyCode = '0x60016000' as Hex, implCode = '0x60026000' as Hex,
  registryCode = '0x60036000' as Hex, vaultImplCode = '0x60046000' as Hex;
const resourceUrl = 'https://income.example/x402/vault-income';
const vaultAbi = parseAbi(['function receiveFundsWithAuthorization(address from,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'event FundsReceived(address indexed source,uint96 grossAmount,uint96 incomeFee,bytes32 paymentRef)']);
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const registryAbi = parseAbi(['event Income(bytes32 indexed agentId,uint96 amount,uint96 fee,address indexed source,bytes32 paymentRef)']);

function profile(chainId: 8453 | 84532 = 84532): VaultIncomePublicProfile {
  return { resourceUrl, grossAmount: '101', pins: { chainId, asset: chainId === 8453 ? baseMainnetUsdc : baseSepoliaUsdc,
    tokenCodeHash: keccak256(proxyCode), payTo: vault, facilitator: facilitator.address, reviewedTokenKind: 'circle_proxy',
    assetImplementation: { address: tokenImpl, codeHash: keccak256(implCode) },
    archiveAnchor: { number: '100', hash: hash(100), timestamp: '1000' }, confirmations: 1,
    exact: { reviewedEip3009: true, name: chainId === 8453 ? 'USD Coin' : 'USDC', version: '2' },
    selection: { chainId, selectionRegistryAddress: registry, selectionRegistryCodeHash: keccak256(registryCode),
      vaultImplementationAddress: vaultImpl, vaultImplementationCodeHash: keccak256(vaultImplCode), confirmations: 1 },
    agentId: hash(10), treasury } };
}

function rpc(value: VaultIncomePublicProfile) {
  const pins = value.pins;
  const fault = { block: undefined as Hex | undefined, field: '' as string, upgraded: false, tooYoung: false };
  const getBlock = vi.fn(async (request: { blockNumber?: bigint; blockTag?: string }) => {
    const number = request.blockNumber ?? 200n;
    return { number, hash: hash(number), timestamp: number === 100n ? 1000n
      : number === 199n ? 29_998n : number === 200n ? fault.tooYoung ? 20_000n : 30_000n : 25_000n };
  });
  const getCode = vi.fn(async (request: { address: Address; blockHash: Hex; requireCanonical: boolean }) => {
    if (request.blockHash === fault.block && fault.field === 'code') return '0x6000';
    if (request.address === pins.asset) return proxyCode;
    if (request.address === tokenImpl) return request.blockHash === fault.block && fault.field === 'implementation' ? '0x6000' : implCode;
    if (request.address === registry) return registryCode;
    if (request.address === vaultImpl) return vaultImplCode;
    if (request.address === vault) return `0x363d3d373d3d3d363d73${vaultImpl.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    if (request.address === facilitator.address) return '0x';
    throw new Error('Unexpected code address');
  });
  const getStorageAt = vi.fn(async (request: { slot: Hex; blockHash: Hex }) => {
    if (request.slot !== CIRCLE_PROXY_IMPLEMENTATION_SLOT) throw new Error('Unexpected proxy slot');
    return padHex(request.blockHash === fault.block && fault.field === 'pointer' ? escrow : tokenImpl, { size: 32 });
  });
  const readContract = vi.fn(async (request: { functionName: string; blockHash: Hex }) => {
    switch (request.functionName) {
      case 'name': return request.blockHash === fault.block && fault.field === 'metadata' ? 'Global Dollar' : pins.exact.name;
      case 'symbol': return 'USDC';
      case 'version': return '2';
      case 'decimals': return 6;
      case 'DOMAIN_SEPARATOR': return request.blockHash === fault.block && fault.field === 'domain' ? hash(999)
        : domainSeparator({ domain: { name: pins.exact.name, version: '2', chainId: pins.chainId, verifyingContract: pins.asset } });
      case 'getAgent': return { status: 1, vault, owner, agentWallet: wallet };
      case 'token': return pins.asset;
      case 'escrow': return escrow;
      case 'controller': return controller;
      case 'treasury': return treasury;
      case 'vaultImplementation': return vaultImpl;
      case 'registry': return registry;
      case 'agentWalletAgent': case 'vaultAgent': case 'agentId': return pins.agentId;
      case 'owner': return owner;
      case 'agentWallet': return wallet;
      case 'authorizationState': case 'usedIncomeAuthorization': return true;
      default: throw new Error('Unexpected contract function');
    }
  });
  const getLogs = vi.fn(async (request: { blockHash: Hex }) => fault.upgraded && request.blockHash === hash(150)
    ? [{ transactionHash: hash(77) }] : []);
  const getRawTransaction = vi.fn<() => Promise<Hex>>(), getTransactionReceipt = vi.fn<() => Promise<TransactionReceipt>>();
  hooks.client = { getChainId: vi.fn(async () => pins.chainId), getBlockNumber: vi.fn(async () => 200n), getBlock,
    getCode, getStorageAt, readContract, getLogs, getRawTransaction, getTransactionReceipt };
  hooks.snapshot = { binding: { agentId: pins.agentId, owner, agentWallet: wallet, vault, status: 1, frozen: false },
    block: { number: '199', hash: hash(199), timestamp: '29998' } };
  return { fault, getCode, getStorageAt, readContract, getLogs, getRawTransaction, getTransactionReceipt };
}

function journal(): VaultIncomeJournal {
  let state: VaultIncomeJournalState | undefined;
  return { async exclusive(_scope, callback) { return callback({ load: async () => structuredClone(state),
    save: async value => { state = structuredClone(value); } }); } };
}
function offer(value: VaultIncomePublicProfile) {
  const nonce = hash(42), requestHash = requestBinding('POST', resourceUrl, Buffer.from('{}'));
  return { x402Version: 2, resource: { url: resourceUrl }, accepts: [{ scheme: 'exact', network: `eip155:${value.pins.chainId}`,
    asset: value.pins.asset, amount: '101', payTo: vault, maxTimeoutSeconds: 300,
    extra: { name: value.pins.exact.name, version: '2', assetTransferMethod: 'eip3009', facilitatorAddress: facilitator.address,
      telomere: { challengeId: 'b693f8ea-a6e2-4e2f-a66f-5c392ec4cd75', nonce, requestHash } } }],
    extensions: { 'telomere-request-binding': { version: 1, requestHash } } };
}

async function paidEvidence(value: VaultIncomePublicProfile) {
  const accepted = offer(value).accepts[0]!;
  const plan = vaultIncomePlanSchema.parse({ operationId: 'receipt', profileHash: digest(value), resource: { url: resourceUrl }, accepted,
    authorization: { from: payer.address, to: vault, value: '101', validAfter: '24999', validBefore: '25119', nonce: hash(42) } });
  const signature = await payer.signTypedData(vaultIncomeTypedData(plan, value)), payment = vaultIncomePayment(plan, signature);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  const data = encodeFunctionData({ abi: vaultAbi, functionName: 'receiveFundsWithAuthorization', args: [payer.address, 101n,
    24999n, 25119n, hash(42), v < 27 ? v + 27 : v, `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`] });
  const raw = await facilitator.signTransaction({ chainId: value.pins.chainId, to: vault, data,
    nonce: 0, gas: 200_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
  const transactionHash = keccak256(raw), paymentRef = vaultIncomeAuthorizationRef(value.pins.chainId, value.pins.asset, vault, payer.address, hash(42));
  const log = (address: Address, topics: readonly (Hex | Hex[] | null)[], data: Hex) => ({ address,
    topics: topics.map(topic => { if (typeof topic !== 'string') throw new Error('Missing fixture topic'); return topic; }), data,
    removed: false, transactionHash, blockHash: hash(150), blockNumber: 150n });
  const logs = [
    log(value.pins.asset, encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from: payer.address, to: vault } }),
      encodeAbiParameters([{ type: 'uint256' }], [101n])),
    log(value.pins.asset, encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from: vault, to: treasury } }),
      encodeAbiParameters([{ type: 'uint256' }], [2n])),
    log(vault, encodeEventTopics({ abi: vaultAbi, eventName: 'FundsReceived', args: { source: payer.address } }),
      encodeAbiParameters([{ type: 'uint96' }, { type: 'uint96' }, { type: 'bytes32' }], [101n, 2n, paymentRef])),
    log(registry, encodeEventTopics({ abi: registryAbi, eventName: 'Income', args: { agentId: value.pins.agentId, source: payer.address } }),
      encodeAbiParameters([{ type: 'uint96' }, { type: 'uint96' }, { type: 'bytes32' }], [101n, 2n, paymentRef])),
  ];
  // REASON: Only fields inspected by the reader and conservation validator are modeled; cryptographic bytes are real local signatures.
  const receipt = { transactionHash, from: facilitator.address, to: vault, blockHash: hash(150), blockNumber: 150n,
    status: 'success', logs } as unknown as TransactionReceipt;
  return { raw, transactionHash, payment, receipt };
}

describe('Base USDC checked Node Vault income client', () => {
  beforeEach(() => { hooks.create.mockClear(); hooks.canonical.mockClear(); });

  it.each([8453, 84532] as const)('checks chain %s proxy, archive and its exact domain before exposing a signing plan', async chainId => {
    const value = profile(chainId), fixture = rpc(value), reader = new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value });
    const fetcher = vi.fn(async () => new Response('{}', { status: 402, headers: { 'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': encodePaymentHeader(offer(value)) } }));
    const client = new VaultIncomeClient({ profile: value, reader, journal: journal(), fetch: fetcher, now: () => 30_000_000 });
    const result = await client.prepare('public-plan', { payer: payer.address });
    expect(result.typedData.domain).toEqual({ name: chainId === 8453 ? 'USD Coin' : 'USDC', version: '2', chainId, verifyingContract: value.pins.asset });
    expect(fixture.getStorageAt.mock.calls.some(([request]) => request.blockHash === hash(100))).toBe(true);
    expect(fixture.getStorageAt.mock.calls.some(([request]) => request.blockHash === hash(200))).toBe(true);
    expect(Object.isFrozen(client.profile.pins.archiveAnchor)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([46630, 4663])('rejects old chain %s profiles before constructing RPC or making a POST', chainId => {
    const value = profile(); value.pins.chainId = chainId; value.pins.selection.chainId = chainId;
    const fetcher = vi.fn(async () => { throw new Error('Unexpected POST'); });
    expect(() => new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value })).toThrow();
    expect(() => new VaultIncomeClient({ profile: value, reader: { profile: value, check: vi.fn(), inspect: vi.fn() }, journal: journal(), fetch: fetcher })).toThrow();
    expect(hooks.create).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects USDG at a Base chain before creating a reader', () => {
    const value = profile(); value.pins.asset = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
    expect(() => new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value })).toThrow();
    expect(hooks.create).not.toHaveBeenCalled();
  });

  it.each(['code', 'pointer', 'implementation', 'metadata', 'domain'])(`rejects forged archive %s before requesting an offer`, async field => {
    const value = profile(), fixture = rpc(value); fixture.fault.block = hash(100); fixture.fault.field = field;
    const reader = new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value }), fetcher = vi.fn(async () => { throw new Error('Unexpected POST'); });
    const client = new VaultIncomeClient({ profile: value, reader, journal: journal(), fetch: fetcher, now: () => 30_000_000 });
    await expect(client.prepare('forged-archive', { payer: payer.address })).rejects.toMatchObject({ code: 'vault_income_chain_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires six hours of historical state before offering a signing plan', async () => {
    const value = profile(), fixture = rpc(value); fixture.fault.tooYoung = true;
    await expect(new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value }).check()).rejects.toMatchObject({ code: 'vault_income_chain_unavailable' });
    expect(fixture.getStorageAt).not.toHaveBeenCalled();
  });

  it('rechecks the current implementation before submitting a retained authorization', async () => {
    const value = profile(), fixture = rpc(value), reader = new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value });
    const fetcher = vi.fn(async () => new Response('{}', { status: 402, headers: { 'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': encodePaymentHeader(offer(value)) } }));
    const client = new VaultIncomeClient({ profile: value, reader, journal: journal(), fetch: fetcher, now: () => 30_000_000 });
    const prepared = await client.prepare('retained', { payer: payer.address }); await client.authorize('retained', await payer.signTypedData(prepared.typedData));
    fixture.fault.block = hash(200); fixture.fault.field = 'pointer';
    await expect(client.submit('retained')).rejects.toMatchObject({ code: 'vault_income_chain_unavailable' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses to reuse a signed Sepolia journal after changing the approved chain to Base mainnet', async () => {
    const value = profile(), fixture = rpc(value), stored = journal();
    const fetcher = vi.fn(async () => new Response('{}', { status: 402, headers: { 'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': encodePaymentHeader(offer(value)) } }));
    const initial = new VaultIncomeClient({ profile: value, reader: new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value }),
      journal: stored, fetch: fetcher, now: () => 30_000_000 });
    const plan = await initial.prepare('retained', { payer: payer.address }); await initial.authorize('retained', await payer.signTypedData(plan.typedData));
    const mainnet = profile(8453); rpc(mainnet);
    const moved = new VaultIncomeClient({ profile: mainnet, reader: new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: mainnet }),
      journal: stored, fetch: fetcher, now: () => 30_000_000 });
    await expect(moved.submit('retained')).rejects.toMatchObject({ code: 'vault_income_journal_invalid' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(fixture.getRawTransaction).not.toHaveBeenCalled();
  });

  it('accepts conserved income only after checking the receipt and parent proxy states', async () => {
    const value = profile(), fixture = rpc(value), paid = await paidEvidence(value);
    fixture.getRawTransaction.mockResolvedValue(paid.raw); fixture.getTransactionReceipt.mockResolvedValue(paid.receipt);
    const result = await new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value }).inspect(paid);
    expect(result).toMatchObject({ status: 'settled', classification: 'income', grossAmount: '101', incomeFee: '2', netAmount: '99' });
    expect(fixture.getStorageAt.mock.calls.some(([request]) => request.blockHash === hash(149))).toBe(true);
    expect(fixture.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: value.pins.asset, blockHash: hash(150) }));
  });

  it.each(['code', 'pointer', 'implementation', 'metadata', 'domain', 'upgrade', 'parent-pointer'])(`refuses receipt-block %s despite correct current pins and real signed transaction bytes`, async field => {
    const value = profile(), fixture = rpc(value), paid = await paidEvidence(value);
    fixture.getRawTransaction.mockResolvedValue(paid.raw); fixture.getTransactionReceipt.mockResolvedValue(paid.receipt);
    fixture.fault.block = field === 'parent-pointer' ? hash(149) : hash(150);
    fixture.fault.field = field === 'parent-pointer' ? 'pointer' : field; fixture.fault.upgraded = field === 'upgrade';
    await expect(new RpcVaultIncomeReader({ rpcUrl: 'https://rpc.example', profile: value }).inspect(paid)).rejects.toMatchObject({ code: 'asset_pin_mismatch' });
  });
});
