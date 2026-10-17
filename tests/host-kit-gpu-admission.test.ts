import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/common.js';
import { GpuAdmissionController } from '../src/gpu/admission.js';
import { reserveGpuSlot } from '../src/gpu/slot.js';
import type { GpuChallenge, GpuClassPolicy, GpuProbeDriver } from '../src/gpu/probes.js';
import { GpuHostKitAdmission, type GpuHostCell, type GpuHostCellRuntime } from '../src/host-kit/gpu-admission.js';

const uuid = 'GPU-11111111-2222-3333-4444-555555555555';
const runId = `0x${'a'.repeat(64)}`;
const probeDigest = `sha256:${'b'.repeat(64)}`;
const image = `reviewed/gpu@sha256:${'c'.repeat(64)}`;
const policy: GpuClassPolicy = { classId: 'h100_pilot', minimumDriverMajor: 550, minimumMemoryMiB: 8192,
  memoryChallengeMiB: 4096, memoryHeadroomMiB: 1024, minimumPowerRatio: 0.85,
  gemmTflops: { minimum: 90, maximum: 110 }, bandwidthGiBs: { minimum: 45, maximum: 55 }, probeImageDigest: probeDigest };
const policySha256 = createHash('sha256').update(canonical(policy)).digest('hex');
const snapshot = { uuid, driverMajor: 550, totalMemoryMiB: 8192, freeMemoryMiB: 8192,
  powerLimitWatts: 300, defaultPowerLimitWatts: 350, computeMode: 'Exclusive_Process' as const, migMode: 'Disabled' as const };
const scope = { uuid, image, isolation: 'kata_gpu' as const, policySha256 };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function report(challenge: GpuChallenge, overrides: Partial<{ throttled: boolean; cleanupConfirmed: boolean }> = {}) {
  return { cleanupConfirmed: overrides.cleanupConfirmed ?? true,
    report: { version: 1, kind: challenge.kind, runId: challenge.runId, nonce: challenge.nonce, seed: challenge.seed,
      uuid: challenge.uuid, startedAtMs: challenge.issuedAtMs, finishedAtMs: challenge.issuedAtMs + 1,
      kernelElapsedMs: 1, gemmTflops: challenge.kind === 'memory' ? 0 : 100,
      bandwidthGiBs: challenge.kind === 'memory' ? 0 : 50,
      verifiedMemoryMiB: challenge.kind === 'memory' ? challenge.requestedMemoryMiB : 0,
      integrityPassed: true, throttled: overrides.throttled ?? false } };
}
function warmReport(challenge: GpuChallenge, overrides: Partial<{ throttled: boolean; probeExited: boolean }> = {}) {
  return { probeExited: overrides.probeExited ?? true,
    report: report(challenge, overrides.throttled === undefined ? {} : { throttled: overrides.throttled }).report };
}

async function fixture(options: { cell?: Partial<GpuHostCell>; stop?: GpuHostCell['stop'];
  start?: GpuHostCellRuntime['start']; warm?: GpuHostCell['runWarmProbe']; clock?: () => number;
  timing?: { startMs: number; stopMs: number } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-gpu-host-'));
  directories.push(directory);
  const events: string[] = [];
  const driver: GpuProbeDriver = { binding: { uuid, imageDigest: probeDigest, isolation: 'kata_gpu' },
    run: async challenge => { events.push('admission:' + challenge.kind);
      return report(challenge); } };
  const controller = new GpuAdmissionController({ directory, policy, driver,
    inventory: async () => ({ devices: [snapshot], activeComputeUuids: new Set<string>() }) });
  const cell: GpuHostCell = { runId, uuid, image, isolation: 'kata_gpu', cellId: 'd'.repeat(64),
    startedAtMs: Date.now(), runWarmProbe: options.warm ?? (async challenge => { events.push('cell:warm'); return warmReport(challenge); }),
    stop: options.stop ?? (async () => { events.push('cell:stop'); return { cleanupConfirmed: true }; }),
    ...options.cell };
  const explicitStartTime = options.cell?.startedAtMs !== undefined;
  const runtime: GpuHostCellRuntime = { binding: { uuid, image, isolation: 'kata_gpu' },
    start: options.start ?? (async () => { events.push('cell:start');
      if (!explicitStartTime) Object.assign(cell, { startedAtMs: Date.now() });
      return cell; }) };
  const host = new GpuHostKitAdmission(controller, runtime, scope, options.clock, options.timing);
  const claim = () => reserveGpuSlot({ directory, uuid, runId });
  return { host, cell, controller, runtime, events, claim };
}

describe('default-off GPU HostKit admission seam', () => {
  it('pins the exact reviewed policy, physical device, image and isolation before runtime use', async () => {
    const { controller, runtime, host } = await fixture();
    for (const altered of [
      { ...scope, policySha256: '0'.repeat(64) }, { ...scope, uuid: 'GPU-aaaaaaaa-2222-3333-4444-555555555555' },
      { ...scope, image: `reviewed/other@sha256:${'c'.repeat(64)}` }, { ...scope, isolation: 'gvisor_nvproxy' as const },
    ]) expect(() => new GpuHostKitAdmission(controller, runtime, altered)).toThrow();
    expect(() => new GpuHostKitAdmission(controller, { ...runtime, binding: { ...runtime.binding,
      image: `reviewed/other@sha256:${'c'.repeat(64)}` } }, scope)).toThrow();
    expect(Object.isFrozen(host.scope)).toBe(true);
    expect(Object.isFrozen(controller.policy)).toBe(true);
    expect(Object.isFrozen(controller.policy.gemmTflops)).toBe(true);
    expect(Object.isFrozen(controller.policy.bandwidthGiBs)).toBe(true);
    expect(Object.isFrozen(controller.probeBinding)).toBe(true);
    expect(() => Object.assign(host.scope, { image: `reviewed/other@sha256:${'c'.repeat(64)}` })).toThrow();
    expect(() => Object.assign(host, { scope: { ...host.scope, image: `reviewed/other@sha256:${'c'.repeat(64)}` } })).toThrow();
    expect(() => Object.defineProperty(host, 'scope', { value: { ...host.scope,
      image: `reviewed/other@sha256:${'c'.repeat(64)}` } })).toThrow();
    expect(() => Object.assign(host as any, { timing: { startMs: 0, stopMs: 0 } })).toThrow();
    expect(() => Object.assign(controller.policy.gemmTflops, { minimum: 1 })).toThrow();
    expect(() => Object.assign(controller, { policy: { ...controller.policy, minimumMemoryMiB: 1 } })).toThrow();
    expect(() => Object.defineProperty(controller, 'policy', { value: { ...controller.policy, minimumMemoryMiB: 1 } })).toThrow();
    expect(() => Object.assign(controller.probeBinding, { uuid: 'GPU-aaaaaaaa-2222-3333-4444-555555555555' })).toThrow();
    expect(() => Object.assign(controller, { probeBinding: { ...controller.probeBinding, uuid: 'GPU-aaaaaaaa-2222-3333-4444-555555555555' } })).toThrow();
    expect(() => Object.defineProperty(controller, 'prepare', { value: async () => undefined })).toThrow();
    expect(() => Object.assign(controller as any, { options: { directory: 'forged' } })).toThrow();
    Object.assign(runtime.binding, { image: `reviewed/other@sha256:${'c'.repeat(64)}` });
    await expect(host.start({ runId, maxSeconds: 120 })).rejects.toThrow();
    const short = await fixture();
    await expect(short.host.start({ runId, maxSeconds: 21 })).rejects.toThrow();
    const free = await short.claim(); await free.release({ cleanupConfirmed: true });
  });

  it('runs warm only inside the workload Cell, keeps the claim and admits no earlier billable second', async () => {
    let enter!: () => void, complete!: (value: ReturnType<typeof warmReport>) => void;
    let warmChallenge: GpuChallenge | undefined;
    let observedAtMs = Date.now();
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const warm = new Promise<ReturnType<typeof warmReport>>(resolve => { complete = resolve; });
    const f = await fixture({ clock: () => observedAtMs,
      warm: challenge => { f.events.push('cell:warm'); warmChallenge = challenge; enter(); return warm; } });
    const pending = f.host.start({ runId, maxSeconds: 120 });
    await entered;
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await expect(f.claim()).rejects.toThrow();
    complete(warmReport(warmChallenge!));
    const run = await pending;
    expect(f.events).toEqual(['admission:class', 'admission:memory', 'cell:start', 'cell:warm']);
    expect(run.billableReady).toBe(false);
    expect(() => run.assertBillableSecond(f.cell.startedAtMs + 19_000, f.cell.startedAtMs + 20_000)).toThrow();
    expect(() => run.assertBillableSecond(f.cell.startedAtMs + 20_000, f.cell.startedAtMs + 21_000)).toThrow();
    observedAtMs = f.cell.startedAtMs + 20_000;
    expect(run.billableReady).toBe(true);
    observedAtMs = f.cell.startedAtMs + 21_000;
    expect(run.billableReady).toBe(true);
    expect(() => run.assertBillableSecond(f.cell.startedAtMs + 20_000, f.cell.startedAtMs + 21_000)).not.toThrow();
    observedAtMs = f.cell.startedAtMs + 120_000;
    expect(run.billableReady).toBe(false);
    expect(() => run.assertBillableSecond(f.cell.startedAtMs + 119_000, f.cell.startedAtMs + 120_000)).toThrow();
    expect(() => run.assertBillableSecond(f.cell.startedAtMs + 120_000, f.cell.startedAtMs + 121_000)).toThrow();
    expect(Object.isFrozen(run.request)).toBe(true);
    expect(() => Object.assign(run.request, { maxSeconds: 120_000 })).toThrow();
    expect(() => Object.assign(run, { request: { ...run.request, maxSeconds: 120_000 } })).toThrow();
    expect(() => Object.defineProperty(run, 'request', { value: { ...run.request, maxSeconds: 120_000 } })).toThrow();
    const cellId = run.cellId, originalStart = f.cell.startedAtMs;
    expect(() => Object.assign(run, { warmPassedAtMs: originalStart - 19_000 })).toThrow();
    expect(() => Object.defineProperty(run, 'warmPassedAtMs', { value: originalStart - 19_000 })).toThrow();
    Object.assign(f.cell, { cellId: 'e'.repeat(64), startedAtMs: originalStart - 19_000 });
    expect(run.cellId).toBe(cellId);
    expect(() => Object.assign(run as any, { startedAtMs: originalStart - 19_000,
      deadlineAtMs: originalStart + 999_000, stopping: true, stopped: true })).toThrow();
    expect(() => Object.defineProperty(run, 'stop', { value: async () => undefined })).toThrow();
    observedAtMs = originalStart + 21_000;
    expect(run.billableReady).toBe(true);
    expect(() => run.assertBillableSecond(originalStart + 20_000, originalStart + 21_000)).not.toThrow();
    await run.stop();
    expect(run.billableReady).toBe(false);
    const released = await f.claim(); await released.release({ cleanupConfirmed: true });
  });

  it.each(['runId', 'uuid', 'isolation', 'image', 'cellId'] as const)('quarantines an unexpected %s without stopping an untrusted Cell', async field => {
    const changed = { runId: `0x${'e'.repeat(64)}`, uuid: 'GPU-aaaaaaaa-2222-3333-4444-555555555555',
      isolation: 'gvisor_nvproxy' as const, image: `reviewed/other@sha256:${'c'.repeat(64)}`, cellId: 'invalid' };
    const f = await fixture({ cell: { [field]: changed[field] } });
    await expect(f.host.start({ runId, maxSeconds: 120 })).rejects.toThrow();
    expect(f.events).not.toContain('cell:warm');
    expect(f.events).not.toContain('cell:stop');
    await expect(f.claim()).rejects.toThrow();
  });

  it('stops a throttled Cell but preserves its slot for review; a pre-warm stale run can release cleanly', async () => {
    const throttled = await fixture({ warm: async challenge => warmReport(challenge, { throttled: true }) });
    await expect(throttled.host.start({ runId, maxSeconds: 120 })).rejects.toThrow();
    expect(throttled.events).toContain('cell:stop');
    await expect(throttled.claim()).rejects.toThrow();
    const late = await fixture({ cell: { startedAtMs: Date.now() - 19_000 } });
    await expect(late.host.start({ runId, maxSeconds: 120 })).rejects.toThrow();
    expect(late.events).not.toContain('cell:warm');
    const second = await late.claim(); await second.release({ cleanupConfirmed: true });
  });

  it('preserves the physical claim after ambiguous start, warm cleanup or Cell stop', async () => {
    const ambiguous = await fixture({ start: async () => { throw new Error('lost Docker create acknowledgement'); } });
    await expect(ambiguous.host.start({ runId, maxSeconds: 120 })).rejects.toThrow();
    await expect(ambiguous.claim()).rejects.toThrow();
    const warm = await fixture({ warm: async challenge => warmReport(challenge, { probeExited: false }) });
    await expect(warm.host.start({ runId, maxSeconds: 120 })).rejects.toThrow();
    expect(warm.events).toContain('cell:stop');
    await expect(warm.claim()).rejects.toThrow();
    const stopping = await fixture({ stop: async () => ({ cleanupConfirmed: false }) });
    const run = await stopping.host.start({ runId, maxSeconds: 120 });
    await expect(run.stop()).rejects.toThrow();
    expect(run.billableReady).toBe(false);
    await expect(stopping.claim()).rejects.toThrow();
    await expect(run.stop()).rejects.toThrow();
  });

  it('bounds stuck runtime creation and stop without releasing an uncertain physical claim', async () => {
    let createSignal: AbortSignal | undefined;
    const create = await fixture({ timing: { startMs: 20, stopMs: 20 },
      start: async (_request, signal) => { createSignal = signal; return new Promise<GpuHostCell>(() => undefined); } });
    await expect(create.host.start({ runId, maxSeconds: 120 })).rejects.toThrow();
    expect(createSignal?.aborted).toBe(true);
    await expect(create.claim()).rejects.toThrow();

    let stopSignal: AbortSignal | undefined;
    const stop = await fixture({ timing: { startMs: 20, stopMs: 20 },
      stop: async signal => { stopSignal = signal; return new Promise<{ cleanupConfirmed: boolean }>(() => undefined); } });
    const run = await stop.host.start({ runId, maxSeconds: 120 });
    await expect(run.stop()).rejects.toThrow();
    expect(stopSignal?.aborted).toBe(true);
    expect(run.billableReady).toBe(false);
    await expect(run.stop()).rejects.toThrow();
    await expect(stop.claim()).rejects.toThrow();
  });

  it('asks the runtime to stop automatically at the reviewed deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      const run = await f.host.start({ runId, maxSeconds: 22 });
      expect(f.events).not.toContain('cell:stop');
      await vi.advanceTimersByTimeAsync(22_000);
      expect(f.events).toContain('cell:stop');
      expect(run.billableReady).toBe(false);
      // The watchdog has started stop; join its filesystem cleanup before
      // re-acquiring the durable slot. Fake timers do not drain POSIX I/O.
      await run.stop();
      expect(f.events.filter(event => event === 'cell:stop')).toHaveLength(1);
      const released = await f.claim(); await released.release({ cleanupConfirmed: true });
    } finally { vi.useRealTimers(); }
  });
});
