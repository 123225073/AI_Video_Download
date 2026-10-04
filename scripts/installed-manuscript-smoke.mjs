import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const executablePath=path.resolve(process.argv[2]);
const output=path.resolve('output',`installed-manuscript-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let application;const result={output,ok:false,realProvider:false},errors=[];
try{
  application=await electron.launch({executablePath,env,timeout:45000});const page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();const snapshot=await page.evaluate(async()=>(await window.fengsha.snapshot()).value);
  result.version=snapshot.version;result.textKeyAvailable=snapshot.ai.text.hasKey;result.model=snapshot.ai.text.model;
  await page.locator('nav').getByRole('button',{name:'转录与翻译',exact:true}).click();
  if(snapshot.transcriptions.length){await page.getByRole('button',{name:/^打开文案：/}).first().click();await page.getByRole('heading',{name:'原文 · 不带时间戳',exact:true}).waitFor();assert.ok((await page.locator('.manuscript-text').first().innerText()).length>10);result.oldRecordsReadable=true;}
  assert.equal(await page.getByRole('heading',{name:'内容摘要',exact:true}).count(),0);assert.equal(await page.getByLabel('我的笔记',{exact:true}).count(),0);await page.screenshot({path:path.join(output,'安装版文案对照.png')});
  if(!snapshot.ai.text.hasKey)throw Error('安装版文本密钥不可用，未完成真实模型验证');
  result.realProvider=true;
  const response=await application.evaluate(async({app,safeStorage},{output,config})=>{
    const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');const {Store}=load('./electron/store.js'),{AIService}=load('./electron/ai.js'),{Transcriptions}=load('./electron/transcription.js');const path=process.getBuiltinModule('path');
    const store=await Store.open(path.join(output,'profile'),{});store.put('ai-config','text',config);const ai=new AIService(store,path.join(app.getPath('userData'),'ai'),safeStorage);const service=new Transcriptions(store,{bin:path.join(process.resourcesPath,'bin')},ai,path.join(output,'records'),()=>{});
    const settle=async id=>{while(service.active||service.get(id).status==='queued')await new Promise(r=>setTimeout(r,200));const t=service.get(id);if(!['ready','archived'].includes(t.status))throw Error(t.message);return t;};
    try{
      const segments=[{start:1.234,end:5.678,text:'今天我们学习如何整里视频资料，首先把视频转成文字。'},{start:6.789,end:11.012,text:'然后提练关键观点。全过程分成 3 步，原始素材必须保留。'}];
      const id=service.start({text:segments.map(s=>s.text).join('\n'),title:'合成素材 · 成对矫正与格式翻译验证'}).id;const raw=await settle(id);store.put('transcription',id,{...raw,segments});const stagedStart=!raw.correctedTranscript&&!raw.summary&&!raw.translation;
      await service.action(id,'correct-pair');const corrected=await settle(id);
      for(const format of ['plain','timed']){await service.action(id,'translate',{sourceKind:'corrected',format,languages:['en','ja'],expectedText:format==='plain'?corrected.correctedTranscript:service.exportText(id,'corrected-timed-txt')});await settle(id);}
      const t=service.get(id);return {status:t.status,original:t.transcript,originalSegments:t.segments,corrected:t.correctedTranscript,correctedSegments:t.correctedSegments,summary:t.summary,variants:t.translationVariants,stagedStart,srt:service.exportText(id,'variant-srt','en','corrected:timed:en')};
    }finally{await service.close();store.close();}
  },{output,config:snapshot.ai.text});
  Object.assign(result,response);assert.equal(response.status,'ready');assert.match(response.original,/整里/);assert.match(response.corrected,/整理/);assert.match(response.corrected,/提炼/);assert.equal(response.summary,'');assert.equal(response.stagedStart,true);
  const times=response.originalSegments.map(s=>[s.start,s.end]);assert.deepEqual(response.correctedSegments.map(s=>[s.start,s.end]),times);
  for(const lang of ['en','ja']){assert.ok(response.variants[`corrected:plain:${lang}`].text);assert.ok(!response.variants[`corrected:plain:${lang}`].text.includes('[00:'));assert.deepEqual(response.variants[`corrected:timed:${lang}`].segments.map(s=>[s.start,s.end]),times);}
  assert.match(response.variants['corrected:plain:en'].text,/[a-zA-Z]{3}/);assert.match(response.variants['corrected:plain:ja'].text,/[ぁ-ゖァ-ヺ]/);assert.match(response.srt,/00:00:01,234 --> 00:00:05,678/);assert.deepEqual(errors,[]);result.rendererErrors=errors;result.ok=true;
}catch(error){result.error=String(error.message);process.exitCode=1;console.log(result.error);}
finally{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));if(application)await application.close().catch(()=>{});console.log(JSON.stringify(result,null,2));}
