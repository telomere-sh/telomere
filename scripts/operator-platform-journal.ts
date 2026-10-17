import { lstat, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createPublicClient, defineChain, getAddress, http, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { z } from 'zod';
import { readProfile } from '../src/operator/profile.js';
import { auditPlatformJournal } from '../src/operator/platform-journal-audit.js';
import { platformPinsSchema } from '../src/platform-runtime/types.js';

let phase = 'arguments';
let failureCode = 'platform_journal_audit_failed';
try {
  const { values } = parseArgs({ options: { 'env-file': { type: 'string' },
    'expected-chain-id': { type: 'string' }, 'expected-signer': { type: 'string' },
    'expected-escrow': { type: 'string' }, 'expected-receipt-root': { type: 'string' },
    'initial-signer-nonce': { type: 'string' } }, strict: true, allowPositionals: false });
  const expectedChainId = z.string().regex(/^[1-9][0-9]*$/).transform(Number)
    .pipe(z.number().int().positive().safe()).parse(values['expected-chain-id']);
  const expectedSigner = getAddress(z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(values['expected-signer']));
  const expectedEscrow = getAddress(z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(values['expected-escrow']));
  const expectedReceiptRoot = getAddress(z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(values['expected-receipt-root']));
  const initialNonce = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number)
    .pipe(z.number().int().nonnegative().safe()).parse(values['initial-signer-nonce']);
  phase = 'profile';
  const config = await readProfile(z.string().min(1).parse(values['env-file']));
  if (!config.DATABASE_URL || !config.PLATFORM_RUNTIME_CONFIG || config.CHAIN_ID !== expectedChainId) {
    throw new Error('Paid platform profile does not match reviewed deployment');
  }
  const metadata = await lstat(config.PLATFORM_RUNTIME_CONFIG);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 65_536
    || process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new Error('Invalid platform profile');
  const pins = platformPinsSchema.parse(JSON.parse(await readFile(config.PLATFORM_RUNTIME_CONFIG, 'utf8')).pins);
  if (pins.chainId !== expectedChainId || pins.quoteSigner.toLowerCase() !== expectedSigner.toLowerCase()
    || pins.escrowAddress.toLowerCase() !== expectedEscrow.toLowerCase()
    || pins.receiptRootAddress.toLowerCase() !== expectedReceiptRoot.toLowerCase()) throw new Error('Platform pins changed');

  phase = 'database';
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'telomere-readonly-platform-journal' });
  let rows: unknown[];
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const table = await client.query<{ present: boolean }>("SELECT to_regclass('platform_transaction_journal') IS NOT NULL AS present");
      if (!table.rows[0]?.present) throw new Error('Paid platform transaction journal is missing');
      const selected = await client.query(`SELECT left(key, 181) AS key, chain_id AS "chainId",
        left(sender, 43) AS sender, left("to", 43) AS "to", left(data, 131073) AS data,
        left(raw, 131073) AS raw, left(hash, 67) AS hash, nonce
        FROM platform_transaction_journal ORDER BY chain_id, sender, nonce, key LIMIT 4097`);
      rows = selected.rows;
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }

  if (rows.length > 4096) {
    failureCode = 'platform_journal_limit';
    throw new Error('Platform journal requires archival review');
  }
  phase = 'network';
  const chain = defineChain({ id: expectedChainId, name: 'Telomere reviewed platform',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.RPC_URL] } } });
  const rpc = createPublicClient({ chain, transport: http(config.RPC_URL, { timeout: 10_000, retryCount: 0 }) });
  if (await rpc.getChainId() !== expectedChainId) throw new Error('Platform chain changed');
  phase = 'audit';
  const result = await auditPlatformJournal(rows, { chainId: expectedChainId, signer: expectedSigner,
    escrow: expectedEscrow, receiptRoot: expectedReceiptRoot, initialNonce }, {
    getReferenceBlock: async () => {
      const block = await rpc.getBlock();
      if (block.number === null || !block.hash) throw new Error('Canonical reference block is unavailable');
      return { number: block.number, hash: block.hash };
    },
    getTransactionReceipt: async (hash: Hex) => {
      try { return await rpc.getTransactionReceipt({ hash }); }
      catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    },
    getBlockHash: async blockNumber => (await rpc.getBlock({ blockNumber })).hash,
    getLatestNonce: async (address, blockNumber) => rpc.getTransactionCount(blockNumber === undefined
      ? { address, blockTag: 'latest' } : { address, blockNumber }),
  });
  process.stdout.write(JSON.stringify({ readOnly: true, chainId: expectedChainId, ...result }) + '\n');
  if (result.status !== 'ok') process.exitCode = 1;
} catch {
  // Never print profile, RPC or DB exceptions: they can contain credentials and private endpoints.
  process.stdout.write(JSON.stringify({ readOnly: true, status: 'critical', phase,
    code: failureCode }) + '\n');
  process.exitCode = 1;
}
