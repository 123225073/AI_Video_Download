import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';

// Native ES-module recovery in Chromium. All responses belong to this isolated
// fixture session; no platform account, system proxy or certificate is changed.
const output=path.resolve('output/collector-content-e2e-'+Date.now());
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('.')],env,timeout:45000});
  await app.firstWindow();
  const result=await app.evaluate(async({BrowserWindow,session},source)=>{
    const s=session.fromPartition('collector-module-fixture');await s.setProxy({mode:'direct'});
    const moduleURL='https://res.wx.qq.com/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.publishFixture.js';
    let requests=0;
    s.protocol.handle('https',request=>{
      if(request.url===moduleURL){requests++;return new Response('globalThis.moduleRuns=(globalThis.moduleRuns||0)+1;const service={finderSearch:async function(p){if(this!==service)throw Error("lost receiver");globalThis.calls.push(p);return {errCode:0,data:{objectList:[],objectContinueFlag:p.offset?0:1,offset:20,lastBuff:"cursor"}};}};export {service as Z};',{headers:{'content-type':'application/javascript','access-control-allow-origin':'*'}});}
      return new Response(`<script>globalThis.calls=[];globalThis.sent=[];globalThis.WXU={onAPILoaded(){}};globalThis.ws_client$={methods:{__wx_handle_api_call:async()=>{}}};</script><script type="module">import '${moduleURL}';globalThis.moduleReady=true;</script>`,{headers:{'content-type':'text/html'}});
    });
    const w=new BrowserWindow({show:false,webPreferences:{session:s,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try{
      await w.loadURL('https://channels.weixin.qq.com/fixture');
      await w.webContents.executeJavaScript('new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(globalThis.moduleReady)return resolve();if(Date.now()-start>5000)return reject(Error("module load timeout"));setTimeout(check,10)};check()})');
      await w.webContents.executeJavaScript(source);
      return await w.webContents.executeJavaScript(`(async()=>{const request=async marker=>{await ws_client$.methods.__wx_handle_api_call({id:'fixture',key:'key:channels:contact_list',data:{keyword:'__fengsha_content__:'+JSON.stringify({query:'fixture',requestId:'same'}),next_marker:marker||''}},{readyState:1,send:v=>sent.push(JSON.parse(v))});return sent.at(-1).data;};const first=await request();const second=await request(encodeURIComponent(first.data.fengshaNextMarker));return {first,second,calls,moduleRuns};})()`);
    }finally{w.destroy();}
  },fs.readFileSync('electron/collector-content.js','utf8'));
  assert.equal(result.first.errCode,0);assert.equal(result.second.errCode,0);
  assert.equal(result.moduleRuns,1);assert.equal(result.calls.length,2);
  assert.equal(result.calls[1].offset,20);assert.equal(result.calls[1].requestId,'same');
  assert.equal(result.second.data.objectContinueFlag,0);
  fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:true,nativeModuleRecovered:true,singletonPreserved:true,pagination:true,output}));
}finally{if(app)await app.close();}
