import { z } from "zod";

export const cpuTaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sha256"), text: z.string().max(8192).refine(value => Buffer.byteLength(value, "utf8") <= 8192) }).strict(),
  z.object({ kind: z.literal("hash_chain"), text: z.string().max(8192).refine(value => Buffer.byteLength(value, "utf8") <= 8192),
    iterations: z.number().int().min(1).max(2_000_000) }).strict(),
  z.object({ kind: z.literal("sort"), numbers: z.array(z.number().int().min(-1_000_000_000).max(1_000_000_000)).max(10_000) }).strict(),
  z.object({ kind: z.literal("primes"), limit: z.number().int().min(2).max(2_000_000) }).strict(),
]);
export const cpuRunInputSchema = z.object({
  runId: z.string().regex(/^(?:0x[a-f0-9]{64}|[a-z0-9][a-z0-9-]{0,63})$/),
  task: cpuTaskSchema,
  maxSeconds: z.number().int().min(1).max(120),
}).strict();
export type CpuTask = z.infer<typeof cpuTaskSchema>;
export type CpuRunInput = z.infer<typeof cpuRunInputSchema>;
export type CpuRunStatus = "completed" | "failed" | "cancelled" | "timed_out";
export type MeterTick = {
  runId: string;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  billableSeconds: number;
  state: "running" | CpuRunStatus;
  previousHash: string | null;
  hash: string;
  outputHash?: string;
};
export type CpuRunResult = {
  output: string;
  billableSeconds: number;
  ticks: MeterTick[];
  exitCode: number;
  status: CpuRunStatus;
};
export type TickHandler = (tick: MeterTick) => void | Promise<void>;
export interface CpuExecutor {
  run(input: CpuRunInput, signal: AbortSignal, onTick?: TickHandler): Promise<CpuRunResult>;
}
