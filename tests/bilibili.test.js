import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../electron/engine.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { thumbnailUrl } from '../electron/thumbnail.js';
import { Bilibili, biliEntry, biliDuration } from '../electron/bilibili.js';
import { classifyError } from '../electron/core.js';
import { Creators } from '../electron/creators.js';
import { Store } from '../electron/store.js';

const creator = { platform: 'B站', id: '60542591', name: '原作者', url: 'https://space.bilibili.com/60542591/video', listUrl: 'https://space.bilibili.com/60542591/video', supported: true, adapter: 'yt-dlp', accountId: 'bili-session' };
const images = { img_url: 'https://i0.hdslb.com/' + 'a'.repeat(32) + '.png', sub_url: 'https://i0.hdslb.com/' + 'b'.repeat(32) + '.png' };
const raw = n => ({ bvid: 'BV' + String(n).padStart(10, '0'), mid: 60542591, author: '原作者', title: `作品${n}`, pic: 'http://i2.hdslb.com/bfs/archive/cover.jpg', length: '10:59', created: 1791028800 });
const ok = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
async function fixture() {
  const store = await Store.open(path.resolve('output/unit', randomUUID()), {}), engine = new Engine('', { active: () => ({ id: 'bili-session', platform: 'B站', status: '会话已保存', lastSync: 1 }), bilibiliLoginReady: async () => true }, null);
  const service = new Creators(store, engine, null, () => {});
  const record = { id: 'record', creator, items: [], scanned: 0, cursor: 1, seen: [], skipped: {}, status: 'identified', complete: false };
  store.put('creator', record.id, record); return { store, engine, service, record };
}

test('B站实际提取器返回的 HTTP 封面应升级为 HTTPS，不能丢失', () => {
  const engine = new Engine('', null, null);
  const item = engine.item({ id: 'BV1MVbW6XEbZ', title: '视频标题', thumbnail: 'http://i2.hdslb.com/bfs/archive/cover.jpg', duration: 659 }, 'https://www.bilibili.com/video/BV1MVbW6XEbZ', 'B站');
  assert.equal(item.thumbnail, 'https://i2.hdslb.com/bfs/archive/cover.jpg');
});

test('旧封面地址、协议相对地址和候选列表正常化，拒绝非安全地址', () => {
  assert.equal(thumbnailUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  for (const url of ['http://evil.example/a.jpg', 'file:///C:/a.png', 'javascript:x', 'https://user:secret@i0.hdslb.com/a.jpg']) assert.equal(thumbnailUrl(url), '');
  assert.equal(new Engine('', null, null).item({ thumbnail: 'data:x', thumbnails: [{ url: '//i0.hdslb.com/a.jpg' }] }, 'https://www.bilibili.com/video/BV1MVbW6XEbZ', 'B站').thumbnail, 'https://i0.hdslb.com/a.jpg');
});
test('352、412、签名拒绝是平台限制，不误报账号过期，不泄露原始错误', () => {
  for (const error of ['ERROR: [BilibiliSpaceVideo] 60542591: Request is rejected by server (352)', 'ERROR: [BilibiliSpaceVideo] 60542591: Request is blocked by server (412)', 'BILIBILI_RISK 401']) {
    const result = classifyError(error); assert.equal(result.category, 'rate-limit'); assert.match(result.message, /已保留/); assert.match(result.message, /一分钟/);
  }
});
test('B站原始分页保留标题封面日期时长，非整页继续不重新请求之前的页面', async () => {
  const calls = [];
  const reader = new Bilibili(async url => {
    const u = new URL(url); if (u.pathname.endsWith('/nav')) return { ok: true, status: 200, json: async () => ({ code: -101, data: { wbi_img: images } }) };
    assert.ok(u.searchParams.get('w_rid')); assert.equal(u.searchParams.get('mid'), creator.id);
    const pn = Number(u.searchParams.get('pn')); calls.push(pn);
    const entries = Array.from({ length: pn === 3 ? 1 : 30 }, (_, i) => raw((pn - 1) * 30 + i + 1));
    return ok({ page: { pn, ps: 30, count: 61 }, list: { vlist: entries } });
  }, { interval: 0 });
  const first = await reader.page(creator, 1, 30); assert.equal(first.entries[0].title, '作品1'); assert.equal(first.entries[0].duration, 659); assert.ok(first.entries[0].timestamp); assert.match(first.entries[0].thumbnail, /^https:/);
  await reader.page(creator, 31, 20); const tail = await reader.page(creator, 51, 30); assert.equal(tail.advance, 10); assert.equal(tail.complete, false);
  const last = await reader.page(creator, 61, 30); assert.equal(last.complete, true); assert.deepEqual(calls, [1,2,3]);
});

test('来源头仅发送可信源站，不带作者路径或查询参数', async () => {
  let headers;
  const reader = new Bilibili(async (_url, options) => { headers = options.headers; return ok({}); }, { interval: 0 });
  await reader.json('/x/web-interface/view?bvid=BV1MVbW6XEbZ', null, null, creator.url + '?secret=tracking');
  assert.equal(headers.Referer, 'https://space.bilibili.com/');
});

test('HTML、缺失响应体、客户端拦截与799限流都给出可操作分类', async () => {
  for (const [response, category] of [
    [{ ok:true, status:200, json:async()=>{throw new SyntaxError('Unexpected token < SECRET');} }, 'extractor'],
    [{ ok:true, status:200, json:async()=>({code:0}) }, 'extractor'],
    [{ ok:true, status:200, json:async()=>({code:-799}) }, 'rate-limit']
  ]) {
    const reader=new Bilibili(async()=>response,{interval:0});
    await assert.rejects(reader.json('/x/space/arc/search'), error=>classifyError(error.message).category===category && !error.message.includes('SECRET'));
  }
  const reader=new Bilibili(async()=>{throw Error('net::ERR_BLOCKED_BY_CLIENT');},{interval:0});
  await assert.rejects(reader.json('/x/space/arc/search'),error=>classifyError(error.message).category==='network');
});

test('取消排队请求立即返回，同时不让后续请求越过正在执行的请求', async () => {
  let finish, entered; const started=new Promise(r=>entered=r); const calls=[];
  const reader=new Bilibili(async url=>{calls.push(url); if(calls.length===1){entered(); await new Promise(r=>finish=r);}return ok({});},{interval:0});
  const first=reader.json('/first');await started;
  const c=new AbortController(); const second=reader.json('/second',null,c.signal); const third=reader.json('/third'); c.abort();
  await Promise.race([assert.rejects(second),new Promise((_,reject)=>setTimeout(()=>reject(Error('排队取消超过200毫秒')),200))]);
  assert.equal(calls.length,1);finish();await first;await third;assert.equal(calls.length,2);assert.ok(calls[1].endsWith('/third'));
});

test('非法时长与隐藏合集不污染作品字段', () => {
  for(const value of [Infinity,NaN,-1,'1:99','1:60:01'])assert.equal(biliDuration(value),null);
  assert.equal(biliDuration('1:02:03'),3723);
  assert.equal(biliEntry({meta:{attribute:156}},creator),null);
});

test('重复视频页及缩水的未完成页不会被缓存或误报读完', async () => {
  const reader=new Bilibili(async url=>{if(url.includes('/nav'))return ok({wbi_img:images});const pn=Number(new URL(url).searchParams.get('pn'));return ok({page:{pn,ps:30,count:60},list:{vlist:Array.from({length:30},(_,i)=>raw(i+1))}});},{interval:0});
  await reader.page(creator,1,30);await assert.rejects(reader.page(creator,31,30),/重复/);
  const short=new Bilibili(async url=>url.includes('/nav')?ok({wbi_img:images}):ok({page:{pn:1,ps:30,count:60},list:{vlist:[raw(1)]}}),{interval:0});
  await assert.rejects(short.page(creator,1,30),/分页/);
});

test('av链接、分P和作者字段必须匹配，缓存读取也响应取消', async () => {
  const reader=new Bilibili(async()=>ok({aid:2,bvid:'BV1MVbW6XEbZ',owner:{mid:60542591},pages:[{page:1,duration:40}]}),{interval:0});
  await assert.rejects(reader.detail('https://www.bilibili.com/video/av1'),/不一致/);
  await assert.rejects(reader.detail('https://www.bilibili.com/video/BV1MVbW6XEbZ?p=NaN'),/分P/);
  const c=new AbortController();c.abort();await assert.rejects(reader.page(creator,1,30,c.signal));
});

test('切换账号不能接着旧账号游标拼接作品清单，重新读取仍保留失败前清单', async () => {
  const {store,engine,service,record}=await fixture();const item=engine.item(biliEntry(raw(1),creator),biliEntry(raw(1),creator).webpage_url,'B站');
  engine.accounts={active:()=>({id:'new-account',platform:'B站',status:'会话已保存',lastSync:1}),bilibiliLoginReady:async()=>true};let calls=0;engine.bilibili={reset(){},page:async()=>{calls++;throw Error('BILIBILI_RISK 799');}};
  store.put('creator',record.id,{...record,items:[item],seen:[item.key],scanned:1,cursor:2,filters: { ... (await import('../electron/creators.js')).normalizeFilters({limit:100}) }});
  const result=await service.page(record.id,{});assert.equal(calls,0);assert.equal(result.cursor,2);assert.match(result.message,/账号/);
  store.put('creator',record.id,{...store.get('creator',record.id),complete:true});
  const failed=await service.page(record.id,{limit:100},true);assert.equal(failed.items.length,1);assert.equal(failed.restartRequired,true);
  const retry=await service.page(record.id,{});assert.equal(calls,2);assert.equal(retry.items.length,1);store.close();
});

test('失败重读后显式改变筛选仍生效，重复页继续会重新读第一页', async () => {
  const {store,engine,service,record}=await fixture();const item=engine.item(biliEntry(raw(1),creator),biliEntry(raw(1),creator).webpage_url,'B站');const starts=[];
  store.put('creator',record.id,{...record,items:[item],scanned:1,cursor:2,seen:[item.key],restartRequired:true,filters:{limit:50,keyword:'旧关键词',period:'all'}});
  engine.bilibili={reset(){},page:async(_creator,start)=>{starts.push(start);return{entries:[biliEntry(raw(2),creator)],advance:1,total:1,complete:true};}};
  const result=await service.page(record.id,{limit:100,keyword:'作品2'},true);assert.equal(result.filters.keyword,'作品2');assert.equal(result.filters.limit,100);assert.equal(result.items[0].title,'作品2');assert.deepEqual(starts,[1]);store.close();
});

test('补全响应缺少字段不覆盖原有封面、日期与时长', async () => {
  const {store,engine,service,record}=await fixture();const item=engine.item(biliEntry(raw(1),creator),biliEntry(raw(1),creator).webpage_url,'B站');item.title='待获取标题';store.put('creator',record.id,{...record,items:[item]});
  engine.bilibili={detail:async()=>({id:raw(1).bvid,title:'补全标题',uploader_id:creator.id})};
  const result=await service.refresh(record.id);assert.equal(result.items[0].title,'补全标题');assert.equal(result.items[0].thumbnail,item.thumbnail);assert.equal(result.items[0].duration,item.duration);assert.equal(result.items[0].publishedAt,item.publishedAt);store.close();
});

test('识别新记录失败可明确恢复同作者历史结果，不混入其他作者或账号', async () => {
  const {store,engine,service,record}=await fixture();const item=engine.item(biliEntry(raw(1),creator),biliEntry(raw(1),creator).webpage_url,'B站');
  store.put('creator','history',{...record,id:'history',items:[item],scanned:1,cursor:2,complete:true,createdAt:1});
  store.put('creator','wrong-account',{...record,id:'wrong-account',creator:{...creator,accountId:'other'},items:[{...item,title:'其他账号私密清单'}],createdAt:3});
  engine.bilibili={reset(){},page:async()=>{throw Error('BILIBILI_RISK 799');}};
  const failed=await service.page(record.id,{limit:100},true);assert.equal(failed.recoveryAvailable,true);assert.equal(failed.items.length,0);
  const recovered=service.recover(record.id);assert.equal(recovered.id,record.id);assert.equal(recovered.items[0].title,'作品1');assert.match(recovered.message,/历史结果/);assert.equal(recovered.restartRequired,true);assert.equal(recovered.complete,false);assert.equal(store.get('creator','history').complete,true);assert.throws(()=>service.recover(record.id));store.close();
});
test('串作者、缺页和空页不能推进位置或伪装完整，集合不作为视频', async () => {
  assert.throws(() => biliEntry({ ...raw(1), mid: 999 }, creator), /其他作者/);
  assert.equal(biliEntry({ ...raw(1), meta: { attribute: 156 } }, creator), null);
  for (const data of [{ page: { pn: 1, ps: 30, count: 50 }, list: { vlist: [] } }, { page: { pn: 2, ps: 30, count: 50 }, list: { vlist: [raw(1)] } }, { page: { pn: 1, ps: 30, count: 50 }, list: { vlist: [{ ...raw(1), mid: 999 }] } }]) {
    const reader = new Bilibili(async url => url.includes('/nav') ? ok({ wbi_img: images }) : ok(data), { interval: 0 });
    await assert.rejects(reader.page(creator, 1, 30));
  }
});
test('列表风控停止重试，冷却期不再次请求，不删除已经读取的清单', async () => {
  let calls = 0;
  const reader = new Bilibili(async url => { calls++; return url.includes('/nav') ? ok({ wbi_img: images }) : { ok: true, status: 200, json: async () => ({ code: -352 }) }; }, { interval: 0 });
  await assert.rejects(reader.page(creator, 1, 30), /BILIBILI_RISK/);
  const before = calls; await assert.rejects(reader.page(creator, 1, 30), /冷却/); assert.equal(calls, before);
  const { store, engine, service } = await fixture(); engine.bilibili = reader;
  const item = engine.item(biliEntry(raw(1), creator), biliEntry(raw(1), creator).webpage_url, 'B站');
  store.put('creator', 'record', { ...store.get('creator','record'), items: [item], seen: [item.key], cursor: 2, scanned: 1 });
  const record = await service.page('record', { limit: 50 }); assert.equal(record.cursor, 2); assert.equal(record.items.length, 1); assert.equal(record.status, 'interrupted');
  const reset = await service.page('record', { limit: 50 }, true); assert.equal(reset.items.length,1); assert.equal(reset.cursor,2); assert.match(reset.message,/原清单/); store.close();
});
test('真实作者分页集成保持50条限额、日期关键词筛选、去重和继续读取位置', async () => {
  const { store, engine, service } = await fixture(); const starts = [];
  engine.bilibili = { reset() {}, page: async (_creator, start, count) => { starts.push(start); const n = Math.min(count, 56-start); return { entries: Array.from({ length: n }, (_, i) => biliEntry(raw(start+i), creator)), advance: n, total: 55, complete: start+n>55 }; } };
  let record = await service.page('record', { limit: 50, keyword: '作品', period: 'custom', from: '2026-10-01', to: '2026-10-05' }, true);
  record = await service.page('record', {}); assert.equal(record.scanned, 50); assert.equal(record.items.length, 50); assert.equal(record.status, 'limited');
  record = await service.page('record', {}, false, true); assert.equal(record.complete, true); assert.equal(record.items.length, 55); assert.equal(new Set(record.items.map(i=>i.key)).size,55); assert.deepEqual(starts,[1,31,51]); store.close();
});
test('旧的空标题清单按需补全，失败与停止保存进度，重试只补未完成条目', async () => {
  const { store, engine, service, record } = await fixture(); const calls=[];
  const items = [1,2].map(n=>engine.item({id:raw(n).bvid},biliEntry(raw(n),creator).webpage_url,'B站'));
  store.put('creator',record.id,{...record,items,cursor:51,scanned:50,status:'interrupted',message:'列表受限'});
  engine.bilibili = { detail: async url => { calls.push(url); if(calls.length===2) throw new Error('BILIBILI_RISK 412'); return biliEntry(raw(Number(url.split('/').at(-1).slice(2))),creator); } };
  let refreshed=await service.refresh(record.id); assert.equal(refreshed.items[0].title,'作品1'); assert.equal(refreshed.items[1].title,'待获取标题'); assert.equal(refreshed.cursor,51); assert.equal(refreshed.status,'interrupted'); assert.equal(refreshed.metadataPending,1);
  engine.bilibili.detail=async url=>{calls.push(url);return biliEntry(raw(2),creator);};
  refreshed=await service.refresh(record.id); assert.equal(refreshed.metadataPending,0); assert.equal(calls.length,3); assert.equal(refreshed.items[1].duration,659); store.close();
});
test('单视频详情保留原作者和分P时长，不把不同视频当成原链接', async () => {
  const reader=new Bilibili(async()=>ok({bvid:'BV1MVbW6XEbZ',title:'原视频',pic:'http://i2.hdslb.com/a.jpg',owner:{mid:60542591,name:'原作者'},pubdate:1791028800,duration:100,pages:[{page:1,duration:40,part:'第一P'},{page:2,duration:60,part:'第二P'}]}),{interval:0});
  const item=await reader.detail('https://www.bilibili.com/video/BV1MVbW6XEbZ?p=2');assert.equal(item.duration,60);assert.match(item.title,/第二P/);assert.equal(item.uploader_id,creator.id);
  await assert.rejects(reader.detail('https://www.bilibili.com/video/BV1aaaaaaaaa'),/不一致/);
});
test('停止补全保留已完成信息，再次补全只读取剩余作品', async () => {
  const {store,engine,service,record}=await fixture();const items=[1,2].map(n=>engine.item({},biliEntry(raw(n),creator).webpage_url,'B站'));
  store.put('creator',record.id,{...record,items});let entered;const ready=new Promise(r=>entered=r);
  engine.bilibili={detail:async(url,_account,signal)=>{if(url.endsWith(raw(1).bvid))return biliEntry(raw(1),creator);entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('CANCELLED')),{once:true}));}};
  const pending=service.refresh(record.id);await ready;service.cancel();const stopped=await pending;assert.equal(stopped.items[0].title,'作品1');assert.equal(stopped.metadataPending,1);assert.match(stopped.metadataMessage,/已停止/);
  let calls=0;engine.bilibili.detail=async()=>{calls++;return biliEntry(raw(2),creator);};assert.equal((await service.refresh(record.id)).metadataPending,0);assert.equal(calls,1);store.close();
});
test('单个作品已删除不会阻止补全其他视频，失效项明确标注且不进入下载', async () => {
  const {store,engine,service,record}=await fixture();const items=[1,2].map(n=>engine.item({},biliEntry(raw(n),creator).webpage_url,'B站'));store.put('creator',record.id,{...record,items});
  engine.bilibili={detail:async url=>{if(url.endsWith(raw(1).bvid))throw new Error('Video unavailable');return biliEntry(raw(2),creator);}};
  const result=await service.refresh(record.id);assert.equal(result.items[0].available,false);assert.match(result.items[0].metadataError,/失效/);assert.equal(result.items[1].title,'作品2');assert.equal(result.metadataPending,0);store.close();
});
