"""Manual isolated full-quota acceptance through the actual restricted export and private release transport."""
import json,os,re,shutil,tempfile,time
from pathlib import Path
from archive_policy import MIN_FREE_BYTES
from cloud import ExportClient,validate_archive_metadata,verify_archive,rehearse_restore
from github_store import GitHubStore

def main():
    began=time.monotonic()
    metadata={'id':os.environ['CAPACITY_BACKUP_ID'],'sha256':os.environ['CAPACITY_SHA256'],'bytes':int(os.environ['CAPACITY_BYTES']),
        'restore':{'databaseImage':os.environ['CAPACITY_DATABASE_IMAGE']}}
    validate_archive_metadata(metadata)
    if not re.fullmatch('postgres@sha256:[0-9a-f]{64}',metadata['restore']['databaseImage']):raise ValueError('Capacity PostgreSQL digest')
    tag=os.environ['CAPACITY_RELEASE_TAG']
    if not re.fullmatch('capacity-[0-9a-f]{16}',tag):raise ValueError('Capacity release tag')
    store=GitHubStore(os.environ['GITHUB_REPOSITORY'],os.environ['GITHUB_TOKEN'])
    with tempfile.TemporaryDirectory(prefix='capacity-acceptance-') as temporary:
        folder=Path(temporary);folder.chmod(0o700)
        if shutil.disk_usage(folder).free<MIN_FREE_BYTES:raise RuntimeError('Capacity scratch free disk')
        identity=folder/'age-identity';identity.write_text(os.environ['TELOMERE_AGE_IDENTITY'].strip()+'\n');identity.chmod(0o600)
        exported=folder/(metadata['id']+'.tar.age')
        received=ExportClient(folder).request({'operation':'download','id':metadata['id']},exported)
        if any(received[key]!=metadata[key] for key in ('id','sha256','bytes')):raise ValueError('Capacity export binding')
        proof=verify_archive(exported,identity,folder)
        if proof['id']!=metadata['id'] or proof['capacity']['cystBytes']!=1024**3:raise ValueError('Full Cyst quota missing')
        release=store.release(tag,{'kind':'telomere-backup-capacity-acceptance',**metadata,'verification':proof})
        if json.loads(release['body'])['sha256']!=metadata['sha256']:raise ValueError('Capacity release binding')
        asset=store.upload(release,exported)
        class CapacityStore:
            def release(self,identifier,*args):
                if identifier!=metadata['id']:raise ValueError('Capacity restore identifier')
                return release
            def assets(self,value):return store.assets(value)
            def download(self,asset,target,checksum):return store.download(asset,target,checksum)
        restored=rehearse_restore(CapacityStore(),metadata,identity,folder)
        if restored['cysts']['bytes']!=1024**3 or restored['cysts']['files']!=512:raise ValueError('Restored full quota differs')
        print(json.dumps({'scope':'independent full Cyst backup capacity acceptance','passed':True,**metadata,'verification':proof,
            'storedAssetBytes':asset['size'],'storedAssetSha256':asset['digest'],'privateReleaseTag':tag,'cloudRestore':restored,
            'elapsedSeconds':round(time.monotonic()-began,3),'productionReceiptChanged':False,'mainnetTransactions':0}),flush=True)

if __name__=='__main__':main()
