import { z } from "zod";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, toHex, verifyTypedData, type Address, type Hex } from "viem";
import { escrowAbi, tokenAbi } from "../chain/abi.js";
import { quoteTypedData } from "../chain/typed-data.js";
import { baseUsdcForChainId, chainForId } from "../chain/chains.js";
import { ApiTransport, isLoopback } from "./transport.js";
import { CystClient } from './cysts.js';
import { HttpAgentLifecycleControl } from '../agents/http-client.js';
import type { DeploymentPins, FetchTransport, OwnerWallet, PilotConfig, QuoteRequest, QuotedRun, RunView,
  WalletActionPlan, WalletConfirmation, WalletExecution, WalletTransaction, WireQuote } from "./types.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase() as Hex);
const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(32768).transform(value => value as Hex);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value as Hex);
const money = z.string().regex(/^(0|[1-9][0-9]{0,27})$/).refine(value => BigInt(value) < 2n ** 96n);
const deadlineJobSchema = z.object({ id: bytes32, runId: bytes32.nullable(), deadline: z.number().int().safe().positive(),
  maxSpend: money, maxSeconds: z.number().int().min(1).max(120), hostId: bytes32,
  status: z.enum(['preparing', 'prepared', 'queued', 'running', 'near_dispatching', 'receipt_pending', 'settling', 'completed',
    'failed', 'cancelled', 'timed_out', 'reconciliation', 'refunded']), deadlineMissed: z.boolean(),
  charged: money.nullable(), refund: money.nullable(), enforcement: z.literal('operator-signed-zero-charge-on-missed-deadline'),
  walletActionRequired: z.boolean() }).strict();
export type DeadlineJobView = z.infer<typeof deadlineJobSchema>;
export type DeadlineQuotedRun = QuotedRun & { readonly deadlineJob: Readonly<DeadlineJobView> };
const text = z.string().max(8192).refine(value => new TextEncoder().encode(value).length <= 8192);
export const sdkTaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sha256"), text }).strict(),
  z.object({ kind: z.literal("hash_chain"), text, iterations: z.number().int().min(1).max(2_000_000) }).strict(),
  z.object({ kind: z.literal("sort"), numbers: z.array(z.number().int().min(-1_000_000_000).max(1_000_000_000)).max(10_000) }).strict(),
  z.object({ kind: z.literal("primes"), limit: z.number().int().min(2).max(2_000_000) }).strict(),
]);
export const sdkQuoteRequestSchema = z.object({ leashId: bytes32, task: sdkTaskSchema,
  maxSeconds: z.number().int().min(1).max(120), nearPrompt: text.refine(value => value.length > 0).optional() }).strict();
const configSchema = z.object({ mode: z.enum(["demo", "testnet", "mainnet"]),
  chain: z.object({ id: z.number().int(), name: z.string(), rpcUrl: z.string().url(), explorerUrl: z.string().url().optional() }),
  token: z.object({ address, symbol: z.string(), decimals: z.number().int(), codeHash: bytes32.optional(),
    implementation: z.object({ address, codeHash: bytes32 }).strict().optional() }), escrowAddress: address, receiptSigner: address,
  prices: z.object({ cpuPerSecond: money, inferenceFixed: money, maxSeconds: z.number().int(), maxTokens: z.number().int() }),
  workload: z.object({ nearModel: z.string().min(1).max(512).nullable() }).strict(),
  nearAvailable: z.boolean(), cpuMode: z.enum(["demo", "docker", "hostkit"]), cystsAvailable: z.boolean().default(false) });
const quoteSchema = z.object({ runId: bytes32, leashId: bytes32, payer: address, workloadHash: bytes32,
  maxSeconds: z.number().int().min(1).max(120), pricePerSecond: money, inferencePrice: money, quoteExpiry: z.number().int().positive() }).strict();
const transactionSchema = z.object({ to: address, data: hex, value: z.literal("0x0") }).strict();
const runSchema = z.object({ id: bytes32, owner: z.string(), status: z.string(), ceiling: money, charged: money.nullable(),
  refund: money.nullable(), billableSeconds: z.number().int().nonnegative(), receipt: z.unknown().optional(),
  output: z.string().nullable().optional(), refundAt: z.number().optional() }).passthrough();

function equalAddress(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function units(value: string | bigint): string { return money.parse(value.toString()); }
function fingerprint(value: unknown): string { return keccak256(toHex(JSON.stringify(value))); }
// Same canonical JSON as the API, kept here so the browser SDK has no Node crypto dependency.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error("Cannot hash undefined");
    return encoded;
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}

export class WalletActionUncertainError extends Error {
  constructor(readonly planId: string, readonly intentIndex: number, readonly confirmed: WalletExecution["confirmed"], readonly txHash?: Hex) {
    super("Wallet outcome is uncertain. Reconcile the original transaction before preparing or sending another payment.");
    this.name = "WalletActionUncertainError";
  }
}
export class TelomereClient {
  readonly origin: string;
  readonly cysts: CystClient;
  readonly agents: HttpAgentLifecycleControl;
  private readonly transport: ApiTransport;
  private readonly pins: DeploymentPins | undefined;
  private configValue: PilotConfig | undefined;
  private readonly issuedPlans = new Map<string, string>();
  private readonly executions = new Map<string, Promise<WalletExecution>>();
  private readonly quoteRequests = new Map<string, { request: string; result: Promise<QuotedRun> }>();
  private readonly deadlineRequests = new Map<string, { request: string; result: Promise<DeadlineQuotedRun> }>();
  constructor(options: { baseUrl: string; pins?: DeploymentPins; sessionToken?: string; fetch?: FetchTransport;
    cystQuotaVersion?: 2; metabolismVersion?: 2 }) {
    this.transport = new ApiTransport(options.baseUrl, {
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
    this.origin = this.transport.origin;
    this.cysts = new CystClient(this.transport, options.cystQuotaVersion === undefined ? {} : { quotaVersion: options.cystQuotaVersion });
    this.agents = new HttpAgentLifecycleControl(this.transport, {
      ...(options.cystQuotaVersion === undefined ? {} : { cystQuotaVersion: options.cystQuotaVersion }),
      ...(options.metabolismVersion === undefined ? {} : { metabolismVersion: options.metabolismVersion }) });
    this.pins = options.pins ? Object.freeze({ ...options.pins,
      ...(options.pins.assetImplementation ? { assetImplementation: Object.freeze({ ...options.pins.assetImplementation }) } : {}) }) : undefined;
  }
  async config(): Promise<PilotConfig> {
    if (this.configValue) return this.configValue;
    const config = configSchema.parse(await this.transport.request("/api/config"));
    const expectedChain = config.mode === 'demo' ? 31337 : config.mode === 'mainnet' ? 8453 : 84532;
    if (config.chain.id !== expectedChain || config.token.decimals !== 6 || config.prices.maxSeconds !== 120) {
      throw new Error("Unsupported Telomere pilot deployment");
    }
    if (config.mode !== 'demo') {
      const chain = chainForId(expectedChain), asset = baseUsdcForChainId(expectedChain);
      if (!asset || !equalAddress(config.token.address, asset) || config.token.symbol !== 'USDC'
        || config.chain.rpcUrl !== chain.rpcUrls.default.http[0] || config.chain.explorerUrl !== chain.blockExplorers?.default.url
        || !this.pins?.tokenCodeHash || !this.pins.assetImplementation || !config.token.codeHash || !config.token.implementation
        || this.pins.tokenCodeHash.toLowerCase() !== config.token.codeHash.toLowerCase()
        || !equalAddress(this.pins.assetImplementation.address, config.token.implementation.address)
        || this.pins.assetImplementation.codeHash.toLowerCase() !== config.token.implementation.codeHash.toLowerCase()) {
        throw new Error('Public Base deployment requires independently reviewed Circle USDC pins and network metadata');
      }
    }
    if (this.pins && (this.pins.chainId !== config.chain.id || !equalAddress(this.pins.escrowAddress, config.escrowAddress)
      || !equalAddress(this.pins.tokenAddress, config.token.address) || !equalAddress(this.pins.receiptSigner, config.receiptSigner))) {
      throw new Error("Telomere deployment differs from the supplied pins");
    }
    this.configValue = Object.freeze({ ...config, chain: Object.freeze(config.chain), token: Object.freeze({ ...config.token,
      ...(config.token.implementation ? { implementation: Object.freeze(config.token.implementation) } : {}) }),
      prices: Object.freeze(config.prices), workload: Object.freeze(config.workload) });
    return this.configValue;
  }
  async authenticate(wallet: Pick<OwnerWallet, "address" | "getChainId" | "signMessage">) {
    const config = await this.config();
    if (await wallet.getChainId() !== config.chain.id) throw new Error("Select the configured pilot chain in the owner wallet");
    const challenge = z.object({ nonce: z.string().regex(/^[a-f0-9]{48}$/), message: z.string().max(4096) }).strict()
      .parse(await this.transport.request("/api/auth/challenge", { method: "POST", body: { address: wallet.address } }));
    const { message, nonce } = challenge;
    const dates = message.match(/\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/);
    const issued = dates?.[1] ?? ""; const expires = dates?.[2] ?? "";
    const expiration = Date.parse(expires); const issuedAt = Date.parse(issued);
    const expected = `${new URL(this.origin).host} wants you to sign in to Telomere:\n${getAddress(wallet.address)}\n\n`
      + `Authorize this browser session. No token transfer.\n\nURI: ${this.origin}\nVersion: 1\nChain ID: ${config.chain.id}\nNonce: ${nonce}\n`
      + `Issued At: ${issued}\nExpiration Time: ${expires}`;
    if (message !== expected || !Number.isFinite(issuedAt) || issuedAt > Date.now() + 30_000
      || !Number.isFinite(expiration) || expiration <= Date.now() || expiration - issuedAt !== 5 * 60_000) {
      throw new Error("Wallet sign-in challenge changed scope or expired");
    }
    const signed = signature.parse(await wallet.signMessage({ message }));
    const session = z.object({ address, demo: z.literal(false) }).parse(await this.transport.request("/api/auth/verify", {
      method: "POST", body: { address: wallet.address, nonce, signature: signed } }));
    if (!equalAddress(session.address, wallet.address)) throw new Error("Owner session address changed");
    return session;
  }
  async authenticateDemo(options: { explicitlyEnabled: true }) {
    const config = await this.config();
    if (options.explicitlyEnabled !== true || !isLoopback(new URL(this.origin)) || config.mode !== "demo" || config.chain.id !== 31337) {
      throw new Error("Demo authentication requires an explicitly enabled loopback local-chain demo");
    }
    return z.object({ address, demo: z.literal(true) }).parse(await this.transport.request("/api/auth/demo", { method: "POST", body: {} }));
  }
  async logout(): Promise<void> {
    try { await this.transport.request("/api/auth/logout", { method: "POST", body: {} }); }
    finally { this.transport.clearSession(); }
  }
  async me() { return z.object({ address, demo: z.boolean() }).parse(await this.transport.request("/api/me")); }
  async balance() { return z.object({ available: money, reserved: money }).parse(await this.transport.request("/api/balance")); }
  async operations() { return z.record(z.unknown()).parse(await this.transport.request("/api/operations")); }
  async prices() {
    const window = z.object({ window: z.enum(['1h', '24h', '7d']), count: z.number().int().nonnegative(),
      p10: money.nullable(), median: money.nullable(), p90: money.nullable() }).strict();
    return z.object({ hardwareClass: z.literal('cpu'), lane: z.literal('standard'), unit: z.literal('token-base-units-per-second'),
      source: z.literal('controller-indexed-settled-controlled-host-receipts'), samplesAreMarketWide: z.literal(false),
      windows: z.array(window).length(3) }).strict().parse(await this.transport.request('/api/jobs/prices'));
  }
  async receiptProof(runId: Hex) {
    return z.record(z.unknown()).parse(await this.transport.request('/api/receipt-batches/' + bytes32.parse(runId) + '/proof'));
  }
  async leashes() { return z.object({ leashes: z.array(z.record(z.unknown())) }).parse(await this.transport.request("/api/leashes")); }
  async runs(): Promise<{ runs: RunView[] }> { return z.object({ runs: z.array(runSchema) }).parse(await this.transport.request("/api/runs")); }
  async run(runId: Hex): Promise<RunView> { return runSchema.parse(await this.transport.request(`/api/runs/${bytes32.parse(runId)}`)); }
  async receipt(runId: Hex) {
    const run = await this.run(runId);
    if (!run.receipt) return { available: false as const, runId, status: run.status };
    const verification = await this.transport.request("/api/receipts/verify", { method: "POST", body: { receipt: run.receipt } });
    return { available: true as const, runId, receipt: run.receipt, verification };
  }
  private checkedTransaction(value: unknown, to: Address, data: Hex): WalletTransaction {
    const tx = transactionSchema.parse(value);
    if (!equalAddress(tx.to, to) || tx.data.toLowerCase() !== data.toLowerCase()) throw new Error("Wallet transaction differs from the requested pilot action");
    return tx;
  }
  private async plan(purpose: WalletActionPlan["purpose"], intents: { transaction: WalletTransaction; summary: string }[],
    nextStep: string, identifiers: { runId?: Hex; leashId?: Hex; expiresAt?: number } = {}): Promise<WalletActionPlan> {
    const config = await this.config();
    const action = Object.freeze({ planId: crypto.randomUUID(), purpose, requiresWallet: true as const,
      intents: Object.freeze(intents.map(intent => Object.freeze({ ...intent, transaction: Object.freeze(intent.transaction), chainId: config.chain.id }))),
      nextStep, ...identifiers });
    this.issuedPlans.set(action.planId, fingerprint(action));
    return action;
  }
  async prepareDeposit(amount: string | bigint): Promise<WalletActionPlan> {
    const value = units(amount); if (value === "0") throw new Error("Deposit amount must be positive");
    const config = await this.config();
    const response = z.object({ transactions: z.array(transactionSchema).length(2) }).parse(await this.transport.request(`/api/transactions/deposit?amount=${value}`));
    const approve = this.checkedTransaction(response.transactions[0], config.token.address,
      encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [config.escrowAddress, BigInt(value)] }));
    const deposit = this.checkedTransaction(response.transactions[1], config.escrowAddress,
      encodeFunctionData({ abi: escrowAbi, functionName: "deposit", args: [BigInt(value)] }));
    return this.plan("deposit", [{ transaction: approve, summary: `Approve exactly ${value} token units for the pilot escrow.` },
      { transaction: deposit, summary: `Deposit ${value} token units into your available escrow balance.` }], "Wait for both transactions, then check balance.");
  }
  async prepareWithdraw(amount: string | bigint): Promise<WalletActionPlan> {
    const value = units(amount); if (value === "0") throw new Error("Withdrawal amount must be positive");
    const config = await this.config();
    const response = z.object({ transaction: transactionSchema }).parse(await this.transport.request(`/api/transactions/withdraw?amount=${value}`));
    return this.plan("withdraw", [{ transaction: this.checkedTransaction(response.transaction, config.escrowAddress,
      encodeFunctionData({ abi: escrowAbi, functionName: "withdraw", args: [BigInt(value)] })), summary: `Withdraw ${value} available token units to your wallet.` }], "Check the confirmed wallet balance.");
  }
  async prepareLeash(input: { agent?: Address; maxPerHour: string | bigint; maxPerDay: string | bigint; expiry: number }): Promise<WalletActionPlan> {
    const owner = await this.me(); const config = await this.config();
    const agent = input.agent ? address.parse(input.agent) : owner.address;
    const body = { agent, maxPerHour: units(input.maxPerHour), maxPerDay: units(input.maxPerDay), expiry: z.number().int().positive().parse(input.expiry) };
    const response = z.object({ leashId: bytes32, transaction: transactionSchema }).parse(await this.transport.request("/api/leashes", { method: "POST", body }));
    return this.plan("leash", [{ transaction: this.checkedTransaction(response.transaction, config.escrowAddress,
      encodeFunctionData({ abi: escrowAbi, functionName: "createLeash", args: [response.leashId, agent, BigInt(body.maxPerHour), BigInt(body.maxPerDay), BigInt(body.expiry)] })),
      summary: `Create budget ${response.leashId}: hourly ${body.maxPerHour}, daily ${body.maxPerDay} token units; agent ${agent}.` }],
      "Confirm budget creation before requesting a quote.", { leashId: response.leashId });
  }
  async prepareUpdateLeash(id: Hex, input: { maxPerHour: string | bigint; maxPerDay: string | bigint; expiry: number }): Promise<WalletActionPlan> {
    const leashId = bytes32.parse(id), owner = await this.me(), config = await this.config();
    const current = z.object({ leashes: z.array(z.object({ id: bytes32, owner: address, agent: address, killed: z.boolean() }).passthrough()) })
      .parse(await this.transport.request("/api/leashes")).leashes.find(leash => leash.id === leashId && equalAddress(leash.owner, owner.address));
    if (!current || current.killed) throw new Error("Only an existing owner budget that has not been killed can be edited");
    const body = { maxPerHour: units(input.maxPerHour), maxPerDay: units(input.maxPerDay), expiry: z.number().int().safe().positive().parse(input.expiry) };
    const now = Math.floor(Date.now() / 1000);
    if (body.maxPerHour === "0" || BigInt(body.maxPerDay) < BigInt(body.maxPerHour) || body.expiry <= now || body.expiry > now + 30 * 86400) {
      throw new Error("Set positive limits and an expiry within thirty days");
    }
    const response = z.object({ leashId: bytes32, agent: address, transaction: transactionSchema }).strict()
      .parse(await this.transport.request(`/api/leashes/${leashId}/update`, { method: "POST", body }));
    if (response.leashId !== leashId || !equalAddress(response.agent, current.agent)) throw new Error("Budget or authorized agent changed while preparing the update");
    return this.plan("leash_update", [{ transaction: this.checkedTransaction(response.transaction, config.escrowAddress,
      encodeFunctionData({ abi: escrowAbi, functionName: "updateLeash", args: [leashId, current.agent, BigInt(body.maxPerHour), BigInt(body.maxPerDay), BigInt(body.expiry)] })),
      summary: `Update budget ${leashId}: hourly ${body.maxPerHour}, daily ${body.maxPerDay} token units; keep agent ${current.agent}.` }],
      "Confirm the budget update, then refresh its limits.", { leashId, expiresAt: body.expiry });
  }
  async quote(input: QuoteRequest, options: { idempotencyKey: string }): Promise<QuotedRun> {
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(options.idempotencyKey);
    const body = sdkQuoteRequestSchema.parse(input); const request = fingerprint(body);
    const previous = this.quoteRequests.get(key);
    if (previous) {
      if (previous.request !== request) throw new Error("Reuse the original idempotency key only with the original request");
      return previous.result;
    }
    const result = this.requestQuote(body, key);
    this.quoteRequests.set(key, { request, result });
    try { return await result; }
    catch (error) { this.quoteRequests.delete(key); throw error; }
  }
  private async requestQuote(body: QuoteRequest, key: string): Promise<QuotedRun> {
    const owner = await this.me(); const config = await this.config();
    return this.verifiedQuote(body, key, await this.transport.request('/api/quotes', { method: 'POST', body, idempotencyKey: key }), owner.address, config);
  }
  private async verifiedQuote(body: QuoteRequest, key: string, value: unknown, owner: Address, config: PilotConfig, deadline?: number): Promise<QuotedRun> {
    const response = z.object({ quote: quoteSchema, signature, ceiling: money, transaction: transactionSchema }).strict()
      .parse(value);
    const q: WireQuote = response.quote;
    const workloadHash = keccak256(toHex(canonical({ input: body, maxTokens: config.prices.maxTokens, model: config.workload.nearModel })));
    if (!equalAddress(q.payer, owner) || q.leashId !== body.leashId || q.maxSeconds !== body.maxSeconds
      || q.workloadHash !== workloadHash
      || q.pricePerSecond !== config.prices.cpuPerSecond || q.inferencePrice !== (body.nearPrompt ? config.prices.inferenceFixed : "0")
      || q.quoteExpiry <= Date.now() / 1000 || BigInt(response.ceiling) !== BigInt(q.maxSeconds) * BigInt(q.pricePerSecond) + BigInt(q.inferencePrice)) {
      throw new Error("Quote differs from the requested workload, run or published tariff");
    }
    if (deadline !== undefined && q.quoteExpiry > deadline - q.maxSeconds) throw new Error('Deadline quote expires after the safe execution window');
    const typed = { ...q, maxSeconds: BigInt(q.maxSeconds), pricePerSecond: BigInt(q.pricePerSecond),
      inferencePrice: BigInt(q.inferencePrice), quoteExpiry: BigInt(q.quoteExpiry) };
    if (!await verifyTypedData({ address: config.receiptSigner, ...quoteTypedData(config.chain.id, config.escrowAddress, typed), signature: response.signature })) {
      throw new Error("Invalid operator quote signature");
    }
    const transaction = this.checkedTransaction(response.transaction, config.escrowAddress,
      encodeFunctionData({ abi: escrowAbi, functionName: "openRun", args: [typed, response.signature] }));
    if (!equalAddress((await this.me()).address, owner)) throw new Error('The signed-in quote owner changed');
    const walletAction = await this.plan("open", [{ transaction, summary: `Reserve at most ${response.ceiling} token units for ${q.maxSeconds} CPU seconds${body.nearPrompt ? " and one bounded inference request" : ""}${deadline === undefined ? '' : `; deadline ${new Date(deadline * 1000).toISOString()}, full ceiling returned on a miss under the operator policy`}.` }],
      "After wallet confirmation, admit this exact run with its original transaction hash.", { runId: q.runId, leashId: q.leashId, expiresAt: q.quoteExpiry });
    if (!equalAddress((await this.me()).address, owner)) throw new Error('The signed-in quote owner changed');
    return Object.freeze({ quote: Object.freeze(q), signature: response.signature, ceiling: response.ceiling, walletAction, idempotencyKey: key });
  }
  async quoteDeadline(input: Omit<QuoteRequest, 'nearPrompt'> & { deadline: number; maxSpend: string }, options: { idempotencyKey: string }): Promise<DeadlineQuotedRun> {
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(options.idempotencyKey);
    const body = sdkQuoteRequestSchema.omit({ nearPrompt: true }).extend({ deadline: z.number().int().safe().positive(), maxSpend: money }).strict().parse(input);
    const request = fingerprint(body), previous = this.deadlineRequests.get(key);
    if (previous) {
      if (previous.request !== request) throw new Error('Reuse the original deadline idempotency key only with the original request');
      return previous.result;
    }
    const result = this.requestDeadline(body, key); this.deadlineRequests.set(key, { request, result });
    try { return await result; } catch (error) { this.deadlineRequests.delete(key); throw error; }
  }
  private async requestDeadline(body: Omit<QuoteRequest, 'nearPrompt'> & { deadline: number; maxSpend: string }, key: string): Promise<DeadlineQuotedRun> {
    const owner = await this.me(), config = await this.config();
    const response = z.object({ deadlineJob: deadlineJobSchema, quote: quoteSchema, signature, ceiling: money, transaction: transactionSchema }).strict()
      .parse(await this.transport.request('/api/jobs/deadline', { method: 'POST', body, idempotencyKey: key }));
    const deadlineJob = response.deadlineJob;
    if (deadlineJob.deadline !== body.deadline || deadlineJob.maxSpend !== body.maxSpend || deadlineJob.maxSeconds !== body.maxSeconds
      || deadlineJob.runId !== response.quote.runId || BigInt(response.ceiling) > BigInt(body.maxSpend)) throw new Error('Deadline job differs from the original terms');
    const { deadlineJob: _job, ...wire } = response; const { deadline, maxSpend: _maxSpend, ...workload } = body;
    const quoted = await this.verifiedQuote(workload, key, wire, owner.address, config, deadline);
    return Object.freeze({ ...quoted, deadlineJob: Object.freeze(deadlineJob) });
  }
  async deadlineJob(id: Hex) { return deadlineJobSchema.parse(await this.transport.request(`/api/jobs/deadline/${bytes32.parse(id)}`)); }
  async deadlineJobs() { return z.object({ jobs: z.array(deadlineJobSchema).max(100) }).strict().parse(await this.transport.request('/api/jobs/deadline')); }
  async admit(runId: Hex, txHash: Hex): Promise<RunView> {
    return runSchema.parse(await this.transport.request("/api/runs", { method: "POST", body: { runId: bytes32.parse(runId), txHash: bytes32.parse(txHash) } }));
  }
  async prepareStop(runId: Hex) { return this.runAction("stop", runId); }
  async prepareRefund(runId: Hex) { return this.runAction("refund", runId); }
  private async runAction(purpose: "stop" | "refund", id: Hex): Promise<WalletActionPlan> {
    const runId = bytes32.parse(id); const config = await this.config();
    const response = z.object({ transaction: transactionSchema }).parse(await this.transport.request(`/api/runs/${runId}/${purpose}`, { method: "POST", body: {} }));
    const data = purpose === "stop" ? encodeFunctionData({ abi: escrowAbi, functionName: "requestStop", args: [runId] })
      : encodeFunctionData({ abi: escrowAbi, functionName: "refundRun", args: [runId] });
    return this.plan(purpose, [{ transaction: this.checkedTransaction(response.transaction, config.escrowAddress, data),
      summary: purpose === "stop" ? "Request a stop; accepted work remains payable and unused funds return at settlement."
        : "Request the permissionless timeout refund; the contract checks the refund deadline." }], "Confirm in the owner wallet, then check run status.", { runId });
  }
  async prepareKill(id: Hex): Promise<WalletActionPlan> {
    const leashId = bytes32.parse(id); const config = await this.config();
    const response = z.object({ transaction: transactionSchema }).parse(await this.transport.request(`/api/leashes/${leashId}/kill`, { method: "POST", body: {} }));
    return this.plan("kill", [{ transaction: this.checkedTransaction(response.transaction, config.escrowAddress,
      encodeFunctionData({ abi: escrowAbi, functionName: "killLeash", args: [leashId] })),
      summary: "Permanently kill this budget; no new reservations, accepted work can still settle." }], "Confirm in the owner wallet, then check active runs.", { leashId });
  }
  async executePlan(plan: WalletActionPlan, wallet: OwnerWallet, confirm: WalletConfirmation): Promise<WalletExecution> {
    // No imported/arbitrary intents: execute only an exact plan this client checked.
    if (this.issuedPlans.get(plan.planId) !== fingerprint(plan)) throw new Error("Wallet action plan was changed or was not issued by this client");
    const existing = this.executions.get(plan.planId); if (existing) return existing;
    const operation = this.executeOnce(plan, wallet, confirm);
    this.executions.set(plan.planId, operation);
    return operation;
  }
  private async executeOnce(plan: WalletActionPlan, wallet: OwnerWallet, confirm: WalletConfirmation): Promise<WalletExecution> {
    if (!this.pins) throw new Error("Supply reviewed deployment pins before sending wallet transactions");
    const config = await this.config(); const owner = await this.me();
    if (!equalAddress(owner.address, wallet.address) || await wallet.getChainId() !== config.chain.id) throw new Error("Owner wallet or selected chain changed");
    const confirmed: { index: number; txHash: Hex }[] = [];
    for (const [index, intent] of plan.intents.entries()) {
      if (!await confirm(intent, index)) throw new Error("Wallet action declined");
      if (plan.expiresAt !== undefined && plan.expiresAt <= Date.now() / 1000) throw new Error("Quote expired before wallet submission");
      if (!equalAddress(owner.address, wallet.address) || await wallet.getChainId() !== intent.chainId) throw new Error("Owner wallet or chain changed before submission");
      if (plan.purpose === 'leash_update') {
        const current = (await this.leashes()).leashes.find(leash => leash.id === plan.leashId);
        const decoded = decodeFunctionData({ abi: escrowAbi, data: intent.transaction.data });
        if (!current || current.killed || decoded.functionName !== 'updateLeash' || !equalAddress(address.parse(current.agent), decoded.args[1])) {
          throw new Error('Leash agent or availability changed after review; prepare a fresh budget update');
        }
      }
      let txHash: Hex | undefined;
      try {
        txHash = bytes32.parse(await wallet.sendTransaction({ account: wallet.address, chainId: intent.chainId,
          to: intent.transaction.to, data: intent.transaction.data, value: 0n }));
        const receipt = await wallet.waitForTransaction({ hash: txHash, chainId: intent.chainId });
        if (receipt.status !== "success") throw new Error("Wallet transaction reverted");
      } catch { throw new WalletActionUncertainError(plan.planId, index, confirmed, txHash); }
      confirmed.push({ index, txHash });
    }
    return { planId: plan.planId, confirmed };
  }
}
