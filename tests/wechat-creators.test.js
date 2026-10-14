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

test('缺少稳定作者ID或身份待确认时拒绝读取，不连接、不清空已有清单', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null);
  let requests = 0, connections = 0;
  const connector = new WeChatCreators(store, engine, async () => { requests++; return wrap({ object: [], continueFlag: 0 }); });
  const creators = new Creators(store, engine, null, () => {}, connector);
  creators.connection = { withConnection: async (_signal, run) => { connections++; return run(); } };
  for (const identity of [{ id: null }, { id: '' }, { id: '   ' }, { id: 'shared_author_fake' }, { id: username, identityStatus: 'pending' }]) {
    const r = { id: 'unconfirmed', creator: { platform: '视频号', name: '同名作者', supported: true, adapter: 'wechat-collector', ...identity }, items: [{ key: 'old' }], scanned: 1, collectorCursor: 'saved', collectorPending: [{ id: '1' }] };
    store.put('creator', r.id, r);
    await assert.rejects(creators.page(r.id, { limit: 50 }, true), /稳定作者 ID.*重新识别/);
    assert.deepEqual(store.get('creator', r.id), r);
    await assert.rejects(connector.page(r.creator, 50), /稳定作者 ID.*重新识别/);
  }
  assert.equal(requests, 0); assert.equal(connections, 0); store.close();
});

test('只有头像昵称时保留资料并明确身份待确认，不按同名作者读取', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null);
  engine.parse = async () => ({ items: [{ author: '同名作者', creatorAvatar: 'https://images.example/avatar' }] });
  const calls = [];
  const connector = new WeChatCreators(store, engine, async url => { calls.push(new URL(url).pathname); return wrap({ object: { contact: { nickname: '同名作者' } } }); });
  const creators = new Creators(store, engine, null, () => {}, connector);
  const r = await creators.identify('https://weixin.qq.com/sph/original');
  assert.equal(r.creator.id, null); assert.equal(r.creator.name, '同名作者'); assert.ok(r.creator.avatar);
  assert.equal(r.creator.supported, false); assert.equal(r.creator.identityStatus, 'pending'); assert.equal(r.status, 'needs-connection');
  assert.match(r.creator.reason, /稳定作者 ID/);
  await assert.rejects(creators.page(r.id, { limit: 50 }, true), /稳定作者 ID/);
  assert.deepEqual(calls, ['/api/channels/feed/profile']); store.close();
});

test('原链接解析与微信身份读取均未完成时返回待确认记录，不臆断元宝登录原因', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null);
  engine.parse = async () => { throw new Error('分享资料暂未返回'); };
  const connector = new WeChatCreators(store, engine, async () => wrap({ object: { contact: {} } }));
  const creators = new Creators(store, engine, null, () => {}, connector), r = await creators.identify('https://weixin.qq.com/sph/original');
  assert.equal(r.creator.id, null); assert.equal(r.creator.identityStatus, 'pending'); assert.equal(r.creator.supported, false); assert.equal(r.status, 'needs-connection');
  assert.match(r.creator.reason, /稳定作者 ID/); assert.doesNotMatch(r.creator.reason, /元宝/);
  assert.equal(store.get('creator', r.id).creator.identityStatus, 'pending'); store.close();
});

test('作品读取复用source_url并按上游uint64编码内部链接，不逐项请求分享接口', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null);
  const source = 'https://weixin.qq.com/sph/captured';
  const objects = [
    { id: '5397107284542310304', objectNonceId: '14887697630331082851_0_146_0_0' },
    { id: '18446744073709551615', objectNonceId: '', source_url: source },
    { id: '14954560208914487678', objectNonceId: '', source_url: 'https://www.douyin.com/video/unrelated' },
    { id: '18446744073709551615', objectNonceId: '1', source_url: 'https://user:secret@weixin.qq.com/sph/invalid' }
  ].map(raw => ({ ...raw, contact: { username }, objectDesc: { mediaType: 4, description: '视频', media: [{ thumbUrl: 'https://images.example/cover', videoPlayLen: 12 }] }, createtime: 1790712000 }));
  const calls = [];
  const connector = new WeChatCreators(store, engine, async url => {
    const u = new URL(url); calls.push(u);
    if (!u.pathname.endsWith('feed/list')) throw new Error('分享接口不可用');
    return wrap({ object: objects, contact: { username }, feedsCount: 4, continueFlag: 0, lastBuffer: '' });
  });
  const first = await connector.page({ id: username, name: '作者' }, 1);
  const link = new URL(first.items[0].url);
  assert.equal(link.origin + link.pathname, 'https://channels.weixin.qq.com/web/pages/feed');
  assert.equal(link.searchParams.get('username'), username); assert.equal(link.searchParams.get('oid'), 'SuZgeu3RR6A'); assert.equal(link.searchParams.get('nid'), 'zpu6HctPGGM');
  assert.equal(first.items[0].sourceId, objects[0].id); assert.equal(first.items[0].objectNonceId, objects[0].objectNonceId);
  const next = await connector.page({ id: username, name: '作者' }, 50, undefined, first.next, first.pending);
  assert.equal(next.items[0].url, source); assert.equal(new URL(next.items[1].url).searchParams.get('oid'), 'z4lFRwCKGX4');
  assert.equal(new URL(next.items[2].url).searchParams.get('oid'), '__________8'); assert.equal(new URL(next.items[2].url).searchParams.get('nid'), 'AAAAAAAAAAE');
  assert.equal(next.complete, true); assert.equal(next.total, 4); assert.ok(next.items[0].publishedAt);
  const mediaObject = { ...objects[0], objectDesc: { mediaType: 4, description: '原视频', media: [{ url: 'https://finder.video.qq.com/video.mp4' }] } };
  connector.fetch = async url => { const u = new URL(url); calls.push(u); return wrap({ object: mediaObject }); };
  const resolved = await connector.resolve(first.items[0]);
  assert.equal(resolved.info.id, objects[0].id); assert.equal(calls[1].searchParams.get('oid'), objects[0].id); assert.equal(calls[1].searchParams.get('nid'), objects[0].objectNonceId);
  assert.equal(calls.length, 2); assert.equal(calls[0].searchParams.get('username'), username); assert.equal(calls[0].searchParams.get('next_marker'), '');
  store.close();
});

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
test('无效作品ID不提交半页；跨页循环游标不能无限读取', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null); let marker = 'A', broken = true;
  const object = id => ({ id, contact: { username }, objectDesc: { mediaType: 4, description: '视频', media: [{ thumbUrl: 'https://images.example/a' }] } });
  const connector = new WeChatCreators(store, engine, async url => { const u = new URL(url); assert.ok(u.pathname.endsWith('feed/list')); return wrap({ object: broken ? [object('1'), object('18446744073709551616')] : [object(marker === 'A' ? '1' : '2')], continueFlag: 1, lastBuffer: marker }); }); connector.save({ enabled: true });
  const r = { id: 'loop', creator: { id: username, platform: '视频号', supported: true, name: '作者', adapter: 'wechat-collector' }, items: [], scanned: 0, cursor: 1, seen: [], skipped: {}, status: 'identified' }; store.put('creator', r.id, r); const creators = new Creators(store, engine, null, () => {}, connector);
  const failed = await creators.page(r.id, { limit: 'all' }, true); assert.equal(failed.status, 'interrupted'); assert.equal(failed.scanned, 0); assert.equal(failed.collectorCursor, null); broken = false; const first = await creators.page(r.id, {}); assert.equal(first.items.length, 1); marker = 'B'; const second = await creators.page(r.id, {}); assert.equal(second.items.length, 2); marker = 'A'; const loop = await creators.page(r.id, {}); assert.equal(loop.status, 'interrupted'); assert.equal(loop.items.length, 2); assert.equal(loop.collectorCursor, 'B'); await creators.close(); store.close();
});

test('existing public-share author metadata identifies without asking the desktop to reopen',async()=>{
 const store=await Store.open(path.resolve('output/unit-collector',randomUUID()),{}),engine=new Engine('',null,null);
 let connectionCalls=0,parseOptions;
 engine.parse=async (source,options)=>{parseOptions=options;return {items:[{author:'原作者',creatorId:username,sourceId:'123'}]};};
 const connector=new WeChatCreators(store,engine,async()=>{throw new Error('must not reread known metadata');});
 const connection={withConnection:async()=>{connectionCalls++;throw new Error('must not open desktop');}};
 const creators=new Creators(store,engine,null,()=>{},connector,connection);
 // Existing constructor configuration supports connection as a separate property.
 creators.connection=connection;
 const r=await creators.identify('https://weixin.qq.com/sph/AidY5tmMHd');assert.equal(r.creator.id,username);assert.equal(r.creator.supported,true);assert.equal(r.creator.identityStatus,'confirmed');assert.equal(r.status,'identified');assert.equal(connectionCalls,0);assert.equal(parseOptions.allowCollector,false);store.close();
});

test('待确认ID不会被原链接快速路径当作确认；占位作者ID可由原视频真实ID替换', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null);
  let reads = 0;
  const connector = new WeChatCreators(store, engine, async url => { reads++; assert.ok(new URL(url).pathname.endsWith('feed/profile')); return wrap({ object: { id: '5397107284542310304', contact: { username, nickname: '原作者' } } }); });
  const creators = new Creators(store, engine, null, () => {}, connector);
  for (const item of [{ creatorId: username, identityStatus: 'pending' }, { creatorId: 'shared_author_fake' }]) {
    engine.parse = async () => ({ items: [{ author: '原作者', ...item }] });
    const r = await creators.identify('https://weixin.qq.com/sph/original');
    assert.equal(r.creator.id, username); assert.equal(r.creator.identityStatus, 'confirmed'); assert.equal(r.status, 'identified'); assert.equal(r.creator.sourceObjectId, '5397107284542310304');
  }
  assert.equal(reads, 2);
  engine.parse = async () => ({ items: [{ author: '原作者', creatorId: username, identityStatus: 'pending' }] });
  connector.fetch = async () => wrap({ object: { contact: { nickname: '原作者' } } });
  const unresolved = await creators.identify('https://weixin.qq.com/sph/original');
  assert.equal(unresolved.creator.identityStatus, 'pending'); assert.equal(unresolved.creator.supported, false); assert.equal(unresolved.status, 'needs-connection');
  await assert.rejects(creators.page(unresolved.id, { limit: 50 }), /稳定作者 ID/); store.close();
});

test('主页通过返回contact确认ID，不把相同昵称当作同一作者', async () => {
  const store = await Store.open(path.resolve('output/unit-collector', randomUUID()), {}), engine = new Engine('', null, null);
  const connector = new WeChatCreators(store, engine, async url => {
    const u = new URL(url); assert.equal(u.searchParams.get('username'), username); assert.equal(u.searchParams.get('next_marker'), '');
    return wrap({ contact: { username, nickname: '同名作者' }, object: [], feedsCount: 0, continueFlag: 0, lastBuffer: '' });
  });
  const creators = new Creators(store, engine, null, () => {}, connector), source = `https://channels.weixin.qq.com/web/pages/profile?username=${encodeURIComponent(username)}`;
  const r = await creators.identify(source);
  assert.equal(r.creator.identityStatus, 'confirmed'); assert.equal(r.status, 'identified'); assert.equal(r.total, 0);
  connector.fetch = async () => wrap({ contact: { username: 'other@finder', nickname: '同名作者' }, object: [] });
  const rejected = await creators.identify(source);
  assert.equal(rejected.creator.supported, false); assert.equal(rejected.creator.identityStatus, 'pending'); assert.equal(rejected.status, 'needs-connection'); assert.match(rejected.creator.reason, /身份.*不一致/);
  await assert.rejects(creators.page(rejected.id, {}, true), /稳定作者 ID/); store.close();
});

test('视频号重读失败保留已有作品、缓冲和游标，正常续读仍能完成', async () => {
  const dir = path.resolve('output/unit-collector', randomUUID()), store = await Store.open(dir, {}), engine = new Engine('', null, null);
  let broken = false;
  const connector = new WeChatCreators(store, engine, async url => {
    assert.ok(new URL(url).pathname.endsWith('feed/list'));
    if (broken) return wrap({ object: [], continueFlag: 1, lastBuffer: '' });
    return wrap({ object: ['1', '2'].map(id => ({ id, contact: { username }, objectDesc: { mediaType: 4, description: '视频', media: [{ thumbUrl: 'https://images.example/cover', coverUrl: 'https://images.example/cover', videoPlayLen: 12 }] }, createtime: 1790712000 })), continueFlag: 0, lastBuffer: '' });
  });
  const r = { id: 'saved', creator: { id: username, platform: '视频号', name: '作者', supported: true, adapter: 'wechat-collector' }, items: [], scanned: 0, cursor: 1, seen: [], skipped: {} };
  store.put('creator', r.id, r);
  const creators = new Creators(store, engine, null, () => {}, connector), first = await creators.page(r.id, { limit: 1 }, true);
  assert.equal(first.items.length, 1); assert.equal(first.collectorPending.length, 1);
  broken = true;
  const failed = await creators.page(r.id, { limit: 50 }, true);
  assert.equal(failed.status, 'interrupted'); assert.match(failed.message, /原清单已保留/);
  for (const key of ['items', 'scanned', 'seen', 'cursor', 'collectorCursor', 'collectorPending']) assert.deepEqual(failed[key], first[key]);
  store.close();
  const reopened = await Store.open(dir, {}); assert.deepEqual(reopened.get('creator', r.id).items, first.items);
  broken = false;
  const recovered = new Creators(reopened, engine, null, () => {}, new WeChatCreators(reopened, engine, connector.fetch));
  await recovered.page(r.id, {});
  const next = await recovered.page(r.id, {}, false, true);
  assert.equal(next.items.length, 2); assert.equal(new Set(next.items.map(item => item.sourceId)).size, 2); assert.equal(next.complete, true);
  reopened.close();
});
