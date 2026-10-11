import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {reloadTestRenderer} from './test-renderer.mjs';
const output=path.resolve('output','studio-transcription-'+Date.now()),profile=path.join(output,'profile');
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_VISIBLE:'1',FENGSHA_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const result={output,isolated:true},errors=[];
async function launch(){app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('.')],env});await reloadTestRenderer(app);page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);}
async function poll(fn){for(let i=0;i<150;i++){const value=await fn();if(value)return value;await page.waitForTimeout(100);}throw Error('Expected actual state did not arrive');}
async function enter(){await page.getByRole('button',{name:'作品搜索与二创',exact:true}).click();}
try{
  await launch();
  await app.evaluate(()=>{const t=globalThis.fengshaTest;
    const item={id:'fixture-video',platform:'YouTube',title:'手动克隆视频',url:'https://www.youtube.com/watch?v=abcdefghijk',type:'video',images:[],text:'',publishedAt:'2026-10-01'};
    t.contentSearch.record={id:'record',platform:'YouTube',keyword:'测试',options:{limit:50,from:'2026-09-01',to:'2026-10-11'},all:[item],scanned:1,status:'ready',accountId:null};
    t.store.put('content-search','record',t.contentSearch.record);t.store.put('meta','lastContentSearch',{id:'record'});
    t.ai.chat=()=>{throw Error('Unexpected text model call');};t.contentStudio.fetcher=()=>{throw Error('Unexpected image model call');};
    t.transcriptions.sourceText=async(_record,signal,update)=>{update({status:'transcribing',transcript:'第一批原文',transcriptPartial:true});return new Promise((resolve,reject)=>{t.releaseTranscript=()=>resolve({text:'第一批原文。完整的原始口播。',segments:[]});signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true});});};
  });
  await enter();await page.getByRole('checkbox',{name:/克隆后自动二创/}).uncheck();await page.getByRole('button',{name:'一键克隆',exact:true}).click();
  await poll(async()=>await page.getByLabel('原文案').inputValue()==='第一批原文');
  assert.equal(await page.getByLabel('克隆稿正文').inputValue(),'第一批原文');result.bothColumnsStream=true;
  await page.waitForTimeout(1200);const before=await page.getByTestId('studio-elapsed').textContent();assert.notEqual(before,'00:00');
  await page.reload();await enter();await page.getByRole('button',{name:'打开当前二创稿',exact:true}).click();assert.notEqual(await page.getByTestId('studio-elapsed').textContent(),'00:00');result.reloadKeepsTimer=true;
  await page.getByRole('button',{name:'停止处理',exact:true}).click();await poll(async()=>!(await page.getByRole('button',{name:'停止处理',exact:true}).count()));
  assert.equal(await page.getByLabel('克隆稿正文').isEnabled(),true);assert.equal(await app.evaluate(()=>globalThis.fengshaTest.transcriptions.active),null);assert.equal(await page.getByLabel('原文案').inputValue(),'第一批原文');result.stopReachesRealTranscription=true;
  await page.getByRole('button',{name:'继续提取视频文案',exact:true}).click();await poll(()=>app.evaluate(()=>!!globalThis.fengshaTest.transcriptions.active));await app.evaluate(()=>globalThis.fengshaTest.releaseTranscript());
  await poll(async()=>!(await page.getByLabel('克隆稿正文').isDisabled()));assert.equal(await page.getByLabel('原文案').inputValue(),'第一批原文。完整的原始口播。');assert.equal(await page.getByLabel('克隆稿正文').inputValue(),await page.getByLabel('原文案').inputValue());result.manualCloneNoRemix=true;result.resumeCompletes=true;
  // Reproduce the previous version's on-disk mismatch, then perform a real process restart.
  const legacy=process.argv[2]?JSON.parse(fs.readFileSync(process.argv[2],'utf8')):null;
  await app.evaluate((_,legacy)=>{const t=globalThis.fengshaTest,d=legacy?.draft||t.store.get('content-draft',t.store.get('meta','lastContentDraft').id),tr=legacy?.transcription||t.store.get('transcription',d.transcriptionId);
    d.status='transcribing';d.original.text='';d.body='';delete d.extractionEndedAt;d.extractionStartedAt=d.createdAt;tr.status='ready';t.store.put('content-draft',d.id,d);t.store.put('transcription',tr.id,tr);t.store.put('meta','lastContentDraft',{id:d.id});t.store.flush();
  },legacy);
  await app.close();app=null;await launch();await enter();await page.getByRole('button',{name:'打开当前二创稿',exact:true}).click();
  const source=await page.getByLabel('原文案').inputValue();assert.equal(source,legacy?.transcription.transcript||'第一批原文。完整的原始口播。');assert.equal(await page.getByLabel('克隆稿正文').inputValue(),source);assert.equal(await page.getByLabel('克隆稿正文').isEnabled(),true);assert.equal(await page.getByRole('button',{name:'停止处理',exact:true}).count(),0);
  const timer=await page.getByTestId('studio-elapsed').textContent();await page.waitForTimeout(1500);assert.equal(await page.getByTestId('studio-elapsed').textContent(),timer);result.restartRecoversSavedTranscript=true;result.recoveredCharacters=source.length;result.timerStops=true;
  fs.writeFileSync(path.join(output,'recovered.png'),Buffer.from(await app.evaluate(async()=> (await globalThis.fengshaTest.win.webContents.capturePage()).toPNG().toString('base64')),'base64'));
  assert.deepEqual(errors,[]);result.ok=true;
}finally{if(app)await app.close();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({...result,errors},null,2));console.log(JSON.stringify({...result,errors}));}
