import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { build } from 'vite';
import { execFileSync } from 'node:child_process';

// Each run builds into its own output and uses its own profile. No proxy changes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', `media-preview-${Date.now()}-${process.pid}`);
const profile = path.join(output, 'profile');
const clip = path.join(output, 'preview-fixture.webm');
fs.mkdirSync(output, { recursive: true });
const result = { output, profile, isolated: true, mockOnly: true, checks: [] };
const errors = [];
let app, page, server, tlsServer;
const checked = name => { result.checks.push(name); console.log(`PASS ${name}`); };
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await app.evaluate(async () => (await globalThis.fengshaTest.win.webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(path.join(output, name), Buffer.from(png, 'base64'));
}
try {
  execFileSync(path.join(root, 'bin', 'ffmpeg', 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libvorbis', clip], { windowsHide: true });
  // File-only test certificate: never install anything in Windows' trust store.
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    $key = [System.Security.Cryptography.RSA]::Create(2048)
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=127.0.0.1', $key, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
    [IO.File]::WriteAllBytes((Join-Path $env:FENGSHA_TEST_CERT_DIR 'fixture.pfx'), $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
    [IO.File]::WriteAllBytes((Join-Path $env:FENGSHA_TEST_CERT_DIR 'fixture.cer'), $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    $cert.Dispose(); $key.Dispose()
  `], { windowsHide: true, env: { ...process.env, FENGSHA_TEST_CERT_DIR: output } });
  const digest = new X509Certificate(fs.readFileSync(path.join(output, 'fixture.cer'))).fingerprint256;
  const fingerprint = `sha256/${Buffer.from(digest.replaceAll(':', ''), 'hex').toString('base64')}`;
  const videoRequests = result.videoRequests = [];
  tlsServer = https.createServer({ pfx: fs.readFileSync(path.join(output, 'fixture.pfx')) }, (request, response) => {
    const bytes = fs.readFileSync(clip), range = request.headers.range;
    videoRequests.push({ url: request.url, range });
    const match = /bytes=(\d+)-(\d*)/.exec(range || '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    response.writeHead(match ? 206 : 200, { 'content-type': 'video/webm', 'content-length': String(end - start + 1), 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    response.end(bytes.subarray(start, end + 1));
  });
  await new Promise(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
  const httpsVideo = `https://127.0.0.1:${tlsServer.address().port}/clip.webm`;
  await build({ root, build: { outDir: path.join(output, 'renderer'), emptyOutDir: false } });
  // Serve Node-read bytes, also on Windows hosts with protected file headers.
  const files = new Map();
  function read(dir, prefix = '') { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), key = `${prefix}/${e.name}`;
    if (e.isDirectory()) read(p, key); else files.set(key, fs.readFileSync(p));
  } }
  read(path.join(output, 'renderer'));
  const originalHtml = files.get('/index.html').toString(),directive=originalHtml.match(/media-src\s+([^;]+)/)?.[1]||'';
  assert.ok(directive.split(/\s+/).includes('https:'),'The actual host CSP must support secure video playback');
  assert.ok(directive.split(/\s+/).includes('fengsha-media:'));
  result.hostCsp={integrationRequired:false,actualDirective:directive};
  server = http.createServer((req, res) => {
    const key = new URL(req.url, 'http://localhost').pathname;
    const data = files.get(key);
    res.writeHead(data ? 200 : 404, { 'content-type': key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_VISIBLE: '1', FENGSHA_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [root], env, timeout: 45000 });
  page = await app.firstWindow();
  result.networkFailures = []; result.certificates = [];
  page.on('requestfailed', request => result.networkFailures.push({ url: request.url(), failure: request.failure() }));
  page.setDefaultTimeout(8000);
  await page.waitForLoadState('load');
  const picture = await app.evaluate(({ nativeImage }) => {
    const bitmap = Buffer.alloc(640 * 360 * 4);
    for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 100; bitmap[i + 1] = 190; bitmap[i + 2] = 65; bitmap[i + 3] = 255; }
    return nativeImage.createFromBitmap(bitmap, { width: 640, height: 360 }).toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(output, 'picture.png'), Buffer.from(picture, 'base64'));
  await page.route('https://media-preview.test/**', async route => {
    const request = route.request();
    if (request.url().includes('broken')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(picture, 'base64') });
  });
  await app.evaluate(async ({ app: desktop, session, ipcMain }, { profile, output, clip, clipSize, fingerprint }) => {
    assertProfile();
    function assertProfile() { if (desktop.getPath('userData') !== profile) throw Error('Wrong test profile'); }
    const t = globalThis.fengshaTest;
    // Trust precisely this temporary loopback certificate in this isolated app.
    t.mediaPreviewCerts = [];
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      t.mediaPreviewCerts.push({ hostname: request.hostname, fingerprint: request.certificate.fingerprint, expected: fingerprint });
      callback(request.hostname === '127.0.0.1' && request.certificate.fingerprint === fingerprint ? 0 : -3);
    });
    t.mediaPreviewFixture = { external: [], forbidden: [] };
    const pngFile = `${output}/picture.png`;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const u = new URL(details.url), allow = ['file:', 'data:', 'blob:', 'fengsha-media:', 'devtools:'].includes(u.protocol) || u.hostname === '127.0.0.1' || u.hostname === 'media-preview.test';
      if (!allow) t.mediaPreviewFixture.external.push(details.url);
      callback({ cancel: !allow });
    });
    globalThis.fetch = async url => { t.mediaPreviewFixture.external.push(String(url)); throw Error('External transport forbidden'); };
    for (const name of ['content-image-edit', 'content-remix', 'content-auto-remix', 'content-publish-open', 'content-publish-fill', 'content-publish-submit', 'content-render-video', 'enqueue', 'action', 'open-file', 'open-source']) {
      ipcMain.removeHandler(`fengsha:${name}`);
      ipcMain.handle(`fengsha:${name}`, () => { t.mediaPreviewFixture.forbidden.push(name); return { ok: false, error: 'Forbidden in media preview fixture' }; });
    }
    ipcMain.removeHandler('fengsha:creator-last');
    ipcMain.handle('fengsha:creator-last', () => ({ ok: true, value: { id: 'preview-creator', source: '', creator: { platform: '抖音', name: '预览测试博主', avatar: 'https://media-preview.test/avatar.png', supported: true }, items: [{key:'remote-cover', title:'只有远程封面的作品',thumbnail:'https://media-preview.test/cover.png',available:true,duration:4}], skipped: {}, status:'identified', scanned: 1 } }));
    const item = { id: 'preview-library', platform: '抖音', title: '本地视频预览测试', author: '隔离测试', filePath: clip, thumbnail: 'https://media-preview.test/library.png', downloadedAt: Date.now(), duration: 8, size: clipSize, tags: [] };
    t.store.put('media', item.id, item);
    t.store.put('media', 'preview-missing', { ...item, id: 'preview-missing', title: '已缺失视频封面', thumbnail: 'https://media-preview.test/missing.png', filePath: `${output}/missing.webm` });
    const assets = [
      { id: 'original-1', origin: 'original', file: pngFile },
      { id: 'original-2', origin: 'original', file: pngFile },
      { id: 'output-1', origin: 'generated', originalAssetId: 'original-1', file: pngFile },
      { id: 'output-2', origin: 'generated', originalAssetId: 'original-2', file: pngFile },
      { id: 'history-1', origin: 'generated', originalAssetId: 'original-1', file: pngFile }
    ];
    const draft = { id: 'preview-draft', status: 'draft', source: { id: 'source-fixture', platform: '小红书', type: 'image', title: '隔离媒体预览稿', images: ['https://media-preview.test/original1.png', 'https://media-preview.test/original2.png'] }, original: { title: '隔离原文', text: '只测试预览，不调用任何模型。' }, title: '隔离媒体预览稿', body: '已有的二创文案保持不变', tags: '#测试', visibility: 'private', revision: 1, createdAt: Date.now(), assets, assetOrder: ['output-1', 'output-2'] };
    t.store.put('content-draft', draft.id, draft);
    t.store.put('meta', 'lastContentDraft', { id: draft.id });
    t.store.flush();
  }, { profile, output, clip, clipSize: fs.statSync(clip).size, fingerprint });
  await app.evaluate((_electron, url) => globalThis.fengshaTest.win.loadURL(url), `http://127.0.0.1:${server.address().port}/index.html`);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '博主批量下载', exact: true }).click();
  const avatar = page.locator('.creator-avatar img');
  await avatar.waitFor();
  await avatar.click();
  await page.getByRole('dialog', { name: '媒体放大预览', exact: true }).waitFor();
  checked('global-avatar-opens-root-preview');
  await capture('avatar-preview.png');
  const preview = page.getByRole('dialog', { name: '媒体放大预览', exact: true });
  await page.waitForFunction(() => document.querySelector('.media-preview-dialog img')?.naturalWidth > 0);
  const width = await preview.locator('img').evaluate(el => el.getBoundingClientRect().width);
  await page.getByRole('button', { name: '放大图片', exact: true }).click();
  assert.ok(await preview.locator('img').evaluate(el => el.getBoundingClientRect().width) > width * 1.2);
  await page.getByRole('button', { name: '缩小图片', exact: true }).click();
  await page.getByRole('button', { name: '重置图片缩放', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '重置图片缩放' }).innerText(), '100%');
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
  assert.equal(await page.locator('#root').evaluate(el => el.inert), true);
  const controls = await preview.locator('button').count();
  for (let i = 0; i < controls + 2; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('.media-preview-dialog')), true); }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.media-preview-dialog')), true);
  await page.keyboard.press('Escape');
  await preview.waitFor({ state: 'hidden' });
  assert.equal(await avatar.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  assert.equal(await page.locator('#root').evaluate(el => el.inert), false);
  checked('zoom-reset-focus-trap-escape-focus-and-scroll-restored');
  await avatar.press('Enter'); await preview.waitFor();
  await page.locator('.media-preview-layer').click({ position: { x: 3, y: 3 } });
  await preview.waitFor({ state: 'hidden' });
  checked('keyboard-open-and-backdrop-close');

  await page.locator('.creator-item .thumb img').click();
  await preview.waitFor();
  assert.match(await preview.innerText(), /仅有封面，尚未取得可播放的视频；下载后可直接放大播放。/);
  assert.equal(await preview.locator('video').count(), 0);
  await capture('remote-cover-only.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('checkbox', { name: '选择 只有远程封面的作品' }).isChecked(), false);
  checked('remote-thumbnail-only-and-label-checkbox-unaffected');

  await page.getByRole('button', { name: '媒体库', exact: true }).click();
  await page.getByLabel('媒体排序').selectOption('name');
  assert.equal(await preview.count(), 0);
  await page.locator('[data-media-id="preview-library"] img').click();
  await preview.waitFor();
  await page.waitForFunction(() => { const v = document.querySelector('.media-preview-dialog video'); return v?.readyState >= 2 && v.currentTime > 0 && !v.paused; });
  assert.equal(await preview.locator('video').getAttribute('src'), 'fengsha-media://preview-library');
  await capture('library-local-video.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.media-preview-layer video').count(), 0);
  await app.evaluate(()=>{const t=globalThis.fengshaTest,item=t.store.get('media','preview-library');item.thumbnail='';t.store.put('media',item.id,item);t.store.flush();t.win.webContents.send('fengsha:changed',t.snapshot());});
  await page.waitForFunction(()=>!document.querySelector('[data-media-id="preview-library"] .thumb img'));
  await page.locator('[data-media-id="preview-library"] [data-media-preview-trigger]').click();await preview.waitFor();
  assert.equal(await preview.locator('video').getAttribute('src'),'fengsha-media://preview-library');await page.keyboard.press('Escape');
  checked('downloaded-video-without-thumbnail-still-enlarges');
  await page.locator('[data-media-id="preview-missing"] img').click();
  await preview.waitFor(); assert.match(await preview.innerText(), /尚未取得可播放的视频/); assert.equal(await preview.locator('video').count(), 0);
  await page.keyboard.press('Escape');
  checked('library-source-playback-missing-file-fallback-and-sort-counterexample');

  await page.getByRole('button', { name: '作品搜索与二创', exact: true }).click();
  await page.getByRole('button', { name: '打开当前二创稿', exact: true }).click();
  const body = await page.getByLabel('克隆稿正文', { exact: true }).inputValue();
  for (const selector of ['.compare-original-image img', '.compare-output-image > img']) {
    await page.locator(selector).first().click(); await preview.waitFor();
    assert.equal(await preview.locator('video').count(), 0);
    assert.match(await preview.locator('img').getAttribute('src'), /^fengsha-media:\/\/draft-preview-draft\//);
    await capture(selector.includes('output') ? 'studio-output.png' : 'studio-original.png');
    await page.keyboard.press('Escape');
  }
  await page.getByLabel('画面1下移', { exact: true }).click();
  assert.equal(await preview.count(), 0);
  assert.equal(await page.locator('.compare-image-pair').first().getAttribute('data-output-id'), 'output-2');
  const row = page.locator('.compare-image-pair[data-reference-id="original-1"]');
  await row.locator('.compare-versions summary').click();
  const history = row.locator('.compare-version').filter({ has: page.locator('img[src$="/history-1"]') });
  await history.locator('img').click(); await preview.waitFor(); await page.keyboard.press('Escape');
  assert.equal(await row.getAttribute('data-output-id'), 'output-1');
  await history.locator('button').click();
  await page.waitForFunction(() => document.querySelector('[data-reference-id="original-1"]')?.dataset.outputId === 'history-1');
  assert.equal(await preview.count(), 0);
  assert.equal(await page.getByLabel('克隆稿正文', { exact: true }).inputValue(), body);
  checked('studio-original-output-history-image-vs-restore-text-and-reorder-safe');

  // Late-mounted DOM exercises the same root delegation as any future page.
  await page.evaluate(httpsVideo => {
    const fixture = document.createElement('section'); fixture.id = 'media-preview-ui-fixture';
    fixture.style.cssText = 'background:white;padding:20px;position:relative;z-index:2';
    fixture.innerHTML = '<div data-media-group="test-gallery"><img id="gallery-1" src="https://media-preview.test/gallery1.png" alt="分组第一张" width="160"><img id="gallery-2" src="https://media-preview.test/gallery2.png" alt="分组第二张" width="160"></div><img id="broken-preview" src="https://media-preview.test/broken.png" alt="加载失败图片" width="160" height="90"><video id="native-controls-video" controls preload="metadata" src="fengsha-media://preview-library" style="width:480px"></video><video id="plain-video" preload="metadata" src="https://media-preview.test/clip.webm" style="width:240px"></video><img id="explicit-video" data-media-type="video" data-video-src="https://media-preview.test/clip.webm" src="https://media-preview.test/video-cover.png" width="160"><video id="source-element-video" preload="metadata" style="width:240px"><source src="https://media-preview.test/clip.webm" type="video/webm"></video>';
    fixture.innerHTML = fixture.innerHTML.replaceAll('https://media-preview.test/clip.webm', httpsVideo);
    document.querySelector('.main').append(fixture);
  }, httpsVideo);
  await page.locator('#gallery-1').click(); await preview.waitFor();
  await page.getByRole('button', { name: '下一张媒体' }).click();
  assert.match(await preview.locator('img').getAttribute('src'), /gallery2/);
  await page.keyboard.press('ArrowLeft'); assert.match(await preview.locator('img').getAttribute('src'), /gallery1/);
  await page.keyboard.press('Escape');
  await page.locator('#broken-preview').click(); await preview.waitFor();
  await preview.getByRole('alert').waitFor(); assert.match(await preview.getByRole('alert').innerText(), /图片加载失败/);
  await capture('visible-load-error.png');
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await preview.getByRole('alert').waitFor(); await page.keyboard.press('Escape');
  checked('optional-group-navigation-and-visible-load-error-with-retry');

  const native = page.locator('#native-controls-video');
  await native.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#native-controls-video')?.readyState >= 2);
  // Real pointer on Chromium's bottom-left play control; delegated handler must leave it alone.
  const rect = await native.boundingBox();
  await page.mouse.click(rect.x + 24, rect.y + rect.height - 48);
  await page.waitForFunction(() => !document.querySelector('#native-controls-video').paused);
  assert.equal(await preview.count(), 0);
  await native.evaluate(el => { el.pause(); el.currentTime = 0; el.volume = .3; el.muted = false; });
  await page.waitForFunction(() => document.querySelector('#native-controls-video').currentTime < .1);
  const enlarge = page.locator('#native-controls-video + .media-preview-open-video');
  await enlarge.click(); await preview.waitFor();
  await page.waitForFunction(() => { const v = document.querySelector('.media-preview-dialog video'); return v?.readyState >= 2 && !v.paused; });
  assert.equal(await native.evaluate(el => el.paused), true);
  assert.equal(await preview.locator('video').evaluate(el => el.volume), .3);
  await capture('native-video-enlarged.png');
  await page.keyboard.press('Escape');
  assert.equal(await native.evaluate(el => el.paused), true);
  assert.ok(await native.evaluate(el => el.currentTime) < .1);
  assert.equal(await enlarge.evaluate(el => el === document.activeElement), true);
  await native.evaluate(el => el.play());
  await enlarge.click(); await preview.waitFor(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#native-controls-video').paused);
  await native.evaluate(el => el.pause());
  checked('native-bottom-controls-usable-volume-time-and-prior-play-state-restored');

  for (const selector of ['#plain-video', '#explicit-video', '#source-element-video']) {
    await page.locator(selector).click(); await preview.waitFor();
    await page.waitForFunction(() => { const v = document.querySelector('.media-preview-dialog video'); return v?.readyState >= 2 && !v.paused; });
    assert.equal(await preview.locator('video').getAttribute('src'), httpsVideo);
    await page.keyboard.press('Escape');
  }
  checked('plain-video-explicit-cover-source-and-native-source-child-preview');
  assert.deepEqual(errors, []);
  const transport = await app.evaluate(() => globalThis.fengshaTest.mediaPreviewFixture);
  assert.deepEqual(transport.external, []); assert.deepEqual(transport.forbidden, []);
  assert.equal(await page.locator('.media-preview-layer').count(), 0);
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  checked('no-paid-ai-no-publish-no-delete-no-real-network-and-clean-close');
  result.ok = true;
} catch (error) {
  result.ok = false; result.failure = error.stack; process.exitCode = 1;
  if (page) result.videoDiagnostic = await page.locator('video').evaluateAll(videos => videos.map(v => ({ id: v.id, src: v.currentSrc || v.src, readyState: v.readyState, paused: v.paused, time: v.currentTime, seeking: v.seeking, error: v.error && { code: v.error.code, message: v.error.message } }))).catch(() => []);
}
finally {
  if (app) {
    try { if (page) await capture('final.png'); result.transport = await app.evaluate(() => globalThis.fengshaTest.mediaPreviewFixture); result.certificates = await app.evaluate(() => globalThis.fengshaTest.mediaPreviewCerts); } catch (error) { result.captureError = String(error); }
    await app.close();
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (tlsServer) { tlsServer.closeAllConnections(); await new Promise(resolve => tlsServer.close(resolve)); }
  result.rendererErrors = errors;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
