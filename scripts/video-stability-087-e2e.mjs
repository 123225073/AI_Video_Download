// Offline replay of a captured candidate; never connects to a model or modifies
// the installed profile. Pass the local captured JSON as the first argument.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';import {reloadTestRenderer} from './test-renderer.mjs';
const require=createRequire(import.meta.url),root=path.resolve('.'),captured=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const out=path.join(root,'output','stability-087-'+Date.now()),profile=path.join(out,'profile');fs.mkdirSync(out,{recursive:true});
const result={out,isolated:true,realCandidateReplay:true,paidRequests:0,cases:[],errors:[]};let app,page;
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const poll=async(fn,label)=>{for(let n=0;n<200;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
const button=name=>page.getByRole('button',{name,exact:true});
const get=()=>app.evaluate(()=>globalThis.fengshaTest.videoWorkflow.get('v'));
const launch=async()=>{app=await electron.launch({executablePath:require('electron'),args:[root,'--agent-data-dir',profile],env});await reloadTestRenderer(app);page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));page.setDefaultTimeout(15000);};
const open=async()=>{await page.locator('nav').getByRole('button',{name:'作品搜索与二创',exact:true}).click();await page.getByRole('tab',{name:'视频复刻',exact:true}).click();await page.getByLabel('视频任务',{exact:true}).selectOption('v');await page.locator('.video-workbench[data-workflow-id="v"]').waitFor();await page.getByRole('tab',{name:'视频转图文',exact:true}).click();};
try {
 await launch();await app.evaluate(async({session})=>session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:/^https?:/.test(d.url)&&!d.url.startsWith('http://127.0.0.1:')})));
 await app.evaluate((_electron,{captured})=>{
  const t=globalThis.fengshaTest,candidate=structuredClone(captured.recovery.value.candidate);
  t.store.put('transcription','t',{id:'t',title:captured.source.title,source:{kind:'text',text:captured.source.text},status:'ready',transcript:captured.source.text,correctedTranscript:captured.source.text,segments:[]});
  t.store.put('content-draft','d',{id:'d',source:{id:'s',type:'video',platform:'抖音',title:captured.source.title},original:{title:captured.source.title,text:captured.source.text,images:[]},title:captured.source.title,body:captured.source.text,transcriptionId:'t',assets:[],assetOrder:[],revision:1,status:'draft',createdAt:Date.now()});
  t.store.put('video-workflow','v',{id:'v',draftId:'d',transcriptionId:'t',createdAt:Date.now(),autoCorrect:false,articleRecovery:captured.recovery,articleOptions:{...captured.options,generateImages:false},articlePreview:captured.preview,lastAction:'article',message:captured.message});
  t.fixture={repairs:[],writes:0,continuations:0,audits:0,transientAudit:false};
  const fixed=structuredClone(candidate);fixed.pages[2].text=fixed.pages[2].text.replace('可能成为未来很值钱的东西','可能未来是最值钱的东西');fixed.pages[5].text=fixed.pages[5].text.replace('原来不在某个行业，并不会因为有了AI就能轻易进入','你原来不是这行业，你现在进也进不去');
  t.ai.config=()=>({hasKey:true,model:'offline-fixture',protocol:'chat',supportsImages:false});
  t.ai.chat=async(system,content,signal,onText)=>{
   const f=t.fixture;
   if(system.includes('VIDEO_ARTICLE_FACT_AUDIT')){f.audits++;if(f.transientAudit&&f.audits===1)throw Error('模型服务超时');if(f.transientAudit&&f.audits===2)return 'not-json';const a=JSON.parse(content).article;return JSON.stringify({faithful:a.pages[2].text.includes('最值钱')&&a.pages[5].text.includes('进也进不去'),issues:[]});}
   if(system.includes('VIDEO_ARTICLE_REPAIR')){const index=JSON.parse(content).pendingPage;f.repairs.push(index);return JSON.stringify({page:fixed.pages[index-1]});}
   if(system.includes('VIDEO_ARTICLE_CONTINUE_PAGE')){f.continuations++;const index=Number(/本次仅补第(\d+)页/.exec(system)[1]);return JSON.stringify({page:fixed.pages[index-1],styleDescription:fixed.styleDescription});}
   f.writes++;onText('{"title":'+JSON.stringify(fixed.title)+',"pages":['+fixed.pages.slice(0,7).map(p=>JSON.stringify(p)).join(',')+',{"title":"结尾","text":"部分输出');throw Error('模型服务超时');
  };t.store.flush();t.win.webContents.send('fengsha:changed',t.snapshot());
 },{captured});
 await page.reload();await open();assert.equal(await button('继续图文处理').isEnabled(),true);await button('继续图文处理').click();
 await poll(async()=>!!(await get()).article&&!(await get()).busy,'old candidate automatically repaired');
 const first=await get();const calls=await app.evaluate(()=>globalThis.fengshaTest.fixture);
 assert.deepEqual(calls.repairs,[3,6]);assert.equal(calls.writes,0);assert.equal(calls.audits,1);assert.equal(first.article.pages.length,8);
 for(const index of [0,1,3,4,6,7])assert.equal(first.article.pages[index].text,captured.recovery.value.candidate.pages[index].text);
 assert.match(first.article.pages[2].text,/最值钱/);assert.match(first.article.pages[5].text,/进也进不去/);
 result.cases.push('captured eight-page failure: enabled continue repairs only pages 3 and 6, then validates and saves');
 fs.writeFileSync(path.join(out,'repaired.png'),Buffer.from(await app.evaluate(async()=> (await globalThis.fengshaTest.win.webContents.capturePage()).toPNG().toString('base64')),'base64'));
 await app.evaluate(()=>{globalThis.fengshaTest.fixture={repairs:[],writes:0,continuations:0,audits:0,transientAudit:true};});
 await button('创作图文方案').click();await poll(async()=>!(await get()).busy&&(await get()).articlePreview?.status==='completed','all injected recoverable errors handled in one operation');
 const second=await app.evaluate(()=>globalThis.fengshaTest.fixture);assert.equal(second.writes,1);assert.equal(second.continuations,1);assert.equal(second.audits,3);assert.deepEqual(second.repairs,[]);
 result.cases.push('one operation handles stream timeout, remaining page, audit timeout and malformed audit response without manual retry');
 await page.getByRole('tab',{name:'生图提示词',exact:true}).click();assert.equal(await page.getByLabel('第 1 页生图提示词',{exact:true}).count(),1);
 await app.close();app=null;await launch();await open();assert.equal((await get()).article.pages.length,8);assert.equal((await get()).articlePreview.status,'completed');
 result.cases.push('accepted plan and detailed prompts persist across actual Electron restart');
 assert.deepEqual(result.errors,[]);result.ok=true;
} catch(e) {result.error=e.stack;process.exitCode=1;}
finally {await app?.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
