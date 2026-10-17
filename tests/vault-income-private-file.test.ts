import { execFile } from 'node:child_process';
import { chmod, chown, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateVaultIncomeText } from '../src/payments/vault-income-private-file.js';

const execute = promisify(execFile), failure = 'Private Vault income file is unavailable';
// This mutation is confined to disposable fixture files. Production only reads ACLs.
const secureScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $env:TELOMERE_TEST_PRIVATE_PATH -ErrorAction Stop
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $acl.SetOwner($sid) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existing in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { $acl.RemoveAccessRuleSpecific($existing) }
  foreach ($s in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s), 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
  }
  if ($env:TELOMERE_TEST_BROAD_ACL -eq 'yes') {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
  }
  Set-Acl -LiteralPath $env:TELOMERE_TEST_PRIVATE_PATH -AclObject $acl -ErrorAction Stop
  [Console]::Out.Write('secured')
} catch { [Console]::Out.Write('denied') }
`;
async function secure(path: string, broad = false): Promise<void> {
  if (process.platform !== 'win32') { await chmod(path, 0o600); return; }
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !['psmodulepath', 'telomere_test_private_path', 'telomere_test_broad_acl'].includes(name.toLowerCase())));
  const result = await execute(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(secureScript, 'utf16le').toString('base64')],
    { timeout: 5000, windowsHide: true, maxBuffer: 64, encoding: 'utf8',
      env: { ...inherited, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        TELOMERE_TEST_PRIVATE_PATH: path, TELOMERE_TEST_BROAD_ACL: broad ? 'yes' : 'no' } });
  if (result.stdout !== 'secured' || result.stderr) throw new Error('Private fixture ACL setup failed');
}

describe('bounded private Vault income files with actual filesystem permissions and Windows ACLs', () => {
  let directory: string, path: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'telomere-vault-income-private-'));
    path = join(directory, "private-sentinel-'quoted.json");
    await writeFile(path, '{"reviewed":"fixture"}', { mode: 0o600 }); await secure(path);
  });
  afterEach(async () => {
    const owned = resolve(directory);
    if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('telomere-vault-income-private-')) throw new Error('Unsafe private fixture cleanup');
    await rm(owned, { recursive: true, force: true });
  });
  it('reads exact private Unicode text and preserves a BOM for the caller strict parser', async () => {
    const text = '{"reviewed":"Привет 🧬"}'; await writeFile(path, text);
    expect(await privateVaultIncomeText(path, 8192)).toBe(text);
    await writeFile(path, '\uFEFF' + text);
    expect(await privateVaultIncomeText(path, 8192)).toBe('\uFEFF' + text);
  });
  it('enforces byte bounds before reading and permits an exact byte limit', async () => {
    const text = '🧬'.repeat(20); await writeFile(path, text);
    expect(await privateVaultIncomeText(path, 80)).toBe(text);
    await expect(privateVaultIncomeText(path, 79)).rejects.toThrow(failure);
    await writeFile(path, '0x' + 'ab'.repeat(32) + '\n');
    expect(await privateVaultIncomeText(path, 80)).toBe('0x' + 'ab'.repeat(32) + '\n');
  });
  it.each([0, -1, 1.5, Number.NaN, 1_048_577])('refuses invalid bound %s', async maximum => {
    await expect(privateVaultIncomeText(path, maximum)).rejects.toThrow(failure);
  });
  it('refuses empty and oversized files without truncating or repairing them', async () => {
    await writeFile(path, ''); await expect(privateVaultIncomeText(path, 8192)).rejects.toThrow(failure);
    await writeFile(path, Buffer.alloc(8193, 0x61));
    await expect(privateVaultIncomeText(path, 8192)).rejects.toThrow(failure);
  });
  it.each([Buffer.from([0x80]), Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82])])('refuses malformed or incomplete UTF-8 %j', async bytes => {
    await writeFile(path, bytes); await expect(privateVaultIncomeText(path, 80)).rejects.toThrow(failure);
  });
  it('refuses NUL text and returns only a fixed safe diagnostic', async () => {
    await writeFile(path, 'private-content-sentinel\0');
    try { await privateVaultIncomeText(path, 80); throw new Error('Expected private read failure'); }
    catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe(failure); expect(String(error)).not.toContain('sentinel'); }
  });
  it('refuses missing, relative, NUL and malformed paths with no private path diagnostic', async () => {
    for (const invalid of [join(directory, 'missing-secret-path'), 'relative-private.json', path + '\0', path + '\uD800']) {
      await expect(privateVaultIncomeText(invalid, 80)).rejects.toThrow(failure);
    }
  });
  it('refuses directories and actual hard-linked files', async () => {
    await expect(privateVaultIncomeText(directory, 8192)).rejects.toThrow(failure);
    await link(path, join(directory, 'second-name.json'));
    await expect(privateVaultIncomeText(path, 8192)).rejects.toThrow(failure);
  });
  it.skipIf(process.platform === 'win32')('requires exact private POSIX 0600 and never repairs unsafe permissions', async () => {
    for (const mode of [0o666, 0o640, 0o400, 0o700]) {
      await chmod(path, mode); await expect(privateVaultIncomeText(path, 8192)).rejects.toThrow(failure);
    }
    await chmod(path, 0o600); expect(await privateVaultIncomeText(path, 8192)).toBe('{"reviewed":"fixture"}');
  });
  it.skipIf(process.platform === 'win32' || process.geteuid?.() !== 0)('refuses a private POSIX file owned by a different effective user', async () => {
    await chown(path, 65534, 65534); await expect(privateVaultIncomeText(path, 8192)).rejects.toThrow(failure);
  });
  it.skipIf(process.platform === 'win32')('refuses final symlinks and symlinked ancestor directories', async () => {
    const direct = join(directory, 'linked.json'); await symlink(path, direct);
    await expect(privateVaultIncomeText(direct, 8192)).rejects.toThrow(failure);
    const inner = join(directory, 'inner'); await mkdir(inner, { mode: 0o700 });
    await writeFile(join(inner, 'profile.json'), '{}', { mode: 0o600 });
    const linked = join(directory, 'linked-directory'); await symlink(inner, linked);
    await expect(privateVaultIncomeText(join(linked, 'profile.json'), 8192)).rejects.toThrow(failure);
  });
  it.skipIf(process.platform !== 'win32')('accepts actual restricted Windows ACLs and rejects an actual Everyone Allow ACE', async () => {
    expect(await privateVaultIncomeText(path, 8192)).toBe('{"reviewed":"fixture"}');
    // Some Windows tokens cannot re-persist a protected ACL without
    // SeSecurityPrivilege. Create each reviewed fixture ACL once, as main does.
    const broad = join(directory, 'everyone-readable-fixture.json');
    await writeFile(broad, '{"reviewed":"public-fixture"}'); await secure(broad, true);
    await expect(privateVaultIncomeText(broad, 8192)).rejects.toThrow(failure);
    expect(await privateVaultIncomeText(path, 8192)).toBe('{"reviewed":"fixture"}');
  });
});
