import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentSearch} from '../electron/content-search.js';
import {mergeContent,xhsContent} from '../electron/content-data.js';
import {service,card,rawWechat,options,record,rendered,harness} from '../scripts/search-regression-harness.mjs';
import {douyinPageState} from '../electron/douyin-page.js';

for(const platform of ['B站','视频号'])test(`${platform}: 页51之后的日期匹配保留，游标不跳过有效页`,async()=>{
  let pages=0;
  const s=service({close(){}},async url=>{const page=platform==='B站'?Number(new URL(url,'https://api.bilibili.com').searchParams.get('page')):++pages;pages=page;
    const date=page<=50?'2026-10-13':'2026-10-01';
    return platform==='B站'?{page,numPages:52,result:Array.from({length:20},(_,i)=>({bvid:'BV'+String((page-1)*20+i).padStart(10,'0'),title:'合成作品',pubdate:new Date(date+'T12:00:00+08:00').getTime()/1000}))}:{fengshaVersion:1,objectList:Array.from({length:20},(_,i)=>rawWechat((page-1)*20+i+1,date)),objectContinueFlag:page<52?1:0,lastBuff:'p'+page};});
  let r=await s.start(platform,'审计',{...options,to:'2026-10-11',limit:50});
  assert.equal(pages,10);assert.equal(r.items.length,0);
  while(r.canContinue)r=await s.more(r.id);
  assert.equal(r.items.length,40);assert.equal(r.scanned,1040);assert.equal(r.status,'complete');assert.equal(s.record.next,null);
  assert.equal(s.item(r.id,r.items[39].id).item.id,r.items[39].id);
});

test('日期补查失败前缀不能饿死后续作品；重载后继续补查',async()=>{
  const attempted=[],cards=Array.from({length:4},(_,i)=>card('YouTube',i+1,null));
  class Browser{close(){}show(){}async read(_r,_s,_i,progress){progress({items:cards});return {items:cards,complete:true};}async detail(item){attempted.push(item.id);if(cards.slice(0,2).some(c=>c.id===item.id))throw Error('确切日期暂缺');return {...item,publishedAt:'2026-10-01'};}}
  const s=service(new Browser());let r=await s.start('YouTube','审计',{...options,limit:2});assert.equal(r.canContinue,true);
  const restored=new ContentSearch({accounts:s.accounts,creators:s.creators,userSearch:s.userSearch,store:s.store,browser:new Browser()});
  r=await restored.more(r.id);assert.equal(r.items.length,2);assert.deepEqual(attempted,cards.map(c=>c.id));assert.equal(r.status,'limited');
});

test('YouTube 250张保留DOM卡片必须完整读取，继续不能卡在前200',async()=>{
  const h=harness(()=>rendered('YouTube','','2026-10-01',250)),r=record('YouTube');r.options.limit=500;
  const first=await h.browser.read(r,new AbortController().signal,true);const next=await h.browser.read(r,new AbortController().signal);
  assert.equal(first.items.length,250);assert.equal(next.items.length,250);assert.equal(next.complete,false);
});

test('YouTube 周级相对日期须补查，不冒充确切发布时间',async()=>{
  for(const label of ['1 week ago','2 weeks ago','1周前','2星期前'])assert.equal(rendered('YouTube','',label).items[0].publishedAt,null);
  let details=0;const c=card('YouTube',1,null);
  class Browser{close(){}show(){}async read(){return {items:[c],complete:true};}async detail(){details++;return {...c,publishedAt:'2026-10-01'};}}
  const r=await service(new Browser()).start('YouTube','审计',{...options,from:'2026-10-06',to:'2026-10-06'});assert.equal(r.items.length,0);assert.equal(details,1);
});

for(const platform of ['抖音','小红书']){
  test(`${platform}: 文案含末页词不能结束；独立可见末页提示才结束`,()=>{
    assert.equal(rendered(platform,'合成作品：我没有更多了，明天再写').complete,false);
    assert.equal(rendered(platform,'没有更多了','2026-10-01',1,{footer:true}).complete,true);
    assert.equal(rendered(platform,'没有更多了','2026-10-01',1,{footer:true,hidden:true}).complete,false);
  });
  for(const failed of [false,true])test(`${platform}: 已有卡片仍呈现${failed?'网络':'接口'}错误并保留继续`,async()=>{
    const r=record(platform),h=harness(()=>({items:[card(platform)]})),signal=new AbortController().signal;
    await h.browser.open(h.searchURL(r),r,signal);await h.response(r,platform==='小红书'?{success:false,code:300012,msg:'登录已失效'}:{status_code:8,status_msg:'访问受限'},failed);
    const result=await h.browser.read(r,signal);assert.equal(result.items.length,1);assert.equal(result.complete,false);assert.equal(result.needsAction,true);assert.match(result.message,/失效|受限|失败|错误|断开/);
  });
  test(`${platform}: 停止保留滚动位置，首次继续即可取得新作品`,async()=>{
    const controller=new AbortController(),r=record(platform),h=harness(({scrolls})=>({items:[card(platform,scrolls+1)]}),n=>{if(n===12)controller.abort();});let first=[];
    await assert.rejects(h.browser.read(r,controller.signal,true,p=>{first=p.items;}));
    const next=await h.browser.read(r,new AbortController().signal);assert.ok(next.items.some(i=>!first.find(c=>c.id===i.id)));assert.equal(h.stats().loads,1);
  });
}

test('小红书：不完整API缓存须合并页面准确日期，而非误报登录',async()=>{
  const target=card('小红书',1,null),raw={id:target.id,note_card:{title:'合成笔记',desc:'完整正文',time:1790812800000}};
  const h=harness(()=>({note:raw})),open=h.browser.open.bind(h.browser);h.browser.open=async(...args)=>{const w=await open(...args);h.browser.items.set(target.id,target);return w;};
  const result=await h.browser.detail(target,null,new AbortController().signal,{metadataOnly:true});assert.equal(result.publishedAt,xhsContent(raw).publishedAt);assert.equal(h.stats().waits,0);
});

test('准确API日期优先于推测月日，准确详情又能替换推测日期',()=>{
  const old=card('小红书'),dom=rendered('小红书','','10-01').items[0];old.publishedAt='2025-10-01';
  const h=mergeContent(old,{...old,...dom});assert.equal(h.publishedAt,'2025-10-01');
  const inferred={...old,publishedAt:'2026-10-01',publishedAtSource:'estimated'};
  assert.equal(mergeContent(inferred,{...old,publishedAtSource:'exact'}).publishedAt,'2025-10-01');
});

test('取消后晚到列表不写入，账号切换拒绝继续',async()=>{
  let release,started;const gate=new Promise(r=>release=r),pending=new Promise(r=>started=r);
  const s=service({close(){},async read(_r,_signal,_initial,progress){progress({items:[card('抖音',1)]});started();await gate;progress({items:[card('抖音',2)]});return {items:[card('抖音',2)],complete:true};}});
  const running=s.start('抖音','审计',options);await pending;s.cancel();release();await assert.rejects(running);assert.equal(s.view().items.length,1);assert.equal(s.view().status,'interrupted');
  s.accounts.active=()=>({id:'other'});await assert.rejects(s.more(s.record.id),/账号已切换/);
});

test('补查保持单并发和每轮上限；网络列表末页不重复请求',async()=>{
  let reads=0,active=0,maxActive=0,details=0;
  const cards=Array.from({length:6},(_,i)=>card('YouTube',i+1,null));
  class Browser{close(){}async read(_r,_s,_i,progress){reads++;progress({items:cards});return {items:cards,complete:true};}async detail(item){active++;maxActive=Math.max(maxActive,active);details++;await Promise.resolve();active--;throw Error('日期暂缺');}}
  const s=service(new Browser());let r=await s.start('YouTube','审计',{...options,limit:2});assert.equal(details,2);
  r=await s.more(r.id);assert.equal(details,4);r=await s.more(r.id);assert.equal(details,6);
  assert.equal(reads,1);assert.equal(maxActive,1);assert.equal(r.canContinue,true);
});

test('包括未知日期时不做无用补查，保留首批快速返回',async()=>{
  let details=0;
  class Browser{close(){}async read(){return {items:[card('YouTube',1,null)],complete:true};}async detail(){details++;throw Error('不该调用');}}
  const r=await service(new Browser()).start('YouTube','审计',{...options,includeUnknown:true});assert.equal(details,0);assert.equal(r.items.length,1);assert.equal(r.status,'complete');
});

test('详情取消的晚到响应不改日期，已有结果仍可继续',async()=>{
  let release,started;const gate=new Promise(r=>release=r),pending=new Promise(r=>started=r),c=card('YouTube',1,null);
  class Browser{close(){}async read(){return {items:[c],complete:true};}async detail(){started();await gate;return {...c,publishedAt:'2026-10-01'};}}
  const s=service(new Browser()),running=s.start('YouTube','审计',options);await pending;s.cancel();release();await assert.rejects(running);assert.equal(s.record.all[0].publishedAt,null);assert.equal(s.view().status,'interrupted');assert.equal(s.view().canContinue,true);
});

test('窗口重建按原滚动次数逐批恢复；每轮仍限定12次快照',async()=>{
  const r=record('抖音'),h=harness(({scrolls})=>({items:[card('抖音',scrolls+1)]}));
  await h.browser.read(r,new AbortController().signal,true);await h.browser.read(r,new AbortController().signal);const target=r.browserScroll;assert.equal(target,24);h.browser.close();
  const restored=await h.browser.read(r,new AbortController().signal);assert.match(restored.message,/恢复/);assert.equal(r.browserScroll,target);assert.equal(h.stats().scrolls,12);
  await h.browser.read(r,new AbortController().signal);const next=await h.browser.read(r,new AbortController().signal);assert.ok(next.items.some(i=>i.id===card('抖音',25).id));assert.equal(h.stats().loads,2);
});

test('停止关闭应用时销毁自建搜索窗口；普通停止仅隐藏保留',async()=>{
  const h=harness(()=>({items:[card('抖音')]})),s=service(h.browser);await s.start('抖音','审计',options);const w=h.browser.window;s.cancel();assert.equal(w.isDestroyed(),false);assert.ok(h.stats().hidden);await s.close();assert.equal(w.isDestroyed(),true);
});

test('API成功末页依然生效；明确错误覆盖末页并保留部分结果',async()=>{
  const r=record('小红书'),h=harness(()=>({items:[card('小红书')]})),signal=new AbortController().signal;
  await h.browser.open(h.searchURL(r),r,signal);await h.response(r,{success:true,data:{items:[],has_more:false}});
  assert.equal((await h.browser.read(r,signal)).complete,true);
  await h.response(r,{success:false,code:1,msg:'登录失效'});const failed=await h.browser.read(r,signal);assert.equal(failed.complete,false);assert.equal(failed.needsAction,true);assert.equal(failed.items.length,1);
});

test('登录验证码和设备超限仍需官方窗口处理，不能标记完成',async()=>{
  const r=record('小红书');r.accountId='synthetic-account';const h=harness(()=>({items:[],blocked:true,reason:'device-limit',message:'设备登录超限'}));let expired=0;
  h.browser.accounts={getSession:()=>undefined,markExpired:()=>expired++};const result=await h.browser.read(r,new AbortController().signal,true);assert.equal(result.needsAction,true);assert.equal(result.complete,false);assert.equal(expired,1);assert.equal(h.stats().shown,1);
});

test('停止发生在快照等待期间，迟到卡片不能写入浏览器缓存',async()=>{
  let release,started;const gate=new Promise(r=>release=r),pending=new Promise(r=>started=r),controller=new AbortController();const h=harness(async()=>{started();await gate;return {items:[card('抖音')]};});
  const running=h.browser.read(record('抖音'),controller.signal,true);await pending;controller.abort();release();await assert.rejects(running);assert.equal(h.browser.items.size,0);
});

test('取消前发出的旧API响应，继续后仍必须被忽略',async()=>{
  const r=record('小红书'),h=harness(()=>({items:[card('小红书')]})),controller=new AbortController();await h.browser.open(h.searchURL(r),r,controller.signal);
  const w=h.browser.window,listener=w.webContents.debugger.listeners('message')[0];
  await listener({},'Network.requestWillBeSent',{requestId:'old',request:{url:'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes',postData:JSON.stringify({keyword:r.keyword})}});controller.abort();
  await h.browser.read(r,new AbortController().signal);
  w.body={success:true,data:{items:[{id:card('小红书',2).id,note_card:{title:'迟到卡片'}}],has_more:false}};
  await listener({},'Network.loadingFinished',{requestId:'old',encodedDataLength:100});assert.equal(h.browser.items.size,1);assert.equal(h.browser.complete,false);
});

test('打开官方页面尚未完成时停止，不能等30秒超时', {timeout:1000},async()=>{
  const h=harness(()=>({items:[]})),r=record('抖音');await h.browser.open('https://www.douyin.com',r,new AbortController().signal);const w=h.browser.window;
  let started;const pending=new Promise(resolve=>started=resolve);w.loadURL=()=>{started();return new Promise(()=>{});};
  const controller=new AbortController(),opening=h.browser.open('https://www.douyin.com',r,controller.signal,{reuse:true});await pending;controller.abort();await assert.rejects(opening,/已停止/);assert.equal(w.isDestroyed(),true);
});

test('搜索服务保留接口失败的原始提示与部分卡片，而非普通成功消息',async()=>{
  const r=record('抖音');let failed=false,h;h=harness(async()=>{if(!failed){failed=true;await h.response(r,{status_code:8,status_msg:'访问受限'});}return {items:[card('抖音')]};});
  const s=service(h.browser),result=await s.start('抖音',r.keyword,options);assert.equal(result.status,'needs-action');assert.match(result.message,/访问受限/);assert.equal(result.items.length,1);assert.equal(result.canContinue,true);
});

test('真实导航helper处理暂时连接失败，错误文档dom-ready不能冒充成功',async()=>{
  const h=harness(()=>({items:[card('抖音')]}),()=>{},{loadErrors:['net::ERR_CONNECTION_CLOSED']});
  const result=await h.browser.read(record('抖音'),new AbortController().signal,true);
  assert.equal(h.stats().loads,2,'必须实际重试导航，不能用错误文档的dom-ready放行');assert.equal(result.items.length,1);assert.equal(result.needsAction,false);
});

test('真实导航helper重复连接失败仍报错并关闭失败窗口，不吞成普通成功',async()=>{
  let snapshots=0;const h=harness(()=>{snapshots++;return {items:[]};},()=>{},{loadErrors:['net::ERR_CONNECTION_CLOSED','net::ERR_CONNECTION_CLOSED']});
  await assert.rejects(h.browser.read(record('抖音'),new AbortController().signal,true),/ERR_CONNECTION_CLOSED/);assert.equal(h.stats().loads,2);assert.equal(snapshots,0);assert.equal(h.browser.window,null);
});

test('真实抖音状态helper识别官方服务错误，仅重试一次且不误读业务快照',async()=>{
  let snapshots=0;const h=harness(()=>{snapshots++;return {items:[card('抖音')]};},()=>{},{serviceMessage:'服务器出现问题'});
  await assert.rejects(h.browser.read(record('抖音'),new AbortController().signal,true),/本次已自动重连/);assert.equal(h.stats().loads,2);assert.equal(snapshots,0,'DOM状态探针不能被伪装成业务快照读取');
});

test('真实抖音状态helper区分验证码与普通登录字样，并读取真实导航就绪状态',async()=>{
  const h=harness(()=>{throw Error('状态探针不得调用业务快照');}),r=record('抖音'),signal=new AbortController().signal;
  const window=await h.browser.open(h.searchURL(r),r,signal);
  const ready=await window.webContents.executeJavaScript('({url:location.href,ready:document.readyState,content:!!document.body&&(document.body.children.length>0||!!document.body.innerText.trim())})');assert.equal(ready.url,h.searchURL(r));assert.equal(ready.ready,'complete');assert.equal(ready.content,true);
  window.page.title='验证码中间页';let state=await window.webContents.executeJavaScript(`(${douyinPageState.toString()})()`);assert.equal(state.kind,'verification');assert.equal(state.retryable,false);
  window.page.title='合成官方页面';window.page.text='登录';state=await window.webContents.executeJavaScript(`(${douyinPageState.toString()})()`);assert.equal(state.kind,'unconfirmed','页面普通登录字样不能冒充登录拦截');
  window.page.loginText='扫码登录';state=await window.webContents.executeJavaScript(`(${douyinPageState.toString()})()`);assert.equal(state.kind,'login');assert.equal(state.retryable,false);
});

for(const external of [false,true])test(`${external?'Chrome':'原生'}搜索页面登录标识只更新对应会话，不能改写旧native账号`,async()=>{
  let verified=0,expired=0;const h=harness(()=>({items:[card('小红书')],loggedIn:true})),r=record('小红书');r.accountId='native-account';h.browser.accounts={getSession:()=>undefined,markVerified:()=>verified++,markExpired:()=>expired++};
  await h.browser.open(h.searchURL(r),r,new AbortController().signal);if(external)h.browser.window.externalTab={};await h.browser.read(r,new AbortController().signal);assert.equal(verified,external?0:1);assert.equal(expired,0);
});

test('Chrome搜索和详情的设备超限保留本次异常，但不能使旧native下载会话过期',async()=>{
  let expired=0;const h=harness(()=>({items:[],blocked:true,reason:'device-limit',message:'设备登录超限'})),r=record('小红书');r.accountId='native-account';h.browser.accounts={getSession:()=>undefined,markExpired:()=>expired++};
  const open=h.browser.open.bind(h.browser);h.browser.open=async(...args)=>{const w=await open(...args);w.externalTab={};return w;};
  const result=await h.browser.read(r,new AbortController().signal,true);assert.equal(result.needsAction,true);assert.match(result.message,/设备登录超限/);assert.equal(expired,0);
  await assert.rejects(h.browser.detail(card('小红书'),'native-account',new AbortController().signal,{metadataOnly:true}),/设备登录超限/);assert.equal(expired,0);
});
