"""Manually wrap the cloud recovery identity to an owner's NEW public age key.

Works without the VPS and the original Windows device. Never prints a private key.
"""
import json, os, re, subprocess, tempfile
from pathlib import Path
from github_store import GitHubStore, digest


def run():
    recipient = os.environ['RECOVERY_RECIPIENT'].strip()
    run_id = os.environ['GITHUB_RUN_ID']
    if not re.fullmatch(r'age1[0-9a-z]{58}', recipient) or not re.fullmatch(r'[0-9]{1,20}', run_id):
        raise ValueError('A new public age recipient is required')
    store = GitHubStore(os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_TOKEN'])
    with tempfile.TemporaryDirectory(prefix='telomere-key-recovery-') as temporary:
        folder = Path(temporary); folder.chmod(0o700)
        encrypted = folder / 'cloud-recovery-identity.age'
        subprocess.run(['age', '-r', recipient, '-o', str(encrypted)],
            input=(os.environ['TELOMERE_AGE_IDENTITY'].strip()+'\n').encode(), check=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        checksum = digest(encrypted)
        release = store.release('owner-key-recovery-'+run_id, {'kind':'telomere-owner-key-recovery',
            'recipient':recipient,'ciphertextSha256':checksum})
        asset = store.upload(release, encrypted)
        store.download(asset, folder/'readback.age', checksum)
        print(json.dumps({'passed':True,'privateKeyPrinted':False,'onlyOwnerEncryptedIdentityUploaded':True,
            'assetId':asset['id'],'ciphertextSha256':checksum,'mainnetTransactions':0}))


if __name__=='__main__':
    os.umask(0o077)
    try:run()
    except Exception as error:
        print(json.dumps({'passed':False,'errorType':type(error).__name__}))
        raise SystemExit(1)
