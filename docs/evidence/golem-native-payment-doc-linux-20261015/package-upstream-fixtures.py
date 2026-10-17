import gzip, hashlib, io, json, pathlib, re, subprocess, sys, tarfile

root = pathlib.Path(__file__).resolve().parents[1]
revision = sys.argv[1]
assert re.fullmatch('[0-9a-f]{40}', revision)
prefix = 'docs/evidence/golem-allocation-upstream-20261015/'
output = root / '.local/telomere-yagna-native-doc-fixtures-20261015.tar.gz'
listing = subprocess.check_output(['git', 'ls-tree', '-r', '-z', revision, '--', prefix], cwd=root)
entries = []
for record in listing.split(b'\0'):
    if not record: continue
    metadata, name = record.split(b'\t', 1)
    mode, kind, object_id = metadata.split()
    name = name.decode()
    assert mode == b'100644' and kind == b'blob' and name.startswith(prefix)
    assert '..' not in pathlib.PurePosixPath(name).parts
    entries.append((name, object_id.decode()))
assert len(entries) == 12
raw_files = {name: subprocess.check_output(['git', 'cat-file', 'blob', object_id], cwd=root)
             for name, object_id in entries}
upstream = json.loads(raw_files[prefix + 'manifest.json'])
assert upstream['revision'] == 'c256fce68c50c141a51d4bd2ca18292e4b006f15'
assert len(upstream['files']) == 11
for item in upstream['files']:
    raw = raw_files[prefix + item['path']]
    assert len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256']
inventory = []
with output.open('xb') as destination, gzip.GzipFile(filename='', mode='wb', fileobj=destination, mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w') as packed:
    for name, object_id in sorted(entries):
        raw = raw_files[name]
        item = tarfile.TarInfo(name); item.size = len(raw); item.mode = 0o600; item.mtime = 0
        item.uid = item.gid = 0; item.uname = item.gname = ''
        packed.addfile(item, io.BytesIO(raw))
        inventory.append({'path': name, 'gitBlob': object_id, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
manifest = {'gitRevision': revision, 'source': 'committed_git_blobs_only', 'workingTreeIncluded': False,
            'upstreamRevision': upstream['revision'], 'archiveSha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'files': inventory}
with output.with_suffix(output.suffix + '.manifest.json').open('x') as result:
    result.write(json.dumps(manifest, indent=2) + '\n')
windows = json.loads((root / '.local/golem-native-doc-null-after-20261015.json').read_bytes())
cases = [case['fullName'] for row in windows['testResults'] for case in row['assertionResults']]
assert len(cases) == len(set(cases)) == 27 and windows['numFailedTests'] == 0 and windows['numPendingTests'] == 1
expected = {'gitRevision': revision, 'sourceTestSha256': hashlib.sha256(subprocess.check_output(['git', 'show', revision + ':tests/golem-allocation-attribution.test.ts'], cwd=root)).hexdigest(),
            'cases': sorted(cases), 'expectedTotal': 27, 'expectedSkipped': 0,
            'source': 'complete_27_case_Windows_collection_including_explicit_POSIX_case'}
case_path = root / '.local/yagna-native-doc-expected-cases-20261015.json'
with case_path.open('x') as result:
    result.write(json.dumps(expected, indent=2) + '\n')
print(json.dumps({'gitRevision': revision, 'supplementSha256': manifest['archiveSha256'], 'supplementFiles': len(entries),
                  'expectedCasesSha256': hashlib.sha256(case_path.read_bytes()).hexdigest()}))
