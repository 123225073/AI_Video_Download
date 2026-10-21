import test from 'node:test';
import assert from 'node:assert/strict';
import {ExternalBrowserTab} from '../electron/external-browser.js';
import {externalBrowserWindow} from '../electron/external-browser-window.js';
import {openDouyinSearch} from '../electron/douyin-navigation.js';

function freshOfficialTab(){
  let url='about:blank',searchValue='';const calls=[];
  const owner={tabs:new Map(),connection:{connected:true,async send(method,params){
    calls.push(method);
    if(method==='Page.getFrameTree')return {frameTree:{frame:{url}}};
    if(method==='Page.navigate'){url=params.url;queueMicrotask(()=>{tab.receive('Page.frameNavigated',{frame:{id:'main',url}});tab.receive('Page.loadEventFired',{});});return {frameId:'main',loaderId:'load'};}
    if(method==='Runtime.evaluate'){
      if(params.expression==='navigator.userAgent')return {result:{value:'Chrome fixture'}};
      if(params.expression.includes('function douyinVisibleState')){const search=url.includes('/search/');return {result:{value:{official:true,path:new URL(url).pathname,ready:'complete',searchReady:true,searchValue,searchKeyword:search?'AI':null,searchType:search?'general':null}}};}
      if(params.expression.includes('function douyinVisibleAction'))return {result:{value:{found:true,x:15,y:25}}};
    }
    if(method==='Input.insertText')searchValue=params.text;
    if(method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased')url='https://www.douyin.com/jingxuan/search/AI?type=general';
    return {};
  }}};
  const tab=new ExternalBrowserTab(owner,'own',value=>value.startsWith('https://www.douyin.com/'));tab.sessionId='session';owner.tabs.set('own',tab);
  return {manager:{open:async()=>tab},calls};
}

test('fresh deferred external tab navigates to Douyin before evaluating an official-page probe',async()=>{
  const f=freshOfficialTab(),w=await externalBrowserWindow(f.manager,'https://www.douyin.com/jingxuan/search/AI?type=general','抖音');
  assert.equal(w.webContents.getURL(),'about:blank');
  await openDouyinSearch(w,'AI',new AbortController().signal,{restart:true,wait:async()=>{}});
  assert.ok(f.calls.indexOf('Page.navigate')<f.calls.indexOf('Runtime.evaluate'),'official navigation must precede protected evaluation');
  assert.equal(await w.externalTab.currentURL(),'https://www.douyin.com/jingxuan/search/AI?type=general');
});

test('cancelled external-tab preparation returns immediately and closes a late tab without showing it',async()=>{
 let release;const controller=new AbortController(),calls=[];
 const manager={open:()=>new Promise(resolve=>release=resolve)};
 const opening=externalBrowserWindow(manager,'https://www.douyin.com/','抖音',{signal:controller.signal});controller.abort();
 await assert.rejects(opening);release({show:async()=>calls.push('show'),close:async()=>calls.push('close')});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['close']);
});
