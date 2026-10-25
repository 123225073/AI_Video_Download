import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {CollectorConnection} from '../electron/collector-connection.js';
const original={ProxyEnable:{present:true,value:1},ProxyServer:{present:true,value:'127.0.0.1:7897'},ProxyOverride:{present:false,value:null},AutoConfigURL:{present:false,value:null}};
function fixture(options={}){
 const data=new Map(),store={get:(type,id)=>data.get(type+':'+id),put:(type,id,value)=>data.set(type+':'+id,value),flush(){}};store.put('collector-policy','automatic',{allowed:true,certificateFingerprint:'unit'});
 let applied=false,online=false;const events=[],states=[],directory=path.resolve('output/repair-089/wechat-helper/bootstrap-'+randomUUID());
 const connection=new CollectorConnection(store,'',directory,()=>states.push({...connection.state}),{waitMs:25,routing:{discover:async()=>null},guard:async()=>events.push('guard'),system:async action=>{events.push(action);if(action==='apply')applied=true;if(action==='restore')applied=false;if(action==='inspect')return {proxy:applied?{...original,ProxyServer:{present:true,value:'127.0.0.1:2023'}}:original,ownerStarted:'fixture'};return {};},...options});
 connection.prepare=async()=>{connection.certificate={name:'Fengsha-WeChat-unit',fingerprint:'unit',file:'fixture'};};connection.online=async()=>online;connection.adapterReady=async()=>{events.push('adapter-ready');return true;};connection.api=async()=>({});connection.stopProxy=async()=>events.push('stop-proxy');
 return {connection,store,events,states,get applied(){return applied;},setOnline(value){online=value;}};
}
test('已打开的视频号在已核验租约内自动检测刷新一次，online与适配都成功才执行任务',async()=>{
 const x=fixture({windowHelper:{inspect:async()=>{assert.ok(x.applied);assert.ok(fs.existsSync(x.connection.leaseFile));x.events.push('window-inspect');return {ok:true,status:'found',matched:1};},refresh:async()=>{assert.ok(x.applied);x.events.push('window-refresh');x.setOnline(true);return {ok:true,status:'invoked',matched:1,refreshAttempted:true,refreshed:true};}}});
 let opened=0;x.connection.openPage=async()=>opened++;
 await x.connection.withConnection(undefined,async()=>{assert.ok(x.events.includes('adapter-ready'));x.events.push('collect');});assert.equal(x.events.filter(e=>e==='window-refresh').length,1);assert.equal(opened,0);assert.ok(x.events.indexOf('window-refresh')<x.events.indexOf('collect'));assert.ok(x.states.some(s=>/已检测到.*视频号/.test(s.label)));assert.ok(x.events.includes('restore'));
});
test('刷新Invoke回执不构成连接成功，未online不进入任务，也不重复刷新',async()=>{
 const x=fixture({windowHelper:{inspect:async()=>({ok:true,status:'found',matched:1}),refresh:async()=>{x.events.push('window-refresh');return {ok:true,status:'invoked',matched:1,refreshAttempted:true,refreshed:true};}}});let collected=false;
 await assert.rejects(x.connection.withConnection(undefined,async()=>collected=true),/尚未接入|尚未连接/);assert.equal(collected,false);assert.equal(x.events.filter(e=>e==='window-refresh').length,1);assert.ok(!x.states.some(s=>s.phase==='connected'));assert.ok(x.events.includes('restore'));
});
test('助手timeout或unsupported保持人工兜底并区分“未打开”，不刷新不冒充ready',async()=>{
 for(const status of ['timeout','scan-limited','unsupported-document-url','unsupported-document-owner','unsupported-toolbar']){
  const x=fixture({windowHelper:{inspect:async()=>({ok:false,status,matched:0}),refresh:async()=>{throw Error('must not refresh');}}});let opened=0;x.connection.openPage=async()=>opened++;
  await assert.rejects(x.connection.withConnection(undefined,async()=>{throw Error('must not collect');}));assert.ok(x.states.some(s=>s.needsPage&&/检测超时|检测达到安全上限|无法确认|暂不支持/.test(s.label)),status);assert.ok(!x.states.some(s=>s.phase==='connected'));assert.equal(opened,0);
 }
});
test('检测过程中取消后不刷新，也不在迟到的检测结果后补刷新',async()=>{
 let release,entered;const waiting=new Promise(r=>entered=r),pending=new Promise(r=>release=r),controller=new AbortController();let refreshes=0;
 const x=fixture({windowHelper:{inspect:async()=>{entered();return pending;},refresh:async()=>{refreshes++;return {ok:true,status:'invoked',matched:1,refreshAttempted:true,refreshed:true};}}});
 const running=x.connection.withConnection(controller.signal,async()=>{throw Error('must not collect');});await waiting;controller.abort();release({ok:true,status:'found',matched:1});await assert.rejects(running,/CANCELLED/);await new Promise(r=>setImmediate(r));assert.equal(refreshes,0);assert.ok(x.events.includes('restore'));
});
test('租约应用失败或未获授权不进行窗口检测和刷新',async()=>{
 for(const mode of ['refused','apply-failed']){let calls=0;const x=fixture({windowHelper:{inspect:async()=>{calls++;},refresh:async()=>{calls++;}}});
  if(mode==='refused'){x.store.put('collector-policy','automatic',{allowed:false});x.connection.consent=async()=>false;}
  else x.connection.system=async action=>{if(action==='apply')throw Error('fixture-apply-failed');if(action==='inspect')return {proxy:original,ownerStarted:'fixture'};return {};};
  await assert.rejects(x.connection.withConnection(undefined,async()=>{throw Error('must not collect');}));assert.equal(calls,0);
 }
});
test('已检测到页面但刷新不受支持时保留明确兜底，只尝试一次',async()=>{
 const x=fixture({windowHelper:{inspect:async()=>({ok:true,status:'found',matched:1}),refresh:async()=>{x.events.push('window-refresh');return {ok:true,status:'unsupported-menu',matched:1,refreshAttempted:false,refreshed:false};}}});
 await assert.rejects(x.connection.withConnection(undefined,async()=>{throw Error('must not collect');}));assert.equal(x.events.filter(e=>e==='window-refresh').length,1);assert.ok(x.states.some(s=>s.needsPage&&/已检测到.*暂不支持自动刷新/.test(s.label)));
});
test('刷新后socket在线但适配未就绪仍不开始任务',async()=>{
 const x=fixture({windowHelper:{inspect:async()=>({ok:true,status:'found',matched:1}),refresh:async()=>{x.setOnline(true);return {ok:true,status:'invoked',matched:1,refreshAttempted:true,refreshed:true};}}});x.connection.adapterReady=async()=>false;
 await assert.rejects(x.connection.withConnection(undefined,async()=>{throw Error('must not collect');}),/适配版本未就绪/);assert.ok(!x.states.some(s=>s.phase==='connected'));
});
test('已检测到页面的更新回调中取消，不触发随后刷新',async()=>{
 const controller=new AbortController();let refreshed=0;const x=fixture({windowHelper:{inspect:async()=>({ok:true,status:'found',matched:1}),refresh:async()=>{refreshed++;}}});
 const changed=x.connection.changed;x.connection.changed=()=>{changed();if(x.connection.state.pageDetection==='found')controller.abort();};
 await assert.rejects(x.connection.withConnection(controller.signal,async()=>{throw Error('must not collect');}),/CANCELLED/);assert.equal(refreshed,0);
});
test('初次未找到而自动打开视频号后仅延迟重检一次，唯一found后刷新一次再连接',async()=>{
 let checks=0,refreshes=0,opened=0;const x=fixture({waitMs:1200,windowHelper:{inspect:async()=>++checks===1?{ok:true,status:'not-found',matched:0}:{ok:true,status:'found',matched:1},refresh:async()=>{refreshes++;x.setOnline(true);return {ok:true,status:'invoked',matched:1,refreshAttempted:true,refreshed:true};}}});
 x.connection.openPage=async()=>opened++;await x.connection.withConnection(undefined,async()=>x.events.push('collect'));assert.equal(opened,1);assert.equal(checks,2);assert.equal(refreshes,1);assert.ok(x.events.includes('collect'));
});
test('自动打开后延迟重检期间取消，不再检测或刷新',async()=>{
 let checks=0,refreshes=0,waiting;const entered=new Promise(resolve=>waiting=resolve),controller=new AbortController();const x=fixture({waitMs:1200,windowHelper:{inspect:async()=>{checks++;return {ok:true,status:'not-found',matched:0};},refresh:async()=>refreshes++}});
 const changed=x.connection.changed;x.connection.changed=()=>{changed();if(x.connection.state.label.includes('页面就绪后'))waiting();};x.connection.openPage=async()=>{};
 const running=x.connection.withConnection(controller.signal,async()=>{throw Error('must not collect');});await entered;controller.abort();await assert.rejects(running,/CANCELLED/);assert.equal(checks,1);assert.equal(refreshes,0);
});
test('自动打开后网络已online，不再检测或刷新已接入的页面',async()=>{
 let checks=0,refreshes=0;const x=fixture({waitMs:1200,windowHelper:{inspect:async()=>{checks++;return {ok:true,status:'not-found',matched:0};},refresh:async()=>refreshes++}});x.connection.openPage=async()=>x.setOnline(true);
 await x.connection.withConnection(undefined,async()=>x.events.push('collect'));assert.equal(checks,1);assert.equal(refreshes,0);assert.ok(x.events.includes('collect'));
});
test('打开后的延迟内自动online，重检前再次核验网络而不刷新',async()=>{
 let checks=0,refreshes=0;const x=fixture({waitMs:1200,windowHelper:{inspect:async()=>{checks++;return {ok:true,status:'not-found',matched:0};},refresh:async()=>refreshes++}});x.connection.openPage=async()=>{};
 const changed=x.connection.changed;x.connection.changed=()=>{changed();if(x.connection.state.label.includes('页面就绪后'))setTimeout(()=>x.setOnline(true),10);};
 await x.connection.withConnection(undefined,async()=>x.events.push('collect'));assert.equal(checks,1);assert.equal(refreshes,0);assert.ok(x.events.includes('collect'));
});

test('视频号迟于首次延迟检查才打开，等待期间继续检测并只刷新一次',async()=>{
 let checks=0,refreshes=0;const x=fixture({waitMs:4200,windowHelper:{inspect:async()=>++checks<3?{ok:true,status:'not-found',matched:0}:{ok:true,status:'found',matched:1},refresh:async()=>{refreshes++;x.setOnline(true);return {ok:true,status:'invoked',matched:1,refreshAttempted:true,refreshed:true};}}});
 x.connection.openPage=async()=>{};
 await x.connection.withConnection(undefined,async()=>x.events.push('collect'));
 assert.equal(checks,3);assert.equal(refreshes,1);assert.ok(x.events.includes('collect'));assert.ok(x.events.includes('restore'));
});

test('已验证页面不支持菜单刷新时，通过固定微信入口接入而不要求人工刷新',async()=>{
 let opened=0,refreshes=0;const x=fixture({windowHelper:{inspect:async()=>({ok:true,status:'found',matched:1}),refresh:async()=>{refreshes++;return {ok:true,status:'unsupported-toolbar',matched:1,refreshAttempted:false,refreshed:false};}}});
 x.connection.openPage=async()=>{assert.ok(x.applied);opened++;x.setOnline(true);};
 await x.connection.withConnection(undefined,async()=>x.events.push('collect'));
 assert.equal(opened,1);assert.equal(refreshes,1);assert.ok(x.events.includes('collect'));assert.ok(x.events.includes('restore'));
});

test('微信入口返回成功但页面没有接入，仍超时恢复且不重复打开',async()=>{
 let opened=0;const x=fixture({windowHelper:{inspect:async()=>({ok:true,status:'found',matched:1}),refresh:async()=>({ok:true,status:'unsupported-toolbar',matched:1,refreshAttempted:false,refreshed:false})}});
 x.connection.openPage=async()=>opened++;
 await assert.rejects(x.connection.withConnection(undefined,async()=>{throw Error('must not collect');}),/尚未接入|尚未连接/);
 assert.equal(opened,1);assert.ok(x.events.includes('restore'));assert.ok(!x.states.some(s=>s.phase==='connected'));
});
