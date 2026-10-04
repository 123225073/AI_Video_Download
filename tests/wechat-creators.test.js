import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/store.js';
import { Engine } from '../electron/engine.js';
import { Creators, profileFromUrl } from '../electron/creators.js';
import { WeChatCreators, wechatMetadata, collectorBase } from '../electron/wechat-creators.js';
const username = 'confirmed-author@finder';
const wrap = data => new Response(JSON.stringify({ code: 0, data: { errCode: 0, data } }));

test('作品通过微信解析下载参数，稳定ID/作者核对；大整数解密参数不丢精度',async()=>{
  const store=await Store.open(path.resolve('output/unit-collector',randomUUID()),{}),engine=new Engine('',null,null);let requested;
  const connector=new WeChatCreators(store,engine,async url=>{requested=new URL(url);return new Response('{"code":0,"data":{"errCode":0,"data":{"object":{"id":"12345678901234567890","contact":{"username":"confirmed-author@finder","nickname":"原作者"},"objectDesc":{"mediaType":4,"media":[{"url":"https://finder.video.qq.com/video.mp4","urlToken":"?secret=ephemeral","decodeKey":12345678901234567890}]}}}}}');});
  const item={acquisition:'wechat-collector',sourceId:'12345678901234567890',objectNonceId:'nonce',creatorId:username,url:'https://weixin.qq.com/sph/original'};
  const media=await connector.resolve(item);assert.equal(requested.searchParams.get('nid'),'nonce');assert.equal(media.decodeKey,'12345678901234567890');assert.match(media.url,/ephemeral/);
  await assert.rejects(connector.resolve({...item,creatorId:'other'}),/作者身份/);await assert.rejects(connector.resolve({...item,sourceId:'different'}),/不一致/);
  assert.equal(JSON.stringify(store.list('task')).includes('ephemeral'),false);store.close();
});
test('视频号分享作者与封面被保留；仅姓名不能成为稳定作者ID', () => {
  const meta = wechatMetadata({ data: { object: { contact: { username, nickname: '原作者', headUrl: 'https://images.example/avatar' }, objectDesc: { media: [{ thumbUrl: 'https://images.example/cover' }] }, createtime: 1790712000 } } }); assert.equal(meta.id, username); assert.equal(meta.name, '原作者'); assert.ok(meta.thumbnail); assert.ok(meta.publishedAt); assert.equal(wechatMetadata({ data: { authorinfo: { nickname: '同名', username: 'shared_author_fake' } } }).id, null); assert.throws(() => collectorBase('http://remote.example:2022')); assert.equal(profileFromUrl(`https://channels.weixin.qq.com/web/pages/profile?username=${encodeURIComponent(username)}`).id, username);
});
test('视频号原链接确认作者，55条跨页缓冲无丢失；保留封面日期和总数', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null); const calls = [];
  const objects = Array.from({ length: 55 }, (_, i) => ({ id: `12345678901234567${String(i).padStart(2, '0')}`, contact: { username }, objectDesc: { mediaType: 4, description: `视频${i}`, media: [{ thumbUrl: `https://images.example/${i}`, videoPlayLen: 55 }] }, createtime: 1790712000 }));
  const connector = new WeChatCreators(store, engine, async url => { const u = new URL(url); calls.push(u.pathname); if (u.pathname.endsWith('feed/profile')) return wrap({ object: { contact: { username, nickname: '原作者', headUrl: 'https://images.example/avatar' } } }); if (u.pathname.endsWith('feed/list')) return wrap({ object: objects, contact: { username, nickname: '原作者' }, feedsCount: 55, continueFlag: 0, lastBuffer: '' }); return wrap({ feedH5Url: `https://weixin.qq.com/sph/${u.searchParams.get('oid')}` }); }); connector.save({ enabled: true });
  engine.parse = async () => ({ items: [{ author: '原作者', creatorId: username, creatorAvatar: 'https://images.example/avatar' }] }); const creators = new Creators(store, engine, null, () => {}, connector); const identified = await creators.identify('https://weixin.qq.com/sph/original'); assert.equal(identified.creator.supported, true); const first = await creators.page(identified.id, { limit: 50 }, true); assert.equal(first.items.length, 50); assert.equal(first.complete, false); assert.equal(first.total, 55); assert.equal(first.collectorPending.length, 5); assert.ok(first.items[0].thumbnail); assert.ok(first.items[0].publishedAt);
  const next = await creators.page(identified.id, {}, false, true); assert.equal(next.items.length, 55); assert.equal(next.complete, true); assert.equal(new Set(next.items.map(x => x.sourceId)).size, 55); assert.equal(calls.filter(p => p.endsWith('feed/list')).length, 1); await creators.close(); store.close();
});
test('视频号服务缺失可解释恢复；串作者、缺分页与重复游标不冒充完整列表', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null), connector = new WeChatCreators(store, engine); connector.save({ enabled: true }); connector.fetch = async () => wrap({ object: { contact: { username: 'other@finder' } } }); await assert.rejects(connector.identify('https://weixin.qq.com/sph/video', { creatorId: username }), /不一致/);
  connector.fetch = async () => wrap({ object: [], continueFlag: 1, lastBuffer: 'same', contact: { username } }); await assert.rejects(connector.page({ id: username, platform: '视频号' }, 50, undefined, 'same'), /分页位置/);
  connector.fetch = async () => wrap({ object: [], contact: { username } }); await assert.rejects(connector.page({ id: username, platform: '视频号' }, 50), /分页状态/);
  connector.save({ enabled: false }); engine.parse = async () => ({ items: [{ author: '已识别作者', creatorAvatar: 'https://images.example/avatar' }] }); const creators = new Creators(store, engine, null, () => {}, connector); const r = await creators.identify('https://weixin.qq.com/sph/video'); assert.equal(r.status, 'needs-connection'); assert.equal(r.creator.avatar, 'https://images.example/avatar'); await creators.close(); store.close();
});
test('服务可达不等于微信在线；大整数作者作品ID不丢精度', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), connector = new WeChatCreators(store, {}); connector.save({ enabled: true }); connector.fetch = async () => new Response('{"code":0,"data":{"available":false}}'); const offline = await connector.test(); assert.equal(offline.connected, false); assert.match(offline.detail, /未连接/); connector.fetch = async () => new Response('{"code":0,"data":{"errCode":0,"data":{"object":{"id":12345678901234567890}}}}'); const data = await connector.request('/api/channels/feed/profile'); assert.equal(data.object.id, '12345678901234567890'); store.close();
});
test('分享链接失败不提交半页；跨页循环游标不能无限读取', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null); let marker = 'A', broken = true;
  const connector = new WeChatCreators(store, engine, async url => { const u = new URL(url); if (u.pathname.endsWith('feed/list')) return wrap({ object: [{ id: `id-${marker}`, contact: { username }, objectDesc: { mediaType: 4, description: '视频', media: [{ thumbUrl: 'https://images.example/a' }] } }], continueFlag: 1, lastBuffer: marker }); if (broken) return wrap({ feedH5Url: 'https://wrong.example/video' }); return wrap({ feedH5Url: `https://weixin.qq.com/sph/${u.searchParams.get('oid')}` }); }); connector.save({ enabled: true });
  const r = { id: 'loop', creator: { id: username, platform: '视频号', supported: true, name: '作者', adapter: 'wechat-collector' }, items: [], scanned: 0, cursor: 1, seen: [], skipped: {}, status: 'identified' }; store.put('creator', r.id, r); const creators = new Creators(store, engine, null, () => {}, connector);
  const failed = await creators.page(r.id, { limit: 'all' }, true); assert.equal(failed.status, 'interrupted'); assert.equal(failed.scanned, 0); assert.equal(failed.collectorCursor, null); broken = false; const first = await creators.page(r.id, {}); assert.equal(first.items.length, 1); marker = 'B'; const second = await creators.page(r.id, {}); assert.equal(second.items.length, 2); marker = 'A'; const loop = await creators.page(r.id, {}); assert.equal(loop.status, 'interrupted'); assert.equal(loop.items.length, 2); assert.equal(loop.collectorCursor, 'B'); await creators.close(); store.close();
});
