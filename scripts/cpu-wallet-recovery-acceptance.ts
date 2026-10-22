import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { createWalletClient, http, type Hex } from 'viem';
import { startLocalChain, deployLocalContracts } from './local-chain.js';
import { localChain } from '../src/chain/chains.js';
import { loadConfig } from '../src/config.js';
import { ChainBridge } from '../src/bridge.js';
import { Service } from '../src/service.js';
import { Worker } from '../src/worker.js';
import { openStore, jobs, transactions } from '../src/store.js';
import { bytes32Schema } from '../src/common.js';
import { tokenAbi } from '../src/chain/abi.js';
import { createDemoCpuExecutor } from '../src/runtime/index.js';
import { inspectCpuReservation } from '../src/chain/wallet-recovery.js';

function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }

export async function cpuWalletRecoveryAcceptance() {
  const chain = await startLocalChain();
  let store: Awaited<ReturnType<typeof openStore>> | undefined, worker: Worker | undefined;
  try {
    check(new URL(chain.rpcUrl).hostname === '127.0.0.1' && await chain.publicClient.getChainId() === 31337, 'Disposable local chain required');
    const deployed = await deployLocalContracts(chain);
    const config = loadConfig({ MODE: 'demo', CPU_MODE: 'demo', CHAIN_ID: '31337', RPC_URL: chain.rpcUrl,
      TOKEN_ADDRESS: deployed.tokenAddress, ESCROW_ADDRESS: deployed.escrowAddress, SIGNER_PRIVATE_KEY: deployed.keys.signer,
      DEMO_PRIVATE_KEY: deployed.keys.owner, DATA_DIR: ':memory:' });
    store = await openStore(config);
    const bridge = new ChainBridge(config), service = new Service(store.db, bridge, config, false);
    await bridge.check();
    const owner = deployed.accounts.owner.address;
    const wallet = createWalletClient({ account: deployed.accounts.owner, chain: localChain, transport: http(chain.rpcUrl, { retryCount: 0 }) });
    const confirmed = async (pending: Promise<Hex>) => {
      const receipt = await chain.publicClient.waitForTransactionReceipt({ hash: await pending });
      check(receipt.status === 'success', 'Local wallet transaction reverted');return receipt.transactionHash;
    };
    await confirmed(wallet.writeContract({ address: config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'faucet', args: [owner, 1_000_000n] }));
    for (const tx of bridge.depositTransactions(1_000_000n)) await confirmed(wallet.sendTransaction({ to: tx.to, data: tx.data }));
    check((await bridge.balance(owner)).available === '1000000', 'Deposit balance differs');
    const leash = await service.createLeash(owner, owner, 100_000n, 1_000_000n, (await chain.publicClient.getBlock()).timestamp + 86400n);
    await confirmed(wallet.sendTransaction({ to: leash.transaction.to, data: leash.transaction.data }));
    const leashId = bytes32Schema.parse(leash.leashId), cases = [];
    worker = new Worker(store.db, bridge, createDemoCpuExecutor(), undefined, pino({ enabled: false }));worker.start();
    let totalCharged = 0n;
    for (let sequence = 1; sequence <= 2; sequence++) {
      const quote = await service.quote(owner, { leashId, maxSeconds: 30, task: { kind: 'hash_chain', text: 'wallet-recovery-'+sequence, iterations: 2_000_000 } }, 'wallet-recovery-'+sequence);
      const runId = quote.quote.runId;
      const sent = await confirmed(wallet.sendTransaction({ to: quote.transaction.to, data: quote.transaction.data }));
      // Deliberately omit the wallet response from admission. Recovery must find
      // the original on-chain event, rather than submit a second openRun.
      const recovered = await inspectCpuReservation(service, owner, runId);
      check(recovered.state === 'transaction_found' && recovered.hash === sent, 'Original wallet transaction was not recovered');
      await service.admit(owner, runId, recovered.hash);await service.admit(owner, runId, recovered.hash);
      const deadline = Date.now() + 60000;
      while ((await service.requireJob(owner, runId)).status !== 'completed') {
        const row = await service.requireJob(owner, runId);
        check(!['failed','reconciliation','cancelled','timed_out'].includes(row.status) && Date.now() < deadline, 'CPU execution/settlement failed');
        await delay(100);
      }
      const row = await service.requireJob(owner, runId), receipt = await service.verifyReceipt(row.receipt);
      const charge = BigInt(row.charged ?? '-1'), refund = BigInt(row.refund ?? '-1');
      check(charge > 0n && charge + refund === BigInt(quote.ceiling), 'Positive charge and unused reserve must equal the original ceiling');
      check(receipt.valid && 'anchored' in receipt && receipt.anchored, 'Receipt signature/settlement verification failed');
      const journal = await store.db.select().from(transactions).where(eq(transactions.runId, runId));
      check(journal.length === 1 && journal[0]?.hash === row.settlementTxHash, 'Exactly one settlement is required');
      const replay = await inspectCpuReservation(service, owner, runId);
      check(replay.state === 'transaction_found' && replay.hash === sent, 'Completed recovery lost the original hash');
      await service.admit(owner, runId, replay.hash);
      totalCharged += charge;
      cases.push({ runId, reservationHash: sent, settlementHash: row.settlementTxHash, chargedAtomic: String(charge), refundAtomic: String(refund),
        billableSeconds: row.billableSeconds, receiptValid: true, receiptAnchored: true, settlementCount: journal.length, lostHashRecovered: true });
    }
    const available = BigInt((await bridge.balance(owner)).available);check(available === 1_000_000n - totalCharged, 'Available balance includes a duplicate charge');
    const withdrawal = bridge.withdrawTransaction(available);await confirmed(wallet.sendTransaction({ to: withdrawal.to, data: withdrawal.data }));
    const balance = (address: typeof owner) => chain.publicClient.readContract({ address: config.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'balanceOf', args: [address] });
    check((await bridge.balance(owner)).available === '0' && await balance(config.ESCROW_ADDRESS) === 0n, 'Escrow was not fully withdrawn');
    check(await balance(owner) === available && await balance(deployed.accounts.treasury.address) === totalCharged, 'Owner and treasury balances differ');
    const expired = await service.quote(owner, { leashId, maxSeconds: 10, task: { kind: 'sha256', text: 'never submitted' } }, 'wallet-recovery-expired');
    await deployed.testClient.increaseTime({ seconds: 601 });await deployed.testClient.mine({ blocks: 1 });
    check((await inspectCpuReservation(service, owner, expired.quote.runId)).state === 'expired_unused', 'Unused expired quote remained blocked');
    check((await store.db.select().from(jobs).where(eq(jobs.id, expired.quote.runId)))[0]?.txHash === null, 'Read-only expiry check mutated admission');
    const report = { passed: true, chainId: 31337, asset: 'local six-decimal MockToken', mainnetTransactions: 0,
      cpuExecutor: 'local process; production sandbox unchanged', cases, totalChargedAtomic: String(totalCharged), withdrawnAtomic: String(available),
      finalEscrowAtomic: '0', expiredUnusedVerified: true, duplicateAdmissionsDidNotChargeAgain: true };
    await mkdir('.local', { recursive: true });await writeFile('.local/cpu-wallet-recovery-acceptance.json', JSON.stringify(report, null, 2)+'\n');
    return report;
  } finally { await worker?.stop();await store?.close();await chain.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cpuWalletRecoveryAcceptance().then(report => process.stdout.write(JSON.stringify(report)+'\n')).catch(error => {
    process.stderr.write(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'acceptance_failed' })+'\n');process.exitCode = 1;
  });
}
