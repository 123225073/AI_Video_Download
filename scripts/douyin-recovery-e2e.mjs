// Real Electron navigation regression; all HTTPS responses are isolated fixtures.
// It must detect the previous blank-document early-ready race and exercise recovery.
import {_electron as electron} from 'playwright';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {reloadTestRenderer} from './test-renderer.mjs';
const require=createRequire(import.meta.url),root=path.resolve('.'),output=path.resolve('output/repair-089/douyin/recovery-'+Date.now());fs.mkdirSync(output,{recursive:true});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
let app;const result={output,fixture:true,ok:false};
try{
 app=await electron.launch({executablePath:require('electron'),args:[root],env,timeout:45000});await reloadTestRenderer(app);await(await app.firstWindow()).getByRole('heading',{name:'链接下载',exact:true}).waitFor();
 result.checks=await app.evaluate(async({session})=>{
  const b=globalThis.fengshaTest.contentSearch.browser,originalAccounts=b.accounts;
  const html='<meta charset="utf-8"><ul data-e2e="search-video-list"><li><a href="https://www.douyin.com/video/1234567890123456789"><span data-e2e="video-desc">真实导航恢复后返回的作品</span></a><span data-e2e="video-author">原作者</span></li></ul>';
  const checks=[];
  try{for(const mode of ['first-failure','persistent-failure']){
   const s=session.fromPartition('douyin-navigation-recovery-'+mode);let requests=0;
   s.protocol.handle('https',request=>{if(request.url.includes('/search/')){requests++;if(mode==='persistent-failure'||requests===1)return Response.error();}return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});});
   b.accounts={getSession:()=>s};b.hidden=true;
   const record={id:'douyin-'+mode,platform:'抖音',keyword:'导航恢复',accountId:'fixture',options:{from:'2026-01-01',to:'2026-12-31',limit:1,includeUnknown:true}};
   const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),15000);
   const row={mode};try{const r=await b.read(record,ctrl.signal,true);row.count=r.items.length;row.message=r.message;row.needsAction=r.needsAction;}catch(e){row.error=e.message;}
   clearTimeout(timer);row.requests=requests;row.windowRetained=!!b.window&&!b.window.isDestroyed();checks.push(row);b.close();s.protocol.unhandle('https');
  }}finally{b.accounts=originalAccounts;b.close();}
  return checks;
 });
 const recovered=result.checks.find(c=>c.mode==='first-failure'),failed=result.checks.find(c=>c.mode==='persistent-failure');
 assert.equal(recovered.count,1,'One failed official navigation must automatically reconnect and return the selected search result.');
 assert.ok(recovered.requests>=2&&recovered.requests<=3,'Recovery must retry the original page within a bounded budget.');
 assert.ok(failed.error&&!/离开本次作品搜索/.test(failed.error),'A Chromium error document must retain the navigation failure, not be mistaken for leaving search.');
 assert.equal(failed.windowRetained,false,'Persistent failure must not leave a blank official window open.');
 assert.ok(failed.requests<=3,'Persistent failures must not retry forever.');
 result.ok=true;
}catch(e){result.error=e.stack;process.exitCode=1;}finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
