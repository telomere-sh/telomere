import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureBoundedProcess, defaultWatchdogPolicy, evaluateOperatorSnapshot,
  FileWatchdogState, watchdogCycle } from '../src/operator/watchdog.js';

const now = Date.parse('2026-10-13T12:00:00.000Z');
function snapshot() {
  // Matches the public shape of scripts/operator-status.ts, including its PostgreSQL diagnosis.
  return {
    schemaVersion: 1, checkedAt: new Date(now).toISOString(), readOnly: true,
    mode: 'testnet', database: 'postgresql', near: { configured: false, readiness: { state: 'disabled' } },
    chainId: 84532, escrow: '0x1111111111111111111111111111111111111111',
    token: '0x2222222222222222222222222222222222222222',
    signer: '0x3333333333333333333333333333333333333333',
    checks: { networkMatches: true, signerMatches: true, tokenMatches: true, tokenHasSixDecimals: true },
    chain: { actualChainId: 84532, latestNonce: 7, pendingNonce: 7, operatorGasBalanceWei: '100000000000000000',
      treasury: '0x1111111111111111111111111111111111111111' },
    controller: { status: 'ready', worker: 'idle' },
    storage: { status: 'not_configured' },
    databaseStatus: { controllerLockHeld: true, counts: { completed: 3, queued: 0 }, oldestQueuedAt: null,
      oldestActiveUpdatedAt: null,
      platform: { counts: { prepared: 0, queued: 0, running: 0, receipt_pending: 0, settling: 0,
        reconciliation: 0, completed: 0, refunded: 0 }, unknownStatusCount: 0,
      oldestQueuedCreatedAt: null, oldestRunningUpdatedAt: null, oldestFinancialCreatedAt: null,
      oldestPreparedCreatedAt: null, oldestVaultSyncCreatedAt: null },
      journal: { count: 3, unknownNonceCount: 0, highestNonce: 6, truncated: false }, diagnostics: [],
      reconciliation: [], reconciliationTruncated: false, pendingReceipts: [], pendingReceiptsTruncated: false },
  };
}

describe('operator watchdog evaluation', () => {
  it('accepts a fresh ready diagnostic with observed persistent finance state', () => {
    expect(evaluateOperatorSnapshot(snapshot(), now)).toEqual([]);
  });
  it('accepts pre-platform staging without a paid table while keeping legacy finance observable', () => {
    const value = { ...snapshot(), databaseStatus: { ...snapshot().databaseStatus,
      platform: { status: 'not_installed' as const } } };
    expect(evaluateOperatorSnapshot(value, now)).toEqual([]);
    value.databaseStatus.controllerLockHeld = false;
    expect(evaluateOperatorSnapshot(value, now)).toContainEqual({ code: 'controller_lock_missing', severity: 'critical' });
  });
  it('raises independent critical codes for changed chain, signer, token, controller and unresolved funds', () => {
    const value = snapshot();
    value.checks.networkMatches = false;
    value.checks.signerMatches = false;
    value.checks.tokenMatches = false;
    value.controller.status = 'unavailable';
    value.controller.worker = 'faulted';
    value.databaseStatus.controllerLockHeld = false;
    value.databaseStatus.journal.unknownNonceCount = 1;
    value.databaseStatus.reconciliation.push({ runId: 'secret-should-never-appear' } as never);
    value.databaseStatus.pendingReceipts.push({ runId: 'secret-should-never-appear' } as never);
    const codes = evaluateOperatorSnapshot(value, now).map(item => item.code);
    expect(codes).toEqual(expect.arrayContaining(['network_mismatch', 'signer_mismatch', 'token_mismatch',
      'controller_unavailable', 'worker_unavailable', 'controller_lock_missing', 'journal_unresolved',
      'reconciliation_pending', 'receipts_pending']));
    expect(JSON.stringify(codes)).not.toContain('secret-should-never-appear');
  });
  it('fails closed on malformed, stale, incomplete and truncated diagnostics', () => {
    expect(evaluateOperatorSnapshot({ ...snapshot(), databaseStatus: { status: 'pglite_not_opened' } }, now))
      .toContainEqual({ code: 'database_unobserved', severity: 'critical' });
    expect(evaluateOperatorSnapshot({ ...snapshot(), controller: { status: 'ready' } }, now))
      .toContainEqual({ code: 'worker_unavailable', severity: 'critical' });
    expect(evaluateOperatorSnapshot({ ...snapshot(), checkedAt: new Date(now - 120_000).toISOString() }, now))
      .toContainEqual({ code: 'diagnostic_stale', severity: 'critical' });
    expect(evaluateOperatorSnapshot({ ...snapshot(), checks: { networkMatches: 'true' } }, now))
      .toEqual([{ code: 'diagnostic_invalid', severity: 'critical' }]);
    const value = snapshot();
    value.databaseStatus.journal.truncated = true;
    expect(evaluateOperatorSnapshot(value, now)).toContainEqual({ code: 'journal_truncated', severity: 'critical' });
  });
  it('distinguishes warnings for queue age, pending signer nonce and low gas', () => {
    const value = snapshot();
    value.chain.operatorGasBalanceWei = '0'; value.chain.pendingNonce = 8;
    value.databaseStatus.oldestQueuedAt = new Date(now - 180_000).toISOString() as never;
    const alerts = evaluateOperatorSnapshot(value, now, defaultWatchdogPolicy);
    expect(alerts).toEqual(expect.arrayContaining([
      { code: 'queue_stalled', severity: 'warning' }, { code: 'signer_gas_low', severity: 'warning' },
      { code: 'signer_pending_transactions', severity: 'warning' },
    ]));
  });
  it('flags an aged active run and inconsistent active-status timestamps', () => {
    const value = snapshot();
    Object.assign(value.databaseStatus.counts, { running: 1 });
    value.databaseStatus.oldestActiveUpdatedAt = new Date(now - 901_000).toISOString() as never;
    expect(evaluateOperatorSnapshot(value, now)).toContainEqual({ code: 'active_run_stalled', severity: 'warning' });
    value.databaseStatus.oldestActiveUpdatedAt = null;
    expect(evaluateOperatorSnapshot(value, now)).toContainEqual({ code: 'diagnostic_invalid', severity: 'critical' });
  });
  it('monitors paid PlatformRunEscrow work even while the legacy queue is empty', () => {
    const value = snapshot();
    const platform = value.databaseStatus.platform;
    Object.assign(platform.counts, { queued: 1, running: 1, receipt_pending: 1, reconciliation: 1 });
    platform.unknownStatusCount = 1;
    platform.oldestQueuedCreatedAt = new Date(now - 180_000).toISOString() as never;
    platform.oldestRunningUpdatedAt = new Date(now - 901_000).toISOString() as never;
    platform.oldestFinancialCreatedAt = new Date(now - 7_201_000).toISOString() as never;
    const codes = evaluateOperatorSnapshot(value, now).map(item => item.code);
    expect(codes).toEqual(expect.arrayContaining(['platform_status_unknown', 'platform_reconciliation',
      'platform_queue_stalled', 'platform_run_stalled', 'platform_financial_stalled']));
    expect(codes).not.toContain('queue_stalled');
    expect(codes).not.toContain('active_run_stalled');
  });
  it('does not page forever for unused prepared quotes but checks Vault sync', () => {
    const value = snapshot();
    Object.assign(value.databaseStatus.platform.counts, { prepared: 1 });
    value.databaseStatus.platform.oldestPreparedCreatedAt = new Date(now - 601_000).toISOString() as never;
    value.databaseStatus.platform.oldestVaultSyncCreatedAt = new Date(now - 7_201_000).toISOString() as never;
    expect(evaluateOperatorSnapshot(value, now)).toEqual([{ code: 'platform_vault_sync_stalled', severity: 'warning' }]);
    value.databaseStatus.platform.oldestPreparedCreatedAt = null;
    expect(evaluateOperatorSnapshot(value, now)).toContainEqual({ code: 'diagnostic_invalid', severity: 'critical' });
  });
  it('checks reviewed public deployment pins independently of self-consistent runtime checks', () => {
    const value = snapshot();
    const expected = { mode: 'testnet' as const, chainId: 84532, escrow: value.escrow,
      token: value.token, signer: value.signer };
    expect(evaluateOperatorSnapshot(value, now, { ...defaultWatchdogPolicy, expected })).toEqual([]);
    expect(evaluateOperatorSnapshot(value, now, { ...defaultWatchdogPolicy,
      expected: { ...expected, token: '0x4444444444444444444444444444444444444444' } }))
      .toContainEqual({ code: 'deployment_pin_mismatch', severity: 'critical' });
  });
  it('raises safe storage codes for configured S3 outage and controller read-only mode', () => {
    const value = snapshot();
    Object.assign(value, { storage: { status: 'read_only', destinations: ['ready', 'unavailable'] } });
    expect(evaluateOperatorSnapshot(value, now)).toEqual(expect.arrayContaining([
      { code: 'large_cyst_read_only', severity: 'critical' },
      { code: 'large_cyst_destination_unavailable', severity: 'critical' },
    ]));
    Object.assign(value, { storage: { status: 'unobserved', reason: 'configuration_untrusted',
      destinations: ['unchecked', 'unchecked'] } });
    const codes = evaluateOperatorSnapshot(value, now).map(item => item.code);
    expect(codes).toContain('large_cyst_unobserved');
    expect(codes).not.toContain('large_cyst_destination_unavailable');
    expect(evaluateOperatorSnapshot({ ...snapshot(), storage: undefined }, now))
      .toEqual([{ code: 'diagnostic_invalid', severity: 'critical' }]);
  });
});

describe('durable watchdog transitions and bounded process', () => {
  const directories: string[] = [];
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
  async function state() {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-watchdog-'));
    directories.push(directory);
    return new FileWatchdogState(join(directory, 'state.json'));
  }
  it('deduplicates raised alerts across restart, records resolution and never persists diagnostic data', async () => {
    const store = await state();
    const failure = { ...snapshot(), checks: { ...snapshot().checks, signerMatches: false } };
    const probe = async () => ({ exitCode: 1, stdout: JSON.stringify(failure) });
    const first = await watchdogCycle(store, probe, () => now);
    expect(first.health).toBe('critical');
    expect(first.transitions.map(item => item.code)).toEqual(['diagnostic_nonzero', 'signer_mismatch']);
    const reopened = new FileWatchdogState(store.path);
    const second = await watchdogCycle(reopened, probe, () => now + 1000);
    expect(second.transitions).toEqual([]);
    expect(second.active.find(item => item.code === 'signer_mismatch')?.firstSeenAt).toBe(now);
    const healthy = await watchdogCycle(reopened, async () => ({ exitCode: 0, stdout: JSON.stringify(snapshot()) }), () => now + 2000);
    expect(healthy.health).toBe('ok');
    expect(healthy.transitions).toEqual([
      { code: 'diagnostic_nonzero', change: 'resolved', severity: 'critical' },
      { code: 'signer_mismatch', change: 'resolved', severity: 'critical' },
    ]);
    const disk = await readFile(store.path, 'utf8');
    expect(disk).not.toContain('operatorGasBalanceWei');
    expect(disk).not.toContain('treasury');
  });
  it('keeps testnet status monitoring independent of the quiescent manual paid journal audit', async () => {
    const store = await state();
    const value = snapshot();
    const result = await watchdogCycle(store,
      async () => ({ exitCode: 0, stdout: JSON.stringify(value) }), () => now,
      { ...defaultWatchdogPolicy, expected: { mode: 'testnet', chainId: value.chainId,
        escrow: value.escrow, token: value.token, signer: value.signer } });
    expect(result.health).toBe('ok');
    expect(result.active).toEqual([]);
    expect(result.sequence).toBe(1);
  });
  it('records a safe generic probe failure even if the thrown error contains a secret', async () => {
    const store = await state();
    const result = await watchdogCycle(store, async () => { throw new Error('credential=private-secret'); }, () => now);
    expect(result.active.map(item => item.code)).toEqual(['diagnostic_probe_failed']);
    expect(await readFile(store.path, 'utf8')).not.toContain('private-secret');
  });
  it('retains an earlier signer fault through failed and malformed probes until a fresh clean observation', async () => {
    const store = await state();
    const bad = { ...snapshot(), checks: { ...snapshot().checks, signerMatches: false } };
    await watchdogCycle(store, async () => ({ exitCode: 1, stdout: JSON.stringify(bad) }), () => now);
    const failed = await watchdogCycle(store, async () => { throw new Error('connection lost'); }, () => now + 1000);
    expect(failed.active.map(item => item.code)).toContain('signer_mismatch');
    expect(failed.transitions).not.toContainEqual(expect.objectContaining({ code: 'signer_mismatch', change: 'resolved' }));
    const malformed = await watchdogCycle(store, async () => ({ exitCode: 0, stdout: '{invalid' }), () => now + 2000);
    expect(malformed.active.map(item => item.code)).toContain('signer_mismatch');
    expect(malformed.transitions).not.toContainEqual(expect.objectContaining({ code: 'signer_mismatch', change: 'resolved' }));
    const healthy = await watchdogCycle(store, async () => ({ exitCode: 0, stdout: JSON.stringify(snapshot()) }), () => now + 3000);
    expect(healthy.active).toEqual([]);
    expect(healthy.transitions).toContainEqual({ code: 'signer_mismatch', change: 'resolved', severity: 'critical' });
  });
  it('uses completion time when checking a slow diagnostic snapshot', async () => {
    const store = await state();
    let finished = false;
    const result = await watchdogCycle(store, async () => {
      finished = true;
      return { exitCode: 0, stdout: JSON.stringify(snapshot()) };
    }, () => {
      expect(finished).toBe(true);
      return now + 30_000;
    });
    expect(result.health).toBe('ok');
    expect(result.checkedAt).toBe(new Date(now + 30_000).toISOString());
  });
  it('rejects corrupt state and preserves it for operator review', async () => {
    const store = await state();
    await writeFile(store.path, '{"schemaVersion":1,"active":"corrupt"}', { mode: 0o600 });
    await expect(watchdogCycle(store, async () => ({ exitCode: 0, stdout: JSON.stringify(snapshot()) }), () => now))
      .rejects.toThrow();
    expect(await readFile(store.path, 'utf8')).toContain('corrupt');
  });
  it.skipIf(process.platform === 'win32')('rejects public parent, symlink ancestor and symlink state', async () => {
    const store = await state();
    const directory = dirname(store.path);
    await chmod(directory, 0o755);
    await expect(store.update([], now)).rejects.toThrow('not private');
    await chmod(directory, 0o700);
    const linkedDirectory = join(directory, 'redirect');
    await symlink(directory, linkedDirectory, 'dir');
    await expect(new FileWatchdogState(join(linkedDirectory, 'state.json')).update([], now))
      .rejects.toThrow('unsafe');
    await symlink(join(directory, 'absent'), store.path);
    await expect(store.update([], now)).rejects.toThrow('unsafe');
  });
  it('bounds child time and output without shell execution', async () => {
    await expect(captureBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 1000))
      .rejects.toThrow('timed out');
    await expect(captureBoundedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], 5000, 1024))
      .rejects.toThrow('output limit');
    expect(await captureBoundedProcess(process.execPath, ['-e', "process.stdout.write('public');process.exitCode=2"], 5000))
      .toEqual({ exitCode: 2, stdout: 'public' });
  });
  it('aborts a diagnostic without recording a false critical transition', async () => {
    const shutdown = new AbortController();
    const diagnostic = captureBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      10_000, 262_144, shutdown.signal);
    shutdown.abort();
    await expect(diagnostic).rejects.toThrow('aborted');
    const store = await state();
    await expect(watchdogCycle(store, async () => {
      throw new Error('Diagnostic process aborted');
    }, () => now, defaultWatchdogPolicy, shutdown.signal)).rejects.toThrow('aborted');
    await expect(readFile(store.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
