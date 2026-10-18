import hashlib,importlib.util,io,tarfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('forge_installer',Path(__file__).with_name('install-forge.py'))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)

def fixture(extra=False,link=False):
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w:gz')as tar:
        for name,value in [('package/package.json',b'{}'),('package/bin/forge',b'fixture')]+([('../outside',b'x')]if extra else[]):
            info=tarfile.TarInfo(name)
            if link and name.endswith('/forge'):info.type=tarfile.SYMTYPE;info.linkname='/outside';tar.addfile(info)
            else:info.size=len(value);tar.addfile(info,io.BytesIO(value))
    data=buffer.getvalue();return data,{'sha256':hashlib.sha256(data).hexdigest(),'member':'package/bin/forge',
      'binaryBytes':7,'binarySha256':hashlib.sha256(b'fixture').hexdigest()}
class ForgePinTests(unittest.TestCase):
    def test_exact_archive_and_binary(self):
        data,pin=fixture();self.assertEqual(installer.extract_binary(data,pin),b'fixture')
    def test_rejects_outer_inner_and_size_changes(self):
        data,pin=fixture()
        for change in [{'sha256':'0'*64},{'binarySha256':'0'*64},{'binaryBytes':8}]:
            with self.subTest(change=change),self.assertRaises(ValueError):installer.extract_binary(data,{**pin,**change})
    def test_rejects_extra_paths_and_link_members(self):
        for options in [{'extra':True},{'link':True}]:
            data,pin=fixture(**options)
            with self.subTest(options=options),self.assertRaises(ValueError):installer.extract_binary(data,pin)
