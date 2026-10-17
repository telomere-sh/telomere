import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DurableVaultCompute, FRAMEWORK_COMPUTE_SCHEMA, frameworkComputeProfileSchema } from '../src/integrations/durable-vault-compute.js';
import { platformVaultRuntimeConfigSchema } from '../src/platform-runtime/vault-client.js';
import { CystCheckpointFileVault } from '../src/sdk/cyst-checkpoints-file-vault.js';
import { PaidLifecycleClientVault } from '../src/agents/paid-lifecycle-runner.js';

it('persists an observed CPU v2 protocol floor before any payment and rejects downgrade after encrypted journal reopen', async () => {
  const raw: unknown = JSON.parse(await readFile(resolve('python/tests/fixtures/platform-typescript.json'), 'utf8'));
  const config = z.object({ vaultConfig: platformVaultRuntimeConfigSchema }).passthrough().parse(raw).vaultConfig;
  const profile = frameworkComputeProfileSchema.parse({ baseUrl: 'http://127.0.0.1:3280', pins: config.pins,
    vaultPins: config.vaultPins, binding: config.binding });
  const root = await mkdtemp(join(tmpdir(), 'telomere-framework-floor-')), masterKey = randomBytes(32);
  let privateVault: CystCheckpointFileVault | undefined;
  const journal = () => {
    privateVault = new CystCheckpointFileVault({ directory: root, masterKey });
    return new PaidLifecycleClientVault(privateVault, { owner: config.binding.owner,
      agent: config.binding.agentWallet, applicationSchema: FRAMEWORK_COMPUTE_SCHEMA });
  };
  let activeJournal = journal(), versionTwo = true;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') throw new Error('Unexpected mutation');
    return new Response(JSON.stringify({ ...config, ...(versionTwo ? { cpuReceiptVersion: 2 } : {}) }), { status: 200 });
  });
  const compute = () => new DurableVaultCompute({ profile, journal: activeJournal, sessionToken: 'a'.repeat(64), fetch: fetcher });
  try {
    // Missing work still performs a reviewed configuration read and records the issuer protocol floor.
    await expect(compute().status('no-existing-operation')).rejects.toBeDefined();
    expect(await activeJournal.read('framework-cpu-receipt-floor')).toBe(2);
    privateVault?.close(); activeJournal = journal(); versionTwo = false;
    await expect(compute().status('no-existing-operation')).rejects.toThrow('downgraded');
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  } finally {
    privateVault?.close(); masterKey.fill(0);
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-framework-floor-')) throw new Error('Unsafe protocol-floor test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});

it('binds the independent expected CPU v2 protocol into the immutable private profile and rejects initial v1', async () => {
  const raw: unknown = JSON.parse(await readFile(resolve('python/tests/fixtures/platform-typescript.json'), 'utf8'));
  const config = z.object({ vaultConfig: platformVaultRuntimeConfigSchema }).passthrough().parse(raw).vaultConfig;
  const profile = frameworkComputeProfileSchema.parse({ baseUrl: 'http://127.0.0.1:3280', pins: config.pins,
    vaultPins: config.vaultPins, binding: config.binding, cpuReceiptVersion: 2 });
  const records = new Map<string, unknown>();
  const compute = new DurableVaultCompute({ profile, sessionToken: 'a'.repeat(64),
    journal: { scope: { owner: config.binding.owner, agent: config.binding.agentWallet, applicationSchema: FRAMEWORK_COMPUTE_SCHEMA },
      claim: async (key, value) => { records.set(key, value); }, read: async key => records.get(key) },
    fetch: async () => new Response(JSON.stringify(config), { status: 200 }) });
  await expect(compute.status('no-existing-operation')).rejects.toThrow('downgraded');
  expect(records.get('framework-profile')).toEqual(profile);
});
