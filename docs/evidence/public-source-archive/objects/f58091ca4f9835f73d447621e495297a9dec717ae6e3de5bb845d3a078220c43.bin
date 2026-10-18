import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { localChain } from "../src/chain/chains.js";
import { compileContracts, projectRoot } from "./compile-contracts.js";

export async function unusedLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => server.listen(0, "127.0.0.1", () => resolvePromise()).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate local port");
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

function anvilCommand(): { command: string; prefix: string[] } {
  const executable = process.platform === "win32" ? "anvil.exe" : "anvil";
  const platform = process.platform === "win32" ? "win32-amd64" : process.platform === "darwin"
    ? `darwin-${process.arch === "arm64" ? "arm64" : "amd64"}` : `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  const candidates = [resolve(projectRoot, "node_modules/@foundry-rs/anvil", executable),
    resolve(projectRoot, `node_modules/@foundry-rs/anvil-${platform}/bin`, executable),
    resolve(projectRoot, `node_modules/@foundry-rs/anvil-${platform}`, executable)];
  const binary = candidates.find(path => existsSync(path));
  if (binary) return { command: binary, prefix: [] };
  const launcher = resolve(projectRoot, "node_modules/@foundry-rs/anvil/bin.mjs");
  if (existsSync(launcher)) return { command: process.execPath, prefix: [launcher] };
  throw new Error("Anvil binary is missing; run npm install to install the supported local EVM dependency");
}

export async function startLocalChain(options: { port?: number } = {}) {
  const port = options.port ?? await unusedLocalPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const command = anvilCommand();
  const child = spawn(command.command, [...command.prefix, "--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "31337", "--accounts", "0", "--silent"], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let startupError: Error | undefined;
  let diagnostic = "";
  child.on("error", error => { startupError = error; });
  child.stdout?.on("data", () => { /* Never display account output from the local EVM. */ });
  child.stderr?.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4_000); });
  const client = createPublicClient({ chain: localChain, transport: http(rpcUrl, { timeout: 500, retryCount: 0 }), cacheTime: 0 });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Anvil exited during startup: ${diagnostic}`);
    try {
      if (await client.getChainId() !== 31337) throw new Error("Local EVM chain mismatch");
      return { rpcUrl, port, process: child, publicClient: client, close: () => stopChild(child) };
    } catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 100)); }
  }
  await stopChild(child);
  throw new Error(`Local EVM did not become ready: ${diagnostic}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const timeout = setTimeout(() => resolvePromise(), 3_000);
    child.once("exit", () => { clearTimeout(timeout); resolvePromise(); });
    child.kill();
  });
}
export type LocalChain = Awaited<ReturnType<typeof startLocalChain>>;

export async function deployLocalContracts(local: Pick<LocalChain, "rpcUrl" | "publicClient">) {
  if (new URL(local.rpcUrl).hostname !== "127.0.0.1" || await local.publicClient.getChainId() !== 31337) {
    throw new Error("Local deployment accepts only disposable loopback chain 31337");
  }
  const artifacts = compileContracts();
  const tokenArtifact = artifacts.MockToken;
  const escrowArtifact = artifacts.TelomereRunEscrow;
  if (!tokenArtifact || !escrowArtifact) throw new Error("Compiled artifacts missing");
  const keys = { owner: generatePrivateKey(), signer: generatePrivateKey(), treasury: generatePrivateKey(), outsider: generatePrivateKey() };
  const accounts = { owner: privateKeyToAccount(keys.owner), signer: privateKeyToAccount(keys.signer),
    treasury: privateKeyToAccount(keys.treasury), outsider: privateKeyToAccount(keys.outsider) };
  const transport = http(local.rpcUrl, { retryCount: 0 });
  const testClient = createTestClient({ chain: localChain, mode: "anvil", transport });
  for (const account of Object.values(accounts)) await testClient.setBalance({ address: account.address, value: parseEther("10") });
  const owner = createWalletClient({ chain: localChain, transport, account: accounts.owner });
  async function deployed(hash: `0x${string}`): Promise<Address> {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Local deployment reverted");
    return receipt.contractAddress;
  }
  const tokenAddress = await deployed(await owner.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode }));
  const escrowAddress = await deployed(await owner.deployContract({ abi: escrowArtifact.abi, bytecode: escrowArtifact.bytecode,
    args: [tokenAddress, accounts.signer.address, accounts.signer.address, accounts.treasury.address] }));
  return { chainId: 31337 as const, rpcUrl: local.rpcUrl, tokenAddress, escrowAddress, keys, accounts, artifacts, testClient };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const local = await startLocalChain({ port: Number(process.env.LOCAL_CHAIN_PORT ?? "8547") });
  console.log(JSON.stringify({ chainId: 31337, rpcUrl: local.rpcUrl, ephemeral: true, fundedPresetAccounts: false }));
  const shutdown = () => { void local.close().then(() => process.exit(0)); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
