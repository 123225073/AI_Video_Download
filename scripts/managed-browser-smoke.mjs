import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {ManagedBrowser,browserCandidates} from '../electron/managed-browser.js';
import {ExternalBrowser} from '../electron/external-browser.js';

const out=path.resolve('output','managed-browser-'+Date.now());await fs.mkdir(out,{recursive:true});
const server=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><meta charset="utf-8"><title>Fengsha isolated browser acceptance</title><p>Local synthetic profile test only</p>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`,directory=path.join(out,'browser');
const options={directory,...(process.argv.includes('--edge')?{candidates:browserCandidates().filter(x=>x.kind==='edge')}:{})};
const managed=new ManagedBrowser(options);let browser;const result={isolated:true,directory,cases:[]};
async function localTarget(){
  const {targetId}=await browser.connection.send('Target.createTarget',{url,background:true});
  const {sessionId}=await browser.connection.send('Target.attachToTarget',{targetId,flatten:true});
  await browser.connection.send('Page.enable',{},sessionId);
  for(let i=0;i<100;i++){
    const r=await browser.connection.send('Runtime.evaluate',{expression:'location.href',returnByValue:true},sessionId);
    if(r.result?.value===url)return {targetId,sessionId};await delay(50);
  }
  throw Error('Local synthetic page did not load');
}
async function stopOwned(){
  if(!browser?.connection?.connected)return;
  // The endpoint was checked against this run's isolated profile file. This
  // test never discovers, connects to, or closes the user's normal browser.
  const own=await managed.inspect(await managed.selection());assert.equal(own?.socketURL,browser.connection.socket.url);
  const connection=browser.connection;
  await connection.send('Browser.close').catch(()=>{});
  for(let i=0;i<100&&connection.connected;i++)await delay(50);
  assert.equal(connection.connected,false);await browser.close();
}
try{
  const prepared=await managed.status();assert.equal(prepared.canStart,true);assert.equal(prepared.available,false);result.browser=prepared.browserName;
  browser=new ExternalBrowser({managed,connectTimeoutMs:10000});await browser.connect();
  const connection=browser.connection;await browser.connect();assert.equal(browser.connection,connection);assert.equal((await browser.status()).requiresApproval,false);
  result.cases.push('fresh profile starts automatically and repeated opens reuse one connection without default-profile permission');
  const first=await localTarget();
  await connection.send('Runtime.evaluate',{expression:'localStorage.setItem("fengsha-synthetic","persistent-fixture"); document.title',returnByValue:true},first.sessionId);
  await delay(1000);await stopOwned();
  browser=new ExternalBrowser({managed:new ManagedBrowser(options),connectTimeoutMs:10000});await browser.connect();const second=await localTarget();
  const recovered=await browser.connection.send('Runtime.evaluate',{expression:'localStorage.getItem("fengsha-synthetic")',returnByValue:true},second.sessionId);assert.equal(recovered.result?.value,'persistent-fixture');
  result.cases.push('normal shutdown and restart preserve synthetic local data in the dedicated profile');
  await delay(1000);assert.equal(browser.connection.connected,true);result.cases.push('background startup remains connected and only this run browser is closed');result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;}
finally{try{await stopOwned();}catch(error){result.cleanupError=error.message;process.exitCode=1;}await new Promise(resolve=>server.close(resolve));await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
