import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseTransaction, toHex, type Address, type Hex } from 'viem';
import { localChain } from '../src/chain/chains.js';
import { EIP3009_TYPES } from '../src/payments/gateway.js';
import { paymentPayloadSchema, requestBinding, type PaymentPayload } from '../src/payments/protocol.js';
import { RpcVaultIncomeReader } from '../src/sdk/vault-income/reader.js';
import type { VaultIncomePublicProfile } from '../src/sdk/vault-income/types.js';
import { deployVaultIncomeMainFixture } from './fixtures/vault-income-main.js';

const vaultAbi = parseAbi(['function receiveFundsWithAuthorization(address from,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
const tokenAbi = parseAbi(['function authorizationState(address,bytes32) view returns(bool)', 'function balanceOf(address) view returns(uint256)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
const resourceUrl = 'http://127.0.0.1:1/x402/vault-income';
type Rpc = { jsonrpc: string; id: number; method: string; params: unknown[] };
type Override = (rpc: Rpc) => Promise<{ result?: unknown; error?: { code: number; message: string } } | undefined>;

describe('independent read-only checked Vault income chain evidence', () => {
  let fixture: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>, snapshot: Hex, profile: VaultIncomePublicProfile;
  const servers: { server: Server; sockets: Set<Socket> }[] = [];
  const wallet = (account = fixture.facilitator) => createWalletClient({ account, chain: localChain, transport: http(fixture.local.rpcUrl, { retryCount: 0 }) });
  const reader = (value = profile, rpcUrl = fixture.local.rpcUrl) => new RpcVaultIncomeReader({ rpcUrl, profile: value });
  beforeAll(async () => {
    fixture = await deployVaultIncomeMainFixture();
    const code = await fixture.local.publicClient.getCode({ address: fixture.pins.tokenAddress }); if (!code) throw new Error('Missing disposable token');
    profile = { resourceUrl, grossAmount: '101', pins: { chainId: 31337, asset: fixture.pins.tokenAddress, tokenCodeHash: keccak256(code),
      payTo: fixture.vault.agent.vault, facilitator: fixture.facilitator.address, reviewedTokenKind: 'immutable', confirmations: 1,
      exact: { reviewedEip3009: true, name: 'Local EIP3009 Fixture', version: '1' }, agentId: fixture.agentId,
      treasury: fixture.accounts.outsider.address, selection: { chainId: 31337, selectionRegistryAddress: fixture.vault.registryAddress,
        selectionRegistryCodeHash: fixture.vault.pins.registryCodeHash, vaultImplementationAddress: fixture.vault.implementationAddress,
        vaultImplementationCodeHash: fixture.vault.pins.implementationCodeHash, confirmations: 1 } } };
    snapshot = await fixture.test.snapshot();
  }, 90_000);
  beforeEach(async () => { await fixture.test.revert({ id: snapshot }); snapshot = await fixture.test.snapshot(); });
  afterEach(async () => {
    await fixture.test.setAutomine(true);
    for (const item of servers.splice(0)) { for (const socket of item.sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => item.server.close(error => error ? reject(error) : resolve())); }
  });
  afterAll(async () => { await fixture?.close(); });
  async function proxy(override: Override) {
    const calls: Rpc[] = [], sockets = new Set<Socket>();
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const rpc = JSON.parse(Buffer.concat(chunks).toString()) as Rpc; rpc.params ??= []; calls.push(rpc);
        const changed = await override(rpc);
        outgoing.setHeader('Content-Type', 'application/json');
        if (changed) outgoing.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...changed }));
        else { const response = await fetch(fixture.local.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpc) });
          outgoing.end(await response.text()); }
      } catch { outgoing.statusCode = 500; outgoing.end('{}'); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    servers.push({ server, sockets }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing disposable RPC port');
    return { url: 'http://127.0.0.1:' + address.port, calls };
  }
  async function payment(account = fixture.payer): Promise<PaymentPayload> {
    if (account.address === fixture.accounts.owner.address) await fixture.confirmed(fixture.owner.writeContract({ address: profile.pins.asset,
      abi: fixture.artifact('MockToken').abi, functionName: 'faucet', args: [account.address, 1000n] }));
    const time = (await fixture.local.publicClient.getBlock()).timestamp, nonce = keccak256(toHex(randomUUID()));
    const authorization = { from: account.address, to: profile.pins.payTo, value: 101n, validAfter: time - 1n, validBefore: time + 180n, nonce };
    const signature = await account.signTypedData({ domain: { name: profile.pins.exact.name, version: profile.pins.exact.version,
      chainId: 31337, verifyingContract: profile.pins.asset }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
    return paymentPayloadSchema.parse({ x402Version: 2, resource: { url: resourceUrl }, accepted: { scheme: 'exact', network: 'eip155:31337',
      asset: profile.pins.asset, amount: '101', payTo: profile.pins.payTo, maxTimeoutSeconds: 300, extra: { name: profile.pins.exact.name,
        version: profile.pins.exact.version, assetTransferMethod: 'eip3009', facilitatorAddress: profile.pins.facilitator,
        telomere: { challengeId: randomUUID(), nonce, requestHash: requestBinding('POST', resourceUrl, Buffer.from('{}')) } } },
      payload: { signature, authorization: { ...authorization, value: '101', validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString() } } });
  }
  function args(input: PaymentPayload) {
    if (!('authorization' in input.payload)) throw new Error('Missing disposable exact authorization');
    const auth = input.payload.authorization, signature = input.payload.signature, byte = Number.parseInt(signature.slice(130, 132), 16);
    return [auth.from, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, byte < 27 ? byte + 27 : byte,
      `0x${signature.slice(2, 66)}`, `0x${signature.slice(66, 130)}`] as const;
  }
  async function prepared(input: PaymentPayload, account = fixture.facilitator, gas = 1_000_000n, accessList: { address: Address; storageKeys: Hex[] }[] = []) {
    const request = await wallet(account).prepareTransactionRequest({ account, chain: localChain, to: profile.pins.payTo,
      data: encodeFunctionData({ abi: vaultAbi, functionName: 'receiveFundsWithAuthorization', args: args(input) }), gas, type: 'eip1559', accessList });
    const raw = await wallet(account).signTransaction(request); return { raw, transactionHash: keccak256(raw) };
  }
  async function submit(input: PaymentPayload, account = fixture.facilitator) {
    const value = await prepared(input, account);
    expect(await fixture.local.publicClient.sendRawTransaction({ serializedTransaction: value.raw })).toBe(value.transactionHash);
    const receipt = await fixture.local.publicClient.waitForTransactionReceipt({ hash: value.transactionHash });
    return { ...value, receipt };
  }
  it('checks actual immutable public pins and returns a fresh canonical registered binding without a signing account', async () => {
    const cloned = structuredClone(profile), checked = reader(cloned), result = await checked.check();
    expect(result.binding).toMatchObject({ agentId: fixture.agentId, vault: profile.pins.payTo, owner: fixture.accounts.owner.address });
    expect(Object.isFrozen(checked.profile.pins.exact)).toBe(true); cloned.pins.exact.name = 'mutated';
    expect(checked.profile.pins.exact.name).toBe(profile.pins.exact.name);
  });
  it.each(['income', 'subsidy'] as const)('independently verifies actual %s original-payer classification and exact rounded fee', async classification => {
    const input = await payment(classification === 'income' ? fixture.payer : fixture.accounts.owner), value = await submit(input);
    expect(value.receipt.status).toBe('success');
    const result = await reader().inspect({ transactionHash: value.transactionHash, payment: input });
    expect(result).toMatchObject({ status: 'settled', transactionHash: value.transactionHash, classification, grossAmount: '101',
      incomeFee: classification === 'income' ? '2' : '0', netAmount: classification === 'income' ? '99' : '101', payer: args(input)[0] });
    expect(result.block?.hash).toBe(value.receipt.blockHash); expect(result.paymentRef).toMatch(/^0x[a-f0-9]{64}$/);
  });
  it('accepts the same signed raw transaction bytes with upper-case hex encoding', async () => {
    const input = await payment(), value = await submit(input), transport = await proxy(async rpc => rpc.method === 'eth_getRawTransactionByHash'
      ? { result: '0x' + value.raw.slice(2).toUpperCase() } : undefined);
    expect((await reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('settled');
  });
  it('retains historical canonical receipts after expiry, guardian freeze and actual Death', async () => {
    const input = await payment(), value = await submit(input), registry = fixture.vault.registryAddress, abi = fixture.artifact('PlatformSelectionRegistry').abi;
    await fixture.confirmed(fixture.vault.guardianWallet.writeContract({ address: registry, abi, functionName: 'setFrozen',
      args: [fixture.agentId, true, 'disposable checked-client evidence', keccak256(toHex('freeze'))] }));
    const balance = await fixture.local.publicClient.readContract({ address: profile.pins.asset, abi: tokenAbi, functionName: 'balanceOf', args: [profile.pins.payTo] });
    await fixture.confirmed(fixture.owner.writeContract({ address: profile.pins.payTo, abi: fixture.artifact('PlatformAgentVault').abi, functionName: 'ownerWithdraw', args: [balance] }));
    await fixture.test.increaseTime({ seconds: 3 * 86_400 + 1 }); await fixture.test.mine({ blocks: 1 });
    await fixture.confirmed(fixture.owner.writeContract({ address: registry, abi, functionName: 'declareDormant', args: [fixture.agentId] }));
    await fixture.test.increaseTime({ seconds: 30 * 86_400 + 1 }); await fixture.test.mine({ blocks: 1 });
    await fixture.confirmed(fixture.owner.writeContract({ address: registry, abi, functionName: 'declareDeath', args: [fixture.agentId] }));
    await fixture.test.mine({ blocks: 2 });
    expect((await reader().inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('settled');
  });
  it('reports insufficient canonical depth as pending and withdraws success after actual depth loss', async () => {
    const input = await payment(), value = await submit(input), shallow = await fixture.test.snapshot();
    const deeper = structuredClone(profile); deeper.pins.confirmations = deeper.pins.selection.confirmations = 2;
    expect((await reader(deeper).inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('pending');
    await fixture.test.mine({ blocks: 1 });
    expect((await reader(deeper).inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('settled');
    await fixture.test.revert({ id: shallow });
    expect((await reader(deeper).inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('pending');
  });
  it('never caches a successful receipt across an actual reorg and only accepts the original raw transaction again', async () => {
    const input = await payment(), before = await fixture.test.snapshot(), value = await submit(input), checked = reader();
    expect((await checked.inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('settled');
    await fixture.test.revert({ id: before });
    expect((await checked.inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('pending');
    await fixture.local.publicClient.sendRawTransaction({ serializedTransaction: value.raw });
    await fixture.local.publicClient.waitForTransactionReceipt({ hash: value.transactionHash });
    expect((await checked.inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('settled');
  });
  it('returns pending for a real unmined raw transaction without treating nonce or an HTTP candidate as payment', async () => {
    const input = await payment(), value = await prepared(input); await fixture.test.setAutomine(false);
    await fixture.local.publicClient.sendRawTransaction({ serializedTransaction: value.raw });
    expect(await reader().inspect({ transactionHash: value.transactionHash, payment: input })).toEqual({ status: 'pending', transactionHash: value.transactionHash });
  });
  it('recognizes an actual canonical reverted native call with no credit or consumed authorization', async () => {
    const input = await payment(), value = await prepared(input); await fixture.test.increaseTime({ seconds: 181 }); await fixture.test.mine({ blocks: 1 });
    await fixture.local.publicClient.sendRawTransaction({ serializedTransaction: value.raw });
    expect((await fixture.local.publicClient.waitForTransactionReceipt({ hash: value.transactionHash })).status).toBe('reverted');
    expect(await reader().inspect({ transactionHash: value.transactionHash, payment: input })).toEqual({ status: 'reverted', transactionHash: value.transactionHash });
  });
  it('fails closed on direct-token front-running without adopting another hash or inventing Vault income', async () => {
    const input = await payment(), auth = args(input);
    await fixture.confirmed(wallet(fixture.payer).writeContract({ address: profile.pins.asset, abi: tokenAbi, functionName: 'transferWithAuthorization',
      args: [auth[0], profile.pins.payTo, auth[1], auth[2], auth[3], auth[4], auth[5], auth[6], auth[7]] }));
    await expect(reader().inspect({ transactionHash: keccak256(toHex('unknown original relay')), payment: input })).rejects.toMatchObject({ code: 'income_authorization_reconciliation_required' });
  });
  it.each(['direct-token', 'alternate-native-relay'] as const)('reconciles a still-valid authorization consumed after an actual low-gas revert by %s', async later => {
    const input = await payment(), original = await prepared(input, fixture.facilitator, 30_000n);
    await fixture.local.publicClient.sendRawTransaction({ serializedTransaction: original.raw });
    const reverted = await fixture.local.publicClient.waitForTransactionReceipt({ hash: original.transactionHash }); expect(reverted.status).toBe('reverted');
    expect((await reader().inspect({ transactionHash: original.transactionHash, payment: input })).status).toBe('reverted');
    if (later === 'direct-token') { const auth = args(input);
      await fixture.confirmed(wallet(fixture.payer).writeContract({ address: profile.pins.asset, abi: tokenAbi, functionName: 'transferWithAuthorization',
        args: [auth[0], profile.pins.payTo, auth[1], auth[2], auth[3], auth[4], auth[5], auth[6], auth[7]] }));
    } else expect((await submit(input)).receipt.status).toBe('success');
    await expect(reader().inspect({ transactionHash: original.transactionHash, payment: input })).rejects.toMatchObject({ code: 'income_authorization_reconciliation_required' });
  });
  it.each(['raw-hash', 'wrong-outer-signer', 'wrong-calldata'] as const)('rejects actual independent raw transaction evidence mismatch: %s', async reason => {
    const input = await payment(), actual = reason === 'wrong-calldata' ? await payment() : input;
    const value = await submit(actual, reason === 'wrong-outer-signer' ? fixture.payer : fixture.facilitator);
    const transport = await proxy(async rpc => rpc.method === 'eth_getRawTransactionByHash' && reason === 'raw-hash' ? { result: '0x1234' } : undefined);
    await expect(reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input })).rejects.toThrow(/^(income_transaction_mismatch|vault_income_chain_unavailable)$/);
    expect(transport.calls.some(call => call.method === 'eth_getRawTransactionByHash')).toBe(true);
    expect(transport.calls.some(call => call.method === 'eth_getTransactionByHash')).toBe(false);
  });
  it.each(['income', 'subsidy'] as const)('reconstructs a complete signed type2 %s transaction only after explicit raw-method unsupported', async classification => {
    const input = await payment(classification === 'income' ? fixture.payer : fixture.accounts.owner);
    const value = await prepared(input, fixture.facilitator, 1_000_000n, [{ address: profile.pins.asset, storageKeys: [toHex(0, { size: 32 })] }]);
    expect(value.raw.slice(0, 4)).toBe('0x02');
    await fixture.local.publicClient.sendRawTransaction({ serializedTransaction: value.raw });
    const receipt = await fixture.local.publicClient.waitForTransactionReceipt({ hash: value.transactionHash }); expect(receipt.status).toBe('success');
    const transport = await proxy(async rpc => rpc.method === 'eth_getRawTransactionByHash'
      ? { error: { code: -32601, message: 'method unavailable with private provider metadata' } } : undefined);
    const result = await reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input });
    expect(result).toMatchObject({ status: 'settled', transactionHash: value.transactionHash, classification,
      grossAmount: '101', incomeFee: classification === 'income' ? '2' : '0', netAmount: classification === 'income' ? '99' : '101' });
    expect(result.block?.hash).toBe(receipt.blockHash);
    expect(transport.calls.filter(call => call.method === 'eth_getTransactionByHash')).toHaveLength(1);
  });
  it.each([-32602, -32004, -32000, -32603, 4200])('never reconstructs after raw RPC error %s, regardless of its message', async code => {
    const input = await payment(), value = await submit(input), transport = await proxy(async rpc => rpc.method === 'eth_getRawTransactionByHash'
      ? { error: { code, message: 'method not found -32601' } } : undefined);
    await expect(reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input })).rejects.toThrow(/^vault_income_chain_unavailable$/);
    expect(transport.calls.some(call => call.method === 'eth_getTransactionByHash')).toBe(false);
  });
  it('reconstructs actual Anvil minimal-length signature quantities without dropping their leading zero bytes', async () => {
    let chosen: { input: PaymentPayload; value: Awaited<ReturnType<typeof prepared>> } | undefined;
    for (let attempt = 0; attempt < 128 && !chosen; attempt++) {
      const input = await payment(), value = await prepared(input), tx = parseTransaction(value.raw);
      if (tx.r?.startsWith('0x0') || tx.s?.startsWith('0x0')) chosen = { input, value };
    }
    if (!chosen) throw new Error('Disposable leading-zero signature vector unavailable');
    const { input, value } = chosen; await fixture.local.publicClient.sendRawTransaction({ serializedTransaction: value.raw });
    await fixture.local.publicClient.waitForTransactionReceipt({ hash: value.transactionHash }); let observedShortScalar = false;
    const transport = await proxy(async rpc => {
      if (rpc.method === 'eth_getRawTransactionByHash') return { error: { code: -32601, message: 'unsupported' } };
      if (rpc.method !== 'eth_getTransactionByHash') return undefined;
      const response = await fetch(fixture.local.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpc) });
      const data = await response.json() as { result: { r: string; s: string } };
      observedShortScalar = [data.result.r, data.result.s].some(value => value.length < 66); return { result: data.result };
    });
    expect((await reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input })).status).toBe('settled');
    expect(observedShortScalar).toBe(true);
  });
  it('does not reconstruct a raw RPC null response and treats unsupported+missing full transaction as pending', async () => {
    const input = await payment(), hash = keccak256(toHex('missing fallback transaction'));
    const missingRaw = await proxy(async rpc => rpc.method === 'eth_getRawTransactionByHash' ? { result: null } : undefined);
    expect((await reader(profile, missingRaw.url).inspect({ transactionHash: hash, payment: input })).status).toBe('pending');
    expect(missingRaw.calls.some(call => call.method === 'eth_getTransactionByHash')).toBe(false);
    const unsupported = await proxy(async rpc => rpc.method === 'eth_getRawTransactionByHash' ? { error: { code: -32601, message: 'unsupported' } } : undefined);
    expect((await reader(profile, unsupported.url).inspect({ transactionHash: hash, payment: input })).status).toBe('pending');
    expect(unsupported.calls.filter(call => call.method === 'eth_getTransactionByHash')).toHaveLength(1);
  });
  it.each(['chainId', 'type', 'nonce', 'gas', 'to', 'value', 'input', 'accessList', 'maxFeePerGas', 'maxPriorityFeePerGas',
    'yParity', 'r', 's', 'hash', 'from'])('refuses reconstruction when signed transaction field %s is omitted', async field => {
    const input = await payment(), value = await submit(input); let altered = 0;
    const transport = await proxy(async rpc => {
      if (rpc.method === 'eth_getRawTransactionByHash') return { error: { code: -32601, message: 'unsupported' } };
      if (rpc.method !== 'eth_getTransactionByHash') return undefined;
      const response = await fetch(fixture.local.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpc) });
      const data = await response.json() as { result: Record<string, unknown> }; delete data.result[field]; altered++; return { result: data.result };
    });
    await expect(reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input })).rejects.toThrow(/^income_transaction_mismatch$/);
    expect(altered).toBe(1); expect(transport.calls.some(call => call.method === 'eth_getTransactionReceipt')).toBe(false);
  });
  it.each(['chain', 'nonce', 'gas', 'fee', 'priority', 'to', 'value', 'input', 'access-list', 'hash', 'from', 'r', 's', 'parity',
    'v-parity', 'padded-quantity', 'uint256-overflow', 'unsafe-nonce', 'uint64-gas', 'unknown-type', 'legacy-type', 'zero-r', 'high-s'] as const)
  ('rejects altered type2 reconstruction evidence: %s', async reason => {
    const input = await payment(), value = await submit(input); let altered = 0;
    const transport = await proxy(async rpc => {
      if (rpc.method === 'eth_getRawTransactionByHash') return { error: { code: -32601, message: 'unsupported' } };
      if (rpc.method !== 'eth_getTransactionByHash') return undefined;
      const response = await fetch(fixture.local.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpc) });
      const data = await response.json() as { result: Record<string, unknown> }, tx = data.result;
      if (reason === 'chain') tx.chainId = '0x1';
      else if (reason === 'nonce') tx.nonce = toHex(BigInt(String(tx.nonce)) + 1n);
      else if (reason === 'gas') tx.gas = toHex(BigInt(String(tx.gas)) + 1n);
      else if (reason === 'fee') tx.maxFeePerGas = toHex(BigInt(String(tx.maxFeePerGas)) + 1n);
      else if (reason === 'priority') tx.maxPriorityFeePerGas = toHex(BigInt(String(tx.maxFeePerGas)) + 1n);
      else if (reason === 'to' || reason === 'from') tx[reason] = fixture.payer.address;
      else if (reason === 'value') tx.value = '0x1';
      else if (reason === 'input') tx.input = '0x1234';
      else if (reason === 'access-list') tx.accessList = [{ address: profile.pins.asset, storageKeys: [toHex(1, { size: 32 })] }];
      else if (reason === 'hash') tx.hash = keccak256(toHex('substituted transaction'));
      else if (reason === 'r' || reason === 's') tx[reason] = toHex(1, { size: 32 });
      else if (reason === 'parity') { tx.yParity = tx.yParity === '0x0' ? '0x1' : '0x0'; tx.v = tx.yParity; }
      else if (reason === 'v-parity') tx.v = tx.yParity === '0x0' ? '0x1' : '0x0';
      else if (reason === 'padded-quantity') tx.nonce = '0x00';
      else if (reason === 'uint256-overflow') tx.maxFeePerGas = '0x1' + '0'.repeat(64);
      else if (reason === 'unsafe-nonce') tx.nonce = '0x20000000000000';
      else if (reason === 'uint64-gas') tx.gas = '0x10000000000000000';
      else if (reason === 'unknown-type') tx.type = '0x4';
      else if (reason === 'legacy-type') tx.type = '0x0';
      else if (reason === 'zero-r') tx.r = toHex(0, { size: 32 });
      else tx.s = toHex(2n ** 255n, { size: 32 });
      altered++; return { result: tx };
    });
    await expect(reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input })).rejects.toThrow(/^income_transaction_mismatch$/);
    expect(altered).toBe(1); expect(transport.calls.some(call => call.method === 'eth_getTransactionReceipt')).toBe(false);
  });
  it.each(['asset', 'registry', 'implementation', 'clone'] as const)('checks %s code at the actual historical receipt hash independently of current pins', async target => {
    const input = await payment(), value = await submit(input); await fixture.test.mine({ blocks: 4 }); let altered = 0;
    const address: Address = target === 'asset' ? profile.pins.asset : target === 'registry' ? profile.pins.selection.selectionRegistryAddress
      : target === 'implementation' ? profile.pins.selection.vaultImplementationAddress : profile.pins.payTo;
    const transport = await proxy(async rpc => {
      const state = rpc.params[1] as { blockHash?: string } | undefined;
      if (rpc.method === 'eth_getCode' && String(rpc.params[0]).toLowerCase() === address.toLowerCase() && state?.blockHash === value.receipt.blockHash) {
        altered++; return { result: '0x00' };
      } return undefined;
    });
    const rejected = await reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input }).then(() => undefined, error => error as Error);
    expect(rejected).toBeInstanceOf(Error);
    if (altered === 0) throw new Error(JSON.stringify({ diagnostic: 'historical_fixture_override_not_reached', message: rejected?.message,
      methods: transport.calls.map(call => call.method), tail: transport.calls.slice(-4) }));
    expect(transport.calls.filter(call => ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(call.method)).every(call => {
      const state = call.params[call.method === 'eth_getStorageAt' ? 2 : 1] as { blockHash?: string; requireCanonical?: boolean };
      return typeof state?.blockHash === 'string' && state.requireCanonical === true;
    })).toBe(true);
  });
  it.each(['nonce', 'reference', 'fee-event'] as const)('refuses contradictory actual receipt evidence: %s', async reason => {
    const input = await payment(), value = await submit(input); await fixture.test.mine({ blocks: 4 }); let altered = 0;
    const selector = reason === 'nonce' ? encodeFunctionData({ abi: tokenAbi, functionName: 'authorizationState', args: [args(input)[0], args(input)[4]] })
      : encodeFunctionData({ abi: parseAbi(['function usedIncomeAuthorization(bytes32) view returns(bool)']), functionName: 'usedIncomeAuthorization', args: [toHex(0, { size: 32 })] }).slice(0, 10);
    const transport = await proxy(async rpc => {
      const state = rpc.params[1] as { blockHash?: string } | undefined, call = rpc.params[0] as { data?: string } | undefined;
      if (rpc.method === 'eth_call' && state?.blockHash === value.receipt.blockHash && call?.data?.startsWith(selector) && reason !== 'fee-event') { altered++; return { result: toHex(0, { size: 32 }) }; }
      if (reason === 'fee-event' && rpc.method === 'eth_getTransactionReceipt') {
        const response = await fetch(fixture.local.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpc) });
        const data = await response.json() as { result: { logs: { address: string; data: string }[] } };
        const log = data.result.logs.find(log => log.address.toLowerCase() === profile.pins.payTo.toLowerCase());
        if (!log) throw new Error('Missing actual FundsReceived fixture'); altered++; log.data = toHex(0, { size: 96 }); return { result: data.result };
      } return undefined;
    });
    await expect(reader(profile, transport.url).inspect({ transactionHash: value.transactionHash, payment: input })).rejects.toThrow();
    expect(altered).toBeGreaterThan(0);
  });
  it('rejects a mismatched payer signature and request binding before making any RPC call', async () => {
    const input = await payment(), transport = await proxy(async () => undefined), invalid = structuredClone(input);
    if (!('authorization' in invalid.payload)) throw new Error('Missing disposable exact input'); invalid.payload.authorization.from = fixture.accounts.owner.address;
    await expect(reader(profile, transport.url).inspect({ transactionHash: keccak256('0x1234'), payment: invalid })).rejects.toMatchObject({ code: 'vault_income_signature_mismatch' });
    const wrongRequest = structuredClone(input); wrongRequest.accepted.extra.telomere.requestHash = keccak256('0x5678');
    await expect(reader(profile, transport.url).inspect({ transactionHash: keccak256('0x1234'), payment: wrongRequest })).rejects.toMatchObject({ code: 'vault_income_plan_mismatch' });
    expect(transport.calls).toHaveLength(0);
  });
  it('redacts an actual provider failure while checking a missing transaction authorization', async () => {
    const input = await payment(), selector = encodeFunctionData({ abi: tokenAbi, functionName: 'authorizationState', args: [args(input)[0], args(input)[4]] });
    const transport = await proxy(async rpc => rpc.method === 'eth_call' && (rpc.params[0] as { data?: string }).data === selector
      ? { error: { code: -32000, message: 'private-provider-token-and-path' } } : undefined);
    await expect(reader(profile, transport.url).inspect({ transactionHash: keccak256(toHex('missing redacted transaction')), payment: input })).rejects.toThrow(/^vault_income_chain_unavailable$/);
    expect(transport.calls.some(call => call.method === 'eth_getRawTransactionByHash')).toBe(true);
  });
});
