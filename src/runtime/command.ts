import { spawn } from "node:child_process";

export type CommandResult = { stdout: string; stderr: string; exitCode: number };
export type CommandOptions = { stdin?: string; signal?: AbortSignal; maxOutputBytes?: number; env?: NodeJS.ProcessEnv };
export type DockerCommand = (args: readonly string[], options: CommandOptions) => Promise<CommandResult>;
export class CommandFailure extends Error {
  constructor(readonly reason: "spawn" | "aborted" | "output_limit") {
    super(`Runtime command failed: ${reason}`);
    this.name = "CommandFailure";
  }
}

/** No shell; child output and input are bounded; abort terminates the local CLI/process. */
export function executeCommand(binary: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.reject(new CommandFailure("aborted"));
  return new Promise((resolve, reject) => {
    const maximum = options.maxOutputBytes ?? 16_384;
    const child = spawn(binary, [...args], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }) });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, failure: CommandFailure | undefined;
    const stop = (reason: CommandFailure["reason"]) => {
      failure ??= new CommandFailure(reason);
      child.kill("SIGKILL");
    };
    const aborted = () => stop("aborted");
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) { stop("output_limit"); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => { /* A finished/aborted process may close stdin first. */ });
    child.once("error", () => { failure ??= new CommandFailure("spawn"); });
    child.once("close", code => {
      options.signal?.removeEventListener("abort", aborted);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? -1 });
    });
    child.stdin.end(options.stdin ?? "");
  });
}
