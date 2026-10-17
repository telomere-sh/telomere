import datetime, hashlib, json, os, pathlib, stat, tarfile

revision = '36d8a7f877038e4a15e91d03c6f5ae71283a1263'
archive_sha = '9d9a5993f9d8b617ce8759a56f21c8172c3ecf0429abf596cd077db4bdf6a7c2'
image_revision = 'd4481aec92179df44a533699897db2f523fbd0a2'
image_archive_sha = '090932a350a522ddfe2c056775edf194176060c3cca79a06d286e5d3f1989bd6'
parent = pathlib.Path('/opt/telomere-host-runtime')
original = parent / ('backend-completion-final-20261015-' + image_archive_sha[:12])
target = parent / ('backend-completion-corrected-20261015-' + archive_sha[:12])
archive = pathlib.Path('/tmp/telomere-completion-corrected-20261015.tar.gz')
manifest_path = archive.with_name(archive.name + '.manifest.json')
assert parent.resolve() == parent and original.resolve() == original
assert not target.exists() and not target.is_symlink()
assert archive.is_file() and not archive.is_symlink() and manifest_path.is_file() and not manifest_path.is_symlink()
assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive_sha
manifest = json.loads(manifest_path.read_bytes())
old_manifest = json.loads((original / '.local/source-manifest.json').read_bytes())
for item, rev, sha in [(manifest, revision, archive_sha), (old_manifest, image_revision, image_archive_sha)]:
    assert item['gitRevision'] == rev and item['archiveSha256'] == sha
    assert item['source'] == 'committed_git_blobs_only' and item['workingTreeIncluded'] is False
    assert len(item['files']) == len({row['path'] for row in item['files']}) == 708
old = {row['path']: row for row in old_manifest['files']}
new = {row['path']: row for row in manifest['files']}
assert sorted(old) == sorted(new)
changed = sorted(name for name in old if old[name] != new[name])
expected = ['python/tests/test_vault_income_journal.py', 'tests/declared-state-restore.test.ts', 'tests/paid-cpu-jobs.test.ts']
assert changed == expected
assert sum(row['bytes'] for row in manifest['files']) < 64 * 1024 * 1024
for name, item in old.items():
    path = original / name
    assert path.is_file() and not path.is_symlink()
    assert path.stat().st_size == item['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256']
for name in ['node_modules', 'dist']:
    path = original / name
    assert path.is_dir() and not path.is_symlink() and path.resolve().parent == original
os.umask(0o077)
target.mkdir(mode=0o700)
with tarfile.open(archive, 'r:gz') as packed:
    members = packed.getmembers()
    assert len(members) == len({row.name for row in members}) == 708
    for item in members:
        name = pathlib.PurePosixPath(item.name)
        assert item.isfile() and not name.is_absolute() and '..' not in name.parts
        assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
        assert item.name in new and item.size == new[item.name]['bytes']
        raw = packed.extractfile(item).read()
        assert len(raw) == new[item.name]['bytes'] and hashlib.sha256(raw).hexdigest() == new[item.name]['sha256']
        destination = target / item.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
logs = target / '.local'
logs.mkdir(mode=0o700)
with (logs / 'source-manifest.json').open('xb') as output:
    output.write(manifest_path.read_bytes())
    output.flush()
    os.fsync(output.fileno())
for name in ['node_modules', 'dist']:
    (target / name).symlink_to(original / name, target_is_directory=True)
files = []
for name in sorted(new):
    path = target / name
    assert path.is_file() and not path.is_symlink()
    assert path.stat().st_size == new[name]['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest() == new[name]['sha256']
    files.append({'path': name, 'before': {k: old[name][k] for k in ['sha256', 'bytes', 'gitBlob']},
                  'after': {k: new[name][k] for k in ['sha256', 'bytes', 'gitBlob']}, 'changed': name in changed})
report = {'schemaVersion': 1, 'status': 'accepted', 'imageGitRevision': image_revision, 'finalGitRevision': revision,
          'imageArchiveSha256': image_archive_sha, 'finalArchiveSha256': archive_sha,
          'imageSourceDirectory': str(original), 'finalSourceDirectory': str(target),
          'imageManifestSha256': hashlib.sha256((original / '.local/source-manifest.json').read_bytes()).hexdigest(),
          'finalManifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
          'filesBefore': 708, 'filesAfter': 708, 'unchangedFiles': 705, 'changedPaths': changed,
          'addedPaths': [], 'deletedPaths': [], 'runtimeChangedPaths': [], 'files': files,
          'actualSourceFilesVerifiedBefore': 708, 'actualSourceFilesVerifiedAfter': 708,
          'nodeModulesSymlink': str(original / 'node_modules'), 'distSymlink': str(original / 'dist'),
          'reinstallPerformed': False, 'rebuildPerformed': False,
          'publicTransactions': 0, 'paidProviderRequests': 0, 'serviceMutations': False,
          'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
destination = logs / 'final-test-only-source-continuity.json'
with destination.open('xb') as output:
    output.write((json.dumps(report, indent=2) + '\n').encode())
    output.flush()
    os.fsync(output.fileno())
print(json.dumps({'status': 'accepted', 'directory': str(target), 'sourceFiles': 708, 'changedPaths': changed,
                  'sourceContinuitySha256': hashlib.sha256(destination.read_bytes()).hexdigest()}), flush=True)
