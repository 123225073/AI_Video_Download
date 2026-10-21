import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const apiNames = [...preload.matchAll(/(\w+):\s*invoke\(/g)].map(match => match[1]);

// Exercise CreatorPage itself; only the external IPC boundary is replaced.
test('作者页微信连接：真实 React 离线交互', { timeout: 120000 }, async t => {
  const bundled = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import CreatorPage from './src/CreatorPage.jsx';
    const root=createRoot(document.getElementById('root'));let key=0;
    const noop=()=>{};
    const item={key:'saved',title:'已有作品',available:true,acquisition:'wechat-collector'};
    const baseRecord=()=>({id:'record-1',source:'https://channels.weixin.qq.com/fixture',
      creator:{id:'author-1',name:'测试作者',platform:'视频号',supported:true},
      items:[item],scanned:1,skipped:{},status:'partial',complete:false,
      filters:{period:'all',limit:50,excludeDownloaded:true},total:null});
    function Fixture({options}){
      const [record,setRecord]=useState(options.record===null?null:{...baseRecord(),...options.record});
      const [identifying,setIdentifying]=useState(Boolean(options.identifying));
      const [state,setState]=useState({accounts:[],media:[],settings:{concurrency:2},
        collectorConnection:options.connection||{phase:'idle',needsPage:false}});
      const [error,setError]=useState(null);
      const [source,setSource]=useState(options.source||'https://channels.weixin.qq.com/fixture');
      window.patchConnection=value=>flushSync(()=>setState(old=>({...old,collectorConnection:value})));
      window.endIdentify=value=>flushSync(()=>{setIdentifying(false);setError(value);});
      async function perform(method,...args){
        if(!window.apiNames.includes(method))throw Error('Not exported by preload: '+method);
        window.calls.push({method,args});
        if(method==='collectorOpenPage')return {attempted:true};
        if(method==='collectorStatus'){
          if(window.holdProbe)await new Promise(resolve=>window.releaseProbe=resolve);
          if(window.failProbe)throw Error('连接检测失败，请刷新官方窗口');
          return window.probeResult;
        }
        if(method==='creatorClearHistory'){if(window.failClear)throw Error('清除失败，历史仍保留');return {cleared:true,count:2};}
        if(method==='creatorPage'){
          if(window.failPage)throw Error('连接前代理状态核对失败，请重新读取');
          const next=await new Promise(resolve=>window.releasePage=resolve);
          return next;
        }
        if(method==='creatorCancel'||method==='creatorPageCancel'){
          if(window.failCancel)throw Error('停止作者读取失败，请重试');
          window.cancelled=true;
          if(window.releasePage)window.releasePage({...record,status:'partial'});
          return true;
        }
        throw Error('Unexpected fixture method: '+method);
      }
      const safe=(...args)=>perform(...args).catch(noop);
      return <CreatorPage state={state} record={record} setRecord={setRecord}
        identifying={identifying} source={source}
        perform={perform} safe={safe} notify={message=>window.notices.push(message)}
        error={error} identify={()=>window.identifyCalls++} ensureCreatorLogin={()=>true}
        back={noop} accounts={noop} settings={noop} reidentify={noop} done={noop} setSource={setSource}/>;
    }
    window.mountCreator=(options={})=>{
      window.calls=[];window.notices=[];window.identifyCalls=0;window.cancelled=false;
      window.releasePage=null;window.releaseProbe=null;window.holdProbe=false;window.failProbe=false;
      window.failPage=false;window.failClear=false;
      window.failCancel=false;
      window.probeResult={phase:'waiting',needsPage:true,ready:true,connected:false};
      window.fengsha=Object.fromEntries(window.apiNames.map(name=>[name,()=>{}]));
      flushSync(()=>root.render(<Fixture key={++key} options={options}/>));
    };
  ` }, bundle: true, write: false, outfile: 'creator-ui.js', format: 'iife' });
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }),
    args: ['--disable-background-networking'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => route.request().url() === 'http://creator-ui.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' })
    : route.abort());
  const page = await context.newPage();page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://creator-ui.test/');
  await page.evaluate(names=>window.apiNames=names,apiNames);
  for(const file of bundled.outputFiles){
    if(file.path.endsWith('.css'))await page.addStyleTag({content:file.text});
    if(file.path.endsWith('.js'))await page.addScriptTag({content:file.text});
  }
  const mount = options=>page.evaluate(options=>window.mountCreator(options),options);
  const waiting={phase:'waiting',needsPage:true,label:'请刷新视频号页面',activeTasks:1};
  const button=name=>page.getByRole('button',{name,exact:true});
  const calls=()=>page.evaluate(()=>window.calls);
  const waitCalls=n=>page.waitForFunction(n=>window.calls.length===n,n);

  await t.test('清除历史需要确认，取消保留；成功后清空链接和清单',async()=>{
    await mount();await button('清除博主历史').click();
    assert.match(await page.getByRole('dialog').innerText(),/已下载视频、下载任务、平台账号/);
    await button('取消').click();assert.equal((await calls()).length,0);
    await button('清除博主历史').click();await button('清除全部博主历史').click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal(await page.getByRole('textbox',{name:'博主链接',exact:true}).inputValue(),'');
    assert.equal(await page.getByText('测试作者',{exact:true}).count(),0);
    assert.deepEqual((await calls()).map(c=>c.method),['creatorClearHistory']);
  });
  await t.test('清除失败保留历史并显示原因，识别期间不能清除',async()=>{
    await mount();await page.evaluate(()=>window.failClear=true);await button('清除博主历史').click();await button('清除全部博主历史').click();
    await page.getByRole('alert').waitFor();assert.equal(await page.getByText('测试作者',{exact:true}).count(),1);
    assert.match(await page.getByRole('textbox',{name:'博主链接',exact:true}).inputValue(),/weixin/);
    await mount({identifying:true});assert.equal(await button('清除博主历史').isDisabled(),true);
  });
  await t.test('识别等待必须显示操作弹窗、官方窗口刷新步骤和超时说明',async()=>{
    await mount({identifying:true,record:null,connection:waiting});
    assert.equal(await page.getByRole('dialog').count(),1,'连接等待不能只显示转圈');
    const text=await page.getByRole('dialog').innerText();
    assert.match(text,/官方.*视频号.*窗口|视频号.*官方.*窗口/);
    assert.match(text,/关闭视频号页面后重新进入/);assert.match(text,/菜单.*刷新/);assert.match(text,/保持|保留/);
    assert.match(text,/超时/);assert.match(text,/已有.*保留|已读取.*保留/);
    await button('打开微信视频号').click();await waitCalls(1);
    assert.deepEqual((await calls())[0],{method:'collectorOpenPage',args:[]});
    await page.getByRole('status').getByText(/已发送.*打开请求/).waitFor();
    assert.match(await page.getByRole('status').innerText(),/未出现.*手动/);
  });
  await t.test('已操作继续检测只探测现有连接，防重复且未连接时不误报成功',async()=>{
    await mount({identifying:true,record:null,connection:waiting});
    await page.evaluate(()=>window.holdProbe=true);
    await button('立即检测').click();await waitCalls(1);
    assert.equal(await button('正在检测…').isDisabled(),true);
    assert.deepEqual((await calls())[0],{method:'collectorStatus',args:[]});
    await page.evaluate(()=>window.releaseProbe());
    await button('立即检测').waitFor();
    assert.match(await page.getByRole('dialog').innerText(),/尚未|仍未/);
    assert.equal((await calls()).filter(call=>/^creator/.test(call.method)).length,0);
    assert.equal(await page.evaluate(()=>window.identifyCalls),0);
    await page.evaluate(()=>window.patchConnection({phase:'connected',needsPage:false}));
    assert.equal(await page.getByRole('dialog').count(),0);
  });
  await t.test('读取连接失败后原因持续可见，不只恢复为无反应的读取按钮',async()=>{
    await mount();await page.evaluate(()=>window.failPage=true);
    await button('确认博主并读取作品').click();
    await page.getByText('连接前代理状态核对失败，请重新读取',{exact:true}).waitFor();
    assert.equal(await button('确认博主并读取作品').isEnabled(),true);
    assert.equal((await calls()).filter(c=>c.method==='creatorPage').length,1);
  });
  await t.test('检测失败可重试并显示说明，不启动新的作者任务',async()=>{
    await mount({identifying:true,record:null,connection:waiting});
    await page.evaluate(()=>window.failProbe=true);
    await button('立即检测').click();
    await button('立即检测').waitFor();
    assert.match(await page.getByRole('dialog').innerText(),/连接检测失败/);
    assert.deepEqual((await calls()).map(call=>call.method),['collectorStatus']);
  });
  await t.test('停止识别取消当前任务，超时后保留明确失败信息',async()=>{
    await mount({identifying:true,record:null,connection:waiting});
    await button('停止并保留已有结果').click();await waitCalls(1);
    assert.deepEqual((await calls())[0],{method:'creatorCancel',args:[]});
    await page.evaluate(()=>{window.patchConnection({phase:'idle',needsPage:false});window.endIdentify('微信视频号页面尚未连接，等待超时；原网络将自动恢复');});
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.match(await page.locator('#root').innerText(),/等待超时/);
  });
  await t.test('停止失败在连接弹窗里可见，允许重试且不悄悄吞错',async()=>{
    await mount({identifying:true,record:null,connection:waiting});
    await page.evaluate(()=>window.failCancel=true);await button('停止并保留已有结果').click();
    await page.getByRole('dialog').getByText('停止作者读取失败，请重试',{exact:true}).waitFor();
    assert.equal(await button('停止并保留已有结果').isEnabled(),true);
    await page.evaluate(()=>window.failCancel=false);await button('停止并保留已有结果').click();
    assert.equal((await calls()).filter(c=>c.method==='creatorCancel').length,2);
  });
  await t.test('waitingUntil显示剩余等待时间，截止后仍等待后台返回失败原因',async()=>{
    await mount({identifying:true,record:null,connection:{...waiting,waitingUntil:Date.now()+90000}});
    assert.match(await page.getByRole('dialog').innerText(),/剩余等待.*秒/);
    await page.evaluate(waiting=>window.patchConnection({...waiting,waitingUntil:Date.now()-1}),waiting);
    await page.getByText(/等待已超时/).waitFor();
    assert.deepEqual(await calls(),[],'UI截止时间不自行重启或取消后台任务');
    await page.evaluate(()=>{window.patchConnection({phase:'idle',needsPage:false});window.endIdentify('当前作者作品接口尚未就绪，请刷新官方视频号窗口');});
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.match(await page.locator('#root').innerText(),/当前作者作品接口尚未就绪/);
  });
  await t.test('作品读取等待可检测和停止，取消后已有清单仍在且不再自动分页',async()=>{
    await mount();
    await button('继续读取').click();await waitCalls(1);
    await page.evaluate(waiting=>window.patchConnection(waiting),waiting);
    assert.equal(await page.getByRole('dialog').count(),1);
    await button('立即检测').click();await waitCalls(2);
    await button('立即检测').waitFor();
    await button('停止并保留已有结果').click();await waitCalls(3);
    await button('继续读取').waitFor();
    assert.equal((await calls()).filter(call=>call.method==='creatorPage').length,1);
    assert.equal((await calls())[2].method,apiNames.includes('creatorPageCancel')?'creatorPageCancel':'creatorCancel');
    assert.match(await page.locator('#root').innerText(),/已有作品/);
    assert.equal(await page.getByRole('dialog').count(),0);
  });
  await t.test('缺失作者 ID 即使 supported=true 也不能显示已识别或允许读取',async()=>{
    for(const id of [null,'','   ']){
      await mount({record:{creator:{id,name:'仅有昵称',platform:'视频号',supported:true},status:'needs-connection'}});
      assert.equal(await button('确认博主并读取作品').isDisabled(),true);
      assert.equal(await button('继续读取').count(),0);
      assert.doesNotMatch(await page.locator('#root').innerText(),/作者已识别|博主已确认|作者昵称已识别/);
      assert.match(await page.locator('#root').innerText(),/作者 ID 尚未取得/);
    }
  });
  await t.test('已取得ID但身份仍pending也不能标成确认或开启作品读取',async()=>{
    await mount({record:{creator:{id:'author-pending',name:'待确认作者',platform:'视频号',supported:true,identityStatus:'pending'},status:'identified'}});
    assert.equal(await button('确认博主并读取作品').isDisabled(),true);
    assert.equal(await button('继续读取').count(),0);
    assert.doesNotMatch(await page.locator('#root').innerText(),/博主已确认/);
    assert.match(await page.locator('#root').innerText(),/身份待确认/);
  });
  await t.test('弹窗键盘焦点不逃到后台，窄窗口步骤及按钮完整可操作',async()=>{
    await page.setViewportSize({width:390,height:700});
    await mount({identifying:true,record:null,connection:waiting});
    await button('打开微信视频号').focus();await page.keyboard.press('Shift+Tab');
    assert.equal(await button('停止并保留已有结果').evaluate(element=>element===document.activeElement),true);
    await page.keyboard.press('Tab');
    assert.equal(await button('打开微信视频号').evaluate(element=>element===document.activeElement),true);
    const box=await page.getByRole('dialog').boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=700);
    await button('立即检测').scrollIntoViewIfNeeded();
    assert.equal(await button('立即检测').isVisible(),true);
    await page.setViewportSize({width:1280,height:900});
  });
  await t.test('其他任务的等待或无需页面操作时不抢占作者页',async()=>{
    await mount({connection:waiting});assert.equal(await page.getByRole('dialog').count(),0);
    await mount({identifying:true,record:null,source:'https://www.bilibili.com/video/BVfixture',connection:waiting});
    assert.equal(await page.getByRole('dialog').count(),0);
    await mount({identifying:true,record:null,connection:{...waiting,needsPage:false}});
    assert.equal(await page.getByRole('dialog').count(),0);
  });
  assert.deepEqual(errors,[]);
});
