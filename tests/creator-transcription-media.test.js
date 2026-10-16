import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../electron/engine.js';
import {WeChatCreators} from '../electron/wechat-creators.js';
import {Transcriptions} from '../electron/transcription.js';

const author='fixture-author@finder',secondId='5397107284542310305',nonce='14887697630331082852_0_146_0_0';
const stopBeforeSpeech=Object.assign(Error('Fixture stops after media acquisition and before ffmpeg/speech'),{code:'FIXTURE_MEDIA_ONLY'});
const wrapped=data=>new Response(JSON.stringify({code:0,data:{errCode:0,data}}));
async function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'creator-transcription-media-')),rows=new Map();
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store={get:(k,id)=>structuredClone(rows.get(k+':'+id)),put:(k,id,r)=>rows.set(k+':'+id,structuredClone(r)),list:k=>[...rows].filter(([key])=>key.startsWith(k+':')).map(([,r])=>structuredClone(r)),flush(){}};
  const objects=Array.from({length:26},(_,index)=>({id:String(5397107284542310304n+BigInt(index)),objectNonceId:index===1?nonce:'1_0',contact:{username:author,nickname:'测试作者'},createtime:1790712000,objectDesc:{mediaType:4,description:index===1?'说什么大环境不好，钱难挣，那都是借口。':'另一作品 '+index,media:[{url:'https://finder.video.qq.com/fixture-'+index+'.mp4',decodeKey:'12345678901234567890',thumbUrl:'https://images.example/'+index+'.jpg',videoPlayLen:62}]}}));
  const trace={parse:[],download:[],resolve:[],detail:[],connections:0,mediaDownloads:0,sourceUpdates:[]};
  const engine=new Engine('',null,{}),collector=new WeChatCreators(store,engine,async (value,{signal}={})=>{
    signal?.throwIfAborted();const u=new URL(value);
    if(u.pathname==='/api/channels/contact/feed/list')return wrapped({contact:{username:author},object:objects,continueFlag:0,lastBuffer:'',feedsCount:26});
    assert.equal(u.pathname,'/api/channels/feed/profile','fixture cannot perform any other network operation');
    trace.detail.push({oid:u.searchParams.get('oid'),nid:u.searchParams.get('nid'),url:u.searchParams.get('url')});
    const object=structuredClone(objects[1]);if(options.wrongId)object.id=objects[0].id;if(options.wrongAuthor)object.contact.username='other-author@finder';
    return wrapped({object});
  });
  engine.wechat.collector=collector;
  const page=await collector.page({id:author,name:'测试作者',identityStatus:'confirmed'},50),item=page.items[1];
  assert.equal(item.sourceId,secondId);assert.equal(item.objectNonceId,nonce);assert.equal(page.items.length,26);
  // A restart or expired media address can empty the download cache while the
  // persisted selected work and its exact stable locator are still available.
  collector.mediaCache.clear();
  assert.equal(collector.cached(item),null);
  const originalResolve=collector.resolve.bind(collector);
  collector.resolve=async (selected,signal)=>{trace.resolve.push(structuredClone(selected));return originalResolve(selected,signal);};
  engine.wechat.connection={withConnection:async(signal,run,capabilities)=>{
    assert.deepEqual(capabilities,['detail']);assert.ok(++trace.connections<=2,'connection recovery must be bounded');signal?.throwIfAborted();const result=await run();signal?.throwIfAborted();return result;
  }};
  engine.wechat.download=async(task,dir,signal)=>{
    trace.mediaDownloads++;signal?.throwIfAborted();
    const result=await collector.resolve(task.item,signal);
    assert.equal(result.info.id,secondId);assert.equal(result.info.uploader_id,author);
    // Only path-existence validation is under test. This inert MP4 placeholder
    // is never passed to ffmpeg, speech or a real media/paid provider.
    const file=path.join(dir,'fixture-selected-video.mp4');fs.writeFileSync(file,Buffer.from('fixture media acquisition only'));return {filePath:file};
  };
  const realParse=engine.parse.bind(engine),realDownload=engine.download.bind(engine);
  engine.parse=async(url,parseOptions)=>{
    trace.parse.push({url,allowCollector:parseOptions.allowCollector,sourceItem:parseOptions.sourceItem&&structuredClone(parseOptions.sourceItem)});
    const result=await realParse(url,parseOptions);if(options.abortAfterParse)options.controller.abort();return result;
  };
  engine.download=async(task,...args)=>{trace.download.push(structuredClone(task));return realDownload(task,...args);};
  const ai={config:()=>({mode:'local',localModel:'base',language:'auto',hasKey:false,model:''}),chat:()=>assert.fail('No text provider allowed'),transcribe:()=>assert.fail('No speech provider allowed')};
  const service=new Transcriptions(store,engine,ai,directory,()=>{});service.closing=true;
  const record={id:'fixture-transcription',status:'queued',source:{kind:'url',url:item.url,title:item.title,item:structuredClone(item)},title:item.title,speech:{mode:'local',localModel:'base',language:'auto'},transcript:'已保留原文',correctedTranscript:'已保留校对稿',segments:[{start:0,end:1,text:'已保留原文'}]};
  store.put('transcription',record.id,record);
  return {store,service,engine,collector,item,record,trace,directory};
}
function assertSelected(trace,item){
  assert.ok(trace.parse.length);assert.equal(trace.parse[0].url,item.url);assert.equal(trace.parse[0].allowCollector,true);
  assert.equal(trace.parse[0].sourceItem?.sourceId,secondId);assert.equal(trace.parse[0].sourceItem?.objectNonceId,nonce);assert.equal(trace.parse[0].sourceItem?.creatorId,author);
  assert.ok(trace.resolve.length);for(const selected of trace.resolve){assert.equal(selected.sourceId,secondId);assert.equal(selected.objectNonceId,nonce);assert.equal(selected.creatorId,author);assert.equal(selected.acquisition,'wechat-collector');}
  assert.equal(trace.detail.length,1);assert.deepEqual(trace.detail[0],{oid:secondId,nid:nonce,url:null});
  assert.ok(trace.download.length);assert.equal(trace.download[0].item.sourceId,secondId);assert.equal(trace.download[0].item.creatorId,author);
}

test('ensureVideo forwards saved selected creator locator through real Engine.parse/resolve/download and preserves text',async t=>{
  const f=await fixture(t),file=await f.service.ensureVideo(f.record.id,new AbortController().signal);
  assert.ok(fs.existsSync(file));assertSelected(f.trace,f.item);
  const saved=f.store.get('transcription',f.record.id);assert.equal(saved.transcript,'已保留原文');assert.equal(saved.correctedTranscript,'已保留校对稿');assert.equal(saved.sourceFile,file);
});
test('sourceText recovers the exact creator second work before speech instead of treating its description as a transcript',async t=>{
  const f=await fixture(t),controller=new AbortController();
  await assert.rejects(f.service.sourceText(f.record,controller.signal,patch=>{controller.signal.throwIfAborted();f.trace.sourceUpdates.push(patch);if(patch.status==='preparing'&&patch.sourceFile)throw stopBeforeSpeech;}),error=>error.code==='FIXTURE_MEDIA_ONLY');
  assertSelected(f.trace,f.item);assert.ok(f.trace.sourceUpdates.some(p=>p.sourceFile&&p.status==='preparing'));
});
test('ordinary internal feed without structured creator identity still forbids collector recovery',async t=>{
  const f=await fixture(t),record=f.store.get('transcription',f.record.id);delete record.source.item;f.store.put('transcription',record.id,record);
  await assert.rejects(f.service.ensureVideo(record.id,new AbortController().signal),error=>error.code==='VIDEO_SHARE_REQUIRED');
  assert.equal(f.trace.parse[0].allowCollector,false);assert.equal(f.trace.connections,0);assert.equal(f.trace.resolve.length,0);assert.equal(f.trace.download.length,0);
});
test('incomplete or untrusted source locators cannot enable collector access',async t=>{
  for(const patch of [{acquisition:undefined},{sourceId:'encoded_jump_oid'},{creatorId:''},{creatorId:'shared_author_fake'}]){
    const f=await fixture(t),record=f.store.get('transcription',f.record.id);Object.assign(record.source.item,patch);f.store.put('transcription',record.id,record);
    await assert.rejects(f.service.ensureVideo(record.id,new AbortController().signal),error=>error.code==='VIDEO_SHARE_REQUIRED'||/身份|作品|标识/.test(error.message));
    assert.equal(f.trace.parse[0]?.allowCollector??false,false);assert.equal(f.trace.connections,0);assert.equal(f.trace.download.length,0);
  }
});
test('already cancelled acquisition never parses, reconnects or downloads',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();
  await assert.rejects(f.service.ensureVideo(f.record.id,controller.signal),/停止|abort/i);
  assert.equal(f.trace.parse.length,0);assert.equal(f.trace.connections,0);assert.equal(f.trace.download.length,0);
});
test('cancellation after exact item parsing must stop before download and leave existing transcript untouched',async t=>{
  const controller=new AbortController(),f=await fixture(t,{abortAfterParse:true,controller});
  await assert.rejects(f.service.ensureVideo(f.record.id,controller.signal),/停止|abort/i);
  assert.equal(controller.signal.aborted,true);assert.equal(f.trace.download.length,0);assert.equal(f.store.get('transcription',f.record.id).transcript,'已保留原文');
});
for(const [name,options,pattern]of [['another work',{wrongId:true},/所选作品不一致|作品身份|视频.*不一致/],['another author',{wrongAuthor:true},/作者身份|作者.*不一致/]])test(`collector response from ${name} is rejected before media download`,async t=>{
  const f=await fixture(t,options);
  await assert.rejects(f.service.ensureVideo(f.record.id,new AbortController().signal),pattern);
  assert.equal(f.trace.resolve[0].sourceId,secondId);assert.equal(f.trace.resolve[0].creatorId,author);assert.equal(f.trace.download.length,0);assert.equal(f.trace.mediaDownloads,0);
});
