import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/store.js';
import { Creators } from '../electron/creators.js';
import { Engine } from '../electron/engine.js';

async function fixture(account = null, cookieReady = false) {
  const store=await Store.open(path.resolve('output/unit',randomUUID()),{});
  const engine=new Engine('',{active:()=>account,bilibiliLoginReady:async()=>cookieReady},null);let calls=0;
  engine.bilibili={reset(){},page:async()=>{calls++;return {entries:[],advance:0,total:0,complete:true};},detail:async()=>{calls++;return {id:'BV1iaun65Ehn',uploader_id:'237602907',title:'补全标题'};}};
  const service=new Creators(store,engine,null,()=>{});
  service.identityMetadata=async()=>{calls++;return {id:'237602907',name:'测试作者',total:1};};
  const record={id:'saved',creator:{id:'237602907',name:'测试作者',platform:'B站',url:'https://space.bilibili.com/237602907/video',supported:true,adapter:'bilibili',accountId:account?.id||null},items:[{key:'item',url:'https://www.bilibili.com/video/BV1iaun65Ehn',title:'待获取标题',available:true}],scanned:1,cursor:2,seen:['item'],skipped:{},complete:false,status:'interrupted'};
  store.put('creator',record.id,record);store.put('meta','lastCreator',{id:record.id});
  return {store,service,record,engine,calls:()=>calls};
}

test('未登录时B站识别、重读、继续和补全均在请求前提醒，原清单不变',async()=>{
  const f=await fixture();try{
    for(const run of [()=>f.service.identify('https://space.bilibili.com/237602907/video'),()=>f.service.page('saved',{limit:100},true),()=>f.service.page('saved',{}),()=>f.service.refresh('saved')])await assert.rejects(run(),{code:'BILIBILI_LOGIN_REQUIRED'});
    assert.equal(f.calls(),0);assert.deepEqual(f.store.get('creator','saved'),f.record);assert.equal(f.service.active,null);assert.equal(f.store.list('creator').length,1);
  }finally{f.store.close();}
});

test('未完成、过期或只有访客会话的账号不能当作B站已登录',async()=>{
  for(const [account,ready] of [[{id:'a',platform:'B站',status:'未登录'},false],[{id:'a',platform:'B站',status:'登录中',lastSync:1},true],[{id:'a',platform:'B站',status:'需要重新登录',lastSync:1},true],[{id:'a',platform:'B站',status:'会话已保存',lastSync:1},false]]){
    const f=await fixture(account,ready);try{await assert.rejects(f.service.identify('https://space.bilibili.com/237602907/video'),{code:'BILIBILI_LOGIN_REQUIRED'});assert.equal(f.calls(),0);}finally{f.store.close();}
  }
});

test('保存的B站登录会话可以继续执行；历史查看和恢复不要求发起登录',async()=>{
  const f=await fixture({id:'a',platform:'B站',status:'会话已保存',lastSync:Date.now()},true);try{const record=await f.service.identify('https://space.bilibili.com/237602907/video');assert.equal(record.creator.id,'237602907');assert.ok(f.calls()>0);}finally{f.store.close();}
  const guest=await fixture();try{assert.equal(guest.service.last().items.length,1);}finally{guest.store.close();}
});

test('登录预检期间取消或账号状态变化，不发送平台请求也不覆盖清单',async()=>{
  for(const mode of ['cancel','logout','switch']){
    let account={id:'a',platform:'B站',status:'会话已保存',lastSync:1};const f=await fixture(account,true);let finish;
    f.engine.accounts.active=()=>account;f.engine.accounts.bilibiliLoginReady=()=>new Promise(r=>finish=r);
    try{const pending=f.service.page('saved',{limit:100},true);assert.ok(f.service.active);if(mode==='cancel')f.service.cancel();else if(mode==='logout')account={...account,status:'未登录',lastSync:null};else account={...account,id:'b'};finish(true);await assert.rejects(pending);assert.equal(f.calls(),0);assert.deepEqual(f.store.get('creator','saved'),f.record);assert.equal(f.service.active,null);}finally{f.store.close();}
  }
});
