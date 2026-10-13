// Reuses the 2026-10-13 audit fixtures. Executes adapter source with no real
// Electron window, session, disk store or network request.
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {ContentSearch} from '../electron/content-search.js';
import {contentItem,xhsContent,douyinContent,mergeContent} from '../electron/content-data.js';
import {contentNavigation} from '../electron/content-navigation.js';
import {contentLoadMessage} from '../electron/content-network.js';

const source=fs.readFileSync(new URL('../electron/content-browser.js',import.meta.url),'utf8');
const renderSource=source.slice(source.indexOf('export function renderedContent'),source.indexOf('export class ContentBrowser')).replace('export function','function');
export const options={from:'2026-09-13',to:'2026-10-13',limit:50,includeUnknown:false};
export const record=platform=>({id:'fixture-search',platform,keyword:'审计',accountId:null,options:{...options}});
export function card(platform,n=1,date='2026-10-01'){
  const id=platform==='小红书'?n.toString(16).padStart(24,'0'):platform==='YouTube'?String(n).padStart(11,'0'):String(10000+n);
  const url=platform==='小红书'?`https://www.xiaohongshu.com/explore/${id}`:platform==='YouTube'?`https://www.youtube.com/watch?v=${id}`:`https://www.douyin.com/video/${id}`;
  return contentItem(platform,{id,url,title:'合成作品 '+n,publishedAt:date});
}
export const rawWechat=(n,date)=>({id:String(n),createtime:new Date(date+'T12:00:00+08:00').getTime()/1000,objectDesc:{description:'合成作品 '+n,media:[{}]}});
export function service(browser,request=async()=>{}){
  const records=new Map();
  return new ContentSearch({accounts:{active:()=>null},creators:{progress:()=>null,requireLogin:async()=>{},connection:{withConnection:async(_s,fn)=>fn()}},userSearch:{active:null},browser,bilibili:{json:request},wechat:{request},store:{get:(k,id)=>records.get(k+id),put:(k,id,v)=>records.set(k+id,structuredClone(v)),flush(){}}});
}
export function rendered(platform,body='',label='2026-10-01',count=1,{footer=false,hidden=false}={}){
  const cards=Array.from({length:count},(_,i)=>{const c=card(platform,i+1);return {getClientRects:()=>[1],querySelectorAll:()=>[{href:c.url,title:c.title}],querySelector:q=>q.includes('#metadata-line')||q.includes('.time')?{innerText:label}:null};});
  const end={innerText:'没有更多了',getClientRects:()=>hidden?[]:[1],closest:()=>null};
  class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-10-13T12:00:00+08:00']));}}
  const url=platform==='YouTube'?'https://www.youtube.com/results?search_query=审计':platform==='小红书'?'https://www.xiaohongshu.com/search_result/?keyword=审计':'https://www.douyin.com/search/审计?type=video';
  const context={URL,Date:Clock,location:{href:url},window:{},getComputedStyle:()=>({visibility:'visible'}),document:{title:'合成页面',body:{innerText:body},querySelectorAll:q=>['.feeds-container .note-item,section.note-item','ytd-video-renderer','[data-e2e="search-video-list"] li,[data-e2e="search-video-item"]'].includes(q)?cards:footer&&q.includes('no-more')?[end]:[]}};
  return vm.runInNewContext(renderSource+`;renderedContent(${JSON.stringify(platform)},'审计')`,context);
}
export function harness(snapshotFn,onDelay=()=>{}){
  let scrolls=0,loads=0,shown=0,waits=0,hidden=0;
  class FakeWindow{
    constructor(){this.dead=false;this.url='';const wc=this.webContents=new EventEmitter(),dbg=wc.debugger=new EventEmitter();dbg.isAttached=()=>false;dbg.attach=()=>{};dbg.detach=()=>{};dbg.sendCommand=async method=>method==='Network.getResponseBody'?{body:JSON.stringify(this.body),base64Encoded:false}:{};wc.setAudioMuted=()=>{};wc.setWindowOpenHandler=()=>{};wc.getURL=()=>this.url;wc.executeJavaScript=async script=>{if(script.startsWith('window.scrollBy')){scrolls++;return;}return snapshotFn({scrolls,loads,window:this});};}
    setMenu(){}isDestroyed(){return this.dead;}destroy(){this.dead=true;}show(){shown++;}focus(){}hide(){hidden++;}
    async loadURL(url){this.url=url;loads++;scrolls=0;}
  }
  const context={BrowserWindow:FakeWindow,URL,Date,Map,Set,Buffer,contentItem,xhsContent,douyinContent,mergeContent,contentNavigation,contentLoadMessage,officialUserAgent:'NO-NETWORK',setTimeout,clearTimeout,delay:async(_ms,_value,{signal}={})=>{waits++;onDelay(waits);signal?.throwIfAborted();}};
  vm.runInNewContext(source.replace(/^import .*;\r?\n/gm,'').replace(/export /g,'')+'\nglobalThis.Adapter=ContentBrowser;',context);
  const browser=new context.Adapter({});browser.hidden=true;
  return {browser,stats:()=>({scrolls,loads,shown,waits,hidden}),async response(r,payload,failed=false){const w=browser.window;w.body=payload;const request=r.platform==='小红书'?{url:'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes',postData:JSON.stringify({keyword:r.keyword})}:{url:'https://www.douyin.com/aweme/v1/web/search/item/?keyword='+encodeURIComponent(r.keyword)};const listener=w.webContents.debugger.listeners('message')[0];await listener({},'Network.requestWillBeSent',{requestId:'fixture',request});await listener({},failed?'Network.loadingFailed':'Network.loadingFinished',{requestId:'fixture',encodedDataLength:100,errorText:'net::ERR_CONNECTION_RESET'});}};
}
