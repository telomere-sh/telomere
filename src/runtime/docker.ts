import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { CommandFailure, executeCommand, type DockerCommand } from "./command.js";
import { RunMeter } from "./meter.js";
import { TASK_PROGRAM } from "./task-program.js";
import { cpuRunInputSchema, type CpuExecutor, type CpuRunInput, type CpuRunResult, type CpuRunStatus, type TickHandler } from "./types.js";

const stateSchema = z.object({ Running: z.boolean(), ExitCode: z.number().int(), StartedAt: z.string(), FinishedAt: z.string() }).passthrough();
type ContainerState = z.infer<typeof stateSchema>;
const containerName = /^telomere-[a-z0-9][a-z0-9-]{0,63}-[a-f0-9]{8}$/;
export type DockerExecutorOptions = { image?: string; dockerBinary?: string; command?: DockerCommand };
export class CpuCleanupError extends Error {
  constructor(readonly container: string) { super("CPU container cleanup could not be confirmed"); this.name = "CpuCleanupError"; }
}

export class DockerCpuExecutor implements CpuExecutor {
  readonly isolation = "docker_restricted" as const;
  private readonly command: DockerCommand;
  private readonly image: string;
  constructor(options: DockerExecutorOptions = {}) {
    this.image = options.image ?? "node:22-alpine";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(this.image)) throw new Error("Invalid operator CPU image");
    const binary = options.dockerBinary ?? "docker";
    this.command = options.command ?? ((args, commandOptions) => executeCommand(binary, args, commandOptions));
  }

  private async inspect(name: string, signal?: AbortSignal): Promise<ContainerState> {
    const result = await this.command(["inspect", "--format", "{{json .State}}", name], { signal: signal ?? AbortSignal.timeout(10_000), maxOutputBytes: 16_384 });
    if (result.exitCode !== 0) throw new Error("CPU container state unavailable");
    return stateSchema.parse(JSON.parse(result.stdout));
  }

  private elapsed(state: ContainerState, maxSeconds: number): number {
    const start = Date.parse(state.StartedAt), finish = state.Running ? Date.now() : Date.parse(state.FinishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || start <= 0 || finish < start) return 0;
    return Math.min(maxSeconds * 1000, finish - start);
  }

  private async remove(name: string, kill: boolean): Promise<void> {
    // Never use the already-aborted task signal for cleanup.
    if (kill) {
      try { await this.command(["kill", name], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 16_384 }); }
      catch { /* rm --force still terminates a container if kill's acknowledgement was lost. */ }
    }
    const removed = await this.command(["rm", "--force", "--volumes", name], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 16_384 }).catch(() => undefined);
    if (!removed || removed.exitCode !== 0) throw new CpuCleanupError(name);
  }

  /** Exclusive startup recovery only. Reconcile the persisted journal before starting new work. */
  async cleanupOrphans(): Promise<string[]> {
    const result = await this.command(["ps", "--all", "--filter", "label=telomere.managed=true", "--filter", "name=^/telomere-", "--format", "{{.Names}}"],
      { signal: AbortSignal.timeout(10_000), maxOutputBytes: 65_536 });
    if (result.exitCode !== 0) throw new Error("CPU recovery inventory unavailable");
    const names = result.stdout.split(/\r?\n/).filter(Boolean);
    if (names.length > 1000 || names.some(name => !containerName.test(name))) throw new Error("CPU recovery inventory rejected");
    for (const name of names) await this.remove(name, true);
    return names;
  }

  async run(rawInput: CpuRunInput, signal: AbortSignal, onTick?: TickHandler): Promise<CpuRunResult> {
    const input = cpuRunInputSchema.parse(rawInput), meter = new RunMeter(input.runId, input.maxSeconds, onTick);
    const name = `telomere-${createHash("sha256").update(input.runId).digest("hex").slice(0, 24)}-${randomBytes(4).toString("hex")}`;
    if (signal.aborted) {
      await meter.emit("cancelled", 0, "");
      return { output: "", billableSeconds: 0, ticks: meter.ticks, exitCode: -1, status: "cancelled" };
    }
    const deadline = new AbortController(), meterFailure = new AbortController();
    const combined = AbortSignal.any([signal, deadline.signal, meterFailure.signal]);
    const timer = setTimeout(() => deadline.abort(), input.maxSeconds * 1000);
    let created = false, createAmbiguous = false, ticker: ReturnType<typeof setInterval> | undefined, pendingTick: Promise<void> = Promise.resolve();
    let output = "", exitCode = -1, status: CpuRunStatus = "failed", elapsed = 0;
    try {
      const creation = await this.command(["create", "--name", name, "--label", "telomere.managed=true", "--label", `telomere.run_id=${input.runId}`,
        "--interactive", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--user", "10001:10001", "--cpus", "1", "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "64",
        "--entrypoint", "node", this.image, "-e", TASK_PROGRAM], {
          // Wait for create's acknowledgement even if the owner cancels. Killing its
          // CLI early can leave a daemon-created container that we never learned about.
          signal: AbortSignal.timeout(10_000), maxOutputBytes: 16_384,
        }).catch(error => { createAmbiguous = !(error instanceof CommandFailure && error.reason === "spawn"); throw error; });
      if (creation.exitCode !== 0) throw new Error("CPU container creation failed");
      created = true;
      if (!/^[a-f0-9]{12,64}\s*$/.test(creation.stdout)) throw new Error("CPU container identity rejected");
      if (combined.aborted) throw new CommandFailure("aborted");
      const sample = async () => {
        const state = await this.inspect(name, combined);
        if (state.Running) { elapsed = Math.max(elapsed, this.elapsed(state, input.maxSeconds)); await meter.emit("running", elapsed); }
      };
      // start attaches stdin/output; a final inspect captures even sub-second tasks.
      const attached = this.command(["start", "--attach", "--interactive", name], { stdin: JSON.stringify(input.task), signal: combined, maxOutputBytes: 16_384 });
      // Attach a handler immediately so a failed start never becomes an unhandled rejection.
      const observed = attached.then(value => ({ value }), () => ({ value: undefined }));
      pendingTick = sample().catch(() => { if (!combined.aborted) meterFailure.abort(); });
      ticker = setInterval(() => {
        pendingTick = pendingTick.then(sample).catch(() => { if (!combined.aborted) meterFailure.abort(); });
      }, 5000);
      const result = (await observed).value;
      clearInterval(ticker); ticker = undefined;
      await pendingTick;
      if (result) { output = result.stdout; exitCode = result.exitCode; }
      status = combined.aborted ? signal.aborted ? "cancelled" : deadline.signal.aborted ? "timed_out" : "failed"
        : result && result.exitCode === 0 ? "completed" : "failed";
      // Cancellation may leave attach terminated while the container is still alive.
      if (combined.aborted) { try { await this.command(["kill", name], { signal: AbortSignal.timeout(10_000), maxOutputBytes: 16_384 }); } catch { /* force removal follows */ } }
      const finalState = await this.inspect(name).catch(() => undefined);
      if (finalState) {
        elapsed = Math.max(elapsed, this.elapsed(finalState, input.maxSeconds));
        exitCode = finalState.ExitCode;
        if (!combined.aborted && (finalState.Running || finalState.ExitCode !== 0)) status = "failed";
      } else status = combined.aborted ? status : "failed";
    } catch { status = combined.aborted ? signal.aborted ? "cancelled" : deadline.signal.aborted ? "timed_out" : "failed" : "failed"; }
    finally {
      if (ticker) clearInterval(ticker);
      clearTimeout(timer);
      if (created || createAmbiguous) await this.remove(name, status !== "completed");
    }
    await meter.emit(status, elapsed, output); await meter.flush();
    return { output, billableSeconds: meter.ticks.at(-1)?.billableSeconds ?? 0, ticks: meter.ticks, exitCode, status };
  }
}
export function createDockerCpuExecutor(options: DockerExecutorOptions = {}): DockerCpuExecutor { return new DockerCpuExecutor(options); }
