import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID,createHash } from 'node:crypto';
import { Store } from '../electron/store.js';
import { CollectorConnection,upstreamProxy,retireStaleComponentPid,collectorEnvironment,validateCollectorScriptSource } from '../electron/collector-connection.js';
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
test('分流后系统代理快照键序不同但四项 present/value 相同不误判变化',async()=>{
  const plan={directory:'fixture',rulesDigest:'fixture'},after=Object.fromEntries(Object.entries(before).reverse().map(([key,value])=>[key,{value:value.value,present:value.present}]));
  const {connection,store,calls}=await fixture({routing:{discover:async()=>plan,begin:async()=>{}}});
  const system=connection.system;let inspections=0;
  connection.system=async(action,file)=>action==='inspect'?{proxy:++inspections===1?before:after,ownerStarted:'start'}:system(action,file);
  await connection.withConnection(undefined,async()=>calls.push('collect'));
  assert.ok(calls.includes('collect'));assert.ok(calls.includes('restore'));await connection.close();store.close();
});
test('分流后已知四项任何 value 或 present 真正变化均停止采集并恢复',async()=>{
  for(const key of ['ProxyEnable','ProxyServer','ProxyOverride','AutoConfigURL'])for(const field of ['value','present']){
    const plan={directory:'fixture',rulesDigest:'fixture'},after=structuredClone(before);
    after[key][field]=field==='present'?!after[key].present:key==='ProxyEnable'?0:'fixture-changed-value';
    const {connection,store,calls}=await fixture({routing:{discover:async()=>plan,begin:async()=>{}}});
    const system=connection.system;let inspections=0;
    connection.system=async(action,file)=>action==='inspect'?{proxy:++inspections===1?before:after,ownerStarted:'start'}:system(action,file);
    await assert.rejects(connection.withConnection(undefined,async()=>calls.push('collect')),/系统代理发生变化/);
    assert.ok(!calls.includes('collect'),`${key}.${field}`);assert.ok(calls.includes('restore'));await connection.close();store.close();
  }
});
async function fixture(options={}) {
  const directory=path.resolve('output/unit-connection',randomUUID()),store=await Store.open(directory,{}),calls=[];let online=false;
  store.put('collector-policy','automatic',{allowed:true,certificateFingerprint:'unit'});store.flush();
  const connection=new CollectorConnection(store,'',directory,()=>{},{routing:{discover:async()=>null},waitMs:20,guard:async()=>calls.push('guard'),system:async(action,file)=>{calls.push(action);if(action==='inspect')return {proxy:online?{...before,ProxyServer:{present:true,value:'127.0.0.1:2023'}}:before,ownerStarted:'start'};if(action==='apply')online=true;if(action==='restore'){online=false;const state=JSON.parse(fs.readFileSync(file));state.phase='restored';fs.writeFileSync(file,JSON.stringify(state));}return {};},...options});
  connection.prepare=async()=>{connection.certificate={name:'Fengsha-WeChat-unit',file:'test-public-certificate',fingerprint:'unit'};return connection.status();};
  connection.online=async()=>online;connection.adapterReady=async()=>true;connection.api=async(route,body)=>{calls.push(body.values['proxy.enabled']?'start-proxy':'stop-proxy');return {};};
  return {connection,store,calls};
}

test('已连接的旧页面不能跳过适配准备，等待新版本后才开始采集',async()=>{
  const {connection,store,calls}=await fixture();let ready=false;
  connection.online=async()=>true;connection.adapterReady=async()=>ready;
  const system=connection.system;connection.system=async(action,file)=>{const r=await system(action,file);if(action==='inspect'&&calls.includes('apply'))r.proxy={...before,ProxyServer:{present:true,value:'127.0.0.1:2023'}};return r;};
  connection.openPage=async()=>{calls.push('open-page');ready=true;};
  await connection.withConnection(undefined,async()=>{assert.equal(ready,true);calls.push('collect');});
  assert.ok(calls.indexOf('apply')>=0);assert.ok(calls.indexOf('open-page')<calls.indexOf('collect'));assert.ok(calls.includes('restore'));store.close();
});

test('已连接且适配版本匹配时复用页面，不切换网络或打开窗口',async()=>{
  const {connection,store,calls}=await fixture();connection.online=async()=>true;connection.adapterReady=async()=>true;
  await connection.withConnection(undefined,async()=>calls.push('collect'));
  assert.ok(calls.includes('collect'));assert.ok(!calls.includes('apply'));assert.ok(!calls.includes('guard'));store.close();
});

test('连接探针仅接受当前适配版本，每次请求避免复用上游旧缓存',async()=>{
  const requests=[];const connection=Object.create(CollectorConnection.prototype);
  connection.api=async url=>{requests.push(new URL(url,'http://127.0.0.1:2022'));return {errCode:0,data:{fengshaAdapterVersion:4,capabilities:{search:true,detail:true,creatorFeeds:true}}};};
  assert.equal(await connection.adapterReady(),true);assert.equal(await connection.adapterReady(),true);
  const inputs=requests.map(u=>JSON.parse(u.searchParams.get('keyword').slice(20)));
  assert.equal(inputs[0].probe,true);assert.equal(inputs[0].query,undefined);assert.notEqual(inputs[0].nonce,inputs[1].nonce);
  for(const response of [{errCode:1009},{errCode:0,data:{fengshaAdapterVersion:1}},{errCode:0,data:{fengshaAdapterVersion:3}},{errCode:0,data:{fengshaAdapterVersion:4}},{errCode:0,data:{fengshaAdapterVersion:4,capabilities:{search:true,detail:false,creatorFeeds:true}}},{errCode:0,data:{fengshaAdapterVersion:4,capabilities:{search:1,detail:true,creatorFeeds:true}}},{available:true}]){connection.api=async()=>response;assert.equal(await connection.adapterReady(),false);}
});

const adapterProbe=(version=4,capabilities={search:true,detail:true,creatorFeeds:true})=>({errCode:0,data:{fengshaAdapterVersion:version,capabilities}});
test('能力检查按显式需求验证：作者作品缺失不阻止关键词搜索，默认仍要求全部',async()=>{
  const connection=Object.create(CollectorConnection.prototype);
  connection.api=async()=>adapterProbe(4,{search:true,detail:true,creatorFeeds:false});
  assert.equal(await connection.adapterReady(null,8000,['search']),true);
  assert.equal(await connection.adapterReady(null,8000,['detail']),true);
  assert.equal(await connection.adapterReady(),false);
  assert.equal(await connection.adapterReady(null,8000,['creatorFeeds']),false);
  assert.match(connection.adapterMessage(['creatorFeeds']),/作者作品接口尚未加载/);
  assert.doesNotMatch(connection.adapterMessage(['creatorFeeds']),/搜索.*尚未加载/);
});
test('已部署源码指纹存在时 v4 探针必须同 hash；v4→v4 旧脚本和缺 hash 都不能就绪',async()=>{
  const connection=Object.create(CollectorConnection.prototype);connection.adapterFingerprint='aabbcc112233';
  for(const hash of [undefined,'oldscript123',4]){
    connection.api=async()=>{const result=adapterProbe();result.data.fengshaContentHash=hash;return result;};
    assert.equal(await connection.adapterReady(null,8000,['search']),false);
  }
  connection.api=async()=>{const result=adapterProbe(4,{search:true,detail:false,creatorFeeds:false});result.data.fengshaContentHash='aabbcc112233';return result;};
  assert.equal(await connection.adapterReady(null,8000,['search']),true);
  assert.equal(await connection.adapterReady(),false);
  delete connection.adapterFingerprint;
  connection.api=async()=>adapterProbe();assert.equal(await connection.adapterReady(),true);
});
test('v4 哈希不匹配的后续等待仍要求刷新页面，不误报采集能力未加载',async()=>{
  const plan={directory:'fixture',rulesDigest:'fixture'},seen=[];
  const {connection,store,calls}=await fixture({routing:{discover:async()=>plan,begin:async()=>{}}});
  connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;connection.adapterFingerprint='aabbcc112233';connection.adapterReloadAttempted=true;
  const system=connection.system;connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start'}:system(action,file);
  connection.api=async route=>{if(route.startsWith('/api/channels/contact/search?')){const probe=adapterProbe();probe.data.fengshaContentHash='oldscript123';return probe;}return {};};
  const controller=new AbortController();connection.changed=()=>{if(connection.state.phase==='waiting'&&connection.state.label.includes('旧的采集适配脚本')){seen.push({...connection.state});controller.abort();}};
  await assert.rejects(connection.withConnection(controller.signal,async()=>{throw Error('must not collect');},['search']),/CANCELLED/);
  assert.equal(seen.length,1);assert.equal(seen[0].needsPage,true);assert.doesNotMatch(seen[0].label,/接口尚未加载/);assert.ok(calls.includes('restore'));
  await connection.close();store.close();
});
test('本地服务：v4 旧 hash 只在已授权活动分流租约内发一次保留刷新 GET，ack 后仍等待新 hash，最后恢复',async t=>{
  const expected='aabbcc112233',events=[],plan={directory:'fixture',rulesDigest:'fixture'};
  const {connection,store,calls}=await fixture({waitMs:3500,routing:{discover:async()=>plan,begin:async()=>events.push('route-begin')}});
  connection.adapterFingerprint=expected;connection.api=CollectorConnection.prototype.api;connection.online=CollectorConnection.prototype.online;connection.adapterReady=CollectorConnection.prototype.adapterReady;
  const system=connection.system;connection.system=async(action,file)=>{
    if(action==='inspect')return {proxy:before,ownerStarted:'start'};
    const result=await system(action,file);if(action==='apply'){const lease=JSON.parse(fs.readFileSync(file));lease.phase='active';fs.writeFileSync(file,JSON.stringify(lease));}return result;
  };
  let hash='oldscript123',refreshes=0,acknowledged=false;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let result;
    if(url.pathname==='/api/channels/status'){assert.equal(req.method,'GET');result={available:true};}
    else if(url.pathname==='/api/proxy/config'){assert.equal(req.method,'POST');for await(const _ of req){}result={};}
    else{
      assert.equal(url.pathname,'/api/channels/contact/search');assert.equal(req.method,'GET');
      const keyword=url.searchParams.get('keyword');assert.ok(keyword.startsWith('__fengsha_content__:'));const input=JSON.parse(keyword.slice(20));assert.equal(input.probe,true);assert.equal(input.query,undefined);
      if(input.reload===true){
        assert.equal(input.expectedHash,expected);assert.ok(/^[a-f0-9]{12}$/.test(input.expectedHash));assert.ok(input.nonce);
        const lease=JSON.parse(fs.readFileSync(connection.leaseFile));assert.equal(lease.mode,'routed');assert.equal(lease.phase,'active');assert.equal(connection.status().allowed,true);
        assert.ok(events.includes('route-begin'));assert.ok(calls.includes('guard'));assert.ok(calls.includes('apply'));
        refreshes++;events.push('reload');acknowledged=true;result={errCode:0,data:{reloading:true}};
      }else{
        const probe=adapterProbe(4,{search:true,detail:false,creatorFeeds:false});probe.data.fengshaContentHash=hash;probe.data.canRefreshAdapter=true;result=probe;
        if(acknowledged&&hash!==expected){assert.ok(!events.includes('collect'));events.push('probe-still-old');hash=expected;}
      }
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data:result}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await connection.close();store.close();});
  connection.fetch=(input,options)=>{const url=new URL(input);assert.equal(url.origin,'http://127.0.0.1:2022');return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,options);};
  await connection.withConnection(undefined,async()=>{assert.equal(connection.adapterState.hashMatches,true);events.push('collect');},['search']);
  assert.deepEqual(events,['route-begin','reload','probe-still-old','collect']);assert.equal(refreshes,1);assert.equal(calls.filter(call=>call==='restore').length,1);assert.equal(connection.members.size,0);
  const lease=fs.readdirSync(connection.directory).find(name=>/^lease-.*\.json$/.test(name));assert.equal(JSON.parse(fs.readFileSync(path.join(connection.directory,lease))).phase,'restored');
});
test('只读 probe 不发刷新标记；v3、无能力声明、无分流、权限撤回或无合法 hash 均禁止自动刷新',async()=>{
  for(const mode of ['v3','v3-with-marker','no-marker','system-route','revoked-policy','invalid-hash']){
    const plan={directory:'fixture',rulesDigest:'fixture'},routed=mode!=='system-route';
    const {connection,store,calls}=await fixture({waitMs:30,routing:{discover:async()=>routed?plan:null,begin:async()=>{if(mode==='revoked-policy')store.put('collector-policy','automatic',{allowed:false});}}});
    connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;connection.adapterFingerprint=mode==='invalid-hash'?'invalid-hash':'aabbcc112233';
    const system=connection.system;connection.system=async(action,file)=>action==='inspect'?{proxy:!routed&&calls.includes('apply')?{...before,ProxyServer:{present:true,value:'127.0.0.1:2023'}}:before,ownerStarted:'start'}:system(action,file);
    let commands=0,collected=0;
    connection.api=async(route,body)=>{
      if(!route.startsWith('/api/channels/contact/search?'))return {};
      const input=JSON.parse(new URL(route,'http://localhost').searchParams.get('keyword').slice(20));assert.equal(input.probe,true);assert.equal(input.query,undefined);
      if(input.reload===true){commands++;return {errCode:0,data:{reloading:true}};}
      assert.equal(input.expectedHash,undefined);
      const probe=adapterProbe(mode.startsWith('v3')?3:4);probe.data.fengshaContentHash='oldscript123';probe.data.canRefreshAdapter=!['v3','no-marker'].includes(mode);return probe;
    };
    assert.equal(await connection.adapterReady(null,8000,['search']),false);assert.equal(commands,0);
    await assert.rejects(connection.withConnection(undefined,async()=>collected++,['search']),/原网络将自动恢复/);
    assert.equal(commands,0,mode);assert.equal(collected,0);assert.equal(calls.filter(call=>call==='restore').length,1);await connection.close();store.close();
  }
});
test('刷新 ack 不能代替 hash 就绪；无新 hash 超时、坏 ack 或取消均恢复租约且不重复命令',async()=>{
  for(const mode of ['ack-only','already-scheduled','bad-ack','cancelled']){
    const plan={directory:'fixture',rulesDigest:'fixture'};
    const {connection,store,calls}=await fixture({waitMs:30,routing:{discover:async()=>plan,begin:async()=>{}}});
    connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;connection.adapterFingerprint='aabbcc112233';
    const system=connection.system;connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start'}:system(action,file);
    const controller=new AbortController();let commands=0,collected=0;
    connection.api=async route=>{
      if(!route.startsWith('/api/channels/contact/search?'))return {};
      const input=JSON.parse(new URL(route,'http://localhost').searchParams.get('keyword').slice(20));
      if(input.reload===true){
        commands++;assert.ok(calls.includes('apply'));assert.equal(connection.status().allowed,true);
        if(mode==='cancelled'){controller.abort();return new Promise(()=>{});}
        return mode==='bad-ack'?{errCode:1011,data:{reloading:true}}:{errCode:0,data:{reloading:mode!=='already-scheduled'}};
      }
      const probe=adapterProbe();probe.data.fengshaContentHash='oldscript123';probe.data.canRefreshAdapter=true;return probe;
    };
    await assert.rejects(connection.withConnection(controller.signal,async()=>collected++,['search']),mode==='cancelled'?/CANCELLED/:mode==='bad-ack'?/刷新请求未完成/:/旧的采集适配脚本/);
    assert.equal(commands,1);assert.equal(collected,0);assert.equal(calls.filter(call=>call==='restore').length,1);assert.equal(connection.members.size,0);await connection.close();store.close();
  }
});
test('主调用方的 search/detail/creatorFeeds 单项需求独立放行，未加载其他接口不会阻断',async()=>{
  for(const required of ['search','detail','creatorFeeds']){
    const {connection,store,calls}=await fixture();connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;
    const capabilities={search:false,detail:false,creatorFeeds:false};capabilities[required]=true;
    connection.api=async()=>adapterProbe(4,capabilities);
    await connection.withConnection(undefined,async()=>calls.push('collect'),[required]);
    assert.equal(calls.filter(call=>call==='collect').length,1);assert.ok(!calls.includes('apply'));assert.ok(!calls.includes('guard'));assert.equal(connection.members.size,0);
    capabilities[required]=1;
    await assert.rejects(connection.withConnection(undefined,async()=>calls.push('collect'),[required]),/接口尚未加载/);
    assert.equal(calls.filter(call=>call==='collect').length,1);
    await connection.close();store.close();
  }
});
test('withConnection 第三需求参数贯穿首次准备；后加入的缺失能力不会取消已有搜索任务',async()=>{
  const {connection,store,calls}=await fixture();connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;
  connection.api=async()=>adapterProbe(4,{search:true,detail:false,creatorFeeds:false});
  let release,entered;const started=new Promise(resolve=>entered=resolve),work=new Promise(resolve=>release=resolve);
  const search=connection.withConnection(undefined,()=>{entered();return work;},['search']);
  await started;
  await assert.rejects(connection.withConnection(undefined,async()=>calls.push('detail'),['detail']),error=>/详情接口尚未加载/.test(error.message)&&!/搜索.*尚未加载/.test(error.message));
  assert.equal(connection.members.size,1);assert.ok(!calls.includes('detail'));assert.ok(!calls.includes('restore'));assert.ok(!calls.includes('apply'));
  release();await search;await connection.close();store.close();
});
test('无效能力参数在准备和权限租约之前拒绝，不误放行未知接口',async()=>{
  const {connection,store,calls}=await fixture();
  for(const required of [null,'search',['unknown'],[true]])await assert.rejects(connection.withConnection(undefined,async()=>calls.push('collect'),required),/能力要求/);
  assert.ok(!calls.includes('guard'));assert.ok(!calls.includes('apply'));assert.ok(!calls.includes('collect'));assert.equal(connection.leaseFile,null);
  await connection.close();store.close();
});
test('socket 在线但 v4 接口不完整时明确报错，不开窗口、不刷新、不创建租约或重复登录',async()=>{
  const {connection,store,calls}=await fixture();let opened=0;
  connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;
  connection.api=async()=>adapterProbe(4,{search:false,detail:true,creatorFeeds:false});
  connection.openPage=async()=>opened++;
  connection.adapterUpdatePending=true;
  await assert.rejects(connection.withConnection(undefined,async()=>calls.push('collect')),error=>/搜索、作者作品接口尚未加载/.test(error.message)&&/无需反复登录/.test(error.message));
  assert.equal(opened,0);assert.equal(connection.leaseFile,null);assert.ok(!calls.includes('apply'));assert.ok(!calls.includes('guard'));assert.ok(!calls.includes('collect'));
  assert.equal(connection.members.size,0);await connection.close();store.close();
});

test('适配部署只记录真实内容更新；重复准备保留待刷新状态但不产生新更新',async()=>{
  const {connection,store}=await fixture();
  const bin=path.join(connection.directory,'fixture-bin'),content=path.join(bin,'collector','collector-content.js'),deployed=path.join(connection.directory,'fengsha-content.js');
  fs.mkdirSync(path.dirname(content),{recursive:true});fs.writeFileSync(content,'fixture-v4');fs.writeFileSync(deployed,'fixture-v3');connection.bin=bin;
  // Stop preparation after local deployment. No executable, certificate or live API is used.
  connection.api=async route=>{if(route==='/api/channels/status')return {available:true};throw new Error('fixture-stop-after-deployment');};
  await assert.rejects(connection.prepareComponent(),/fixture-stop-after-deployment/);
  const fingerprint=createHash('sha256').update('fixture-v4').digest('hex').slice(0,12),tagged=path.join(connection.directory,`fengsha-content-${fingerprint}.js`);
  assert.equal(fs.readFileSync(deployed,'utf8'),'fixture-v3');assert.equal(connection.adapterFingerprint,fingerprint);
  assert.equal(fs.readFileSync(tagged,'utf8'),`window.__fengshaContentHash="${fingerprint}";\nfixture-v4`);assert.equal(connection.adapterUpdatePending,true);
  await assert.rejects(connection.prepareComponent(),/fixture-stop-after-deployment/);assert.equal(connection.adapterUpdatePending,true);
  connection.adapterUpdatePending=false;
  await assert.rejects(connection.prepareComponent(),/fixture-stop-after-deployment/);assert.equal(connection.adapterUpdatePending,false);
  await connection.close();store.close();
});

test('TSD 密文或无效 JS 不生成部署哈希、不改配置或请求本机服务',async()=>{
  for(const source of ['%TSD-Header%fixture-private-marker','\uFEFF%TSD-Header\nfixture-private-marker','(() => {','']){
    const {connection,store}=await fixture(),bin=path.join(connection.directory,'fixture-bin'),content=path.join(bin,'collector','collector-content.js'),config=path.join(connection.directory,'component.yaml');
    fs.mkdirSync(path.dirname(content),{recursive:true});fs.writeFileSync(content,source);fs.writeFileSync(config,'inject:\n  globalScript: existing-user-script.js\n');connection.bin=bin;
    const before=fs.readFileSync(config),files=fs.readdirSync(connection.directory).sort();let requests=0;
    connection.api=async()=>{requests++;throw Error('fixture-service-must-not-be-called');};
    await assert.rejects(connection.prepareComponent(),error=>/适配脚本/.test(error.message)&&!error.message.includes('fixture-private-marker'));
    assert.equal(connection.adapterFingerprint,undefined);assert.equal(requests,0);assert.deepEqual(fs.readFileSync(config),before);assert.deepEqual(fs.readdirSync(connection.directory).sort(),files);
    await connection.close();store.close();
  }
});
test('构建器可复用明文字节 guard：只编译不执行脚本，并拒绝密文',()=>{
  const source=Buffer.from('globalThis.__fengshaGuardExecutionProbe = true;');
  const before=globalThis.__fengshaGuardExecutionProbe;
  assert.equal(validateCollectorScriptSource(source),source);assert.equal(globalThis.__fengshaGuardExecutionProbe,before);
  assert.deepEqual(validateCollectorScriptSource('(() => {})();'),Buffer.from('(() => {})();'));
  assert.throws(()=>validateCollectorScriptSource(Buffer.from('%TSD-Header%fixture-private-marker')),error=>/TSD 加密字节/.test(error.message)&&!error.message.includes('fixture-private-marker'));
});

test('源码内容改变使 globalScript 路径改变并触发已验证 restart，旧文件保留且重复准备不重复重启',async()=>{
  const {connection,store}=await fixture();
  const bin=path.join(connection.directory,'fixture-bin'),content=path.join(bin,'collector','collector-content.js'),config=path.join(connection.directory,'component.yaml'),legacy=path.join(connection.directory,'fengsha-content.js');
  fs.mkdirSync(path.dirname(content),{recursive:true});fs.writeFileSync(content,'window.fixtureVersion="v4-first";');fs.writeFileSync(legacy,'original-user-file');
  fs.writeFileSync(config,'inject:\n  globalScript: fengsha-content.js\nproxy:\n  enabled: false\n');connection.bin=bin;
  let effective=legacy,pending;const updates=[],statuses=[];
  connection.api=async(route,body)=>{
    if(route==='/api/channels/status')return {available:true};
    if(route==='/api/config'&&!body)return {config_file:config,fields:[{key:'inject.globalScript',effective_value:effective}]};
    if(route==='/api/config'){assert.deepEqual(Object.keys(body.values),['inject.globalScript']);pending=body.values['inject.globalScript'];updates.push(pending);return {restart_token:'fixture-'+updates.length};}
    if(route.startsWith('/api/restart/status?')){assert.equal(new URL(route,'http://localhost').searchParams.get('restart_token'),'fixture-'+updates.length);statuses.push(route);if(statuses.filter(item=>item===route).length===1)return {restart_completed:true,config_applied:false};effective=pending;return {restart_completed:true,config_applied:true};}
    assert.equal(route,'/api/proxy/certificate/status');throw Error('fixture-stop-before-certificate');
  };
  const prepare=()=>assert.rejects(connection.prepareComponent(),/fixture-stop-before-certificate/);
  await prepare();assert.equal(updates.length,1,'首次迁移必须改变 globalScript 路径并重启注入服务');const first=updates[0],firstFingerprint=connection.adapterFingerprint,firstBytes=fs.readFileSync(first);
  assert.equal(path.basename(first),`fengsha-content-${firstFingerprint}.js`);assert.equal(statuses.length,2);
  fs.writeFileSync(content,'window.fixtureVersion="v4-second";');await prepare();
  assert.equal(updates.length,2);assert.notEqual(updates[1],first);assert.notEqual(connection.adapterFingerprint,firstFingerprint);assert.equal(statuses.length,4);
  assert.equal(path.basename(updates[1]),`fengsha-content-${connection.adapterFingerprint}.js`);
  assert.equal(fs.readFileSync(legacy,'utf8'),'original-user-file');assert.deepEqual(fs.readFileSync(first),firstBytes);
  assert.match(fs.readFileSync(updates[1],'utf8'),/^window\.__fengshaContentHash="[a-f0-9]{12}";\nwindow\.fixtureVersion="v4-second";$/);
  assert.ok(fs.readFileSync(config,'utf8').includes(path.basename(updates[1])));
  await prepare();assert.equal(updates.length,2);assert.equal(statuses.length,4);
  await connection.close();store.close();
});

test('无公开刷新 API 时 v3 或旧 v4 hash 保留有限分流租约；新版 hash 和所需能力通过才继续',async()=>{
  for(const oldVersion of [3,4]){
  const plan={directory:'fixture',rulesDigest:'fixture'},events=[];
  const {connection,store,calls}=await fixture({waitMs:1800,routing:{discover:async()=>plan,begin:async()=>events.push('route-begin')}});
  connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;connection.adapterUpdatePending=false;connection.adapterFingerprint='aabbcc112233';
  const system=connection.system;connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start'}:system(action,file);
  let fresh=false,waiting,finish;
  const entered=new Promise(resolve=>waiting=resolve),work=new Promise(resolve=>finish=resolve);
  connection.changed=()=>{if(connection.state.phase==='waiting'&&connection.state.needsPage&&connection.state.label.includes('首次刷新'))waiting();};
  connection.api=async(route,body)=>{if(route.startsWith('/api/channels/contact/search?')){const probe=adapterProbe(fresh?4:oldVersion,{search:true,detail:false,creatorFeeds:false});probe.data.fengshaContentHash=fresh?'aabbcc112233':'oldscript123';return probe;}assert.notEqual(route,'/api/channels/reload');return {};};
  const run=connection.withConnection(undefined,()=>{events.push('collect');return work;},['search']);
  assert.equal(await Promise.race([entered.then(()=>'waiting'),run.then(()=>'finished',()=>'failed')]),'waiting');
  assert.ok(connection.leaseFile);assert.equal(connection.members.size,1);assert.deepEqual(events,['route-begin']);assert.ok(!calls.includes('restore'));
  assert.equal(connection.state.needsPage,true);assert.match(connection.state.label,/没有公开自动刷新接口/);
  assert.equal(connection.adapterState.hashMatches,false);
  // Simulate only the external page refresh result. No automatic refresh API is faked.
  fresh=true;
  for(let i=0;i<150&&!events.includes('collect');i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(events,['route-begin','collect']);assert.ok(!calls.includes('restore'));
  assert.equal(connection.adapterState.hashMatches,true);
  finish();await run;assert.equal(calls.filter(call=>call==='restore').length,1);
  await connection.close();store.close();
  }
});

test('部署标记丢失仍识别旧 v3；v260907 无刷新 HTTP 路由明确失败，并发共享恢复且不猜测 endpoint',async()=>{
  for(const pending of [true,false]){
    const events=[],plan={directory:'fixture',rulesDigest:'fixture'};
    const {connection,store,calls}=await fixture({waitMs:30,routing:{discover:async()=>plan,begin:async()=>events.push('route-begin')}});
    connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;connection.adapterUpdatePending=pending;
    const system=connection.system;connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start'}:system(action,file);
    let fresh=false,collected=0;
    connection.api=async(route,body)=>{
      if(route.startsWith('/api/channels/contact/search?'))return adapterProbe(fresh?4:3);
      assert.notEqual(route,'/api/channels/reload');calls.push(body.values['proxy.enabled']?'start-proxy':'stop-proxy');return {};
    };
    const run=()=>connection.withConnection(undefined,async()=>collected++);
    const results=await Promise.allSettled([run(),run()]);
    for(const result of results){assert.equal(result.status,'rejected');assert.match(result.reason.message,/适配版本未就绪.*原网络将自动恢复/);}
    assert.equal(collected,0);assert.deepEqual(events,['route-begin']);assert.equal(connection.adapterUpdatePending,false);assert.equal(connection.adapterReloadAttempted,true);
    assert.equal(calls.filter(call=>call==='apply').length,1);assert.equal(calls.filter(call=>call==='restore').length,1);
    // A user-refreshed page must pass the real capability probe before use.
    fresh=true;await run();assert.equal(collected,1);assert.deepEqual(events,['route-begin']);
    await connection.close();store.close();
  }
});

test('普通系统代理路径不自动刷新；旧页面超时明确保留登录并恢复租约',async()=>{
  for(const [pending,routed] of [[true,false]]){
    const plan={directory:'fixture',rulesDigest:'fixture'},events=[];
    const {connection,store,calls}=await fixture({routing:{discover:async()=>routed?plan:null,begin:async()=>events.push('route-begin')}});
    connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;connection.adapterUpdatePending=pending;
    const system=connection.system;connection.system=async(action,file)=>{if(action==='inspect'&&routed)return {proxy:before,ownerStarted:'start'};const value=await system(action,file);if(action==='inspect'&&!routed&&calls.includes('apply'))value.proxy={...before,ProxyServer:{present:true,value:'127.0.0.1:2023'}};return value;};
    connection.api=async(route,body)=>{if(route.startsWith('/api/channels/contact/search?'))return adapterProbe(3);if(route==='/api/channels/reload')events.push('reload');else calls.push(body.values['proxy.enabled']?'start-proxy':'stop-proxy');return {};};
    await assert.rejects(connection.withConnection(undefined,async()=>{throw Error('must not collect');}),/适配版本未就绪.*登录保留/);
    assert.ok(!events.includes('reload'));assert.ok(calls.includes('restore'));assert.equal(connection.members.size,0);
    await connection.close();store.close();
  }
});

test('分流开启失败或首次权限被拒绝时不自动刷新，不越过现有租约边界',async()=>{
  for(const mode of ['route-failed','permission-refused']){
    const events=[],plan={directory:'fixture',rulesDigest:'fixture'};
    const {connection,store,calls}=await fixture({routing:{discover:async()=>plan,begin:async()=>{throw new Error('fixture-route-failed');}}});
    connection.online=async()=>false;connection.adapterUpdatePending=true;
    const system=connection.system;connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start'}:system(action,file);
    connection.api=async(route,body)=>{events.push(route);return {};};
    if(mode==='permission-refused'){store.put('collector-policy','automatic',{allowed:false});connection.consent=async()=>false;}
    await assert.rejects(connection.withConnection(undefined,async()=>{}),mode==='route-failed'?/fixture-route-failed/:/尚未确认/);
    assert.ok(!events.includes('/api/channels/reload'));assert.equal(connection.adapterUpdatePending,true);
    if(mode==='permission-refused'){assert.ok(!calls.includes('apply'));assert.equal(connection.leaseFile,null);}else assert.ok(calls.includes('restore'));
    await connection.close();store.close();
  }
});

test('适配探针取消立即结束；不把取消误报成旧版或继续切换网络',async()=>{
  const {connection,store,calls}=await fixture();connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;
  const controller=new AbortController();let probing;
  const entered=new Promise(resolve=>probing=resolve);
  connection.api=async()=>{probing();return new Promise(()=>{});};
  const run=connection.withConnection(controller.signal,async()=>{throw Error('must not collect');});
  await entered;controller.abort();await assert.rejects(run,/CANCELLED/);
  assert.ok(!calls.includes('guard'));assert.ok(!calls.includes('apply'));assert.equal(connection.members.size,0);
  await connection.close();store.close();
});

test('旧页面等待取消释放已建租约；不支持自动刷新只报告一次且不开始采集',async()=>{
  for(const mode of ['cancelled','unsupported']){
    const plan={directory:'fixture',rulesDigest:'fixture'};
    const {connection,store,calls}=await fixture({waitMs:30,routing:{discover:async()=>plan,begin:async()=>{}}});
    connection.online=async()=>true;connection.adapterReady=CollectorConnection.prototype.adapterReady;connection.adapterUpdatePending=true;
    const system=connection.system;connection.system=async(action,file)=>action==='inspect'?{proxy:before,ownerStarted:'start'}:system(action,file);
    const controller=new AbortController();let reloads=0;
    connection.adapterReloadAttempted=mode==='cancelled';let probes=0;
    connection.api=async(route,body)=>{
      if(route.startsWith('/api/channels/contact/search?')){if(mode==='cancelled'&&++probes===2)controller.abort();return adapterProbe(3);}
      if(route==='/api/channels/reload')reloads++;
      return {};
    };
    await assert.rejects(connection.withConnection(controller.signal,async()=>{throw Error('must not collect');}),mode==='cancelled'?/CANCELLED/:/适配版本未就绪/);
    assert.equal(reloads,0);assert.ok(calls.includes('restore'));assert.equal(connection.members.size,0);
    if(mode==='unsupported'){
      assert.equal(connection.adapterUpdatePending,false);assert.equal(connection.adapterReloadAttempted,true);
      connection.waitMs=20;
      await assert.rejects(connection.withConnection(undefined,async()=>{}),/适配版本未就绪/);
      assert.equal(reloads,0);
    }
    await connection.close();store.close();
  }
});
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

test('Windows 辅助程序失败保留原提示，并在 Error 附加类型及 HResult 白名单诊断', {skip:process.platform!=='win32'},async()=>{
  const {connection,store}=await fixture();
  const directory=path.join(connection.directory,'diagnostic-bin','collector');fs.mkdirSync(directory,{recursive:true});connection.bin=path.dirname(directory);
  fs.writeFileSync(path.join(directory,'collector-system.ps1'),`param($Action,$StateFile,$OwnerProcess)
@{ok=$false;stage='certificate-check';errorCode=-2146233087;exceptionType='System.Management.Automation.MethodInvocationException';innerType='System.IO.FileLoadException';innerErrorCode=-2146232799;message='fixture-private-marker';data='fixture-private-marker'} | ConvertTo-Json -Compress
exit 1
`);
  await assert.rejects(CollectorConnection.prototype.runSystem.call(connection,'apply'),error=>{
    assert.equal(error.message,'证书检查失败（Windows 错误 -2146233087）；恢复记录保留在本机');
    assert.deepEqual(error.diagnostic,{stage:'certificate-check',exceptionType:'System.Management.Automation.MethodInvocationException',innerType:'System.IO.FileLoadException',innerErrorCode:-2146232799,errorCode:-2146233087});
    assert.ok(!JSON.stringify(error.diagnostic).includes('fixture-private-marker'));return true;
  });
  fs.writeFileSync(path.join(directory,'collector-system.ps1'),"param($Action,$StateFile,$OwnerProcess)\n@{ok=$false;stage='certificate-check';errorCode=-2146233087} | ConvertTo-Json -Compress\nexit 1\n");
  await assert.rejects(CollectorConnection.prototype.runSystem.call(connection,'apply'),error=>{
    assert.equal(error.message,'证书检查失败（Windows 错误 -2146233087）；恢复记录保留在本机');
    assert.deepEqual(error.diagnostic,{stage:'certificate-check',exceptionType:null,innerType:null,innerErrorCode:null,errorCode:-2146233087});return true;
  });
  fs.writeFileSync(path.join(directory,'collector-system.ps1'),"param($Action,$StateFile,$OwnerProcess)\nWrite-Output 'fixture-private-marker'\nexit 1\n");
  await assert.rejects(CollectorConnection.prototype.runSystem.call(connection,'apply'),error=>{
    assert.equal(error.message,'连接准备失败；恢复记录保留在本机');
    assert.deepEqual(error.diagnostic,{stage:null,exceptionType:null,innerType:null,innerErrorCode:null,errorCode:null});return true;
  });
  for(const [stage,label] of [['certificate-proxy-baseline','连接前代理状态核对'],['certificate-parse','本机连接证书读取'],['certificate-identity','本机连接证书名称和有效期核对'],['certificate-fingerprint','本机连接证书指纹核对'],['certificate-store','当前用户证书库检查']]){
    fs.writeFileSync(path.join(directory,'collector-system.ps1'),`param($Action,$StateFile,$OwnerProcess)\n@{ok=$false;stage='${stage}';errorCode=-2146233087;exceptionType='RuntimeException';innerType=$null;innerErrorCode=$null} | ConvertTo-Json -Compress\nexit 1\n`);
    await assert.rejects(CollectorConnection.prototype.runSystem.call(connection,'apply'),error=>{
      assert.equal(error.message,`${label}失败（Windows 错误 -2146233087）；恢复记录保留在本机`);
      assert.deepEqual(error.diagnostic,{stage,exceptionType:'RuntimeException',innerType:null,innerErrorCode:null,errorCode:-2146233087});return true;
    });
  }
  assert.equal(connection.leaseFile,null);await connection.close();store.close();
});

test('死亡组件 PID 记录可恢复启动；保留旧记录，不杀活进程或移走活记录',async()=>{
  const {connection,store}=await fixture();const file=path.join(connection.directory,'wx_video_download.pid');fs.writeFileSync(file,'16100');
  assert.equal(retireStaleComponentPid(connection.directory,pid=>{assert.equal(pid,16100);return true;}),false);assert.ok(fs.existsSync(file));
  assert.equal(retireStaleComponentPid(connection.directory,()=>false),true);assert.ok(!fs.existsSync(file));
  const retired=fs.readdirSync(connection.directory).find(n=>n.startsWith('wx_video_download.pid.stale-'));assert.equal(fs.readFileSync(path.join(connection.directory,retired),'utf8'),'16100');
  assert.equal(retireStaleComponentPid(connection.directory),false);await connection.close();store.close();
});

test('微信未连接时先自动打开视频号，再检测连接；已连接不重复打开',async()=>{const {connection,store}=await fixture();let opened=0;connection.openPage=async()=>{opened++;};let checks=0;connection.online=async()=>++checks>1;await connection.withConnection(undefined,async()=>{});assert.equal(opened,1);await connection.withConnection(undefined,async()=>{});assert.equal(opened,1);await connection.close();store.close();});
