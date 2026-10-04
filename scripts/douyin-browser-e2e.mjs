import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), root = path.resolve('.');
const output = path.resolve('output', `douyin-browser-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: path.join(output, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
let application; const result = { output, fixture: true, ok: false };
try {
  application = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 45000 });
  await (await application.firstWindow()).getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  result.checks = await application.evaluate(async ({ session }) => {
    const reader = globalThis.fengshaTest.creators.browser;
    const fixture = session.fromPartition('douyin-short-link-fixture');
    const saved = reader.accounts;
    reader.accounts = { getSession: () => fixture };
    const profileHtml = '<div data-e2e="user-title">原视频作者</div><div data-e2e="user-post-list"><li><a href="/video/1234567890123456789"><span data-e2e="video-desc">发布作品一</span></a></li><li><a href="/video/1234567890123456790"><span data-e2e="video-desc">发布作品二</span></a></li><p>没有更多作品</p></div><aside><a href="/video/9876543210123456789">推荐作品</a></aside>';
    const signal = new AbortController().signal;
    fixture.protocol.handle('https', request => {
      const u = new URL(request.url);
      if (u.hostname === 'v.douyin.com') return Response.redirect('https://www.iesdouyin.com/share/user/creatorA/', 302);
      return new Response(profileHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    try {
      const creator = await reader.identify('https://v.douyin.com/fixture/', '抖音', 'fixture', signal);
      const items = await reader.page({ ...creator, accountId: 'fixture' }, 50, signal);
      let blocked = false;
      reader.window.webContents.emit('will-redirect', { preventDefault: () => { blocked = true; } }, 'https://douyin.com.evil.example/user/creatorA');
      const menuHidden = !reader.window.isMenuBarVisible();
      await reader.window.loadURL('https://www.douyin.com/user/wrong');
      let mismatch = false;
      try { await reader.read('抖音', 'creatorA', signal); } catch { mismatch = true; }
      const recovered = await reader.identify('https://v.douyin.com/fixture/', '抖音', 'fixture', signal);
      fixture.protocol.unhandle('https');
      fixture.protocol.handle('https', () => new Response('<aside><a href="/user/wrong">同名推荐作者</a></aside><div data-e2e="user-info"><a href="/user/creatorA"><img src="https://p3.douyinpic.com/avatar.jpg"/></a><a href="/user/creatorA">原视频作者\n认证徽章</a></div>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      const videoAuthor = await reader.identify('https://www.douyin.com/video/1234567890123456789', '抖音', 'fixture', signal);
      reader.close();
      fixture.protocol.unhandle('https');
      fixture.protocol.handle('https', () => { throw new Error('fixture network failure'); });
      let failedWindowClosed = false;
      try { await reader.identify('https://www.douyin.com/user/creatorA', '抖音', 'fixture', signal); } catch { failedWindowClosed = reader.window === null; }
      return { id: creator.id, url: creator.url, name: creator.name, itemCount: items.items.length, complete: items.complete, blocked, menuHidden, mismatch, recovered: recovered.id === 'creatorA', videoAuthor: videoAuthor.id === 'creatorA' && videoAuthor.name === '原视频作者', failedWindowClosed };
    } finally { reader.close(); reader.accounts = saved; fixture.protocol.unhandle('https'); }
  });
  assert.equal(result.checks.id, 'creatorA');
  assert.equal(result.checks.url, 'https://www.douyin.com/user/creatorA');
  assert.equal(result.checks.name, '原视频作者');
  assert.equal(result.checks.itemCount, 2); assert.ok(result.checks.complete);
  assert.ok(result.checks.blocked); assert.ok(result.checks.menuHidden);
  assert.ok(result.checks.mismatch && result.checks.recovered && result.checks.videoAuthor && result.checks.failedWindowClosed);
  result.ok = true;
} catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
finally { await application?.close().catch(() => {}); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
