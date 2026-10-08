import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/store.js';
import { CollectorConnection,upstreamProxy,retireStaleComponentPid,collectorEnvironment } from '../electron/collector-connection.js';
test('采集子进程不继承代理回环；保留 Codex 和其他程序的代理环境',()=>{const original={HTTP_PROXY:'http://127.0.0.1:7897',https_proxy:'http://127.0.0.1:7897',ALL_PROXY:'http://127.0.0.1:7897',NO_PROXY:'localhost',PATH:'original'};const env=collectorEnvironment(original);assert.equal(env.NO_PROXY,'*');assert.equal(env.HTTP_PROXY,undefined);assert.equal(env.https_proxy,undefined);assert.equal(env.ALL_PROXY,undefined);assert.equal(env.PATH,original.PATH);assert.equal(original.HTTP_PROXY,'http://127.0.0.1:7897');});
const before={ProxyEnable:{present:true,value:1},ProxyServer:{present:true,value:'127.0.0.1:7897'},ProxyOverride:{present:true,value:'localhost;<local>'},AutoConfigURL:{present:false,value:null}};
test('active Clash proxy guard blocks before certificate or proxy changes', async()=>{
  const {connection,store,calls}=await fixture();const original=connection.system;
  connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start',guardedProxy:true}:original(action,file);
  await assert.rejects(connection.withConnection(undefined,async()=>{throw Error('must not collect');}),/系统代理守卫/);
  assert.equal(calls.includes('apply'),false);assert.equal(calls.includes('guard'),false);assert.equal(connection.leaseFile,null);await connection.close();store.close();
});
test('a refused or overwritten proxy change cannot enter the waiting/collection phase', async()=>{
  const {connection,store,calls}=await fixture();let inspected=0,called=false;
  const original=connection.system;connection.system=async(action,file)=>{if(action==='inspect'){inspected++;return {proxy:before,ownerStarted:'start'};}return original(action,file);};
  await assert.rejects(connection.withConnection(undefined,async()=>{called=true;}),/代理.*未.*生效|代理.*未.*切换/);
  assert.equal(called,false);assert.ok(inspected>=2);assert.ok(calls.includes('restore'));await connection.close();store.close();
});
test('Clash 守卫开启时选择专用分流，不写系统代理，也不把 Clash 配作采集上游',async()=>{
 const routeCalls=[],plan={directory:'isolated-fixture',rulesDigest:'fixture'};
 const {connection,store}=await fixture({routing:{discover:async()=>plan,begin:async p=>{assert.equal(p,plan);routeCalls.push('begin');}}});const system=connection.system;
 connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start',guardedProxy:true}:system(action,file);
 let upstream;connection.api=async(_route,body)=>{if(body.values['proxy.enabled'])upstream=body.values['proxy.upstreamProxy'];};
 await connection.withConnection(undefined,async()=>{const lease=JSON.parse(fs.readFileSync(connection.leaseFile));assert.equal(lease.mode,'routed');assert.deepEqual(lease.before,before);assert.deepEqual(lease.routing,plan);});
 assert.equal(upstream,'');assert.deepEqual(routeCalls,['begin']);await connection.close();store.close();
});
async function fixture(options={}) {
  const directory=path.resolve('output/unit-connection',randomUUID()),store=await Store.open(directory,{}),calls=[];let online=false;
  store.put('collector-policy','automatic',{allowed:true,certificateFingerprint:'unit'});store.flush();
  const connection=new CollectorConnection(store,'',directory,()=>{},{routing:{discover:async()=>null},waitMs:20,guard:async()=>calls.push('guard'),system:async(action,file)=>{calls.push(action);if(action==='inspect')return {proxy:online?{...before,ProxyServer:{present:true,value:'127.0.0.1:2023'}}:before,ownerStarted:'start'};if(action==='apply')online=true;if(action==='restore'){online=false;const state=JSON.parse(fs.readFileSync(file));state.phase='restored';fs.writeFileSync(file,JSON.stringify(state));}return {};},...options});
  connection.prepare=async()=>{connection.certificate={name:'Fengsha-WeChat-unit',file:'test-public-certificate',fingerprint:'unit'};return connection.status();};
  connection.online=async()=>online;connection.api=async(route,body)=>{calls.push(body.values['proxy.enabled']?'start-proxy':'stop-proxy');return {};};
  return {connection,store,calls};
}
test('按任务自动切换：并发任务共享一次连接，最后一个任务完成才恢复',async()=>{
  const {connection,store,calls}=await fixture();let releaseA,releaseB;const waitA=new Promise(r=>releaseA=r),waitB=new Promise(r=>releaseB=r);
  const a=connection.withConnection(undefined,()=>waitA),b=connection.withConnection(undefined,()=>waitB);await new Promise(r=>setTimeout(r,20));
  assert.equal(calls.filter(x=>x==='apply').length,1);assert.equal(connection.status().activeTasks,2);releaseA();await a;assert.equal(calls.includes('restore'),false);releaseB();await b;
  assert.equal(calls.filter(x=>x==='restore').length,1);assert.equal(connection.status().phase,'idle');assert.equal(calls.indexOf('guard')<calls.indexOf('apply'),true);await connection.close();store.close();
});
test('失败和取消恢复原网络；超时后不留下临时代理',async()=>{
  for(const mode of ['failed','cancelled','timeout']) {const {connection,store,calls}=await fixture();const controller=new AbortController();if(mode==='timeout')connection.online=async()=>false;
    const run=connection.withConnection(controller.signal,async()=>{if(mode==='failed')throw new Error('failed');return new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('CANCELLED')),{once:true}));});
    if(mode==='cancelled')setTimeout(()=>controller.abort(),20);await assert.rejects(run);assert.ok(calls.includes('restore'),mode);assert.equal(connection.members.size,0);await connection.close();store.close();}
});
test('拒绝首次授权不变更代理；恢复守护启动失败时禁止系统切换',async()=>{
  const {connection,store,calls}=await fixture();store.put('collector-policy','automatic',{allowed:false});connection.consent=async()=>false;
  await assert.rejects(connection.withConnection(undefined,async()=>{}),/尚未确认/);assert.ok(!calls.includes('apply'));
  store.put('collector-policy','automatic',{allowed:true,certificateFingerprint:'unit'});connection.guard=async()=>{throw new Error('guard failed');};await assert.rejects(connection.withConnection(undefined,async()=>{}),/guard failed/);assert.ok(!calls.includes('apply'));await connection.close();store.close();
});
test('自动准备无需弹窗，更新证书身份后绑定新指纹且保留任务恢复',async()=>{
  const {connection,store,calls}=await fixture();let prepared=0;
  store.put('collector-policy','automatic',{allowed:true,certificateFingerprint:'old-certificate'});
  connection.consent=async()=>{prepared++;return true;};
  await connection.withConnection(undefined,async()=>{
    const lease=JSON.parse(fs.readFileSync(connection.leaseFile));
    assert.equal(lease.certificateFingerprint,'unit');
    assert.equal(store.get('collector-policy','automatic').certificateFingerprint,'unit');
    assert.equal(connection.status().phase,'connected');
  });
  assert.equal(prepared,1);assert.equal(calls.filter(x=>x==='apply').length,1);
  assert.equal(calls.filter(x=>x==='restore').length,1);assert.equal(connection.status().phase,'idle');
  await connection.close();store.close();
});
test('恢复失败明确阻止新任务，手动恢复后可以重新开始；复杂原代理不被覆盖',async()=>{
  assert.equal(upstreamProxy(before),'http://127.0.0.1:7897');assert.throws(()=>upstreamProxy({...before,AutoConfigURL:{value:'https://example/pac'}}),/自动代理/);assert.throws(()=>upstreamProxy({...before,ProxyServer:{value:'http=a:1;https=b:2'}}),/不能安全/);
  const {connection,store}=await fixture();const system=connection.system;connection.system=async(action,file)=>{if(action==='restore')throw new Error('locked');return system(action,file);};await assert.rejects(connection.withConnection(undefined,async()=>{}),/locked/);assert.equal(connection.status().phase,'error');await assert.rejects(connection.withConnection(undefined,async()=>{}),/上次网络恢复/);
  connection.system=system;await connection.restore();await connection.withConnection(undefined,async()=>{});await connection.close();store.close();
});
test('慢速准备期间旧任务进入恢复，新任务必须等待恢复结束再切换',async()=>{
  const {connection,store,calls}=await fixture();let finishA,finishPreparation,finishRestore;
  const aWork=new Promise(r=>finishA=r),preparation=new Promise(r=>finishPreparation=r),restoration=new Promise(r=>finishRestore=r);
  const prepare=connection.prepare,system=connection.system;let prepared=0,restored=0;
  connection.prepare=async()=>{if(++prepared===2)await preparation;return prepare();};
  connection.system=async(action,file)=>{if(action==='restore'&&++restored===1)await restoration;return system(action,file);};
  const a=connection.withConnection(undefined,()=>aWork),b=connection.withConnection(undefined,async()=>{});
  await new Promise(r=>setTimeout(r,20));finishA();await new Promise(r=>setTimeout(r,20));finishPreparation();await new Promise(r=>setTimeout(r,20));
  assert.equal(calls.filter(c=>c==='apply').length,1);finishRestore();await Promise.all([a,b]);assert.equal(calls.filter(c=>c==='apply').length,2);
  assert.equal(connection.status().phase,'idle');await connection.close();store.close();
});

test('重新准备不能清除未恢复状态；组件停止失败不掩盖已经完成的系统恢复',async()=>{
  const {connection,store,calls}=await fixture();
  connection.state={phase:'error',label:'unrestored'};
  await assert.rejects(CollectorConnection.prototype.prepare.call(connection),/上次网络恢复/);
  assert.equal(connection.status().phase,'error');
  connection.state={phase:'idle'};const api=connection.api;
  connection.api=async(route,body)=>{if(body.values['proxy.enabled']===false)throw new Error('component offline');return api(route,body);};
  await connection.withConnection(undefined,async()=>{});
  assert.ok(calls.includes('restore'));assert.equal(connection.status().phase,'idle');
  await connection.close();store.close();
});

test('Windows 取消证书等待会终止整棵本工具进程树，不等待继承管道的子进程', {skip:process.platform!=='win32'},async()=>{
  const {connection,store}=await fixture();
  const bin=path.join(connection.directory,'bin'),directory=path.join(bin,'collector');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'collector-system.ps1'),'param($Action,$StateFile,$OwnerProcess)\n[IO.File]::WriteAllText($StateFile,$PID.ToString())\n& powershell.exe -NoProfile -Command "Start-Sleep -Seconds 120"\n');
  connection.bin=bin;const controller=new AbortController(),file=path.join(connection.directory,'test-owner.txt');
  const running=CollectorConnection.prototype.runSystem.call(connection,'apply',file,controller.signal);
  for(let i=0;i<100&&!fs.existsSync(file);i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(fs.existsSync(file));const started=Date.now();controller.abort();
  await assert.rejects(running,/CANCELLED/);assert.ok(Date.now()-started<10000);
  await connection.close();store.close();
});

test('死亡组件 PID 记录可恢复启动；保留旧记录，不杀活进程或移走活记录',async()=>{
  const {connection,store}=await fixture();const file=path.join(connection.directory,'wx_video_download.pid');fs.writeFileSync(file,'16100');
  assert.equal(retireStaleComponentPid(connection.directory,pid=>{assert.equal(pid,16100);return true;}),false);assert.ok(fs.existsSync(file));
  assert.equal(retireStaleComponentPid(connection.directory,()=>false),true);assert.ok(!fs.existsSync(file));
  const retired=fs.readdirSync(connection.directory).find(n=>n.startsWith('wx_video_download.pid.stale-'));assert.equal(fs.readFileSync(path.join(connection.directory,retired),'utf8'),'16100');
  assert.equal(retireStaleComponentPid(connection.directory),false);await connection.close();store.close();
});
