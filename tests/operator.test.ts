import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyJournal, type JournalDiagnostic } from '../src/operator/diagnostics.js';
import { backupManifestSchema, createBackupDirectory, finishBackup, privateBackupPath, verifyBackup } from '../src/operator/backup.js';
import { parseProfile, publicProfile } from '../src/operator/profile.js';
import { loadConfig } from '../src/config.js';

const runId = `0x${'aa'.repeat(32)}` as const;
const txHash = `0x${'bb'.repeat(32)}` as const;
const item: JournalDiagnostic = { runId, txHash, status: 'settling', errorCode: null, nonce: 7, runStatus: 1, chainNonce: 7, receipt: null };
const profile = [ 'MODE=demo', 'CHAIN_ID=31337', 'RPC_URL=http://127.0.0.1:18547',
  'SIGNER_PRIVATE_KEY=0x' + '11'.repeat(32), 'DEMO_PRIVATE_KEY=0x' + '22'.repeat(32),
  'ESCROW_ADDRESS=0x3333333333333333333333333333333333333333', 'TOKEN_ADDRESS=0x4444444444444444444444444444444444444444',
  'DATABASE_URL=postgresql://telomere:private-password@127.0.0.1:15434/telomere',
  'CPU_MODE=docker', 'CPU_IMAGE=node@sha256:' + '55'.repeat(32), 'NEAR_API_KEY=',
  'PUBLIC_ORIGIN=http://127.0.0.1:3281' ].join('\n') + '\n';

describe('read-only settlement diagnosis', () => {
  it('does not resolve a signed nonce just because its run was externally refunded', () => {
    expect(classifyJournal({ ...item, runStatus: 3, status: 'refunded' })).toMatchObject({ kind: 'external_refund_unresolved_nonce', nonceResolved: false });
  });
  it('distinguishes canonical mined rejection from an unresolved broadcast', () => {
    expect(classifyJournal({ ...item, chainNonce: 8, receipt: { status: 'reverted', canonical: true } })).toMatchObject({ kind: 'settlement_rejected', nonceResolved: true });
    expect(classifyJournal(item)).toMatchObject({ kind: 'unresolved_transaction_nonce', nonceResolved: false });
  });
  it('does not treat a consumed nonce as proof of a successful settlement', () => {
    expect(classifyJournal({ ...item, chainNonce: 8 })).toMatchObject({ kind: 'nonce_consumed_receipt_unknown', nonceResolved: true });
  });
  it('rejects orphaned receipts and success receipts with mismatched run state', () => {
    expect(classifyJournal({ ...item, receipt: { status: 'success', canonical: false } }).kind).toBe('noncanonical_receipt');
    expect(classifyJournal({ ...item, receipt: { status: 'success', canonical: true } }).kind).toBe('settlement_state_mismatch');
    expect(classifyJournal({ ...item, runStatus: 2, chainNonce: 8, receipt: { status: 'success', canonical: true } }).kind).toBe('settlement_mined');
  });
  it('fails closed when legacy transaction nonce cannot be recovered', () => {
    expect(classifyJournal({ ...item, nonce: null })).toMatchObject({ kind: 'legacy_nonce_unknown', nonceResolved: false });
  });
});

describe('private profiles and matching staging backup sets', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'telomere-backup-'));
    roots.push(root);
    const directory = await createBackupDirectory(join(root, '.local', 'backups', 'sample'));
    await writeFile(join(directory, 'database.dump'), Buffer.from('PGDMPprivate-fixture'), { mode: 0o600 });
    await writeFile(join(directory, 'chain.json'), JSON.stringify({ block: { number: 1 }, accounts: {} }), { mode: 0o600 });
    await writeFile(join(directory, 'profile.env'), profile, { mode: 0o600 });
    return { root, directory };
  }
  it('outputs public metadata without keys, credentials, endpoint or raw env fields', () => {
    const output = JSON.stringify(publicProfile(loadConfig(parseProfile(profile))));
    expect(output).toContain('31337');
    expect(output).not.toContain('private-password');
    expect(output).not.toContain('SIGNER_PRIVATE_KEY');
    expect(output).not.toContain('11'.repeat(32));
    expect(output).not.toContain('22'.repeat(32));
  });
  it('parses literal profiles without shell execution and rejects duplicate or malformed fields', () => {
    expect(parseProfile('NEAR_MODEL="$(whoami)"\n').NEAR_MODEL).toBe('$(whoami)');
    expect(() => parseProfile('MODE=demo\nMODE=testnet')).toThrow();
    expect(() => parseProfile('export MODE=demo')).toThrow();
    expect(() => parseProfile('MODE="demo')).toThrow();
  });
  it('refuses output directories that could put secrets in tracked deliverables', () => {
    expect(() => privateBackupPath(join(tmpdir(), 'outputs', 'backups', 'run'))).toThrow();
  });
  it('verifies all matching files and safe public identities without restoring anything', async () => {
    const { directory } = await fixture();
    const manifest = await finishBackup(directory);
    expect(await verifyBackup(directory)).toEqual(manifest);
    expect(manifest.files).toHaveLength(3);
    expect(JSON.stringify(manifest)).not.toContain('private-password');
  });
  it('detects a changed archive instead of accepting a partial or inconsistent set', async () => {
    const { directory } = await fixture();
    await finishBackup(directory);
    await writeFile(join(directory, 'database.dump'), 'PGDMPaltered', { mode: 0o600 });
    await expect(verifyBackup(directory)).rejects.toThrow('checksum');
  });
  it('rejects unsafe manifest filenames and duplicate entries', async () => {
    const { directory } = await fixture();
    const manifest = await finishBackup(directory);
    expect(backupManifestSchema.safeParse({ ...manifest, files: [manifest.files[0], manifest.files[0], manifest.files[2]] }).success).toBe(false);
    expect(backupManifestSchema.safeParse({ ...manifest, files: [{ ...manifest.files[0], name: '../profile.env' }, manifest.files[1], manifest.files[2]] }).success).toBe(false);
  });
  it('does not let checksums alone authenticate a different profile identity', async () => {
    const { directory } = await fixture();
    await finishBackup(directory);
    const raw = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as unknown;
    const manifest = backupManifestSchema.parse(raw);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, signer: '0x9999999999999999999999999999999999999999' }), { mode: 0o600 });
    await expect(verifyBackup(directory)).rejects.toThrow('profile mismatch');
  });
  it.skipIf(process.platform === 'win32')('rejects public permissions and symlinked backup files', async () => {
    const { root, directory } = await fixture();
    await finishBackup(directory);
    await chmod(join(directory, 'profile.env'), 0o644);
    await expect(verifyBackup(directory)).rejects.toThrow('private');
    await chmod(join(directory, 'profile.env'), 0o600);
    const original = await readFile(join(directory, 'chain.json'));
    const external = join(root, 'chain-external.json');
    await writeFile(external, original, { mode: 0o600 });
    await rm(join(directory, 'chain.json'));
    await symlink(external, join(directory, 'chain.json'));
    await expect(verifyBackup(directory)).rejects.toThrow('Invalid backup file');
  });
  it('refuses an already existing capture directory, preserving its original files', async () => {
    const { directory } = await fixture();
    await expect(createBackupDirectory(directory)).rejects.toThrow();
    expect(await readFile(join(directory, 'profile.env'), 'utf8')).toBe(profile);
  });
  it('rejects a directory symlink before writing private backup files', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'telomere-backup-'));
    roots.push(root);
    const outside = join(root, 'external');
    await mkdir(outside);
    await mkdir(join(root, '.local'));
    await symlink(outside, join(root, '.local', 'redirect'));
    await expect(createBackupDirectory(join(root, '.local', 'redirect', 'capture'))).rejects.toThrow('symlinks');
  });
});
