import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import {CollectorConnection} from '../electron/collector-connection.js';import {ClashRoute,routeName} from '../electron/clash-route.js';
import net from 'node:net';
const childMode=process.argv[2]==='--child',directory=childMode?process.argv[3]:path.resolve('output',`clash-route-crash-${Date.now()}`);fs.mkdirSync(directory,{recursive:true});
const bin=path.resolve((childMode?process.argv[4]:process.argv[2])||'bin');
const connection=new CollectorConnection({get(){},put(){},flush(){}},bin,directory,()=>{}),routing=new ClashRoute();
if(childMode){
 const before=await connection.system('inspect'),plan=await routing.discover(before.proxy);assert.ok(plan);await connection.prepare();
 const id=randomUUID(),lease=path.join(directory,`lease-${id}.json`);fs.writeFileSync(lease,JSON.stringify({schema:1,id,mode:'routed',routing:plan,owner:process.pid,ownerStarted:before.ownerStarted,before:before.proxy,proxyAddress:'127.0.0.1:2023',certificateName:connection.certificate.name,certificateFile:connection.certificate.file,certificateFingerprint:connection.certificate.fingerprint,certificateThumbprint:'',certificateAdded:false,phase:'prepared'}));
 await connection.guard(lease);
 await connection.api('/api/proxy/config',{values:{'proxy.enabled':true,'proxy.system':false,'proxy.hostname':'127.0.0.1','proxy.port':2023,'proxy.skipInstallRootCert':true,'proxy.tun':false,'proxy.upstreamProxy':''},restart:true},30000);
 await routing.begin(plan);fs.writeFileSync(path.join(directory,'ready.json'),JSON.stringify({lease}));setInterval(()=>{},1000);
}else{
 const before=await connection.system('inspect'),context=routing.load(),selectors=await routing.selectors(context),result={ok:false,realOwnerCrash:true};let child,lease;
 try{
  child=spawn(process.execPath,[path.resolve('scripts/clash-route-crash-smoke.mjs'),'--child',directory,bin],{windowsHide:true,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);child.stdout.resume();
  for(let i=0;i<100&&!fs.existsSync(path.join(directory,'ready.json'));i++){if(child.exitCode!==null)throw Error(`Child failed: ${errors.slice(0,300)}`);await new Promise(r=>setTimeout(r,500));}
  assert.ok(fs.existsSync(path.join(directory,'ready.json')));lease=JSON.parse(fs.readFileSync(path.join(directory,'ready.json'))).lease;
  child.kill();
  for(let i=0;i<90;i++){if(JSON.parse(fs.readFileSync(lease)).phase==='restored')break;await new Promise(r=>setTimeout(r,500));}
  assert.equal(JSON.parse(fs.readFileSync(lease)).phase,'restored');const rules=await routing.api(context,'/rules');assert.ok(!rules.rules.some(r=>r.proxy===routeName));assert.deepEqual(await routing.selectors(context),selectors);
  result.guardRemovedRoute=true;result.otherNodesUnchanged=true;result.windowsProxyUnchanged=JSON.stringify(before.proxy)===JSON.stringify((await connection.system('inspect')).proxy);assert.ok(result.windowsProxyUnchanged);
  const listening=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:2023});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});result.orphanProxyStopped=!listening;assert.ok(result.orphanProxyStopped);result.ok=true;
 }catch(e){result.error=e.message;}
 finally{if(child?.exitCode===null)child.kill();if(lease&&JSON.parse(fs.readFileSync(lease)).phase!=='restored')await connection.system('restore',lease);await connection.close();fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}
}
