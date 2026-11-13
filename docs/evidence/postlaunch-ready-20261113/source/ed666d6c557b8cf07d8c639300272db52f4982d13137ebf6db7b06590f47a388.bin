import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, type Hex } from 'viem';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { deployLocalContracts, startLocalChain } from '../scripts/local-chain.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { jobs, openStore } from '../src/store.js';
import { Service, type SignedReceipt } from '../src/service.js';
import { Auth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { tokenAbi, escrowAbi } from '../src/chain/abi.js';
import { localChain } from '../src/chain/chains.js';
import { RunMeter } from '../src/runtime/meter.js';
import { hashJson } from '../src/common.js';
import type { PublicReceiptReport } from '../src/receipts/public-verifier.js';

describe('public verifier against actual disposable escrow events', () => {
  let local: Awaited<ReturnType<typeof startLocalChain>>;
  let deployed: Awaited<ReturnType<typeof deployLocalContracts>>;
  let store: Awaited<ReturnType<typeof openStore>>;
  let app: ReturnType<typeof createApp>, bridge: ChainBridge, receipt: SignedReceipt, settlementTxHash: Hex;
  let runId: Hex;
  const origin = 'http://127.0.0.1:3280';
  async function verify(body: unknown, suppliedOrigin = origin) {
    return app.request('/api/public/receipts/verify', { method: 'POST',
      headers: { Origin: suppliedOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  beforeAll(async () => {
    local = await startLocalChain(); deployed = await deployLocalContracts(local);
    const config = loadConfig({ MODE: 'demo', RPC_URL: local.rpcUrl, SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      TOKEN_ADDRESS: deployed.tokenAddress, ESCROW_ADDRESS: deployed.escrowAddress, DATA_DIR: ':memory:', PUBLIC_ORIGIN: origin });
    store = await openStore(config); bridge = new ChainBridge(config);
    const service = new Service(store.db, bridge, config, false);
    app = createApp(service, new Auth(store.db, config), pino({ level: 'silent' }));
    const wallet = createWalletClient({ chain: localChain, transport: http(local.rpcUrl), account: deployed.accounts.owner });
    async function send(hash: Hex) { await local.publicClient.waitForTransactionReceipt({ hash }); }
    await send(await wallet.writeContract({ address: deployed.tokenAddress, abi: tokenAbi, functionName: 'faucet', args: [wallet.account.address, 1000000n] }));
    await send(await wallet.writeContract({ address: deployed.tokenAddress, abi: tokenAbi, functionName: 'approve', args: [deployed.escrowAddress, 1000000n] }));
    await send(await wallet.writeContract({ address: deployed.escrowAddress, abi: escrowAbi, functionName: 'deposit', args: [1000000n] }));
    const leashId = '0x' + 'aa'.repeat(32) as Hex, now = (await local.publicClient.getBlock()).timestamp;
    await send(await wallet.writeContract({ address: deployed.escrowAddress, abi: escrowAbi, functionName: 'createLeash',
      args: [leashId, wallet.account.address, 100000n, 100000n, now + 3600n] }));
    const quote = await service.quote(wallet.account.address, { leashId, task: { kind: 'sha256', text: 'PRIVATE_TASK_DATA' }, maxSeconds: 60 }, 'public-verifier-chain-test');
    runId = quote.quote.runId;
    await send(await wallet.sendTransaction({ to: quote.transaction.to, data: quote.transaction.data }));
    const meter = new RunMeter(runId, 60); await meter.emit('completed', 2500, 'PRIVATE_RESULT_DATA');
    const body = { version: 1, runId, payer: wallet.account.address, leashId, workloadHash: quote.quote.workloadHash,
      cpu: { billableSeconds: 2, measuredSeconds: 2, pricePerSecond: '100', ticks: meter.ticks }, near: null,
      billing: { token: deployed.tokenAddress, ceiling: '6000', charged: '200', refund: '5800' } };
    const receiptHash = hashJson(body), settlement = { runId, billableSeconds: 2n, inferenceCharge: 0n, receiptHash };
    receipt = { body, receiptHash, settlement: { runId, billableSeconds: '2', inferenceCharge: '0', receiptHash },
      signature: await bridge.signSettlement(settlement), signer: bridge.account.address, domain: bridge.domain };
    await deployed.testClient.increaseTime({ seconds: 3 }); await deployed.testClient.mine({ blocks: 1 });
    settlementTxHash = await bridge.wallet.writeContract({ address: deployed.escrowAddress, abi: escrowAbi,
      functionName: 'settleRun', args: [settlement, receipt.signature] });
    await send(settlementTxHash);
    await store.db.update(jobs).set({ receipt, settlementTxHash, status: 'completed', output: 'PRIVATE_RESULT_DATA' }).where(eq(jobs.id, runId));
    await deployed.testClient.mine({ blocks: 12 });
  }, 90000);
  afterAll(async () => { await store?.close(); await local?.close(); });
  it('verifies a run ID without a session and without leaking input or output', async () => {
    const nonce = await local.publicClient.getTransactionCount({ address: bridge.account.address });
    const response = await verify({ runId }); expect(response.status).toBe(200);
    const result = await response.json() as PublicReceiptReport;
    expect(result.outcome).toBe('verified'); expect(result.summary).toMatchObject({ settlementTxHash, charged: '200', refund: '5800' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|"body":|"receipt":|"owner":|"output":/);
    expect(await local.publicClient.getTransactionCount({ address: bridge.account.address })).toBe(nonce);
  });
  it('verifies pasted signed JSON and rejects a different real transaction', async () => {
    expect((await (await verify({ receipt })).json() as PublicReceiptReport).outcome).toBe('verified');
    const wrongHash = await bridge.wallet.sendTransaction({ to: deployed.accounts.owner.address, value: 0n });
    await local.publicClient.waitForTransactionReceipt({ hash: wrongHash });
    const result = await (await verify({ receipt, settlementTxHash: wrongHash })).json() as PublicReceiptReport;
    expect(result.outcome).toBe('invalid'); expect(result.steps.find(step => step.id === 'settlement')?.status).toBe('failed');
  });
  it('keeps private run APIs authenticated and rejects foreign Origin', async () => {
    expect((await app.request('/api/runs/' + runId)).status).toBe(401);
    expect((await verify({ runId }, 'https://evil.invalid')).status).toBe(403);
  });
  it('limits the public RPC surface per client', async () => {
    // Four successful requests plus the wrong-Origin attempt already used this client bucket.
    const responses = [];
    for (let i = 0; i < 7; ++i) responses.push(await verify({ receipt: {} }));
    expect(responses.some(response => response.status === 429)).toBe(true);
  });
});
