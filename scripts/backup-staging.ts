import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import pg from 'pg';
import { CYST_BACKUP_LIMITS, captureCystSnapshot, createBackupDirectory, copyPrivate, cystSnapshotFileName,
  finishBackup, verifyBackup, type CystBackupReference } from '../src/operator/backup.js';
import { readProfile } from '../src/operator/profile.js';
import type { Config } from '../src/config.js';

async function command(binary: string, args: string[]): Promise<{ code: number; output: string }> {
  return await new Promise((accept, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Backup prerequisite timed out')); }, 10000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 16384) child.kill('SIGKILL'); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); if (output.length > 16384) reject(new Error('Backup prerequisite exceeded limit'));
      else accept({ code: code ?? -1, output: output.trim() }); });
  });
}

async function prerequisites(): Promise<void> {
  for (const service of ['telomere-staging.service', 'telomere-staging-chain.service']) {
    const loaded = await command('systemctl', ['show', service, '--property=LoadState', '--value']);
    const state = await command('systemctl', ['show', service, '--property=ActiveState', '--value']);
    if (loaded.code !== 0 || loaded.output !== 'loaded' || state.code !== 0 || state.output !== 'inactive') throw new Error('Stop both staging services cleanly before backup');
  }
  const cells = await command('docker', ['ps', '--all', '--filter', 'label=telomere.managed=true', '--format', '{{.ID}}']);
  if (cells.code !== 0 || cells.output !== '') throw new Error('Confirm workload cleanup before backup');
}

async function dumpDatabase(destination: string): Promise<void> {
  const file = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const child = spawn('docker', ['exec', 'telomere-staging-postgres', 'pg_dump', '--username=telomere', '--dbname=telomere',
    '--format=custom', '--no-owner', '--no-acl'], { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
  let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1073741824) child.kill('SIGKILL'); });
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
  const completion = new Promise<void>((accept, reject) => {
    child.on('error', reject);
    child.on('close', code => { if (code === 0 && bytes > 5 && bytes <= 1073741824) accept(); else reject(new Error('PostgreSQL dump failed')); });
  });
  try { await Promise.all([pipeline(child.stdout, file), completion]); }
  finally { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); }
  const durable = await open(destination, 'r+');
  try { await durable.sync(); } finally { await durable.close(); }
}

async function snapshotCysts(config: Config, destination: string): Promise<void> {
  if (!config.CYSTS_ENABLED || !config.CYSTS_DIR || !config.DATABASE_URL) throw new Error('Enabled Cyst capture requires explicit storage and PostgreSQL');
  const database = new pg.Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await database.connect();
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await database.query<CystBackupReference>(
      'SELECT owner, id, sha256, ciphertext_bytes AS "ciphertextBytes", state FROM cysts ORDER BY owner, id LIMIT 65537');
    if (result.rows.length > CYST_BACKUP_LIMITS.maxMetadataRecords) throw new Error('Cyst metadata exceeds backup limit');
    // No ready checkpoint may become a verified backup without its exact immutable blob.
    // Pending uploads with no blob remain pending in the restored database.
    await captureCystSnapshot(config.CYSTS_DIR, destination, result.rows);
    await database.query('COMMIT');
  } finally { await database.end(); }
}

try {
  if (process.platform !== 'linux') throw new Error('Staging capture runs on the Linux VPS');
  const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true, allowPositionals: false });
  const profile = '/opt/telomere-pilot/config/staging.env';
  const config = await readProfile(profile);
  const database = new URL(z.string().url().parse(config.DATABASE_URL));
  if (config.MODE !== 'demo' || config.CHAIN_ID !== 31337 || database.hostname !== '127.0.0.1' || database.port !== '15434'
    || database.pathname !== '/telomere' || database.username !== 'telomere' || config.RPC_URL !== 'http://127.0.0.1:18547') throw new Error('Unexpected staging profile');
  await prerequisites();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = await createBackupDirectory(values.output ?? `/opt/telomere-pilot/backups/${timestamp}`);
  await dumpDatabase(join(directory, 'database.dump'));
  // Recheck after capture so an accidental service start cannot silently produce a complete manifest.
  await prerequisites();
  await copyPrivate('/opt/telomere-pilot/data/chain.json', join(directory, 'chain.json'));
  await copyPrivate(profile, join(directory, 'profile.env'));
  if (config.CYSTS_ENABLED) await snapshotCysts(config, join(directory, cystSnapshotFileName));
  await prerequisites();
  await finishBackup(directory);
  const manifest = await verifyBackup(directory);
  process.stdout.write(JSON.stringify({ status: 'verified_backup', directory, chainId: manifest.chainId, files: manifest.files.map(file => file.name),
    schemaVersion: manifest.schemaVersion, ...(manifest.schemaVersion === 2 ? { cysts: manifest.cysts } : {}),
    servicesStarted: false, transactionsSent: 0, secretFilesPrivate: true }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ status: 'backup_failed', detail: 'Run on the VPS with both dedicated staging services inactive and all managed cells absent. Preserve partial captures for inspection.' }) + '\n');
  process.exitCode = 1;
}
