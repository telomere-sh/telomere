import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createWalletClient, http, keccak256, type Hex, type TransactionSerialized } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localChain } from '../src/chain/chains.js';
import { hashJson } from '../src/common.js';
import { EIP3009_TYPES } from '../src/payments/gateway.js';
import { BaseTopUpCredit, type BaseTopUpPort } from '../src/treasury/base-credit.js';
import { FileTopUpLedger } from '../src/treasury/ledger.js';
import { TreasuryTopUpService } from '../src/treasury/service.js';
import { SolanaTopUpReader } from '../src/treasury/solana-reader.js';
import type { TopUpProfile } from '../src/treasury/types.js';
import { deployVaultIncomeMainFixture } from './fixtures/vault-income-main.js';
import { SolanaTopUpRpcFixture, treasuryTopUpFixtureProfile } from './fixtures/treasury-topups.js';

describe('finite treasury source-to-Base Vault credits (real Anvil, fixture Solana observations)', () => {
  let chain: Awaited<ReturnType<typeof deployVaultIncomeMainFixture>>, snapshot: Hex;
  let root: string, source: SolanaTopUpRpcFixture;
  beforeAll(async () => { chain = await deployVaultIncomeMainFixture(); snapshot = await chain.test.snapshot(); }, 180_000);
  beforeEach(async () => {
    await chain.test.revert({ id: snapshot }); snapshot = await chain.test.snapshot();
    root = await mkdtemp(join(tmpdir(), 'telomere-treasury-topups-')); source = new SolanaTopUpRpcFixture(); await source.start();
  });
  afterEach(async () => {
    await source.close(); const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('telomere-treasury-topups-')) throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  });
  afterAll(async () => { await chain.close(); });
  const owner = () => chain.accounts.owner.address;
  const wallet = () => createWalletClient({ account: chain.facilitator, chain: localChain, transport: http(chain.local.rpcUrl, { retryCount: 0 }) });
  async function build(overrides: Partial<TopUpProfile> = {}, replacement?: (base: BaseTopUpCredit) => BaseTopUpPort) {
    const result = await treasuryTopUpFixtureProfile(chain, root, source, overrides), policyHash = hashJson(result.profile);
    const base = new BaseTopUpCredit(result.profile, chain.local.rpcUrl); await base.initialize();
    const ledger = new FileTopUpLedger(result.profile.journalPath, policyHash);
    const service = new TreasuryTopUpService(result.profile, policyHash, ledger, new SolanaTopUpReader(result.profile.solana), replacement?.(base) ?? base);
    await service.initialize(); return { ...result, service, base, ledger, policyHash };
  }
  async function prepared(service: TreasuryTopUpService, profile: TopUpProfile, clientId = 'source-credit-1', amountMicros = '100000') {
    const { invoice } = await service.create(owner(), { clientId, amountMicros });
    const signature = source.add(invoice), observed = await service.observe(owner(), invoice.id, signature), auth = observed.authorization;
    if (!auth) throw new Error('Missing exact treasury authorization plan');
    const treasurySignature = await chain.accounts.outsider.signTypedData({ domain: { name: profile.base.exact.name, version: profile.base.exact.version,
      chainId: 31337, verifyingContract: profile.base.asset }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization',
      message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) } });
    const authorized = await service.authorize(owner(), invoice.id, treasurySignature); if (!authorized.transaction) throw new Error('Missing exact relay plan');
    const externalWallet = wallet(), request = await externalWallet.prepareTransactionRequest({ account: chain.facilitator, chain: localChain,
      to: profile.base.payTo, data: authorized.transaction.data, gas: 500_000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const raw = await externalWallet.signTransaction(request);
    return { invoice, signature, auth, treasurySignature, raw };
  }
  const balance = (address: Hex) => chain.local.publicClient.readContract({ address: chain.pins.tokenAddress,
    abi: chain.artifact('MockToken').abi, functionName: 'balanceOf', args: [address] });
  it('credits the exact real Vault once, classifies only treasury Subsidy, retains source replay protection after owner withdrawal', async () => {
    const { service, profile } = await build(), original = await prepared(service, profile);
    const before = await balance(profile.base.payTo), incomeBefore = await chain.local.publicClient.readContract({ address: profile.base.selection.selectionRegistryAddress,
      abi: chain.artifact('PlatformSelectionRegistry').abi, functionName: 'getAgent', args: [profile.base.agentId] });
    await expect(service.create(chain.vault.account.address, { clientId: 'agent-key-cannot-fund', amountMicros: '1' })).rejects.toThrow('human owner');
    const sent = await service.submit(owner(), original.invoice.id, original.raw); expect(sent.invoice.transactionHash).toBe(keccak256(original.raw));
    await chain.test.mine({ blocks: 3 }); const credited = await service.get(owner(), original.invoice.id);
    expect(credited).toMatchObject({ state: 'credited', amountMicros: '100000', refundConfirmed: false });
    expect(await balance(profile.base.payTo)).toBe(BigInt(String(before)) + 100000n);
    const after = await chain.local.publicClient.readContract({ address: profile.base.selection.selectionRegistryAddress,
      abi: chain.artifact('PlatformSelectionRegistry').abi, functionName: 'getAgent', args: [profile.base.agentId] });
    // REASON: these dynamic fixture ABIs come from the real Solidity compiler.
    const totals = (value: unknown) => value as { lifetimeIncome: bigint; lifetimeSubsidy: bigint; lifetimeIncomeFees: bigint };
    expect(totals(after).lifetimeIncome).toBe(totals(incomeBefore).lifetimeIncome);
    expect(totals(after).lifetimeIncomeFees).toBe(totals(incomeBefore).lifetimeIncomeFees);
    expect(totals(after).lifetimeSubsidy).toBe(totals(incomeBefore).lifetimeSubsidy + 100000n);
    await chain.confirmed(chain.owner.writeContract({ address: profile.base.payTo, abi: chain.artifact('PlatformAgentVault').abi,
      functionName: 'ownerWithdraw', args: [100000n] }));
    expect(await balance(profile.base.payTo)).toBe(before);
    const nonce = await chain.local.publicClient.getTransactionCount({ address: chain.facilitator.address });
    expect((await service.submit(owner(), original.invoice.id, original.raw)).invoice.state).toBe('credited');
    expect(await chain.local.publicClient.getTransactionCount({ address: chain.facilitator.address })).toBe(nonce);
    expect((await service.create(owner(), { clientId: original.invoice.clientId, amountMicros: '100000' })).replayed).toBe(true);
    const second = (await service.create(owner(), { clientId: 'same-source-another-reference', amountMicros: '100000' })).invoice;
    // Even a contradictory trusted-RPC fixture cannot spend one source again
    // by attaching it to a different invoice/reference.
    source.add(second, original.signature);
    await expect(service.observe(owner(), second.id, original.signature)).rejects.toMatchObject({ code: 'topup_source_used' });
  }, 120_000);

  it.each(['before', 'after'] as const)('recovers a response loss %s raw-byte broadcast without another authorization or changed relay nonce', async timing => {
    let broadcasts = 0;
    const result = await build({}, base => ({ check: base.check.bind(base), validateAuthorization: base.validateAuthorization.bind(base),
      validateTransaction: base.validateTransaction.bind(base), inspect: base.inspect.bind(base), broadcast: async record => {
        broadcasts++; if (timing === 'after') await base.broadcast(record); throw new Error('Injected lost delivery response');
      } }));
    const original = await prepared(result.service, result.profile);
    expect((await result.service.submit(owner(), original.invoice.id, original.raw)).delivery).toBe('unknown');
    expect(broadcasts).toBe(1); const persisted = await result.ledger.read();
    expect(persisted.records[0]?.transactionHash).toBe(keccak256(original.raw));
    const reopened = new TreasuryTopUpService(result.profile, result.policyHash, new FileTopUpLedger(result.profile.journalPath, result.policyHash),
      new SolanaTopUpReader(result.profile.solana), result.base); await reopened.initialize();
    if (timing === 'before') {
      expect((await reopened.get(owner(), original.invoice.id)).state).toBe('base_pending');
      expect((await reopened.rebroadcast(owner(), original.invoice.id)).delivery).toBe('submitted');
    }
    await chain.test.mine({ blocks: 3 }); expect((await reopened.get(owner(), original.invoice.id)).state).toBe('credited');
    expect((await reopened.rebroadcast(owner(), original.invoice.id)).delivery).toBe('not_required');
    expect((await result.ledger.read()).records[0]?.rawTransaction).toBe(original.raw);
    expect(await chain.local.publicClient.getTransactionCount({ address: chain.facilitator.address })).toBe(1);
  }, 120_000);

  it('bounds cumulative policy inventory, keeps expired unpaid holds, and refuses journal loss or a changed operator policy', async () => {
    const { service, profile, ledger, policyHash } = await build({ maxInvoiceMicros: '150000', maxTotalCreditMicros: '200000', maxWaitingInvoices: 1 });
    const emptyPath = resolve(root, 'initially-unfunded', 'topups.json');
    await expect(new FileTopUpLedger(emptyPath, policyHash).initialize('0')).rejects.toMatchObject({ code: 'topup_inventory_unfunded' });
    await expect(lstat(emptyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const outcomes = await Promise.allSettled([service.create(owner(), { clientId: 'competing-a', amountMicros: '150000' }),
      service.create(owner(), { clientId: 'competing-b', amountMicros: '150000' })]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await ledger.read()).records).toHaveLength(1);
    await expect(service.create(owner(), { clientId: 'another', amountMicros: '150000' })).rejects.toMatchObject({ code: 'topup_inventory_limit' });
    const retained = (await ledger.read()).records[0]; if (!retained) throw new Error('Missing held invoice');
    const late = new TreasuryTopUpService(profile, policyHash, ledger, new SolanaTopUpReader(profile.solana), new BaseTopUpCredit(profile, chain.local.rpcUrl), () => retained.expiresAt + 1);
    await late.initialize(); await expect(late.create(owner(), { clientId: 'expired-is-not-free', amountMicros: '50001' })).rejects.toMatchObject({ code: 'topup_inventory_limit' });
    const exposure = await chain.local.publicClient.readContract({ address: profile.base.payTo, abi: chain.artifact('PlatformAgentVault').abi, functionName: 'managedExposure' });
    const cap = await chain.local.publicClient.readContract({ address: profile.base.payTo, abi: chain.artifact('PlatformAgentVault').abi, functionName: 'MAX_MANAGED_EXPOSURE' });
    await chain.confirmed(chain.owner.writeContract({ address: profile.base.asset, abi: chain.artifact('MockToken').abi,
      functionName: 'faucet', args: [profile.base.payTo, BigInt(String(cap)) - BigInt(String(exposure))] }));
    await chain.test.mine({ blocks: 3 });
    await expect(service.create(owner(), { clientId: 'full-vault-no-payment-url', amountMicros: '1' })).rejects.toMatchObject({ code: 'topup_vault_capacity' });
    expect((await ledger.read()).records).toHaveLength(1);
    await expect(new FileTopUpLedger(profile.journalPath, `0x${'9'.repeat(64)}`).initialize('200000')).rejects.toThrow('another reviewed policy');
    const journal = await readFile(profile.journalPath); await rm(profile.journalPath);
    await expect(new FileTopUpLedger(profile.journalPath, policyHash).initialize('200000')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(journal.length).toBeGreaterThan(100);
  }, 120_000);

  it('rechecks credited receipts after a real Anvil reorg and rejects changed source reuse, wrong treasury signatures and altered transactions', async () => {
    const { service, profile, ledger } = await build({ maxInvoiceMicros: '100000', maxTotalCreditMicros: '100000' });
    const original = await prepared(service, profile, 'reorg-source', '60000'), before = await chain.test.snapshot();
    const retained = (await ledger.read()).records[0]; if (!retained?.authorization) throw new Error('Missing signed invoice');
    const forged = await chain.accounts.owner.signTypedData({ domain: { name: profile.base.exact.name, version: profile.base.exact.version,
      chainId: 31337, verifyingContract: profile.base.asset }, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization',
      message: { ...retained.authorization, value: BigInt(retained.authorization.value), validAfter: BigInt(retained.authorization.validAfter), validBefore: BigInt(retained.authorization.validBefore) } });
    await expect(service.authorize(owner(), original.invoice.id, forged)).rejects.toThrow('immutable');
    const base = new BaseTopUpCredit(profile, chain.local.rpcUrl); await expect(base.validateAuthorization(retained, forged)).rejects.toThrow('pinned treasury');
    await expect(new BaseTopUpCredit({ ...profile, base: { ...profile.base, facilitator: chain.accounts.signer.address } }, chain.local.rpcUrl).check())
      .rejects.toThrow('dedicated');
    const bad = await wallet().signTransaction({ account: chain.facilitator, chain: localChain, chainId: 31337,
      to: owner(), data: '0x', nonce: 0, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: 'eip1559' });
    await expect(service.submit(owner(), original.invoice.id, bad as TransactionSerialized)).rejects.toThrow('exact relay plan');
    const plan = await base.validateAuthorization(retained, original.treasurySignature);
    const insufficientGas = await wallet().signTransaction({ account: chain.facilitator, chain: localChain, chainId: 31337,
      to: profile.base.payTo, data: plan.data, nonce: 0, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: 'eip1559' });
    await expect(service.submit(owner(), original.invoice.id, insufficientGas)).rejects.toThrow();
    expect((await ledger.read()).records[0]?.rawTransaction).toBeNull();
    await service.submit(owner(), original.invoice.id, original.raw); await chain.test.mine({ blocks: 3 });
    expect((await service.get(owner(), original.invoice.id)).state).toBe('credited');
    await chain.test.revert({ id: before });
    expect(await service.get(owner(), original.invoice.id)).toMatchObject({ state: 'base_pending', creditedBlockHash: null, creditedBlockNumber: null });
    await expect(service.create(owner(), { clientId: 'cannot-reuse-reorg-cash', amountMicros: '60000' })).rejects.toMatchObject({ code: 'topup_inventory_limit' });
  }, 120_000);

  it('retains the hold when the original authorization is consumed directly into the intended Vault without classified ingress', async () => {
    const { service, profile, ledger } = await build(), original = await prepared(service, profile, 'direct-token-consumption');
    const balanceBefore = await balance(profile.base.payTo), vByte = Number.parseInt(original.treasurySignature.slice(130), 16);
    await chain.confirmed(chain.owner.writeContract({ address: profile.base.asset, abi: chain.artifact('MockToken').abi,
      functionName: 'transferWithAuthorization', args: [original.auth.from, original.auth.to, BigInt(original.auth.value),
        BigInt(original.auth.validAfter), BigInt(original.auth.validBefore), original.auth.nonce, vByte < 27 ? vByte + 27 : vByte,
        `0x${original.treasurySignature.slice(2, 66)}`, `0x${original.treasurySignature.slice(66, 130)}`] }));
    await chain.test.mine({ blocks: 3 });
    expect(await balance(profile.base.payTo)).toBe(BigInt(String(balanceBefore)) + 100000n);
    await expect(service.submit(owner(), original.invoice.id, original.raw)).rejects.toMatchObject({ code: 'topup_authorization_consumed_unclassified' });
    const record = (await ledger.read()).records[0];
    expect(record).toMatchObject({ state: 'authorization_recorded', transactionHash: null, rawTransaction: null });
    expect((await service.get(owner(), original.invoice.id)).state).not.toBe('credited');
    expect(await chain.local.publicClient.getTransactionCount({ address: chain.facilitator.address })).toBe(0);
    // A transfer into the intended Vault is real, but without the required
    // FundsReceived/Subsidy evidence this service cannot classify it or free its hold.
  }, 120_000);
});
