import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { z } from 'zod';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ChainBridge } from '../src/bridge.js';
import { tokenAbi } from '../src/chain/abi.js';
import { localChain } from '../src/chain/chains.js';
import { bytes32Schema, hashJson } from '../src/common.js';
import { loadConfig, type Config } from '../src/config.js';
import { jobs, transactions, openStore, type Database, type Job } from '../src/store.js';
import { Service } from '../src/service.js';
import { Worker } from '../src/worker.js';
import { createDockerCpuExecutor, type CpuExecutor } from '../src/runtime/index.js';
import { executeCommand, type DockerCommand } from '../src/runtime/command.js';
import { validateCpuResult } from '../src/runtime/validation.js';
import { nearReadinessSnapshot } from '../src/providers/readiness.js';
import type { NearCompletionResult, NearProvider } from '../src/providers/index.js';
import { assertForkMutationTarget } from '../src/operator/fork-guard.js';

function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const artifactSchema = z.object({ bytecode: z.string().regex(/^0x[a-fA-F0-9]+$/).transform(value => {
  // REASON: the schema establishes local compiled bytecode's hex representation.
  return value as Hex;
}), abi: z.custom<Abi>(value => Array.isArray(value)) }).passthrough();
let phase = 'configuration';
let anvil: ChildProcess | undefined;
let store: Awaited<ReturnType<typeof openStore>> | undefined;
let worker: Worker | undefined;
let cleanupCpu: ReturnType<typeof createDockerCpuExecutor> | undefined;
let work: string | undefined;
let report: Record<string, unknown> | undefined;

async function createPrivateScratch(namespace: string): Promise<string> {
  const parent = '/opt/telomere-pilot/work/receipt-recovery';
  let current = '';
  for (const segment of parent.split('/').filter(Boolean)) {
    current += `/${segment}`;
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const entry = await lstat(current);
    invariant(entry.isDirectory() && !entry.isSymbolicLink(), 'Scratch parent must be a real directory');
  }
  const directory = resolve(parent, namespace);
  invariant(/^[a-f0-9]{16}$/.test(namespace), 'Scratch namespace invalid');
  // A collision must fail, and no existing directory or symlink can become our database.
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function unusedLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => server.listen(0, '127.0.0.1', accept).once('error', reject));
  const address = server.address(); invariant(address && typeof address !== 'string', 'No fresh loopback port');
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return address.port;
}

async function stopAnvil(): Promise<boolean> {
  if (!anvil || !anvil.pid || anvil.exitCode !== null || anvil.signalCode !== null) return true;
  let ended = false;
  const child = anvil;
  const finished = new Promise<void>(accept => { child.once('exit', () => { ended = true; accept(); }); });
  child.kill('SIGTERM'); await Promise.race([finished, delay(3000)]);
  if (!ended) { child.kill('SIGKILL'); await Promise.race([finished, delay(3000)]); }
  return ended;
}

try {
  invariant(process.platform === 'linux', 'Real Docker recovery acceptance requires Linux');
  const image = z.string().regex(/@sha256:[a-f0-9]{64}$/).parse(process.env.CPU_IMAGE);
  const binary = z.string().min(1).refine(isAbsolute).parse(process.env.ACCEPTANCE_ANVIL_BINARY);
  const artifacts = z.string().min(1).refine(isAbsolute).parse(process.env.ACCEPTANCE_ARTIFACT_DIR);
  const namespace = randomBytes(8).toString('hex');
  work = await createPrivateScratch(namespace);
  let port = await unusedLocalPort();
  while ([3280, 3281, 13280, 15434, 18547, 8547].includes(port)) port = await unusedLocalPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  phase = 'isolated_chain';
  anvil = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--accounts', '0', '--silent'],
    { stdio: ['ignore', 'ignore', 'ignore'], shell: false });
  let chainStartFailed = false;
  anvil.once('error', () => { chainStartFailed = true; });
  const chain = createPublicClient({ chain: localChain, transport: http(rpcUrl, { retryCount: 0, timeout: 1000 }), cacheTime: 0 });
  const test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(rpcUrl, { retryCount: 0 }) });
  const readyUntil = Date.now() + 15000;
  while (true) {
    invariant(!chainStartFailed && anvil.exitCode === null, 'Owned EVM failed');
    try { if (await chain.getChainId() === 31337) break; } catch { /* Only our startup reads. */ }
    invariant(Date.now() < readyUntil, 'Owned EVM not ready'); await delay(100);
  }
  const ensureLocal = () => assertForkMutationTarget(rpcUrl, { pid: anvil?.pid, port,
    exited: !anvil || anvil.exitCode !== null || anvil.signalCode !== null });
  const keys = { owner: generatePrivateKey(), signer: generatePrivateKey(), treasury: generatePrivateKey() };
  const accounts = { owner: privateKeyToAccount(keys.owner), signer: privateKeyToAccount(keys.signer), treasury: privateKeyToAccount(keys.treasury) };
  for (const account of Object.values(accounts)) { ensureLocal(); await test.setBalance({ address: account.address, value: parseEther('10') }); }
  const owner = createWalletClient({ chain: localChain, account: accounts.owner, transport: http(rpcUrl, { retryCount: 0 }) });
  async function confirmed(hash: Promise<Hex>) {
    const mined = await chain.waitForTransactionReceipt({ hash: await hash, timeout: 15000 });
    invariant(mined.status === 'success', 'Local acceptance transaction reverted'); return mined;
  }
  const tokenArtifact = artifactSchema.parse(JSON.parse(await readFile(resolve(artifacts, 'MockToken.json'), 'utf8')));
  const escrowArtifact = artifactSchema.parse(JSON.parse(await readFile(resolve(artifacts, 'TelomereRunEscrow.json'), 'utf8')));
  ensureLocal(); const token = (await confirmed(owner.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode }))).contractAddress;
  invariant(token, 'Mock token missing');
  ensureLocal(); const escrow = (await confirmed(owner.deployContract({ abi: escrowArtifact.abi, bytecode: escrowArtifact.bytecode,
    args: [token, accounts.signer.address, accounts.signer.address, accounts.treasury.address] }))).contractAddress;
  invariant(escrow, 'Escrow missing');
  const config = loadConfig({ MODE: 'demo', RPC_URL: rpcUrl, CHAIN_ID: '31337', TOKEN_ADDRESS: token, ESCROW_ADDRESS: escrow,
    SIGNER_PRIVATE_KEY: keys.signer, DEMO_PRIVATE_KEY: keys.owner, CPU_MODE: 'docker', CPU_IMAGE: image, DATA_DIR: resolve(work, 'database'),
    NEAR_ENDPOINT: 'https://cloud-api.near.ai/v1', NEAR_MODEL: 'acceptance/synthetic', NEAR_API_KEY: 'unused-offline-fixture', NEAR_ALLOWED_MODELS: 'acceptance/synthetic' });
  const faultedRuns = new Set<string>(), failures = new Map<string, number>(), executions = new Map<string, number>();
  class ReceiptFaultBridge extends ChainBridge {
    constructor(configuration: Config, private readonly database: Database) { super(configuration); }
    override async run(id: Hex) {
      const saved = (await this.database.select({ status: jobs.status, cpuResult: jobs.cpuResult }).from(jobs).where(eq(jobs.id, id)).limit(1))[0];
      if (faultedRuns.has(id) && saved?.status === 'receipt_pending' && saved.cpuResult != null) {
        failures.set(id, (failures.get(id) ?? 0) + 1); throw new Error('Injected receipt-only RPC transport outage');
      }
      return super.run(id);
    }
  }
  const dockerCommand: DockerCommand = async (raw, options) => {
    const args = [...raw];
    if (args[0] === 'create') {
      args.splice(1, 0, '--label', `telomere.receipt.acceptance=${namespace}`);
      const cpu = args.indexOf('--cpus'); invariant(cpu >= 0, 'CPU cap missing'); args[cpu + 1] = '0.5';
    }
    if (args[0] === 'ps') args.splice(1, 0, '--filter', `label=telomere.receipt.acceptance=${namespace}`);
    return executeCommand('docker', args, options);
  };
  const docker = createDockerCpuExecutor({ image, command: dockerCommand }); cleanupCpu = docker;
  const cpu: CpuExecutor = { run: async (input, signal, onTick) => {
    executions.set(input.runId, (executions.get(input.runId) ?? 0) + 1); return docker.run(input, signal, onTick);
  } };
  let syntheticCalls = 0, syntheticReady = true;
  const synthetic: NearProvider = {
    async readiness() { return nearReadinessSnapshot(syntheticReady ? 'ready' : 'unavailable', syntheticReady ? 'TLS_ONLY' : 'POLICY_EXPIRED', 'provider_tls'); },
    async complete(input): Promise<NearCompletionResult> {
      syntheticCalls++;
      const evidence = { verification: 'provider_tls' as const, endpoint: 'https://cloud-api.near.ai/v1/chat/completions',
        receivedAt: new Date().toISOString(), requestHash: hashJson({ runId: input.runId, prompt: input.prompt }),
        responseHash: hashJson('synthetic provider result') };
      return { output: 'synthetic provider result', model: 'acceptance/synthetic', requestId: 'synthetic_acceptance_fixture_no_http_request',
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }, evidence };
    },
  };
  const logger = pino({ enabled: false });
  store = await openStore(config);
  let bridge = new ReceiptFaultBridge(config, store.db), service = new Service(store.db, bridge, config, true);
  await bridge.check();
  ensureLocal(); await confirmed(owner.writeContract({ address: token, abi: tokenAbi, functionName: 'faucet', args: [accounts.owner.address, 1_000_000n] }));
  for (const tx of bridge.depositTransactions(1_000_000n)) { ensureLocal(); await confirmed(owner.sendTransaction({ to: tx.to, data: tx.data })); }
  const leash = await service.createLeash(accounts.owner.address, accounts.owner.address, 100_000n, 200_000n, BigInt(Math.floor(Date.now() / 1000) + 86400));
  ensureLocal(); await confirmed(owner.sendTransaction({ to: leash.transaction.to, data: leash.transaction.data }));
  const leashId = bytes32Schema.parse(leash.leashId);
  async function stored(runId: Hex): Promise<Job> {
    invariant(store, 'Isolated database not open');
    const row = (await store.db.select().from(jobs).where(eq(jobs.id, runId)).limit(1))[0]; invariant(row, 'Accepted job missing'); return row;
  }
  async function until(runId: Hex, status: Job['status'], timeout = 60000): Promise<Job> {
    const deadline = Date.now() + timeout;
    while (true) { const row = await stored(runId); if (row.status === status) return row;
      invariant(!['failed', 'reconciliation', 'cancelled', 'timed_out', 'refunded'].includes(row.status), 'Unexpected terminal acceptance state');
      invariant(Date.now() < deadline, 'Acceptance worker deadline exceeded'); await delay(100); }
  }
  async function waitForReceiptFault(runId: Hex): Promise<void> {
    const deadline = Date.now() + 15000;
    while ((failures.get(runId) ?? 0) < 1) {
      invariant(Date.now() < deadline, 'Receipt fault was not reached'); await delay(50);
    }
  }
  async function enqueue(label: string, withNear = false): Promise<Hex> {
    const quote = await service.quote(accounts.owner.address, { leashId, maxSeconds: 30,
      task: { kind: 'hash_chain', text: 'Receipt retry real Docker acceptance', iterations: 2_000_000 },
      ...(withNear ? { nearPrompt: 'Offline synthetic fixture; no provider request' } : {}) }, `receipt-retry-${label}-${namespace}`);
    ensureLocal(); const opened = await confirmed(owner.sendTransaction({ to: quote.transaction.to, data: quote.transaction.data }));
    await service.admit(accounts.owner.address, quote.quote.runId, opened.transactionHash); faultedRuns.add(quote.quote.runId); return quote.quote.runId;
  }
  async function inspectSettled(runId: Hex, observed: Job, withNear = false) {
    invariant(store, 'Acceptance store missing');
    const final = await until(runId, 'completed');
    const cpuResult = validateCpuResult(observed.cpuResult, runId, 30);
    const charge = BigInt(cpuResult.billableSeconds) * 100n + (withNear ? 10000n : 0n);
    invariant(cpuResult.billableSeconds > 0 && executions.get(runId) === 1, 'Work repeated or no positive CPU meter observed');
    invariant(final.charged === charge.toString() && BigInt(final.refund ?? '-1') + charge === BigInt(final.ceiling)
      && hashJson(final.cpuResult) === hashJson(observed.cpuResult) && final.output === observed.output, 'Durable completed outcome or accounting changed');
    const proof = await service.verifyReceipt(final.receipt), run = await bridge.run(runId);
    invariant(proof.valid && 'anchored' in proof && proof.anchored && run.status === 2 && final.settlementTxHash, 'Receipt did not anchor');
    const journal = (await store.db.select({ hash: transactions.hash }).from(transactions).where(eq(transactions.runId, runId)).limit(1))[0];
    invariant(journal?.hash === final.settlementTxHash, 'Settlement journal/hash mismatch');
    return { runId, executions: executions.get(runId), receiptRpcFailures: failures.get(runId), billableSeconds: cpuResult.billableSeconds,
      charged: final.charged, refund: final.refund, fullChargeAndRefundConsistent: true, storedCpuResultUnchanged: true,
      signatureValid: true, anchored: true, journalMatches: true, settlementTxHash: final.settlementTxHash };
  }
  phase = 'same_worker_receipt_outage';
  const first = await enqueue('same-worker');
  worker = new Worker(store.db, bridge, cpu, synthetic, logger); worker.start();
  const firstPending = await until(first, 'receipt_pending');
  await waitForReceiptFault(first);
  invariant(firstPending.targetStatus === 'completed' && firstPending.receipt === null, 'Known CPU outcome was lost');
  faultedRuns.delete(first);
  const sameWorker = await inspectSettled(first, firstPending);
  await worker.stop(); worker = undefined;

  async function restartedCase(label: string, withNear = false) {
    invariant(store, 'Store required for restart case');
    const runId = await enqueue(label, withNear);
    worker = new Worker(store.db, bridge, cpu, synthetic, logger); worker.start();
    const before = await until(runId, 'receipt_pending');
    await waitForReceiptFault(runId);
    await worker.stop(); worker = undefined; await store.close(); store = undefined;
    if (withNear) syntheticReady = false;
    store = await openStore(config); bridge = new ReceiptFaultBridge(config, store.db); service = new Service(store.db, bridge, config, true);
    worker = new Worker(store.db, bridge, cpu, synthetic, logger);
    const oldFailures = failures.get(runId) ?? 0;
    await worker.recover(true);
    const recovered = await stored(runId);
    invariant(recovered.status === 'receipt_pending' && recovered.targetStatus === 'completed' && (failures.get(runId) ?? 0) > oldFailures
      && hashJson(recovered.cpuResult) === hashJson(before.cpuResult) && hashJson(recovered.nearResult) === hashJson(before.nearResult)
      && executions.get(runId) === 1 && worker.snapshot().state !== 'quarantined', 'Restart while RPC blocked did not retain a known outcome');
    faultedRuns.delete(runId); worker.start();
    const result = await inspectSettled(runId, before, withNear);
    await worker.stop(); worker = undefined;
    return { ...result, databaseClosedAndReopened: true, recoveredWhileReceiptRpcStillBlocked: true, pendingOutcomeRetainedOnRestart: true };
  }
  phase = 'restart_with_receipt_outage';
  const restart = await restartedCase('restart');
  phase = 'synthetic_provider_result_receipt_outage';
  const syntheticProvider = await restartedCase('synthetic-provider', true);
  invariant(syntheticCalls === 1, 'Synthetic provider called again during receipt recovery');
  const remaining = await executeCommand('docker', ['ps', '--all', '--filter', `label=telomere.receipt.acceptance=${namespace}`, '--format', '{{.Names}}'],
    { signal: AbortSignal.timeout(5000), maxOutputBytes: 16384 });
  invariant(remaining.exitCode === 0 && remaining.stdout.trim() === '', 'Acceptance cells survived');
  report = { schemaVersion: 1, status: 'passed', checkedAt: new Date().toISOString(), deployment: 'isolated_receipt_recovery_acceptance',
    chainId: 31337, token: 'disposable MockToken', cpuImage: image, acceptanceCpuLimit: 0.5, database: 'namespaced_persistent_pglite',
    sameWorker, restart, syntheticProvider: { ...syntheticProvider, source: 'offline_synthetic_result', completionCalls: syntheticCalls,
      inferenceFixedCharge: '10000', providerReadinessUnavailableAfterResult: true, paidNearPosts: 0 },
    actualProviderRequests: 0, publicTransactionsSent: 0, personalWalletUsed: false, existingPilotKeysUsed: false, liveStagingModified: false,
    remainingAcceptanceContainers: 0 };
} catch {
  report = { schemaVersion: 1, status: 'failed', phase, checkedAt: new Date().toISOString(), actualProviderRequests: 0,
    publicTransactionsSent: 0, personalWalletUsed: false, existingPilotKeysUsed: false, liveStagingModified: false };
  process.exitCode = 1;
} finally {
  let workerStopped = true, databaseClosed = true, ownedCellsRemoved = true;
  try { await worker?.stop(); } catch { workerStopped = false; }
  try { await store?.close(); } catch { databaseClosed = false; }
  try { await cleanupCpu?.cleanupOrphans(); } catch { ownedCellsRemoved = false; }
  const ownedAnvilStopped = await stopAnvil();
  const clean = workerStopped && databaseClosed && ownedCellsRemoved && ownedAnvilStopped;
  if (!clean) process.exitCode = 1;
  const output = { ...report, ...(!clean ? { status: 'cleanup_failed' } : {}), cleanup: { workerStopped, databaseClosed, ownedCellsRemoved, ownedAnvilStopped } };
  if (work) {
    try { await writeFile(resolve(work, 'report.json'), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 }); }
    catch { process.exitCode = 1; }
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}
