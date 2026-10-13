import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';
import {build} from 'vite';
import {reloadTestRenderer} from './test-renderer.mjs';

const root=path.resolve('.'),output=path.join(root,'output/repair-071/review-main',`final-${Date.now()}`),renderer=path.join(output,'renderer');
fs.mkdirSync(renderer,{recursive:true});
const result={output,realReact:true,realElectronIPC:true,syntheticBackend:true,externalNetworkForbidden:true,checks:[],errors:[],hashes:{}};
for(const file of ['src/ContentPage.jsx','electron/clash-route.js','electron/content-studio.js'])result.hashes[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
await build({root,logLevel:'warn',build:{outDir:path.join(renderer,'dist'),emptyOutDir:false}});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_VISIBLE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
let app,page;
const button=name=>page.getByRole('button',{name,exact:true});
const body=()=>page.getByLabel('克隆稿正文',{exact:true});
async function load(){const previous=process.cwd();try{process.chdir(renderer);await reloadTestRenderer(app);}finally{process.chdir(previous);}page=await app.firstWindow();await page.bringToFront();await button('作品搜索与二创').click();}
async function setup({status='draft',delayLast=false}={}){
  await app.evaluate(({ipcMain},args)=>{
    const t=globalThis.fengshaTest;t.contentStudio.job=null;t.contentSearch.record=null;
    for(const id of ['A','B'])t.store.put('content-draft',id,{id,source:{id:'source-'+id,title:'source-'+id,platform:'小红书',type:'image'},original:{title:'original-'+id,text:'original-body-'+id,images:[]},title:'title-'+id,body:'body-'+id,tags:'#tag',status:id==='A'?args.status:'draft',assets:[],assetOrder:[],visibility:'public',revision:1,createdAt:Date.now()});
    t.store.put('meta','lastContentDraft',{id:'A'});t.store.flush();
    const test=t.finalReview={gates:{},calls:[],armed:null};
    const hold=async(key,value)=>{test.gates[key]={value};await new Promise(resolve=>test.gates[key].resolve=resolve);return test.gates[key].value;};
    const handle=(name,fn)=>{ipcMain.removeHandler('fengsha:'+name);ipcMain.handle('fengsha:'+name,async(_e,...args)=>{test.calls.push({name,args});return {ok:true,value:await fn(...args)};});};
    const record=(id,keyword)=>({id,keyword,platform:'小红书',options:{limit:50,from:'2026-09-13',to:'2026-10-13',includeUnknown:false},items:[],scanned:0,unknown:0,canContinue:true,status:'interrupted',message:id});
    handle('content-last',()=>args.delayLast&&!test.initialLastDone?(test.initialLastDone=true,hold('last',record('OLD','old'))):t.contentSearch.record);
    handle('content-draft-get',id=>{const value=t.contentStudio.get(id);if(test.armed===id){test.armed=null;return hold('get',value);}return value;});
    handle('content-remix',id=>hold('remix',t.contentStudio.get(id)));
    handle('content-search',(_p,keyword,options)=>t.contentSearch.record={...record('FRESH',keyword),options});
    handle('content-more',id=>t.contentSearch.record);
  },{status,delayLast});
  await load();await button('打开当前二创稿').waitFor();
}
async function arm(id){await app.evaluate((_e,id)=>{globalThis.fengshaTest.finalReview.armed=id;},id);}
async function gated(key){await app.evaluate(async(_e,key)=>{for(let i=0;i<200;i++){if(globalThis.fengshaTest.finalReview.gates[key]?.resolve)return;await new Promise(r=>setTimeout(r,10));}throw Error('gate missing: '+key);},key);}
async function release(key,value){await app.evaluate((_e,{key,value})=>{const gate=globalThis.fengshaTest.finalReview.gates[key];if(value)gate.value={...gate.value,...value};gate.resolve();},{key,value});await page.waitForTimeout(180);}
async function check(name,fn){try{const evidence=await fn();result.checks.push({name,pass:true,...evidence});}catch(e){result.checks.push({name,pass:false,error:e.stack});}fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));}
try{
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[root],env});
  await app.evaluate(({session})=>{session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{const u=new URL(details.url);callback({cancel:['http:','https:'].includes(u.protocol)&&!['127.0.0.1','localhost'].includes(u.hostname)});});});
  page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));
  await check('open B delayed response preserves newer manual A edit',async()=>{
    await setup();await arm('B');await page.getByLabel('已保存克隆稿').selectOption('B');await gated('get');await button('打开当前二创稿').click();await body().fill('manual-A-important');await release('get');
    assert.equal(await body().inputValue(),'manual-A-important');assert.equal(await page.getByLabel('克隆稿标题',{exact:true}).inputValue(),'title-A');assert.equal(await button('保存修改').isEnabled(),true);await page.screenshot({path:path.join(output,'open-dirty-protected.png')});
  });
  await check('same A older reopen response preserves generated revision and manual edit',async()=>{
    await setup();await button('打开当前二创稿').click();await page.getByLabel('整篇二创要求').fill('rewrite');await button('文案＋图片一起二创').click();await gated('remix');await button('返回搜索').click();await arm('A');await button('返回当前任务').click();await gated('get');await release('remix',{revision:2,body:'generated-A'});await button('打开当前二创稿').click();await body().fill('manual-new-A');await release('get');assert.equal(await body().inputValue(),'manual-new-A');assert.equal(await button('保存修改').isEnabled(),true);
  });
  await check('late initial contentLast preserves fresh search and Continue ID',async()=>{
    await setup({delayLast:true});await gated('last');await page.getByLabel('作品搜索关键词').fill('fresh');await button('搜索作品').click();await page.waitForFunction(()=>document.querySelector('.content-summary')?.textContent.includes('fresh'));await release('last');assert.equal(await page.getByLabel('作品搜索关键词').inputValue(),'fresh');await button('继续读取').click();await page.waitForTimeout(180);const calls=await app.evaluate(()=>globalThis.fengshaTest.finalReview.calls);assert.equal(calls.find(c=>c.name==='content-more').args[0],'FRESH');return {continueRequestId:'FRESH'};
  });
  await check('wrong-ID remix response rejected at renderer boundary',async()=>{
    await setup();await button('打开当前二创稿').click();await page.getByLabel('整篇二创要求').fill('rewrite');await button('文案＋图片一起二创').click();await gated('remix');await release('remix',{id:'B',body:'wrong-B'});assert.equal(await body().inputValue(),'body-A');assert.equal(await page.getByLabel('克隆稿标题',{exact:true}).inputValue(),'title-A');return {faultInjection:true};
  });
  await check('transcribing poll must reject older revision after newer completion',async()=>{
    await setup({status:'transcribing'});await button('打开当前二创稿').click();await page.waitForTimeout(250);await arm('A');await gated('get');
    await app.evaluate(()=>{const t=globalThis.fengshaTest,d=t.contentStudio.get('A');d.revision=2;d.status='draft';d.body='new-complete-A';t.store.put('content-draft','A',d);t.contentStudio.job={draftId:'A',id:'completed-A',state:'completed',startedAt:Date.now(),endedAt:Date.now(),visited:[]};t.win.webContents.send('fengsha:changed',t.snapshot());});
    await page.waitForFunction(()=>document.querySelector('[aria-label="克隆稿正文"]')?.value==='new-complete-A');await release('get');const observed={body:await body().inputValue(),disabled:await body().isDisabled(),editable:await body().isEditable()};assert.equal(observed.body,'new-complete-A');assert.equal(observed.disabled,false);assert.equal(observed.editable,true);
    await body().fill('new-complete-A-manual-edit');assert.equal(await body().inputValue(),'new-complete-A-manual-edit');assert.equal(await button('保存修改').isEnabled(),true);observed.manualEditPreserved=true;await page.screenshot({path:path.join(output,'poll-stale-revision.png')});fs.writeFileSync(path.join(output,'poll-observed.json'),JSON.stringify(observed,null,2));return observed;
  });
  result.ok=result.checks.every(c=>c.pass)&&!result.errors.length;
}catch(e){result.fatal=e.stack;}finally{
  if(app){await app.evaluate(()=>{for(const gate of Object.values(globalThis.fengshaTest.finalReview?.gates||{}))gate.resolve?.();}).catch(()=>{});await app.close();}
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;
}
