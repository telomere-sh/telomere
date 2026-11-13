import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { inflateSync } from 'node:zlib';
import type { Address, Hex } from 'viem';
import { ChainBridge } from '../src/bridge.js';
import { Problem } from '../src/common.js';
import { loadConfig } from '../src/config.js';
import { Service } from '../src/service.js';
import { jobs, openStore } from '../src/store.js';
import type { PublicReceiptReport } from '../src/receipts/public-verifier.js';
import { ReceiptLinkService, createOwnerReceiptLinkRoutes, createPublicReceiptLinkRoutes, createSharedReceiptPageRoutes,
  renderReceiptCardSvg, renderSharedReceiptHtml, exactReceiptUsdc } from '../src/updates/receipt-links.js';
import { receiptLinks, receiptLinkMigrationSQL } from '../src/updates/sharing-schema.js';
import { renderReceiptCardPng } from '../src/updates/receipt-card-png.js';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const owner = '0x1111111111111111111111111111111111111111' as Address;
const stranger = '0x2222222222222222222222222222222222222222' as Address;
const config = loadConfig({ MODE: 'demo', DATA_DIR: ':memory:', SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  DEMO_PRIVATE_KEY: `0x${'55'.repeat(32)}`, ESCROW_ADDRESS: '0x6666666666666666666666666666666666666666',
  TOKEN_ADDRESS: '0x7777777777777777777777777777777777777777', PUBLIC_ORIGIN: 'https://telomere.example' });
const template = '<!doctype html><html><head><title>Old title</title><meta name="description" content="old"><meta property="og:title" content="old"><link rel="canonical" href="https://old.example/"><script src="/preload.js"></script></head><body><main id="page-content"></main><script type="module" src="/site.js"></script></body></html>';
function verified(): PublicReceiptReport {
  return { outcome: 'verified', checkedAt: '2026-11-13T10:00:00.000Z', steps: [], summary: {
    runId: id(1), receiptHash: id(2), billableSeconds: 2, charged: '2000001', refund: '7999999', ceiling: '10000000',
    token: config.TOKEN_ADDRESS, escrow: config.ESCROW_ADDRESS, chainId: 8453, settlementTxHash: id(9) } };
}
describe('opt-in public receipt summaries', () => {
  let store: Awaited<ReturnType<typeof openStore>>, service: Service, links: ReceiptLinkService;
  let report: PublicReceiptReport, verify: ReturnType<typeof vi.fn<(input: unknown) => Promise<PublicReceiptReport>>>;
  beforeEach(async () => {
    store = await openStore(config);
    for (const statement of receiptLinkMigrationSQL.split(';').map(s => s.trim()).filter(Boolean)) await store.db.execute(sql.raw(statement));
    const input = { leashId: id(3), task: { kind: 'sha256' as const, text: 'PRIVATE_INPUT' }, maxSeconds: 30 };
    const quote = { runId: id(1), leashId: id(3), payer: owner, workloadHash: id(4), maxSeconds: 30,
      pricePerSecond: '100', inferencePrice: '0', quoteExpiry: 10000000000 };
    await store.db.insert(jobs).values({ id: id(1), owner, leashId: id(3), idemKey: 'PRIVATE_KEY', inputHash: id(4), input, quote,
      signature: `0x${'aa'.repeat(65)}`, ceiling: '10000000', output: 'PRIVATE_OUTPUT', receipt: { privateBody: 'PRIVATE_RECEIPT', ticks: ['PRIVATE_TICK'] }, status: 'completed' });
    service = new Service(store.db, new ChainBridge(config), config, false);
    report = verified(); verify = vi.fn(async (_input: unknown) => structuredClone(report));
    links = new ReceiptLinkService(service, { verify });
  });
  afterEach(async () => { await store.close(); });
  const publish = () => links.publish(owner, { runId: id(1), publish: true });
  function app(wallet = owner): Hono {
    const routes = new Hono();
    routes.onError((error, context) => context.json({ code: error instanceof Problem ? error.code : 'invalid_input' }, error instanceof Problem ? error.status : 422));
    routes.route('/api/receipt-links', createOwnerReceiptLinkRoutes(links, async () => wallet));
    routes.route('/api/public/receipt-links', createPublicReceiptLinkRoutes(links));
    routes.route('/', createSharedReceiptPageRoutes(links, async () => template));
    return routes;
  }
  it('never publishes implicitly and accepts only the explicit strict consent payload', async () => {
    for (const payload of [{ runId: id(1) }, { runId: id(1), publish: false }, { runId: id(1), publish: true, receipt: 'PRIVATE' }]) {
      await expect(links.publish(owner, payload)).rejects.toThrow();
    }
    await expect(links.read(id(1))).rejects.toMatchObject({ status: 404 });
    expect(verify).not.toHaveBeenCalled(); expect(await store.db.select().from(receiptLinks)).toHaveLength(0);
    const response = await app().request('/api/receipt-links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: id(1), publish: true }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ published: true, runId: id(1), url: `${config.PUBLIC_ORIGIN}/r/${id(1)}` });
  });
  it('uses actual owner job isolation before verification or publication and before revocation', async () => {
    await expect(links.publish(stranger, { runId: id(1), publish: true })).rejects.toMatchObject({ status: 404 });
    await expect(links.revoke(stranger, id(1))).rejects.toMatchObject({ status: 404 }); expect(verify).not.toHaveBeenCalled();
    await publish(); await expect(links.revoke(stranger, id(1))).rejects.toMatchObject({ status: 404 });
    expect((await links.read(id(1))).state).toBe('ready');
  });
  it('lets the injected verifier read the real private store without holding its PGlite transaction open', async () => {
    verify.mockImplementation(async () => {
      const records = await store.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id(1)));
      expect(records).toHaveLength(1); return verified();
    });
    await publish(); expect((await links.read(id(1))).state).toBe('ready');
  });
  it('stores and returns only whitelisted accounting, never raw receipt, owner, job or proof data', async () => {
    Object.assign(report.summary!, { owner, input: 'PRIVATE_INPUT', output: 'PRIVATE_OUTPUT', signature: 'PRIVATE_SIGNATURE', ticks: ['PRIVATE_TICK'], cpuProfile: 'FABRICATED' });
    await publish();
    const stored = (await store.db.select().from(receiptLinks))[0]!;
    expect(Object.keys(stored.summary).sort()).toEqual(['billableSeconds', 'ceiling', 'chainId', 'charged', 'escrow', 'receiptHash', 'refund', 'runId', 'settlementTxHash', 'token'].sort());
    const shared = JSON.stringify(await links.read(id(1)));
    expect(shared).not.toMatch(/PRIVATE|owner|input|output|signature|ticks|cpuProfile|FABRICATED/);
    expect(shared).toContain('2000001'); expect(shared).toContain('7999999');
  });
  it('keeps repeated publication idempotent and allows same-owner explicit re-publication after revocation', async () => {
    await publish(); const original = (await store.db.select().from(receiptLinks))[0]!;
    await publish(); expect(await store.db.select().from(receiptLinks)).toHaveLength(1);
    expect((await store.db.select().from(receiptLinks))[0]!.publishedAt).toEqual(original.publishedAt);
    await links.revoke(owner, id(1)); await links.revoke(owner, id(1));
    await expect(links.read(id(1))).rejects.toMatchObject({ status: 404 });
    await publish(); expect((await links.read(id(1))).summary.receiptHash).toBe(id(2));
  });
  it('requires a currently verified matching signature and settlement before publication', async () => {
    for (const outcome of ['invalid', 'incomplete', 'unavailable'] as const) {
      report.outcome = outcome;
      await expect(publish()).rejects.toMatchObject({ status: outcome === 'unavailable' ? 503 : 404 });
    }
    report = verified(); delete report.summary!.settlementTxHash;
    await expect(publish()).rejects.toMatchObject({ status: 404 });
    expect(await store.db.select().from(receiptLinks)).toHaveLength(0);
  });
  it('returns no stale verified summary on reorg, signature failure, missing proof or RPC failure', async () => {
    await publish();
    for (const outcome of ['incomplete', 'invalid', 'unavailable'] as const) {
      report.outcome = outcome;
      const response = await app().request(`/api/public/receipt-links/${id(1)}`);
      expect(response.status).toBe(outcome === 'unavailable' ? 503 : 404);
      expect(await response.text()).not.toMatch(/2000001|receiptHash|"ready"/);
    }
    verify.mockRejectedValueOnce(new Error('PRIVATE_RPC_DETAILS'));
    const response = await app().request(`/api/public/receipt-links/${id(1)}`);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE');
  });
  it('never changes a published run/hash/summary binding or its owner', async () => {
    await publish(); report.summary!.receiptHash = id(8);
    await expect(publish()).rejects.toMatchObject({ status: 409 });
    await expect(links.read(id(1))).rejects.toMatchObject({ status: 404 });
    report = verified(); report.summary!.charged = '2000002'; report.summary!.refund = '7999998';
    await expect(publish()).rejects.toMatchObject({ status: 409 });
    await store.db.update(receiptLinks).set({ owner: stranger }).where(eq(receiptLinks.runId, id(1)));
    await expect(publish()).rejects.toMatchObject({ status: 404 });
    await expect(links.revoke(owner, id(1))).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks consent after pending canonical verification so revocation wins the read', async () => {
    await publish(); let finish!: (value: PublicReceiptReport) => void;
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    verify.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const reading = links.read(id(1)); await began; await links.revoke(owner, id(1)); finish(verified());
    await expect(reading).rejects.toMatchObject({ status: 404 });
  });
  it('lets revocation supersede a first publication while its verifier is pending', async () => {
    let finish!: (value: PublicReceiptReport) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    verify.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = publish();
    const rejected = expect(pending).rejects.toMatchObject({ status: 409, code: 'receipt_link_consent_changed' });
    await began;
    expect(await store.db.select().from(receiptLinks)).toHaveLength(0);
    expect(await links.revoke(owner, id(1))).toEqual({ published: false, runId: id(1) });
    finish(verified()); await rejected;
    expect(await store.db.select().from(receiptLinks)).toHaveLength(0);
    await expect(links.read(id(1))).rejects.toMatchObject({ status: 404 });
    // Cancellation cleanup also leaves a later, explicit opt-in operational.
    await publish(); expect((await links.read(id(1))).state).toBe('ready');
  });
  it('lets a newer concurrent publication supersede the older pending publication', async () => {
    let finish!: (value: PublicReceiptReport) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    verify.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = publish();
    const rejected = expect(pending).rejects.toMatchObject({ status: 409, code: 'receipt_link_consent_changed' });
    await began; await publish(); finish(verified()); await rejected;
    expect(await store.db.select().from(receiptLinks)).toHaveLength(1);
    expect((await links.read(id(1))).state).toBe('ready');
  });
  it('keeps a different owner revoke from invalidating the real owner pending consent', async () => {
    let finish!: (value: PublicReceiptReport) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    verify.mockImplementationOnce(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = publish(); await began;
    await expect(links.revoke(stranger, id(1))).rejects.toMatchObject({ status: 404 });
    finish(verified()); await expect(pending).resolves.toMatchObject({ published: true });
    expect((await links.read(id(1))).state).toBe('ready');
  });
  it('serves deterministic SVG and fixed-origin OG/Twitter metadata while preserving site bootstrap', async () => {
    await publish(); const receipt = await links.read(id(1));
    const html = renderSharedReceiptHtml(template, receipt, config.PUBLIC_ORIGIN);
    expect(html).toContain(`property="og:url" content="${config.PUBLIC_ORIGIN}/r/${id(1)}"`);
    expect(html).toContain(`name="twitter:image" content="${config.PUBLIC_ORIGIN}/api/public/receipt-links/${id(1)}/card.png"`);
    expect(html).toContain(`property="og:image" content="${config.PUBLIC_ORIGIN}/api/public/receipt-links/${id(1)}/card.png"`);
    expect(html).toContain('property="og:image:type" content="image/png"');
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(html).toContain('/site.js'); expect(html).toContain('/preload.js'); expect(html).not.toContain('https://old.example');
    expect(html.match(/<title>/g)).toHaveLength(1); expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(renderReceiptCardSvg(receipt)).toBe(renderReceiptCardSvg(receipt));
    const adversarial = { ...receipt, asOf: '"><script>alert(1)</script>&' };
    expect(renderReceiptCardSvg(adversarial)).toContain('&lt;script&gt;');
    expect(renderSharedReceiptHtml(template, adversarial, config.PUBLIC_ORIGIN)).not.toContain('<script>alert(1)</script>');
    expect(exactReceiptUsdc('1234567890123456789012345678')).toBe('1234567890123456789012.345678 USDC');
    const response = await app().request(`/api/public/receipt-links/${id(1)}/card.svg`);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('renders an actual deterministic 1200 by 630 PNG with inflated RGB glyph pixels', async () => {
    await publish(); const receipt = await links.read(id(1)), png = renderReceiptCardPng(receipt);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    const compressed: Buffer[] = [], chunks: string[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + length);
      expect(offset + 12 + length).toBeLessThanOrEqual(png.length); chunks.push(type);
      if (type === 'IHDR') {
        expect(length).toBe(13); expect(data.readUInt32BE(0)).toBe(1200); expect(data.readUInt32BE(4)).toBe(630);
        expect([...data.subarray(8)]).toEqual([8,2,0,0,0]);
      }
      if (type === 'IDAT') compressed.push(data);
      // Independently compute the PNG chunk CRC (the renderer uses a lookup table).
      let crc = 0xffffffff;
      for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      expect(png.readUInt32BE(offset + 8 + length)).toBe((crc ^ 0xffffffff) >>> 0);
      offset += 12 + length;
    }
    expect(offset).toBe(png.length); expect(chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    const pixels = inflateSync(Buffer.concat(compressed)), stride = 1200 * 3 + 1;
    expect(pixels.length).toBe(630 * stride);
    for (let y = 0; y < 630; y++) expect(pixels[y * stride]).toBe(0);
    const pixel = (x: number, y: number) => [...pixels.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)];
    expect(pixel(0, 0)).toEqual([240,238,233]); expect(pixel(48, 48)).toEqual([252,93,36]);
    expect(pixel(88, 62)).toEqual([25,25,25]);
    // The final digits of both full-length hashes fit inside their bitmap rows.
    expect(pixel(920, 374)).toEqual([25,25,25]); expect(pixel(932, 414)).toEqual([25,25,25]);
    expect(png).toEqual(renderReceiptCardPng(receipt));
    expect(png).toEqual(renderReceiptCardPng({ ...receipt, summary: Object.assign({ ...receipt.summary }, {
      owner, input: 'PRIVATE_INPUT', output: 'PRIVATE_OUTPUT', signature: 'PRIVATE_SIGNATURE', ticks: ['PRIVATE_TICK'],
    }) }));
    const response = await app().request(`/api/public/receipt-links/${id(1)}/card.png`);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });
  it('fits the maximum exact atomic amount and rejects overlong or malformed PNG inputs', async () => {
    await publish(); const receipt = await links.read(id(1));
    const large = { ...receipt, summary: { ...receipt.summary, charged: '9999999999999999999999999999', refund: '0', ceiling: '9999999999999999999999999999' } };
    expect(renderReceiptCardPng(large).subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(() => renderReceiptCardPng({ ...receipt, summary: { ...receipt.summary, charged: '1'.repeat(10000) } })).toThrow();
    expect(() => renderReceiptCardPng({ ...receipt, summary: { ...receipt.summary, runId: '0xPRIVATE_NOT_A_HASH' } })).toThrow();
  });
  it('does not leak unpublished, revoked, redacted or stale summaries into HTML or social cards', async () => {
    const paths = [`/r/${id(1)}`, `/api/public/receipt-links/${id(1)}/card.svg`, `/api/public/receipt-links/${id(1)}/card.png`, `/api/public/receipt-links/${id(1)}`];
    const ownerLookup = vi.spyOn(service, 'requireJob');
    for (const path of paths) { const response = await app().request(path); expect(response.status).toBe(404); expect(await response.text()).not.toMatch(/2000001|receiptHash|og:image/); }
    expect(ownerLookup).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
    await publish(); await links.revoke(owner, id(1)); ownerLookup.mockClear(); verify.mockClear();
    for (const path of paths) expect((await app().request(path)).status).toBe(404);
    expect(ownerLookup).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
    await publish(); report.outcome = 'unavailable';
    for (const path of paths) { const response = await app().request(path); expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/2000001|receiptHash|og:image/); }
    expect((await app().request('/api/public/receipt-links')).status).toBe(404);
  });
  it('rejects malformed IDs without verifier work and never accepts an arbitrary remote origin', async () => {
    await expect(links.read('https://private.example')).rejects.toMatchObject({ status: 404 });
    expect(verify).not.toHaveBeenCalled();
    for (const value of ['https://user:password@example.test', 'https://example.test/path', 'file:///etc/passwd']) {
      expect(() => new ReceiptLinkService(service, { verify }, value)).toThrow();
    }
  });
});
