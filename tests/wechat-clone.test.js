import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../electron/engine.js';
import {WeChatCreators} from '../electron/wechat-creators.js';
import {ContentSearch} from '../electron/content-search.js';

const fixtureCodec={encode:value=>Buffer.from(value).toString('base64'),decode:value=>Buffer.from(value,'base64').toString()};
function cachedFixture(){const rows=new Map(),store={get:(k,id)=>rows.get(k+':'+id),put:(k,id,v)=>rows.set(k+':'+id,v),flush(){}};const collector=new WeChatCreators(store,null,()=>{throw Error('Must not reconnect to WeChat');},fixtureCodec);return {store,collector};}
const rawVideo=()=>({id:'18446744073709551615',objectNonceId:'selected-nonce',createtime:1790812800,contact:{username:'author@finder',nickname:'原作者'},objectDesc:{mediaType:4,description:'已经采集到的原说明',media:[{url:'https://finder.video.qq.com/selected',urlToken:'?token=fixture',decodeKey:'918273645546372819',videoPlayLen:12}]}});
test('视频处理没有缓存时立即说明缺少媒体，不再连接微信页面等待',async()=>{
 let opened=0;const engine=new Engine('',{active:()=>({id:'saved',lastSync:1})},{collector:{config:()=>({enabled:true}),cached:()=>null,resolve:()=>{throw Error('Re-fetch');}},connection:{withConnection:()=>{opened++;throw Error('WeChat popup');}}});
 await assert.rejects(engine.parse('https://channels.weixin.qq.com/web/pages/feed?oid=12345',{allowCollector:false}),e=>e.code==='VIDEO_SHARE_REQUIRED');assert.equal(opened,0);
});

test('搜索保存已取得的媒体信息，卡片不暴露媒体令牌，重启后不需要微信页面',async()=>{
 const f=cachedFixture();const search=new ContentSearch({store:f.store,accounts:{active:()=>null},creators:{progress:()=>null,connection:{withConnection:async(_s,fn)=>fn()}},userSearch:{},browser:{close(){}},wechat:f.collector});f.collector.request=async()=>({fengshaVersion:1,objectList:[rawVideo()],continueFlag:0});
 const view=await search.start('视频号','原视频',{from:'2026-09-01',to:'2026-10-12'});assert.equal(view.items.length,1);assert.equal(JSON.stringify(view).includes('918273645546372819'),false);
 const restarted=new WeChatCreators(f.store,null,()=>{throw Error('Reconnect');},fixtureCodec);assert.ok(restarted.cached({sourceId:rawVideo().id}));assert.equal(JSON.stringify(f.store.get('wechat-media',rawVideo().id)).includes('918273645546372819'),false);
 const engine=new Engine('',{active:()=>null},{collector:restarted,connection:{withConnection:()=>{throw Error('Must not open WeChat');}}});const group=await engine.parse(view.items[0].url);assert.equal(group.items[0].sourceId,rawVideo().id);
 engine.wechat.download=async()=>({filePath:'cached-download'});assert.equal((await engine.download({item:group.items[0]},'.',null,()=>{})).filePath,'cached-download');
});

test('缓存拒绝外域地址、精度丢失的解密参数和其他作品身份',()=>{
 const f=cachedFixture(),bad=rawVideo();bad.objectDesc.media[0].url='https://finder.video.qq.com.evil.invalid/file';assert.equal(f.collector.remember(bad),false);
 bad.objectDesc.media[0].url='https://finder.video.qq.com/file';bad.objectDesc.media[0].decodeKey=918273645546372819;assert.equal(f.collector.remember(bad),false);
 assert.equal(f.collector.remember(rawVideo()),true);assert.equal(f.collector.cached({sourceId:'other'}),null);assert.throws(()=>f.collector.cached({sourceId:rawVideo().id,creatorId:'wrong'}),/作者/);
});

test('视频号搜索作品转录必须按所选 oid/nid 走采集连接，即使账户有保存的登录',async()=>{
  const calls=[],url='https://channels.weixin.qq.com/web/pages/feed?oid=18446744073709551615&nid=selected-nonce';
  const wechat={resolve:async()=>{throw Error('WECHAT_INVALID_LINK');},collector:{config:()=>({enabled:true}),resolve:async item=>{calls.push(item);assert.equal(item.sourceId,'18446744073709551615');assert.equal(item.objectNonceId,'selected-nonce');return {info:{id:item.sourceId,title:'所选原视频'},objectNonceId:item.objectNonceId};}},connection:{withConnection:async(_signal,fn)=>{calls.push('connection');return fn();}}};
  const engine=new Engine('',{active:()=>({id:'account',lastSync:Date.now()})},wechat);
  const group=await engine.parse(url,{signal:new AbortController().signal});
  assert.equal(group.items[0].acquisition,'wechat-collector');assert.equal(group.items[0].sourceId,'18446744073709551615');assert.equal(calls[0],'connection');
});

test('视频号外部分享链接保持原有已登录分享解析路径',async()=>{
  let calls=0;const wechat={resolve:async()=>{calls++;return {info:{id:'share',title:'分享原视频'}};},collector:{config:()=>({enabled:true}),resolve:async()=>{throw Error('Wrong route');}}};
  const engine=new Engine('',{active:()=>({id:'account',lastSync:1})},wechat);await engine.parse('https://weixin.qq.com/sph/example');assert.equal(calls,1);
});

test('采集作品地址缺少 oid 时应明确拒绝，不伪装成登录问题',async()=>{
  const engine=new Engine('',{active:()=>({lastSync:1})},{resolve:async()=>{throw Error('WECHAT_INVALID_LINK');},collector:{config:()=>({enabled:true})}});
  await assert.rejects(engine.parse('https://channels.weixin.qq.com/web/pages/feed?oid='),/作品标识/);
});

test('已缓存媒体被上游拒绝后仅刷新一次，同步校验身份，不在重试时复用失效地址',async()=>{
 const f=cachedFixture(),item={sourceId:rawVideo().id,acquisition:'wechat-collector',platform:'视频号'};f.collector.remember(rawVideo());
 let reads=0,connections=0,transfers=0;const fresh=rawVideo();fresh.objectDesc.media[0].urlToken='?token=fresh';
 f.collector.fetch=async()=>{reads++;return new Response(JSON.stringify({data:{object:fresh}}));};
 const wechat={collector:f.collector,connection:{withConnection:async(s,run)=>{connections++;return run();}},download:async()=>{transfers++;const media=await f.collector.resolve(item);if(media.url.endsWith('fixture'))throw Error('WECHAT_MEDIA_UNAVAILABLE');return {filePath:'downloaded'};}};
 const engine=new Engine('',null,wechat),signal=new AbortController().signal;assert.equal((await engine.download({item,options:{}},'.',signal,()=>{})).filePath,'downloaded');assert.equal(reads,1);assert.equal(connections,1);assert.equal(transfers,2);assert.ok(f.collector.cached(item).url.endsWith('fresh'));
 wechat.download=async()=>{await f.collector.resolve(item);throw Error('WECHAT_MEDIA_UNAVAILABLE');};await assert.rejects(engine.download({item,options:{}},'.',signal,()=>{}),/WECHAT_MEDIA_UNAVAILABLE/);assert.equal(connections,2);
 const before=connections;await assert.rejects(engine.download({item,options:{allowCollector:false}},'.',signal,()=>{}),/WECHAT_MEDIA_UNAVAILABLE/);assert.equal(connections,before);
});

test('缓存下载的非地址错误和取消不会触发微信重连',async()=>{
 const f=cachedFixture(),item={sourceId:rawVideo().id,acquisition:'wechat-collector',platform:'视频号'};f.collector.remember(rawVideo());let connections=0;
 const controller=new AbortController(),wechat={collector:f.collector,connection:{withConnection:()=>{connections++;}},download:async()=>{throw Error('WECHAT_FILE_WRITE_FAILED');}},engine=new Engine('',null,wechat);
 await assert.rejects(engine.download({item,options:{}},'.',controller.signal,()=>{}),/WECHAT_FILE_WRITE_FAILED/);
 wechat.download=async()=>{controller.abort();throw Error('WECHAT_MEDIA_UNAVAILABLE');};await assert.rejects(engine.download({item,options:{}},'.',controller.signal,()=>{}),{name:'AbortError'});assert.equal(connections,0);assert.ok(f.collector.cached(item));
});
