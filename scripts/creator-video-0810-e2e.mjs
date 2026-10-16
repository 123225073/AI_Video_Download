// Offline E2E: actual renderer/preload/IPC/SQLite/VideoWorkflow/Transcriptions/
// Engine/WeChatCreators. Only platform I/O, connection and local ASR are fixtures.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright';
import {reloadTestRenderer} from './test-renderer.mjs';

const require=createRequire(import.meta.url),root=path.resolve('.');
const out=path.join(root,'output','repair-0810','e2e-'+Date.now());
const profile=path.join(out,'profile'),fixtureFile=path.join(out,'two-second-fixture.mp4');
fs.mkdirSync(out,{recursive:true});
execFileSync(path.join(root,'bin/ffmpeg/ffmpeg.exe'),['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=20','-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',fixtureFile],{windowsHide:true});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:profile,FENGSHA_TEST_VISIBLE:'1'};
for(const key of ['ELECTRON_RUN_AS_NODE','FENGSHA_TEST_EXTERNAL_BROWSER','FENGSHA_TEST_WECHAT_WINDOW'])delete env[key];
const result={out,isolated:true,offline:true,paidRequestsTriggered:false,fixtureBoundaries:['collector request/connection','WeChat.download file transport','localSpeech recognition'],realBoundaries:['renderer','preload','IPC','Store','VideoWorkflow','Transcriptions','Engine.parse/download/verify','WeChatCreators.page/resolve/media','ffmpeg/ffprobe','fengsha-media playback'],cases:[],errors:[]};
let app,page;
let phase='created',fatalCaptured=false;
const checkpoint=next=>{phase=next;fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify({phase,checkedAt:new Date().toISOString(),profile,ownedElectronPid:app?.process().pid||null},null,2));};
const closeOwned=async()=>{
  if(!app)return true;
  const owned=app;app=null;
  const closed=await Promise.race([owned.close().then(()=>true).catch(()=>false),new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),10000);timer.unref();})]);
  result.ownedElectronClosed=closed;return closed;
};
const fatal=error=>{
  if(fatalCaptured)return;fatalCaptured=true;result.error=error?.stack||String(error);result.failedPhase=phase;result.hostProtocolFailure=true;
  checkpoint('fatal-'+phase);
  void closeOwned().finally(()=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.error(JSON.stringify(result,null,2));process.exit(1);});
};
process.on('uncaughtException',fatal);process.on('unhandledRejection',fatal);
const poll=async(fn,label)=>{for(let n=0;n<300;n++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timeout: '+label);};
const nav=label=>page.locator('nav').getByRole('button',{name:label,exact:true});

async function launch(seed){
  checkpoint('electron-launch');
  app=await electron.launch({executablePath:require('electron'),args:[root,'--agent-data-dir',profile],env,timeout:60000});
  checkpoint('renderer-bootstrap');
  await reloadTestRenderer(app);
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>result.errors.push(error.message));
  checkpoint('fixture-seed');
  await app.evaluate(async({session,app:electronApp},{fixtureFile,seed})=>{
    const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),t=globalThis.fengshaTest;
    const ensure=(condition,message)=>{if(!condition)throw Error(message);};
    ensure(electronApp.getPath('userData').includes('repair-0810'),'Must use isolated profile');
    t.creatorVideoFixture={details:[],resolves:[],downloads:[],connections:0,asr:0,paidCalls:0,externalRequests:0,externalWindows:0};
    const audit=t.creatorVideoFixture;
    electronApp.on('browser-window-created',()=>audit.externalWindows++);
    session.defaultSession.webRequest.onBeforeRequest((request,callback)=>{
      const blocked=/^https?:/.test(request.url)&&!/^http:\/\/127\.0\.0\.1:\d+\//.test(request.url);
      if(blocked)audit.externalRequests++;
      callback({cancel:blocked});
    });
    globalThis.fetch=async()=>{audit.externalRequests++;throw Error('Offline E2E blocks external main-process fetch');};
    const creator={id:'offline-creator-0810',name:'离线验收博主',platform:'视频号',identityStatus:'confirmed',supported:true,adapter:'wechat-collector',needsCollector:false};
    const objects=Array.from({length:26},(_,index)=>({
      id:(17300000000000000000n+BigInt(index)).toString(),objectNonceId:(7200000000000000000n+BigInt(index)).toString(),
      contact:{username:creator.id,nickname:creator.name},createtime:1792000000-index,
      objectDesc:{mediaType:4,description:'离线第'+String(index+1).padStart(2,'0')+'条原视频',media:[{url:'https://finder.video.qq.com/offline-'+(index+1)+'.mp4',urlToken:'',decodeKey:'',thumbUrl:'',coverUrl:'',videoPlayLen:2}]}
    }));
    t.wechatCreators.request=async(route,parameters,signal)=>{
      signal?.throwIfAborted();
      if(route==='/api/channels/contact/feed/list'){
        ensure(parameters.username===creator.id,'Wrong list creator');
        return{contact:{username:creator.id,nickname:creator.name},object:objects,continueFlag:0,lastBuffer:'',feedsCount:26};
      }
      ensure(route==='/api/channels/feed/profile','Unexpected collector route');
      const index=objects.findIndex(object=>object.id===parameters.oid);
      ensure(index>=0,'Detail request must use original decimal sourceId');
      ensure(parameters.nid===objects[index].objectNonceId,'Detail request nonce mismatch');
      audit.details.push({ordinal:index+1,decimalSourceIdExact:true,nonceExact:true});
      return{object:objects[index]};
    };
    const resolve=t.wechatCreators.resolve.bind(t.wechatCreators);
    t.wechatCreators.resolve=async(item,signal)=>{
      const index=objects.findIndex(object=>object.id===item.sourceId);
      ensure(index>=0,'Resolve must preserve original decimal sourceId');
      ensure(item.creatorId===creator.id,'Resolve creator mismatch');
      ensure(item.objectNonceId===objects[index].objectNonceId,'Resolve nonce mismatch');
      const value=await resolve(item,signal);
      ensure(value.info.id===objects[index].id,'Resolved object identity mismatch');
      ensure(value.info.uploader_id===creator.id,'Resolved author identity mismatch');
      ensure(value.objectNonceId===objects[index].objectNonceId,'Resolved nonce mismatch');
      audit.resolves.push({ordinal:index+1,sourceIdExact:true,creatorExact:true,nonceExact:true});
      return value;
    };
    t.collectorConnection.withConnection=async(signal,run,capabilities)=>{
      signal?.throwIfAborted();ensure(capabilities?.includes('detail'),'Expected detail capability');audit.connections++;return run();
    };
    t.engine.wechat.download=async(task,directory,signal,progress,engine)=>{
      const index=objects.findIndex(object=>object.id===task.item.sourceId);
      ensure(index>=0,'Download item identity missing');ensure(task.options.allowCollector===true,'Structured creator source must allow detail acquisition');
      await t.wechatCreators.resolve(task.item,signal);
      fs.mkdirSync(directory,{recursive:true});
      const filePath=path.join(directory,'offline-selected-'+(index+1)+'.mp4');fs.copyFileSync(fixtureFile,filePath);
      const verified=await engine.verify(filePath,signal);ensure(verified.duration>=1.9&&verified.size>0,'Generated original video must be valid');
      progress({status:'processing',bytes:verified.size,total:verified.size});audit.downloads.push({ordinal:index+1,sourceIdExact:true,creatorExact:task.item.creatorId===creator.id});
      return{filePath,...verified};
    };
    t.transcriptions.options.localSpeech=async(file,model,language,signal)=>{
      signal?.throwIfAborted();ensure(fs.statSync(file).size>1000,'ASR must receive actual extracted WAV');audit.asr++;
      return{text:'这是离线验收口播，先确认原始作品，再继续创作。',segments:[{start:0,end:2,text:'这是离线验收口播，先确认原始作品，再继续创作。'}],language:'zh'};
    };
    t.ai.config=kind=>kind==='speech'?{mode:'local',localModel:'small',language:'zh',hasKey:false}:{hasKey:false,model:'',supportsImages:false};
    for(const key of ['chat','transcribe','fetch'])t.ai[key]=async()=>{audit.paidCalls++;throw Error('Paid/model endpoint is disabled for offline E2E');};
    if(seed){
      ensure(t.store.list('wechat-media').length===0&&t.store.list('media').length===0,'Seed must have no cached or local media');
      const list=await t.wechatCreators.page(creator,26,new AbortController().signal);
      ensure(list.items.length===26&&list.complete,'Real collector.page must generate 26 complete creator entries');
      ensure(list.items.every((item,index)=>item.sourceId===objects[index].id&&item.creatorId===creator.id&&item.objectNonceId===objects[index].objectNonceId),'Generated list identities must be exact');
      ensure(list.items.every(item=>new URL(item.url).searchParams.get('oid')!==item.sourceId),'List URLs must use encoded oid');
      ensure(t.store.list('wechat-media').length===0,'Listing must not manufacture media cache');
      t.store.put('creator','offline-creator-list',{id:'offline-creator-list',creator,source:list.items[0].url,total:26,items:list.items,scanned:26,cursor:27,seen:list.items.map(item=>item.key),status:'complete',complete:true,skipped:{},filters:{period:'all',limit:50,keyword:'',includeUnknown:true},createdAt:Date.now()});
      t.store.put('meta','lastCreator',{id:'offline-creator-list'});t.store.flush();
    }
    t.win.webContents.send('fengsha:changed',t.snapshot());
  },{fixtureFile,seed});
  checkpoint('renderer-reload');
  await page.reload();await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();checkpoint('ui-ready');
}

async function stateFor(ordinal){
  return app.evaluate((_electron,ordinal)=>{
    const t=globalThis.fengshaTest,sourceId=(17300000000000000000n+BigInt(ordinal-1)).toString();
    const record=t.store.list('video-workflow').find(record=>t.store.get('content-draft',record.draftId)?.source.sourceId===sourceId);
    if(!record)return null;
    const transcription=t.store.get('transcription',record.transcriptionId),workflow=t.videoWorkflow.get(record.id);
    return{id:record.id,transcriptionId:record.transcriptionId,status:transcription.status,transcript:transcription.transcript,sourceIdExact:transcription.source.item?.sourceId===sourceId,creatorExact:transcription.source.item?.creatorId==='offline-creator-0810',nonceExact:transcription.source.item?.objectNonceId===(7200000000000000000n+BigInt(ordinal-1)).toString(),hasVideo:workflow.hasVideo,preview:workflow.preview,sourceFile:transcription.sourceFile,mode:transcription.mode};
  },ordinal);
}
async function completed(ordinal){
  await poll(async()=>{const state=await stateFor(ordinal);if(state&&['failed','ai-failed','no-speech'].includes(state.status))throw Error('Selected item failed: '+state.status);return state?.status==='ready'&&state.hasVideo;},'selected '+ordinal+' video + transcript');
  const state=await stateFor(ordinal);assert.equal(state.sourceIdExact,true);assert.equal(state.creatorExact,true);assert.equal(state.nonceExact,true);assert.ok(state.transcript);assert.equal(state.mode.correct,false);assert.ok(fs.existsSync(state.sourceFile));return state;
}
async function playCurrent(){
  await poll(()=>page.locator('.video-workbench video').count().then(count=>count===1),'original player mounted');
  const video=page.locator('.video-workbench video');
  await poll(()=>video.evaluate(element=>element.readyState>=2&&element.videoWidth>0&&element.duration>=1.9),'real original video decoded');
  await video.evaluate(async element=>{element.muted=true;await element.play();});
  await poll(()=>video.evaluate(element=>element.currentTime>0.08),'real original video playing');await video.evaluate(element=>element.pause());
}

try{
  await launch(true);await nav('博主批量下载').click();await poll(()=>page.locator('.creator-item').count().then(count=>count===26),'26 real creator UI entries');
  checkpoint('creator-second-click');await page.locator('.creator-item').nth(1).getByRole('button',{name:'对标二创',exact:true}).click();
  const second=await completed(2);await playCurrent();result.cases.push('second of 26 creator entries crosses real IPC and completes exact original video + transcript; first entry is never selected');
  checkpoint('creator-third-click');await nav('博主批量下载').click();await page.locator('.creator-item').nth(2).getByRole('button',{name:'语音识别',exact:true}).click();
  await page.getByRole('heading',{name:'转录与翻译',exact:true}).waitFor();const third=await completed(3);assert.notEqual(second.id,third.id);result.cases.push('third creator speech action crosses real videoStart IPC and completes a distinct exact-source transcription');
  const audit=await app.evaluate(()=>globalThis.fengshaTest.creatorVideoFixture);
  assert.ok(audit.details.length>=2);assert.deepEqual([...new Set(audit.details.map(item=>item.ordinal))].sort(),[2,3]);
  assert.deepEqual(audit.downloads.map(item=>item.ordinal),[2,3]);assert.ok(audit.resolves.every(item=>[2,3].includes(item.ordinal)&&item.sourceIdExact&&item.creatorExact&&item.nonceExact));
  assert.equal(audit.asr,2);assert.equal(audit.paidCalls,0);assert.equal(audit.externalRequests,0);assert.equal(audit.externalWindows,0);
  result.offlineAudit=audit;result.cases.push('original decimal IDs, author and nonce preserved through detail/resolve/download; no paid/network/real browser calls');
  checkpoint('restart');await closeOwned();await launch(false);
  const restoredSecond=await completed(2),restoredThird=await completed(3);assert.equal(restoredSecond.id,second.id);assert.equal(restoredThird.id,third.id);assert.equal(restoredSecond.transcript,second.transcript);assert.equal(restoredThird.transcript,third.transcript);
  await nav('博主批量下载').click();assert.equal(await page.locator('.creator-item').count(),26);
  await nav('作品搜索与二创').click();await page.getByRole('tab',{name:'视频复刻',exact:true}).click();await page.getByLabel('视频任务',{exact:true}).selectOption(second.id);await playCurrent();
  await page.getByLabel('视频任务',{exact:true}).selectOption(third.id);await playCurrent();
  const after=await app.evaluate(()=>({audit:globalThis.fengshaTest.creatorVideoFixture,workflows:globalThis.fengshaTest.store.list('video-workflow').length,transcriptions:globalThis.fengshaTest.store.list('transcription').length}));
  assert.equal(after.workflows,2);assert.equal(after.transcriptions,2);assert.equal(after.audit.details.length,0);assert.equal(after.audit.downloads.length,0);assert.equal(after.audit.asr,0);assert.equal(after.audit.paidCalls,0);assert.equal(after.audit.externalRequests,0);assert.equal(after.audit.externalWindows,0);
  result.cases.push('restart restores exactly two tasks and transcripts; both original videos play through actual media protocol without reacquisition');
  assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.error=error.stack;result.failedPhase=phase;await page?.screenshot({path:path.join(out,'failure.png'),timeout:3000}).catch(()=>{});process.exitCode=1;}
finally{await closeOwned();checkpoint(result.ok?'completed':'failed');fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
