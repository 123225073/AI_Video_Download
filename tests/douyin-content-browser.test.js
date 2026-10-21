import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {contentLoadError,contentAction} from '../electron/content-network.js';
import {transientNavigationError} from '../electron/browser-navigation.js';
const source=fs.readFileSync(new URL('../electron/content-browser.js',import.meta.url),'utf8');
function fixture(external=true,{loadErrors=[],createErrors=[],searchErrors=[],create}={}){
 const calls=[],w=new EventEmitter(),contents=new EventEmitter(),debuggerApi=new EventEmitter();let closed=false;
 Object.assign(debuggerApi,{isAttached:()=>false,attach:()=>{},sendCommand:async()=>({})});
 Object.assign(contents,{debugger:debuggerApi,setAudioMuted:()=>{},setWindowOpenHandler:()=>{},getURL:()=>external?'https://www.douyin.com/jingxuan/search/AI?type=general':'https://www.douyin.com/search/AI?type=video'});
 Object.assign(w,{webContents:contents,setMenu:()=>{},isDestroyed:()=>closed,destroy:()=>{closed=true;},show:()=>{},focus:()=>{},...(external?{externalTab:{}}:{})});
 let creates=0;const context={Map,Set,Buffer,Error,BrowserWindow:function(){return w;},officialUserAgent:'fixture',contentNavigation:()=>({allowed:true}),navigateOfficialPage:async(_w,url)=>{calls.push({normal:url});if(loadErrors.length)throw loadErrors.shift();},openDouyinSearch:async(_w,keyword,signal,opts)=>{calls.push({gui:keyword});if(searchErrors.length)throw searchErrors.shift();await opts.navigate('https://www.douyin.com/');},externalBrowserWindow:async()=>{creates++;if(createErrors.length)throw createErrors.shift();return create?await create(w):w;},transientNavigationError,contentLoadError,contentAction,contentLoadMessage:e=>e.message,delay:async(_ms,_value,{signal})=>signal.throwIfAborted()};
 const Class=vm.runInNewContext(source.slice(source.indexOf('export class ContentBrowser')).replace('export class','class')+';ContentBrowser',context);
 return {browser:new Class({usesExternal:()=>external}),calls,w,creates:()=>creates};
}
test('ContentBrowser external Douyin search uses GUI homepage flow after installing network listeners',async()=>{
 const {browser,calls}=fixture();
 await browser.open('https://www.douyin.com/jingxuan/search/AI?type=general',{id:'test',platform:'抖音',keyword:'AI'},new AbortController().signal);
 assert.deepEqual(calls,[{gui:'AI'},{normal:'https://www.douyin.com/'}]);assert.equal(browser.pendingDouyinSearch,false);
});
test('embedded Douyin compatibility retains its existing navigation behavior',async()=>{
 const {browser,calls}=fixture(false),url='https://www.douyin.com/search/AI?type=video';
 await browser.open(url,{id:'test',platform:'抖音',keyword:'AI'},new AbortController().signal);
 assert.deepEqual(calls,[{normal:url}]);
});
test('non-Douyin external search retains its existing navigation behavior',async()=>{
 const {browser,calls}=fixture(),url='https://www.youtube.com/results?search_query=AI';
 await browser.open(url,{id:'test',platform:'YouTube',keyword:'AI'},new AbortController().signal);
 assert.deepEqual(calls,[{normal:url}]);
});

const query={id:'test',platform:'抖音',keyword:'AI'},target='https://www.douyin.com/jingxuan/search/AI?type=general';
test('external Douyin transient navigation reconnects once; repeated failure keeps its original code and action',async()=>{
 const success=fixture(true,{loadErrors:[Error('net::ERR_CONNECTION_CLOSED')]});await success.browser.open(target,query,new AbortController().signal);assert.equal(success.calls.filter(c=>c.normal).length,2);
 const failed=fixture(true,{loadErrors:[Error('net::ERR_CONNECTION_CLOSED'),Error('net::ERR_CONNECTION_CLOSED')]});
 await assert.rejects(failed.browser.open(target,query,new AbortController().signal),e=>e.code==='ERR_CONNECTION_CLOSED'&&e.recoveryAttempts===1&&e.action.kind==='network'&&e.cause.message.includes('ERR_CONNECTION_CLOSED'));
 assert.equal(failed.calls.filter(c=>c.normal).length,2);assert.equal(failed.browser.window,null);
});
test('official login and verification never trigger an automatic reload',async()=>{
 for(const kind of ['login','verification']){
  const error=Object.assign(Error('请在官方窗口处理'),{needsAction:true,keepWindow:true,action:{kind,message:'请在官方窗口处理',retryable:false}}),f=fixture(true,{searchErrors:[error]});
  await assert.rejects(f.browser.open(target,query,new AbortController().signal),e=>e===error);assert.equal(f.calls.filter(c=>c.gui).length,1);assert.equal(f.calls.filter(c=>c.normal).length,0);assert.equal(f.w.isDestroyed(),false);
 }
});
test('browser-creation errors are actionable; only a transient connection loss is retried',async()=>{
 const missing=fixture(true,{createErrors:[Error('未找到 Chrome 或 Microsoft Edge，请安装官方浏览器')]});
 await assert.rejects(missing.browser.open(target,query,new AbortController().signal),e=>e.action.kind==='page'&&/安装官方浏览器/.test(e.message)&&e.sourceMessage.includes('未找到'));
 assert.equal(missing.creates(),1);
 const transient=fixture(true,{createErrors:[Error('Chrome connection closed')]});await transient.browser.open(target,query,new AbortController().signal);assert.equal(transient.creates(),2);assert.equal(transient.calls.filter(c=>c.normal).length,1);
});
test('cancellation during an unfinished browser creation destroys the late window before navigation',async()=>{
 let release,started;const pending=new Promise(resolve=>started=resolve),f=fixture(true,{create:async w=>{started();await new Promise(resolve=>release=resolve);return w;}}),controller=new AbortController();
 const opening=f.browser.open(target,query,controller.signal);await pending;controller.abort();release();await assert.rejects(opening,/停止/);
 assert.equal(f.w.isDestroyed(),true);assert.equal(f.browser.window,null);assert.equal(f.calls.length,0);
});
