import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoCpuExecutor, createDockerCpuExecutor, cpuRunInputSchema, type CommandResult, type DockerCommand, type MeterTick } from "../src/runtime/index.js";

const input = { runId: "run-1", task: { kind: "sort" as const, numbers: [3, 1, 2] }, maxSeconds: 10 };
const ok = (stdout = "", exitCode = 0): CommandResult => ({ stdout, stderr: "", exitCode });
const state = (running: boolean, exitCode = 0, milliseconds = 2500) => JSON.stringify({ Running: running, ExitCode: exitCode,
  StartedAt: "2030-01-01T00:00:00.000Z", FinishedAt: new Date(Date.parse("2030-01-01T00:00:00.000Z") + milliseconds).toISOString() });
afterEach(() => { vi.useRealTimers(); });

describe("allowlisted CPU tasks", () => {
  it("executes actual fixed programs locally with deterministic bounded results", async () => {
    const executor = createDemoCpuExecutor(), signal = new AbortController().signal;
    expect(executor.isolation).toBe("local_demo_not_sandbox");
    const sorted = await executor.run(input, signal);
    expect(sorted.status).toBe("completed");
    expect(JSON.parse(sorted.output)).toEqual({ numbers: [1, 2, 3] });
    const hashed = await executor.run({ ...input, task: { kind: "sha256", text: "hello" } }, signal);
    expect(JSON.parse(hashed.output)).toEqual({ sha256: createHash("sha256").update("hello").digest("hex") });
    const primes = await executor.run({ ...input, task: { kind: "primes", limit: 2_000_000 } }, signal);
    const summary: unknown = JSON.parse(primes.output);
    expect(summary).toMatchObject({ count: 148_933, limit: 2_000_000, first: [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71] });
    expect(Buffer.byteLength(primes.output)).toBeLessThanOrEqual(16_384);
    expect(hashed.ticks.at(-1)?.outputHash).toBe(createHash("sha256").update(hashed.output).digest("hex"));
  });

  it("rejects arbitrary commands, malformed data and all operator caps before dispatch", async () => {
    const command = vi.fn<DockerCommand>();
    const executor = createDockerCpuExecutor({ command });
    const rejected = [
      { ...input, maxSeconds: 121 }, { ...input, runId: "../../escape" },
      { ...input, task: { kind: "shell", command: "whoami" } },
      { ...input, task: { kind: "sha256", text: "😀".repeat(3000) } },
      { ...input, task: { kind: "sort", numbers: Array.from({ length: 10_001 }, () => 1) } },
      { ...input, task: { kind: "primes", limit: 2_000_001 } },
      { ...input, task: { kind: "hash_chain", text: "hello", iterations: 0 } },
      { ...input, task: { kind: "hash_chain", text: "hello", iterations: 2_000_001 } },
      { ...input, task: { kind: "hash_chain", text: "hello", iterations: 1.5 } },
      { ...input, task: { kind: "hash_chain", text: "😀".repeat(3000), iterations: 1 } },
    ];
    for (const candidate of rejected) {
      expect(cpuRunInputSchema.safeParse(candidate).success).toBe(false);
    }
    await expect(executor.run({ ...input, maxSeconds: 121 }, new AbortController().signal)).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
  });

  it("executes the known SHA-256 digest chain without artificial delays", async () => {
    const executor = createDemoCpuExecutor(), signal = new AbortController().signal;
    const first = await executor.run({ ...input, task: { kind: "hash_chain", text: "hello", iterations: 1 } }, signal);
    expect(first.status).toBe("completed");
    expect(JSON.parse(first.output)).toEqual({ hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", iterations: 1 });
    const third = await executor.run({ ...input, task: { kind: "hash_chain", text: "hello", iterations: 3 } }, signal);
    expect(third.status).toBe("completed");
    expect(JSON.parse(third.output)).toEqual({ hash: "6c92efed736019d91804be8749edd36be572a345bd51c80f1ac4ea0d932c0dc7", iterations: 3 });
    expect(cpuRunInputSchema.safeParse({ ...input, task: { kind: "hash_chain", text: "a".repeat(8192), iterations: 2_000_000 } }).success).toBe(true);
  });

  it("pre-aborted work has no dispatch or billable seconds", async () => {
    const command = vi.fn<DockerCommand>(), controller = new AbortController(); controller.abort();
    const result = await createDockerCpuExecutor({ command }).run(input, controller.signal);
    expect(result).toMatchObject({ status: "cancelled", billableSeconds: 0, exitCode: -1 });
    expect(command).not.toHaveBeenCalled();
  });
});

describe("Docker runtime lifecycle and meter", () => {
  it("creates an isolated cell, meters every five seconds and hashes the final output", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const mutableCalls: string[][] = [], persisted: MeterTick[] = [];
    let running = true;
    const command: DockerCommand = async (args, options) => {
      mutableCalls.push([...args]);
      if (args[0] === "create") return ok("a".repeat(64));
      if (args[0] === "start") {
        expect(options.stdin).toBe(JSON.stringify(input.task));
        return await new Promise(resolve => setTimeout(() => { running = false; resolve(ok('{"numbers":[1,2,3]}')); }, 6200));
      }
      if (args[0] === "inspect") return ok(state(running, 0, 6200));
      return ok();
    };
    const operation = createDockerCpuExecutor({ command }).run(input, new AbortController().signal, async tick => { persisted.push(tick); });
    await vi.advanceTimersByTimeAsync(6200);
    const result = await operation;
    expect(result).toMatchObject({ status: "completed", billableSeconds: 6, exitCode: 0 });
    expect(result.ticks.map(tick => tick.elapsedMs)).toEqual([0, 5000, 6200]);
    expect(persisted).toEqual(result.ticks);
    for (const [index, tick] of result.ticks.entries()) {
      const { hash, ...record } = tick;
      expect(hash).toBe(createHash("sha256").update(JSON.stringify(record)).digest("hex"));
      expect(tick.previousHash).toBe(index === 0 ? null : result.ticks[index - 1]?.hash);
    }
    const creation = mutableCalls.find(args => args[0] === "create");
    expect(creation).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--user", "10001:10001", "--cpus", "1", "--memory", "256m", "--pids-limit", "64"]));
    expect(creation).not.toContain("--privileged");
    expect(creation).not.toContain("/var/run/docker.sock");
    expect(mutableCalls.at(-1)?.slice(0, 3)).toEqual(["rm", "--force", "--volumes"]);
  });

  it("kills and removes a cancelled container, including a lost attach outcome", async () => {
    const calls: string[][] = [], controller = new AbortController();
    let killed = false;
    const command: DockerCommand = async (args, options) => {
      calls.push([...args]);
      if (args[0] === "create") return ok("a".repeat(64));
      if (args[0] === "start") return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("attach aborted")), { once: true });
        setTimeout(() => controller.abort(), 5);
      });
      if (args[0] === "kill") killed = true;
      if (args[0] === "inspect") return ok(state(!killed, killed ? 137 : 0));
      return ok();
    };
    const result = await createDockerCpuExecutor({ command }).run(input, controller.signal);
    expect(result).toMatchObject({ status: "cancelled", exitCode: 137 });
    expect(calls.some(args => args[0] === "kill")).toBe(true);
    expect(calls.at(-1)?.[0]).toBe("rm");
  });

  it("enforces the deadline and cleans up without retrying execution", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    let starts = 0;
    const command: DockerCommand = async (args, options) => {
      if (args[0] === "create") return ok("a".repeat(64));
      if (args[0] === "start") { starts++; return await new Promise((_resolve, reject) => { options.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true }); }); }
      if (args[0] === "inspect") return ok(state(false, 137, 1000));
      return ok();
    };
    const operation = createDockerCpuExecutor({ command }).run({ ...input, maxSeconds: 1 }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await operation).toMatchObject({ status: "timed_out", billableSeconds: 1 });
    expect(starts).toBe(1);
  });

  it("reports a container failure and refuses to hide a failed tick write", async () => {
    let removed = false;
    const command: DockerCommand = async args => {
      if (args[0] === "create") return ok("a".repeat(64));
      if (args[0] === "start") return ok("", 2);
      if (args[0] === "inspect") return ok(state(false, 2, 100));
      if (args[0] === "rm") removed = true;
      return ok();
    };
    const executor = createDockerCpuExecutor({ command });
    expect(await executor.run(input, new AbortController().signal)).toMatchObject({ status: "failed", billableSeconds: 0, exitCode: 2 });
    removed = false;
    await expect(executor.run(input, new AbortController().signal, async () => { throw new Error("database write failure"); })).rejects.toThrow("database write failure");
    expect(removed).toBe(true);
  });

  it("waits for a cancelled create acknowledgement and never starts the cell", async () => {
    const controller = new AbortController(), calls: string[][] = [];
    const command: DockerCommand = async args => {
      calls.push([...args]);
      if (args[0] === "create") { controller.abort(); return ok("a".repeat(64)); }
      return ok();
    };
    expect(await createDockerCpuExecutor({ command }).run({ ...input, runId: `0x${"a".repeat(64)}` }, controller.signal))
      .toMatchObject({ status: "cancelled", billableSeconds: 0 });
    expect(calls.some(args => args[0] === "start")).toBe(false);
    expect(calls.at(-1)?.[0]).toBe("rm");
    expect(calls[0]?.[2]?.length).toBeLessThan(64);
  });

  it("attempts cleanup after a lost create acknowledgement and surfaces failed removal", async () => {
    const calls: string[][] = [];
    const command: DockerCommand = async args => {
      calls.push([...args]);
      if (args[0] === "create") throw new Error("lost acknowledgement");
      if (args[0] === "rm") return ok("", 1);
      return ok();
    };
    await expect(createDockerCpuExecutor({ command }).run(input, new AbortController().signal)).rejects.toThrow("cleanup could not be confirmed");
    expect(calls.some(args => args[0] === "start")).toBe(false);
    expect(calls.at(-1)?.[0]).toBe("rm");
  });

  it("cleans only labelled, validated orphan names during exclusive recovery", async () => {
    const removed: string[] = [];
    const name = "telomere-run-1-aabbccdd";
    const command: DockerCommand = async args => {
      if (args[0] === "ps") { expect(args).toContain("label=telomere.managed=true"); return ok(`${name}\n`); }
      if (args[0] === "rm") removed.push(args.at(-1) ?? "");
      return ok();
    };
    expect(await createDockerCpuExecutor({ command }).cleanupOrphans()).toEqual([name]);
    expect(removed).toEqual([name]);
    await expect(createDockerCpuExecutor({ command: async () => ok("unrelated-production-container") }).cleanupOrphans()).rejects.toThrow("inventory rejected");
  });
});
