import { encodeFunctionData, getAbiItem, keccak256, parseAbi, parseEventLogs, type Hex } from 'viem';
import { z } from 'zod';
import { addressSchema, bytes32Schema, Problem, sameAddress } from '../common.js';
import { PlatformBridge } from './bridge.js';
import { platformEscrowAbi, PLATFORM_ZERO, typedPlatformQuote, type PlatformQuote } from './types.js';

export const platformVaultConfigSchema = z.object({ registryAddress: addressSchema, registryCodeHash: bytes32Schema,
  implementationAddress: addressSchema, implementationCodeHash: bytes32Schema }).strict();
export type PlatformVaultConfig = z.infer<typeof platformVaultConfigSchema>;
export const platformVaultBindingSchema = z.object({ vault: addressSchema, owner: addressSchema, agentWallet: addressSchema,
  agentId: bytes32Schema, leashId: bytes32Schema }).strict();
export type PlatformVaultBinding = z.infer<typeof platformVaultBindingSchema>;

export const platformVaultAbi = parseAbi([
  'function MAX_MANAGED_EXPOSURE() view returns (uint96)',
  'struct VaultQuote { bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass; bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry; }',
  'function token() view returns (address)', 'function escrow() view returns (address)', 'function registry() view returns (address)',
  'function controller() view returns (address)', 'function treasury() view returns (address)', 'function owner() view returns (address)',
  'function agentWallet() view returns (address)', 'function agentId() view returns (bytes32)', 'function leashId() view returns (bytes32)',
  'function spendableBalance() view returns (uint256)', 'function trackedRun(bytes32 runId) view returns (bool)',
  'function finalizedRun(bytes32 runId) view returns (bool)',
  'function payRun(VaultQuote quote,bytes signature,bytes32[] imageProof,bytes32[] regionProof)',
  'function requestStop(bytes32 runId)', 'function syncRun(bytes32 runId)',
  'event RunFunded(bytes32 indexed runId,uint96 ceiling)', 'event RunFinalized(bytes32 indexed runId,uint96 charge,bool refunded)',
]);
const registryAbi = parseAbi([
  'struct Agent { uint256 identityId; address owner; address agentWallet; address vault; bytes32 leashId; bytes32 parent; bytes32 family; bytes32 cystHash; uint64 enteredAt; uint64 dormantAt; uint64 diedAt; uint64 lastPaidRun; uint64 lastActivationAt; uint64 deathAt; uint256 lifetimeIncome; uint256 lifetimeBurn; uint256 lifetimeSubsidy; uint256 lifetimeIncomeFees; uint8 livingChildren; uint8 status; bool frozen; }',
  'function token() view returns (address)', 'function escrow() view returns (address)', 'function controller() view returns (address)',
  'function treasury() view returns (address)', 'function vaultImplementation() view returns (address)',
  'function vaultAgent(address vault) view returns (bytes32)', 'function getAgent(bytes32 agentId) view returns (Agent)',
  'function agentWalletAgent(address wallet) view returns (bytes32)',
  'function canRun(bytes32 agentId) view returns (bool)',
  'event Burn(bytes32 indexed agentId,uint96 amount,bytes32 indexed runId,uint64 paidAt)',
]);

/** Only reviewed immutable factories and their exact EIP-1167 clones are admitted. */
export class PlatformVaultBridge {
  readonly config: PlatformVaultConfig;
  constructor(readonly bridge: PlatformBridge, config: PlatformVaultConfig) { this.config = Object.freeze(platformVaultConfigSchema.parse(config)); }
  async check(): Promise<void> {
    await this.bridge.check();
    for (const [address, hash] of [[this.config.registryAddress, this.config.registryCodeHash],
      [this.config.implementationAddress, this.config.implementationCodeHash]] as const) {
      const code = await this.bridge.public.getCode({ address });
      if (!code || code === '0x' || keccak256(code) !== hash) throw new Error('Platform Vault contract code pin changed');
    }
    const registry = this.config.registryAddress, implementation = this.config.implementationAddress;
    const [token, escrow, controller, treasury, factoryImplementation, implToken, implEscrow, implRegistry,
      implController, implTreasury, managedExposureCap] = await Promise.all([
      this.bridge.public.readContract({ address: registry, abi: registryAbi, functionName: 'token' }),
      this.bridge.public.readContract({ address: registry, abi: registryAbi, functionName: 'escrow' }),
      this.bridge.public.readContract({ address: registry, abi: registryAbi, functionName: 'controller' }),
      this.bridge.public.readContract({ address: registry, abi: registryAbi, functionName: 'treasury' }),
      this.bridge.public.readContract({ address: registry, abi: registryAbi, functionName: 'vaultImplementation' }),
      this.bridge.public.readContract({ address: implementation, abi: platformVaultAbi, functionName: 'token' }),
      this.bridge.public.readContract({ address: implementation, abi: platformVaultAbi, functionName: 'escrow' }),
      this.bridge.public.readContract({ address: implementation, abi: platformVaultAbi, functionName: 'registry' }),
      this.bridge.public.readContract({ address: implementation, abi: platformVaultAbi, functionName: 'controller' }),
      this.bridge.public.readContract({ address: implementation, abi: platformVaultAbi, functionName: 'treasury' }),
      this.bridge.public.readContract({ address: implementation, abi: platformVaultAbi, functionName: 'MAX_MANAGED_EXPOSURE' }),
    ]);
    if (![[token, this.bridge.pins.tokenAddress], [escrow, this.bridge.pins.escrowAddress], [factoryImplementation, implementation],
      [implToken, token], [implEscrow, escrow], [implRegistry, registry], [implController, controller], [implTreasury, treasury]]
      .every(([actual, expected]) => actual !== undefined && expected !== undefined && sameAddress(actual, addressSchema.parse(expected)))) {
      throw new Error('Platform Vault contract relationships differ from reviewed pins');
    }
    if (managedExposureCap !== 2_500_000_000n) throw new Error('Platform Vault exposure limit differs from reviewed policy');
  }
  async authorize(principal: string, address: string, mode: 'run' | 'read' | 'owner'): Promise<PlatformVaultBinding> {
    await this.check();
    const caller = addressSchema.parse(principal), vault = addressSchema.parse(address);
    const code = await this.bridge.public.getCode({ address: vault });
    const clone = `0x363d3d373d3d3d363d73${this.config.implementationAddress.slice(2)}5af43d82803e903d91602b57fd5bf3`.toLowerCase();
    if (code?.toLowerCase() !== clone) throw new Problem(404, 'platform_vault_unknown', 'The reviewed registry has no matching Vault.');
    const agentId = await this.bridge.public.readContract({ address: this.config.registryAddress, abi: registryAbi,
      functionName: 'vaultAgent', args: [vault] });
    if (agentId === PLATFORM_ZERO) throw new Problem(404, 'platform_vault_unknown', 'The reviewed registry has no matching Vault.');
    const [agent, owner, agentWallet, cloneAgentId, leashId] = await Promise.all([
      this.bridge.public.readContract({ address: this.config.registryAddress, abi: registryAbi, functionName: 'getAgent', args: [agentId] }),
      this.bridge.public.readContract({ address: vault, abi: platformVaultAbi, functionName: 'owner' }),
      this.bridge.public.readContract({ address: vault, abi: platformVaultAbi, functionName: 'agentWallet' }),
      this.bridge.public.readContract({ address: vault, abi: platformVaultAbi, functionName: 'agentId' }),
      this.bridge.public.readContract({ address: vault, abi: platformVaultAbi, functionName: 'leashId' }),
    ]);
    if (agent.status === 0 || !sameAddress(agent.vault, vault) || !sameAddress(agent.owner, owner)
      || !sameAddress(agent.agentWallet, agentWallet) || cloneAgentId !== agentId || agent.leashId !== leashId || leashId === PLATFORM_ZERO) {
      throw new Error('Platform Vault clone binding differs from its factory entry');
    }
    const allowed = mode === 'run' ? sameAddress(caller, agentWallet) : mode === 'owner' ? sameAddress(caller, owner)
      : sameAddress(caller, owner) || sameAddress(caller, agentWallet);
    if (!allowed) throw new Problem(404, 'platform_vault_unknown', 'The reviewed registry has no matching Vault.');
    const leash = await this.bridge.leash(leashId);
    if (!sameAddress(leash.owner, vault) || !sameAddress(leash.agent, vault)) throw new Error('Platform Vault Leash binding differs');
    if (mode === 'run' && (!await this.bridge.public.readContract({ address: this.config.registryAddress, abi: registryAbi,
      functionName: 'canRun', args: [agentId] }) || leash.killed || leash.expiry <= BigInt(await this.bridge.now()) || leash.classMask === 0n)) {
      throw new Problem(409, 'platform_vault_unavailable', 'The Vault lifecycle or Leash does not permit new work.');
    }
    return { vault, owner, agentWallet, agentId, leashId };
  }
  async balance(vault: string) {
    return { available: (await this.bridge.public.readContract({ address: addressSchema.parse(vault), abi: platformVaultAbi,
      functionName: 'spendableBalance' })).toString() };
  }
  /** The lifecycle principal is the human owner; the agent wallet identifies one immutable factory Vault. */
  async forAgent(owner: string, agentWallet: string): Promise<PlatformVaultBinding> {
    await this.check();
    const wallet = addressSchema.parse(agentWallet);
    const agentId = await this.bridge.public.readContract({ address: this.config.registryAddress, abi: registryAbi,
      functionName: 'agentWalletAgent', args: [wallet] });
    if (agentId === PLATFORM_ZERO) throw new Problem(404, 'platform_vault_unknown', 'The reviewed registry has no matching Vault.');
    const entry = await this.bridge.public.readContract({ address: this.config.registryAddress, abi: registryAbi,
      functionName: 'getAgent', args: [agentId] });
    const actual = await this.authorize(owner, entry.vault, 'owner');
    if (actual.agentId !== agentId || !sameAddress(actual.agentWallet, wallet)) throw new Error('Original agent Vault identity changed');
    return actual;
  }
  async checkBinding(binding: PlatformVaultBinding): Promise<void> {
    platformVaultBindingSchema.parse(binding);
    const actual = await this.authorize(binding.owner, binding.vault, 'read');
    if (!sameAddress(actual.owner, binding.owner) || !sameAddress(actual.agentWallet, binding.agentWallet)
      || actual.agentId !== binding.agentId || actual.leashId !== binding.leashId) throw new Error('Persisted Platform Vault binding changed');
  }
  async runnable(binding: PlatformVaultBinding): Promise<boolean> {
    await this.checkBinding(binding);
    const [enabled, leash] = await Promise.all([
      this.bridge.public.readContract({ address: this.config.registryAddress, abi: registryAbi, functionName: 'canRun', args: [binding.agentId] }),
      this.bridge.leash(binding.leashId),
    ]);
    return enabled && !leash.killed && leash.expiry > BigInt(await this.bridge.now()) && leash.classMask !== 0n;
  }
  openPlan(binding: PlatformVaultBinding, quote: PlatformQuote, signature: Hex, imageProof: Hex[], regionProof: Hex[]) {
    if (!sameAddress(quote.payer, binding.vault) || quote.leashId !== binding.leashId) throw new Error('Platform Vault quote binding differs');
    return { chainId: this.bridge.pins.chainId, to: binding.vault, value: '0' as const,
      data: encodeFunctionData({ abi: platformVaultAbi, functionName: 'payRun', args: [typedPlatformQuote(quote), signature, imageProof, regionProof] }) };
  }
  stopPlan(binding: PlatformVaultBinding, runId: Hex) {
    return { chainId: this.bridge.pins.chainId, to: binding.vault, value: '0' as const,
      data: encodeFunctionData({ abi: platformVaultAbi, functionName: 'requestStop', args: [runId] }) };
  }
  refundPlan(_binding: PlatformVaultBinding, runId: Hex) {
    return this.bridge.plan(encodeFunctionData({ abi: platformEscrowAbi, functionName: 'refundRun', args: [runId] }));
  }
  async verifyAdmission(binding: PlatformVaultBinding, quote: PlatformQuote, ceiling: string, hash: Hex,
    signature: Hex, imageProof: Hex[], regionProof: Hex[]): Promise<void> {
    return this.admissionEvidence(binding, quote, ceiling, hash, signature, imageProof, regionProof, true);
  }
  async verifyHistoricalAdmission(binding: PlatformVaultBinding, quote: PlatformQuote, ceiling: string, hash: Hex,
    signature: Hex, imageProof: Hex[], regionProof: Hex[]): Promise<void> {
    return this.admissionEvidence(binding, quote, ceiling, hash, signature, imageProof, regionProof, false);
  }
  private async admissionEvidence(binding: PlatformVaultBinding, quote: PlatformQuote, ceiling: string, hash: Hex,
    signature: Hex, imageProof: Hex[], regionProof: Hex[], requireOpen: boolean): Promise<void> {
    await this.checkBinding(binding);
    const receipt = await this.bridge.canonicalReceipt(hash, binding.vault);
    const transaction = await this.bridge.public.getTransaction({ hash });
    const expected = this.openPlan(binding, quote, signature, imageProof, regionProof);
    if (!sameAddress(transaction.from, binding.agentWallet) || !sameAddress(receipt.from, binding.agentWallet)
      || transaction.to?.toLowerCase() !== binding.vault.toLowerCase() || transaction.input.toLowerCase() !== expected.data.toLowerCase()
      || transaction.value !== 0n || transaction.blockHash !== receipt.blockHash) throw new Error('Platform Vault admission outer transaction differs');
    const opened = parseEventLogs({ abi: platformEscrowAbi, eventName: 'RunOpened',
      logs: receipt.logs.filter(log => sameAddress(log.address, this.bridge.pins.escrowAddress)) });
    const funded = parseEventLogs({ abi: platformVaultAbi, eventName: 'RunFunded', logs: receipt.logs.filter(log => sameAddress(log.address, binding.vault)) });
    const [run, tracked] = await Promise.all([this.bridge.run(quote.runId), this.bridge.public.readContract({ address: binding.vault,
      abi: platformVaultAbi, functionName: 'trackedRun', args: [quote.runId] })]);
    const historical = await this.bridge.public.readContract({ address: this.config.registryAddress, abi: registryAbi,
      functionName: 'getAgent', args: [binding.agentId], blockNumber: receipt.blockNumber });
    if (!sameAddress(historical.owner, binding.owner) || !sameAddress(historical.agentWallet, binding.agentWallet)
      || !sameAddress(historical.vault, binding.vault) || historical.leashId !== binding.leashId) {
      throw new Error('Original Platform Vault ownership differs at admission');
    }
    if (!tracked || (requireOpen ? run.status !== 1 : ![1, 2, 3].includes(run.status))
      || !this.bridge.matches(quote, run) || run.ceiling.toString() !== ceiling
      || !funded.some(log => log.args.runId === quote.runId && log.args.ceiling.toString() === ceiling)
      || !opened.some(log => log.args.runId === quote.runId && log.args.leashId === binding.leashId && log.args.hostId === quote.hostId
        && sameAddress(log.args.payer, binding.vault) && log.args.ceiling.toString() === ceiling && log.args.maxSeconds === BigInt(quote.maxSeconds))) {
      throw new Error('Platform Vault reservation differs from the accepted quote');
    }
    await this.bridge.canonicalReceipt(hash, binding.vault);
  }
  private async finalizedEvidence(binding: PlatformVaultBinding, runId: Hex, hash: Hex) {
    await this.checkBinding(binding);
    const receipt = await this.bridge.canonicalReceipt(hash), run = await this.bridge.run(runId);
    const [tracked, finalized] = await Promise.all(['trackedRun', 'finalizedRun'].map(functionName => this.bridge.public.readContract({
      address: binding.vault, abi: platformVaultAbi, functionName: functionName === 'trackedRun' ? 'trackedRun' : 'finalizedRun', args: [runId] })));
    if (!tracked || !finalized || !sameAddress(run.payer, binding.vault) || run.leashId !== binding.leashId || ![2, 3].includes(run.status)
      || !run.hostReleased) throw new Error('Platform Vault finalization has no matching terminal reservation');
    const base = run.billableSeconds * run.pricePerSecond + run.inferenceCharge;
    const charged = run.status === 3 ? 0n : base + await this.bridge.fee(base, run.sealedHost);
    const refunded = run.status === 3;
    const block = await this.bridge.public.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) throw new Error('Platform Vault finalization block changed');
    const paidAt = run.openedAt + run.billableSeconds < block.timestamp ? run.openedAt + run.billableSeconds : block.timestamp;
    const events = parseEventLogs({ abi: platformVaultAbi, eventName: 'RunFinalized', logs: receipt.logs.filter(log => sameAddress(log.address, binding.vault)) });
    if (!events.some(log => log.args.runId === runId && log.args.charge === charged && log.args.refunded === refunded)) {
      throw new Error('Platform Vault finalization financial evidence differs');
    }
    const burns = parseEventLogs({ abi: registryAbi, eventName: 'Burn', logs: receipt.logs.filter(log => sameAddress(log.address, this.config.registryAddress)) })
      .filter(log => log.args.agentId === binding.agentId && log.args.runId === runId);
    if (charged > 0n ? burns.length !== 1 || burns[0]?.args.amount !== charged || burns[0].args.paidAt !== paidAt : burns.length !== 0) {
      throw new Error('Platform Selection burn differs from Vault finalization');
    }
    await this.bridge.canonicalReceipt(hash);
    return { transactionHash: receipt.transactionHash, charged: charged.toString(), refunded, paidAt: paidAt.toString() };
  }
  private async reconcileFinalized(binding: PlatformVaultBinding, runId: Hex) {
    const latest = await this.bridge.public.getBlockNumber({ cacheTime: 0 }), first = latest > 65_536n ? latest - 65_536n : 0n;
    const event = getAbiItem({ abi: platformVaultAbi, name: 'RunFinalized' });
    for (let fromBlock = first; fromBlock <= latest; fromBlock += 2048n) {
      const toBlock = fromBlock + 2047n < latest ? fromBlock + 2047n : latest;
      const logs = await this.bridge.public.getLogs({ address: binding.vault, event, args: { runId }, fromBlock, toBlock, strict: true });
      for (const log of logs) if (log.transactionHash) return this.finalizedEvidence(binding, runId, log.transactionHash);
    }
    throw new Problem(409, 'platform_vault_sync_evidence_missing', 'Canonical Vault finalization requires operator reconciliation.');
  }
  private async syncEvidence(binding: PlatformVaultBinding, id: string) {
    await this.checkBinding(binding);
    const runId = bytes32Schema.parse(id), run = await this.bridge.run(runId);
    if (!sameAddress(run.payer, binding.vault) || run.leashId !== binding.leashId || ![2, 3].includes(run.status)
      || !await this.bridge.public.readContract({ address: binding.vault, abi: platformVaultAbi, functionName: 'trackedRun', args: [runId] })) {
      throw new Problem(409, 'platform_vault_sync_unavailable', 'The tracked Vault reservation is not final.');
    }
    if (await this.bridge.public.readContract({ address: binding.vault, abi: platformVaultAbi, functionName: 'finalizedRun', args: [runId] })) {
      return this.reconcileFinalized(binding, runId);
    }
    const data = encodeFunctionData({ abi: platformVaultAbi, functionName: 'syncRun', args: [runId] });
    try {
      const receipt = await this.bridge.transactions.submit(`vault-sync:${binding.vault.toLowerCase()}:${runId}`, binding.vault, data);
      return this.finalizedEvidence(binding, runId, receipt.transactionHash);
    } catch (error) {
      if (await this.bridge.public.readContract({ address: binding.vault, abi: platformVaultAbi, functionName: 'finalizedRun', args: [runId] })) {
        return this.reconcileFinalized(binding, runId);
      }
      throw error;
    }
  }
  async syncRun(binding: PlatformVaultBinding, id: string) {
    const { transactionHash, charged, refunded } = await this.syncEvidence(binding, id);
    return { transactionHash, charged, refunded };
  }
  async verifyFinalized(binding: PlatformVaultBinding, runId: string, hash: Hex) {
    const { transactionHash, charged, refunded } = await this.finalizedEvidence(binding, bytes32Schema.parse(runId), bytes32Schema.parse(hash));
    return { transactionHash, charged, refunded };
  }
  /** Extended canonical evidence for Metabolism; ordinary runtime responses retain their existing shape. */
  async verifyFinalizedBurn(binding: PlatformVaultBinding, runId: string, hash: Hex) {
    return this.finalizedEvidence(binding, bytes32Schema.parse(runId), bytes32Schema.parse(hash));
  }
}
