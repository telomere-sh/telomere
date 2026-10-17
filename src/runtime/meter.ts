import { createHash } from "node:crypto";
import type { CpuRunStatus, MeterTick, TickHandler } from "./types.js";

export function outputHash(output: string): string { return createHash("sha256").update(output).digest("hex"); }

/** Software host observations; hashes establish a chain of records, not proof of compute. */
export class RunMeter {
  readonly ticks: MeterTick[] = [];
  private deliveries: Promise<void> = Promise.resolve();
  private deliveryFailure: unknown;
  constructor(private readonly runId: string, private readonly maxSeconds: number, private readonly onTick?: TickHandler) {}

  emit(state: "running" | CpuRunStatus, elapsedMs: number, output?: string): Promise<void> {
    const delivery = this.deliveries.then(async () => {
      if (this.deliveryFailure !== undefined) throw new Error("Meter tick persistence failed");
      const safeElapsed = Math.max(this.ticks.at(-1)?.elapsedMs ?? 0, Math.min(this.maxSeconds * 1000, Math.max(0, Math.floor(elapsedMs))));
      const record = { runId: this.runId, sequence: this.ticks.length, timestamp: new Date().toISOString(), elapsedMs: safeElapsed,
        billableSeconds: Math.floor(safeElapsed / 1000), state, previousHash: this.ticks.at(-1)?.hash ?? null,
        ...(output === undefined ? {} : { outputHash: outputHash(output) }) };
      const tick: MeterTick = { ...record, hash: outputHash(JSON.stringify(record)) };
      await this.onTick?.(tick);
      // Only persisted ticks can contribute to the confirmed result.
      this.ticks.push(tick);
    });
    this.deliveries = delivery.catch(error => { this.deliveryFailure ??= error; });
    return delivery;
  }

  async flush(): Promise<void> {
    await this.deliveries;
    if (this.deliveryFailure !== undefined) throw new Error("Meter tick persistence failed");
  }
}
