import { lstat, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { z } from 'zod';
import { readProfile } from '../src/operator/profile.js';
import { auditPreparedPlatformRuns } from '../src/operator/platform-prepared-audit.js';
import { platformEscrowAbi, platformPinsSchema, typedPlatformQuote } from '../src/platform-runtime/types.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => getAddress(value));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase() as Hex);
const positive = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().safe());
const nonnegativeBlock = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(BigInt);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type DbRow = { id: string; owner: string; agent: string; inputHash: string; inputJson: string;
  quoteJson: string; signature: string; ceiling: string; vaultBindingJson: string | null;
  status: string; admissionTx: string | null; settlementTx: string | null;
  settlementJson: string | null; charged: string | null; refund: string | null; updatedAt: Date };
const query = `SELECT left(id, 67) AS id, left(owner, 43) AS owner, left(agent, 43) AS agent,
  left(input_hash, 67) AS "inputHash", left(input::text, 32769) AS "inputJson",
  left(quote::text, 8193) AS "quoteJson", left(signature, 133) AS signature,
  left(ceiling, 33) AS ceiling, left(vault_binding::text, 2049) AS "vaultBindingJson",
  status, left(admission_tx, 67) AS "admissionTx", left(settlement_tx, 67) AS "settlementTx",
  left(settlement::text, 2049) AS "settlementJson", left(charged, 33) AS charged,
  left(refund, 33) AS refund, updated_at AS "updatedAt"
  FROM platform_runs WHERE status = 'prepared' ORDER BY id LIMIT 1025`;
async function readRows(pool: pg.Pool): Promise<DbRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const table = await client.query<{ present: boolean }>("SELECT to_regclass('platform_runs') IS NOT NULL AS present");
    if (!table.rows[0]?.present) throw new Error('Paid platform runs are unavailable');
    const selected = await client.query<DbRow>(query);
    await client.query('COMMIT');
    return selected.rows;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
const parseJson = (value: string | null): unknown => value === null ? null : JSON.parse(value);
function auditRows(rows: DbRow[]): unknown[] {
  return rows.map(row => {
    try {
      return { id: row.id, owner: row.owner, agent: row.agent, inputHash: row.inputHash,
        input: parseJson(row.inputJson), quote: parseJson(row.quoteJson), signature: row.signature,
        ceiling: row.ceiling, vaultBinding: parseJson(row.vaultBindingJson), status: row.status,
        admissionTx: row.admissionTx, settlementTx: row.settlementTx,
        settlement: parseJson(row.settlementJson), charged: row.charged, refund: row.refund };
    } catch { return { malformed: true }; }
  });
}

let phase = 'arguments';
let failureCode = 'platform_prepared_audit_failed';
try {
  const { values } = parseArgs({ options: {
    'env-file': { type: 'string' }, 'expected-chain-id': { type: 'string' },
    'expected-escrow': { type: 'string' }, 'expected-escrow-code-hash': { type: 'string' },
    'expected-quote-signer': { type: 'string' }, 'expected-token': { type: 'string' },
    'expected-receipt-root': { type: 'string' }, 'expected-host-registry': { type: 'string' },
    'expected-fee-router': { type: 'string' }, 'reference-block': { type: 'string' },
    'expected-reference-hash': { type: 'string' },
  }, strict: true, allowPositionals: false });
  const expected = { chainId: positive.parse(values['expected-chain-id']),
    escrow: address.parse(values['expected-escrow']), escrowCodeHash: hash.parse(values['expected-escrow-code-hash']),
    quoteSigner: address.parse(values['expected-quote-signer']), token: address.parse(values['expected-token']),
    receiptRoot: address.parse(values['expected-receipt-root']), hostRegistry: address.parse(values['expected-host-registry']),
    feeRouter: address.parse(values['expected-fee-router']), referenceBlock: nonnegativeBlock.parse(values['reference-block']),
    referenceHash: hash.parse(values['expected-reference-hash']) };
  phase = 'profile';
  const config = await readProfile(z.string().min(1).parse(values['env-file']));
  if (!config.DATABASE_URL || !config.PLATFORM_RUNTIME_CONFIG || config.CHAIN_ID !== expected.chainId) {
    throw new Error('Paid platform profile differs from reviewed deployment');
  }
  const metadata = await lstat(config.PLATFORM_RUNTIME_CONFIG);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 65_536
    || process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) throw new Error('Invalid platform profile');
  const pins = platformPinsSchema.parse(JSON.parse(await readFile(config.PLATFORM_RUNTIME_CONFIG, 'utf8')).pins);
  if (pins.chainId !== expected.chainId || !same(pins.escrowAddress, expected.escrow)
    || !same(pins.escrowCodeHash, expected.escrowCodeHash) || !same(pins.quoteSigner, expected.quoteSigner)
    || !same(pins.tokenAddress, expected.token) || !same(pins.receiptRootAddress, expected.receiptRoot)
    || !same(pins.hostRegistryAddress, expected.hostRegistry) || !same(pins.feeRouterAddress, expected.feeRouter)) {
    throw new Error('Platform public pins differ from independently reviewed values');
  }

  phase = 'database';
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'telomere-readonly-platform-prepared' });
  try {
    const initial = await readRows(pool);
    if (initial.length > 1024) { failureCode = 'platform_prepared_limit'; throw new Error('Prepared run inventory exceeds bound'); }
    phase = 'network';
    const chain = defineChain({ id: expected.chainId, name: 'Telomere reviewed platform',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.RPC_URL] } } });
    const rpc = createPublicClient({ chain, transport: http(config.RPC_URL, { timeout: 10_000, retryCount: 0 }) });
    if (await rpc.getChainId() !== expected.chainId) throw new Error('Platform chain changed');
    phase = 'audit';
    const result = await auditPreparedPlatformRuns(auditRows(initial), expected, {
      getBlockHash: async blockNumber => {
        const block = await rpc.getBlock({ blockNumber });
        if (!block.hash) throw new Error('Historical reference block is unavailable');
        return block.hash;
      },
      getEscrowCode: blockNumber => rpc.getCode({ address: expected.escrow, blockNumber }),
      getEscrowIdentity: async blockNumber => {
        const read = (functionName: 'quoteSigner' | 'token' | 'receiptRoot' | 'hostRegistry' | 'feeRouter') =>
          rpc.readContract({ address: expected.escrow, abi: platformEscrowAbi, functionName, blockNumber });
        const [quoteSigner, token, receiptRoot, hostRegistry, feeRouter] = await Promise.all([
          read('quoteSigner'), read('token'), read('receiptRoot'), read('hostRegistry'), read('feeRouter')]);
        return { quoteSigner, token, receiptRoot, hostRegistry, feeRouter };
      },
      getRun: (runId, blockNumber) => rpc.readContract({ address: expected.escrow,
        abi: platformEscrowAbi, functionName: 'getRun', args: [runId], blockNumber }),
      getLeash: (leashId, blockNumber) => rpc.readContract({ address: expected.escrow,
        abi: platformEscrowAbi, functionName: 'getLeash', args: [leashId], blockNumber }),
      getQuoteCeiling: (quote, blockNumber) => rpc.readContract({ address: expected.escrow,
        abi: platformEscrowAbi, functionName: 'quoteCeiling', args: [typedPlatformQuote(quote), false], blockNumber }),
    });
    phase = 'database';
    const final = await readRows(pool);
    if (JSON.stringify(final) !== JSON.stringify(initial)) {
      result.counts.database_changed++;
      result.status = 'critical';
    }
    process.stdout.write(JSON.stringify({ readOnly: true, ...result }) + '\n');
    if (result.status !== 'ok') process.exitCode = 1;
  } finally { await pool.end(); }
} catch {
  // Profile, database and RPC exception text can include private endpoints or credentials.
  process.stdout.write(JSON.stringify({ readOnly: true, status: 'critical', phase, code: failureCode }) + '\n');
  process.exitCode = 1;
}
