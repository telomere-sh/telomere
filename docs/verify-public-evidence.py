"""Verify committed evidence and historical source snapshots from a clean checkout.

Run: python -B docs/verify-evidence.py
Reads local files and the current Git commit only; never reruns acceptance.
"""
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
archive_sha256 = '78e6120063068870d7767e3244b686bcab5432d9d4c7eb0305fdc751626c9273'
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
    assert key in public_archive and set(public_archive[key]) == {'website/dist/site.js'}
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
                elif name == 'dist/dashboard.js':
                    verify_archive_file(dict(value, path='website/' + name), source_document, 'ee6169d1007b11f037fbc409dc1f7575f15117c9')
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
for entry in integration['files'] + integration['preserved'] + [integration['historicalSocial']]:
    name, digest = validate_source_entry(entry)
    assert name in tracked
    actual = (root / name).read_bytes()
    assert len(actual) == entry['bytes'] and hashlib.sha256(actual).hexdigest() == digest, 'Workspace integration source changed: ' + name
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
