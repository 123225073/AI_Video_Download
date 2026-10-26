import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {_electron as electron} from 'playwright';
const output=path.resolve('output/articles-public-live-'+Date.now());fs.mkdirSync(output,{recursive:true});const profile=path.join(output,'profile');
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let app;const result={kind:'real supplied public article in an isolated profile; no account-list API request and no imported login'};
try{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve(process.env.FENGSHA_E2E_APP||'.'),'--agent-data-dir',profile],env,timeout:45000});
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),profile);
 for(let n=0;n<100&&!await app.evaluate(()=>!!globalThis.fengshaTest?.ready);n++)await new Promise(r=>setTimeout(r,100));
 result.article=await app.evaluate(async()=>{
  const a=globalThis.fengshaTest.articles;a.reader.accountAccess.block();
  await a.start({mode:'links',platform:'公众号',input:'https://mp.weixin.qq.com/s/HeK2GlRBGJGFDMg73HjikA',limit:1});
  const item=a.record.items[0];if(item.status!=='identified')return {status:item.status,message:item.error};
  await a.collect([item.id]);const saved=a.view().library[0];
  return {status:item.status,title:item.title,author:item.author,date:item.publishedAt,saved:!!saved,savedImages:saved?.savedImages,imageCount:saved?.imageCount,error:item.error};
 });
 assert.equal(result.article.author,'编程进阶录');assert.ok(result.article.saved);assert.equal(result.article.status,'saved');result.ok=true;
}catch(e){result.error=e.stack;process.exitCode=1;}finally{await app?.close().catch(()=>{});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,output}));}
