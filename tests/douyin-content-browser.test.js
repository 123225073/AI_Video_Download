import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
const source=fs.readFileSync(new URL('../electron/content-browser.js',import.meta.url),'utf8');
function fixture(external=true){
 const calls=[],w=new EventEmitter(),contents=new EventEmitter(),debuggerApi=new EventEmitter();let closed=false;
 Object.assign(debuggerApi,{isAttached:()=>false,attach:()=>{},sendCommand:async()=>({})});
 Object.assign(contents,{debugger:debuggerApi,setAudioMuted:()=>{},setWindowOpenHandler:()=>{},getURL:()=>external?'https://www.douyin.com/jingxuan/search/AI?type=general':'https://www.douyin.com/search/AI?type=video'});
 Object.assign(w,{webContents:contents,setMenu:()=>{},isDestroyed:()=>closed,destroy:()=>{closed=true;},show:()=>{},focus:()=>{},...(external?{externalTab:{}}:{})});
 const context={Map,Set,Buffer,Error,BrowserWindow:function(){return w;},officialUserAgent:'fixture',contentNavigation:()=>({allowed:true}),navigateOfficialPage:async(_w,url)=>calls.push({normal:url}),openDouyinSearch:async(_w,keyword,signal,opts)=>{calls.push({gui:keyword});await opts.navigate('https://www.douyin.com/');},externalBrowserWindow:async()=>w,transientNavigationError:()=>false,contentLoadMessage:e=>e.message};
 const Class=vm.runInNewContext(source.slice(source.indexOf('export class ContentBrowser')).replace('export class','class')+';ContentBrowser',context);
 return {browser:new Class({usesExternal:()=>external}),calls,w};
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
