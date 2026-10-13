import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';import {_electron as electron} from 'playwright';
const require=createRequire(import.meta.url),root=process.cwd(),out=path.resolve('output/repair-081/ui-'+Date.now());fs.mkdirSync(out,{recursive:true});
const file=path.join(out,'original.mp4');execFileSync('bin/ffmpeg/ffmpeg.exe',['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',file],{windowsHide:true});
for(const key of Object.keys(process.env))if(/^(https?_proxy|all_proxy|no_proxy)$/i.test(key))delete process.env[key];process.env.NO_PROXY='127.0.0.1,localhost';
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(out,'profile')};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const result={scope:'actual React/Electron IPC and local MP4; AI response fixture, no paid request',cases:[],out,errors:[]};
async function launch(seed){app=await electron.launch({executablePath:require('electron'),args:[root,'--agent-data-dir',path.join(out,'profile')],env,timeout:20000});page=await Promise.race([app.firstWindow(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Test renderer did not appear in 20s')),20000))]);page.on('pageerror',e=>result.errors.push(e.message));await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();
 await app.evaluate((_,{file,seed})=>{const t=globalThis.fengshaTest;t.ai.config=kind=>kind==='image'?{hasKey:true,baseUrl:'https://cpa.fengsha.online/v1',model:'gpt-image-2.5-sunburst',timeout:30}:{hasKey:true,name:'fixture',model:'fixture',protocol:'chat',chunkChars:2000,outputTokens:8000,timeout:30};t.ai.chat=async(system,content,signal,onText)=>{signal?.throwIfAborted();let value;t.calls=(t.calls||[]);t.calls.push({system,content});
 if(system.includes('VIDEO_ARTICLE_FACT_AUDIT'))return JSON.stringify({faithful:true,issues:[]});
 if(system.includes('imagePrompt')&&system.includes('pages'))value=JSON.stringify({title:'机器人因果理解',pages:[{title:'开头',text:'机器人需要理解指令。',imagePrompt:'机器人接收人类指令的场景'},{title:'重点',text:'机器人遇到风险在0.2秒内停止。',imagePrompt:'安全暂停的机器人动作'},{title:'结尾',text:'原视频介绍了具身智能理解因果的能力。',imagePrompt:'因果关系的简洁示意'}],styleDescription:'科技信息图'});
 else{let data;try{data=JSON.parse(content);}catch{};value=data?.sourceText?JSON.stringify({title:'视频样本',body:data.sourceText,tags:''}):(data?.textToCorrect||data?.text||String(content)).replaceAll('0.02','0.2').replaceAll('英国智能','具身智能');}
 for(let end=4;end<value.length;end+=Math.max(4,Math.ceil(value.length/3))){signal?.throwIfAborted();onText?.(value.slice(0,end));await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,550);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('已停止处理'));},{once:true});});}signal?.throwIfAborted();onText?.(value);return value;};
 t.ai.fetch=async()=>{throw Error('unexpected paid request');};
 if(seed){const text='机器人需要理解指令。机器人遇到风险在0.02秒内停止。原视频介绍了英国智能理解因果的能力。';t.store.put('transcription','ui-tr',{id:'ui-tr',source:{kind:'file',file,ext:'mp4'},sourceFile:file,status:'ready',title:'视频样本',transcript:text,segments:[],correctedTranscript:'',mode:{correct:false},speech:{mode:'local',language:'zh'},progress:100});t.store.put('content-draft','ui-d',{id:'ui-d',source:{id:'ui-source',type:'video',platform:'本地视频',url:'',title:'视频样本'},original:{title:'视频样本',text,description:''},title:'视频样本',body:text,assets:[],assetOrder:[],revision:1,status:'draft',transcriptionId:'ui-tr',originalVideoFile:file});t.store.put('video-workflow','ui-v',{id:'ui-v',draftId:'ui-d',transcriptionId:'ui-tr',autoCorrect:false,createdAt:Date.now(),startedAt:1});t.store.flush();}
 },{file,seed});
 await page.locator('nav').getByRole('button',{name:'作品搜索与二创',exact:true}).click();await page.getByRole('tab',{name:'视频复刻',exact:true}).click();await page.getByLabel('视频任务',{exact:true}).selectOption('ui-v');await page.getByLabel('视频口播原文').waitFor();}
const video=()=>page.getByLabel('原视频播放',{exact:true});
const articleSettings=()=>page.getByRole('dialog',{name:'创作设置',exact:true});
async function openArticleSettings(){await page.getByRole('button',{name:'创作设置',exact:true}).click();await articleSettings().waitFor();return articleSettings();}
async function playable(){await page.waitForFunction(()=>{const v=document.querySelector('video[aria-label="原视频播放"]');return v?.readyState>=1&&v.duration>0&&!v.error;},{},{timeout:15000});await video().evaluate(async v=>{v.muted=true;await v.play();});await page.waitForFunction(()=>{const v=document.querySelector('video[aria-label="原视频播放"]');return v?.currentTime>0&&!v.paused;});}
try{
 await launch(true);await playable();const originalSrc=await video().getAttribute('src');await video().evaluate(v=>{window.originalPlayer=v;});
 await page.getByRole('button',{name:'仅 AI 校对',exact:true}).click();await page.getByRole('tab',{name:'AI 校对',exact:true}).waitFor();await page.waitForFunction(()=>{const box=document.querySelector('textarea[aria-label="视频校对文案"]');return !!box?.value&&!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('停止处理'));});result.cases.push('live correction appears before request completes and switches to correction tab');
 await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.includes('停止处理')));
 const candidate=await page.getByLabel('视频校对文案').inputValue();assert.ok(candidate.includes('0.2'));assert.ok(candidate.includes('具身智能'));assert.ok(!candidate.includes('0.02'));assert.equal((await page.evaluate(()=>window.fengsha.videoGet('ui-v'))).value.corrected,'');
 await page.getByRole('tab',{name:'二创文案',exact:true}).click();assert.equal(await page.getByLabel('视频二创依据').inputValue(),'corrected');assert.equal(await page.getByRole('button',{name:'仅优化视频文案',exact:true}).isDisabled(),true);result.cases.push('numeric correction collects a complete candidate; rewrite is gated until explicit acceptance');
 await page.getByRole('tab',{name:'AI 校对',exact:true}).click();await page.getByRole('button',{name:'核对并编辑完整候选',exact:true}).click();await page.getByRole('button',{name:'确认并保存校对稿',exact:true}).click();await page.getByRole('button',{name:'编辑校对稿',exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.fengsha.videoGet('ui-v'))).value.corrected,candidate);result.cases.push('confirmed numeric and homophone repairs save separately from raw ASR');
 await page.getByRole('tab',{name:'二创文案',exact:true}).click();await page.getByRole('button',{name:'仅优化视频文案',exact:true}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.includes('停止处理')));await playable();assert.equal(await video().getAttribute('src'),originalSrc);assert.equal(await video().evaluate(v=>v===window.originalPlayer),true);result.cases.push('correction and rewrite preserve the same original video URL/node and playback');
 await page.getByRole('tab',{name:'视频转图文',exact:true}).click();
 const creationDialog=await openArticleSettings();
 assert.equal(await creationDialog.getByLabel('生成图文配图',{exact:true}).isChecked(),false);
 assert.equal(await creationDialog.getByLabel('图文创作依据',{exact:true}).inputValue(),'corrected');
 await creationDialog.getByRole('button',{name:'赛博朋克',exact:true}).click();
 assert.equal(await creationDialog.getByRole('button',{name:'赛博朋克',exact:true}).getAttribute('aria-pressed'),'true');
 const cards=creationDialog.locator('.video-style-picker__card img');assert.equal(await cards.count(),8);
 assert.equal(await creationDialog.locator('.video-style-picker').getAttribute('data-media-preview'),'off');
 for(const card of await cards.all()){await card.scrollIntoViewIfNeeded();await card.evaluate(async img=>{await img.decode();if(img.naturalWidth<500)throw Error('missing style preview');});}
 result.cases.push('eight generated style assets load and preset selection is visually marked');
 await creationDialog.getByLabel('图文页数',{exact:true}).selectOption('3');
 await creationDialog.getByRole('button',{name:'确认应用',exact:true}).click();
 assert.equal(await articleSettings().count(),0);
 await page.getByRole('button',{name:'创作图文方案',exact:true}).click();
 await page.getByRole('button',{name:'打开图文成稿继续编辑与导出',exact:true}).waitFor({timeout:15000});
 assert.equal(await page.locator('.video-article-result .video-article-pages>article').count(),3);
 assert.equal(await page.locator('.video-article-result .video-article-pages img').count(),0);
 assert.ok((await page.getByLabel('图文配图生成状态',{exact:true}).innerText()).includes('关闭'));
 const afterCreationDialog=await openArticleSettings();
 assert.equal(await afterCreationDialog.getByLabel('生成图文配图',{exact:true}).isChecked(),false);
 assert.equal(await afterCreationDialog.getByLabel('图文创作依据',{exact:true}).inputValue(),'corrected');
 assert.equal(await afterCreationDialog.getByLabel('图文页数',{exact:true}).inputValue(),'3');
 assert.equal(await afterCreationDialog.getByRole('button',{name:'赛博朋克',exact:true}).getAttribute('aria-pressed'),'true');
 await afterCreationDialog.getByRole('button',{name:'取消',exact:true}).click();
 await playable();assert.equal(await video().getAttribute('src'),originalSrc);assert.equal(await video().evaluate(v=>v===window.originalPlayer),true);
 result.cases.push('video-to-article yields three readable pages, no automatic image request, original player survives');
 const calls=await app.evaluate(()=>globalThis.fengshaTest.calls);const rewrite=calls.map(c=>{try{return JSON.parse(c.content);}catch{return{};}}).find(c=>c.sourceText);assert.ok(rewrite.sourceText.includes('0.2')&&!rewrite.sourceText.includes('0.02'));const articleCall=calls.find(c=>c.system.includes('imagePrompt')&&c.system.includes('pages'));const material=JSON.parse(articleCall.content);assert.equal(material.reference,'corrected');assert.ok(material.style.includes('赛博朋克'));assert.ok(material.source.text.includes('0.2')&&!material.source.text.includes('0.02'));assert.equal(material.source.description,'');result.cases.push('actual rewrite/article IPC receive accepted correction, not raw ASR or stale description');
 const value=await page.evaluate(async()=>(await window.fengsha.videoGet('ui-v')).value);assert.ok(value.article.draftId);assert.notEqual(value.article.draftId,'ui-d');await page.screenshot({path:path.join(out,'video-to-article.png')});
 await page.getByRole('tab',{name:'AI 校对',exact:true}).click();await page.getByRole('button',{name:'编辑校对稿',exact:true}).click();await page.getByLabel('视频校对文案').fill(candidate+'。');await page.getByRole('tab',{name:'视频转图文',exact:true}).click();assert.equal(await page.getByRole('button',{name:'打开图文成稿继续编辑与导出',exact:true}).isDisabled(),true);await page.getByRole('tab',{name:'AI 校对',exact:true}).click();assert.equal(await page.getByLabel('视频校对文案').inputValue(),candidate+'。');await page.getByRole('button',{name:'取消编辑',exact:true}).click();await page.getByRole('tab',{name:'视频转图文',exact:true}).click();result.cases.push('unsaved correction cannot be discarded by opening a derived draft');
 await page.getByRole('button',{name:'打开图文成稿继续编辑与导出',exact:true}).click();await page.getByRole('heading',{name:'单篇克隆与二创',exact:true}).waitFor();const saved=(await page.evaluate(id=>window.fengsha.contentDraftGet(id),value.article.draftId)).value;assert.equal(saved.source.type,'image');assert.ok(saved.body.includes('机器人'));result.cases.push('derived image draft opens in image workbench without reprocessing original video');
 await app.close();app=null;await launch(false);await playable();await page.getByRole('tab',{name:'视频转图文',exact:true}).click();
 assert.equal(await page.locator('.video-article-result .video-article-pages>article').count(),3);
 const recoveredDialog=await openArticleSettings();
 assert.equal(await recoveredDialog.getByLabel('生成图文配图',{exact:true}).isChecked(),false);
 assert.equal(await recoveredDialog.getByLabel('图文创作依据',{exact:true}).inputValue(),'corrected');
 await recoveredDialog.getByRole('button',{name:'取消',exact:true}).click();
 result.cases.push('restart recovers article, original video and disabled automatic image switch');
 assert.deepEqual(result.errors,[]);result.ok=true;
}catch(e){result.error=e.stack;process.exitCode=1;if(page){result.visible=await page.locator('main').innerText().catch(()=> '');await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}}
finally{if(app)await Promise.race([app.close(),new Promise(resolve=>setTimeout(resolve,10000))]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
