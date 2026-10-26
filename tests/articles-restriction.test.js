import test from 'node:test';
import assert from 'node:assert/strict';
import {wechatAccountPage,wechatAccountRetry} from '../electron/article-data.js';
import {Articles} from '../electron/articles.js';
import {WechatAccountAccess,WECHAT_ACCOUNT_PAUSE_MS} from '../electron/wechat-account-access.js';

const author={name:'编程进阶录',biz:'MzkwNjQ0MTIzNA==',sourceInput:'https://mp.weixin.qq.com/s/seed'};
test('200013 stops immediately instead of repeatedly requesting a rejected page',async()=>{
 let requests=0,waits=0;
 const data=await wechatAccountRetry(async()=>{requests++;return {base_resp:{ret:200013,err_msg:'freq control'}};},{wait:async()=>{waits++;}});
 assert.equal(data.base_resp.ret,200013);assert.equal(requests,1);assert.equal(waits,0);
});
test('a restricted author list keeps its identity and presents a distinct recovery action',async()=>{
 const records=new Map(),store={get:(k,id)=>structuredClone(records.get(k+':'+id)||null),put:(k,id,v)=>records.set(k+':'+id,structuredClone(v)),list:()=>[]};
 const center=new Articles({store,directory:'.',reader:{identifyAuthor:async()=>author,discover:async()=>wechatAccountPage({base_resp:{ret:200013}},author,0,5),close(){}}});
 const view=await center.start({mode:'author',platform:'公众号',input:author.sourceInput,limit:30});
 assert.equal(view.busy,false);assert.equal(view.discovery.authorContext.biz,author.biz);assert.equal(view.discovery.status,'needs-action');assert.equal(view.discovery.action,'wechat-rate-limit');assert.equal(view.discovery.items.length,0);
});
function storeFixture(){const rows=new Map();return {get:(k,id)=>structuredClone(rows.get(k+':'+id)||null),put:(k,id,v)=>rows.set(k+':'+id,structuredClone(v)),list:()=>[],flush(){}};}
test('restriction survives restart, covers the entire account session, and expires without automatic traffic',()=>{
 let now=1000;const store=storeFixture(),access=new WechatAccountAccess(store,{clock:()=>now});access.block();
 const restored=new WechatAccountAccess(store,{clock:()=>now});assert.throws(()=>restored.check(),e=>e.rateLimited&&e.restriction.retryAt===1000+WECHAT_ACCOUNT_PAUSE_MS);
 assert.deepEqual(Object.keys(store.get('article-meta','wechat-limit')).sort(),['code','platformCode','retryAt']);
 now+=WECHAT_ACCOUNT_PAUSE_MS+1;assert.doesNotThrow(()=>restored.check());restored.clear();assert.doesNotThrow(()=>new WechatAccountAccess(store,{clock:()=>now}).check());
});
test('old 200013 record is migrated without querying WeChat or discarding its cursor',()=>{
 const store=storeFixture();store.put('article-meta','discovery',{id:'original',request:{mode:'author',platform:'公众号',input:author.sourceInput},authorContext:author,status:'failed',message:'微信返回 200013',offset:5,items:[{id:'kept',title:'已有文章',status:'pending'}]});
 const reader={accountAccess:new WechatAccountAccess(store,{clock:()=>1000})},center=new Articles({store,reader,directory:'.'}),record=center.view().discovery;
 assert.equal(record.id,'original');assert.equal(record.offset,5);assert.equal(record.items.length,1);assert.equal(record.action,'wechat-rate-limit');assert.equal(record.status,'needs-action');assert.throws(()=>reader.accountAccess.check(),e=>e.rateLimited);
});
test('repeated Update resumes the same limited discovery and retains already obtained articles',async()=>{
 const store=storeFixture(),first='https://mp.weixin.qq.com/s/first';let fail=true,seen;
 const request={mode:'author',platform:'公众号',input:author.sourceInput,limit:30};
 store.put('article-meta','discovery',{id:'kept-record',request,authorContext:author,status:'needs-action',action:'wechat-rate-limit',restriction:{retryAt:1},offset:5,items:[{id:'wx-first',platform:'公众号',url:first,title:'已有文章',status:'pending'}]});
 const reader={discover:async(_r,previous)=>{seen=structuredClone(previous);if(fail)wechatAccountPage({base_resp:{ret:200013}},author,5,5);return {source:'wechat-account',items:[{url:'https://mp.weixin.qq.com/s/second',title:'下一篇'}],offset:10,complete:false};},close(){}};
 const center=new Articles({store,reader,directory:'.'});await center.start(request);assert.equal(seen.offset,5);assert.equal(center.record.id,'kept-record');assert.equal(center.record.items.length,1);assert.equal(center.record.offset,5);
 fail=false;await center.start(request);assert.equal(center.record.id,'kept-record');assert.equal(center.record.items.length,2);assert.equal(center.record.offset,10);assert.equal(center.record.action,null);assert.equal(center.record.restriction,null);
});
test('a partially fetched page retains both the limit action and already persisted results',async()=>{
 const store=storeFixture(),restriction={code:'WECHAT_RATE_LIMIT',platformCode:'200013',retryAt:99999};
 const center=new Articles({store,directory:'.',reader:{identifyAuthor:async()=>author,discover:async()=>({source:'wechat-account',items:[{url:'https://mp.weixin.qq.com/s/first',title:'已有文章'}],offset:5,complete:false,needsAction:true,action:'wechat-rate-limit',restriction}),close(){}}});
 await center.start({mode:'author',platform:'公众号',input:author.sourceInput,limit:30});assert.equal(center.record.items.length,1);assert.equal(center.record.offset,5);assert.deepEqual(center.record.restriction,restriction);assert.equal(center.record.status,'needs-action');
});
