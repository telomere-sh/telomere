import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PaidLifecycleClientVault } from '../src/agents/paid-lifecycle-runner.js';
import { PaidLifecycleClientVaultV3, type PaidLifecycleVaultV3Policy } from '../src/agents/paid-lifecycle-vault-v3.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { decryptCheckpoint, encryptCheckpoint } from '../src/sdk/cysts.js';

const scope = { owner: '0x' + '11'.repeat(20), agent: '0x' + '22'.repeat(20), applicationSchema: 'lifespan.v3' };
const policy: PaidLifecycleVaultV3Policy = { version: 3, buckets: 64, maxRecordsPerBucket: 512,
  maxEncodedRecordBytes: 32768, maxJournalBytes: 1073741824 };
async function cleanup(directory: string) {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-vault-v3-')) throw new Error('Unsafe test cleanup');
  await rm(target, { recursive: true, force: true });
}

it('keeps original v1 records, binds v3 claims after restart and serializes distinct stop operations with one durable lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-vault-v3-')), key = randomBytes(32);
  const legacyStorage = new CystCheckpointFileVault({ directory, masterKey: key });
  const legacy = new PaidLifecycleClientVault(legacyStorage, scope);
  let first: PaidLifecycleClientVaultV3 | undefined, second: PaidLifecycleClientVaultV3 | undefined;
  try {
    await legacy.claim('existing-v1', { original: true });
    first = new PaidLifecycleClientVaultV3({ ...scope, directory, masterKey: key, policy });
    await first.claim('first-v3', { original: 'private v3 state' });
    first.close(); first = new PaidLifecycleClientVaultV3({ ...scope, directory, masterKey: key, policy });
    second = new PaidLifecycleClientVaultV3({ ...scope, directory, masterKey: key, policy });
    expect(await first.read('first-v3')).toEqual({ original: 'private v3 state' });
    expect(Object.isFrozen(first.scope)).toBe(true);
    expect(await legacy.read('existing-v1')).toEqual({ original: true });
    await expect(second.claim('first-v3', { original: 'replacement' })).rejects.toThrow();
    const conflicting = await Promise.allSettled([first.claim('concurrent-original', { writer: 1 }), second.claim('concurrent-original', { writer: 2 })]);
    expect(conflicting.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(conflicting.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await first.read('concurrent-original')).toEqual(await second.read('concurrent-original'));
    await expect(first.claim('too-large', { text: 'x'.repeat(40_000) })).rejects.toThrow('storage budget');
    expect(await first.read('too-large')).toBeUndefined();
    const events: string[] = [];
    let entered: (() => void) | undefined;
    const started = new Promise<void>(done => { entered = done; });
    const operation = first.exclusiveOperation('different-stop-a', async () => {
      events.push('a-enter'); entered?.();
      await first!.claim('stop-a', { exactTransaction: 'retained-before-return' });
      await new Promise<void>(done => setTimeout(done, 100)); events.push('a-leave');
    });
    await started;
    const other = second.exclusiveOperation('different-stop-b', async () => {
      events.push('b-enter'); expect(await second!.read('stop-a')).toEqual({ exactTransaction: 'retained-before-return' }); events.push('b-leave');
    });
    await Promise.all([operation, other]);
    expect(events).toEqual(['a-enter', 'a-leave', 'b-enter', 'b-leave']);
    const directoriesBefore = (await readdir(directory)).length;
    for (let index = 0; index < 10; index++) await first.exclusiveOperation('new-operation-' + index, async () => undefined);
    expect((await readdir(directory)).length).toBe(directoriesBefore);
    expect((await readdir(directory)).length).toBeLessThanOrEqual(68);
  } finally { first?.close(); second?.close(); legacyStorage.close(); key.fill(0); await cleanup(directory); }
});

it.runIf(process.env.TELOMERE_LIFECYCLE_V3_CAPACITY_ACCEPTANCE === '1')(
  'retains 960 logical hops and more than twenty thousand actual encrypted immutable records across restarts without deleting history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telomere-vault-v3-')), key = randomBytes(32);
    let vault: PaidLifecycleClientVaultV3 | undefined;
    const retained: { intent: string; id: string; state: number }[] = [];
    try {
      vault = new PaidLifecycleClientVaultV3({ ...scope, directory, masterKey: key, policy });
      for (let hop = 0; hop < 960; hop++) {
        if (hop && hop % 120 === 0) { vault.close(); vault = new PaidLifecycleClientVaultV3({ ...scope, directory, masterKey: key, policy }); }
        const intent = '00000000-0000-4000-8000-' + hop.toString(16).padStart(12, '0');
        for (let record = 0; record < 20; record++) await vault.claim('v3:' + intent + ':' + record, { hop, record,
          logicalLeaseSeconds: 120, logicalHopSeconds: 90, paymentOperation: 'original-' + hop });
        const encrypted = await encryptCheckpoint(Buffer.from(JSON.stringify({ hop })), scope);
        try { await vault.putCheckpoint(intent, encrypted.envelope, encrypted.recoveryKey); }
        finally { encrypted.recoveryKey.fill(0); }
        retained.push({ intent, id: encrypted.envelope.id, state: hop });
      }
      vault.close(); vault = new PaidLifecycleClientVaultV3({ ...scope, directory, masterKey: key, policy });
      for (const value of [retained[0]!, retained[479]!, retained[959]!]) {
        const checkpoint = await vault.getCheckpoint(value.intent); expect(checkpoint?.envelope.id).toBe(value.id);
        if (!checkpoint) throw new Error('Retained original checkpoint absent');
        const recoveryKey = await vault.recoveryKey(value.id);
        try { expect(JSON.parse(Buffer.from(await decryptCheckpoint(checkpoint.envelope, recoveryKey)).toString())).toEqual({ hop: value.state }); }
        finally { checkpoint.recoveryKey.fill(0); recoveryKey.fill(0); }
      }
      expect(await vault.read('v3:' + retained[0]!.intent + ':0')).toMatchObject({ hop: 0, record: 0 });
      expect((await readdir(directory)).length).toBeLessThanOrEqual(67);
    } finally { vault?.close(); key.fill(0); await cleanup(directory); }
  }, 3_600_000);
