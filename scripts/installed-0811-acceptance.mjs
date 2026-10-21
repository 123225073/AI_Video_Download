import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
const executablePath=path.resolve(process.argv[2]),out=path.resolve('output/repair-0811');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.FENGSHA_TEST_MODE;delete env.FENGSHA_TEST_DATA;
const result={executablePath,cases:[],errors:[]};let app,page;
try{
  app=await electron.launch({executablePath,args:[],env,timeout:45000});page=await app.firstWindow();page.setDefaultTimeout(20000);
  page.on('pageerror',e=>result.errors.push(e.message));await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();
  const initial=(await page.evaluate(()=>window.fengsha.snapshot())).value;
  assert.equal(initial.version,'0.8.11');result.version=initial.version;
  result.counts={accounts:initial.accounts.length,tasks:initial.tasks.length,media:initial.media.length,transcriptions:initial.transcriptions.length};
  assert.ok(initial.speechEnvironment.runtime);assert.deepEqual(initial.speechEnvironment.models,['base','small']);
  const components=await page.evaluate(()=>window.fengsha.environment());assert.equal(components.ok,true);assert.ok(components.value.every(c=>c.ok));
  result.cases.push('installed application 0.8.11 starts using existing profile and all download/speech resources');
  await page.locator('nav').getByRole('button',{name:'媒体库',exact:true}).click();
  result.preexistingMissingLibraryFiles=initial.media.filter(m=>!m.exists).length;
  let selected;
  for(const task of initial.videoTasks){const response=await page.evaluate(id=>window.fengsha.videoGet(id),task.id);if(response.ok&&response.value.hasVideo){selected=response.value;break;}}
  assert.ok(selected,'No existing original video is available');
  await page.locator('nav').getByRole('button',{name:'作品搜索与二创',exact:true}).click();
  await page.getByRole('tab',{name:'视频复刻',exact:true}).click();
  await page.getByLabel('视频任务',{exact:true}).selectOption(selected.id);
  const video=page.locator('.video-workbench video').first();await video.waitFor();
  await video.evaluate(async el=>{el.muted=true;await el.play();});
  await page.waitForFunction(()=>{const v=document.querySelector('.video-workbench video');return v&&v.currentTime>0.2&&v.readyState>=2;});
  result.cases.push('an existing real media file plays in installed application');
  await page.screenshot({path:path.join(out,'installed-media.png')});await video.evaluate(el=>el.pause());
  await page.locator('nav').getByRole('button',{name:'账号管理',exact:true}).click();
  await page.getByRole('heading',{name:'网页登录浏览器',exact:true}).waitFor();
  const browser=await page.evaluate(()=>window.fengsha.externalBrowserStatus());assert.equal(browser.ok,true);assert.equal(browser.value.canSwitch,true);
  result.browserMode=browser.value.mode;result.cases.push('browser settings and mode switch IPC available; existing login bindings left unchanged');
  await page.screenshot({path:path.join(out,'installed-accounts.png')});
  await page.locator('.sidebar-bottom').getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('heading',{name:'设置',exact:true}).waitFor();
  await page.getByRole('button',{name:/应用与组件/}).click();
  await page.getByText('当前版本 · 0.8.11',{exact:true}).waitFor();
  await page.screenshot({path:path.join(out,'installed-version.png')});
  assert.deepEqual(result.errors,[]);result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,'installed-failure.png')}).catch(()=>{});}
finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(out,'installed-acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
