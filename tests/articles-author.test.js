import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {wechatAuthor,wechatAccountPage,wechatAccountRetry} from '../electron/article-data.js';
import {Articles} from '../electron/articles.js';

const input='https://mp.weixin.qq.com/s/seed',biz='MzkwNjQ0MTIzNA==';
const author=()=>wechatAuthor({author:'编程进阶录',sourceIdentity:{biz},account:{avatar:'http://wx.qlogo.cn/avatar',username:'gh_sample',description:'编程文章'}},input);
test('author identity comes from the article account, with approved avatar only',()=>{
 const a=author();assert.equal(a.biz,biz);assert.equal(a.name,'编程进阶录');assert.equal(a.avatar,'https://wx.qlogo.cn/avatar');assert.equal(a.sourceInput,input);
 assert.throws(()=>wechatAuthor({author:'作者',sourceIdentity:{biz:''}},input),/账号标识/);
 assert.equal(wechatAuthor({author:'作者',sourceIdentity:{biz},account:{avatar:'https://evil.test/a'}},input).avatar,'');
});
test('official account pagination preserves server offsets and rejects foreign biz',()=>{
 const a=author(),list=[{title:'文章一',link:'https://mp.weixin.qq.com/s?__biz='+encodeURIComponent(biz)+'&mid=1&idx=1',cover:'https://mmbiz.qpic.cn/a',create_time:1791324000},{title:'其他账号',link:'https://mp.weixin.qq.com/s?__biz=wrong&mid=2&idx=1'}];
 const p=wechatAccountPage({base_resp:{ret:0},app_msg_list:list,app_msg_cnt:10},a,0,2);
 assert.equal(p.items.length,1);assert.equal(p.items[0].author,a.name);assert.equal(p.offset,2);assert.equal(p.complete,false);assert.ok(p.items[0].thumbnail);assert.ok(p.items[0].publishedAt);
 assert.equal(wechatAccountPage({base_resp:{ret:0},app_msg_list:[],app_msg_cnt:2},a,2,2).complete,true);
 assert.throws(()=>wechatAccountPage({base_resp:{ret:0},app_msg_list:[],app_msg_cnt:10},a,2,2),/空列表/);
 assert.throws(()=>wechatAccountPage({base_resp:{ret:0},app_msg_list:[{title:'其他作者',link:'https://mp.weixin.qq.com/s?__biz=wrong&mid=2&idx=1'}],app_msg_cnt:1},a,0,5),/身份/);
});
test('expired login, rate limits and malformed account responses never become empty success',()=>{
 assert.throws(()=>wechatAccountPage({base_resp:{ret:200003}},author(),0,5),e=>e.needsAction&&e.wechatLogin);
 assert.throws(()=>wechatAccountPage({base_resp:{ret:200013}},author(),0,5),/200013/);
 for(const value of [{},{base_resp:{ret:0}},{base_resp:{ret:0},app_msg_list:'invalid'}])assert.throws(()=>wechatAccountPage(value,author(),0,5));
});
test('current publish-page format counts publish records, retains all multi-article posts, and fails closed on broken JSON',()=>{
 const entry=n=>({title:'文章'+n,link:'https://mp.weixin.qq.com/s?'+new URLSearchParams({__biz:biz,mid:String(n),idx:'1'})});
 const data={base_resp:{ret:0},publish_page:JSON.stringify({total_count:4,publish_list:[{publish_info:JSON.stringify({appmsgex:[entry(1),entry(2)]})},{publish_info:JSON.stringify({appmsgex:[entry(3)]})}]})};
 const p=wechatAccountPage(data,author(),0,2);assert.equal(p.items.length,3);assert.equal(p.offset,2);assert.equal(p.total,4);assert.equal(p.totalUnit,'publish');assert.equal(p.complete,false);
 for(const publish_page of ['{broken',JSON.stringify({publish_list:[{publish_info:'{broken'}]}),JSON.stringify({publish_list:[{publish_info:'{}'}]})])assert.throws(()=>wechatAccountPage({...data,publish_page},author(),0,2),/位置/);
});
test('rate limits retry the same request after 20/40 seconds, with a strict three-attempt bound',async()=>{
 const waits=[],messages=[];let calls=0;const response=await wechatAccountRetry(async()=>{calls++;return calls<3?{base_resp:{ret:200013}}:{base_resp:{ret:0}};},{progress:m=>messages.push(m),wait:async ms=>waits.push(ms)});assert.equal(response.base_resp.ret,0);assert.equal(calls,3);assert.deepEqual(waits,[20000,40000]);assert.equal(messages.length,2);
 calls=0;const final=await wechatAccountRetry(async()=>{calls++;return {base_resp:{ret:200013}};},{wait:async()=>{}});assert.equal(calls,3);assert.equal(final.base_resp.ret,200013);
 const c=new AbortController();calls=0;await assert.rejects(wechatAccountRetry(async()=>{calls++;return {base_resp:{ret:200013}};},{signal:c.signal,wait:async()=>c.abort()}));assert.equal(calls,1);
});
function fixture(reader){
 const records=new Map(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'fengsha-author-'));
 const store={get:(k,id)=>structuredClone(records.get(k+':'+id)||null),put:(k,id,v)=>records.set(k+':'+id,structuredClone(v)),list:k=>[...records].filter(([id])=>id.startsWith(k+':')).map(([,v])=>structuredClone(v)),flush(){}};
 return {directory,center:new Articles({store,directory,reader,changed(){}})};
}
test('automatic identity lookup does not fetch or archive articles; update reuses identity',async()=>{
 let lookups=0,fetches=0;const f=fixture({identifyAuthor:async()=>{lookups++;return author();},discover:async(request)=>{fetches++;assert.equal(request.authorContext.biz,biz);return {items:[],complete:true,message:'账号没有文章'};},close(){}});
 try{await f.center.identifyAuthor({mode:'author',platform:'公众号',input});assert.equal(lookups,1);assert.equal(fetches,0);assert.equal(f.center.view().discovery.status,'identified');assert.equal(f.center.view().library.length,0);assert.equal(f.center.view().discovery.items.length,0);await f.center.start({mode:'author',platform:'公众号',input});assert.equal(lookups,1);assert.equal(fetches,1);}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
test('missing authorization keeps identified account and empty results with explicit action',async()=>{
 const f=fixture({identifyAuthor:async()=>author(),discover:async()=>{throw Object.assign(Error('请连接微信公众平台'),{needsAction:true,wechatLogin:true});},close(){}});
 try{await f.center.start({mode:'author',platform:'公众号',input});const r=f.center.view().discovery;assert.equal(r.status,'needs-action');assert.equal(r.authorContext.biz,biz);assert.equal(r.items.length,0);assert.equal(r.action,'wechat-login');assert.equal(r.complete,undefined);}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
test('saving an article cannot overwrite account-list window target or accept wrong biz',async()=>{
 const f=fixture({identifyAuthor:async()=>author(),discover:async()=>({items:[{url:input,title:'文章一'}],complete:true,source:'wechat-account',offset:1}),read:async()=>({url:input,title:'文章一',author:author().name,sourceIdentity:{biz:'other'},blocks:[{type:'text',text:'正文'}],images:[]}),close(){}});
 try{await f.center.start({mode:'author',platform:'公众号',input});await f.center.collect(f.center.view().discovery.items.map(i=>i.id));assert.equal(f.center.view().library.length,0);assert.match(f.center.view().discovery.items[0].error,/身份/);assert.equal(f.center.view().discovery.source,'wechat-account');}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
test('repeated account pages do not advance the stored cursor or fake completion',async()=>{
 const f=fixture({identifyAuthor:async()=>author(),discover:async()=>({items:[{url:input,title:'文章一'}],source:'wechat-account',offset:5,complete:false}),close(){}});
 try{await f.center.start({mode:'author',platform:'公众号',input});await f.center.more();const r=f.center.view().discovery;assert.equal(r.items.length,1);assert.equal(r.offset,5);assert.equal(r.complete,false);assert.equal(r.status,'failed');assert.match(r.message,/重复/);}finally{await f.center.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});
