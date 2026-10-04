// Read-only recovery fixture: no certificate is installed and no proxy is changed.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {Store} from '../electron/store.js';import {CollectorConnection} from '../electron/collector-connection.js';
const output=path.resolve('output',`collector-guard-${Date.now()}`),store=await Store.open(output,{}),connection=new CollectorConnection(store,path.resolve('bin'),output,()=>{});const result={output,changedSystemSettings:false,ok:false};
let owner;
try {
 const before=await connection.system('inspect'),id=randomUUID(),file=path.join(output,`lease-${id}.json`);
 owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 const inspected=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('bin/collector/collector-system.ps1'),'-Action','inspect','-OwnerProcess',String(owner.pid)],{windowsHide:true,encoding:'utf8'}));
 fs.writeFileSync(file,JSON.stringify({schema:1,id,owner:owner.pid,ownerStarted:inspected.ownerStarted,before:before.proxy,proxyAddress:'127.0.0.1:2023',certificateName:'Fengsha-WeChat-test',certificateAdded:false,phase:'prepared'}));
 await connection.startGuard(file);
 assert.equal(JSON.parse(fs.readFileSync(file)).phase,'prepared');owner.kill();
 for(let i=0;i<30;i++){if(JSON.parse(fs.readFileSync(file)).phase==='restored')break;await new Promise(r=>setTimeout(r,250));}
 assert.equal(JSON.parse(fs.readFileSync(file)).phase,'restored');const after=await connection.system('inspect');assert.deepEqual(after.proxy,before.proxy);result.nativeGuardStarted=true;result.deadOwnerDetected=true;result.proxyUnchanged=true;result.ok=true;
}catch(error){result.error=String(error.stack || error);process.exitCode=1;}
finally{owner?.kill();store.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
