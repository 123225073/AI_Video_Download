import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {CollectorConnection} from '../electron/collector-connection.js';import {ClashRoute,routeName} from '../electron/clash-route.js';
import net from 'node:net';import tls from 'node:tls';
const directory=path.resolve('output',`clash-route-smoke-${Date.now()}`),records=new Map(),store={get:(k,id)=>records.get(k+id),put:(k,id,v)=>records.set(k+id,v),flush(){}};
const connection=new CollectorConnection(store,path.resolve(process.argv[2]||'bin'),directory,()=>{}),routing=new ClashRoute(),result={ok:false,realClash:true};let plan,before,context,selectors;
function verifiedPage(proxy,certificate,host='channels.weixin.qq.com',requestPath='/finder-preview/pages/sph?id=AQ8CxoKEtN'){
 return new Promise((resolve,reject)=>{
  const [hostname,port]=proxy.split(':'),socket=net.connect({host:hostname,port:Number(port)});let headers=Buffer.alloc(0),stage='CONNECT';
  socket.setTimeout(45000,()=>socket.destroy(new Error(`TLS probe timeout: ${host} ${stage}`)));socket.on('error',reject);
  socket.once('connect',()=>socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
  const onData=b=>{
   headers=Buffer.concat([headers,b]);const end=headers.indexOf('\r\n\r\n');if(end<0)return;socket.off('data',onData);
   if(!/^HTTP\/1\.[01] 200/.test(headers.toString()))return reject(new Error('CONNECT refused'));
   if(headers.length>end+4)socket.unshift(headers.subarray(end+4));stage='handshake';
   const secure=tls.connect({socket,servername:host,...(certificate?{ca:fs.readFileSync(certificate)}:{}),rejectUnauthorized:true});let body='';secure.on('error',reject);
   secure.once('secureConnect',()=>{stage='HTTP';secure.write(`${host==='github.com'?'HEAD':'GET'} ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);});
   secure.on('data',b=>{body+=b;if(host==='github.com'&&body.includes('\r\n\r\n')){resolve(body);secure.end();}});secure.on('end',()=>resolve(body));
  };socket.on('data',onData);
 });
}
try{
 before=await connection.system('inspect');context=routing.load();assert.ok(context);selectors=await routing.selectors(context);plan=await routing.discover(before.proxy);assert.ok(plan);await connection.prepare();
 await connection.api('/api/proxy/config',{values:{'proxy.enabled':true,'proxy.system':false,'proxy.hostname':'127.0.0.1','proxy.port':2023,'proxy.skipInstallRootCert':true,'proxy.tun':false,'proxy.upstreamProxy':''},restart:true},30000);
 await routing.begin(plan);
 result.routeTargetBefore=(await routing.api(context,`/proxies/${routeName}`)).now;
 const proxy=before.proxy.ProxyServer.value;
 const body=await verifiedPage(proxy,connection.certificate.file);result.certificateChainVerified=true;
 result.httpStatus=body.split('\r\n')[0];result.publicResponseBytes=body.length;fs.writeFileSync(path.join(directory,'public-page-response.txt'),body);
 result.pageReadable=body.includes('<html')||body.includes('<!DOCTYPE');result.injected=/__assets|WXEnv|channelsWSURL|wxchannels\/inject/.test(body);assert.ok(result.pageReadable);assert.ok(result.injected,'视频号页面必须经过采集器注入，不能把原网页成功当作连接成功');
 const now=await routing.api(context,`/proxies/${routeName}`);result.routeTarget=now.now;assert.equal(now.now,'Fengsha-WeChat-Local');
 const github=await verifiedPage(proxy,null,'github.com','/');result.githubHttp=Number(github.split(' ')[1]);assert.equal(result.githubHttp,200);assert.deepEqual(await routing.selectors(context),selectors);result.otherNodesUnchanged=true;result.ok=true;
}catch(error){result.error=error.message;}
finally{
 if(plan)try{await routing.restore(plan);const rules=await routing.api(context,'/rules');assert.ok(!rules.rules.some(r=>r.proxy===routeName));result.routeRemoved=true;assert.deepEqual(await routing.selectors(context),selectors);}catch(e){result.restoreError=e.message;result.ok=false;}
 await connection.api('/api/proxy/config',{values:{'proxy.enabled':false,'proxy.system':false},restart:true}).catch(()=>{});await connection.close();
 if(before){result.windowsProxyUnchanged=JSON.stringify(before.proxy)===JSON.stringify((await connection.system('inspect')).proxy);assert.ok(result.windowsProxyUnchanged);}
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}
