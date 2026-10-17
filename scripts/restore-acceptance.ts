import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { parseEventLogs } from 'viem';
import { z } from 'zod';
import { ChainBridge } from '../src/bridge.js';
import { escrowAbi } from '../src/chain/abi.js';
import { bytes32Schema } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { createBackupDirectory, copyPrivate, cystSnapshotFileName, readBackupCystQuotaPolicy, readCystSnapshot,
  restoreCystSnapshot, verifyRestoredCysts, verifyBackup, type CystSnapshot } from '../src/operator/backup.js';
import { readProfile, parseProfile } from '../src/operator/profile.js';
import { Service, signedReceiptSchema, receiptSettlement } from '../src/service.js';
import { jobs, transactions, storeSchema } from '../src/store.js';
import { unusedLocalPort } from './local-chain.js';

const expectedRun = bytes32Schema.parse('0xf4ac16669705d41f559a967cde2f08623575151b9652ee95c69bf4684147bd8c');
const expectedReceipt = bytes32Schema.parse('0xeee6ccf9dd2deb847f2be3b6d9b0aea3a2580ee68bea04c5ec7af7503770792e');
let phase = 'arguments';
let anvil: ChildProcess | undefined;
let pool: pg.Pool | undefined;
let scratchName: string | undefined;
let exerciseId: string | undefined;
let containerRequested = false;
let report: Record<string, unknown> | undefined;
let reportPath: string | undefined;
let restoredCystSnapshot: CystSnapshot | undefined;

async function command(binary: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return await new Promise((accept, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false, ...(environment ? { env: environment } : {}) });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Scratch command timed out')); }, 30000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 16384) child.kill('SIGKILL'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (output.length > 16384) reject(new Error('Scratch command output exceeded limit'));
      else accept({ code: code ?? -1, output: output.trim() }); });
  });
}

async function restoreArchive(container: string, archive: string): Promise<void> {
  const child = spawn('docker', ['exec', '-i', container, 'pg_restore', '--username=telomere_restore', '--dbname=telomere_restore',
    '--exit-on-error', '--no-owner', '--no-acl'], { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
  const finished = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => { if (code === 0) accept(); else reject(new Error('Scratch restore failed')); });
  });
  try { await Promise.all([pipeline(createReadStream(archive), child.stdin), finished]); }
  finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
}

async function stopOwnedAnvil(): Promise<boolean> {
  if (!anvil || !anvil.pid || anvil.exitCode !== null || anvil.signalCode !== null) return true;
  const child = anvil;
  let stopped = false;
  const completion = new Promise<void>(accept => { child.once('exit', () => { stopped = true; accept(); }); });
  child.kill('SIGTERM');
  await Promise.race([completion, delay(3000)]);
  if (!stopped) { child.kill('SIGKILL'); await Promise.race([completion, delay(3000)]); }
  return stopped;
}

async function removeOwnedContainer(): Promise<boolean> {
  if (!containerRequested || !scratchName || !exerciseId) return true;
  if (!/^telomere-restore-[a-f0-9]{32}$/.test(scratchName)) return false;
  const inspect = await command('docker', ['container', 'inspect', '--format', '{{index .Config.Labels "telomere.restore.exercise"}}', scratchName]);
  if (inspect.code !== 0 || inspect.output !== exerciseId) return false;
  const removed = await command('docker', ['container', 'rm', '--force', scratchName]);
  return removed.code === 0;
}

try {
  if (process.platform !== 'linux') throw new Error('Restore exercise runs on the Linux VPS');
  const { values } = parseArgs({ options: { directory: { type: 'string' } }, strict: true, allowPositionals: false });
  const directory = resolve(z.string().min(1).parse(values.directory));
  phase = 'backup_verification';
  const manifest = await verifyBackup(directory);
  const original = await readProfile(join(directory, 'profile.env'));
  if (original.MODE !== 'demo' || original.CHAIN_ID !== 31337 || !original.DEMO_PRIVATE_KEY) throw new Error('Staging backup required');
  phase = 'reviewed_cyst_quota';
  const quotaPolicy = await readBackupCystQuotaPolicy(original);
  const id = randomUUID().replaceAll('-', '');
  exerciseId = id;
  scratchName = `telomere-restore-${id}`;
  const scratch = await createBackupDirectory(`/opt/telomere-pilot/backups/restore-exercise-${id}`);
  reportPath = join(scratch, 'acceptance.json');
  await copyPrivate(join(directory, 'chain.json'), join(scratch, 'chain.json'));
  const restoredCystDirectory = original.CYSTS_ENABLED ? join(scratch, 'cysts') : undefined;
  if (restoredCystDirectory) {
    phase = 'ciphertext_restore';
    if (manifest.schemaVersion !== 2) throw new Error('Enabled Cyst restore requires version 2 backup');
    const entry = manifest.files.find(file => file.name === cystSnapshotFileName);
    if (!entry) throw new Error('Cyst snapshot entry missing');
    restoredCystSnapshot = await readCystSnapshot(join(directory, cystSnapshotFileName), entry);
    await restoreCystSnapshot(join(directory, cystSnapshotFileName), restoredCystDirectory, entry);
  }
  const pgPort = await unusedLocalPort();
  let chainPort = await unusedLocalPort();
  while (chainPort === pgPort) chainPort = await unusedLocalPort();
  if ([13280, 15434, 18547].includes(pgPort) || [13280, 15434, 18547].includes(chainPort)) throw new Error('Scratch ports overlap staging');
  phase = 'scratch_postgresql';
  const image = await command('docker', ['container', 'inspect', '--format', '{{.Image}}', 'telomere-staging-postgres']);
  const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(image.output);
  if (image.code !== 0) throw new Error('Pinned installed PostgreSQL image unavailable');
  const password = randomBytes(32).toString('hex');
  containerRequested = true;
  const created = await command('docker', ['run', '--detach', '--name', scratchName,
    '--label', `telomere.restore.exercise=${id}`, '--label', 'telomere.restore.scratch=true',
    '--cpus', '0.5', '--memory', '512m', '--pids-limit', '128', '--security-opt', 'no-new-privileges',
    '--publish', `127.0.0.1:${pgPort}:5432`, '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=268435456',
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=telomere_restore', '--env', 'POSTGRES_DB=telomere_restore', imageId],
  { PATH: process.env.PATH, POSTGRES_PASSWORD: password });
  if (created.code !== 0) throw new Error('Scratch PostgreSQL creation failed');
  const pgDeadline = Date.now() + 30000;
  // initdb briefly starts a Unix-socket-only server. Probe TCP so restore waits for the final server.
  while ((await command('docker', ['exec', scratchName, 'pg_isready', '--host=127.0.0.1', '--username=telomere_restore', '--dbname=telomere_restore'])).code !== 0) {
    if (Date.now() >= pgDeadline) throw new Error('Scratch PostgreSQL not ready');
    await delay(200);
  }
  phase = 'archive_restore';
  await restoreArchive(scratchName, join(directory, 'database.dump'));
  const databaseUrl = `postgresql://telomere_restore:${password}@127.0.0.1:${pgPort}/telomere_restore`;
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  const db = drizzle(pool, { schema: storeSchema, casing: 'snake_case' });
  phase = 'scratch_chain';
  const binary = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil');
  anvil = spawn(binary, ['--host', '127.0.0.1', '--port', String(chainPort), '--chain-id', '31337', '--accounts', '0', '--silent',
    '--load-state', join(scratch, 'chain.json')], { stdio: ['ignore', 'ignore', 'ignore'], shell: false });
  let startupFailed = false;
  anvil.once('error', () => { startupFailed = true; });
  const config = loadConfig({ ...parseProfile(await readFile(join(directory, 'profile.env'), 'utf8')), DATABASE_URL: databaseUrl, RPC_URL: `http://127.0.0.1:${chainPort}`,
    CYSTS_DIR: restoredCystDirectory, NEAR_ENDPOINT: undefined, NEAR_MODEL: undefined, NEAR_API_KEY: undefined, NEAR_ALLOWED_MODELS: undefined });
  const bridge = new ChainBridge(config);
  const chainDeadline = Date.now() + 15000;
  while (true) {
    if (startupFailed || anvil.exitCode !== null) throw new Error('Scratch Anvil startup failed');
    try { await bridge.check(); break; } catch { if (Date.now() >= chainDeadline) throw new Error('Scratch chain does not match backup'); }
    await delay(100);
  }
  phase = 'accepted_receipt';
  const evidence = await db.transaction(async transaction => {
    let cystEvidence: Record<string, unknown> = { enabled: false };
    if (config.CYSTS_ENABLED) {
      phase = 'restored_cysts';
      if (!config.CYSTS_DIR || !restoredCystSnapshot) throw new Error('Restored Cyst snapshot unavailable');
      cystEvidence = await verifyRestoredCysts(transaction, config.CYSTS_DIR, restoredCystSnapshot, quotaPolicy ? { quotaPolicy } : {});
    }
    phase = 'accepted_receipt';
    const row = (await transaction.select({ id: jobs.id, status: jobs.status, receipt: jobs.receipt, txHash: jobs.settlementTxHash,
      ceiling: jobs.ceiling, charged: jobs.charged, refund: jobs.refund, billableSeconds: jobs.billableSeconds })
      .from(jobs).where(eq(jobs.id, expectedRun)).limit(1))[0];
    if (!row || row.status !== 'completed' || !row.txHash || row.charged === null || row.refund === null) throw new Error('Accepted run missing from restored archive');
    const receipt = signedReceiptSchema.parse(row.receipt);
    if (receipt.receiptHash !== expectedReceipt || receipt.settlement.runId !== expectedRun) throw new Error('Accepted receipt changed');
    const service = new Service(transaction, bridge, config, false);
    const proof = await service.verifyReceipt(receipt);
    if (!proof.valid || !('anchored' in proof) || !proof.anchored) throw new Error('Restored receipt invalid or unanchored');
    const txHash = bytes32Schema.parse(row.txHash);
    const mined = await bridge.public.getTransactionReceipt({ hash: txHash });
    const block = await bridge.public.getBlock({ blockNumber: mined.blockNumber });
    const settlement = receiptSettlement(receipt);
    const logs = parseEventLogs({ abi: escrowAbi, eventName: 'RunSettled', logs: mined.logs.filter(log => log.address.toLowerCase() === config.ESCROW_ADDRESS.toLowerCase()) });
    if (mined.status !== 'success' || block.hash !== mined.blockHash || !logs.some(log => log.args.runId === expectedRun
      && log.args.receiptHash === expectedReceipt && log.args.billableSeconds === settlement.billableSeconds
      && log.args.inferenceCharge === settlement.inferenceCharge && log.args.amount.toString() === row.charged
      && log.args.returnedAmount.toString() === row.refund)) throw new Error('Restored canonical settlement event mismatch');
    const journal = (await transaction.select({ hash: transactions.hash, nonce: transactions.nonce }).from(transactions)
      .where(eq(transactions.runId, expectedRun)).limit(1))[0];
    if (!journal || journal.hash !== txHash || journal.nonce === null
      || await bridge.public.getTransactionCount({ address: bridge.account.address, blockTag: 'latest' }) <= journal.nonce) throw new Error('Restored transaction journal inconsistent');
    if (BigInt(row.charged) + BigInt(row.refund) !== BigInt(row.ceiling)) throw new Error('Restored billing mismatch');
    const counts = await transaction.select({ status: jobs.status, count: sql<number>`count(*)::integer` }).from(jobs).groupBy(jobs.status);
    return { runId: expectedRun, receiptHash: expectedReceipt, settlementTxHash: txHash, charged: row.charged, refund: row.refund,
      billableSeconds: row.billableSeconds, signatureValid: true, anchored: true, canonicalSettlementEvent: true,
      journalMatches: true, counts: Object.fromEntries(counts.map(count => [count.status, count.count])), cysts: cystEvidence };
  }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
  report = { schemaVersion: 1, status: 'passed', checkedAt: new Date().toISOString(), deployment: 'isolated_restore_exercise',
    chainId: 31337, backupCreatedAt: manifest.createdAt, backupSchemaVersion: manifest.schemaVersion, PostgreSqlRestore: 'empty_scratch_database',
    anvilState: 'matching_private_backup_copy', controllerStarted: false, transactionsSent: 0, paidNearPosts: 0,
    liveStagingModified: false, ...evidence };
} catch {
  report = { schemaVersion: 1, status: 'failed', phase, checkedAt: new Date().toISOString(), controllerStarted: false,
    transactionsSent: 0, paidNearPosts: 0, liveStagingModified: false };
  process.exitCode = 1;
} finally {
  let dbClosed = true, anvilStopped = false, scratchContainerRemoved = false;
  try { await pool?.end(); } catch { dbClosed = false; }
  try { anvilStopped = await stopOwnedAnvil(); } catch { /* Report cleanup failure without exposing private exception data. */ }
  try { scratchContainerRemoved = await removeOwnedContainer(); } catch { /* Only our exact labelled scratch container may be removed. */ }
  const cleanupPassed = dbClosed && anvilStopped && scratchContainerRemoved;
  if (!cleanupPassed) process.exitCode = 1;
  const output = { ...report, ...(!cleanupPassed ? { status: 'cleanup_failed' } : {}), cleanup: { databaseConnectionClosed: dbClosed, ownedAnvilStopped: anvilStopped,
    labelledScratchContainerRemoved: scratchContainerRemoved } };
  if (reportPath) {
    try { await writeFile(reportPath, JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { process.exitCode = 1; }
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}
