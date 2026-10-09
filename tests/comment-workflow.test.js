import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {searchUser} from '../electron/user-search-data.js';
import {thumbnailUrl} from '../electron/thumbnail.js';

const source=fs.readFileSync(new URL('../electron/comment-workflow.js',import.meta.url),'utf8');
const work={id:'abcdefabcdefabcdefabcdef',platform:'小红书',url:'https://www.xiaohongshu.com/explore/abcdefabcdefabcdefabcdef'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture({item=work,read=async()=>({comments:[],complete:true}),request,changed=()=>{}}={}){
  const records=new Map(),disk=new Map(),events=[];
  const store={get:(kind,id)=>records.get(kind+':'+id),put:(kind,id,value)=>records.set(kind+':'+id,structuredClone(value)),flush(){disk.clear();for(const [key,value] of records)disk.set(key,structuredClone(value));}};
  class Browser{
    constructor(){this.shown=0;this.opened=[];}
    close(){if(this.window)this.window.destroyed=true;this.window=null;}
    show(){this.shown++;}
    async open(url,record,signal){this.opened.push({url,record,hidden:this.hidden});signal.throwIfAborted();return this.window={destroyed:false,isDestroyed(){return this.destroyed;},hide(){this.hidden=true;},webContents:{executeJavaScript:read}};}
  }
  const context={randomUUID,createHash,delay,searchUser,thumbnailUrl,ContentBrowser:Browser,AbortController};
  vm.createContext(context);vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nglobalThis.CommentWorkflow=CommentWorkflow;globalThis.publicComment=publicComment;',context);
  const options={store,search:{active:null,item:()=>({item,accountId:null})},accounts:{active:()=>null},connection:{withConnection:async(_signal,fn)=>fn()},wechat:{request},changed(){events.push(structuredClone(workflow.view()));changed(workflow);}};
  const workflow=new context.CommentWorkflow(options);
  return {workflow,options,records,disk,events,restore:()=>new context.CommentWorkflow({...options,store:{...store,get:(kind,id)=>disk.get(kind+':'+id)}}),publicComment:context.publicComment};
}

test('搜索忙碌时开始或继续采集均拒绝，旧评论任务与上限不被替换',async()=>{
  const f=fixture();await f.workflow.start('search','work',3);
  const before=structuredClone(f.workflow.view()),saved=structuredClone([...f.disk]);
  f.options.search.active=new AbortController();
  await assert.rejects(async()=>f.workflow.start('other','work',10),/正在/);
  assert.deepEqual(structuredClone(f.workflow.view()),before);
  await assert.rejects(async()=>f.workflow.more(before.id,20),/正在/);
  assert.deepEqual(structuredClone(f.workflow.view()),before);
  assert.deepEqual([...f.disk],saved);
});

test('普通采集后台打开官方窗口，仅遇到验证时显示，继续读取恢复隐藏',async()=>{
  let blocked=false;
  const f=fixture({read:async()=>({comments:[],blocked,complete:!blocked,message:'请在官方窗口完成验证'})});
  await f.workflow.start('search','work');
  assert.equal(f.workflow.browser.opened[0].hidden,true);
  assert.equal(f.workflow.browser.shown,0);
  blocked=true;await f.workflow.more(f.workflow.record.id);
  assert.equal(f.workflow.browser.shown,1);
  assert.equal(f.workflow.view().status,'needs-action');
  blocked=false;await f.workflow.more(f.workflow.record.id);
  assert.equal(f.workflow.browser.window.hidden,true);
});

test('初始记录和DOM首批在changed前落盘，停止后可重启并继续同一任务',async()=>{
  const gate=deferred();let calls=0,initialSaved=false,batchSaved=false;
  const row={id:'first',name:'没有公开ID的用户',text:'首批正文',avatar:'https://example.com/avatar.png'};
  const f=fixture({read:async()=>++calls===1?{comments:[row]}:gate.promise,changed(w){
    const saved=f.disk.get('comment-collection:'+w.record.id);
    if(w.view().busy&&saved?.status==='reading'&&!saved.comments.length)initialSaved=true;
    if(w.view().busy&&saved?.comments.length===1)batchSaved=true;
  }});
  const pending=f.workflow.start('search','work');
  try{
    assert.equal(initialSaved,true,'等待窗口打开期间初始记录也应已持久化');
    await tick();assert.equal(batchSaved,true,'首批changed应能恢复同一批记录');
    assert.equal(f.events.some(e=>e.busy&&e.comments.length===1),true);
    f.workflow.cancel();gate.resolve({comments:[],complete:true});
    await assert.rejects(pending);
    assert.equal(f.workflow.view().canContinue,true);
    const restored=f.restore();assert.equal(restored.view().comments.length,1);assert.equal(restored.view().canContinue,true);
    restored.browser.open=async()=>{restored.browser.window={isDestroyed:()=>false,hide(){},webContents:{executeJavaScript:async()=>({comments:[row,{id:'second',text:'继续取得的评论'}],complete:true})}};};
    await restored.more(restored.record.id,10);assert.equal(restored.view().status,'complete');assert.equal(restored.view().comments.length,2);
  }finally{f.workflow.cancel();gate.resolve({comments:[]});await pending.catch(()=>{});}
});

test('未返回稳定用户ID时仍保留真实昵称与安全头像，不猜测主页',()=>{
  const {publicComment}=fixture();
  const row=publicComment('小红书',{id:'anonymous',name:'匿名显示名',avatar:'https://example.com/avatar.png',text:'公开评论',isReply:true,published:'昨天',region:'上海'});
  assert.equal(row.name,'匿名显示名');assert.equal(row.avatar,'https://example.com/avatar.png');
  assert.equal(row.userId,null);assert.equal(row.profileURL,null);assert.equal(row.isReply,true);assert.equal(row.region,'上海');
  assert.equal(publicComment('小红书',{text:'x',avatar:'file:///C:/secret'}).avatar,'');
});

// Small DOM fixture for the selectors used by the exported renderer; no network or Electron session.
function element(tag,attrs={},text='',children=[]){
  const node={tag,attrs,text,children,parent:null,clicked:0,getClientRects:()=>attrs.hidden?[]:[1],getAttribute:key=>attrs[key]||null,dataset:{commentId:attrs['data-comment-id']},id:attrs.id||'',click(){this.clicked++;}};
  for(const child of children)child.parent=node;
  Object.defineProperties(node,{innerText:{get:()=>[text,...children.map(c=>c.innerText)].filter(Boolean).join('\n')},href:{get:()=>new URL(attrs.href,work.url).href},src:{get:()=>attrs.src||''}});
  const simple=(n,s)=>{
    if(s==='*')return true;
    const name=s.match(/^[\w-]+/);if(name&&name[0]!==n.tag)return false;
    for(const match of s.matchAll(/([.#])([\w-]+)|\[([\w-]+)(?:([*]?=)"([^"]*)")?\]/g)){
      if(match[1]==='.'&&!String(n.attrs.class||'').split(' ').includes(match[2]))return false;
      if(match[1]==='#'&&n.id!==match[2])return false;
      if(match[3]&&(n.attrs[match[3]]===undefined||match[4]==='='&&n.attrs[match[3]]!==match[5]||match[4]==='*='&&!n.attrs[match[3]].includes(match[5])))return false;
    }return true;
  };
  const matches=(n,s)=>s.split(',').some(part=>{const tokens=part.trim().split(/\s+/);if(!simple(n,tokens.pop()))return false;let p=n.parent;while(tokens.length){const token=tokens.pop();while(p&&!simple(p,token))p=p.parent;if(!p)return false;p=p.parent;}return true;});
  node.closest=selector=>{for(let n=node;n;n=n.parent)if(matches(n,selector))return n;return null;};
  node.querySelectorAll=selector=>{const found=[];const visit=n=>{for(const c of n.children){if(matches(c,selector))found.push(c);visit(c);}};visit(node);return found;};
  node.querySelector=selector=>node.querySelectorAll(selector)[0]||null;
  return node;
}
function render(root,platform='小红书',expand=false){
  const document=element('document',{},'',[root]);document.title='所选作品';document.scrollingElement={scrollTop:0};
  const context={URL,location:{href:platform==='B站'?'https://www.bilibili.com/video/BV1234567890':work.url},document,CSS:{escape:v=>v},innerHeight:800,getComputedStyle:()=>({visibility:'visible'})};
  const fn=source.slice(source.indexOf('export function renderedComments'),source.indexOf('export function publicComment')).replace('export function','function');
  return vm.runInNewContext(fn+`;renderedComments(${JSON.stringify(platform)},${JSON.stringify(context.location.href)},${expand})`,context);
}
function xhsCard(id,text,{reply=false,user=true}={}){
  return element('div',{class:reply?'sub-comment':'comment-item','data-comment-id':id},'',[
    element('div',{class:'author'},'',user?[element('a',{href:'/user/profile/111111111111111111111111'},'真实昵称')]:[element('span',{class:'name'},'匿名昵称')]),
    element('div',{class:'content'},'',[element('span',{class:'note-text'},text)]),element('img',{src:'https://example.com/avatar.png'}),
  ]);
}

test('嵌套评论容器不重复读取主评论，真实回复和匿名昵称归属各自评论',()=>{
  const root=element('div',{class:'comments-container'},'',[element('div',{class:'parent-comment',id:'wrapper'},'',[xhsCard('root','主评论'),xhsCard('reply','真实回复',{reply:true,user:false})])]);
  const page=render(root);
  assert.deepEqual(Array.from(page.comments,c=>c.id),['root','reply']);
  assert.equal(page.comments[0].isReply,false);assert.equal(page.comments[1].isReply,true);
  assert.equal(page.comments[1].name,'匿名昵称');assert.equal(page.comments[1].userId,null);
});

test('实际小红书comment-item-sub回复以及date内location分别读取，不混入日期',()=>{
  const card=xhsCard('actual','实际回复');card.attrs.class='comment-item comment-item-sub';
  const date=element('div',{class:'date'},'',[element('span',{},'1天前'),element('span',{class:'location'},'福建')]);date.parent=card;card.children.push(date);
  const page=render(element('div',{class:'comments-container'},'',[card]));
  assert.equal(page.comments[0].isReply,true);assert.equal(page.comments[0].region,'福建');assert.equal(page.comments[0].published,'1天前');
});

test('评论正文中的没有更多了不冒充末页，真实末页仍识别，未展开回复不误报完整',()=>{
  const root=element('div',{class:'comments-container'},'',[xhsCard('c1','没有更多了')]);
  assert.equal(render(root).complete,false);
  root.children.push(element('div',{class:'end-container'},'THE END'));root.children.at(-1).parent=root;
  assert.equal(render(root).complete,true);
  const more=element('button',{},'展开 2 条回复');root.children.push(more);more.parent=root;
  assert.equal(render(root,'小红书',true).complete,false);assert.equal(more.clicked,1);
});

test('B站嵌套root-reply只读取实际主评论，独立sub-reply-item仍识别为回复',()=>{
  const card=(cls,id,text)=>element('div',{class:cls,'data-rpid':id},'',[
    element('div',{class:'reply-user-info'},'',[element('a',{class:'reply-user-name',href:'https://space.bilibili.com/123'},'用户')]),
    element('div',{class:'reply-content'},text),
  ]);
  const root=element('div',{class:'reply-list'},'',[element('div',{class:'root-reply',id:'wrapper'},'',[card('reply-item','1','主评论'),card('sub-reply-item','2','独立回复')])]);
  const page=render(root,'B站');assert.deepEqual(Array.from(page.comments,c=>c.id),['1','2']);
  assert.equal(page.comments[0].isReply,false);assert.equal(page.comments[1].isReply,true);
});

test('DOM批次超出上限的真实回复持久化缓冲，滚动后继续不丢失',async()=>{
  let reads=0;
  const f=fixture({read:async()=>({comments:++reads===1?[{id:'root',text:'主评论'},{id:'reply',text:'真实回复',isReply:true}]:[],complete:true})});
  await f.workflow.start('search','work',1);assert.equal(f.workflow.view().status,'limited');
  const restored=f.restore();restored.browser=f.workflow.browser;
  await restored.more(restored.record.id,10);
  assert.deepEqual(Array.from(restored.view().comments,c=>c.id),['root','reply']);assert.equal(restored.view().comments[1].isReply,true);
  assert.equal(restored.view().status,'complete');assert.equal(restored.view().pendingComments,undefined);
});

test('视频号批次实时落盘，取消后的晚响应不冒充完成，重启沿用原分页位置',async()=>{
  const gate=deferred();let calls=0;
  const item={id:'18446744073709551000',platform:'视频号',url:'https://channels.weixin.qq.com/web/pages/feed?oid=18446744073709551000'};
  const f=fixture({item,request:async()=>++calls===1?{commentInfo:[{commentId:'18446744073709551615',username:'one@finder',nickname:'用户一',content:'首批评论'}],lastBuffer:'next cursor'}:gate.promise});
  const pending=f.workflow.start('search','work');await tick();
  try{
    assert.equal(f.workflow.view().busy,true);assert.equal(f.events.some(e=>e.busy&&e.comments.length===1),true);
    const partial=f.restore();assert.equal(partial.view().comments[0].id,'18446744073709551615');assert.equal(partial.view().status,'interrupted');
    f.workflow.cancel();gate.resolve({commentInfo:[{commentId:'late',content:'晚到的响应'}],lastBuffer:''});await assert.rejects(pending);
    const restored=f.restore();restored.wechat={request:async(_url,params)=>{assert.equal(params.next_marker,'next%20cursor');return {commentInfo:[{commentId:'next',content:'继续读取'}],lastBuffer:''};}};
    await restored.more(restored.record.id);assert.deepEqual(Array.from(restored.view().comments,c=>c.id),['18446744073709551615','next']);assert.equal(restored.view().status,'complete');
    assert.equal(restored.view().branches,undefined);assert.equal(restored.view().accountId,undefined);
  }finally{f.workflow.cancel();gate.resolve({commentInfo:[],lastBuffer:''});await pending.catch(()=>{});}
});

test('视频号上限缓冲和根评论回复分支重启后去重继续，不损失大整数与真实回复',async()=>{
  const item={id:'18446744073709551000',platform:'视频号',url:'https://channels.weixin.qq.com/web/pages/feed?oid=18446744073709551000'};
  const root={commentId:'18446744073709551615',username:'one@finder',nickname:'用户一',content:'主评论',expandCommentCount:1,levelTwoComment:[{commentId:'18446744073709551614',nickname:'匿名回复者',content:'已展开回复',headUrl:'https://example.com/avatar.png'}]};
  const f=fixture({item,request:async(_url,params)=>({commentInfo:params.comment_id?[root.levelTwoComment[0],{commentId:'last',username:'two@finder',nickname:'用户二',content:'分支回复'}]:[root,{commentId:'another',username:'one@finder',nickname:'用户一',content:'另一条主评论'}],lastBuffer:''})});
  await f.workflow.start('search','work',1);assert.equal(f.workflow.view().status,'limited');
  const restored=f.restore();await restored.more(restored.record.id,10);
  assert.equal(restored.view().comments.length,4);assert.equal(restored.view().status,'complete');
  const anonymous=restored.view().comments.find(c=>c.id==='18446744073709551614');assert.equal(anonymous.isReply,true);assert.equal(anonymous.name,'匿名回复者');assert.equal(anonymous.userId,null);
  assert.equal(restored.view().comments.find(c=>c.id==='last').isReply,true);
  assert.equal(restored.view().users.find(u=>u.id==='one@finder').comments.length,2);
});

test('打开官方页面失败仍保留初始任务；DOM重复评论ID不重复计数',async()=>{
  const f=fixture();f.workflow.browser.open=async()=>{throw Error('测试加载失败');};
  await assert.rejects(f.workflow.start('search','work'),/加载失败/);
  const restored=f.restore();assert.equal(restored.record.id,f.workflow.record.id);assert.equal(restored.view().status,'interrupted');assert.equal(restored.view().canContinue,true);
  assert.equal(f.events.at(-1).busy,false);
  const dup=fixture({read:async()=>({comments:[{id:'one',text:'第一条'},{id:'one',text:'第一条'},{id:'two',text:'真实回复',isReply:true}],complete:true})});
  await dup.workflow.start('search','work');assert.equal(dup.workflow.view().comments.length,2);assert.equal(dup.workflow.view().comments[1].isReply,true);
});

test('已有评论时出现验证也需要暂停；折叠已加载回复的英文按钮不被点击',()=>{
  const root=element('div',{class:'comments-container'},'',[xhsCard('c1','已加载评论'),element('div',{class:'login-modal'},'官方登录')]);
  assert.equal(render(root).blocked,true);
  root.children.pop();const hide=element('button',{},'Hide replies');hide.parent=root;root.children.push(hide);
  render(root,'小红书',true);assert.equal(hide.clicked,0);
});

test('view暴露每次运行的startedAt和已持久化updatedAt，供采集计时使用',async()=>{
  const f=fixture();const before=Date.now();await f.workflow.start('search','work');
  const first=f.events.find(e=>e.busy);assert.ok(first.startedAt>=before);assert.ok(first.updatedAt>=first.startedAt);
  const view=f.workflow.view();assert.ok(view.updatedAt>=first.updatedAt);
  assert.equal(f.restore().view().startedAt,view.startedAt);assert.equal(f.restore().view().updatedAt,view.updatedAt);
  const nextStart=Date.now();await f.workflow.more(view.id);
  assert.ok(f.workflow.view().startedAt>=nextStart);assert.ok(f.workflow.view().updatedAt>=f.workflow.view().startedAt);
});
