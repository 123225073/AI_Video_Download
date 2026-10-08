import test from 'node:test';
import assert from 'node:assert/strict';
import { searchInput, searchUrl, searchUser, biliSearchPage, wechatSearchPage } from '../electron/user-search-data.js';
import { UserSearch } from '../electron/user-search.js';
import { parseArgs } from '../cli/options.mjs';
import { createAgentHandler } from '../electron/agent.js';

const bili = (id, name = '相同昵称') => searchUser('B站', { id, name });
function service() {
  const calls = []; let account = { id: 'a' };
  const search = new UserSearch({ accounts: { active: () => account }, creators: { progress: () => null, requireLogin: async () => {} }, bilibili: { json: async url => { calls.push(url); const page = Number(new URL(url, 'https://api.bilibili.com').searchParams.get('page')); return { page, numPages: 2, result: [{ mid: page, uname: '相同昵称', fans: 0, videos: 3 }] }; } }, wechat: { test: async () => ({ connected: true }), request: async () => ({ infoList: [{ contact: { username: 'v2_test@finder', nickname: '微信用户' }, friendFollowCount: 19 }], continueFlag: 0 }) }, browser: { close() {}, read: async r => ({ users: [searchUser(r.platform, { id: { '抖音': 'MS4wLjABtest', '小红书': '0123456789abcdef01234567', 'YouTube': '@test' }[r.platform], name: '测试用户' })], status: 'browser', next: null }) } });
  return { search, calls, account: a => account = a };
}
test('search validates platform, Unicode keywords and query encoding', () => {
  assert.equal(searchInput('小红书', '  电梯 AI  '), '电梯 AI');
  for (const word of ['', ' '.repeat(5), 'a'.repeat(101), 'a\nb', null]) assert.throws(() => searchInput('B站', word));
  assert.throws(() => searchInput('其他', 'AI'));
  assert.equal(new URL(searchUrl('YouTube', 'AI & 设计')).searchParams.get('search_query'), 'AI & 设计');
  assert.equal(new URL(searchUrl('小红书', 'AI')).searchParams.get('type'), '51');
});
test('search users require stable identity; canonical URL ignores untrusted fields', () => {
  for (const p of ['视频号', '抖音', '小红书', 'B站', 'YouTube']) assert.equal(searchUser(p, { id: '展示昵称', name: '用户', url: 'https://evil.com' }), null);
  assert.equal(searchUser('视频号', { id: '12345', name: '微信' }), null);
  assert.equal(searchUser('B站', { id: 9999999999999999999, name: '用户' }), null);
  assert.equal(searchUser('抖音', { id: 'self', name: '自己' }), null);
  const user = searchUser('B站', { id: 17, name: '<em>同名</em>用户', avatar: '//i0.hdslb.com/a.jpg', description: '<b>简介</b>', followers: 0, videos: -1, url: 'https://evil.com' });
  assert.equal(user.name, '同名用户'); assert.equal(user.description, '简介'); assert.equal(user.followers, 0); assert.equal(user.videos, null); assert.equal(user.url, 'https://space.bilibili.com/17/video'); assert.ok(user.avatar.startsWith('https:'));
  assert.equal(searchUser('YouTube', { id: '@AI频道', name: '频道' }).idKind, 'handle');
});
test('Bili rejects missing or mismatched pagination and does not derive counts from videos', () => {
  assert.throws(() => biliSearchPage({ result: [] }, 1));
  assert.throws(() => biliSearchPage({ page: 2, numPages: 2, result: [] }, 1));
  assert.throws(() => biliSearchPage({ page: 1, numPages: 2, result: [{ uname: '只有名字' }] }, 1));
  assert.equal(biliSearchPage({ page: 1, numPages: 0, result: [] }, 1).status, 'complete');
});
test('WeChat omits private/incorrect metrics and never claims completion without marker', () => {
  const page = wechatSearchPage({ infoList: [{ contact: { username: 'v2_a@finder', nickname: '甲', signature: '简介' }, friendFollowCount: 999 }] });
  assert.equal(page.users[0].followers, null); assert.equal(page.status, 'limited');
  assert.equal(wechatSearchPage({ infoList: [], continueFlag: 0 }).status, 'complete');
  assert.equal(wechatSearchPage({ infoList: [], continueFlag: 1, lastBuff: 'A' }).next, 'A');
  assert.throws(() => wechatSearchPage({ infoList: [], continueFlag: 1, lastBuff: 'A' }, 'A'));
  assert.throws(() => wechatSearchPage({ infoList: [], continueFlag: '1' }));
  assert.throws(() => wechatSearchPage({ objectList: [] }));
});
test('five adapters return real-shaped public fields and hide session identifiers', async () => {
  for (const platform of ['视频号', '抖音', '小红书', 'B站', 'YouTube']) { const { search } = service(); const r = await search.start(platform, 'AI'); assert.equal(r.platform, platform); assert.equal(r.users.length, 1); assert.equal('accountId' in r, false); assert.equal('next' in r, false); }
});
test('pagination deduplicates IDs, keeps distinct same-name users, rejects obsolete search IDs', async () => {
  const { search, calls } = service(); const first = await search.start('B站', 'AI'); const second = await search.more(first.id);
  assert.equal(second.users.length, 2); assert.equal(second.status, 'complete'); assert.ok(calls[1].includes('page=2')); assert.equal(second.users[0].name, second.users[1].name);
  await assert.rejects(search.more(first.id), /没有可继续/); await search.start('B站', '摄影'); await assert.rejects(search.more(first.id), /被替换/);
});
test('account switching during request cannot merge results into previous account', async () => {
  const { search, account } = service(); let release; search.bilibili.json = () => new Promise(r => release = r);
  const pending = search.start('B站', 'AI'); while (!release) await new Promise(r => setImmediate(r)); account({ id: 'b' }); release({ page: 1, numPages: 1, result: [{ mid: 1, uname: '用户' }] });
  await assert.rejects(pending, /账号已切换/); assert.equal(search.view().users.length, 0);
});
test('login gate occurs before network, failed new search preserves previous result', async () => {
  const { search, calls } = service(); const first = await search.start('B站', 'AI'); search.creators.requireLogin = async () => { throw new Error('请先登录'); };
  await assert.rejects(search.start('B站', '新查询'), /先登录/); assert.deepEqual(search.view(), first); assert.equal(calls.length, 1);
});
test('risk cooldown retains cursor and blocks repeated network requests', async () => {
  const { search, calls } = service(); const first = await search.start('B站', 'AI'); search.bilibili.json = async () => { calls.push('risk'); throw new Error('BILIBILI_RISK 352'); };
  await assert.rejects(search.more(first.id), /限制/); assert.equal(search.view().users.length, 1); await assert.rejects(search.more(first.id), /冷却/); await assert.rejects(search.start('B站', '其他'), /冷却/); assert.equal(calls.length, 2);
});
test('cancel, simultaneous read and platform failure preserve acquired users', async () => {
  const { search } = service(); const first = await search.start('B站', 'AI'); let release;
  search.bilibili.json = () => new Promise(r => release = r); const pending = search.more(first.id); while (!release) await new Promise(r => setImmediate(r));
  await assert.rejects(search.start('视频号', '新查询'), /正在搜索/); search.cancel(); release({ page: 2, numPages: 2, result: [{ mid: 2, uname: '乙' }] }); await assert.rejects(pending); assert.equal(search.view().users.length, 1); assert.equal(search.view().status, 'cancelled');
});
test('CLI search options and agent route use same service, no creator writes', async () => {
  const parsed = parseArgs(['search', 'AI 工具', '--platform', 'YouTube']); assert.equal(parsed.source, 'AI 工具');
  for (const args of [['search', 'AI'], ['search', '--record', 'x'], ['search', 'AI', '--platform', '其他'], ['search', 'AI', '--record', 'x', '--continue']]) assert.throws(() => parseArgs(args));
  const { search } = service(); const handler = createAgentHandler({ userSearch: search, busy: () => false }); const result = await handler(parsed); assert.equal(result.users[0].id, '@test');
  assert.equal(parseArgs(['search', '--record', result.id, '--continue']).command, 'search');
});
test('browser verification is a pending action, not an empty success', async () => {
  const { search } = service(); search.browser.read = async () => ({ users: [], next: null, status: 'needs-action', partial: true, message: '验证码' });
  const r = await search.start('抖音', 'AI'); assert.equal(r.partial, true); assert.equal(r.canContinue, true); assert.equal(r.status, 'needs-action');
});
test('WeChat search prepares the existing connection before checking the page and restores after query', async () => {
  const { search } = service(); let connected = false; const events = [];
  search.wechat.test = async () => { events.push('check-page'); return { connected }; };
  search.creators.connection = { withConnection: async (signal, operation) => { events.push('prepare'); connected = true; try { return await operation(); } finally { connected = false; events.push('restore'); } } };
  const result = await search.start('视频号', '减肥');
  assert.equal(result.users.length, 1); assert.deepEqual(events, ['prepare', 'check-page', 'restore']); assert.equal(connected, false);
});
