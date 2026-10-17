import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const diagnostic = z.object({ kind: z.string().min(1).max(64) }).passthrough();
const observedDatabase = z.object({
  controllerLockHeld: z.boolean(), counts: z.record(z.number().int().nonnegative()),
  oldestQueuedAt: z.string().datetime().nullable(),
  oldestActiveUpdatedAt: z.string().datetime().nullable(),
  platform: z.union([z.object({ status: z.literal('not_installed') }).strict(), z.object({
    counts: z.record(z.number().int().nonnegative()),
    unknownStatusCount: z.number().int().nonnegative(),
    oldestQueuedCreatedAt: z.string().datetime().nullable(),
    oldestRunningUpdatedAt: z.string().datetime().nullable(),
    oldestFinancialCreatedAt: z.string().datetime().nullable(),
    oldestPreparedCreatedAt: z.string().datetime().nullable(),
    oldestVaultSyncCreatedAt: z.string().datetime().nullable() }).strict()]),
  journal: z.object({ count: z.number().int().nonnegative(), unknownNonceCount: z.number().int().nonnegative(),
    highestNonce: z.number().int().nonnegative().nullable(), truncated: z.boolean() }).passthrough(),
  diagnostics: z.array(diagnostic).max(25), reconciliation: z.array(z.unknown()).max(25),
  reconciliationTruncated: z.boolean(), pendingReceipts: z.array(z.unknown()).max(25),
  pendingReceiptsTruncated: z.boolean(),
}).passthrough();
export const operatorSnapshotSchema = z.object({
  schemaVersion: z.literal(1), checkedAt: z.string().datetime(),
  mode: z.enum(['demo', 'testnet', 'mainnet']), database: z.enum(['postgresql', 'pglite']),
  chainId: z.number().int().positive().safe(), escrow: address, token: address, signer: address,
  near: z.object({ configured: z.boolean(), readiness: z.object({ state: z.string().max(32) }).passthrough() }).passthrough(),
  checks: z.object({ networkMatches: z.boolean(), signerMatches: z.boolean(), tokenMatches: z.boolean(),
    tokenHasSixDecimals: z.boolean() }).strict(),
  chain: z.object({ latestNonce: z.number().int().nonnegative(), pendingNonce: z.number().int().nonnegative(),
    operatorGasBalanceWei: decimal }).passthrough(),
  controller: z.object({ status: z.string().max(32), worker: z.string().max(32).optional() }).passthrough(),
  storage: z.union([z.object({ status: z.literal('not_configured') }).strict(), z.object({
    status: z.enum(['ready', 'read_only', 'destination_unavailable', 'unobserved']),
    destinations: z.tuple([z.enum(['ready', 'unavailable', 'unchecked']),
      z.enum(['ready', 'unavailable', 'unchecked'])]),
    reason: z.enum(['configuration_untrusted', 'topology_untrusted', 'controller_untrusted']).optional(),
  }).strict()]),
  databaseStatus: z.union([observedDatabase, z.object({ status: z.literal('pglite_not_opened') }).passthrough()]),
}).passthrough();
export type OperatorSnapshot = z.infer<typeof operatorSnapshotSchema>;

export type WatchdogAlertCode =
  | 'diagnostic_probe_failed' | 'diagnostic_invalid' | 'diagnostic_nonzero' | 'diagnostic_stale'
  | 'deployment_pin_mismatch'
  | 'network_mismatch' | 'signer_mismatch' | 'token_mismatch' | 'token_decimals_mismatch'
  | 'controller_unavailable' | 'worker_unavailable' | 'database_unobserved' | 'controller_lock_missing'
  | 'journal_unresolved' | 'journal_truncated' | 'reconciliation_pending' | 'receipts_pending'
  | 'near_unavailable' | 'queue_stalled' | 'active_run_stalled' | 'signer_gas_low' | 'signer_pending_transactions'
  | 'platform_status_unknown' | 'platform_reconciliation' | 'platform_queue_stalled' | 'platform_run_stalled'
  | 'platform_financial_stalled' | 'platform_vault_sync_stalled'
  | 'large_cyst_unobserved' | 'large_cyst_destination_unavailable' | 'large_cyst_read_only';
export type WatchdogAlert = { code: WatchdogAlertCode; severity: 'critical' | 'warning' };
export type WatchdogPolicy = { maxSnapshotAgeMs: number; queueWarnMs: number; activeWarnMs: number;
  platformFinancialWarnMs: number; platformVaultSyncWarnMs: number;
  minOperatorGasWei: string;
  expected?: { mode: 'demo' | 'testnet' | 'mainnet'; chainId: number; escrow: string; token: string; signer: string } };
export const defaultWatchdogPolicy: Readonly<WatchdogPolicy> = Object.freeze({
  maxSnapshotAgeMs: 60_000, queueWarnMs: 120_000, activeWarnMs: 900_000,
  platformFinancialWarnMs: 7_200_000, platformVaultSyncWarnMs: 7_200_000,
  minOperatorGasWei: '1000000000000000',
});

/** Only stable codes leave this boundary; remote URLs, raw errors and status data never enter the alert journal. */
export function evaluateOperatorSnapshot(raw: unknown, now: number, policy: WatchdogPolicy = defaultWatchdogPolicy): WatchdogAlert[] {
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(policy.maxSnapshotAgeMs)
    || policy.maxSnapshotAgeMs < 1000 || !Number.isSafeInteger(policy.queueWarnMs) || policy.queueWarnMs < 1000
    || !Number.isSafeInteger(policy.activeWarnMs) || policy.activeWarnMs < 1000
    || !Number.isSafeInteger(policy.platformFinancialWarnMs) || policy.platformFinancialWarnMs < 1000
    || !Number.isSafeInteger(policy.platformVaultSyncWarnMs) || policy.platformVaultSyncWarnMs < 1000)
    throw new Error('Invalid watchdog clock or policy');
  const minGas = BigInt(decimal.parse(policy.minOperatorGasWei));
  const parsed = operatorSnapshotSchema.safeParse(raw);
  if (!parsed.success) return [{ code: 'diagnostic_invalid', severity: 'critical' }];
  const snapshot = parsed.data;
  const alerts: WatchdogAlert[] = [];
  const add = (condition: boolean, code: WatchdogAlertCode, severity: WatchdogAlert['severity'] = 'critical') => {
    if (condition && !alerts.some(item => item.code === code)) alerts.push({ code, severity });
  };
  const checkedAt = Date.parse(snapshot.checkedAt);
  if (policy.expected) {
    const expected = policy.expected;
    add(snapshot.mode !== expected.mode || snapshot.chainId !== expected.chainId
      || snapshot.escrow.toLowerCase() !== expected.escrow.toLowerCase()
      || snapshot.token.toLowerCase() !== expected.token.toLowerCase()
      || snapshot.signer.toLowerCase() !== expected.signer.toLowerCase(), 'deployment_pin_mismatch');
  }
  add(!Number.isSafeInteger(checkedAt) || checkedAt > now + 5000 || now - checkedAt > policy.maxSnapshotAgeMs,
    'diagnostic_stale');
  add(!snapshot.checks.networkMatches, 'network_mismatch');
  add(!snapshot.checks.signerMatches, 'signer_mismatch');
  add(!snapshot.checks.tokenMatches, 'token_mismatch');
  add(!snapshot.checks.tokenHasSixDecimals, 'token_decimals_mismatch');
  add(snapshot.controller.status !== 'ready', 'controller_unavailable');
  add(!['idle', 'running'].includes(snapshot.controller.worker ?? ''), 'worker_unavailable');
  add(snapshot.near.configured && snapshot.near.readiness.state !== 'ready', 'near_unavailable');
  if (snapshot.storage.status !== 'not_configured') {
    add(snapshot.storage.status === 'unobserved', 'large_cyst_unobserved');
    add(snapshot.storage.destinations.includes('unavailable'), 'large_cyst_destination_unavailable');
    add(snapshot.storage.status === 'read_only', 'large_cyst_read_only');
    add(snapshot.storage.status === 'ready' && snapshot.storage.destinations.some(value => value !== 'ready')
      || snapshot.storage.status === 'destination_unavailable'
        && !snapshot.storage.destinations.includes('unavailable'), 'diagnostic_invalid');
  }
  add(BigInt(snapshot.chain.operatorGasBalanceWei) < minGas, 'signer_gas_low', 'warning');
  add(snapshot.chain.pendingNonce > snapshot.chain.latestNonce, 'signer_pending_transactions', 'warning');
  const database = snapshot.databaseStatus;
  if ('status' in database || snapshot.database !== 'postgresql') add(true, 'database_unobserved');
  else {
    add(!database.controllerLockHeld, 'controller_lock_missing');
    add(database.journal.unknownNonceCount > 0 || database.diagnostics.some(item => item.kind !== 'settlement_mined'), 'journal_unresolved');
    add(database.journal.truncated || database.reconciliationTruncated || database.pendingReceiptsTruncated, 'journal_truncated');
    add(database.reconciliation.length > 0 || (database.counts.reconciliation ?? 0) > 0, 'reconciliation_pending');
    add(database.pendingReceipts.length > 0 || (database.counts.receipt_pending ?? 0) > 0, 'receipts_pending');
    if (database.oldestQueuedAt !== null) {
      const queuedAt = Date.parse(database.oldestQueuedAt);
      add(!Number.isSafeInteger(queuedAt) || queuedAt > now + 5000 || now - queuedAt > policy.queueWarnMs,
        'queue_stalled', 'warning');
      add((database.counts.queued ?? 0) === 0, 'diagnostic_invalid');
    } else add((database.counts.queued ?? 0) > 0, 'diagnostic_invalid');
    const activeCount = (database.counts.running ?? 0) + (database.counts.near_dispatching ?? 0)
      + (database.counts.settling ?? 0);
    if (database.oldestActiveUpdatedAt !== null) {
      const activeAt = Date.parse(database.oldestActiveUpdatedAt);
      add(!Number.isSafeInteger(activeAt) || activeAt > now + 5000 || now - activeAt > policy.activeWarnMs,
        'active_run_stalled', 'warning');
      add(activeCount === 0, 'diagnostic_invalid');
    } else add(activeCount > 0, 'diagnostic_invalid');
    const platform = database.platform;
    if ('status' in platform) return alerts;
    add(platform.unknownStatusCount > 0, 'platform_status_unknown');
    add((platform.counts.reconciliation ?? 0) > 0, 'platform_reconciliation');
    const aged = (value: string | null, count: number, threshold: number, code: WatchdogAlertCode) => {
      add((value === null) !== (count === 0), 'diagnostic_invalid');
      if (value !== null) {
        const timestamp = Date.parse(value);
        add(!Number.isSafeInteger(timestamp) || timestamp > now + 5000 || now - timestamp > threshold,
          code, 'warning');
      }
    };
    aged(platform.oldestQueuedCreatedAt, platform.counts.queued ?? 0, policy.queueWarnMs, 'platform_queue_stalled');
    aged(platform.oldestRunningUpdatedAt, platform.counts.running ?? 0, policy.activeWarnMs, 'platform_run_stalled');
    aged(platform.oldestFinancialCreatedAt,
      (platform.counts.receipt_pending ?? 0) + (platform.counts.settling ?? 0),
      policy.platformFinancialWarnMs, 'platform_financial_stalled');
    // Unsubmitted quotes stay prepared indefinitely. Age alone cannot prove
    // whether a payer opened one onchain before losing HTTP admission.
    add((platform.oldestPreparedCreatedAt === null) !== ((platform.counts.prepared ?? 0) === 0),
      'diagnostic_invalid');
    if (platform.oldestVaultSyncCreatedAt !== null) {
      const timestamp = Date.parse(platform.oldestVaultSyncCreatedAt);
      add(!Number.isSafeInteger(timestamp) || timestamp > now + 5000
        || now - timestamp > policy.platformVaultSyncWarnMs, 'platform_vault_sync_stalled', 'warning');
    }
  }
  return alerts;
}

const alertCodeSchema = z.enum([
  'diagnostic_probe_failed', 'diagnostic_invalid', 'diagnostic_nonzero', 'diagnostic_stale',
  'deployment_pin_mismatch',
  'network_mismatch', 'signer_mismatch', 'token_mismatch', 'token_decimals_mismatch',
  'controller_unavailable', 'worker_unavailable', 'database_unobserved', 'controller_lock_missing',
  'journal_unresolved', 'journal_truncated', 'reconciliation_pending', 'receipts_pending',
  'near_unavailable', 'queue_stalled', 'active_run_stalled', 'signer_gas_low', 'signer_pending_transactions',
  'platform_status_unknown', 'platform_reconciliation', 'platform_queue_stalled', 'platform_run_stalled',
  'platform_financial_stalled', 'platform_vault_sync_stalled',
  'large_cyst_unobserved', 'large_cyst_destination_unavailable', 'large_cyst_read_only',
] as const);
const activeSchema = z.object({ code: alertCodeSchema, severity: z.enum(['critical', 'warning']),
  firstSeenAt: z.number().int().positive(), lastSeenAt: z.number().int().positive(),
  occurrences: z.number().int().min(1).max(1_000_000_000) }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), sequence: z.number().int().nonnegative(),
  checkedAt: z.number().int().positive(), active: z.array(activeSchema).max(32) }).strict();
type State = z.infer<typeof stateSchema>;
export type WatchdogResult = { schemaVersion: 1; checkedAt: string; health: 'ok' | 'warning' | 'critical';
  active: State['active']; transitions: Array<{ code: WatchdogAlertCode; change: 'raised' | 'resolved';
    severity: WatchdogAlert['severity'] }>; sequence: number };

function validateState(value: unknown): State {
  const state = stateSchema.parse(value);
  if (new Set(state.active.map(item => item.code)).size !== state.active.length
    || state.active.some(item => item.firstSeenAt > item.lastSeenAt || item.lastSeenAt > state.checkedAt))
    throw new Error('Watchdog state is inconsistent');
  return state;
}

/** A checked private state file. A crash-held lock requires operator inspection, never automatic takeover. */
export class FileWatchdogState {
  readonly path: string;
  constructor(path: string) {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Watchdog state path must be absolute');
    this.path = resolve(path);
  }
  private async read(): Promise<State | undefined> {
    let original;
    try { original = await lstat(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!original.isFile() || original.isSymbolicLink()) throw new Error('Watchdog state file is unsafe');
    let file;
    file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.dev !== original.dev || metadata.ino !== original.ino
        || metadata.size > 16_384 || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0))
        throw new Error('Watchdog state file is unsafe');
      const text = await file.readFile('utf8');
      return validateState(JSON.parse(text));
    } finally { await file.close(); }
  }
  async update(alerts: readonly WatchdogAlert[], now: number, preservePrior = false): Promise<WatchdogResult> {
    if (!Number.isSafeInteger(now) || now <= 0 || alerts.length > 32
      || new Set(alerts.map(item => item.code)).size !== alerts.length
      || alerts.some(item => !alertCodeSchema.safeParse(item.code).success || !['critical', 'warning'].includes(item.severity)))
      throw new Error('Invalid watchdog update');
    const directory = dirname(this.path);
    // The operator must pre-provision this private directory. Check every
    // ancestor instead of following a junction or symlink during mkdir.
    const root = parse(directory).root;
    let cursor = root;
    const parts = relative(root, directory).split(sep).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      cursor = join(cursor, part);
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Watchdog state directory is unsafe');
      if (index === parts.length - 1 && process.platform !== 'win32'
        && ((metadata.mode & 0o077) !== 0 || typeof process.getuid === 'function' && metadata.uid !== process.getuid()))
        throw new Error('Watchdog state directory is not private');
    }
    if (parts.length === 0) throw new Error('Watchdog state directory must be private');
    const lockPath = this.path + '.lock';
    const lock = await open(lockPath, 'wx', 0o600);
    let temporary: string | undefined;
    try {
      const previous = await this.read();
      if (previous && now < previous.checkedAt) throw new Error('Watchdog clock moved backwards');
      const before = new Map(previous?.active.map(item => [item.code, item]) ?? []);
      const reported = [...alerts].map(item => {
        const old = before.get(item.code);
        return { ...item, firstSeenAt: old?.firstSeenAt ?? now, lastSeenAt: now,
          occurrences: Math.min((old?.occurrences ?? 0) + 1, 1_000_000_000) };
      });
      // An absent signal is not a resolution when this cycle could not
      // observe the full state. Retain specific faults until a trusted cycle.
      const current = [...reported, ...(preservePrior ? (previous?.active ?? []).filter(item =>
        !item.code.startsWith('diagnostic_') && !reported.some(current => current.code === item.code)) : [])]
        .sort((a, b) => a.code.localeCompare(b.code));
      const next = validateState({ schemaVersion: 1, sequence: (previous?.sequence ?? 0) + 1,
        checkedAt: now, active: current });
      const after = new Map(current.map(item => [item.code, item]));
      const transitions: WatchdogResult['transitions'] = [
        ...current.filter(item => !before.has(item.code)).map(item => ({ code: item.code, change: 'raised' as const,
          severity: item.severity })),
        ...(previous?.active ?? []).filter(item => !after.has(item.code)).map(item => ({ code: item.code,
          change: 'resolved' as const, severity: item.severity })),
      ].sort((a, b) => a.code.localeCompare(b.code));
      temporary = this.path + '.tmp-' + randomBytes(8).toString('hex');
      const output = await open(temporary, 'wx', 0o600);
      try { await output.writeFile(JSON.stringify(next) + '\n'); await output.sync(); }
      finally { await output.close(); }
      await rename(temporary, this.path); temporary = undefined;
      if (process.platform !== 'win32') {
        const parent = await open(directory, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return { schemaVersion: 1, checkedAt: new Date(now).toISOString(),
        health: current.some(item => item.severity === 'critical') ? 'critical' : current.length ? 'warning' : 'ok',
        active: current, transitions, sequence: next.sequence };
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
      await lock.close(); await unlink(lockPath);
    }
  }
}

export type ProcessObservation = { exitCode: number; stdout: string };
/** Capture only bounded stdout. Child stderr is discarded because it may contain provider credentials. */
export function captureBoundedProcess(binary: string, args: readonly string[], timeoutMs: number,
  maxOutputBytes = 262_144, signal?: AbortSignal): Promise<ProcessObservation> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 1_048_576)
    throw new Error('Invalid diagnostic process limits');
  if (signal?.aborted) return Promise.reject(new Error('Diagnostic process aborted'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false, settled = false;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const abort = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(fail, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) fail(); else chunks.push(chunk);
    });
    child.once('error', () => { if (!settled) { settled = true; cleanup(); reject(new Error('Diagnostic process failed')); } });
    child.once('close', code => {
      if (settled) return;
      settled = true; cleanup();
      if (signal?.aborted) { reject(new Error('Diagnostic process aborted')); return; }
      if (failed || code === null) reject(new Error('Diagnostic process timed out or exceeded output limit'));
      else resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

export async function watchdogCycle(store: FileWatchdogState, probe: () => Promise<ProcessObservation>,
  clock: () => number, policy: WatchdogPolicy = defaultWatchdogPolicy, signal?: AbortSignal): Promise<WatchdogResult> {
  let alerts: WatchdogAlert[];
  let now: number;
  try {
    const observation = await probe();
    now = clock();
    let snapshot: unknown;
    try { snapshot = JSON.parse(observation.stdout); }
    catch { snapshot = null; }
    alerts = evaluateOperatorSnapshot(snapshot, now, policy);
    if (observation.exitCode !== 0) alerts.push({ code: 'diagnostic_nonzero', severity: 'critical' });
  } catch {
    if (signal?.aborted) throw new Error('Watchdog cycle aborted');
    now = clock(); alerts = [{ code: 'diagnostic_probe_failed', severity: 'critical' }];
  }
  if (signal?.aborted) throw new Error('Watchdog cycle aborted');
  const uncertain = alerts.some(item => ['diagnostic_probe_failed', 'diagnostic_invalid', 'diagnostic_stale',
    'database_unobserved', 'journal_truncated'].includes(item.code));
  return store.update(alerts, now, uncertain);
}
