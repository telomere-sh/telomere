import hashlib,importlib.util,io,json,os,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('mainnet_ops',Path(__file__).with_name('mainnet-ops.py'))
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
class FingerprintTests(unittest.TestCase):
    def test_large_output_is_hashed_in_bounded_chunks(self):
        payload=(b'{"record":"'+b'x'*8192+b'"}\n')*300
        class Bounded(io.BytesIO):
            def read(self,size=-1):
                if not 0<size<=1024*1024:raise AssertionError('Unbounded fingerprint read')
                return super().read(size)
        self.assertEqual(ops.fingerprint_file(Bounded(payload)),(hashlib.sha256(payload).hexdigest(),300))
    def test_empty_table_fingerprint(self):
        self.assertEqual(ops.fingerprint_file(io.BytesIO(b'')),(hashlib.sha256(b'').hexdigest(),0))
class HealthTests(unittest.TestCase):
    def setUp(self):self.good={'ready':True,'databaseAvailable':True,'rpc':{'available':True,'operatorGasWei':'100000000000000'},'invalidFinancialRows':0,'states':[],
        'backupAgeSeconds':100,'offhostAgeSeconds':100,'diskFreeBytes':10*1024**3,'tlsRemainingDays':60}
    def test_ready(self):self.assertEqual(ops.evaluate_health(self.good),[])
    def test_journal_history_warning_precedes_the_runtime_cap(self):
        self.good['settlementJournalRows']=1499;self.assertNotIn('SETTLEMENT_HISTORY_REVIEW_DUE',ops.evaluate_health(self.good))
        self.good['settlementJournalRows']=1500;self.assertIn('SETTLEMENT_HISTORY_REVIEW_DUE',ops.evaluate_health(self.good))
    def test_stalled_settlement_and_queue(self):
        self.good['states']=[{'status':'settling','count':1,'oldest_seconds':121},{'status':'queued','count':1,'oldest_seconds':301}]
        self.assertEqual(ops.evaluate_health(self.good),['QUEUE_DELAY_HIGH','SETTLEMENT_OR_RECEIPT_STALLED'])
    def test_backup_and_offhost_expiry(self):
        self.good.update(backupAgeSeconds=7201,offhostAgeSeconds=10801)
        self.assertEqual(ops.evaluate_health(self.good),['BACKUP_STALE','OFFHOST_BACKUP_STALE'])
    def test_missing_observation_fails_closed(self):
        self.assertIn('DATABASE_UNAVAILABLE',ops.evaluate_health({}))
        self.assertIn('RPC_OR_ASSET_PINS_UNAVAILABLE',ops.evaluate_health({}))
    def test_low_gas_and_invalid_financial_rows(self):
        self.good['rpc']['operatorGasWei']='1';self.good['invalidFinancialRows']=1
        self.assertEqual(ops.evaluate_health(self.good),['FINANCIAL_INVARIANT_FAILED','OPERATOR_GAS_LOW'])
    def test_reconciliation_alert(self):
        self.good['states']=[{'status':'reconciliation','count':1,'oldest_seconds':1}]
        self.assertIn('RUN_REQUIRES_RECONCILIATION',ops.evaluate_health(self.good))
    def test_offhost_runtime_must_match_current_bundle(self):
        self.good['offhostRuntimeValid']=False
        self.assertIn('OFFHOST_RUNTIME_NOT_VERIFIED',ops.evaluate_health(self.good))
    def test_cpu_exceeding_maximum_runtime_without_updates(self):
        self.good['states']=[{'status':'running','count':1,'oldest_seconds':181}]
        self.assertIn('CPU_RUN_STALLED',ops.evaluate_health(self.good))
    def test_soak_failure_or_missing_progress_alerts(self):
        self.good.update(cpuSoakState='failed');self.assertIn('CPU_SOAK_FAILED',ops.evaluate_health(self.good))
        self.good.update(cpuSoakState='running',cpuSoakProgressAgeSeconds=181);self.assertIn('CPU_SOAK_STALE',ops.evaluate_health(self.good))
        self.good.update(cpuSoakState='invalid');self.assertIn('CPU_SOAK_OBSERVATION_INVALID',ops.evaluate_health(self.good))
    def test_running_and_completed_soak_do_not_page(self):
        self.good.update(cpuSoakState='running',cpuSoakProgressAgeSeconds=60);self.assertEqual(ops.evaluate_health(self.good),[])
        self.good.update(cpuSoakState='completed',cpuSoakProgressAgeSeconds=86400);self.assertEqual(ops.evaluate_health(self.good),[])
class ProgressDescriptorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.namespace='a'*16;self.file=self.root/('soak-'+self.namespace+'.json');self.file.write_text('{"state":"running"}')
    def tearDown(self):self.temp.cleanup()
    def read(self):return ops.read_soak_progress(self.root,self.namespace,os.getuid())
    def test_regular_owned_record(self):self.assertEqual(self.read(),{'state':'running'})
    def test_symlink_is_not_followed(self):
        original=self.root/'original';self.file.rename(original);self.file.symlink_to(original)
        with self.assertRaises(OSError):self.read()
    def test_hardlink_is_rejected(self):
        os.link(self.file,self.root/'linked')
        with self.assertRaises(AssertionError):self.read()
    def test_oversized_record(self):
        self.file.write_text('x'*16385)
        with self.assertRaises(AssertionError):self.read()
    def test_fifo_is_rejected_without_waiting_for_a_writer(self):
        self.file.unlink();os.mkfifo(self.file)
        with self.assertRaises(AssertionError):self.read()
    def test_foreign_owner(self):
        with self.assertRaises(AssertionError):ops.read_soak_progress(self.root,self.namespace,os.getuid()+1)
class BackupCiphertextTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.source=self.root/'source';self.target=self.root/'target';self.source.mkdir();self.target.mkdir()
        self.blob=b'encrypted-test-ciphertext';self.ref={'owner':'0x'+'11'*20,'sha256':hashlib.sha256(self.blob).hexdigest(),'ciphertext_bytes':len(self.blob),'state':'ready'}
        self.name=hashlib.sha256(('telomere-cyst-blob:'+self.ref['owner']+':'+self.ref['sha256']).encode()).hexdigest()+'.blob'
    def tearDown(self):self.temp.cleanup()
    def test_ready_ciphertext_copies_with_hash(self):
        (self.source/self.name).write_bytes(self.blob);ops.copy_cysts(self.source,self.target,[self.ref]);self.assertEqual((self.target/self.name).read_bytes(),self.blob)
    def test_ready_missing_refuses_backup(self):
        with self.assertRaises(AssertionError):ops.copy_cysts(self.source,self.target,[self.ref])
    def test_pending_missing_is_retained_as_pending(self):
        self.ref['state']='pending';ops.copy_cysts(self.source,self.target,[self.ref]);self.assertEqual(list(self.target.iterdir()),[])
    def test_corrupt_ciphertext_refuses_backup(self):
        (self.source/self.name).write_bytes(b'x'*len(self.blob))
        with self.assertRaises(AssertionError):ops.copy_cysts(self.source,self.target,[self.ref])
    def test_symlink_cannot_read_another_file(self):
        other=self.root/'private';other.write_bytes(self.blob);(self.source/self.name).symlink_to(other)
        with self.assertRaises(OSError):ops.copy_cysts(self.source,self.target,[self.ref])
    def test_invalid_reference_is_rejected(self):
        self.ref['owner']='../../private'
        with self.assertRaises(AssertionError):ops.copy_cysts(self.source,self.target,[self.ref])
if __name__=='__main__':unittest.main()
