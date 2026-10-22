import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestClient, createWalletClient, decodeFunctionData, getAbiItem, http, parseEther, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startLocalChain } from '../scripts/local-chain.js';
import { compileContracts } from '../scripts/compile-contracts.js';
import { localChain } from '../src/chain/chains.js';
import { escrowAbi, tokenAbi } from '../src/chain/abi.js';
import { ChainBridge } from '../src/bridge.js';
import { loadConfig } from '../src/config.js';
import { inspectWalletTransaction, walletFundingState, walletRecoveryState } from '../src/chain/wallet-recovery.js';
import { WorkspaceClient } from '../public/workspace-client.js';

// Real loopback EVM and token transfers; only the wallet's response/failure
// behaviour is controlled. A reload creates a new client over persisted storage.
describe('deposit lifecycle against real local escrow contracts', () => {
  let chain: Awaited<ReturnType<typeof startLocalChain>>;
  let test: ReturnType<typeof createTestClient>;
  let wallet: ReturnType<typeof createWalletClient>;
  let token: Address, escrow: Address, bridge: ChainBridge, snapshot: Hex;
  const account = privateKeyToAccount(generatePrivateKey()), signer = privateKeyToAccount(generatePrivateKey());
  const amount = 1_000_000n, opening = 10_000_000n;
  beforeAll(async () => {
    chain = await startLocalChain();
    test = createTestClient({ chain: localChain, mode: 'anvil', transport: http(chain.rpcUrl) });
    await test.setBalance({ address: account.address, value: parseEther('10') });
    wallet = createWalletClient({ account, chain: localChain, transport: http(chain.rpcUrl, { retryCount: 0 }) });
    const artifacts = compileContracts(['MockToken.sol', 'TelomereRunEscrow.sol']);
    const deploy = async (name: string, args: readonly unknown[] = []) => {
      const artifact = artifacts[name]!;
      const hash = await wallet.deployContract({ account, chain: localChain, abi: artifact.abi, bytecode: artifact.bytecode, args });
      const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress || receipt.status !== 'success') throw Error('Local fixture deployment failed');
      return receipt.contractAddress;
    };
    token = await deploy('MockToken');
    escrow = await deploy('TelomereRunEscrow', [token, signer.address, signer.address, signer.address]);
    await chain.publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account, chain: localChain, address: token, abi: tokenAbi, functionName: 'faucet', args: [account.address, opening] }) });
    bridge = new ChainBridge(loadConfig({ MODE: 'demo', CHAIN_ID: '31337', RPC_URL: chain.rpcUrl,
      SIGNER_PRIVATE_KEY: generatePrivateKey(), DEMO_PRIVATE_KEY: generatePrivateKey(),
      ESCROW_ADDRESS: escrow, TOKEN_ADDRESS: token, DATA_DIR: ':memory:' }));
    snapshot = await test.snapshot();
  }, 60000);
  beforeEach(async () => { await test.revert({ id: snapshot }); snapshot = await test.snapshot(); });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await test.setAutomine(true); });
  afterAll(async () => { await chain?.close(); });

  function fixture() {
    const storage = new Map<string, string>(), submissions: { method: string; hash?: Hex }[] = [];
    const state = { reject: '' as string, hold: false, loseHash: false, receiptFailure: false, timeout: false, hangReply: false };
    let resume: (() => void) | undefined;
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    let locked = false;
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, run: (lock: object | null) => unknown) => {
      if (locked) return run(null); locked = true; try { return await run({}); } finally { locked = false; }
    } } });
    const provider = { request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
      if (method === 'eth_accounts') return [account.address];
      if (method === 'eth_chainId') return toHex(31337);
      if (method === 'eth_sendTransaction') {
        const tx = params![0] as { to: Address; data: Hex };
        const call = decodeFunctionData({ abi: tx.to.toLowerCase() === token.toLowerCase() ? tokenAbi : escrowAbi, data: tx.data });
        const row: { method: string; hash?: Hex } = { method: call.functionName }; submissions.push(row);
        if (state.reject === row.method) throw { code: -32603, data: { originalError: { code: 4001 } } };
        if (state.hangReply && row.method === 'deposit') await new Promise<void>(resolve => { resume = resolve; });
        if (state.hold && row.method === 'deposit') await test.setAutomine(false);
        row.hash = await wallet.sendTransaction({ account, chain: localChain, to: tx.to, data: tx.data, gas: 300000n });
        if (state.loseHash && row.method === 'deposit') throw Error('Wallet response lost after broadcast');
        return row.hash;
      }
      if (method === 'eth_getTransactionReceipt') {
        if (state.receiptFailure) throw Error('Wallet receipt RPC unavailable');
        if (state.timeout) { const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 121000); return null; }
        const receipt = await chain.publicClient.getTransactionReceipt({ hash: params![0] as Hex });
        return { status: receipt.status === 'success' ? '0x1' : '0x0' };
      }
      throw Error('Unexpected fixture wallet method: ' + method);
    }) };
    const reload = () => {
      const client = new WorkspaceClient(() => {}, () => {}); client.address = account.address; client.provider = provider as never;
      client.config = { mode: 'demo', chain: { id: 31337, name: 'Local', rpcUrl: chain.rpcUrl },
        token: { address: token, symbol: 'USDC', decimals: 6 }, escrowAddress: escrow, cpuMode: 'docker',
        prices: { cpuPerSecond: '100', maxSeconds: 120 }, platform: { agentLifecycle: false, receiptRootAddress: null }, nearAvailable: false, cystsAvailable: false };
      vi.spyOn(client, 'request').mockImplementation(async path => {
        if (path === '/api/wallet/funding') return walletFundingState(bridge, account.address);
        if (path === '/api/transactions/recovery-state') return walletRecoveryState(bridge, account.address);
        if (path === '/api/balance') return { ...await bridge.balance(account.address), reserved: '0' };
        if (/^\/api\/transactions\/0x[\da-f]{64}$/i.test(path)) return inspectWalletTransaction(bridge, account.address, path.split('/').at(-1) as Hex);
        throw Error('Unexpected fixture API path: ' + path);
      });
      return client;
    };
    const client = reload(), packets = bridge.depositTransactions(amount);
    const deposit = async (current = client) => { await current.ensureDepositFunds(amount.toString()); for (const packet of packets) await current.transaction(packet, 'deposit USDC'); };
    return { client, reload, state, provider, storage, submissions, packets, deposit, resume: () => resume?.(), waitingForReply: () => !!resume };
  }
  async function cash(deposits: number) {
    const logs = await chain.publicClient.getLogs({ address: escrow, event: getAbiItem({ abi: escrowAbi, name: 'Deposited' }), args: { payer: account.address }, fromBlock: 0n, toBlock: 'latest', strict: true });
    expect(logs).toHaveLength(deposits);
    expect(logs.reduce((total, log) => total + log.args.amount, 0n)).toBe(BigInt(deposits) * amount);
    expect(await chain.publicClient.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] })).toBe(opening - BigInt(deposits) * amount);
    expect(await chain.publicClient.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [escrow] })).toBe(BigInt(deposits) * amount);
    expect((await bridge.balance(account.address)).available).toBe((BigInt(deposits) * amount).toString());
  }
  it.each(['approve', 'deposit'])('wallet rejection at %s releases the lock, including after reload; explicit retry debits once', async rejected => {
    const f = fixture(); f.state.reject = rejected;
    await expect(f.deposit()).rejects.toThrow('closed automatically'); expect(f.client.financialBusy).toBe(false); expect(f.client.pending()).toEqual([]); await cash(0);
    const fresh = f.reload(); expect(await fresh.reconcilePending()).toEqual({ state: 'none' });
    f.state.reject = ''; await f.deposit(fresh); await cash(1);
    expect(f.submissions.filter(row => row.method === 'deposit' && row.hash)).toHaveLength(1);
  });
  it('insufficient USDC makes no wallet request and creates no blocker after reload', async () => {
    const f = fixture(); await expect(f.client.ensureDepositFunds((opening + 1n).toString())).rejects.toThrow('USDC');
    expect(f.submissions).toEqual([]); expect(f.reload().pending()).toEqual([]); await cash(0);
    await f.deposit(f.reload()); await cash(1);
  });
  it('a 120-second wait timeout retains the hash across reload; late mining credits exactly once', async () => {
    const f = fixture(); await f.client.transaction(f.packets[0], 'deposit USDC'); f.state.hold = true; f.state.timeout = true;
    await expect(f.client.transaction(f.packets[1], 'deposit USDC')).rejects.toThrow('still pending'); vi.restoreAllMocks();
    const fresh = f.reload(); expect(fresh.pending()[0]?.hash).toBe(f.submissions.at(-1)?.hash); await cash(0);
    const count = f.submissions.length; await expect(fresh.transaction(f.packets[1], 'deposit USDC')).rejects.toThrow('previous transaction');
    await expect(fresh.reconcilePending()).rejects.toThrow('still pending'); expect(f.submissions).toHaveLength(count);
    await test.mine({ blocks: 1 }); f.state.timeout = false;
    expect(await fresh.reconcilePending()).toMatchObject({ state: 'resolved' }); await cash(1);
    expect(fresh.pending()).toEqual([]); expect(await f.reload().reconcilePending()).toEqual({ state: 'none' });
    expect(f.submissions.filter(row => row.method === 'deposit' && row.hash)).toHaveLength(1);
  });
  it('lost hash after actual broadcast stays blocked on reload; original-hash recovery never debits twice', async () => {
    const f = fixture(); await f.client.transaction(f.packets[0], 'deposit USDC'); f.state.loseHash = true;
    await expect(f.client.transaction(f.packets[1], 'deposit USDC')).rejects.toThrow('response lost'); await cash(1);
    const fresh = f.reload(); expect(fresh.pending()[0]?.hash).toBeUndefined(); expect(await fresh.reconcilePending()).toEqual({ state: 'unknown_submission' });
    await expect(fresh.transaction(f.packets[1], 'deposit USDC')).rejects.toThrow('previous transaction');
    await fresh.recover(f.submissions.at(-1)!.hash); expect(fresh.pending()).toEqual([]); await cash(1);
    expect(await f.reload().reconcilePending()).toEqual({ state: 'none' }); expect(f.submissions.filter(row => row.method === 'deposit' && row.hash)).toHaveLength(1);
  });
  it('late approval recovery after reload does not submit the deposit without another explicit action', async () => {
    const f = fixture(); f.state.receiptFailure = true;
    await expect(f.client.transaction(f.packets[0], 'deposit USDC')).rejects.toThrow('RPC unavailable');
    const fresh = f.reload(); expect(await fresh.reconcilePending()).toMatchObject({ state: 'resolved' }); await cash(0); expect(f.submissions).toHaveLength(1);
    f.state.receiptFailure = false; await f.deposit(fresh); await cash(1); expect(f.submissions.filter(row => row.method === 'deposit' && row.hash)).toHaveLength(1);
  });
  it('a hung wallet response blocks duplicate requests; a late response settles once across client recreation', async () => {
    const f = fixture(); await f.client.transaction(f.packets[0], 'deposit USDC'); f.state.hangReply = true;
    const original = f.client.transaction(f.packets[1], 'deposit USDC');
    try {
      await vi.waitFor(() => expect(f.waitingForReply()).toBe(true)); await cash(0);
      await expect(f.client.transaction(f.packets[1], 'deposit USDC')).rejects.toThrow('operation is pending');
      const fresh = f.reload(); expect(fresh.pending()[0]?.hash).toBeUndefined();
      expect(await fresh.reconcilePending()).toEqual({ state: 'unknown_submission' });
      await expect(fresh.transaction(f.packets[1], 'deposit USDC')).rejects.toThrow('Another tab');
      f.resume(); await original; await cash(1);
      expect(f.client.financialBusy).toBe(false); expect(await fresh.reconcilePending()).toEqual({ state: 'none' });
      expect(f.submissions.filter(row => row.method === 'deposit' && row.hash)).toHaveLength(1);
    } finally { f.resume(); await original; }
  });
});
