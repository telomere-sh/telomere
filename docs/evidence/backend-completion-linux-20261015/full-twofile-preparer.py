"""Extract exact final Git archive and copy, never mutate, the reviewed dependency cache."""
import datetime, hashlib, json, os, pathlib, shutil, stat, tarfile

REVISION = 'bc3ca04617c2ec6b0fec32ee59aa34af97ba867d'
ARCHIVE_SHA = '3ed17e69fc55c944999ca0449a3384beba7c0ef8753589d502463fa55a332ee2'
ORIGINAL = pathlib.Path('/opt/telomere-host-runtime/backend-completion-final-20261015-090932a350a5')
TARGET = pathlib.Path('/opt/telomere-host-runtime/full-twofile-corrected-20261015-3ed17e69fc55')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, maximum):
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1 and info.st_uid == os.getuid()
    assert info.st_size <= maximum
    data = path.read_bytes()
    assert len(data) == info.st_size
    return data


def source_inventory(root, manifest):
    changed = []
    for item in manifest['files']:
        try:
            data = regular(root / item['path'], 32 * 1024 * 1024)
            assert len(data) == item['bytes'] and sha(data) == item['sha256']
        except (OSError, AssertionError):
            changed.append(item['path'])
    return {'unchanged': not changed, 'verified': len(manifest['files']) - len(changed), 'changed': changed}


def tree_inventory(root):
    assert root.is_dir() and not root.is_symlink()
    rows = []
    for directory, directories, files in os.walk(root, followlinks=False):
        directories.sort(); files.sort()
        base = pathlib.Path(directory)
        for name in list(directories):
            path = base / name
            if path.is_symlink():
                assert path.resolve().is_relative_to(root)
                rows.append({'path': path.relative_to(root).as_posix(), 'type': 'symlink', 'target': os.readlink(path)})
                directories.remove(name)
        for name in files:
            path = base / name
            if path.is_symlink():
                assert path.resolve().is_relative_to(root)
                rows.append({'path': path.relative_to(root).as_posix(), 'type': 'symlink', 'target': os.readlink(path)})
                continue
            before = path.lstat()
            assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid()
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            after = path.lstat()
            assert (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            rows.append({'path': path.relative_to(root).as_posix(), 'type': 'file', 'bytes': before.st_size, 'sha256': digest.hexdigest()})
    return sorted(rows, key=lambda item: item['path'])


def dependency_inventory(root):
    return {name: tree_inventory(root / name) for name in ['node_modules', 'dist']}


def inventory_sha(value):
    return sha((json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode())


def save(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as output:
        json.dump(value, output, indent=2)
        output.write('\n'); output.flush(); os.fsync(output.fileno())


def main():
    archive = pathlib.Path('/tmp/telomere-full-twofile-corrected-20261015.tar.gz')
    manifest_path = pathlib.Path(str(archive) + '.manifest.json')
    continuity_path = pathlib.Path('/tmp/full-twofile-source-continuity-20261015.json')
    manifest_bytes = regular(manifest_path, 2 * 1024 * 1024)
    continuity_bytes = regular(continuity_path, 2 * 1024 * 1024)
    manifest, continuity = json.loads(manifest_bytes), json.loads(continuity_bytes)
    assert manifest['gitRevision'] == REVISION and manifest['archiveSha256'] == ARCHIVE_SHA
    assert manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
    assert sha(regular(archive, 16 * 1024 * 1024)) == ARCHIVE_SHA
    assert continuity['baselineRevision'] == '079bb31fa76217df9d3d3d0e309293bf4f58e89c' and continuity['finalRevision'] == REVISION
    assert continuity['sourceManifestSha256'] == sha(manifest_bytes) and continuity['archiveSha256'] == ARCHIVE_SHA
    assert continuity['changedRuntimePaths'] == ['tests/platform-runtime.test.ts', 'tests/selection-reputation-publisher.test.ts']
    assert continuity['productionChangedPaths'] == continuity['addedPaths'] == continuity['deletedPaths'] == []
    assert len(manifest['files']) == 708 and len({item['path'] for item in manifest['files']}) == 708
    assert {row['path']: row['after'] for row in continuity['files']} == {item['path']: {key: item[key] for key in ['sha256', 'bytes', 'gitBlob']} for item in manifest['files']}
    old_manifest_bytes = regular(ORIGINAL / '.local/source-manifest.json', 2 * 1024 * 1024)
    assert sha(old_manifest_bytes) == '16b7ddcfb62c1d6fde5bd0f6c4a2b55013d0dbe508c62e4ff233efd896e69028'
    old_manifest = json.loads(old_manifest_bytes)
    assert old_manifest['gitRevision'] == 'd4481aec92179df44a533699897db2f523fbd0a2' and len(old_manifest['files']) == 708
    assert TARGET.parent.resolve() == TARGET.parent and ORIGINAL.resolve() == ORIGINAL and not TARGET.exists()
    old_source_before = source_inventory(ORIGINAL, old_manifest)
    assert old_source_before['unchanged']
    old_dependencies = dependency_inventory(ORIGINAL)
    source_bytes = sum(item['bytes'] for item in manifest['files'])
    dependency_bytes = sum(item.get('bytes', 0) for rows in old_dependencies.values() for item in rows)
    assert shutil.disk_usage(TARGET.parent).free >= source_bytes + dependency_bytes + 1024 * 1024 * 1024
    os.umask(0o077)
    TARGET.mkdir(mode=0o700)
    local = TARGET / '.local'; local.mkdir(mode=0o700)
    report = {'schemaVersion': 1, 'status': 'preparing', 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'gitRevision': REVISION, 'archiveSha256': ARCHIVE_SHA, 'directory': str(TARGET), 'sourceFiles': 708,
              'oldSourceDirectory': str(ORIGINAL), 'oldManifestSha256': sha(old_manifest_bytes), 'oldSourceBefore': old_source_before,
              'dependencyEntries': {name: len(rows) for name, rows in old_dependencies.items()},
              'dependencyInventoryBeforeSha256': inventory_sha(old_dependencies),
              'serviceMutations': False, 'publicTransactions': 0, 'paidProviderRequests': 0,
              'reinstallPerformed': False, 'rebuildPerformed': False, 'dependenciesCopiedToOwnedDirectory': True}
    try:
        expected = {item['path']: item for item in manifest['files']}
        with tarfile.open(archive, 'r:gz') as packed:
            members = packed.getmembers()
            assert len(members) == len(expected) and len({item.name for item in members}) == len(expected)
            for member in members:
                name = pathlib.PurePosixPath(member.name)
                assert member.isfile() and not name.is_absolute() and '..' not in name.parts and member.name in expected
                assert not any(part in {'.git', '.local', 'node_modules', '.env'} for part in name.parts)
                item = expected[member.name]
                raw = packed.extractfile(member).read()
                assert len(raw) == item['bytes'] and sha(raw) == item['sha256']
                destination = TARGET / name
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with destination.open('xb') as output:
                    output.write(raw)
                destination.chmod(0o755 if member.mode & 0o111 else 0o600)
        for name in ['node_modules', 'dist']:
            shutil.copytree(ORIGINAL / name, TARGET / name, symlinks=True)
        with (local / 'source-manifest.json').open('xb') as output:
            output.write(manifest_bytes)
        with (local / 'source-continuity.json').open('xb') as output:
            output.write(continuity_bytes)
        save(local / 'old-dependency-inventory.json', old_dependencies)
        report['sourceAfter'] = source_inventory(TARGET, manifest)
        report['oldSourceAfter'] = source_inventory(ORIGINAL, old_manifest)
        report['dependencyInventoryAfterSha256'] = inventory_sha(dependency_inventory(ORIGINAL))
        report['copiedDependencyInventorySha256'] = inventory_sha(dependency_inventory(TARGET))
        assert report['sourceAfter']['unchanged'] and report['oldSourceAfter']['unchanged']
        assert report['dependencyInventoryBeforeSha256'] == report['dependencyInventoryAfterSha256'] == report['copiedDependencyInventorySha256']
        report['success'], report['status'] = True, 'accepted_preparation_only'
    except BaseException as error:
        report['success'], report['status'], report['failureType'] = False, 'failed', type(error).__name__
    report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save(local / 'preparation.json', report)
    print(json.dumps(report, separators=(',', ':')))
    return 0 if report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
