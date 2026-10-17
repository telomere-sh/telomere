import hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('clean_server',Path(__file__).with_name('clean-server-recovery.py'))
recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)
class RecoveryPlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.data_dir=self.root/'data';self.runtime_dir=self.root/'runtime'
        (self.data_dir/'configuration').mkdir(parents=True);(self.runtime_dir/'release/dist').mkdir(parents=True)
        self.release='a'*40;self.hash=hashlib.sha256(b'reviewed source').hexdigest();(self.runtime_dir/'release/dist/app.js').write_bytes(b'reviewed source')
        self.expected={'releaseId':self.release,'releaseDirectory':'/opt/telomere-mainnet-pilot/releases/'+self.release,
            'runtimePins':[{'path':'dist/app.js','sha256':self.hash}]}
        (self.data_dir/'configuration/expected.json').write_text(json.dumps(self.expected))
        (self.data_dir/'configuration/mainnet.env').write_text('CPU_IMAGE=node@sha256:'+'b'*64+'\n')
        (self.data_dir/'snapshot.json').write_text(json.dumps({'fingerprints':[{'table':'jobs','sha256':'c'*64,'rows':3}],'chainCursor':{'chainId':8453}}))
        self.bundle={'id':'runtime-'+self.release+'-'+'d'*16,'sha256':'e'*64,'runtimePinsVerified':1}
        self.receipt={'id':'backup-20261017T210333Z-b874c46d','runtimeBundle':self.bundle}
        self.data={'kind':'mainnet-cpu-encrypted-backup','chainId':8453,'id':self.receipt['id'],'runtimeBundle':self.bundle,
            'restoreRehearsal':{'databaseImage':'postgres@sha256:'+'f'*64}}
        self.runtime={'kind':'exact-reviewed-runtime','id':self.bundle['id'],'files':[{'path':'release/dist/app.js','sha256':self.hash}]}
    def tearDown(self):self.tmp.cleanup()
    def validate(self):return recovery.validate_pair(self.data,self.runtime,self.receipt,self.data_dir,self.runtime_dir)
    def test_bound_pair_produces_nonactivating_ordered_plan(self):
        expected,snapshot,pg,cpu=self.validate();plan=recovery.install_plan(expected,snapshot,pg,cpu,self.root)
        self.assertFalse(plan['activationExecuted']);self.assertEqual(plan['mainnetTransactions'],0)
        self.assertIn('Fence the old worker',plan['orderedCutoverGates'][0]);self.assertIn('exactly one controller',plan['orderedCutoverGates'][-1])
        self.assertEqual(plan['database']['rows'],3)
    def test_different_chain_rejected(self):
        self.data['chainId']=31337
        with self.assertRaises(ValueError):self.validate()
    def test_unbound_runtime_rejected(self):
        self.runtime['id']='runtime-different'
        with self.assertRaises(ValueError):self.validate()
    def test_modified_reviewed_file_rejected(self):
        (self.runtime_dir/'release/dist/app.js').write_bytes(b'modified')
        with self.assertRaises(ValueError):self.validate()
    def test_runtime_pin_traversal_rejected(self):
        self.expected['runtimePins'][0]['path']='../outside';(self.data_dir/'configuration/expected.json').write_text(json.dumps(self.expected))
        with self.assertRaises(ValueError):self.validate()
    def test_mutable_image_tag_rejected(self):
        (self.data_dir/'configuration/mainnet.env').write_text('CPU_IMAGE=node:latest\n')
        with self.assertRaises(ValueError):self.validate()
    def test_unknown_table_name_rejected(self):
        (self.data_dir/'snapshot.json').write_text(json.dumps({'fingerprints':[{'table':'jobs;SELECT','sha256':'c'*64,'rows':3}]}))
        with self.assertRaises(ValueError):self.validate()
    def test_existing_target_rejected_before_decryption(self):
        with patch.object(recovery.os,'geteuid',return_value=0,create=True):
            with self.assertRaises(ValueError):recovery.stage_pair(self.root/'missing',self.root/'missing',self.root/'missing',self.root,b'identity')
if __name__=='__main__':unittest.main()
