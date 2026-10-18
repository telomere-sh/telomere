"""Build a minimal signed-package Debian 12 disk for the isolated recovery VM.

Run in a private mount namespace. Does not install packages on the source host.
The source-compatible application IDs remain free until the guest reserves them.
"""
import hashlib,json,os,re,shutil,subprocess,sys,time
from pathlib import Path

def run(args,**kwargs):return subprocess.run(args,**{'check':True,'capture_output':True,'timeout':120,**kwargs})
def main(root):
    assert os.geteuid()==0 and root.resolve()==root and root.parent==Path('/opt/telomere-mainnet-pilot/private') and re.fullmatch('fresh-vm-[0-9a-f]{16}',root.name)
    os.umask(0o077);began=time.monotonic();tools=root.parent/'backup-crash-vm-tools';debs=tools/'debs';extracted=tools/'extracted'
    run(['apt-get','--download-only','--no-install-recommends','-y','-o','Dir::Cache::archives='+str(debs),'install','debootstrap'],timeout=600)
    for package in debs.glob('debootstrap_*.deb'):run(['dpkg-deb','-x',str(package),str(extracted)])
    fs=root/'minimal-root';assert not fs.exists()
    environment={**os.environ,'DEBOOTSTRAP_DIR':str(extracted/'usr/share/debootstrap')}
    command=[str(extracted/'usr/sbin/debootstrap'),'--force-check-gpg','--variant=minbase','--include=systemd-sysv,udev,dbus,iproute2,isc-dhcp-client,python3,ca-certificates,e2fsprogs,passwd,kmod','bookworm',str(fs),'https://deb.debian.org/debian']
    with (root/'debootstrap.log').open('wb') as log:subprocess.run(command,env=environment,check=True,stdout=log,stderr=subprocess.STDOUT,timeout=1200)
    assert 'Valid Release signature' in (root/'debootstrap.log').read_text()
    fs.chmod(0o755)
    # Compatible IDs must genuinely be free in the new OS; no existing account
    # is removed or renumbered to make the original runtime fit.
    assert all(line.split(':')[2]!='995' for line in (fs/'etc/passwd').read_text().splitlines())
    assert all(line.split(':')[2]!='993' for line in (fs/'etc/group').read_text().splitlines())
    namespace=root.name.rsplit('-',1)[1]
    marker={'kind':'telomere-disposable-clean-vm','namespace':namespace,'productionControllerAllowed':False,'mainnetTransactionsAllowed':False}
    (fs/'etc/telomere-recovery-guest.json').write_text(json.dumps(marker));(fs/'etc/telomere-recovery-guest.json').chmod(0o600)
    (fs/'etc/hostname').write_text('telomere-recovery-'+namespace+'\n')
    (fs/'etc/apt/sources.list').write_text('deb https://deb.debian.org/debian bookworm main\ndeb https://deb.debian.org/debian bookworm-updates main\ndeb https://security.debian.org/debian-security bookworm-security main\n')
    (fs/'etc/systemd/network').mkdir(parents=True,exist_ok=True)
    (fs/'etc/systemd/network').chmod(0o755)
    network=fs/'etc/systemd/network/20-recovery.network';network.write_text('[Match]\nName=en* eth*\n[Network]\nDHCP=yes\n');network.chmod(0o644)
    resolver=fs/'etc/resolv.conf'
    if resolver.is_symlink():resolver.unlink()
    resolver.write_text('nameserver 10.0.2.3\n');resolver.chmod(0o644)
    units=fs/'etc/systemd/system';target=units/'multi-user.target.wants';target.mkdir(parents=True,exist_ok=True)
    for name in ('systemd-networkd.service','systemd-networkd-wait-online.service'):
        path=target/name
        if not path.exists():path.symlink_to('/lib/systemd/system/'+name)
    unit=units/'telomere-fresh-bootstrap.service'
    unit.write_text('[Unit]\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=oneshot\nExecStartPre=/usr/sbin/resize2fs /dev/vda\nExecStart=/bin/sh -c "mkdir -p /mnt/recovery && mount -L TELOMERE_INPUT /mnt/recovery && cp -a /mnt/recovery/operator /root/recovery-kit && /usr/bin/python3 -B /root/recovery-kit/cpu-launch/fresh-vm-guest.py bootstrap"\nTimeoutStartSec=3000\nStandardOutput=journal+console\nStandardError=journal+console\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n')
    (target/unit.name).symlink_to('/etc/systemd/system/'+unit.name)
    kernel=os.uname().release;modules=fs/'lib/modules'/kernel;modules.parent.mkdir(parents=True,exist_ok=True)
    shutil.copytree(Path('/lib/modules')/kernel,modules,symlinks=True)
    (fs/'mnt/recovery').mkdir(mode=0o700,parents=True,exist_ok=True)
    # The overlay expands this 4 GiB ext4 filesystem online to 32 GiB on first boot.
    disk=root/'debian-12-minimal.ext4'
    with disk.open('wb') as out:out.truncate(4*1024**3)
    run(['/usr/sbin/mkfs.ext4','-F','-q','-d',str(fs),str(disk)],timeout=180)
    packages=run(['chroot',str(fs),'dpkg-query','-W','-f','${Package}\t${Version}\n']).stdout.decode()
    (root/'os-packages.txt').write_text(packages)
    checksum=hashlib.sha512()
    with disk.open('rb') as source:
        for chunk in iter(lambda:source.read(1024**2),b''):checksum.update(chunk)
    result={'passed':True,'kind':'signed-debootstrap-minimal','format':'raw','imageFile':disk.name,'os':'Debian 12 bookworm amd64',
        'repository':'https://deb.debian.org/debian','aptSignaturesVerifiedByDebootstrap':True,'sha512':checksum.hexdigest(),'bytes':disk.stat().st_size,
        'osPackagesSha256':hashlib.sha256(packages.encode()).hexdigest(),'kernel':kernel,'kernelSha256':hashlib.sha256(Path('/boot/vmlinuz-'+kernel).read_bytes()).hexdigest(),
        'initrdSha256':hashlib.sha256(Path('/boot/initrd.img-'+kernel).read_bytes()).hexdigest(),'hostPackagesInstalled':False,'elapsedSeconds':round(time.monotonic()-began,3)}
    (root/'prepare-result.json').write_text(json.dumps(result,indent=2)+'\n')
    assert fs.parent==root and not fs.is_symlink();shutil.rmtree(fs)
    print(json.dumps(result),flush=True)

if __name__=='__main__':main(Path(sys.argv[1]))
