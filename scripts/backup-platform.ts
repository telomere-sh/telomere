import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createPublicClient, defineChain, http } from 'viem';
import { z } from 'zod';
import { admissionHash } from '../src/host-kit/admission.js';
import { dockerHostScope } from '../src/host-kit/hosted.js';
import { assertPaidCystInputLocation, readPaidCystInputConfig } from '../src/host-kit/sessions/cyst-input-config.js';
import { paidCystInputSpoolIdentity } from '../src/host-kit/sessions/cyst-input-spool.js';
import { createBackupDirectory, hashBackupFile, readBackupCystQuotaPolicy } from '../src/operator/backup.js';
import { fingerprintPlatformDatabase, readPlatformBackupBinding, restorePlatformHostFiles, snapshotPlatformHost,
  verifyPaidDockerInventory, verifyPlatformBackupManifest, verifyPlatformHostFiles, verifyPlatformLargeCysts,
  verifyPlatformHostSemantic, verifyPlatformSignedJournal, verifyPlatformSmallCysts,
  writePlatformBackupManifest } from '../src/operator/platform-backup.js';
import { readProfile } from '../src/operator/profile.js';

let phase = 'arguments';
async function command(binary: string, args: string[]): Promise<string> {
  const result = await new Promise<{ code: number; output: string }>((accept, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 16_384) child.kill('SIGKILL'); });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); accept({ code: code ?? -1, output: output.trim() }); });
  });
  if (result.code !== 0 || result.output.length > 16_384) throw new Error('Backup prerequisite failed');
  return result.output;
}
async function stopped(controller: string, host: string, dockerHost: string): Promise<void> {
  for (const service of [controller, host]) {
    if (await command('systemctl', ['show', service, '--property=LoadState', '--value']) !== 'loaded'
      || await command('systemctl', ['show', service, '--property=ActiveState', '--value']) !== 'inactive') {
      throw new Error('Paid controller and HostKit services must be stopped');
    }
  }
  await verifyPaidDockerInventory(dockerHost, command);
}
async function dumpDatabase(destination: string, url: URL, snapshot: string,
  dockerHost: string, container: string): Promise<void> {
  const file = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const child = spawn('docker', ['--host', dockerHost, 'exec', '-i', '--env', 'PGPASSWORD', container,
    'pg_dump', '--host=127.0.0.1', '--port=5432', `--username=${decodeURIComponent(url.username)}`,
    `--dbname=${decodeURIComponent(url.pathname.slice(1))}`, '--format=custom', '--no-owner', '--no-acl',
    `--snapshot=${snapshot}`], {
    stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    env: { PATH: process.env.PATH, PGPASSWORD: decodeURIComponent(url.password) },
  });
  let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_073_741_824) child.kill('SIGKILL'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  const finished = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 && bytes > 5 && bytes <= 1_073_741_824
      ? accept() : reject(new Error('Snapshot-pinned PostgreSQL dump failed')));
  });
  try { await Promise.all([pipeline(child.stdout, file), finished]); }
  finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
  const durable = await open(destination, 'r+');
  try { await durable.sync(); } finally { await durable.close(); }
}

try {
  if (process.platform !== 'linux') throw new Error('Paid stopped-state backup runs on Linux');
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, output: { type: 'string' },
    'controller-service': { type: 'string' }, 'host-service': { type: 'string' },
    'host-directory': { type: 'string' }, 'initial-signer-nonce': { type: 'string' },
    'docker-socket': { type: 'string' }, 'host-isolation': { type: 'string' },
    'host-cyst-inputs-config': { type: 'string' }, 'host-cyst-inputs-sha256': { type: 'string' },
    'postgres-container': { type: 'string' } },
    strict: true, allowPositionals: false });
  const serviceName = z.string().regex(/^telomere-[a-zA-Z0-9@_.-]+\.service$/);
  const controller = serviceName.parse(values['controller-service']), host = serviceName.parse(values['host-service']);
  if (controller === host) throw new Error('Controller and host services must be distinct');
  const hostDirectory = z.string().min(1).max(4096).parse(values['host-directory']);
  const postgresContainer = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).parse(values['postgres-container']);
  const dockerSocket = z.string().regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.sock$/).parse(values['docker-socket']);
  const hostIsolation = z.enum(['gvisor', 'kata', 'docker_development']).parse(values['host-isolation']);
  const dockerHost = `unix://${dockerSocket}`;
  const nonce = z.coerce.number().int().nonnegative().safe().parse(values['initial-signer-nonce']);
  const profile = z.string().min(1).max(4096).parse(values['env-file']);
  phase = 'profile';
  const profileSha256 = (await hashBackupFile(profile)).sha256;
  const config = await readProfile(profile), binding = await readPlatformBackupBinding(config);
  const quotaPolicy = await readBackupCystQuotaPolicy(config);
  const cystInputConfig = await readPaidCystInputConfig(values['host-cyst-inputs-config'], values['host-cyst-inputs-sha256']);
  assertPaidCystInputLocation(cystInputConfig, hostDirectory);
  const hostScope = dockerHostScope({ hostKey: binding.hostKey, controlKey: binding.controlKey,
    isolation: hostIsolation, socketPath: dockerSocket,
    ...(cystInputConfig ? { cystInputIdentity: paidCystInputSpoolIdentity(cystInputConfig) } : {}) });
  if (!config.DATABASE_URL || !config.CYSTS_REPLICATION_CONFIG || !config.CYSTS_LARGE_REPLICATION_CONFIG) {
    throw new Error('Paid backup requires PostgreSQL and both reviewed Cyst replications');
  }
  const smallConfigSha256 = (await hashBackupFile(config.CYSTS_REPLICATION_CONFIG)).sha256;
  const largeConfigSha256 = (await hashBackupFile(config.CYSTS_LARGE_REPLICATION_CONFIG)).sha256;
  if ((await hashBackupFile(profile)).sha256 !== profileSha256
    || (await hashBackupFile(config.PLATFORM_RUNTIME_CONFIG!)).sha256 !== binding.configSha256) {
    throw new Error('Paid profile or platform configuration changed while loading');
  }
  const databaseUrl = new URL(config.DATABASE_URL);
  if (!['postgresql:', 'postgres:'].includes(databaseUrl.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname)
    || !databaseUrl.pathname.slice(1) || !databaseUrl.username || databaseUrl.search || databaseUrl.hash) {
    throw new Error('Stopped-state dump requires a local PostgreSQL endpoint');
  }
  const portBinding = z.array(z.object({ HostIp: z.literal('127.0.0.1'),
    HostPort: z.string().regex(/^[1-9][0-9]{0,4}$/) }).strict()).length(1).parse(JSON.parse(await command('docker',
      ['--host', dockerHost, 'container', 'inspect', '--format', '{{json (index .NetworkSettings.Ports "5432/tcp")}}', postgresContainer])));
  if (portBinding[0]!.HostPort !== (databaseUrl.port || '5432')) throw new Error('PostgreSQL container and profile port differ');
  phase = 'stopped_state';
  await stopped(controller, host, dockerHost);
  const chain = defineChain({ id: config.CHAIN_ID, name: 'Telomere paid backup',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.RPC_URL] } } });
  const rpc = createPublicClient({ chain, transport: http(config.RPC_URL, { timeout: 10_000, retryCount: 0 }) });
  if (await rpc.getChainId() !== config.CHAIN_ID) throw new Error('Backup chain changed');
  const anchor = await rpc.getBlock();
  if (anchor.number === null || !anchor.hash) throw new Error('Backup chain anchor unavailable');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = await createBackupDirectory(values.output ?? `/opt/telomere-pilot/backups/paid-${timestamp}`);
  phase = 'host_journal';
  const hostSnapshot = await snapshotPlatformHost(hostDirectory, join(directory, 'host'));
  if (await verifyPlatformHostFiles(join(directory, 'host'), hostSnapshot) !== binding.hostKey) {
    throw new Error('Host signing key does not match reviewed platform host');
  }
  phase = 'database';
  const database = new pg.Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000,
    statement_timeout: 30_000, application_name: 'telomere-paid-stopped-backup' });
  let tables: Awaited<ReturnType<typeof fingerprintPlatformDatabase>>;
  let journalRows: number;
  let smallCysts: Awaited<ReturnType<typeof verifyPlatformSmallCysts>>;
  let hostEvidence: Awaited<ReturnType<typeof verifyPlatformHostSemantic>>;
  try {
    await database.connect();
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const active = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM platform_runs
      WHERE status NOT IN ('completed','refunded')`);
    if (active.rows[0]?.count !== '0') throw new Error('Active paid runs need reconciliation before backup');
    const exportResult = await database.query<{ pg_export_snapshot: string }>('SELECT pg_export_snapshot()');
    const snapshot = exportResult.rows[0]?.pg_export_snapshot;
    if (!snapshot || !/^[0-9A-Fa-f-]{1,80}$/.test(snapshot)) throw new Error('PostgreSQL exported snapshot unavailable');
    await dumpDatabase(join(directory, 'database.dump'), databaseUrl, snapshot, dockerHost, postgresContainer);
    tables = await fingerprintPlatformDatabase(database);
    journalRows = await verifyPlatformSignedJournal(database, config.CHAIN_ID);
    smallCysts = await verifyPlatformSmallCysts(database, config, quotaPolicy ? { quotaPolicy } : {});
    const scratchHost = join(directory, `_host-semantic-${randomUUID().replaceAll('-', '')}`);
    try {
      await restorePlatformHostFiles(join(directory, 'host'), scratchHost, hostSnapshot);
      hostEvidence = await verifyPlatformHostSemantic(scratchHost, binding.hostId, binding.hostKey,
        binding.controlKey, hostScope, database);
    } finally { await rm(scratchHost, { recursive: true, force: true }); }
    await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await database.end(); }
  phase = 'large_cyst_replicas';
  const largeCysts = await verifyPlatformLargeCysts(config);
  await stopped(controller, host, dockerHost);
  if ((await rpc.getBlock({ blockNumber: anchor.number })).hash.toLowerCase() !== anchor.hash.toLowerCase()) {
    throw new Error('Chain anchor changed during capture');
  }
  phase = 'manifest';
  if ((await hashBackupFile(profile)).sha256 !== profileSha256
    || (await hashBackupFile(config.PLATFORM_RUNTIME_CONFIG!)).sha256 !== binding.configSha256
    || (await hashBackupFile(config.CYSTS_REPLICATION_CONFIG)).sha256 !== smallConfigSha256
    || (await hashBackupFile(config.CYSTS_LARGE_REPLICATION_CONFIG)).sha256 !== largeConfigSha256) {
    throw new Error('Paid profile or Cyst configuration changed during capture');
  }
  await writePlatformBackupManifest(directory, { schemaVersion: 1, kind: 'paid_platform_stopped_state',
    createdAt: new Date().toISOString(), chainId: config.CHAIN_ID, blockNumber: anchor.number.toString(),
    blockHash: anchor.hash.toLowerCase(), profileSha256, platformConfigSha256: binding.configSha256,
    smallConfigSha256, largeConfigSha256,
    hostId: binding.hostId, hostKey: binding.hostKey, hostControlKey: binding.controlKey,
    hostScopeSha256: admissionHash(hostScope), journalSigner: binding.signer,
    initialSignerNonce: nonce, servicesStopped: true, managedCellsAbsent: true, activeRunsAbsent: true,
    hostFiles: hostSnapshot.files, hostDirectories: hostSnapshot.directories, tables, journalRows, smallCysts, largeCysts,
    files: [{ name: 'database.dump', ...await hashBackupFile(join(directory, 'database.dump')) }],
    externalCiphertextRequired: true, configurationRecovery: false, largeShadowRecovery: false,
    fullDisasterRecovery: false });
  await verifyPlatformBackupManifest(directory);
  await stopped(controller, host, dockerHost);
  process.stdout.write(JSON.stringify({ status: 'paid_stopped_backup_verified', directory, chainId: config.CHAIN_ID,
    tables: tables.length, journalRows, hostFiles: hostSnapshot.files.length, smallCysts: smallCysts.records,
    largeCysts: largeCysts.records, ...hostEvidence, remoteCiphertextCopied: false,
    configurationRecovery: false, largeShadowRecovery: false, fullDisasterRecovery: false,
    transactionsSent: 0 }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ status: 'paid_backup_failed', phase, transactionsSent: 0 }) + '\n');
  process.exitCode = 1;
}
