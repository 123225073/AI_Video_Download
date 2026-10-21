import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {chromeActivePort,externalChromeStatus} from './external-browser.js';

// A separate, persistent profile is required by Chrome 136+. Never change or
// copy the user's normal Chrome/Edge profile, policies, credentials or proxy.
export function browserCandidates(env=process.env){
  const locations=[env.LOCALAPPDATA,env.PROGRAMFILES,env['PROGRAMFILES(X86)']].filter(Boolean);
  return [
    ...locations.map(root=>({name:'Chrome',kind:'chrome',executable:path.join(root,'Google','Chrome','Application','chrome.exe')})),
    ...locations.map(root=>({name:'Edge',kind:'edge',executable:path.join(root,'Microsoft','Edge','Application','msedge.exe')}))
  ];
}

const runFile=promisify(execFile);
// Read the registered application executable only. This covers custom install
// locations without searching disks, executing shell commands from registry
// values, or changing the user's registry/browser defaults.
const registryProbe=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$found=@()
$views=@([Microsoft.Win32.RegistryView]::Default)
if([Environment]::Is64BitOperatingSystem){$views=@([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)}
foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){
  foreach($view in $views){
    $base=$null
    try{
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      foreach($browser in @(@{kind='chrome';exe='chrome.exe'},@{kind='edge';exe='msedge.exe'})){
        $key=$null
        try{
          $key=$base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\'+$browser.exe,$false)
          if($key){$value=$key.GetValue('');if($value -is [string] -and $value){$found+=@{kind=$browser.kind;executable=$value}}}
        }catch{}finally{if($key){$key.Dispose()}}
      }
    }catch{}finally{if($base){$base.Dispose()}}
  }
}
ConvertTo-Json -InputObject @($found) -Compress
`;

export async function registeredBrowserCandidates({platform=process.platform,env=process.env,run=runFile}={}){
  if(platform!=='win32')return [];
  try{
    const powershell=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout}=await run(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(registryProbe,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:64*1024,encoding:'utf8'});
    const entries=JSON.parse(String(stdout).replace(/^\uFEFF/,''));
    if(!Array.isArray(entries))return [];
    return entries.flatMap(entry=>{
      if(!entry||!['chrome','edge'].includes(entry.kind)||typeof entry.executable!=='string')return [];
      const executable=entry.executable.trim().replace(/^"([^"]+)"$/,'$1');
      if(!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!==(entry.kind==='chrome'?'chrome.exe':'msedge.exe'))return [];
      return [{kind:entry.kind,name:entry.kind==='chrome'?'Chrome':'Edge',executable}];
    });
  }catch{return [];}
}

export async function discoverBrowserCandidates({env=process.env,registered=registeredBrowserCandidates}={}){
  const candidates=[...browserCandidates(env),...await registered({env})],seen=new Set();
  return candidates.filter(candidate=>{const key=candidate.executable.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
}

export class ManagedBrowser{
  constructor({directory,candidates,discover=discoverBrowserCandidates,exists=async file=>{try{return (await fs.stat(file)).isFile();}catch{return false;}},mkdir=fs.mkdir,spawnProcess=spawn,readActivePort=chromeActivePort,readStatus=externalChromeStatus,wait=delay,startTimeoutMs=15000,pollMs=150}={}){
    if(!directory||!path.isAbsolute(directory))throw Error('专用浏览器资料目录必须是绝对路径');
    Object.assign(this,{directory:path.resolve(directory),candidates,discover,exists,mkdir,spawnProcess,readActivePort,readStatus,wait,startTimeoutMs,pollMs});
    this.starting=null;this.controller=null;this.selected=null;
  }
  async selection(){
    if(this.selected&&await this.exists(this.selected.executable))return this.selected;
    // Keep the browser family stable across launches when both are installed.
    const available=[];
    const collect=async candidates=>{for(const candidate of candidates){
      if(!path.isAbsolute(candidate.executable)||!['chrome','edge'].includes(candidate.kind))continue;
      if(await this.exists(candidate.executable))available.push({...candidate,profile:path.join(this.directory,candidate.kind)});
    }};
    await collect(this.candidates||browserCandidates());
    const retainedFamilies=[];
    for(const kind of ['chrome','edge'])if(await this.exists(path.join(this.directory,kind,'Local State')))retainedFamilies.push(kind);
    // Normal installs need no subprocess. Query registered custom locations only
    // if no browser was found, or an existing profile's browser is missing from
    // the standard candidates. An installed Edge must not hide a custom Chrome
    // installation and make its preserved login appear to have disappeared.
    if(!this.candidates&&(!available.length||retainedFamilies.some(kind=>!available.some(candidate=>candidate.kind===kind))))await collect(await(this.discovery||(this.discovery=this.discover().finally(()=>{this.discovery=null;}))));
    for(const candidate of available)if(await this.exists(path.join(candidate.profile,'Local State')))return this.selected=candidate;
    return this.selected=available[0]||null;
  }
  async inspect(browser){
    const socketURL=await this.readActivePort({file:path.join(browser.profile,'DevToolsActivePort')});
    if(!socketURL)return null;
    const endpoint=new URL(socketURL).origin.replace(/^ws:/,'http:');
    const status=await this.readStatus({endpoint,discover:false,timeoutMs:700});
    // A stale port may have been reused by another process. Accept only the
    // exact browser ID recorded in this application's own profile.
    return status.available&&status.socketURL===socketURL?{...status,mode:'managed',browserName:browser.name,requiresApproval:false,canStart:true,message:`${browser.name} 专用浏览器已连接，后续使用自动复用。`}:null;
  }
  async status(){
    const browser=await this.selection();
    if(!browser)return {available:false,mode:'managed',reason:'browser-missing',canStart:false,message:'未找到 Chrome 或 Microsoft Edge。请安装其中一种官方浏览器，然后重试；无需配置 IP、端口或调试权限。'};
    return await this.inspect(browser)||{available:false,mode:'managed',reason:'prepared',canStart:true,browserName:browser.name,message:`${browser.name} 已准备，使用时自动启动专用浏览器；首次登录后保留会话，无需设置 IP 或端口。`};
  }
  async ensure(){
    if(this.starting)return this.starting;
    this.controller=new AbortController();const signal=this.controller.signal;
    this.starting=this.start(signal);
    try{return await this.starting;}finally{this.starting=null;this.controller=null;}
  }
  async start(signal){
    const browser=await this.selection();signal.throwIfAborted();
    if(!browser)throw Object.assign(Error((await this.status()).message),{reason:'browser-missing'});
    const existing=await this.inspect(browser);signal.throwIfAborted();if(existing)return existing;
    await this.mkdir(browser.profile,{recursive:true});signal.throwIfAborted();
    const args=[`--user-data-dir=${browser.profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--no-startup-window'];
    let failure=null,exited=false;
    const child=this.spawnProcess(browser.executable,args,{windowsHide:true,stdio:'ignore'});
    const failed=()=>{failure=Error(`${browser.name} 专用浏览器未能启动，请检查浏览器是否正常安装。`);};
    const exit=code=>{exited=true;if(code!==0)failure=Error(`${browser.name} 专用浏览器启动失败，请检查本机浏览器或组织策略。`);};
    child.once('error',failed);child.once('exit',exit);child.unref?.();
    try{
      const until=Date.now()+this.startTimeoutMs;
      do{
        signal.throwIfAborted();if(failure)throw failure;
        const ready=await this.inspect(browser);signal.throwIfAborted();if(ready)return ready;
        await this.wait(this.pollMs,undefined,{signal});
      }while(Date.now()<until);
      throw Error(`${browser.name} 专用浏览器启动超时，请关闭本工具的空白专用浏览器窗口后重试；组织策略限制需要管理员处理。`);
    }finally{
      // Do not kill a browser process: it may already hold a user's open page.
      // Successful and interrupted starts retain their own profile and can be
      // reconnected on the next attempt. No personal browser is ever targeted.
      child.removeListener('exit',exit);if(exited)child.removeListener('error',failed);
    }
  }
  cancelPending(){this.controller?.abort(Error('专用浏览器准备已取消'));}
}
