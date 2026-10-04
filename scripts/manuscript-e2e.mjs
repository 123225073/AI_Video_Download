import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), root = path.resolve('.');
const output = path.join(root, 'output', `manuscript-e2e-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
let calls = 0; const requests = [];
const server = http.createServer(async (req,res) => {
  let body=''; for await (const part of req) body+=part;
  requests.push({route:req.url,authorized:req.headers.authorization==='Bearer SYNTHETIC-E2E-ONLY'});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/v1/models') return res.end(JSON.stringify({data:[{id:'fixture-text'},{id:'fixture-second'}]}));
  if(req.url==='/v1/chat/completions') {
    calls++; const parsed=JSON.parse(body), prompt=parsed.messages[0].content;
    let content='连接成功。';
    if(!prompt.includes('只回复')) {
      const input=JSON.parse(parsed.messages[1].content), correct=prompt.includes('文案校对员');
      const convert=text=>correct?text.replaceAll('整里','整理').replaceAll('提练','提炼'):prompt.includes('日语')?'動画の資料を整理し、重要なポイントをまとめます。3 つの手順を確認します。':'Organize the video materials and identify key ideas. Keep all 3 steps and the original source.';
      content=input.segments?JSON.stringify({segments:input.segments.map(s=>({id:s.id,text:convert(s.text)}))}):convert(input.textToTranslate || input.textToCorrect);
    }
    return res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));
  }
  res.statusCode=404;res.end('{}');
}); await new Promise(r=>server.listen(0,'127.0.0.1',r));
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile'),FENGSHA_TEST_VISIBLE:'1'};delete env.ELECTRON_RUN_AS_NODE;
let application;const errors=[],result={output,ok:false};
async function launch(){application=await electron.launch({executablePath:require('electron'),args:[root],env,timeout:60000});const page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();return page;}
async function read(id){return application.evaluate((_,id)=>globalThis.fengshaTest.transcriptions.get(id),id);}
async function settled(id){for(let i=0;i<900;i++){const t=await read(id);if(!['queued','preparing','subtitles','transcribing','correcting','translating'].includes(t.status))return t;await new Promise(r=>setTimeout(r,200));}throw Error('任务未结束');}
async function exportFile(page,name,file,expression){await application.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target});},path.join(output,file));await page.getByRole('button',{name,exact:true}).click();for(let i=0;i<40&&!fs.existsSync(path.join(output,file));i++)await new Promise(r=>setTimeout(r,100));assert.match(fs.readFileSync(path.join(output,file),'utf8'),expression);}
try {
  let page=await launch();await page.locator('nav').getByRole('button',{name:'转录与翻译',exact:true}).click();
  await page.getByRole('button',{name:'新建目录',exact:true}).click();await page.getByLabel('目录名称',{exact:true}).fill('读书分享');await page.getByRole('button',{name:'保存目录',exact:true}).click();await page.getByRole('button',{name:'重命名当前目录',exact:true}).waitFor();
  await page.getByRole('button',{name:'新建目录',exact:true}).click();await page.getByLabel('目录名称',{exact:true}).fill('心理成长');await page.getByRole('button',{name:'保存目录',exact:true}).click();await page.getByText('读书分享 / 心理成长',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('本次转录语言').inputValue(),'zh');await page.getByRole('button',{name:'本地文件 / 字幕',exact:true}).click();
  await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'output/reference/speech-fixture.wav'));
  await page.getByRole('button',{name:'选择文件',exact:true}).click();await page.getByRole('button',{name:'开始转录',exact:true}).click();
  const speechId=await application.evaluate(()=>globalThis.fengshaTest.snapshot().transcriptions[0].id);let t=await settled(speechId);assert.equal(t.status,'ready');assert.match(t.transcript,/文字|观点|知识/);assert.ok(t.segments.length);assert.equal(t.correctedTranscript,'');assert.equal(calls,0);result.realLocalSpeech=true;
  const subtitle=path.join(output,'字幕核对.srt');fs.writeFileSync(subtitle,'1\n00:00:01,234 --> 00:00:05,678\n今天学习如何整里视频资料，首先把视频转成文字。\n\n2\n00:00:06,789 --> 00:00:11,012\n然后提练关键观点。全过程分成 3 步，原始素材必须保留。\n');
  await page.getByRole('button',{name:'新建转录',exact:true}).click();await page.getByRole('button',{name:'本地文件 / 字幕',exact:true}).click();await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},subtitle);await page.getByRole('button',{name:'选择文件',exact:true}).click();await page.getByRole('button',{name:'开始转录',exact:true}).click();
  const id=await application.evaluate(()=>globalThis.fengshaTest.snapshot().transcriptions[0].id);t=await settled(id);assert.equal(t.status,'ready');assert.equal(t.segments.length,2);assert.ok(t.folderId);
  await page.getByRole('heading',{name:'原文 · 不带时间戳',exact:true}).waitFor();const before=await page.locator('.comparison-grid>section').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})));assert.equal(before[0].y,before[1].y);assert.ok(before[1].x>before[0].x);assert.equal(before[0].x,before[2].x);assert.ok(before[2].y>before[0].y);assert.equal(await page.getByText('我的笔记',{exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'内容摘要',exact:true}).count(),0);result.layoutOrder=true;
  await page.locator('main').getByRole('button',{name:'AI 模型设置',exact:true}).click();await page.getByLabel('文本服务地址').fill(`http://127.0.0.1:${server.address().port}/v1`);await page.getByLabel('文本 API 密钥').fill('SYNTHETIC-E2E-ONLY');await page.getByRole('button',{name:'保存并读取模型',exact:true}).click();await page.getByText(/读取到 2 个模型/).waitFor();assert.equal(await page.getByLabel('文本 API 密钥').inputValue(),'');await page.getByLabel('AI 矫正与翻译模型').fill('fixture-text');await page.getByRole('button',{name:'保存并测试文本连接',exact:true}).click();await page.getByText(/文本连接成功/).waitFor();await page.getByRole('button',{name:'去转录与翻译',exact:true}).click();await page.getByRole('button',{name:'打开文案：字幕核对.srt',exact:true}).click();
  await page.getByRole('button',{name:'AI 矫正',exact:true}).click();t=await settled(id);assert.equal(t.status,'ready',t.message);assert.match(t.correctedTranscript,/整理/);assert.match(t.correctedTranscript,/提炼/);assert.deepEqual(t.correctedSegments.map(s=>[s.start,s.end]),t.segments.map(s=>[s.start,s.end]));assert.equal(t.summary,'');result.correctedPair=true;
  await page.getByRole('button',{name:'AI 矫正已完成',exact:true}).waitFor();await page.screenshot({path:path.join(output,'01-文案上下与矫正并排.png')});
  await exportFile(page,'导出带时间戳矫正文案 SRT','corrected.srt',/00:00:01,234 --> 00:00:05,678/);
  await page.getByRole('button',{name:'多语言翻译',exact:true}).click();assert.equal(await page.getByLabel('翻译文案来源').inputValue(),'corrected');await page.getByRole('checkbox',{name:'翻译为日语',exact:true}).check();await page.getByRole('button',{name:'AI 翻译（2）',exact:true}).click();t=await settled(id);assert.equal(t.status,'ready',t.message);assert.equal(t.translationVariants['corrected:plain:en'].segments,null);assert.ok(!t.translationVariants['corrected:plain:en'].text.includes('[00:'));await page.getByRole('button',{name:'复制日语译文',exact:true}).waitFor();await page.screenshot({path:path.join(output,'02-纯文本多语言并排.png')});
  await page.getByRole('button',{name:'带时间戳',exact:true}).click();await page.getByRole('button',{name:'AI 翻译（2）',exact:true}).click();t=await settled(id);assert.equal(t.status,'ready',t.message);for(const lang of ['en','ja'])assert.deepEqual(t.translationVariants[`corrected:timed:${lang}`].segments.map(s=>[s.start,s.end]),t.segments.map(s=>[s.start,s.end]));assert.equal(Object.keys(t.translationVariants).length,4);result.multiLanguageFormat=true;
  await page.getByRole('button',{name:'导出英语译文 SRT',exact:true}).waitFor();await exportFile(page,'导出英语译文 SRT','english.srt',/00:00:06,789 --> 00:00:11,012/);await exportFile(page,'导出日语译文 TXT','japanese.txt',/\[00:00:01\]/);await exportFile(page,'导出全部','all.md',/英语译文 · AI 矫正文案 · 带时间戳/);const md=fs.readFileSync(path.join(output,'all.md'),'utf8');assert.match(md,/AI 矫正 · 带时间戳/);assert.ok(!md.includes('未生成摘要'));result.exports=true;
  await page.screenshot({path:path.join(output,'03-时间戳多语言并排.png')});await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1080,720));await page.waitForTimeout(300);await page.screenshot({path:path.join(output,'04-小窗口翻译.png')});await page.getByRole('button',{name:'文案对照',exact:true}).click();await page.screenshot({path:path.join(output,'05-小窗口文案对照.png')});const small=await page.evaluate(()=>({viewport:[innerWidth,innerHeight],body:[document.body.scrollWidth,document.body.scrollHeight],panes:[...document.querySelectorAll('.comparison-grid>section')].map(n=>({bottom:n.getBoundingClientRect().bottom,height:n.clientHeight}))}));assert.ok(small.body[0]<=small.viewport[0]);assert.ok(small.body[1]<=small.viewport[1]);assert.ok(small.panes.every(p=>p.height>100&&p.bottom<small.viewport[1]));result.smallWindow=small;
  await page.getByRole('button',{name:'修改文案标题',exact:true}).click();await page.getByLabel('文案标题',{exact:true}).fill('心理成长 · 文案对照样本');await page.getByRole('button',{name:'保存文案标题',exact:true}).click();await page.getByRole('heading',{name:'心理成长 · 文案对照样本',exact:true}).waitFor();
  await page.getByLabel('所属目录').selectOption('');await page.getByRole('button',{name:/^未分类/}).click();await page.getByRole('button',{name:'打开文案：心理成长 · 文案对照样本',exact:true}).waitFor();const folders=await application.evaluate(()=>globalThis.fengshaTest.snapshot().transcriptionFolders);await page.getByLabel('所属目录').selectOption(folders.find(f=>f.name==='心理成长').id);result.folders=true;
  const snapshot=await application.evaluate(()=>globalThis.fengshaTest.snapshot());assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC-E2E-ONLY'));assert.ok(!fs.readFileSync(path.join(output,'profile/library.sqlite')).includes(Buffer.from('SYNTHETIC-E2E-ONLY')));result.secretIsolation=true;
  await application.close();page=await launch();await page.locator('nav').getByRole('button',{name:'转录与翻译',exact:true}).click();await page.getByLabel('搜索文案').fill('整理');await page.getByRole('button',{name:'打开文案：心理成长 · 文案对照样本',exact:true}).click();await page.getByRole('button',{name:'AI 矫正已完成',exact:true}).waitFor();await page.getByRole('button',{name:'多语言翻译',exact:true}).click();await page.getByRole('button',{name:'复制日语译文',exact:true}).waitFor();assert.equal(await page.getByLabel('翻译文案来源').inputValue(),'corrected');assert.ok(await page.getByRole('checkbox',{name:'翻译为日语',exact:true}).isChecked());assert.equal(await page.getByRole('button',{name:'导出英语译文 SRT',exact:true}).count(),1);result.restart=true;
  assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.authorized));result.modelCalls=calls;result.rendererErrors=errors;result.ok=true;
}catch(e){result.error=String(e.stack||e);process.exitCode=1;console.log(result.error);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));if(application)await (await application.firstWindow()).screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{if(application)await application.close().catch(()=>{});server.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
