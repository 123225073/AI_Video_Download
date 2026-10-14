import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {CollectorConnection} from '../electron/collector-connection.js';

test('page adapter is delivered inline even when every external asset request fails',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fengsha-inline-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const bin=path.join(directory,'bin'),config=path.join(directory,'component.yaml');
  fs.mkdirSync(path.join(bin,'collector'),{recursive:true});
  fs.writeFileSync(path.join(bin,'collector','collector-content.js'),'window.adapterRan=true;');
  fs.writeFileSync(config,'inject:\n  globalScript: fengsha-content-old.js\n');
  const connection=new CollectorConnection({get:()=>null},bin,directory,()=>{});
  let values={'inject.globalScript':path.join(directory,'fengsha-content-old.js'),'inject.contentScript':''};
  let stopped=false;
  connection.api=async(route,body)=>{
    if(route==='/api/channels/status')return {available:true};
    if(route==='/api/config'&&!body)return {config_file:config,fields:Object.entries(values).map(([key,effective_value])=>({key,effective_value}))};
    if(route==='/api/proxy/config'){assert.equal(body.values['proxy.enabled'],false);assert.equal(body.restart,false);return {};}
    if(route==='/api/service/stop'){assert.deepEqual(body,{name:'interceptor'});return {};}
    if(route==='/api/proxy/status'){stopped=true;return {service:{status:'stopped',listening:false}};}
    if(route==='/api/config'){assert.equal(stopped,true,'old proxy must stop before application restart');values={...values,...body.values};return {restart_token:'one'};}
    if(route.startsWith('/api/restart/status'))return {restart_completed:true,config_applied:true};
    throw Error('stop-before-certificate');
  };
  await assert.rejects(connection.prepareComponent(),/stop-before-certificate/);
  // v260907 AppendScripts requires an external request, while contentScript is
  // read from disk and placed directly in the intercepted HTML response.
  const page={window:{}};
  if(values['inject.contentScript'])vm.runInNewContext(fs.readFileSync(values['inject.contentScript'],'utf8'),page);
  assert.equal(page.window.adapterRan,true,'the bridge must survive blocked /__assets/user requests');
  assert.equal(fs.existsSync(values['inject.globalScript']),false,'v260907 skips external injection for an absent script');
  assert.equal(page.window.__fengshaContentHash,connection.adapterFingerprint);
});

test('stopping the proxy uses the service endpoint and waits for actual listener release',async()=>{
  const connection=Object.create(CollectorConnection.prototype),calls=[];let polls=0;
  connection.api=async(route,body)=>{
    calls.push(route);
    if(route==='/api/proxy/config'){assert.equal(body.restart,false);assert.equal(body.values['proxy.enabled'],false);return {};}
    if(route==='/api/service/stop'){assert.deepEqual(body,{name:'interceptor'});return {};}
    assert.equal(route,'/api/proxy/status');polls++;
    return {service:polls===1?{status:'stopped',listening:true}:{status:'stopped',listening:false}};
  };
  await connection.stopProxy();
  assert.deepEqual(calls,['/api/proxy/config','/api/service/stop','/api/proxy/status','/api/proxy/status']);
});

test('network restoration precedes proxy shutdown, with failure retained for retry',async()=>{
  const events=[],connection=Object.create(CollectorConnection.prototype);
  Object.assign(connection,{leaseFile:'owned-lease',leaseMode:'routed',system:async(action)=>events.push(action),stopProxy:async()=>{events.push('stop');throw Error('listener still active');},update(phase){this.state={phase};}});
  await assert.rejects(connection.finish(),/listener still active/);
  assert.deepEqual(events,['restore','stop']);assert.equal(connection.state.phase,'error');assert.equal(connection.leaseFile,'owned-lease');
  connection.members=new Set();connection.recover=async()=>events.push('recover');connection.status=()=>connection.state;
  await assert.rejects(connection.restore(),/listener still active/);assert.equal(connection.leaseFile,'owned-lease');
  connection.stopProxy=async()=>events.push('stopped');await connection.restore();assert.equal(connection.leaseFile,null);assert.equal(connection.state.phase,'idle');
});
