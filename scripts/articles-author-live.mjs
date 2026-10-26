import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
const output=path.resolve('output/articles-author-live-'+Date.now());fs.mkdirSync(output,{recursive:true});
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
let app;const result={output,kind:'live user article identity and unauthenticated flow; account list not authorized'};
try{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('.')],env,timeout:45000});
 for(let i=0;i<150;i++){if(await app.evaluate(()=>globalThis.fengshaTest?.ready))break;await new Promise(r=>setTimeout(r,100));}
 const request={mode:'author',platform:'公众号',input:'https://mp.weixin.qq.com/s/HeK2GlRBGJGFDMg73HjikA',limit:5};
 result.identity=await app.evaluate(async(_e,request)=>{const a=globalThis.fengshaTest.articles;await a.identifyAuthor(request);return {status:a.view().discovery.status,account:a.view().discovery.authorContext,message:a.view().discovery.message,library:a.view().library.length};},request);
 assert.equal(result.identity.status,'identified');assert.equal(result.identity.account.name,'编程进阶录');assert.equal(result.identity.account.biz,'MzkwNjQ0MTIzNA==');assert.ok(result.identity.account.avatar);assert.equal(result.identity.library,0);
 result.fetch=await app.evaluate(async(_e,request)=>{const a=globalThis.fengshaTest.articles;await a.start(request);const r=a.view().discovery;return {status:r.status,action:r.action,count:r.items.length,message:r.message,account:r.authorContext};},request);
 result.windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),host:(()=>{try{return new URL(w.webContents.getURL()).hostname;}catch{return '';}})()})));
 assert.equal(result.fetch.action,'wechat-login');assert.equal(result.fetch.count,0);assert.equal(result.windows.some(w=>w.visible),false);assert.equal(result.windows.some(w=>w.host==='weixin.sogou.com'),false);result.ok=true;
}catch(e){result.error=e.stack;process.exitCode=1;}finally{if(app)await app.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
