import { gpuProbeBindingSchema, gpuClassPolicySchema, newGpuChallenge, checkGpuProbe,
  checkGpuSnapshot, type GpuClassPolicy, type GpuProbeBinding, type GpuProbeDriver, type GpuProbeReport,
  type GpuChallenge } from './probes.js';
import { readGpuInventory, gpuUuidSchema, type GpuSnapshot } from './inventory.js';
import { reserveGpuSlot, type GpuSlotLease } from './slot.js';

type Inventory = typeof readGpuInventory;
const rejected = () => new Error('GPU admission rejected or quarantined');
const occupied = (active: ReadonlySet<string>, uuid: string): boolean =>
  [...active].some(value => gpuUuidSchema.parse(value) === uuid);

export type GpuAdmissionEvidence = { uuid: string; runId: string; classId: string; before: GpuSnapshot; after: GpuSnapshot;
  classProbe: { report: GpuProbeReport; evidenceHash: string };
  memoryProbe: { report: GpuProbeReport; evidenceHash: string } };

/** A trusted handle to the actual workload Cell. The warm kernel must run in
 * this handle; an admission-probe driver cannot create a second Cell for it. */
export interface GpuWarmCell {
  readonly runId: string;
  readonly uuid: string;
  readonly isolation: GpuProbeBinding['isolation'];
  runWarmProbe(challenge: GpuChallenge, signal: AbortSignal): Promise<{ report: unknown; probeExited: boolean }>;
}

/** This is the HostKit integration seam. The caller must hold the returned
 * lease through workload cleanup and call warmCheck before user billing. */
export class GpuAdmissionController {
  readonly #policy: GpuClassPolicy;
  readonly #probeBinding: GpuProbeBinding;
  readonly #driver: GpuProbeDriver;
  readonly #runProbeCell: GpuProbeDriver['run'];
  readonly #directory: string;
  readonly #inventory: Inventory;
  get policy(): GpuClassPolicy { return this.#policy; }
  get probeBinding(): GpuProbeBinding { return this.#probeBinding; }
  constructor(options: { directory: string; policy: unknown; driver: GpuProbeDriver; inventory?: Inventory }) {
    const policy = gpuClassPolicySchema.parse(options.policy);
    this.#policy = Object.freeze({ ...policy, gemmTflops: Object.freeze({ ...policy.gemmTflops }),
      bandwidthGiBs: Object.freeze({ ...policy.bandwidthGiBs }) });
    this.#driver = options.driver;
    this.#runProbeCell = options.driver.run.bind(options.driver);
    this.#directory = options.directory;
    this.#inventory = options.inventory ?? readGpuInventory;
    const binding = gpuProbeBindingSchema.parse(options.driver.binding);
    if (binding.imageDigest !== this.#policy.probeImageDigest) throw rejected();
    this.#probeBinding = Object.freeze({ ...binding });
    Object.preventExtensions(this);
  }

  async #runProbe(kind: 'class' | 'memory', uuid: string, runId: string, onUncertain: () => void): Promise<{
    report: GpuProbeReport; evidenceHash: string;
  }> {
    const memory = kind === 'memory' ? this.#policy.memoryChallengeMiB : 0;
    const challenge = newGpuChallenge(kind, uuid, runId, memory);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(rejected()); }, challenge.deadlineAtMs - challenge.issuedAtMs);
      });
      onUncertain();
      const result = await Promise.race([Promise.resolve().then(() => this.#runProbeCell(challenge, controller.signal)), timeout]);
      if (result.cleanupConfirmed !== true) throw rejected();
      // A returned report is usable only after the adapter certifies that its
      // probe cell has stopped. Admission checks then re-read the GPU inventory.
      return checkGpuProbe(result.report, challenge, this.#policy);
    } finally { clearTimeout(timer); }
  }

  async prepare(uuidRaw: string, runId: string): Promise<GpuPreparedRun> {
    const uuid = gpuUuidSchema.parse(uuidRaw), binding = gpuProbeBindingSchema.parse(this.#driver.binding);
    if (binding.uuid !== uuid || binding.imageDigest !== this.#policy.probeImageDigest
      || binding.uuid !== this.#probeBinding.uuid || binding.imageDigest !== this.#probeBinding.imageDigest
      || binding.isolation !== this.#probeBinding.isolation) throw rejected();
    const slot = await reserveGpuSlot({ directory: this.#directory, uuid, runId });
    let cleanupKnown = true;
    try {
      const beforeInventory = await this.#inventory({});
      if (occupied(beforeInventory.activeComputeUuids, uuid)) throw rejected();
      const before = checkGpuSnapshot(beforeInventory.devices.find(device => device.uuid === uuid), this.#policy, uuid);
      const classProbe = await this.#runProbe('class', uuid, runId, () => { cleanupKnown = false; });
      cleanupKnown = true;
      const memoryProbe = await this.#runProbe('memory', uuid, runId, () => { cleanupKnown = false; });
      cleanupKnown = true;
      const afterInventory = await this.#inventory({});
      if (occupied(afterInventory.activeComputeUuids, uuid)) throw rejected();
      const after = checkGpuSnapshot(afterInventory.devices.find(device => device.uuid === uuid), this.#policy, uuid);
      if (after.driverMajor !== before.driverMajor || after.totalMemoryMiB !== before.totalMemoryMiB
        || after.defaultPowerLimitWatts !== before.defaultPowerLimitWatts) throw rejected();
      return new GpuPreparedRun(slot, this.#policy, binding,
        { uuid, runId, classId: this.#policy.classId, before, after, classProbe, memoryProbe });
    } catch {
      if (cleanupKnown) await slot.release({ cleanupConfirmed: true });
      // An uncertain probe cleanup leaves the atomic claim on disk. The
      // operator must inspect the GPU and reconcile it before another run.
      throw rejected();
    }
  }
}

export class GpuPreparedRun {
  #warmState: 'pending' | 'running' | 'passed' | 'quarantined' = 'pending';
  #probeCleanupUncertain = false;
  #released = false;
  readonly #expectedRunId: string;
  readonly #expectedUuid: string;
  readonly #slot: GpuSlotLease;
  readonly #policy: GpuClassPolicy;
  readonly #binding: GpuProbeBinding;
  readonly #evidence: GpuAdmissionEvidence;
  get evidence(): GpuAdmissionEvidence { return this.#evidence; }
  constructor(slot: GpuSlotLease, policy: GpuClassPolicy,
    binding: GpuProbeBinding, evidence: GpuAdmissionEvidence) {
    this.#slot = slot;
    this.#policy = policy;
    this.#binding = binding;
    this.#expectedRunId = evidence.runId;
    this.#expectedUuid = evidence.uuid;
    this.#evidence = Object.freeze({ ...evidence,
      before: Object.freeze({ ...evidence.before }), after: Object.freeze({ ...evidence.after }),
      classProbe: Object.freeze({ ...evidence.classProbe, report: Object.freeze({ ...evidence.classProbe.report }) }),
      memoryProbe: Object.freeze({ ...evidence.memoryProbe, report: Object.freeze({ ...evidence.memoryProbe.report }) }),
    });
    Object.preventExtensions(this);
  }

  get billableReady(): boolean { return !this.#released && this.#warmState === 'passed'; }

  /** The trusted runtime passes its own run-start time; the first 20 seconds
   * are platform-funded. A failed warm check must fault/rehome the job. */
  async warmCheck(runStartedAtMs: number, cell: GpuWarmCell): Promise<{ report: GpuProbeReport; evidenceHash: string }> {
    if (this.#released || this.#warmState !== 'pending' || !Number.isSafeInteger(runStartedAtMs)
      || runStartedAtMs > Date.now() || Date.now() >= runStartedAtMs + 20_000
      || cell?.runId !== this.#expectedRunId || cell.uuid !== this.#expectedUuid
      || cell.isolation !== this.#binding.isolation || typeof cell.runWarmProbe !== 'function') throw rejected();
    this.#warmState = 'running';
    const challenge = newGpuChallenge('warm', this.#expectedUuid, this.#expectedRunId, 0);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = Math.min(challenge.deadlineAtMs, runStartedAtMs + 20_000) - Date.now();
      if (timeoutMs <= 0) throw rejected();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(rejected()); }, timeoutMs);
      });
      this.#probeCleanupUncertain = true;
      const result = await Promise.race([Promise.resolve().then(() => cell.runWarmProbe(challenge, controller.signal)), timeout]);
      if (result.probeExited !== true) throw rejected();
      this.#probeCleanupUncertain = false;
      const checked = checkGpuProbe(result.report, challenge, this.#policy);
      if (checked.report.finishedAtMs > runStartedAtMs + 20_000 || Date.now() >= runStartedAtMs + 20_000) throw rejected();
      this.#warmState = 'passed'; return checked;
    } catch { this.#warmState = 'quarantined'; throw rejected(); }
    finally { clearTimeout(timer); }
  }

  /** The runtime must stop and inspect its isolated cell before releasing. */
  async release(cleanup: { cleanupConfirmed: true }): Promise<void> {
    // A failed warm kernel is a host-quality fault. Until the on-chain strike
    // path exists, preserve the durable UUID claim for operator review even
    // when the workload Cell itself was removed cleanly.
    if (this.#released || this.#warmState === 'running' || this.#warmState === 'quarantined'
      || this.#probeCleanupUncertain || cleanup?.cleanupConfirmed !== true) throw rejected();
    await this.#slot.release(cleanup);
    this.#released = true;
  }
}
