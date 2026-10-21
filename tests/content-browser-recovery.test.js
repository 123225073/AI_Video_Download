import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,record,card} from '../scripts/search-regression-harness.mjs';
import {contentLoadError,contentLoadMessage} from '../electron/content-network.js';

test('API network failure clears after its read; a visible recovered page continues without the stale action',async()=>{
 const h=harness(()=>({items:[card('小红书')]})),r=record('小红书'),signal=new AbortController().signal;
 await h.browser.open(h.searchURL(r),r,signal);await h.response(r,{},true);
 const failed=await h.browser.read(r,signal);assert.equal(failed.needsAction,true);assert.equal(failed.action.kind,'network');assert.equal(h.browser.networkError,null);assert.equal(h.browser.networkAction,null);
 const checked=await h.browser.checkAction(r,signal);assert.equal(checked.ready,true);
 const resumed=await h.browser.read(r,signal);assert.equal(resumed.needsAction,false);assert.equal(resumed.action,undefined);assert.equal(resumed.items.length,1);assert.equal(h.stats().loads,1);
});

test('a newer explicit login failure replaces the previous network action in the same read',async()=>{
 const h=harness(()=>({items:[card('小红书')]})),r=record('小红书'),signal=new AbortController().signal;
 await h.browser.open(h.searchURL(r),r,signal);await h.response(r,{},true);await h.response(r,{success:false,code:300012,msg:'登录已失效'});
 const failed=await h.browser.read(r,signal);assert.equal(failed.action.kind,'login');assert.match(failed.message,/登录已失效/);
});

test('recovery checks do not navigate, reopen a closed window, or mark an empty shell ready',async()=>{
 let snapshot={items:[]};const h=harness(()=>snapshot),r=record('小红书'),signal=new AbortController().signal;
 await h.browser.open(h.searchURL(r),r,signal);const before=h.stats();
 assert.equal((await h.browser.checkAction(r,signal)).ready,false);assert.deepEqual(h.stats(),before);
 snapshot={items:[card('小红书')],blocked:true,reason:'login',message:'需要登录'};const blocked=await h.browser.checkAction(r,signal);assert.equal(blocked.action.kind,'login');assert.equal(blocked.ready,false);
 snapshot={items:[card('小红书')]};assert.equal((await h.browser.checkAction(r,signal)).ready,true);
 h.browser.close();const closed=await h.browser.checkAction(r,signal);assert.equal(closed.closed,true);assert.equal(closed.ready,false);assert.equal(h.stats().loads,1);
});

test('recovery on a detail verification window preserves its exact work and does not navigate to a search',async()=>{
 const item=card('小红书');let snapshot={blocked:true,reason:'verification',message:'完成验证',items:[]};
 const h=harness(()=>snapshot),r=record('小红书'),detail={id:'detail-'+item.id,detailId:item.id,platform:'小红书',accountId:null},signal=new AbortController().signal;
 await h.browser.open(item.url,detail,signal);const first=await h.browser.openAction(r,signal);assert.equal(first.ready,false);assert.equal(first.action.kind,'verification');assert.equal(h.stats().loads,1);assert.equal(h.browser.window.webContents.getURL(),item.url);
 snapshot={detail:{id:item.id},items:[]};assert.equal((await h.browser.checkAction(r,signal)).ready,true);
 snapshot={detail:{id:'wrong'},items:[]};assert.equal((await h.browser.checkAction(r,signal)).ready,false);
 h.browser.close();snapshot={detail:{id:item.id},items:[]};assert.equal((await h.browser.openAction(r,signal)).ready,true);assert.equal(h.browser.window.webContents.getURL(),item.url);assert.equal(h.stats().loads,2);
});

test('unclassified load failures keep a useful original cause instead of disguising every failure as network IP',()=>{
 const original=Error('浏览器启动被组织策略限制 https://example.com/?token=PRIVATE');const failure=contentLoadError(original);
 assert.equal(failure.cause,original);assert.equal(failure.code,'BROWSER_LOAD_FAILED');assert.equal(failure.action.kind,'page');assert.match(failure.message,/组织策略/);assert.doesNotMatch(failure.message+' '+failure.sourceMessage,/PRIVATE/);
 assert.match(contentLoadMessage(Error('Chrome connection closed')),/BROWSER_CONNECTION_CLOSED/);
});
