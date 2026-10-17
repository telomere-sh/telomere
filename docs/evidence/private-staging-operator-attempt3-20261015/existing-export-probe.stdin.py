import gzip,hashlib,json,re,stat,subprocess,tarfile,zlib
from pathlib import Path
class Refusal(Exception):
    pass

def require(condition, code):
    if not condition:
        raise Refusal(code)

def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1048576), b''):
            result.update(block)
    return result.hexdigest()

def image_archive_stamp(path):
    meta = Path(path).lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and (0 < meta.st_size <= 268435456), 'image_archive_file')
    return {'device': meta.st_dev, 'inode': meta.st_ino, 'bytes': meta.st_size, 'mtimeNs': meta.st_mtime_ns}

def image_archive_identity(path, source, source_digest):
    """Pure bounded Docker29 OCI-index -> classic config-ID proof. No extraction or Docker calls.

    Only the unique linux/amd64 graph is a runnable claim. Missing nonselected index
    siblings are reported, never fetched. Present auxiliary blobs are hash checked;
    their provenance/attestation claims are not interpreted or accepted.
    """
    sha_pattern = 'sha256:[a-f0-9]{64}'
    require(set(source) == {'Id', 'Architecture', 'Os', 'RootFS'}, 'image_source_fields')
    require(source['Id'] == source_digest and re.fullmatch(sha_pattern, source_digest), 'image_source_pin')
    require(source['Os'] == 'linux' and source['Architecture'] == 'amd64', 'image_source_platform')
    require(isinstance(source['RootFS'], dict) and source['RootFS'].get('Type') == 'layers' and isinstance(source['RootFS'].get('Layers'), list) and (0 < len(source['RootFS']['Layers']) <= 64) and all((isinstance(item, str) and re.fullmatch(sha_pattern, item) for item in source['RootFS']['Layers'])), 'image_source_rootfs')
    before = image_archive_stamp(path)
    checksum = digest(path)
    index_type = 'application/vnd.oci.image.index.v1+json'
    manifest_type = 'application/vnd.oci.image.manifest.v1+json'
    config_type = 'application/vnd.oci.image.config.v1+json'
    plain_layer = 'application/vnd.oci.image.layer.v1.tar'
    gzip_layer = plain_layer + '+gzip'
    with tarfile.open(path, 'r:') as packed:
        members, blobs, total = ({}, {}, 0)
        for item in packed:
            require(len(members) < 512 and item.name not in members, 'image_tar_members')
            require(item.name in ['blobs', 'blobs/', 'blobs/sha256', 'blobs/sha256/'] or item.isfile(), 'image_tar_type')
            if item.isdir():
                require(item.name in ['blobs', 'blobs/', 'blobs/sha256', 'blobs/sha256/'], 'image_tar_directory')
            else:
                require(item.isfile() and (item.name in ['index.json', 'manifest.json', 'oci-layout'] or re.fullmatch('blobs/sha256/[a-f0-9]{64}', item.name)), 'image_tar_path')
                require(0 < item.size <= 134217728, 'image_blob_bound')
                total += item.size
                require(total <= 268435456, 'image_total_bound')
                if item.name.startswith('blobs/'):
                    hasher, length = (hashlib.sha256(), 0)
                    with packed.extractfile(item) as raw:
                        for block in iter(lambda: raw.read(1048576), b''):
                            length += len(block)
                            require(length <= item.size, 'image_blob_length')
                            hasher.update(block)
                    require(length == item.size and hasher.hexdigest() == item.name.rsplit('/', 1)[1], 'image_blob_digest')
                    blobs['sha256:' + hasher.hexdigest()] = item
            members[item.name] = item

        def unique_json(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, 'image_json_duplicate')
                result[key] = value
            return result

        def invalid_constant(_value):
            raise Refusal('image_json_constant')

        def json_member(name):
            require(name in members and members[name].isfile() and (members[name].size <= 1048576), 'image_json_bound')
            with packed.extractfile(members[name]) as raw:
                data = raw.read(1048577)
            require(len(data) == members[name].size and len(data) <= 1048576, 'image_json_length')
            try:
                return json.loads(data, object_pairs_hook=unique_json, parse_constant=invalid_constant)
            except (UnicodeError, ValueError):
                raise Refusal('image_json_invalid') from None
        reached, absent = (set(), [])

        def descriptor(value, required=True):
            require(isinstance(value, dict) and 'urls' not in value and ('data' not in value), 'image_descriptor_external')
            require(isinstance(value.get('digest'), str) and re.fullmatch(sha_pattern, value['digest']) and (type(value.get('size')) is int) and (0 < value['size'] <= 134217728) and isinstance(value.get('mediaType'), str), 'image_descriptor')
            identity = value['digest']
            if identity not in blobs:
                require(not required, 'image_selected_blob_missing')
                absent.append(identity)
                return None
            require(blobs[identity].size == value['size'], 'image_descriptor_size')
            reached.add(identity)
            return 'blobs/sha256/' + identity.split(':', 1)[1]
        require(json_member('oci-layout') == {'imageLayoutVersion': '1.0.0'}, 'image_layout_version')
        wrapper = json_member('index.json')
        require(isinstance(wrapper, dict) and type(wrapper.get('schemaVersion')) is int and (wrapper['schemaVersion'] == 2) and (wrapper.get('mediaType') == index_type) and isinstance(wrapper.get('manifests'), list) and (len(wrapper['manifests']) == 1), 'image_index_wrapper')
        root_descriptor = wrapper['manifests'][0]
        root_name = descriptor(root_descriptor)
        require(root_descriptor['digest'] == source_digest and root_descriptor['mediaType'] == index_type, 'image_root_pin')
        root = json_member(root_name)
        require(isinstance(root, dict) and type(root.get('schemaVersion')) is int and (root['schemaVersion'] == 2) and (root.get('mediaType') == index_type) and isinstance(root.get('manifests'), list) and (0 < len(root['manifests']) <= 64), 'image_root_index')
        candidates, references = ([], set())
        for child in root['manifests']:
            require(isinstance(child, dict) and child.get('mediaType') == manifest_type, 'image_nested_or_unknown_manifest')
            require(child.get('digest') not in references, 'image_duplicate_descriptor')
            references.add(child.get('digest'))
            platform = child.get('platform')
            require(isinstance(platform, dict) and isinstance(platform.get('os'), str) and isinstance(platform.get('architecture'), str), 'image_platform_descriptor')
            selected = platform['os'] == 'linux' and platform['architecture'] == 'amd64'
            if selected:
                require(platform.get('variant') in [None, ''], 'image_platform_variant')
                candidates.append(child)
        require(len(candidates) == 1, 'image_ambiguous_platform')
        selected_digest = candidates[0]['digest']
        selected_config, selected_layers, selected_value = (None, None, None)
        for child in root['manifests']:
            selected = child['digest'] == selected_digest
            name = descriptor(child, required=selected)
            if name is None:
                continue
            manifest = json_member(name)
            require(isinstance(manifest, dict) and type(manifest.get('schemaVersion')) is int and (manifest['schemaVersion'] == 2) and (manifest.get('mediaType') == manifest_type) and isinstance(manifest.get('layers'), list) and (0 < len(manifest['layers']) <= 64), 'image_manifest')
            config_descriptor = manifest.get('config')
            config_name = descriptor(config_descriptor)
            require(config_descriptor['mediaType'] == config_type, 'image_config_media')
            config = json_member(config_name)
            require(isinstance(config, dict), 'image_config_object')
            for layer in manifest['layers']:
                descriptor(layer)
            if selected:
                selected_config, selected_layers, selected_value = (config_descriptor, manifest['layers'], config)
        require(set(blobs) == reached, 'image_unreferenced_blob')
        require(selected_value.get('os') == 'linux' and selected_value.get('architecture') == 'amd64' and (selected_value.get('variant') in [None, '']), 'image_config_platform')
        rootfs = selected_value.get('rootfs')
        require(isinstance(rootfs, dict) and rootfs.get('type') == 'layers' and (rootfs.get('diff_ids') == source['RootFS']['Layers']) and (len(selected_layers) == len(rootfs['diff_ids'])), 'image_config_rootfs')
        compatibility = json_member('manifest.json')
        require(isinstance(compatibility, list) and len(compatibility) == 1 and isinstance(compatibility[0], dict), 'image_compatibility_count')
        legacy = compatibility[0]
        require(set(legacy) == {'Config', 'RepoTags', 'Layers'} and legacy['RepoTags'] in [None, []] and (legacy['Config'] == 'blobs/sha256/' + selected_config['digest'].split(':', 1)[1]) and (legacy['Layers'] == ['blobs/sha256/' + layer['digest'].split(':', 1)[1] for layer in selected_layers]), 'image_compatibility_binding')
        expanded_total, expanded_sizes = (0, [])
        for layer, expected_diff in zip(selected_layers, rootfs['diff_ids']):
            require(layer['mediaType'] in [plain_layer, gzip_layer], 'image_layer_media')
            count, hasher = (0, hashlib.sha256())
            with packed.extractfile(blobs[layer['digest']]) as raw:
                stream = gzip.GzipFile(fileobj=raw, mode='rb') if layer['mediaType'] == gzip_layer else raw
                try:
                    for block in iter(lambda: stream.read(1048576), b''):
                        require(count + len(block) <= 268435456 and expanded_total + len(block) <= 536870912, 'image_expanded_bound')
                        count += len(block)
                        expanded_total += len(block)
                        hasher.update(block)
                except (OSError, EOFError, zlib.error):
                    raise Refusal('image_layer_stream_invalid') from None
                finally:
                    if stream is not raw:
                        stream.close()
            require('sha256:' + hasher.hexdigest() == expected_diff, 'image_layer_diff_id')
            expanded_sizes.append(count)
    require(image_archive_stamp(path) == before and digest(path) == checksum, 'image_archive_changed')
    return {'schemaVersion': 1, 'kind': 'bounded_installed_oci_index_to_classic_config_identity', 'sourceIndexDigest': source_digest, 'selectedManifestDigest': selected_digest, 'configDigest': selected_config['digest'], 'platform': {'os': 'linux', 'architecture': 'amd64'}, 'orderedDiffIds': source['RootFS']['Layers'], 'orderedLayerDigests': [layer['digest'] for layer in selected_layers], 'expandedLayerBytes': expanded_sizes, 'expandedBytes': expanded_total, 'archiveSha256': checksum, 'archiveStat': before, 'archiveMembers': len(members), 'presentBlobs': len(blobs), 'allPresentBlobHashesVerified': True, 'selectedLayerDiffIdsIndependentlyVerified': True, 'missingNonselectedDescriptors': absent, 'missingDescriptorsFetched': False, 'auxiliaryProvenanceClaimsVerified': False}

reference='sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402'
template='{"Id":{{json .Id}},"Architecture":{{json .Architecture}},"Os":{{json .Os}},"RootFS":{{json .RootFS}}}'
path=Path('/opt/telomere-pilot/rollout/staging-354fe7af62ea-launch02/clone/cpu-image.tar')
try:
    result=subprocess.run(['/usr/bin/docker','--host','unix:///var/run/docker.sock','image','inspect','--format',template,reference],capture_output=True,text=True,timeout=15,check=True)
    before=json.loads(result.stdout)
    proof=image_archive_identity(path,before,reference)
    result=subprocess.run(['/usr/bin/docker','--host','unix:///var/run/docker.sock','image','inspect','--format',template,reference],capture_output=True,text=True,timeout=15,check=True)
    require(before==json.loads(result.stdout),'image_source_changed')
    print(json.dumps({'result':'verified','remoteReadOnly':True,'sourceIdentity':before,'proof':proof},sort_keys=True))
except BaseException as error:
    reason=str(error) if isinstance(error,Refusal) and re.fullmatch('[a-z_]{1,96}',str(error)) else type(error).__name__
    print(json.dumps({'result':'refused','reason':reason,'remoteReadOnly':True},sort_keys=True))
    raise SystemExit(1)
