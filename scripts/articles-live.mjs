import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {_electron as electron} from 'playwright';import init from 'sql.js';
const output=path.resolve('output/articles-live-'+Date.now());fs.mkdirSync(output,{recursive:true});
const require=createRequire(import.meta.url),env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_EXTERNAL_BROWSER:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const installed=path.resolve('../风沙全平台视频下载器/用户数据'),SQL=await init({wasmBinary:fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))}),db=new SQL.Database(fs.readFileSync(path.join(installed,'library.sqlite')));
const records=db.exec("SELECT data FROM records WHERE kind='content-search'").flatMap(r=>r.values).map(([v])=>JSON.parse(v));db.close();
const sample=records.flatMap(r=>r.platform==='小红书'?r.all||[]:[]).find(i=>i.type==='image');
let endpoint=null;try{const port=Number(fs.readFileSync(path.join(installed,'browser/chrome/DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);if(port>0&&port<65536)endpoint=`http://127.0.0.1:${port}`;}catch{}
const result={output,kind:'live public platform requests',wechat:{},xhs:{}};let app;
try{
  app=await electron.launch({executablePath:require('electron'),args:[path.resolve('.')],env,timeout:45000});
  for(let i=0;i<100;i++){if(await app.evaluate(()=>globalThis.fengshaTest?.ready))break;await new Promise(r=>setTimeout(r,100));}
  const discovered=await app.evaluate(async()=>{const a=globalThis.fengshaTest.articles;await a.start({mode:'search',platform:'公众号',input:'微信派',limit:10});return a.view().discovery;});
  result.wechat.search={status:discovered.status,count:discovered.items.length,message:discovered.message};
  for(const item of discovered.items.filter(i=>i.author==='微信派').slice(0,2)){
    const saved=await app.evaluate(async(_e,id)=>{const a=globalThis.fengshaTest.articles;await a.collect([id]);return a.view();},item.id);
    result.wechat.collect={status:saved.discovery.status,item:saved.discovery.items.find(i=>i.id===item.id),library:saved.library};
    if(saved.library.length)break;
  }
  const author=await app.evaluate(async()=>{const a=globalThis.fengshaTest.articles;await a.start({mode:'author',platform:'公众号',input:'微信派',limit:10});return a.view().discovery;});result.wechat.author={status:author.status,count:author.items.length,allAuthorsMatch:author.items.every(i=>i.author==='微信派'),message:author.message};
  if(endpoint&&sample){
    result.xhs.connection=await app.evaluate(async(_e,endpoint)=>{const t=globalThis.fengshaTest,external=new t.accounts.externalBrowser.constructor({endpoint,discover:false,timeoutMs:3000,connectTimeoutMs:10000});const status=await external.status();if(status.available){t.articles.reader.close();t.articles.reader=new t.articles.reader.constructor(t.accounts,{externalBrowser:external});}return status;},endpoint);
    if(result.xhs.connection.available){
      const saved=await app.evaluate(async(_e,url)=>{const a=globalThis.fengshaTest.articles;await a.start({mode:'links',platform:'小红书',input:url});await a.collect(a.view().discovery.items.map(i=>i.id));return a.view();},sample.url);
      result.xhs.collect={status:saved.discovery.status,items:saved.discovery.items.map(({url,...i})=>i),library:saved.library.filter(i=>i.platform==='小红书')};
      const profile=await app.evaluate(async()=>{const w=globalThis.fengshaTest.articles.reader.detail.window;return w&&!w.isDestroyed()?w.webContents.executeJavaScript(`document.querySelector('.author-container a[href*="/user/profile/"],.note-container .author a[href*="/user/profile/"]')?.href||null`):null;});
      if(profile){const author=await app.evaluate(async(_e,input)=>{const a=globalThis.fengshaTest.articles;await a.start({mode:'author',platform:'小红书',input,limit:3});return a.view().discovery;},profile);result.xhs.author={status:author.status,count:author.items.length,message:author.message};}
      const search=await app.evaluate(async()=>{const a=globalThis.fengshaTest.articles;await a.start({mode:'search',platform:'小红书',input:'读书',limit:3});return a.view().discovery;});result.xhs.search={status:search.status,count:search.items.length,message:search.message};
    }
  }else result.xhs.message='No current managed-browser endpoint or image-note sample';
  result.offlineImages=await app.evaluate(async({BrowserWindow})=>{const result=[];for(const article of globalThis.fengshaTest.articles.view().library){const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false}});try{await w.loadFile(article.directory+'/article.html');const images=await w.webContents.executeJavaScript('[...document.images].map(i=>({loaded:i.complete&&i.naturalWidth>0,width:i.naturalWidth,height:i.naturalHeight}))');result.push({title:article.title,status:article.status,images});}finally{w.destroy();}}return result;});
}catch(e){result.error=e.stack;}finally{if(app)await app.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
