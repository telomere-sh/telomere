import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical } from '../src/common.js';
import { admissionHash } from '../src/host-kit/admission.js';
import type { HostedSessionManager } from '../src/host-kit/hosted-sessions.js';
import { hostPaidSessions, openHostJournal, type HostJournal } from '../src/host-kit/journal.js';
import { Ed25519Identity, hostMessageHash, leaseSchema } from '../src/host-kit/protocol.js';
import { PaidCystInputSpool } from '../src/host-kit/sessions/cyst-input-spool.js';
import { cystInputBindingSchema } from '../src/host-kit/sessions/cyst-input-protocol.js';
import { PaidHostSessionAgent } from '../src/host-kit/sessions/paid-agent.js';
import { PAID_SESSION_ARGV, paidSessionPolicy } from '../src/host-kit/sessions/paid-protocol.js';
import { sessionSpecSchema } from '../src/host-kit/sessions/types.js';

const hash = (digit: string) => '0x' + digit.repeat(64);
describe('paid file reservation recovery authority (journal unit seam)', () => {
  let root: string, journal: HostJournal, spool: PaidCystInputSpool;
  afterEach(async () => { await spool?.close().catch(() => undefined); await journal?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    root = await mkdtemp(join(tmpdir(), 'paid-cyst-recovery-')); journal = await openHostJournal(':memory:');
    spool = await PaidCystInputSpool.open({ directory: join(root, 'spool'), maxInputBytes: 64, globalBytes: 64, maxOperations: 4, minimumFreeBytes: 0 });
    const control = new Ed25519Identity(), runId = hash('1'), owner = '0x' + '2'.repeat(40), now = Date.now();
    const spec = sessionSpecSchema.parse({ version: 1, sessionId: runId, image: 'fixture/session@sha256:' + 'a'.repeat(64), lifetimeSeconds: 30,
      policy: paidSessionPolicy(2), cystInput: { protocol: 'telomere-cyst-application-file-v1', operationId: 'recovery', agentId: hash('3'), revision: '1',
        plaintextBytes: 1, plaintextSha256: 'b'.repeat(64), checkpoint: { version: 1, format: 'telomere-large-cyst-manifest-v1', id: hash('4'),
          owner, agent: '0x' + '5'.repeat(40), applicationSchema: 'state.v1', manifestSha256: hash('6'), cystHash: hash('7'), sizeBytes: 41, storageRef: hash('8') } } });
    const lease = control.sign('lease', leaseSchema.parse({ version: 1, hostKey: journal.identity.publicKey, runId, owner, image: spec.image,
      argv: [...PAID_SESSION_ARGV], stdin: JSON.stringify({ spec, quoteHash: hash('9'), admissionTx: hash('a') }),
      issuedAt: now, expiresAt: now + 30_000, maxSeconds: 30, nonce: hash('b') }));
    const binding = cystInputBindingSchema.parse({ version: 1, hostKey: journal.identity.publicKey, runId, owner,
      leaseHash: hostMessageHash(lease), expiresAt: lease.body.expiresAt, descriptor: spec.cystInput });
    // This unit seam assumes the already-reviewed admission cleanup boundary.
    // It deliberately starts no process and earns no resource-isolation credit.
    const sessions = { admission: { journal, scope: { controlKey: control.publicKey }, backend: { cystInputs: spool }, assertReady() {} } } as unknown as HostedSessionManager;
    const paid = new PaidHostSessionAgent(journal, sessions, control.publicKey);
    const row = { sessionId: runId, owner, leaseHash: hostMessageHash(lease), lease };
    return { paid, binding, spec, row };
  }
  it('rejects an extant plaintext reservation with no original signed paid journal row', async () => {
    const value = await fixture(); await spool.reserve(value.binding, admissionHash(value.spec));
    await expect(value.paid.initialize()).rejects.toThrow('no retained signed session authority');
    expect(await spool.canReserve(64)).toBe(false);
    expect(await readdir(join(spool.directory, 'run-' + value.row.sessionId.slice(2)))).toContain('ready');
  });
  it('rejects missing unfinished state while preserving an already-confirmed clean backup history', async () => {
    const value = await fixture();
    await journal.db.insert(hostPaidSessions).values({ ...value.row, state: 'starting' });
    await expect(value.paid.initialize()).rejects.toThrow('reservation is missing');
    expect((await journal.db.select().from(hostPaidSessions))[0]?.cleanupConfirmed).toBe(false);
    await journal.db.update(hostPaidSessions).set({ state: 'fault', cleanupConfirmed: true });
    await expect(value.paid.initialize()).resolves.toBeUndefined();
    expect((await journal.db.select().from(hostPaidSessions))[0]?.state).toBe('fault');
    expect(await spool.inventory()).toEqual([]);
  });
  it('requires the exact signed lease and spec binding without releasing mismatched storage', async () => {
    const value = await fixture();
    await journal.db.insert(hostPaidSessions).values({ ...value.row, state: 'starting' });
    await spool.reserve(value.binding, 'e'.repeat(64));
    await expect(value.paid.initialize()).rejects.toThrow('differs from retained signed session authority');
    expect((await journal.db.select().from(hostPaidSessions))[0]?.cleanupConfirmed).toBe(false);
    const inventory = await spool.inventory(); expect(canonical(inventory[0]?.binding)).toBe(canonical(value.binding));
  });
  it('cleans a matching reserved file operation after the admission seam proves no session resource remains', async () => {
    const value = await fixture(); await journal.db.insert(hostPaidSessions).values({ ...value.row, state: 'starting' });
    await spool.reserve(value.binding, admissionHash(value.spec)); await value.paid.initialize();
    expect(await spool.status(value.binding)).toEqual({ state: 'cleaned', committed: false });
    expect((await journal.db.select().from(hostPaidSessions))[0]).toMatchObject({ state: 'fault', cleanupConfirmed: true });
  });
});
