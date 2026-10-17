import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import solc from 'solc';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, domainSeparator, encodeFunctionData,
  getAddress, getContractAddress, http, keccak256, maxUint256, parseAbi, parseEther, parseTransaction,
  recoverTransactionAddress, type Abi, type Address, type Hex, type PublicClient,
  type TransactionReceipt, type TransactionSerialized } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { requestBinding, type PaymentPayload } from '../src/payments/protocol.js';
import { canonical } from '../src/common.js';
import { EIP3009_TYPES, type PaymentChain } from '../src/payments/gateway.js';
import { EvmVaultIncomeChain, validateVaultIncomeReceipt, vaultIncomeAuthorizationRef, type VaultIncomePins } from '../src/payments/vault-income-chain.js';
import { X402PaymentService } from '../src/payments/service.js';
import { paymentJournal } from '../src/payments/schema.js';
import { baseSepolia, baseSepoliaUsdc } from '../src/chain/chains.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT, matchesNativeBaseUsdcMetadata } from '../src/payments/circle-usdc.js';
import { assertCircleUsdcArchiveHistory } from '../src/payments/circle-usdc-archive.js';
import { assertForkMutationTarget } from '../src/operator/fork-guard.js';
import { openStore } from '../src/store.js';
import { unusedLocalPort } from './local-chain.js';
import type { ContractArtifact } from './compile-contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = baseSepolia.rpcUrls.default.http[0];
const token: Address = baseSepoliaUsdc;
// Observed on 2026-10-14; fork acceptance pins are not production role/code approval.
const historicalSourceBlock = { number: 48080303n,
  hash: '0x4e06d144fc22ebf92b20d04b5ba5141d0163e8ff7da3af648a74b201c9730a1e' as Hex,
  timestamp: 1791928894n };
const proxyHash: Hex = '0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c';
const implementation: Address = '0xd74cc5d436923b8ba2c179b4bCA2841D8A52C5B5';
const implementationHash: Hex = '0x1254951e5483b882fd5def9452f58fe786eb3380c0bf9bb2744fa21a0a97a16c';
const slot: Hex = CIRCLE_PROXY_IMPLEMENTATION_SLOT;
const publicMethods = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt', 'eth_getProof', 'eth_call',
  'eth_gasPrice', 'eth_getTransactionReceipt', 'eth_getAccountInfo', 'eth_getLogs']);
const tokenAbi = parseAbi(['function name() view returns(string)', 'function symbol() view returns(string)', 'function version() view returns(string)',
  'function decimals() view returns(uint8)', 'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function balanceOf(address) view returns(uint256)',
  'function authorizationState(address,bytes32) view returns(bool)', 'function approve(address,uint256) returns(bool)', 'function transfer(address,uint256) returns(bool)',
  'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)']);
const vaultAbi = parseAbi(['function receiveFundsWithAuthorization(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
  'function usedIncomeAuthorization(bytes32) view returns(bool)']);
const randomId = (): Hex => `0x${randomBytes(32).toString('hex')}`;
function requireFact(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
type Account = ReturnType<typeof privateKeyToAccount>;
type Agent = { vault: Address; lifetimeIncome: bigint; lifetimeIncomeFees: bigint; lifetimeSubsidy: bigint };
type RpcRequest = { jsonrpc: '2.0'; id: number | string; method: string; params?: unknown[] };
type SafeReport = { version: 1; checkedAt: string; success: boolean; stage: string; failureCode?: string;
  failureType?: string; failureDetail?: string; failureCauses?: Array<{ name: string; code?: number }>;
  source: Record<string, unknown>; cases: Record<string, unknown>; isolation: Record<string, unknown>; history: Array<{ stage: string; at: string }> };

function artifacts(): Record<string, ContractArtifact> {
  const names = ['PlatformAgentVault.sol', 'PlatformSelectionRegistry.sol', 'PlatformRunEscrow.sol', 'HostRegistry.sol',
    'ReceiptRoot.sol', 'FeeRouter.sol', 'TlmrToken.sol', 'TlmrStaking.sol'];
  const sources: Record<string, { content: string }> = {};
  for (const name of names) sources['contracts/' + name] = { content: readFileSync(resolve(root, 'contracts', name), 'utf8') };
  sources['ForkOnlyIdentity.sol'] = { content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
// Disposable fork ownerOf adapter; no canonical ERC-8004 claim.
contract ForkOnlyIdentity { mapping(uint256 => address) public ownerOf;
 constructor() { require(block.chainid == 84532); }
 function register(uint256 id, address owner) external { require(owner != address(0) && ownerOf[id] == address(0)); ownerOf[id] = owner; }
}` };
  const raw = solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), {
    import: (path: string) => path.startsWith('@openzeppelin/contracts/') && !path.includes('..')
      ? { contents: readFileSync(resolve(root, 'node_modules', path), 'utf8') } : { error: 'Unsupported isolated compiler import' },
  });
  requireFact(Buffer.byteLength(raw) < 8_388_608, 'compile_output_bound');
  const compiled = JSON.parse(raw) as { errors?: Array<{ severity: string }>; contracts: Record<string,
    Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>> };
  requireFact(!compiled.errors?.some(error => error.severity === 'error'), 'compile_failed');
  const result: Record<string, ContractArtifact> = {};
  for (const file of Object.values(compiled.contracts)) for (const [name, item] of Object.entries(file)) result[name] = {
    contractName: name, compiler: solc.version(), abi: item.abi, bytecode: `0x${item.evm.bytecode.object}`, deployedBytecode: `0x${item.evm.deployedBytecode.object}` };
  return result;
}
function anvilBinary(): string {
  const platform = process.platform === 'win32' ? 'win32-amd64' : process.platform === 'linux' ? 'linux-amd64' : '';
  const name = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const binary = [resolve(root, `node_modules/@foundry-rs/anvil-${platform}/bin`, name), resolve(root, `node_modules/@foundry-rs/anvil-${platform}`, name)]
    .find(path => existsSync(path)); requireFact(binary && platform && process.arch === 'x64', 'isolated_anvil_unavailable'); return binary;
}

/** Generated accounts and local-fork mutations only. Public upstream is routed
 * through an explicit readonly RPC allowlist, including Anvil's lazy fork reads. */
export async function runUsdcVaultForkAcceptance(): Promise<SafeReport> {
  const report: SafeReport = { version: 1, checkedAt: new Date().toISOString(), success: false, stage: 'arguments', source: {}, cases: {},
    isolation: { publicTransactionsSubmitted: false, generatedFixtureAccountsOnly: true, mainConfigurationChanged: false,
      sdkRawTransactionFallbackUsed: false, canonicalIdentityRegistryClaimed: false }, history: [] };
  let child: ChildProcess | undefined, relay: Server | undefined, store: Awaited<ReturnType<typeof openStore>> | undefined;
  let sourceBlock: { number: bigint; hash: Hex } = { number: historicalSourceBlock.number,
    hash: historicalSourceBlock.hash };
  let localPort = 0, publicCalls = 0, mutationCalls = 0, cleanupConfirmed = false, relayClosed = false, storeClosed = false;
  const started = Date.now(), controller = new AbortController(), methods: Record<string, number> = {};
  const relayRejectedMethods: Record<string, number> = {}, publicRpcErrors: Array<{ method: string; code: number }> = [];
  const anvilLog: Buffer[] = []; let anvilLogBytes = 0, anvilLogOverflow = false;
  const timer = setTimeout(() => { controller.abort(); child?.kill('SIGTERM'); }, 600_000);
  const localDirectory = resolve(root, '.local'); await mkdir(localDirectory, { recursive: true });
  const directory = await mkdtemp(join(localDirectory, 'usdc-vault-fork-'));
  const progress = (stage: string) => { requireFact(Date.now() - started < 600_000 && !controller.signal.aborted, 'acceptance_deadline');
    report.stage = stage; report.history.push({ stage, at: new Date().toISOString() }); };
  async function boundedJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    requireFact(response.ok && response.body, 'readonly_http_unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length;
      requireFact(size <= 1_048_576, 'readonly_response_bound'); chunks.push(item.value); } }
    finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  }
  async function publicRpc(request: RpcRequest | RpcRequest[]): Promise<unknown> {
    const batch = Array.isArray(request) ? request : [request];
    for (const item of batch.slice(0, 16)) if (item && typeof item.method === 'string' && !publicMethods.has(item.method)) {
      const method = /^[a-zA-Z0-9_]{1,64}$/.test(item.method) ? item.method : 'invalid_method';
      relayRejectedMethods[method] = (relayRejectedMethods[method] ?? 0) + 1;
    }
    requireFact(batch.length > 0 && batch.length <= 16 && batch.every(item => item && item.jsonrpc === '2.0'
      && publicMethods.has(item.method) && (item.params === undefined || Array.isArray(item.params))) && publicCalls + batch.length <= 1500,
    'public_readonly_method_or_count');
    for (const item of batch) { publicCalls++; methods[item.method] = (methods[item.method] ?? 0) + 1; }
    const result = await boundedJson(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    for (const reply of Array.isArray(result) ? result : [result]) if (reply && typeof reply === 'object' && 'error' in reply) {
      const error = (reply as { error?: { code?: unknown } }).error;
      if (typeof error?.code === 'number' && publicRpcErrors.length < 32) publicRpcErrors.push({ method: batch.find(item => item.id === reply.id)?.method ?? 'unknown', code: error.code });
    }
    return result;
  }
  const state: { blockHash: Hex; requireCanonical: true } = { blockHash: sourceBlock.hash, requireCanonical: true };
  async function checkedSource(client: PublicClient): Promise<void> {
    const block = await client.getBlock({ blockNumber: sourceBlock.number });
    requireFact(block.hash === sourceBlock.hash && await client.getChainId() === 84532, 'canonical_source_mismatch');
    const [proxy, impl, stored, name, symbol, version, decimals, separator, nativeMetadata] = await Promise.all([
      client.getCode({ address: token, ...state }), client.getCode({ address: implementation, ...state }),
      client.getStorageAt({ address: token, slot, ...state }), client.readContract({ address: token, abi: tokenAbi, functionName: 'name', ...state }),
      client.readContract({ address: token, abi: tokenAbi, functionName: 'symbol', ...state }),
      client.readContract({ address: token, abi: tokenAbi, functionName: 'version', ...state }),
      client.readContract({ address: token, abi: tokenAbi, functionName: 'decimals', ...state }),
      client.readContract({ address: token, abi: tokenAbi, functionName: 'DOMAIN_SEPARATOR', ...state }),
      matchesNativeBaseUsdcMetadata(client, 84532, token, state),
    ]);
    requireFact(proxy && impl && stored && keccak256(proxy) === proxyHash && keccak256(impl) === implementationHash
      && getAddress(`0x${stored.slice(-40)}`).toLowerCase() === implementation.toLowerCase()
      && name === 'USDC' && symbol === 'USDC' && version === '2' && decimals === 6 && nativeMetadata
      && separator === domainSeparator({ domain: { name: 'USDC', version: '2', chainId: 84532,
        verifyingContract: token } }), 'canonical_asset_pin_mismatch');
    requireFact((await client.getBlock({ blockNumber: sourceBlock.number })).hash === sourceBlock.hash, 'canonical_source_reorg');
  }
  const ensureLocal = () => { requireFact(!controller.signal.aborted, 'acceptance_deadline'); assertForkMutationTarget(`http://127.0.0.1:${localPort}`,
    { pid: child?.pid, port: localPort, exited: !child || child.exitCode !== null || child.signalCode !== null }); };
  try {
    progress('compile_readonly_sources'); const compiled = artifacts();
    const artifact = (name: string) => { const value = compiled[name]; requireFact(value, 'missing_fixture_artifact'); return value; };
    progress('public_readonly_pins');
    const publicClient = createPublicClient({ chain: baseSepolia, cacheTime: 0, transport: http(upstream, { retryCount: 0, timeout: 10_000,
      fetchFn: async (_input, init) => { const response = await publicRpc(JSON.parse(String(init?.body)) as RpcRequest);
        return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }); } }) });
    const selectionHead = await publicClient.getBlockNumber();
    requireFact(selectionHead > 3n, 'source_confirmation_depth_unavailable');
    const selected = await publicClient.getBlock({ blockNumber: selectionHead - 3n });
    requireFact(selected.hash && selected.number === selectionHead - 3n, 'source_block_selection_unavailable');
    sourceBlock = { number: selected.number, hash: selected.hash }; state.blockHash = selected.hash;
    report.source = { chainId: 84532, blockNumber: sourceBlock.number.toString(), blockHash: sourceBlock.hash,
      selectionHead: selectionHead.toString(), confirmationDepthAtSelection: 3,
      historicalObservedBlock: { number: historicalSourceBlock.number.toString(), hash: historicalSourceBlock.hash,
        timestamp: historicalSourceBlock.timestamp.toString(), independentApproval: false } };
    await checkedSource(publicClient);
    await assertCircleUsdcArchiveHistory(publicClient, { chainId: 84532, asset: token, tokenCodeHash: proxyHash,
      assetImplementation: { address: implementation, codeHash: implementationHash },
      archiveAnchor: { number: historicalSourceBlock.number.toString(), hash: historicalSourceBlock.hash,
        timestamp: historicalSourceBlock.timestamp.toString() } });
    const holders = await boundedJson(`https://base-sepolia.blockscout.com/api/v2/tokens/${token}/holders`) as {
      items?: Array<{ address?: { hash?: string }; value?: string }> };
    requireFact(Array.isArray(holders.items) && holders.items.length <= 100, 'holder_discovery_unavailable');
    let holder: Address | undefined;
    for (const item of holders.items.slice(0, 10)) {
      if (!item.address?.hash || !/^0x[0-9a-fA-F]{40}$/.test(item.address.hash) || !item.value || !/^\d{1,78}$/.test(item.value) || BigInt(item.value) < 10_000_000n) continue;
      const candidate = getAddress(item.address.hash);
      if (await publicClient.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [candidate], ...state }) >= 10_000_000n) { holder = candidate; break; }
    }
    requireFact(holder, 'pinned_holder_funding_unavailable');
    report.source = { ...report.source, token, proxyCodeHash: proxyHash,
      implementation, implementationCodeHash: implementationHash, circleProxySlot: slot,
      eip1898Checked: true, archiveCandidateChecked: true, domain: { name: 'USDC', version: '2' },
      pinnedHolderAvailable: true, productionPinsApproved: false };
    progress('isolated_readonly_relay');
    relay = createServer((request, response) => { void (async () => {
      requireFact(request.method === 'POST' && request.url === '/', 'relay_request_rejected');
      const chunks: Buffer[] = []; let size = 0;
      for await (const item of request) { size += item.length; requireFact(size <= 262_144, 'relay_body_bound'); chunks.push(Buffer.from(item)); }
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as RpcRequest | RpcRequest[];
      const result = await publicRpc(parsed); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    })().catch(() => { response.statusCode = 502; response.end('{"error":"readonly_fork_upstream_unavailable"}'); }); });
    relay.requestTimeout = 15_000; relay.headersTimeout = 10_000; relay.maxRequestsPerSocket = 100;
    await new Promise<void>(yes => relay!.listen(0, '127.0.0.1', yes)); const relayAddress = relay.address();
    requireFact(relayAddress && typeof relayAddress !== 'string', 'relay_loopback_unavailable');
    progress('isolated_fork_start');
    do { localPort = await unusedLocalPort(); } while ([3280, 3281, 13280, 15434, 18547, 8547, relayAddress.port].includes(localPort));
    const rpcUrl = `http://127.0.0.1:${localPort}`;
    child = spawn(anvilBinary(), ['--host', '127.0.0.1', '--port', String(localPort), '--chain-id', '84532', '--accounts', '0',
      '--fork-url', `http://127.0.0.1:${relayAddress.port}`, '--fork-block-number', sourceBlock.number.toString()], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RUST_LOG: 'anvil=debug' } });
    const appendAnvilLog = (chunk: Buffer) => { if (anvilLogBytes + chunk.length > 1_048_576) { anvilLogOverflow = true; child?.kill('SIGTERM'); return; }
      anvilLog.push(Buffer.from(chunk)); anvilLogBytes += chunk.length; };
    child.stdout?.on('data', appendAnvilLog); child.stderr?.on('data', appendAnvilLog);
    let spawnFailed = false; child.once('error', () => { spawnFailed = true; });
    const localFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requireFact(new URL(url).href === rpcUrl + '/', 'local_transport_target_mismatch'); ensureLocal();
      const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
      const batch = Array.isArray(body) ? body : [body];
      if (batch.some(item => /^(anvil_|evm_|eth_send)/.test(item.method))) { mutationCalls++; ensureLocal(); }
      return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    };
    const transport = http(rpcUrl, { retryCount: 0, timeout: 10_000, fetchFn: localFetch });
    const client = createPublicClient({ chain: baseSepolia, cacheTime: 0, transport }), test = createTestClient({ chain: baseSepolia, mode: 'anvil', transport });
    const readyUntil = Date.now() + 30_000;
    while (true) {
      requireFact(!spawnFailed && child.exitCode === null && child.signalCode === null, 'fork_start_failed');
      try { if (await client.getChainId() === 84532) break; } catch { /* Explicit owned-child read-only startup probe. */ }
      requireFact(Date.now() < readyUntil, 'fork_start_timeout'); await delay(100);
    }
    await checkedSource(client);
    await assertCircleUsdcArchiveHistory(client, { chainId: 84532, asset: token, tokenCodeHash: proxyHash,
      assetImplementation: { address: implementation, codeHash: implementationHash },
      archiveAnchor: { number: historicalSourceBlock.number.toString(), hash: historicalSourceBlock.hash,
        timestamp: historicalSourceBlock.timestamp.toString() } });
    const accounts = { owner: privateKeyToAccount(generatePrivateKey()), facilitator: privateKeyToAccount(generatePrivateKey()), payer: privateKeyToAccount(generatePrivateKey()),
      guardian: privateKeyToAccount(generatePrivateKey()), treasury: privateKeyToAccount(generatePrivateKey()), agent: privateKeyToAccount(generatePrivateKey()),
      frontRunner: privateKeyToAccount(generatePrivateKey()) };
    const wallet = (account: Account) => createWalletClient({ account, chain: baseSepolia, transport });
    for (const account of Object.values(accounts)) { ensureLocal(); await test.setBalance({ address: account.address, value: parseEther('10') }); }
    const confirmed = async (operation: Promise<Hex>, expected: 'success' | 'reverted' = 'success'): Promise<TransactionReceipt> => {
      const hash = await operation; let receipt: TransactionReceipt;
      try {
        const until = Date.now() + 20_000;
        while (true) {
          ensureLocal();
          try {
            receipt = await client.getTransactionReceipt({ hash });
            requireFact(receipt.transactionHash === hash && (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash
              && await client.getBlockNumber({ cacheTime: 0 }) >= receipt.blockNumber, 'local_receipt_canonical_mismatch');
            break;
          } catch (error) {
            if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') throw error;
            requireFact(Date.now() < until, 'local_receipt_poll_timeout'); await delay(100);
          }
        }
      }
      catch (error) {
        const diagnostics = await Promise.allSettled([client.getTransaction({ hash }), client.getBlock(), client.getTransactionReceipt({ hash }),
          client.request({ method: 'txpool_status' as never, params: [] as never })]);
        await writeFile(join(directory, 'local-transaction-diagnostic.json'), JSON.stringify({ hash,
          results: diagnostics.map(item => item.status === 'fulfilled' ? { status: item.status, value: item.value }
            : { status: item.status, name: item.reason instanceof Error ? item.reason.name : 'Error',
              code: item.reason && typeof item.reason.code === 'number' ? item.reason.code : undefined }) }, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { mode: 0o600 });
        throw error;
      }
      requireFact(receipt.status === expected, 'local_receipt_status_mismatch'); return receipt;
    };
    const write = (address: Address, name: string, functionName: string, args: readonly unknown[] = [], account = accounts.owner) => {
      ensureLocal(); return confirmed(wallet(account).writeContract({ address, abi: artifact(name).abi, functionName, args }));
    };
    const deploy = async (name: string, args: readonly unknown[] = []): Promise<Address> => {
      ensureLocal(); const value = artifact(name), receipt = await confirmed(wallet(accounts.owner).deployContract({ abi: value.abi, bytecode: value.bytecode, args }));
      requireFact(receipt.contractAddress, 'local_deployment_missing'); return receipt.contractAddress;
    };
    const tokenBalance = (address: Address) => client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
    progress('fork_only_holder_set_balance'); ensureLocal(); await test.setBalance({ address: holder, value: parseEther('10') });
    progress('fork_only_holder_impersonation');
    ensureLocal(); await test.impersonateAccount({ address: holder });
    try {
      const holderWallet = createWalletClient({ account: holder, chain: baseSepolia, transport });
      for (const [index, target] of [accounts.owner.address, accounts.payer.address].entries()) { progress(`fork_only_holder_transfer_${index}`); ensureLocal();
        await confirmed(holderWallet.writeContract({ address: token, abi: tokenAbi, functionName: 'transfer', args: [target, 5_000_000n] }));
        requireFact(await tokenBalance(target) === 5_000_000n, 'canonical_funding_delta_mismatch'); }
    } finally { ensureLocal(); await test.stopImpersonatingAccount({ address: holder }); }
    progress('fork_real_platform_deployment');
    const signerSet = await deploy('SignerSet', [accounts.owner.address, accounts.facilitator.address]), receiptRoot = await deploy('ReceiptRoot', [signerSet]);
    const next = await client.getTransactionCount({ address: accounts.owner.address });
    const expectedEscrow = getContractAddress({ from: accounts.owner.address, nonce: BigInt(next + 2) });
    const hostRegistry = await deploy('HostRegistry', [token, expectedEscrow, accounts.owner.address, accounts.owner.address, receiptRoot]);
    const feeRouter = await deploy('FeeRouter', [token, expectedEscrow, accounts.owner.address, accounts.treasury.address, accounts.owner.address, accounts.owner.address]);
    const escrow = await deploy('PlatformRunEscrow', [{ token, quoteSigner: accounts.facilitator.address, receiptRoot, hostRegistry, feeRouter, guardian: accounts.guardian.address }]);
    requireFact(escrow.toLowerCase() === expectedEscrow.toLowerCase(), 'escrow_nonce_prediction_mismatch');
    const identity = await deploy('ForkOnlyIdentity'), utility = await deploy('TlmrToken', [accounts.owner.address, parseEther('1000000')]), staking = await deploy('TlmrStaking', [utility]);
    const registry = await deploy('PlatformSelectionRegistry', [{ token, escrow, controller: accounts.facilitator.address, guardian: accounts.guardian.address,
      identityRegistry: identity, staking, treasury: accounts.treasury.address, entryFee: 100n, vaultFloor: 100n }]);
    await write(identity, 'ForkOnlyIdentity', 'register', [1n, accounts.owner.address]);
    ensureLocal(); await confirmed(wallet(accounts.owner).writeContract({ address: token, abi: tokenAbi, functionName: 'approve', args: [registry, maxUint256] }));
    await write(registry, 'PlatformSelectionRegistry', 'enter', [{ identityId: 1n, agentWallet: accounts.agent.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
      expiry: (await client.getBlock()).timestamp + 86_400n, cystHash: randomId(), endowment: 1_000_000n,
      scope: { classMask: 1n, sealedOnly: false, imageAllowRoot: `0x${'0'.repeat(64)}`, regionAllowRoot: `0x${'0'.repeat(64)}` } }]);
    const agentId = await client.readContract({ address: registry, abi: artifact('PlatformSelectionRegistry').abi, functionName: 'identityAgent', args: [1n] }) as Hex;
    const getAgent = () => client.readContract({ address: registry, abi: artifact('PlatformSelectionRegistry').abi, functionName: 'getAgent', args: [agentId] }) as Promise<Agent>;
    const agent = await getAgent(), vaultImplementation = await client.readContract({ address: registry, abi: artifact('PlatformSelectionRegistry').abi, functionName: 'vaultImplementation' }) as Address;
    ensureLocal(); await test.mine({ blocks: 2 });
    const codeHash = async (address: Address) => { const code = await client.getCode({ address }); requireFact(code && code !== '0x', 'local_contract_code_missing'); return keccak256(code); };
    const pins: VaultIncomePins = { chainId: 84532, asset: token, tokenCodeHash: proxyHash, reviewedTokenKind: 'circle_proxy',
      assetImplementation: { address: implementation, codeHash: implementationHash },
      archiveAnchor: { number: historicalSourceBlock.number.toString(), hash: historicalSourceBlock.hash,
        timestamp: historicalSourceBlock.timestamp.toString() },
      payTo: agent.vault, facilitator: accounts.facilitator.address, confirmations: 1,
      exact: { reviewedEip3009: true, name: 'USDC', version: '2' }, agentId, treasury: accounts.treasury.address,
      selection: { chainId: 84532, selectionRegistryAddress: registry, selectionRegistryCodeHash: await codeHash(registry), vaultImplementationAddress: vaultImplementation,
        vaultImplementationCodeHash: await codeHash(vaultImplementation), confirmations: 1 } };
    const chain = new EvmVaultIncomeChain(client, wallet(accounts.facilitator), pins, { rpcUrl });
    let localClock = Number((await client.getBlock()).timestamp) * 1000;
    store = await openStore({ DATA_DIR: join(directory, 'journal') });
    let service = new X402PaymentService(store.db, chain, () => localClock); await service.initialize();
    const resource = { url: 'https://fork-only.telomere.invalid/native-income' }, requestHash = requestBinding('POST', resource.url, Buffer.from('canonical-usdc-fork-only'));
    const payment = async (account: Account, amount: string, target = service): Promise<PaymentPayload> => {
      const time = (await client.getBlock()).timestamp; localClock = Number(time) * 1000;
      const required = await target.challenge({ resource, requestHash, amount, scheme: 'exact' }), accepted = required.accepts[0]!;
      const authorization = { from: account.address, to: agent.vault, value: BigInt(amount), validAfter: time - 1n, validBefore: time + 240n, nonce: accepted.extra.telomere.nonce };
      const signature = await account.signTypedData({ domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: token },
        types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: authorization });
      return { x402Version: 2, resource, accepted, payload: { signature, authorization: { ...authorization, value: amount,
        validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString() } } };
    };
    const settleTerminal = async (value: PaymentPayload, amount: string, target = service) => {
      const until = Date.now() + 25_000; let candidate: string | undefined;
      while (true) {
        const result = await target.settle(value, { amount, requestHash });
        if (result.transaction) { requireFact(!candidate || candidate === result.transaction, 'settlement_candidate_changed'); candidate = result.transaction; }
        if (result.success || result.errorReason !== 'settlement_pending') return result;
        requireFact(Date.now() < until, 'local_settlement_terminal_timeout'); await delay(100);
      }
    };
    const authorization = (value: PaymentPayload) => { requireFact('authorization' in value.payload, 'exact_authorization_required'); return value.payload.authorization; };
    const authArgs = (value: PaymentPayload) => { const auth = authorization(value), sig = value.payload.signature, byte = Number.parseInt(sig.slice(130, 132), 16);
      return [auth.from, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, byte < 27 ? byte + 27 : byte, `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`] as const; };
    const usedToken = (value: PaymentPayload) => { const auth = authorization(value); return client.readContract({ address: token, abi: tokenAbi, functionName: 'authorizationState', args: [auth.from, auth.nonce] }); };
    const usedVault = (value: PaymentPayload) => { const auth = authorization(value); return client.readContract({ address: agent.vault, abi: vaultAbi, functionName: 'usedIncomeAuthorization',
      args: [vaultIncomeAuthorizationRef(84532, token, agent.vault, auth.from, auth.nonce)] }); };
    const balances = async () => ({ payer: await tokenBalance(accounts.payer.address), owner: await tokenBalance(accounts.owner.address),
      vault: await tokenBalance(agent.vault), treasury: await tokenBalance(accounts.treasury.address) });
    progress('actual_external_income'); await checkedSource(client);
    const external = await payment(accounts.payer, '1000001'), before = await balances(), settled = await settleTerminal(external, '1000001');
    report.isolation.lastSettlement = { success: settled.success, ...(settled.errorReason ? { errorReason: settled.errorReason } : {}) };
    requireFact(settled.success && settled.transaction, 'external_income_not_settled');
    const receipt = await client.getTransactionReceipt({ hash: settled.transaction }); validateVaultIncomeReceipt(receipt, external, pins);
    const updated = await getAgent(), after = await balances();
    requireFact(updated.lifetimeIncome === 1_000_001n && updated.lifetimeIncomeFees === 10_001n && updated.lifetimeSubsidy === 1_000_000n
      && before.payer - after.payer === 1_000_001n && after.vault - before.vault === 990_000n && after.treasury - before.treasury === 10_001n
      && await usedToken(external) && await usedVault(external), 'external_income_conservation_mismatch');
    const income = receipt.logs.filter(log => log.address.toLowerCase() === registry.toLowerCase()).map(log => decodeEventLog({ abi: artifact('PlatformSelectionRegistry').abi, data: log.data, topics: log.topics }));
    requireFact(income.length === 1 && income[0]!.eventName === 'Income', 'external_income_classification_mismatch');
    report.cases.externalPayer = { success: true, gross: '1000001', fee: '10001', net: '990000', transaction: settled.transaction, canonicalReceiptValidated: true };
    progress('durable_exact_replay');
    const originalRows = await store.db.select().from(paymentJournal), original = originalRows[0]; requireFact(original?.raw && original.hash && original.nonce !== null, 'original_journal_missing');
    requireFact(keccak256(original.raw as Hex) === settled.transaction && parseTransaction(original.raw as Hex).chainId === 84532
      && (await recoverTransactionAddress({ serializedTransaction: original.raw as TransactionSerialized })).toLowerCase() === accounts.facilitator.address.toLowerCase(), 'original_signed_envelope_mismatch');
    const relayNonce = await client.getTransactionCount({ address: accounts.facilitator.address }), originalIdentity = canonical({ raw: original.raw, hash: original.hash, nonce: original.nonce, attemptHash: original.attemptHash });
    await store.close(); store = undefined; store = await openStore({ DATA_DIR: join(directory, 'journal') }); service = new X402PaymentService(store.db, chain, () => localClock); await service.initialize();
    const replay = await service.settle(external, { amount: '1000001', requestHash }), repeated = (await store.db.select().from(paymentJournal))[0]!;
    requireFact(replay.success && replay.transaction === settled.transaction && canonical(await balances()) === canonical(after)
      && await client.getTransactionCount({ address: accounts.facilitator.address }) === relayNonce
      && canonical({ raw: repeated.raw, hash: repeated.hash, nonce: repeated.nonce, attemptHash: repeated.attemptHash }) === originalIdentity, 'durable_original_replay_mismatch');
    report.cases.immutableReplay = { success: true, diskJournalReopened: true, sameSignedHashNonceBytes: true, secondTransfer: false };
    progress('actual_owner_subsidy'); await checkedSource(client);
    const subsidy = await payment(accounts.owner, '100001'), subsidyBefore = await balances(), subsidyReceipt = await settleTerminal(subsidy, '100001');
    requireFact(subsidyReceipt.success && subsidyReceipt.transaction, 'owner_subsidy_not_settled');
    validateVaultIncomeReceipt(await client.getTransactionReceipt({ hash: subsidyReceipt.transaction }), subsidy, pins);
    const subsidized = await getAgent(), subsidyAfter = await balances();
    requireFact(subsidized.lifetimeIncome === updated.lifetimeIncome && subsidized.lifetimeIncomeFees === updated.lifetimeIncomeFees
      && subsidized.lifetimeSubsidy === updated.lifetimeSubsidy + 100_001n && subsidyBefore.owner - subsidyAfter.owner === 100_001n
      && subsidyAfter.vault - subsidyBefore.vault === 100_001n && subsidyAfter.treasury === subsidyBefore.treasury
      && await usedToken(subsidy) && await usedVault(subsidy), 'owner_subsidy_classification_mismatch');
    report.cases.ownerSubsidy = { success: true, gross: '100001', fee: '0', transaction: subsidyReceipt.transaction };
    progress('wrong_domain_atomic_rollback');
    const wrong = await payment(accounts.payer, '10001'), wrongAuth = authorization(wrong), wrongBefore = await balances(), wrongAgent = await getAgent();
    wrong.payload.signature = await accounts.payer.signTypedData({ domain: { name: 'USDC', version: '2', chainId: 84533, verifyingContract: token },
      types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: { ...wrongAuth, value: BigInt(wrongAuth.value), validAfter: BigInt(wrongAuth.validAfter), validBefore: BigInt(wrongAuth.validBefore) } });
    const wrongData = encodeFunctionData({ abi: vaultAbi, functionName: 'receiveFundsWithAuthorization', args: authArgs(wrong) });
    ensureLocal(); const wrongReceipt = await confirmed(wallet(accounts.frontRunner).sendTransaction({ to: agent.vault, data: wrongData, gas: 1_000_000n }), 'reverted');
    requireFact(wrongReceipt.logs.length === 0 && canonical(await balances()) === canonical(wrongBefore) && canonical(await getAgent()) === canonical(wrongAgent)
      && !await usedToken(wrong) && !await usedVault(wrong), 'wrong_domain_rollback_mismatch');
    report.cases.wrongDomain = { success: true, revertedTransaction: wrongReceipt.transactionHash, tokenNonceUnconsumed: true, vaultReferenceUnconsumed: true, classificationUnchanged: true };
    progress('front_run_nonce_reconciliation'); await checkedSource(client);
    let frontRunHash: Hex | undefined, broadcastCount = 0;
    const raced: PaymentChain = { pins: chain.pins, verify: chain.verify.bind(chain), prepare: chain.prepare.bind(chain), inspect: chain.inspect.bind(chain),
      broadcast: async raw => {
        broadcastCount++;
        if (!frontRunHash) {
          const args = authArgs(frontPayment), auth = authorization(frontPayment); ensureLocal();
          const donated = await confirmed(wallet(accounts.frontRunner).writeContract({ address: token, abi: tokenAbi, functionName: 'transferWithAuthorization',
            args: [args[0], auth.to, ...args.slice(1)] as [Address, Address, bigint, bigint, bigint, Hex, number, Hex, Hex] })); frontRunHash = donated.transactionHash;
        }
        ensureLocal(); return chain.broadcast(raw);
      } };
    const racingService = new X402PaymentService(store.db, raced, () => localClock); await racingService.initialize();
    const frontPayment = await payment(accounts.payer, '100003', racingService), frontBefore = await balances(), frontAgent = await getAgent();
    const racedResult = await settleTerminal(frontPayment, '100003', racingService);
    requireFact(!racedResult.success && racedResult.errorReason === 'income_authorization_reconciliation_required' && racedResult.transaction && frontRunHash
      && racedResult.transaction !== frontRunHash, 'front_run_not_reconciled');
    const frontAfter = await balances();
    requireFact(frontBefore.payer - frontAfter.payer === 100_003n && frontAfter.vault - frontBefore.vault === 100_003n && frontAfter.treasury === frontBefore.treasury
      && canonical(await getAgent()) === canonical(frontAgent) && await usedToken(frontPayment) && !await usedVault(frontPayment), 'front_run_incorrect_classification');
    const racedRow = (await store.db.select().from(paymentJournal)).find(row => row.hash === racedResult.transaction); requireFact(racedRow?.raw, 'front_run_original_journal_missing');
    const racedIdentity = canonical({ raw: racedRow.raw, hash: racedRow.hash, nonce: racedRow.nonce, attemptHash: racedRow.attemptHash }), beforeRetryNonce = await client.getTransactionCount({ address: accounts.facilitator.address });
    const retry = await racingService.settle(frontPayment, { amount: '100003', requestHash }), afterRetryRow = (await store.db.select().from(paymentJournal)).find(row => row.hash === racedResult.transaction)!;
    requireFact(!retry.success && retry.errorReason === 'income_authorization_reconciliation_required' && retry.transaction === racedResult.transaction
      && canonical({ raw: afterRetryRow.raw, hash: afterRetryRow.hash, nonce: afterRetryRow.nonce, attemptHash: afterRetryRow.attemptHash }) === racedIdentity
      && await client.getTransactionCount({ address: accounts.facilitator.address }) === beforeRetryNonce && canonical(await balances()) === canonical(frontAfter), 'front_run_retry_changed_original');
    report.cases.nonceFrontRun = { success: true, originalCandidate: racedResult.transaction, directTokenTransaction: frontRunHash,
      reconciliationRequired: true, differentHashNeverAdopted: true, noIncomeOrFeeCredited: true, immutableRetry: true, broadcastsAttempted: broadcastCount };
    progress('canonical_final_recheck'); await checkedSource(publicClient); await checkedSource(client);
    report.isolation.publicReadonlyAllowlist = [...publicMethods]; report.isolation.publicReadonlyMethodCounts = methods;
    report.isolation.publicReadonlyRequests = publicCalls; report.isolation.guardedLocalMutationRequests = mutationCalls;
    report.source.localDeployment = { registry, vault: agent.vault, agentId, escrow, identityFixture: identity };
    progress('complete'); report.success = true;
  } catch (error) {
    report.success = false;
    report.failureCode = error instanceof Error && /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'acceptance_stage_failed';
    if (error instanceof Error) {
      report.failureType = /^[a-zA-Z0-9_]{1,80}$/.test(error.name) ? error.name : 'Error';
      const detail = 'shortMessage' in error && typeof error.shortMessage === 'string' ? error.shortMessage : error.message;
      report.failureDetail = detail.split('\n')[0]!.replace(/https?:\/\/\S+/g, '[url]').replace(/0x[0-9a-fA-F]+/g, '[hex]').replace(/[A-Z]:[\\/][^ ]+/gi, '[path]').slice(0, 180);
      report.failureCauses = []; let cause: unknown = error;
      for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
        const item: { name: string; code?: number } = { name: /^[a-zA-Z0-9_]{1,80}$/.test(cause.name) ? cause.name : 'Error' };
        if ('code' in cause && typeof cause.code === 'number') item.code = cause.code;
        report.failureCauses.push(item); cause = cause.cause;
      }
    }
  }
  finally {
    const deadlineReached = controller.signal.aborted;
    clearTimeout(timer); controller.abort();
    try { if (store) await store.close(); storeClosed = true; } catch { storeClosed = false; }
    if (!child || child.exitCode !== null || child.signalCode !== null) cleanupConfirmed = true;
    else {
      const owned = child, exited = new Promise<void>(yes => owned.once('exit', () => yes()));
      owned.kill('SIGTERM'); await Promise.race([exited, delay(3000)]);
      if (owned.exitCode === null && owned.signalCode === null) { owned.kill('SIGKILL'); await Promise.race([exited, delay(3000)]); }
      cleanupConfirmed = owned.exitCode !== null || owned.signalCode !== null;
    }
    try { if (relay) { relay.closeAllConnections(); await new Promise<void>((yes, no) => relay!.close(error => error ? no(error) : yes())); } relayClosed = true; }
    catch { relayClosed = false; }
    Object.assign(report.isolation, { childStopped: cleanupConfirmed, readonlyRelayClosed: relayClosed, privateStoreClosed: storeClosed });
    report.isolation.relayRejectedMethods = relayRejectedMethods; report.isolation.publicRpcErrors = publicRpcErrors;
    report.isolation.publicReadonlyMethodCounts = methods; report.isolation.publicReadonlyRequests = publicCalls;
    report.isolation.guardedLocalMutationRequests = mutationCalls;
    report.isolation.privateAnvilLogBytes = anvilLogBytes; report.isolation.privateAnvilLogOverflow = anvilLogOverflow;
    report.success = report.success && !deadlineReached && cleanupConfirmed && relayClosed && storeClosed;
    if (!report.success && !report.failureCode) report.failureCode = 'owned_fixture_cleanup_incomplete';
    await writeFile(join(directory, 'anvil-private.log'), Buffer.concat(anvilLog), { mode: 0o600 });
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('No arguments are accepted');
  const result = await runUsdcVaultForkAcceptance(); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.success) process.exitCode = 1;
}
