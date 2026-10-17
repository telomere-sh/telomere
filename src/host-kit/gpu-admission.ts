import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../common.js';
import { GpuAdmissionController, type GpuPreparedRun, type GpuWarmCell } from '../gpu/admission.js';
import { gpuUuidSchema } from '../gpu/inventory.js';
import { gpuProbeBindingSchema } from '../gpu/probes.js';
import { imageDigestSchema } from './protocol.js';

const rejected = () => new Error('GPU HostKit Cell unavailable or quarantined');
const scopeSchema = z.object({
  uuid: gpuUuidSchema,
  image: imageDigestSchema,
  isolation: gpuProbeBindingSchema.shape.isolation,
  policySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const cellIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const runSchema = z.object({ runId: z.string().regex(/^0x[a-f0-9]{64}$/),
  maxSeconds: z.number().int().min(22).max(120) }).strict();
const timingSchema = z.object({ startMs: z.number().int().min(1).max(10_000),
  stopMs: z.number().int().min(1).max(10_000) }).strict();
const defaultTiming: Readonly<z.infer<typeof timingSchema>> = Object.freeze({ startMs: 10_000, stopMs: 10_000 });
export type GpuHostScope = z.infer<typeof scopeSchema>;
export type GpuHostRunRequest = z.infer<typeof runSchema>;

/** Bounds the caller's wait. Abort is advisory: a late Docker operation may
 * still finish, so its durable GPU claim must remain for reconciliation. */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(rejected()); }, timeoutMs);
    });
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]);
  } finally { clearTimeout(timer); }
}

/** This is a trusted host-runtime handle. The warm kernel executes through the
 * same handle that owns the workload process; no second probe tenant is valid.
 * stop() must inspect and remove exactly this Cell before confirming cleanup.
 * The runtime must independently enforce maxSeconds across controller crashes. */
export interface GpuHostCell extends GpuWarmCell {
  readonly cellId: string;
  readonly image: string;
  readonly startedAtMs: number;
  stop(signal: AbortSignal): Promise<{ cleanupConfirmed: boolean }>;
}

/** A production implementation must check the actual GPU device assignment,
 * runtime (runsc nvproxy or Kata GPU), image digest and owned Cell identity.
 * A rejected or ambiguous start MUST leave cleanup unconfirmed. */
export interface GpuHostCellRuntime {
  readonly binding: Pick<GpuHostScope, 'uuid' | 'image' | 'isolation'>;
  start(request: GpuHostRunRequest & Pick<GpuHostScope, 'uuid' | 'image' | 'isolation'>,
    signal: AbortSignal): Promise<GpuHostCell>;
}

/** A GPU HostKit seam deliberately kept off the HTTP and financial paths.
 * There is no GPU billable admission until a real runtime is supplied. */
export class GpuHostKitAdmission {
  readonly #scope: GpuHostScope;
  readonly #timing: Readonly<z.infer<typeof timingSchema>>;
  readonly #controller: GpuAdmissionController;
  readonly #prepareGpu: GpuAdmissionController['prepare'];
  readonly #runtime: GpuHostCellRuntime;
  readonly #startCell: GpuHostCellRuntime['start'];
  readonly #clock: () => number;
  get scope(): GpuHostScope { return this.#scope; }
  constructor(controller: GpuAdmissionController,
    runtime: GpuHostCellRuntime, reviewed: unknown,
    clock: () => number = Date.now,
    timing: Readonly<z.infer<typeof timingSchema>> = defaultTiming) {
    this.#controller = controller;
    this.#prepareGpu = controller.prepare.bind(controller);
    this.#runtime = runtime;
    this.#startCell = runtime.start.bind(runtime);
    this.#clock = clock;
    this.#timing = Object.freeze({ ...timingSchema.parse(timing) });
    this.#scope = Object.freeze({ ...scopeSchema.parse(reviewed) });
    const actualPolicy = createHash('sha256').update(canonical(controller.policy)).digest('hex');
    const probe = controller.probeBinding;
    const runtimeBinding = scopeSchema.pick({ uuid: true, image: true, isolation: true }).parse(runtime.binding);
    if (this.#scope.policySha256 !== actualPolicy || probe.uuid !== this.#scope.uuid
      || probe.isolation !== this.#scope.isolation || probe.imageDigest !== controller.policy.probeImageDigest
      || runtimeBinding.uuid !== this.#scope.uuid || runtimeBinding.image !== this.#scope.image
      || runtimeBinding.isolation !== this.#scope.isolation) throw rejected();
    Object.preventExtensions(this);
  }

  async start(raw: unknown): Promise<GpuHostKitRun> {
    const request = Object.freeze({ ...runSchema.parse(raw) }), scope = this.#scope;
    const binding = scopeSchema.pick({ uuid: true, image: true, isolation: true }).parse(this.#runtime.binding);
    if (binding.uuid !== scope.uuid || binding.image !== scope.image || binding.isolation !== scope.isolation
      || createHash('sha256').update(canonical(this.#controller.policy)).digest('hex') !== scope.policySha256) throw rejected();
    // This durable claim is acquired before a runtime can touch the device.
    const prepared = await this.#prepareGpu(scope.uuid, request.runId);
    let cell: GpuHostCell | undefined;
    let cellVerified = false;
    try {
      const startRequestedAtMs = Date.now();
      cell = await bounded(signal => this.#startCell({ ...request, uuid: scope.uuid, image: scope.image,
        isolation: scope.isolation }, signal), this.#timing.startMs);
      if (cell.runId !== request.runId || cell.uuid !== scope.uuid || cell.image !== scope.image
        || cell.isolation !== scope.isolation || !cellIdSchema.safeParse(cell.cellId).success
        || typeof cell.runWarmProbe !== 'function' || typeof cell.stop !== 'function') throw rejected();
      cellVerified = true;
      if (!Number.isSafeInteger(cell.startedAtMs) || cell.startedAtMs < startRequestedAtMs
        || cell.startedAtMs > Date.now()) throw rejected();
      const cellId = cell.cellId, startedAtMs = cell.startedAtMs;
      const warmCell: GpuWarmCell = Object.freeze({ runId: request.runId, uuid: scope.uuid,
        isolation: scope.isolation, runWarmProbe: cell.runWarmProbe.bind(cell) });
      // warmCheck takes the actual workload Cell handle. No user-billable
      // capability is returned until this same-Cell probe has passed.
      await prepared.warmCheck(startedAtMs, warmCell);
      if (!prepared.billableReady) throw rejected();
      return new GpuHostKitRun(prepared, cell, request, cellId, startedAtMs, Date.now(), this.#clock, this.#timing.stopMs);
    } catch {
      // An ambiguous start cannot be assumed absent. With no Cell handle,
      // the durable UUID claim intentionally remains for reconciliation.
      if (cellVerified && cell) {
        try {
          const stopped = await bounded(signal => cell!.stop(signal), this.#timing.stopMs);
          if (stopped.cleanupConfirmed === true) await prepared.release({ cleanupConfirmed: true });
        } catch { /* Preserve the claim on uncertain cleanup. */ }
      }
      throw rejected();
    }
  }
}

export class GpuHostKitRun {
  #stopping = false;
  #stopped = false;
  #stopUncertain = false;
  #stopFlight: Promise<void> | undefined;
  readonly #deadlineTimer: ReturnType<typeof setTimeout>;
  readonly #request: GpuHostRunRequest;
  readonly #stopCell: GpuHostCell['stop'];
  readonly #deadlineAtMs: number;
  readonly #prepared: GpuPreparedRun;
  readonly #verifiedCellId: string;
  readonly #startedAtMs: number;
  readonly #warmPassedAtMs: number;
  readonly #clock: () => number;
  readonly #stopTimeoutMs: number;
  constructor(prepared: GpuPreparedRun, cell: GpuHostCell,
    request: GpuHostRunRequest, verifiedCellId: string,
    startedAtMs: number, warmPassedAtMs: number,
    clock: () => number, stopTimeoutMs: number) {
    this.#prepared = prepared;
    this.#request = Object.freeze({ ...request });
    this.#stopCell = cell.stop.bind(cell);
    this.#verifiedCellId = verifiedCellId;
    this.#startedAtMs = startedAtMs;
    this.#warmPassedAtMs = warmPassedAtMs;
    this.#clock = clock;
    this.#stopTimeoutMs = stopTimeoutMs;
    this.#deadlineAtMs = startedAtMs + request.maxSeconds * 1000;
    this.#deadlineTimer = setTimeout(() => { void this.#stopInternal().catch(() => undefined); },
      Math.max(0, this.#deadlineAtMs - Date.now()));
    this.#deadlineTimer.unref?.();
    Object.preventExtensions(this);
  }

  get request(): GpuHostRunRequest { return this.#request; }
  get warmPassedAtMs(): number { return this.#warmPassedAtMs; }
  get runId(): string { return this.#request.runId; }
  get cellId(): string { return this.#verifiedCellId; }
  get billableReady(): boolean {
    const now = this.#clock();
    return !this.#stopping && !this.#stopped && this.#prepared.billableReady
      && Number.isSafeInteger(now) && now >= this.#startedAtMs + 20_000
      && now < this.#deadlineAtMs;
  }

  /** A future signed GPU meter must call this for each covered second and
   * additionally validate paired ticks, heartbeat and physical counters. */
  assertBillableSecond(fromMs: number, throughMs: number): void {
    const observedAtMs = this.#clock();
    // The local watchdog may stop at the exact deadline. Conservatively omit
    // that final second until a durable signed GPU meter resolves the order.
    if (this.#stopping || this.#stopped || !this.#prepared.billableReady
      || !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(throughMs)
      || !Number.isSafeInteger(observedAtMs) || throughMs - fromMs !== 1000
      || fromMs < this.#warmPassedAtMs || fromMs < this.#startedAtMs + 20_000
      || throughMs > observedAtMs || throughMs >= this.#deadlineAtMs) throw rejected();
  }

  /** Disable billing immediately, then require confirmed removal before the
   * durable physical UUID claim can be released. Uncertainty is quarantined. */
  stop(): Promise<void> { return this.#stopInternal(); }

  #stopInternal(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#stopFlight) return this.#stopFlight;
    if (this.#stopUncertain) return Promise.reject(rejected());
    this.#stopping = true;
    clearTimeout(this.#deadlineTimer);
    const flight = (async () => {
      try {
        const result = await bounded(signal => this.#stopCell(signal), this.#stopTimeoutMs);
        if (result.cleanupConfirmed !== true) throw rejected();
        await this.#prepared.release({ cleanupConfirmed: true });
        this.#stopped = true;
      } catch { this.#stopUncertain = true; throw rejected(); }
    })();
    this.#stopFlight = flight;
    void flight.finally(() => { if (this.#stopFlight === flight) this.#stopFlight = undefined; }).catch(() => undefined);
    return flight;
  }
}
