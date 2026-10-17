import datetime, hashlib, importlib.util, io, json, os, re, subprocess, sys, tarfile, tempfile, unittest, urllib.request
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parent))
import cloud, github_store, pager
spec = importlib.util.spec_from_file_location('exporter', Path(__file__).with_name('export.py'))
exporter = importlib.util.module_from_spec(spec); spec.loader.exec_module(exporter)
spec = importlib.util.spec_from_file_location('ops', Path(__file__).parent.parent/'cpu-launch/mainnet-ops.py')
ops = importlib.util.module_from_spec(spec); spec.loader.exec_module(ops)


class ProtocolTests(unittest.TestCase):
    def test_no_shell_or_arbitrary_path(self):
        for request in ({'schemaVersion':1,'operation':'status','command':'id'},
            {'schemaVersion':1,'operation':'download','id':'../../private/mainnet.env'},
            {'schemaVersion':1,'operation':'shell'}, {'operation':'status'}, []):
            with self.assertRaises((ValueError, TypeError)):
                exporter.validate_request(request)

    def test_runtime_download_but_no_runtime_ack(self):
        identity = 'runtime-'+'a'*40+'-'+'b'*16
        self.assertEqual(exporter.validate_request({'schemaVersion':1,'operation':'download','id':identity}),'download')
        with self.assertRaises(ValueError):
            exporter.validate_request({'schemaVersion':1,'operation':'ack','id':identity,'sha256':'a'*64,
                'runtimeId':identity,'runtimeSha256':'b'*64,'repository':'owner/repo','runId':'123'})

    def test_metadata_size_identity_and_checksum(self):
        good={'id':'backup-20261017T120000Z-'+'a'*8,'sha256':'b'*64,'bytes':200}
        cloud.validate_archive_metadata(good)
        for replacement in ({'bytes':True},{'bytes':513*1024**2},{'sha256':'x'},{'id':'/etc/passwd'}):
            with self.assertRaises(ValueError):cloud.validate_archive_metadata({**good,**replacement})

    @unittest.skipUnless(hasattr(os,'O_NOFOLLOW'),'POSIX descriptor safety')
    def test_export_refuses_symlink_and_hardlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();backups=root/'backups';backups.mkdir();private=root/'secret';private.write_bytes(b'x'*200)
            name='backup-20261017T120000Z-'+'a'*8;target=backups/(name+'.tar.age')
            with patch.object(exporter,'BACKUPS',backups):
                target.symlink_to(private)
                with self.assertRaises(OSError):exporter.open_archive(name)
                target.unlink();os.link(private,target)
                with self.assertRaises(ValueError):exporter.open_archive(name)

    def test_age_recipients_support_rotation_but_reject_duplicates(self):
        first,second='age1'+'a'*58,'age1'+'b'*58
        ops.validate_recipients(first+'\n'+second+'\n')
        for text in (first+'\n'+first+'\n','',first+'\nnot-a-key\n',first+'\n\n'):
            with self.assertRaises(AssertionError):ops.validate_recipients(text)


class NotificationTests(unittest.TestCase):
    def test_incident_repeat_recovery_and_no_recovery_spam(self):
        first=pager.delivery_plan({},['RPC_DOWN'],10000);self.assertEqual(first['kind'],'incident')
        previous={**first,'sentAt':10000}
        self.assertIsNone(pager.delivery_plan(previous,['RPC_DOWN'],10001))
        self.assertEqual(pager.delivery_plan(previous,['RPC_DOWN'],13600)['kind'],'incident')
        self.assertEqual(pager.delivery_plan(previous,['DB_DOWN'],10001)['kind'],'incident')
        self.assertEqual(pager.delivery_plan(previous,[],10002)['kind'],'recovery')
        self.assertIsNone(pager.delivery_plan({'alerts':[],'sentAt':10002},[],10003))

    def test_failed_delivery_does_not_commit_dedupe_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'cpu-telegram.json').write_text('{"chatId":"123"}');(root/'telegram-bot-token').write_text('fixture')
            with patch.object(pager,'PRIVATE',root),patch.object(pager,'local_alerts',return_value=['DB_DOWN']),patch.object(pager,'send',side_effect=RuntimeError('transport unavailable')):
                with self.assertRaises(RuntimeError):pager.notify()
            self.assertFalse((root/'cpu-vps-pager-state.json').exists())

    def test_only_numeric_bound_recipient_and_bounded_codes(self):
        with self.assertRaises(ValueError):pager.send('unused','@someone','vps','incident',[])
        with self.assertRaises(ValueError):pager.send('unused','123','vps','incident',['secret\ncontent'])


class StorageTests(unittest.TestCase):
    def test_snapshot_advancing_during_copy_is_retried_before_ack(self):
        runtime={'id':'runtime-'+'a'*40+'-'+'b'*16,'sha256':'a'*64}
        first={'id':'backup-20261017T120000Z-1234abcd','sha256':'b'*64,'runtimeBundle':runtime}
        second={**first,'id':'backup-20261017T130000Z-1234abcd'}
        class Exporter:
            calls=0
            acknowledged=[]
            def request(self,request):
                if request['operation']=='ack':self.acknowledged.append(request['id']);return {'acknowledged':True}
                self.calls+=1;return {'backup':first if self.calls==1 else second,'monitor':{}}
        exporter=Exporter();store=type('Store',(),{'repository':'owner/repo'})()
        def copied(store,exporter,metadata,*args):return {'id':metadata['id'],'runtimeBundle':runtime}
        with patch.object(cloud,'copy_archive',side_effect=copied),patch.dict(os.environ,{'GITHUB_RUN_ID':'123'}):
            result=cloud.copy_current_backup(store,exporter,None,None)
        self.assertEqual(result[-1],2);self.assertEqual(exporter.acknowledged,[second['id']])
    def test_backup_timestamp_tag_preserves_uppercase_t_and_z(self):
        store=object.__new__(github_store.GitHubStore);store.prefix='/repos/owner/repo';calls=[]
        def api(path,method='GET',body=None,missing=False):
            calls.append((method,body));return None if missing else {'id':1}
        store.api=api
        self.assertEqual(store.release('backup-20261017T120000Z-1234abcd',{'kind':'telomere-cpu-data-backup'}),{'id':1})
        self.assertEqual(calls[-1][1]['tag_name'],'backup-20261017T120000Z-1234abcd')
    def test_cross_host_redirect_removes_token(self):
        request=urllib.request.Request('https://api.github.com/repos/a/b/releases/assets/1',headers={'Authorization':'Bearer fixture'})
        redirected=github_store.SafeRedirect().redirect_request(request,None,302,'',{},'https://release-assets.githubusercontent.com/object')
        self.assertIsNone(redirected.get_header('Authorization'))
        with self.assertRaises(RuntimeError):github_store.SafeRedirect().redirect_request(request,None,302,'',{},'https://attacker.invalid/object')

    def test_refuses_public_backup_repository(self):
        with patch.object(github_store.GitHubStore,'api',return_value={'private':False}):
            with self.assertRaises(RuntimeError):github_store.GitHubStore('owner/repo','fixture')

    def test_retention_uses_full_inventory_and_preserves_daily_copies(self):
        start=datetime.datetime(2026,10,1,tzinfo=datetime.timezone.utc)
        releases=[]
        for index in range(264):
            identity='backup-'+(start+datetime.timedelta(hours=index)).strftime('%Y%m%dT%H%M%SZ')+'-'+format(index,'08x')
            releases.append({'id':index+1,'tag_name':identity,'body':json.dumps({'kind':'telomere-cpu-data-backup','id':identity})})
        releases.append({'id':999,'tag_name':'unrelated-release','body':'keep'})
        removed=[];store=object.__new__(github_store.GitHubStore);store.prefix='/repos/owner/repo'
        def api(path,method='GET'):
            if method=='DELETE':removed.append(int(path.rsplit('/',1)[1]));return {}
            page=int(path.split('page=')[-1]);return releases[(page-1)*100:page*100]
        store.api=api;result=store.prune_snapshots()
        self.assertEqual(result['snapshotsKept'],31);self.assertEqual(len(removed),233);self.assertNotIn(999,removed)

    def test_incomplete_retention_inventory_never_deletes(self):
        store=object.__new__(github_store.GitHubStore);store.prefix='/repos/owner/repo';calls=[]
        def api(path,method='GET'):
            calls.append(method);return [{}]*100
        store.api=api
        with self.assertRaises(RuntimeError):store.prune_snapshots()
        self.assertNotIn('DELETE',calls)


@unittest.skipUnless(os.name=='posix','Official Linux age tool required')
class EncryptedRecoveryTests(unittest.TestCase):
    def test_authentication_and_manifest_tampering_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);key=root/'identity';subprocess.run(['age-keygen','-o',str(key)],check=True,capture_output=True)
            recipient=subprocess.check_output(['age-keygen','-y',str(key)]).decode().strip()
            for corrupt_manifest in (False,True):
                content=b'encrypted fixture payload';manifest={'id':'fixture','files':[{'path':'data','bytes':len(content),'sha256':('0'*64 if corrupt_manifest else hashlib.sha256(content).hexdigest())}]}
                plain=root/'source.tar'
                with tarfile.open(plain,'w') as tar:
                    for name,body in [('data',content),('manifest.json',json.dumps(manifest).encode())]:
                        member=tarfile.TarInfo(name);member.size=len(body);tar.addfile(member,io.BytesIO(body))
                encrypted=root/('bad.tar.age' if corrupt_manifest else 'good.tar.age')
                subprocess.run(['age','-r',recipient,'-o',str(encrypted),str(plain)],check=True,capture_output=True)
                if corrupt_manifest:
                    with self.assertRaises(ValueError):cloud.verify_archive(encrypted,key,root)
                else:
                    self.assertTrue(cloud.verify_archive(encrypted,key,root)['manifestChecksumsValid'])
                    changed=bytearray(encrypted.read_bytes());changed[-1]^=1;encrypted.write_bytes(changed)
                    with self.assertRaises(subprocess.CalledProcessError):cloud.verify_archive(encrypted,key,root)
                self.assertFalse((root/(encrypted.name+'.plain')).exists())


if __name__=='__main__':unittest.main()
