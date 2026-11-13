import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { type Address } from 'viem';
import { Problem, addressSchema, bytes32Schema, moneySchema } from '../common.js';
import type { Service } from '../service.js';
import type { PublicReceiptReport, publicReceiptInputSchema } from '../receipts/public-verifier.js';
import { configuredPublicReceiptVerifier } from '../receipts/public-configured.js';
import { receiptLinks } from './sharing-schema.js';
import { renderReceiptCardPng } from './receipt-card-png.js';

export const publishReceiptLinkSchema = z.object({ runId: bytes32Schema, publish: z.literal(true) }).strict();
const summarySchema = z.object({
  runId: bytes32Schema, receiptHash: bytes32Schema, charged: moneySchema, refund: moneySchema,
  ceiling: moneySchema, billableSeconds: z.number().int().min(0).max(120),
  chainId: z.number().int().positive().safe(), escrow: addressSchema, token: addressSchema,
  settlementTxHash: bytes32Schema,
}).refine(s => BigInt(s.charged) + BigInt(s.refund) === BigInt(s.ceiling));
export type SharedReceiptSummary = z.infer<typeof summarySchema>;
export type SharedReceipt = { state: 'ready'; summary: SharedReceiptSummary; asOf: string;
  publishedAt: string; source: 'Operator-signed receipt and canonical escrow settlement' };
type Verifier = { verify(input: z.infer<typeof publicReceiptInputSchema>): Promise<PublicReceiptReport> };
const SOURCE = 'Operator-signed receipt and canonical escrow settlement' as const;
// Standalone SVG has no site CSS cascade; mirror the existing public theme.
const CARD_THEME = { paper: '#f0eee9', ink: '#191919', orange: '#fc5d24' } as const;
const unavailable = () => new Problem(503, 'receipt_link_unavailable', 'Current receipt evidence is unavailable. Retry shortly.');
const missing = () => new Problem(404, 'receipt_link_not_found', 'This receipt is not publicly available.');
function origin(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin !== value) throw new Error('PUBLIC_ORIGIN must be an HTTP origin');
  return url.origin;
}
function equalSummary(a: SharedReceiptSummary, b: SharedReceiptSummary): boolean {
  return Object.keys(a).every(key => a[key as keyof SharedReceiptSummary] === b[key as keyof SharedReceiptSummary]);
}

/** Every read re-verifies. Publication never grants access to a job or raw receipt. */
export class ReceiptLinkService {
  readonly publicOrigin: string;
  private inFlight = 0;
  // The controller is single-instance. Pending tokens order consent changes even
  // before a first publication has a persistent row; entries live only per request.
  private readonly pendingPublications = new Map<string, symbol>();
  constructor(readonly service: Pick<Service, 'db' | 'requireJob' | 'config'>,
    private readonly verifier: Verifier, publicOrigin = service.config.PUBLIC_ORIGIN,
    private readonly verificationTimeoutMs = 30000) { this.publicOrigin = origin(publicOrigin); }
  private async current(runId: string): Promise<{ summary: SharedReceiptSummary; asOf: string }> {
    if (this.inFlight >= 2) throw new Problem(429, 'receipt_link_busy', 'Receipt verification is busy. Retry shortly.');
    ++this.inFlight;
    const work = Promise.resolve().then(() => this.verifier.verify({ runId: bytes32Schema.parse(runId) }));
    void work.then(() => { --this.inFlight; }, () => { --this.inFlight; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let report: PublicReceiptReport;
    try {
      report = await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), this.verificationTimeoutMs);
      })]);
    } catch { throw unavailable(); }
    finally { if (timer) clearTimeout(timer); }
    if (report.outcome === 'unavailable') throw unavailable();
    if (report.outcome !== 'verified') throw missing();
    // Parse into a fresh whitelist: never spread report, steps, receipt or private job fields.
    const parsed = summarySchema.safeParse(report.summary);
    if (!parsed.success || parsed.data.runId !== runId || !Number.isFinite(Date.parse(report.checkedAt))) throw missing();
    return { summary: parsed.data, asOf: new Date(report.checkedAt).toISOString() };
  }
  async publish(ownerValue: Address, input: unknown): Promise<{ published: true; url: string; runId: string }> {
    const { runId } = publishReceiptLinkSchema.parse(input), owner = addressSchema.parse(ownerValue).toLowerCase();
    const key = `${owner}:${runId}`, token = Symbol();
    if (!this.pendingPublications.has(key) && this.pendingPublications.size >= 128) {
      throw new Problem(429, 'receipt_link_busy', 'Receipt publication is busy. Retry shortly.');
    }
    // Record ordering before the first await. A newer same-owner publish replaces
    // this token; a revoke removes it even when no receipt_links row exists yet.
    this.pendingPublications.set(key, token);
    try {
      await this.service.requireJob(owner as Address, runId);
      // The configured verifier reads the private receipt through the service DB.
      // Keep its reads outside the transaction for the PGlite adapter.
      const fresh = await this.current(runId);
      await this.service.db.transaction(async tx => {
        await tx.execute(sql`UPDATE quote_admission_lock SET id = id WHERE id = 1`);
        if (this.pendingPublications.get(key) !== token) {
          throw new Problem(409, 'receipt_link_consent_changed', 'A newer sharing action superseded this publication.');
        }
        const existing = (await tx.select().from(receiptLinks).where(eq(receiptLinks.runId, runId)).limit(1))[0];
        if (existing && existing.owner !== owner) throw missing();
        if (existing && (existing.receiptHash !== fresh.summary.receiptHash || !equalSummary(existing.summary, fresh.summary))) {
          throw new Problem(409, 'receipt_link_binding_changed', 'The published receipt binding changed. This link was not updated.');
        }
        if (!existing) await tx.insert(receiptLinks).values({ runId, owner, receiptHash: fresh.summary.receiptHash, summary: fresh.summary });
        else if (existing.revokedAt) await tx.update(receiptLinks).set({ revokedAt: null, publishedAt: new Date() }).where(eq(receiptLinks.runId, runId));
      });
      return { published: true, url: `${this.publicOrigin}/r/${runId}`, runId };
    } finally {
      // A superseded request must preserve the newer request's pending token.
      if (this.pendingPublications.get(key) === token) this.pendingPublications.delete(key);
    }
  }
  async revoke(ownerValue: Address, id: string): Promise<{ published: false; runId: string }> {
    const runId = bytes32Schema.parse(id), owner = addressSchema.parse(ownerValue).toLowerCase();
    this.pendingPublications.delete(`${owner}:${runId}`);
    await this.service.requireJob(owner as Address, runId);
    await this.service.db.transaction(async tx => {
      await tx.execute(sql`UPDATE quote_admission_lock SET id = id WHERE id = 1`);
      const existing = (await tx.select().from(receiptLinks).where(eq(receiptLinks.runId, runId)).limit(1))[0];
      if (existing && existing.owner !== owner) throw missing();
      if (existing && !existing.revokedAt) await tx.update(receiptLinks).set({ revokedAt: new Date() }).where(and(eq(receiptLinks.runId, runId), eq(receiptLinks.owner, owner)));
    });
    return { published: false, runId };
  }
  async read(id: string): Promise<SharedReceipt> {
    const parsed = bytes32Schema.safeParse(id); if (!parsed.success) throw missing();
    const runId = parsed.data;
    const active = () => this.service.db.select().from(receiptLinks).where(and(eq(receiptLinks.runId, runId), isNull(receiptLinks.revokedAt))).limit(1);
    const row = (await active())[0]; if (!row) throw missing();
    const fresh = await this.current(runId);
    if (fresh.summary.receiptHash !== row.receiptHash || !equalSummary(row.summary, fresh.summary)) throw missing();
    // A revoke that committed while RPC verification was pending takes effect on this read.
    const latest = (await active())[0];
    if (!latest || latest.publishedAt.getTime() !== row.publishedAt.getTime() || latest.receiptHash !== row.receiptHash) throw missing();
    return { state: 'ready', summary: fresh.summary, asOf: fresh.asOf, publishedAt: row.publishedAt.toISOString(), source: SOURCE };
  }
}
export function configuredReceiptLinks(service: Service): ReceiptLinkService {
  return new ReceiptLinkService(service, configuredPublicReceiptVerifier(service));
}
export function createOwnerReceiptLinkRoutes(links: ReceiptLinkService, owner: (context: Context) => Promise<Address>) {
  const routes = new Hono();
  routes.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next(); });
  routes.post('/', async context => context.json(await links.publish(await owner(context), await context.req.json())));
  routes.delete('/:runId', async context => context.json(await links.revoke(await owner(context), context.req.param('runId'))));
  routes.post('/:runId/revoke', async context => {
    const wallet = await owner(context);
    z.object({}).strict().parse(await context.req.json());
    return context.json(await links.revoke(wallet, context.req.param('runId')));
  });
  return routes;
}
function publicError(context: Context, failure: unknown) {
  const status = failure instanceof Problem && [404, 429, 503].includes(failure.status) ? failure.status as 404 | 429 | 503 : 503;
  return context.json({ state: status === 404 ? 'no_data' : 'unavailable', detail: status === 404 ? 'This receipt is not publicly available.' : 'Current receipt evidence is unavailable. Retry shortly.' }, status);
}
export function createPublicReceiptLinkRoutes(links: ReceiptLinkService) {
  const routes = new Hono();
  routes.use('*', async (context, next) => { context.header('Cache-Control', 'no-store'); context.header('X-Robots-Tag', 'noindex'); await next(); });
  routes.get('/:runId/card.png', async context => {
    try {
      const png = renderReceiptCardPng(await links.read(context.req.param('runId')));
      return context.body(Uint8Array.from(png).buffer, 200, { 'Content-Type': 'image/png', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    } catch (failure) { return publicError(context, failure); }
  });
  routes.get('/:runId/card.svg', async context => {
    try { return context.body(renderReceiptCardSvg(await links.read(context.req.param('runId'))), 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }); }
    catch (failure) { return publicError(context, failure); }
  });
  routes.get('/:runId', async context => {
    try { return context.json(await links.read(context.req.param('runId'))); }
    catch (failure) { return publicError(context, failure); }
  });
  return routes;
}
export function escapeReceiptMarkup(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function exactReceiptUsdc(value: string): string {
  const atomic = BigInt(value); return `${atomic / 1000000n}.${(atomic % 1000000n).toString().padStart(6, '0')} USDC`;
}
export function renderReceiptCardSvg(receipt: SharedReceipt): string {
  const s = summarySchema.parse(receipt.summary);
  const lines = ['TELOMERE / SHARED RECEIPT', 'Canonical settlement verified', `Charged ${exactReceiptUsdc(s.charged)}`,
    `Refund ${exactReceiptUsdc(s.refund)} / Ceiling ${exactReceiptUsdc(s.ceiling)}`, `${s.billableSeconds} billable seconds / Chain ${s.chainId}`,
    `Run ${s.runId}`, `Receipt ${s.receiptHash}`, `Checked ${receipt.asOf}`];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img"><title>Telomere shared receipt</title><rect width="1200" height="630" fill="${CARD_THEME.paper}"/><rect x="48" y="48" width="8" height="534" fill="${CARD_THEME.orange}"/><g fill="${CARD_THEME.ink}" font-family="monospace" font-size="20">${lines.map((line, i) => `<text x="88" y="${100 + i * 62}">${escapeReceiptMarkup(line)}</text>`).join('')}</g></svg>`;
}
function replaceSharingHead(template: string, head: string): string {
  if (!/<\/head\s*>/i.test(template)) throw new Error('Site page template must have a head');
  return template.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
    .replace(/<meta\b(?=[^>]*(?:name|property)\s*=\s*["'](?:description|robots|og:[^"']*|twitter:[^"']*)["'])[^>]*>/gi, '')
    .replace(/<link\b(?=[^>]*rel\s*=\s*["']canonical["'])[^>]*>/gi, '')
    .replace(/<\/head\s*>/i, `${head}</head>`);
}
/** Preserve the site bootstrap and shared shell; replace only conflicting head metadata. */
export function renderSharedReceiptHtml(template: string, receipt: SharedReceipt, publicOrigin: string): string {
  const s = summarySchema.parse(receipt.summary), base = origin(publicOrigin);
  const url = `${base}/r/${s.runId}`, image = `${base}/api/public/receipt-links/${s.runId}/card.png`;
  const title = 'Telomere shared receipt';
  const description = `${exactReceiptUsdc(s.charged)} charged; ${exactReceiptUsdc(s.refund)} returned to escrow; ${s.billableSeconds} billable seconds. Verified ${receipt.asOf}.`;
  const tag = (key: string, value: string, property = false) => `<meta ${property ? 'property' : 'name'}="${key}" content="${escapeReceiptMarkup(value)}">`;
  const head = `<title>${title}</title>${tag('description', description)}${tag('robots', 'noindex')}`
    + tag('og:type', 'website', true) + tag('og:title', title, true) + tag('og:description', description, true)
    + tag('og:url', url, true) + tag('og:image', image, true) + tag('og:image:type', 'image/png', true)
    + tag('og:image:width', '1200', true) + tag('og:image:height', '630', true) + tag('og:image:alt', 'Telomere shared settlement receipt', true)
    + tag('twitter:card', 'summary_large_image') + tag('twitter:title', title) + tag('twitter:description', description)
    + tag('twitter:image', image) + tag('twitter:image:alt', 'Telomere shared settlement receipt');
  return replaceSharingHead(template, `<link rel="canonical" href="${escapeReceiptMarkup(url)}">${head}`);
}
export function createSharedReceiptPageRoutes(links: ReceiptLinkService, pageTemplate: () => Promise<string>) {
  const routes = new Hono();
  routes.get('/r/:runId', async context => {
    context.header('Cache-Control', 'no-store'); context.header('X-Robots-Tag', 'noindex');
    let template: string | undefined;
    try {
      template = await pageTemplate();
      return context.html(renderSharedReceiptHtml(template, await links.read(context.req.param('runId')), links.publicOrigin));
    } catch (failure) {
      const status = failure instanceof Problem && [404, 429, 503].includes(failure.status) ? failure.status as 404 | 429 | 503 : 503;
      // Keep the application shell for the public no-data/retry states. Never add
      // receipt-specific social metadata when consent or current evidence is absent.
      if (template) return context.html(replaceSharingHead(template, '<title>Receipt unavailable | Telomere</title><meta name="robots" content="noindex">'), status);
      return publicError(context, failure);
    }
  });
  return routes;
}
