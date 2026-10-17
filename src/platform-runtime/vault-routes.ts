import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Problem, addressSchema, bytes32Schema } from '../common.js';
import { sessionCommandSchema } from '../host-kit/sessions/types.js';
import { platformAdmissionSchema, validatedPlatformQuoteInputSchema, type PlatformPrepared } from './types.js';
import type { PlatformWalletPlan } from './client.js';
import type { PlatformRuntimeService } from './service.js';
import type { PlatformVaultRuntimeConfig } from './vault-client.js';

type VaultRouteRun = Awaited<ReturnType<PlatformRuntimeService['get']>>;

export interface PlatformVaultRuntimeRouteService {
  config(principal: string, vault: string): Promise<PlatformVaultRuntimeConfig>;
  balance(principal: string, vault: string): Promise<{ available: string }>;
  quote(principal: string, vault: string, raw: unknown, key: string): Promise<PlatformPrepared>;
  admit(principal: string, vault: string, raw: unknown, key: string): Promise<VaultRouteRun>;
  list(principal: string, vault: string): Promise<{ runs: VaultRouteRun[] }>;
  get(principal: string, vault: string, id: string): Promise<VaultRouteRun>;
  sessionLease(principal: string, vault: string, id: string): Promise<unknown>;
  preemptionOptIn(principal: string, vault: string, id: string, key: string): Promise<unknown>;
  preemptionNotice(principal: string, vault: string, id: string): Promise<unknown>;
  command(principal: string, vault: string, id: string, raw: unknown): Promise<unknown>;
  sessionEvents(principal: string, vault: string, id: string, afterSequence?: number, limit?: number): Promise<unknown>;
  stopPlan(principal: string, vault: string, id: string): Promise<PlatformWalletPlan>;
  refundPlan(principal: string, vault: string, id: string): Promise<PlatformWalletPlan>;
}

const idem = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const empty = z.object({}).strict();
const vaultAddress = (context: Context) => addressSchema.parse(context.req.param('vault'));

async function jsonBody(context: Context): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(context.req.header('content-type') ?? '')) {
    throw new Problem(422, 'json_required', 'Send application/json.');
  }
  const length = context.req.header('content-length');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 32_768)) {
    throw new Problem(422, 'platform_body_limit', 'Platform requests may contain at most 32 KiB.');
  }
  const reader = context.req.raw.body?.getReader();
  if (!reader) throw new Problem(422, 'invalid_input', 'Send a JSON object.');
  const chunks: Uint8Array[] = []; let bytes = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    reject(new Problem(422, 'platform_body_timeout', 'The request body did not finish.'));
    void reader.cancel().catch(() => undefined);
  }, 5000); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32_768) {
        void reader.cancel().catch(() => undefined);
        throw new Problem(422, 'platform_body_limit', 'Platform requests may contain at most 32 KiB.');
      }
      chunks.push(chunk.value);
    }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(joined); }
    catch { throw new Problem(422, 'invalid_input', 'Send valid UTF-8 JSON.'); }
    return JSON.parse(decoded);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Mount under /api/platform; the main API retains origin, rate and secure-header guards. */
export function createPlatformVaultRuntimeRoutes(service: PlatformVaultRuntimeRouteService, authenticate: (context: Context) => Promise<string>) {
  const routes = new Hono<{ Variables: { platformPrincipal: string } }>();
  routes.use('/vaults/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.set('platformPrincipal', addressSchema.parse(await authenticate(context)).toLowerCase());
    await next();
  });
  routes.get('/vaults/:vault/config', async context => context.json(await service.config(context.get('platformPrincipal'), vaultAddress(context))));
  routes.get('/vaults/:vault/balance', async context => context.json(await service.balance(context.get('platformPrincipal'), vaultAddress(context))));
  routes.post('/vaults/:vault/quotes', async context => {
    const key = idem.parse(context.req.header('idempotency-key'));
    return context.json(await service.quote(context.get('platformPrincipal'), vaultAddress(context), validatedPlatformQuoteInputSchema.parse(await jsonBody(context)), key), 201);
  });
  routes.get('/vaults/:vault/runs', async context => context.json(await service.list(context.get('platformPrincipal'), vaultAddress(context))));
  routes.post('/vaults/:vault/runs', async context => {
    const key = idem.parse(context.req.header('idempotency-key'));
    return context.json(await service.admit(context.get('platformPrincipal'), vaultAddress(context), platformAdmissionSchema.parse(await jsonBody(context)), key));
  });
  routes.get('/vaults/:vault/runs/:id', async context => context.json(await service.get(context.get('platformPrincipal'), vaultAddress(context), bytes32Schema.parse(context.req.param('id')))));
  routes.get('/vaults/:vault/runs/:id/lease', async context => context.json(await service.sessionLease(
    context.get('platformPrincipal'), vaultAddress(context), bytes32Schema.parse(context.req.param('id')))));
  routes.post('/vaults/:vault/runs/:id/preemption-opt-in', async context => {
    const key = idem.parse(context.req.header('idempotency-key')); empty.parse(await jsonBody(context));
    return context.json(await service.preemptionOptIn(context.get('platformPrincipal'), vaultAddress(context),
      bytes32Schema.parse(context.req.param('id')), key));
  });
  routes.get('/vaults/:vault/runs/:id/preemption-notice', async context => context.json(await service.preemptionNotice(
    context.get('platformPrincipal'), vaultAddress(context), bytes32Schema.parse(context.req.param('id')))));
  routes.post('/vaults/:vault/runs/:id/commands', async context => {
    const key = idem.parse(context.req.header('idempotency-key'));
    const command = sessionCommandSchema.parse(await jsonBody(context));
    if (command.commandId !== key) throw new Problem(409, 'platform_command_idempotency', 'Idempotency-Key must equal commandId.');
    return context.json(await service.command(context.get('platformPrincipal'), vaultAddress(context),
      bytes32Schema.parse(context.req.param('id')), command));
  });
  routes.get('/vaults/:vault/runs/:id/events', async context => {
    const after = context.req.query('after') ?? '-1', rawLimit = context.req.query('limit') ?? '8';
    if (!/^(?:-1|0|[1-9][0-9]{0,3})$/.test(after) || !/^[1-8]$/.test(rawLimit)) {
      throw new Problem(422, 'platform_event_cursor', 'Invalid session event cursor.');
    }
    return context.json(await service.sessionEvents(context.get('platformPrincipal'), vaultAddress(context),
      bytes32Schema.parse(context.req.param('id')), Number(after), Number(rawLimit)));
  });
  for (const action of ['stop', 'refund'] as const) routes.post('/vaults/:vault/runs/:id/' + action, async context => {
    idem.parse(context.req.header('idempotency-key')); empty.parse(await jsonBody(context));
    return context.json(await service[action === 'stop' ? 'stopPlan' : 'refundPlan'](context.get('platformPrincipal'), vaultAddress(context), bytes32Schema.parse(context.req.param('id'))));
  });
  return routes;
}
