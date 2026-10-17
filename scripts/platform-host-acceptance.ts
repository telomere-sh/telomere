import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWalletClient, http, type Hex } from 'viem';
import { startLocalChain, deployLocalContracts, unusedLocalPort } from './local-chain.js';
import { startPilot } from '../src/main.js';
import { loadConfig } from '../src/config.js';
import { localChain } from '../src/chain/chains.js';
import { TelomereClient } from '../src/sdk/index.js';
import { openStore } from '../src/store.js';
import { controllerHostRuns } from '../src/host-kit/controller-schema.js';
import { HourReceiptService } from '../src/receipts/service.js';
import { createReceiptRootReader, verifyHourlyReceipt } from '../src/receipts/verifier.js';

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
check(process.platform === 'linux', 'Actual gVisor acceptance requires Linux');
check(process.env.HOST_KIT_URL === 'http://127.0.0.1:13290', 'This acceptance uses the isolated loopback Host Kit');
const work = await mkdtemp('/opt/telomere-host-runtime/platform-');
const chain = await startLocalChain();
let pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
try {
  const deployed = await deployLocalContracts(chain), port = await unusedLocalPort(), origin = 'http://127.0.0.1:' + port;
  const config = loadConfig({ ...process.env, MODE: 'demo', PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
    RPC_URL: chain.rpcUrl, CHAIN_ID: '31337', DATABASE_URL: '', DATA_DIR: join(work, 'db'),
    ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress,
    SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
    CPU_MODE: 'hostkit', CPU_IMAGE: process.env.HOST_KIT_TASK_IMAGE, CYSTS_ENABLED: 'true', CYSTS_DIR: join(work, 'cysts'),
    CYSTS_REPLICATION_CONFIG: '', SELECTION_ENABLED: 'false', LOG_LEVEL: 'error', NEAR_ENDPOINT: '', NEAR_MODEL: '', NEAR_API_KEY: '' });
  const wallet = createWalletClient({ account: deployed.accounts.owner, chain: localChain, transport: http(chain.rpcUrl, { retryCount: 0 }) });
  async function confirmed(hash: Promise<Hex>) {
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash: await hash }); check(receipt.status === 'success', 'Disposable chain transaction reverted'); return receipt;
  }
  const token = deployed.artifacts.MockToken; check(token, 'Disposable token artifact missing');
  await confirmed(wallet.writeContract({ address: deployed.tokenAddress, abi: token.abi, functionName: 'faucet', args: [deployed.accounts.owner.address, 10000000n] }));
  pilot = await startPilot(config);
  for (const tx of pilot.bridge.depositTransactions(1000000n)) await confirmed(wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n }));
  const leash = await pilot.service.createLeash(deployed.accounts.owner.address, deployed.accounts.owner.address, 1000000n, 1000000n, BigInt(Math.floor(Date.now() / 1000) + 86400));
  await confirmed(wallet.sendTransaction({ to: leash.transaction.to, data: leash.transaction.data, value: 0n }));
  const pins = { chainId: 31337 as const, escrowAddress: deployed.escrowAddress, tokenAddress: deployed.tokenAddress, receiptSigner: deployed.accounts.signer.address };
  let sdk = new TelomereClient({ baseUrl: origin, pins }); await sdk.authenticateDemo({ explicitlyEnabled: true });
  const quote = await sdk.quoteDeadline({ leashId: leash.leashId, task: { kind: 'hash_chain', text: 'actual-gvisor-settlement', iterations: 2000000 },
    maxSeconds: 30, deadline: Math.floor(Date.now() / 1000) + 90, maxSpend: '3000' }, { idempotencyKey: 'actual_host_deadline_001' });
  const tx = quote.walletAction.intents[0]?.transaction; check(tx, 'Original wallet reservation missing');
  const opened = await confirmed(wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n }));
  await sdk.admit(quote.quote.runId, opened.transactionHash);
  await sdk.agents.register(deployed.accounts.owner.address, deployed.accounts.owner.address, quote.quote.runId);
  const until = Date.now() + 45000;
  let run = await sdk.run(quote.quote.runId);
  while (!['completed', 'failed', 'timed_out', 'reconciliation'].includes(run.status) && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 250)); run = await sdk.run(quote.quote.runId);
  }
  check(run.status === 'completed' && run.receipt, 'Real Host Kit task did not settle successfully');
  check((await pilot.service.verifyReceipt(run.receipt)).anchored, 'Actual receipt is not anchored in escrow');
  const evidence = await pilot.service.db.select().from(controllerHostRuns);
  check(evidence.length === 1 && evidence[0]?.cleanupConfirmed && evidence[0].ticks.length > 0
    && evidence[0].ticks.length === evidence[0].acknowledgments.length, 'Signed host evidence or cleanup is incomplete');
  const balance = await sdk.balance(); check(BigInt(balance.available) + BigInt(run.charged ?? '-1') === 1000000n && balance.reserved === '0', 'Owner funds do not conserve');
  await pilot.close(); pilot = undefined;
  pilot = await startPilot(config); sdk = new TelomereClient({ baseUrl: origin, pins }); await sdk.authenticateDemo({ explicitlyEnabled: true });
  const recovered = await sdk.run(quote.quote.runId);
  check(recovered.status === 'completed' && recovered.charged === run.charged && (await sdk.balance()).available === balance.available, 'Restart changed settlement or balance');
  check((await pilot.service.db.select().from(controllerHostRuns)).length === 1, 'Restart redispatched a cell');
  await pilot.close(); pilot = undefined;
  const store = await openStore(config);
  try {
    const signerSet = deployed.artifacts.SignerSet, receiptRoot = deployed.artifacts.ReceiptRoot; check(signerSet && receiptRoot, 'Hourly root artifacts missing');
    const signerSetTx = await confirmed(wallet.deployContract({ abi: signerSet.abi, bytecode: signerSet.bytecode, args: [deployed.accounts.owner.address, deployed.accounts.signer.address] }));
    check(signerSetTx.contractAddress, 'SignerSet deployment missing');
    const rootTx = await confirmed(wallet.deployContract({ abi: receiptRoot.abi, bytecode: receiptRoot.bytecode, args: [signerSetTx.contractAddress] }));
    check(rootTx.contractAddress, 'ReceiptRoot deployment missing');
    const proofPins = { ...pins, receiptRootAddress: rootTx.contractAddress }, hour = Math.floor(Date.now() / 3600000);
    const receipts = new HourReceiptService(store.db, proofPins, () => (hour + 2) * 3600000);
    const batch = await receipts.seal(hour); check(batch.leafCount === 1, 'Hourly batch did not include the real host receipt');
    const publication = await receipts.preparePublication(hour); check(publication, 'Root publication plan unavailable');
    await deployed.testClient.setNextBlockTimestamp({ timestamp: BigInt((hour + 1) * 3600 + 1) });
    const publisher = createWalletClient({ account: deployed.accounts.signer, chain: localChain, transport: http(chain.rpcUrl, { retryCount: 0 }) });
    await confirmed(publisher.sendTransaction({ to: publication.transaction.to, data: publication.transaction.data, value: 0n }));
    const proof = await receipts.proof(deployed.accounts.owner.address, quote.quote.runId);
    const verified = await verifyHourlyReceipt(proof, proofPins, createReceiptRootReader(chain.rpcUrl));
    check(verified.onchain_verified, 'Real receipt Merkle root was not verified against its chain');
    const report = { status: 'passed', checkedAt: new Date().toISOString(), chainId: 31337, isolation: 'gvisor', image: config.CPU_IMAGE,
      runId: run.id, billableSeconds: run.billableSeconds, charged: run.charged, refund: run.refund,
      signedHostTicks: evidence[0].ticks.length, signedControlAcknowledgments: evidence[0].acknowledgments.length,
      actualEscrowSettlement: true, ownerBalanceConserved: true, restartWithoutRedispatch: true,
      hourlyRootPublishedAndRpcVerified: true, publicTransactions: 0, paidProviderRequests: 0, privateKeysIncluded: false };
    await writeFile(join(work, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (process.env.PLATFORM_ACCEPTANCE_REPORT) await writeFile(process.env.PLATFORM_ACCEPTANCE_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally { await store.close(); }
} finally { await pilot?.close(); await chain.close(); }
