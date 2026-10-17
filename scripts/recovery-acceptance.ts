import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { z } from 'zod';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ChainBridge } from '../src/bridge.js';
import { escrowAbi, tokenAbi } from '../src/chain/abi.js';
import { localChain } from '../src/chain/chains.js';
import { randomId, typedQuote } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { Service } from '../src/service.js';
import { jobs, openStore, transactions, type Job } from '../src/store.js';
import { createDockerCpuExecutor, type CpuExecutor } from '../src/runtime/index.js';
import { executeCommand, type DockerCommand } from '../src/runtime/command.js';
import { validateTicks } from '../src/runtime/validation.js';
import { Worker } from '../src/worker.js';

/** Destructive failure injection is confined to generated accounts, its own EVM,
 * durable PGlite directory, child controllers and a unique Docker label. */
const settingsSchema = z.object({ env: z.record(z.string()), namespace: z.string().regex(/^[a-f0-9]{16}$/),
  mode: z.enum(['crash_cpu', 'hold_settlement', 'recover']), runId: z.string().regex(/^0x[a-f0-9]{64}$/) }).strict();
type Settings = z.infer<typeof settingsSchema>;
const eventSchema = z.object({ type: z.enum(['created', 'tick', 'held', 'ready', 'complete']), container: z.string().optional(),
  runId: z.string().optional(), seconds: z.number().optional(), cleaned: z.array(z.string()).optional(), status: z.string().optional() });
type Event = z.infer<typeof eventSchema>;
type Controller = { child: ChildProcess; events: Event[]; exited: Promise<void>; wait(type: Event['type'], predicate?: (event: Event) => boolean): Promise<Event> };

function invariant(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const send = (event: Event) => { process.send?.(event); };
function isolatedDocker(namespace: string, slow: boolean, observe: (event: Event) => void): DockerCommand {
  return async (input, options) => {
    const args = [...input];
    if (args[0] === 'create') {
      args.splice(1, 0, '--label', `telomere.acceptance=${namespace}`);
      if (slow) { const index = args.indexOf('--cpus'); invariant(index >= 0, 'CPU limit missing'); args[index + 1] = '0.1'; }
    }
    if (args[0] === 'ps') args.splice(1, 0, '--filter', `label=telomere.acceptance=${namespace}`);
    const result = await executeCommand('docker', args, options);
    if (args[0] === 'create' && result.exitCode === 0) {
      const name = args[args.indexOf('--name') + 1]; invariant(name, 'Container name missing'); observe({ type: 'created', container: name });
    }
    return result;
  };
}

async function childController(path: string): Promise<void> {
  const settings = settingsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const config = loadConfig(settings.env), bridge = new ChainBridge(config);
  await bridge.check();
  const store = await openStore(config);
  const docker = createDockerCpuExecutor({ image: config.CPU_IMAGE, command: isolatedDocker(settings.namespace, settings.mode === 'crash_cpu', send) });
  const cleaned = await docker.cleanupOrphans();
  const cpu: CpuExecutor = { run: (input, signal, onTick) => docker.run(input, signal, async tick => {
    await onTick?.(tick); send({ type: 'tick', runId: tick.runId, seconds: tick.billableSeconds });
  }) };
  if (settings.mode === 'hold_settlement') {
    // Called only after ChainBridge has durably journalled the signed bytes.
    // Never broadcasts; the controller is forcibly killed by the parent here.
    bridge.public.sendRawTransaction = async () => { send({ type: 'held', runId: settings.runId }); return new Promise<Hex>(() => undefined); };
  }
  const worker = new Worker(store.db, bridge, cpu, undefined, pino({ enabled: false }));
  try {
    await worker.recover(true); worker.start(); send({ type: 'ready', cleaned });
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const job = (await store.db.select().from(jobs).where(eq(jobs.id, settings.runId)))[0];
      if (job && ['completed', 'failed', 'cancelled', 'timed_out', 'refunded'].includes(job.status)) {
        send({ type: 'complete', status: job.status }); return;
      }
      await delay(100);
    }
    throw new Error('Acceptance controller deadline exceeded');
  } finally { await worker.stop(); await store.close(); }
}

async function controller(settings: Settings, work: string): Promise<Controller> {
  const path = resolve(work, `controller-${settings.mode}-${randomBytes(4).toString('hex')}.json`);
  await writeFile(path, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
  const entry = process.argv[1]; invariant(entry, 'Harness entry point missing');
  const child = spawn(process.execPath, [...process.execArgv, entry, '--child', path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const events: Event[] = []; let diagnostic = '', failure: Error | undefined, ended = false;
  child.stderr?.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-2000); });
  child.on('error', error => { failure = error; });
  child.on('message', value => { events.push(eventSchema.parse(value)); });
  const exited = new Promise<void>(resolvePromise => child.once('exit', (code, signal) => {
    ended = true;
    if (code !== 0 && signal !== 'SIGKILL') failure = new Error(`Acceptance controller failed (${code ?? signal}): ${diagnostic}`);
    resolvePromise();
  }));
  return { child, events, exited, wait: async (type, predicate = () => true) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const event = events.find(value => value.type === type && predicate(value));
      if (event) return event;
      invariant(!ended, 'Acceptance controller exited before expected evidence'); await delay(50);
    }
    throw new Error(`Acceptance timed out waiting for ${type}`);
  } };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => server.listen(0, '127.0.0.1', resolvePromise).once('error', reject));
  const address = server.address(); invariant(address && typeof address !== 'string', 'Unused loopback port unavailable');
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}
const artifactSchema = z.object({ bytecode: z.string().regex(/^0x[a-fA-F0-9]+$/), abi: z.custom<Abi>(value => Array.isArray(value)) }).passthrough();

async function acceptance(): Promise<void> {
  invariant(process.platform === 'linux', 'Real Docker crash acceptance runs on Linux only');
  const namespace = randomBytes(8).toString('hex');
  const work = resolve(process.env.ACCEPTANCE_WORK_DIR ?? '.local/recovery-acceptance', namespace);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const image = z.string().regex(/@sha256:[a-f0-9]{64}$/).parse(process.env.CPU_IMAGE);
  const binary = resolve(process.env.ACCEPTANCE_ANVIL_BINARY ?? 'node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil');
  const artifacts = resolve(process.env.ACCEPTANCE_ARTIFACT_DIR ?? 'contracts/artifacts');
  const port = await unusedPort(), rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--accounts', '0', '--silent'],
    { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  const children: Controller[] = [];
  const chain = createPublicClient({ chain: localChain, transport: http(rpcUrl, { retryCount: 0, timeout: 1000 }), cacheTime: 0 });
  const test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(rpcUrl, { retryCount: 0 }) });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = await chain.getChainId() === 31337; if (ready) break; } catch { /* own local startup */ } await delay(100); }
    invariant(ready, 'Disposable local EVM did not start');
    const keys = { owner: generatePrivateKey(), signer: generatePrivateKey(), treasury: generatePrivateKey() };
    const accounts = { owner: privateKeyToAccount(keys.owner), signer: privateKeyToAccount(keys.signer), treasury: privateKeyToAccount(keys.treasury) };
    for (const account of Object.values(accounts)) await test.setBalance({ address: account.address, value: parseEther('10') });
    const owner = createWalletClient({ chain: localChain, account: accounts.owner, transport: http(rpcUrl, { retryCount: 0 }) });
    const token = artifactSchema.parse(JSON.parse(await readFile(resolve(artifacts, 'MockToken.json'), 'utf8')));
    const escrow = artifactSchema.parse(JSON.parse(await readFile(resolve(artifacts, 'TelomereRunEscrow.json'), 'utf8')));
    const tokenReceipt = await chain.waitForTransactionReceipt({ hash: await owner.deployContract({ abi: token.abi, bytecode: token.bytecode as Hex }) });
    invariant(tokenReceipt.contractAddress, 'Test token deployment failed');
    const tokenAddress = tokenReceipt.contractAddress;
    const escrowReceipt = await chain.waitForTransactionReceipt({ hash: await owner.deployContract({ abi: escrow.abi, bytecode: escrow.bytecode as Hex,
      args: [tokenAddress, accounts.signer.address, accounts.signer.address, accounts.treasury.address] }) });
    invariant(escrowReceipt.contractAddress, 'Test escrow deployment failed');
    const escrowAddress = escrowReceipt.contractAddress;
    const env = { MODE: 'demo', RPC_URL: rpcUrl, CHAIN_ID: '31337', ESCROW_ADDRESS: escrowAddress, TOKEN_ADDRESS: tokenAddress,
      SIGNER_PRIVATE_KEY: keys.signer, DEMO_PRIVATE_KEY: keys.owner, CPU_MODE: 'docker', CPU_IMAGE: image, DATA_DIR: resolve(work, 'database') };
    const config = loadConfig(env), bridge = new ChainBridge(config);
    await bridge.check();
    async function receipt(hash: Hex) { invariant((await chain.waitForTransactionReceipt({ hash })).status === 'success', 'Test-only owner transaction reverted'); }
    await receipt(await owner.writeContract({ address: tokenAddress, abi: tokenAbi, functionName: 'faucet', args: [accounts.owner.address, 1_000_000n] }));
    for (const transaction of bridge.depositTransactions(1_000_000n)) await receipt(await owner.sendTransaction({ to: transaction.to, data: transaction.data }));
    const leashId = randomId();
    await receipt(await owner.writeContract({ address: escrowAddress, abi: escrowAbi, functionName: 'createLeash',
      args: [leashId, accounts.owner.address, 1_000_000n, 1_000_000n, BigInt(Math.floor(Date.now() / 1000) + 86400)] }));
    async function enqueue(label: string): Promise<Hex> {
      const store = await openStore(config);
      try {
        const service = new Service(store.db, bridge, config, false);
        const quoted = await service.quote(accounts.owner.address, { leashId, task: { kind: 'hash_chain', text: label, iterations: 2_000_000 }, maxSeconds: 30 }, `acceptance-${namespace}-${label}`);
        const transaction = bridge.openTransaction(typedQuote(quoted.quote), quoted.signature as Hex);
        const hash = await owner.sendTransaction({ to: transaction.to, data: transaction.data }); await receipt(hash);
        await service.admit(accounts.owner.address, quoted.quote.runId, hash); return quoted.quote.runId;
      } finally { await store.close(); }
    }
    async function runController(runId: Hex, mode: Settings['mode']) {
      const value = await controller({ env, namespace, mode, runId }, work); children.push(value); await value.wait('ready'); return value;
    }
    async function stored(runId: Hex): Promise<{ job: Job; journal: typeof transactions.$inferSelect | undefined }> {
      const store = await openStore(config);
      try { const job = (await store.db.select().from(jobs).where(eq(jobs.id, runId)))[0]; invariant(job, 'Persisted acceptance job missing');
        return { job, journal: (await store.db.select().from(transactions).where(eq(transactions.runId, runId)))[0] }; }
      finally { await store.close(); }
    }
    async function treasury() { return chain.readContract({ address: tokenAddress, abi: tokenAbi, functionName: 'balanceOf', args: [accounts.treasury.address] }); }
    async function terminate(value: Controller) { invariant(value.child.kill('SIGKILL'), 'Controller SIGKILL was not delivered'); await value.exited; }
    const baseline = await treasury(), crashId = await enqueue('crash-cpu');
    const crash = await runController(crashId, 'crash_cpu');
    await crash.wait('tick', event => (event.seconds ?? 0) >= 5); await terminate(crash);
    const created = crash.events.find(event => event.type === 'created')?.container; invariant(created, 'Active Docker cell was not observed');
    const orphan = await executeCommand('docker', ['inspect', '--format', '{{json .State}}', created], { signal: AbortSignal.timeout(5000), maxOutputBytes: 16384 });
    const orphanState = z.object({ Running: z.literal(true) }).passthrough().parse(JSON.parse(orphan.stdout));
    const persisted = await stored(crashId), ticks = validateTicks(persisted.job.ticks, crashId, 30), seconds = ticks.at(-1)?.billableSeconds ?? 0;
    invariant(seconds >= 5 && persisted.job.status === 'running' && persisted.job.billableSeconds === seconds, 'Durable CPU tick was not recovered after SIGKILL');
    const recovered = await runController(crashId, 'recover'); const recoveryReady = recovered.events.find(event => event.type === 'ready');
    invariant(recoveryReady?.cleaned?.includes(created), 'Orphan cleanup did not confirm the killed controller cell');
    await recovered.wait('complete'); await recovered.exited;
    const finalCrash = await stored(crashId), crashChain = await bridge.run(crashId), crashCharge = BigInt(seconds) * 100n;
    invariant(finalCrash.job.status === 'failed' && finalCrash.job.errorCode === 'CONTROLLER_RESTART' && finalCrash.job.charged === crashCharge.toString(), 'Recovered CPU charge differs from durable meter');
    invariant(crashChain.status === 2 && crashChain.billableSeconds === BigInt(seconds) && await treasury() - baseline === crashCharge, 'Recovered CPU was not settled exactly once');
    invariant(recovered.events.every(event => event.type !== 'created'), 'Restart dispatched CPU a second time');

    const heldId = await enqueue('held-settlement'), heldBaseline = await treasury();
    const held = await runController(heldId, 'hold_settlement'); await held.wait('held'); await terminate(held);
    const heldBefore = await stored(heldId); invariant(heldBefore.job.status === 'settling' && heldBefore.journal && BigInt(heldBefore.job.charged ?? '0') > 0n, 'Settlement bytes were not durably journalled before crash');
    invariant((await bridge.run(heldId)).status === 1 && await treasury() === heldBaseline, 'Held settlement was broadcast before crash');
    const resumed = await runController(heldId, 'recover'); await resumed.wait('complete'); await resumed.exited;
    const heldAfter = await stored(heldId), heldChain = await bridge.run(heldId);
    invariant(heldAfter.job.status === 'completed' && heldAfter.journal?.hash === heldBefore.journal.hash && heldAfter.journal.raw === heldBefore.journal.raw, 'Settlement restart changed signed transaction bytes');
    invariant(heldChain.status === 2 && await treasury() - heldBaseline === BigInt(heldBefore.job.charged ?? '0'), 'Held settlement recovery charge was duplicated or missing');
    invariant(resumed.events.every(event => event.type !== 'created'), 'Settlement restart dispatched CPU a second time');
    const recheck = await runController(heldId, 'recover'); await recheck.wait('complete'); await recheck.exited;
    invariant(await treasury() - heldBaseline === BigInt(heldBefore.job.charged ?? '0'), 'Repeated restart duplicated settlement');

    const refundId = await enqueue('timeout-refund'), refundBaseline = await treasury(), availableBefore = BigInt((await bridge.balance(accounts.owner.address)).available);
    const pending = await runController(refundId, 'hold_settlement'); await pending.wait('held'); await terminate(pending);
    const refundBefore = await stored(refundId), refundRun = await bridge.run(refundId);
    invariant(refundBefore.journal && refundRun.status === 1, 'Refund fixture was not held before broadcast');
    await test.increaseTime({ seconds: 21632 }); await test.mine({ blocks: 1 });
    const refundTransaction = bridge.refundTransaction(refundId); await receipt(await owner.sendTransaction({ to: refundTransaction.to, data: refundTransaction.data }));
    const refunded = await runController(refundId, 'recover'); await refunded.wait('complete'); await refunded.exited;
    const refundAfter = await stored(refundId), refundChain = await bridge.run(refundId), availableAfter = BigInt((await bridge.balance(accounts.owner.address)).available);
    invariant(refundAfter.job.status === 'refunded' && refundAfter.job.charged === '0' && refundAfter.job.refund === refundBefore.job.ceiling, 'Timeout refund was not reconciled after restart');
    invariant(refundChain.status === 3 && availableAfter - availableBefore === refundRun.ceiling && await treasury() === refundBaseline, 'Timeout refund did not return the full reservation without charging');
    invariant(refunded.events.every(event => event.type !== 'created'), 'Refund recovery dispatched CPU a second time');
    const remaining = await executeCommand('docker', ['ps', '--all', '--filter', `label=telomere.acceptance=${namespace}`, '--format', '{{.Names}}'], { signal: AbortSignal.timeout(5000), maxOutputBytes: 16384 });
    invariant(remaining.exitCode === 0 && !remaining.stdout.trim(), 'Acceptance left Docker cells behind');
    const report = { status: 'passed', checkedAt: new Date().toISOString(), chainId: 31337, paymentToken: 'disposable MockToken',
      scope: 'Separate random loopback EVM, generated accounts, durable PGlite and namespaced Docker cells; existing staging untouched',
      cpuImage: image, providerCalls: 0,
      cpuCrash: { controllerSignal: 'SIGKILL', orphanObservedRunning: orphanState.Running, persistedTickCount: ticks.length, persistedBillableSeconds: seconds,
        acceptanceCpuLimit: 0.1, orphanRemovedOnRestart: true, executions: 1, charged: finalCrash.job.charged, refund: finalCrash.job.refund, settledOnce: true },
      heldSettlement: { journalPersistedBeforeBroadcast: true, positiveCharge: heldBefore.job.charged, transactionHash: heldBefore.journal.hash,
        rawBytesUnchangedAfterRestart: true, repeatedRestartDidNotChargeAgain: true, executions: 1 },
      timeoutRefund: { evmTimeAdvancedSeconds: 21632, contractStatus: refundChain.status, jobStatus: refundAfter.job.status,
        charged: refundAfter.job.charged, refund: refundAfter.job.refund, fullReservationReturned: true }, remainingAcceptanceContainers: 0 };
    const reportPath = resolve(process.env.ACCEPTANCE_REPORT_PATH ?? work, process.env.ACCEPTANCE_REPORT_PATH ? '' : 'report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally {
    for (const child of children) { if (child.child.exitCode === null && child.child.signalCode === null) { child.child.kill('SIGKILL'); await child.exited; } }
    const cleanup = createDockerCpuExecutor({ image, command: isolatedDocker(namespace, false, () => undefined) });
    await cleanup.cleanupOrphans();
    anvil.kill('SIGTERM');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--child') { const path = process.argv[3]; invariant(path, 'Private controller settings path missing'); await childController(path); }
  else await acceptance();
}
