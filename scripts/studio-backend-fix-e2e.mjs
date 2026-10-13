import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {build} from 'vite';

// Reuse the established mock-only comparison E2E, with an independent renderer
// and the application's own isolated test profile. Never rebuild shared dist.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'output',`studio-backend-fix-e2e-${Date.now()}-${process.pid}`);
const rendererRoot=path.join(output,'renderer');fs.mkdirSync(rendererRoot,{recursive:true});
await build({root,logLevel:'warn',build:{outDir:path.join(rendererRoot,'dist'),emptyOutDir:false}});
let runner=fs.readFileSync(path.join(root,'scripts/studio-compare-e2e.mjs'),'utf8');
const replace=(from,to)=>{if(!runner.includes(from))throw Error('E2E anchor changed: '+from.slice(0,100));runner=runner.replace(from,to);};
replace("from './test-renderer.mjs'",`from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/test-renderer.mjs')).href)}`);
replace("const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');",`const root=${JSON.stringify(root)};`);
replace("const output=path.join(root,'output',`studio-compare-${Date.now()}-${process.pid}`);",`const output=${JSON.stringify(output)};`);
runner=runner.replaceAll('reloadTestRenderer(app)','loadOwnedRenderer(app)');
runner+=`\nasync function loadOwnedRenderer(application){const previous=process.cwd();try{process.chdir(${JSON.stringify(rendererRoot)});await reloadTestRenderer(application);}finally{process.chdir(previous);}}\n`;
// The old audit proved this exact completion-without-EOF scenario. Keep the
// transport open after finish_reason=stop; production readTextStream must settle.
replace("done=true;cleanup();stream.close();", "done=true;cleanup();/* Deliberately keep the model stream open after completion. */");
replace("checked('whole-remix-real-sse-and-gpt-image-2.5-edits-contract');", "checked('whole-remix-real-sse-and-gpt-image-2.5-edits-contract');await page.locator('.compare-image-pair').first().getByRole('button',{name:'AI 修改此图',exact:true}).isEnabled().then(enabled=>assert.equal(enabled,true));checked('visible-all-direction-enables-single-image-with-empty-hidden-image-direction');");
replace("checked('saved-copy-order-originals-and-png-bytes-survive-electron-restart');",`checked('saved-copy-order-originals-and-png-bytes-survive-electron-restart');
  assert.match(await page.locator('.studio-progress h2').innerText(),/已停止/);checked('cancelled-image-reason-visible-after-electron-restart');
  await app.evaluate(()=>{globalThis.fengshaTest.contentStudio.fetcher=async()=>new Response('{}',{status:503});});
  await page.getByLabel('整篇二创要求',{exact:true}).fill('失败回归轻调');await page.locator('.compare-image-pair').first().getByRole('button',{name:'AI 修改此图',exact:true}).click();await idle();
  await page.getByRole('button',{name:'返回搜索',exact:true}).click();await page.getByRole('button',{name:'打开当前二创稿',exact:true}).click();await idle();
  assert.match(await page.locator('.studio-progress h2').innerText(),/503/);assert.match(await page.locator('.compare-image-pair').first().innerText(),/503/);checked('image-503-persists-and-is-visible-on-workspace-reentry');await capture('image-503-reentry.png');
  const savedFailure=await current();assert.equal(savedFailure.imageOperation.status,'failed');assert.deepEqual(savedFailure.assetOrder,cancelled.assetOrder);
  await app.evaluate(()=>{const t=globalThis.fengshaTest;t.contentStudio.fetcher=async()=>{const d=t.contentStudio.get(t.store.get('meta','lastContentDraft').id),png=t.nativeFixturePng;return new Response(JSON.stringify({data:[{b64_json:t.compareFixture.originalPngs[0]}]}));};});
  await page.getByLabel('整篇二创要求',{exact:true}).fill('成功重试轻调');await page.locator('.compare-image-pair').first().getByRole('button',{name:'AI 修改此图',exact:true}).click();await idle();
  await page.getByRole('button',{name:'返回搜索',exact:true}).click();await page.getByRole('button',{name:'打开当前二创稿',exact:true}).click();await idle();
  assert.doesNotMatch(await page.locator('.studio-progress h2').innerText(),/503|已停止/);assert.doesNotMatch(await page.locator('.compare-image-pair').first().innerText(),/503/);assert.equal((await current()).imageOperation.status,'completed');checked('successful-image-retry-removes-stale-failure-from-visible-workspace');`);
const file=path.join(output,'runner.mjs');fs.writeFileSync(file,runner);
console.log('Independent renderer/profile:',output);
const child=spawn(process.execPath,[file],{cwd:root,env:{...process.env},stdio:'inherit',windowsHide:true});
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
