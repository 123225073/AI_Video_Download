// Real source React + Electron preload/IPC + VideoWorkflow/createVideoArticle + SQLite.
// Only AI responses are local fixtures. Run: node scripts/video-article-082-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const out = path.join(root, 'output', 'video-article-082-e2e-'+Date.now());
const profile = path.join(out, 'profile'), file = path.join(out, 'original.mp4');
const SQL = await initSqlJs({wasmBinary:fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))});
const workflowId = 'article-082-video', draftId = 'article-082-source', transcriptionId = 'article-082-transcript';
fs.mkdirSync(out, { recursive: true });
execFileSync(path.join(root, 'bin/ffmpeg/ffmpeg.exe'), [
  '-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25',
  '-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
  '-t','5','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',file,
], { windowsHide: true });

const sourceFiles = ['src/VideoWorkbench.jsx','src/video-workbench.css','src/VideoArticleOptions.jsx',
  'src/VideoArticleOptions.css','electron/video-workflow.js','electron/video-article.js',
  'scripts/video-corrected-081-e2e.mjs','scripts/video-workbench-races-e2e.mjs'];
const fingerprints = () => Object.fromEntries(sourceFiles.map(name => [name,
  createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
const beforeFiles = fingerprints();
const bundled = await build({ stdin: { loader:'jsx',resolveDir:root,contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';
  import VideoWorkbench from './src/VideoWorkbench.jsx';
  const root=createRoot(document.getElementById('root'));let key=0;
  window.mountVideo=(seed=null)=>root.render(<VideoWorkbench key={++key} state={{}} seed={seed}
    perform={async(method,...args)=>{const r=await window.fengsha[method](...args);
      if(!r.ok)throw Error(r.error);return r.value;}}
    accounts={()=>{throw Error('No account access in this test');}} onSearch={()=>{}}
    onImages={id=>window.openedArticle=id}/>);
  window.mountVideo();
` }, bundle:true,write:false,outdir:out,platform:'browser',format:'iife',
  define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"./"'} });
const files = new Map(bundled.outputFiles.map(f => ['/'+path.basename(f.path),f.contents]));
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url,'http://127.0.0.1').pathname;
  const png = /^\/video-styles\/([a-z0-9]+)\.png$/.exec(pathname);
  if (png) {
    const asset = path.join(root,'public/video-styles',png[1]+'.png');
    if (fs.existsSync(asset)) { res.setHeader('content-type','image/png');res.end(fs.readFileSync(asset));return; }
  }
  if (files.has(pathname)) {
    res.setHeader('content-type',pathname.endsWith('.css')?'text/css':'text/javascript');res.end(files.get(pathname));return;
  }
  if (pathname === '/') {
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"><div id="root"></div><script src="/stdin.js"></script>');return;
  }
  res.writeHead(404);res.end();
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const env = {...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:profile,NO_PROXY:'127.0.0.1,localhost'};
delete env.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(env)) if (/^(https?_proxy|all_proxy)$/i.test(name)) delete env[name];
let app,page,settingsBaseline,accepted;
const result = {scope:'actual source React/Electron preload IPC, workflow, article parser/validation and persistent SQLite; local model fixtures and MP4',
  out,profile,cases:[],errors:[],sessions:[],sourceHashes:beforeFiles,
  unverified:['real model translation quality and provider streaming','paid image generation','external platform download/ASR',
    'full ContentPage navigation/export','installed/package acceptance']};
async function poll(fn,label,timeout=20000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100)); }
  throw Error('Timed out: '+label);
}
const button=name=>page.getByRole('button',{name,exact:true});
const dialog=()=>page.getByRole('dialog',{name:'创作设置',exact:true});
const video=()=>page.getByLabel('原视频播放',{exact:true});
const live=()=>page.locator('.video-article-live');
const ipc=async(method,...args)=>{
  const r=await page.evaluate(async({method,args})=>window.fengsha[method](...args),{method,args});
  if(!r.ok)throw Error(r.error);return r.value;
};
const flow=()=>ipc('videoGet',workflowId);
function diskSnapshot(){
  // Read only the physical SQLite bytes in this runner, never Store.open/flush.
  const db=new SQL.Database(fs.readFileSync(path.join(profile,'library.sqlite')));
  try{
    const read=(kind,id)=>{
      const statement=db.prepare('SELECT data FROM records WHERE kind=? AND id=?');
      try{statement.bind([kind,id]);return statement.step()?JSON.parse(statement.getAsObject().data):null;}
      finally{statement.free();}
    };
    const workflow=read('video-workflow',workflowId);
    return {workflow,draft:workflow?.article?.draftId?read('content-draft',workflow.article.draftId):null};
  }finally{db.close();}
}
const fixture=()=>app.evaluate(()=>{const f=globalThis.fengshaTest.article082;
  return {actions:f.actions,models:f.models,imageRequests:f.imageRequests,networkAttempts:f.networkAttempts,phase:f.phase,continuous:f.continuous||null};});
const snapshot=async name=>page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
async function playable() {
  await page.waitForFunction(()=>{const v=document.querySelector('video[aria-label="原视频播放"]');return v?.readyState>=1&&v.duration>0&&!v.error;},{},{timeout:15000});
  await video().evaluate(async v=>{v.muted=true;v.loop=true;await v.play();});
  await page.waitForFunction(()=>{const v=document.querySelector('video[aria-label="原视频播放"]');return v?.currentTime>0&&!v.paused;});
}
const rememberPlayer=()=>video().evaluate(v=>{window.article082Player=v;window.article082Src=v.getAttribute('src');});
async function stablePlayer() {
  assert.equal(await video().evaluate(v=>v===window.article082Player&&v.getAttribute('src')===window.article082Src),true,'same view keeps the native player and URL');
}
async function launch(seed=false) {
  app=await electron.launch({executablePath:require('electron'),args:[root,'--agent-data-dir',profile],env,timeout:25000});
  app.process().stderr.on('data',data=>fs.appendFileSync(path.join(out,'electron-stderr.log'),data));
  await poll(()=>app.evaluate(()=>!!globalThis.fengshaTest?.ready),'test services ready');
  await app.evaluate(async({session,BrowserWindow,app}, {origin,profile})=>{
    if(app.getPath('userData')!==profile)throw Error('Test profile isolation failed');
    await session.defaultSession.setProxy({mode:'direct'});
    session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith(origin+'/')
      &&!d.url.startsWith('fengsha-media:')&&!d.url.startsWith('file:')&&!d.url.startsWith('devtools:')}));
    await BrowserWindow.getAllWindows()[0].loadURL(origin);
  },{origin,profile});
  page=await app.firstWindow();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>result.errors.push(error.message));
  await page.getByLabel('视频任务',{exact:true}).waitFor();
  await app.evaluate((_,{seed,file,workflowId,draftId,transcriptionId})=>{
    const t=globalThis.fengshaTest;
    const f=t.article082={mode:'success',phase:'idle',actions:[],models:[],imageRequests:0,networkAttempts:0,gates:{}};
    const action=t.videoWorkflow.action.bind(t.videoWorkflow);
    t.videoWorkflow.action=async(id,kind,options)=>{f.actions.push({id,kind,options});return action(id,kind,options);};
    // Config overrides are in memory and never write settings or credentials.
    t.ai.config=kind=>kind==='image'?{hasKey:false,model:''}:
      {hasKey:true,model:'offline-fixture',protocol:'chat',supportsImages:false,supportsVision:false,timeout:30};
    const deny=async()=>{f.networkAttempts++;throw Error('External access prohibited in article-082 fixture');};
    t.ai.fetch=async()=>{f.imageRequests++;throw Error('No paid image request is allowed');};
    globalThis.fetch=deny;t.engine.parse=deny;t.engine.download=deny;
    t.collectorConnection.withConnection=deny;
    function gate(name,signal){
      signal?.throwIfAborted();f.phase=name;
      return new Promise((resolve,reject)=>{
        const aborted=()=>{delete f.gates[name];reject(Error('Fixture model cancelled'));};
        f.gates[name]=()=>{signal?.removeEventListener('abort',aborted);delete f.gates[name];resolve();};
        signal?.addEventListener('abort',aborted,{once:true});
      });
    }
    t.ai.chat=async(system,content,signal,onText)=>{
      signal?.throwIfAborted();assertInput();
      let data;try{data=JSON.parse(content);}catch{throw Error('Unexpected non-JSON model input');}
      const audit=system.includes('VIDEO_ARTICLE_FACT_AUDIT');
      f.models.push({kind:audit?'audit':'planning',system,data});
      if(system.includes('VIDEO_ARTICLE_REPAIR'))return JSON.stringify({page:{title:'未采用测试候选',text:'机器人遇到风险在0.02秒内停止。',imagePrompt:'安全暂停示意'}});
      if(data.outputLanguage!=='chinese')throw Error('Chinese contract must reach actual model boundary');
      if(audit){await gate('audit',signal);return JSON.stringify({faithful:true,issues:[]});}
      if(data.reference!=='corrected'||!data.source.text.includes('0.2 seconds')||data.source.text.includes('0.02'))
        throw Error('Planning must receive accepted English correction');
      if(f.mode==='continuous'){
        // Never pause at a gate or finish: every 8ms produces a longer JSON prefix.
        // A 200ms Store debounce cannot settle during this scenario.
        const prefix='{"title":"持续流自动保存","pages":[{"title":"持续流分页","text":"持续更新：';
        const body='机器人需要理解指令并保持安全。'.repeat(2000);
        const startedAt=Date.now();f.phase='continuous';
        f.continuous={startedAt,chunks:0,lastChunkAt:startedAt,maxGapMs:0,prefixChars:prefix.length};
        for(let end=8;end<body.length;end+=8){
          signal?.throwIfAborted();
          const now=Date.now(),stream=f.continuous;
          stream.maxGapMs=Math.max(stream.maxGapMs,now-stream.lastChunkAt);
          stream.lastChunkAt=now;stream.chunks++;stream.prefixChars=prefix.length+end;
          onText?.(prefix+body.slice(0,end));
          await new Promise(resolve=>setTimeout(resolve,8));
        }
        throw Error('Continuous fixture unexpectedly completed before hard crash');
      }
      const pages=[{title:f.mode==='failure'?'未采用测试候选':'开头',text:'机器人需要理解指令。',imagePrompt:'机器人接收指令的插画'},
        {title:'安全暂停',text:f.mode==='failure'?'机器人遇到风险在0.02秒内停止。':'机器人遇到风险在0.2秒内停止。',imagePrompt:'安全暂停示意'},
        {title:'因果理解',text:'原视频介绍了具身智能理解因果的能力。',imagePrompt:'因果关系的信息图'}];
      const reply=JSON.stringify({title:'机器人因果理解',pages,styleDescription:'简洁科技信息图'});
      const one=reply.indexOf(JSON.stringify(pages[0]))+JSON.stringify(pages[0]).length;
      const two=reply.indexOf(JSON.stringify(pages[1]))+JSON.stringify(pages[1]).length-5;
      onText?.(reply.slice(0,one));await gate('page-one',signal);
      onText?.(reply.slice(0,two));await gate('page-two',signal);
      onText?.(reply);signal?.throwIfAborted();return reply;
      function assertInput(){if(!system.includes('pages')&&!system.includes('VIDEO_ARTICLE_FACT_AUDIT'))throw Error('Unexpected model operation');}
    };
    if(seed){
      const original='The robot needs to understand instructions. It stops within 0.02 seconds when a risk occurs. The video introduces embodied intelligence and causal understanding.';
      const corrected=original.replace('0.02','0.2');
      t.store.put('transcription',transcriptionId,{id:transcriptionId,status:'ready',source:{kind:'file',file,ext:'mp4'},
        sourceFile:file,title:'English robot example',transcript:original,correctedTranscript:corrected,segments:[],progress:100,
        mode:{correct:false},speech:{mode:'local',language:'en'},createdAt:Date.now()});
      t.store.put('content-draft',draftId,{id:draftId,source:{id:'article-082-source-id',type:'video',platform:'本地视频',url:'',title:'English robot example'},
        original:{title:'English robot example',text:original,description:'Metadata is not the fact source'},title:'English robot example',body:corrected,
        assets:[],assetOrder:[],revision:1,status:'draft',transcriptionId,originalVideoFile:file,createdAt:Date.now()});
      t.store.put('video-workflow',workflowId,{id:workflowId,draftId,transcriptionId,autoCorrect:false,createdAt:Date.now(),startedAt:Date.now()});
      t.store.flush();
    }
  },{seed,file,workflowId,draftId,transcriptionId});
  await page.evaluate(draftId=>window.mountVideo({draftId}),draftId);
  await poll(async()=>await page.getByLabel('视频任务',{exact:true}).inputValue()===workflowId,'open isolated video task');
  await page.getByRole('tab',{name:'视频转图文',exact:true}).click();
}
async function settings({cancel=false}={}) {
  await button('创作设置').click();await dialog().waitFor();
  await page.getByLabel('图文输出语言',{exact:true}).selectOption('chinese');
  await page.getByLabel('图文页数',{exact:true}).selectOption('3');
  if(cancel){await page.getByLabel('生成图文配图',{exact:true}).check();await button('赛博朋克').click();}
  await button(cancel?'取消':'确认应用').click();
}
const waitPhase=name=>poll(async()=>await app.evaluate((_,name)=>!!globalThis.fengshaTest.article082.gates[name],name),'model gate '+name);
const release=name=>app.evaluate((_,name)=>{const f=globalThis.fengshaTest.article082;if(!f.gates[name])throw Error('Missing gate '+name);f.gates[name]();},name);
async function begin(mode='success') {
  await app.evaluate((_,mode)=>{globalThis.fengshaTest.article082.mode=mode;},mode);
  await button('创作图文方案').click();
  await poll(async()=>{const r=await flow();if(r.articlePreview?.status==='failed')throw Error('Article integration failed: '+r.message);return r.busy;},'workflow becomes busy');
  if(mode==='continuous')await poll(async()=>!!(await fixture()).continuous,'continuous model starts');
  else await waitPhase('page-one');
  await live().locator('.video-article-pages>article').first().waitFor();
}
async function assertOld() {
  const r=await flow();assert.equal(r.article.draftId,accepted.article.draftId);assert.equal(r.article.body,accepted.article.body);
  const saved=await ipc('contentDraftGet',accepted.article.draftId);assert.deepEqual(saved,accepted.draft);
  return r;
}
async function recordSession(reason){
  const value=await fixture();assert.equal(value.imageRequests,0);assert.equal(value.networkAttempts,0);
  result.sessions.push({reason,...value});
}
async function closeNormally(){await recordSession('normal-exit');await app.close();app=null;page=null;}

try {
  await launch(true);await playable();await rememberPlayer();
  settingsBaseline=await app.evaluate(()=>globalThis.fengshaTest.store.get('settings','main'));
  const baseline=await flow();assert.equal(baseline.correctionReady,true);assert.match(baseline.corrected,/0\.2 seconds/);
  assert.match(baseline.original,/0\.02 seconds/);
  await settings({cancel:true});assert.equal((await fixture()).actions.length,0);
  assert.match(await page.getByLabel('图文配图生成状态').innerText(),/关闭/);
  await button('创作设置').click();
  assert.equal(await page.getByLabel('图文输出语言').inputValue(),'source');
  assert.equal(await page.getByLabel('图文创作依据').inputValue(),'corrected');
  assert.equal(await page.getByLabel('生成图文配图').isChecked(),false);
  assert.equal(await button('自动参考原视频').getAttribute('aria-pressed'),'true');
  assert.equal(await dialog().locator('[data-media-preview="off"] img').count(),8);
  await button('取消').click();await settings();await stablePlayer();
  assert.equal((await fixture()).actions.length,0,'confirm settings cannot call IPC generation');
  result.cases.push('modal cancel is isolated; confirm only applies; source/auto/corrected defaults and images off survive cancellation');

  await begin();
  let r=await flow();assert.equal(r.articlePreview.status,'running');assert.equal(r.articlePreview.validated,false);
  assert.equal(r.articlePreview.pages.length,1);assert.equal(r.article,null);
  assert.equal(await live().locator('.video-article-pages>article').count(),1);await stablePlayer();
  const planning=(await fixture()).models.find(c=>c.kind==='planning');
  assert.equal(planning.data.outputLanguage,'chinese');assert.equal(planning.data.style,'auto');assert.equal(planning.data.reference,'corrected');
  result.modelOutputLanguage=planning.data.outputLanguage;
  assert.equal(planning.data.source.text,baseline.corrected);assert.equal(planning.data.source.description,'');
  assert.match(planning.system,/简体中文/);
  assert.equal((await fixture()).actions[0].options.outputLanguage,'chinese');
  assert.equal((await fixture()).actions[0].options.generateImages,false);
  await snapshot('stream-first-page');
  result.cases.push('real frontend IPC chinese reaches actual article creator/planning model; accepted English source yields readable unvalidated first Chinese page');

  await release('page-one');await waitPhase('page-two');
  await live().getByText('安全暂停',{exact:true}).waitFor();
  r=await flow();assert.equal(r.articlePreview.pages.length,2);assert.equal(r.articlePreview.pages[1].contentComplete,false);
  assert.equal(await live().locator('.video-article-pages>article').count(),2);await stablePlayer();
  await page.evaluate(draftId=>window.mountVideo({draftId}),draftId);
  await live().getByText('安全暂停',{exact:true}).waitFor();
  assert.equal(await button('创作设置').isDisabled(),true);assert.equal(await button('停止处理').count(),1);
  assert.equal((await flow()).busy,true);await playable();await rememberPlayer();
  await release('page-two');await waitPhase('audit');
  r=await flow();assert.equal(r.article,null);assert.equal(r.articlePreview.validated,false);
  assert.equal(r.articlePreview.validation.audit,'running');
  await release('audit');
  await poll(async()=>{const v=await flow();return !v.busy&&v.articlePreview.status==='completed';},'Chinese article saved');
  await button('打开图文成稿继续编辑与导出').waitFor();
  r=await flow();assert.equal(r.article.pages.length,3);assert.equal(r.article.generatedCount,0);
  assert.match(r.article.body,/0\.2秒/);assert.doesNotMatch(r.article.body,/0\.02/);
  assert.equal(r.original,baseline.original);assert.equal(r.corrected,baseline.corrected);
  assert.equal((await fixture()).models.find(c=>c.kind==='audit').data.outputLanguage,planning.data.outputLanguage);
  accepted={article:r.article,draft:await ipc('contentDraftGet',r.article.draftId)};
  assert.equal(accepted.draft.source.type,'image');assert.equal(accepted.draft.assets.length,0);
  await stablePlayer();await playable();await snapshot('Chinese-article-saved');
  result.cases.push('incomplete second page accumulates; remount/reopen recovers busy preview without local operation; real audit precedes persisted Chinese draft with zero images and same player');

  // Reopening the component correctly resets the unpersisted language default.
  // Confirm Chinese again before starting the independent failure scenario.
  await settings();
  await begin('failure');await release('page-one');await waitPhase('page-two');await release('page-two');
  await poll(async()=>{const v=await flow();return !v.busy&&v.articlePreview.status==='failed';},'failed candidate retained');
  r=await assertOld();assert.equal(r.articlePreview.validated,false);
  assert.match(r.articlePreview.pages[1].text,/0\.02秒/);
  assert.ok(r.articlePreview.numericIssues?.length||r.articlePreview.auditIssues?.length,'failure has actual validation evidence');
  await live().getByText('未采用的图文候选',{exact:true}).waitFor();
  assert.equal(await page.locator('.video-article-saved').getAttribute('open'),null);
  await page.getByText('查看已保存图文成稿',{exact:true}).click();
  assert.equal(await page.locator('.video-article-result').getByText('机器人遇到风险在0.2秒内停止。',{exact:true}).isVisible(),true);
  await stablePlayer();await snapshot('failure-unadopted-old-result');
  result.cases.push('actual numeric validation rejects changed 0.02; readable failed pages are unadopted and previous derived draft/body/assets remain identical');

  await begin();await stablePlayer();await closeNormally();
  await launch();r=await assertOld();assert.equal(r.busy,false);
  assert.ok(['cancelled','interrupted'].includes(r.articlePreview.status));assert.ok(r.articlePreview.pages.length>0);
  await live().getByText('未采用的图文候选',{exact:true}).waitFor();await playable();await rememberPlayer();
  assert.equal((await fixture()).models.length,0,'restart must not automatically request a model');
  result.cases.push('normal Electron exit aborts in-flight fixture; real profile restart retains partial preview, old article and playable original, without automatic model retry');

  await settings();
  const diskBeforeStream=diskSnapshot(),crashSource=await video().getAttribute('src');
  assert.equal(diskBeforeStream.draft.id,accepted.draft.id);
  assert.equal(diskBeforeStream.draft.body,accepted.draft.body);
  await begin('continuous');await stablePlayer();
  await poll(async()=>{
    const stats=(await fixture()).continuous;
    return stats&&stats.lastChunkAt-stats.startedAt>=1200;
  },'more than 1.2 seconds of uninterrupted 8ms stream');
  const persistedFirst=await poll(()=>{
    const saved=diskSnapshot(),preview=saved.workflow?.articlePreview;
    return preview?.status==='running'&&preview.pages?.[0]?.title==='持续流分页'&&preview.pages[0].text.length>8?saved:null;
  },'automatic preview persistence during active stream');
  // A second advancing disk snapshot rules out an incidental one-time save.
  const persistedSecond=await poll(()=>{
    const saved=diskSnapshot(),preview=saved.workflow?.articlePreview;
    return preview?.status==='running'&&preview.pages?.[0]?.text.length>persistedFirst.workflow.articlePreview.pages[0].text.length?saved:null;
  },'another automatic disk checkpoint while chunks continue');
  const streamStats=(await fixture()).continuous,memoryPreview=(await flow()).articlePreview;
  assert.ok(streamStats.lastChunkAt-streamStats.startedAt>1200);
  assert.ok(streamStats.chunks>=100);
  assert.ok(streamStats.maxGapMs<200,'no gap may allow the 200ms debounce to settle');
  assert.ok(memoryPreview.pages[0].text.startsWith(persistedSecond.workflow.articlePreview.pages[0].text));
  assert.equal(persistedSecond.workflow.articlePreview.validated,false);
  assert.equal(persistedSecond.workflow.articlePreview.pages[0].contentComplete,false);
  assert.notEqual(persistedSecond.workflow.articlePreview.text,diskBeforeStream.workflow.articlePreview.text);
  await stablePlayer();
  await recordSession('abrupt-exit');
  const stoppedApp=app,exited=new Promise(resolve=>stoppedApp.process().once('exit',resolve));
  // Kill this runner's isolated process tree, including Chromium children that
  // can otherwise keep the Windows profile lock alive. No graceful quit/flush.
  if(process.platform==='win32')execFileSync('taskkill.exe',
    ['/PID',String(stoppedApp.process().pid),'/T','/F'],{windowsHide:true,stdio:'pipe'});
  else assert.equal(stoppedApp.process().kill('SIGKILL'),true);
  await exited;app=null;page=null;
  const diskAfterCrash=diskSnapshot(),crashedPreview=diskAfterCrash.workflow.articlePreview;
  assert.equal(crashedPreview.status,'running');
  assert.equal(crashedPreview.pages[0].title,'持续流分页');
  assert.ok(crashedPreview.pages[0].text.length>=persistedSecond.workflow.articlePreview.pages[0].text.length);
  assert.equal(diskAfterCrash.workflow.article.draftId,accepted.article.draftId);
  // Compare persisted records with persisted records; IPC adds display-only fields.
  assert.deepEqual(diskAfterCrash.draft,diskBeforeStream.draft);
  result.continuousPersistence={intervalMs:8,elapsedMs:streamStats.lastChunkAt-streamStats.startedAt,
    chunks:streamStats.chunks,maxGapMs:streamStats.maxGapMs,
    firstDiskTextChars:persistedFirst.workflow.articlePreview.pages[0].text.length,
    secondDiskTextChars:persistedSecond.workflow.articlePreview.pages[0].text.length,
    afterCrashDiskTextChars:crashedPreview.pages[0].text.length,manualFlushBeforeKill:false};
  await launch();r=await assertOld();assert.equal(r.busy,false);assert.equal(r.articlePreview.status,'interrupted');
  assert.deepEqual(r.articlePreview.pages,crashedPreview.pages);
  assert.equal(r.articlePreview.text,crashedPreview.text);
  assert.equal(r.articlePreview.validated,false);
  await live().getByText('未采用的图文候选',{exact:true}).waitFor();
  await live().getByText('持续流分页',{exact:true}).waitFor();
  assert.equal(await video().getAttribute('src'),crashSource);
  await playable();await rememberPlayer();await button('创作设置').click();await button('取消').click();await stablePlayer();
  await page.waitForTimeout(1100);await stablePlayer();
  assert.equal((await fixture()).models.length,0);assert.match(await page.getByLabel('图文配图生成状态').innerText(),/关闭/);
  assert.deepEqual(await app.evaluate(()=>globalThis.fengshaTest.store.get('settings','main')),settingsBaseline);
  await snapshot('interrupted-restart-recovered');
  result.cases.push('continuous 8ms chunks outlive 200ms debounce; two advancing physical SQLite previews survive SIGKILL with no fixture flush, and actual constructor recovers the latest durable pages with original source/player stable');
  const finalFixture=await fixture();
  assert.equal(finalFixture.imageRequests,0);assert.equal(finalFixture.networkAttempts,0);assert.deepEqual(result.errors,[]);
  await closeNormally();assert.deepEqual(fingerprints(),beforeFiles,'read-only integration run does not edit source or existing scripts');
  result.ok=true;
} catch(error) {
  result.error=error.stack;process.exitCode=1;
  if(app)result.fixture=await fixture().catch(()=>null);
  if(page){result.visible=await page.locator('body').innerText().catch(()=>null);await snapshot('failure').catch(()=>{});}
} finally {
  if(app)await app.close().catch(error=>{result.closeError=error.message;process.exitCode=1;});
  await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:result.ok??false,out,cases:result.cases,error:result.error,
    rendererErrors:result.errors,modelOutputLanguage:result.modelOutputLanguage,
    continuousPersistence:result.continuousPersistence,
    sessions:result.sessions.map(({reason,imageRequests,networkAttempts,models,actions})=>
      ({reason,imageRequests,networkAttempts,modelCalls:models.length,actions:actions.length})),
    unverified:result.unverified},null,2));
}
