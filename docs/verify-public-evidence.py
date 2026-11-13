"""Verify committed evidence and historical source snapshots from a clean checkout.

Run: python -B docs/verify-evidence.py
Reads local files and the current Git commit only; never reruns acceptance.
"""
import sys
if sys.flags.optimize:
    raise RuntimeError('Evidence verification requires checked Python; remove -O/-OO and PYTHONOPTIMIZE.')

import hashlib
import json
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
tracked = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split(chr(0)))
names = sorted(name for name in tracked if name.startswith('docs/') and
               (name.startswith('docs/evidence/') or name.endswith('.json')))


def git_blobs(queries):
    """Batch current committed bytes without requiring historical Git objects."""
    assert all(not any(character in query for character in '\r\n\0') for query in queries)
    output = subprocess.check_output(['git', 'cat-file', '--batch'], cwd=root,
                                     input=('\n'.join(queries) + '\n').encode('utf-8'))
    offset = 0
    for query in queries:
        header_end = output.index(b'\n', offset)
        header = output[offset:header_end].split()
        assert len(header) == 3 and header[1] == b'blob', 'Committed file is missing: ' + query
        size = int(header[2])
        start, end = header_end + 1, header_end + 1 + size
        assert output[end:end + 1] == b'\n'
        yield memoryview(output)[start:end]
        offset = end + 1
    assert offset == len(output)


different = []
for name, committed in zip(names, git_blobs(['HEAD:' + name for name in names])):
    if committed != (root / name).read_bytes():
        different.append(name)
print(json.dumps({'checkedRawRecords': len(names), 'gitWorkingBytesDiffer': different}))
assert not different

references = 0
mismatches = []
untracked = []
archived_source_files = 0
approved_social_records = 0
handoff_document = 'docs/evidence/website-handoff-import-20261015.json'
handoff_import_commit = '9823db6fb9d2c2e70d636358c458eb96e4f2e625'
social_document = 'docs/evidence/domain-https-20261015/social-links-approved-change.json'
approved_social_sha256 = '859669b4db1c9ba2061823769cbd80e1c38fc30be0bcbf71d4245318ab5e29ce'
source_document = 'docs/evidence/legacy-mainnet-preparation-20261015/vps/vps-source-record.json'
archive_document = 'docs/evidence/public-source-archive/manifest.json'
archive_sha256 = '7e2ec7258dac5ab8ae109fb15b290e233cf0bc3b1ab31af567556d5fdec56d54'
used_archive_entries = set()


def validate_source_entry(entry):
    name, digest = entry.get('path'), entry.get('sha256')
    assert isinstance(name, str) and isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest)
    relative = pathlib.PurePosixPath(name)
    assert not relative.is_absolute() and '..' not in relative.parts and ':' not in name and '\\' not in name
    assert name and not any(character in name for character in '\r\n\0')
    assert type(entry.get('bytes')) is int and entry['bytes'] >= 0
    return name, digest


def load_public_archive():
    """Pin the index and retain every original source size and hash constraint."""
    global references
    assert archive_document in tracked, 'Public source archive manifest is not tracked'
    raw = (root / archive_document).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == archive_sha256, 'Public source archive manifest changed'
    references += 1
    manifest = json.loads(raw)
    assert manifest.get('schemaVersion') == 1
    records = manifest.get('records')
    assert isinstance(records, list) and len(records) == 2
    index, objects = {}, set()
    for record in records:
        document, commit = record.get('document'), record.get('sourceCommit')
        assert document in (source_document, handoff_document)
        assert isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit)
        key = (document, commit)
        assert key not in index
        entries = record.get('files')
        assert isinstance(entries, list) and 0 < len(entries) <= 4096
        indexed = {}
        for entry in entries:
            name, digest = validate_source_entry(entry)
            assert name not in indexed
            storage, stored = entry.get('storage'), entry.get('storedPath')
            if storage == 'working-tree':
                assert stored == name
            else:
                assert storage == 'object'
                assert stored == 'docs/evidence/public-source-archive/objects/' + digest + '.bin'
                objects.add(stored)
            assert stored in tracked, 'Archived source bytes are not tracked: ' + stored
            assert (root / stored).resolve().is_relative_to(root)
            indexed[name] = entry
        index[key] = indexed
    assert {document for document, _ in index} == {source_document, handoff_document}
    actual_objects = {path.relative_to(root).as_posix()
                      for path in (root / archive_document).parent.joinpath('objects').glob('*.bin')}
    assert actual_objects == objects, 'Public archive object set differs from the index'
    return index


public_archive = load_public_archive()


def verify_archive_file(entry, document, commit):
    global references, archived_source_files
    name, digest = validate_source_entry(entry)
    assert (document, commit) in public_archive, 'Historical source record is not indexed'
    stored = public_archive[(document, commit)].get(name)
    assert stored is not None, 'Historical source path is not indexed: ' + name
    assert stored['bytes'] == entry['bytes'] and stored['sha256'] == digest, 'Archive index differs from original source evidence'
    references += 1
    archived_source_files += 1
    used_archive_entries.add((document, commit, name))
    target = root / stored['storedPath']
    if not target.is_file() or target.stat().st_size != entry['bytes'] or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        mismatches.append({'document': document, 'reference': name, 'sourceCommit': commit,
                           'storedPath': stored['storedPath']})


def verify_approved_social_change(value):
    """Only the explicitly approved two-link edit supersedes the imported site.js."""
    global references, approved_social_records
    assert value.get('schemaVersion') == 1 and value.get('file') == 'website/dist/site.js'
    assert value.get('originalImportRecord') == handoff_document
    assert value.get('originalImportCommit') == handoff_import_commit
    assert value.get('sourceZipFileBytesMatchedBeforeEdit') is True
    assert value.get('originalSha256') == '9e8eb19cf38c72cccdd3765e9b498b9924cb851d5c4b222cfca00e64c0c434e6'
    assert value.get('updatedSha256') == approved_social_sha256
    assert value.get('telegram') == 'https://t.me/telomereonchain'
    assert value.get('x') == 'https://x.com/telomere_base?s=11'
    assert value.get('htmlOrCssModified') is False
    entries = value.get('files')
    assert entries == [{'path': 'website/dist/site.js', 'bytes': 44283, 'sha256': approved_social_sha256}]
    references += 1
    if 'website/dist/site.js' not in tracked:
        untracked.append({'document': social_document, 'reference': 'website/dist/site.js'})
    actual = (root / 'docs/evidence/public-wallet-launch-20261017/previous-social-site.bin').read_bytes()
    if len(actual) != 44283 or hashlib.sha256(actual).hexdigest() != approved_social_sha256:
        mismatches.append({'document': social_document, 'reference': 'website/dist/site.js'})
    approved_social_records += 1


def verify_original_handoff_site(entry, document):
    """Keep the original bytes and require the independently pinned current edit."""
    assert document == handoff_document and entry.get('path') == 'dist/site.js'
    key = (document, handoff_import_commit)
    assert key in public_archive and {'website/dist/site.js', 'website/README.md'} <= set(public_archive[key])
    verify_archive_file(dict(entry, path='website/dist/site.js'), document, handoff_import_commit)
    approval = json.loads((root / social_document).read_bytes())
    verify_approved_social_change(approval)


def verify_archived_source(value, document):
    """Verify recorded release bytes without importing its former Git history."""
    commit, entries = value.get('commit'), value.get('sourceFiles')
    assert isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit)
    assert isinstance(entries, list) and 0 < len(entries) <= 4096
    assert (document, commit) in public_archive
    seen = set()
    for entry in entries:
        name, _ = validate_source_entry(entry)
        assert name not in seen
        seen.add(name)
        verify_archive_file(entry, document, commit)
    assert seen == set(public_archive[(document, commit)]), 'Archive index has extra source paths'


def walk(value, document):
    global references
    if isinstance(value, dict):
        name, digest = value.get('path'), value.get('sha256')
        target = None
        if isinstance(name, str) and isinstance(digest, str):
            relative = pathlib.PurePosixPath(name)
            if document == handoff_document:
                assert not relative.is_absolute() and '..' not in relative.parts and ':' not in name and '\\' not in name
                if name == 'dist/site.js':
                    verify_original_handoff_site(value, document)
                elif name == 'README.md':
                    verify_archive_file(dict(value, path='website/README.md'), document, handoff_import_commit)
                elif name == 'dist/dashboard.js':
                    verify_archive_file(dict(value, path='website/' + name), source_document, 'ee6169d1007b11f037fbc409dc1f7575f15117c9')
                elif 'website/' + name in public_archive[(document, handoff_import_commit)]:
                    verify_archive_file(dict(value, path='website/' + name), document, handoff_import_commit)
                else:
                    target = root / 'website' / relative
            elif name.startswith(('docs/', 'ops/legacy-mainnet/')):
                assert not relative.is_absolute() and '..' not in relative.parts and ':' not in name and '\\' not in name
                target = root / name
            elif document.startswith('docs/evidence/') and (
                pathlib.PurePosixPath(document).name == 'source-record.json'
                or document in ('docs/evidence/golem-protocol-upstream-20261015/manifest.json',
                                'docs/evidence/golem-allocation-upstream-20261015/manifest.json')
            ):
                assert not relative.is_absolute() and '..' not in relative.parts and ':' not in name and '\\' not in name
                target = (root / document).parent / relative
        if target is not None:
            references += 1
            if target.relative_to(root).as_posix() not in tracked:
                untracked.append({'document': document, 'reference': name})
            if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                mismatches.append({'document': document, 'reference': name})
        for item in value.values():
            walk(item, document)
    elif isinstance(value, list):
        for item in value:
            walk(item, document)


# The original handoff and social edit remain independently archived above.
# This later user-authorized integration has a separate exact source boundary.
integration_document = 'docs/evidence/public-wallet-launch-20261017/frontend-integration.json'
assert integration_document in tracked
integration_bytes = (root / integration_document).read_bytes()
assert hashlib.sha256(integration_bytes).hexdigest() == 'd8f49088fb288b41b91fadfcccce10b69aaa13301be8614968aebae70acd8697'
integration = json.loads(integration_bytes)
assert {entry['path'] for entry in integration['files']} == {'website/dist/dashboard.js','website/dist/site.js','public/workspace-client.ts'}
remediation_document = 'docs/evidence/audit-remediation-20261018/frontend-source.json'
assert remediation_document in tracked
remediation_bytes = (root / remediation_document).read_bytes()
assert hashlib.sha256(remediation_bytes).hexdigest() == '0edcccdbe6817a71ea13b85012fe1531a41fcaaaddd70255807e67a40cff199f'
remediation = json.loads(remediation_bytes)
assert remediation['schemaVersion'] == 1 and remediation['previousIntegrationRecord'] == integration_document
assert {entry['path'] for entry in remediation['files']} == {entry['path'] for entry in integration['files']} | {'website/dist/agent-panels.js'}
# Preserve the exact reviewed October 18 bytes before checking later approved changes.
latest_document = 'docs/evidence/review-remediation-20261023/frontend-source.json'
assert latest_document in tracked
latest_bytes = (root / latest_document).read_bytes()
assert hashlib.sha256(latest_bytes).hexdigest() == '1ea9919e6fa3417669b2b1791f901f10f302803be931ce37c5be673af4b2f29e'
latest = json.loads(latest_bytes)
assert latest['schemaVersion'] == 1 and latest['previousRecord'] == remediation_document
historical_sources = {}
for entry in latest['previousSources']:
    name, digest = validate_source_entry(entry)
    assert name not in historical_sources
    stored = entry['storedPath']
    assert stored == 'docs/evidence/review-remediation-20261023/source/' + digest + '.bin'
    assert stored in tracked
    raw = (root / stored).read_bytes()
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    historical_sources[name] = raw
    references += 1
expected_historical = {entry['path'] for entry in remediation['files']} | {entry['path'] for entry in integration['preserved']}
assert set(historical_sources) == expected_historical
postlaunch_document = 'docs/evidence/postlaunch-ready-20261113/source-registry.json'
assert postlaunch_document in tracked
postlaunch_bytes = (root / postlaunch_document).read_bytes()
assert hashlib.sha256(postlaunch_bytes).hexdigest() == '32d5e78c7a6c3c0c4a5e586833060b52e3badeb9fd1e4a5a5f63a91cd5d7af99'
postlaunch = json.loads(postlaunch_bytes)
assert postlaunch['schemaVersion'] == 1 and postlaunch['baselineSourceCommit'] == 'd9489ed33257e34cd985dd0359a173416de69daa'
postlaunch_baseline, postlaunch_current = {}, {}
def postlaunch_source(entry):
    global references
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/postlaunch-ready-20261113/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    references += 1
    return name, raw
for entry in postlaunch['baselineSources']:
    name, raw = postlaunch_source(entry)
    assert name not in postlaunch_baseline
    postlaunch_baseline[name] = raw
postlaunch_ids = []
for feature in postlaunch['features']:
    assert feature['state'] == 'prepared-not-deployed' and type(feature['id']) is int and 2 <= feature['id'] <= 12
    postlaunch_ids.append(feature['id'])
    for entry in feature['files']:
        name, raw = postlaunch_source(entry)
        postlaunch_current[name] = raw
assert len(postlaunch_ids) == len(set(postlaunch_ids)) and postlaunch_ids == sorted(postlaunch_ids)
for name, raw in postlaunch_current.items():
    assert name in tracked and (root / name).read_bytes() == raw, 'Prepared feature source changed: ' + name
verification_document = 'docs/evidence/public-verifier-20261113/frontend-source.json'
assert verification_document in tracked
verification_bytes = (root / verification_document).read_bytes()
assert hashlib.sha256(verification_bytes).hexdigest() == 'f5e6acc133a8febd87db50ebcb479638d8a1df7a5c917eb20c823dc872601217'
verification_record = json.loads(verification_bytes)
assert verification_record['schemaVersion'] == 1 and verification_record['previousRecord'] == 'docs/evidence/contract-publish-20261113/frontend-source.json'
verification_previous = {}
for entry in verification_record['preservedSources']:
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/public-verifier-20261113/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert name not in verification_previous and len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    verification_previous[name] = raw
    references += 1
assert set(verification_previous) == {'website/dist/site.js', 'website/dist/site.css', 'website/dist/dashboard.js', 'scripts/build-browser.mjs', 'src/service.ts', 'src/app.ts'}
verification_names = set()
for entry in verification_record['files']:
    name, digest = validate_source_entry(entry)
    assert name in tracked and name not in verification_names
    verification_names.add(name)
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    raw = postlaunch_baseline.get(name, raw)
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved public verifier changed: ' + name
    references += 1
assert verification_names == set(verification_previous) | {'public/receipt-verifier.ts', 'src/receipts/public-verifier.ts', 'src/receipts/public-configured.ts', 'src/receipts/public-routes.ts', 'tests/public-receipt-verifier.test.ts', 'tests/public-receipt-chain.test.ts'}
publish_document = 'docs/evidence/contract-publish-20261113/frontend-source.json'
assert publish_document in tracked
publish_bytes = (root / publish_document).read_bytes()
assert hashlib.sha256(publish_bytes).hexdigest() == 'ddd2813460cd3f99aa7eb3e1b7eab66d1a4f563578071981905b315db8db3e29'
publish_record = json.loads(publish_bytes)
assert publish_record['schemaVersion'] == 1 and publish_record['previousRecord'] == 'docs/evidence/plan-limits-20261112/frontend-source.json'
publish_previous = {}
for entry in publish_record['preservedSources']:
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/contract-publish-20261113/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert name not in publish_previous and len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    publish_previous[name] = raw
    references += 1
assert set(publish_previous) == {'website/dist/site.js', 'website/dist/site.css', 'scripts/build-browser.mjs',
    'website/optional/contract-address/config.json', 'website/optional/contract-address/contract-address.ts', 'website/optional/contract-address/contract-address.css'}
publish_names = set()
for entry in publish_record['files']:
    name, digest = validate_source_entry(entry)
    assert name in tracked and name not in publish_names
    publish_names.add(name)
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    raw = verification_previous.get(name, raw)
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved contract publication changed: ' + name
    references += 1
assert publish_names == set(publish_previous) | {'public/published-contract.ts'}
performance_document = 'docs/evidence/website-performance-20261023/frontend-source.json'
assert performance_document in tracked
performance_bytes = (root / performance_document).read_bytes()
assert hashlib.sha256(performance_bytes).hexdigest() == 'c838fdc1c35d93ca28c7bddc4b0ebd06e5d5b9e1e495b6bfaa108a60b64e0ab4'
performance = json.loads(performance_bytes)
assert performance['schemaVersion'] == 1 and performance['previousRecord'] == latest_document
performance_previous = {}
for entry in performance['preservedSources']:
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/website-performance-20261023/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert name not in performance_previous and len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    performance_previous[name] = raw
    references += 1
assert set(performance_previous) == {'website/dist/site.js'}
performance_names = set()
for entry in performance['files']:
    name, digest = validate_source_entry(entry)
    assert name in tracked and name not in performance_names
    performance_names.add(name)
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    raw = publish_previous.get(name, raw)
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved loading fix changed: ' + name
    references += 1
assert performance_names == {'website/dist/site.js', 'website/dist/preload.js', 'ops/website-performance/static-compression.conf'}
mobile_document = 'docs/evidence/mobile-loading-20261023/frontend-source.json'
assert mobile_document in tracked
mobile_bytes = (root / mobile_document).read_bytes()
assert hashlib.sha256(mobile_bytes).hexdigest() == '8ec588b04b5617a2cf4b10fddcea58fa6098d0bf3f57b4981760e2a0b33572fd'
mobile = json.loads(mobile_bytes)
assert mobile['schemaVersion'] == 1 and mobile['previousRecord'] == performance_document
mobile_previous = {}
for entry in mobile['preservedSources']:
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/mobile-loading-20261023/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert name not in mobile_previous and len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    mobile_previous[name] = raw
    references += 1
assert set(mobile_previous) == {'website/dist/wallet-picker.css'}
assert len(mobile['files']) == 1
for entry in mobile['files']:
    name, digest = validate_source_entry(entry)
    assert name == 'website/dist/wallet-picker.css' and name in tracked
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved narrow wallet layout changed'
    references += 1
wallet_style_document = 'docs/evidence/wallet-style-readiness-20261109/frontend-source.json'
assert wallet_style_document in tracked
wallet_style_bytes = (root / wallet_style_document).read_bytes()
assert hashlib.sha256(wallet_style_bytes).hexdigest() == 'bbb159f8944e4c1f02e8a2348e0667f887fe2694ff8bc98beae8d998451aa0e0'
wallet_style = json.loads(wallet_style_bytes)
assert wallet_style['schemaVersion'] == 1 and wallet_style['previousRecord'] == mobile_document
wallet_style_previous = {}
for entry in wallet_style['preservedSources']:
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/wallet-style-readiness-20261109/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert name not in wallet_style_previous and len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    wallet_style_previous[name] = raw
    references += 1
assert set(wallet_style_previous) == {'public/wallet-picker.ts'}
assert len(wallet_style['files']) == 1
for entry in wallet_style['files']:
    name, digest = validate_source_entry(entry)
    assert name == 'public/wallet-picker.ts' and name in tracked
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved wallet stylesheet readiness changed'
    references += 1
domain_document = 'docs/evidence/domain-links-20261112/frontend-source.json'
assert domain_document in tracked
domain_bytes = (root / domain_document).read_bytes()
assert hashlib.sha256(domain_bytes).hexdigest() == '5cfb3a2576b458c3c20d12e28481f4c443ad30d175c6085d276eb76adc162aff'
domain = json.loads(domain_bytes)
assert domain['schemaVersion'] == 1 and domain['previousRecord'] == wallet_style_document
domain_previous = {}
for entry in domain['preservedSources']:
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/domain-links-20261112/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert name not in domain_previous and len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    domain_previous[name] = raw
    references += 1
assert set(domain_previous) == {'website/dist/index.html'}
assert len(domain['files']) == 1
for entry in domain['files']:
    name, digest = validate_source_entry(entry)
    assert name == 'website/dist/index.html' and name in tracked
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved public domain changed'
    references += 1
plan_document = 'docs/evidence/plan-limits-20261112/frontend-source.json'
assert plan_document in tracked
plan_bytes = (root / plan_document).read_bytes()
assert hashlib.sha256(plan_bytes).hexdigest() == '466fce0f8ccaf37f4346eb29326080d1707a926262476e1f1fb98ed809930a57'
plan_record = json.loads(plan_bytes)
assert plan_record['schemaVersion'] == 1 and plan_record['previousRecord'] == domain_document
plan_previous = {}
for entry in plan_record['preservedSources']:
    name, digest = validate_source_entry(entry)
    stored = entry['storedPath']
    assert stored == 'docs/evidence/plan-limits-20261112/source/' + digest + '.bin' and stored in tracked
    raw = (root / stored).read_bytes()
    assert name not in plan_previous and len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest
    plan_previous[name] = raw
    references += 1
assert set(plan_previous) == {'public/workspace-client.ts', 'website/dist/dashboard.js', 'website/dist/dashboard.css'}
plan_names = set()
for entry in plan_record['files']:
    name, digest = validate_source_entry(entry)
    assert name in tracked and name not in plan_names
    plan_names.add(name)
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    raw = verification_previous.get(name, raw)
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved plan feedback changed: ' + name
    references += 1
assert plan_names == set(plan_previous) | {'public/run-plan-policy.ts'}
latest_names = set()
for entry in latest['files']:
    name, digest = validate_source_entry(entry)
    assert name in tracked and name.startswith(('public/', 'website/dist/')) and name not in latest_names
    latest_names.add(name)
    raw = postlaunch_baseline.get(name, (root / name).read_bytes())
    for sources in [verification_previous, performance_previous, mobile_previous, wallet_style_previous,
                    domain_previous, plan_previous, publish_previous]:
        raw = sources.get(name, raw)
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == digest, 'Approved frontend changed: ' + name
    references += 1
assert expected_historical <= latest_names

prior = {entry['path']: entry for entry in integration['files'] + integration['preserved']}
for entry in remediation['files']:
    name, digest = validate_source_entry(entry)
    previous = entry['previous']
    assert {key: previous[key] for key in ('path', 'bytes', 'sha256')} == prior[name]
    stored = previous['storedPath']
    assert stored == 'docs/evidence/audit-remediation-20261018/source/' + previous['sha256'] + '.bin'
    assert stored in tracked and name in tracked
    archived = (root / stored).read_bytes()
    assert len(archived) == previous['bytes'] and hashlib.sha256(archived).hexdigest() == previous['sha256']
    current = historical_sources[name]
    assert len(current) == entry['bytes'] and hashlib.sha256(current).hexdigest() == digest, 'Reviewed frontend changed: ' + name
    references += 2
for entry in [item for item in integration['preserved'] if item['path'] != 'website/dist/agent-panels.js'] + [integration['historicalSocial']]:
    name, digest = validate_source_entry(entry)
    assert name in tracked
    actual = historical_sources.get(name, (root / name).read_bytes())
    assert len(actual) == entry['bytes'] and hashlib.sha256(actual).hexdigest() == digest, 'Preserved frontend changed: ' + name
    references += 1

for name in names:
    if name.endswith('.json'):
        value = json.loads((root / name).read_bytes())
        if name == archive_document:
            # Rows are checked against their original evidence, not today's paths.
            continue
        if name == source_document:
            verify_archived_source(value, name)
            walk({key: item for key, item in value.items() if key != 'sourceFiles'}, name)
        else:
            walk(value, name)
print(json.dumps({'checkedEvidenceReferences': references, 'mismatches': mismatches,
                  'untrackedEvidenceReferences': untracked, 'verifiedArchivedSourceFiles': archived_source_files,
                  'verifiedApprovedSocialRecords': approved_social_records,
                  'approvedSocialRecordTracked': social_document in tracked,
                  'verifiedPublicArchiveRecords': len(public_archive)}))
assert not mismatches and not untracked
assert used_archive_entries == {(document, commit, name)
                                for (document, commit), entries in public_archive.items()
                                for name in entries}, 'Some archived source entries were not verified'
