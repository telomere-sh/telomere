"""Verify one already pushed private acceptance image. Never rebuild or restart.

Usage: python3 VERIFY /absolute/path/to/exact-executed-attempt03-builder.py
Writes only WORK/image-verification.json; all Docker calls are read-only.
The failed03 record remains failed and byte-identical. No HTTP manifest success
is implied by the independent stored-blob and cached-image proof below.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys

WORK = pathlib.Path('/opt/telomere-host-runtime/declared-state-gvisor-20261015')
CONTEXT = WORK / 'image-context-final'
BLOBS = pathlib.Path('/opt/telomere-host-runtime/declared-state-registry-attempt03-20261015/data/docker/registry/v2/blobs/sha256')
BUILDER_SHA = '07a64947271d4af2277ce1e11e1e04ca7e36ca395dadbe32faac1a8f2e767859'
REVISION = 'd4481aec92179df44a533699897db2f523fbd0a2'
ARCHIVE_SHA = '090932a350a522ddfe2c056775edf194176060c3cca79a06d286e5d3f1989bd6'
IMAGE_ID = 'sha256:5fbba0e35a485f0de44263330354a8325c84a2a39a64661c6bfc15239c16b58d'
MANIFEST_DIGEST = 'sha256:db091765b34bac310fa2fa6284d59abe97f294e5d2a800946c38f46e46f31eea'
IMAGE = '127.0.0.1:15004/telomere-declared-state@' + MANIFEST_DIGEST
MAX_BLOBS = 512 * 1024 * 1024


class Refusal(Exception):
    pass


def require(value):
    if not value:
        raise Refusal('Stored acceptance image verification refused')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    def constant(_value):
        raise Refusal('Non-finite JSON refused')
    return json.loads(data.decode('utf-8', errors='strict'), object_pairs_hook=pairs, parse_constant=constant)


def stable_file(path, maximum, allowed_uids, capture=False, allow_empty=False):
    require(path.is_absolute() and path.resolve() == path)
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink())
    named = path.lstat()
    require(stat.S_ISREG(named.st_mode) and not path.is_symlink() and named.st_nlink == 1
            and named.st_uid in allowed_uids and (0 if allow_empty else 1) <= named.st_size <= maximum
            and not named.st_mode & 0o022)
    signature = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    digest, collected, count = hashlib.sha256(), [], 0
    try:
        require(signature(os.fstat(fd)) == signature(named))
        with os.fdopen(fd, 'rb', closefd=False) as source:
            while True:
                block = source.read(min(131072, maximum - count + 1))
                if not block:
                    break
                count += len(block)
                require(count <= maximum)
                digest.update(block)
                if capture:
                    collected.append(block)
        require(count == named.st_size and signature(os.fstat(fd)) == signature(named)
                and signature(path.lstat()) == signature(named))
    finally:
        os.close(fd)
    return {'bytes': count, 'sha256': digest.hexdigest()}, b''.join(collected) if capture else None


def blob(descriptor, maximum, capture=False):
    require(isinstance(descriptor, dict) and re.fullmatch('sha256:[a-f0-9]{64}', descriptor.get('digest', ''))
            and type(descriptor.get('size')) is int and 0 < descriptor['size'] <= maximum
            and 'urls' not in descriptor and 'data' not in descriptor)
    digest = descriptor['digest'][7:]
    proof, data = stable_file(BLOBS / digest[:2] / digest / 'data', maximum, {0, 65534}, capture)
    require(proof['sha256'] == digest and proof['bytes'] == descriptor['size'])
    return proof, data


def source_manifest(builder, source, expected):
    builder.private_directory(source)
    builder.private_directory(source / '.local')
    require(source.is_relative_to(WORK.parent) and source != WORK)
    manifest_bytes = builder.private_file(source / '.local/source-manifest.json', 1_048_576)
    manifest = strict_json(manifest_bytes)
    require(manifest['source'] == 'committed_git_blobs_only' and manifest['workingTreeIncluded'] is False
            and manifest['gitRevision'] == REVISION and manifest['archiveSha256'] == ARCHIVE_SHA
            and sha(manifest_bytes) == expected and len(manifest['files']) == 708)
    seen = set()
    for item in manifest['files']:
        name = item['path']; parts = pathlib.PurePosixPath(name)
        require(isinstance(name, str) and '\\' not in name and not parts.is_absolute() and '..' not in parts.parts and str(parts) == name
                and not any(part in ('.git', '.local', 'node_modules', '.env') for part in parts.parts) and name not in seen
                and type(item['bytes']) is int and 0 <= item['bytes'] <= 64 * 1024 * 1024)
        seen.add(name)
        actual, _ = stable_file(source / name, max(item['bytes'], 1), {0}, allow_empty=True)
        require(actual == {'bytes': item['bytes'], 'sha256': item['sha256']})
    return manifest_bytes


def main(argv):
    require(len(argv) == 1 and os.getuid() == 0)
    helper = pathlib.Path(argv[0])
    helper_proof, helper_bytes = stable_file(helper, 131_072, {0}, True)
    require(helper_proof['sha256'] == BUILDER_SHA)
    # Execute declarations under a non-main name; the frozen builder has no
    # import-time effects. Disable bytecode output even for standard imports.
    sys.dont_write_bytecode = True
    namespace = {'__name__': 'reviewed_image_builder', '__file__': str(helper)}
    exec(compile(helper_bytes, str(helper), 'exec'), namespace)
    class Builder:
        pass
    builder = Builder()
    for key, value in namespace.items():
        setattr(builder, key, value)
    builder.private_directory(WORK)
    output = WORK / 'image-verification.json'
    require(not output.exists() and not output.is_symlink())
    failed_bytes = builder.private_file(WORK / 'image-build-attempt03.json', 65_536)
    failed = strict_json(failed_bytes)
    require(failed['success'] is False and failed['status'] == 'failed' and failed['failureType'] == 'Refusal'
            and failed['failureStage'] == 'image_push' and 'postflightFailureType' not in failed
            and not any(key.endswith('FailureType') for key in failed)
            and not any(key.lower().endswith('timedout') for key in failed)
            and 'registryServiceCleanupFailureType' not in failed and 'registryServiceLogFailureType' not in failed
            and 'extractionCleanupFailureType' not in failed
            and failed['registryCleanupConfirmed'] is True and failed['registryServiceCleanupConfirmed'] is True
            and failed['extractionContainerCleanupConfirmed'] is True
            and failed['gitRevision'] == REVISION and failed['archiveSha256'] == ARCHIVE_SHA
            and failed['image'] == IMAGE and failed['imageId'] == IMAGE_ID and failed['manifestDigest'] == MANIFEST_DIGEST
            and failed['sourceFilesVerified'] == failed['sourceFilesVerifiedAfter'] == 708
            and failed['servicesBefore'] == failed['servicesAfter']
            and failed['profileBeforeSha256'] == failed['profileAfterSha256']
            and failed['protectedBeforeSha256'] == failed['protectedAfterSha256']
            and failed['ownedContainersBefore'] == failed['ownedContainersAfter'] == [builder.PROTECTED]
            and failed['globalContainersBefore'] == failed['globalContainersAfter']
            and failed['daemonBefore'] == failed['daemonAfter'])
    require(failed['publicTransactions'] == failed['paidProviderRequests'] == failed['publicNetworkRequests'] == 0
            and failed['stagingServiceMutations'] is False)
    source = pathlib.Path(failed['sourceDirectory'])
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(WORK), 'LANG': 'C.UTF-8'}
    report = {'schemaVersion': 1, 'status': 'verifying', 'success': False,
              'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'scope': 'stored_blob_and_cached_image_identity_only', 'initialHttpManifestVerificationFailed': True,
              'httpManifestVerificationPassed': False, 'failedAttempt03ReportSha256': sha(failed_bytes),
              'executedBuilderSha256': BUILDER_SHA, 'image': IMAGE, 'imageId': IMAGE_ID,
              'manifestDigest': MANIFEST_DIGEST, 'gitRevision': REVISION, 'archiveSha256': ARCHIVE_SHA,
              'publicTransactions': 0, 'paidProviderRequests': 0, 'registryHttpRequests': 0,
              'stagingServiceMutations': False, 'dockerWrites': 0}
    for key in ['sourceDirectory', 'sourceManifestSha256', 'sourceFilesVerified', 'cjsSha256', 'cjsBytes',
                'captureCjsSha256', 'captureCjsBytes', 'dockerfileSha256', 'prepareSha256', 'baseImage', 'baseImageId',
                'registryImage', 'registryImageId', 'registryCleanupConfirmed', 'registryServiceCleanupConfirmed',
                'extractionContainerCleanupConfirmed']:
        report[key] = failed[key]
    success = False
    try:
        report['servicesBefore'], report['profileBeforeSha256'] = builder.services(environment), builder.profile_hash()
        report['protectedBeforeSha256'], report['daemonBefore'] = builder.protected_hash(environment), builder.daemon_identity(environment)
        report['ownedContainersBefore'], report['globalContainersBefore'] = builder.container_ids(environment), builder.container_ids(environment, builder.GLOBAL_DOCKER)
        report['healthBefore'] = builder.health()
        require(report['servicesBefore'] == failed['servicesAfter'] and report['profileBeforeSha256'] == failed['profileAfterSha256']
                and report['protectedBeforeSha256'] == failed['protectedAfterSha256'] and report['daemonBefore'] == failed['daemonAfter']
                and report['ownedContainersBefore'] == failed['ownedContainersAfter'] and report['globalContainersBefore'] == failed['globalContainersAfter'])
        builder.registry_service_identity(environment, failed['registryServiceDescription'], failed['registryBinarySha256'],
                                         failed['registryConfigSha256'], allow_absent=True, verify_live_namespace=False)
        builder.registry_uid_idle()
        manifest_bytes = source_manifest(builder, source, failed['sourceManifestSha256'])
        dockerfile = builder.private_file(CONTEXT / 'Dockerfile', 4096)
        context = builder.image_context(CONTEXT, failed['cjsSha256'], failed['captureCjsSha256'], dockerfile)
        require(sha(dockerfile) == failed['dockerfileSha256'] and dockerfile == (source / 'infra/host-kit/Dockerfile.declared-state').read_bytes())
        proof, data = stable_file(BLOBS / MANIFEST_DIGEST[7:9] / MANIFEST_DIGEST[7:] / 'data', 65_536, {0, 65534}, True)
        require(proof['sha256'] == MANIFEST_DIGEST[7:])
        manifest = strict_json(data)
        require(manifest['schemaVersion'] == 2 and manifest['mediaType'] == 'application/vnd.docker.distribution.manifest.v2+json'
                and 'manifests' not in manifest and manifest['config']['digest'] == IMAGE_ID and len(manifest['layers']) == 7)
        require(manifest['config']['mediaType'] == 'application/vnd.docker.container.image.v1+json')
        config_proof, config_data = blob(manifest['config'], 262_144, True)
        config = strict_json(config_data)
        require(config['os'] == 'linux' and config['architecture'] == 'amd64' and config['rootfs']['type'] == 'layers'
                and len(config['rootfs']['diff_ids']) == 7
                and all(re.fullmatch('sha256:[a-f0-9]{64}', x) for x in config['rootfs']['diff_ids']))
        total = 0; layers = []
        for descriptor in manifest['layers']:
            require(descriptor['mediaType'] == 'application/vnd.docker.image.rootfs.diff.tar.gzip')
            total += descriptor['size']; require(total <= MAX_BLOBS)
            layer_proof, _ = blob(descriptor, MAX_BLOBS)
            layers.append({'digest': descriptor['digest'], 'bytes': layer_proof['bytes'], 'sha256': layer_proof['sha256']})
        cached = builder.json_command(builder.DOCKER + ['image', 'inspect', IMAGE], environment)
        require(len(cached) == 1 and cached[0]['Id'] == IMAGE_ID and IMAGE in cached[0]['RepoDigests']
                and cached[0]['Os'] == 'linux' and cached[0]['Architecture'] == 'amd64'
                and cached[0]['RootFS']['Type'] == 'layers' and cached[0]['RootFS']['Layers'] == config['rootfs']['diff_ids'])
        report['registryManifestVerified'] = {**proof, 'schemaVersion': 2, 'configDigest': IMAGE_ID, 'method': 'stored_blob_sha256_not_http'}
        report['configBlobVerified'] = config_proof
        report['layerBlobsVerified'], report['compressedLayerBytes'] = layers, total
        report['cachedRepoDigestVerified'] = True
        report['layerProofBoundary'] = 'compressed_digest_size_and_hashed_config_vs_cached_RootFS; no_independent_decompression'
        require(source_manifest(builder, source, failed['sourceManifestSha256']) == manifest_bytes)
        require(builder.image_context(CONTEXT, failed['cjsSha256'], failed['captureCjsSha256'], dockerfile) == context)
        require(stable_file(BLOBS / MANIFEST_DIGEST[7:9] / MANIFEST_DIGEST[7:] / 'data', 65_536, {0, 65534})[0] == proof
                and blob(manifest['config'], 262_144)[0] == config_proof)
        for descriptor, original in zip(manifest['layers'], layers):
            require(blob(descriptor, MAX_BLOBS)[0] == {'bytes': original['bytes'], 'sha256': original['sha256']})
        require(stable_file(helper, 131_072, {0})[0] == helper_proof
                and builder.private_file(WORK / 'image-build-attempt03.json', 65_536) == failed_bytes
                and sha(builder.private_file(WORK / 'prepare.json', 65_536)) == failed['prepareSha256'])
        report['sourceFilesVerifiedAfter'] = 708
        success = True
    except BaseException as error:
        report['failureType'] = type(error).__name__
    finally:
        try:
            report['servicesAfter'], report['profileAfterSha256'] = builder.services(environment), builder.profile_hash()
            report['protectedAfterSha256'], report['daemonAfter'] = builder.protected_hash(environment), builder.daemon_identity(environment)
            report['ownedContainersAfter'], report['globalContainersAfter'] = builder.container_ids(environment), builder.container_ids(environment, builder.GLOBAL_DOCKER)
            report['healthAfter'] = builder.health()
            require(report['servicesAfter'] == report['servicesBefore'] and report['profileAfterSha256'] == report['profileBeforeSha256']
                    and report['protectedAfterSha256'] == report['protectedBeforeSha256'] and report['daemonAfter'] == report['daemonBefore']
                    and report['ownedContainersAfter'] == report['ownedContainersBefore'] and report['globalContainersAfter'] == report['globalContainersBefore'])
        except BaseException as error:
            report['postflightFailureType'] = type(error).__name__; success = False
        report['success'] = bool(success)
        report['status'] = 'accepted' if success else 'failed'
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        builder.persist(output, report)
        print(json.dumps(report, separators=(',', ':')))
    return 0 if success else 1


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        print(json.dumps({'schemaVersion': 1, 'success': False, 'status': 'refused_before_image_verification',
                          'failureType': type(error).__name__}, separators=(',', ':')))
        sys.exit(1)
