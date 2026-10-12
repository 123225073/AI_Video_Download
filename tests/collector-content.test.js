import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const moduleURL='https://res.wx.qq.com/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.publishFixture.js?v=260907';
function fixture({api={},resources=[],load=async()=>({}),late}={}) {
  const sent=[],imports=[],calls=[];let listener;
  const sandbox={window:{},URL,performance:{getEntriesByType:()=>resources.map(name=>({name}))},document:{querySelectorAll:()=>[]},
    WXU:{API:api,onAPILoaded(fn){listener=fn;}},ws_client$:{methods:{__wx_handle_api_call:async()=>calls.push('other')}},
    setTimeout:fn=>setTimeout(()=>{late?.(sandbox);fn();},1),setInterval,clearInterval,clearTimeout,
    loadModule:async url=>{imports.push(url);return load(url);}};
  // Replace only the native import boundary; the module selection and all request logic run unchanged.
  vm.runInNewContext(fs.readFileSync('electron/collector-content.js','utf8').replace('import(url)','loadModule(url)'),sandbox);
  return {sandbox,sent,imports,calls,emit:value=>listener?.(value),request:async(data={},key='key:channels:contact_list')=>{
    await sandbox.ws_client$.methods.__wx_handle_api_call({id:'test',key,data:{keyword:'__fengsha_content__:'+JSON.stringify({query:'樊振东',requestId:'stable-search'}),...data}},{readyState:1,send:v=>sent.push(JSON.parse(v))});
    return sent.at(-1)?.data;
  }};
}
test('cached official module recovers a missed API event and retains the service instance',async()=>{
  const payloads=[];const service={finderSearch:async function(p){assert.equal(this,service);payloads.push(p);return {errCode:0,data:{objectList:[],objectContinueFlag:0}};}};
  const f=fixture({resources:[moduleURL],load:async()=>({Z:service})});
  const r=await f.request();assert.equal(r.errCode,0);assert.equal(r.data.fengshaVersion,1);assert.equal(payloads[0].scene,19);assert.deepEqual(f.imports,[moduleURL]);
  await f.request();assert.equal(f.imports.length,1);
});
test('late API replacement is reread even when no loaded event is emitted',async()=>{
  const f=fixture({late:s=>{s.WXU.API2={finderSearch:async()=>({errCode:0,data:{objectList:[],objectContinueFlag:0}})};}});
  assert.equal((await f.request()).errCode,0);
});
test('module fallback rejects outside hosts, credentials and non-module paths',async()=>{
  const f=fixture({resources:[moduleURL.replace('res.wx.qq.com','evil.invalid'),moduleURL.replace('https:','http:'),moduleURL.replace('res.wx.qq.com','res.wx.qq.com.evil.invalid'),moduleURL.replace('https://','https://secret@'),moduleURL.replace('virtual_svg-icons-register','unrelated')]});
  assert.equal((await f.request()).errCode,1009);assert.equal(f.imports.length,0);
});
test('invalid query never loads a module or calls an official API',async()=>{
  const f=fixture({resources:[moduleURL]});assert.equal((await f.request({keyword:'__fengsha_content__:{broken'})).errCode,1011);assert.equal(f.imports.length,0);
});

test('adapter probe never calls the official search service or imports modules',async()=>{
  let calls=0;const f=fixture({api:{finderSearch(){calls++;}},resources:[moduleURL]});
  const r=await f.request({keyword:'__fengsha_content__:'+JSON.stringify({probe:true})});
  assert.equal(r.data.fengshaAdapterVersion,3);assert.equal(calls,0);assert.equal(f.imports.length,0);
});
test('content pagination preserves offset, lastBuff and one requestId',async()=>{
  const payloads=[];const f=fixture({api:{finderSearch:async p=>{payloads.push(p);return {errCode:0,data:{objectList:[],objectContinueFlag:1,lastBuff:'buffer',offset:20}};}}});
  const r=await f.request();assert.ok(r.data.fengshaNextMarker);
  await f.request({next_marker:encodeURIComponent(r.data.fengshaNextMarker)});
  assert.equal(payloads[1].offset,20);assert.equal(payloads[1].lastBuff,'buffer');assert.equal(payloads[1].requestId,payloads[0].requestId);
});
test('missing API gives a capability error without sending page tokens or instructing endless reopens',async()=>{
  const f=fixture();const r=await f.request();assert.equal(r.errCode,1009);assert.doesNotMatch(r.errMsg,/重新进入|未登录/);assert.equal(r.fengshaDiagnostics.search,false);
});

test('selected feed detail recovers a cached service even when WXU.API has no detail method',async()=>{
  let payload;const service={finderGetCommentDetail:async function(p){assert.equal(this,service);payload=p;return {errCode:0,data:{object:{id:p.objectid}}};}};
  const f=fixture({resources:[moduleURL],load:async()=>({Z:service})});
  const r=await f.request({oid:'18446744073709551615',nid:'selected-nonce'},'key:channels:feed_profile');
  assert.equal(r?.data?.object.id,'18446744073709551615');assert.equal(payload.objectNonceId,'selected-nonce');assert.equal(payload.needObject,1);assert.equal(f.calls.length,0);
});
