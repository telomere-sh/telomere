import { Hono } from 'hono';
import { z } from 'zod';
import { Problem } from '../common.js';
import type { Database } from '../store.js';
import { SelectionIndexer, type SelectionIndexProfile } from './indexer.js';
import { SelectionDataset } from './dataset.js';
import type { SelectionReader } from './rpc.js';
import { AgentEconomics, createAgentEconomicsRoutes } from '../updates/agent-economics.js';
import { SelectionExplorer, createSelectionExplorerRoutes } from '../updates/selection-explorer.js';
import { selectionPublicHealthSchema, type SelectionPublicHealth } from './public-http.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase()), hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase());
/** Compatible with the existing canonical-profile.json, including its creation provenance. */
export const selectionPublicProfileSchema = z.object({ reviewed: z.literal(true), chainId: z.number().int().positive(),
  registryAddress: address, registryCodeHash: hash, startBlock: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  confirmations: z.number().int().min(3).max(10000), creationTransaction: hash, creationBlockHash: hash, planDigest: hash }).strict();
export type SelectionPublicProfile = z.infer<typeof selectionPublicProfileSchema>;

export function createSelectionPublicService(options: { db: Database; profile: SelectionIndexProfile; reader: SelectionReader;
  features: () => Promise<readonly string[]>; now?: () => number }) {
  const now = options.now ?? Date.now, indexer = new SelectionIndexer(options.db, options.profile, options.reader);
  const dataset = new SelectionDataset(options.db, indexer, options.reader, now), explorer = new SelectionExplorer(options.db, dataset, indexer, now);
  const economics = new AgentEconomics(options.db, dataset, indexer, options.reader, now);
  let active: Promise<void> | undefined, closed = false, lastError = false;
  async function maintain(): Promise<void> {
    if (closed) return;
    if (active) return active;
    active = (async () => {
      try {
        // At most 192 block headers per 30-second cycle with the default profile.
        // Leave shared public RPC capacity for canonical checks and the legacy reader.
        for (let page = 0; page < 3 && !closed; page++) {
          const progress = await indexer.sync();
          if (progress.processedBlocks < indexer.profile.maxBlocksPerSync) break;
        }
        lastError = false;
      } catch { lastError = true; }
    })();
    try { await active; } finally { active = undefined; }
  }
  async function health(): Promise<SelectionPublicHealth> {
    const status = await indexer.status();
    const base = { version: 1 as const, chainId: status.chainId, registryAddress: status.registryAddress,
      confirmations: status.confirmations, indexedThrough: status.indexedThrough, asOfSeconds: null, stale: true };
    try {
      if (closed || lastError || !status.indexedThrough) return selectionPublicHealthSchema.parse({ ...base, state: lastError || closed ? 'unavailable' : 'syncing' });
      const monday = new Date(now()); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
      const page = await dataset.page({ week: monday.toISOString().slice(0, 10), limit: 1 });
      const stale = BigInt(Math.floor(now() / 1000)) - BigInt(page.coverage.asOfSeconds) > 900n;
      return selectionPublicHealthSchema.parse({ ...base, state: stale ? 'syncing' : 'ready',
        indexedThrough: page.index.indexedThrough, asOfSeconds: page.coverage.asOfSeconds, stale });
    } catch { return selectionPublicHealthSchema.parse({ ...base, state: 'unavailable' }); }
  }
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store'); context.header('X-Content-Type-Options', 'nosniff');
    if (context.req.method !== 'GET') return context.json({ status: 'method_not_allowed' }, 405);
    if (context.req.url.length > 2048) throw new Problem(422, 'selection_public_input', 'Use a bounded public query.');
    return next();
  });
  app.onError((error, context) => context.json({ title: error instanceof Problem ? error.code : 'selection_public_unavailable' }, error instanceof Problem ? error.status : 503));
  app.get('/health/selection', async context => {
    if ([...new URL(context.req.url).searchParams].length) throw new Problem(422, 'selection_public_input', 'No health query is accepted.');
    return context.json(await health());
  });
  app.use('/api/public/selection/*', async (context, next) => {
    const feature = context.req.path === '/api/public/selection/explorer' ? 'fossils' : 'agent-economics';
    if (!(await options.features()).includes(feature)) return context.json({ status: 'not_found' }, 404);
    if (closed || lastError) throw new Problem(503, 'selection_public_unavailable', 'Canonical Selection evidence is unavailable.');
    return next();
  });
  app.route('/api/public/selection', createSelectionExplorerRoutes(explorer));
  app.route('/api/public/selection', createAgentEconomicsRoutes(economics));
  return { app, indexer, dataset, explorer, economics, health, maintain,
    async close() { closed = true; await active; } };
}
