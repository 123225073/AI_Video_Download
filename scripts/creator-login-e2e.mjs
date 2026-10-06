import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {request} from '../cli/protocol.mjs';
const output=path.resolve('output',`creator-login-e2e-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const profile=path.join(output,'profile'),source='https://space.bilibili.com/237602907/video';
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:profile,FENGSHA_TEST_VISIBLE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const result={output,ok:false,platformResponses:'isolated fixtures; no real login or Bilibili list request'},errors=[];let app,page;
try{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve(process.argv[2]||'.')],env,timeout:45000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1080,720));
 await app.evaluate(()=>{
  const {engine,store,win,accounts}=globalThis.fengshaTest;globalThis.loginTestCalls=[];engine.bilibili.interval=0;
  engine.bilibili.request=async url=>{const u=new URL(url);globalThis.loginTestCalls.push(u.pathname);let data;
   if(u.pathname.endsWith('/nav'))data={wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}};
   else if(u.pathname.endsWith('/card'))data={card:{mid:'237602907',name:'登录提示测试作者'},archive_count:1};
   else data={page:{pn:1,ps:30,count:1},list:{vlist:[{bvid:'BV1iaun65Ehn',mid:237602907,title:'登录后读取的模拟作品',author:'登录提示测试作者',pic:'https://i2.hdslb.com/login-test.jpg',length:'07:45',created:1791028800}]}};
   return {ok:true,status:200,json:async()=>({code:0,data})};};
  const record={id:'history',creator:{id:'237602907',platform:'B站',name:'已有作者',url:'https://space.bilibili.com/237602907/video',supported:true,adapter:'bilibili',accountId:null},source:'https://space.bilibili.com/237602907/video',items:[{key:'history-item',platform:'B站',sourceId:'BV1iaun65Ehn',url:'https://www.bilibili.com/video/BV1iaun65Ehn',title:'已保存历史视频',duration:465,publishedAt:'20261001',available:true}],seen:['history-item'],skipped:{},scanned:1,cursor:2,status:'interrupted',complete:false,filters:{limit:50,period:'all',excludeDownloaded:true}};
  store.put('creator',record.id,record);store.put('meta','lastCreator',{id:record.id});store.flush();win.webContents.send('fengsha:creator-changed',record);
  accounts.login=async id=>accounts.save({...accounts.account(id),status:'登录中'});
 });
 await page.route('https://i2.hdslb.com/**',route=>route.fulfill({path:path.resolve('assets/icon.png'),contentType:'image/png'}));
 await page.getByLabel('视频链接').fill(source);await page.getByRole('button',{name:'识别博主',exact:true}).click();
 const prompt=page.getByRole('dialog',{name:'请先登录 B站账号',exact:true});await prompt.waitFor();assert.equal(await app.evaluate(()=>globalThis.loginTestCalls.length),0);assert.ok(await prompt.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));result.smallWindowPromptFits=true;await page.screenshot({path:path.join(output,'01-未登录先提示.png')});
 await prompt.getByRole('button',{name:'暂不执行',exact:true}).click();assert.equal(await page.locator('.creator-item').count(),1);result.identifyBlockedWithoutLosingHistory=true;
 for(const button of ['确认博主并读取作品','继续读取','补全作品信息']){await page.getByRole('button',{name:button,exact:true}).click();await prompt.waitFor();await prompt.getByRole('button',{name:'暂不执行',exact:true}).click();}
 const denied=await page.evaluate(source=>window.fengsha.creatorIdentify(source),source);assert.equal(denied.code,'BILIBILI_LOGIN_REQUIRED');
 const cli=await request(profile,{command:'creator',source});assert.equal(cli.ok,false);assert.equal(cli.error.code,'BILIBILI_LOGIN_REQUIRED');assert.equal(await app.evaluate(()=>globalThis.loginTestCalls.length),0);result.allEntryPointsBlockedBeforeNetwork=true;
 await page.getByRole('button',{name:'登录后读取',exact:true}).click();await prompt.getByRole('button',{name:'去登录 B站',exact:true}).click();await page.getByRole('heading',{name:'账号管理',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'B站',exact:true}).getAttribute('class'),'selected');
 await page.getByRole('button',{name:'添加账号',exact:true}).first().click();await page.getByRole('dialog',{name:'添加平台账号'}).getByPlaceholder('例如：工作账号、素材账号').fill('登录提示测试账号');await page.getByRole('button',{name:'添加并打开官方登录',exact:true}).click();await page.getByRole('button',{name:'完成登录',exact:true}).waitFor();
 await app.evaluate(async()=>{const a=globalThis.fengshaTest.accounts,id=a.active('B站').id;await a.getSession(id).cookies.set({url:'https://www.bilibili.com/',domain:'.bilibili.com',path:'/',name:'buvid3',value:'SYNTHETIC-VISITOR'});});
 await page.getByRole('button',{name:'完成登录',exact:true}).click();await page.getByRole('status').filter({hasText:'尚未检测到 B站登录会话'}).waitFor();result.visitorCookieNotAcceptedAsLogin=true;
 await app.evaluate(async()=>{const a=globalThis.fengshaTest.accounts,id=a.active('B站').id;await a.getSession(id).cookies.set({url:'https://www.bilibili.com/',domain:'.bilibili.com',path:'/',name:'SESSDATA',value:'SYNTHETIC-LOGIN-E2E',expirationDate:Date.now()/1000+3600});});
 await page.getByRole('button',{name:'完成登录',exact:true}).click();await page.getByText('会话已保存',{exact:true}).waitFor();await page.getByRole('button',{name:'返回博主读取',exact:true}).click();assert.equal(await page.getByLabel('博主链接').inputValue(),source);assert.equal(await page.locator('.creator-item').count(),1);result.returnLinkAndHistoryPreserved=true;
 await page.getByRole('button',{name:'识别新博主',exact:true}).click();await page.getByRole('heading',{name:'登录提示测试作者',exact:true}).waitFor();await page.getByRole('button',{name:'确认博主并读取作品',exact:true}).click();await page.getByText('登录后读取的模拟作品',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.creator-item img')?.naturalWidth>0);result.savedSessionCanExecute=true;
 await app.evaluate(()=>{const a=globalThis.fengshaTest.accounts;a.markExpired('B站',a.active('B站').id);});await page.getByText(/当前 B站会话已过期/).first().waitFor();const before=await app.evaluate(()=>globalThis.loginTestCalls.length);await page.getByRole('button',{name:'确认博主并读取作品',exact:true}).click();await prompt.waitFor();assert.equal(await app.evaluate(()=>globalThis.loginTestCalls.length),before);result.expiredSessionPrompt=true;
 await prompt.getByRole('button',{name:'暂不执行',exact:true}).click();const history=await request(profile,{command:'creator',options:{record:'history'}});assert.equal(history.ok,true);assert.equal(history.data.items.length,1);result.historicalCLIReadStillAllowed=true;
 assert.deepEqual(errors,[]);result.rendererErrors=errors;result.ok=true;
}catch(e){result.error=String(e.stack||e);process.exitCode=1;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}
finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
