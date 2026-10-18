import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, link, lstat, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { hashJson, randomId } from '../src/common.js';
import { GolemAllocationAttributionReader, GolemAttributedFinanceProtocol, GOLEM_ATTRIBUTION_TABLES,
  golemAttributionSchemaHash, type GolemAttributionPolicy } from '../src/suppliers/golem-allocation-attribution.js';
import { GolemFinanceHttpProtocol } from '../src/suppliers/golem-finance-http.js';
import { GolemFinancialLifecycle } from '../src/suppliers/golem-finance.js';
import { FileGolemFinanceLedger } from '../src/suppliers/golem-finance-ledger.js';
import { golemAmountToBaseUnits, golemOriginalRunSchema, type GolemFinanceAuthorities } from '../src/suppliers/golem-finance-types.js';

const owner = '0x1111111111111111111111111111111111111111', requestor = '0x2222222222222222222222222222222222222222',
  provider = '0x3333333333333333333333333333333333333333', payer = '0x4444444444444444444444444444444444444444',
  payee = '0x5555555555555555555555555555555555555555';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const root = new URL('../docs/evidence/golem-allocation-upstream-20261015/', import.meta.url);
async function setup(wal = false) {
  const directory = await mkdtemp(join(tmpdir(), 'telomere-native-yagna-')), path = join(directory, 'payment.db');
  await chmod(directory, 0o700); let db: DatabaseSync | undefined;
  cleanups.push(async () => { db?.close(); db = undefined; await rm(directory, { recursive: true, force: true }); });
  db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  const initial = await readFile(new URL('core/payment/migrations/2020-01-23-123456_init/up.sql', root), 'utf8');
  const extended = await readFile(new URL('core/payment/migrations/2024-08-12-171012_extended_order/up.sql', root), 'utf8');
  // Real native SQLite tables, using unchanged upstream DDL rather than a JSON
  // callback pretending to be a Yagna database. This is not a running daemon.
  for (const table of GOLEM_ATTRIBUTION_TABLES) {
    const source = table === 'pay_agreement' || table === 'pay_activity' ? initial : extended;
    const statement = new RegExp('CREATE TABLE ' + table + '\\s*\\([\\s\\S]*?\\n\\);').exec(source)?.[0];
    if (!statement) throw new Error('Retained native DDL absent'); db.exec(statement);
  }
  db.exec('CREATE INDEX pay_batch_order_item_payment_id ON pay_batch_order_item(payment_id);');
  const timestamp = '2026-10-15 00:00:00.000', transactionHash = randomId();
  const wire = { paymentId: 'native-payment-1', payerId: requestor, payeeId: provider, payerAddr: payer, payeeAddr: payee,
    paymentPlatform: 'erc20-polygon-glm', amount: '1', timestamp: '2026-10-15T00:00:00.000Z',
    details: Buffer.from(transactionHash.slice(2), 'hex').toString('base64'), signature: [1, 2], signedBytes: [3, 4],
    agreementPayments: [], activityPayments: [{ activityId: 'native-activity', amount: '1' }] };
  db.prepare(`INSERT INTO pay_agreement(id,owner_id,role,peer_id,payee_addr,payer_addr,payment_platform,total_amount_due,total_amount_accepted,total_amount_paid)
    VALUES(?,?,'R',?,?,?,'erc20-polygon-glm','1','1','1')`).run('native-agreement', requestor, provider, payee, payer);
  db.prepare(`INSERT INTO pay_activity(id,owner_id,role,agreement_id,total_amount_due,total_amount_accepted,total_amount_paid)
    VALUES(?,?,'R',?,'1','1','1')`).run('native-activity', requestor, 'native-agreement');
  db.prepare(`INSERT INTO pay_allocation(id,owner_id,payment_platform,address,avail_amount,spent_amount,timeout,released)
    VALUES(?,?,'erc20-polygon-glm',?,'0','1','2030-01-01 00:00:00',0)`).run('native-allocation', requestor, payer);
  db.prepare(`INSERT INTO pay_batch_order(id,owner_id,payer_addr,platform,total_amount,paid_amount)
    VALUES('native-order',?,?,'erc20-polygon-glm','1','1')`).run(requestor, payer);
  db.prepare(`INSERT INTO pay_batch_order_item(order_id,owner_id,payee_addr,allocation_id,amount,payment_id,paid)
    VALUES('native-order',?,?,'native-allocation','1',?,1)`).run(requestor, payee, wire.paymentId);
  db.prepare(`INSERT INTO pay_batch_order_item_document(order_id,owner_id,payee_addr,allocation_id,agreement_id,activity_id,debit_note_id,amount)
    VALUES('native-order',?,?,'native-allocation','native-agreement','native-activity','native-debit','1')`).run(requestor, payee);
  db.prepare(`INSERT INTO pay_payment(id,owner_id,peer_id,payee_addr,payer_addr,payment_platform,role,amount,timestamp,details)
    VALUES(?,?,?,?,?,'erc20-polygon-glm','R','1',?,?)`).run(wire.paymentId, requestor, provider, payee, payer, timestamp, Buffer.from(transactionHash.slice(2), 'hex'));
  db.prepare(`INSERT INTO pay_payment_document(payment_id,owner_id,peer_id,agreement_id,activity_id,amount)
    VALUES(?,?,?,'native-agreement','native-activity','1')`).run(wire.paymentId, requestor, provider);
  if (wal) { db.exec('PRAGMA journal_mode=WAL;'); db.prepare('UPDATE pay_payment SET send_payment=?').run(1); }
  await chmod(path, 0o600);
  if (wal) { await chmod(path + '-wal', 0o600); await chmod(path + '-shm', 0o600); }
  const file = await lstat(path, { bigint: true }), parent = await lstat(directory, { bigint: true });
  const schemaHash = golemAttributionSchemaHash(db.prepare('SELECT name,type,sql FROM sqlite_master WHERE name IN (?,?,?,?,?,?,?,?) ORDER BY name').all(...GOLEM_ATTRIBUTION_TABLES));
  const policy: GolemAttributionPolicy = { version: 1, sourceProfile: 'yagna-c256fce-local-sqlite-v1', databasePath: path,
    databaseDevice: file.dev.toString(), databaseInode: file.ino.toString(), directoryDevice: parent.dev.toString(), directoryInode: parent.ino.toString(),
    schemaHash, requestorId: requestor, payerAddr: payer, maxDatabaseBytes: 1_048_576, maxWalBytes: 1_048_576, maxShmBytes: 131_072, timeoutMs: 5000 };
  return { directory, path, db, wire, policy, reader: new GolemAllocationAttributionReader(policy),
    closeDb() { db?.close(); db = undefined; },
    mutate(sql: string, ...params: (string | number | null)[]) { if (!db) throw new Error('Closed fixture'); db.prepare(sql).run(...params); } };
}

it('reconstructs omitted allocation only from the actual native payment→order→document join and preserves the database bytes', async () => {
  const f = await setup(), before = await readFile(f.path);
  const result = await f.reader.attribute(f.wire, signal());
  expect(result).toMatchObject({ source: 'operator-local-yagna-sqlite', allocationAttribution: 'exact-native-payment-order-document-join',
    payment: { paymentId: f.wire.paymentId, activityPayments: [{ activityId: 'native-activity', allocationId: 'native-allocation', amount: '1' }] } });
  expect('allocationId' in f.wire.activityPayments[0]!).toBe(false);
  expect((await readFile(f.path)).equals(before)).toBe(true); expect('confirmed' in result).toBe(false);
});

it('reads a real existing WAL snapshot without changing DB/WAL bytes and refuses WAL over the reviewed bound', async () => {
  const f = await setup(true), before = await Promise.all([readFile(f.path), readFile(f.path + '-wal')]);
  expect((await f.reader.attribute(f.wire, signal())).payment.activityPayments[0]?.allocationId).toBe('native-allocation');
  const after = await Promise.all([readFile(f.path), readFile(f.path + '-wal')]); expect(after.every((value, index) => value.equals(before[index]!))).toBe(true);
  await expect(new GolemAllocationAttributionReader({ ...f.policy, maxWalBytes: 0 }).attribute(f.wire, signal())).rejects.toMatchObject({ code: 'golem_allocation_attribution_unavailable' });
});

it.each([
  ['payment-id', "UPDATE pay_batch_order_item SET payment_id='another-payment'"],
  ['unpaid', 'UPDATE pay_batch_order_item SET paid=0'],
  ['item-total', "UPDATE pay_batch_order_item SET amount='0.5'"],
  ['document-total', "UPDATE pay_batch_order_item_document SET amount='0.5'"],
  ['order-payer', "UPDATE pay_batch_order SET payer_addr='0x6666666666666666666666666666666666666666'"],
  ['order-platform', "UPDATE pay_batch_order SET platform='erc20-holesky-tglm'"],
  ['agreement-peer', "UPDATE pay_agreement SET peer_id='0x6666666666666666666666666666666666666666'"],
  ['foreign-activity', "UPDATE pay_batch_order_item_document SET activity_id='foreign-activity'"],
  ['orphan-order', 'DELETE FROM pay_batch_order'],
  ['orphan-allocation', 'DELETE FROM pay_allocation'],
  ['payment-details', "UPDATE pay_payment SET details=zeroblob(32)"],
  ['oversized-native-proof', "UPDATE pay_payment SET details=zeroblob(100000)"],
  ['payment-role', "UPDATE pay_payment SET role='P'"],
  ['native-payment-share', "UPDATE pay_payment_document SET amount='2'"],
  ['oversized-native-field', "UPDATE pay_batch_order SET platform=printf('%0200000d',1)"],
  ['deposit', "UPDATE pay_allocation SET deposit='unsupported-deposit',deposit_status='open'"],
] as const)('refuses exact native attribution mismatch: %s', async (_label, sql) => {
  const f = await setup(); f.db.exec(sql);
  await expect(f.reader.attribute(f.wire, signal())).rejects.toMatchObject({ code: 'golem_allocation_attribution_unavailable' });
});

it('rejects mixed allocations, duplicate native documents and schema changes rather than allocating by amount', async () => {
  const f = await setup();
  f.db.exec(`UPDATE pay_batch_order_item SET amount='0.5'; UPDATE pay_batch_order_item_document SET amount='0.5';
    INSERT INTO pay_allocation SELECT 'other-allocation',owner_id,payment_platform,address,avail_amount,spent_amount,created_ts,updated_ts,timeout,released,deposit,deposit_status FROM pay_allocation;
    INSERT INTO pay_batch_order_item SELECT order_id,owner_id,payee_addr,'other-allocation',amount,payment_id,paid FROM pay_batch_order_item;
    INSERT INTO pay_batch_order_item_document SELECT order_id,owner_id,payee_addr,'other-allocation',agreement_id,invoice_id,activity_id,debit_note_id,amount FROM pay_batch_order_item_document;`);
  await expect(f.reader.attribute(f.wire, signal())).rejects.toThrow('ambiguous');
  const g = await setup(); g.db.exec('ALTER TABLE pay_payment ADD COLUMN unsupported TEXT');
  await expect(g.reader.attribute(g.wire, signal())).rejects.toThrow('ambiguous');
});

it('attributes an agreement share and rejects duplicate NULL-activity document rows permitted by native composite keys', async () => {
  const f = await setup();
  f.db.exec("UPDATE pay_payment_document SET activity_id=NULL; UPDATE pay_batch_order_item_document SET activity_id=NULL,debit_note_id=NULL,invoice_id='native-invoice'");
  const wire = { ...f.wire, activityPayments: [], agreementPayments: [{ agreementId: 'native-agreement', amount: '1' }] };
  expect((await f.reader.attribute(wire, signal())).payment.agreementPayments).toEqual([{ agreementId: 'native-agreement', amount: '1', allocationId: 'native-allocation' }]);
  f.db.exec('INSERT INTO pay_batch_order_item_document SELECT * FROM pay_batch_order_item_document');
  await expect(f.reader.attribute(wire, signal())).rejects.toThrow('ambiguous');
});

it.each(['invoice_id', 'debit_note_id'] as const)('refuses populated native payment-document %s for activity and agreement shares', async column => {
  const activity = await setup();
  activity.mutate(`UPDATE pay_payment_document SET ${column}=?`, 'unexpected-payment-document');
  await expect(activity.reader.attribute(activity.wire, signal())).rejects.toMatchObject({ code: 'golem_allocation_attribution_unavailable' });

  const agreement = await setup();
  agreement.db.exec("UPDATE pay_payment_document SET activity_id=NULL; UPDATE pay_batch_order_item_document SET activity_id=NULL,debit_note_id=NULL,invoice_id='native-invoice'");
  agreement.mutate(`UPDATE pay_payment_document SET ${column}=?`, 'unexpected-payment-document');
  const wire = { ...agreement.wire, activityPayments: [], agreementPayments: [{ agreementId: 'native-agreement', amount: '1' }] };
  await expect(agreement.reader.attribute(wire, signal())).rejects.toMatchObject({ code: 'golem_allocation_attribution_unavailable' });
});

it('pins source file/directory identity, rejects links/unsafe limits and never creates a missing source', async () => {
  const f = await setup(); f.closeDb();
  const other = join(f.directory, 'replacement.db'); await copyFile(f.path, other); await chmod(other, 0o600);
  await rename(f.path, join(f.directory, 'original.db')); await rename(other, f.path);
  await expect(f.reader.attribute(f.wire, signal())).rejects.toThrow('ambiguous');
  const g = await setup(); await link(g.path, join(g.directory, 'hard-link.db'));
  await expect(g.reader.attribute(g.wire, signal())).rejects.toThrow('ambiguous');
  const missing = join(f.directory, 'absent.db');
  await expect(new GolemAllocationAttributionReader({ ...f.policy, databasePath: missing }).attribute(f.wire, signal())).rejects.toThrow('ambiguous');
  await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(() => new GolemAllocationAttributionReader({ ...f.policy, databasePath: './relative' })).toThrow('Absolute');
});

it.skipIf(process.platform === 'win32')('refuses an actual filesystem symlink instead of following a reviewed database name', async () => {
  const h = await setup(); h.closeDb(); await rename(h.path, join(h.directory, 'target.db')); await symlink(join(h.directory, 'target.db'), h.path);
  await expect(h.reader.attribute(h.wire, signal())).rejects.toThrow('ambiguous');
});

it('bounds a worker and honors already-aborted or in-flight cancellation without a main-loop SQLite call', async () => {
  const f = await setup(), aborted = new AbortController(); aborted.abort();
  await expect(f.reader.attribute(f.wire, aborted.signal)).rejects.toThrow('ambiguous');
  const controller = new AbortController(), work = f.reader.attribute(f.wire, controller.signal); controller.abort();
  await expect(work).rejects.toThrow('ambiguous');
  const started = Date.now();
  // A new source worker must load and validate exact native tables. Termination
  // is bounded even if startup/native work has not yet produced a response.
  const short = new GolemAllocationAttributionReader({ ...f.policy, timeoutMs: 100 });
  const outcome = await short.attribute(f.wire, signal()).then(() => 'finished', () => 'bounded');
  expect(['finished', 'bounded']).toContain(outcome); expect(Date.now() - started).toBeLessThan(2000);
});

it('limits concurrent native readers and refuses a third worker without creating an unbounded local queue', async () => {
  const f = await setup(), first = f.reader.attribute(f.wire, signal()), second = f.reader.attribute(f.wire, signal());
  await expect(f.reader.attribute(f.wire, signal())).rejects.toThrow('ambiguous');
  const completed = await Promise.all([first, second]);
  expect(completed.every(value => value.payment.activityPayments[0]?.allocationId === 'native-allocation')).toBe(true);
});

it('feeds normal authenticated missing-allocation HTTP payments into the existing financial lifecycle without weakening strict transport or inventing finality', async () => {
  const f = await setup(), now = Date.now(), runId = randomId(); let invoiceStatus = 'RECEIVED', mutations = 0, ledger: FileGolemFinanceLedger;
  const original = golemOriginalRunSchema.parse({ authorityId: hashJson('original-fixture'), owner, runId, authorizationHash: randomId(),
    active: true, asOfMs: now, requestorId: requestor, providerId: provider, payerAddr: payer, payeeAddr: payee,
    paymentPlatform: 'erc20-polygon-glm', allocationId: 'native-allocation', agreementId: 'native-agreement', activityId: 'native-activity',
    imageDigest: randomId(), spendUntilMs: now + 60_000, maxGlmBaseUnits: golemAmountToBaseUnits('2').toString(), maxUsdcMicros: '1000000' });
  const invoice = () => ({ invoiceId: 'native-invoice', issuerId: provider, recipientId: requestor, payerAddr: payer, payeeAddr: payee,
    paymentPlatform: 'erc20-polygon-glm', agreementId: original.agreementId, timestamp: new Date(now).toISOString(),
    status: invoiceStatus, activityIds: [original.activityId], amount: '1', paymentDueDate: new Date(now + 30_000).toISOString() });
  const server = createServer((request, response) => { void (async () => {
    if (request.headers.authorization !== 'Bearer local-yagna-fixture') { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/payment-api/v1/payments/' + f.wire.paymentId) response.end(JSON.stringify(f.wire));
    else if (request.method === 'GET' && request.url === '/payment-api/v1/invoices/native-invoice') response.end(JSON.stringify(invoice()));
    else if (request.method === 'POST' && request.url === '/payment-api/v1/invoices/native-invoice/accept') {
      const state = await ledger.read(); expect(state.records[0]?.intents.some(row => row.status === 'pending' && row.action === 'accept_invoice')).toBe(true);
      let body = ''; for await (const chunk of request) body += String(chunk);
      expect(JSON.parse(body)).toEqual({ totalAmountAccepted: '1', allocationId: 'native-allocation' });
      mutations++; invoiceStatus = 'ACCEPTED'; response.end();
    } else response.writeHead(404).end('{}');
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native HTTP fixture unavailable');
  const http = new GolemFinanceHttpProtocol({ endpoint: 'http://127.0.0.1:' + address.port, apiKey: 'local-yagna-fixture', allowLocalHttp: true });
  await expect(http.payment(f.wire.paymentId, signal())).rejects.toMatchObject({ code: 'golem_http_payment_unattributed' });
  const proofAuthority = hashJson('explicit-local-finality-fixture'), financePolicy = { version: 1, policyId: randomId(),
    runAuthorityId: original.authorityId, treasuryAuthorityId: randomId(), finalityAuthorityId: proofAuthority,
    requestorId: requestor, payerAddr: payer, paymentPlatform: 'erc20-polygon-glm', tokenDecimals: 18, expiresAtMs: now + 120_000,
    maxLifetimeGlmBaseUnits: golemAmountToBaseUnits('10').toString(), maxLifetimeUsdcMicros: '10000000', minimumConfirmations: 12 };
  ledger = new FileGolemFinanceLedger(join(f.directory, 'finance.json'), financePolicy);
  const authorities: GolemFinanceAuthorities = { originalRun: async () => original,
    treasury: async () => ({ authorityId: financePolicy.treasuryAuthorityId, policyId: financePolicy.policyId, requestorId: requestor,
      payerAddr: payer, paymentPlatform: 'erc20-polygon-glm', availableGlmBaseUnits: golemAmountToBaseUnits('10').toString(),
      availableUsdcMicros: '10000000', evidenceHash: randomId(), asOfMs: now }),
    stop: async binding => ({ authorityId: proofAuthority, bindingHash: hashJson(binding), asOfMs: now, confirmed: false }),
    payment: async (binding, payment) => ({ authorityId: proofAuthority, bindingHash: hashJson(binding), asOfMs: now,
      confirmed: true, paymentId: payment.paymentId, paymentHash: hashJson(payment), confirmations: 12,
      proofHash: hashJson('explicit-finality-fixture-not-Polygon'), settlementReference: hashJson('fixture-only-transfer-reference') }),
    release: async binding => ({ authorityId: proofAuthority, bindingHash: hashJson(binding), asOfMs: now, confirmed: false }) };
  const make = () => new GolemFinancialLifecycle({ ledger, protocol: new GolemAttributedFinanceProtocol(http, f.reader), authorities, now: () => now });
  let service = make(); await service.initializeFresh(); await service.admit(owner, runId, 'native-admission');
  await service.acceptInvoice(owner, runId, 'native-invoice', 'native-accept');
  const result = await service.reconcile(owner, runId, { paymentIds: [f.wire.paymentId] });
  expect(result).toMatchObject({ acceptedBaseUnits: golemAmountToBaseUnits('1').toString(), paidBaseUnits: golemAmountToBaseUnits('1').toString(),
    settledBaseUnits: golemAmountToBaseUnits('1').toString(), state: 'held', releaseProofHash: null,
    reserveHeldGlmBaseUnits: original.maxGlmBaseUnits }); expect(mutations).toBe(1);
  service = make();
  await service.reconcile(owner, runId, { paymentIds: [f.wire.paymentId] }); expect(mutations).toBe(1);
  expect((await ledger.read()).records[0]?.payments[0]).toMatchObject({ id: f.wire.paymentId, confirmed: true,
    scopedBaseUnits: golemAmountToBaseUnits('1').toString() });
  f.db.exec("UPDATE pay_batch_order_item SET allocation_id='foreign-allocation'");
  await expect(service.reconcile(owner, runId, { paymentIds: [f.wire.paymentId] })).rejects.toMatchObject({ code: 'golem_allocation_attribution_unavailable' });
  expect(mutations).toBe(1);
});
