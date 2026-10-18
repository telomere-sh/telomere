import hashlib, importlib.util, io, json, shutil, tarfile, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rehearsal', Path(__file__).with_name('restore-rehearsal.py'))
rehearsal = importlib.util.module_from_spec(spec); spec.loader.exec_module(rehearsal)

class ArchiveBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.root = Path(self.temporary.name)
        self.cipher = self.root / 'fixture.age'; self.cipher.write_bytes(b'fixture cipher')
        self.checksum = hashlib.sha256(self.cipher.read_bytes()).hexdigest()
        self.archive = self.root / 'fixture.tar'; self.target = self.root / 'unpacked'
    def tearDown(self): self.temporary.cleanup()
    def fixture(self, name='release/app.js', content=b'checked', kind=tarfile.REGTYPE, duplicate=False, **overrides):
        entry = {'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(), **overrides}
        manifest = json.dumps({'id': 'backup-20261018T000000Z-1234abcd', 'files': [entry]}).encode()
        with tarfile.open(self.archive, 'w') as output:
            metadata = tarfile.TarInfo('manifest.json'); metadata.size = len(manifest); output.addfile(metadata, io.BytesIO(manifest))
            member = tarfile.TarInfo(name); member.type = kind
            if kind == tarfile.REGTYPE: member.size = len(content)
            else: member.linkname = '/private/material'
            output.addfile(member, io.BytesIO(content) if kind == tarfile.REGTYPE else None)
            if duplicate: output.addfile(member, io.BytesIO(content))
    def unpack(self):
        def decrypt(arguments, **_): shutil.copyfile(self.archive, arguments[arguments.index('-o') + 1])
        with patch.object(rehearsal, 'run', side_effect=decrypt):
            return rehearsal.unpack(self.cipher, self.checksum, b'fixture identity', self.target)
    def test_verified_regular_member_round_trip(self):
        self.fixture(); result = self.unpack()
        self.assertEqual(result['id'], 'backup-20261018T000000Z-1234abcd'); self.assertEqual((self.target / 'release/app.js').read_bytes(), b'checked')
        self.assertFalse((self.root / 'unpacked.plain').exists())
    def test_ciphertext_changed_before_decryption(self):
        self.fixture(); self.cipher.write_bytes(b'changed')
        with self.assertRaises(ValueError): self.unpack()
    def test_traversal_and_absolute_paths(self):
        for name in ('../outside', '/outside', 'release/../../outside', 'release\\outside'):
            self.fixture(name=name)
            with self.assertRaises(ValueError): self.unpack()
        self.assertFalse((self.root / 'outside').exists())
    def test_symlinks_and_hardlinks(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            self.fixture(kind=kind)
            with self.assertRaises(ValueError): self.unpack()
    def test_duplicate_members(self):
        self.fixture(duplicate=True)
        with self.assertRaises(ValueError): self.unpack()
    def test_file_checksum(self):
        self.fixture(sha256='0' * 64)
        with self.assertRaises(ValueError): self.unpack()
    def test_file_size(self):
        self.fixture(bytes=500)
        with self.assertRaises(ValueError): self.unpack()
    def test_expanded_size_limit(self):
        self.fixture(bytes=3 * 1024**3)
        with self.assertRaises(ValueError): self.unpack()
    def test_untrusted_proxy_origin_cannot_inject_privileged_nginx_configuration(self):
        for origin in ('http://127.0.0.1:80; } } include /private/file;', 'http://127.0.0.1:65536',
                       'https://attacker.invalid:443', 'http://localhost:3282', 'http://127.0.0.1:3282/path', None):
            with patch.object(rehearsal,'run') as command:
                with self.assertRaises(ValueError): rehearsal.proxy_rehearsal(self.root,self.root,origin)
                command.assert_not_called()

if __name__ == '__main__': unittest.main()
