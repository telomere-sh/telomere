import hashlib, json, pathlib, subprocess, tarfile
clone = pathlib.Path('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch02/clone')
original = 'sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402'
raw = subprocess.check_output(['docker', '--host', 'unix:///var/run/docker.sock', 'image', 'inspect', original,
    '--format', '{{json .}}'], timeout=15)
image = [json.loads(raw)]
export = clone / 'cpu-image.tar'
digest = hashlib.sha256()
with export.open('rb') as stream:
    for block in iter(lambda: stream.read(1048576), b''): digest.update(block)
with tarfile.open(export, 'r:') as archive:
    compatibility = json.loads(archive.extractfile('manifest.json').read())
    index = json.loads(archive.extractfile('index.json').read())
    entry = compatibility[0]
    config_raw = archive.extractfile(entry['Config']).read()
    config_hash = hashlib.sha256(config_raw).hexdigest()
    config = json.loads(config_raw)
    index_raw = archive.extractfile('blobs/sha256/' + original.split(':')[1]).read()
loaded = clone / ('docker-data/image/vfs/imagedb/content/sha256/' + config_hash)
assert len(image) == 1 and image[0]['Id'] == original and hashlib.sha256(index_raw).hexdigest() == original.split(':')[1]
assert entry['Config'] == 'blobs/sha256/' + config_hash and loaded.is_file()
assert hashlib.sha256(loaded.read_bytes()).hexdigest() == config_hash
assert config['rootfs']['diff_ids'] == image[0]['RootFS']['Layers']
print(json.dumps({'schemaVersion': 1, 'status': 'observed_distinct_index_and_config_image_identities',
    'originalGlobalImageId': original, 'globalPlatform': {'os': image[0]['Os'], 'architecture': image[0]['Architecture']},
    'exportBytes': export.stat().st_size, 'exportSha256': digest.hexdigest(),
    'exportIndexReferencesGlobalId': any(item['digest'] == original for item in index['manifests']),
    'rootIndexBlobDigestMatchesGlobalId': True, 'compatibilityConfigDigest': 'sha256:' + config_hash,
    'loadedVfsConfigDigestMatchesExport': True, 'configDiffIdsMatchGlobalRootFS': True,
    'globalRootFSLayers': image[0]['RootFS']['Layers'], 'profileOrKeyFileRead': False,
    'dockerMutations': 0, 'servicesChanged': False}, separators=(',', ':')))
