import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {_electron as electron} from 'playwright';
const root=path.resolve('.'),exe=process.argv[2],out=path.resolve('output/repair-0812'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.FENGSHA_TEST_MODE;delete env.FENGSHA_TEST_DATA;
const data='D:/9005_IDEauthorized/风沙应用/风沙全平台视频下载器/用户数据';const result={mode:exe?'installed':'source',platform:'抖音',keyword:'大环境',errors:[]};let app,page;
try{
 app=await electron.launch({executablePath:exe?path.resolve(exe):createRequire(import.meta.url)('electron'),args:exe?[]:[root,'--agent-data-dir',data],env,timeout:45000});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>result.errors.push(e.message));
 await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();const status=await page.evaluate(()=>window.fengsha.externalBrowserStatus());assert.equal(status.value.mode,'managed');
 await page.locator('nav').getByRole('button',{name:'作品搜索与二创',exact:true}).click();await page.getByRole('tab',{name:'图文复刻',exact:true}).click();
 await page.getByLabel('作品搜索平台',{exact:true}).selectOption('抖音');await page.getByLabel('作品搜索关键词',{exact:true}).fill('大环境');await page.getByLabel('作品采集数量',{exact:true}).fill('50');await page.getByLabel('作品起始日期',{exact:true}).fill('2026-10-01');await page.getByLabel('作品结束日期',{exact:true}).fill('2026-10-11');
 const previousId=(await page.evaluate(()=>window.fengsha.contentLast())).value?.id;
 await page.getByRole('button',{name:'搜索作品',exact:true}).click();
 let r;const deadline=Date.now()+120000;do{r=(await page.evaluate(()=>window.fengsha.contentLast())).value;if(r&&r.id!==previousId&&r.keyword==='大环境'&&!r.busy&&r.status!=='searching')break;await new Promise(resolve=>setTimeout(resolve,300));}while(Date.now()<deadline);
 assert.ok(r&&r.id!==previousId&&!r.busy&&r.status!=='searching','Live search did not reach a stable result within two minutes');
 result.search={status:r.status,action:r.action,scanned:r.scanned,count:r.items.length,message:r.message,options:r.options};
 if(r.action&&!r.action.dismissed)await page.getByRole('dialog').waitFor();
 result.dialog=await page.getByRole('dialog').count();result.browser=(await page.evaluate(()=>window.fengsha.externalBrowserStatus())).value;
 delete result.browser.socketURL;assert.ok(!/LOAD_FAILED|Chrome 网页已离开所选平台/.test(r.message||''));assert.deepEqual(result.errors,[]);
 if(r.action&&!r.action.dismissed)assert.ok(result.dialog>0,'Needs-action state must have visible guidance');
 assert.ok(r.scanned>0||r.action||r.status==='complete','Live search must either return data or specific actionable state');
 await page.screenshot({path:path.join(out,`live-${result.mode}.png`)});result.ok=true;
}catch(e){result.error=e.stack;process.exitCode=1;await page?.screenshot({path:path.join(out,`live-${result.mode}-failure.png`)}).catch(()=>{});}
finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(out,`live-${result.mode}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
