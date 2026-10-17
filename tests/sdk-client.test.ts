import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, getAddress, keccak256, toHex, verifyMessage, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TelomereClient, WalletActionUncertainError, type FetchTransport, type OwnerWallet } from "../src/sdk/index.js";
import { escrowAbi, tokenAbi } from "../src/chain/abi.js";
import { quoteTypedData } from "../src/chain/typed-data.js";
import { hashJson } from "../src/common.js";

const owner = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const escrow = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const attacker = getAddress("0x3333333333333333333333333333333333333333");
const runId = keccak256(toHex("sdk-run")); const leashId = keccak256(toHex("sdk-leash"));
const txHash = keccak256(toHex("wallet-tx")); const session = "c".repeat(64);
const config = { mode: "demo", chain: { id: 31337, name: "Local", rpcUrl: "http://127.0.0.1:8545" },
  token: { address: token, symbol: "TEST", decimals: 6 }, escrowAddress: escrow, receiptSigner: signer.address,
  prices: { cpuPerSecond: "1000", inferenceFixed: "50000", maxSeconds: 120, maxTokens: 128 }, workload: { nearModel: null }, nearAvailable: false, cpuMode: "demo" };
const pins = { chainId: 31337 as const, escrowAddress: escrow, tokenAddress: token, receiptSigner: signer.address };
const input = { leashId, task: { kind: "sha256" as const, text: "hello" }, maxSeconds: 5 };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json", ...headers } });
type Request = { path: string; init: RequestInit };
function fixture(handler?: (request: Request) => Promise<Response | undefined> | Response | undefined) {
  const requests: Request[] = [];
  const fetcher: FetchTransport = async (url, init) => {
    const parsed = new URL(url); const request = { path: parsed.pathname + parsed.search, init }; requests.push(request);
    const custom = await handler?.(request); if (custom) return custom;
    if (request.path === "/api/config") return json(config);
    if (request.path === "/api/me") return json({ address: owner.address, demo: false });
    if (request.path.startsWith("/api/transactions/deposit")) return json({ transactions: [
      { to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [escrow, 1000000n] }), value: "0x0" },
      { to: escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "deposit", args: [1000000n] }), value: "0x0" }] });
    if (request.path === "/api/quotes") {
      const q = { runId, leashId, payer: owner.address, workloadHash: hashJson({ input: JSON.parse(String(request.init.body)), maxTokens: 128, model: null }), maxSeconds: 5,
        pricePerSecond: "1000", inferencePrice: "0", quoteExpiry: Math.floor(Date.now() / 1000) + 120 };
      const typed = { ...q, maxSeconds: 5n, pricePerSecond: 1000n, inferencePrice: 0n, quoteExpiry: BigInt(q.quoteExpiry) };
      const signature = await signer.signTypedData(quoteTypedData(31337, escrow, typed));
      return json({ quote: q, signature, ceiling: "5000", transaction: { to: escrow,
        data: encodeFunctionData({ abi: escrowAbi, functionName: "openRun", args: [typed, signature] }), value: "0x0" } }, 201);
    }
    if (request.path === `/api/runs/${runId}`) return json({ id: runId, owner: owner.address, status: "queued", ceiling: "5000",
      charged: null, refund: null, billableSeconds: 0, receipt: null, output: null });
    return json({ title: "not_found" }, 404);
  };
  return { requests, fetcher, client: new TelomereClient({ baseUrl: "http://127.0.0.1:3280", pins, sessionToken: session, fetch: fetcher }) };
}
function wallet(overrides: Partial<OwnerWallet> = {}): OwnerWallet {
  return { address: owner.address, getChainId: async () => 31337, signMessage: input => owner.signMessage(input),
    sendTransaction: async () => txHash, waitForTransaction: async () => ({ status: "success" }), ...overrides };
}

describe("owner wallet SDK", () => {
  async function deadlineResponse(request: Request, change: (value: Record<string, unknown>) => void = () => undefined) {
    const body = JSON.parse(String(request.init.body)); const { deadline, maxSpend, ...task } = body;
    const q = { runId, leashId, payer: owner.address, workloadHash: hashJson({ input: task, maxTokens: 128, model: null }), maxSeconds: 5,
      pricePerSecond: '1000', inferencePrice: '0', quoteExpiry: deadline - 5 };
    const typed = { ...q, maxSeconds: 5n, pricePerSecond: 1000n, inferencePrice: 0n, quoteExpiry: BigInt(q.quoteExpiry) };
    const signature = await signer.signTypedData(quoteTypedData(31337, escrow, typed));
    const value = { quote: q, signature, ceiling: '5000', transaction: { to: escrow,
      data: encodeFunctionData({ abi: escrowAbi, functionName: 'openRun', args: [typed, signature] }), value: '0x0' },
      deadlineJob: { id: hashJson({ key: 'deadline' }), runId, deadline, maxSpend, maxSeconds: 5, hostId: hashJson({ host: 'controlled' }),
        status: 'prepared', deadlineMissed: false, charged: null, refund: null,
        enforcement: 'operator-signed-zero-charge-on-missed-deadline', walletActionRequired: true } };
    change(value); return json(value);
  }
  it('verifies a deadline quote and retains one exact pending wallet plan across concurrent retries', async () => {
    const f = fixture(request => request.path === '/api/jobs/deadline' ? deadlineResponse(request) : undefined);
    const body = { ...input, deadline: Math.floor(Date.now() / 1000) + 60, maxSpend: '5000' };
    const [a, b] = await Promise.all([1, 2].map(() => f.client.quoteDeadline(body, { idempotencyKey: 'deadline_client_01' })));
    expect(a).toBe(b); expect(a?.deadlineJob.deadline).toBe(body.deadline);
    expect(a?.walletAction.intents[0]?.summary).toContain('full ceiling returned');
    expect(f.requests.filter(request => request.path === '/api/jobs/deadline')).toHaveLength(1);
    await expect(f.client.quoteDeadline({ ...body, maxSpend: '6000' }, { idempotencyKey: 'deadline_client_01' })).rejects.toThrow('original request');
  });
  it('rejects mismatched deadline metadata and swapped transaction data before returning a plan', async () => {
    const body = { ...input, deadline: Math.floor(Date.now() / 1000) + 60, maxSpend: '5000' };
    const wrong = fixture(request => request.path === '/api/jobs/deadline' ? deadlineResponse(request, value => {
      value.deadlineJob = { ...(value.deadlineJob as Record<string, unknown>), deadline: body.deadline + 1 };
    }) : undefined);
    await expect(wrong.client.quoteDeadline(body, { idempotencyKey: 'deadline_client_02' })).rejects.toThrow();
    const swap = fixture(request => request.path === '/api/jobs/deadline' ? deadlineResponse(request, value => {
      value.transaction = { to: attacker, data: '0x', value: '0x0' };
    }) : undefined);
    await expect(swap.client.quoteDeadline(body, { idempotencyKey: 'deadline_client_03' })).rejects.toThrow('differs from the requested');
  });
  it("retains only the scoped session cookie and sends the API's exact Origin", async () => {
    const nonce = "a".repeat(48); const issued = new Date(); const expiry = new Date(issued.getTime() + 300000);
    const message = `127.0.0.1:3280 wants you to sign in to Telomere:\n${owner.address}\n\nAuthorize this browser session. No token transfer.\n\nURI: http://127.0.0.1:3280\nVersion: 1\nChain ID: 31337\nNonce: ${nonce}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expiry.toISOString()}`;
    const f = fixture(async request => {
      if (request.path === "/api/auth/challenge") return json({ nonce, message });
      if (request.path === "/api/auth/verify") {
        const body = JSON.parse(String(request.init.body)) as { signature: Hex };
        expect(await verifyMessage({ address: owner.address, message, signature: body.signature })).toBe(true);
        return json({ address: owner.address, demo: false }, 200, { "Set-Cookie": `telomere_session=${"d".repeat(64)}; HttpOnly; Path=/; SameSite=Strict` });
      }
      return undefined;
    });
    await f.client.authenticate(wallet()); await f.client.me();
    for (const request of f.requests.filter(request => request.init.method === "POST")) {
      expect(new Headers(request.init.headers).get("Origin")).toBe("http://127.0.0.1:3280");
      expect(request.init.credentials).toBe("include"); expect(request.init.redirect).toBe("error");
    }
    expect(new Headers(f.requests.at(-1)!.init.headers).get("Cookie")).toBe(`telomere_session=${"d".repeat(64)}`);
  });
  it("refuses a changed sign-in message before asking the wallet to sign", async () => {
    const signMessage = vi.fn(); const f = fixture(request => request.path === "/api/auth/challenge"
      ? json({ nonce: "a".repeat(48), message: "Authorize spending all your tokens" }) : undefined);
    await expect(f.client.authenticate(wallet({ signMessage }))).rejects.toThrow("challenge changed scope");
    expect(signMessage).not.toHaveBeenCalled();
  });
  it("retries a quote with the same key and same pending wallet plan", async () => {
    const f = fixture(); const [a, b] = await Promise.all([f.client.quote(input, { idempotencyKey: "request_123" }), f.client.quote(input, { idempotencyKey: "request_123" })]);
    expect(a).toBe(b); expect(a.walletAction.requiresWallet).toBe(true);
    expect(f.requests.filter(request => request.path === "/api/quotes")).toHaveLength(1);
    expect(new Headers(f.requests.find(request => request.path === "/api/quotes")!.init.headers).get("Idempotency-Key")).toBe("request_123");
    await expect(f.client.quote({ ...input, maxSeconds: 6 }, { idempotencyKey: "request_123" })).rejects.toThrow("original request");
  });
  it("rejects swapped approval target or calldata before returning a wallet action", async () => {
    const f = fixture(request => request.path.startsWith("/api/transactions/deposit") ? json({ transactions: [
      { to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [attacker, 1000000n] }), value: "0x0" },
      { to: escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "deposit", args: [1000000n] }), value: "0x0" }] }) : undefined);
    await expect(f.client.prepareDeposit("1000000")).rejects.toThrow("differs from the requested");
  });
  it("rejects a valid operator signature and calldata that bind a different workload", async () => {
    const f = fixture(async request => {
      if (request.path !== "/api/quotes") return undefined;
      const q = { runId, leashId, payer: owner.address, workloadHash: hashJson({ input: { ...input, task: { kind: "sha256", text: "changed" } }, maxTokens: 128, model: null }),
        maxSeconds: 5, pricePerSecond: "1000", inferencePrice: "0", quoteExpiry: Math.floor(Date.now() / 1000) + 120 };
      const typed = { ...q, maxSeconds: 5n, pricePerSecond: 1000n, inferencePrice: 0n, quoteExpiry: BigInt(q.quoteExpiry) };
      const signature = await signer.signTypedData(quoteTypedData(31337, escrow, typed));
      return json({ quote: q, signature, ceiling: "5000", transaction: { to: escrow,
        data: encodeFunctionData({ abi: escrowAbi, functionName: "openRun", args: [typed, signature] }), value: "0x0" } });
    });
    await expect(f.client.quote(input, { idempotencyKey: "wrong_workload" })).rejects.toThrow("requested workload");
  });
  it("checks reviewed deployment pins before any signing or sending", async () => {
    const f = fixture(); const client = new TelomereClient({ baseUrl: "http://127.0.0.1:3280", fetch: f.fetcher,
      pins: { ...pins, escrowAddress: attacker } });
    await expect(client.config()).rejects.toThrow("differs from the supplied pins");
    const unpinned = new TelomereClient({ baseUrl: "http://127.0.0.1:3280", fetch: f.fetcher });
    const pending = await unpinned.prepareDeposit("1000000"); const send = vi.fn();
    await expect(unpinned.executePlan(pending, wallet({ sendTransaction: send }), async () => true)).rejects.toThrow("reviewed deployment pins");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not repeat a wallet send after a timeout, preserving the original hash", async () => {
    const f = fixture(); const quote = await f.client.quote(input, { idempotencyKey: "request_456" });
    const send = vi.fn(async () => txHash); const wait = vi.fn(async () => { throw new Error("RPC timeout"); });
    const adapter = wallet({ sendTransaction: send, waitForTransaction: wait });
    const confirm = vi.fn(async () => true);
    await expect(f.client.executePlan(quote.walletAction, adapter, confirm)).rejects.toMatchObject({ name: "WalletActionUncertainError", txHash });
    await expect(f.client.executePlan(quote.walletAction, adapter, confirm)).rejects.toBeInstanceOf(WalletActionUncertainError);
    expect(send).toHaveBeenCalledTimes(1); expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("preserves the confirmed approval when a deposit outcome is uncertain", async () => {
    const f = fixture(); const plan = await f.client.prepareDeposit("1000000"); let count = 0;
    const adapter = wallet({ sendTransaction: vi.fn(async () => txHash), waitForTransaction: async () => {
      if (++count === 2) throw new Error("timeout"); return { status: "success" };
    } });
    await expect(f.client.executePlan(plan, adapter, async () => true)).rejects.toMatchObject({ intentIndex: 1, confirmed: [{ index: 0, txHash }] });
    await expect(f.client.executePlan(plan, adapter, async () => true)).rejects.toBeInstanceOf(WalletActionUncertainError);
    expect(adapter.sendTransaction).toHaveBeenCalledTimes(2);
  });
  it("refuses imported or edited wallet plans", async () => {
    const f = fixture(); const plan = await f.client.prepareDeposit("1000000");
    const send = vi.fn();
    await expect(f.client.executePlan({ ...plan, intents: [] }, wallet({ sendTransaction: send }), async () => true)).rejects.toThrow("changed");
    expect(send).not.toHaveBeenCalled();
  });
  it("returns pending nullable billing and missing receipts without fabricating settlement", async () => {
    const f = fixture(); expect(await f.client.run(runId)).toMatchObject({ status: "queued", charged: null, refund: null });
    expect(await f.client.receipt(runId)).toEqual({ available: false, runId, status: "queued" });
    expect(f.requests.some(request => request.path === "/api/receipts/verify")).toBe(false);
  });
  it("allows demo authentication only for explicitly enabled loopback demo mode", async () => {
    const fetcher = vi.fn(async () => json(config));
    const client = new TelomereClient({ baseUrl: "https://example.com", fetch: fetcher });
    await expect(client.authenticateDemo({ explicitlyEnabled: true })).rejects.toThrow("explicitly enabled loopback");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => new TelomereClient({ baseUrl: "http://example.com" })).toThrow("HTTPS");
  });
});
