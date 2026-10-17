import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { bytes32Schema, addressSchema } from '../src/common.js';
import { signedReceiptSchema } from '../src/service.js';

const config = loadConfig(process.env);
if (config.MODE !== 'demo' || config.CPU_MODE !== 'docker' || config.CHAIN_ID !== 31337 || !config.DATABASE_URL) throw new Error('Private Docker/PostgreSQL staging only');
const endpoint = `http://127.0.0.1:${config.PORT}`, reportPath = resolve(process.env.STAGING_REPORT_PATH ?? '.local/staging-acceptance.json');
const readinessDeadline = Date.now() + 15000;
while (true) {
  try { const ready = await fetch(endpoint + '/health/ready', { signal: AbortSignal.timeout(1000) }); if (ready.ok) break; } catch { /* Startup probes are read-only. */ }
  if (Date.now() >= readinessDeadline) throw new Error('Staging controller did not become ready');
  await delay(200);
}
let cookie = '';
async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, idempotencyKey?: string): Promise<T> {
  const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
    headers: { origin: config.PUBLIC_ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const received = response.headers.get('set-cookie');
  if (received?.startsWith('telomere_session=')) cookie = received.split(';')[0]!;
  if (!response.ok) throw new Error(`Staging endpoint rejected ${path}: ${response.status}`);
  return schema.parse(await response.json());
}
const txSchema = z.object({ to: addressSchema, data: z.string().regex(/^0x[a-f0-9]+$/i), value: z.literal('0x0') });
const runSchema = z.object({ id: bytes32Schema, status: z.string(), billableSeconds: z.number().int(), charged: z.string().nullable(),
  refund: z.string().nullable(), settlementTxHash: bytes32Schema.nullable(), output: z.string().nullable(), receipt: signedReceiptSchema.nullable() }).passthrough();
const auth = await request('/api/auth/demo', z.object({ address: addressSchema, demo: z.literal(true) }), {});
if (process.argv.includes('--recover')) {
  const prior = z.object({ runId: bytes32Schema, receiptHash: bytes32Schema, settlementTxHash: bytes32Schema, charged: z.string(), refund: z.string() }).passthrough().parse(JSON.parse(await readFile(reportPath, 'utf8')));
  const run = await request(`/api/runs/${prior.runId}`, runSchema);
  const proof = await request('/api/receipts/verify', z.object({ valid: z.literal(true), anchored: z.literal(true) }).passthrough(), { receipt: run.receipt });
  if (run.status !== 'completed' || run.receipt?.receiptHash !== prior.receiptHash || run.settlementTxHash !== prior.settlementTxHash
    || run.charged !== prior.charged || run.refund !== prior.refund) throw new Error('Persisted run changed after restart');
  const report = { ...prior, restartVerifiedAt: new Date().toISOString(), recovery: { unchangedRunAndSettlement: true, signatureValid: proof.valid, anchored: proof.anchored } };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(report));
} else {
  await request('/api/demo/fund', z.unknown(), {});
  const leash = await request('/api/leashes', z.object({ leashId: bytes32Schema, transaction: txSchema }), { maxPerHour: '200000', maxPerDay: '300000', expiry: Math.floor(Date.now() / 1000) + 3600 });
  await request('/api/demo/transaction', z.object({ txHash: bytes32Schema }), leash.transaction);
  const quoteInput = { leashId: leash.leashId, maxSeconds: 30, task: { kind: 'hash_chain', text: 'Telomere isolated staging acceptance', iterations: 2000000 } };
  const quoted = await request('/api/quotes', z.object({ quote: z.object({ runId: bytes32Schema }), transaction: txSchema, ceiling: z.string() }), quoteInput, `staging-${randomUUID()}`);
  const opened = await request('/api/demo/transaction', z.object({ txHash: bytes32Schema }), quoted.transaction);
  await request('/api/runs', z.unknown(), { runId: quoted.quote.runId, txHash: opened.txHash });
  let run = await request(`/api/runs/${quoted.quote.runId}`, runSchema);
  const until = Date.now() + 60000;
  while (!['completed', 'failed', 'reconciliation', 'cancelled', 'timed_out'].includes(run.status) && Date.now() < until) {
    await delay(1000); run = await request(`/api/runs/${quoted.quote.runId}`, runSchema);
  }
  if (run.status !== 'completed' || !run.receipt || !run.settlementTxHash || run.charged === null || run.refund === null) throw new Error('Staging execution did not settle');
  const proof = await request('/api/receipts/verify', z.object({ valid: z.literal(true), anchored: z.literal(true) }).passthrough(), { receipt: run.receipt });
  if (BigInt(run.charged) + BigInt(run.refund) !== BigInt(quoted.ceiling)) throw new Error('Staging charge/refund mismatch');
  const report = { checkedAt: new Date().toISOString(), deployment: 'private_vps_staging', chainId: 31337, cpuMode: 'docker', database: 'dedicated_postgresql',
    realFunds: false, paidNearPosts: 0, owner: auth.address, runId: run.id, status: run.status, billableSeconds: run.billableSeconds,
    ceiling: quoted.ceiling, charged: run.charged, refund: run.refund, receiptHash: run.receipt.receiptHash, settlementTxHash: run.settlementTxHash,
    signatureValid: proof.valid, anchored: proof.anchored };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
