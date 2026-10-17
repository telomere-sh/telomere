import { beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { compileContracts, type ContractArtifact } from '../scripts/compile-contracts.js';
import { hashJson, randomId } from '../src/common.js';
import { auditPreparedPlatformRuns, type PlatformPreparedAuditPins, type PlatformPreparedAuditRpc,
  type PlatformPreparedAuditRow } from '../src/operator/platform-prepared-audit.js';
import { platformEscrowAbi, platformQuoteTypes, platformWorkloadHash,
  typedPlatformQuote } from '../src/platform-runtime/types.js';
import { deployPlatformRuntime } from './fixtures/platform-runtime.js';

const zero = `0x${'0'.repeat(64)}` as Hex;
type Fixture = Awaited<ReturnType<typeof deployPlatformRuntime>>;

async function prepared(fixture: Fixture): Promise<PlatformPreparedAuditRow> {
  const block = await fixture.local.publicClient.getBlock();
  const leashId = randomId(), runId = randomId();
  await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
    abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'createLeash', args: [leashId,
      { agent: fixture.accounts.owner.address, maxPerHour: 100_000n, maxPerDay: 1_000_000n,
        classMask: 1n, sealedOnly: false, imageAllowRoot: zero, regionAllowRoot: zero,
        expiry: block.timestamp + 86_400n }] }));
  const now = Number((await fixture.local.publicClient.getBlock()).timestamp);
  const input = { leashId, task: { kind: 'sha256' as const, text: 'prepared-audit' },
    maxSeconds: 10, deadline: now + 300, maxSpend: '2000', regions: [] };
  const quote = { runId, leashId, hostId: fixture.hostId, payer: fixture.accounts.owner.address,
    hwClass: 0 as const, regionHash: keccak256(toHex('local-test')),
    imageHash: keccak256(toHex(`sha256:${'1'.repeat(64)}`)), workloadHash: hashJson({ task: input.task }),
    maxSeconds: 10, pricePerSecond: '100', inferencePrice: '0' as const, quoteExpiry: now + 120 };
  const signature = await fixture.accounts.signer.signTypedData({
    domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: 31337,
      verifyingContract: fixture.pins.escrowAddress }, primaryType: 'PlatformQuote',
    types: platformQuoteTypes, message: typedPlatformQuote(quote),
  });
  return { id: runId, owner: fixture.accounts.owner.address, agent: fixture.accounts.owner.address,
    inputHash: hashJson(input), input, quote, signature, ceiling: '1090', vaultBinding: null,
    status: 'prepared', admissionTx: null, settlementTx: null, settlement: null, charged: null, refund: null };
}

async function at(fixture: Fixture): Promise<{ pins: PlatformPreparedAuditPins; rpc: PlatformPreparedAuditRpc }> {
  const block = await fixture.local.publicClient.getBlock();
  if (!block.hash) throw new Error('Local block hash unavailable');
  const p = fixture.pins, client = fixture.local.publicClient;
  return { pins: { chainId: p.chainId, escrow: p.escrowAddress, escrowCodeHash: p.escrowCodeHash,
    quoteSigner: p.quoteSigner, token: p.tokenAddress, receiptRoot: p.receiptRootAddress,
    hostRegistry: p.hostRegistryAddress, feeRouter: p.feeRouterAddress,
    referenceBlock: block.number, referenceHash: block.hash },
  rpc: {
    getBlockHash: async number => {
      const historical = await client.getBlock({ blockNumber: number });
      if (!historical.hash) throw new Error('No historical block'); return historical.hash;
    },
    getEscrowCode: number => client.getCode({ address: p.escrowAddress, blockNumber: number }),
    getEscrowIdentity: async number => {
      const read = (functionName: 'quoteSigner' | 'token' | 'receiptRoot' | 'hostRegistry' | 'feeRouter') =>
        client.readContract({ address: p.escrowAddress, abi: platformEscrowAbi, functionName, blockNumber: number });
      const [quoteSigner, token, receiptRoot, hostRegistry, feeRouter] = await Promise.all([
        read('quoteSigner'), read('token'), read('receiptRoot'), read('hostRegistry'), read('feeRouter')]);
      return { quoteSigner, token, receiptRoot, hostRegistry, feeRouter };
    },
    getRun: (runId, number) => client.readContract({ address: p.escrowAddress,
      abi: platformEscrowAbi, functionName: 'getRun', args: [runId], blockNumber: number }),
    getLeash: (leashId, number) => client.readContract({ address: p.escrowAddress,
      abi: platformEscrowAbi, functionName: 'getLeash', args: [leashId], blockNumber: number }),
    getQuoteCeiling: (quote, number) => client.readContract({ address: p.escrowAddress,
      abi: platformEscrowAbi, functionName: 'quoteCeiling', args: [typedPlatformQuote(quote), false], blockNumber: number }),
  } };
}

describe('manual read-only paid prepared-run audit', () => {
  let artifacts: Record<string, ContractArtifact>;
  beforeAll(() => { artifacts = compileContracts([
    'PlatformRunEscrow.sol', 'HostRegistry.sol', 'ReceiptRoot.sol', 'FeeRouter.sol', 'MockToken.sol']); });

  it('anchors unopened, opened but unadmitted, and refunded but unrecorded states to real Anvil blocks', async () => {
    const fixture = await deployPlatformRuntime(randomId(), artifacts);
    try {
      const row = await prepared(fixture);
      const before = await at(fixture);
      const unopened = await auditPreparedPlatformRuns([row], before.pins, before.rpc);
      expect(unopened).toMatchObject({ status: 'ok', counts: { unopened: 1, open_unadmitted: 0 } });
      await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
        abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'openRun',
        args: [typedPlatformQuote(row.quote), row.signature, [], []] }));
      const afterOpen = await at(fixture);
      expect((await auditPreparedPlatformRuns([row], afterOpen.pins, afterOpen.rpc)).counts.open_unadmitted).toBe(1);
      // The older reviewed block still shows unopened even after the later transaction.
      expect((await auditPreparedPlatformRuns([row], before.pins, before.rpc)).counts.unopened).toBe(1);
      const refundAt = await fixture.local.publicClient.readContract({ address: fixture.pins.escrowAddress,
        abi: platformEscrowAbi, functionName: 'refundAt', args: [row.quote.runId] });
      await fixture.test.setNextBlockTimestamp({ timestamp: refundAt });
      await fixture.test.mine({ blocks: 1 });
      await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
        abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'refundRun', args: [row.quote.runId] }));
      const afterRefund = await at(fixture);
      const refunded = await auditPreparedPlatformRuns([row], afterRefund.pins, afterRefund.rpc);
      expect(refunded).toMatchObject({ status: 'critical', counts: { refunded_unrecorded: 1 } });
      expect(JSON.stringify(refunded)).not.toContain(row.id);
      expect(JSON.stringify(refunded)).not.toContain(row.owner);
    } finally { await fixture.close(); }
  });

  it('audits an inference-only prepared quote and rejects provider-scope or onchain-price changes', async () => {
    const fixture = await deployPlatformRuntime(randomId(), artifacts);
    try {
      const base = await prepared(fixture);
      const input = { ...base.input, task: { kind: 'near_inference' as const }, maxSeconds: 20,
        maxSpend: '5000', near: { model: 'z-ai/glm-5.3-flash', maxTokens: 32,
          policySha256: randomId(), prompt: 'prepared audit' } };
      const quote = { ...base.quote, maxSeconds: 20, inferencePrice: '500',
        workloadHash: platformWorkloadHash(input) };
      const signature = await fixture.accounts.signer.signTypedData({
        domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: 31337,
          verifyingContract: fixture.pins.escrowAddress }, primaryType: 'PlatformQuote',
        types: platformQuoteTypes, message: typedPlatformQuote(quote),
      });
      const row: PlatformPreparedAuditRow = { ...base, input, inputHash: hashJson(input), quote,
        signature, ceiling: '2725' };
      const before = await at(fixture);
      expect((await auditPreparedPlatformRuns([row], before.pins, before.rpc)))
        .toMatchObject({ status: 'ok', counts: { unopened: 1 } });
      const changedInput = { ...input, near: { ...input.near, prompt: 'different prompt' } };
      expect((await auditPreparedPlatformRuns([{ ...row, input: changedInput,
        inputHash: hashJson(changedInput) }], before.pins, before.rpc)).counts.quote_ceiling_mismatch).toBe(1);
      const zeroQuote = { ...quote, inferencePrice: '0' };
      const zeroSignature = await fixture.accounts.signer.signTypedData({
        domain: { name: 'TelomerePlatformEscrow', version: '1', chainId: 31337,
          verifyingContract: fixture.pins.escrowAddress }, primaryType: 'PlatformQuote',
        types: platformQuoteTypes, message: typedPlatformQuote(zeroQuote),
      });
      expect((await auditPreparedPlatformRuns([{ ...row, quote: zeroQuote, signature: zeroSignature,
        ceiling: '2180' }], before.pins, before.rpc)).counts.quote_ceiling_mismatch).toBe(1);
      await fixture.confirmed(fixture.owner.writeContract({ address: fixture.pins.escrowAddress,
        abi: fixture.artifact('PlatformRunEscrow').abi, functionName: 'openRun',
        args: [typedPlatformQuote(row.quote), row.signature, [], []] }));
      const after = await at(fixture);
      expect((await auditPreparedPlatformRuns([row], after.pins, after.rpc)).counts.open_unadmitted).toBe(1);
      const changedRun = await auditPreparedPlatformRuns([row], after.pins,
        { ...after.rpc, getRun: async (id, block) => ({ ...(await after.rpc.getRun(id, block)),
          inferencePrice: 501n }) });
      expect(changedRun.counts.quote_ceiling_mismatch).toBe(1);
    } finally { await fixture.close(); }
  });

  it('counts changed quote/ceiling, settled state, and unavailable archive RPC without exposing row identity', async () => {
    const fixture = await deployPlatformRuntime(randomId(), artifacts);
    try {
      const row = await prepared(fixture), { pins, rpc } = await at(fixture);
      const wrongCeiling = { ...row, ceiling: '1091' };
      expect((await auditPreparedPlatformRuns([wrongCeiling], pins, rpc)).counts.quote_ceiling_mismatch).toBe(1);
      const wrongSignature = { ...row, signature: `0x${'11'.repeat(65)}` };
      expect((await auditPreparedPlatformRuns([wrongSignature], pins, rpc)).counts.quote_ceiling_mismatch).toBe(1);
      const tooLittleSpend = { ...row, input: { ...row.input, maxSpend: '1000' },
        inputHash: hashJson({ ...row.input, maxSpend: '1000' }) };
      expect((await auditPreparedPlatformRuns([tooLittleSpend], pins, rpc)).counts.quote_ceiling_mismatch).toBe(1);
      const shortDeadline = { ...row, input: { ...row.input, deadline: row.quote.quoteExpiry },
        inputHash: hashJson({ ...row.input, deadline: row.quote.quoteExpiry }) };
      expect((await auditPreparedPlatformRuns([shortDeadline], pins, rpc)).counts.quote_ceiling_mismatch).toBe(1);
      const wrongAgent = { ...row, agent: fixture.accounts.outsider.address };
      expect((await auditPreparedPlatformRuns([wrongAgent], pins, rpc)).counts.leash_binding_mismatch).toBe(1);
      const wrongLeashOwner = await auditPreparedPlatformRuns([row], pins,
        { ...rpc, getLeash: async () => ({ owner: fixture.accounts.outsider.address, agent: row.agent }) });
      expect(wrongLeashOwner.counts.leash_binding_mismatch).toBe(1);
      const invalidSessionInput = { ...row.input,
        task: { kind: 'session', imageDigest: `sha256:${'a'.repeat(64)}`, maxCommands: 1 }, maxSeconds: 5 };
      expect((await auditPreparedPlatformRuns([{ ...row, input: invalidSessionInput,
        inputHash: hashJson(invalidSessionInput) }], pins, rpc)).counts.invalid_row).toBe(1);
      const opened = { ...(await rpc.getRun(row.id, pins.referenceBlock)), status: 2,
        payer: row.quote.payer, leashId: row.quote.leashId, hostId: row.quote.hostId,
        hwClass: 0, regionHash: row.quote.regionHash, imageHash: row.quote.imageHash,
        workloadHash: row.quote.workloadHash, sealedHost: false, maxSeconds: 10n,
        pricePerSecond: 100n, inferencePrice: 0n, ceiling: 1090n };
      expect((await auditPreparedPlatformRuns([row], pins,
        { ...rpc, getRun: async () => opened })).counts.settled_unrecorded).toBe(1);
      const unavailable = await auditPreparedPlatformRuns([row], pins,
        { ...rpc, getRun: async () => { throw new Error('private RPC URL'); } });
      expect(unavailable).toMatchObject({ status: 'critical', counts: { rpc_unavailable: 1 } });
      expect(JSON.stringify(unavailable)).not.toContain('private RPC URL');
      const reorged = await auditPreparedPlatformRuns([row], pins,
        { ...rpc, getBlockHash: async () => zero });
      expect(reorged.counts.anchor_reorged).toBe(1);
      const changedCode = await auditPreparedPlatformRuns([row], pins,
        { ...rpc, getEscrowCode: async () => '0x6000' });
      expect(changedCode.counts.pin_mismatch).toBe(1);
      await expect(auditPreparedPlatformRuns(new Array(1025).fill(row), pins, rpc)).rejects.toThrow('at most 1024');
    } finally { await fixture.close(); }
  });
});
