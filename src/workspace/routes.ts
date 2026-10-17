import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Problem } from '../common.js';
import type { Database } from '../store.js';
import { workspaceDocuments } from './schema.js';

const text = z.string().max(256);
const number = z.union([z.number().finite().min(0).max(1e6), z.string().regex(/^\d{1,7}(?:\.\d{1,6})?$/)]);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const entry = z.object({ id, name: text }).strict();
// Planning metadata is separate from authoritative on-chain balances, Leashes and execution receipts.
export const workspaceSchema = z.object({
  version: z.literal(1), budget: z.number().finite().min(0).max(1e6),
  plans: z.array(entry.extend({ hardware: text, lane: text, minutes: number, rate: number,
    image: text, ceiling: number, region: text, leash: text.optional(), status: z.enum(['Prepared','Blocked','Archived']), created: z.string().datetime() })).max(100),
  leashes: z.array(entry.extend({ hourly: number, daily: number, hardware: text, expiry: text, sealed: z.boolean(), killed: z.boolean() })).max(100),
  cysts: z.array(entry.extend({ directory: text, interval: number, sealed: z.boolean() })).max(100),
  receipts: z.array(z.object({ run_id: text, hw_class: text, billable_seconds: number, amount_usdc: number }).strict()).max(100),
  agents: z.array(entry.extend({ budget: number, endpoint: z.string().max(2048), leash: text })).max(100),
  hosts: z.array(z.object({id,label:text,hardware:text,region:text,rate:number,endpoint:z.string().max(2048).optional(),created:z.string().datetime()}).strict()).max(100).default([]),
  records: z.array(z.object({ id, kind: text, label: text, date: z.string().datetime() }).strict()).max(200),
  preferences: z.object({ region: z.enum(['Asia Pacific','Europe','North America']), currency: z.literal('USDC') }).strict(),
}).strict();
export const emptyWorkspace = () => ({version: 1 as const,budget:0,plans:[],leashes:[],cysts:[],receipts:[],agents:[],hosts:[],records:[],preferences:{region:'Asia Pacific' as const,currency:'USDC' as const}});
export function createWorkspaceRoutes(db: Database, owner: (context: Context) => Promise<string>) {
  const app = new Hono();
  app.get('/', async c => {
    const address = (await owner(c)).toLowerCase();
    const row = (await db.select().from(workspaceDocuments).where(eq(workspaceDocuments.owner,address)).limit(1))[0];
    return c.json({ owner: address, revision: row?.revision ?? 0, document: row?.document ?? emptyWorkspace() });
  });
  app.put('/', async c => {
    const address = (await owner(c)).toLowerCase();
    const input = z.object({revision:z.number().int().min(0).max(2147483646),document:workspaceSchema}).strict().parse(await c.req.json());
    const row = input.revision === 0
      ? await db.insert(workspaceDocuments).values({owner:address,revision:1,document:input.document}).onConflictDoNothing().returning()
      : await db.update(workspaceDocuments).set({revision:input.revision+1,document:input.document,updatedAt:new Date()})
          .where(and(eq(workspaceDocuments.owner,address),eq(workspaceDocuments.revision,input.revision))).returning();
    if (row.length !== 1) throw new Problem(409,'workspace_conflict','Workspace changed in another tab. Reload before saving again.');
    return c.json({owner:address,revision:row[0]!.revision,document:row[0]!.document});
  });
  return app;
}
