import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { request } from '../cli/protocol.mjs';

const live = process.argv.includes('--live');
const output = path.resolve('output', `user-search-${live ? 'live' : 'e2e'}-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, 'profile'), env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: profile, FENGSHA_TEST_VISIBLE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const result = { ok: false, output, mode: live ? 'real public network; no saved login' : 'isolated official-page fixtures; not live platform acceptance' }, errors = []; let app;
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve(process.argv[2] || '.')], env, timeout: 45000 });
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  await page.getByRole('button', { name: '用户搜索', exact: true }).click(); await page.getByLabel('用户搜索关键词').fill('AI');
  if (live) {
    for (const platform of ['YouTube', '抖音', '小红书']) {
      await page.getByLabel('搜索用户平台').selectOption(platform); await page.getByRole('button', { name: '搜索用户', exact: true }).click();
      await page.getByRole('button', { name: '搜索用户', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('.user-search-form button[type]') && !document.querySelector('.user-search-form .spin') && !document.querySelector('.user-search-form .primary')?.disabled, { timeout: 45000 });
      const r = await page.evaluate(async () => (await window.fengsha.userSearchLast()).value);
      result[platform] = { status: r?.status, users: r?.users.length, message: r?.message, first: r?.users[0] && { id: r.users[0].id, name: r.users[0].name, description: r.users[0].description } };
      await page.screenshot({ path: path.join(output, `${platform}.png`) });
      if (platform === 'YouTube') { assert.ok(r.users.length > 0); assert.equal(r.status, 'browser'); }
    }
    result.ok = true;
  } else {
    await app.context().route('https://www.youtube.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>AI - YouTube</title><ytd-channel-renderer><a href="/@theAIsearch"><div id="channel-title"><span id="text">AI Search 测试卡片</span></div></a><div id="description">测试简介</div><span>75.4万位订阅者</span></ytd-channel-renderer><a href="/@sidebar">侧边栏非结果</a><ytd-video-renderer><a href="/@video-author">视频推荐的作者</a></ytd-video-renderer>' }));
    await app.context().route('https://www.douyin.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>AI 用户搜索</title><div data-e2e="search-user-item"><a href="/user/MS4wLjABtest"><span data-e2e="user-title">抖音测试用户</span></a><span data-e2e="user-signature">抖音简介</span><span>1.2万粉丝</span></div><div data-e2e="video-author"><a href="/user/MS4wLjABrecommend">推荐作者</a></div>' }));
    await app.context().route('https://www.xiaohongshu.com/**', r => r.fulfill({ contentType: 'text/html', body: '<title>AI 搜索</title><div class="user-list"><div class="user-item"><a href="/user/profile/0123456789abcdef01234567"><span class="user-name">小红书测试用户</span></a><span class="desc">红书简介</span><span>300粉丝</span></div></div><div class="note-item"><a href="/user/profile/abcdefabcdefabcdefabcdef">笔记作者</a></div>' }));
    await app.evaluate(async () => {
      const { accounts, engine, wechatCreators, creators } = globalThis.fengshaTest; creators.connection = { withConnection: async (_signal, operation) => operation() };
      engine.bilibili.interval = 0; globalThis.searchCalls = [];
      engine.bilibili.request = async url => { const u = new URL(url); globalThis.searchCalls.push(u.pathname); const pn = Number(u.searchParams.get('page') || 1); const data = u.pathname.endsWith('/card') ? { card: { mid: '19', name: 'B站测试用户', face: '' }, archive_count: 2 } : { page: pn, numPages: 2, result: [{ mid: pn === 1 ? 19 : 20, uname: '同名测试用户', fans: 0, videos: 2, usign: '搜索测试简介' }] }; return { ok: true, status: 200, json: async () => ({ code: 0, data }) }; };
      wechatCreators.test = async () => ({ connected: true }); wechatCreators.request = async () => ({ infoList: [{ contact: { username: 'v2_search_test@finder', nickname: '视频号测试用户', signature: '公开简介' } }], continueFlag: 0 });
      const a = accounts.add('B站', '隔离搜索测试'); await accounts.getSession(a.id).cookies.set({ url: 'https://www.bilibili.com/', domain: '.bilibili.com', path: '/', name: 'SESSDATA', value: 'SYNTHETIC-SEARCH-TEST', expirationDate: Date.now() / 1000 + 3600 }); await accounts.complete(a.id);
    });
    for (const platform of ['视频号', '抖音', '小红书', 'B站', 'YouTube']) {
      await page.getByLabel('搜索用户平台').selectOption(platform); await page.getByRole('button', { name: '搜索用户', exact: true }).click();
      await page.locator('.user-search-card').first().waitFor(); await page.waitForFunction(() => !document.querySelector('.user-search-form .primary').disabled);
      const r = await page.evaluate(async () => (await window.fengsha.userSearchLast()).value); assert.equal(r.platform, platform); assert.equal(r.users.length, 1); assert.ok(r.users[0].id); assert.equal(r.users[0].followers, platform === 'B站' ? 0 : null);
      result[platform] = true; await page.screenshot({ path: path.join(output, `${platform}.png`) });
      if (platform === 'B站') { await page.getByRole('button', { name: '加载更多用户', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.user-search-card').length === 2); }
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); result.smallWindowFits = true;
    await page.getByRole('button', { name: '任务中心', exact: true }).click(); await page.getByRole('button', { name: '用户搜索', exact: true }).click(); assert.equal(await page.getByLabel('用户搜索关键词').inputValue(), 'AI'); assert.equal(await page.locator('.user-search-card').count(), 1); result.navigationPreservesSearch = true;
    // Read the native official window after a challenge and verify it never becomes an empty-success result.
    await app.evaluate(async () => { const w = globalThis.fengshaTest.userSearch.browser.window; await w.webContents.executeJavaScript('document.title="验证码中间页";document.body.innerHTML="请完成验证"'); });
    await page.getByRole('button', { name: '读取官方页面结果', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.user-search-form .primary').disabled);
    const pending = await page.evaluate(async () => (await window.fengsha.userSearchLast()).value); assert.equal(pending.status, 'needs-action'); assert.equal(pending.users.length, 1); result.challengePreservesUsers = true;
    const cli = await request(profile, { command: 'search', source: 'AI', options: { platform: '视频号' } }); assert.equal(cli.ok, true); assert.equal(cli.data.users[0].id, 'v2_search_test@finder'); result.cliSameService = true;
    await page.getByLabel('搜索用户平台').selectOption('B站'); await page.getByRole('button', { name: '搜索用户', exact: true }).click(); await page.locator('.user-search-card').filter({ hasText: '同名测试用户' }).waitFor();
    await page.getByRole('button', { name: '选择并读取作品', exact: true }).click(); await page.getByRole('heading', { name: '博主批量下载', exact: true }).waitFor();
    const record = await page.evaluate(async () => (await window.fengsha.creatorLast()).value); assert.equal(record.creator.id, '19'); assert.equal(record.items.length, 0); result.selectedIdentityAndNoAutoDownload = true;
    result.ok = true;
  }
  assert.deepEqual(errors, []); result.rendererErrors = errors;
} finally { if (app) await app.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
