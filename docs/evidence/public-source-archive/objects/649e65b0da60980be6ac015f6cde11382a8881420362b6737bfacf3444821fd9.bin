import * as esbuild from 'esbuild';
import {readFile,writeFile,mkdir,readdir,unlink} from 'node:fs/promises';
await mkdir('dist/assets/app',{recursive:true});
const result=await esbuild.build({entryPoints:['src/runtime/script_main.CNf0m5fQ.mjs'],outdir:'dist/assets/app',entryNames:'telomere-[hash]',chunkNames:'module-[hash]',bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2020',minify:true,metafile:true,external:['https://*','http://*']});
const entry=Object.entries(result.metafile.outputs).find(([,v])=>v.entryPoint?.endsWith('script_main.CNf0m5fQ.mjs'))[0].replace(/^dist/,'');
let html=await readFile('dist/index.html','utf8');
html=html.replace(/\/assets\/app\/(?:ENTRY|telomere-[A-Z0-9]+)\.js/g,entry);
await writeFile('dist/index.html',html);
for(const name of await readdir('dist/assets/app')){const file='dist/assets/app/'+name;if(!result.metafile.outputs[file])await unlink(file)}
await writeFile('BUNDLE-REPORT.json',JSON.stringify({entry,modules:Object.keys(result.metafile.inputs).length,bytes:Object.values(result.metafile.outputs).reduce((n,v)=>n+v.bytes,0)},null,2));
console.log('Native reference animation runtime built:',entry);

await import('./build-assets.mjs');
