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

try {
  ensure(process.platform === 'linux' && process.argv.length === 4, 'linux_arguments');
  const action = process.argv[2], file = resolve(process.argv[3]);
  ensure(['fingerprint', 'restore-cysts', 'clone'].includes(action), 'unknown_action');
  const raw = JSON.parse((await bounded(file, 65536)).toString('utf8'));
  ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'invalid_options');
  ensure(/^\/opt\/telomere-pilot\/releases\/[a-f0-9]{40}-[a-z0-9]{6,16}$/.test(raw.release), 'release_path');
  ensure(/^\/opt\/telomere-pilot\/rollout\/staging-[a-f0-9]{12}-[a-z0-9]{6,16}$/.test(raw.work), 'work_path');
  const require = createRequire(join(raw.release, 'package.json'));
  const { z } = require('zod');
  const options = z.object({ release: z.string(), work: z.string(), profile: z.string(), output: z.string(),
    backup: z.string().optional(), cloneRoot: z.string().optional(), databaseUrl: z.string().optional(), rpcUrl: z.string().optional(),
    port: z.number().int().min(1024).max(65535).optional(), dockerHost: z.string().optional(), cpuImage: z.string().optional(),
    source: z.enum(['latest', 'old']).optional(), baseline: z.string().optional() }).strict().parse(raw);
  ensure(options.output.startsWith(options.work + '/'), 'output_scope');
  const { parseProfile } = await moduleAt(options.release, 'dist/src/operator/profile.js');
  const { loadConfig } = await moduleAt(options.release, 'dist/src/config.js');
  const profileBytes = await bounded(options.profile, 65536);
  const env = parseProfile(profileBytes.toString('utf8'));
  const original = loadConfig(env);
  ensure(original.MODE === 'demo' && original.CHAIN_ID === 31337 && original.CPU_MODE === 'docker'
    && original.CYSTS_ENABLED && original.AGENT_RUNTIME === 'legacy' && !original.PAID_CYST_INPUTS_ENABLED
    && !original.SELECTION_ENABLED && !original.NEAR_ENDPOINT && OPTIONAL.every(key => !env[key]), 'protected_profile_changed');
  ensure(original.RPC_URL === 'http://127.0.0.1:18547' && original.CYSTS_DIR === '/opt/telomere-pilot/data/cysts', 'protected_paths_changed');
  const originalDb = new URL(original.DATABASE_URL);
  ensure(originalDb.hostname === '127.0.0.1' && originalDb.port === '15434' && originalDb.pathname === '/telomere', 'protected_db_changed');

  if (action === 'restore-cysts') {
    phase = 'restore_cysts';
    ensure(options.backup?.startsWith(options.work + '/') && options.cloneRoot === join(options.work, 'clone'), 'clone_paths');
    const api = await moduleAt(options.release, 'dist/src/operator/backup.js');
    const manifest = await api.verifyBackup(options.backup);
    ensure(manifest.schemaVersion === 2, 'backup_v2_required');
    const entry = manifest.files.find(row => row.name === api.cystSnapshotFileName);
    ensure(entry, 'snapshot_missing');
    await api.restoreCystSnapshot(join(options.backup, api.cystSnapshotFileName), join(options.cloneRoot, '.local', 'cysts'), entry);
    await privateJson(options.output, { status: 'cysts_restored', schemaVersion: 2, count: manifest.cysts.blobs, bytes: manifest.cysts.ciphertextBytes });
  } else if (action === 'fingerprint') {
    phase = 'fingerprint';
    const { Client } = require('pg'), client = new Client({ connectionString: original.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    let evidence;
    try { await client.connect(); evidence = await dbEvidence(client, original.CYSTS_DIR, true); }
    finally { await client.end(); }
    const chainBytes = await bounded('/opt/telomere-pilot/data/chain.json', 1073741824);
    const { ChainBridge } = await moduleAt(options.release, 'dist/src/bridge.js');
    // The chain service is stopped during this action, so canonical chain evidence comes from the immutable backup at clone validation.
    ensure(typeof ChainBridge === 'function', 'bridge_export');
    await privateJson(options.output, { schemaVersion: 1, status: 'stopped_snapshot_fingerprint',
      profileSha256: sha(profileBytes), rawChainSha256: sha(chainBytes), tableHashes: evidence.tableHashes,
      counts: evidence.counts, originalColumns: evidence.columns, cysts: evidence.cysts, transactionsSent: 0 });
  } else {
    phase = 'clone_config';
    ensure(options.cloneRoot === join(options.work, 'clone') && options.backup?.startsWith(options.work + '/'), 'clone_paths');
    ensure(/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/telomere_rollout$/.test(options.databaseUrl ?? ''), 'clone_db');
    const dbUrl = new URL(options.databaseUrl), rpc = new URL(options.rpcUrl);
    ensure(dbUrl.port !== '15434' && rpc.hostname === '127.0.0.1' && rpc.port !== '18547' && rpc.protocol === 'http:', 'clone_isolation');
    ensure(options.port && ![13280, 15434, 18547, Number(dbUrl.port), Number(rpc.port)].includes(options.port), 'clone_port');
    ensure(options.dockerHost === 'unix://' + join(options.work, 'clone', 'run', 'docker.sock') && /^sha256:[a-f0-9]{64}$/.test(options.cpuImage ?? ''), 'clone_docker');
    const cloneEnv = { ...env, DATABASE_URL: options.databaseUrl, RPC_URL: options.rpcUrl, CYSTS_DIR: join(options.cloneRoot, '.local', 'cysts'),
      DATA_DIR: join(options.cloneRoot, 'controller-data'), HOST: '127.0.0.1', PORT: String(options.port),
      PUBLIC_ORIGIN: 'http://127.0.0.1:' + options.port, CPU_IMAGE: options.cpuImage, LOG_LEVEL: 'error' };
    for (const key of Object.keys(cloneEnv)) if (key.startsWith('NEAR_') || OPTIONAL.includes(key)) delete cloneEnv[key];
    cloneEnv.PAID_CYST_INPUTS_ENABLED = 'false'; cloneEnv.SELECTION_ENABLED = 'false';
    process.env.DOCKER_HOST = options.dockerHost;
    // Old and latest main both inherit this dedicated socket, including orphan cleanup.
    ensure(process.env.DOCKER_HOST !== 'unix:///var/run/docker.sock', 'global_docker_forbidden');
    const target = options.source === 'old' ? OLD : options.release;
    process.chdir(target);
    const targetConfig = (await moduleAt(target, 'dist/src/config.js')).loadConfig(cloneEnv);
    ensure(targetConfig.MODE === 'demo' && targetConfig.CHAIN_ID === 31337 && targetConfig.DATABASE_URL === options.databaseUrl
      && targetConfig.RPC_URL === options.rpcUrl && targetConfig.CYSTS_DIR.startsWith(options.cloneRoot + '/'), 'target_config');
    const { Client } = require('pg'), client = new Client({ connectionString: options.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    let pilot, before, after, canonicalAnchor;
    await client.connect();
    try {
      const baseline = JSON.parse((await bounded(options.baseline, 65536)).toString('utf8'));
      before = await dbEvidence(client, targetConfig.CYSTS_DIR, false, baseline.originalColumns);
      ensure(canonical(before.tableHashes) === canonical(baseline.tableHashes) && canonical(before.cysts) === canonical(baseline.cysts), 'clone_not_original_snapshot');
      const { ChainBridge } = await moduleAt(options.release, 'dist/src/bridge.js');
      const { escrowAbi, tokenAbi } = await moduleAt(options.release, 'dist/src/chain/abi.js');
      const { parseEventLogs, keccak256 } = require('viem');
      const { signedReceiptSchema, receiptSettlement } = await moduleAt(options.release, 'dist/src/service.js');
      const chain = new ChainBridge(loadConfig(cloneEnv)); await chain.check();
      const chainState = async () => {
        const block = await chain.public.getBlock({ blockTag: 'latest' });
        const owners = [...new Set([chain.account.address.toLowerCase(), ...before.jobs.map(row => row.owner.toLowerCase())])].sort();
        const accounts = [];
        for (const address of owners) accounts.push({ address,
          native: await chain.public.getBalance({ address, blockNumber: block.number }),
          nonce: await chain.public.getTransactionCount({ address, blockNumber: block.number }),
          pendingNonce: await chain.public.getTransactionCount({ address, blockTag: 'pending' }),
          token: await chain.public.readContract({ address: targetConfig.TOKEN_ADDRESS, abi: tokenAbi, functionName: 'balanceOf', args: [address], blockNumber: block.number }),
          available: await chain.public.readContract({ address: targetConfig.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'availableBalance', args: [address], blockNumber: block.number }) });
        const runs = [], leashes = [];
        for (const row of before.jobs) runs.push(await chain.public.readContract({ address: targetConfig.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'getRun', args: [row.id], blockNumber: block.number }));
        for (const id of [...new Set(before.jobs.map(row => row.leash_id))].sort()) leashes.push(await chain.public.readContract({ address: targetConfig.ESCROW_ADDRESS, abi: escrowAbi, functionName: 'getLeash', args: [id], blockNumber: block.number }));
        const code = [];
        for (const address of [targetConfig.ESCROW_ADDRESS, targetConfig.TOKEN_ADDRESS]) code.push(keccak256(await chain.public.getCode({ address, blockNumber: block.number })));
        ensure((await chain.public.getBlock({ blockNumber: block.number })).hash === block.hash, 'anchor_replaced');
        return { number: block.number.toString(), hash: block.hash, stateRoot: block.stateRoot,
          stateSha256: sha(canonical({ accounts, runs, leashes, code })) };
      };
      const originalAnchor = await chainState();
      phase = options.source + '_start';
      pilot = await (await moduleAt(target, 'dist/src/main.js')).startPilot(targetConfig);
      const health = await fetch('http://127.0.0.1:' + options.port + '/health/ready', { signal: AbortSignal.timeout(5000) });
      ensure(health.status === 200 && (await health.json()).status === 'ready', 'clone_not_ready');
      phase = options.source + '_five_receipts';
      for (const row of before.jobs) {
        const receipt = signedReceiptSchema.parse(row.receipt), settlement = receiptSettlement(receipt);
        ensure(receipt.settlement.runId === row.id && receipt.body.runId === row.id
          && receipt.body.billing.ceiling === row.ceiling && receipt.body.billing.charged === row.charged
          && receipt.body.billing.refund === row.refund && receipt.settlement.billableSeconds === String(row.billable_seconds), 'receipt_row_binding');
        const proof = await pilot.service.verifyReceipt(receipt);
        ensure(proof.valid && proof.anchored, 'receipt_invalid');
        const mined = await chain.public.getTransactionReceipt({ hash: row.settlement_tx_hash });
        const block = await chain.public.getBlock({ blockNumber: mined.blockNumber });
        ensure(mined.status === 'success' && block.hash === mined.blockHash && BigInt(row.charged) + BigInt(row.refund) === BigInt(row.ceiling), 'settlement_invalid');
        const logs = parseEventLogs({ abi: escrowAbi, eventName: 'RunSettled', logs: mined.logs.filter(log => log.address.toLowerCase() === targetConfig.ESCROW_ADDRESS.toLowerCase()) });
        ensure(logs.length === 1 && logs[0].args.runId === row.id && logs[0].args.receiptHash === receipt.receiptHash
          && logs[0].args.billableSeconds === settlement.billableSeconds && logs[0].args.inferenceCharge === settlement.inferenceCharge
          && logs[0].args.amount.toString() === row.charged && logs[0].args.returnedAmount.toString() === row.refund, 'settlement_event_binding');
        const journal = (await client.query('SELECT hash,nonce FROM transaction_journal WHERE run_id=$1 LIMIT 2', [row.id])).rows;
        const transaction = await chain.public.getTransaction({ hash: row.settlement_tx_hash });
        ensure(journal.length === 1 && journal[0].hash === row.settlement_tx_hash && journal[0].nonce !== null
          && transaction.nonce === Number(journal[0].nonce) && transaction.from.toLowerCase() === chain.account.address.toLowerCase()
          && transaction.to?.toLowerCase() === targetConfig.ESCROW_ADDRESS.toLowerCase()
          && await chain.public.getTransactionCount({ address: chain.account.address, blockTag: 'latest' }) > Number(journal[0].nonce), 'journal_binding');
      }
      if (options.source === 'latest') {
        phase = 'owned_cpu_executor';
        const { createDockerCpuExecutor } = await moduleAt(options.release, 'dist/src/runtime/index.js');
        const result = await createDockerCpuExecutor({ image: options.cpuImage }).run({ runId: 'rollout-clone-' + sha(options.work).slice(0, 20),
          task: { kind: 'sha256', text: 'private-staging-rollout' }, maxSeconds: 10 }, AbortSignal.timeout(15000));
        ensure(result.status === 'completed' && result.exitCode === 0 && result.output.includes(sha('private-staging-rollout')), 'owned_cpu_failed');
      }
      phase = options.source + '_close'; await pilot.close(); pilot = undefined;
      canonicalAnchor = await chainState();
      ensure(canonical(originalAnchor) === canonical(canonicalAnchor), 'startup_or_close_changed_chain');
      after = await dbEvidence(client, targetConfig.CYSTS_DIR, false, baseline.originalColumns);
      ensure(canonical(before.tableHashes) === canonical(after.tableHashes), 'old_records_changed');
      await privateJson(options.output, { schemaVersion: 1, status: 'passed', source: options.source, fiveReceiptsVerified: 5,
        cysts: after.cysts, originalTableHashes: after.tableHashes, migratedTables: after.tables, canonicalAnchor,
        columns: after.actualColumns, originalColumns: after.columns, originalCanonicalAnchor: originalAnchor,
        controllerStarted: true, controllerClosed: true, isolatedDocker: true, cpuExecutorOnly: options.source === 'latest',
        noNewPaidRun: true, transactionsSent: 0, publicProviderCalls: 0 });
    } finally { await pilot?.close().catch(() => undefined); await client.end(); }
  }
  process.stdout.write(JSON.stringify({ status: 'passed', phase: action }) + '\n');
} catch {
  process.stderr.write(JSON.stringify({ status: 'failed', phase, detail: 'Private rollout check failed; inspect private owned artifacts without disclosing profile or child output.' }) + '\n');
  process.exitCode = 1;
}
