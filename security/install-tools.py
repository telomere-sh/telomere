"""Install only checksum-pinned scanner binaries; never execute a downloaded installer."""
from pathlib import Path
import hashlib
import io
import json
import os
import platform
import tarfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def install():
    pins = json.loads((ROOT / 'security/tools.json').read_text(encoding='utf-8'))
    selected = ('win32' if os.name == 'nt' else 'linux') + '-x64'
    if platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('The reviewed native scanner pins cover x86_64 only')
    target = ROOT / '.local/security-bin'
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.is_symlink():
        raise RuntimeError('Scanner output directory is a link')
    for name in ('gitleaks', 'solc'):
        pin = pins[name][selected]
        parsed = urllib.parse.urlparse(pin['url'])
        if parsed.scheme != 'https' or parsed.hostname not in ('github.com', 'raw.githubusercontent.com'):
            raise RuntimeError('Unreviewed scanner origin')
        with urllib.request.urlopen(pin['url'], timeout=60) as response:
            archive = response.read(64 * 1024 * 1024 + 1)
        if len(archive) > 64 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != pin['sha256']:
            raise RuntimeError('Scanner artifact checksum differs: ' + name)
        if 'member' not in pin:
            binary = archive
        elif selected.startswith('win32'):
            with zipfile.ZipFile(io.BytesIO(archive)) as source:
                member = source.getinfo(pin['member'])
                if member.is_dir() or member.file_size > 64 * 1024 * 1024:
                    raise RuntimeError('Invalid scanner archive member')
                binary = source.read(member)
        else:
            with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
                member = source.getmember(pin['member'])
                if not member.isfile() or member.size > 64 * 1024 * 1024:
                    raise RuntimeError('Invalid scanner archive member')
                handle = source.extractfile(member)
                if handle is None:
                    raise RuntimeError('Scanner member missing')
                binary = handle.read()
        output = target / (name + ('.exe' if os.name == 'nt' else ''))
        if output.is_symlink():
            raise RuntimeError('Scanner output is a link')
        temporary = output.with_suffix('.new')
        if temporary.exists() or temporary.is_symlink():
            raise RuntimeError('Unexpected scanner staging file')
        temporary.write_bytes(binary)
        temporary.chmod(0o755)
        temporary.replace(output)
        print(json.dumps({'tool': name, 'version': pins[name]['version'], 'artifactSha256': pin['sha256'], 'installed': True}))


if __name__ == '__main__':
    install()
