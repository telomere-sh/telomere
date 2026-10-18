import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, keccak256, parseEther, toHex,
  type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileContracts } from '../scripts/compile-contracts.js';
import { startLocalChain } from '../scripts/local-chain.js';
import { escrowAbi, tokenAbi, localChain, quoteTypedData, settlementTypedData, type Quote, type Settlement } from '../src/chain/index.js';

// A separate cash-flow ledger derives every expected balance and pending amount
// from accepted operations. It never initializes expected values from contract storage.
const extended = process.env.TELOMERE_ESCROW_EXTENDED_ACCEPTANCE === '1';
const seeds = [0x71a4c901, 0xc0ffee19, 0x5eed2026, ...(extended ? [0x10203040, 0xabcdef01, 0x76543210,
  0x31337001, 0x84530001, 0xdeadbeef, 0xf00dcafe, 0x6a09e667, 0xbb67ae85, 0x3c6ef372,
  0xa54ff53a, 0x510e527f, 0x9b05688c] : [])];
const steps = extended ? 512 : 240;
const supply = 1_000_000n;
type Leash = { id: Hex; owner: number; hour: bigint; day: bigint; expiry: bigint; killedAt?: bigint };
type Run = { quote: Quote; owner: number; openedAt: bigint; expiry: bigint; stopAt?: bigint;
  state: 'open' | 'settled' | 'refunded'; settledAt?: bigint; charged: bigint; receipt?: Hex; settlement?: Settlement };
const ceiling = (quote: Quote) => quote.maxSeconds * quote.pricePerSecond + quote.inferencePrice;

describe('seeded real-EVM escrow campaigns with independent cash accounting', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  const owners = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const signer = privateKeyToAccount(generatePrivateKey()), treasury = privateKeyToAccount(generatePrivateKey());
  let token: Address, escrow: Address, snapshot: Hex;

  beforeAll(async () => {
    local = await startLocalChain();
    const test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    for (const account of [...owners, signer, treasury]) await test.setBalance({ address: account.address, value: parseEther('10') });
    const artifacts = compileContracts(['MockToken.sol', 'TelomereRunEscrow.sol']);
    const wallet = createWalletClient({ account: owners[0]!, chain: localChain, transport: http(local.rpcUrl) });
    const tokenArtifact = artifacts.MockToken!, escrowArtifact = artifacts.TelomereRunEscrow!;
    const tokenReceipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode }) });
    if (!tokenReceipt.contractAddress) throw new Error('Campaign token deployment missing');
    token = tokenReceipt.contractAddress;
    const escrowReceipt = await local.publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: escrowArtifact.abi,
      bytecode: escrowArtifact.bytecode, args: [token, signer.address, signer.address, treasury.address] }) });
    if (!escrowReceipt.contractAddress) throw new Error('Campaign escrow deployment missing');
    escrow = escrowReceipt.contractAddress;
    for (const account of owners) {
      const owner = createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl) });
      await local.publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: token, abi: tokenArtifact.abi,
        functionName: 'faucet', args: [account.address, supply] }) });
      await local.publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: token, abi: tokenAbi,
        functionName: 'approve', args: [escrow, supply] }) });
    }
    snapshot = await test.snapshot();
  }, 60_000);
  afterAll(async () => { await local?.close(); });

  it.each(seeds)(`preserves funds and reservation authority through ${steps} mixed steps, seed %s`, async seed => {
    const test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(local.rpcUrl) });
    await test.revert({ id: snapshot }); snapshot = await test.snapshot();
    // A snapshot may rewind block numbers and repeat otherwise identical tx hashes.
    // Give each campaign a fresh observer identity and an explicit polling deadline.
    const publicClient = createPublicClient({ chain: localChain, transport: http(local.rpcUrl, { retryCount: 0, timeout: 5000 }),
      cacheTime: 0, pollingInterval: 10 });
    let state = seed >>> 0, serial = 0, clock = (await publicClient.getBlock()).timestamp;
    const random = (max: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
    const id = () => keccak256(toHex(`telomere-campaign-${seed}-${serial++}`));
    const wallets = owners.map(account => createWalletClient({ account, chain: localChain, transport: http(local.rpcUrl), cacheTime: 0 }));
    const available = [0n, 0n], walletCash = [supply, supply], leashes: Leash[] = [], runs: Run[] = [];
    let earned = 0n, deposits = 0n, withdrawals = 0n;
    const trace: { handler: string; accepted: boolean; observedStatus: 'success' | 'reverted'; hash: Hex; timestamp: string }[] = [];
    const handlers: Record<string, { calls: number; accepted: number; reverted: number }> = {};
    const choose = <T>(values: readonly T[]): T => values[random(values.length)]!;
    const pending = (leash: Leash) => runs.filter(run => run.quote.leashId === leash.id && run.state === 'open')
      .reduce((sum, run) => sum + ceiling(run.quote), 0n);
    const spent = (leash: Leash, period: bigint, at: bigint) => runs.filter(run => run.quote.leashId === leash.id
      && run.state === 'settled' && run.settledAt! / period === at / period).reduce((sum, run) => sum + run.charged, 0n);
    async function transaction(handler: string, owner: number, data: Hex, accepted: boolean) {
      const next = clock + 1n;
      await test.setNextBlockTimestamp({ timestamp: next });
      const hash = await wallets[owner]!.sendTransaction({ to: escrow, data, gas: 1_000_000n,
        maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: BigInt(seed % 1_000_000) + 1n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      expect(block.timestamp, `seed=${seed} handler=${handler} time`).toBe(next); clock = next;
      trace.push({ handler, accepted, observedStatus: receipt.status, hash, timestamp: clock.toString() });
      const record = handlers[handler] ??= { calls: 0, accepted: 0, reverted: 0 };
      record.calls++; record[accepted ? 'accepted' : 'reverted']++;
      expect(receipt.status, `seed=${seed} call=${trace.length} handler=${handler}`).toBe(accepted ? 'success' : 'reverted');
    }
    async function check() {
      const tokenBalance = (address: Address) => publicClient.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
      const [cash0, cash1, treasuryCash, escrowCash, free0, free1] = await Promise.all([
        tokenBalance(owners[0]!.address), tokenBalance(owners[1]!.address), tokenBalance(treasury.address), tokenBalance(escrow),
        ...owners.map(account => publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: 'availableBalance', args: [account.address] })),
      ]);
      const reserved = runs.filter(run => run.state === 'open').reduce((sum, run) => sum + ceiling(run.quote), 0n);
      expect([cash0, cash1]).toEqual(walletCash); expect([free0, free1]).toEqual(available);
      expect(treasuryCash).toBe(earned); expect(escrowCash).toBe(available[0]! + available[1]! + reserved);
      expect(cash0! + cash1! + treasuryCash! + escrowCash!).toBe(2n * supply);
      expect(available[0]! + available[1]! + reserved).toBe(deposits - withdrawals - earned);
      for (const leash of leashes) {
        const actual = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: 'getLeash', args: [leash.id] });
        expect(actual.pending).toBe(pending(leash)); expect(actual.spentHour).toBe(spent(leash, 3600n, clock));
        expect(actual.spentDay).toBe(spent(leash, 86400n, clock)); expect(actual.killed).toBe(leash.killedAt !== undefined);
        expect(actual.maxPerHour).toBe(leash.hour); expect(actual.maxPerDay).toBe(leash.day);
      }
      // Periodic complete history comparison catches mutation of a previous run.
      if (trace.length % 12 === 0) for (const run of runs) {
        const actual = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: 'getRun', args: [run.quote.runId] });
        expect(actual.status).toBe(run.state === 'open' ? 1 : run.state === 'settled' ? 2 : 3);
        expect(actual.ceiling).toBe(ceiling(run.quote)); expect(actual.payer).toBe(owners[run.owner]!.address);
        if (run.settlement) {
          expect(actual.billableSeconds).toBe(run.settlement.billableSeconds);
          expect(actual.inferenceCharge).toBe(run.settlement.inferenceCharge);
          expect(actual.receiptHash).toBe(run.settlement.receiptHash);
        }
      }
    }
    async function deposit(owner: number, amount: bigint) {
      const accepted = walletCash[owner]! >= amount;
      await transaction('deposit', owner, encodeFunctionData({ abi: escrowAbi, functionName: 'deposit', args: [amount] }), accepted);
      if (accepted) { walletCash[owner]! -= amount; available[owner]! += amount; deposits += amount; }
    }
    async function create(owner: number) {
      const leash: Leash = { id: id(), owner, hour: BigInt(300 + random(700)), day: BigInt(1800 + random(1200)), expiry: clock + 200_000n };
      await transaction('create', owner, encodeFunctionData({ abi: escrowAbi, functionName: 'createLeash',
        args: [leash.id, owners[owner]!.address, leash.hour, leash.day, leash.expiry] }), true);
      leashes.push(leash);
    }
    async function open(leash: Leash, forceValid = false) {
      const quote: Quote = { runId: id(), leashId: leash.id, payer: owners[leash.owner]!.address, workloadHash: id(),
        maxSeconds: !forceValid && random(12) === 0 ? 121n : BigInt(2 + random(19)), pricePerSecond: BigInt(1 + random(5)),
        inferencePrice: random(2) ? 7n : 0n, quoteExpiry: clock + 100n };
      const badSignature = !forceValid && random(6) === 0;
      const signature = await (badSignature ? owners[1]! : signer).signTypedData(quoteTypedData(31337, escrow, quote));
      const amount = ceiling(quote), at = clock + 1n;
      const accepted = !badSignature && quote.maxSeconds <= 120n && leash.killedAt === undefined && at < leash.expiry
        && available[leash.owner]! >= amount && spent(leash, 3600n, at) + pending(leash) + amount <= leash.hour
        && spent(leash, 86400n, at) + pending(leash) + amount <= leash.day;
      await transaction('open', leash.owner, encodeFunctionData({ abi: escrowAbi, functionName: 'openRun', args: [quote, signature] }), accepted);
      if (accepted) { available[leash.owner]! -= amount; runs.push({ quote, owner: leash.owner, openedAt: clock, expiry: leash.expiry, state: 'open', charged: 0n }); }
    }
    async function advance(seconds: number) {
      await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); clock = (await publicClient.getBlock()).timestamp;
      const record = handlers.advance ??= { calls: 0, accepted: 0, reverted: 0 }; record.calls++; record.accepted++;
    }
    async function settle(run: Run, forceValid = false) {
      const leash = leashes.find(item => item.id === run.quote.leashId)!;
      const at = clock + 1n, cutoff = [at, run.stopAt ?? at, leash.killedAt ?? at, run.expiry].reduce((a, b) => a < b ? a : b);
      const permitted = [run.quote.maxSeconds, cutoff > run.openedAt ? cutoff - run.openedAt + 1n : 1n].reduce((a, b) => a < b ? a : b);
      const reused = !forceValid && random(5) === 0 ? runs.find(item => item.receipt)?.receipt : undefined;
      const data: Settlement = { runId: run.quote.runId, billableSeconds: forceValid ? permitted : BigInt(random(Number(run.quote.maxSeconds) + 4)),
        inferenceCharge: !forceValid && random(6) === 0 ? 1n : run.quote.inferencePrice, receiptHash: reused ?? id() };
      const badSignature = !forceValid && random(8) === 0;
      const signature = await (badSignature ? owners[0]! : signer).signTypedData(settlementTypedData(31337, escrow, data));
      const charge = data.billableSeconds * run.quote.pricePerSecond + data.inferenceCharge;
      const accepted = run.state === 'open' && at < run.openedAt + run.quote.maxSeconds + 21600n && !badSignature
        && !runs.some(item => item.receipt === data.receiptHash) && data.billableSeconds <= permitted
        && (data.inferenceCharge === 0n || data.inferenceCharge === run.quote.inferencePrice) && charge <= ceiling(run.quote);
      await transaction('settle', 1 - run.owner, encodeFunctionData({ abi: escrowAbi, functionName: 'settleRun', args: [data, signature] }), accepted);
      if (accepted) { run.state = 'settled'; run.charged = charge; run.settledAt = clock; run.receipt = data.receiptHash; run.settlement = data;
        earned += charge; available[run.owner]! += ceiling(run.quote) - charge; }
    }
    async function refund(run: Run) {
      const accepted = run.state === 'open' && clock + 1n >= run.openedAt + run.quote.maxSeconds + 21600n;
      await transaction('refund', 1 - run.owner, encodeFunctionData({ abi: escrowAbi, functionName: 'refundRun', args: [run.quote.runId] }), accepted);
      if (accepted) { run.state = 'refunded'; available[run.owner]! += ceiling(run.quote); }
    }

    let campaignPassed = false, completedSteps = 0;
    try {
      for (let owner = 0; owner < 2; owner++) { await deposit(owner, 10_000n); await create(owner); }
      await open(leashes[0]!, true); await open(leashes[1]!, true); await advance(8); await settle(runs[0]!, true);
      await advance(21631); await refund(runs[1]!); await check();
      if (extended) for (let index = 0; index < 3; index++) {
        await open(leashes[index % 2]!, true); await settle(runs.at(-1)!, true); await check();
      }
      const schedule = ['open', 'open', 'settle', 'deposit', 'withdraw', 'update', 'stop', 'refund', 'advance', 'create', 'kill', 'replay'];
      for (let step = 0; step < steps; step++) {
        const handler = choose(schedule), owner = random(2);
        const active = leashes.filter(leash => leash.killedAt === undefined && leash.expiry > clock + 1n);
        const leash = choose(active.length ? active : leashes);
        const run = runs.length ? choose(runs) : undefined;
        if (handler === 'deposit') await deposit(owner, BigInt(1 + random(500)));
        else if (handler === 'create') await create(owner);
        else if (handler === 'advance') await advance(choose([1, 30, 3601, 21631, 86401]));
        else if (handler === 'open') await open(leash);
        else if (handler === 'settle' && run) await settle(run);
        else if (handler === 'refund' && run) await refund(run);
        else if (handler === 'withdraw') {
          const amount = random(3) ? BigInt(1 + random(600)) : available[owner]! + 1n;
          const accepted = available[owner]! >= amount;
          await transaction(handler, owner, encodeFunctionData({ abi: escrowAbi, functionName: 'withdraw', args: [amount] }), accepted);
          if (accepted) { available[owner]! -= amount; walletCash[owner]! += amount; withdrawals += amount; }
        } else if (handler === 'update') {
          const hour = BigInt(50 + random(1400)), day = BigInt(100 + random(3000)), at = clock + 1n;
          const caller = random(4) ? leash.owner : 1 - leash.owner, expiry = clock + 200_000n;
          const accepted = caller === leash.owner && leash.killedAt === undefined
            && spent(leash, 3600n, at) + pending(leash) <= hour && spent(leash, 86400n, at) + pending(leash) <= day;
          await transaction(handler, caller, encodeFunctionData({ abi: escrowAbi, functionName: 'updateLeash',
            args: [leash.id, owners[leash.owner]!.address, hour, day, expiry] }), accepted);
          if (accepted) Object.assign(leash, { hour, day, expiry });
        } else if (handler === 'kill') {
          const caller = random(4) ? leash.owner : 1 - leash.owner;
          const accepted = caller === leash.owner && leash.killedAt === undefined;
          await transaction(handler, caller, encodeFunctionData({ abi: escrowAbi, functionName: 'killLeash', args: [leash.id] }), accepted);
          if (accepted) leash.killedAt = clock;
        } else if (handler === 'stop' && run) {
          const caller = random(4) ? run.owner : 1 - run.owner;
          const accepted = caller === run.owner && run.state === 'open';
          await transaction(handler, caller, encodeFunctionData({ abi: escrowAbi, functionName: 'requestStop', args: [run.quote.runId] }), accepted);
          if (accepted && run.stopAt === undefined) run.stopAt = clock;
        } else if (handler === 'replay' && run) {
          const signature = await signer.signTypedData(quoteTypedData(31337, escrow, run.quote));
          await transaction(handler, run.owner, encodeFunctionData({ abi: escrowAbi, functionName: 'openRun', args: [run.quote, signature] }), false);
        }
        await check(); completedSteps = step + 1;
      }
      await advance(300_000);
      for (const run of runs.filter(item => item.state === 'open')) { await refund(run); await check(); }
      for (let owner = 0; owner < 2; owner++) if (available[owner]! > 0n) {
        const amount = available[owner]!;
        await transaction('final-withdraw', owner, encodeFunctionData({ abi: escrowAbi, functionName: 'withdraw', args: [amount] }), true);
        available[owner] = 0n; walletCash[owner]! += amount; withdrawals += amount; await check();
      }
      expect(handlers.open!.accepted).toBeGreaterThanOrEqual(5);
      expect(handlers.settle!.accepted).toBeGreaterThanOrEqual(1); expect(handlers.refund!.accepted).toBeGreaterThanOrEqual(1);
      for (const name of new Set(schedule)) expect(handlers[name]?.calls, `seed=${seed} handler=${name}`).toBeGreaterThan(0);
      expect(runs.every(item => item.state !== 'open')).toBe(true);
      campaignPassed = true;
    } finally {
      const directory = resolve('.local/audit-remediation/' + (extended ? 'stateful-extended' : 'stateful')); await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, `seed-${seed}.json`), JSON.stringify({ schemaVersion: 2, seed, scheduledSteps: steps,
        completedScheduledSteps: completedSteps, passed: campaignPassed,
        handlers, transactionCalls: trace.length, expectedReverts: trace.filter(item => !item.accepted).length, discardedCalls: 0,
        observedReverts: trace.filter(item => item.observedStatus === 'reverted').length,
        ghostAccounting: 'Independent owner wallet/escrow/reservation/treasury cash-flow ledger; per-leash spending derived from settlement history',
        invariantsCheckedAfterEveryScheduledStep: campaignPassed, finalEscrowBalance: campaignPassed ? '0' : null, earned: earned.toString(), deposits: deposits.toString(),
        withdrawals: withdrawals.toString(), trace }, null, 2) + '\n');
    }
  }, 180_000);
});
