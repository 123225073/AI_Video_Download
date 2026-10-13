import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));

test('视频转图文真实 React UI：离线设置、流式输出与既有编辑保护', { timeout: 120000 }, async t => {
  const bundled = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import VideoWorkbench from './src/VideoWorkbench.jsx';
      const root=createRoot(document.getElementById('root')); let key=0;
      const base=id=>({id,title:id,status:'ready',busy:false,original:'完整原文'+id,
        corrected:'已校对'+id,correctionReady:true,currentSourceHash:'source-'+id,
        correctedCandidateHash:'accepted-'+id,candidateHash:'candidate-'+id,
        transcriptionId:'tr-'+id,body:'当前正文'+id,hasVideo:true,
        preview:'http://video-ui.test/fixture.mp4',progress:100,
        draft:{id:'draft-'+id,revision:7,assets:[]}});
      const clone=value=>JSON.parse(JSON.stringify(value));
      async function perform(method,...args){
        if(method==='videoList')return Object.values(window.records).map(clone);
        if(method==='videoOpenDraft')return clone(window.records[args[0].replace('draft-','')]);
        if(method==='videoGet'){
          const value=clone(window.records[args[0]]);
          if(window.holdGet===args[0]){window.holdGet=null;await new Promise(r=>window.releaseGet=r);}
          return value;
        }
        if(method==='videoAction'){
          const [id,kind,options]=args;window.calls.push(clone({id,kind,options:options||{}}));
          if(window.holdAction)await new Promise(r=>window.releaseAction=r);
          const record=window.records[id];
          if(kind==='save'){record.body=options.body;record.draft.revision++;}
          if(kind==='accept-correction'){record.corrected=options.text;record.correctionCandidate=null;}
          if(kind==='article'){record.articlePreview=null;record.status='ready';}
          return clone(record);
        }
        throw Error('Unexpected fixture method: '+method);
      }
      window.mountVideo=(patch={})=>{
        window.records={A:{...base('A'),...patch},B:base('B')};window.calls=[];
        window.holdGet=null;window.holdAction=false;window.dirty=false;
        flushSync(()=>root.render(<VideoWorkbench key={++key} seed={{draftId:'draft-A'}}
          state={{}} perform={perform} accounts={()=>{}} onSearch={()=>{}}
          onImages={id=>window.openedDraft=id} onDirtyChange={v=>window.dirty=v}/>));
      };
      window.patchRecord=(patch,id='A')=>Object.assign(window.records[id],patch);
      window.mountVideo();
    ` },
    bundle: true, write: false, outdir: 'video-article-ui-memory', format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"./"' },
  });
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }),
    args: ['--disable-background-networking'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: { width: 1280, height: 960 } });
  const pngs = new Map(['cyberpunk','anime','photo','clay3d','infographic','watercolor','retrocomic','ink']
    .map(id => [id, readFileSync(new URL('../public/video-styles/'+id+'.png', import.meta.url))]));
  // All resources are fulfilled locally. No platform, model or paid API exists in this fixture.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'video-ui.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' });
    const png = pngs.get(url.pathname.match(/^\/video-styles\/(.+)\.png$/)?.[1]);
    return png ? route.fulfill({ contentType: 'image/png', body: png }) : route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://video-ui.test/');
  for (const file of bundled.outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text });
  }
  const button = name => page.getByRole('button', { name, exact: true });
  const articleTab = () => page.getByRole('tab', { name: '视频转图文', exact: true }).click();
  const dialog = () => page.getByRole('dialog', { name: '创作设置', exact: true });
  const mount = async patch => {
    await page.evaluate(patch => window.mountVideo(patch), patch || {});
    await page.waitForFunction(() => document.querySelector('select[aria-label="视频任务"]')?.value === 'A');
    await articleTab();
  };
  const openSettings = async () => { await button('创作设置').click(); await dialog().waitFor(); };
  const calls = () => page.evaluate(() => window.calls);
  const waitCalls = async n => page.waitForFunction(n => window.calls.length === n, n);
  const assertPlayer = async () => assert.equal(await page.evaluate(() => window.playerBefore === document.querySelector('video')), true);

  await t.test('紧凑主区默认源语言、corrected和不生图；settings不占正文位置', async () => {
    await mount();
    assert.equal(await page.locator('.video-style-picker').count(), 0);
    assert.equal(await dialog().count(), 0);
    assert.equal(await page.getByLabel('图文配图生成状态').innerText(), '配图生成：关闭 · 只生成文案与配图方案，不调用图片模型');
    await button('创作图文方案').click(); await waitCalls(1);
    assert.deepEqual((await calls())[0], { id:'A',kind:'article',options:{reference:'corrected',style:'auto',pageCount:'auto',generateImages:false,instructions:'',outputLanguage:'source'} });
  });

  await t.test('取消设置不会改变参考、语言、页数、风格或费用开关；8本地PNG可见', async () => {
    await mount(); await openSettings();
    const images = dialog().locator('[data-media-preview="off"] img');
    assert.equal(await images.count(), 8);
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(image => image.decode());
      assert.ok(await image.evaluate(image => image.naturalWidth > 0));
      assert.match(await image.getAttribute('src'), /video-styles\/.*\.png$/);
    }
    await page.getByLabel('图文创作依据',{exact:true}).selectOption('current');
    await page.getByLabel('图文页数',{exact:true}).selectOption('6');
    await page.getByLabel('图文输出语言',{exact:true}).selectOption('chinese');
    await button('赛博朋克').click(); await page.getByLabel('生成图文配图',{exact:true}).check();
    await button('取消').click(); await button('创作图文方案').click(); await waitCalls(1);
    assert.equal((await calls())[0].options.outputLanguage,'source');
    assert.equal((await calls())[0].options.reference,'corrected');
    assert.equal((await calls())[0].options.style,'auto');
    assert.equal((await calls())[0].options.pageCount,'auto');
    assert.equal((await calls())[0].options.generateImages,false);
  });

  await t.test('确认才应用；中文、current与配图开关准确发送且取消不收费', async () => {
    await mount(); await openSettings();
    await page.getByLabel('图文创作依据',{exact:true}).selectOption('current');
    await page.getByLabel('图文页数',{exact:true}).selectOption('4');
    await page.getByLabel('图文输出语言',{exact:true}).selectOption('chinese');
    await button('水彩手绘').click(); await page.getByLabel('生成图文配图',{exact:true}).check();
    await button('确认应用').click();
    assert.match(await page.getByLabel('图文配图生成状态').innerText(), /开启.*费用/);
    assert.equal((await calls()).length,0,'应用设置不发起生成');
    await page.getByLabel('视频转图文方向',{exact:true}).fill('换成中文输出');
    await button('创作图文与配图').click(); await waitCalls(1);
    const options=(await calls())[0].options;
    assert.equal(options.outputLanguage,'chinese');assert.equal(options.reference,'current');
    assert.equal(options.pageCount,4);assert.equal(options.generateImages,true);
    assert.match(options.style,/水彩手绘/);assert.equal(options.instructions,'换成中文输出');
    await openSettings();assert.equal(await page.getByLabel('图文输出语言',{exact:true}).inputValue(),'chinese');await button('取消').click();
  });

  await t.test('自定义为空禁用应用，填写后保留并发送画风', async () => {
    await mount();await openSettings();await button('自定义').click();
    assert.equal(await button('确认应用').isDisabled(),true);
    await page.getByLabel('自定义图文画风',{exact:true}).fill('黑白钢笔插画');
    await button('确认应用').click();await button('创作图文方案').click();await waitCalls(1);
    assert.equal((await calls())[0].options.style,'黑白钢笔插画');
  });

  await t.test('dialog焦点循环、Escape/关闭/遮罩取消及播放器DOM稳定', async () => {
    await mount();await page.evaluate(()=>window.playerBefore=document.querySelector('video'));
    await openSettings();
    assert.equal(await dialog().evaluate(d=>d.contains(document.activeElement)),true);
    const focusables=dialog().locator('button:not([disabled]),select:not([disabled]),input:not([disabled]),textarea:not([disabled])');
    await focusables.last().focus();await page.keyboard.press('Tab');
    assert.equal(await focusables.first().evaluate(e=>e===document.activeElement),true);
    await page.keyboard.press('Shift+Tab');assert.equal(await focusables.last().evaluate(e=>e===document.activeElement),true);
    await page.getByLabel('图文输出语言',{exact:true}).selectOption('chinese');
    await page.keyboard.press('Escape');assert.equal(await dialog().count(),0);
    assert.equal(await button('创作设置').evaluate(e=>e===document.activeElement),true);await assertPlayer();
    await openSettings();assert.equal(await page.getByLabel('图文输出语言',{exact:true}).inputValue(),'source');await button('关闭创作设置').click();
    await openSettings();await page.mouse.click(3,3);assert.equal(await dialog().count(),0);await assertPlayer();
    await page.getByRole('tab',{name:'AI 校对',exact:true}).click();await articleTab();await assertPlayer();
  });

  await t.test('重开running任务自动显示累积页，poll更新累积且播放器节点保持', async () => {
    await mount({busy:false,status:'ready',articlePreview:{status:'running',text:'原始JSON回退不应显示',pages:[{title:'第一页',text:'第一页正文'}]}});
    await page.evaluate(()=>window.playerBefore=document.querySelector('video'));
    const output=page.getByLabel('图文正文与分页',{exact:true});
    assert.equal(await output.locator('.video-article-pages>article').count(),1);
    assert.equal(await output.locator('pre').count(),0);
    assert.equal(await button('创作设置').isDisabled(),true);assert.equal(await button('创作图文方案').isDisabled(),true);
    assert.equal(await button('停止处理').count(),1);
    await page.evaluate(()=>window.patchRecord({articlePreview:{status:'running',pages:[{title:'第一页',text:'第一页正文'},{title:'第二页',text:'第二页正文'}]}}));
    await output.getByText('第二页正文',{exact:true}).waitFor();await assertPlayer();
    // Remount models leaving/reopening the workbench with no local pending operation.
    await mount({status:'ready',busy:false,articlePreview:{status:'running',text:'重开流式正文'}});
    assert.equal(await output.locator('pre').innerText(),'重开流式正文');
  });

  await t.test('失败候选正文可读且标未采用，已保存正式稿分层保留', async () => {
    await mount({status:'article-failed',articlePreview:{status:'failed',label:'事实校验未通过',text:'未采用候选正文'},
      article:{title:'已有正式结果',pages:[{id:'p1',title:'正式第一页',text:'正式正文',imagePrompt:'方案'}],draftId:'article-A'}});
    assert.equal(await page.getByText('未采用的图文候选',{exact:true}).count(),1);
    assert.equal(await page.locator('.video-article-live pre').innerText(),'未采用候选正文');
    assert.equal(await page.locator('.video-article-saved').getAttribute('open'),null);
    await page.getByText('查看已保存图文成稿',{exact:true}).click();
    assert.equal(await page.getByText('正式正文',{exact:true}).isVisible(),true);
    await button('打开图文成稿继续编辑与导出').click();assert.equal(await page.evaluate(()=>window.openedDraft),'article-A');
    await openSettings();assert.equal(await dialog().getByText('未采用候选正文',{exact:true}).count(),0);await button('取消').click();
  });

  await t.test('dirty文案和校对阻止设置/创作；保存绑定不被轮询更新', async () => {
    await mount();await page.getByRole('tab',{name:'二创文案',exact:true}).click();
    await page.getByLabel('视频二创文案',{exact:true}).fill('手工保留正文');
    await page.evaluate(()=>window.patchRecord({draft:{id:'draft-A',revision:8,assets:[]},body:'后台的新正文'}));
    await articleTab();assert.equal(await button('创作设置').isDisabled(),true);assert.equal(await button('创作图文方案').isDisabled(),true);
    await page.getByLabel('视频任务',{exact:true}).selectOption('B');
    assert.equal(await page.getByLabel('视频任务',{exact:true}).inputValue(),'A');
    await page.getByRole('tab',{name:'二创文案',exact:true}).click();
    await page.waitForTimeout(1100);assert.equal(await page.getByLabel('视频二创文案',{exact:true}).inputValue(),'手工保留正文');
    await button('保存文案').click();await waitCalls(1);
    assert.deepEqual((await calls())[0].options,{body:'手工保留正文',workflowId:'A',draftId:'draft-A',transcriptionId:'tr-A',revision:7});
    await page.getByRole('tab',{name:'AI 校对',exact:true}).click();await button('编辑校对稿').click();
    await articleTab();assert.equal(await button('创作设置').isDisabled(),true);
    await page.getByRole('tab',{name:'AI 校对',exact:true}).click();await button('取消编辑').click();
    await articleTab();assert.equal(await button('创作设置').isEnabled(),true);
  });

  await t.test('校对候选确认沿用源hash与任务绑定；过时current参考禁用', async () => {
    await mount({rewriteStale:true,correctionCandidate:{text:'数字候选',contentComplete:true,correctionValidated:true,reason:'CORRECTION_NUMBERS_CHANGED',verification:{numbersChanged:true}}});
    await openSettings();assert.equal(await page.getByLabel('图文创作依据',{exact:true}).locator('option[value="current"]').evaluate(option=>option.disabled),true);await button('取消').click();
    await page.getByRole('tab',{name:'AI 校对',exact:true}).click();await button('核对并编辑完整候选').click();
    await page.getByLabel('视频校对文案',{exact:true}).fill('确认后的数字候选');await button('确认并保存校对稿').click();await waitCalls(1);
    assert.deepEqual((await calls())[0],{id:'A',kind:'accept-correction',options:{text:'确认后的数字候选',workflowId:'A',transcriptionId:'tr-A',sourceKind:'candidate',expectedSourceHash:'source-A',expectedCandidateHash:'candidate-A'}});
  });

  await t.test('任务切换关闭未应用设置且生图恢复off；迟到open不抢当前任务绑定', async () => {
    await mount();await openSettings();await page.getByLabel('生成图文配图',{exact:true}).check();
    await page.getByLabel('视频任务',{exact:true}).selectOption('B');
    await page.waitForFunction(()=>document.querySelector('select[aria-label="视频任务"]').value==='B'&&document.querySelector('button[aria-haspopup="dialog"]'));
    assert.equal(await dialog().count(),0);assert.match(await page.getByLabel('图文配图生成状态').innerText(),/关闭/);
    await page.evaluate(()=>window.holdGet='A');await page.getByLabel('视频任务',{exact:true}).selectOption('A');
    await page.waitForFunction(()=>typeof window.releaseGet==='function');await page.getByLabel('视频任务',{exact:true}).selectOption('B');
    await page.getByRole('tab',{name:'二创文案',exact:true}).click();await page.getByLabel('视频二创文案',{exact:true}).fill('仅B的正文');
    await page.evaluate(()=>window.releaseGet());await button('保存文案').click();await waitCalls(1);
    assert.equal((await calls())[0].id,'B');assert.equal((await calls())[0].options.workflowId,'B');assert.equal((await calls())[0].options.draftId,'draft-B');
    assert.equal(await page.evaluate(()=>window.records.A.body),'当前正文A');
  });

  await t.test('弹窗打开后busy变化禁用应用；本地pending也禁用重复生成', async () => {
    await mount();await openSettings();await page.evaluate(()=>window.patchRecord({busy:true}));
    await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[type="submit"]')?.disabled||[...document.querySelectorAll('[role="dialog"] button')].some(b=>b.textContent==='确认应用'&&b.disabled));
    assert.equal(await page.getByLabel('图文输出语言',{exact:true}).isDisabled(),true);await button('取消').click();
    await mount();await page.evaluate(()=>window.holdAction=true);await button('创作图文方案').click();await waitCalls(1);
    assert.equal(await button('创作设置').isDisabled(),true);assert.equal(await button('创作图文方案').isDisabled(),true);
    await page.evaluate(()=>{window.holdAction=false;window.releaseAction();});
  });
  assert.deepEqual(errors,[], 'React renderer must have no uncaught errors');
});
