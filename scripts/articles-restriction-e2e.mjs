import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {reloadTestRenderer} from './test-renderer.mjs';
const output=path.resolve('output/articles-restriction-e2e-'+Date.now());fs.mkdirSync(output,{recursive:true});
const executablePath=createRequire(import.meta.url)('electron'),applicationPath=path.resolve(process.env.FENGSHA_E2E_APP||'.'),input='https://mp.weixin.qq.com/s/restriction-fixture';
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const result={kind:'isolated official-origin responses; no live platform restriction is bypassed',errors:[]};let app,page;
async function launch(){
 app=await electron.launch({executablePath,args:[applicationPath,'--agent-data-dir',path.join(output,'profile')],env,timeout:45000});
 const isolation=await app.evaluate(({app})=>({directory:app.getPath('userData'),testing:!!globalThis.fengshaTest}));assert.equal(isolation.directory,path.join(output,'profile'));assert.equal(isolation.testing,true);
 await reloadTestRenderer(app);page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));
 await app.evaluate(({session,nativeImage})=>{
  const png=nativeImage.createFromBitmap(Buffer.alloc(16,255),{width:2,height:2}).toPNG();
  globalThis.limitFixture={calls:0,mode:'limited'};
  session.defaultSession.protocol.handle('https',()=>new Response(png,{headers:{'content-type':'image/png'}}));
  session.fromPartition('persist:fengsha-articles').protocol.handle('https',request=>{
   const u=new URL(request.url),t=globalThis.limitFixture;
   if(u.pathname==='/cgi-bin/appmsgpublish'){
    t.calls++;if(t.mode==='429')return new Response('Too many requests',{status:429,headers:{'retry-after':'900'}});
    const response=t.mode==='limited'?{base_resp:{ret:200013,err_msg:'freq control'}}:{base_resp:{ret:0},app_msg_cnt:1,app_msg_list:[{title:'原账号文章',link:'https://mp.weixin.qq.com/s?'+new URLSearchParams({__biz:'MzkwNjQ0MTIzNA==',mid:'1',idx:'1'}),create_time:1791324000}]};
    return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
   }
   const body=u.pathname.startsWith('/s')?`<script>window.biz='MzkwNjQ0MTIzNA==';window.user_name='gh_fixture';</script><h1 id="activity-name">文章原文</h1><span id="js_name">编程进阶录</span><div id="js_content"><p>正文</p></div>`:'<p>微信公众平台会话样本</p>';
   return new Response('<meta charset="utf-8">'+body,{headers:{'content-type':'text/html; charset=utf-8'}});
  });
 });
}
async function authorizedFixture(){await app.evaluate(async()=>{const w=await globalThis.fengshaTest.articles.reader.portal(new AbortController().signal);await w.loadURL('https://mp.weixin.qq.com/cgi-bin/home?token=123456');});}
try{
 await launch();await page.getByRole('button',{name:'文章中心',exact:true}).click();await page.getByRole('button',{name:'作者批量',exact:true}).click();await page.getByLabel('文章采集输入').fill(input);await page.getByLabel('已识别公众号').waitFor();await authorizedFixture();
 await page.getByRole('button',{name:'更新获取',exact:true}).click();await page.getByRole('dialog',{name:'公众号文章列表访问受限'}).waitFor();
 assert.equal(await app.evaluate(()=>globalThis.limitFixture.calls),1);assert.equal(await page.getByRole('button',{name:'更新获取',exact:true}).isDisabled(),true);
 const original=await app.evaluate(()=>globalThis.fengshaTest.articles.view().discovery);assert.equal(original.items.length,0);assert.equal(original.action,'wechat-rate-limit');
 await page.getByRole('button',{name:'稍后处理，保留清单',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);await page.getByRole('button',{name:'查看处理指引',exact:true}).click();await page.getByRole('button',{name:'使用文章链接采集',exact:true}).click();
 assert.equal(await page.getByLabel('文章采集输入').inputValue(),input);assert.equal(await app.evaluate(()=>globalThis.limitFixture.calls),1);assert.equal((await app.evaluate(()=>globalThis.fengshaTest.articles.view().discovery)).id,original.id);result.immediateStopAndActionableFallback=true;
 await app.close();app=null;await launch();await page.getByRole('button',{name:'文章中心',exact:true}).click();await page.getByRole('dialog',{name:'公众号文章列表访问受限'}).waitFor();assert.equal(await page.getByLabel('文章采集输入').inputValue(),input);assert.equal(await app.evaluate(()=>globalThis.limitFixture.calls),0);result.restartPreservesRestrictionWithoutRequests=true;
 await page.getByRole('button',{name:'稍后处理，保留清单',exact:true}).click();
 await app.evaluate(()=>{const a=globalThis.fengshaTest.articles;a.reader.accountAccess.clock=()=>Date.now()+20*60*1000;a.record.restriction.retryAt=Date.now()-1000;a.publish();globalThis.limitFixture.mode='ok';});
 await authorizedFixture();if(await page.getByRole('dialog',{name:'公众号文章列表访问受限'}).isVisible())await page.getByRole('button',{name:'稍后处理，保留清单',exact:true}).click();await page.getByRole('button',{name:'继续读取列表',exact:true}).click();await page.getByRole('heading',{name:'本次文章清单 (1)',exact:true}).waitFor();
 const recovered=await app.evaluate(()=>globalThis.fengshaTest.articles.view().discovery);assert.equal(recovered.id,original.id);assert.equal(recovered.action,null);assert.equal(recovered.items[0].author,'编程进阶录');assert.equal(await app.evaluate(()=>globalThis.limitFixture.calls),1);result.explicitResumeUsesOriginalRecord=true;
 await app.evaluate(()=>{const a=globalThis.fengshaTest.articles;a.reader.accountAccess.clock=Date.now;globalThis.limitFixture.mode='429';});
 await page.getByRole('button',{name:'更新获取',exact:true}).click();await page.getByRole('dialog',{name:'公众号文章列表访问受限'}).waitFor();
 assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.record.restriction.platformCode),'HTTP 429');assert.equal(await app.evaluate(()=>globalThis.fengshaTest.articles.reader.portalWindow.isDestroyed()),false);result.nonJson429KeepsLoginAndBlocksRequests=true;
 assert.deepEqual(result.errors,[]);await page.screenshot({path:path.join(output,'restricted-guidance.png')});result.ok=true;
}catch(e){result.error=e.stack;process.exitCode=1;}finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output}));}
