import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
fs.mkdirSync('bin/collector',{recursive:true});
// Bundle the interop assembly. Windows PowerShell's runtime CodeDOM compilation
// can fail with a machine's compiler response configuration; do not alter it.
if(process.platform==='win32') {
  const compiler=path.join(process.env.SystemRoot || 'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  execFileSync(compiler,['/noconfig','/nologo','/target:library','/r:System.dll',`/out:${path.resolve('bin/collector/collector-native.dll')}`,path.resolve('electron/collector-native.cs')],{windowsHide:true,stdio:'inherit'});
}
if(!fs.existsSync('bin/collector/collector-native.dll'))throw new Error('Missing Windows collector interop assembly');
fs.writeFileSync('bin/collector/collector-system.ps1','\uFEFF'+fs.readFileSync('electron/collector-system.ps1','utf8').replace(/^\uFEFF/,''));
await build({entryPoints:['scripts/clash-route-helper.mjs'],outfile:'bin/collector/clash-route-helper.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'});
fs.writeFileSync('bin/collector/LICENSE-yaml',fs.readFileSync('node_modules/yaml/LICENSE'));
