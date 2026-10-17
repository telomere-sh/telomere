import hashlib, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
helper = root / '.local/private-staging-rollout-attempt4-20261015/clone-smoke.mjs'
raw = helper.read_bytes()
assert hashlib.sha256(raw).hexdigest() == '43d37c51c7d50a1a9971b444367045a2c7e73b91239418d679460d1fb06176e5'
source = raw.decode('utf-8')
prefix = source[:source.index("try {\n  ensure(process.platform === 'linux'")]
audit = r'''
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
'''
target = root / '.local/verify-postactivation-original-state-20261015.mjs'
target.write_text(prefix + audit, encoding='utf-8', newline='\n')
print('Separate read-only postactivation auditor prepared from exact frozen helper.')
