import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { beforeAll, expect, it, vi } from 'vitest';
import { decodeFunctionData, domainSeparator, encodeDeployData, encodeFunctionResult, getContractAddress, keccak256, padHex, parseAbi,
  toHex, type EIP1193Provider, type PublicClient } from 'viem';
import type { ContractArtifact } from '../scripts/compile-contracts.js';
import { legacyDeploymentPlanDigest } from '../scripts/deployment-approval.js';
import { createOwnerWalletReviewServer } from '../scripts/owner-wallet-deployment.js';
import { unusedLocalPort } from '../scripts/local-chain.js';
import { baseMainnetUsdc } from '../src/chain/chains.js';
import { compileOwnerWalletArtifact, loadFrozenOwnerWalletDeployment, reviewOwnerWalletDeployment,
  validateOwnerWalletPlan, type FrozenOwnerWalletDeployment } from '../src/deployment/owner-wallet-review.js';
import { ownerWalletPlanSchema, ownerWalletTrustSchema } from '../src/deployment/owner-wallet-types.js';
import { baseGasPriceOracle, ownerWalletOracleAbi } from '../src/deployment/owner-wallet-fees.js';
import { checkOwnerWalletReview, prepareOwnerWalletRequest } from '../src/deployment/owner-wallet-wallet.js';

const h = (x: string): `0x${string}` => `0x${x.repeat(64)}`;
const owner = '0xa67c6a174409b9b44e67d24cdd386a31d44edb1d' as const;
const signer = '0x87599dBF6f720DE7751E8CB2d36d4Ea96A4A1d38' as const;
const implementation = '0x1111111111111111111111111111111111111111' as const;
const now = 1_800_000_000_000;
let artifact: ContractArtifact;
beforeAll(() => { artifact = compileOwnerWalletArtifact(process.cwd()).artifact; }, 60_000);

function fixture() {
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [baseMainnetUsdc, signer, signer, owner] });
  const raw = { schemaVersion: 2, mode: 'unsigned-base-usdc-legacy-escrow', chainId: 8453,
    referenceBlock: '100', referenceHash: h('1'), reviewedAsset: { kind: 'circle_proxy', address: baseMainnetUsdc,
      proxyCodeHash: keccak256('0x6001'), implementation: { address: implementation, codeHash: keccak256('0x6002') },
      name: 'USD Coin', symbol: 'USDC', decimals: 6, version: '2' }, quoteSigner: signer, receiptSigner: signer, treasury: owner,
    predictedEscrowAddress: getContractAddress({ from: owner, nonce: 0n }), compiler: artifact.compiler,
    creationCodeHash: keccak256(data), artifactBytecodeHash: keccak256(artifact.bytecode),
    transaction: { from: owner, to: null, value: '0', data, nonce: 0, gas: '3600001', gasPrice: '2' },
    estimate: { gas: '3000000', mode: 'unmodified RPC estimate', gasLimitBufferPercent: 20 },
    funding: { nativeBalance: '1000000000000000000', bufferedCost: '7200002', sufficientForEstimate: true, relayNativeBalance: '0' },
    status: 'prepared; no transaction submitted' };
  const plan = ownerWalletPlanSchema.parse({ ...raw, reviewDigest: legacyDeploymentPlanDigest(raw) });
  const trust = ownerWalletTrustSchema.parse({ owner, signer, treasury: owner, planSha256: 'a'.repeat(64),
    reviewDigest: plan.reviewDigest, maxGas: '6000000', maxFeePerGasWei: '10', maxTotalGasBudgetWei: '100000000' });
  const state = { chainId: 8453, ownerCode: '0x', targetCode: '0x', nonce: 0, balance: 10n ** 18n,
    proxy: '0x6001', implementation: '0x6002', slot: padHex(implementation, { size: 32 }),
    metadata: 'USD Coin', hash: h('1'), gas: 3_000_000n, fee: 2n, l1Fee: 100n, operatorFee: 20n, oracleAvailable: true };
  const calls: string[] = [];
  // REASON: this closed read-only fake implements every method exercised by the
  // real USDC verifier; absence of a financial sender is checked explicitly.
  const client = {
    getChainId: vi.fn(async () => { calls.push('getChainId'); return state.chainId; }),
    getBlock: vi.fn(async () => ({ number: 100n, hash: state.hash, timestamp: 1_800_000_000n })),
    getCode: vi.fn(async ({ address }: { address: string }) => address.toLowerCase() === owner.toLowerCase() ? state.ownerCode
      : address.toLowerCase() === plan.predictedEscrowAddress.toLowerCase() ? state.targetCode
      : address.toLowerCase() === baseMainnetUsdc.toLowerCase() ? state.proxy : state.implementation),
    getStorageAt: vi.fn(async () => state.slot),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getL1FeeUpperBound' || functionName === 'getOperatorFee') {
        if (!state.oracleAvailable) throw new Error('Base fee oracle unavailable');
        return functionName === 'getL1FeeUpperBound' ? state.l1Fee : state.operatorFee;
      }
      const values: Record<string, unknown> = { name: state.metadata, symbol: 'USDC', version: '2', decimals: 6,
        DOMAIN_SEPARATOR: domainSeparator({ domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: baseMainnetUsdc } }) };
      return values[functionName];
    }),
    getTransactionCount: vi.fn(async () => state.nonce), getBalance: vi.fn(async () => state.balance),
    estimateGas: vi.fn(async (_input?: unknown) => state.gas), estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: state.fee, maxPriorityFeePerGas: 1n })),
  };
  const frozen: FrozenOwnerWalletDeployment = { plan, trust, assertUnchanged: vi.fn(async () => undefined) };
  return { raw, plan, trust, state, client, calls, frozen,
    review: () => reviewOwnerWalletDeployment(frozen, client as unknown as PublicClient, now) };
}

it('validates exact owner, dedicated signer, treasury, source, digest and constructor without a wallet or chain mutation', () => {
  const f = fixture(); expect(validateOwnerWalletPlan(f.plan, f.trust, artifact)).toEqual(f.plan);
  expect(f.plan.transaction.from).toBe(owner); // Original JSON case stays covered by its digest.
  expect(f.client.getChainId).not.toHaveBeenCalled();
});

it.each(['owner', 'signer', 'treasury', 'digest', 'chain', 'token', 'extra field'] as const)('rejects substituted %s before RPC access', field => {
  const f = fixture(), raw: Record<string, unknown> = structuredClone(f.plan);
  if (field === 'owner') raw.transaction = { ...f.plan.transaction, from: implementation };
  if (field === 'signer') raw.quoteSigner = implementation;
  if (field === 'treasury') raw.treasury = implementation;
  if (field === 'digest') raw.reviewDigest = h('2');
  if (field === 'chain') raw.chainId = 84532;
  if (field === 'token') raw.reviewedAsset = { ...f.plan.reviewedAsset, address: implementation };
  if (field === 'extra field') raw.privateKey = h('2');
  expect(() => validateOwnerWalletPlan(raw, f.trust, artifact)).toThrow(); expect(f.client.getChainId).not.toHaveBeenCalled();
});

it('rejects arbitrary initcode even when its attacker recomputes the complete plan digest and creation hash', () => {
  const f = fixture(), changed = { ...f.plan, transaction: { ...f.plan.transaction, data: '0x6000' }, creationCodeHash: keccak256('0x6000') };
  const digest = legacyDeploymentPlanDigest(changed);
  expect(() => validateOwnerWalletPlan({ ...changed, reviewDigest: digest }, { ...f.trust, reviewDigest: digest }, artifact)).toThrow('creation bytes changed');
});

it('rechecks an actual frozen file and compiler inputs, and refuses an altered plan after startup', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'telomere-owner-review-'));
  try {
    const path = join(directory, 'plan.json'), bytes = Buffer.from(JSON.stringify(f.plan)); await writeFile(path, bytes, { mode: 0o600 });
    const frozen = await loadFrozenOwnerWalletDeployment(path, { ...f.trust, planSha256: createHash('sha256').update(bytes).digest('hex') }, process.cwd());
    await expect(frozen.assertUnchanged()).resolves.toBeUndefined(); await writeFile(path, JSON.stringify({ ...f.plan, status: 'replaced' }));
    await expect(frozen.assertUnchanged()).rejects.toThrow('plan file changed');
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('telomere-owner-review-')) throw new Error('Unsafe owner review fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('performs current canonical USDC, EOA, nonce, vacancy and bounded gas review with no financial port', async () => {
  const f = fixture(), review = await f.review();
  expect(review).toMatchObject({ status: 'ready_for_owner_wallet', transactionsSent: 0, ownerKeysLoaded: false,
    gas: { estimated: '3000000', limit: '3600001', l2GasBudgetWei: '7200002', l1DataFeeUpperBoundWei: '100',
      operatorFeeWei: '20', totalGasBudgetWei: '7200122', includesL1DataFee: true, futureL1FeeHardCap: false } });
  expect(checkOwnerWalletReview(review, f.plan.reviewDigest, now)).toEqual(review);
  expect(Object.keys(f.client)).not.toContain('sendRawTransaction'); expect(Object.keys(f.client)).not.toContain('signTransaction');
});

it.each(['chain', 'owner code', 'occupied target', 'nonce', 'proxy code', 'implementation code', 'implementation slot', 'metadata', 'canonical block', 'gas', 'fee'] as const)
('refuses fresh %s drift without signing or sending', async field => {
  const f = fixture();
  if (field === 'chain') f.state.chainId = 84532;
  if (field === 'owner code') f.state.ownerCode = '0x6000';
  if (field === 'occupied target') f.state.targetCode = '0x6000';
  if (field === 'nonce') f.state.nonce = 1;
  if (field === 'proxy code') f.state.proxy = '0x6003';
  if (field === 'implementation code') f.state.implementation = '0x6003';
  if (field === 'implementation slot') f.state.slot = h('2');
  if (field === 'metadata') f.state.metadata = 'USDC';
  if (field === 'canonical block') f.state.hash = h('2');
  if (field === 'gas') f.state.gas = 6_000_000n;
  if (field === 'fee') f.state.fee = 11n;
  await expect(f.review()).rejects.toThrow();
});

it('shows an unfunded read-only estimate but refuses to prepare any wallet action', async () => {
  const f = fixture(); f.state.balance = 0n;
  f.client.estimateGas.mockRejectedValueOnce(new Error('insufficient funds'));
  const review = await f.review();
  expect(review).toMatchObject({ status: 'awaiting_base_eth', gas: { balanceOverrideUsed: true, nativeBalanceWei: '0' } });
  expect(f.client.estimateGas.mock.calls[1]?.[0]).toMatchObject({ stateOverride: [{ address: owner, balance: 10n ** 18n }] });
  expect(() => checkOwnerWalletReview(review, f.plan.reviewDigest, now)).toThrow('funding');
});

it('requires funding for every Base fee component, not only the L2 gas budget', async () => {
  const f = fixture(); f.state.balance = 7_200_003n;
  const review = await f.review();
  expect(review.status).toBe('awaiting_base_eth');
  expect(() => checkOwnerWalletReview(review, f.plan.reviewDigest, now)).toThrow('funding');
  expect(() => checkOwnerWalletReview({ ...review, status: 'ready_for_owner_wallet' }, f.plan.reviewDigest, now)).toThrow('funding');
});

it('refuses an unavailable oracle and any total fee over the explicit total review cap', async () => {
  const f = fixture(); f.state.oracleAvailable = false;
  await expect(f.review()).rejects.toThrow('oracle unavailable');
  const excessive = fixture(); excessive.state.l1Fee = 100_000_000n;
  await expect(excessive.review()).rejects.toThrow('total Base fee');
});

it('rejects a nonce which changes after the expensive estimate and rechecks source immutability', async () => {
  const f = fixture(); f.client.estimateGas.mockImplementationOnce(async () => { f.state.nonce = 1; return f.state.gas; });
  await expect(f.review()).rejects.toThrow('nonce changed during review');
  const stable = fixture(); await stable.review(); expect(stable.frozen.assertUnchanged).toHaveBeenCalledTimes(2);
});

const metadataAbi = parseAbi(['function name() view returns(string)', 'function symbol() view returns(string)',
  'function version() view returns(string)', 'function decimals() view returns(uint8)', 'function DOMAIN_SEPARATOR() view returns(bytes32)']);
function wallet(f: ReturnType<typeof fixture>) {
  const methods: string[] = [], functions = ['name', 'symbol', 'version', 'decimals', 'DOMAIN_SEPARATOR'] as const;
  // REASON: a synthetic read-only EIP-1193 endpoint returns exact wire RPC values.
  const provider = { request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    methods.push(method);
    if (method === 'eth_accounts') return [owner];
    if (method === 'eth_chainId') return toHex(f.state.chainId);
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: f.state.hash, timestamp: toHex(1_800_000_000),
      baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', difficulty: '0x0', totalDifficulty: '0x0', size: '0x0', transactions: [] };
    if (method === 'eth_getCode') return f.client.getCode({ address: String(params?.[0]) });
    if (method === 'eth_getStorageAt') return f.state.slot;
    if (method === 'eth_getTransactionCount') return toHex(f.state.nonce);
    if (method === 'eth_getBalance') return toHex(f.state.balance);
    if (method === 'eth_estimateGas') return toHex(f.state.gas);
    if (method === 'eth_call') {
      const input = params?.[0]; if (!input || typeof input !== 'object' || !('data' in input)) throw new Error('Invalid fake call');
      if ('to' in input && String(input.to).toLowerCase() === baseGasPriceOracle.toLowerCase()) {
        if (typeof input.data !== 'string' || !input.data.startsWith('0x')) throw new Error('Invalid oracle calldata');
        // REASON: wire calldata is decoded by the exact fixed oracle ABI.
        const decoded = decodeFunctionData({ abi: ownerWalletOracleAbi, data: input.data as `0x${string}` });
        const value = await f.client.readContract({ functionName: decoded.functionName });
        return encodeFunctionResult({ abi: ownerWalletOracleAbi, functionName: decoded.functionName, result: value as bigint });
      }
      for (const functionName of functions) {
        const selector = keccak256(new TextEncoder().encode(functionName + '()')).slice(0, 10);
        if (String(input.data).startsWith(selector)) {
          const value = await f.client.readContract({ functionName });
          // REASON: function names and result values above are the complete fixed metadata ABI.
          return encodeFunctionResult({ abi: metadataAbi, functionName, result: value as never });
        }
      }
    }
    throw new Error('Unexpected wallet method: ' + method);
  }) } as unknown as EIP1193Provider;
  return { provider, methods };
}

it('independently prepares exact creation calldata using only wallet read methods; no signature, account request or send', async () => {
  const f = fixture(), review = await f.review(), w = wallet(f);
  const transaction = await prepareOwnerWalletRequest(review, w.provider, f.plan.reviewDigest, () => now);
  expect(transaction).toMatchObject({ from: owner, chainId: '0x2105', nonce: '0x0', value: '0x0', data: f.plan.transaction.data });
  expect(transaction).not.toHaveProperty('to');
  expect(w.methods.some(method => /send|sign|requestAccounts/i.test(method))).toBe(false);
});

it.each(['wallet chain', 'wallet nonce', 'wallet proxy', 'expired', 'changed digest', 'changed creation'] as const)
('refuses %s before any financial wallet request', async field => {
  const f = fixture(), review = structuredClone(await f.review()), w = wallet(f);
  if (field === 'wallet chain') f.state.chainId = 84532;
  if (field === 'wallet nonce') f.state.nonce = 1;
  if (field === 'wallet proxy') f.state.proxy = '0x6003';
  if (field === 'expired') review.expiresAtMs = now;
  if (field === 'changed digest') review.plan.reviewDigest = h('2');
  if (field === 'changed creation') review.plan.transaction.data = '0x6000';
  await expect(prepareOwnerWalletRequest(review, w.provider, f.plan.reviewDigest, () => now)).rejects.toThrow();
  expect(w.methods.some(method => /send|sign/i.test(method))).toBe(false);
});

it.each(['balance only covers L2', 'fresh L1 fee increases', 'fresh operator fee increases', 'oracle unavailable'] as const)
('refuses %s in the independent wallet preflight without a financial request', async field => {
  const f = fixture(), review = await f.review(), w = wallet(f);
  if (field === 'balance only covers L2') f.state.balance = 7_200_003n;
  if (field === 'fresh L1 fee increases') f.state.l1Fee++;
  if (field === 'fresh operator fee increases') f.state.operatorFee++;
  if (field === 'oracle unavailable') f.state.oracleAvailable = false;
  await expect(prepareOwnerWalletRequest(review, w.provider, f.plan.reviewDigest, () => now)).rejects.toThrow();
  expect(w.methods.some(method => /send|sign/i.test(method))).toBe(false);
});

it('serves an inert review page and refuses financial endpoints, cross-origin and unauthenticated review requests', async () => {
  const f = fixture(), review = await f.review(), reader = vi.fn(async () => review), token = randomBytes(32).toString('hex');
  const port = await unusedLocalPort(), origin = 'http://127.0.0.1:' + port;
  const server = createOwnerWalletReviewServer({ frozen: f.frozen, origin, javascript: new Uint8Array([47, 47]), review: reader, token });
  await new Promise<void>(resolveListening => server.listen(port, '127.0.0.1', resolveListening));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server missing');
  const url = 'http://127.0.0.1:' + address.port, host = { host: '127.0.0.1:' + address.port };
  try {
    const page = await fetch(url, { headers: host }); expect(page.status).toBe(200);
    expect(await page.text()).toContain('No wallet request or financial transaction');
    expect(reader).not.toHaveBeenCalled();
    expect((await fetch(url + '/api/plan', { headers: host }).then(response => response.json())).plan.reviewDigest).toBe(f.plan.reviewDigest);
    for (const path of ['/api/send', '/api/sign', '/api/broadcast', '/api/review']) {
      expect((await fetch(url + path, { method: 'POST', headers: host, body: '{}' })).status).toBe(path === '/api/review' ? 403 : 404);
    }
    const headers = { ...host, origin: 'https://attacker.test', 'content-type': 'application/json', 'x-deployment-review': token };
    expect((await fetch(url + '/api/review', { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect(reader).not.toHaveBeenCalled();
    const response = await fetch(url + '/api/review', { method: 'POST', headers: { ...headers, origin }, body: '{}' });
    expect(response.status).toBe(200); expect(reader).toHaveBeenCalledTimes(1);
    expect((await fetch(url + '/api/review', { method: 'POST', headers: { ...headers, origin }, body: '{}' })).status).toBe(429);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

it('builds the keyless browser in memory with no external resource dependency or owner private-key module', async () => {
  const result = await build({ entryPoints: ['src/deployment/owner-wallet-browser.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  expect(result.outputFiles[0]!.contents.length).toBeLessThan(2_097_152);
  const source = await readFile('src/deployment/owner-wallet-browser.ts', 'utf8');
  expect(source).toContain('navigator.locks.request'); expect(source).toContain('localStorage.setItem(journalKey');
  expect(source.indexOf("localStorage.setItem(journalKey")).toBeLessThan(source.indexOf("method: 'eth_sendTransaction'"));
});
