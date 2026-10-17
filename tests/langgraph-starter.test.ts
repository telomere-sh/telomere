import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createWalletClient, decodeFunctionData, http, type Hex } from 'viem';
import { it, expect } from 'vitest';
import { deployLocalContracts, startLocalChain, unusedLocalPort } from '../scripts/local-chain.js';
import { localChain } from '../src/chain/index.js';
import { escrowAbi } from '../src/chain/abi.js';
import { loadConfig } from '../src/config.js';
import { startPilot } from '../src/main.js';

const python = process.env.TELOMERE_LANGGRAPH_PYTHON;

it.skipIf(!python)('runs the LangGraph wallet interrupt against the actual paid controller and local escrow', async () => {
  const local = await startLocalChain();
  const root = await mkdtemp(join(tmpdir(), 'telomere-langgraph-'));
  let pilot: Awaited<ReturnType<typeof startPilot>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const deployed = await deployLocalContracts(local);
    const port = await unusedLocalPort(), origin = 'http://127.0.0.1:' + port;
    pilot = await startPilot(loadConfig({ MODE: 'demo', CPU_MODE: 'demo', DATA_DIR: join(root, 'db'),
      HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin, RPC_URL: local.rpcUrl, LOG_LEVEL: 'error',
      SIGNER_PRIVATE_KEY: deployed.keys.signer, DEMO_PRIVATE_KEY: deployed.keys.owner,
      ESCROW_ADDRESS: deployed.escrowAddress, TOKEN_ADDRESS: deployed.tokenAddress }));
    const wallet = createWalletClient({ account: deployed.accounts.owner, chain: localChain,
      transport: http(local.rpcUrl, { retryCount: 0 }) });
    async function confirmed(hash: Promise<Hex>) {
      const receipt = await local.publicClient.waitForTransactionReceipt({ hash: await hash });
      expect(receipt.status).toBe('success'); return receipt;
    }
    const send = (tx: { to: `0x${string}`; data: `0x${string}` }) => confirmed(wallet.sendTransaction({
      account: deployed.accounts.owner, chain: localChain, to: tx.to, data: tx.data, value: 0n }));
    const token = deployed.artifacts.MockToken;
    if (!token) throw new Error('Missing disposable token artifact');
    await confirmed(wallet.writeContract({ account: deployed.accounts.owner, chain: localChain, address: deployed.tokenAddress,
      abi: token.abi, functionName: 'faucet', args: [deployed.accounts.owner.address, 10_000_000n] }));
    for (const tx of pilot.bridge.depositTransactions(1_000_000n)) await send(tx);
    const leash = await pilot.service.createLeash(deployed.accounts.owner.address, deployed.accounts.owner.address,
      1_000_000n, 1_000_000n, BigInt(Math.floor(Date.now() / 1000) + 86_400));
    await send(leash.transaction);

    child = spawn(python!, [resolve('python/examples/langgraph_paid_cpu.py'),
      '--origin', origin, '--chain-id', '31337', '--escrow-address', deployed.escrowAddress,
      '--token-address', deployed.tokenAddress, '--receipt-signer', pilot.bridge.account.address,
      '--leash-id', leash.leashId, '--idempotency-key', 'langgraph_actual_cell_001',
      '--text', 'LangGraph local paid Cell', '--max-seconds', '5', '--poll-seconds', '20', '--demo-auth'],
    { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      SIGNER_PRIVATE_KEY: '', DEMO_PRIVATE_KEY: '', PYTHONUNBUFFERED: '1' } });
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) throw new Error('LangGraph process pipes unavailable');
    const processExit = once(child, 'exit');
    const lines = createInterface({ input: stdout })[Symbol.asyncIterator]();
    let errors = '';
    stderr.on('data', value => { errors += String(value); });
    const next = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for LangGraph output: ' + errors)), 45_000);
      });
      let line: IteratorResult<string>;
      try { line = await Promise.race([lines.next(), deadline]); }
      finally { if (timer) clearTimeout(timer); }
      if (line.done) throw new Error('LangGraph exited before a result: ' + errors);
      return JSON.parse(line.value) as Record<string, any>;
    };
    const walletAction = await next();
    expect(walletAction).toMatchObject({ type: 'wallet_action', ceiling: '500',
      walletAction: { purpose: 'open', requiresWallet: true, runId: walletAction.runId } });
    const intent = walletAction.walletAction.intents[0];
    expect(intent.chainId).toBe(31337);
    expect(intent.to.toLowerCase()).toBe(deployed.escrowAddress.toLowerCase());
    const decoded = decodeFunctionData({ abi: escrowAbi, data: intent.data });
    expect(decoded.functionName).toBe('openRun');
    expect((decoded.args?.[0] as { runId: string }).runId).toBe(walletAction.runId);
    expect((await pilot.bridge.run(walletAction.runId)).status).toBe(0);
    const nonceBefore = await local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address });
    const receipt = await send({ to: intent.to, data: intent.data });
    stdin.write(receipt.transactionHash + '\n');
    const final = await next();
    expect(final).toMatchObject({ type: 'run_status', runId: walletAction.runId,
      admitted: { id: walletAction.runId }, observed: { id: walletAction.runId, status: 'completed' } });
    expect((await local.publicClient.getTransactionCount({ address: deployed.accounts.owner.address })) - nonceBefore).toBe(1);
    const [code] = await processExit;
    expect(code, errors).toBe(0);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await pilot?.close();
    await local.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('telomere-langgraph-')) {
      throw new Error('Unsafe fixture cleanup');
    }
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
