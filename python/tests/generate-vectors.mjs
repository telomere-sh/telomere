// Offline cross-language fixtures. Keys below are deterministic public TEST keys with no funds.
import { writeFileSync, mkdirSync } from "node:fs";
import { encodeFunctionData, hashTypedData, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi, tokenAbi } from "../../dist/src/chain/abi.js";
import { quoteTypedData, settlementTypedData } from "../../dist/src/chain/typed-data.js";

const operator = privateKeyToAccount(`0x${"11".repeat(32)}`);
const owner = privateKeyToAccount(`0x${"22".repeat(32)}`);
const escrow = `0x${"33".repeat(20)}`, token = `0x${"44".repeat(20)}`, agent = `0x${"55".repeat(20)}`;
const runId = `0x${"66".repeat(32)}`, leashId = `0x${"77".repeat(32)}`;
const epoch = 1700000000, expiry = epoch + 3600;
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",")}}`;
const input = { leashId, maxSeconds: 5, task: { kind: "sha256", text: "Telomere — проверка 🧬" } };
const config = { mode: "demo", chain: { id: 31337, name: "Local", rpcUrl: "http://127.0.0.1:8545" }, token: { address: token, decimals: 6, symbol: "TEST" },
  escrowAddress: escrow, receiptSigner: operator.address, prices: { cpuPerSecond: "100", inferenceFixed: "10000", maxSeconds: 120, maxTokens: 16 },
  workload: { nearModel: null }, nearAvailable: false, cpuMode: "demo" };
const q = { runId, leashId, payer: owner.address, workloadHash: keccak256(toHex(canonical({ input, maxTokens: 16, model: null }))),
  maxSeconds: 5n, pricePerSecond: 100n, inferencePrice: 0n, quoteExpiry: BigInt(epoch + 120) };
const quoteSignature = await operator.signTypedData(quoteTypedData(31337, escrow, q));
const transaction = (to, data) => ({ to, data, value: "0x0" });
const encode = (fn, args) => encodeFunctionData({ abi: escrowAbi, functionName: fn, args });
const quote = { quote: { ...q, maxSeconds: Number(q.maxSeconds), quoteExpiry: Number(q.quoteExpiry) }, signature: quoteSignature, ceiling: "500", transaction: transaction(escrow, encode("openRun", [q, quoteSignature])) };
const body = { version: 1, runId, payer: owner.address, leashId, workloadHash: q.workloadHash, status: "completed",
  cpu: { billableSeconds: 2, measuredSeconds: 2, pricePerSecond: "100" }, near: null,
  billing: { token, ceiling: "500", charged: "200", refund: "300" } };
const receiptHash = keccak256(toHex(canonical(body)));
const settlement = { runId, billableSeconds: 2n, inferenceCharge: 0n, receiptHash };
const signed = settlementTypedData(31337, escrow, settlement);
const receipt = { body, receiptHash, settlement, signature: await operator.signTypedData(signed), signer: operator.address, domain: signed.domain };
const leash = { id: leashId, owner: owner.address, agent, maxPerHour: "1000", maxPerDay: "2000", expiry: String(expiry), killed: false,
  killedAt: "0", hourKey: "0", dayKey: "0", spentHour: "0", spentDay: "0", pending: "0" };
const fixtures = { source: "viem 2.57.3; offline test-only signatures; no RPC, HTTP or transaction broadcast", epoch, expiry, owner: owner.address, agent,
  config, input, quote, receipt, leash, quoteDigest: hashTypedData(quoteTypedData(31337, escrow, q)),
  actions: { stop: transaction(escrow, encode("requestStop", [runId])), refund: transaction(escrow, encode("refundRun", [runId])), kill: transaction(escrow, encode("killLeash", [leashId])),
    create: { leashId, transaction: transaction(escrow, encode("createLeash", [leashId, agent, 1000n, 2000n, BigInt(expiry)])) },
    update: { leashId, agent, transaction: transaction(escrow, encode("updateLeash", [leashId, agent, 1500n, 2500n, BigInt(expiry)])) },
    withdraw: { transaction: transaction(escrow, encode("withdraw", [500n])) },
    deposit: { transactions: [transaction(token, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [escrow, 500n] })), transaction(escrow, encode("deposit", [500n]))] } } };
mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
writeFileSync(new URL("./fixtures/viem.json", import.meta.url), JSON.stringify(fixtures, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
