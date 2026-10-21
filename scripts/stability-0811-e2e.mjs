import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {Store} from '../electron/store.js';

const root=path.resolve('.'),exe=process.argv[2]&&path.resolve(process.argv[2]);
const out=path.join(root,'output',`stability-0811-${Date.now()}`);
fs.mkdirSync(out,{recursive:true});
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.FENGSHA_TEST_MODE;delete env.FENGSHA_TEST_DATA;
const result={out,packaged:!!exe,version,errors:[],cases:[]};let app,page;
async function launch(profile){
  app=await electron.launch({executablePath:exe||createRequire(import.meta.url)('electron'),args:[...(!exe?[root]:[]),'--agent-data-dir',profile],env,timeout:45000});
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>result.errors.push(e.message));
  await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();
  const response=await page.evaluate(()=>window.fengsha.snapshot());assert.equal(response.ok,true);
  assert.equal(response.value.version,version);
  return response.value;
}
async function stop(){await app.close();app=null;}
try{
  const clean=path.join(out,'fresh-profile');
  await launch(clean);
  let status=await page.evaluate(()=>window.fengsha.externalBrowserStatus());
  assert.equal(status.ok,true);assert.equal(status.value.mode,'managed');assert.equal(status.value.canStart,true);
  assert.equal(status.value.socketURL,undefined);result.cases.push('fresh profile defaults to prepared managed browser without IP/port setup');
  await page.locator('nav').getByRole('button',{name:'账号管理',exact:true}).click();
  await page.getByText('使用时自动启动',{exact:true}).waitFor();
  await page.screenshot({path:path.join(out,'fresh-browser.png')});
  const components=await page.evaluate(()=>window.fengsha.environment());
  assert.equal(components.ok,true);assert.ok(components.value.every(c=>c.ok));
  result.cases.push('bundled download components run in application');
  await stop();
  const legacy=path.join(out,'legacy-profile');
  const store=await Store.open(legacy,{});
  store.put('account','legacy-test',{id:'legacy-test',platform:'B站',name:'旧浏览器会话验收',loginBackend:'external-chrome',status:'Chrome 登录已确认',lastSync:12345,lastVerified:12345});
  store.close();
  let state=await launch(legacy);assert.equal(state.accounts[0].browserMode,'legacy');
  await page.locator('nav').getByRole('button',{name:'账号管理',exact:true}).click();
  await page.getByRole('button',{name:'使用专用浏览器（推荐）',exact:true}).click();
  await page.getByText('使用时自动启动',{exact:true}).waitFor();
  state=(await page.evaluate(()=>window.fengsha.snapshot())).value;
  assert.equal(state.accounts[0].browserMode,'managed');assert.equal(state.accounts[0].lastSync,null);
  assert.equal(state.accounts[0].externalBrowserSessions.legacy.lastSync,12345);
  result.cases.push('old browser binding preserved and managed session never falsely marked logged in');
  await page.screenshot({path:path.join(out,'switched-browser.png')});
  await stop();
  state=await launch(legacy);assert.equal(state.accounts[0].browserMode,'managed');
  status=await page.evaluate(()=>window.fengsha.externalBrowserMode('legacy'));assert.equal(status.ok,true,status.error);
  state=(await page.evaluate(()=>window.fengsha.snapshot())).value;
  assert.equal(state.accounts[0].lastSync,12345);assert.equal(state.accounts[0].status,'会话待检测');
  const automatic=await page.evaluate(()=>window.fengsha.completeAccount('legacy-test',{automatic:true}));
  assert.equal(automatic.ok,true);assert.equal(automatic.value.verified,false);
  assert.equal((await page.evaluate(()=>window.fengsha.snapshot())).value.accounts[0].lastSync,12345);
  result.cases.push('browser preference survives restart; switch back retains old session; automatic check never opens a missing tab or clears binding');
  assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
