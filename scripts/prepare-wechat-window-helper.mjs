import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
export function prepareWeChatWindowHelper(){
 const output=path.resolve('bin/collector/wechat-window-helper.exe');
 if(process.platform!=='win32'){if(!fs.existsSync(output))throw Error('Missing Windows WeChat window helper');return output;}
 const runtime=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');fs.mkdirSync(path.dirname(output),{recursive:true});
 execFileSync(path.join(runtime,'csc.exe'),['/noconfig','/nologo','/target:exe','/platform:anycpu','/r:System.dll','/r:System.Core.dll','/r:System.Web.Extensions.dll',...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(name=>'/r:'+path.join(runtime,'WPF',name)),'/out:'+output,path.resolve('electron/wechat-window-helper.cs')],{windowsHide:true,stdio:'inherit'});return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(prepareWeChatWindowHelper());
