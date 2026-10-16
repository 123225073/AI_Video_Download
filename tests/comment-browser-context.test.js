import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import {searchUser} from '../electron/user-search-data.js';
import {thumbnailUrl} from '../electron/thumbnail.js';
import {youtubeCommentContext} from '../electron/youtube-session.js';
import {douyinPageState} from '../electron/douyin-page.js';

const source=fs.readFileSync(new URL('../electron/comment-workflow.js',import.meta.url),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const douyin={id:'7633204472352781667',platform:'抖音',url:'https://www.douyin.com/video/7633204472352781667',title:'所选来源作品'};
const youtube={id:'vUno6VvDnGk',platform:'YouTube',url:'https://www.youtube.com/watch?v=vUno6VvDnGk',title:'所选YouTube作品'};
const comment=(id='first')=>({id,userId:'MS4wLjAB_fixture',name:'公开用户',text:'首批公开评论 '+id,published:'今天'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({item=douyin,read=async()=>({comments:[comment()],complete:true}),external=true}={}){
  const records=new Map(),disk=new Map(),events=[],calls=[],session={id:'same-official-session'};
  let reads=0;const context={randomUUID,createHash,searchUser,thumbnailUrl,youtubeCommentContext,douyinPageState,AbortController,URL,
    delay:async(_ms,_value,{signal}={})=>{signal?.throwIfAborted();calls.push({kind:'delay'});}};
  const makeWindow=(url,{borrowed=false}={})=>{
    const w={url,borrowed,dead:false,hidden:0,shown:0,destroyed:0,externalTab:external?{}:undefined,
      isDestroyed(){return this.dead;},hide(){this.hidden++;},show(){this.shown++;},destroy(){this.dead=true;this.destroyed++;},close(){this.destroy();},
      webContents:{session,getURL:()=>w.url,executeJavaScript:async script=>{
        if(script.includes('function douyinPageState('))return {kind:'unconfirmed',retryable:false};
        reads++;return read({reads,opens:browser.opened.length,window:w,script});
      }}};return w;
  };
  let browser;
  class Browser{
    constructor(){browser=this;this.opened=[];this.selected=[];this.shown=0;}
    async open(url,record,signal,options={}){
      signal.throwIfAborted();const w=options.reuse&&this.window&&!this.window.isDestroyed()?this.window:makeWindow(url);w.url=url;this.window=w;
      this.opened.push({url,record:copy(record),options:copy(options),window:w});calls.push({kind:'open',url,record:copy(record),options:copy(options)});return w;
    }
    async selectDouyinWork(selected,signal,options={}){
      signal.throwIfAborted();this.selected.push({selected,signal,sourceBrowser:options.sourceBrowser});calls.push({kind:'select',id:selected.id});
      if(this.selectionError)throw this.selectionError;
      const w=options.sourceBrowser?.window;if(!w||w.isDestroyed())throw Object.assign(Error('原页面不可用，请打开所选作品后继续'),{needsAction:true});return w;
    }
    close(){if(this.window)this.window.destroy();this.window=null;calls.push({kind:'close-own-browser'});}
    show(){this.shown++;this.window?.show();}
  }
  context.ContentBrowser=Browser;vm.createContext(context);vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.CommentWorkflow=CommentWorkflow;globalThis.publicComment=publicComment;',context);
  const store={get:(kind,id)=>records.has(kind+':'+id)?copy(records.get(kind+':'+id)):null,put:(kind,id,value)=>records.set(kind+':'+id,copy(value)),flush(){disk.clear();for(const [key,value]of records)disk.set(key,copy(value));}};
  const accounts={active:()=>({id:'account-a'}),usesExternal:()=>external};
  const search={active:null,item:()=>({item,accountId:'account-a'}),browser:null,creators:{browser:null},userSearch:{browser:null}};
  const workflow=new context.CommentWorkflow({store,search,accounts,changed(){events.push(copy(workflow.view()));}});
  const borrowed=makeWindow('https://www.douyin.com/jingxuan/search/fixture?type=general',{borrowed:true});
  search.browser={window:borrowed,accountId:'account-a'};
  const saved=()=>disk.get('comment-collection:'+workflow.record.id);
  return {workflow,search,accounts,events,calls,borrowed,makeWindow,session,saved,get reads(){return reads;},seed(){workflow.record={id:'saved-comments',source:item,accountId:'account-a',comments:[context.publicComment(item.platform,comment('old'))],status:'interrupted',limit:50,createdAt:1};workflow.publish();}};
}

test('抖音外置评论精确选择已有同账号来源作品，不深链打开新窗口；close保留来源标签',async()=>{
  const f=fixture();const result=await f.workflow.start('search-source',douyin.id,5);
  assert.equal(f.workflow.browser.selected.length,1);const selected=f.workflow.browser.selected[0];assert.equal(selected.selected,douyin);assert.equal(selected.sourceBrowser,f.search.browser);assert.equal(selected.signal.aborted,false);
  assert.equal(f.workflow.browser.opened.length,0,'外置抖音不能重新深链打开所选视频');assert.equal(result.status,'complete');assert.equal(result.comments.length,1);assert.equal(f.workflow.borrowedWindow,f.borrowed);
  await f.workflow.close();assert.equal(f.borrowed.dead,false);assert.equal(f.borrowed.destroyed,0);assert.equal(f.search.browser.window,f.borrowed);
});

test('抖音借用只能选择同账号来源页，不能因候选顺序点击其他账号标签',async()=>{
  const f=fixture(),wrong=f.search.browser;wrong.accountId='account-b';
  f.search.creators.browser={window:f.makeWindow('https://www.douyin.com/user/selected-author',{borrowed:true}),accountId:'account-a'};
  await f.workflow.start('search-source',douyin.id,5);
  assert.equal(f.workflow.browser.selected[0].sourceBrowser,f.search.creators.browser,'应跳过其他账号的搜索页，借用同账号博主页');assert.equal(f.workflow.browser.opened.length,0);assert.equal(wrong.window.dead,false);await f.workflow.close();
});

test('抖音继续前账号已切换时先拒绝，不先点击旧来源标签再报错',async()=>{
  const f=fixture();f.seed();f.accounts.active=()=>({id:'different-account'});
  await assert.rejects(f.workflow.more('saved-comments',50),/账号已切换/);assert.equal(f.workflow.browser.selected.length,0,'账号核对必须发生在来源页面点击前');assert.equal(f.saved().comments[0].id,'old');assert.equal(f.borrowed.dead,false);await f.workflow.close();
});

test('新的抖音账号任务不能把上次借用窗口伪装成新账号来源',async()=>{
  const f=fixture();await f.workflow.start('source-a',douyin.id,5);const old=f.borrowed;
  const nextSource={window:f.makeWindow('https://www.douyin.com/jingxuan/search/next?type=general',{borrowed:true}),accountId:'account-b'};f.search.browser=nextSource;f.accounts.active=()=>({id:'account-b'});f.search.item=()=>({item:douyin,accountId:'account-b'});
  await f.workflow.start('source-b',douyin.id,5);assert.equal(f.workflow.browser.selected[1].sourceBrowser,nextSource,'上次借用窗口必须保留原账号归属');assert.equal(old.dead,false);assert.equal(nextSource.window.dead,false);await f.workflow.close();
});

test('抖音借用采集中cancel只停止本次任务，来源标签不销毁且迟到评论不写入',async()=>{
  const started=deferred(),gate=deferred(),f=fixture({read:async()=>{started.resolve();return gate.promise;}}),pending=f.workflow.start('source',douyin.id,5);
  try{await started.promise;f.workflow.cancel();assert.equal(f.borrowed.dead,false);gate.resolve({comments:[comment('late')],complete:true});await assert.rejects(pending);assert.equal(f.workflow.view().comments.length,0);assert.equal(f.saved().status,'interrupted');assert.match(f.saved().message,/已停止/);assert.equal(f.workflow.view().busy,false);}
  finally{gate.resolve({comments:[]});await pending.catch(()=>{});await f.workflow.close();assert.equal(f.borrowed.destroyed,0);}
});

test('抖音来源选择异常needsAction会持久化旧评论和继续位置，不报完成或销毁来源页',async()=>{
  const f=fixture();f.seed();f.workflow.browser.selectionError=Object.assign(Error('请在原页面打开准确作品后继续'),{needsAction:true});
  await assert.rejects(f.workflow.more('saved-comments',50),/准确作品/);assert.equal(f.saved().status,'needs-action');assert.equal(f.saved().comments.length,1);assert.equal(f.saved().comments[0].id,'old');assert.equal(f.workflow.view().canContinue,true);assert.equal(f.workflow.view().busy,false);assert.equal(f.borrowed.dead,false);assert.equal(f.workflow.browser.opened.length,0);await f.workflow.close();
});

test('YouTube连续首批为空且无验证时只重载一次，复用原会话并读到新评论',async()=>{
  const f=fixture({item:youtube,read:async({opens})=>opens===1?{comments:[],message:'评论尚在加载'}:{comments:[{...comment('youtube'),userId:'@public-user'}],complete:true}});
  const result=await f.workflow.start('source',youtube.id,5),opened=f.workflow.browser.opened;
  assert.equal(opened.length,2);assert.equal(opened[1].options.reuse,true);assert.equal(opened[0].window,opened[1].window);assert.equal(opened[1].record.accountId,'account-a');assert.equal(opened[1].window.webContents.session,f.session);assert.equal(opened[1].url,youtube.url);
  assert.equal(result.comments[0].id,'youtube');assert.equal(result.status,'complete');assert.equal(f.events.filter(e=>/同一 Chrome 会话重新加载/.test(e.message||'')).length,1);await f.workflow.close();
});

test('YouTube一次重载后仍为空时保留可继续状态，不反复重新打开或误报全部完成',async()=>{
  const f=fixture({item:youtube,read:async()=>({comments:[],message:'首批仍未加载'})});const result=await f.workflow.start('source',youtube.id,5);
  assert.equal(f.workflow.browser.opened.length,2);assert.ok(f.reads>15&&f.reads<=40,'恢复有有限等待，不无限重载');assert.equal(result.status,'interrupted');assert.equal(result.canContinue,true);assert.equal(result.comments.length,0);await f.workflow.close();
});

test('YouTube明确complete的空评论是真正末页，不进行空批恢复重载',async()=>{
  const f=fixture({item:youtube,read:async()=>({comments:[],complete:true})});const result=await f.workflow.start('source',youtube.id,5);
  assert.equal(f.reads,1);assert.equal(f.workflow.browser.opened.length,1);assert.equal(result.status,'complete');assert.equal(result.comments.length,0);await f.workflow.close();
});

for(const page of [
  {comments:[],blocked:true,message:'官方评论页面要求验证码'},
  {comments:[],blocked:true,reason:'login',message:'YouTube要求登录确认不是机器人'}
])test(`YouTube${page.reason==='login'?'登录':'验证码'}阻断不进行自动重载，保留needs-action和官方操作入口`,async()=>{
  const f=fixture({item:youtube,read:async()=>page});const result=await f.workflow.start('source',youtube.id,5);
  assert.equal(f.workflow.browser.opened.length,1);assert.equal(result.status,'needs-action');assert.equal(result.canContinue,true);assert.equal(f.workflow.browser.shown,1);assert.ok(f.reads<=4);assert.equal(f.events.some(e=>/重新加载所选视频/.test(e.message||'')),false);await f.workflow.close();
});
