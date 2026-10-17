// Execute the Windows-skipped POSIX storage case against the frozen Linux runtime.
import {chmod,mkdtemp,readdir,rename,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {openStore} from '/opt/telomere-mainnet-pilot/app/dist/src/store.js';
import {CystService} from '/opt/telomere-mainnet-pilot/app/dist/src/cysts/service.js';
import {PrivateCystStorage} from '/opt/telomere-mainnet-pilot/app/dist/src/cysts/storage.js';
import {encryptCheckpoint} from '/opt/telomere-mainnet-pilot/app/dist/src/sdk/cysts.js';
const parent='/opt/telomere-mainnet-pilot/data/cpu-launch-acceptance-20261017';
const directory=await mkdtemp(parent+'/cyst-posix-');await chmod(directory,0o700);
const store=await openStore({DATA_DIR:':memory:'});
const check=(value,message)=>{if(!value)throw Error(message)};
let checks=0;
async function rejected(operation){try{await operation()}catch(error){if(error.code==='cyst_storage_unavailable'){checks++;return}throw error}throw Error('Unsafe storage accepted')}
try{
  const owner='0x1111111111111111111111111111111111111111';
  const service=new CystService(store.db,join(directory,'cysts'));await service.initialize();
  const {envelope}=await encryptCheckpoint(new TextEncoder().encode('isolated POSIX fixture'),{owner,applicationSchema:'posix.v1'});
  await service.upload(owner,envelope,'posix-storage-test');
  const file=(await readdir(service.privateDirectory))[0];check(file,'Fixture blob');
  const path=join(service.privateDirectory,file);
  check(((await stat(service.privateDirectory)).mode&0o077)===0&&((await stat(path)).mode&0o077)===0,'Private modes');checks++;
  await chmod(path,0o644);await rejected(()=>service.download(owner,envelope.id));
  await chmod(path,0o600);const original=path+'.original';await rename(path,original);await symlink(original,path);
  await rejected(()=>service.download(owner,envelope.id));
  const linked=join(directory,'linked-root');await symlink(service.privateDirectory,linked);
  await rejected(()=>new PrivateCystStorage(linked).initialize());
  await symlink(original,join(service.privateDirectory,'.tmp-12345678-1234-1234-1234-123456789abc'));
  await rejected(()=>new PrivateCystStorage(service.privateDirectory).initialize());
  const report={passed:true,platform:process.platform,uid:process.getuid(),checks,scope:'Frozen runtime, disposable encrypted Cyst and in-memory database',
    privateModes:true,publicModeRefused:true,symlinkBlobRefused:true,symlinkRootRefused:true,symlinkTemporaryRefused:true,mainnetTransactions:0};
  await writeFile(parent+'/cyst-posix-result.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');
}finally{await store.close();check(dirname(directory)===parent,'Cleanup scope');await rm(directory,{recursive:true,force:true})}
