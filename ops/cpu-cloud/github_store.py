"""Private GitHub release storage; ciphertext only, no financial execution."""
import hashlib, http.client, json, os, re, time, urllib.error, urllib.parse, urllib.request
from archive_policy import asset_limit,TRANSFER_SECONDS


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(part)
    return result.hexdigest()


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, location):
        destination = urllib.parse.urlparse(location)
        if destination.scheme != 'https' or not (destination.hostname == 'api.github.com' or destination.hostname.endswith('.githubusercontent.com')):
            raise RuntimeError('Untrusted release download redirect')
        redirected = super().redirect_request(request, response, code, message, headers, location)
        if destination.hostname != urllib.parse.urlparse(request.full_url).hostname:
            redirected.remove_header('Authorization')
        return redirected


class GitHubStore:
    def __init__(self, repository, token):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
            raise ValueError('Invalid repository')
        self.repository = repository
        self.prefix = '/repos/' + repository
        self.headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Telomere-private-operations'}
        self.opener = urllib.request.build_opener(SafeRedirect())
        metadata = self.api(self.prefix)
        if metadata.get('private') is not True:
            raise RuntimeError('Backup destination must be private')

    def api(self, path, method='GET', body=None, missing=False):
        resource, _, query = path.partition('?')
        if not (resource == self.prefix or resource.startswith(self.prefix + '/')) or (query and not re.fullmatch(r'per_page=100&page=[1-9][0-9]?', query)):
            raise ValueError('Unexpected API resource')
        request = urllib.request.Request('https://api.github.com' + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={**self.headers, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(4 * 1024**2 + 1)
                if len(raw) > 4 * 1024**2:
                    raise RuntimeError('API response exceeded limit')
                return json.loads(raw or b'{}')
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise RuntimeError('GitHub API HTTP ' + str(error.code)) from None

    def release(self, tag, metadata):
        if not re.fullmatch(r'[A-Za-z0-9-]{1,150}', tag):
            raise ValueError('Invalid operations tag')
        found = self.api(self.prefix + '/releases/tags/' + tag, missing=True)
        if found:
            if json.loads(found['body']).get('kind') != metadata['kind']:
                raise RuntimeError('Unrelated release at operations tag')
            return found
        return self.api(self.prefix + '/releases', 'POST', {'tag_name': tag, 'name': tag,
            'body': json.dumps(metadata), 'draft': False, 'prerelease': True})

    def assets(self, release):
        assets = self.api(self.prefix + '/releases/' + str(release['id']) + '/assets')
        if len(assets) >= 30:
            raise RuntimeError('Unexpected release asset count')
        return assets

    def download(self, asset, target, checksum):
        if not re.fullmatch(r'[0-9a-f]{64}', checksum) or type(asset['size']) is not int or not 0 < asset['size'] <= asset_limit(asset.get('name','')):
            raise ValueError('Invalid asset metadata')
        path = self.prefix + '/releases/assets/' + str(int(asset['id']))
        request = urllib.request.Request('https://api.github.com' + path,
            headers={**self.headers, 'Accept': 'application/octet-stream'})
        count = 0;deadline=time.monotonic()+TRANSFER_SECONDS
        with self.opener.open(request, timeout=90) as response, target.open('xb') as output:
            while part := response.read(1024 * 1024):
                if time.monotonic()>deadline:raise RuntimeError('Release download deadline')
                count += len(part)
                if count > asset['size']:
                    raise RuntimeError('Release download exceeded reviewed size')
                output.write(part)
        if count != asset['size'] or digest(target) != checksum:
            raise RuntimeError('Stored backup checksum differs')

    def upload(self, release, path):
        name = path.name
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,180}', name):
            raise ValueError('Invalid asset name')
        if not 0<path.stat().st_size<=asset_limit(name):raise ValueError('Asset exceeds scoped capacity')
        expected = digest(path)
        found = next((item for item in self.assets(release) if item['name'] == name), None)
        if found:
            if found['size'] != path.stat().st_size or found.get('digest') != 'sha256:' + expected:
                raise RuntimeError('Existing immutable asset differs')
            return found
        url = urllib.parse.urlparse(release['upload_url'].split('{', 1)[0])
        if url.scheme != 'https' or url.hostname != 'uploads.github.com':
            raise RuntimeError('Untrusted release upload host')
        connection = http.client.HTTPSConnection(url.hostname, timeout=120)
        try:
            connection.putrequest('POST', url.path + '?name=' + urllib.parse.quote(name))
            for key, value in {**self.headers, 'Content-Type': 'application/octet-stream',
                'Content-Length': str(path.stat().st_size)}.items():
                connection.putheader(key, value)
            connection.endheaders()
            deadline=time.monotonic()+TRANSFER_SECONDS
            with path.open('rb') as stream:
                for part in iter(lambda: stream.read(1024 * 1024), b''):
                    if time.monotonic()>deadline:raise RuntimeError('Release upload deadline')
                    connection.send(part)
            response = connection.getresponse()
            if response.status != 201:
                raise RuntimeError('GitHub upload HTTP ' + str(response.status))
            asset = json.loads(response.read(1024 * 1024))
            if asset['size'] != path.stat().st_size or asset.get('digest') != 'sha256:' + expected:
                raise RuntimeError('Uploaded asset digest differs')
            return asset
        finally:
            connection.close()

    def state(self):
        release = self.release('ops-delivery-state-v1', {'kind': 'telomere-ops-delivery-state', 'state': {}})
        return release, json.loads(release['body'])['state']

    def save_state(self, release, value):
        self.api(self.prefix + '/releases/' + str(release['id']), 'PATCH',
            {'body': json.dumps({'kind': 'telomere-ops-delivery-state', 'state': value})})

    def prune_snapshots(self):
        releases = []
        for page in range(1, 21):
            batch = self.api(self.prefix + '/releases?per_page=100&page=' + str(page))
            releases.extend(batch)
            if len(batch) < 100:
                break
        else:
            raise RuntimeError('Incomplete retention inventory; refusing deletion')
        snapshots = []
        for release in releases:
            if not re.fullmatch(r'backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}', release['tag_name']):
                continue
            metadata = json.loads(release['body'])
            if metadata.get('kind') != 'telomere-cpu-data-backup' or metadata.get('id') != release['tag_name']:
                raise RuntimeError('Unexpected backup release provenance')
            snapshots.append(release)
        snapshots.sort(key=lambda value: value['tag_name'], reverse=True)
        keep = {item['id'] for item in snapshots[:24]}
        days = set()
        for item in snapshots[24:]:
            day = item['tag_name'][7:15]
            if day not in days and len(days) < 7:
                days.add(day)
                keep.add(item['id'])
        removed = 0
        for item in snapshots:
            if item['id'] not in keep:
                self.api(self.prefix + '/releases/' + str(item['id']), 'DELETE')
                removed += 1
        return {'retentionApplied': True, 'snapshotsKept': len(keep), 'snapshotsRemoved': removed}
