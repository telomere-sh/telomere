"""POSIX recovery ownership and publication boundary tests; no chain access."""
import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('crash_ops',Path(__file__).with_name('mainnet-ops.py'))
ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.root.chmod(0o700)
        self.private=patch.object(ops,'PRIVATE',self.root);self.private.start()
        self.commands=[]
        def command(args,**kwargs):
            self.commands.append(args)
            return SimpleNamespace(stdout=b'')
        self.docker=patch.object(ops,'run',side_effect=command);self.docker.start()
    def tearDown(self):self.docker.stop();self.private.stop();self.temp.cleanup()
    def stale(self):
        folder=self.root/'cpu-backup-work';folder.mkdir(mode=0o700,exist_ok=True)
        stage=folder/('attempt-'+'a'*32);stage.mkdir(mode=0o700);(stage/'private.dump').write_bytes(b'fixture plaintext')
        return stage
    def test_stale_plaintext_and_partial_removed_success_receipt_retained(self):
        stale=self.stale();(stale/'cipher.partial').write_bytes(b'partial')
        receipt=self.root/'cpu-backup-status.json';receipt.write_text('{"id":"previous-success"}')
        (self.root/'cpu-backup-status.json.next').write_bytes(b'incomplete')
        runtime=self.root/('runtime-'+'b'*40+'-'+'c'*16+'.json.next');runtime.write_bytes(b'incomplete')
        with ops.backup_workspace() as stage:
            self.assertFalse(stale.exists());self.assertEqual(list(stage.iterdir()),[])
            self.assertFalse(runtime.exists());self.assertFalse((self.root/'cpu-backup-status.json.next').exists())
            self.assertEqual(receipt.read_text(),'{"id":"previous-success"}')
        self.assertEqual(list((self.root/'cpu-backup-work').iterdir()),[])
    def test_concurrent_backup_cannot_reclaim_active_attempt(self):
        with ops.backup_workspace() as stage:
            (stage/'active').write_bytes(b'live')
            with self.assertRaises(BlockingIOError):
                with ops.backup_workspace():pass
            self.assertTrue((stage/'active').exists())
    def test_stage_symlink_rejected_and_external_data_preserved(self):
        stale=self.stale();target=self.root/'foreign';target.mkdir(mode=0o700);(target/'keep').write_bytes(b'foreign')
        ops.shutil.rmtree(stale);stale.symlink_to(target,target_is_directory=True)
        with self.assertRaises(AssertionError):
            with ops.backup_workspace():pass
        self.assertTrue((target/'keep').exists())
    def test_inner_symlink_unlinked_without_following(self):
        stale=self.stale();target=self.root/'foreign';target.write_bytes(b'preserved');(stale/'link').symlink_to(target)
        with ops.backup_workspace():self.assertEqual(target.read_bytes(),b'preserved')
    def test_foreign_name_blocks_recovery_without_deletion(self):
        self.stale();foreign=self.root/'cpu-backup-work/unrelated';foreign.mkdir()
        with self.assertRaises(AssertionError):
            with ops.backup_workspace():pass
        self.assertTrue(foreign.exists())
    def test_weak_directory_permissions_rejected(self):
        stale=self.stale();stale.chmod(0o755)
        with self.assertRaises(AssertionError):
            with ops.backup_workspace():pass
        self.assertTrue((stale/'private.dump').exists())
    def test_lock_symlink_rejected(self):
        target=self.root/'target';target.write_bytes(b'intact');(self.root/'cpu-backup.lock').symlink_to(target)
        with self.assertRaises(OSError):
            with ops.backup_workspace():pass
        self.assertEqual(target.read_bytes(),b'intact')
    def test_receipt_partial_symlink_blocks_instead_of_deleting_foreign_target(self):
        target=self.root/'target';target.write_bytes(b'intact');(self.root/'cpu-backup-status.json.next').symlink_to(target)
        with self.assertRaises(AssertionError):
            with ops.backup_workspace():pass
        self.assertEqual(target.read_bytes(),b'intact')
    def test_docker_unavailable_retains_stage_for_retry(self):
        stale=self.stale()
        with patch.object(ops,'run',side_effect=RuntimeError('fixture unavailable')):
            with self.assertRaises(RuntimeError):
                with ops.backup_workspace():pass
        self.assertTrue((stale/'private.dump').exists())
    def test_mismatched_docker_label_never_removed(self):
        stale=self.stale();identity='d'*64
        replies=[SimpleNamespace(stdout=(identity+'\n').encode()),SimpleNamespace(stdout=json.dumps([{'Config':{'Labels':{}}}]).encode())]
        with patch.object(ops,'run',side_effect=replies) as command:
            with self.assertRaises(AssertionError):ops.remove_attempt(stale)
            self.assertEqual(command.call_count,2)
        self.assertTrue(stale.exists())
    def test_normal_exception_also_cleans_workspace(self):
        with self.assertRaises(ValueError):
            with ops.backup_workspace() as stage:
                (stage/'temporary').write_bytes(b'x');raise ValueError('fixture')
        self.assertFalse(stage.exists())
    def test_stopped_containers_and_volumes_removed_before_directory(self):
        stage=self.stale();labels=ops.attempt_labels(stage);identity='d'*64;volume='telomere-backup-restore-'+'e'*32+'-data'
        replies=[SimpleNamespace(stdout=(identity+'\n').encode()),SimpleNamespace(stdout=json.dumps([{'Config':{'Labels':labels}}]).encode()),SimpleNamespace(stdout=b''),
            SimpleNamespace(stdout=(volume+'\n').encode()),SimpleNamespace(stdout=json.dumps([{'Labels':labels}]).encode()),SimpleNamespace(stdout=b'')]
        with patch.object(ops,'run',side_effect=replies) as command:
            ops.remove_attempt(stage)
            self.assertIn('-aq',command.call_args_list[0].args[0]);self.assertEqual(command.call_count,6)
        self.assertFalse(stage.exists())
    def test_wrong_volume_label_retains_plaintext_for_retry(self):
        stage=self.stale();volume='telomere-backup-restore-'+'e'*32+'-data'
        replies=[SimpleNamespace(stdout=b''),SimpleNamespace(stdout=(volume+'\n').encode()),SimpleNamespace(stdout=json.dumps([{'Labels':{}}]).encode())]
        with patch.object(ops,'run',side_effect=replies) as command:
            with self.assertRaises(AssertionError):ops.remove_attempt(stage)
            self.assertEqual(command.call_count,3)
        self.assertTrue((stage/'private.dump').exists())
    def test_atomic_hardlink_rejected_before_truncation(self):
        target=self.root/'target';target.write_bytes(b'intact');os.link(target,self.root/'receipt.next')
        with self.assertRaises(AssertionError):ops.atomic(self.root/'receipt',{'x':1})
        self.assertEqual(target.read_bytes(),b'intact')
    def test_atomic_fifo_rejected_without_blocking(self):
        os.mkfifo(self.root/'receipt.next')
        with self.assertRaises(OSError):ops.atomic(self.root/'receipt',{})
    def test_atomic_fsync_failure_does_not_publish(self):
        receipt=self.root/'receipt';receipt.write_bytes(b'previous')
        with patch.object(ops.os,'fsync',side_effect=OSError('fixture disk error')):
            with self.assertRaises(OSError):ops.atomic(receipt,{'new':True})
        self.assertEqual(receipt.read_bytes(),b'previous')
    def test_successful_atomic_has_no_partial(self):
        receipt=self.root/'receipt';ops.atomic(receipt,{'new':True})
        self.assertEqual(json.loads(receipt.read_bytes()),{'new':True});self.assertFalse(receipt.with_name('receipt.next').exists())

if __name__=='__main__':unittest.main()
