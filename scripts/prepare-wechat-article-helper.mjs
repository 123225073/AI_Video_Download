import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const output=path.resolve('bin/collector/wechat-article-helper.exe');
if(process.platform==='win32'){
 fs.mkdirSync(path.dirname(output),{recursive:true});
 const source=fs.readFileSync('electron/wechat-article-helper.cs','utf8');if(source.slice(0,64).includes('%TSD-Header'))throw Error('微信文章采集源码当前不可读取，未替换组件');
 execFileSync('pwsh.exe',['-NoProfile','-File',path.resolve('scripts/compile-wechat-helper.ps1'),'-SourcePath','-','-TargetPath',output],{input:source,encoding:'utf8',windowsHide:true,stdio:['pipe','inherit','inherit']});
}else if(!fs.existsSync(output))throw Error('Missing desktop WeChat article helper');
console.log('Prepared desktop WeChat article helper');
