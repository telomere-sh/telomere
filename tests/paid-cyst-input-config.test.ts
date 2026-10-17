import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { dockerHostScope } from '../src/host-kit/hosted.js';
import { assertPaidCystInputLocation, readPaidCystInputConfig } from '../src/host-kit/sessions/cyst-input-config.js';
import { paidCystInputSpoolIdentity } from '../src/host-kit/sessions/cyst-input-spool.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
it('binds operator restore scope to a private reviewed input policy without opening plaintext storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-input-policy-'));
  try {
    const config = { directory: join(directory, 'unopened-spool'), maxInputBytes: 8_388_608,
      globalBytes: 16_777_216, maxOperations: 4, minimumFreeBytes: 1_048_576 };
    const path = join(directory, 'input.json'), bytes = JSON.stringify(config);
    await writeFile(path, bytes, { mode: 0o600 });
    const policy = await readPaidCystInputConfig(path, '0x' + hash(bytes));
    expect(policy).toEqual(config); expect(await readFile(path, 'utf8')).toBe(bytes);
    await expect(lstat(config.directory)).rejects.toHaveProperty('code', 'ENOENT');
    if (!policy) throw new Error('Reviewed policy missing');
    expect(() => assertPaidCystInputLocation(policy, join(directory, 'host-journal'))).not.toThrow();
    for (const journal of [directory, policy.directory, join(policy.directory, 'nested-host')]) {
      expect(() => assertPaidCystInputLocation(policy, journal)).toThrow('separate directory trees');
    }
    const options = { hostKey: '0x' + '1'.repeat(64), controlKey: '0x' + '2'.repeat(64),
      isolation: 'gvisor' as const, socketPath: '/run/telomere/docker.sock' };
    const legacy = dockerHostScope(options), current = dockerHostScope({ ...options, cystInputIdentity: paidCystInputSpoolIdentity(policy) });
    expect(current.sessionBackend).not.toBe(legacy.sessionBackend);
    expect(dockerHostScope({ ...options, cystInputIdentity: paidCystInputSpoolIdentity({ ...policy, globalBytes: policy.globalBytes + 1 }) })
      .sessionBackend).not.toBe(current.sessionBackend);
    expect(() => dockerHostScope({ ...options, isolation: 'docker_development', cystInputIdentity: paidCystInputSpoolIdentity(policy) })).toThrow();
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-input-policy-')) throw new Error('Unexpected owned policy fixture');
    await rm(target, { recursive: true, force: true });
  }
});

it('rejects incomplete, changed, ambiguous or unbounded operator input policies before opening a spool', async () => {
  expect(await readPaidCystInputConfig()).toBeUndefined();
  await expect(readPaidCystInputConfig('/missing/private.json')).rejects.toThrow('reviewed hash');
  await expect(readPaidCystInputConfig(undefined, '1'.repeat(64))).rejects.toThrow('reviewed hash');
  const directory = await mkdtemp(join(tmpdir(), 'telomere-input-policy-'));
  try {
    const path = join(directory, 'input.json'), policy = { directory: join(directory, 'unopened-spool'),
      maxInputBytes: 8_388_608, globalBytes: 16_777_216, maxOperations: 4, minimumFreeBytes: 1_048_576 };
    for (const bytes of [JSON.stringify(policy), '{"directory":"a","directory":"b"}', ' '.repeat(32_769)]) {
      await writeFile(path, bytes, { mode: 0o600 });
      await expect(readPaidCystInputConfig(path, bytes === JSON.stringify(policy) ? '0'.repeat(64) : hash(bytes))).rejects.toThrow('reviewed hash');
    }
    await expect(lstat(policy.directory)).rejects.toHaveProperty('code', 'ENOENT');
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-input-policy-')) throw new Error('Unexpected owned policy fixture');
    await rm(target, { recursive: true, force: true });
  }
});
