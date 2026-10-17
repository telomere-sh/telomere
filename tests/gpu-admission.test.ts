import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCommand, type DockerCommand } from '../src/runtime/command.js';
import { GpuAdmissionController, type GpuWarmCell } from '../src/gpu/admission.js';
import { readGpuInventory, gpuInventoryArgs, gpuProcessesArgs } from '../src/gpu/inventory.js';
import { checkGpuProbe, checkGpuSnapshot, newGpuChallenge,
  type GpuClassPolicy, type GpuProbeDriver, type GpuChallenge } from '../src/gpu/probes.js';
import { reserveGpuSlot } from '../src/gpu/slot.js';

const uuid = 'GPU-11111111-2222-3333-4444-555555555555';
const alphaUuid = 'GPU-abcdefab-cdef-abcd-efab-cdefabcdefab';
const runId = '0x' + 'a'.repeat(64);
const imageDigest = 'sha256:' + 'b'.repeat(64);
const policy: GpuClassPolicy = { classId: 'h100_pilot', minimumDriverMajor: 550, minimumMemoryMiB: 8192,
  memoryChallengeMiB: 4096, memoryHeadroomMiB: 1024, minimumPowerRatio: 0.85,
  gemmTflops: { minimum: 90, maximum: 110 }, bandwidthGiBs: { minimum: 45, maximum: 55 }, probeImageDigest: imageDigest };
const snapshot = { uuid, driverMajor: 550, totalMemoryMiB: 8192, freeMemoryMiB: 8192,
  powerLimitWatts: 300, defaultPowerLimitWatts: 350, computeMode: 'Exclusive_Process' as const, migMode: 'Disabled' as const };
const empty = () => ({ devices: [snapshot], activeComputeUuids: new Set<string>() });
const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), 'telomere-gpu-')); directories.push(value); return value; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); });

function driver(overrides: Partial<{ nonce: string; uuid: string; runId: string; kind: 'class' | 'memory' | 'warm';
  gemmTflops: number; bandwidthGiBs: number; verifiedMemoryMiB: number; integrityPassed: boolean;
  throttled: boolean; cleanupConfirmed: boolean }> = {}): GpuProbeDriver {
  return { binding: { uuid, imageDigest, isolation: 'kata_gpu' },
    run: async challenge => ({ cleanupConfirmed: overrides.cleanupConfirmed ?? true,
      report: { version: 1, kind: overrides.kind ?? challenge.kind, runId: overrides.runId ?? challenge.runId,
        nonce: overrides.nonce ?? challenge.nonce, seed: challenge.seed,
        uuid: overrides.uuid ?? challenge.uuid, startedAtMs: challenge.issuedAtMs,
        finishedAtMs: challenge.issuedAtMs + 2, kernelElapsedMs: 2,
        gemmTflops: overrides.gemmTflops ?? (challenge.kind === 'memory' ? 0 : 100),
        bandwidthGiBs: overrides.bandwidthGiBs ?? (challenge.kind === 'memory' ? 0 : 50),
        verifiedMemoryMiB: overrides.verifiedMemoryMiB ?? (challenge.kind === 'memory' ? challenge.requestedMemoryMiB : 0),
        integrityPassed: overrides.integrityPassed ?? true, throttled: overrides.throttled ?? false } }) };
}

function warmCell(overrides: Parameters<typeof driver>[0] = {}): GpuWarmCell {
  return { runId, uuid, isolation: 'kata_gpu', runWarmProbe: async (challenge: GpuChallenge) => ({
    probeExited: overrides.cleanupConfirmed ?? true,
    report: { version: 1, kind: overrides.kind ?? challenge.kind, runId: overrides.runId ?? challenge.runId,
      nonce: overrides.nonce ?? challenge.nonce, seed: challenge.seed, uuid: overrides.uuid ?? challenge.uuid,
      startedAtMs: challenge.issuedAtMs, finishedAtMs: challenge.issuedAtMs + 2, kernelElapsedMs: 2,
      gemmTflops: overrides.gemmTflops ?? 100, bandwidthGiBs: overrides.bandwidthGiBs ?? 50,
      verifiedMemoryMiB: overrides.verifiedMemoryMiB ?? 0,
      integrityPassed: overrides.integrityPassed ?? true, throttled: overrides.throttled ?? false },
  }) };
}

describe('NVIDIA GPU admission and probe evidence', () => {
  it('executes bounded read-only nvidia-smi queries through real child processes', async () => {
    const calls: string[][] = [];
    const command: DockerCommand = async (args, options) => {
      calls.push([...args]);
      const stdout = args[0] === gpuInventoryArgs[0]
        ? `${uuid}, 8192, 8192, 550.54.15, Exclusive_Process, Disabled, 300, 350\n` : '';
      return executeCommand(process.execPath, ['-e', 'process.stdout.write(' + JSON.stringify(stdout) + ')'], options);
    };
    const value = await readGpuInventory({ command });
    expect(value.devices).toEqual([snapshot]); expect(value.activeComputeUuids.size).toBe(0);
    expect(calls).toEqual([[...gpuInventoryArgs], [...gpuProcessesArgs]]);
  });

  it('rejects ambiguous, partial, duplicate, busy and unsafe inventory', async () => {
    const csv = `${uuid}, 8192, 8192, 550.54.15, Exclusive_Process, Disabled, 300, 350\n`;
    for (const [inventory, processes] of [
      [csv + csv, ''], [csv.replace('Exclusive_Process', 'Default'), ''], [csv.replace('550.54.15', 'N/A'), ''],
      [csv.replace('350', 'N/A'), ''], [csv, `${uuid}, 42\n`], [csv, 'No running processes found\n'],
    ]) {
      const command: DockerCommand = async args => ({ stdout: args[0] === gpuInventoryArgs[0] ? inventory ?? '' : processes ?? '',
        stderr: '', exitCode: 0 });
      if (processes === `${uuid}, 42\n`) expect((await readGpuInventory({ command })).activeComputeUuids.has(uuid)).toBe(true);
      else await expect(readGpuInventory({ command })).rejects.toThrow();
    }
    expect(() => checkGpuSnapshot({ ...snapshot, powerLimitWatts: 175 }, policy, uuid)).toThrow();
    expect(() => checkGpuSnapshot({ ...snapshot, freeMemoryMiB: 5000 }, policy, uuid)).toThrow();
    expect(() => checkGpuSnapshot({ ...snapshot, driverMajor: 535 }, policy, uuid)).toThrow();
    expect(() => checkGpuSnapshot({ ...snapshot, migMode: 'Enabled' }, policy, uuid)).toThrow();
  });

  it('normalizes UUID hex case before duplicate detection and occupancy checks', async () => {
    const row = (id: string) => `${id}, 8192, 8192, 550.54.15, Exclusive_Process, Disabled, 300, 350\n`;
    const alias = alphaUuid.toUpperCase();
    const command: DockerCommand = async args => ({ stdout: args[0] === gpuInventoryArgs[0] ? row(alphaUuid)
      : `${alias}, 42\n`, stderr: '', exitCode: 0 });
    const observed = await readGpuInventory({ command });
    expect(observed.devices[0]?.uuid).toBe(alphaUuid);
    expect(observed.activeComputeUuids.has(alphaUuid)).toBe(true);
    const duplicate: DockerCommand = async args => ({ stdout: args[0] === gpuInventoryArgs[0]
      ? row(alphaUuid) + row(alias) : '', stderr: '', exitCode: 0 });
    await expect(readGpuInventory({ command: duplicate })).rejects.toThrow('GPU inventory unavailable');

    // The injected inventory seam must also reject a differently cased busy
    // process; the production inventory reader has already normalized it.
    const dir = await directory(), base = driver();
    const controller = new GpuAdmissionController({ directory: dir, policy,
      driver: { ...base, binding: { ...base.binding, uuid: alphaUuid } },
      inventory: async () => ({ devices: [{ ...snapshot, uuid: alphaUuid }],
        activeComputeUuids: new Set([alias]) }) });
    await expect(controller.prepare(alphaUuid, runId)).rejects.toThrow();
    const claim = await reserveGpuSlot({ directory: dir, uuid: alphaUuid, runId });
    await claim.release({ cleanupConfirmed: true });
  });

  it('holds an atomic cross-process GPU slot until confirmed cleanup', async () => {
    const dir = await directory(), slot = await reserveGpuSlot({ directory: dir, uuid, runId });
    const path = join(dir, uuid.toLowerCase() + '.json');
    const attempt = async () => executeCommand(process.execPath, ['-e',
      'require("node:fs").openSync(process.argv[1],"wx")', path], { maxOutputBytes: 1024, signal: AbortSignal.timeout(2000) });
    expect((await attempt()).exitCode).not.toBe(0);
    await expect(reserveGpuSlot({ directory: dir, uuid, runId })).rejects.toThrow();
    // @ts-expect-error Deliberately exercises the runtime guard on an untrusted caller value.
    await expect(slot.release({ cleanupConfirmed: false })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8')).runId).toBe(runId);
    await slot.release({ cleanupConfirmed: true });
    expect((await attempt()).exitCode).toBe(0);
  });

  it('admits a free GPU only after class and VRAM probes and retains the slot through warm check', async () => {
    const dir = await directory(), calls: string[] = [];
    const native = driver(), adapter: GpuProbeDriver = { binding: native.binding,
      run: async (challenge, signal) => { calls.push(challenge.kind); return native.run(challenge, signal); } };
    const controller = new GpuAdmissionController({ directory: dir, policy, driver: adapter, inventory: async () => empty() });
    const ready = await controller.prepare(uuid, runId);
    expect(calls).toEqual(['class', 'memory']);
    expect(ready.evidence.classProbe.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(ready.evidence)).toBe(true);
    expect(Object.isFrozen(ready.evidence.classProbe.report)).toBe(true);
    expect(() => Object.assign(ready.evidence, { runId: '0x' + 'e'.repeat(64) })).toThrow();
    expect(() => Object.assign(ready, { evidence: { ...ready.evidence, runId: '0x' + 'e'.repeat(64) } })).toThrow();
    expect(ready.billableReady).toBe(false);
    await expect(reserveGpuSlot({ directory: dir, uuid, runId })).rejects.toThrow();
    const warm = await ready.warmCheck(Date.now(), { ...warmCell(), runWarmProbe: async challenge => {
      calls.push(challenge.kind); return warmCell().runWarmProbe(challenge, AbortSignal.timeout(100));
    } });
    expect(warm.report.kind).toBe('warm'); expect(warm.report.runId).toBe(runId);
    expect(calls).toEqual(['class', 'memory', 'warm']);
    expect(ready.billableReady).toBe(true);
    await expect(ready.warmCheck(Date.now(), warmCell())).rejects.toThrow();
    await ready.release({ cleanupConfirmed: true });
    expect(ready.billableReady).toBe(false);
    const next = await reserveGpuSlot({ directory: dir, uuid, runId }); await next.release({ cleanupConfirmed: true });
  });

  it('does not admit occupied GPUs or failed and forged probes', async () => {
    for (const candidate of [driver({ gemmTflops: 50 }), driver({ bandwidthGiBs: 25 }), driver({ integrityPassed: false }),
      driver({ throttled: true }), driver({ nonce: 'c'.repeat(64) }),
      driver({ runId: '0x' + 'd'.repeat(64) }), driver({ verifiedMemoryMiB: 1 })]) {
      const dir = await directory();
      const controller = new GpuAdmissionController({ directory: dir, policy, driver: candidate, inventory: async () => empty() });
      await expect(controller.prepare(uuid, runId)).rejects.toThrow();
    }
    const dir = await directory();
    const busy = new GpuAdmissionController({ directory: dir, policy, driver: driver(),
      inventory: async () => ({ devices: [snapshot], activeComputeUuids: new Set([uuid]) }) });
    await expect(busy.prepare(uuid, runId)).rejects.toThrow();
    const next = await reserveGpuSlot({ directory: dir, uuid, runId }); await next.release({ cleanupConfirmed: true });
  });

  it('quarantines a slot when a probe fails before cleanup is confirmed', async () => {
    const dir = await directory();
    const controller = new GpuAdmissionController({ directory: dir, policy, driver: driver({ cleanupConfirmed: false }), inventory: async () => empty() });
    await expect(controller.prepare(uuid, runId)).rejects.toThrow();
    await expect(reserveGpuSlot({ directory: dir, uuid, runId })).rejects.toThrow();
  });

  it('fails closed when inventory never settles despite an abort signal', async () => {
    const controller = new AbortController();
    const command: DockerCommand = async () => new Promise(() => undefined);
    const check = readGpuInventory({ command, signal: controller.signal });
    controller.abort();
    await expect(check).rejects.toThrow('GPU inventory unavailable');
  });

  it('rejects changed power capacity after the challenge and releases a known-clean slot', async () => {
    const dir = await directory(); let reads = 0;
    const controller = new GpuAdmissionController({ directory: dir, policy, driver: driver(), inventory: async () => {
      reads += 1;
      return { devices: [{ ...snapshot, powerLimitWatts: reads === 1 ? 300 : 175 }], activeComputeUuids: new Set<string>() };
    } });
    await expect(controller.prepare(uuid, runId)).rejects.toThrow();
    expect(reads).toBe(2);
    const next = await reserveGpuSlot({ directory: dir, uuid, runId }); await next.release({ cleanupConfirmed: true });
  });

  it('prevents billing after a throttled warm check', async () => {
    const dir = await directory();
    const controller = new GpuAdmissionController({ directory: dir, policy, driver: driver(), inventory: async () => empty() });
    const ready = await controller.prepare(uuid, runId);
    await expect(ready.warmCheck(Date.now(), warmCell({ throttled: true }))).rejects.toThrow();
    expect(ready.billableReady).toBe(false);
    await expect(ready.release({ cleanupConfirmed: true })).rejects.toThrow();
    await expect(reserveGpuSlot({ directory: dir, uuid, runId })).rejects.toThrow();
  });

  it('does not release a warmed slot when probe cleanup is uncertain', async () => {
    const dir = await directory();
    const controller = new GpuAdmissionController({ directory: dir, policy, driver: driver(), inventory: async () => empty() });
    const ready = await controller.prepare(uuid, runId);
    await expect(ready.warmCheck(Date.now(), warmCell({ cleanupConfirmed: false }))).rejects.toThrow();
    await expect(ready.release({ cleanupConfirmed: true })).rejects.toThrow();
    await expect(reserveGpuSlot({ directory: dir, uuid, runId })).rejects.toThrow();
  });

  it('rejects stale challenge, late or underpowered warm evidence', async () => {
    const challenge = newGpuChallenge('warm', uuid, runId, 0, Date.now() - 40_000);
    const report = (await warmCell().runWarmProbe(challenge, AbortSignal.timeout(100))).report;
    expect(() => checkGpuProbe(report, challenge, policy)).toThrow();
    const dir = await directory();
    const controller = new GpuAdmissionController({ directory: dir, policy, driver: driver(), inventory: async () => empty() });
    const ready = await controller.prepare(uuid, runId);
    await expect(ready.warmCheck(Date.now() - 21_000, warmCell())).rejects.toThrow();
    await ready.release({ cleanupConfirmed: true });
  });
});
