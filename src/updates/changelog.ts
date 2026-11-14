import { Hono } from 'hono';
import { z } from 'zod';
import catalog from '../../public/updates/changelog-catalog.json' with { type: 'json' };
import { unversionedRelease, type PublicRelease } from '../release.js';

// Only these public destinations and feature-to-entry assignments are publishable.
const TARGETS = [
  [null, '/verify/'], ['refunds', '/refunds/'], ['prices', '/prices/'], ['receipt-links', '/verify/'],
  ['leash-presets', '/dashboard/'], ['runway', '/runway/'], ['accounting', '/accounting/'],
  ['fossils', '/fossils/'], ['agent-economics', '/fossils/'], ['copy-examples', '/developers/examples/'],
  ['host-calculator', '/hosts/calculator/'], ['status-changelog', '/status/'],
] as const;
const plainText = (maximum: number) => z.string().min(1).max(maximum).regex(/^[^<>\u0000-\u001f\u007f]+$/u);
export const changelogEntrySchema = z.object({
  id: z.number().int().min(1).max(12), feature: z.string().nullable(), title: plainText(100),
  description: plainText(500), introducedOn: z.literal('2026-11-13'), href: z.string(),
}).strict().superRefine((entry, context) => {
  const target = TARGETS[entry.id - 1];
  if (!target || entry.feature !== target[0] || entry.href !== target[1]) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown public feature or destination' });
  }
});
const uniqueEntries = z.array(changelogEntrySchema).max(12).superRefine((entries, context) => {
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate changelog ID' });
  }
});
export const changelogCatalogSchema = z.object({ schemaVersion: z.literal(1), entries: uniqueEntries }).strict()
  .refine(value => value.entries.length > 0, 'The public catalog must contain entries');
export const changelogReportSchema = z.object({
  schemaVersion: z.literal(1), state: z.enum(['ready', 'no_data', 'partial']), asOf: z.string().datetime(),
  source: z.literal('curated_public_catalog'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  sourceDirty: z.boolean().nullable(), dateMeaning: z.literal('introduced_on_not_deployment_time'), entries: uniqueEntries,
}).strict().superRefine((report, context) => {
  if (report.state === 'ready' && (report.sourceCommit === null || report.sourceDirty !== false)
    || report.state === 'no_data' && report.entries.length !== 0
    || report.state !== 'no_data' && report.entries.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent source or entry state' });
  }
});
const publicCatalog = changelogCatalogSchema.parse(catalog);

/** A build-time public allowlist, never a view of repository history or operator records. */
export function createChangelogRoutes(enabledFeatures: () => readonly string[], release: PublicRelease = unversionedRelease) {
  const routes = new Hono();
  routes.get('/', context => {
    context.header('Cache-Control', 'no-store');
    let enabled: readonly string[];
    try { enabled = enabledFeatures(); }
    catch { return context.json({ state: 'unavailable', error: 'Feature configuration is unavailable.' }, 503); }
    if (!enabled.includes('status-changelog')) return context.json({ state: 'not_enabled', error: 'This update is not enabled.' }, 404);
    const entries = publicCatalog.entries.filter(entry => entry.feature === null || enabled.includes(entry.feature));
    const report = changelogReportSchema.parse({ schemaVersion: 1,
      state: entries.length === 0 ? 'no_data' : release.sourceCommit === null || release.sourceDirty !== false ? 'partial' : 'ready',
      asOf: new Date().toISOString(), source: 'curated_public_catalog', sourceCommit: release.sourceCommit,
      sourceDirty: release.sourceDirty, dateMeaning: 'introduced_on_not_deployment_time', entries });
    return context.json(report);
  });
  return routes;
}
