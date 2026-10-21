import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentSearch} from '../electron/content-search.js';
import {contentItem} from '../electron/content-data.js';

const options={limit:10,from:'2026-10-01',to:'2026-10-21',includeUnknown:true};
const item=contentItem('抖音',{id:'12345',url:'https://www.douyin.com/video/12345',title:'已有作品',publishedAt:'2026-10-20'});
function fixture(browser={}){
  const data=new Map(),store={get:(kind,id)=>structuredClone(data.get(kind+':'+id)),put:(kind,id,value)=>data.set(kind+':'+id,structuredClone(value)),flush(){}};
  const accounts={active:()=>null},creators={progress:()=>null,requireLogin:async()=>{}},userSearch={active:null};
  const search=new ContentSearch({accounts,creators,userSearch,store,browser:{close(){},show(){},...browser},bilibili:{json:async()=>({result:[],page:1,numPages:0})}});
  return {search,store,accounts,creators,userSearch};
}

test('错误产生结构化处理动作，保留搜索条件、部分结果和续读位置',async()=>{
  const x=fixture({async read(record,_signal,_initial,progress){record.browserScroll=7;progress({items:[item]});throw Object.assign(Error('官方页面连接失败'),{action:{kind:'network',message:'连接失败，已尝试自动重连',retryable:true}});}});
  await assert.rejects(x.search.start('抖音','摄影',options));const r=x.search.view();
  assert.equal(r.status,'needs-action');assert.equal(r.action.kind,'network');assert.equal(r.keyword,'摄影');assert.equal(r.items.length,1);assert.equal(r.canContinue,true);assert.equal(x.search.record.browserScroll,7);assert.ok(r.action.id);
});

test('平台要求验证作为待处理返回，不能被空结果或普通完成消息覆盖',async()=>{
  const x=fixture({async read(){return {items:[],needsAction:true,complete:false,message:'请完成官方验证码',action:{kind:'verification',retryable:false}};}});
  const r=await x.search.start('抖音','摄影',options);assert.equal(r.status,'needs-action');assert.equal(r.action.kind,'verification');assert.match(r.action.message,/验证码/);
});

test('检测只读已有窗口，不自动续读；显式续读复用同一个搜索记录',async()=>{
  let reads=0,checks=0,opens=0;const x=fixture({async read(){reads++;return reads===1?{items:[item],needsAction:true,message:'请登录',action:{kind:'login'}}:{items:[item],complete:true};},async checkAction(){checks++;return {ready:true};},async openAction(){opens++;return {ready:false};}});
  const r=await x.search.start('抖音','摄影',options);assert.deepEqual(await x.search.action(r.id,'check'),{ready:true});assert.equal(checks,1);assert.equal(reads,1);assert.equal(opens,0);
  const resumed=await x.search.more(r.id);assert.equal(resumed.id,r.id);assert.equal(reads,2);assert.equal(resumed.action,null);assert.equal(resumed.keyword,'摄影');
});

test('关闭提示中止待返回检测，迟到ready不会重开提示或执行任务',async()=>{
  let release,checks=0;const x=fixture({async read(){return {items:[item],needsAction:true,message:'请登录',action:{kind:'login'}};},async checkAction(){checks++;return new Promise(resolve=>release=resolve);}});
  const r=await x.search.start('抖音','摄影',options),pending=x.search.action(r.id,'check');
  await x.search.action(r.id,'dismiss');release({ready:true});assert.equal((await pending).cancelled,true);assert.equal(x.search.view().action.dismissed,true);assert.equal(checks,1);
  const reloaded=new ContentSearch({...x,browser:{close(){}},changed(){}});assert.equal(reloaded.view().action.dismissed,true);
});

test('停止待处理任务清除自动续读动作，结果继续保留',async()=>{
  const x=fixture({async read(){return {items:[item],needsAction:true,message:'请登录',action:{kind:'login'}};}});
  await x.search.start('抖音','摄影',options);x.search.cancel();assert.equal(x.search.view().status,'interrupted');assert.equal(x.search.view().action,null);assert.equal(x.search.view().items.length,1);
});

test('正常退出保留闲置错误原因和恢复入口，重启默认收起提示不自动打开',async()=>{
  const x=fixture({async read(){return {items:[item],needsAction:true,message:'请完成官方验证码',action:{kind:'verification'}};}});
  const r=await x.search.start('抖音','摄影',options);await x.search.close();
  const restored=new ContentSearch({...x,browser:{close(){}},changed(){}}),view=restored.view();
  assert.equal(view.status,'needs-action');assert.equal(view.action.id,r.action.id);assert.equal(view.action.dismissed,true);assert.match(view.message,/验证码/);assert.equal(view.items.length,1);
  await restored.action(view.id,'review');assert.equal(restored.view().action.dismissed,false);
});

test('升级旧版失败记录补回收起的处理入口，不把已停止记录重新激活',async()=>{
  const x=fixture({async read(){return {items:[item],complete:true};}});
  const original=await x.search.start('抖音','旧版条件',options);
  x.search.record.status='interrupted';delete x.search.record.action;x.search.record.message='LOAD_FAILED';x.search.publish();
  const restored=new ContentSearch({...x,browser:{close(){}},changed(){}}),r=restored.view();
  assert.equal(r.id,original.id);assert.equal(r.keyword,'旧版条件');assert.equal(r.items.length,1);assert.equal(r.action.kind,'network');assert.equal(r.action.dismissed,true);
  x.search.record.message='已停止，已有结果保留，可继续读取。';x.search.publish();
  const stopped=new ContentSearch({...x,browser:{close(){}},changed(){}}).view();assert.equal(stopped.action,null);assert.equal(stopped.status,'interrupted');
});

test('B站登录预检失败保存本次新条件，旧搜索记录不被错误覆盖',async()=>{
  const x=fixture({async read(){return {items:[item],complete:true};}});
  const old=await x.search.start('抖音','原关键词',options),saved=x.store.get('content-search',old.id);
  x.creators.requireLogin=async()=>{throw Error('请先在账号管理登录 B站');};
  await assert.rejects(x.search.start('B站','新关键词',options));const waiting=x.search.view();
  assert.notEqual(waiting.id,old.id);assert.equal(waiting.keyword,'新关键词');assert.equal(waiting.action.kind,'login');assert.deepEqual(x.store.get('content-search',old.id),saved);
  assert.equal((await x.search.action(waiting.id,'open')).manageAccount,true);
  x.accounts.active=()=>({id:'new-account'});x.creators.requireLogin=async()=>{};
  assert.equal((await x.search.action(waiting.id,'check')).ready,true);
  const resumed=await x.search.more(waiting.id);assert.equal(resumed.id,waiting.id);assert.equal(x.search.record.accountId,'new-account');
});

test('已有B站结果不允许换账号后自动混合续读',async()=>{
  const x=fixture();x.accounts.active=()=>({id:'one'});
  await x.search.start('B站','原关键词',options);x.search.record.all=[{...item,platform:'B站'}];x.search.record.status='needs-action';x.search.record.action={id:'action',kind:'login',message:'请登录'};
  x.accounts.active=()=>({id:'two'});assert.equal((await x.search.action(x.search.record.id,'check')).ready,false);
  await assert.rejects(x.search.more(x.search.record.id),/账号已切换/);assert.equal(x.search.record.accountId,'one');assert.equal(x.search.record.all.length,1);
});
