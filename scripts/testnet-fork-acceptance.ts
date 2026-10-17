import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createTestClient, createWalletClient, getAddress, http, keccak256, parseAbi, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { baseSepolia, baseSepoliaUsdc } from '../src/chain/chains.js';
import { escrowAbi, tokenAbi } from '../src/chain/abi.js';
import { quoteTypedData, settlementTypedData, type Quote } from '../src/chain/typed-data.js';
import { addressSchema } from '../src/common.js';
import { assertForkMutationTarget } from '../src/operator/fork-guard.js';
import { CIRCLE_PROXY_IMPLEMENTATION_SLOT, matchesCircleProxyPins,
  matchesNativeBaseUsdcMetadata } from '../src/payments/circle-usdc.js';
import { compileContracts, projectRoot } from './compile-contracts.js';
import { unusedLocalPort } from './local-chain.js';

const usdcAbi = parseAbi(['function version() view returns(string)',
  'function transfer(address to,uint256 amount) returns(bool)']);
const id = (): Hex => `0x${randomBytes(32).toString('hex')}`;
let phase = 'arguments';
let child: ChildProcess | undefined;
let reportPath = resolve(projectRoot, '.local/base-sepolia-fork-acceptance.json');
let report: Record<string, unknown> | undefined;

function binary(): string {
  const platform = process.platform === 'win32' ? 'win32-amd64' : process.platform === 'linux' ? 'linux-amd64' : '';
  const name = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const candidates = [resolve(projectRoot, `node_modules/@foundry-rs/anvil-${platform}/bin`, name),
    resolve(projectRoot, `node_modules/@foundry-rs/anvil-${platform}`, name)];
  const path = candidates.find(candidate => existsSync(candidate));
  if (!path || !platform || process.arch !== 'x64') throw new Error('Supported isolated Anvil binary unavailable');
  return path;
}

async function stopChild(): Promise<boolean> {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  let stopped = false;
  const owned = child;
  const completion = new Promise<void>(accept => { owned.once('exit', () => { stopped = true; accept(); }); });
  owned.kill('SIGTERM');
  await Promise.race([completion, delay(3000)]);
  if (!stopped) { owned.kill('SIGKILL'); await Promise.race([completion, delay(3000)]); }
  return stopped;
}

try {
  const { values } = parseArgs({ options: { report: { type: 'string' }, 'block-number': { type: 'string' } }, allowPositionals: false, strict: true });
  if (values.report) reportPath = resolve(z.string().min(1).parse(values.report));
  const upstreamUrl = baseSepolia.rpcUrls.default.http[0];
  // This transport cannot sign, send, impersonate or modify public state.
  const upstream = createPublicClient({ chain: baseSepolia, transport: http(upstreamUrl, { timeout: 10000, retryCount: 0,
    methods: { include: ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call'] } }) });
  phase = 'public_readonly_pin';
  if (await upstream.getChainId() !== 84532) throw new Error('Public testnet chain mismatch');
  const source = await upstream.getBlock(values['block-number'] ? { blockNumber: BigInt(z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(values['block-number'])) } : {});
  const token = baseSepoliaUsdc;
  const proxyCode = await upstream.getCode({ address: token, blockNumber: source.number });
  const slot = await upstream.getStorageAt({ address: token, slot: CIRCLE_PROXY_IMPLEMENTATION_SLOT, blockNumber: source.number });
  if (!proxyCode || proxyCode === '0x' || !slot || /^0x0+$/.test(slot)) throw new Error('Circle proxy or implementation unavailable');
  const implementation = getAddress(`0x${slot.slice(-40)}`);
  const implementationCode = await upstream.getCode({ address: implementation, blockNumber: source.number });
  if (!implementationCode || implementationCode === '0x') throw new Error('Circle implementation bytecode unavailable');
  const [name, symbol, decimals, version, metadataMatches, proxyMatches] = await Promise.all([
    upstream.readContract({ address: token, abi: tokenAbi, functionName: 'name', blockNumber: source.number }),
    upstream.readContract({ address: token, abi: tokenAbi, functionName: 'symbol', blockNumber: source.number }),
    upstream.readContract({ address: token, abi: tokenAbi, functionName: 'decimals', blockNumber: source.number }),
    upstream.readContract({ address: token, abi: usdcAbi, functionName: 'version', blockNumber: source.number }),
    matchesNativeBaseUsdcMetadata(upstream, 84532, token, { blockHash: source.hash, requireCanonical: true }),
    matchesCircleProxyPins(upstream, token, { address: implementation, codeHash: keccak256(implementationCode) },
      { blockHash: source.hash, requireCanonical: true }),
  ]);
  if (name !== 'USDC' || symbol !== 'USDC' || decimals !== 6 || version !== '2'
    || !metadataMatches || !proxyMatches) throw new Error('Circle native USDC identity changed');
  phase = 'holder_readonly_selection';
  const holdersResponse = await fetch(`https://base-sepolia.blockscout.com/api/v2/tokens/${token}/holders`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!holdersResponse.ok) throw new Error('Public holder index unavailable');
  const holders = z.object({ items: z.array(z.object({ address: z.object({ hash: addressSchema }), value: z.string().regex(/^\d+$/) })).max(100) })
    .parse(await holdersResponse.json()).items;
  const candidate = holders.find(holder => BigInt(holder.value) >= 5_000_000n);
  if (!candidate) throw new Error('A source holder is required for fork-only funding');
  const holder = candidate.address.hash;
  const sourceHolderBalance = await upstream.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [holder], blockNumber: source.number });
  if (sourceHolderBalance < 5_000_000n) throw new Error('Selected holder lacks funds at pinned block');
  phase = 'isolated_fork_start';
  let port = await unusedLocalPort();
  while ([3280, 3281, 13280, 15434, 18547, 8547].includes(port)) port = await unusedLocalPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  child = spawn(binary(), ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '84532', '--accounts', '0', '--silent',
    '--fork-url', upstreamUrl, '--fork-block-number', source.number.toString()], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, shell: false });
  let childError = false;
  child.once('error', () => { childError = true; });
  const local = createPublicClient({ chain: baseSepolia, cacheTime: 0, transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
  const test = createTestClient({ chain: baseSepolia, mode: 'anvil', transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
  const readyUntil = Date.now() + 30000;
  while (true) {
    if (childError || child.exitCode !== null) throw new Error('Isolated fork startup failed');
    try { if (await local.getChainId() === 84532) break; } catch { /* Read-only startup probe. */ }
    if (Date.now() >= readyUntil) throw new Error('Isolated fork startup timed out');
    await delay(100);
  }
  const ensureLocal = () => assertForkMutationTarget(rpcUrl, { pid: child?.pid, port, exited: !child || child.exitCode !== null || child.signalCode !== null });
  ensureLocal();
  if ((await local.getBlock({ blockNumber: source.number })).hash !== source.hash
    || await local.getCode({ address: token }) !== proxyCode || await local.getCode({ address: implementation }) !== implementationCode) throw new Error('Fork source bytecode/block mismatch');
  const accounts = { owner: privateKeyToAccount(generatePrivateKey()), operator: privateKeyToAccount(generatePrivateKey()),
    treasury: privateKeyToAccount(generatePrivateKey()), relayer: privateKeyToAccount(generatePrivateKey()) };
  for (const account of Object.values(accounts)) { ensureLocal(); await test.setBalance({ address: account.address, value: parseEther('10') }); }
  const owner = createWalletClient({ account: accounts.owner, chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0 }) });
  const relayer = createWalletClient({ account: accounts.relayer, chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0 }) });
  const holderWallet = createWalletClient({ account: holder, chain: baseSepolia, transport: http(rpcUrl, { retryCount: 0 }) });
  async function confirmed(transaction: Promise<Hex>) {
    const receipt = await local.waitForTransactionReceipt({ hash: await transaction, timeout: 20000 });
    if (receipt.status !== 'success') throw new Error('Fork transaction reverted');
    return receipt;
  }
  phase = 'fork_only_holder_funding';
  ensureLocal(); await test.setBalance({ address: holder, value: parseEther('10') });
  ensureLocal(); await test.impersonateAccount({ address: holder });
  const funding = await confirmed(holderWallet.writeContract({ address: token, abi: usdcAbi, functionName: 'transfer', args: [accounts.owner.address, 5_000_000n] }));
  ensureLocal(); await test.stopImpersonatingAccount({ address: holder });
  if (await local.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [accounts.owner.address] }) !== 5_000_000n) throw new Error('Actual Circle USDC funding mismatch');
  phase = 'fork_escrow_deploy';
  const artifact = compileContracts().TelomereRunEscrow;
  if (!artifact) throw new Error('Escrow artifact unavailable');
  ensureLocal();
  const creation = await confirmed(owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode,
    args: [token, accounts.operator.address, accounts.operator.address, accounts.treasury.address] }));
  const escrow = addressSchema.parse(creation.contractAddress);
  const available = () => local.readContract({ address: escrow, abi: escrowAbi, functionName: 'availableBalance', args: [accounts.owner.address] });
  const tokenBalance = (address: `0x${string}`) => local.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
  phase = 'issuer_deposit_withdraw';
  ensureLocal(); await confirmed(owner.writeContract({ address: token, abi: tokenAbi, functionName: 'approve', args: [escrow, 1_000_000n] }));
  ensureLocal(); await confirmed(owner.writeContract({ address: escrow, abi: escrowAbi, functionName: 'deposit', args: [1_000_000n] }));
  if (await available() !== 1_000_000n || await tokenBalance(escrow) !== 1_000_000n) throw new Error('Deposit accounting mismatch');
  ensureLocal(); await confirmed(owner.writeContract({ address: escrow, abi: escrowAbi, functionName: 'withdraw', args: [50_000n] }));
  if (await available() !== 950_000n || await tokenBalance(accounts.owner.address) !== 4_050_000n) throw new Error('Withdrawal accounting mismatch');
  const leashId = id();
  const now = (await local.getBlock()).timestamp;
  ensureLocal(); await confirmed(owner.writeContract({ address: escrow, abi: escrowAbi, functionName: 'createLeash',
    args: [leashId, accounts.relayer.address, 200_000n, 300_000n, now + 86400n] }));
  async function quote(maxSeconds: bigint, cpuPrice: bigint, inference: bigint): Promise<Quote> {
    return { runId: id(), leashId, payer: accounts.owner.address, workloadHash: id(), maxSeconds,
      pricePerSecond: cpuPrice, inferencePrice: inference, quoteExpiry: (await local.getBlock()).timestamp + 300n };
  }
  async function open(q: Quote, delegated = false) {
    const signature = await accounts.operator.signTypedData(quoteTypedData(84532, escrow, q));
    ensureLocal(); await confirmed((delegated ? relayer : owner).writeContract({ address: escrow, abi: escrowAbi, functionName: 'openRun', args: [q, signature] }));
  }
  async function settle(q: Quote, seconds: bigint, inference: bigint) {
    const settlement = { runId: q.runId, billableSeconds: seconds, inferenceCharge: inference, receiptHash: id() };
    const signature = await accounts.operator.signTypedData(settlementTypedData(84532, escrow, settlement));
    ensureLocal(); await confirmed(relayer.writeContract({ address: escrow, abi: escrowAbi, functionName: 'settleRun', args: [settlement, signature] }));
    return settlement;
  }
  phase = 'fork_delegation_and_settlement';
  const billed = await quote(10n, 100n, 10000n);
  await open(billed, true);
  if (await available() !== 939000n) throw new Error('Reserved ceiling mismatch');
  ensureLocal(); await test.increaseTime({ seconds: 3 }); await test.mine({ blocks: 1 });
  const billedSettlement = await settle(billed, 3n, 10000n);
  const billedRun = await local.readContract({ address: escrow, abi: escrowAbi, functionName: 'getRun', args: [billed.runId] });
  if (billedRun.status !== 2 || billedRun.receiptHash !== billedSettlement.receiptHash || await available() !== 939700n
    || await tokenBalance(accounts.treasury.address) !== 10300n) throw new Error('Settlement accounting mismatch');
  phase = 'fork_stop_cutoff';
  const stopped = await quote(10n, 100n, 0n); await open(stopped);
  ensureLocal(); await test.increaseTime({ seconds: 1 }); await test.mine({ blocks: 1 });
  ensureLocal(); await confirmed(owner.writeContract({ address: escrow, abi: escrowAbi, functionName: 'requestStop', args: [stopped.runId] }));
  const stoppedRun = await local.readContract({ address: escrow, abi: escrowAbi, functionName: 'getRun', args: [stopped.runId] });
  const excess = { runId: stopped.runId, billableSeconds: stoppedRun.stopAt - stoppedRun.openedAt + 2n, inferenceCharge: 0n, receiptHash: id() };
  const excessSignature = await accounts.operator.signTypedData(settlementTypedData(84532, escrow, excess));
  let excessRejected = false;
  try { await local.simulateContract({ address: escrow, abi: escrowAbi, functionName: 'settleRun', account: accounts.relayer.address, args: [excess, excessSignature] }); }
  catch (error) {
    const reverted = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : undefined;
    excessRejected = reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'InvalidSettlement';
  }
  if (!excessRejected || stoppedRun.stopAt === 0n) throw new Error('Stop cutoff not enforced');
  await settle(stopped, 0n, 0n);
  if (await available() !== 939700n) throw new Error('Stopped-run refund mismatch');
  phase = 'fork_timeout_refund';
  const timed = await quote(2n, 1000n, 0n); await open(timed);
  let earlyRefundRejected = false;
  try { await local.simulateContract({ address: escrow, abi: escrowAbi, functionName: 'refundRun', account: accounts.relayer.address, args: [timed.runId] }); }
  catch (error) {
    const reverted = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : undefined;
    earlyRefundRejected = reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'RefundNotReady';
  }
  if (!earlyRefundRejected) throw new Error('Early refund accepted');
  ensureLocal(); await test.increaseTime({ seconds: 21603 }); await test.mine({ blocks: 1 });
  ensureLocal(); await confirmed(relayer.writeContract({ address: escrow, abi: escrowAbi, functionName: 'refundRun', args: [timed.runId] }));
  if ((await local.readContract({ address: escrow, abi: escrowAbi, functionName: 'getRun', args: [timed.runId] })).status !== 3
    || await available() !== 939700n) throw new Error('Timeout refund accounting mismatch');
  phase = 'fork_final_withdrawal';
  ensureLocal(); await confirmed(owner.writeContract({ address: escrow, abi: escrowAbi, functionName: 'withdraw', args: [939700n] }));
  const finalOwner = await tokenBalance(accounts.owner.address), finalTreasury = await tokenBalance(accounts.treasury.address), finalEscrow = await tokenBalance(escrow);
  if (await available() !== 0n || finalEscrow !== 0n || finalOwner !== 4989700n || finalTreasury !== 10300n
    || finalOwner + finalTreasury !== 5_000_000n) throw new Error('Final USDC conservation mismatch');
  // Re-read the same public pinned state. Local funding did not change the source holder.
  const sourceUnchanged = await upstream.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [holder], blockNumber: source.number }) === sourceHolderBalance;
  if (!sourceUnchanged) throw new Error('Source pinned state comparison failed');
  report = { schemaVersion: 1, status: 'passed', checkedAt: new Date().toISOString(), deployment: 'isolated_base_sepolia_fork',
    chainId: 84532, source: { rpc: upstreamUrl, blockNumber: source.number.toString(), blockHash: source.hash },
    token: { address: token, name, symbol, version, decimals, proxyCodeHash: keccak256(proxyCode), proxyCodeBytes: (proxyCode.length - 2) / 2,
      implementation, implementationCodeHash: keccak256(implementationCode), circleProxySlot: CIRCLE_PROXY_IMPLEMENTATION_SLOT,
      observedOnPublicChain: true, independentlyReviewedPins: false },
    funding: { mode: 'fork_only_existing_holder_impersonation', holder, sourceHolderBalance: sourceHolderBalance.toString(),
      transferredUnits: '5000000', issuerMintCalled: false, sourcePinnedStateUnchanged: sourceUnchanged, transactionHashOnLocalFork: funding.transactionHash },
    escrow: { addressOnLocalFork: escrow, compiler: artifact.compiler, creationBytecodeHash: keccak256(artifact.bytecode),
      owner: accounts.owner.address, quoteAndReceiptSigner: accounts.operator.address, treasury: accounts.treasury.address, relayerAndAgent: accounts.relayer.address },
    checks: { exactProxyAndImplementationBytecode: true, depositedActualIssuerToken: true, withdrewActualIssuerToken: true,
      delegatedOpen: true, signedSettlementRelayed: true, unusedCeilingReturned: true, stopCutoffRejectedExcess: excessRejected,
      earlyRefundRejected, permissionlessTimeoutRefund: true, finalConservation: true },
    billing: { quotedCeiling: '11000', billableSeconds: 3, simulatedFixedInferenceCharge: '10000', actualProviderRequests: 0,
      settlementCharge: '10300', unusedCeilingReturned: '700', finalOwnerUnits: finalOwner.toString(), finalTreasuryUnits: finalTreasury.toString(), finalEscrowUnits: finalEscrow.toString() },
    publicTransactionsSent: 0, personalWalletUsed: false, existingPilotKeysUsed: false, liveStagingModified: false, paidNearPosts: 0 };
} catch {
  report = { schemaVersion: 1, status: 'failed', phase, checkedAt: new Date().toISOString(), deployment: 'isolated_base_sepolia_fork',
    publicTransactionsSent: 0, personalWalletUsed: false, existingPilotKeysUsed: false, liveStagingModified: false, paidNearPosts: 0 };
  process.exitCode = 1;
} finally {
  const stopped = await stopChild();
  if (!stopped) process.exitCode = 1;
  const output = { ...report, ...(!stopped ? { status: 'cleanup_failed' } : {}), cleanup: { ownedAnvilStopped: stopped, forkStateDiscarded: stopped } };
  try { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(output, null, 2) + '\n'); }
  catch { process.exitCode = 1; }
  process.stdout.write(JSON.stringify(output) + '\n');
}
