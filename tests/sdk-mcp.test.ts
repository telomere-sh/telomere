import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { escrowAbi } from "../src/chain/abi.js";

const runId = keccak256(toHex("mcp-smoke")); const secret = "e".repeat(64);
const escrow = "0x1111111111111111111111111111111111111111";
describe("official MCP stdio integration", () => {
  let api: Server; let client: Client; const paths: string[] = []; let origin: string;
  beforeAll(async () => {
    api = createServer((request, response) => {
      const path = request.url ?? ""; paths.push(path); response.setHeader("Content-Type", "application/json");
      if (path === "/api/config") { response.end(JSON.stringify({ mode: "demo", chain: { id: 31337, name: "Local", rpcUrl: "http://127.0.0.1:8545" },
        token: { address: "0x2222222222222222222222222222222222222222", symbol: "TEST", decimals: 6 }, escrowAddress: escrow,
        receiptSigner: "0x3333333333333333333333333333333333333333", prices: { cpuPerSecond: "1000", inferenceFixed: "50000", maxSeconds: 120, maxTokens: 128 }, workload: { nearModel: null }, nearAvailable: false, cpuMode: "demo" })); return; }
      if (path === `/api/runs/${runId}/stop`) {
        if (request.headers.origin !== origin || request.headers.cookie !== `telomere_session=${secret}`) { response.statusCode = 403; response.end(JSON.stringify({ title: "origin_mismatch" })); return; }
        response.end(JSON.stringify({ transaction: { to: escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "requestStop", args: [runId] }), value: "0x0" } })); return;
      }
      response.statusCode = 401; response.end(JSON.stringify({ title: "session_expired", detail: `Secret must not be echoed: ${secret}` }));
    });
    await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve)); const address = api.address();
    if (!address || typeof address === "string") throw new Error("Missing local API address");
    origin = `http://127.0.0.1:${address.port}`;
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "scripts/mcp.ts"], cwd: resolve("."),
      env: { ...getDefaultEnvironment(), TELOMERE_API_URL: origin, TELOMERE_SESSION_TOKEN: secret }, stderr: "pipe" });
    client = new Client({ name: "telomere-smoke-client", version: "0.1.0" }); await client.connect(transport);
  }, 30000);
  afterAll(async () => {
    await client?.close(); api?.closeAllConnections();
    if (api) await new Promise<void>(resolve => api.close(() => resolve()));
  });
  it("negotiates the actual stdio protocol and exposes tools without a wallet broadcaster", async () => {
    const list = await client.listTools(); expect(list.tools.length).toBeGreaterThan(10);
    expect(list.tools.map(tool => tool.name)).toContain("telomere_quote");
    expect(list.tools.some(tool => /sign|broadcast|execute_plan|demo_fund/.test(tool.name))).toBe(false);
    const config = await client.callTool({ name: "telomere_config", arguments: {} });
    expect(JSON.stringify(config)).toContain("31337"); expect(JSON.stringify(config)).not.toContain(secret);
    const catalog = await client.callTool({ name: "telomere_cpu_tasks", arguments: {} });
    expect(JSON.stringify(catalog)).toContain("hash_chain");
  });
  it("sanitizes expired auth responses and returns stop intents without sending transactions", async () => {
    const unauthenticated = await client.callTool({ name: "telomere_session_status", arguments: {} });
    expect(unauthenticated.isError).toBe(true); expect(JSON.stringify(unauthenticated)).toContain("wallet_auth_required");
    expect(JSON.stringify(unauthenticated)).not.toContain(secret);
    const pending = await client.callTool({ name: "telomere_stop_plan", arguments: { runId } });
    expect(pending.isError).not.toBe(true); expect(JSON.stringify(pending)).toContain('"requiresWallet":true');
    expect(JSON.stringify(pending)).toContain(encodeFunctionData({ abi: escrowAbi, functionName: "requestStop", args: [runId] }));
    expect(paths.some(path => /demo\/transaction|demo\/fund|auth\/demo/.test(path))).toBe(false);
  });
});
