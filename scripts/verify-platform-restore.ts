import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createPublicClient, defineChain, http, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { z } from 'zod';
import { admissionHash } from '../src/host-kit/admission.js';
import { dockerHostScope } from '../src/host-kit/hosted.js';
import { assertPaidCystInputLocation, readPaidCystInputConfig } from '../src/host-kit/sessions/cyst-input-config.js';
import { paidCystInputSpoolIdentity } from '../src/host-kit/sessions/cyst-input-spool.js';
import { hashBackupFile, createBackupDirectory, readBackupCystQuotaPolicy } from '../src/operator/backup.js';
import { auditPlatformJournal } from '../src/operator/platform-journal-audit.js';
import { fingerprintPlatformDatabase, readPlatformBackupBinding, restorePlatformHostFiles,
  verifyPaidDockerInventory, verifyPlatformBackupManifest, verifyPlatformHostSemantic, verifyPlatformLargeCysts, verifyPlatformSignedJournal,
  verifyPlatformSmallCysts } from '../src/operator/platform-backup.js';
import { readProfile } from '../src/operator/profile.js';
import { unusedLocalPort } from './local-chain.js';

let phase = 'arguments', container: string | undefined, label: string | undefined;
let scratchHost: string | undefined;
let dockerHostForCleanup: string | undefined;
async function command(binary: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<string> {
  const result = await new Promise<{ code: number; output: string }>((accept, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false, ...(env ? { env } : {}) });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 16_384) child.kill('SIGKILL'); });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); accept({ code: code ?? -1, output: output.trim() }); });
  });
  if (result.code !== 0 || result.output.length > 16_384) throw new Error('Scratch command failed');
  return result.output;
}
async function stopped(controller: string, host: string, dockerHost: string): Promise<void> {
  for (const service of [controller, host]) {
    if (await command('systemctl', ['show', service, '--property=LoadState', '--value']) !== 'loaded'
      || await command('systemctl', ['show', service, '--property=ActiveState', '--value']) !== 'inactive') {
      throw new Error('Paid services must remain stopped for restore drill');
    }
  }
  await verifyPaidDockerInventory(dockerHost, command);
}
async function restoreDatabase(name: string, archive: string, dockerHost: string): Promise<void> {
  const child = spawn('docker', ['--host', dockerHost, 'exec', '-i', name, 'pg_restore', '--username=telomere_restore',
    '--dbname=telomere_restore', '--exit-on-error', '--no-owner', '--no-acl'], {
    stdio: ['pipe', 'ignore', 'ignore'], shell: false,
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  const done = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? accept() : reject(new Error('Scratch PostgreSQL restore failed')));
  });
  try { await Promise.all([pipeline(createReadStream(archive), child.stdin), done]); }
  finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
}
try {
  if (process.platform !== 'linux') throw new Error('Paid restore drill runs on Linux');
  const { values } = parseArgs({ options: { directory: { type: 'string' }, 'env-file': { type: 'string' },
    'controller-service': { type: 'string' }, 'host-service': { type: 'string' },
    'postgres-image': { type: 'string' }, 'docker-socket': { type: 'string' },
    'host-isolation': { type: 'string' }, 'host-cyst-inputs-config': { type: 'string' },
    'host-cyst-inputs-sha256': { type: 'string' }, 'host-directory': { type: 'string' } }, strict: true, allowPositionals: false });
  const serviceName = z.string().regex(/^telomere-[a-zA-Z0-9@_.-]+\.service$/);
  const controller = serviceName.parse(values['controller-service']), hostService = serviceName.parse(values['host-service']);
  if (controller === hostService) throw new Error('Controller and host services must be distinct');
  const image = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(values['postgres-image']);
  const dockerSocket = z.string().regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.sock$/).parse(values['docker-socket']);
  const hostIsolation = z.enum(['gvisor', 'kata', 'docker_development']).parse(values['host-isolation']);
  const dockerHost = `unix://${dockerSocket}`;
  dockerHostForCleanup = dockerHost;
  const directory = resolve(z.string().min(1).max(4096).parse(values.directory));
  const profile = z.string().min(1).max(4096).parse(values['env-file']);
  phase = 'backup_integrity';
  const manifest = await verifyPlatformBackupManifest(directory);
  const config = await readProfile(profile), binding = await readPlatformBackupBinding(config);
  const quotaPolicy = await readBackupCystQuotaPolicy(config);
  const cystInputConfig = await readPaidCystInputConfig(values['host-cyst-inputs-config'], values['host-cyst-inputs-sha256']);
  if (cystInputConfig && !values['host-directory']) throw new Error('File-input restore verification requires the original HostKit directory');
  if (values['host-directory']) assertPaidCystInputLocation(cystInputConfig, values['host-directory']);
  const hostScope = dockerHostScope({ hostKey: binding.hostKey, controlKey: binding.controlKey,
    isolation: hostIsolation, socketPath: dockerSocket,
    ...(cystInputConfig ? { cystInputIdentity: paidCystInputSpoolIdentity(cystInputConfig) } : {}) });
  if (config.CHAIN_ID !== manifest.chainId || binding.configSha256 !== manifest.platformConfigSha256
    || binding.hostId !== manifest.hostId || binding.hostKey !== manifest.hostKey
    || binding.signer !== manifest.journalSigner || binding.controlKey !== manifest.hostControlKey
    || admissionHash(hostScope) !== manifest.hostScopeSha256
    || (await hashBackupFile(profile)).sha256 !== manifest.profileSha256
    || !config.CYSTS_REPLICATION_CONFIG || !config.CYSTS_LARGE_REPLICATION_CONFIG
    || (await hashBackupFile(config.CYSTS_REPLICATION_CONFIG)).sha256 !== manifest.smallConfigSha256
    || (await hashBackupFile(config.CYSTS_LARGE_REPLICATION_CONFIG)).sha256 !== manifest.largeConfigSha256) {
    throw new Error('Backup deployment/configuration pins changed');
  }
  await stopped(controller, hostService, dockerHost);
  const chain = defineChain({ id: config.CHAIN_ID, name: 'Telomere paid restore',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.RPC_URL] } } });
  const rpc = createPublicClient({ chain, transport: http(config.RPC_URL, { timeout: 10_000, retryCount: 0 }) });
  if (await rpc.getChainId() !== config.CHAIN_ID) throw new Error('Restore chain changed');
  const blockNumber = BigInt(manifest.blockNumber);
  if ((await rpc.getBlock({ blockNumber })).hash.toLowerCase() !== manifest.blockHash) {
    throw new Error('Backup chain anchor is noncanonical');
  }
  phase = 'scratch_host';
  const id = randomUUID().replaceAll('-', '');
  const scratch = await createBackupDirectory(`/opt/telomere-pilot/backups/paid-restore-${id}`);
  scratchHost = join(scratch, 'host');
  await restorePlatformHostFiles(join(directory, 'host'), scratchHost,
    { files: manifest.hostFiles, directories: manifest.hostDirectories });
  phase = 'scratch_postgresql';
  const port = await unusedLocalPort();
  if ([13280, 13290, 15434, 18547].includes(port)) throw new Error('Scratch port overlaps a service');
  const password = randomBytes(32).toString('hex');
  container = `telomere-paid-restore-${id}`; label = id;
  await command('docker', ['--host', dockerHost, 'run', '--pull=never', '--detach', '--name', container,
    '--label', `telomere.paid-restore.exercise=${id}`, '--cpus', '0.5', '--memory', '512m', '--pids-limit', '128',
    '--security-opt', 'no-new-privileges', '--publish', `127.0.0.1:${port}:5432`,
    '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=268435456',
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=telomere_restore',
    '--env', 'POSTGRES_DB=telomere_restore', image],
  { PATH: process.env.PATH, POSTGRES_PASSWORD: password }, 30_000);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await command('docker', ['--host', dockerHost, 'exec', container, 'pg_isready', '--host=127.0.0.1',
      '--username=telomere_restore', '--dbname=telomere_restore']); break; }
    catch { if (Date.now() >= deadline) throw new Error('Scratch PostgreSQL did not become ready'); await delay(200); }
  }
  phase = 'archive_restore';
  await restoreDatabase(container, join(directory, 'database.dump'), dockerHost);
  const database = new pg.Client({ connectionString: `postgresql://telomere_restore:${password}@127.0.0.1:${port}/telomere_restore`,
    connectionTimeoutMillis: 5000, statement_timeout: 30_000, application_name: 'telomere-paid-scratch-restore' });
  let hostEvidence: Awaited<ReturnType<typeof verifyPlatformHostSemantic>>;
  try {
    await database.connect();
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    phase = 'restored_database';
    const tables = await fingerprintPlatformDatabase(database);
    if (JSON.stringify(tables) !== JSON.stringify(manifest.tables)
      || await verifyPlatformSignedJournal(database, config.CHAIN_ID) !== manifest.journalRows) {
      throw new Error('Restored database state or signed journal changed');
    }
    if (JSON.stringify(await verifyPlatformSmallCysts(database, config, quotaPolicy ? { quotaPolicy } : {})) !== JSON.stringify(manifest.smallCysts)) {
      throw new Error('Restored small Cyst metadata/remote replicas changed');
    }
    phase = 'restored_host';
    hostEvidence = await verifyPlatformHostSemantic(scratchHost, manifest.hostId, manifest.hostKey,
      binding.controlKey, hostScope, database);
    phase = 'canonical_journal';
    const rows = await database.query(`SELECT key,chain_id AS "chainId",sender,"to",data,raw,hash,nonce
      FROM platform_transaction_journal ORDER BY chain_id,sender,nonce,key LIMIT 4097`);
    const journal = await auditPlatformJournal(rows.rows, { chainId: config.CHAIN_ID, signer: manifest.journalSigner,
      escrow: binding.pins.escrowAddress, receiptRoot: binding.pins.receiptRootAddress,
      initialNonce: manifest.initialSignerNonce }, {
      getReferenceBlock: async () => ({ number: blockNumber, hash: manifest.blockHash as Hex }),
      getTransactionReceipt: async hash => {
        try { return await rpc.getTransactionReceipt({ hash }); }
        catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
      },
      getBlockHash: async number => (await rpc.getBlock({ blockNumber: number })).hash,
      getLatestNonce: async (address, at) => rpc.getTransactionCount(at === undefined
        ? { address, blockTag: 'latest' } : { address, blockNumber: at }),
    });
    if (journal.status !== 'ok') throw new Error('Canonical signed journal audit failed');
    await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await database.end(); }
  phase = 'large_cyst_replicas';
  if (JSON.stringify(await verifyPlatformLargeCysts(config)) !== JSON.stringify(manifest.largeCysts)) {
    throw new Error('Restored large Cyst remote digest scan changed');
  }
  await stopped(controller, hostService, dockerHost);
  if ((await rpc.getBlock({ blockNumber })).hash.toLowerCase() !== manifest.blockHash) throw new Error('Backup anchor changed during drill');
  process.stdout.write(JSON.stringify({ status: 'paid_isolated_restore_verified', chainId: manifest.chainId,
    tables: manifest.tables.length, journalRows: manifest.journalRows, ...hostEvidence,
    smallCysts: manifest.smallCysts.records, largeCysts: manifest.largeCysts.records,
    PostgreSqlRestore: 'empty_scratch_container', hostJournalRestore: 'private_scratch_copy',
    remoteCiphertextCopied: false, configurationRecovery: false, largeShadowRecovery: false,
    fullDisasterRecovery: false, transactionsSent: 0 }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ status: 'paid_restore_failed', phase, transactionsSent: 0 }) + '\n');
  process.exitCode = 1;
} finally {
  if (container && label && dockerHostForCleanup) {
    try {
      const found = await command('docker', ['--host', dockerHostForCleanup, 'container', 'inspect', '--format', '{{index .Config.Labels "telomere.paid-restore.exercise"}}', container]);
      if (found === label) await command('docker', ['--host', dockerHostForCleanup, 'container', 'rm', '--force', container]);
      else process.exitCode = 1;
    } catch { process.exitCode = 1; }
  }
  if (scratchHost && /^\/opt\/telomere-pilot\/backups\/paid-restore-[a-f0-9]{32}\/host$/.test(scratchHost)) {
    try { await rm(scratchHost, { recursive: true }); } catch { process.exitCode = 1; }
  }
}
