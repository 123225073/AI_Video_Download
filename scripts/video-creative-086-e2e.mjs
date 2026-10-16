// Actual renderer + preload + IPC + workflow + SQLite + decoded local image.
// Platform/ASR/model responses are offline fixtures; no paid requests.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright';import {reloadTestRenderer} from './test-renderer.mjs';
const require=createRequire(import.meta.url),root=path.resolve('.'),out=path.join(root,'output','creative-086-'+Date.now()),profile=path.join(out,'profile'),file=path.join(out,'original.mp4');
fs.mkdirSync(out,{recursive:true});
execFileSync(path.join(root,'bin/ffmpeg/ffmpeg.exe'),['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=20','-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-c:a','aac',file],{windowsHide:true});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const result={out,isolated:true,cases:[],errors:[]};
const poll=async(fn,label)=>{for(let n=0;n<160;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
const button=name=>page.getByRole('button',{name,exact:true});
const tab=name=>page.getByRole('tab',{name,exact:true});
const get=()=>app.evaluate(()=>globalThis.fengshaTest.videoWorkflow.get('v'));
async function launch(seed=false){
  app=await electron.launch({executablePath:require('electron'),args:[root,'--agent-data-dir',profile],env});await reloadTestRenderer(app);page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>result.errors.push(e.message));
  await app.evaluate(async({nativeImage,session},{seed,file})=>{
    const t=globalThis.fengshaTest;
    session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('http://127.0.0.1:')&&!d.url.startsWith('fengsha-media:')&&!d.url.startsWith('file:')&&!d.url.startsWith('devtools:')}));
    const item={id:'111',key:'抖音:111',platform:'抖音',type:'video',url:'https://www.douyin.com/video/111',title:'离线示例视频',author:'示例作者',available:true,duration:2};
    if(seed){
      t.store.put('media','m',{...item,id:'m',sourceId:item.id,filePath:file,size:100,downloadedAt:Date.now()});
      t.store.put('creator','c',{id:'c',source:'https://www.douyin.com/user/fixture',creator:{id:'fixture',name:'示例作者',platform:'抖音',supported:true},items:[item],scanned:1,status:'complete',skipped:{},filters:{period:'all',limit:50,keyword:'',includeUnknown:true}});t.store.put('meta','lastCreator',{id:'c'});
      t.store.put('transcription','t',{id:'t',title:'示例图文任务',source:{kind:'file',file},sourceFile:file,status:'ready',transcript:'先明确目标，再使用工具。',correctedTranscript:'先明确目标，再使用工具。',segments:[]});
      t.store.put('content-draft','d',{id:'d',source:{...item,id:'article-source'},original:{title:'示例图文任务',text:'先明确目标，再使用工具。',images:[]},title:'示例图文任务',body:'先明确目标，再使用工具。',transcriptionId:'t',originalVideoFile:file,assets:[],assetOrder:[],revision:1,status:'draft',createdAt:Date.now()});
      t.store.put('video-workflow','v',{id:'v',draftId:'d',transcriptionId:'t',createdAt:Date.now(),autoCorrect:false});t.store.flush();
    }
    t.engine.parse=async()=>({platform:'抖音',title:item.title,url:item.url,items:[item],complete:true});
    t.engine.download=async()=>{throw Error('Unexpected download: local media must be reused');};
    t.transcriptions.options.localSpeech=async()=>({text:'先明确目标，再使用工具。',segments:[{start:0,end:2,text:'先明确目标，再使用工具。'}],language:'zh'});
    t.ai.config=kind=>kind==='image'?{baseUrl:'https://cpa.fengsha.online/v1',model:'gpt-image-2.5-sunburst',hasKey:true,timeout:30}:{hasKey:true,model:'fixture',protocol:'chat',supportsImages:false,mode:'local',localModel:'small',language:'zh'};
    t.ai.secret=()=> 'OFFLINE-TEST-ONLY';
    t.fixture={first:seed,writes:0,audits:0,images:0,failSecond:true,prompts:[]};
    const pages=['目标','做法','结尾'].map(title=>({title,text:'先明确目标，再使用工具。',imagePrompt:'用纸卡和实体工具表现主题，统一简洁插画'}));
    t.ai.chat=async(system,content,signal,onText)=>{
      const f=t.fixture;
      if(system.includes('VIDEO_ARTICLE_FACT_AUDIT')){f.audits++;return '{"faithful":true,"issues":[]}';}
      if(system.includes('VIDEO_ARTICLE_CONTINUE_PAGE')){f.writes++;const m=/本次仅补第(\d+)页/.exec(system);return JSON.stringify({page:pages[Number(m[1])-1],styleDescription:'蓝橙纸卡插画'});}
      if(system.includes('视频转图文编辑')){f.writes++;if(f.first){f.first=false;onText('{"title":"使用工具","pages":['+JSON.stringify(pages[0])+',{"title":"做法","text":"先明');throw Error('模型服务超时（离线故障注入）');}return JSON.stringify({title:'使用工具',pages,styleDescription:'蓝橙纸卡插画'});}
      const data=JSON.parse(content);return data.textToCorrect||'先明确目标，再使用工具。';
    };
    const png=nativeImage.createFromBitmap(Buffer.alloc(32*48*4,230),{width:32,height:48}).toPNG();
    t.ai.fetch=async(url,init)=>{if(!url.endsWith('/images/generations'))throw Error('Unexpected network request');const f=t.fixture;f.images++;f.prompts.push(JSON.parse(init.body).prompt);if(f.failSecond&&f.images===2)return new Response('{}',{status:503});return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));};
    t.win.webContents.send('fengsha:changed',t.snapshot());
  },{seed,file});
}
async function openArticle(){await page.locator('nav').getByRole('button',{name:'作品搜索与二创',exact:true}).click();await tab('视频复刻').click();await page.getByLabel('视频任务',{exact:true}).selectOption('v');await page.locator('.video-workbench[data-workflow-id="v"]').waitFor();await tab('视频转图文').click();}
try{
  await launch(true);await page.reload();await button('博主批量下载').click();await page.locator('.creator-item').waitFor();assert.equal(await page.locator('.creator-item').getByRole('button',{name:'语音识别',exact:true}).count(),1);
  await page.locator('.creator-item').getByRole('button',{name:'对标二创',exact:true}).click();await poll(()=>app.evaluate(()=>globalThis.fengshaTest.videoWorkflow.list().length===2),'creator routed to workflow');
  await poll(()=>app.evaluate(()=>!globalThis.fengshaTest.transcriptions.active),'ASR finished');
  const creatorId=await app.evaluate(()=>globalThis.fengshaTest.videoWorkflow.list().find(r=>r.id!=='v').id);
  await button('链接下载').click();await page.getByLabel('视频链接',{exact:true}).fill('https://www.douyin.com/video/111');await button('识别视频 / 合集').click();await button('查看内容').click();await button('对标二创').click();await poll(()=>page.getByLabel('视频任务',{exact:true}).inputValue().then(v=>v===creatorId),'link reuses creator task');
  assert.equal(await app.evaluate(()=>globalThis.fengshaTest.videoWorkflow.list().length),2);result.cases.push('creator + parsed link share workflow and local media without download');
  const previousRequest=await page.locator('.video-workbench').getAttribute('data-source-request');await button('媒体库').click();await button('对标二创').click();await poll(()=>page.getByLabel('视频任务',{exact:true}).inputValue().then(v=>v===creatorId),'media workflow');await poll(async()=>await page.locator('.video-workbench').getAttribute('data-source-request')!==previousRequest&&await page.getByLabel('视频任务',{exact:true}).isEnabled(),'media source request consumed');await page.waitForTimeout(1000);result.cases.push('media library reuses same workflow');
  await button('博主批量下载').click();await page.locator('.creator-item').getByRole('button',{name:'语音识别',exact:true}).click();await page.getByRole('heading',{name:'转录与翻译',exact:true}).waitFor();assert.equal(await app.evaluate(()=>globalThis.fengshaTest.videoWorkflow.list().length),2);result.cases.push('creator speech button opens the existing transcription');await button('作品搜索与二创').click();
  await page.getByLabel('视频任务',{exact:true}).selectOption('v');await page.locator('.video-workbench[data-workflow-id="v"]').waitFor();await tab('视频转图文').click();await button('创作图文方案').click();await poll(async()=>!!(await get()).article&&!(await get()).busy,'timeout automatically resumes saved article');assert.equal(await app.evaluate(()=>globalThis.fengshaTest.fixture.writes),3);assert.equal(await app.evaluate(()=>globalThis.fengshaTest.fixture.audits),1);assert.equal((await get()).article.pages.length,3);result.cases.push('timeout automatically fills only missing pages and validates without manual retry');
  await app.close();app=null;await launch();await openArticle();assert.equal((await get()).article.pages.length,3);result.cases.push('restart restores accepted article and detailed prompts');
  await tab('生图提示词').click();await page.getByLabel('第 1 页生图提示词',{exact:true}).waitFor();await page.getByLabel('整组统一画风',{exact:true}).fill('整组统一：蓝橙纸卡插画、米白背景、深蓝标题、自然柔光');
  await page.getByLabel('第 1 页生图提示词',{exact:true}).fill((await page.getByLabel('第 1 页生图提示词',{exact:true}).inputValue())+'\n用户修改：前景增加一本无字笔记本。');
  await tab('视频转图文').click();assert.equal(await button('创作图文方案').isDisabled(),true);await tab('生图提示词').click();assert.match(await page.getByLabel('第 1 页生图提示词',{exact:true}).inputValue(),/用户修改/);
  await button('保存生图提示词').click();await poll(()=>button('保存生图提示词').isDisabled(),'prompts saved');const edited=(await get()).article.pages[0].generationPrompt;result.cases.push('editable prompts + common style + dirty tab preservation');
  await page.getByRole('button',{name:/批量生成配图/}).click();await button('确认生成').click();await poll(async()=>!(await get()).busy&&(await get()).article.generatedCount===1,'image failed after checkpoint');assert.equal(await app.evaluate(()=>globalThis.fengshaTest.fixture.images),2);const firstImage=(await get()).article.pages[0].imageAssetId;
  await app.close();app=null;await launch();await openArticle();await tab('生图提示词').click();assert.equal(await page.getByLabel('第 1 页生图提示词',{exact:true}).inputValue(),edited);await app.evaluate(()=>globalThis.fengshaTest.fixture.failSecond=false);
  await page.getByRole('button',{name:/继续生成剩余/}).click();await button('确认生成').click();await poll(async()=>!(await get()).busy&&(await get()).article.generatedCount===3,'images complete');assert.equal(await app.evaluate(()=>globalThis.fengshaTest.fixture.images),2);assert.equal((await get()).article.pages[0].imageAssetId,firstImage);assert.equal((await get()).article.pages.every(p=>p.imageCurrent),true);result.cases.push('image failure + restart skips successful image and keeps edited prompts');
  const prompts=await app.evaluate(()=>globalThis.fengshaTest.fixture.prompts);assert.ok(prompts.every(p=>p.includes('蓝橙纸卡插画')));fs.writeFileSync(path.join(out,'prompts-and-images.png'),Buffer.from(await app.evaluate(async()=> (await globalThis.fengshaTest.win.webContents.capturePage()).toPNG().toString('base64')),'base64'));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1080,760));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);result.cases.push('small viewport no horizontal overflow');
  assert.deepEqual(result.errors,[]);result.ok=true;
}catch(e){result.error=e.stack;result.view=await page?.locator('.video-workbench').innerText().catch(()=>null);await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}finally{await app?.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
