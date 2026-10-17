"""Retained bounded local fixtures for the exact pure attempt03 image validator. No Docker/SSH."""
import ast
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import tarfile
import tempfile
import zlib

HERE = Path(__file__).resolve().parent
RUNNER = HERE / 'rollout.py'
tree = ast.parse(RUNNER.read_text())
names = {'Refusal', 'require', 'digest', 'image_archive_stamp', 'image_archive_identity',
    'assert_image_archive_stable', 'assert_loaded_cpu_identity'}
selected = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names]
assert len(selected) == len(names)
exec(compile(ast.Module(body=selected, type_ignores=[]), str(RUNNER), 'exec'), globals())
AUDIT = Path(tempfile.mkdtemp(prefix='image-offline-', dir=HERE)).resolve()
assert AUDIT.parent == HERE
INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
LAYER = 'application/vnd.oci.image.layer.v1.tar'

def h(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def fixture(name, mutation=None):
    mutation = mutation or {}
    files = {}
    def blob(data):
        identity = h(data)
        files['blobs/sha256/' + identity[7:]] = data
        return identity
    def descriptor(data, media, **extra):
        return {'digest': blob(data), 'size': len(data), 'mediaType': media, **extra}
    payloads = [b'first ordered synthetic tar layer\x00', b'second ordered synthetic tar layer\x00']
    layers = []
    for index, raw in enumerate(payloads):
        packed = gzip.compress(raw, mtime=0)
        media = LAYER + '+gzip'
        if index == 0 and mutation.get('plain'):
            packed, media = raw, LAYER
        if index == 0 and mutation.get('concat'):
            packed = gzip.compress(raw[:5], mtime=0) + gzip.compress(raw[5:], mtime=0)
        if index == 0 and mutation.get('trailing'):
            packed += b'invalid trailing data'
        if index == 0 and mutation.get('badcrc'):
            packed = packed[:-8] + bytes([packed[-8] ^ 1]) + packed[-7:]
        if index == 0 and mutation.get('oversized'):
            compressed = io.BytesIO()
            with gzip.GzipFile(fileobj=compressed, mode='wb', mtime=0) as output:
                for _ in range(257):
                    output.write(b'0' * 1048576)
            packed = compressed.getvalue()
        if index == 0 and mutation.get('unsupported'):
            media = LAYER + '+zstd'
        layers.append(descriptor(packed, media))
    original_diff_ids = [h(raw) for raw in payloads]
    config = {'os': mutation.get('os', 'linux'), 'architecture': mutation.get('arch', 'amd64'),
        'rootfs': {'type': 'layers', 'diff_ids': list(reversed(original_diff_ids)) if mutation.get('difforder') else original_diff_ids},
        'config': {'Entrypoint': ['/synthetic-no-execution']}}
    config_descriptor = descriptor(encoded(config), CONFIG)
    selected = {'schemaVersion': 2, 'mediaType': MANIFEST, 'config': config_descriptor, 'layers': layers}
    if mutation.get('descriptor_size'):
        selected['layers'][0]['size'] += 1
    if mutation.get('urls'):
        selected['layers'][0]['urls'] = ['https://must-never-fetch.invalid/layer']
    if mutation.get('data'):
        selected['layers'][0]['data'] = 'AA=='
    selected_descriptor = descriptor(encoded(selected), MANIFEST, platform={'os': 'linux', 'architecture': 'amd64'})
    auxiliary = descriptor(encoded({'os': 'unknown', 'architecture': 'unknown'}), CONFIG)
    auxiliary_layer = descriptor(b'not an authenticated attestation claim', 'application/vnd.in-toto+json')
    auxiliary_manifest = descriptor(encoded({'schemaVersion': 2, 'mediaType': MANIFEST, 'config': auxiliary,
        'layers': [auxiliary_layer]}), MANIFEST, platform={'os': 'unknown', 'architecture': 'unknown'})
    missing = {'digest': 'sha256:' + '1' * 64, 'size': 100, 'mediaType': MANIFEST,
        'platform': {'os': 'linux', 'architecture': 'arm64'}}
    children = [selected_descriptor, auxiliary_manifest, missing]
    if mutation.get('ambiguous'):
        second = copy.deepcopy(missing)
        second['platform'] = {'os': 'linux', 'architecture': 'amd64'}
        children.append(second)
        children.remove(missing)
    root = {'schemaVersion': 2, 'mediaType': INDEX, 'manifests': children}
    root_bytes = encoded(root)
    root_descriptor = descriptor(root_bytes, INDEX)
    wrapper = {'schemaVersion': 2, 'mediaType': INDEX, 'manifests': [root_descriptor]}
    files['index.json'] = encoded(wrapper)
    if mutation.get('duplicate_json'):
        files['index.json'] = files['index.json'].replace(b'{', b'{"schemaVersion":2,', 1)
    if mutation.get('nan'):
        files['index.json'] = files['index.json'].replace(b'{', b'{"unused":NaN,', 1)
    files['oci-layout'] = encoded({'imageLayoutVersion': '1.0.0'})
    compatibility = {'Config': 'blobs/sha256/' + config_descriptor['digest'][7:], 'RepoTags': None,
        'Layers': ['blobs/sha256/' + value['digest'][7:] for value in layers]}
    if mutation.get('legacy_config'):
        compatibility['Config'] = 'blobs/sha256/' + auxiliary['digest'][7:]
    if mutation.get('legacy_order'):
        compatibility['Layers'].reverse()
    files['manifest.json'] = encoded([compatibility])
    if mutation.get('blob_corrupt'):
        files['blobs/sha256/' + config_descriptor['digest'][7:]] += b'corrupted'
    if mutation.get('missing'):
        del files['blobs/sha256/' + layers[0]['digest'][7:]]
    source = {'Id': root_descriptor['digest'], 'Architecture': 'amd64', 'Os': 'linux',
        'RootFS': {'Type': 'layers', 'Layers': original_diff_ids}}
    path = AUDIT / (name + '.tar')
    with tarfile.open(path, 'w') as archive:
        for member_name, data in files.items():
            item = tarfile.TarInfo(member_name)
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
        if mutation.get('duplicate_tar'):
            item = tarfile.TarInfo('index.json')
            item.size = len(files['index.json'])
            archive.addfile(item, io.BytesIO(files['index.json']))
        if mutation.get('symlink'):
            item = tarfile.TarInfo('blobs/sha256/' + 'f' * 64)
            item.type, item.linkname = tarfile.SYMTYPE, '/unrelated'
            archive.addfile(item)
        if mutation.get('traversal'):
            item = tarfile.TarInfo('../../outside')
            item.size = 1
            archive.addfile(item, io.BytesIO(b'x'))
    return path, source

results = []
def success(name, mutation=None):
    path, source = fixture(name, mutation)
    proof = image_archive_identity(path, source, source['Id'])
    assert proof['configDigest'] != proof['sourceIndexDigest']
    assert proof['allPresentBlobHashesVerified'] and proof['selectedLayerDiffIdsIndependentlyVerified']
    assert len(proof['missingNonselectedDescriptors']) == 1
    results.append({'case': name, 'result': 'passed'})
    return path, source, proof

def rejected(name, operation, expected):
    try:
        operation()
    except Refusal as error:
        assert str(error) == expected, (name, str(error), expected)
        results.append({'case': name, 'result': 'passed', 'refusal': str(error)})
    else:
        raise AssertionError(name + ' unexpectedly accepted')

path, source, proof = success('valid_dual_identity')
success('plain_tar_layer', {'plain': True})
success('concatenated_gzip_layer', {'concat': True})
for name, mutation, expected in [
    ('blob_content_hash', 'blob_corrupt', 'image_blob_digest'),
    ('descriptor_size', 'descriptor_size', 'image_descriptor_size'),
    ('duplicate_tar_name', 'duplicate_tar', 'image_tar_members'),
    ('symlink_tar', 'symlink', 'image_tar_type'),
    ('traversal_tar', 'traversal', 'image_tar_path'),
    ('duplicate_json', 'duplicate_json', 'image_json_duplicate'),
    ('json_nan', 'nan', 'image_json_constant'),
    ('ambiguous_runnable', 'ambiguous', 'image_ambiguous_platform'),
    ('wrong_config_os', 'os', 'image_config_platform'),
    ('wrong_config_arch', 'arch', 'image_config_platform'),
    ('reordered_diff_ids', 'difforder', 'image_config_rootfs'),
    ('legacy_config_substitution', 'legacy_config', 'image_compatibility_binding'),
    ('legacy_layer_reorder', 'legacy_order', 'image_compatibility_binding'),
    ('missing_selected_layer', 'missing', 'image_selected_blob_missing'),
    ('unsupported_layer_media', 'unsupported', 'image_layer_media'),
    ('trailing_gzip', 'trailing', 'image_layer_stream_invalid'),
    ('gzip_crc', 'badcrc', 'image_layer_stream_invalid'),
    ('external_descriptor_url', 'urls', 'image_descriptor_external'),
    ('inline_descriptor_data', 'data', 'image_descriptor_external'),
    ('expanded_layer_limit', 'oversized', 'image_expanded_bound'),
]:
    value = 'windows' if mutation == 'os' else 'arm64' if mutation == 'arch' else True
    case_path, case_source = fixture(name, {mutation: value})
    rejected(name, lambda p=case_path,s=case_source: image_archive_identity(p,s,s['Id']), expected)
rejected('wrong_root_pin', lambda: image_archive_identity(path,source,'sha256:'+'0'*64), 'image_source_pin')
loaded = {'Id': proof['configDigest'], 'Architecture': source['Architecture'], 'Os': source['Os'], 'RootFS': copy.deepcopy(source['RootFS'])}
assert_loaded_cpu_identity(proof,source,loaded,source)
results.append({'case':'loaded_exact_config_and_rootfs','result':'passed'})
wrong_loaded = copy.deepcopy(loaded)
wrong_loaded['Id'] = source['Id']
rejected('loaded_index_not_config',lambda: assert_loaded_cpu_identity(proof,source,wrong_loaded,source),'image_loaded_config_id')
wrong_loaded = copy.deepcopy(loaded)
wrong_loaded['RootFS']['Layers'].reverse()
rejected('loaded_rootfs_order',lambda: assert_loaded_cpu_identity(proof,source,wrong_loaded,source),'image_loaded_rootfs')
after = copy.deepcopy(source)
after['RootFS']['Layers'].reverse()
rejected('source_postload_drift',lambda: assert_loaded_cpu_identity(proof,source,loaded,after),'image_source_changed')
with path.open('ab') as changed:
    changed.write(b'changed')
rejected('archive_postproof_change',lambda: assert_image_archive_stable(path,proof),'image_archive_changed')
report={'schemaVersion':1,'result':'passed','cases':len(results),'transportCalls':0,'dockerCalls':0,
    'validatorSourceSha256':hashlib.sha256(RUNNER.read_bytes()).hexdigest(),'results':results}
(HERE/'image-identity-offline-results.json').write_bytes((json.dumps(report,indent=2,sort_keys=True)+'\n').encode())
print(json.dumps({k:report[k] for k in ['result','cases','transportCalls','dockerCalls']},sort_keys=True))
