import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {_electron as electron} from 'playwright';
const require=createRequire(import.meta.url),output=path.resolve('output/repair-085/clear-e2e-'+Date.now()),profile=path.join(output,'profile');fs.mkdirSync(output,{recursive:true});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:profile,FENGSHA_TEST_VISIBLE:'1'};delete env.ELECTRON_RUN_AS_NODE;let app;const result={output,errors:[]};
async function launch(){app=await electron.launch({executablePath:require('electron'),args:[path.resolve('.')],env,timeout:45000});const page=await app.firstWindow();page.on('pageerror',e=>result.errors.push(e.message));await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();return page;}
try{
 let page=await launch();const fixture=await app.evaluate(async()=>{
  const t=globalThis.fengshaTest,one=t.accounts.add('B站','待删除的测试账号'),two=t.accounts.add('B站','保留的测试账号');
  for(const a of [one,two]){await t.accounts.getSession(a.id).cookies.set({url:'https://www.bilibili.com',domain:'.bilibili.com',name:'SESSDATA',value:'synthetic-fixture-only',expirationDate:Math.floor(Date.now()/1000)+3600});await t.accounts.complete(a.id);await t.accounts.cookieFile('B站',a.id);}
  t.store.put('creator','fixture-creator',{id:'fixture-creator',source:'https://example.test/creator',creator:{id:'fixture-author',name:'清除测试博主',platform:'视频号',supported:true},items:[],scanned:0,skipped:{},status:'identified'});t.store.put('meta','lastCreator',{id:'fixture-creator'});
  t.store.put('content-draft','keep',{id:'keep',body:'保留资料'});t.store.flush();t.accounts.changed();return {one:one.id,two:two.id};
 });
 const sessionDir=id=>path.join(profile,'accounts','sessions',id);
 // Resolve the directory from the real AccountManager, without copying any real credentials.
 const accountDir=await app.evaluate(()=>globalThis.fengshaTest.accounts.directory);
 for(const id of [fixture.one,fixture.two])assert.ok(fs.existsSync(path.join(accountDir,'sessions',id,'session.encrypted')));
 await page.locator('nav').getByRole('button',{name:'账号管理',exact:true}).click();const row=page.locator('.account-row').filter({hasText:'待删除的测试账号'});await row.getByRole('button',{name:'删除账号及会话',exact:true}).click();
 assert.match(await page.getByRole('dialog').innerText(),/不会注销平台账号/);await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await row.count(),1);
 await app.evaluate(()=>globalThis.fengshaTest.creators.active={label:'fixture busy'});await row.getByRole('button',{name:'删除账号及会话',exact:true}).click();await page.getByRole('button',{name:'确认删除账号及会话',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/任务结束/);await page.getByRole('button',{name:'取消',exact:true}).click();await app.evaluate(()=>globalThis.fengshaTest.creators.active=null);
 await row.getByRole('button',{name:'删除账号及会话',exact:true}).click();await page.getByRole('button',{name:'确认删除账号及会话',exact:true}).click();await row.waitFor({state:'hidden'});
 await new Promise(r=>setTimeout(r,400));
 const after=await app.evaluate(async(_,{one,two})=>{const t=globalThis.fengshaTest;return {gone:!t.store.get('account',one),active:t.accounts.active('B站'),cookies:(await t.accounts.getSession(one).cookies.get({})).length,otherCookies:(await t.accounts.getSession(two).cookies.get({})).length,otherExists:!!t.store.get('account',two),draft:t.store.get('content-draft','keep')};},fixture);
 assert.equal(after.gone,true);assert.equal(after.active,null);assert.equal(after.cookies,0);assert.equal(after.otherExists,true);assert.ok(after.otherCookies>0);assert.equal(after.draft.body,'保留资料');
 for(const filename of ['session.encrypted','session.encrypted.tmp','download-cookies.txt'])assert.equal(fs.existsSync(path.join(accountDir,'sessions',fixture.one,filename)),false);
 assert.ok(fs.existsSync(path.join(accountDir,'sessions',fixture.two,'session.encrypted')));result.accountRemoval=after;
 await page.locator('nav').getByRole('button',{name:'博主批量下载',exact:true}).click();await page.getByRole('button',{name:'清除博主历史',exact:true}).click();await page.getByRole('button',{name:'清除全部博主历史',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.equal((await page.evaluate(()=>window.fengsha.creatorLast())).value,null);await app.close();app=null;
 page=await launch();const restarted=await app.evaluate(async(_,{one,two})=>{const t=globalThis.fengshaTest;return {gone:!t.store.get('account',one),otherExists:!!t.store.get('account',two),otherCookies:(await t.accounts.getSession(two).cookies.get({})).length,creators:t.store.list('creator').length,last:t.creators.last(),draft:t.store.get('content-draft','keep')};},fixture);
 assert.equal(restarted.gone,true);assert.equal(restarted.otherExists,true);assert.ok(restarted.otherCookies>0);assert.equal(restarted.creators,0);assert.equal(restarted.last,null);assert.equal(restarted.draft.body,'保留资料');result.restart=restarted;assert.deepEqual(result.errors,[]);result.ok=true;
}catch(e){result.error=e.stack;process.exitCode=1;}finally{await app?.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));fs.writeFileSync('output/repair-085/clear-e2e-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
