import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import solc from 'solc';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createTestClient, createWalletClient, getAddress, http, keccak256, parseEther, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { startLocalChain, type LocalChain } from '../scripts/local-chain.js';
import { localChain } from '../src/chain/chains.js';
import { hashJson, randomId } from '../src/common.js';
import { golemOriginalBinding, golemOriginalRunSchema, golemPaymentSchema } from '../src/suppliers/golem-finance-types.js';
import { decodeGolemPaymentTransactionHash, GolemPaymentChainObserver, golemDirectSettlementReference,
  GOLEM_POLYGON_GLM, type GolemPaymentChainPolicy } from '../src/suppliers/golem-payment-chain.js';

let artifact: { abi: Abi; bytecode: Hex };
beforeAll(() => {
  const source = `pragma solidity ^0.8.28;
    contract LocalGlm18 { uint8 public constant decimals=18; mapping(address=>uint) public balanceOf; uint public mode;
    event Transfer(address indexed from,address indexed to,uint value);
    constructor(){balanceOf[msg.sender]=1000 ether;} function setMode(uint n) external{mode=n;}
    function transfer(address to,uint n) external returns(bool){require(balanceOf[msg.sender]>=n);balanceOf[msg.sender]-=n;balanceOf[to]+=n;
    emit Transfer(msg.sender,to,n);if(mode==1)emit Transfer(msg.sender,to,n);return true;}
    function indirect(address to,uint n) external{emit Transfer(msg.sender,to,n);} }`;
  // REASON: test-only solc output is checked for compilation errors before use.
  const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'LocalGlm18.sol': { content: source } },
    settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }))) as {
      errors?: { severity: string }[]; contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>> };
  if (result.errors?.some(error => error.severity === 'error')) throw new Error('Local18-decimal token compilation failed');
  const token = result.contracts?.['LocalGlm18.sol']?.LocalGlm18;
  if (!token) throw new Error('Local18-decimal token missing'); artifact = { abi: token.abi, bytecode: `0x${token.evm.bytecode.object}` };
}, 120_000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
let chain: LocalChain;
beforeAll(async () => { chain = await startLocalChain(); });
afterAll(async () => { await chain?.close(); });
type RpcRequest = { method: string; params: unknown[]; id: number; jsonrpc: '2.0' };
async function endpoint(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  const server = createServer((request, response) => { void Promise.resolve(handle(request, response)).catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local RPC fixture address unavailable');
  return 'http://127.0.0.1:' + address.port;
}
async function readRequest(request: IncomingMessage): Promise<RpcRequest> {
  let body = ''; for await (const chunk of request) { body += String(chunk); if (body.length > 8192) throw new Error('Local RPC request bound'); }
  return z.object({ method: z.string(), params: z.array(z.unknown()), id: z.number(), jsonrpc: z.literal('2.0') }).parse(JSON.parse(body));
}
async function setup() {
  const account = privateKeyToAccount(generatePrivateKey()), payee = privateKeyToAccount(generatePrivateKey());
  const transport = http(chain.rpcUrl, { retryCount: 0 }), test = createTestClient({ chain: localChain, mode: 'anvil', transport });
  const wallet = createWalletClient({ chain: localChain, account, transport });
  await test.setBalance({ address: account.address, value: parseEther('10') });
  const confirmed = async (hash: Promise<Hex>) => chain.publicClient.waitForTransactionReceipt({ hash: await hash });
  const deployed = await confirmed(wallet.deployContract(artifact));
  if (!deployed.contractAddress) throw new Error('Local GLM fixture deployment absent');
  const token = getAddress(deployed.contractAddress), code = await chain.publicClient.getCode({ address: token });
  if (!code) throw new Error('Local GLM runtime absent');
  const binding = golemOriginalBinding(golemOriginalRunSchema.parse({ authorityId: randomId(), owner: account.address,
    runId: randomId(), authorizationHash: randomId(), active: true, asOfMs: Date.now(), requestorId: account.address.toLowerCase(),
    providerId: payee.address.toLowerCase(), payerAddr: account.address, payeeAddr: payee.address, paymentPlatform: 'erc20-polygon-glm',
    allocationId: 'local-allocation', agreementId: 'local-agreement', activityId: 'local-activity', imageDigest: randomId(),
    spendUntilMs: Date.now() + 120_000, maxGlmBaseUnits: parseEther('10').toString(), maxUsdcMicros: '10000' }));
  const policy: GolemPaymentChainPolicy = { version: 1, mode: 'direct-erc20-observation-v1', chainId: 31337,
    tokenAddress: token, tokenRuntimeCodeHash: keccak256(code), tokenDecimals: 18, minimumConfirmations: 2,
    rpcUrl: chain.rpcUrl, timeoutMs: 5000, maxResponseBytes: 262144 };
  const payment = (hash: Hex, amount = '1') => golemPaymentSchema.parse({ paymentId: 'local-payment', payerId: binding.requestorId,
    payeeId: binding.providerId, payerAddr: account.address, payeeAddr: payee.address, paymentPlatform: 'erc20-polygon-glm', amount,
    timestamp: new Date().toISOString(), details: Buffer.from(hash.slice(2), 'hex').toString('base64'),
    agreementPayments: [], activityPayments: [{ activityId: binding.activityId, allocationId: binding.allocationId, amount }] });
  const transfer = (amount = parseEther('1')) => confirmed(wallet.writeContract({ address: token, abi: artifact.abi,
    functionName: 'transfer', args: [payee.address, amount], gas: 120_000n }));
  const observe = (hash: Hex, amount = '1', overrides: Partial<GolemPaymentChainPolicy> = {}) =>
    new GolemPaymentChainObserver({ ...policy, ...overrides }).observe(binding, payment(hash, amount), new AbortController().signal);
  return { account, payee, test, wallet, token, binding, policy, payment, transfer, confirmed, observe };
}

it('observes a real exact18-decimal direct transfer and preserves one stable reference across payment aliases', async () => {
  const f = await setup(), receipt = await f.transfer(); await f.test.mine({ blocks: 1 });
  const observer = new GolemPaymentChainObserver(f.policy), result = await observer.observe(f.binding, f.payment(receipt.transactionHash), new AbortController().signal);
  expect(result).toMatchObject({ state: 'observed', observationOnly: true, settlementAuthorityEligible: false,
    amountBaseUnits: '1000000000000000000', confirmations: 2, blockHash: receipt.blockHash });
  if (result.state !== 'observed') throw new Error('Real transfer was not observed');
  expect(result.settlementReference).toBe(golemDirectSettlementReference(31337, f.token.toLowerCase(), receipt.transactionHash));
  const alias = await observer.observe(f.binding, { ...f.payment(receipt.transactionHash), paymentId: 'different-yagna-id' }, new AbortController().signal);
  expect(alias.state).toBe('observed'); if (alias.state !== 'observed') throw new Error('Alias observation missing');
  expect(alias.settlementReference).toBe(result.settlementReference); expect(alias.paymentHash).not.toBe(result.paymentHash);
  expect(observer.settlementAuthorityEligible).toBe(false); expect('confirmed' in result).toBe(false);
  // Deduplication is the consuming ledger's responsibility, never a claim made
  // by this read-only observer merely because two API IDs describe one transfer.
});

it('observes actual Yagna wire projection with missing allocation IDs, signed extras and exact exponent notation without inventing attribution', async () => {
  const f = await setup(), receipt = await f.transfer(1n); await f.test.mine({ blocks: 1 });
  const ordinary = f.payment(receipt.transactionHash, '0.000000000000000001');
  const wire = { ...ordinary, amount: '1E-18', signature: [1, 2, 3], signedBytes: [4, 5],
    activityPayments: [{ activityId: f.binding.activityId, amount: '1E-18' }] };
  const observation = await new GolemPaymentChainObserver(f.policy).observe(f.binding, wire, new AbortController().signal);
  expect(observation).toMatchObject({ state: 'observed', amountBaseUnits: '1', observationOnly: true, settlementAuthorityEligible: false });
  if (observation.state !== 'observed') throw new Error('Actual wire projection not observed');
  expect(observation.paymentHash).toBe(hashJson({ ...ordinary, activityPayments: [{ activityId: f.binding.activityId, amount: '0.000000000000000001' }] }));
  expect('allocationId' in wire.activityPayments[0]!).toBe(false); expect('confirmed' in observation).toBe(false);
});

it('refuses missing, mined-but-nonfinal, reverted and different exact-value claims on real Anvil', async () => {
  const f = await setup(); expect(await f.observe(randomId())).toMatchObject({ state: 'unconfirmed', reason: 'missing' });
  const receipt = await f.transfer(); expect(await f.observe(receipt.transactionHash)).toMatchObject({ reason: 'nonfinal' });
  await f.test.mine({ blocks: 1 }); expect(await f.observe(receipt.transactionHash, '1.000000000000000001')).toMatchObject({ reason: 'unsupported' });
  const reverted = await f.transfer(parseEther('1001')); expect(reverted.status).toBe('reverted');
  expect(await f.observe(reverted.transactionHash, '1001')).toMatchObject({ reason: 'reverted' });
});

it('rejects indirect calldata, multiple token Transfer events, foreign code and changed decimals', async () => {
  const f = await setup();
  const indirect = await f.confirmed(f.wallet.writeContract({ address: f.token, abi: artifact.abi, functionName: 'indirect', args: [f.payee.address, parseEther('1')] }));
  await f.test.mine({ blocks: 1 }); expect(await f.observe(indirect.transactionHash)).toMatchObject({ reason: 'unsupported' });
  await f.confirmed(f.wallet.writeContract({ address: f.token, abi: artifact.abi, functionName: 'setMode', args: [1n] }));
  const duplicate = await f.transfer(); await f.test.mine({ blocks: 1 });
  expect(await f.observe(duplicate.transactionHash)).toMatchObject({ reason: 'unsupported' });
  await f.confirmed(f.wallet.writeContract({ address: f.token, abi: artifact.abi, functionName: 'setMode', args: [0n] }));
  const ordinary = await f.transfer(); await f.test.mine({ blocks: 1 });
  expect(await f.observe(ordinary.transactionHash, '1', { tokenRuntimeCodeHash: randomId() })).toMatchObject({ reason: 'unsupported' });
  const rpcUrl = await endpoint(async (request, response) => {
    const value = await readRequest(request);
    if (value.method === 'eth_call') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...value, result: '0x' + '06'.padStart(64, '0'), method: undefined, params: undefined })); return; }
    const upstream = await fetch(chain.rpcUrl, { method: 'POST', body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });
    response.setHeader('content-type', 'application/json'); response.end(await upstream.text());
  });
  expect(await f.observe(ordinary.transactionHash, '1', { rpcUrl })).toMatchObject({ reason: 'unsupported' });
});

it('detects an actual canonical reorg during awaited inspection rather than retaining the first successful receipt', async () => {
  const f = await setup(), snapshot = await f.test.snapshot(), receipt = await f.transfer(); await f.test.mine({ blocks: 1 });
  let reverted = false, seenReceipt = false;
  const rpcUrl = await endpoint(async (request, response) => {
    const value = await readRequest(request);
    // Reorg after the historical hash-bound code/decimals checks, before final
    // receipt/canonical-block observations. The current code query remains valid.
    if (value.method === 'eth_getTransactionReceipt' && !reverted && seenReceipt) {
      reverted = true; await f.test.revert({ id: snapshot }); await f.test.mine({ blocks: 3 });
    }
    if (value.method === 'eth_getTransactionReceipt') seenReceipt = true;
    const upstream = await fetch(chain.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    response.setHeader('content-type', 'application/json'); response.end(await upstream.text());
  });
  expect(await f.observe(receipt.transactionHash, '1', { rpcUrl })).toMatchObject({ state: 'unconfirmed', reason: 'changed' });
  expect(reverted).toBe(true); expect(await chain.publicClient.getTransactionReceipt({ hash: receipt.transactionHash }).catch(() => null)).toBeNull();
});

it('rejects altered owner/provider/payment bindings and noncanonical details before any HTTP call', async () => {
  const f = await setup(); let calls = 0;
  const rpcUrl = await endpoint((_request, response) => { calls++; response.end('{}'); });
  const observer = new GolemPaymentChainObserver({ ...f.policy, rpcUrl });
  await expect(observer.observe(f.binding, { ...f.payment(randomId()), payerAddr: f.payee.address }, new AbortController().signal)).rejects.toThrow('parties');
  for (const shares of [
    { activityPayments: [{ activityId: 'foreign-activity', amount: '1' }], agreementPayments: [] },
    { activityPayments: [], agreementPayments: [{ agreementId: 'foreign-agreement', amount: '1' }] },
    { activityPayments: [{ activityId: f.binding.activityId, amount: '1', allocationId: 'foreign-allocation' }], agreementPayments: [] },
    { activityPayments: [{ activityId: f.binding.activityId, amount: '0.5' }], agreementPayments: [] },
  ]) await expect(observer.observe(f.binding, { ...f.payment(randomId()), ...shares }, new AbortController().signal)).rejects.toThrow('scope');
  for (const details of ['0x' + 'ab'.repeat(32), Buffer.alloc(31).toString('base64'), Buffer.alloc(32).toString('base64') + '\n', '_'.repeat(43) + '='])
    await expect(observer.observe(f.binding, { ...f.payment(randomId()), details }, new AbortController().signal)).rejects.toThrow('details');
  expect(calls).toBe(0);
  const valid = Buffer.alloc(32, 255).toString('base64'); expect(decodeGolemPaymentTransactionHash(valid)).toBe('0x' + 'ff'.repeat(32));
  expect(() => decodeGolemPaymentTransactionHash(valid.slice(0, 42) + '/=')).toThrow(); // nonzero unused pad bits
});

it('bounds real HTTP response bytes, rejects redirects and RPC error/duplicate-key envelopes without retry or response disclosure', async () => {
  const f = await setup();
  for (const mode of ['oversize', 'stream', 'redirect', 'rpc-error', 'duplicate'] as const) {
    let calls = 0;
    const rpcUrl = await endpoint(async (_request, response) => {
      calls++; response.setHeader('content-type', 'application/json');
      if (mode === 'redirect') { response.writeHead(307, { location: chain.rpcUrl }); response.end(); }
      else if (mode === 'oversize') { response.setHeader('content-length', 9000); response.end('private-response-marker'); }
      else if (mode === 'stream') { response.write(' '.repeat(3000)); response.end(' '.repeat(3000)); }
      else if (mode === 'duplicate') response.end('{"jsonrpc":"2.0","id":1,"result":"0x7a69","result":"private-response-marker"}');
      else response.end('{"jsonrpc":"2.0","id":1,"error":{"message":"private-response-marker"}}');
    });
    await expect(f.observe(randomId(), '1', { rpcUrl, maxResponseBytes: 4096 })).rejects.toThrow(/^Golem read-only RPC observation unavailable$/);
    expect(calls).toBe(1);
  }
});

it('covers stalled response bodies and caller cancellation with the single whole-inspection budget', async () => {
  const f = await setup();
  for (const callerAborts of [false, true]) {
    const controller = new AbortController(); let calls = 0;
    const rpcUrl = await endpoint((_request, response) => {
      calls++; response.setHeader('content-type', 'application/json'); response.write('{');
      if (callerAborts) controller.abort(); // response body stays open until fetch aborts
    });
    const started = Date.now();
    await expect(new GolemPaymentChainObserver({ ...f.policy, rpcUrl, timeoutMs: callerAborts ? 5000 : 100 })
      .observe(f.binding, f.payment(randomId()), controller.signal)).rejects.toThrow(/^Golem read-only RPC observation unavailable$/);
    expect(Date.now() - started).toBeLessThan(2000); expect(calls).toBe(1);
  }
});

it('also bounds injected transport work and cancellation that never resolve, and refuses misleading JSON media types', async () => {
  const f = await setup();
  const stalled: typeof fetch = async () => new Promise<Response>(() => undefined);
  await expect(new GolemPaymentChainObserver({ ...f.policy, timeoutMs: 100 }, stalled)
    .observe(f.binding, f.payment(randomId()), new AbortController().signal)).rejects.toThrow('RPC observation unavailable');
  const stalledCancel: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { return new Promise<void>(() => undefined); },
  }), { headers: { 'content-type': 'application/json' } });
  await expect(new GolemPaymentChainObserver({ ...f.policy, timeoutMs: 100 }, stalledCancel)
    .observe(f.binding, f.payment(randomId()), new AbortController().signal)).rejects.toThrow('RPC observation unavailable');
  const rpcUrl = await endpoint((_request, response) => {
    response.setHeader('content-type', 'application/json-not-a-real-media-type'); response.end('{"jsonrpc":"2.0","id":1,"result":"0x7a69"}');
  });
  await expect(f.observe(randomId(), '1', { rpcUrl })).rejects.toThrow('RPC observation unavailable');
});

it('pins the explicit observation-only policy and canonical Polygon address without approving its proxy implementation', async () => {
  const f = await setup(), supplied = { ...f.policy }, observer = new GolemPaymentChainObserver(supplied);
  supplied.minimumConfirmations = 1; expect(observer.policy.minimumConfirmations).toBe(2); expect(Object.isFrozen(observer.policy)).toBe(true);
  expect(() => new GolemPaymentChainObserver({ ...f.policy, rpcUrl: 'http://example.com' })).toThrow('transport');
  expect(() => new GolemPaymentChainObserver({ ...f.policy, chainId: 137 })).toThrow();
  const polygon = new GolemPaymentChainObserver({ ...f.policy, chainId: 137, tokenAddress: GOLEM_POLYGON_GLM });
  expect(polygon.observationOnly).toBe(true); expect(polygon.settlementAuthorityEligible).toBe(false);
  expect(golemDirectSettlementReference(137, GOLEM_POLYGON_GLM, randomId())).not.toBe(hashJson('production approval'));
});
