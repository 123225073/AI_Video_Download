import { _electron as electron } from 'playwright';
import {createRequire} from 'node:module';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),root=path.resolve('.'),output=path.resolve('output',`wechat-download-e2e-${Date.now()}`);fs.mkdirSync(output,{recursive:true});
const original=path.join(output,'原始测试视频.mp4'),fixtureBin=path.join(output,'test-bin'),key='918273645546372819';
execFileSync(path.join(root,'bin/ffmpeg/ffmpeg.exe'),['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=25','-t','3','-c:v','mpeg4',original],{windowsHide:true});
const decoder=require('../bin/wechat/decrypt.cjs');await decoder.ready;const encrypted=Buffer.from(fs.readFileSync(original)),mask=decoder.getDecryptionArray(key);for(let i=0;i<Math.min(mask.length,encrypted.length);i++)encrypted[i]^=mask[i];
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Length':encrypted.length});res.end(encrypted);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/fixture`;
fs.mkdirSync(path.join(fixtureBin,'wechat'),{recursive:true});for(const directory of ['node','ffmpeg'])fs.symlinkSync(path.join(root,'bin',directory),path.join(fixtureBin,directory),'junction');
fs.writeFileSync(path.join(fixtureBin,'wechat/download-link.cjs'),`const assert=require('node:assert/strict');const originalFetch=global.fetch;global.fetch=(url,options)=>{assert.equal(new URL(url).hostname,'finder.video.qq.com');return originalFetch(${JSON.stringify(endpoint)},options);};require(${JSON.stringify(path.join(root,'bin/wechat/download-link.cjs'))});`);
const env={...process.env,FENGSHA_TEST_MODE:'1',FENGSHA_TEST_DATA:path.join(output,'profile')};delete env.ELECTRON_RUN_AS_NODE;
let app,page;const result={output,platformData:'模拟微信接口与加密测试视频，不代表真实微信平台验收',ok:false};
try {
 app=await electron.launch({executablePath:require('electron'),args:[root],env});page=await app.firstWindow();await page.getByRole('heading',{name:'链接下载',exact:true}).waitFor();
 await app.evaluate(({},{fixtureBin,key})=>{const t=globalThis.fengshaTest;t.collectorConnection.withConnection=async(signal,operation)=>operation();t.wechatCreators.save({enabled:true,automatic:false});t.engine.wechat.bin=fixtureBin;
 const username='fixture-author@finder',id='12345678901234567890',object={id,objectNonceId:'nonce',contact:{username,nickname:'链路测试博主'},objectDesc:{mediaType:4,description:'微信直连下载测试',media:[{url:'https://finder.video.qq.com/encrypted-fixture',decodeKey:key,videoPlayLen:3}]}};
 t.wechatCreators.fetch=async url=>{const u=new URL(url);let data;if(u.pathname.endsWith('feed/profile'))data={object};else if(u.pathname.endsWith('feed/list'))data={contact:object.contact,object:[object],feedsCount:1,continueFlag:0,lastBuffer:''};else data={feedH5Url:'https://weixin.qq.com/sph/fixture'};return new Response(JSON.stringify({code:0,data:{errCode:0,data}}));};
 },{fixtureBin,key});
 await page.locator('nav').getByRole('button',{name:'博主批量下载',exact:true}).click();await page.getByLabel('博主链接').fill('https://weixin.qq.com/sph/fixture');await page.getByRole('button',{name:'识别博主',exact:true}).click();
 await page.getByRole('heading',{name:'链路测试博主',exact:true}).waitFor();await page.getByRole('button',{name:'确认博主并读取作品',exact:true}).click();await page.getByText('已读取至平台返回的末页',{exact:true}).waitFor();
 await page.getByRole('button',{name:'全选当前未下载',exact:true}).click();await page.getByRole('button',{name:'加入下载队列 (1)',exact:true}).click();await page.getByRole('heading',{name:'任务中心',exact:true}).waitFor();
 for(let i=0;i<180;i++){const r=await page.evaluate(async()=>(await window.fengsha.snapshot()).value.tasks[0]);if(r?.status==='completed')break;if(r?.status==='failed')throw new Error(r.message);await page.waitForTimeout(250);}
 const snapshot=await page.evaluate(async()=>(await window.fengsha.snapshot()).value);assert.equal(snapshot.accounts.length,0);assert.equal(snapshot.media.length,1);assert.equal(snapshot.tasks[0].item.acquisition,'wechat-collector');assert.deepEqual(fs.readFileSync(snapshot.media[0].filePath),fs.readFileSync(original));
 execFileSync(path.join(root,'bin/ffmpeg/ffmpeg.exe'),['-v','error','-xerror','-i',snapshot.media[0].filePath,'-f','null','-'],{windowsHide:true});
 assert.equal(fs.readFileSync(path.join(output,'profile/library.sqlite')).includes(Buffer.from(key)),false);result.noYuanbaoAccount=true;result.realEncryptedTransfer=true;result.fullMediaDecode=true;result.readSelectDownload=true;
 await page.screenshot({path:path.join(output,'作品下载完成.png')});result.ok=true;
}catch(error){result.error=String(error.stack || error);if(page)result.visible=await page.locator('main').innerText().catch(()=>'');process.exitCode=1;}
finally{await app?.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
