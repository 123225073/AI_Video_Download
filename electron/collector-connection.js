import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import {ClashRoute} from './clash-route.js';

const bundledHash = '26a99c72dc1873982671426af2b60a20ceef9f7bb31e47fb7db42f94de45a818';
export function collectorEnvironment(base=process.env) {
  const env={...base};for(const key of Object.keys(env))if(/^(https?_proxy|all_proxy|no_proxy)$/i.test(key))delete env[key];
  // The upstream is configured explicitly. Inherited HTTP_PROXY would route
  // WeChat back into Clash's collector rule and create a TLS/proxy loop.
  env.NO_PROXY='*';return env;
}
export function retireStaleComponentPid(directory,isRunning=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}) {
  const file=path.join(directory,'wx_video_download.pid');if(!fs.existsSync(file))return false;
  const pid=Number(fs.readFileSync(file,'utf8').trim());if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('视频号组件运行记录无效，请检查连接资料目录');
  if(isRunning(pid))return false;
  // Upstream's Windows tasklist parser treats the "no tasks" message as a running process.
  // Preserve the exact stale record; never terminate a process based on a PID file.
  fs.renameSync(file,`${file}.stale-${randomUUID()}`);return true;
}
const delay = (ms, signal) => new Promise((resolve, reject) => { if (signal?.aborted) return reject(new Error('CANCELLED')); const abort = () => { clearTimeout(timer); reject(new Error('CANCELLED')); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms); signal?.addEventListener('abort', abort, { once: true }); });
function abortable(promise, signal) { if (!signal) return promise; if (signal.aborted) return Promise.reject(new Error('CANCELLED')); return new Promise((resolve, reject) => { const abort=()=>reject(new Error('CANCELLED')); signal.addEventListener('abort',abort,{once:true}); promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort)); }); }
export function upstreamProxy(before, guardedProxy = false) {
  if (guardedProxy) throw new Error('系统代理守卫正在接管网络，但未能确认专用分流配置；原网络保持不变。请检查代理软件的本机控制接口和规则模式，或使用已配置的手动连接。');
  if (before.AutoConfigURL?.value) throw new Error('当前使用自动代理脚本，不能安全自动切换；请在视频号连接的高级选项中使用手动连接');
  if (!Number(before.ProxyEnable?.value)) return '';
  const address = String(before.ProxyServer?.value || '');
  if (!/^[\w.-]+:\d{1,5}$/.test(address) || address === '127.0.0.1:2023') throw new Error('当前代理配置不能安全自动切换；请使用手动连接，原代理保持不变');
  return `http://${address}`;
}
export class CollectorConnection {
  constructor(store, bin, directory, changed, options = {}) {
    this.store=store; this.bin=bin; this.directory=directory; this.changed=changed; this.fetch=options.request || fetch; this.system=options.system || this.runSystem.bind(this); this.guard=options.guard || this.startGuard.bind(this); this.consent=options.consent || (async()=>false); this.waitMs=options.waitMs ?? 120000; this.members=new Set(); this.state={phase:'idle',label:'未使用时保持原网络设置'}; this.started=null; this.ending=null; this.leaseFile=null; this.controller=null; this.closed=false; this.worker=null;
    fs.mkdirSync(directory,{recursive:true});
    this.routing=options.routing || new ClashRoute();
  }
  config() { return { enabled: true, automatic: true, baseUrl:'http://127.0.0.1:2022', ...this.store.get('collector-config','wechat') }; }
  status() { const policy=this.store.get('collector-policy','automatic');return {...this.state, activeTasks:this.members.size, bundled:fs.existsSync(path.join(this.bin,'collector','wx_video_download.exe')), allowed:Boolean(policy?.allowed && (!this.certificate || policy.certificateFingerprint===this.certificate.fingerprint))}; }
  update(phase,label,extra={}) { this.state={phase,label,...extra}; this.changed(); }
  async api(route, body, timeout=15000) {
    const base=this.config().baseUrl; if (base !== 'http://127.0.0.1:2022') throw new Error('自动连接使用内置本机接口；自定义服务请关闭自动切换');
    const response=await this.fetch(new URL(route,base),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(timeout)});
    if(!response.ok) throw new Error(`微信连接接口暂不可用（HTTP ${response.status}）`);
    const result=await response.json(); if(Number(result.code)!==0) throw new Error('微信连接组件未完成请求，请重新准备连接'); return result.data;
  }
  async online() { try{return (await this.api('/api/channels/status',null,2500)).available === true;}catch{return false;} }
  runSystem(action,stateFile=null,signal=null) {
    const systemScript=path.join(this.bin,'collector','collector-system.ps1');
    return new Promise((resolve,reject)=>{
      const args=['-NoProfile','-NonInteractive','-File',systemScript,'-Action',action,'-OwnerProcess',String(process.pid)];if(stateFile)args.push('-StateFile',stateFile);
      if(signal?.aborted)return reject(new Error('CANCELLED'));
      const child=spawn('powershell.exe',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',timedOut=false;
      const terminate=()=>{const cleanup=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});cleanup.on('error',()=>child.kill());};
      const timer=setTimeout(()=>{timedOut=true;terminate();},action==='apply'?180000:action==='restore'?120000:45000);signal?.addEventListener('abort',terminate,{once:true});child.stdout.on('data',b=>output+=b);child.stderr.resume();child.on('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',terminate);reject(new Error('Windows连接辅助程序未能启动'));});
      child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',terminate);if(signal?.aborted)return reject(new Error('CANCELLED'));let result;try{result=JSON.parse(output.replace(/^\uFEFF/,''));}catch{}
        if(code!==0){const stages={'certificate-check':'证书检查','certificate-add':'临时证书信任','certificate-remove':'临时证书移除','proxy-apply':'代理切换','proxy-restore':'原代理恢复','route-restore':'Clash 分流恢复','restore-state':'恢复记录读取','restore-save':'恢复记录保存'};const stage=stages[result?.stage] || (action==='restore'?'连接恢复':'连接准备');return reject(new Error(timedOut?`${stage}超时；未继续采集，恢复记录保留在本机`:`${stage}失败${Number.isInteger(result?.errorCode)?`（Windows 错误 ${result.errorCode}）`:''}；恢复记录保留在本机`));}
        if(!result)return reject(new Error('Windows连接检查返回无效结果'));resolve(result);
      });
    });
  }
  async startGuard(file) {
    const systemScript=path.join(this.bin,'collector','collector-system.ps1');
    // Windows PowerShell exits silently with Node's DETACHED_PROCESS flag.
    // A hidden Start-Process child survives the owner without requiring a console.
    const args=`-NoProfile -NonInteractive -File "${systemScript}" -Action guard -StateFile "${file}"`;
    const command=`Start-Process -FilePath 'powershell.exe' -ArgumentList '${args.replaceAll("'","''")}' -WindowStyle Hidden`;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
    let failed=false;child.on('error',()=>failed=true);
    for(let i=0;i<40;i++){if(fs.existsSync(file+'.guard-ready'))return;if(failed || (child.exitCode!==null && child.exitCode!==0))break;await delay(250);}
    throw new Error('网络恢复守护未能启动，本次不切换系统代理');
  }
  async recover() {
    for(const name of fs.readdirSync(this.directory).filter(n=>/^lease-[\w-]+\.json$/.test(n))) {
      const file=path.join(this.directory,name); let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('上次网络恢复记录无法读取，请检查视频号连接');}
      if(saved.phase!=='restored') { await this.system('restore',file); this.update('idle','已恢复上次中断的网络设置'); }
    }
  }
  prepare() {if(this.state.phase==='error')return Promise.reject(new Error('上次网络恢复尚未完成，请先点击恢复原网络'));if(!this.preparing)this.preparing=this.prepareComponent().finally(()=>this.preparing=null);return this.preparing;}
  async prepareComponent() {
    this.update('preparing','正在准备内置视频号组件');
    let ready=false; try {await this.api('/api/channels/status',null,2000);ready=true;}catch{}
    if(!ready) {
      const executable=path.join(this.bin,'collector','wx_video_download.exe');
      if(!fs.existsSync(executable) || createHash('sha256').update(fs.readFileSync(executable)).digest('hex')!==bundledHash) throw new Error('内置微信组件缺失或校验失败，请重新安装程序');
      const config=path.join(this.directory,'component.yaml');
      if(!fs.existsSync(config)) fs.writeFileSync(config,'api:\n  hostname: 127.0.0.1\n  port: 2022\nproxy:\n  enabled: false\n  system: false\n  skipInstallRootCert: true\n  tun: false\n  tcpRelay:\n    enabled: false\n');
      retireStaleComponentPid(this.directory);
      this.worker=spawn(executable,['server','--config',config,'--workdir',this.directory],{cwd:this.directory,env:collectorEnvironment(),windowsHide:true,stdio:'ignore'}); this.worker.on('error',()=>{});
      for(let i=0;i<15;i++){await delay(500);try{await this.api('/api/channels/status',null,1000);ready=true;break;}catch{}}
      if(!ready) throw new Error('视频号组件未能启动，可能被安全软件拦截或本机端口被占用');
    }
    let certificate=await this.api('/api/proxy/certificate/status');
    if(certificate.is_legacy || !certificate.name?.startsWith('Fengsha-WeChat-') || new Date(certificate.detail?.not_after).getTime() < Date.now()+86400000 || new Date(certificate.detail?.not_after).getTime()>Date.now()+2*366*86400000) {
      const proxy=await this.api('/api/proxy/status');
      if(proxy.service?.listening || proxy.proxy?.listening) throw new Error('已有其他微信采集连接正在使用该端口，请先关闭它或选择手动连接');
      await this.api('/api/proxy/certificate/generate',{name:`Fengsha-WeChat-${randomUUID().slice(0,8)}`,valid_years:2,install:false,restart:false}); certificate=await this.api('/api/proxy/certificate/status');
    }
    const response=await this.fetch(new URL('/api/proxy/certificate/pem',this.config().baseUrl),{redirect:'error',signal:AbortSignal.timeout(10000)}); if(!response.ok) throw new Error('本机专用证书未准备好');
    const pem=await response.text(); if(!pem.includes('BEGIN CERTIFICATE') || pem.length>32768) throw new Error('本机证书格式异常');
    const file=path.join(this.directory,'local-certificate.pem');fs.writeFileSync(file,pem);
    const parsed=new X509Certificate(pem);if(!parsed.ca || parsed.validToDate < new Date() || !parsed.subject.includes(certificate.name))throw new Error('本机证书身份异常，请检查视频号连接');
    this.certificate={name:certificate.name,file,fingerprint:parsed.fingerprint256}; this.update('prepared','组件已准备；识别和下载时自动连接，微信登录仍在微信完成'); return this.status();
  }
  async allow() {
    await this.prepare(); const inspection=await this.system('inspect'); const plan=await this.routing.discover(inspection.proxy);const upstream=plan?'':upstreamProxy(inspection.proxy,inspection.guardedProxy);
    if(!await this.consent({certificate:this.certificate.name,proxyBefore:inspection.proxy.ProxyServer.value || '直接连接',upstream})) return false;
    this.store.put('collector-policy','automatic',{allowed:true,certificateFingerprint:this.certificate.fingerprint,confirmedAt:Date.now()});this.store.flush();this.changed();return true;
  }
  async begin(signal) {
    if(!this.certificate)await this.prepare(); if(signal.aborted) throw new Error('CANCELLED');
    if(await this.online()){this.update('connected','微信已连接；当前任务无需切换系统代理');return;}
    const inspected=await this.system('inspect');const plan=await this.routing.discover(inspected.proxy);const upstream=plan?'':upstreamProxy(inspected.proxy,inspected.guardedProxy);
    const id=randomUUID(); this.leaseFile=path.join(this.directory,`lease-${id}.json`);
    fs.writeFileSync(this.leaseFile,JSON.stringify({schema:1,id,mode:plan?'routed':'system',routing:plan,owner:process.pid,ownerStarted:inspected.ownerStarted,before:inspected.proxy,proxyAddress:'127.0.0.1:2023',certificateName:this.certificate.name,certificateFile:this.certificate.file,certificateFingerprint:this.certificate.fingerprint,certificateThumbprint:'',certificateAdded:false,phase:'prepared'}));
    await this.guard(this.leaseFile);
    await this.api('/api/proxy/config',{values:{'proxy.enabled':true,'proxy.system':false,'proxy.hostname':'127.0.0.1','proxy.port':2023,'proxy.skipInstallRootCert':true,'proxy.tun':false,'proxy.tcpRelay.enabled':false,'proxy.upstreamProxy':upstream},restart:true},30000);
    if(signal.aborted) throw new Error('CANCELLED');
    this.update('trusting','正在准备微信连接；如 Windows 显示证书确认，请核对 Fengsha-WeChat- 名称后确认');
    await this.system('apply',this.leaseFile,signal);
    if(plan)await this.routing.begin(plan);
    const applied = await this.system('inspect');
    if(plan){if(JSON.stringify(applied.proxy)!==JSON.stringify(inspected.proxy))throw new Error('连接准备期间系统代理发生变化，视频号采集已停止，请重试');}
    else if (!Number(applied.proxy?.ProxyEnable?.value) || applied.proxy?.ProxyServer?.value !== '127.0.0.1:2023' || applied.proxy?.AutoConfigURL?.value) throw new Error('系统代理切换未生效或已被其他程序修改，微信采集已停止；请检查代理软件的系统代理设置后再试');
    this.update('waiting',plan?'视频号专用分流已开启，Clash 保持运行：请打开或重新进入微信的视频号页面':'连接已临时开启：请在微信中打开或重新进入视频号页面，连接后自动继续');
    const deadline=Date.now()+this.waitMs;
    do { if(signal.aborted) throw new Error('CANCELLED');if(await this.online()){this.update('connected','微信已连接 · 当前任务结束后自动恢复原网络');return;}await delay(1000,signal); } while(Date.now()<deadline);
    throw new Error('未等到微信视频号页面连接，原网络将自动恢复；请重新进入微信视频号页面后再试');
  }
  async withConnection(signal,operation) {
    if(this.closed) throw new Error('应用正在退出');
    if(signal?.aborted)throw new Error('CANCELLED');
    if(!this.config().automatic) return operation();
    if(!this.config().enabled) throw new Error('请先在视频号连接中启用作者作品读取');
    if(this.ending) await this.ending;
    if(this.state.phase==='error') throw new Error('上次网络恢复尚未完成，请先在视频号连接中恢复原网络');
    if(!this.started)await this.prepare();
    if(!this.status().allowed) {if(!this.approving)this.approving=this.allow().finally(()=>this.approving=null);if(!await abortable(this.approving,signal))throw new Error('尚未确认微信自动连接，请在视频号连接中完成首次确认');}
    // Preparation/confirmation can outlive a previous task's final restoration.
    // Recheck after those awaits before joining or starting a lease.
    if(this.ending)await this.ending;
    if(this.closed || signal?.aborted)throw new Error('CANCELLED');
    if(this.state.phase==='error')throw new Error('上次网络恢复尚未完成，请先在视频号连接中恢复原网络');
    const member=randomUUID();this.members.add(member);
    try {
      if(!this.started){this.controller=new AbortController();this.started=this.begin(this.controller.signal);}
      await abortable(this.started,signal); if(signal?.aborted) throw new Error('CANCELLED');return await operation();
    } finally {
      this.members.delete(member);
      if(!this.members.size) { this.ending=this.finish();try{await this.ending;}finally{this.ending=null;} }
      this.changed();
    }
  }
  async finish() {
    this.controller?.abort();await this.started?.catch(()=>{});
    try {
      if(this.leaseFile){this.update('restoring','正在恢复原代理与临时证书');const routed=JSON.parse(fs.readFileSync(this.leaseFile,'utf8')).mode==='routed';if(routed)await this.system('restore',this.leaseFile);else{await this.api('/api/proxy/config',{values:{'proxy.enabled':false,'proxy.system':false},restart:true}).catch(()=>{});await this.system('restore',this.leaseFile);} }
      this.update('idle','当前任务已结束，原网络设置已恢复');
    } catch(error){this.update('error','自动恢复尚未完成，请点击恢复原网络');throw error;}
    finally {this.started=null;this.controller=null;if(this.state.phase!=='error')this.leaseFile=null;}
  }
  async restore() { if(this.members.size) throw new Error('请先停止作品读取和视频号下载，再恢复网络');await this.recover();this.leaseFile=null;this.update('idle','原网络设置已恢复');return this.status(); }
  async close(){this.closed=true;this.controller?.abort();await this.ending;await this.finish();this.worker?.kill();}
}
