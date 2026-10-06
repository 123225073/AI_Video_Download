import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {_electron as electron} from 'playwright';
const program=path.resolve(process.argv[2]||'release/win-unpacked'),output=path.resolve('output',`packaged-login-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const profile=path.join(output,'profile'),source='https://space.bilibili.com/237602907/video',version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.FENGSHA_TEST_MODE;delete env.FENGSHA_TEST_DATA;
const result={output,ok:false,mock:false,realLoginUsed:false};let app,page;const errors=[];
try{
 app=await electron.launch({executablePath:path.join(program,'FengshaVideoDownloader.exe'),args:['--agent-data-dir',profile],env,timeout:45000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();
 await app.evaluate(({session,BrowserWindow})=>{globalThis.loginSmokeRequests=0;session.fromPartition('fengsha-creator-guest-B站').webRequest.onBeforeRequest({urls:['https://api.bilibili.com/*']},(_d,callback)=>{globalThis.loginSmokeRequests++;callback({});});BrowserWindow.getAllWindows()[0].setSize(1080,720);});
 const before=(await page.evaluate(()=>window.fengsha.snapshot())).value;assert.equal(before.version,version);assert.equal(before.accounts.length,0);result.version=before.version;
 await page.getByLabel('视频链接').fill(source);await page.getByRole('button',{name:'识别博主',exact:true}).click();const dialog=page.getByRole('dialog',{name:'请先登录 B站账号',exact:true});await dialog.waitFor();await page.screenshot({path:path.join(output,'安装程序-未登录前置提示.png')});
 await dialog.getByRole('button',{name:'暂不执行',exact:true}).click();assert.equal((await page.evaluate(()=>window.fengsha.creatorLast())).value,null);
 const denied=await page.evaluate(source=>window.fengsha.creatorIdentify(source),source);assert.equal(denied.ok,false);assert.equal(denied.code,'BILIBILI_LOGIN_REQUIRED');result.nativeBackendGate=true;
 const cli=await new Promise((resolve,reject)=>{const child=spawn(path.join(program,'resources/bin/node/node.exe'),[path.join(program,'resources/cli/fengsha.mjs'),'creator',source,'--data-dir',profile],{env,windowsHide:true});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
 assert.equal(cli.code,1,cli.stdout+cli.stderr);assert.equal(JSON.parse(cli.stdout).error.code,'BILIBILI_LOGIN_REQUIRED');result.bundledCliGate=true;
 await page.getByRole('button',{name:'登录后读取',exact:true}).click();await dialog.getByRole('button',{name:'去登录 B站',exact:true}).click();await page.getByRole('heading',{name:'账号管理',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'B站',exact:true}).getAttribute('class'),'selected');await page.getByRole('button',{name:'返回博主读取',exact:true}).click();assert.equal(await page.getByLabel('博主链接').inputValue(),source);result.loginNavigationPreservesInput=true;
 const after=(await page.evaluate(()=>window.fengsha.snapshot())).value;for(const key of ['settings','accounts','tasks','media','ai','transcriptions'])assert.deepEqual(after[key],before[key]);result.noRecordsChanged=true;
 assert.equal(await app.evaluate(()=>globalThis.loginSmokeRequests),0);result.platformRequests=0;assert.deepEqual(errors,[]);result.rendererErrors=errors;result.ok=true;
}catch(e){result.error=String(e.stack||e);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
