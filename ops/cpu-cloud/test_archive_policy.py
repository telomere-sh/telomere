import hashlib,importlib.util,io,json,os,sys,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
import archive_policy as p,cloud,github_store
spec=importlib.util.spec_from_file_location('capacity_ops',Path(__file__).parent.parent/'cpu-launch/mainnet-ops.py')
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
spec=importlib.util.spec_from_file_location('capacity_export',Path(__file__).with_name('export.py'))
export=importlib.util.module_from_spec(spec);spec.loader.exec_module(export)
DATA='backup-20261018T000000Z-1234abcd'
RUNTIME='runtime-'+'a'*40+'-'+'b'*16
def entry(name,size):return {'path':name,'bytes':size,'sha256':'a'*64}

class CapacityTests(unittest.TestCase):
    def test_data_and_runtime_have_distinct_exact_bounds(self):
        for identifier,limit,runtime in ((DATA,p.MAX_DATA_ARCHIVE,False),(RUNTIME,p.MAX_RUNTIME_ARCHIVE,True)):
            cloud.validate_archive_metadata({'id':identifier,'bytes':limit,'sha256':'a'*64},runtime)
            with self.assertRaises(ValueError):cloud.validate_archive_metadata({'id':identifier,'bytes':limit+1,'sha256':'a'*64},runtime)
        self.assertEqual(p.asset_limit(DATA+'.tar.age'),1536*p.MIB)
        self.assertEqual(p.asset_limit(RUNTIME+'.tar.age'),512*p.MIB)
    def test_full_cyst_and_dump_budgets_fit(self):
        files=[entry('cysts/'+format(n,'064x')+'.blob',2*p.MIB) for n in range(512)]+[entry('database.dump',256*p.MIB),entry('snapshot.json',16*p.MIB),entry('configuration/profile',16*p.MIB)]
        proof=p.validate_files(files)
        self.assertEqual(proof['cystBytes'],1024*p.MIB)
        for index in (0,512,513,514):
            larger=[{**f,'bytes':f['bytes']+(1 if i==index else 0)} for i,f in enumerate(files)]
            with self.assertRaises(ValueError):p.validate_files(larger)
    def test_unsafe_duplicate_or_unbounded_metadata_rejected(self):
        for files in ([entry('../outside',1)],[entry('same',1)]*2,[entry('cysts/invalid',17)],[entry('database.dump',True)],[entry('x',1)]*50000):
            with self.assertRaises(ValueError):p.validate_files(files)
    def test_github_rejects_oversize_before_any_network(self):
        with patch.object(github_store.GitHubStore,'api',return_value={'private':True}):
            store=github_store.GitHubStore('fixture/fixture','fixture')
        for identifier,limit in ((DATA,p.MAX_DATA_ARCHIVE),(RUNTIME,p.MAX_RUNTIME_ARCHIVE)):
            with tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/(identifier+'.tar.age')
                with path.open('wb') as output:output.truncate(limit+1)
                with patch.object(store,'assets') as network:
                    with self.assertRaises(ValueError):store.upload({},path)
                    network.assert_not_called()
                with self.assertRaises(ValueError):store.download({'name':path.name,'size':limit+1,'id':1},Path(folder)/'out','a'*64)
    @unittest.skipUnless(hasattr(os,'O_NOFOLLOW'),'POSIX file descriptor safety')
    def test_export_accepts_exact_limit_and_refuses_one_extra_byte(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve()
            with patch.object(export,'BACKUPS',root):
                for identifier,limit in ((DATA,p.MAX_DATA_ARCHIVE),(RUNTIME,p.MAX_RUNTIME_ARCHIVE)):
                    path=root/(identifier+'.tar.age')
                    with path.open('wb') as output:output.truncate(limit)
                    stream,size=export.open_archive(identifier);self.assertEqual(size,limit);stream.close()
                    with path.open('ab') as output:output.write(b'x')
                    with self.assertRaises(ValueError):export.open_archive(identifier)
                    path.unlink()
    def test_oversize_cipher_is_never_published_and_partial_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);output=root/(DATA+'.tar.age');output.write_bytes(b'previous')
            def oversized(arguments,**kwargs):
                with Path(arguments[arguments.index('-o')+1]).open('wb') as target:target.truncate(p.MAX_DATA_ARCHIVE+1)
            with patch.object(ops.subprocess,'run',side_effect=oversized):
                with self.assertRaises(AssertionError):ops.encrypt_archive(root/'archive',root/'recipient',output,DATA)
            self.assertEqual(output.read_bytes(),b'previous');self.assertFalse((root/(DATA+'.partial')).exists())
    def test_restored_cysts_match_references_and_reject_corruption_or_missing_ready(self):
        owner='0x'+'1'*40;content=b'checked encrypted checkpoint';checksum=hashlib.sha256(content).hexdigest()
        name='cysts/'+hashlib.sha256(('telomere-cyst-blob:'+owner+':'+checksum).encode()).hexdigest()+'.blob'
        reference={'owner':owner,'sha256':checksum,'ciphertext_bytes':len(content),'state':'ready'}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for case,payload in [('valid',content),('corrupt',b'x'*len(content)),('missing',None)]:
                archive=root/(case+'.tar')
                with tarfile.open(archive,'w') as target:
                    if payload is not None:
                        info=tarfile.TarInfo(name);info.size=len(payload);target.addfile(info,io.BytesIO(payload))
                with tarfile.open(archive) as source:
                    if case=='valid':self.assertEqual(p.restore_cysts(source,{'references':[reference]},root/case)['bytes'],len(content))
                    else:
                        with self.assertRaises(ValueError):p.restore_cysts(source,{'references':[reference]},root/case)

if __name__=='__main__':unittest.main()
