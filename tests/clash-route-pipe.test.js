import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {ClashRoute,parseClashConfig,routeName,routeRule} from '../electron/clash-route.js';

const windows=process.platform==='win32';
const pipeName=()=>String.raw`\\.\pipe\verge-mihomo-sidecar-release-${randomUUID()}`;
function fixture(t,controller={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fengsha-clash-pipe-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.writeFileSync(path.join(directory,'clash-verge.yaml'),JSON.stringify({secret:'fixture-private-token',...controller}));
  return new ClashRoute(directory);
}
async function pipeServer(t,handler){
  const socketPath=pipeName(),sockets=new Set(),server=http.createServer(handler);
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  t.after(async()=>{
    for(const socket of sockets)socket.destroy();
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  });
  return {socketPath,server,sockets};
}
const noPrivateDetails=error=>!error.message.includes('fixture-private-token')&&!error.message.includes('private-server')&&!error.message.includes('verge-mihomo-sidecar-release-');

test('Windows: empty TCP controller loads the current Verge pipe and GET uses local pipe HTTP',{skip:!windows},async t=>{
  const {socketPath}=await pipeServer(t,(req,res)=>{
    assert.equal(req.url,'/version');assert.equal(req.method,'GET');
    assert.equal(req.headers.authorization,'Bearer fixture-private-token');
    res.setHeader('Content-Type','application/json');res.end('{"version":"fixture-mihomo"}');
  });
  const route=fixture(t,{'external-controller':'','external-controller-pipe':socketPath});
  const context=route.load();
  assert.deepEqual(await route.api(context,'/version'),{version:'fixture-mihomo'});
});

test('TCP and constructor fetch injection keep existing options and do not silently fall back from remote TCP',async t=>{
  const route=fixture(t,{'external-controller':'0.0.0.0:9097','external-controller-pipe':pipeName()});
  const context=route.load();assert.equal(context.base,'http://127.0.0.1:9097');assert.equal(context.socketPath,undefined);
  const calls=[];route.fetch=async(url,options)=>{calls.push({url,options});return new Response('{"mode":"rule"}');};
  assert.deepEqual(await route.api(context,'/configs'),{mode:'rule'});
  assert.equal(calls[0].url,'http://127.0.0.1:9097/configs');assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.socketPath,undefined);assert.ok(calls[0].options.signal instanceof AbortSignal);
  const injected=new ClashRoute(route.directory,async()=>new Response(null,{status:204}));
  assert.equal(await injected.api(context,'/configs',{payload:'fixture'},'PUT'),null);
  assert.throws(()=>fixture(t,{'external-controller':'remote.example:9097','external-controller-pipe':pipeName()}).load(),noPrivateDetails);
});

test('only local Windows Verge release pipes are accepted; remote, unrelated and malformed pipes are rejected',async t=>{
  for(const socketPath of [String.raw`\\remote-host\pipe\verge-mihomo-sidecar-release-test`,String.raw`\\.\pipe\other-app`,String.raw`\\?\pipe\verge-mihomo-sidecar-release-test`,String.raw`\\.\pipe\verge-mihomo-sidecar-release-`,String.raw`\\.\pipe\verge-mihomo-sidecar-release-test\other`,String.raw`\\.\pipe\verge-mihomo-sidecar-release-..`,pipeName()+'\n',pipeName()+'?x=1',42]){
    const route=fixture(t,{'external-controller':'','external-controller-pipe':socketPath});
    assert.throws(()=>route.load(),noPrivateDetails);
    let called=false;route.fetch=async()=>{called=true;return new Response('{}');};
    await assert.rejects(route.api({base:'http://localhost',socketPath,secret:'fixture-private-token'},'/version'),noPrivateDetails);
    assert.equal(called,false);
  }
  if(!windows)assert.throws(()=>fixture(t,{'external-controller':'','external-controller-pipe':pipeName()}).load(),noPrivateDetails);
});

test('Windows: pipe requests retain the constructor fetch seam',{skip:!windows},async t=>{
  const socketPath=pipeName(),route=fixture(t,{'external-controller':'','external-controller-pipe':socketPath});
  const calls=[];
  const injected=new ClashRoute(route.directory,async(url,options)=>{calls.push({url,options});return new Response(null,{status:204});});
  assert.equal(await injected.api(injected.load(),'/configs?force=true',{payload:'中文'},'PUT'),null);
  assert.equal(calls[0].options.socketPath,socketPath);assert.equal(calls[0].options.method,'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body),{payload:'中文'});
});

test('Windows: discover/begin/reload and out-of-process restore helper use the same pipe API and preserve selections',{skip:!windows},async t=>{
  const selectionName='原节点 / 中文',selected='节点甲',calls=[];
  let current={mode:'rule','mixed-port':7897,dns:{enable:true},proxies:[{name:selected,type:'http',server:'fixture.example',port:80}],
    'proxy-groups':[{name:selectionName,type:'select',proxies:[selected,'DIRECT']}],rules:[`DOMAIN,example.com,${selectionName}`,'MATCH,DIRECT']};
  let selection=selected;
  const rules=()=>current.rules.map(line=>{const fields=line.split(',');return fields[0]==='MATCH'?{type:'Match',payload:'',proxy:fields[1]}:{type:'Domain',payload:fields[1],proxy:fields[2]};});
  const {socketPath}=await pipeServer(t,async(req,res)=>{
    try{
      calls.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization,'Bearer fixture-private-token');
      if(req.method==='PUT'){
        let body='';for await(const chunk of req)body+=chunk;
        assert.equal(Number(req.headers['content-length']),Buffer.byteLength(body));assert.equal(req.headers['content-type'],'application/json');
        const data=JSON.parse(body);
        if(req.url==='/configs?force=true'){current=parseClashConfig(data.payload);selection='DIRECT';}
        else{assert.equal(req.url,`/proxies/${encodeURIComponent(selectionName)}`);selection=data.name;}
        res.writeHead(204);res.end();return;
      }
      const result=req.url==='/configs'?{mode:'rule','mixed-port':7897}:req.url==='/rules'?{rules:rules()}:req.url==='/proxies'?{proxies:{[selectionName]:{type:'Selector',now:selection},ignored:{type:'URLTest',now:'DIRECT'}}}:{};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
    }catch(error){res.writeHead(500);res.end('fixture-server-failure');t.assert.fail(error.message);}
  });
  const original=structuredClone(current),route=fixture(t,{'external-controller':'','external-controller-pipe':socketPath,...current});
  const plan=await route.discover({ProxyEnable:{value:1},ProxyServer:{value:'127.0.0.1:7897'}});assert.ok(plan);
  await route.begin(plan);
  assert.equal(current.rules[0],routeRule);assert.equal(selection,selected);assert.deepEqual(current.dns,original.dns);
  assert.deepEqual(await route.selectors(route.load()),{[selectionName]:selected});
  // Run the actual helper only against this isolated fixture pipe, never Clash.
  const lease=path.join(route.directory,'fixture-lease.json');
  fs.writeFileSync(lease,JSON.stringify({schema:1,mode:'routed',routing:plan}));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/clash-route-helper.mjs',lease],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
  assert.equal(result.code,0);assert.deepEqual(JSON.parse(result.stdout),{restored:true});assert.equal(result.stderr,'');
  assert.deepEqual(current.rules,original.rules);assert.equal(selection,selected);assert.deepEqual(current.dns,original.dns);
  assert.equal(current['mixed-port'],7897);assert.ok(!current['proxy-groups'].some(group=>group.name===routeName));
  assert.equal(calls.filter(call=>call==='PUT /configs?force=true').length,2);
  assert.equal(calls.filter(call=>call===`PUT /proxies/${encodeURIComponent(selectionName)}`).length,2);
});

test('Windows: HTTP errors, redirects, malformed JSON, 204 and large JSON keep API semantics and redact server details',{skip:!windows},async t=>{
  let redirected=false;
  const {socketPath,sockets}=await pipeServer(t,(req,res)=>{
    if(req.url==='/error'){res.writeHead(403);res.end('fixture-private-token private-server');}
    else if(req.url==='/redirect'){res.writeHead(302,{Location:'/target'});res.end();}
    else if(req.url==='/target'){redirected=true;res.end('{}');}
    else if(req.url==='/empty'){res.writeHead(204);res.end();}
    else if(req.url==='/reset'){res.writeHead(205);res.end();}
    else if(req.url==='/truncated'){res.writeHead(200,{'Content-Length':'100'});res.end('{');}
    else if(req.url==='/large')res.end(JSON.stringify({payload:'中'.repeat(300000)}));
    else res.end('fixture-private-token private-server');
  });
  const route=fixture(t,{'external-controller':'','external-controller-pipe':socketPath}),context=route.load();
  for(const [url,expected] of [['/error','HTTP 403'],['/redirect','未响应'],['/json','无效数据'],['/reset','无效数据'],['/truncated','无效数据']])
    await assert.rejects(route.api(context,url),error=>error.message.includes(expected)&&noPrivateDetails(error));
  assert.equal(redirected,false);assert.equal(await route.api(context,'/empty'),null);
  assert.equal((await route.api(context,'/large')).payload.length,300000);
  // Requests use no pooled agent; completed responses leave no live pipe socket.
  for(let i=0;i<50&&sockets.size;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(sockets.size,0);
});

test('Windows: 20s total timeout also covers stalled response bodies and releases pipe sockets',{skip:!windows},async t=>{
  const originalTimeout=AbortSignal.timeout.bind(AbortSignal),timeouts=[];
  t.mock.method(AbortSignal,'timeout',milliseconds=>{timeouts.push(milliseconds);return originalTimeout(60);});
  const {socketPath,sockets}=await pipeServer(t,(req,res)=>{
    if(req.url==='/body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}
  });
  const route=fixture(t,{'external-controller':'','external-controller-pipe':socketPath}),context=route.load();
  await assert.rejects(route.api(context,'/headers'),error=>error.message.includes('未响应')&&noPrivateDetails(error));
  await assert.rejects(route.api(context,'/body'),error=>error.message.includes('无效数据')&&noPrivateDetails(error));
  assert.deepEqual(timeouts,[20000,20000]);
  for(let i=0;i<50&&sockets.size;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(sockets.size,0);
  await assert.rejects(route.api({...context,socketPath:pipeName()},'/version'),error=>error.message.includes('未响应')&&noPrivateDetails(error));
});
