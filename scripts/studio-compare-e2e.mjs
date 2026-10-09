import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright';
import {reloadTestRenderer} from './test-renderer.mjs';

// Run after building the renderer: node scripts/studio-compare-e2e.mjs
// --red-only records the old UI contract failure, with a nonzero exit status.
// Only output/studio-compare-* and its own disposable profile are written.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'output',`studio-compare-${Date.now()}-${process.pid}`);
const profile=path.join(output,'profile');
const redOnly=process.argv.includes('--red-only');
const source={title:'原稿：社区阅读角开放指南',body:'社区阅读角每周六下午开放，每次限六人。\n请提前预约，携带自己的书。\n这两张原图分别记录入口与座位。'};
const rewritten={title:'周六下午，一起到阅读角读书',body:'想安排一个安静的周六下午？\n社区阅读角每周六下午开放，每次限六人。\n提前预约、带上自己的书，选一个位置开始阅读。',tags:'#阅读角 #周末阅读'};
const wholeDirection='改为面向初学者的暖色手绘阅读指南；保留来源媒体logo、账号署名和水印';
const imageDirection='改为蓝绿色扁平插画，突出六个座位；保留来源媒体logo和账号署名';
const result={output,profile,mode:redOnly?'red-only':'full',isolated:true,mockOnly:true,checks:[]};
const errors=[];
let app,page;
fs.mkdirSync(output,{recursive:true});

async function bounded(promise,label,ms=15000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} timed out (${ms}ms)`)),ms);})]);}
  finally{clearTimeout(timer);}
}
async function capture(name){
  // Native capture can otherwise return the preceding compositor frame after a
  // scroll/resize. Wait for paint without using Playwright's hanging screenshot.
  if(page){await bounded(page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))),'paint before native capture');await page.waitForTimeout(80);}
  const bytes=await bounded(app.evaluate(async()=> (await globalThis.fengshaTest.win.webContents.capturePage()).toPNG().toString('base64')),'native capture');
  fs.writeFileSync(path.join(output,name),Buffer.from(bytes,'base64'));
}
function checked(name){result.checks.push(name);console.log(`PASS ${name}`);}
async function release(name){await app.evaluate((_e,name)=>globalThis.fengshaTest.compareFixture.release(name),name);}
async function waitGate(name){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(await app.evaluate((_e,name)=>globalThis.fengshaTest.compareFixture.waiting.has(name),name))return;await new Promise(resolve=>setTimeout(resolve,40));}
  throw Error(`gate ${name} timed out`);
}
async function current(){return app.evaluate(()=>{const t=globalThis.fengshaTest;return t.contentStudio.get(t.store.get('meta','lastContentDraft').id);});}
async function idle(){
  await page.waitForFunction(()=>{const body=document.querySelector('[aria-label="克隆稿正文"]');return body&&!body.disabled&&!document.querySelector('.studio-progress.is-running');});
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(!await app.evaluate(()=>globalThis.fengshaTest.contentStudio.progress()?.running))return;await new Promise(resolve=>setTimeout(resolve,40));}
  throw Error('studio idle timed out');
}
async function originalCopy(){
  for(const [label,value] of [['原标题',source.title],['原文案',source.body]]){
    const field=page.getByLabel(label,{exact:true});assert.equal(await field.isVisible(),true,`${label} must remain visible`);
    assert.equal(await field.inputValue(),value);assert.equal(await field.getAttribute('readonly'),'');
    assert.equal(await field.evaluate(e=>!!e.closest('details')),false,`${label} must not be hidden in a disclosure`);
  }
}
async function uiPairs(){
  return page.locator('.compare-image-pair').evaluateAll(rows=>rows.map(row=>{
    const original=row.querySelector('.compare-original-image img'),output=row.querySelector('.compare-output-image > img');
    const id=img=>img?new URL(img.src).pathname.split('/').at(-1):null;
    return {originalId:id(original),outputId:id(output),originalLoaded:!!original&&original.complete&&original.naturalWidth>0,outputLoaded:!!output&&output.complete&&output.naturalWidth>0};
  }));
}
function rootOf(d,asset){
  const seen=new Set();while(asset&&!['original','imported'].includes(asset.origin)){assert.ok(!seen.has(asset.id),'cyclic original lineage');seen.add(asset.id);asset=d.assets.find(a=>a.id===asset.originalAssetId);}return asset;
}
async function paired(d){
  d??=await current();
  const expected=d.assetOrder.map(id=>{const a=d.assets.find(a=>a.id===id);return {originalId:rootOf(d,a)?.id||null,outputId:a.origin==='original'?null:a.id};});
  for(const original of d.assets.filter(a=>a.origin==='original'))if(!expected.some(p=>p.originalId===original.id))expected.push({originalId:original.id,outputId:null});
  await page.waitForFunction(expected=>{
    const rows=[...document.querySelectorAll('.compare-image-pair')];
    const id=img=>img?new URL(img.src).pathname.split('/').at(-1):null;
    return rows.length===expected.length&&rows.every((row,i)=>{
      const original=row.querySelector('.compare-original-image img'),output=row.querySelector('.compare-output-image > img');
      return id(original)===expected[i].originalId&&id(output)===expected[i].outputId&&(!original||original.complete&&original.naturalWidth>0)&&(!output||output.complete&&output.naturalWidth>0);
    });
  },expected);
  assert.deepEqual((await uiPairs()).map(({originalId,outputId})=>({originalId,outputId})),expected);
}
async function originalsIntact(originalAssets){
  const d=await current();assert.deepEqual(d.original,{title:source.title,text:source.body,images:d.source.images});
  for(const asset of originalAssets){const stored=d.assets.find(a=>a.id===asset.id);assert.ok(stored);assert.equal(stored.origin,'original');assert.equal(stored.file,asset.file);assert.equal(fs.readFileSync(stored.file).toString('base64'),asset.bytes);}
  await originalCopy();await paired(d);
}
function policyPrompt(prompt,direction){
  for(const phrase of direction.split('；')[0].split(/[，,]/))assert.ok(prompt.includes(phrase),'Actual multipart prompt must preserve each compatible style/detail direction');
  // Semantic guardrails, deliberately not a byte-exact policy/prompt snapshot.
  assert.match(prompt,/logo/i);assert.match(prompt,/水印/);assert.match(prompt,/署名|账号/);
  assert.match(prompt,/全新|原创|重新设计/);assert.match(prompt,/最高优先级|不可覆盖|不能覆盖|不得覆盖/);
  assert.match(prompt,/(?:不|禁止|不得|去除|排除|避免)[^。\n]{0,160}(?:logo|Logo|署名|账号|水印)/);
  assert.notEqual(prompt,direction,'User instruction must not replace the mandatory image policy');
}
async function visiblePairsInViewport(){
  for(const original of await page.locator('.compare-original-image img').all()){
    await original.scrollIntoViewIfNeeded();assert.equal(await original.isVisible(),true);
    assert.equal(await original.evaluate(e=>e.complete&&e.naturalWidth>0),true);
  }
}
async function assertLayout(){
  const layout=await page.evaluate(()=>{
    const original=document.querySelector('[aria-label="原文案"]').getBoundingClientRect(),copy=document.querySelector('[aria-label="克隆稿正文"]').getBoundingClientRect();
    const rows=[...document.querySelectorAll('.compare-image-pair')].map(row=>{
      const a=row.querySelector('.compare-original-image').getBoundingClientRect(),b=row.querySelector('.compare-output-image').getBoundingClientRect();
      return {sideBySide:a.right<=b.left+1,aligned:Math.abs(a.top-b.top)<2,fits:b.right<=innerWidth+1};
    });
    return {viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth,main:document.querySelector('.main')?{client:document.querySelector('.main').clientWidth,scroll:document.querySelector('.main').scrollWidth}:null,copySideBySide:original.right<=copy.left+1,copyAligned:Math.abs(original.top-copy.top)<2,rows};
  });
  assert.ok(layout.document<=layout.viewport+1,JSON.stringify(layout));assert.ok(layout.body<=layout.viewport+1,JSON.stringify(layout));
  if(layout.main)assert.ok(layout.main.scroll<=layout.main.client+1,JSON.stringify(layout));
  assert.ok(layout.copySideBySide&&layout.copyAligned,'Original and rewritten copy must be side by side');
  assert.ok(layout.rows.length===2&&layout.rows.every(r=>r.sideBySide&&r.aligned&&r.fits),JSON.stringify(layout));return layout;
}

async function installFixture(restoring=false){
  await app.evaluate(async({app:electronApp,session,nativeImage,ipcMain},params)=>{
    const t=globalThis.fengshaTest;
    if(electronApp.getPath('userData')!==params.profile)throw Error('The test is not using its isolated profile');
    const controller=new AbortController(),gates=new Map(),waiting=new Set(),pending=new Set();
    const f=t.compareFixture={controller,gates,waiting,pending,textRequests:[],imageRequests:[],originalRequests:[],blocked:[],aborted:[],timers:new Set()};
    function gate(name,signal){
      if(!signal)throw Error(`Missing AbortSignal at ${name}`);
      signal=AbortSignal.any([signal,controller.signal]);signal.throwIfAborted();
      waiting.add(name);
      const promise=new Promise((resolve,reject)=>{
        const finish=error=>{signal.removeEventListener('abort',abort);waiting.delete(name);gates.delete(name);error?reject(error):resolve();};
        const abort=()=>{f.aborted.push(name);finish(signal.reason||Error('Fixture aborted'));};
        gates.set(name,()=>finish());signal.addEventListener('abort',abort,{once:true});
      });
      pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;
    }
    f.release=name=>gates.get(name)?.();
    f.cleanup=async()=>{
      controller.abort(Error('Fixture teardown'));t.contentStudio.cancel();
      for(const timer of f.timers)clearTimeout(timer);f.timers.clear();
      // All synthetic transports observe abort before release; no hung fetch survives.
      for(const release of [...gates.values()])release();
      await Promise.allSettled([...pending]);
      return {pending:pending.size,waiting:waiting.size,timers:f.timers.size,aborted:f.aborted};
    };
    globalThis.fetch=async url=>{f.blocked.push(String(url));throw Error('Unexpected external fetch blocked by Studio fixture');};
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
      const u=new URL(details.url),allow=['file:','data:','blob:','fengsha-media:','devtools:'].includes(u.protocol)||u.hostname==='127.0.0.1';
      if(!allow)f.blocked.push(details.url);callback({cancel:!allow});
    });
    for(const method of ['open','fill','submit'])t.contentPublisher[method]=async()=>{throw Error('Platform publishing is forbidden in this test');};
    t.contentSearch.browser.detail=async()=>{throw Error('Platform lookup is forbidden; fixture has the complete body');};
    const png=color=>{const bitmap=Buffer.alloc(48*64*4);for(let i=0;i<bitmap.length;i+=4){bitmap[i]=color[0];bitmap[i+1]=color[1];bitmap[i+2]=color[2];bitmap[i+3]=255;}return nativeImage.createFromBitmap(bitmap,{width:48,height:64}).toPNG();};
    const originals=[png([40,100,220]),png([180,90,30])],generated=[png([90,210,80]),png([190,50,180]),png([220,190,30]),png([100,220,240])];
    f.originalPngs=originals.map(b=>b.toString('base64'));
    const id='abcdefabcdefabcdefabcdef',urls=['https://sns-webpic.xhscdn.com/studio-compare-original-1.png','https://sns-webpic.xhscdn.com/studio-compare-original-2.png'];
    const item={id,platform:'小红书',key:`小红书:${id}`,title:params.source.title,author:'隔离测试作者',url:`https://www.xiaohongshu.com/explore/${id}?xsec_token=fixture`,type:'image',text:params.source.body,bodyComplete:true,images:urls,publishedAt:'2026-10-01'};
    if(!params.restoring){
    t.contentSearch.record={id:'studio-compare-record',platform:'小红书',keyword:'阅读角fixture',options:{limit:50,from:'2026-09-09',to:'2026-10-09'},all:[item],scanned:1,status:'ready',accountId:null};
    t.store.put('content-search',t.contentSearch.record.id,t.contentSearch.record);t.store.put('meta','lastContentSearch',{id:t.contentSearch.record.id});
    // These are deliberately synthetic, never the user's stored model credentials.
    t.ai.save('text',{baseUrl:'https://cpa.fengsha.online/v1',model:'studio-compare-text-fixture',apiKey:'SYNTHETIC-STUDIO-COMPARE-KEY',protocol:'chat'});
    t.ai.save('image',{baseUrl:'https://cpa.fengsha.online/v1',model:'gpt-image-2.5-sunburst',apiKey:'SYNTHETIC-STUDIO-COMPARE-KEY'});
    }
    let stale=false;
    ipcMain.removeHandler('fengsha:content-draft-get');
    ipcMain.handle('fengsha:content-draft-get',async(_event,id)=>{
      const value=t.contentStudio.get(id);
      if(!params.restoring&&!stale){stale=true;value.revision=1;value.assets=[];value.assetOrder=[];if(value.assetPairs)value.assetPairs=[];await gate('stale-draft-get',controller.signal);}
      return {ok:true,value};
    });
    t.contentStudio.fetcher=async(url,options={})=>{
      const signal=options.signal;if(!signal)throw Error('Missing transport AbortSignal');signal.throwIfAborted();controller.signal.throwIfAborted();
      const index=urls.indexOf(String(url));
      if(index>=0){f.originalRequests.push(String(url));if(index===1)await gate('original-2',signal);return new Response(originals[index],{headers:{'content-type':'image/png'}});}
      if(String(url)!=='https://cpa.fengsha.online/v1/images/edits')throw Error(`Unexpected image request ${url}`);
      if(!(options.body instanceof FormData))throw Error('Images Edits must use multipart FormData');
      const form=options.body,n=f.imageRequests.length+1;
      f.imageRequests.push({url:String(url),model:form.get('model'),prompt:form.get('prompt'),outputFormat:form.get('output_format'),imageType:form.get('image')?.type,image:Buffer.from(await form.get('image').arrayBuffer()).toString('base64')});
      if(n===2)await gate('image-2',signal);
      if(f.holdNextImage){f.holdNextImage=false;await gate('cancel-image',signal);}
      signal.throwIfAborted();controller.signal.throwIfAborted();
      return new Response(JSON.stringify({data:[{b64_json:generated[(n-1)%generated.length].toString('base64')}]}),{headers:{'content-type':'application/json'}});
    };
    t.ai.fetch=async(url,options)=>{
      if(String(url)!=='https://cpa.fengsha.online/v1/chat/completions')throw Error('Unexpected text endpoint');
      const body=JSON.parse(options.body);if(body.stream!==true)throw Error('SSE streaming was not requested');
      if(!options.signal)throw Error('Missing text AbortSignal');
      f.textRequests.push({url:String(url),body});
      const signal=AbortSignal.any([options.signal,controller.signal]);signal.throwIfAborted();
      let timer,stop;
      return new Response(new ReadableStream({
        start(stream){
          let done=false,index=0;const pieces=JSON.stringify(params.rewritten).match(/[\s\S]{1,7}/g),encoder=new TextEncoder();
          const send=value=>stream.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          const cleanup=()=>{if(timer){clearTimeout(timer);f.timers.delete(timer);}signal.removeEventListener('abort',abort);};
          const abort=()=>{if(done)return;done=true;f.aborted.push('text-stream');cleanup();try{stream.error(signal.reason);}catch{}};
          stop=abort;signal.addEventListener('abort',abort,{once:true});
          const pump=async()=>{
            try{
              signal.throwIfAborted();send({choices:[{index:0,delta:{content:pieces[index++]},finish_reason:null}]});
              if(index<pieces.length){timer=setTimeout(()=>{f.timers.delete(timer);void pump();},30);f.timers.add(timer);}
              else{await gate('text-eof',signal);signal.throwIfAborted();if(done)return;send({choices:[{index:0,delta:{},finish_reason:'stop'}]});stream.enqueue(encoder.encode('data: [DONE]\n\n'));done=true;cleanup();stream.close();}
            }catch(error){if(!done){done=true;cleanup();try{stream.error(error);}catch{}}}
          };void pump();
        },cancel(){stop?.();}
      }),{headers:{'content-type':'text/event-stream'}});
    };
    t.store.flush();t.contentStudio.changed();
  },{profile,source,rewritten,restoring});
}

async function loadRenderer(){
  if(!redOnly){await reloadTestRenderer(app);return;}
  // Concurrent UI work can rebuild dist before the red run. Build the committed
  // pre-change ContentPage in our own output, without touching the live checkout.
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const oldPage=execFileSync('git',['show',`${revision}:src/ContentPage.jsx`],{cwd:root,encoding:'utf8'});
  const {build}=await import('vite');const rendererRoot=path.join(output,'old-renderer');
  await build({root,logLevel:'warn',plugins:[{name:'studio-compare-old-ui',enforce:'pre',load(id){if(id.replaceAll('\\','/').split('?')[0]===path.join(root,'src','ContentPage.jsx').replaceAll('\\','/'))return oldPage;}}],build:{outDir:path.join(rendererRoot,'dist'),emptyOutDir:true}});
  result.redRenderer={revision,source:'committed src/ContentPage.jsx',isolatedOutput:rendererRoot};
  const previous=process.cwd();
  try{process.chdir(rendererRoot);await reloadTestRenderer(app);}finally{process.chdir(previous);}
}

try{
  const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_VISIBLE:'1',FENGSHA_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[root],env,timeout:45000});
  await loadRenderer();page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await installFixture();
  await page.getByRole('button',{name:'作品搜索与二创',exact:true}).click();
  await page.getByLabel('克隆后自动二创',{exact:true}).uncheck();
  await page.getByRole('button',{name:'一键克隆',exact:true}).click();
  await page.getByText('独立二创工作台',{exact:true}).waitFor();
  await waitGate('original-2');await page.getByLabel('克隆稿正文',{exact:true}).waitFor();
  assert.equal(await page.locator('.content-search-view').isVisible(),false);
  assert.equal((await current()).body,source.body);
  if(!redOnly){
    await originalCopy();await page.waitForFunction(()=>document.querySelector('.compare-original-image img')?.naturalWidth>0);
    assert.equal(await page.locator('.compare-image-pair').count(),1);assert.equal(await page.getByLabel('克隆稿正文',{exact:true}).isDisabled(),true);
    const before=await page.getByTestId('studio-elapsed').textContent();await page.waitForFunction(before=>document.querySelector('[data-testid="studio-elapsed"]').textContent!==before,before);
    await capture('original-stream-progress.png');checked('clone-streams-originals-and-live-elapsed-progress');
  }
  await release('original-2');await idle();await release('stale-draft-get');
  // A late revision-1 IPC response must not erase either original image.
  await page.waitForTimeout(250);
  const baseline=await page.evaluate(()=>({
    originalTitle:!!document.querySelector('[aria-label="原标题"]'),originalBody:!!document.querySelector('[aria-label="原文案"]'),
    comparison:document.querySelectorAll('.studio-comparison').length,pairs:document.querySelectorAll('.compare-image-pair').length,
    originalDisclosure:[...document.querySelectorAll('details')].filter(e=>e.textContent.includes('核对原始内容')).map(e=>({open:e.open,body:e.textContent})),
    configurationLink:[...document.querySelectorAll('button,a')].some(e=>/配置.*GPT.*图片服务/.test(e.textContent))
  }));
  result.baseline=baseline;await capture(redOnly?'red-old-studio.png':'initial-studio.png');
  assert.ok(baseline.originalTitle&&baseline.originalBody&&baseline.comparison>0,
    `RED: 原标题/原正文没有常驻并排展示。${JSON.stringify(baseline)}`);
  if(redOnly)throw Error('--red-only expected the old interface, but the comparison contract is already present');
  checked('original-title-body-comparison-contract');
  await originalCopy();await paired();await assertLayout();
  assert.equal(baseline.pairs,2);assert.equal(baseline.configurationLink,false,'Remove the GPT image configuration link from Studio');
  const initial=await current(),originalAssets=initial.assets.filter(a=>a.origin==='original').map(a=>({...a,bytes:fs.readFileSync(a.file).toString('base64')}));
  assert.equal(originalAssets.length,2);assert.notEqual(originalAssets[0].bytes,originalAssets[1].bytes,'Use two distinguishable original PNGs');
  let transport=await app.evaluate(()=>{const f=globalThis.fengshaTest.compareFixture;return {text:f.textRequests,image:f.imageRequests};});
  assert.equal(transport.text.length,0);assert.equal(transport.image.length,0);checked('manual-clone-keeps-originals-and-does-not-auto-create');
  assert.equal(await page.getByLabel('整篇二创要求',{exact:true}).inputValue(),'');
  assert.equal(await page.getByLabel('图片二创要求',{exact:true}).inputValue(),'');
  const start=page.getByRole('button',{name:'整篇 AI 二创',exact:true});assert.equal(await start.isDisabled(),true);
  for(const button of await page.getByRole('button',{name:'AI 修改此图',exact:true}).all())assert.equal(await button.isDisabled(),true);
  await page.getByLabel('整篇二创要求',{exact:true}).fill('   ');assert.equal(await start.isDisabled(),true);
  await page.getByLabel('图片二创要求',{exact:true}).fill('   ');
  for(const button of await page.getByRole('button',{name:'AI 修改此图',exact:true}).all())assert.equal(await button.isDisabled(),true);
  // The direction form must precede copy/images in normal document flow.
  assert.equal(await page.evaluate(()=>!!(document.querySelector('[aria-label="整篇二创要求"]').compareDocumentPosition(document.querySelector('[aria-label="原文案"]'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  checked('top-direction-required-empty-and-whitespace-block-start');

  await page.getByLabel('图片二创要求',{exact:true}).fill('');
  await page.getByLabel('整篇二创要求',{exact:true}).fill(wholeDirection);assert.equal(await start.isDisabled(),false);await start.click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="克隆稿正文"]').value.includes('想安排一个安静'));
  assert.equal(await page.getByLabel('克隆稿正文',{exact:true}).isDisabled(),true);
  assert.equal((await current()).body,source.body,'SSE preview must not commit an unfinished body');
  await originalCopy();await paired();await capture('text-sse-preview.png');checked('sse-copy-preview-with-originals-still-visible');
  await waitGate('text-eof');
  assert.equal(await page.getByLabel('克隆稿正文',{exact:true}).inputValue(),rewritten.body);
  assert.equal((await current()).body,source.body,'Even all content is preview until SSE finish/DONE');
  transport=await app.evaluate(()=>{const f=globalThis.fengshaTest.compareFixture;return {text:f.textRequests,image:f.imageRequests};});
  assert.equal(transport.text.length,1);assert.ok(JSON.stringify(transport.text[0].body).includes(wholeDirection));
  const textUser=transport.text[0].body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
  const submittedSource=JSON.parse(textUser);assert.equal(submittedSource.sourceTitle,source.title);assert.equal(submittedSource.sourceText,source.body);
  await release('text-eof');await waitGate('image-2');
  const firstGenerated=await current();assert.equal(firstGenerated.assets.filter(a=>a.origin==='generated').length,1);
  assert.equal(firstGenerated.assetOrder[1],originalAssets[1].id);
  await originalsIntact(originalAssets);assert.equal(await page.locator('.compare-output-image > img').count(),1);
  await visiblePairsInViewport();await capture('first-image-second-original-visible.png');
  checked('first-generated-image-streams-while-second-original-remains-viewable');
  await release('image-2');await idle();await paired();
  const whole=await current();assert.equal(whole.title,rewritten.title);assert.equal(whole.body,rewritten.body);
  assert.equal(await page.getByLabel('克隆稿标题',{exact:true}).inputValue(),rewritten.title);
  assert.equal(await page.locator('.compare-output-image > img').count(),2);await originalsIntact(originalAssets);
  transport=await app.evaluate(()=>{const f=globalThis.fengshaTest.compareFixture;return {text:f.textRequests,image:f.imageRequests};});
  assert.equal(transport.image.length,2);
  for(const [index,request] of transport.image.entries()){
    assert.match(request.model,/gpt-image(?:[-_. ]?)2[._-]5/i);assert.equal(request.outputFormat,'png');assert.equal(request.imageType,'image/png');
    assert.equal(request.image,originalAssets[index].bytes);policyPrompt(request.prompt,wholeDirection);
  }
  await capture('whole-remix-completed.png');checked('whole-remix-real-sse-and-gpt-image-2.5-edits-contract');

  // Fill both directions differently to detect accidental shared prompt state.
  await page.getByLabel('图片二创要求',{exact:true}).fill(imageDirection);
  assert.equal(await page.getByLabel('整篇二创要求',{exact:true}).inputValue(),wholeDirection);
  const previousOutput=whole.assets.find(a=>a.id===whole.assetOrder[0]);
  await page.locator('.compare-image-pair').first().getByRole('button',{name:'AI 修改此图',exact:true}).click();await idle();
  const secondEdit=await current(),latestOutput=secondEdit.assets.find(a=>a.id===secondEdit.assetOrder[0]);
  assert.notEqual(latestOutput.id,previousOutput.id);assert.equal(rootOf(secondEdit,latestOutput).id,originalAssets[0].id);
  if(secondEdit.assetPairs)assert.equal(secondEdit.assetPairs[0].originalAssetId,originalAssets[0].id,'Public pairing must resolve to the root original asset');
  assert.ok(secondEdit.assets.some(a=>a.id===previousOutput.id),'Keep prior generated version');await originalsIntact(originalAssets);
  const single=await app.evaluate(()=>globalThis.fengshaTest.compareFixture.imageRequests.at(-1));policyPrompt(single.prompt,imageDirection);
  assert.equal(single.image,fs.readFileSync(previousOutput.file).toString('base64'),'Edit the selected generated image');
  checked('second-image-edit-keeps-same-original-root-and-prior-version');

  const firstPair=page.locator('.compare-image-pair').first();
  await firstPair.getByRole('button',{name:'移除画面1',exact:true}).click();
  await page.waitForFunction(id=>[...document.querySelectorAll('.compare-image-pair')].some(e=>e.querySelector('.compare-original-image img')?.src.endsWith('/'+id)&&e.textContent.includes('这张图未选入成稿')),originalAssets[0].id);
  assert.equal(await page.locator('.compare-original-image img').count(),2);assert.equal(await page.locator('.compare-output-image > img').count(),1);
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await idle();await originalsIntact(originalAssets);
  const removed=await current();assert.deepEqual(removed.assetOrder,[whole.assetOrder[1]]);checked('remove-image-retains-original-pair-and-history');
  const removedPair=page.locator('.compare-image-pair').filter({has:page.locator(`.compare-original-image img[src$="/${originalAssets[0].id}"]`)});
  await removedPair.getByRole('button',{name:'恢复到成稿',exact:true}).click();
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await idle();await originalsIntact(originalAssets);
  assert.deepEqual((await current()).assetOrder,[whole.assetOrder[1],originalAssets[0].id]);
  const restoredOriginalPair=page.locator('.compare-image-pair').filter({has:page.locator(`.compare-original-image img[src$="/${originalAssets[0].id}"]`)});
  assert.equal(await restoredOriginalPair.locator('.compare-output-image > img').count(),0,'Restored original remains a reference with a pending output placeholder');
  checked('restore-to-draft-button-keeps-original-reference-placeholder');
  // Restore the latest generated version from the actual history UI.
  await restoredOriginalPair.locator('.compare-versions summary').click();
  const restore=restoredOriginalPair.locator('.compare-version').filter({has:page.locator(`img[src$="/${latestOutput.id}"]`)}).locator('button');
  assert.equal(await restore.count(),1);await restore.click();
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await idle();await originalsIntact(originalAssets);
  assert.deepEqual((await current()).assetOrder,[whole.assetOrder[1],latestOutput.id]);checked('restore-selected-version-to-same-original-pair');
  await page.locator('.compare-image-pair').nth(1).getByRole('button',{name:'画面2上移',exact:true}).click();
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await idle();await originalsIntact(originalAssets);
  assert.deepEqual((await current()).assetOrder,[latestOutput.id,whole.assetOrder[1]]);checked('reorder-output-moves-whole-corresponding-pair');

  const dirtyTitle='用户未保存的阅读角标题',dirtyBody='用户未保存正文：继续保留我自己的修改，不能被后台快照覆盖。';
  await page.getByLabel('克隆稿标题',{exact:true}).fill(dirtyTitle);await page.getByLabel('克隆稿正文',{exact:true}).fill(dirtyBody);
  await page.getByLabel('克隆稿话题',{exact:true}).fill('#用户未保存');
  await app.evaluate(()=>{const t=globalThis.fengshaTest;t.win.webContents.send('fengsha:changed',t.snapshot());});
  await page.getByRole('button',{name:'返回搜索',exact:true}).click();assert.equal(await page.locator('.content-search-view').isVisible(),true);
  await page.getByRole('button',{name:'打开当前二创稿',exact:true}).click();
  assert.equal(await page.getByLabel('克隆稿标题',{exact:true}).inputValue(),dirtyTitle);assert.equal(await page.getByLabel('克隆稿正文',{exact:true}).inputValue(),dirtyBody);
  assert.equal(await page.getByLabel('克隆稿话题',{exact:true}).inputValue(),'#用户未保存');assert.equal((await current()).body,rewritten.body);
  await originalsIntact(originalAssets);checked('dirty-edits-survive-background-snapshot-and-search-roundtrip');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();await idle();assert.equal((await current()).body,dirtyBody);

  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1080,720));
  await page.waitForTimeout(200);result.narrowLayout=await assertLayout();await visiblePairsInViewport();await capture('studio-1080.png');
  await page.getByLabel('原文案',{exact:true}).scrollIntoViewIfNeeded();await capture('studio-1080-copy.png');checked('1080-window-paired-columns-without-horizontal-overflow');

  // Exercise cancellation against an actively waiting image fetch, not just cleanup.
  await app.evaluate(()=>{globalThis.fengshaTest.compareFixture.holdNextImage=true;});
  const beforeCancel=await current();await page.locator('.compare-image-pair').first().getByRole('button',{name:'AI 修改此图',exact:true}).click();
  await waitGate('cancel-image');await page.getByRole('button',{name:'停止处理',exact:true}).click();await idle();
  const cancelled=await current();assert.deepEqual(cancelled.assetOrder,beforeCancel.assetOrder);assert.equal(cancelled.assets.length,beforeCancel.assets.length);assert.equal(cancelled.body,dirtyBody);
  assert.ok(await app.evaluate(()=>globalThis.fengshaTest.compareFixture.aborted.includes('cancel-image')));await originalsIntact(originalAssets);checked('stop-aborts-synthetic-image-gate-without-changing-draft');
  assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.fengshaTest.compareFixture.blocked),[]);checked('no-real-platform-or-model-requests-and-no-renderer-errors');
  result.transport=await app.evaluate(()=>{const f=globalThis.fengshaTest.compareFixture;return {text:f.textRequests,image:f.imageRequests,original:f.originalRequests,blocked:f.blocked};});
  result.beforeRestartCleanup=await bounded(app.evaluate(()=>globalThis.fengshaTest.compareFixture.cleanup()),'pre-restart cleanup');
  assert.deepEqual({pending:result.beforeRestartCleanup.pending,waiting:result.beforeRestartCleanup.waiting,timers:result.beforeRestartCleanup.timers},{pending:0,waiting:0,timers:0});
  await bounded(app.close(),'pre-restart Electron close',20000);app=null;page=null;
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[root],env,timeout:45000});
  await reloadTestRenderer(app);page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
  await installFixture(true);await page.getByRole('button',{name:'作品搜索与二创',exact:true}).click();
  await page.getByRole('button',{name:'打开当前二创稿',exact:true}).click();await idle();
  assert.equal(await page.getByLabel('克隆稿标题',{exact:true}).inputValue(),dirtyTitle);assert.equal(await page.getByLabel('克隆稿正文',{exact:true}).inputValue(),dirtyBody);
  assert.equal(await page.getByLabel('克隆稿话题',{exact:true}).inputValue(),'#用户未保存');
  assert.deepEqual((await current()).assetOrder,cancelled.assetOrder);await originalsIntact(originalAssets);
  assert.equal(await page.locator('.studio-stages > span').filter({hasText:'文案'}).evaluate(e=>e.classList.contains('done')),true,'Saved rewrite evidence survives a process restart');
  assert.equal(await page.locator('.studio-stages > span').filter({hasText:'画面'}).evaluate(e=>e.classList.contains('done')),true,'Saved generated images must not be labelled unexecuted');
  await page.getByLabel('原文案',{exact:true}).scrollIntoViewIfNeeded();await capture('studio-restarted-originals.png');
  assert.deepEqual(errors,[]);checked('saved-copy-order-originals-and-png-bytes-survive-electron-restart');
  result.ok=true;
}catch(error){result.ok=false;result.failure=error.stack||String(error);console.error(result.failure);process.exitCode=1;}
finally{
  if(app){
    try{const transport=await app.evaluate(()=>{const f=globalThis.fengshaTest.compareFixture;return {text:f?.textRequests,image:f?.imageRequests,original:f?.originalRequests,blocked:f?.blocked};});if(result.transport)result.restartTransport=transport;else result.transport=transport;result.cleanup=await bounded(app.evaluate(()=>globalThis.fengshaTest.compareFixture?.cleanup()),'fixture abort cleanup');if(result.cleanup)assert.deepEqual({pending:result.cleanup.pending,waiting:result.cleanup.waiting,timers:result.cleanup.timers},{pending:0,waiting:0,timers:0});}catch(error){result.ok=false;result.cleanupError=String(error);process.exitCode=1;}
    try{if(page){result.finalText=(await bounded(page.locator('body').innerText(),'final DOM')).slice(0,6000);await capture('final-studio.png');}}catch(error){result.captureError=String(error);}
    try{await bounded(app.close(),'Electron close',20000);}catch(error){result.ok=false;result.closeError=String(error);app.process().kill();process.exitCode=1;}
  }
  result.rendererErrors=errors;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,output,checks:result.checks,failure:result.failure?.split('\n')[0],cleanup:result.cleanup}));
}
