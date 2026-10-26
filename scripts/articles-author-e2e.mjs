import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {reloadTestRenderer} from './test-renderer.mjs';
const output=path.resolve('output/articles-author-e2e-'+Date.now());fs.mkdirSync(output,{recursive:true});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const result={output,kind:'isolated official-origin fixtures; not real authorized account-list acceptance'},errors=[];let app;
try{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('.')],env,timeout:45000});await reloadTestRenderer(app);const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await app.evaluate(({session,nativeImage})=>{
  globalThis.authorFixture={calls:[],mode:'ok'};const t=globalThis.authorFixture,biz='MzkwNjQ0MTIzNA==',png=nativeImage.createFromBitmap(Buffer.alloc(16,255),{width:2,height:2}).toPNG();
  session.defaultSession.protocol.handle('https',()=>new Response(png,{headers:{'content-type':'image/png'}}));
  session.fromPartition('persist:fengsha-articles').protocol.handle('https',request=>{
   const u=new URL(request.url);t.calls.push({host:u.hostname,path:u.pathname,begin:u.searchParams.get('begin'),fakeid:u.searchParams.get('fakeid')});
   if(u.hostname.endsWith('qpic.cn')||u.hostname.endsWith('qlogo.cn'))return new Response(png,{headers:{'content-type':'image/png'}});
   let body='<p>请扫码登录微信公众平台</p>';
   if(u.pathname==='/cgi-bin/home')body='<p>已连接公众平台</p>';
   else if(u.pathname==='/cgi-bin/appmsgpublish'){
    const begin=Number(u.searchParams.get('begin')),count=Number(u.searchParams.get('count'));
    const data=t.mode==='expired'?{base_resp:{ret:200003}}:t.mode==='limited'?{base_resp:{ret:200013}}:{base_resp:{ret:0},app_msg_cnt:8,app_msg_list:Array.from({length:Math.min(count,8-begin)},(_,i)=>({title:'作者文章 '+(begin+i+1),link:'https://mp.weixin.qq.com/s?'+new URLSearchParams({__biz:biz,mid:String(begin+i+1),idx:'1'}),cover:'https://mmbiz.qpic.cn/cover.png',create_time:1791324000}))};
    return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
   }else if(u.pathname.startsWith('/s')){
    const n=u.searchParams.get('mid')||'1';body=`<script>window.biz='${biz}';window.mid='${n}';window.idx='1';window.user_name='gh_fixture';window.hd_head_img='https://wx.qlogo.cn/head';window.profile_signature='编程文章';</script><h1 id="activity-name">作者文章 ${n}</h1><span id="js_name">编程进阶录</span><span id="publish_time">2026年10月7日</span><div id="js_content"><p>本文真实正文样本。</p><img data-src="https://mmbiz.qpic.cn/cover.png"></div>`;
   }
   return new Response('<meta charset="utf-8">'+body,{headers:{'content-type':'text/html; charset=utf-8'}});
  });
  const s=globalThis.fengshaTest.store;s.put('media','protected-video',{id:'protected-video',title:'视频资料',filePath:'fixture.mp4'});s.flush();
 });
 const baseline=await app.evaluate(()=>JSON.stringify(globalThis.fengshaTest.store.list('media')));
 await page.getByRole('button',{name:'文章中心',exact:true}).click();await page.getByRole('button',{name:'作者批量',exact:true}).click();
 await page.getByLabel('文章读取上限').fill('3');await page.getByLabel('文章采集输入').fill('https://mp.weixin.qq.com/s/fixture');
 await page.getByLabel('已识别公众号').waitFor({timeout:20000});assert.match(await page.getByLabel('已识别公众号').innerText(),/编程进阶录/);
 assert.equal(await app.evaluate(()=>globalThis.authorFixture.calls.some(c=>c.path==='/cgi-bin/appmsgpublish')),false);assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.view().library.length),0);result.autoIdentifyWithoutFetchingOrSaving=true;
 await page.getByRole('button',{name:'更新获取',exact:true}).click();await page.getByRole('button',{name:'连接微信公众平台',exact:true}).waitFor();
 assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.view().discovery.items.length),0);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);assert.equal(await page.getByRole('button',{name:'打开采集窗口',exact:true}).count(),0);result.missingLoginNoPopupNoFakeSeed=true;
 await page.getByRole('button',{name:'连接微信公众平台',exact:true}).click();
 assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.reader.portalWindow.isVisible()),true);
 await app.evaluate(async()=>{const w=globalThis.fengshaTest.articles.reader.portalWindow;for(let i=0;i<100&&w.webContents.isLoadingMainFrame();i++)await new Promise(r=>setTimeout(r,50));await w.loadURL('https://mp.weixin.qq.com/cgi-bin/home?token=123456');});assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.reader.portalWindow.isVisible()),false);
 await page.getByRole('button',{name:'更新获取',exact:true}).click();await page.getByRole('button',{name:'保存所选 (3)',exact:true}).waitFor({timeout:20000});
 let record=await app.evaluate(()=>globalThis.fengshaTest.articles.view().discovery);assert.equal(record.items.length,3);assert.equal(record.offset,3);assert.equal(record.total,8);assert.equal(record.source,'wechat-account');assert.equal(record.complete,false);
 assert.equal(await app.evaluate(()=>globalThis.authorFixture.calls.some(c=>c.host==='weixin.sogou.com')),false);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);result.authorScopedBackgroundResults=true;
 await page.getByRole('button',{name:'继续读取列表',exact:true}).click();await page.getByRole('heading',{name:/本次文章清单 \(6\)/}).waitFor({timeout:20000});result.serverOffsetPagination=true;
 await page.getByRole('button',{name:'保存文章',exact:true}).first().click();await page.getByText('已保存',{exact:true}).waitFor({timeout:20000});assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.view().library.length),1);result.saveAfterPreview=true;
 await app.evaluate(()=>{globalThis.authorFixture.mode='expired';});await page.getByRole('button',{name:'继续读取列表',exact:true}).click();await page.getByRole('button',{name:'连接微信公众平台',exact:true}).waitFor();
 record=await app.evaluate(()=>globalThis.fengshaTest.articles.view().discovery);assert.equal(record.items.length,6);assert.equal(record.offset,6);assert.equal(record.action,'wechat-login');assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.reader.portalWindow),null);result.expiryPreservesListAndRequestsReconnect=true;
 await page.getByRole('button',{name:'连接微信公众平台',exact:true}).click();await app.evaluate(async()=>{globalThis.authorFixture.mode='ok';const w=globalThis.fengshaTest.articles.reader.portalWindow;for(let i=0;i<100&&w.webContents.isLoadingMainFrame();i++)await new Promise(r=>setTimeout(r,50));await w.loadURL('https://mp.weixin.qq.com/cgi-bin/home?token=654321');});
 await page.getByRole('button',{name:'更新获取',exact:true}).click();await page.getByRole('button',{name:'保存所选 (3)',exact:true}).waitFor();
 await page.getByRole('button',{name:'继续读取列表',exact:true}).click();await page.getByRole('heading',{name:/本次文章清单 \(6\)/}).waitFor();await page.getByRole('button',{name:'继续读取列表',exact:true}).click();await page.getByRole('heading',{name:/本次文章清单 \(8\)/}).waitFor();await page.waitForFunction(()=>document.querySelector('.article-hint[role=status]')?.textContent.includes('列表末尾'));
 record=await app.evaluate(()=>globalThis.fengshaTest.articles.view().discovery);assert.equal(record.complete,true);assert.equal(new Set(record.items.map(i=>i.id)).size,8);result.reconnectAndCompleteWithoutDuplicates=true;
 const partial=await app.evaluate(async()=>{const a=globalThis.fengshaTest.articles,r=a.reader,original=r.accountRequest.bind(r);let calls=0;r.accountRequest=async(...args)=>{if(++calls===2)throw Error('微信限制了读取频率');return original(...args);};try{await a.start({...a.record.request,limit:8});return a.view().discovery;}finally{r.accountRequest=original;}});assert.equal(partial.items.length,5);assert.equal(partial.offset,5);assert.equal(partial.complete,false);assert.equal(partial.action,'retry');result.partialBatchFailurePreservesCursorAndResults=true;
 assert.equal(JSON.stringify(record).includes('123456'),false);assert.equal(JSON.stringify(record).includes('654321'),false);result.noSessionTokensInRendererRecord=true;
 const grouped=await app.evaluate(async()=>{const a=globalThis.fengshaTest.articles,r=a.reader,original=r.accountRequest.bind(r);let calls=0;r.accountRequest=async(_endpoint,params)=>{calls++;const nums=Number(params.begin)===0?[101,102]:[103];return {base_resp:{ret:0},publish_page:JSON.stringify({total_count:2,publish_list:[{publish_info:JSON.stringify({appmsgex:nums.map(n=>({title:'多篇推送 '+n,link:'https://mp.weixin.qq.com/s?'+new URLSearchParams({__biz:'MzkwNjQ0MTIzNA==',mid:String(n),idx:'1'})}))})}]})};};try{await a.start({...a.record.request,limit:1});const first={count:a.record.items.length,offset:a.record.offset,overflow:a.record.overflow.length};await a.more();const second={count:a.record.items.length,calls,offset:a.record.offset};await a.more();return {first,second,last:{count:a.record.items.length,calls,complete:a.record.complete,offset:a.record.offset,totalUnit:a.record.totalUnit}};}finally{r.accountRequest=original;}});assert.deepEqual(grouped,{first:{count:1,offset:1,overflow:1},second:{count:2,calls:1,offset:1},last:{count:3,calls:2,complete:true,offset:2,totalUnit:'publish'}});result.multiArticlePublicationOverflowPreserved=true;
 assert.equal(await app.evaluate(()=>JSON.stringify(globalThis.fengshaTest.store.list('media'))),baseline);result.videoRecordsUnchanged=true;
 const guarded=await app.evaluate(async()=>{const r=globalThis.fengshaTest.articles.reader,before=globalThis.authorFixture.calls.length;r.lastAccountRateAt=Date.now();try{await r.accountRequest('/cgi-bin/appmsgpublish',{},new AbortController().signal);return false;}catch(e){return /尚未重新/.test(e.message)&&globalThis.authorFixture.calls.length===before;}finally{r.lastAccountRateAt=0;}});assert.equal(guarded,true);result.cooldownBlocksImmediateRepeatRequests=true;
 const cancelled=await app.evaluate(async()=>{const a=globalThis.fengshaTest.articles,r=a.reader,original=r.accountRequest.bind(r);r.accountRequest=async()=>({base_resp:{ret:0},app_msg_cnt:10,app_msg_list:Array.from({length:5},(_,i)=>({title:'中断前文章'+i,link:'https://mp.weixin.qq.com/s?'+new URLSearchParams({__biz:'MzkwNjQ0MTIzNA==',mid:String(201+i),idx:'1'})}))});try{const pending=a.start({...a.record.request,limit:10});for(let i=0;i<100&&a.record.items.length<5;i++)await new Promise(r=>setTimeout(r,20));a.cancel();await pending;return {count:a.record.items.length,offset:a.record.offset,status:a.record.status};}finally{r.accountRequest=original;}});assert.deepEqual(cancelled,{count:5,offset:5,status:'interrupted'});result.cancelPreservesAlreadyFetchedPage=true;
 const duplicate=await app.evaluate(async()=>{const a=globalThis.fengshaTest.articles,r=a.reader,original=r.accountRequest.bind(r);r.accountRequest=async()=>({base_resp:{ret:0},app_msg_cnt:10,app_msg_list:Array.from({length:5},(_,i)=>({title:'重复分页样本'+i,link:'https://mp.weixin.qq.com/s?'+new URLSearchParams({__biz:'MzkwNjQ0MTIzNA==',mid:String(301+i),idx:'1'})}))});try{await a.start({...a.record.request,limit:10});return {count:a.record.items.length,offset:a.record.offset,complete:a.record.complete,message:a.record.message};}finally{r.accountRequest=original;}});assert.equal(duplicate.count,5);assert.equal(duplicate.offset,5);assert.equal(duplicate.complete,false);assert.match(duplicate.message,/重复/);result.duplicateWithinBatchDoesNotAdvanceCursor=true;
 assert.deepEqual(errors,[]);result.ok=true;
}finally{if(app)await app.close();result.errors=errors;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
