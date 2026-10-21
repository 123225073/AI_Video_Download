import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));

test('账号页 Chrome 默认登录：状态真实、同会话采集、保留内置兼容和视频号网页登录', {timeout:120000},async t=>{
  const main=fs.readFileSync(new URL('../src/main.jsx',import.meta.url),'utf8').replace('createRoot(document.getElementById(\'root\')).render(<App/>);','export {Accounts};');
  const bundled=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{Accounts}from'./src/main.jsx';
    const root=createRoot(document.getElementById('root'));let key=0;
    const base=()=>({id:'account-1',name:'测试账号',platform:'YouTube',active:true,status:'未登录',lastSync:null});
    function Fixture({options}){
      const [accounts,setAccounts]=useState(options.accounts||[{...base(),...options.account}]);
      const [filter,setFilter]=useState('全部平台');
      async function perform(method,...args){
        window.calls.push({method,args});
        if(method==='externalBrowserStatus'){
          if(window.holdStatus)await new Promise(resolve=>window.releaseStatus=resolve);
          if(window.statusError)throw Error(window.statusError);return window.browserStatus;
        }
        if(method==='externalBrowserMode'){
          window.browserStatus={available:false,canStart:true,canSwitch:true,mode:args[0],message:'专用浏览器已准备'};
          setAccounts(old=>old.map(a=>({...a,browserMode:args[0],status:'需要重新登录',lastSync:null})));return window.browserStatus;
        }
        if(method==='openExternalLogin'||method==='login'){
          if(window.openError)throw Error(window.openError);
          setAccounts(old=>old.map(a=>a.id===args[0]?{...a,status:'登录中',loginBackend:method==='openExternalLogin'?'external-chrome':'embedded'}:a));
          return method==='openExternalLogin'?{opened:true,message:'已打开本工具的 Chrome 标签，请在官方页面登录'}:undefined;
        }
        if(method==='completeAccount'){
          if(window.holdComplete)await new Promise(resolve=>window.releaseComplete=resolve);
          const value=window.completeResult;
          if(args[1]?.automatic&&!value.verified)return {saved:false,verified:false};
          if(value.saved)setAccounts(old=>old.map(a=>a.id===args[0]?{...a,status:value.verified?'网页登录已确认':'会话待验证',lastSync:value.verified?Date.now():a.lastSync}:a));
          return value;
        }
        if(method==='addAccount'){
          const next={...base(),id:'account-added',platform:args[0],name:args[1]||'新增账号'};setAccounts(old=>[...old,next]);return next;
        }
        throw Error('Unexpected fixture method '+method);
      }
      return <Accounts state={{accounts}} perform={perform} safe={(...args)=>perform(...args).catch(()=>{})} notify={message=>window.notices.push(message)} filter={filter} setFilter={setFilter}/>;
    }
    window.mountAccounts=(options={})=>{window.calls=[];window.notices=[];window.openError='';window.statusError='';window.holdStatus=false;window.holdComplete=false;window.browserStatus={available:false,reason:'not-running',message:'Chrome 尚未接入，请先打开登录页'};window.completeResult={saved:true,verified:false,message:'会话已保留，平台登录状态尚待确认'};flushSync(()=>root.render(<Fixture key={++key} options={options}/>));};
  `},plugins:[{name:'account-page-test-export',setup(build){build.onLoad({filter:/src[\\/]main\.jsx$/},()=>({contents:main,loader:'jsx'}));}}],bundle:true,write:false,outfile:'account-browser-ui.js',format:'iife',define:{'import.meta.env.BASE_URL':'"./"'}});
  const browser=await chromium.launch({headless:true,...(fs.existsSync(chromium.executablePath())?{}:{channel:'chrome'}),args:['--disable-background-networking']});t.after(()=>browser.close());
  const context=await browser.newContext({offline:true,serviceWorkers:'block',viewport:{width:1280,height:900}});await context.route('**/*',route=>route.request().url()==='http://account-browser.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'}):route.abort());
  const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://account-browser.test/');
  for(const file of bundled.outputFiles){if(file.path.endsWith('.css'))await page.addStyleTag({content:file.text});if(file.path.endsWith('.js'))await page.addScriptTag({content:file.text});}
  const mount=options=>page.evaluate(options=>window.mountAccounts(options),options),button=name=>page.getByRole('button',{name,exact:true});
  const actions=()=>page.evaluate(()=>window.calls.filter(c=>c.method!=='externalBrowserStatus'));
  await t.test('默认设置明确同一 Chrome 会话，接入状态不等于平台登录',async()=>{
    await mount();await page.getByText('Chrome 尚未接入',{exact:true}).waitFor();
    const settings=page.getByRole('region',{name:'网页登录浏览器设置'});assert.match(await settings.innerText(),/默认使用本机 Chrome/);assert.match(await settings.innerText(),/本工具打开的 Chrome 标签/);assert.match(await settings.innerText(),/不代表平台已登录/);
    assert.deepEqual(await actions(),[],'状态检查不能自动打开或切换账号');
    await page.evaluate(()=>window.browserStatus={available:true,message:'Chrome 连接已就绪'});await button('检查 Chrome 接入').click();await page.getByText('Chrome 已接入',{exact:true}).waitFor();assert.doesNotMatch(await settings.innerText(),/登录成功/);
  });
  await t.test('默认网页登录明确走外置 Chrome，完成未验证时不声称登录成功',async()=>{
    await mount();await button('Chrome 官方登录').click();await button('完成登录并检测').waitFor();assert.deepEqual(await actions(),[{method:'openExternalLogin',args:['account-1']}]);
    await button('完成登录并检测').click();await button('完成登录并检测').waitFor();assert.deepEqual((await actions()).map(a=>a.method),['openExternalLogin','completeAccount']);
    assert.match((await page.evaluate(()=>window.notices)).at(-1),/尚待确认/);assert.doesNotMatch((await page.evaluate(()=>window.notices)).join(' '),/登录成功/);
  });
  await t.test('返回软件自动检测，成功后停止；重复焦点不重复保存，未验证不退出等待',async()=>{
    await mount();await button('Chrome 官方登录').click();await button('完成登录并检测').waitFor();
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>window.calls.filter(c=>c.method==='completeAccount').length===1);await button('完成登录并检测').waitFor();
    assert.deepEqual((await actions()).at(-1).args,['account-1',{automatic:true}]);
    await page.evaluate(()=>{window.holdComplete=true;window.completeResult={saved:true,verified:true,message:'已自动确认官方登录'};window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));});
    await button('正在检测登录…').waitFor();assert.equal((await actions()).filter(a=>a.method==='completeAccount').length,2);
    await page.evaluate(()=>window.releaseComplete());await button('Chrome 重新登录').waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal((await actions()).filter(a=>a.method==='completeAccount').length,2);
    assert.equal((await page.evaluate(()=>window.notices)).at(-1),'已自动确认官方登录');
    await mount();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.deepEqual(await actions(),[],'unmounted login does not keep an automatic checker');
  });
  await t.test('旧浏览器切换专用模式仅一次操作，保留首次登录说明并清除旧等待状态',async()=>{
    await mount();await button('Chrome 官方登录').click();await button('完成登录并检测').waitFor();
    await page.evaluate(()=>window.browserStatus={available:false,mode:'legacy',canSwitch:true,message:'旧浏览器会话'});await button('检查 Chrome 接入').click();await button('使用专用浏览器（推荐）').waitFor();
    assert.match(await page.getByRole('region',{name:'网页登录浏览器设置'}).innerText(),/仅首次需要登录/);
    await button('使用专用浏览器（推荐）').click();await button('官方网页登录').waitFor();await page.getByText('使用时自动启动',{exact:true}).waitFor();
    assert.equal((await actions()).filter(x=>x.method==='externalBrowserMode').length,1);assert.equal(await page.getByRole('dialog').count(),0);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    assert.equal((await actions()).filter(x=>x.method==='completeAccount').length,0,'switching mode clears the old automatic login watcher');
  });
  await t.test('检测失败原因可见，检测中阻止重复请求，确认结果以后台为准',async()=>{
    await mount({account:{status:'登录中',loginBackend:'external-chrome'}});await page.evaluate(()=>window.completeResult={saved:false,verified:false,message:'请先在官方页面完成登录，当前仍是访客'});
    await button('完成登录并检测').click();await page.getByRole('alert').getByText('请先在官方页面完成登录，当前仍是访客',{exact:true}).waitFor();assert.equal(await button('完成登录并检测').isEnabled(),true);
    await page.evaluate(()=>{window.holdComplete=true;window.completeResult={saved:true,verified:true,message:'已在官方页面确认登录'};});await button('完成登录并检测').click();await button('正在检测登录…').waitFor();assert.equal(await button('正在检测登录…').isDisabled(),true);
    await page.evaluate(()=>window.releaseComplete());await button('Chrome 重新登录').waitFor();assert.equal((await actions()).filter(a=>a.method==='completeAccount').length,2);assert.equal((await page.evaluate(()=>window.notices)).at(-1),'已在官方页面确认登录');
  });
  await t.test('Chrome 启动失败显示原因，禁止静默切回内置窗口',async()=>{
    await mount();await page.evaluate(()=>window.openError='Chrome 未接入，请先按连接说明启动');await button('Chrome 官方登录').click();await page.getByRole('alert').getByText('Chrome 未接入，请先按连接说明启动',{exact:true}).waitFor();assert.deepEqual((await actions()).map(a=>a.method),['openExternalLogin']);assert.equal(await button('Chrome 官方登录').isEnabled(),true);
  });
  await t.test('高级内置兼容入口保留已有账号，不自动修改其他会话',async()=>{
    await mount({account:{lastSync:1,status:'会话已保存'}});await page.getByText('高级兼容',{exact:true}).click();await button('使用内置窗口登录（兼容）').click();await button('完成登录并检测').waitFor();assert.deepEqual(await actions(),[{method:'login',args:['account-1']}]);
    assert.match(await page.locator('.account-browser-advanced').innerText(),/已有内置会话仍可使用/);
  });
  await t.test('视频号账号保留网页登录用途，明确区分电脑微信连接',async()=>{
    await mount({account:{platform:'视频号'}});assert.equal(await page.getByText('视频号网页登录',{exact:true}).count(),1);assert.match(await page.getByRole('region',{name:'网页登录浏览器设置'}).innerText(),/分享链接解析.*搜索和评论采集仍连接电脑微信/);
    await button('Chrome 官方登录').click();await button('完成登录并检测').waitFor();assert.deepEqual(await actions(),[{method:'openExternalLogin',args:['account-1']}]);
  });
  await t.test('添加账号后使用新账号打开 Chrome，不误用旧账号',async()=>{
    await mount();await button('添加账号').click();await page.getByRole('dialog').getByRole('combobox').selectOption('抖音');await page.getByPlaceholder('例如：工作账号、素材账号').fill('抖音素材');await button('添加并打开官方登录').click();await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.calls.some(c=>c.method==='openExternalLogin'));
    assert.deepEqual(await actions(),[{method:'addAccount',args:['抖音','抖音素材']},{method:'openExternalLogin',args:['account-added']}]);
  });
  assert.deepEqual(errors,[]);
});
