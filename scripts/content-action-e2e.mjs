import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {reloadTestRenderer} from './test-renderer.mjs';

const output=path.resolve('output','content-action-e2e-'+Date.now());fs.mkdirSync(output,{recursive:true});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const result={realElectron:true,isolated:true,externalRequests:0};let app;
try{
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('.')],env,timeout:45000});
  await reloadTestRenderer(app);const page=await app.firstWindow();page.setDefaultTimeout(10000);
  await app.evaluate(async({BrowserWindow})=>{
    const t=globalThis.fengshaTest;
    t.actionFixture={reads:0,opens:0,checks:0,ready:false,closed:false,hold:false,release:null};
    class OfficialFixture {
      close(){if(this.window&&!this.window.isDestroyed())this.window.close();this.window=null;}
      pause(){if(this.window&&!this.window.isDestroyed())this.window.hide();}
      show(){if(this.window&&!this.window.isDestroyed())this.window.show();}
      async read(record,_signal,initial){
        const f=t.actionFixture;
        if(initial){this.close();Object.assign(f,{reads:0,opens:0,checks:0,ready:false,closed:false,hold:false,release:null});}
        f.reads++;
        if(f.ready)return {items:[{id:'123456789',key:'fixture-video',platform:'抖音',type:'video',url:'https://www.douyin.com/video/123456789',title:'恢复后的作品',author:'隔离测试',publishedAt:'2026-10-20'}],complete:true};
        const kind=record.keyword==='网络错误'?'network':record.keyword==='保留搜索条件'?'login':'verification';
        const action={kind,message:kind==='network'?'官方页面连接失败，已自动重连一次。':kind==='login'?'请在官方页面完成登录，原搜索任务已经保留。':'请在官方页面完成验证码，原搜索任务已经保留。',retryable:kind==='network'};
        if(action.kind==='network')throw Object.assign(Error(action.message),{action});
        return {items:[],needsAction:true,complete:false,message:action.message,action};
      }
      async openAction(){
        const f=t.actionFixture;f.opens++;f.closed=false;
        if(!this.window||this.window.isDestroyed()){
          this.window=new BrowserWindow({show:false,width:650,height:420,title:'隔离回归官方验证页面',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
          await this.window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8"><h1>隔离回归：模拟官方验证码</h1><button onclick="window.fixtureReady=true;document.querySelector(\'h1\').textContent=\'模拟验证已完成\'">我已完成验证</button>'));
        }
        this.window.show();return {ready:false,message:'完成官方验证后返回，软件会自动检测并继续。'};
      }
      async checkAction(){
        const f=t.actionFixture;f.checks++;
        if(f.hold)await new Promise(resolve=>f.release=resolve);
        if(f.ready)return {ready:true};
        if(f.closed||f.opens&&(!this.window||this.window.isDestroyed()))return {ready:false,closed:true,message:'官方窗口已关闭，任务和条件仍保留。'};
        if(this.window&&!this.window.isDestroyed()&&await this.window.webContents.executeJavaScript('window.fixtureReady===true')){f.ready=true;return {ready:true};}
        return {ready:false,message:'等待官方验证完成。'};
      }
    }
    t.contentSearch.browser.close();t.contentSearch.browser=new OfficialFixture();
  });
  await page.getByRole('button',{name:'作品搜索与二创',exact:true}).click();
  await page.getByLabel('作品搜索平台').selectOption('抖音');await page.getByLabel('作品起始日期').fill('2026-10-01');await page.getByLabel('作品结束日期').fill('2026-10-21');await page.getByLabel('作品采集数量').fill('10');
  const search=async keyword=>{await page.getByLabel('作品搜索关键词').fill(keyword);await page.getByRole('button',{name:'搜索作品',exact:true}).click();await page.getByRole('dialog',{name:/需要完成平台登录|需要完成平台验证|官方页面连接未完成/}).waitFor();};
  const focus=()=>page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const state=()=>app.evaluate(()=>{const f=globalThis.fengshaTest.actionFixture;return {reads:f.reads,opens:f.opens,checks:f.checks,view:globalThis.fengshaTest.contentSearch.view()};});

  await search('保留搜索条件');
  await page.getByRole('dialog',{name:'需要完成平台登录',exact:true}).waitFor();
  assert.equal(await page.getByRole('dialog').getByText(/搜索条件和读取位置不变/).count(),1);
  const original=(await state()).view;
  assert.equal(await page.getByRole('heading',{name:'当前范围没有匹配作品',exact:true}).count(),0);
  await page.screenshot({path:path.join(output,'login-guidance.png')});
  await page.getByRole('button',{name:'打开官方窗口',exact:true}).click();
  const official=await app.waitForEvent('window',{timeout:1000}).catch(()=>null)||app.windows().find(w=>w!==page);
  assert.ok(official);await official.getByRole('button',{name:'我已完成验证',exact:true}).click();await page.bringToFront();await focus();
  await page.getByRole('heading',{name:'恢复后的作品',exact:true}).waitFor();await page.getByRole('dialog').waitFor({state:'hidden'});
  const resumed=await state();assert.equal(resumed.reads,2);assert.equal(resumed.opens,1);assert.equal(resumed.view.id,original.id);assert.deepEqual(resumed.view.options,original.options);assert.equal(resumed.view.keyword,original.keyword);assert.equal(await page.getByLabel('作品搜索关键词').inputValue(),'保留搜索条件');result.loginAutomaticallyResumedExactlyOnce=true;

  await search('关闭提示不重开');await page.getByRole('dialog',{name:'需要完成平台验证',exact:true}).waitFor();await page.screenshot({path:path.join(output,'verification-guidance.png')});result.verificationGuidance=true;await page.getByRole('button',{name:'稍后处理，保留结果',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await app.evaluate(()=>{globalThis.fengshaTest.actionFixture.ready=true;});await focus();await page.waitForTimeout(2200);
  const dismissed=await state();assert.equal(dismissed.reads,1);assert.equal(dismissed.opens,0);assert.equal(await page.getByRole('dialog').count(),0);result.dismissStopsAutomation=true;

  await search('关闭官方窗口');await page.getByRole('button',{name:'打开官方窗口',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.search-recovery-actions button')?.disabled);
  const identities=await app.evaluate(()=>{const t=globalThis.fengshaTest;return {main:t.win.id,official:t.contentSearch.browser.window.id,url:t.contentSearch.browser.window.webContents.getURL()};});
  assert.notEqual(identities.main,identities.official);assert.match(identities.url,/^data:text\/html/);
  await app.evaluate(()=>{const t=globalThis.fengshaTest;t.actionFixture.closed=true;t.contentSearch.browser.window.close();});await focus();
  await page.getByRole('dialog').getByText('官方窗口已关闭，任务和条件仍保留。',{exact:true}).waitFor();await page.waitForTimeout(2200);
  const closed=await state();assert.equal(closed.opens,1);assert.equal(closed.reads,1);result.closedWindowIsNotReopened=true;
  await page.getByRole('button',{name:'稍后处理，保留结果',exact:true}).click();

  await search('网络错误');await page.getByRole('dialog').getByText('如果平台官网也无法打开，请确认当前网络允许访问该平台；公司网络限制需要由网络管理员处理。',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').getByText(/完成登录|完成验证/).count(),0);result.networkGuidanceIsSpecific=true;await app.evaluate(()=>{globalThis.fengshaTest.actionFixture.hold=true;});await focus();
  await page.waitForFunction(()=>document.querySelector('.search-recovery-actions button')?.disabled);
  assert.equal(await page.getByRole('button',{name:'重新连接并继续',exact:true}).isDisabled(),true);
  await app.evaluate(()=>{const f=globalThis.fengshaTest.actionFixture;f.hold=false;f.release?.();});await page.getByRole('button',{name:'重新连接并继续',exact:true}).waitFor();
  await page.waitForFunction(()=>![...document.querySelectorAll('.search-recovery-actions button')].find(button=>button.textContent.includes('重新连接并继续'))?.disabled);
  await app.evaluate(()=>{globalThis.fengshaTest.actionFixture.ready=true;});await page.getByRole('button',{name:'重新连接并继续',exact:true}).click();
  await page.getByRole('heading',{name:'恢复后的作品',exact:true}).waitFor();assert.equal((await state()).reads,2);result.networkRetrySerializedWithProbe=true;
  await page.screenshot({path:path.join(output,'resumed-results.png')});result.ok=true;
}catch(error){result.error=error.stack;throw error;}
finally{if(app)await app.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output}));}
