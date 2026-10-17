import { execFile } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile), noFollow = constants.O_NOFOLLOW ?? 0, nonBlock = constants.O_NONBLOCK ?? 0;
const unavailable = () => new Error('Private Vault income file is unavailable');
// Only this fixed script is executed. The path is a process environment value,
// never PowerShell source. A missing/null DACL grants public access and is refused.
const windowsAclScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $path = [Environment]::GetEnvironmentVariable('TELOMERE_VAULT_INCOME_PRIVATE_PATH', 'Process')
  if ([string]::IsNullOrWhiteSpace($path)) { throw 'denied' }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')
  $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl -or -not $acl.AreAccessRulesCanonical) { throw 'denied' }
  if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'denied' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $trusted -notcontains $rule.IdentityReference.Value) { throw 'denied' }
  }
  [Console]::Out.Write('private')
} catch { [Console]::Out.Write('denied') }
`;
async function windowsPrivate(path: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  if (!isAbsolute(systemRoot) || systemRoot.includes('\0')) throw unavailable();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !['psmodulepath', 'telomere_vault_income_private_path'].includes(name.toLowerCase())));
  const result = await execute(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsAclScript, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 5000, maxBuffer: 64, encoding: 'utf8',
      env: { ...inherited, PSModulePath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        TELOMERE_VAULT_INCOME_PRIVATE_PATH: path } });
  if (result.stdout !== 'private' || result.stderr !== '') throw unavailable();
}
function checked(stat: BigIntStats, maximum: number): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(maximum)
    || process.platform !== 'win32' && (uid === undefined || stat.uid !== BigInt(uid) || (stat.mode & 0o7777n) !== 0o600n)) throw unavailable();
}
function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode
    && left.uid === right.uid && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function ancestors(path: string): Promise<void> {
  const root = parse(path).root, parts = relative(root, dirname(path)).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part);
    const value = await lstat(current);
    if (!value.isDirectory() || value.isSymbolicLink()) throw unavailable();
  }
}

/** Read one bounded private operator file. No ACL or permission is modified. */
export async function privateVaultIncomeText(absolutePath: string, maxBytes: number): Promise<string> {
  try {
    if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath) || absolutePath.length > 4096
      || absolutePath.includes('\0') || Buffer.from(absolutePath).toString('utf8') !== absolutePath
      || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) throw unavailable();
    const path = resolve(absolutePath); await ancestors(path);
    const named = await lstat(path, { bigint: true }); checked(named, maxBytes);
    if (process.platform === 'win32') await windowsPrivate(path);
    const file = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    const bytes = Buffer.alloc(Number(named.size) + 1);
    try {
      const opened = await file.stat({ bigint: true }); checked(opened, maxBytes);
      if (!unchanged(named, opened)) throw unavailable();
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break; length += read.bytesRead;
      }
      const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true });
      checked(after, maxBytes); checked(current, maxBytes);
      if (length !== Number(opened.size) || !unchanged(opened, after) || !unchanged(after, current)) throw unavailable();
      if (process.platform === 'win32') await windowsPrivate(path);
      await ancestors(path);
      const finalNamed = await lstat(path, { bigint: true }); checked(finalNamed, maxBytes);
      if (!unchanged(current, finalNamed) || !unchanged(after, await file.stat({ bigint: true }))) throw unavailable();
      // Preserve a BOM as text so a caller's strict JSON/hex parser decides
      // whether it is valid; never silently repair a private key's bytes.
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
      if (value.includes('\0')) throw unavailable();
      return value;
    } finally { bytes.fill(0); await file.close(); }
  } catch { throw unavailable(); }
}
