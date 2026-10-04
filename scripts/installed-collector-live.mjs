// Real installed workflow: automatic temporary trust; WeChat's page provides the bridge.
import {_electron as electron} from 'playwright';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {command} from '../electron/engine.js';
const executablePath=path.resolve(process.argv[2]),source=process.argv[3],output=path.resolve('output',`installed-collector-live-${Date.now()}`);
fs.mkdirSync(output,{recursive:true});const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let application,page,last='',cancelled=false;const result={output,installedRealWechat:true,ok:false};
async function snapshot(){const r=await page.evaluate(()=>window.fengsha.snapshot());assert.ok(r.ok);return r.value;}
async function waitFor(predicate,timeout=360000){const until=Date.now()+timeout;while(Date.now()<until){const state=await snapshot();const label=state.collectorConnection?.label;if(label!==last){last=label;console.log(JSON.stringify({phase:state.collectorConnection?.phase,label}));}if(cancelled)throw new Error('CANCELLED');if(await predicate(state))return state;await new Promise(r=>setTimeout(r,1000));}throw new Error('真实微信验收等待超时');}
process.on('SIGINT',()=>{cancelled=true;void page?.evaluate(()=>window.fengsha.creatorCancel()).catch(()=>{});});
try{
 application=await electron.launch({executablePath,env,timeout:45000});page=await application.firstWindow();
 await page.locator('nav').getByRole('button',{name:'博主批量下载',exact:true}).click();await page.getByLabel('博主链接').fill(source);
 const initial=await snapshot();result.version=initial.version;assert.equal(initial.collectorConnection.allowed,true,'Missing existing explicit collector consent');
 await page.getByRole('button',{name:/^识别(新)?博主$/}).click();await page.waitForTimeout(500);
 await waitFor(state=>!state.creatorProgress);
 const identified=await page.evaluate(()=>window.fengsha.creatorLast());assert.ok(identified.ok);const record=identified.value;
 assert.ok(record?.source===source&&record.creator.supported,await page.locator('main').innerText());result.author={name:record.creator.name,id:record.creator.id,hasAvatar:Boolean(record.creator.avatar)};
 console.log(JSON.stringify({author:record.creator.name,identified:true}));
 await page.getByLabel('作品读取数量').selectOption('custom');await page.getByLabel('自定义作品条数').fill('5');
 await page.getByRole('button',{name:'确认博主并读取作品',exact:true}).click();await page.waitForTimeout(500);await waitFor(state=>!state.creatorProgress);
 const list=(await page.evaluate(()=>window.fengsha.creatorLast())).value;assert.ok(list.items.length,'No real author videos');
 result.items=list.items.map(i=>({id:i.sourceId,title:i.title,hasCover:Boolean(i.thumbnail),hasShareUrl:Boolean(i.url)}));result.total=list.total;
 await page.screenshot({path:path.join(output,'真实作者作品清单.png')});
 const item=list.items.find(i=>i.available);assert.ok(item);await page.getByLabel(`选择 ${item.title}`,{exact:true}).check();await page.getByRole('button',{name:'加入下载队列 (1)',exact:true}).click();
 const downloaded=await waitFor(state=>{const task=state.tasks.find(t=>t.item.key===item.key);if(task&&['failed','cancelled'].includes(task.status))throw new Error(task.error||task.status);return state.media.some(m=>m.id===item.key&&m.exists);},420000);
 const media=downloaded.media.find(m=>m.id===item.key);await command(path.join(path.dirname(executablePath),'resources/bin/ffmpeg/ffmpeg.exe'),['-v','error','-xerror','-i',media.filePath,'-f','null','-']);
 result.download={filePath:media.filePath,duration:media.duration,size:media.size};result.fullMediaDecode=true;
 await waitFor(state=>state.collectorConnection.phase==='idle',60000);result.ok=true;
}catch(error){result.error=String(error.message).slice(-1800);process.exitCode=1;}
finally{
 if(page){await page.evaluate(()=>window.fengsha.creatorCancel()).catch(()=>{});await page.screenshot({path:path.join(output,'最终界面.png')}).catch(()=>{});}
 if(application)await application.close().catch(()=>{});
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
