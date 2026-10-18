import * as esbuild from 'esbuild';
import {readFile,writeFile,mkdir,readdir,unlink,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,sep,dirname} from 'node:path';
if(esbuild.version!=='0.28.2')throw Error('Install the reviewed esbuild builder');
const cms=JSON.parse(await readFile('cms-manifest.json','utf8')),urls=new Map(),paths=new Set();
if(cms.schemaVersion!==1||!Array.isArray(cms.files)||cms.files.length!==16)throw Error('Invalid public CMS export inventory');
for(const row of cms.files){
 if(!/^https:\/\/framerusercontent\.com\/cms\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.framercms$/.test(row.url)
  ||row.path!=='dist/assets/cms/'+row.url.split('/').pop()||paths.has(row.path)||urls.has(row.url)
  ||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>512*1024||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('Invalid CMS source binding');
 const stat=await lstat(row.path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('CMS export must be a regular file');
 const data=await readFile(row.path);if(data.length!==row.bytes||createHash('sha256').update(data).digest('hex')!==row.sha256)throw Error('CMS export bytes differ');
 paths.add(row.path);urls.set(row.url,'/'+row.path.replace(/^dist\//,''));
}
const cmsPattern=/new URL\(`(\.\/[^`]+\.framercms)`,`(https:\/\/framerusercontent\.com\/modules\/[^`]+)`\)\.href\.replace\(`\/modules\/`,`\/cms\/`\)/g;
const sourceRoot=resolve('src/runtime')+sep;
const localCms={name:'reviewed-local-cms',setup(build){build.onLoad({filter:/\.mjs$/},async args=>{
 if(!args.path.startsWith(sourceRoot))return;
 const contents=(await readFile(args.path,'utf8')).replace(cmsPattern,(_match,relative,base)=>{
  const remote=new URL(relative,base).href.replace('/modules/','/cms/'),local=urls.get(remote);
  if(!local)throw Error('Unreviewed remote CMS reference');
  return `new URL(${JSON.stringify(local)},import.meta.url).href`;
 });
 return {contents,loader:'js',resolveDir:dirname(args.path)};
})}};
await mkdir('dist/assets/app',{recursive:true});
const result=await esbuild.build({entryPoints:['src/runtime/script_main.CNf0m5fQ.mjs'],outdir:'dist/assets/app',entryNames:'telomere-[hash]',chunkNames:'module-[hash]',bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2020',minify:true,metafile:true,plugins:[localCms],external:['https://*','http://*']});
const entry=Object.entries(result.metafile.outputs).find(([,v])=>v.entryPoint?.endsWith('script_main.CNf0m5fQ.mjs'))[0].replace(/^dist/,'');
let html=await readFile('dist/index.html','utf8');
html=html.replace(/\/assets\/app\/(?:ENTRY|telomere-[A-Z0-9]+)\.js/g,entry);
await writeFile('dist/index.html',html);
for(const name of await readdir('dist/assets/app')){const file='dist/assets/app/'+name;if(!result.metafile.outputs[file])await unlink(file)}
await writeFile('BUNDLE-REPORT.json',JSON.stringify({entry,modules:Object.keys(result.metafile.inputs).length,bytes:Object.values(result.metafile.outputs).reduce((n,v)=>n+v.bytes,0)},null,2));
console.log('Native reference animation runtime built:',entry);

await import('./build-assets.mjs');
