// Operator-only, ignored local runner. Upload/review before use; no automatic execution.
// Never logs the protected profile, DB URLs, receipt bodies, or retained transactions.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const OLD = '/opt/telomere-pilot/app';
const TABLES = ['auth_nonces', 'auth_sessions', 'cyst_owners', 'cysts', 'jobs', 'leash_refs', 'transaction_journal'];
const OPTIONAL = ['PLATFORM_RUNTIME_CONFIG', 'CYST_REGISTRY_CONFIG', 'CYSTS_REPLICATION_CONFIG', 'CYSTS_LARGE_DIR',
  'CYSTS_LARGE_REPLICATION_CONFIG', 'CYSTS_QUOTA_POLICY_PATH', 'INCOME_ENDPOINTS_CONFIG', 'VAULT_INCOME_CONFIG',
  'TREASURY_TOPUP_CONFIG', 'AKASH_READINESS_CONFIG', 'REPUTATION_PUBLISHER_CONFIG'];
let phase = 'arguments';

function ensure(test, code) { if (!test) throw new Error(code); }
async function privateJson(path, value) {
  await writeFile(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 });
}
async function bounded(path, max = 16777216) {
  const meta = await lstat(path);
  ensure(meta.isFile() && !meta.isSymbolicLink() && meta.nlink === 1 && meta.size <= max, 'invalid_private_input');
  return await readFile(path);
}
async function moduleAt(root, path) { return await import(pathToFileURL(join(root, path)).href); }

async function dbEvidence(client, cystDirectory, expectedTables, originalColumns) {
  await client.query("SET TIME ZONE 'UTC'");
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
    if (expectedTables) ensure(canonical(tables) === canonical(TABLES), 'unexpected_legacy_tables');
    const schemaRows = (await client.query(`SELECT table_name,column_name,udt_name FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows;
    const columns = {};
    for (const table of TABLES) columns[table] = schemaRows.filter(row => row.table_name === table).map(row => ({ name: row.column_name, type: row.udt_name }));
    const projected = originalColumns ?? columns;
    const hashes = {}, counts = {};
    for (const name of TABLES) {
      // Identifiers are only from the closed TABLES constant. No values leave this process.
      const expected = projected[name];
      ensure(Array.isArray(expected) && expected.length > 0 && expected.length <= 64, 'original_column_projection');
      for (const column of expected) ensure(/^[a-z_][a-z0-9_]*$/.test(column.name)
        && columns[name].some(actual => actual.name === column.name && actual.type === column.type), 'original_column_changed');
      const extras = columns[name].filter(actual => !expected.some(column => column.name === actual.name));
      ensure(extras.every(column => (name === 'jobs' && column.name === 'agent_address' && column.type === 'text')
        || (name === 'transaction_journal' && column.name === 'nonce' && ['int4', 'int8'].includes(column.type))), 'unreviewed_additive_column');
      const fields = expected.map(column => `'${column.name}',t."${column.name}"`).join(',');
      const rows = (await client.query(`SELECT jsonb_build_object(${fields})::text AS row FROM ${name} t ORDER BY jsonb_build_object(${fields})::text LIMIT 10001`)).rows;
      ensure(rows.length <= 10000, 'table_bound');
      const text = rows.map(row => row.row).join('\n');
      ensure(Buffer.byteLength(text) <= 16777216, 'table_byte_bound');
      hashes[name] = sha(text); counts[name] = rows.length;
    }
    const jobs = (await client.query('SELECT id,owner,leash_id,status,receipt,settlement_tx_hash,ceiling,charged,refund,billable_seconds FROM jobs ORDER BY id LIMIT 6')).rows;
    ensure(jobs.length === 5 && jobs.every(row => row.status === 'completed' && row.receipt && row.settlement_tx_hash), 'five_completed_required');
    const records = (await client.query('SELECT owner,id,sha256,ciphertext_bytes,state FROM cysts ORDER BY owner,id LIMIT 2')).rows;
    ensure(records.length === 1 && records[0].state === 'ready' && records[0].ciphertext_bytes === 93, 'original_cyst_required');
    const names = await readdir(cystDirectory);
    ensure(names.length === 1 && /^[a-f0-9]{64}\.blob$/.test(names[0]), 'unexpected_cyst_files');
    const record = records[0];
    const name = sha('telomere-cyst-blob:' + record.owner + ':' + record.sha256) + '.blob';
    ensure(names[0] === name, 'cyst_name');
    const file = join(cystDirectory, name), meta = await lstat(file), bytes = await bounded(file, 2097168);
    ensure((meta.mode & 0o077) === 0 && bytes.length === record.ciphertext_bytes && sha(bytes) === record.sha256, 'cyst_integrity');
    const usage = (await client.query(`SELECT count(*)::integer AS mismatches FROM cyst_owners o WHERE
      o.checkpoints <> (SELECT count(*) FROM cysts c WHERE c.owner=o.owner) OR
      o.used_bytes <> (SELECT coalesce(sum(ciphertext_bytes),0) FROM cysts c WHERE c.owner=o.owner)`)).rows[0];
    ensure(usage.mismatches === 0, 'cyst_counter_mismatch');
    await client.query('ROLLBACK');
    return { tableHashes: hashes, counts, columns: projected, actualColumns: columns, jobs,
      cysts: { count: 1, bytes: 93, blobSha256: record.sha256, metadataSha256: hashes.cysts, counterMismatches: 0 }, tables };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}


// Exact read-only dbEvidence and support functions above are from frozen helper43d37c51.
// This separate audit imports no main entry point and opens a read-only DB transaction.
try {
  const work = '/opt/telomere-pilot/rollout/staging-354fe7af62ea-final04';
  const release = '/opt/telomere-pilot/releases/354fe7af62ea6701faafc3b04522abb1b4524d2d-launch04';
  const parent = JSON.parse((await bounded('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch04/state.json', 1048576)).toString());
  ensure(parent.run === 'staging-354fe7af62ea-launch04' && parent.stage === 'activated'
    && parent.revision === '354fe7af62ea6701faafc3b04522abb1b4524d2d'
    && parent.archiveSha256 === '86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce'
    && parent.finalWork === work && parent.release === release && parent.heldStop?.active === false,
    'actual_parent_not_activated');
  const childBytes = await bounded(join(work, 'state.json'), 1048576);
  ensure(sha(childBytes) === parent.finalStateSha256, 'final_child_state_changed');
  const child = JSON.parse(childBytes.toString());
  ensure(child.run === 'staging-354fe7af62ea-final04' && child.parentRun === parent.run
    && child.stage === 'clone_accepted' && child.release === release
    && child.revision === parent.revision && child.archiveSha256 === parent.archiveSha256,
    'final_child_identity_changed');
  const preactivationBytes = await bounded(join(work, 'preactivation-fingerprint.json'), 65536);
  ensure(sha(preactivationBytes) === parent.finalFreshFingerprintSha256, 'final_fingerprint_changed');
  const baseline = JSON.parse((await bounded(join(work, 'snapshot-fingerprint.json'), 65536)).toString());
  ensure(canonical(baseline) === canonical(JSON.parse(preactivationBytes.toString())), 'fresh_fingerprint_binding_changed');
  const acceptedBytes = await bounded(join(work, 'clone/latest-acceptance.json'), 65536);
  ensure(sha(acceptedBytes) === child.latestReportSha256, 'final_clone_report_changed');
  const accepted = JSON.parse(acceptedBytes.toString());
  ensure(accepted.status === 'passed' && accepted.source === 'latest', 'final_clone_not_accepted');
  const profileBytes = await bounded('/opt/telomere-pilot/config/staging.env', 65536);
  ensure(sha(profileBytes) === baseline.profileSha256, 'profile_changed_after_activation');
  const { parseProfile } = await moduleAt(release, 'dist/src/operator/profile.js');
  const { loadConfig } = await moduleAt(release, 'dist/src/config.js');
  const config = loadConfig(parseProfile(profileBytes.toString('utf8')));
  const url = new URL(config.DATABASE_URL);
  ensure(config.MODE === 'demo' && config.CHAIN_ID === 31337 && config.RPC_URL === 'http://127.0.0.1:18547'
    && config.CYSTS_DIR === '/opt/telomere-pilot/data/cysts' && url.hostname === '127.0.0.1'
    && url.port === '15434' && url.pathname === '/telomere', 'unexpected_original_profile');
  const require = createRequire(join(release, 'package.json'));
  const { Client } = require('pg');
  const client = new Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  let evidence;
  try {
    await client.connect();
    evidence = await dbEvidence(client, config.CYSTS_DIR, false, baseline.originalColumns);
  } finally { await client.end(); }
  ensure(canonical(evidence.tableHashes) === canonical(baseline.tableHashes), 'original_rows_changed_after_activation');
  ensure(canonical(evidence.cysts) === canonical(baseline.cysts), 'original_cyst_changed_after_activation');
  const rpc = async (method, params) => {
    const response = await fetch(config.RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
    ensure(response.status === 200, 'local_rpc_failed');
    const value = await response.json();
    ensure(!value.error && value.result !== undefined, 'local_rpc_error');
    return value.result;
  };
  ensure(await rpc('eth_chainId', []) === '0x7a69', 'original_chain_id_changed');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  ensure(BigInt(block.number).toString() === accepted.canonicalAnchor.number
    && block.hash === accepted.canonicalAnchor.hash && block.stateRoot === accepted.canonicalAnchor.stateRoot,
    'canonical_head_changed_after_activation');
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'readonly_postactivation_original_data_and_chain',
    status: 'passed', checkedAt: new Date().toISOString(),
    exactDbEvidenceHelperSha256: '43d37c51c7d50a1a9971b444367045a2c7e73b91239418d679460d1fb06176e5',
    originalTableCounts: evidence.counts, originalTableHashes: evidence.tableHashes,
    originalSevenTablesUnchanged: true, originalColumnProjectionVerified: true,
    currentSchemaTableCount: evidence.tables.length, cysts: evidence.cysts,
    protectedProfileUnchanged: true, canonicalHeadMatchesHeldClone: true,
    freshlyVerifiedCanonicalHead: { number: accepted.canonicalAnchor.number,
      hash: block.hash, stateRoot: block.stateRoot },
    retainedCloneStateSha256: accepted.canonicalAnchor.stateSha256, sqlReadOnlyTransaction: true,
    credentialsOrRowContentsReturned: false, transactionsSent: 0, paidProviderRequests: 0 }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ status: 'failed', kind: 'readonly_postactivation_original_data_and_chain' }) + '\n');
  process.exitCode = 1;
}
