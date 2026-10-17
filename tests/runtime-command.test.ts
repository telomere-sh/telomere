import { describe, expect, it } from "vitest";
import { executeCommand } from "../src/runtime/command.js";

describe("local command boundary", () => {
  it("terminates a process when combined output exceeds 16 KiB", async () => {
    await expect(executeCommand(process.execPath, ["-e", "process.stdout.write('a'.repeat(16385))"], { maxOutputBytes: 16_384 }))
      .rejects.toMatchObject({ reason: "output_limit" });
  });

  it("kills a running local process on cancellation", async () => {
    await expect(executeCommand(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { signal: AbortSignal.timeout(25) }))
      .rejects.toMatchObject({ reason: "aborted" });
  });

  it("reports a missing executable without exposing child input", async () => {
    const operation = executeCommand("telomere-nonexistent-binary-128374", [], { stdin: "private-data-canary" });
    await expect(operation).rejects.toMatchObject({ reason: "spawn" });
    await expect(operation).rejects.not.toThrow("private-data-canary");
  });
});
