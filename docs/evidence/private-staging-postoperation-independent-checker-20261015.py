CHECKER_SOURCES = {'status': {'source': "import datetime, json, pathlib, subprocess, urllib.request\r\nwork = pathlib.Path('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch04')\r\noperator = pathlib.Path('/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt04')\r\nresult = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}\r\nresult['snapshotCaptureDirectoryPresent'] = (work / '.local/snapshot').exists()\r\ndef command(args): return subprocess.check_output(args, text=True, timeout=15).strip()\r\nif (work / 'state.json').exists():\r\n    state = json.loads((work / 'state.json').read_bytes())\r\n    result['state'] = {key: state[key] for key in ['stage', 'revision', 'archiveSha256', 'release',\r\n        'preparedAt', 'snapshotMaintenanceSeconds', 'cloneAcceptedAt', 'activatedAt', 'maintenanceSeconds',\r\n        'latestReportSha256', 'oldReportSha256', 'cleanupSha256', 'controllerDropinSha256'] if key in state}\r\nelse: result['state'] = None\r\nfor name in ['clone-cleanup.json', 'global-docker-inventory.json']:\r\n    path = work / name\r\n    if path.exists():\r\n        value = json.loads(path.read_bytes())\r\n        result[name] = value if name == 'clone-cleanup.json' else {'unchanged': value.get('unchanged')}\r\nfor phase in ['prepare', 'snapshot', 'validate-clone', 'cutover']:\r\n    unit = 'telomere-private-staging-354fe7af62ea-launch04-' + phase + '.service'\r\n    result[phase] = command(['systemctl', 'show', unit, '--property=ActiveState', '--property=SubState', '--property=Result', '--property=LoadState', '--property=ExecMainStatus', '--property=MainPID'])\r\n    path = operator / (phase + '.private.log')\r\n    if path.exists():\r\n        lines = path.read_bytes()[-65536:].decode(errors='replace').splitlines()\r\n        records = []\r\n        for line in lines:\r\n            try:\r\n                value = json.loads(line)\r\n                if isinstance(value, dict) and value.get('status') in ['passed', 'failed'] and isinstance(value.get('phase'), str):\r\n                    records.append({key: value[key] for key in ['status', 'phase', 'detail', 'reason'] if key in value})\r\n            except (ValueError, TypeError): pass\r\n        if records:\r\n            result[phase + 'Records'] = records[-8:]\r\n            primary = [value for value in records if value['phase'] not in ['recover-held', 'recover_held']]\r\n            if primary: result[phase + 'Status'] = primary[-1]\r\nresult['services'] = {unit: command(['systemctl', 'show', unit, '--property=ActiveState', '--property=NRestarts', '--property=MainPID', '--property=WorkingDirectory'])\r\n    for unit in ['telomere-staging.service', 'telomere-staging-chain.service', 'telomere-staging-watchdog.service']}\r\nresult['health'] = {}\r\nfor kind in ['live', 'ready']:\r\n    try:\r\n        with urllib.request.urlopen('http://127.0.0.1:13280/health/' + kind, timeout=5) as response:\r\n            result['health'][kind] = {'code': response.status, 'body': json.load(response)}\r\n    except Exception as error: result['health'][kind] = {'errorType': type(error).__name__}\r\nprint(json.dumps(result, separators=(',', ':')))\r\n", 'sha256': '202dba65bababddd27c254102695700869edcdda5a1743340ef4897b32934326'}, 'runtime': {'source': '"""Read-only final check. Run on the VPS only after actual attempt04 activation."""\nimport datetime, grp, hashlib, json, pathlib, stat, subprocess, urllib.request\n\nREV = \'354fe7af62ea6701faafc3b04522abb1b4524d2d\'\nSHA = \'86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce\'\nRUN = \'staging-354fe7af62ea-launch04\'\nBASE = pathlib.Path(\'/opt/telomere-pilot\')\nwork = BASE / \'rollout\' / RUN\noperator = pathlib.Path(\'/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt04\')\nNODE = \'/opt/node-v22.23.3-linux-x64/bin/node\'\nunits = [\'telomere-staging.service\', \'telomere-staging-chain.service\', \'telomere-staging-watchdog.service\']\n\ndef checksum(path): return hashlib.sha256(path.read_bytes()).hexdigest()\ndef obj(path): return json.loads(path.read_bytes())\ndef command(args): return subprocess.check_output(args, text=True, timeout=20).strip()\ndef unit(name):\n    raw = command([\'systemctl\', \'show\', name, \'--property=ActiveState\', \'--property=SubState\',\n        \'--property=LoadState\', \'--property=MainPID\', \'--property=NRestarts\', \'--property=WorkingDirectory\'])\n    return dict(line.split(\'=\', 1) for line in raw.splitlines() if \'=\' in line)\n\nstate = obj(work / \'state.json\')\nassert state[\'stage\'] == \'activated\' and state[\'run\'] == RUN\nassert state[\'heldStop\'][\'active\'] is False and state[\'heldStop\'][\'phase\'] == \'activated\'\nassert state[\'revision\'] == REV and state[\'archiveSha256\'] == SHA\nrelease = pathlib.Path(state[\'release\'])\nassert release == BASE / \'releases\' / (REV + \'-launch04\') and release.resolve() == release\nmanifest = obj(operator / \'telomere-selection-composed-20261015.tar.gz.manifest.json\')\nassert manifest[\'gitRevision\'] == REV and manifest[\'archiveSha256\'] == SHA and len(manifest[\'files\']) == 685\nassert checksum(work / \'clone-smoke.mjs\') == state[\'nodeHelperSha256\']\nassert checksum(operator / \'rollout.py\') == state[\'runnerSha256\']\nassert checksum(work / \'source-manifest.json\') == state[\'sourceManifestSha256\']\nassert checksum(work / \'release-pins.json\') == state[\'releasePinsSha256\']\npins = obj(work / \'release-pins.json\')\nassert pins[\'source\'] == {row[\'path\']: {\'bytes\': row[\'bytes\'], \'sha256\': row[\'sha256\']} for row in manifest[\'files\']}\ngroup = grp.getgrnam(\'telomere\').gr_gid\nbad = []\nfor row in manifest[\'files\']:\n    name = pathlib.PurePosixPath(row[\'path\'])\n    assert not name.is_absolute() and \'..\' not in name.parts\n    path = release / str(name)\n    meta = path.lstat()\n    if not (stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_gid == group\n        and stat.S_IMODE(meta.st_mode) in (0o640, 0o750)\n        and meta.st_size == row[\'bytes\'] and checksum(path) == row[\'sha256\']): bad.append(row[\'path\'])\nassert not bad\nruntime_paths = {path.relative_to(release).as_posix() for path in (release / \'dist\').rglob(\'*\') if path.is_file()}\nassert runtime_paths == set(pins[\'runtime\']) and \'dist/src/main.js\' in runtime_paths\nfor name, value in pins[\'runtime\'].items():\n    path = release / name\n    assert pathlib.PurePosixPath(name).parts[0] == \'dist\' and \'..\' not in pathlib.PurePosixPath(name).parts\n    meta = path.lstat()\n    assert stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and meta.st_gid == group\n    assert stat.S_IMODE(meta.st_mode) in (0o640, 0o750)\n    assert meta.st_size == value[\'bytes\'] and checksum(path) == value[\'sha256\']\nassert all((release / parent).stat().st_uid == 0 for parent in [\'\', \'dist\', \'node_modules\'])\nbefore = {name: unit(name) for name in units}\nassert all(value[\'ActiveState\'] == \'active\' and value[\'SubState\'] == \'running\'\n    and value[\'NRestarts\'] == state[\'originalUnitStates\'][name][\'NRestarts\']\n    and int(value[\'MainPID\']) > 0 for name, value in before.items())\nassert before[units[0]][\'WorkingDirectory\'] == str(release)\nassert before[units[1]][\'WorkingDirectory\'] == str(BASE / \'app\')\nassert before[units[2]][\'WorkingDirectory\'] == str(BASE / \'watchdog-app\')\npid = before[units[0]][\'MainPID\']\nproc = pathlib.Path(\'/proc\') / pid\ncmdline = proc.joinpath(\'cmdline\').read_bytes().rstrip(b\'\\0\').split(b\'\\0\')\nidentity = {\'executableMatches\': str(proc.joinpath(\'exe\').resolve()) == NODE,\n    \'cwdMatches\': proc.joinpath(\'cwd\').resolve() == release,\n    \'argvMatches\': cmdline == [NODE.encode(), str(release / \'dist/src/main.js\').encode()]}\nassert all(identity.values())\ndropin = pathlib.Path(state[\'controllerDropin\'])\nassert dropin == pathlib.Path(\'/etc/systemd/system/telomere-staging.service.d/90-telomere-reviewed-release.conf\')\nassert not dropin.is_symlink() and checksum(dropin) == state[\'controllerDropinSha256\']\nhealth = {}\nfor name in [\'live\', \'ready\']:\n    with urllib.request.urlopen(\'http://127.0.0.1:13280/health/\' + name, timeout=5) as response:\n        value = json.load(response)\n        assert response.status == 200 and value[\'status\'] == (\'ok\' if name == \'live\' else \'ready\')\n        health[name] = {\'code\': response.status, \'status\': value[\'status\']}\nafter = {name: unit(name) for name in units}\nassert before == after\nfor name in [RUN, \'staging-354fe7af62ea-final04\']:\n    namespace = \'tlmr-roll-\' + hashlib.sha256(name.encode()).hexdigest()[:12]\n    assert not pathlib.Path(\'/run/netns\', namespace).exists()\n    assert not command([\'/usr/bin/docker\', \'--host\', \'unix:///var/run/docker.sock\', \'ps\', \'--all\',\n        \'--filter\', \'label=telomere.rollout.owner=\' + name, \'--quiet\'])\n    for service in [\'telomere-\' + namespace + \'.service\',\n        \'telomere-\' + name + \'-latest.service\', \'telomere-\' + name + \'-old.service\']:\n        value = unit(service)\n        assert value[\'ActiveState\'] in [\'inactive\', \'failed\'] and value[\'MainPID\'] in [\'0\', \'\']\nresult = {\'schemaVersion\': 1, \'kind\': \'readonly_actual_private_staging_runtime_identity\',\n    \'checkedAt\': datetime.datetime.now(datetime.timezone.utc).isoformat(), \'status\': \'passed\',\n    \'run\': RUN, \'revision\': REV, \'archiveSha256\': SHA, \'sourceFilesVerified\': len(manifest[\'files\']),\n    \'allSourceBytesAndRootOwnershipVerified\': True, \'runtimeFilesVerified\': len(runtime_paths),\n    \'allGeneratedRuntimeBytesAndRootOwnershipVerified\': True, \'controllerProcess\': identity,\n    \'controllerDropinHashVerified\': True, \'threeUnitsActiveAndStable\': True,\n    \'unitRestartsUnchanged\': True, \'source\': str(release), \'health\': health,\n    \'ownedRehearsalAndFinalCloneContainersNamespacesUnitsRemaining\': 0,\n    \'resourceObservationScope\': \'exact owner-labelled global containers, netns and helper/daemon units; no independent Anvil process scan\',\n    \'profileOrEnvironmentRead\': False,\n    \'transactionsSent\': 0, \'paidRequests\': 0}\nprint(json.dumps(result, separators=(\',\', \':\')))\n', 'sha256': 'a44c122c0ae34a7afb781b4e24c81705e23b2dfb4b4533c95761a0cab6ba94de'}, 'original-data': {'source': '// Operator-only, ignored local runner. Upload/review before use; no automatic execution.\n// Never logs the protected profile, DB URLs, receipt bodies, or retained transactions.\nimport { createHash } from \'node:crypto\';\nimport { createRequire } from \'node:module\';\nimport { readFile, writeFile, lstat, readdir } from \'node:fs/promises\';\nimport { join, resolve } from \'node:path\';\nimport { pathToFileURL } from \'node:url\';\n\nconst sha = value => createHash(\'sha256\').update(value).digest(\'hex\');\nconst canonical = value => JSON.stringify(value, (_key, item) => typeof item === \'bigint\' ? item.toString() : item);\nconst OLD = \'/opt/telomere-pilot/app\';\nconst TABLES = [\'auth_nonces\', \'auth_sessions\', \'cyst_owners\', \'cysts\', \'jobs\', \'leash_refs\', \'transaction_journal\'];\nconst OPTIONAL = [\'PLATFORM_RUNTIME_CONFIG\', \'CYST_REGISTRY_CONFIG\', \'CYSTS_REPLICATION_CONFIG\', \'CYSTS_LARGE_DIR\',\n  \'CYSTS_LARGE_REPLICATION_CONFIG\', \'CYSTS_QUOTA_POLICY_PATH\', \'INCOME_ENDPOINTS_CONFIG\', \'VAULT_INCOME_CONFIG\',\n  \'TREASURY_TOPUP_CONFIG\', \'AKASH_READINESS_CONFIG\', \'REPUTATION_PUBLISHER_CONFIG\'];\nlet phase = \'arguments\';\n\nfunction ensure(test, code) { if (!test) throw new Error(code); }\nasync function privateJson(path, value) {\n  await writeFile(path, canonical(value) + \'\\n\', { flag: \'wx\', mode: 0o600 });\n}\nasync function bounded(path, max = 16777216) {\n  const meta = await lstat(path);\n  ensure(meta.isFile() && !meta.isSymbolicLink() && meta.nlink === 1 && meta.size <= max, \'invalid_private_input\');\n  return await readFile(path);\n}\nasync function moduleAt(root, path) { return await import(pathToFileURL(join(root, path)).href); }\n\nasync function dbEvidence(client, cystDirectory, expectedTables, originalColumns) {\n  await client.query("SET TIME ZONE \'UTC\'");\n  await client.query(\'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY\');\n  try {\n    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname=\'public\' ORDER BY tablename")).rows.map(row => row.tablename);\n    if (expectedTables) ensure(canonical(tables) === canonical(TABLES), \'unexpected_legacy_tables\');\n    const schemaRows = (await client.query(`SELECT table_name,column_name,udt_name FROM information_schema.columns\n      WHERE table_schema=\'public\' ORDER BY table_name,ordinal_position`)).rows;\n    const columns = {};\n    for (const table of TABLES) columns[table] = schemaRows.filter(row => row.table_name === table).map(row => ({ name: row.column_name, type: row.udt_name }));\n    const projected = originalColumns ?? columns;\n    const hashes = {}, counts = {};\n    for (const name of TABLES) {\n      // Identifiers are only from the closed TABLES constant. No values leave this process.\n      const expected = projected[name];\n      ensure(Array.isArray(expected) && expected.length > 0 && expected.length <= 64, \'original_column_projection\');\n      for (const column of expected) ensure(/^[a-z_][a-z0-9_]*$/.test(column.name)\n        && columns[name].some(actual => actual.name === column.name && actual.type === column.type), \'original_column_changed\');\n      const extras = columns[name].filter(actual => !expected.some(column => column.name === actual.name));\n      ensure(extras.every(column => (name === \'jobs\' && column.name === \'agent_address\' && column.type === \'text\')\n        || (name === \'transaction_journal\' && column.name === \'nonce\' && [\'int4\', \'int8\'].includes(column.type))), \'unreviewed_additive_column\');\n      const fields = expected.map(column => `\'${column.name}\',t."${column.name}"`).join(\',\');\n      const rows = (await client.query(`SELECT jsonb_build_object(${fields})::text AS row FROM ${name} t ORDER BY jsonb_build_object(${fields})::text LIMIT 10001`)).rows;\n      ensure(rows.length <= 10000, \'table_bound\');\n      const text = rows.map(row => row.row).join(\'\\n\');\n      ensure(Buffer.byteLength(text) <= 16777216, \'table_byte_bound\');\n      hashes[name] = sha(text); counts[name] = rows.length;\n    }\n    const jobs = (await client.query(\'SELECT id,owner,leash_id,status,receipt,settlement_tx_hash,ceiling,charged,refund,billable_seconds FROM jobs ORDER BY id LIMIT 6\')).rows;\n    ensure(jobs.length === 5 && jobs.every(row => row.status === \'completed\' && row.receipt && row.settlement_tx_hash), \'five_completed_required\');\n    const records = (await client.query(\'SELECT owner,id,sha256,ciphertext_bytes,state FROM cysts ORDER BY owner,id LIMIT 2\')).rows;\n    ensure(records.length === 1 && records[0].state === \'ready\' && records[0].ciphertext_bytes === 93, \'original_cyst_required\');\n    const names = await readdir(cystDirectory);\n    ensure(names.length === 1 && /^[a-f0-9]{64}\\.blob$/.test(names[0]), \'unexpected_cyst_files\');\n    const record = records[0];\n    const name = sha(\'telomere-cyst-blob:\' + record.owner + \':\' + record.sha256) + \'.blob\';\n    ensure(names[0] === name, \'cyst_name\');\n    const file = join(cystDirectory, name), meta = await lstat(file), bytes = await bounded(file, 2097168);\n    ensure((meta.mode & 0o077) === 0 && bytes.length === record.ciphertext_bytes && sha(bytes) === record.sha256, \'cyst_integrity\');\n    const usage = (await client.query(`SELECT count(*)::integer AS mismatches FROM cyst_owners o WHERE\n      o.checkpoints <> (SELECT count(*) FROM cysts c WHERE c.owner=o.owner) OR\n      o.used_bytes <> (SELECT coalesce(sum(ciphertext_bytes),0) FROM cysts c WHERE c.owner=o.owner)`)).rows[0];\n    ensure(usage.mismatches === 0, \'cyst_counter_mismatch\');\n    await client.query(\'ROLLBACK\');\n    return { tableHashes: hashes, counts, columns: projected, actualColumns: columns, jobs,\n      cysts: { count: 1, bytes: 93, blobSha256: record.sha256, metadataSha256: hashes.cysts, counterMismatches: 0 }, tables };\n  } catch (error) { await client.query(\'ROLLBACK\').catch(() => undefined); throw error; }\n}\n\n\n// Exact read-only dbEvidence and support functions above are from frozen helper43d37c51.\n// This separate audit imports no main entry point and opens a read-only DB transaction.\ntry {\n  const work = \'/opt/telomere-pilot/rollout/staging-354fe7af62ea-final04\';\n  const release = \'/opt/telomere-pilot/releases/354fe7af62ea6701faafc3b04522abb1b4524d2d-launch04\';\n  const parent = JSON.parse((await bounded(\'/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch04/state.json\', 1048576)).toString());\n  ensure(parent.run === \'staging-354fe7af62ea-launch04\' && parent.stage === \'activated\'\n    && parent.revision === \'354fe7af62ea6701faafc3b04522abb1b4524d2d\'\n    && parent.archiveSha256 === \'86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce\'\n    && parent.finalWork === work && parent.release === release && parent.heldStop?.active === false,\n    \'actual_parent_not_activated\');\n  const childBytes = await bounded(join(work, \'state.json\'), 1048576);\n  ensure(sha(childBytes) === parent.finalStateSha256, \'final_child_state_changed\');\n  const child = JSON.parse(childBytes.toString());\n  ensure(child.run === \'staging-354fe7af62ea-final04\' && child.parentRun === parent.run\n    && child.stage === \'clone_accepted\' && child.release === release\n    && child.revision === parent.revision && child.archiveSha256 === parent.archiveSha256,\n    \'final_child_identity_changed\');\n  const preactivationBytes = await bounded(join(work, \'preactivation-fingerprint.json\'), 65536);\n  ensure(sha(preactivationBytes) === parent.finalFreshFingerprintSha256, \'final_fingerprint_changed\');\n  const baseline = JSON.parse((await bounded(join(work, \'snapshot-fingerprint.json\'), 65536)).toString());\n  ensure(canonical(baseline) === canonical(JSON.parse(preactivationBytes.toString())), \'fresh_fingerprint_binding_changed\');\n  const acceptedBytes = await bounded(join(work, \'clone/latest-acceptance.json\'), 65536);\n  ensure(sha(acceptedBytes) === child.latestReportSha256, \'final_clone_report_changed\');\n  const accepted = JSON.parse(acceptedBytes.toString());\n  ensure(accepted.status === \'passed\' && accepted.source === \'latest\', \'final_clone_not_accepted\');\n  const profileBytes = await bounded(\'/opt/telomere-pilot/config/staging.env\', 65536);\n  ensure(sha(profileBytes) === baseline.profileSha256, \'profile_changed_after_activation\');\n  const { parseProfile } = await moduleAt(release, \'dist/src/operator/profile.js\');\n  const { loadConfig } = await moduleAt(release, \'dist/src/config.js\');\n  const config = loadConfig(parseProfile(profileBytes.toString(\'utf8\')));\n  const url = new URL(config.DATABASE_URL);\n  ensure(config.MODE === \'demo\' && config.CHAIN_ID === 31337 && config.RPC_URL === \'http://127.0.0.1:18547\'\n    && config.CYSTS_DIR === \'/opt/telomere-pilot/data/cysts\' && url.hostname === \'127.0.0.1\'\n    && url.port === \'15434\' && url.pathname === \'/telomere\', \'unexpected_original_profile\');\n  const require = createRequire(join(release, \'package.json\'));\n  const { Client } = require(\'pg\');\n  const client = new Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 5000 });\n  let evidence;\n  try {\n    await client.connect();\n    evidence = await dbEvidence(client, config.CYSTS_DIR, false, baseline.originalColumns);\n  } finally { await client.end(); }\n  ensure(canonical(evidence.tableHashes) === canonical(baseline.tableHashes), \'original_rows_changed_after_activation\');\n  ensure(canonical(evidence.cysts) === canonical(baseline.cysts), \'original_cyst_changed_after_activation\');\n  const rpc = async (method, params) => {\n    const response = await fetch(config.RPC_URL, { method: \'POST\', headers: { \'Content-Type\': \'application/json\' },\n      body: JSON.stringify({ jsonrpc: \'2.0\', id: 1, method, params }), signal: AbortSignal.timeout(5000) });\n    ensure(response.status === 200, \'local_rpc_failed\');\n    const value = await response.json();\n    ensure(!value.error && value.result !== undefined, \'local_rpc_error\');\n    return value.result;\n  };\n  ensure(await rpc(\'eth_chainId\', []) === \'0x7a69\', \'original_chain_id_changed\');\n  const block = await rpc(\'eth_getBlockByNumber\', [\'latest\', false]);\n  ensure(BigInt(block.number).toString() === accepted.canonicalAnchor.number\n    && block.hash === accepted.canonicalAnchor.hash && block.stateRoot === accepted.canonicalAnchor.stateRoot,\n    \'canonical_head_changed_after_activation\');\n  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: \'readonly_postactivation_original_data_and_chain\',\n    status: \'passed\', checkedAt: new Date().toISOString(),\n    exactDbEvidenceHelperSha256: \'43d37c51c7d50a1a9971b444367045a2c7e73b91239418d679460d1fb06176e5\',\n    originalTableCounts: evidence.counts, originalTableHashes: evidence.tableHashes,\n    originalSevenTablesUnchanged: true, originalColumnProjectionVerified: true,\n    currentSchemaTableCount: evidence.tables.length, cysts: evidence.cysts,\n    protectedProfileUnchanged: true, canonicalHeadMatchesHeldClone: true,\n    freshlyVerifiedCanonicalHead: { number: accepted.canonicalAnchor.number,\n      hash: block.hash, stateRoot: block.stateRoot },\n    retainedCloneStateSha256: accepted.canonicalAnchor.stateSha256, sqlReadOnlyTransaction: true,\n    credentialsOrRowContentsReturned: false, transactionsSent: 0, paidProviderRequests: 0 }) + \'\\n\');\n} catch {\n  process.stderr.write(JSON.stringify({ status: \'failed\', kind: \'readonly_postactivation_original_data_and_chain\' }) + \'\\n\');\n  process.exitCode = 1;\n}\n', 'sha256': '61bf8382fd5f5a7cfcdf7fd299a04ee62fb685223773b9952bd3e8dab62e363a'}}
EXPECTED_UPLOAD = {'rollout.py': 'f9d9b264e9b5b447894ff982239b96c4be2973fe4d94daa23a14d4ed63943d32', 'clone-smoke.mjs': '43d37c51c7d50a1a9971b444367045a2c7e73b91239418d679460d1fb06176e5', 'README.md': '5bd0e8957d30b43c7077c0dfc8834a1b3eb13dcf19b07c0f29f1cb2542731c9d', 'telomere-selection-composed-20261015.tar.gz': '86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce', 'telomere-selection-composed-20261015.tar.gz.manifest.json': 'd7f75f2be9ab97c1ea2cd438a2f053cd0f63ca73fa802574aca25a6b939ab4ab', 'gates.json': '7aa944b4473362f76163ebdf384d74cd4b44247902e38cefe6ca61f9ed32462e', 'gate-evidence.json': '8fa0a3af1e22e07399f61a7f4102630a5fa68b873cd4e7c806cdbde779c6ad17'}
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

REV = '354fe7af62ea6701faafc3b04522abb1b4524d2d'
ARCHIVE = '86b5dc9f36dcf841963f0ffa8161023c126f1fae473c94909f5dddae3040fdce'
RUN = 'staging-354fe7af62ea-launch04'
FINAL = 'staging-354fe7af62ea-final04'
BASE = Path('/opt/telomere-pilot')
OPERATOR = Path('/opt/telomere-host-runtime/private-staging-operator-20261015-354fe7af62ea-attempt04')
NODE = '/opt/node-v22.23.3-linux-x64/bin/node'

def check(value, reason):
    if not value: raise RuntimeError(reason)

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''): value.update(block)
    return value.hexdigest()

def read(path, limit=1048576):
    meta = path.lstat()
    check(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and 0 < meta.st_size <= limit, 'bounded_regular_input')
    return json.loads(path.read_bytes())

def child_check(name, invocation):
    source = CHECKER_SOURCES[name]['source'].encode()
    check(hashlib.sha256(source).hexdigest() == CHECKER_SOURCES[name]['sha256'], 'child_checker_hash')
    child = subprocess.run(invocation, input=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=65, check=False)
    check(child.returncode == 0 and not child.stderr and len(child.stdout) <= 1048576, 'safe_child_check_failed')
    return json.loads(child.stdout)

def main():
    check(sys.platform == 'linux' and os.geteuid() == 0, 'linux_root_readonly_checker')
    observed_upload = read(OPERATOR / 'upload-verified.json')
    check(observed_upload == EXPECTED_UPLOAD, 'uploaded_receipt_identity')
    for name, expected in EXPECTED_UPLOAD.items():
        check('/' not in name and name not in ['.', '..'], 'uploaded_file_scope')
        path = OPERATOR / name
        meta = path.lstat()
        check(stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and stat.S_IMODE(meta.st_mode) == 0o600
              and meta.st_nlink == 1 and digest(path) == expected, 'uploaded_file_hash_mode')
    runner_path = OPERATOR / 'rollout.py'
    source = runner_path.read_bytes()
    check(hashlib.sha256(source).hexdigest() == 'f9d9b264e9b5b447894ff982239b96c4be2973fe4d94daa23a14d4ed63943d32', 'frozen_runner')
    operator = {'__name__': 'independent_readonly_definitions', '__file__': str(runner_path)}
    exec(compile(source, str(runner_path), 'exec'), operator)
    work, parent = operator['load_state'](argparse.Namespace(run=RUN))
    check(parent['stage'] == 'activated' and parent['heldStop']['active'] is False
          and parent['heldStop']['phase'] == 'activated' and parent['revision'] == REV
          and parent['archiveSha256'] == ARCHIVE, 'activated_parent')
    parent_hash = digest(work / 'state.json')
    final_args, final_work, final_state = operator['verify_held_link'](work, parent)
    check(final_args.run == FINAL and final_work == BASE / 'rollout' / FINAL
          and parent['finalWork'] == str(final_work) and final_state['stage'] == 'clone_accepted'
          and digest(final_work / 'state.json') == parent['finalStateSha256'], 'retained_final_child')
    original_units = operator['service_state']()
    process_snapshot = lambda: {name: operator['command'](['systemctl', 'show', name,
        '--property=MainPID', '--property=ExecMainStartTimestampMonotonic', '--property=NRestarts',
        '--property=ActiveState', '--property=SubState']) for name in operator['UNITS']}
    original_processes = process_snapshot()
    dropin = Path(parent['controllerDropin'])
    check(dropin == Path('/etc/systemd/system/telomere-staging.service.d/90-telomere-reviewed-release.conf')
          and not dropin.is_symlink() and digest(dropin) == parent['controllerDropinSha256']
          and digest(dropin) == hashlib.sha256(operator['dropin_text'](parent).encode()).hexdigest(), 'exact_owned_dropin')
    check(operator['protected_identity'](dropin, parent['release']) == parent['protectedIdentity'], 'old_code_and_inherited_unit_pins')
    operator['assert_release'](work, parent)
    operator['assert_release'](final_work, final_state)
    scopes = []
    all_anchors = []
    owned_anvil_refs = 0
    cgroup_members = 0
    for name, scope_work, state in [(RUN, work, parent), (FINAL, final_work, final_state)]:
        before = read(scope_work / 'snapshot-fingerprint.json')
        cleanup = read(scope_work / 'clone-cleanup.json')
        check(set(cleanup) == {'ownedAnvilStopped', 'ownedDaemonStopped', 'ownedHelpersStopped', 'ownedNamespaceRemoved', 'ownedPostgresRemoved'}
              and all(value is True for value in cleanup.values()) and digest(scope_work / 'clone-cleanup.json') == state['cleanupSha256'], 'complete_owned_cleanup')
        inventory = read(scope_work / 'global-docker-inventory.json')
        check(inventory['unchanged'] is True and inventory['before'] == inventory['after']
              and operator['global_inventory']() == inventory['after'], 'unchanged_live_global_inventory')
        reports = []
        for variant, field in [('latest', 'latestReportSha256'), ('old', 'oldReportSha256')]:
            path = scope_work / ('clone/' + variant + '-acceptance.json')
            check(digest(path) == state[field], 'clone_report_hash')
            report = read(path)
            check(report['status'] == 'passed' and report['source'] == variant and report['fiveReceiptsVerified'] == 5
                  and report['cysts'] == before['cysts'] and report['originalTableHashes'] == before['tableHashes']
                  and report['originalColumns'] == before['originalColumns'] and report['controllerStarted'] is True
                  and report['controllerClosed'] is True and report['isolatedDocker'] is True
                  and report['cpuExecutorOnly'] is (variant == 'latest') and report['noNewPaidRun'] is True
                  and report['transactionsSent'] == 0 and report['publicProviderCalls'] == 0
                  and report['originalCanonicalAnchor'] == report['canonicalAnchor'], 'historical_clone_acceptance')
            reports.append(report)
        check(reports[0]['canonicalAnchor'] == reports[1]['canonicalAnchor'], 'same_clone_anchor')
        all_anchors.append(reports[0]['canonicalAnchor'])
        backup = Path(state['backup'])
        check(backup == scope_work / '.local/snapshot' and not backup.is_symlink(), 'exact_backup_path')
        manifest = read(backup / 'manifest.json')
        check(manifest['schemaVersion'] == 2 and manifest['servicesStopped'] is True
              and manifest['managedCellsAbsent'] is True and manifest['chainId'] == 31337
              and len(manifest['files']) == 4 and {item['name'] for item in manifest['files']}
              == {'database.dump', 'chain.json', 'profile.env', 'cysts.snapshot.json'}, 'backup_v2_closed_files')
        for item in manifest['files']:
            path = backup / item['name']; meta = path.lstat()
            check(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and meta.st_size == item['bytes']
                  and digest(path) == item['sha256'], 'opaque_backup_file_identity')
        check(digest(backup / 'chain.json') == before['rawChainSha256']
              and digest(backup / 'profile.env') == before['profileSha256'], 'backup_fingerprint_binding')
        image = read(scope_work / 'image-equivalence.json')
        check(image['result'] == 'verified_same_installed_cpu_image' and image['allPresentBlobHashesVerified'] is True
              and image['selectedLayerDiffIdsIndependentlyVerified'] is True and image['missingDescriptorsFetched'] is False
              and image['sourceBefore'] == image['sourceAfter'] == operator['cpu_image_identity'](image['sourceIndexDigest'])
              and image['loadedIdentity']['Id'] == image['configDigest']
              and image['loadedIdentity']['RootFS'] == image['sourceBefore']['RootFS']
              and digest(scope_work / 'clone/cpu-image.tar') == image['archiveSha256'], 'retained_image_equivalence')
        resources = operator['clone_resources'](scope_work, name)
        check(operator['process_start'](resources['anvilPid']) != resources['anvilStart'], 'recorded_anvil_not_alive')
        cgroups = [resources['outerCgroup'], *['/system.slice/' + unit for unit in resources['identity']['helperUnits']],
                   '/system.slice/' + resources['identity']['daemonUnit']]
        for group in cgroups:
            path = Path('/sys/fs/cgroup' + group, 'cgroup.procs')
            members = path.read_text().split() if path.exists() else []
            cgroup_members += len(members)
            check(not members, 'owned_cgroup_not_empty')
        scopes.append({'run': name, 'fiveReceiptsVerifiedByEachController': 5, 'actualCpuExecutorPassed': True,
                       'cystCount': before['cysts']['count'], 'cystBytes': before['cysts']['bytes'],
                       'cleanupAllFive': True, 'globalInventoryUnchanged': True,
                       'opaqueBackupFileHashesVerified': 4, 'snapshotFingerprintSha256': digest(scope_work / 'snapshot-fingerprint.json'),
                       'latestReportSha256': state['latestReportSha256'], 'oldReportSha256': state['oldReportSha256'],
                       'recordedAnvilGoneOrPidReused': True, 'ownedCgroupsEmptyOrAbsent': True})
    check(all_anchors[0] == all_anchors[1], 'rehearsal_and_final_anchor_equal')
    preactivation = read(final_work / 'preactivation-fingerprint.json')
    check(preactivation == read(final_work / 'snapshot-fingerprint.json')
          and digest(final_work / 'preactivation-fingerprint.json') == parent['finalFreshFingerprintSha256'], 'entire_fresh_fingerprint_equal')
    known_binary = (BASE / 'app/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil').resolve()
    exact_anvil_processes = 0
    candidates = [entry for entry in Path('/proc').iterdir() if entry.name.isdecimal()]
    check(len(candidates) <= 50000, 'proc_inventory_bound')
    for entry in candidates:
        try:
            if entry.joinpath('exe').resolve(strict=True) != known_binary: continue
            exact_anvil_processes += 1
            data = entry.joinpath('cmdline').read_bytes()
            check(len(data) <= 65536, 'anvil_argv_bound')
            if any(str(path).encode() in data for path in [work, final_work]): owned_anvil_refs += 1
        except (FileNotFoundError, ProcessLookupError, PermissionError): continue
    check(owned_anvil_refs == 0, 'owned_anvil_argument_reference')
    status = child_check('status', [sys.executable, '-B', '-'])
    check(status['state']['stage'] == 'activated' and status['cutoverStatus'] == {'status': 'passed', 'phase': 'cutover'}, 'primary_cutover_record')
    for phase in ['prepare', 'snapshot', 'validate-clone', 'cutover']:
        records = status[phase + 'Records']
        check(any(value['phase'] == phase and value['status'] == 'passed' for value in records)
              and not any(value['status'] == 'failed' for value in records), 'phase_safe_records')
    runtime = child_check('runtime', [sys.executable, '-B', '-'])
    original = child_check('original-data', [NODE, '--input-type=module', '-'])
    check(runtime['status'] == original['status'] == 'passed' and original['originalSevenTablesUnchanged'] is True
          and original['canonicalHeadMatchesHeldClone'] is True and original['currentSchemaTableCount'] == 43, 'postactivation_readonly_audits')
    check(operator['service_state']() == original_units and process_snapshot() == original_processes and digest(work / 'state.json') == parent_hash
          and digest(final_work / 'state.json') == parent['finalStateSha256']
          and operator['protected_identity'](dropin, parent['release']) == parent['protectedIdentity'], 'live_and_evidence_stable')
    print(json.dumps({'schemaVersion': 1, 'kind': 'independent_readonly_actual_postoperation_review',
        'status': 'passed', 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'parentRun': RUN, 'finalRun': FINAL, 'revision': REV, 'archiveSha256': ARCHIVE,
        'parentStateSha256': parent_hash, 'finalStateSha256': parent['finalStateSha256'],
        'parentActivatedAndHeldFalse': True, 'childHistoricalHeldIntentRetained': True,
        'primaryCutoverPassedDistinctFromRecoveryGuard': True, 'maintenanceSeconds': parent['maintenanceSeconds'],
        'uploadedSevenFileHashesAndModesVerified': True, 'oldCodeInheritedUnitPinsUnchanged': True,
        'scopes': scopes, 'entireFreshFinalFingerprintIncludingRawChainEqual': True,
        'allOwnedAnvilPidAndArgumentReferencesAbsent': True, 'exactAnvilProcessesObserved': exact_anvil_processes,
        'ownedCgroupMembers': cgroup_members, 'liveAndEvidenceStable': True,
        'runtime': runtime, 'originalDataAndChain': original,
        'readOnlyActionsOnly': True, 'protectedProfileParsedOnlyByBoundedApprovedReadOnlyDataAudit': True,
        'credentialsOrRowContentsReturned': False, 'transactionsSent': 0, 'servicesOrResourcesChanged': False}, separators=(',', ':')))

try:
    main()
except BaseException:
    print(json.dumps({'status': 'failed', 'kind': 'independent_readonly_actual_postoperation_review', 'reason': 'fixed_safe_checker_refusal'}))
    sys.exit(1)
