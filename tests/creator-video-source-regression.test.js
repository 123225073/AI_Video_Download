import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from '../electron/engine.js';
import {WeChatCreators} from '../electron/wechat-creators.js';
import {VideoWorkflow} from '../electron/video-workflow.js';
import {Transcriptions} from '../electron/transcription.js';

const author='fixture-confirmed-author@finder';
const title='说什么大环境不好，钱难挣，那都是借口。';
const wrap=data=>new Response(JSON.stringify({code:0,data:{errCode:0,data}}));
function containsExactLocator(value,item){
  if(!value||typeof value!=='object')return false;
  if(value.sourceId===item.sourceId&&value.objectNonceId===item.objectNonceId&&value.creatorId===item.creatorId&&value.acquisition==='wechat-collector')return true;
  return Object.values(value).some(child=>child&&typeof child==='object'&&containsExactLocator(child,item));
}
async function fixture(t){
  const rows=new Map(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'creator-video-source-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store={get:(type,id)=>structuredClone(rows.get(type+':'+id)),put:(type,id,value)=>rows.set(type+':'+id,structuredClone(value)),list:type=>[...rows].filter(([key])=>key.startsWith(type+':')).map(([,value])=>structuredClone(value)),flush(){}};
  const objects=Array.from({length:26},(_,index)=>({
    id:String(5397107284542310304n+BigInt(index)),objectNonceId:String(14887697630331082851n+BigInt(index))+'_0_146_0_0',
    contact:{username:author,nickname:'测试博主'},createtime:1790712000,
    objectDesc:{mediaType:4,description:index===1?title:'另一条作品 '+index,media:[{
      url:'https://finder.video.qq.com/fixture-'+index+'.mp4',decodeKey:'12345678901234567890',
      thumbUrl:'https://images.example/cover-'+index+'.jpg',videoPlayLen:61+index
    }]}
  }));
  const engine=new Engine('',null,{}),requests=[];
  const collector=new WeChatCreators(store,engine,async url=>{
    const u=new URL(url);requests.push(u.pathname);
    assert.equal(u.pathname,'/api/channels/contact/feed/list','fixture must not request private detail or remote media');
    return wrap({contact:{username:author,nickname:'测试博主'},object:objects,feedsCount:26,continueFlag:0,lastBuffer:''});
  });
  engine.wechat.collector=collector;
  const creator={platform:'视频号',id:author,name:'测试博主',supported:true,identityStatus:'confirmed',adapter:'wechat-collector',source:'https://weixin.qq.com/sph/fixture-first-original-link'};
  const page=await collector.page(creator,50),selected=page.items[1];
  const record={id:'fixture-creator-record',source:creator.source,creator,items:page.items,scanned:26,status:'complete',complete:true};
  store.put('creator',record.id,record);
  const ai={config:()=>({mode:'local',localModel:'base',language:'auto',hasKey:false,model:''}),chat:()=>assert.fail('No paid text request permitted'),transcribe:()=>assert.fail('No paid speech request permitted')};
  const transcriptions=new Transcriptions(store,engine,ai,directory,()=>{});
  // Exercise real start/source persistence, while preventing asynchronous media,
  // browser, speech-runtime and paid-provider work in this regression fixture.
  transcriptions.closing=true;
  const studio={get:id=>store.get('content-draft',id),checkpoint:d=>store.put('content-draft',d.id,d),progress:()=>null};
  const flow=new VideoWorkflow({store,studio,transcriptions,engine,ai,bin:'',pollMs:0});
  t.after(()=>flow.close());
  assert.equal(page.items.length,26);
  assert.equal(selected.title,title);
  assert.equal(selected.acquisition,'wechat-collector');
  assert.equal(selected.creatorId,author);
  assert.equal(selected.sourceId,objects[1].id);
  assert.equal(selected.objectNonceId,objects[1].objectNonceId);
  assert.notEqual(new URL(selected.url).searchParams.get('oid'),selected.sourceId,'official jump URL encodes the uint64 ID; it is not the raw collector ID');
  return {store,flow,collector,transcriptions,selected,record,objects,requests};
}

test('newly read creator second video has recoverable exact identity even when collector media cache misses',async t=>{
  const f=await fixture(t);
  assert.equal(f.collector.cached(f.selected),null,'list reading currently does not imply a saved download cache');
  let source;
  assert.doesNotThrow(()=>{source=f.flow.source({creatorId:f.record.id,itemId:f.selected.key});},'must not label a newly read identified creator video as an irrecoverable old cover-only record');
  assert.equal(source.item.sourceId,f.objects[1].id);
  assert.equal(source.item.objectNonceId,f.objects[1].objectNonceId);
  assert.equal(source.item.creatorId,author);
  assert.equal(source.url,f.selected.url);
  assert.notEqual(source.url,f.record.source,'the creator seed link is another work and must never replace the selected second video');
});

test('creator VideoWorkflow.start queues the selected work and preserves recoverable collector identity through real Transcriptions.start',async t=>{
  const f=await fixture(t);
  let result;
  assert.doesNotThrow(()=>{result=f.flow.start({creatorId:f.record.id,itemId:f.selected.key,title:f.selected.title,autoCorrect:false});},'the exact CreatorPage request must reach the transcription queue instead of VIDEO_SHARE_REQUIRED');
  const queued=f.store.get('transcription',result.transcriptionId);
  assert.equal(queued.status,'queued');
  assert.equal(queued.source.url,f.selected.url);
  assert.ok(containsExactLocator(queued.source,f.selected),'transcription source must retain sourceId, nonce, confirmed author and acquisition; URL/title alone cannot recover this media after cache loss');
  assert.equal(f.store.get('content-draft',result.draftId).source.sourceId,f.selected.sourceId);
  assert.equal(f.requests.length,1,'starting the workflow must not introduce unrequested network or paid work in the fixture');
});

test('raw-ID media cache hit is not mistaken for a miss just because the official feed URL contains an encoded oid',async t=>{
  const f=await fixture(t);
  assert.equal(f.collector.remember(f.objects[1]),true);
  assert.equal(f.collector.cached(f.selected).info.id,f.selected.sourceId);
  let source;
  assert.doesNotThrow(()=>{source=f.flow.source({creatorId:f.record.id,itemId:f.selected.key});},'cache lookup must use selected raw sourceId, not the base64url jump oid');
  assert.equal(source.item.sourceId,f.selected.sourceId);
  assert.equal(source.url,f.selected.url);
});
