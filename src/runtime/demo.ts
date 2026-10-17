import { performance } from "node:perf_hooks";
import { executeCommand, type CommandResult, type CommandOptions } from "./command.js";
import { RunMeter } from "./meter.js";
import { TASK_PROGRAM } from "./task-program.js";
import { cpuRunInputSchema, type CpuExecutor, type CpuRunInput, type CpuRunResult, type CpuRunStatus, type TickHandler } from "./types.js";

export type DemoExecutorOptions = {
  /** Dependency injection for offline fault tests. This executor is NOT a sandbox. */
  command?: (args: readonly string[], options: CommandOptions) => Promise<CommandResult>;
};
export class DemoCpuExecutor implements CpuExecutor {
  readonly isolation = "local_demo_not_sandbox" as const;
  constructor(private readonly options: DemoExecutorOptions = {}) {}

  async run(rawInput: CpuRunInput, signal: AbortSignal, onTick?: TickHandler): Promise<CpuRunResult> {
    const input = cpuRunInputSchema.parse(rawInput), meter = new RunMeter(input.runId, input.maxSeconds, onTick);
    if (signal.aborted) {
      await meter.emit("cancelled", 0, ""); await meter.flush();
      return { output: "", billableSeconds: 0, ticks: meter.ticks, exitCode: -1, status: "cancelled" };
    }
    await meter.emit("running", 0);
    const deadline = new AbortController(), meterFailure = new AbortController(), combined = AbortSignal.any([signal, deadline.signal, meterFailure.signal]);
    const timeout = setTimeout(() => deadline.abort(), input.maxSeconds * 1000);
    const started = performance.now();
    const ticker = setInterval(() => { void meter.emit("running", performance.now() - started).catch(() => meterFailure.abort()); }, 5000);
    let status: CpuRunStatus = "failed", output = "", exitCode = -1;
    try {
      const command = this.options.command ?? ((args: readonly string[], options: CommandOptions) => executeCommand(process.execPath, args, options));
      const result = await command(["-e", TASK_PROGRAM], { stdin: JSON.stringify(input.task), signal: combined, maxOutputBytes: 16_384,
        // Never pass provider credentials or other operator environment into a task.
        env: process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot } });
      output = result.stdout; exitCode = result.exitCode;
      status = combined.aborted ? signal.aborted ? "cancelled" : deadline.signal.aborted ? "timed_out" : "failed" : result.exitCode === 0 ? "completed" : "failed";
    } catch { status = combined.aborted ? signal.aborted ? "cancelled" : deadline.signal.aborted ? "timed_out" : "failed" : "failed"; }
    finally { clearInterval(ticker); clearTimeout(timeout); }
    await meter.emit(status, performance.now() - started, output); await meter.flush();
    return { output, billableSeconds: meter.ticks.at(-1)?.billableSeconds ?? 0, ticks: meter.ticks, exitCode, status };
  }
}
export function createDemoCpuExecutor(options: DemoExecutorOptions = {}): DemoCpuExecutor { return new DemoCpuExecutor(options); }
