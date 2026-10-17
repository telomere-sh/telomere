import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { hashJson } from '../src/common.js';
import { GolemFinancialLifecycle, GolemFinanceHttpProtocol, FileGolemFinanceLedger,
  type GolemFinanceFile } from '../src/suppliers/index.js';
import { golemAmountToBaseUnits, golemBaseUnitsToAmount, golemOriginalBinding, golemOriginalRunSchema,
  type GolemFinanceAction, type GolemFinanceAuthorities, type GolemFinanceBinding,
  type GolemFinanceProtocol } from '../src/suppliers/golem-finance-types.js';

const owner = '0x1111111111111111111111111111111111111111';
const requestorId = '0x2222222222222222222222222222222222222222';
const providerId = '0x3333333333333333333333333333333333333333';
const payeeAddr = '0x4444444444444444444444444444444444444444';
const payerAddr = '0x5555555555555555555555555555555555555555';
const runId = hashJson('golem-original-run');
const initialNow = 1_800_000_000_000;
const units = (amount: string) => golemAmountToBaseUnits(amount).toString();
const policy = { version: 1, policyId: hashJson('policy'), runAuthorityId: hashJson('run-authority'),
  treasuryAuthorityId: hashJson('treasury-authority'), finalityAuthorityId: hashJson('independent-finality'),
  requestorId, payerAddr, paymentPlatform: 'erc20-polygon-glm', tokenDecimals: 18,
  expiresAtMs: initialNow + 120_000, maxLifetimeGlmBaseUnits: units('40'), maxLifetimeUsdcMicros: '40000000', minimumConfirmations: 12 };
type Document = Record<string, unknown>;

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-golem-finance-')), path = join(directory, 'golem.json');
  let now = initialNow, active = true, originalOverride: Record<string, unknown> = {}, treasuryOverride: Record<string, unknown> = {};
  let confirmedStop = false, confirmedRelease = false, destroyed = false, terminated = false, released = false;
  let proofAuthority: string = policy.finalityAuthorityId, proofBinding: string | undefined;
  let beforeMutation: (() => Promise<void>) | undefined;
  let beforeTreasury: (() => Promise<void>) | undefined;
  let dropAction: GolemFinanceAction | undefined, release404 = false;
  const settled = new Set<string>(), settlementReferences = new Map<string, string>();
  const debit = new Map<string, Document>(), invoices = new Map<string, Document>(), payments = new Map<string, Document>();
  const calls: { method: string; path: string; body: unknown }[] = [], durable: GolemFinanceAction[] = [];
  const original = (id: string = runId) => ({ authorityId: policy.runAuthorityId, owner, runId: id,
    authorizationHash: hashJson({ original: id }), active, asOfMs: now, requestorId, providerId, payerAddr, payeeAddr,
    paymentPlatform: 'erc20-polygon-glm', allocationId: 'allocation-' + id.slice(2, 18),
    agreementId: 'agreement-' + id.slice(2, 18), activityId: 'activity-' + id.slice(2, 18),
    imageDigest: hashJson('reviewed-image'), spendUntilMs: initialNow + 60_000,
    maxGlmBaseUnits: units('10'), maxUsdcMicros: '10000000', ...originalOverride });
  let ledger = new FileGolemFinanceLedger(path, policy);
  const parties = () => ({ issuerId: providerId, recipientId: requestorId, payerAddr, payeeAddr,
    paymentPlatform: 'erc20-polygon-glm', agreementId: original().agreementId,
    timestamp: new Date(initialNow).toISOString(), status: 'RECEIVED' });
  const addDebit = (id: string, amount: string, change: Document = {}) => debit.set(id, {
    ...parties(), debitNoteId: id, activityId: original().activityId, previousDebitNoteId: null,
    totalAmountDue: amount, paymentDueDate: new Date(initialNow + 30_000).toISOString(), ...change });
  const addInvoice = (id: string, amount: string, change: Document = {}) => invoices.set(id, {
    ...parties(), invoiceId: id, activityIds: [original().activityId], amount,
    paymentDueDate: new Date(initialNow + 90_000).toISOString(), ...change });
  const addPayment = (id: string, amount: string, kind: 'activity' | 'agreement' = 'activity', change: Document = {}) => payments.set(id, {
    paymentId: id, payerId: requestorId, payeeId: providerId, payerAddr, payeeAddr,
    paymentPlatform: 'erc20-polygon-glm', amount, timestamp: new Date(initialNow).toISOString(), details: 'local-protocol-proof-fixture',
    agreementPayments: kind === 'agreement' ? [{ agreementId: original().agreementId, allocationId: original().allocationId, amount }] : [],
    activityPayments: kind === 'activity' ? [{ activityId: original().activityId, allocationId: original().allocationId, amount }] : [], ...change });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.authorization !== 'Bearer local-protocol-harness') { response.writeHead(401).end(); return; }
    const method = request.method ?? '', url = request.url ?? '', parts = url.split('/'), id = parts.at(-1)!;
    let raw = ''; for await (const chunk of request) { raw += String(chunk); if (raw.length > 4096) throw new Error('Fixture body exceeded limit'); }
    const body: unknown = raw ? JSON.parse(raw) : null; calls.push({ method, path: url, body });
    response.setHeader('content-type', 'application/json');
    if (method === 'GET') {
      const source = url.includes('/debitNotes/') ? debit : url.includes('/invoices/') ? invoices : url.includes('/payments/') ? payments : undefined;
      const value = source?.get(id);
      if (!value) { response.writeHead(404).end('{}'); return; }
      response.end(JSON.stringify(value)); return;
    }
    const action: GolemFinanceAction = url.includes('/debitNotes/') ? 'accept_debit' : url.includes('/invoices/') ? 'accept_invoice'
      : url.includes('/activity/') ? 'destroy_activity' : url.includes('/agreements/') ? 'terminate_agreement' : 'release_allocation';
    const resource = action.startsWith('accept_') || action === 'terminate_agreement' ? parts.at(-2)! : id;
    const saved = await ledger.read();
    if (!saved.records.some(row => row.intents.some(intent => intent.action === action && intent.resourceId === resource && intent.status === 'pending'))) {
      throw new Error('Actual mutation arrived without a durable original intent');
    }
    durable.push(action); await beforeMutation?.();
    if (action === 'accept_debit' || action === 'accept_invoice') {
      const doc = (action === 'accept_debit' ? debit : invoices).get(resource);
      if (!doc) { response.writeHead(404).end('{}'); return; }
      const expectedAmount = action === 'accept_debit' ? doc.totalAmountDue : doc.amount;
      const value = body as { allocationId?: unknown; totalAmountAccepted?: unknown };
      const expectedUnits = expectedAmount === '1E-18' ? 1n : golemAmountToBaseUnits(expectedAmount);
      if (value.allocationId !== original().allocationId || golemAmountToBaseUnits(value.totalAmountAccepted) !== expectedUnits) {
        throw new Error('Changed original financial payload');
      }
      doc.status = 'ACCEPTED';
    } else if (action === 'destroy_activity') destroyed = true;
    else if (action === 'terminate_agreement') terminated = true;
    else if (release404) { response.writeHead(404).end('{}'); return; }
    else released = true;
    if (dropAction === action) { dropAction = undefined; request.socket.destroy(); return; }
    if (action === 'terminate_agreement') response.writeHead(204).end();
    else response.end('null');
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => { response.writeHead(500).end('{}'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const origin = 'http://127.0.0.1:' + address.port;
  const transport = new GolemFinanceHttpProtocol({ endpoint: origin, apiKey: 'local-protocol-harness',
    allowLocalHttp: true, timeoutMs: 250 });
  const protocol: GolemFinanceProtocol = {
    document: (kind, id, signal) => transport.document(kind, id, signal),
    payment: (id, signal) => transport.payment(id, signal),
    mutate: (action, binding, id, amount, signal) => transport.mutate(action, binding, id, amount, signal),
  };
  const evidence = (binding: GolemFinanceBinding) => ({ authorityId: proofAuthority,
    bindingHash: proofBinding ?? hashJson(binding), asOfMs: now });
  const authorities: GolemFinanceAuthorities = {
    originalRun: async (_owner, id) => original(id),
    treasury: async () => { await beforeTreasury?.(); return { authorityId: policy.treasuryAuthorityId, policyId: policy.policyId, requestorId, payerAddr,
      paymentPlatform: 'erc20-polygon-glm', availableGlmBaseUnits: units('100'), availableUsdcMicros: '100000000',
      evidenceHash: hashJson('initial-independent-inventory'), asOfMs: now, ...treasuryOverride }; },
    stop: async binding => confirmedStop && destroyed && terminated
      ? { ...evidence(binding), confirmed: true, proofHash: hashJson({ stop: binding }), activityId: binding.activityId,
        agreementId: binding.agreementId, activityStoppedAtMs: now, agreementTerminatedAtMs: now }
      : { ...evidence(binding), confirmed: false },
    payment: async (binding, payment) => settled.has(payment.paymentId)
      ? { ...evidence(binding), confirmed: true, paymentId: payment.paymentId, paymentHash: hashJson(payment),
        proofHash: hashJson({ canonicalFixturePayment: payment }),
        settlementReference: settlementReferences.get(payment.paymentId) ?? hashJson({ fixtureTransfer: payment.paymentId }), confirmations: 12 }
      : { ...evidence(binding), confirmed: false, paymentId: payment.paymentId, paymentHash: hashJson(payment) },
    release: async binding => confirmedRelease && released
      ? { ...evidence(binding), confirmed: true, proofHash: hashJson({ release: binding }), allocationId: binding.allocationId }
      : { ...evidence(binding), confirmed: false },
  };
  const makeService = () => new GolemFinancialLifecycle({ ledger, protocol, authorities, now: () => now, ioTimeoutMs: 250 });
  let service = makeService();
  return { directory, path, protocol, authorities, calls, durable, debit, invoices, payments, settled,
    original, addDebit, addInvoice, addPayment, settlementReferences,
    observeExternalStop() { destroyed = true; terminated = true; },
    get service() { return service; }, get ledger() { return ledger; },
    set now(value: number) { now = value; }, get now() { return now; },
    set active(value: boolean) { active = value; },
    set originalOverride(value: Record<string, unknown>) { originalOverride = value; },
    set treasuryOverride(value: Record<string, unknown>) { treasuryOverride = value; },
    set confirmStop(value: boolean) { confirmedStop = value; }, set confirmRelease(value: boolean) { confirmedRelease = value; },
    set proofAuthority(value: string) { proofAuthority = value; }, set proofBinding(value: string) { proofBinding = value; },
    set beforeMutation(value: (() => Promise<void>) | undefined) { beforeMutation = value; },
    set beforeTreasury(value: (() => Promise<void>) | undefined) { beforeTreasury = value; },
    set drop(value: GolemFinanceAction | undefined) { dropAction = value; }, set release404(value: boolean) { release404 = value; },
    reopen() { ledger = new FileGolemFinanceLedger(path, policy); service = makeService(); },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const owned: Harness[] = [];
async function setup() { const value = await harness(); owned.push(value); await value.service.initializeFresh(); await value.service.admit(owner, runId, 'original'); return value; }
afterEach(async () => { for (const value of owned.splice(0)) await value.close(); });

describe('bounded unmounted Golem financial lifecycle through an actual local HTTP protocol harness', () => {
  it('accepts cumulative1→2→2 and invoice2 as total2, separates paid/settled, confirms stop/release and never renews lifetime authority', async () => {
    const h = await setup();
    h.addDebit('d1', '1'); h.addDebit('d2', '2'); h.addDebit('d3', '2'); h.addInvoice('i1', '2');
    for (const id of ['d1', 'd2', 'd3']) await h.service.acceptDebit(owner, runId, id, id);
    expect((await h.service.acceptInvoice(owner, runId, 'i1', 'invoice')).acceptedBaseUnits).toBe(units('2'));
    expect(h.durable.filter(value => value.startsWith('accept_'))).toHaveLength(4);
    const before = h.calls.filter(value => value.method === 'POST').length;
    await h.service.acceptDebit(owner, runId, 'd2', 'another-retry-key');
    expect(h.calls.filter(value => value.method === 'POST')).toHaveLength(before);
    h.addPayment('p1', '1'); h.addPayment('p2', '1', 'agreement');
    let state = await h.service.reconcile(owner, runId, { paymentIds: ['p1', 'p1', 'p2'] });
    expect([state.acceptedBaseUnits, state.paidBaseUnits, state.settledBaseUnits]).toEqual([units('2'), units('2'), '0']);
    await expect(h.service.releaseAllocation(owner, runId, 'premature')).rejects.toMatchObject({ code: 'golem_release_unproven' });
    await h.service.requestStop(owner, runId, 'stop');
    expect((await h.service.reconcile(owner, runId)).stopProofHash).toBeNull();
    h.confirmStop = true; h.settled.add('p1'); h.settled.add('p2');
    state = await h.service.reconcile(owner, runId);
    expect(state.state).toBe('settled');
    state = await h.service.releaseAllocation(owner, runId, 'release');
    expect(state.state).toBe('settled'); expect(state.reserveHeldGlmBaseUnits).toBe(units('10'));
    h.confirmRelease = true; h.reopen();
    state = await h.service.reconcile(owner, runId);
    expect(state.state).toBe('complete'); expect(state.reserveHeldGlmBaseUnits).toBe('0');
    expect(state.allocationIsExternalLiabilityCap).toBe(false);
    for (let i = 0; i < 3; i++) await h.service.admit(owner, hashJson('another-run-' + i), 'another-' + i);
    await expect(h.service.admit(owner, hashJson('fifth'), 'fifth')).rejects.toMatchObject({ code: 'golem_lifetime_budget' });
    expect(h.durable.filter(value => value === 'release_allocation')).toHaveLength(1);
  });
  it('persists before a dropped accept response, survives restart and reconciles without another POST or renewed intent', async () => {
    const h = await setup(); h.addDebit('lost', '2'); h.drop = 'accept_debit';
    await expect(h.service.acceptDebit(owner, runId, 'lost', 'lost-key')).rejects.toMatchObject({ code: 'golem_outcome_unknown' });
    expect((await h.service.get(owner, runId)).intents[0]?.status).toBe('unknown'); h.reopen();
    const replay = await h.service.acceptDebit(owner, runId, 'lost', 'new-key-does-not-retry');
    expect(replay.acceptedBaseUnits).toBe('0'); expect(replay.reserveHeldGlmBaseUnits).toBe(units('10'));
    h.addDebit('later', '3');
    await expect(h.service.acceptDebit(owner, runId, 'later', 'later-key')).rejects.toMatchObject({ code: 'golem_acceptance_unknown' });
    expect((await h.service.reconcile(owner, runId)).acceptedBaseUnits).toBe(units('2'));
    expect(h.durable.filter(value => value === 'accept_debit')).toHaveLength(1);
    await h.service.acceptDebit(owner, runId, 'later', 'later-key');
    expect((await h.service.get(owner, runId)).acceptedBaseUnits).toBe(units('3'));
  });
  it('fences kill/expiry increases while allowing the original final invoice at the already accepted debt', async () => {
    const h = await setup(); h.addDebit('d', '2'); await h.service.acceptDebit(owner, runId, 'd', 'd');
    h.drop = 'destroy_activity'; await h.service.requestStop(owner, runId, 'kill');
    await h.service.requestStop(owner, runId, 'another-kill-key');
    expect(h.durable.filter(value => value === 'destroy_activity')).toHaveLength(1);
    expect(h.durable.filter(value => value === 'terminate_agreement')).toHaveLength(1);
    h.active = false; h.now += 61_000; h.addDebit('new', '3');
    await expect(h.service.acceptDebit(owner, runId, 'new', 'new')).rejects.toMatchObject({ code: 'golem_spend_disabled' });
    h.addInvoice('final', '2');
    expect((await h.service.acceptInvoice(owner, runId, 'final', 'final')).acceptedBaseUnits).toBe(units('2'));
    expect((await h.service.get(owner, runId)).reserveHeldGlmBaseUnits).toBe(units('10'));
    await expect(h.service.releaseAllocation(owner, runId, 'release')).rejects.toMatchObject({ code: 'golem_release_unproven' });
  });
  it('persists a disputed higher final invoice after stop and never calls accept/release for it', async () => {
    const h = await setup(); h.addDebit('d', '2'); await h.service.acceptDebit(owner, runId, 'd', 'd');
    await h.service.requestStop(owner, runId, 'stop'); h.addInvoice('too-high', '3');
    await expect(h.service.acceptInvoice(owner, runId, 'too-high', 'invoice')).rejects.toMatchObject({ code: 'golem_invoice_disputed' });
    h.reopen(); const state = await h.service.get(owner, runId);
    expect(state.state).toBe('quarantined'); expect(state.acceptedBaseUnits).toBe(units('2'));
    expect(state.documents.find(value => value.kind === 'invoice')?.totalBaseUnits).toBe(units('3'));
    expect(h.durable).not.toContain('accept_invoice');
    await expect(h.service.releaseAllocation(owner, runId, 'release')).rejects.toMatchObject({ code: 'golem_release_unproven' });
  });
  it('normalizes Yagna scientific strings to exact18-decimal units and rejects invalid amounts before mutation', async () => {
    expect(golemAmountToBaseUnits('0.000000000000000001')).toBe(1n);
    expect(golemBaseUnitsToAmount('1000000000000000001')).toBe('1.000000000000000001');
    expect(() => golemAmountToBaseUnits('1E-18')).toThrow(); // The core DTO remains canonical decimal only.
    const h = await setup();
    for (const [index, amount] of ['-1', '1e-19', '0.0000000000000000001', '01', 1, Number.NaN].entries()) {
      h.addDebit('wrong-' + index, '1', { totalAmountDue: amount });
      await expect(h.service.acceptDebit(owner, runId, 'wrong-' + index, 'wrong-' + index)).rejects.toThrow();
    }
    expect(h.durable).toHaveLength(0); h.addDebit('atto-wire', '1E-18');
    expect((await h.service.acceptDebit(owner, runId, 'atto-wire', 'atto-wire')).acceptedBaseUnits).toBe('1');
    expect(h.calls.find(value => value.method === 'POST')?.body).toEqual({
      totalAmountAccepted: '0.000000000000000001', allocationId: h.original().allocationId });
    h.addDebit('atto', '1.000000000000000001');
    expect((await h.service.acceptDebit(owner, runId, 'atto', 'atto')).acceptedBaseUnits).toBe('1000000000000000001');
  });
  it('rejects hostile original authority, treasury, parties, platform, activity and changed document economics', async () => {
    const h = await setup();
    for (const [index, changes] of [{ issuerId: requestorId }, { recipientId: providerId }, { payeeAddr: payerAddr },
      { payerAddr: payeeAddr }, { agreementId: 'foreign-agreement' }, { activityId: 'foreign-activity' },
      { paymentPlatform: 'erc20-polygon-usdc' }].entries()) {
      h.addDebit('hostile-' + index, '1', changes);
      await expect(h.service.acceptDebit(owner, runId, 'hostile-' + index, 'hostile-' + index)).rejects.toThrow();
    }
    h.addDebit('safe', '1'); h.originalOverride = { authorizationHash: hashJson('replacement-approval') };
    await expect(h.service.acceptDebit(owner, runId, 'safe', 'safe')).rejects.toMatchObject({ code: 'golem_original_changed' });
    h.originalOverride = {}; h.treasuryOverride = { authorityId: hashJson('self-declared-inventory') };
    await expect(h.service.acceptDebit(owner, runId, 'safe', 'safe')).rejects.toMatchObject({ code: 'golem_treasury_scope' });
    h.treasuryOverride = {}; await h.service.acceptDebit(owner, runId, 'safe', 'safe');
    h.addDebit('safe', '2', { status: 'ACCEPTED' });
    await expect(h.service.reconcile(owner, runId)).rejects.toMatchObject({ code: 'golem_document_changed' });
    expect(h.durable.filter(value => value === 'accept_debit')).toHaveLength(1);
  });
  it('serializes competing accepts, rejects reused keys, cumulative regression and debit after final invoice', async () => {
    const h = await setup(); h.addDebit('one', '1');
    const raced = await Promise.allSettled([h.service.acceptDebit(owner, runId, 'one', 'one'), h.service.acceptDebit(owner, runId, 'one', 'one')]);
    expect(raced.some(value => value.status === 'fulfilled')).toBe(true);
    expect(h.durable.filter(value => value === 'accept_debit')).toHaveLength(1);
    h.addDebit('two', '2');
    await expect(h.service.acceptDebit(owner, runId, 'two', 'one')).rejects.toMatchObject({ code: 'golem_idempotency_conflict' });
    h.addDebit('regressed', '0.5');
    await expect(h.service.acceptDebit(owner, runId, 'regressed', 'regressed')).rejects.toMatchObject({ code: 'golem_debit_regression' });
    h.addInvoice('invoice', '1'); await h.service.acceptInvoice(owner, runId, 'invoice', 'invoice');
    await expect(h.service.acceptDebit(owner, runId, 'two', 'two')).rejects.toMatchObject({ code: 'golem_debit_regression' });
  });
  it('never treats document SETTLED, HTTP200/404 or a foreign finality assertion as independent settlement/release', async () => {
    const h = await setup(); h.addDebit('d', '1'); await h.service.acceptDebit(owner, runId, 'd', 'd');
    h.addInvoice('invoice', '1'); await h.service.acceptInvoice(owner, runId, 'invoice', 'invoice');
    h.invoices.get('invoice')!.status = 'SETTLED'; h.addPayment('p', '1'); await h.service.requestStop(owner, runId, 'stop');
    let state = await h.service.reconcile(owner, runId, { paymentIds: ['p'] });
    expect(state.settledBaseUnits).toBe('0'); expect(state.stopProofHash).toBeNull();
    h.confirmStop = true; h.settled.add('p'); h.proofAuthority = hashJson('untrusted-self-declaration');
    await expect(h.service.reconcile(owner, runId)).rejects.toMatchObject({ code: 'golem_proof_scope' });
    h.proofAuthority = policy.finalityAuthorityId; h.proofBinding = hashJson('another-binding');
    await expect(h.service.reconcile(owner, runId)).rejects.toMatchObject({ code: 'golem_proof_scope' });
    h.proofBinding = hashJson(golemOriginalBinding(golemOriginalRunSchema.parse(h.original()))); h.release404 = true;
    state = await h.service.releaseAllocation(owner, runId, 'release');
    expect(state.state).toBe('settled'); expect(state.releaseProofHash).toBeNull();
    h.reopen(); await h.service.releaseAllocation(owner, runId, 'different-release-key');
    expect(h.durable.filter(value => value === 'release_allocation')).toHaveLength(1);
  });
  it('conserves scoped batched payments, rejects overlap/allocation substitution and cannot reuse a full batch across runs', async () => {
    const h = await setup(); h.addDebit('d', '2'); await h.service.acceptDebit(owner, runId, 'd', 'd');
    const newRun = hashJson('different-run'), other = h.original(newRun);
    await h.service.admit(owner, newRun, 'different-run');
    h.addPayment('batch', '3', 'activity', { activityPayments: [{ activityId: h.original().activityId,
      allocationId: h.original().allocationId, amount: '2' }], agreementPayments: [{ agreementId: other.agreementId, allocationId: other.allocationId, amount: '1' }] });
    expect((await h.service.reconcile(owner, runId, { paymentIds: ['batch'] })).paidBaseUnits).toBe(units('2'));
    expect((await h.service.reconcile(owner, newRun, { paymentIds: ['batch'] })).paidBaseUnits).toBe(units('1'));
    h.addPayment('overlap', '2', 'activity', { activityPayments: [
      { activityId: h.original().activityId, allocationId: h.original().allocationId, amount: '1' },
      { activityId: h.original().activityId, allocationId: h.original().allocationId, amount: '1' }] });
    await expect(h.service.reconcile(owner, runId, { paymentIds: ['overlap'] })).rejects.toMatchObject({ code: 'golem_payment_shares' });
    h.addPayment('allocation-swap', '1', 'activity', { activityPayments: [{ activityId: h.original().activityId, allocationId: 'other-allocation', amount: '1' }] });
    await expect(h.service.reconcile(owner, runId, { paymentIds: ['allocation-swap'] })).rejects.toMatchObject({ code: 'golem_payment_allocation' });
    const before = await readFile(h.path);
    await expect(h.ledger.transact(file => { file.records[0]!.acceptedBaseUnits = '99'; })).rejects.toThrow('invariants');
    expect(await readFile(h.path)).toEqual(before);
    await expect(h.ledger.transact(file => { file.records[0]!.intents[0]!.totalBaseUnits = '3'; })).rejects.toThrow('binding');
    expect(await readFile(h.path)).toEqual(before);
    const batch = h.payments.get('batch')!;
    h.payments.set('batch', { ...batch, activityPayments: [], agreementPayments: [{ agreementId: other.agreementId, allocationId: other.allocationId, amount: '3' }] });
    await expect(h.service.reconcile(owner, newRun, { paymentIds: ['batch'] })).rejects.toMatchObject({ code: 'golem_payment_changed' });
  });
  it('refuses lost marker, changed policy, zero initial stock and reinitialization instead of renewing a reservation', async () => {
    const h = await setup(), before = await readFile(h.path);
    await expect(h.service.initializeFresh()).rejects.toThrow('already exists'); expect(await readFile(h.path)).toEqual(before);
    await expect(new FileGolemFinanceLedger(h.path, { ...policy, maxLifetimeGlmBaseUnits: units('50') }).read()).rejects.toThrow('identity differs');
    await unlink(h.path + '.initialized'); await expect(h.service.get(owner, runId)).rejects.toThrow();
    await expect(h.service.initializeFresh()).rejects.toThrow('already exists');
    const empty = await harness(); owned.push(empty); empty.treasuryOverride = { availableGlmBaseUnits: '0' };
    await expect(empty.service.initializeFresh()).rejects.toMatchObject({ code: 'golem_initial_inventory_empty' });
    await expect(readFile(empty.path)).rejects.toThrow();
  });
  it('retains one chain settlement identity through finality loss and restart and refuses a new API payment alias', async () => {
    const h = await setup(), reference = hashJson('one-chain-transfer');
    h.addPayment('original-payment', '1'); h.settled.add('original-payment');
    h.settlementReferences.set('original-payment', reference);
    const confirmed = await h.service.reconcile(owner, runId, { paymentIds: ['original-payment'] });
    expect(confirmed.settledBaseUnits).toBe(units('1'));
    expect(confirmed.payments[0]?.settlementReference).toBe(reference);
    h.settled.delete('original-payment'); h.reopen();
    const withdrawn = await h.service.reconcile(owner, runId);
    expect(withdrawn.settledBaseUnits).toBe('0'); expect(withdrawn.payments[0]?.settlementReference).toBe(reference);
    h.addPayment('renamed-payment', '1'); h.settled.add('renamed-payment');
    h.settlementReferences.set('renamed-payment', reference);
    const before = await readFile(h.path);
    await expect(h.service.reconcile(owner, runId, { paymentIds: ['renamed-payment'] })).rejects.toMatchObject({ code: 'golem_settlement_reused' });
    expect(await readFile(h.path)).toEqual(before);
    h.settled.add('original-payment');
    expect((await h.service.reconcile(owner, runId)).settledBaseUnits).toBe(units('1'));
  });
  it('refuses settlement aliases across original runs and replacement references for an existing payment', async () => {
    const h = await setup(), reference = hashJson('shared-chain-transfer'), otherRun = hashJson('alias-other-run');
    await h.service.admit(owner, otherRun, 'alias-other');
    h.addPayment('p-one', '1'); h.settled.add('p-one'); h.settlementReferences.set('p-one', reference);
    await h.service.reconcile(owner, runId, { paymentIds: ['p-one'] });
    h.addPayment('p-two', '1', 'activity', { activityPayments: [{ activityId: h.original(otherRun).activityId,
      allocationId: h.original(otherRun).allocationId, amount: '1' }] });
    h.settled.add('p-two'); h.settlementReferences.set('p-two', reference);
    const before = await readFile(h.path);
    await expect(h.service.reconcile(owner, otherRun, { paymentIds: ['p-two'] })).rejects.toMatchObject({ code: 'golem_settlement_reused' });
    expect(await readFile(h.path)).toEqual(before);
    h.settlementReferences.set('p-one', hashJson('replacement-chain-transfer'));
    await expect(h.service.reconcile(owner, runId)).rejects.toMatchObject({ code: 'golem_settlement_reused' });
    expect(await readFile(h.path)).toEqual(before);
  });
  it('defends the retained settlement index at the storage boundary, including after proof withdrawal', async () => {
    const h = await setup(); h.addPayment('one', '1'); h.settled.add('one');
    await h.service.reconcile(owner, runId, { paymentIds: ['one'] });
    h.settled.delete('one'); await h.service.reconcile(owner, runId);
    const before = await readFile(h.path);
    await expect(h.ledger.transact(file => {
      const row = file.records[0]!, original = row.payments[0]!;
      row.payments.push({ ...original, id: 'alias', hash: hashJson('alias') });
      row.paidBaseUnits = units('2');
    })).rejects.toThrow('another payment identity');
    expect(await readFile(h.path)).toEqual(before);
  });
  it('reads old unconfirmed private records conservatively and refuses legacy confirmed records without a transfer reference', async () => {
    const h = await setup(); h.addPayment('pending-old', '1');
    await h.service.reconcile(owner, runId, { paymentIds: ['pending-old'] });
    const pending = await readFile(h.path, 'utf8');
    expect(pending).toContain('"settlementReference":null');
    await writeFile(h.path, pending.replace(',"settlementReference":null', ''));
    h.reopen(); expect((await h.service.get(owner, runId)).payments[0]?.settlementReference).toBeNull();
    h.settled.add('pending-old'); await h.service.reconcile(owner, runId);
    const confirmed = await readFile(h.path, 'utf8'), reference = hashJson({ fixtureTransfer: 'pending-old' });
    expect(confirmed).toContain('"settlementReference":"' + reference + '"');
    await writeFile(h.path, confirmed.replace(',"settlementReference":"' + reference + '"', ''));
    h.reopen(); await expect(h.service.get(owner, runId)).rejects.toThrow('invariants');
  });
  it('freezes reviewed policy/options and refuses zero reviewed addresses before any financial mutation', async () => {
    const h = await setup(), originalPolicyHash = h.ledger.policyHash;
    expect(() => { h.ledger.policy.maxLifetimeGlmBaseUnits = units('1000000'); }).toThrow();
    expect(h.ledger.policyHash).toBe(originalPolicyHash); expect(h.ledger.policy.maxLifetimeGlmBaseUnits).toBe(units('40'));
    const options = { ledger: h.ledger, protocol: h.protocol, authorities: h.authorities, now: () => h.now };
    const service = new GolemFinancialLifecycle(options);
    options.ledger = new FileGolemFinanceLedger(join(h.directory, 'other.json'), policy);
    expect((await service.get(owner, runId)).original.runId).toBe(runId);
    const zero = '0x' + '0'.repeat(40);
    expect(() => new FileGolemFinanceLedger(h.path, { ...policy, payerAddr: zero })).toThrow('nonzero');
    for (const [field, value] of [['owner', zero], ['payerAddr', zero], ['payeeAddr', zero]] as const) {
      h.originalOverride = { [field]: value }; h.addDebit('zero-' + field, '1');
      await expect(h.service.acceptDebit(owner, runId, 'zero-' + field, 'zero-' + field)).rejects.toThrow();
    }
    expect(h.durable).toHaveLength(0);
  });
  it('queues a kill during document reads before final dispatch and sends zero accept POSTs', async () => {
    const h = await setup(); h.addDebit('d', '1');
    let entered!: () => void, resume!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; }), pause = new Promise<void>(resolve => { resume = resolve; });
    const document = h.protocol.document; let first = true;
    h.protocol.document = async (kind, id, signal) => {
      if (first) { first = false; entered(); await pause; }
      return document(kind, id, signal);
    };
    const accept = h.service.acceptDebit(owner, runId, 'd', 'd'); await inside;
    const stopping = h.service.requestStop(owner, runId, 'stop-wins'); resume();
    const outcomes = await Promise.allSettled([accept, stopping]);
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { code: 'golem_spend_disabled' } });
    expect(outcomes[1]?.status).toBe('fulfilled');
    expect(h.durable).not.toContain('accept_debit');
    expect((await h.service.get(owner, runId)).intents.find(value => value.action === 'accept_debit')?.status).toBe('aborted_before_send');
  });
  it('linearizes dispatch before a concurrent stop while preserving one original attempt and the later stop fence', async () => {
    const h = await setup(); h.addDebit('d', '1');
    let entered!: () => void, resume!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; }), pause = new Promise<void>(resolve => { resume = resolve; });
    h.beforeMutation = async () => { if (h.durable.at(-1) === 'accept_debit') { entered(); await pause; } };
    const accept = h.service.acceptDebit(owner, runId, 'd', 'd'); await inside;
    let stopComplete = false;
    const stopping = h.service.requestStop(owner, runId, 'stop-after-dispatch').then(value => { stopComplete = true; return value; });
    expect(stopComplete).toBe(false); expect((await h.service.get(owner, runId)).stopRequestedAtMs).toBeNull();
    resume(); const results = await Promise.allSettled([accept, stopping]);
    expect(results[1]?.status).toBe('fulfilled'); expect((await h.service.get(owner, runId)).stopRequestedAtMs).not.toBeNull();
    expect(h.durable.filter(value => value === 'accept_debit')).toHaveLength(1);
    h.addDebit('new', '2'); await expect(h.service.acceptDebit(owner, runId, 'new', 'new')).rejects.toMatchObject({ code: 'golem_spend_disabled' });
  });
  it('rechecks expiry after awaited treasury evidence and sends no expired accept', async () => {
    const h = await setup(); h.addDebit('d', '1'); let reads = 0;
    h.beforeTreasury = async () => { if (++reads === 2) h.now += 61_000; };
    await expect(h.service.acceptDebit(owner, runId, 'd', 'd')).rejects.toMatchObject({ code: 'golem_spend_disabled' });
    expect(h.durable).not.toContain('accept_debit');
  });
  it('restores the full hold when a current independent release proof is no longer confirmed, without another DELETE', async () => {
    const h = await setup(); h.addDebit('d', '1'); h.addInvoice('i', '1');
    await h.service.acceptDebit(owner, runId, 'd', 'd'); await h.service.acceptInvoice(owner, runId, 'i', 'i');
    h.addPayment('p', '1'); h.settled.add('p'); h.confirmStop = true; h.confirmRelease = true;
    await h.service.requestStop(owner, runId, 'stop'); await h.service.reconcile(owner, runId, { paymentIds: ['p'] });
    expect((await h.service.releaseAllocation(owner, runId, 'release')).state).toBe('complete');
    h.confirmRelease = false; h.reopen();
    const held = await h.service.reconcile(owner, runId);
    expect(held.releaseProofHash).toBeNull(); expect(held.reserveHeldGlmBaseUnits).toBe(units('10'));
    await h.service.releaseAllocation(owner, runId, 'new-release-key');
    expect(h.durable.filter(value => value === 'release_allocation')).toHaveLength(1);
  });
  it('fences an independently observed physical stop permanently, including after proof loss and restart', async () => {
    const h = await setup(); h.addDebit('d', '1'); await h.service.acceptDebit(owner, runId, 'd', 'd');
    h.observeExternalStop(); h.confirmStop = true;
    const stopped = await h.service.reconcile(owner, runId);
    expect(stopped.stopRequestedAtMs).not.toBeNull(); expect(stopped.stopProofHash).not.toBeNull();
    expect(h.durable).not.toContain('destroy_activity'); expect(h.durable).not.toContain('terminate_agreement');
    h.confirmStop = false; h.reopen();
    const held = await h.service.reconcile(owner, runId);
    expect(held.stopProofHash).toBeNull(); expect(held.stopRequestedAtMs).toBe(stopped.stopRequestedAtMs);
    h.addDebit('new', '2');
    await expect(h.service.acceptDebit(owner, runId, 'new', 'new')).rejects.toMatchObject({ code: 'golem_spend_disabled' });
    expect(h.durable.filter(value => value === 'accept_debit')).toHaveLength(1);
    h.addInvoice('final', '1');
    expect((await h.service.acceptInvoice(owner, runId, 'final', 'final')).acceptedBaseUnits).toBe(units('1'));
    expect((await h.service.get(owner, runId)).reserveHeldGlmBaseUnits).toBe(units('10'));
  });
  it('rechecks newly revoked local finality between release-intent persistence and dispatch and never retries the DELETE', async () => {
    const h = await setup(); h.addDebit('d', '1'); h.addInvoice('i', '1');
    await h.service.acceptDebit(owner, runId, 'd', 'd'); await h.service.acceptInvoice(owner, runId, 'i', 'i');
    h.addPayment('p', '1'); h.settled.add('p'); h.confirmStop = true;
    await h.service.requestStop(owner, runId, 'stop'); await h.service.reconcile(owner, runId, { paymentIds: ['p'] });
    let entered!: () => void, resume!: () => void, paused = false;
    const inside = new Promise<void>(resolve => { entered = resolve; }), pause = new Promise<void>(resolve => { resume = resolve; });
    const transact = h.ledger.transact.bind(h.ledger);
    h.ledger.transact = async <T>(change: (file: GolemFinanceFile) => T | Promise<T>): Promise<T> => {
      const result = await transact(change);
      if (!paused && (await h.ledger.read()).records[0]!.intents.some(value => value.action === 'release_allocation' && value.status === 'pending')) {
        paused = true; entered(); await pause;
      }
      return result;
    };
    const releasing = h.service.releaseAllocation(owner, runId, 'release'); await inside;
    h.confirmStop = false;
    const revocation = h.service.reconcile(owner, runId); resume();
    const results = await Promise.allSettled([releasing, revocation]);
    expect(results.every(value => value.status === 'fulfilled')).toBe(true);
    const held = await h.service.get(owner, runId);
    expect(held.stopProofHash).toBeNull(); expect(held.reserveHeldGlmBaseUnits).toBe(units('10'));
    expect(held.intents.find(value => value.action === 'release_allocation')?.status).toBe('aborted_before_send');
    expect(h.durable).not.toContain('release_allocation');
    h.confirmStop = true; await h.service.releaseAllocation(owner, runId, 'new-key');
    expect(h.durable).not.toContain('release_allocation');
  });
});
