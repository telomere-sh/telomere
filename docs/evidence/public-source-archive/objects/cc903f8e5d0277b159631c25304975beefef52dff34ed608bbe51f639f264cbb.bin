import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { createWalletClient, encodeFunctionData, http, hashTypedData, type Abi, type Address, type Hex } from "viem";
import { escrowAbi, tokenAbi, localChain, quoteTypedData, settlementTypedData, quoteCeiling,
  type Quote, type Settlement } from "../src/chain/index.js";
import { startLocalChain, deployLocalContracts } from "../scripts/local-chain.js";

const hash = (): Hex => `0x${randomBytes(32).toString("hex")}`;
describe("Telomere escrow on a real disposable local EVM", () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let deployment: Awaited<ReturnType<typeof deployLocalContracts>>;
  let owner: ReturnType<typeof createWalletClient>;
  let outsider: ReturnType<typeof createWalletClient>;
  let snapshot: Hex;
  const leashId = hash();

  async function confirmed(tx: Promise<Hex>) {
    const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await tx });
    expect(receipt.status).toBe("success");
    return receipt;
  }
  async function balance() {
    return local.publicClient.readContract({ address: deployment.escrowAddress, abi: escrowAbi,
      functionName: "availableBalance", args: [deployment.accounts.owner.address] });
  }
  async function leash() {
    return local.publicClient.readContract({ address: deployment.escrowAddress, abi: escrowAbi, functionName: "getLeash", args: [leashId] });
  }
  async function run(runId: Hex) {
    return local.publicClient.readContract({ address: deployment.escrowAddress, abi: escrowAbi, functionName: "getRun", args: [runId] });
  }
  async function quote(overrides: Partial<Quote> = {}): Promise<Quote> {
    const block = await local.publicClient.getBlock();
    return { runId: hash(), leashId, payer: deployment.accounts.owner.address, workloadHash: hash(),
      maxSeconds: 10n, pricePerSecond: 10n, inferencePrice: 50n, quoteExpiry: block.timestamp + 300n, ...overrides };
  }
  async function signQuote(q: Quote, chainId = 31337) {
    return deployment.accounts.signer.signTypedData(quoteTypedData(chainId, deployment.escrowAddress, q));
  }
  async function open(q: Quote, signature?: Hex) {
    return confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "openRun", args: [q, signature ?? await signQuote(q)] }));
  }
  async function simulateOpen(q: Quote, signature?: Hex, caller = deployment.accounts.owner.address) {
    return local.publicClient.simulateContract({ account: caller, address: deployment.escrowAddress,
      abi: escrowAbi, functionName: "openRun", args: [q, signature ?? await signQuote(q)] });
  }
  async function settlement(runId: Hex, seconds: bigint, inferenceCharge = 0n): Promise<{ data: Settlement; signature: Hex }> {
    const data = { runId, billableSeconds: seconds, inferenceCharge, receiptHash: hash() };
    return { data, signature: await deployment.accounts.signer.signTypedData(settlementTypedData(31337, deployment.escrowAddress, data)) };
  }
  async function settle(data: Settlement, signature: Hex) {
    return confirmed(outsider.writeContract({ account: deployment.accounts.outsider, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [data, signature] }));
  }
  async function advance(seconds: number) {
    await deployment.testClient.increaseTime({ seconds });
    await deployment.testClient.mine({ blocks: 1 });
  }

  beforeAll(async () => {
    local = await startLocalChain();
    deployment = await deployLocalContracts(local);
    owner = createWalletClient({ chain: localChain, transport: http(local.rpcUrl), account: deployment.accounts.owner });
    outsider = createWalletClient({ chain: localChain, transport: http(local.rpcUrl), account: deployment.accounts.outsider });
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.tokenAddress, abi: tokenAbi, functionName: "faucet", args: [deployment.accounts.owner.address, 2_000n] }));
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.tokenAddress, abi: tokenAbi, functionName: "approve", args: [deployment.escrowAddress, 2_000n] }));
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "deposit", args: [2_000n] }));
    const now = (await local.publicClient.getBlock()).timestamp;
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "createLeash",
      args: [leashId, deployment.accounts.owner.address, 300n, 450n, now + 200_000n] }));
    snapshot = await deployment.testClient.snapshot();
  }, 60_000);
  beforeEach(async () => {
    await deployment.testClient.revert({ id: snapshot });
    snapshot = await deployment.testClient.snapshot();
  });
  afterAll(async () => { await local?.close(); });

  it("matches the Solidity EIP-712 domain and exact quote encoding", async () => {
    const q = await quote();
    const digest = await local.publicClient.readContract({ address: deployment.escrowAddress, abi: escrowAbi, functionName: "quoteDigest", args: [q] });
    expect(digest).toBe(hashTypedData(quoteTypedData(31337, deployment.escrowAddress, q)));
    const s = (await settlement(q.runId, 0n)).data;
    expect(await local.publicClient.readContract({ address: deployment.escrowAddress, abi: escrowAbi,
      functionName: "settlementDigest", args: [s] })).toBe(hashTypedData(settlementTypedData(31337, deployment.escrowAddress, s)));
  });

  it("withdraws only available funds, preserving the entire pending ceiling", async () => {
    const q = await quote(); await open(q);
    expect(await balance()).toBe(2_000n - quoteCeiling(q));
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.owner.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "withdraw", args: [2_000n] })).rejects.toThrow(/InsufficientBalance/);
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "withdraw", args: [1_850n] }));
    expect(await balance()).toBe(0n); expect((await leash()).pending).toBe(150n);
  });

  it("atomically rejects concurrent ceilings exceeding the hour cap", async () => {
    await open(await quote()); await open(await quote());
    await expect(simulateOpen(await quote())).rejects.toThrow(/BudgetExceeded/);
    expect((await leash()).pending).toBe(300n);
  });

  it("carries all unfinished reservations across both hour and day boundaries", async () => {
    await open(await quote()); await open(await quote()); await advance(86_401);
    await expect(simulateOpen(await quote())).rejects.toThrow(/BudgetExceeded/);
    expect((await leash()).pending).toBe(300n);
    expect((await leash()).spentHour).toBe(0n); expect((await leash()).spentDay).toBe(0n);
  });

  it("separately enforces the day cap after the hour rolls", async () => {
    const first = await quote(); const second = await quote(); await open(first); await open(second);
    await advance(11);
    for (const q of [first, second]) { const s = await settlement(q.runId, 10n, 50n); await settle(s.data, s.signature); }
    await advance(3_601);
    await open(await quote());
    await expect(simulateOpen(await quote())).rejects.toThrow(/BudgetExceeded/);
  });

  it("rejects quote replay, wrong-chain signatures, payer substitution and unapproved callers", async () => {
    const q = await quote(); await open(q);
    await expect(simulateOpen(q)).rejects.toThrow(/InvalidQuote/);
    const fresh = await quote();
    await expect(simulateOpen(fresh, await signQuote(fresh, 84532))).rejects.toThrow(/InvalidSignature/);
    await expect(simulateOpen(await quote({ payer: deployment.accounts.outsider.address }))).rejects.toThrow(/Unauthorized/);
    await expect(simulateOpen(fresh, undefined, deployment.accounts.outsider.address)).rejects.toThrow(/Unauthorized/);
    const altered = { ...fresh, workloadHash: hash() };
    await expect(simulateOpen(altered, await signQuote(fresh))).rejects.toThrow(/InvalidSignature/);
  });

  it("allows the named agent to reserve only its owner's funds", async () => {
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "updateLeash",
      args: [leashId, deployment.accounts.outsider.address, 300n, 450n, 9_999_999_999n] }));
    const q = await quote();
    await confirmed(outsider.writeContract({ account: deployment.accounts.outsider, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "openRun", args: [q, await signQuote(q)] }));
    expect(await balance()).toBe(1_850n);
    expect(await local.publicClient.readContract({ address: deployment.escrowAddress, abi: escrowAbi,
      functionName: "availableBalance", args: [deployment.accounts.outsider.address] })).toBe(0n);
    await expect(simulateOpen(await quote(), undefined, deployment.accounts.signer.address)).rejects.toThrow(/Unauthorized/);
  });

  it("never changes an existing leash owner or revives a killed leash", async () => {
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "createLeash",
      args: [leashId, deployment.accounts.outsider.address, 300n, 450n, 9_999_999_999n] })).rejects.toThrow(/InvalidLeash/);
    await open(await quote());
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.owner.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "updateLeash",
      args: [leashId, deployment.accounts.owner.address, 100n, 100n, 9_999_999_999n] })).rejects.toThrow(/BudgetExceeded/);
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "killLeash", args: [leashId] }));
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.owner.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "updateLeash",
      args: [leashId, deployment.accounts.owner.address, 300n, 450n, 9_999_999_999n] })).rejects.toThrow(/LeashInactive/);
  });

  it("allows any relayer to settle actual usage and returns the unused balance atomically", async () => {
    const q = await quote(); await open(q); await advance(5);
    const s = await settlement(q.runId, 4n, 50n); await settle(s.data, s.signature);
    expect(await balance()).toBe(1_910n);
    expect((await leash()).pending).toBe(0n); expect((await leash()).spentHour).toBe(90n);
    expect((await run(q.runId)).status).toBe(2);
    expect(await local.publicClient.readContract({ address: deployment.tokenAddress, abi: tokenAbi,
      functionName: "balanceOf", args: [deployment.accounts.treasury.address] })).toBe(90n);
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [s.data, s.signature] })).rejects.toThrow(/InvalidRun/);
  });

  it("blocks new runs after kill but pays work accepted before kill, with a wall-time cutoff", async () => {
    const q = await quote(); await open(q); await advance(3);
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "killLeash", args: [leashId] }));
    await expect(simulateOpen(await quote())).rejects.toThrow(/LeashInactive/);
    await advance(30);
    const bad = await settlement(q.runId, 10n);
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [bad.data, bad.signature] })).rejects.toThrow(/InvalidSettlement/);
    const accepted = await settlement(q.runId, 3n, 50n); await settle(accepted.data, accepted.signature);
    expect(await balance()).toBe(1_920n);
  });

  it("a stop stamps the cutoff without permitting an immediate unearned full refund", async () => {
    const q = await quote(); await open(q); await advance(2);
    await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "requestStop", args: [q.runId] }));
    expect((await run(q.runId)).stopAt).toBeGreaterThan(0n);
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.owner.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "refundRun", args: [q.runId] })).rejects.toThrow(/RefundNotReady/);
    await advance(20);
    const bad = await settlement(q.runId, 10n);
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [bad.data, bad.signature] })).rejects.toThrow(/InvalidSettlement/);
  });

  it("permits full timeout refund by an unrelated caller and excludes all later settlements", async () => {
    const q = await quote(); await open(q); await advance(21_611);
    const s = await settlement(q.runId, 10n, 50n);
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [s.data, s.signature] })).rejects.toThrow(/InvalidSettlement/);
    await confirmed(outsider.writeContract({ account: deployment.accounts.outsider, chain: localChain,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "refundRun", args: [q.runId] }));
    expect(await balance()).toBe(2_000n); expect((await leash()).pending).toBe(0n); expect((await run(q.runId)).status).toBe(3);
  });

  it("has no overlap between settlement and refund at the exact grace boundary", async () => {
    const q = await quote(); await open(q);
    const deadline = await local.publicClient.readContract({ address: deployment.escrowAddress, abi: escrowAbi,
      functionName: "refundAt", args: [q.runId] });
    await deployment.testClient.setNextBlockTimestamp({ timestamp: deadline });
    await deployment.testClient.mine({ blocks: 1 });
    const s = await settlement(q.runId, 0n);
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.owner.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [s.data, s.signature] })).rejects.toThrow(/InvalidSettlement/);
    await local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "refundRun", args: [q.runId] });
  });

  it("accepts a signed zero-charge failure receipt and rejects empty/reused hashes and partial inference fees", async () => {
    const q = await quote(); await open(q);
    const failed = await settlement(q.runId, 0n); await settle(failed.data, failed.signature);
    expect(await balance()).toBe(2_000n);
    const next = await quote(); await open(next);
    for (const data of [
      { ...failed.data, runId: next.runId },
      { runId: next.runId, billableSeconds: 0n, inferenceCharge: 0n, receiptHash: `0x${"0".repeat(64)}` as Hex },
      { runId: next.runId, billableSeconds: 0n, inferenceCharge: 25n, receiptHash: hash() },
    ]) {
      const signature = await deployment.accounts.signer.signTypedData(settlementTypedData(31337, deployment.escrowAddress, data));
      await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
        address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [data, signature] })).rejects.toThrow(/InvalidSettlement/);
    }
  });

  it("rejects fake signer, premature seconds and ceilings beyond the 120-second pilot", async () => {
    await expect(simulateOpen(await quote({ maxSeconds: 121n }))).rejects.toThrow(/InvalidQuote/);
    await expect(simulateOpen(await quote({ pricePerSecond: (1n << 96n) - 1n }))).rejects.toThrow(/InvalidQuote/);
    await expect(simulateOpen(await quote({ quoteExpiry: 1n }))).rejects.toThrow(/InvalidQuote/);
    const q = await quote(); await open(q);
    const premature = await settlement(q.runId, 10n);
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [premature.data, premature.signature] })).rejects.toThrow(/InvalidSettlement/);
    const data = (await settlement(q.runId, 0n)).data;
    const fake = await deployment.accounts.outsider.signTypedData(settlementTypedData(31337, deployment.escrowAddress, data));
    await expect(local.publicClient.simulateContract({ account: deployment.accounts.outsider.address,
      address: deployment.escrowAddress, abi: escrowAbi, functionName: "settleRun", args: [data, fake] })).rejects.toThrow(/InvalidSignature/);
  });

  it("resists token callback reentrancy and rolls back fee-on-transfer deposits", async () => {
    const evil = deployment.artifacts.TestAdversarialToken; const escrow = deployment.artifacts.TelomereRunEscrow;
    if (!evil || !escrow) throw new Error("Adversarial fixture missing");
    async function deploy(bytecode: Hex, abi: Abi, args: readonly unknown[]): Promise<Address> {
      const receipt = await confirmed(owner.deployContract({ account: deployment.accounts.owner, chain: localChain, abi, bytecode, args }));
      if (!receipt.contractAddress) throw new Error("Fixture deployment failed"); return receipt.contractAddress;
    }
    for (const feeMode of [false, true]) {
      const token = await deploy(evil.bytecode, evil.abi, [feeMode]);
      const contract = await deploy(escrow.bytecode, escrow.abi,
        [token, deployment.accounts.signer.address, deployment.accounts.signer.address, deployment.accounts.treasury.address]);
      for (const [functionName, args] of [["faucet", [deployment.accounts.owner.address, 100n]],
        ["approve", [contract, 100n]], ["configureAttack", [contract, encodeFunctionData({ abi: escrowAbi, functionName: "deposit", args: [1n] })]]] as const) {
        await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain, address: token, abi: evil.abi, functionName, args }));
      }
      if (feeMode) {
        await expect(local.publicClient.simulateContract({ account: deployment.accounts.owner.address,
          address: contract, abi: escrowAbi, functionName: "deposit", args: [100n] })).rejects.toThrow(/UnsupportedToken/);
      } else {
        await confirmed(owner.writeContract({ account: deployment.accounts.owner, chain: localChain,
          address: contract, abi: escrowAbi, functionName: "deposit", args: [100n] }));
        expect(await local.publicClient.readContract({ address: token, abi: evil.abi, functionName: "reentrySucceeded" })).toBe(false);
        expect(await local.publicClient.readContract({ address: contract, abi: escrowAbi,
          functionName: "availableBalance", args: [deployment.accounts.owner.address] })).toBe(100n);
      }
    }
  });
});
