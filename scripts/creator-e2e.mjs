import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), root = path.resolve('.'), output = path.resolve('output', `creator-e2e-${Date.now()}`);
fs.mkdirSync(output, { recursive: true }); const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: path.join(output, 'profile'), FENGSHA_TEST_VISIBLE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let application, page; const errors = [], result = { output, platformData: '模拟响应，仅用于界面与分页集成测试', ok: false };
try {
  application = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 45000 });
  page = await application.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  const domChecks = await application.evaluate(async ({ BrowserWindow, session }) => {
    const reader = globalThis.fengshaTest.creators.browser;
    const fixtureSession = session.fromPartition('fengsha-creator-dom-fixture');
    let html = '';
    fixtureSession.protocol.handle('https', () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    const browser = new BrowserWindow({ show: false, webPreferences: { session: fixtureSession, sandbox: true, nodeIntegration: false, contextIsolation: true } });
    const inspect = async (url, markup, platform, id) => { html = markup; await browser.loadURL(url); reader.window = browser; return reader.read(platform, id, new AbortController().signal); };
    try {
      const douyin = await inspect('https://www.douyin.com/user/creatorA', '<div data-e2e="user-title">模拟抖音作者</div><div data-e2e="user-post-list"><li><a href="/video/111"><span data-e2e="video-desc">发布作品</span></a></li></div><aside><a href="/video/222">推荐作品</a></aside>', '抖音', 'creatorA');
      const author = await inspect('https://www.douyin.com/video/111', '<aside><a href="/user/wrong">同名推荐</a></aside><div data-e2e="video-author"><a href="/user/right">正确作者</a></div>', '抖音', null);
      const xhs = await inspect('https://www.xiaohongshu.com/user/profile/aaaaaaaaaaaaaaaaaaaaaaaa', '<div class="user-page"><div class="user-name">模拟小红书作者</div><div class="tabs"><span class="active">笔记</span></div><div class="feeds-container"><section class="note-item"><a href="/explore/bbbbbbbbbbbbbbbbbbbbbbbb?xsec_token=fixture-only"><span class="play-icon"></span><span class="title">视频作品</span></a><a href="/user/profile/aaaaaaaaaaaaaaaaaaaaaaaa">作者</a></section><section class="note-item"><a href="/explore/cccccccccccccccccccccccc">图文</a></section><section class="note-item"><a href="/explore/dddddddddddddddddddddddd"><span class="play-icon"></span>其他作者</a><a href="/user/profile/eeeeeeeeeeeeeeeeeeeeeeee">其他作者</a></section></div></div>', '小红书', 'aaaaaaaaaaaaaaaaaaaaaaaa');
      const favorites = await inspect('https://www.xiaohongshu.com/user/profile/aaaaaaaaaaaaaaaaaaaaaaaa', '<div class="user-page"><div class="tabs"><span class="active">收藏</span></div><div class="feeds-container"><section class="note-item"><a href="/explore/bbbbbbbbbbbbbbbbbbbbbbbb"><span class="play-icon"></span>收藏作品</a></section></div></div>', '小红书', 'aaaaaaaaaaaaaaaaaaaaaaaa');
      return { douyinCount: douyin.items.length, douyinId: douyin.items[0]?.id, authorUrl: author.profileUrl, xhsCount: xhs.items.length, xhsId: xhs.items[0]?.id, tokenPreserved: xhs.items[0]?.url.includes('xsec_token=fixture-only'), favoritesExcluded: !favorites.scopeFound };
    } finally { reader.window = null; browser.destroy(); fixtureSession.protocol.unhandle('https'); }
  });
  assert.equal(domChecks.douyinCount, 1); assert.equal(domChecks.douyinId, '111'); assert.equal(domChecks.authorUrl, 'https://www.douyin.com/user/right'); assert.equal(domChecks.xhsCount, 1); assert.equal(domChecks.xhsId, 'bbbbbbbbbbbbbbbbbbbbbbbb'); assert.ok(domChecks.tokenPreserved && domChecks.favoritesExcluded); result.browserDomFixtures = true;
  await application.evaluate(() => {
    const t = globalThis.fengshaTest;
    t.queue.metrics = () => ({ freeMemory: 0, cores: 8, cpuBusy: 0 }); // Persist the batch without network downloads.
    t.engine.parse = async source => ({ items: [t.engine.item({ id: new URL(source).searchParams.get('v'), title: '读书分享 ' + new URL(source).searchParams.get('v'), uploader: '模拟博主（非真实平台验收）', channel_id: 'UC0123456789012345678901', channel_url: 'https://www.youtube.com/channel/UC0123456789012345678901' }, source, 'YouTube')] });
    t.creators.flat = async (url, platform, start, count, signal) => {
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 60); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('CANCELLED')); }, { once: true }); });
      return { playlist_count: 501, entries: Array.from({ length: Math.min(count, Math.max(0, 502 - start)) }, (_, n) => { const id = start + n; return { id: `fixture${id}`, title: `读书分享 ${id}`, url: `https://www.youtube.com/watch?v=fixture${id}`, upload_date: id === 1 ? '20240101' : id === 2 ? null : '20260930' }; }) };
    };
  });
  await page.getByLabel('视频链接').fill('https://www.youtube.com/watch?v=creatorfixture'); await page.getByRole('button', { name: '识别博主', exact: true }).click();
  await page.getByRole('heading', { name: '模拟博主（非真实平台验收）', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认博主并读取作品', exact: true }).isEnabled(), true);
  await page.getByLabel('作品读取数量', { exact: true }).selectOption('custom'); await page.getByLabel('自定义作品条数').fill('501');
  await page.getByLabel('作品发布时间', { exact: true }).selectOption('custom'); await page.getByLabel('作品开始日期').fill('2026-09-01'); await page.getByLabel('作品结束日期').fill('2026-09-30');
  await page.getByLabel('作品标题关键词').fill('读书'); await page.getByLabel('日期未知也列入清单（单独标注）').check();
  await page.getByRole('button', { name: '确认博主并读取作品', exact: true }).click();
  await page.getByText('已读取至平台返回的末页', { exact: true }).waitFor({ timeout: 45000 });
  const r = await application.evaluate(() => globalThis.fengshaTest.creators.last()); assert.equal(r.scanned, 501); assert.equal(r.items.length, 500); assert.equal(r.skipped.date, 1); assert.ok(r.items.some(i => !i.publishedAt)); result.filteredPagination = true;
  await page.screenshot({ path: path.join(output, '07-博主作品.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
  assert.equal(await page.locator('.main').evaluate(el => el.scrollWidth > el.clientWidth + 2), false); await page.screenshot({ path: path.join(output, '博主作品-最小窗口.png') }); result.minWindowChecked = true;
  await page.getByRole('button', { name: '全选当前未下载', exact: true }).click(); await page.getByRole('button', { name: '加入下载队列 (500)', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: '确认博主批量下载' }).count(),0);result.noRepeatedBatchConfirmation=true;
  await page.getByRole('heading', { name: '任务中心', exact: true }).waitFor();
  const data = await application.evaluate(() => globalThis.fengshaTest.snapshot()); assert.equal(data.tasks.length, 500); assert.equal(data.scheduler.waiting, 500); assert.equal(data.scheduler.active, 0); result.batch500Persisted = true;
  await page.locator('.sidebar-bottom').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('同时下载上限').selectOption('99'); await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存，新任务将使用新的下载偏好').waitFor(); assert.equal((await application.evaluate(() => globalThis.fengshaTest.snapshot())).settings.concurrency, 99); result.upper99 = true;
  await page.screenshot({ path: path.join(output, '08-99并发设置.png') });
  await page.getByLabel('同时下载上限').selectOption('auto'); await page.getByRole('button', { name: '保存设置', exact: true }).click();
  assert.equal((await application.evaluate(() => globalThis.fengshaTest.snapshot())).settings.concurrency, 'auto'); result.autoConcurrency = true;
  // Check cancellation of a subsequent read through real IPC, retaining the completed checkpoint.
  await page.locator('nav').getByRole('button', { name: '链接下载', exact: true }).click(); await page.getByRole('button', { name: '继续上次博主清单', exact: true }).click();
  await page.getByRole('button', { name: '确认博主并读取作品', exact: true }).click(); await page.getByRole('button', { name: '停止读取', exact: true }).click();
  await page.getByText('已停止，可继续', { exact: true }).waitFor(); result.cancelRead = true;
  await application.close();
  application = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 45000 });
  page = await application.firstWindow(); await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  const preserved = await application.evaluate(() => ({ tasks: globalThis.fengshaTest.queue.tasks().length, creator: globalThis.fengshaTest.creators.last(), concurrency: globalThis.fengshaTest.store.settings().concurrency }));
  assert.equal(preserved.tasks, 500); assert.equal(preserved.concurrency, 'auto'); assert.equal(preserved.creator.status, 'cancelled'); result.restartPreserved = true;
  assert.deepEqual(errors, []); result.rendererErrors = errors; result.ok = true;
} catch (e) { result.error = String(e.stack || e); if (page) { await page.screenshot({ path: path.join(output, '失败诊断.png') }).catch(() => {}); result.visibleError = (await page.locator('main').innerText().catch(() => '')).slice(0, 1600); } process.exitCode = 1; }
finally { await application?.close().catch(() => {}); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
