import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Creators, profileFromUrl, normalizeFilters, filterItem } from '../electron/creators.js';
import { Store } from '../electron/store.js';
import { Engine } from '../electron/engine.js';

test('博主主页识别使用稳定ID，视频链接不被误认为主页', () => {
  assert.equal(profileFromUrl('https://space.bilibili.com/123/video').id, '123');
  assert.equal(profileFromUrl('https://www.douyin.com/user/MS4wLjABC').id, 'MS4wLjABC');
  assert.equal(profileFromUrl('https://www.xiaohongshu.com/user/profile/63a58bb000000000260073cd').platform, '小红书');
  assert.equal(profileFromUrl('https://www.youtube.com/@Blender/videos').url, 'https://www.youtube.com/@Blender');
  assert.equal(profileFromUrl('https://www.youtube.com/watch?v=test'), null);
  assert.equal(profileFromUrl('https://www.xiaohongshu.com/user/profile/63a58bb000000000260073cd/6411cf99000000001300b6d9'), null);
});
test('时间与关键词组合筛选，未知日期单独处理，日期边界包含当天', () => {
  const f = normalizeFilters({ period: 'custom', from: '2026-09-01', to: '2026-09-30', keyword: '读书', limit: 'all' });
  const item = { title: '读书分享', publishedAt: '20260930' };
  assert.equal(filterItem(item, f, () => false), null);
  assert.equal(filterItem({ ...item, publishedAt: '20261001' }, f, () => false), 'date');
  assert.equal(filterItem({ ...item, publishedAt: null }, f, () => false), 'unknown-date');
  assert.equal(filterItem({ ...item, publishedAt: null }, { ...f, includeUnknown: true }, () => false), null);
  assert.equal(filterItem(item, f, () => true), 'downloaded');
  assert.throws(() => normalizeFilters({ period: 'custom', from: '2026-02-30', to: '2026-03-01' }));
  assert.throws(() => normalizeFilters({ period: 'custom', from: '2026-10-01', to: '2026-09-30' }));
});
async function fixture() {
  const dir = path.resolve('output', 'unit', randomUUID());
  const store = await Store.open(dir, {}), engine = new Engine('', null, null);
  const service = new Creators(store, engine, null, () => {});
  const r = { id: 'creator', creator: { platform: 'YouTube', name: '原作者', listUrl: 'https://www.youtube.com/playlist?list=UUtest', supported: true, adapter: 'yt-dlp' }, items: [], scanned: 0, cursor: 1, seen: [], status: 'identified', skipped: {} };
  store.put('creator', r.id, r); store.put('meta', 'lastCreator', { id: r.id });
  return { store, service, dir };
}
const entries = ids => ids.map(id => ({ id, url: `https://www.youtube.com/watch?v=${id}`, title: id, upload_date: '20260930' }));
test('按页读取到数量上限后可继续，跨页重复去重，末页有实际依据并保存重启位置', async () => {
  const { store, service, dir } = await fixture(); const calls = [];
  service.flat = async (u, p, start) => { calls.push(start); return { entries: entries(start === 1 ? ['a', 'b'] : ['b', 'c']) }; };
  const first = await service.page('creator', { limit: 2 }, true); assert.equal(first.status, 'limited'); assert.equal(first.complete, false); assert.equal(first.items.length, 2);
  const next = await service.page('creator', {}, false, true); assert.equal(next.complete, true); assert.equal(next.items.length, 3); assert.deepEqual(calls, [1, 3]);
  store.close(); const reopened = await Store.open(dir, {}); assert.equal(new Creators(reopened, {}, null, () => {}).last().cursor, 5); reopened.close();
});
test('取消正在执行的分页保留前一页和游标；可以继续读取', async () => {
  const { store, service } = await fixture();
  service.flat = async () => ({ entries: entries(['a', 'b']) });
  await service.page('creator', { limit: 2 }, true);
  service.flat = (u, p, start, count, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true }));
  const pending = service.page('creator', {}, false, true); service.cancel();
  const cancelled = await pending; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.items.length, 2); assert.equal(cancelled.cursor, 3);
  service.flat = async () => ({ entries: entries(['c']) });
  const recovered = await service.page('creator', {}); assert.equal(recovered.items.length, 3); assert.equal(recovered.complete, true); store.close();
});
test('日期过滤补取详情；登录失败不会跳过该页或假装完成', async () => {
  const { store, service } = await fixture();
  service.flat = async () => ({ entries: [{ id: 'a', title: 'a', url: 'https://www.youtube.com/watch?v=a' }] });
  service.engine.parse = async () => { throw new Error('Login required'); };
  const r = await service.page('creator', { period: '30', limit: 50 }, true); assert.equal(r.status, 'interrupted'); assert.equal(r.cursor, 1); assert.equal(r.items.length, 0); assert.match(r.message, /登录/);
  service.engine.parse = async () => ({ items: [{ publishedAt: '20260930' }] });
  const fixed = await service.page('creator', {}); assert.equal(fixed.items.length, 1); assert.equal(fixed.items[0].publishedAt, '20260930'); store.close();
});

for(const external of [false,true])test(`${external?'Chrome':'原生'}博主网页认证失败保留清单，只失效对应原生会话`,async()=>{
  const {store,service}=await fixture();let expired=0;
  try{
    const row=store.get('creator','creator');row.creator={id:'63a58bb000000000260073cd',platform:'小红书',name:'原作者',url:'https://www.xiaohongshu.com/user/profile/63a58bb000000000260073cd',supported:true,adapter:'browser',accountId:'native-account'};row.items=[{key:'saved-work',title:'已保存作品'}];row.seen=['saved-work'];row.scanned=1;row.cursor=2;row.filters=normalizeFilters({period:'all',limit:50});store.put('creator',row.id,row);
    service.engine.accounts={active:()=>({id:'native-account'}),usesExternal:()=>external,markExpired:()=>expired++};
    service.browser={async page(){throw Error('Login required');}};
    const result=await service.page('creator',{},false);assert.equal(result.status,'interrupted');assert.equal(result.complete,false);assert.equal(result.items[0].key,'saved-work');assert.equal(result.cursor,2);assert.equal(expired,external?0:1);
  }finally{store.close();}
});
