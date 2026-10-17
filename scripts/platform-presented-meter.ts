import { lstat, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { addressSchema, bytes32Schema } from '../src/common.js';
import { hostMessageHash, signedAckSchema, signedLeaseSchema } from '../src/host-kit/protocol.js';
import { PRESENTED_METER_MAX_BYTES, preparePresentedMeterBundle,
  verifyPresentedMeterBundle } from '../src/platform-runtime/presented-meter.js';
import { platformPinsSchema, platformQuoteSchema } from '../src/platform-runtime/types.js';

const rowSchema = z.object({ status: z.literal('completed'), owner: addressSchema,
  hostId: bytes32Schema, quote: platformQuoteSchema, leaseHash: bytes32Schema,
  lease: signedLeaseSchema, ticks: z.unknown(), acknowledgments: z.unknown(),
  cleanupConfirmed: z.number().int().min(1) }).strict();

async function boundedFile(path: string, maximum: number): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximum) {
    throw new Error('Input file is not a bounded regular file');
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

let phase = 'arguments';
try {
  const { values } = parseArgs({ options: { mode: { type: 'string' }, pins: { type: 'string' },
    'rpc-url': { type: 'string' }, bundle: { type: 'string' }, 'run-id': { type: 'string' },
    'transaction-hash': { type: 'string' }, confirmations: { type: 'string' } },
    strict: true, allowPositionals: false });
  const mode = z.enum(['export', 'verify']).parse(values.mode);
  const rpcUrl = z.string().url().parse(values['rpc-url']);
  const confirmations = values.confirmations === undefined ? 12 : z.string().regex(/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/)
    .transform(Number).parse(values.confirmations);
  phase = 'pins';
  const pins = platformPinsSchema.parse(await boundedFile(z.string().min(1).parse(values.pins), 65_536));
  if (mode === 'verify') {
    phase = 'bundle';
    if (values['run-id'] || values['transaction-hash']) throw new Error('Unexpected export arguments');
    const bundle = await boundedFile(z.string().min(1).parse(values.bundle), PRESENTED_METER_MAX_BYTES);
    phase = 'chain';
    const result = await verifyPresentedMeterBundle(bundle, pins, rpcUrl, confirmations);
    process.stdout.write(JSON.stringify({ readOnly: true, ...result }) + '\n');
  } else {
    if (values.bundle) throw new Error('Unexpected verification bundle');
    const runId = bytes32Schema.parse(values['run-id']), transactionHash = bytes32Schema.parse(values['transaction-hash']);
    const databaseUrl = z.string().min(1).parse(process.env.DATABASE_URL);
    phase = 'database';
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, application_name: 'telomere-readonly-presented-meter' });
    let raw: unknown;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await client.query(`SELECT r.status, r.owner, h.host_id AS "hostId", r.quote,
          h.lease_hash AS "leaseHash", h.lease, h.ticks, h.acknowledgments,
          h.cleanup_confirmed AS "cleanupConfirmed"
          FROM platform_runs r JOIN platform_host_leases h ON h.run_id=r.id
          WHERE r.id=$1 AND r.settlement_tx=$2
            AND jsonb_array_length(h.ticks) BETWEEN 1 AND 100
            AND jsonb_array_length(h.acknowledgments)=jsonb_array_length(h.ticks)
          LIMIT 1`, [runId, transactionHash]);
        raw = result.rows[0];
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    } finally { await pool.end(); }
    const row = rowSchema.parse(raw);
    if (row.hostId !== row.quote.hostId || row.owner.toLowerCase() !== row.quote.payer.toLowerCase()
      || row.lease.body.runId !== runId || row.lease.body.owner !== row.owner.toLowerCase()
      || row.leaseHash !== hostMessageHash(row.lease)) {
      throw new Error('Stored paid host scope changed');
    }
    const bundle = preparePresentedMeterBundle(runId, transactionHash, row.ticks);
    const acknowledgments = signedAckSchema.array().length(bundle.ticks.length).parse(row.acknowledgments);
    const leaseBodyHash = hostMessageHash({ body: row.lease.body, signature: '' });
    for (const [index, tick] of bundle.ticks.entries()) {
      const ack = acknowledgments[index]!;
      if (tick.body.leaseHash !== leaseBodyHash || ack.body.leaseHash !== leaseBodyHash
        || ack.body.runId !== runId || ack.body.hostKey !== row.lease.body.hostKey
        || ack.body.sequence !== index || ack.body.tickHash !== hostMessageHash(tick)) {
        throw new Error('Stored paired host evidence changed');
      }
    }
    phase = 'chain';
    await verifyPresentedMeterBundle(bundle, pins, rpcUrl, confirmations);
    process.stdout.write(JSON.stringify(bundle) + '\n');
  }
} catch {
  // Profiles, RPC URLs, DB credentials and untrusted bundle contents are never logged.
  process.stdout.write(JSON.stringify({ readOnly: true, status: 'rejected', phase,
    code: 'platform_presented_meter_unavailable' }) + '\n');
  process.exitCode = 1;
}
