import importlib.util,json,tempfile,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('gvisor_runtime',Path(__file__).with_name('gvisor-runtime.py'))
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)

class CompleteRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.source=self.root/'source'
        (self.source/'gvisor-bin').mkdir(parents=True)
        for name in ('runsc','gvisor-bin/gvisor_sentry','gvisor-bin/runsc-fd-parking'):
            path=self.source/name;path.write_text(name);path.chmod(0o755)
    def tearDown(self):self.tmp.cleanup()
    def capture(self):
        self.medium=self.root/'medium';self.descriptor=runtime.capture_supplement(self.medium,self.source)
    def test_complete_distribution_survives_capture_verify_install(self):
        self.capture();runtime.verify_supplement(self.medium,self.descriptor,self.source/'runsc')
        destination=self.root/'installed';self.assertEqual(runtime.install(self.medium,destination),3)
        for path in self.source.rglob('*'):
            if path.is_file():self.assertEqual(path.read_bytes(),(destination/path.relative_to(self.source)).read_bytes())
    def test_incomplete_source_rejected(self):
        (self.source/'gvisor-bin/gvisor_sentry').unlink()
        with self.assertRaises(AssertionError):runtime.entries(self.source)
    def test_modified_sidecar_rejected(self):
        self.capture();(self.medium/'binaries/gvisor/gvisor-bin/gvisor_sentry').write_text('tampered')
        with self.assertRaises(AssertionError):runtime.verify_supplement(self.medium,self.descriptor,self.source/'runsc')
    def test_unbound_runsc_rejected(self):
        self.capture();(self.source/'runsc').write_text('different build')
        with self.assertRaises(AssertionError):runtime.verify_supplement(self.medium,self.descriptor,self.source/'runsc')
    def test_manifest_change_rejected(self):
        self.capture();(self.medium/'manifest.json').write_text('{}')
        with self.assertRaises(AssertionError):runtime.verify_supplement(self.medium,self.descriptor,self.source/'runsc')
    def test_symlink_source_rejected(self):
        (self.source/'gvisor-bin/link').symlink_to(self.source/'runsc')
        with self.assertRaises(AssertionError):runtime.entries(self.source)
    def test_writable_source_rejected(self):
        (self.source/'runsc').chmod(0o777)
        with self.assertRaises(AssertionError):runtime.entries(self.source)
    def test_extra_unmanifested_file_rejected(self):
        self.capture();(self.medium/'binaries/unlisted').write_text('x')
        with self.assertRaises(AssertionError):runtime.verify_supplement(self.medium,self.descriptor,self.source/'runsc')

if __name__=='__main__':unittest.main()
