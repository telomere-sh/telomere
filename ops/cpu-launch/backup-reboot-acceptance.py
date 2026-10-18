"""Private QEMU TCG guest: real emergency kernel reboot on a disposable ext4 disk.

Debian QEMU packages are downloaded/extracted privately, never installed on the
production host. The guest has one scratch disk, one vCPU and no network/device
passthrough. Source disk files, generated identity and disk image are removed.
"""
import sys as _runtime_sys
if _runtime_sys.flags.optimize:
    raise RuntimeError('Telomere recovery tooling requires checked Python; remove -O/-OO and PYTHONOPTIMIZE.')

import hashlib,json,os,re,shutil,subprocess,sys,time
from pathlib import Path

ROOT=Path(sys.argv[1]).resolve();TOOLS=Path('/opt/telomere-mainnet-pilot/private/backup-crash-vm-tools')
assert ROOT.parent==TOOLS.parent and re.fullmatch('backup-crash-candidate-[0-9a-f]{16}',ROOT.name)
os.umask(0o077)

def run(args,**kwargs):return subprocess.run(args,check=True,capture_output=True,**{'timeout':120,**kwargs})
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    began=time.monotonic();host_boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    tools=TOOLS/'extracted';tools.mkdir(mode=0o700,exist_ok=True)
    for package in sorted((TOOLS/'debs').glob('*.deb')):run(['dpkg-deb','-x',str(package),str(tools)])
    environment={**os.environ,'LD_LIBRARY_PATH':str(tools/'usr/lib/x86_64-linux-gnu')+':'+str(tools/'lib/x86_64-linux-gnu'),
        'QEMU_MODULE_DIR':str(tools/'usr/lib/x86_64-linux-gnu/qemu')}
    qemu=tools/'usr/bin/qemu-system-x86_64';version=run([str(qemu),'--version'],env=environment).stdout.decode().splitlines()[0]
    folder=ROOT/'vm';folder.mkdir(mode=0o700);fs=folder/'rootfs';fs.mkdir(mode=0o700);disk=folder/'scratch.ext4'
    for name in ('bin','sbin','usr/bin','lib','lib64','proc','sys','dev','tmp','run','etc','fixture/private','fixture/backups','fixture/operator/cpu-launch','fixture/operator/cpu-cloud'):
        (fs/name).mkdir(mode=0o700,parents=True,exist_ok=True)
    def copy_binary(path,target=None):
        path=Path(path);dest=fs/(str(path).lstrip('/') if target is None else target);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,dest);dest.chmod(0o755)
        output=run(['ldd',str(path)]).stdout.decode()
        for library in re.findall(r'(?:=>\s+)?(/[^\s()]+)',output):
            dest=fs/library.lstrip('/');dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(library,dest);dest.chmod(0o755)
    copy_binary('/usr/bin/python3.11');copy_binary('/usr/bin/busybox','bin/busybox');copy_binary('/usr/bin/age')
    (fs/'usr/bin/python3').symlink_to('python3.11');(fs/'bin/sh').symlink_to('busybox')
    shutil.copytree('/usr/lib/python3.11',fs/'usr/lib/python3.11',ignore=shutil.ignore_patterns('__pycache__','test','tests'))
    for module in Path('/usr/lib/python3.11/lib-dynload').glob('*.so'):
        output=run(['ldd',str(module)]).stdout.decode()
        for library in re.findall(r'(?:=>\s+)?(/[^\s()]+)',output):
            dest=fs/library.lstrip('/');dest.parent.mkdir(parents=True,exist_ok=True)
            if not dest.exists():shutil.copyfile(library,dest);dest.chmod(0o755)
    (fs/'etc/passwd').write_text('root:x:0:0:root:/root:/bin/sh\n');(fs/'etc/group').write_text('root:x:0:\n');(fs/'etc/fstab').write_text('')
    for name in ('mainnet-ops.py','backup-reboot-guest.py','restore-rehearsal.py'):shutil.copyfile(ROOT/'operator/cpu-launch'/name,fs/'fixture/operator/cpu-launch'/name)
    for name in ('archive_policy.py','cyst-capacity.json'):shutil.copyfile(ROOT/'operator/cpu-cloud'/name,fs/'fixture/operator/cpu-cloud'/name)
    run(['age-keygen','-o',str(fs/'fixture/identity')]);(fs/'fixture/private/backup-recipient.txt').write_bytes(run(['age-keygen','-y',str(fs/'fixture/identity')]).stdout)
    (fs/'fixture/source.dump').write_bytes(os.urandom(4*1024**2));(fs/'fixture/source.blob').write_bytes(os.urandom(1024**2))
    init=fs/'fixture-init';init.write_text('#!/bin/sh\n/bin/busybox mount -t proc proc /proc\n/bin/busybox mount -t sysfs sysfs /sys\n/bin/busybox mount -t devtmpfs devtmpfs /dev\n/usr/bin/python3 -B /fixture/operator/cpu-launch/backup-reboot-guest.py > /fixture/guest.log 2>&1\n/bin/busybox cat /fixture/guest.log\n/bin/busybox sync\n/bin/busybox poweroff -f\n');init.chmod(0o755)
    with disk.open('wb') as stream:stream.truncate(384*1024**2)
    run(['/usr/sbin/mkfs.ext4','-F','-q','-d',str(fs),str(disk)],timeout=180)
    kernel=Path('/boot/vmlinuz-'+os.uname().release);initrd=Path('/boot/initrd.img-'+os.uname().release)
    command=[str(qemu),'-no-user-config','-nodefaults','-machine','pc,accel=tcg','-cpu','qemu64','-smp','1','-m','512','-L',str(tools/'usr/share/qemu'),
        '-display','none','-serial','stdio','-monitor','none','-nic','none','-kernel',str(kernel),'-initrd',str(initrd),
        '-append','console=ttyS0 root=/dev/vda rw init=/fixture-init panic=-1 quiet',
        '-drive','file='+str(disk)+',format=raw,if=virtio,cache=writeback']
    with (ROOT/'vm-console.log').open('wb') as log:
        result=subprocess.run(command,env=environment,stdout=log,stderr=subprocess.STDOUT,timeout=600)
    assert result.returncode==0
    proof=folder/'result.json';run(['/usr/sbin/debugfs','-R','dump /fixture/reboot-result.json '+str(proof),str(disk)])
    if not proof.exists():raise RuntimeError('Guest result missing; inspect private vm-console.log')
    value=json.loads(proof.read_text());assert value['passed'] and value['firstBootId']!=value['secondBootId']
    assert Path('/proc/sys/kernel/random/boot_id').read_text().strip()==host_boot
    value.update(hostKernelBootIdUnchanged=True,hostRebooted=False,qemu=version,guestKernel=os.uname().release,guestKernelSha256=sha(kernel),guestInitrdSha256=sha(initrd),
        guestVcpus=1,guestMemoryMiB=512,scratchDiskMiB=384,virtualization='QEMU TCG; no KVM or production hardware passthrough',
        elapsedSeconds=round(time.monotonic()-began,3))
    # The disposable disk contains synthetic key/data remnants; remove it rather
    # than retaining a misleadingly "wiped" VM image as public evidence.
    assert folder.parent==ROOT and not folder.is_symlink();shutil.rmtree(folder)
    value['scratchDiskRootfsAndSyntheticKeysRemoved']=True
    (ROOT/'vm-result.json').write_text(json.dumps(value,indent=2)+'\n');print(json.dumps(value),flush=True)

if __name__=='__main__':main()
