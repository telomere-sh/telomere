import hashlib,importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('isolated_daemon',Path(__file__).with_name('gvisor-daemon.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class IsolatedAcceptanceTests(unittest.TestCase):
    def test_fixed_owned_locations_reject_escape_and_short_names(self):
        locations=module.locations('review-20261018')
        self.assertEqual(locations[0].as_posix(),'/run/telomere-audit-review-20261018')
        for value in ('','short','../production','review/../other','UPPERCASE-NAME','review\n20261018'):
            with self.subTest(value=value),self.assertRaises(ValueError):module.locations(value)
    def archive(self,root,members):
        archive=root/'runtime.tar.bz2'
        with tarfile.open(archive,'w:bz2')as tar:
            for name,kind in members:
                item=tarfile.TarInfo(name);item.type=kind
                if kind==tarfile.REGTYPE:item.size=7;tar.addfile(item,io.BytesIO(b'fixture'))
                else:item.linkname='../../outside';tar.addfile(item)
        pins={'archiveSha512':module.digest(archive,'sha512'),'files':[{'path':'runsc','bytes':7,'sha256':hashlib.sha256(b'fixture').hexdigest()}]}
        target=root/'installed';target.mkdir();return archive,target,pins
    def test_authenticates_outer_and_inner_bytes_before_runtime_activation(self):
        with tempfile.TemporaryDirectory()as name:
            a,t,p=self.archive(Path(name),[('runsc',tarfile.REGTYPE)])
            module.install_archive(a,t,p);self.assertEqual((t/'runsc').read_bytes(),b'fixture')
        with tempfile.TemporaryDirectory()as name:
            a,t,p=self.archive(Path(name),[('runsc',tarfile.REGTYPE)]);p['archiveSha512']='0'*128
            with self.assertRaisesRegex(ValueError,'archive checksum'):module.install_archive(a,t,p)
            self.assertEqual(list(t.iterdir()),[])
        with tempfile.TemporaryDirectory()as name:
            a,t,p=self.archive(Path(name),[('runsc',tarfile.REGTYPE)]);p['files'][0]['sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'member checksum'):module.install_archive(a,t,p)
    def test_rejects_paths_links_unknown_duplicates_and_missing_members(self):
        for members in [[('../outside',tarfile.REGTYPE)],[('/outside',tarfile.REGTYPE)],[('runsc',tarfile.SYMTYPE)],
                        [('runsc',tarfile.LNKTYPE)],[('unknown',tarfile.REGTYPE)],[('runsc',tarfile.REGTYPE),('runsc',tarfile.REGTYPE)],[]]:
            with self.subTest(members=members),tempfile.TemporaryDirectory()as name:
                a,t,p=self.archive(Path(name),members)
                with self.assertRaises(ValueError):module.install_archive(a,t,p)
                self.assertFalse((Path(name)/'outside').exists())

if __name__=='__main__':unittest.main()
