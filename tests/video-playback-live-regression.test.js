import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { byteRange, localMediaResponse, transcriptVideoFile } from '../electron/transcript-media.js';
import { videoPlaybackError } from '../src/media-preview.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
test('local transport returns exact byte ranges, HEAD and a readable missing-file response', async () => {
  const out = fs.mkdtempSync(path.join(root, 'output', 'video-range-'));
  const file = path.join(out, 'clip.mp4'), bytes = Buffer.from('0123456789'); fs.writeFileSync(file, bytes);
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  for (const range of ['bytes=-0', 'bytes=10-', 'bytes=2-1', 'bytes=0-2,4-6']) assert.equal(byteRange(range, 10), false);
  const r = await localMediaResponse(new Request('fengsha-media://test', { headers: { Range: 'bytes=2-5' } }), file);
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(2, 6));
  const head = await localMediaResponse(new Request('fengsha-media://test', { method: 'HEAD' }), file);
  assert.equal(head.headers.get('content-length'), '10'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const missing = await localMediaResponse(new Request('fengsha-media://test'), file + '.missing');
  assert.equal(missing.status, 404); assert.match(await missing.text(), /文件不可用/);
  const transcript = { sourceFile: path.join(out, 'source.vtt'), source: { file } };
  const store = { get: kind => kind === 'transcription' ? transcript : null, list: () => [] };
  fs.writeFileSync(transcript.sourceFile, 'WEBVTT');
  assert.equal(transcriptVideoFile(store, 'id'), file);
  assert.match(videoPlaybackError({ code: 3 }, { local: true, status: 206 }), /无法解码/);
  assert.match(videoPlaybackError({ code: 4 }, { local: true, status: 206 }), /文件可读取/);
  assert.match(videoPlaybackError({ code: 4 }, { local: true, status: 404 }), /文件不可用/);
});
// Actual Electron/Chromium decode, actual app protocol and isolated persisted store.
// No real platforms, model services, downloads, installed app or production profile.
test('saved/corrected/remixed original MP4 stays playable, seekable and retryable in Electron', { timeout: 120000 }, async () => {
  const out = path.join(root, 'output', `video-playback-live-${Date.now()}-${process.pid}`);
  const profile = path.join(out, 'profile'), clip = path.join(out, '原视频 # fixture.mp4');
  fs.mkdirSync(out, { recursive: true });
  execFileSync(path.join(root, 'bin/ffmpeg/ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', clip], { windowsHide: true });
  const bytes = fs.readFileSync(clip), component = path.join(root, 'src/VideoPlayer.jsx');
  const hasPlayer = fs.existsSync(component);
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';
    ${hasPlayer ? `import VideoPlayer from ${JSON.stringify(component.replaceAll('\\', '/'))};` : `const VideoPlayer=p=><video {...p} controls preload="metadata"/>;`}
    import MediaPreview from ${JSON.stringify(path.join(root, 'src/MediaPreview.jsx').replaceAll('\\', '/'))};
    const root=createRoot(document.getElementById('root'));let tab='original';
    window.renderVideo=(src,revision=1)=>root.render(<><VideoPlayer src={src} label="原视频播放" title="原视频"/><button onClick={()=>{tab=tab==='original'?'rewrite':'original';window.renderVideo(src,revision+1);}}>切换编辑标签</button><p>{tab} revision {revision}</p><MediaPreview/></>);
    window.renderVideo('fengsha-media://transcript-live/video');`;
  const bundled = await build({ stdin: { contents: entry, loader: 'jsx', resolveDir: root }, bundle: true, write: false, outdir: out, platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' } });
  const files = new Map(bundled.outputFiles.map(f => ['/' + path.basename(f.path), f.contents]));
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(files.get(req.url) || '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"><div id="root"></div><script src="/stdin.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page;
  const result = { out, profile, actualMP4: { size: bytes.length, codec: 'H264/AAC', duration: 10 }, checks: [], protocol: [], rendererErrors: [] };
  const realRows = process.env.FENGSHA_PLAYBACK_REAL_FIXTURES === '1'
    ? JSON.parse(fs.readFileSync(path.join(root, 'output/repair-072/real-state.json'), 'utf8')).filter(r => r.sourceFile) : [];
  async function poll(fn) { for (let i = 0; i < 140; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); } throw Error('Condition timed out'); }
  const checked = name => result.checks.push(name);
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 30000 });
    app.process().stderr.on('data', data => fs.appendFileSync(path.join(out, 'electron.log'), data));
    await poll(() => app.evaluate(() => !!globalThis.fengshaTest?.ready));
    await app.evaluate(({ app }, profile) => { if (app.getPath('userData') !== profile) throw Error('Not isolated'); }, profile);
    await app.evaluate(({ session }, { origin, clip }) => {
      const t = globalThis.fengshaTest;
      t.playbackFixture = { external: [], downloads: 0, models: 0 };
      session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
        const allowed = [origin, 'fengsha-media:', 'file:', 'devtools:'].some(prefix => d.url.startsWith(prefix));
        if (!allowed) t.playbackFixture.external.push(d.url);
        cb({ cancel: !allowed });
      });
      t.engine.parse = async () => { throw Error('External parse forbidden'); };
      t.engine.download = async () => { t.playbackFixture.downloads++; throw Error('Downloads forbidden'); };
      const config = t.ai.config.bind(t.ai);
      t.ai.config = kind => ({ ...config(kind), hasKey: true, model: 'local-fixture' });
      t.ai.chat = async (system, input) => { t.playbackFixture.models++; const p = JSON.parse(input); return system.includes('校对员') ? p.textToCorrect : JSON.stringify({ title: '本地二创', body: p.sourceText || '原视频口播保持不变。', tags: [] }); };
      t.store.put('transcription', 'live', { id: 'live', title: '本地真实原视频', source: { kind: 'file', file: clip, ext: 'mp4' }, sourceFile: clip, status: 'ready', transcript: '原视频口播保持不变。', transcriptPartial: false, segments: [], mode: {}, speech: {}, progress: 100, createdAt: Date.now() });
      t.store.put('content-draft', 'live-draft', { id: 'live-draft', transcriptionId: 'live', originalVideoFile: clip, source: { type: 'video', platform: '本地视频', title: '本地真实原视频', url: '' }, original: { title: '本地真实原视频', text: '原视频口播保持不变。', images: [] }, title: '本地真实原视频', body: '原视频口播保持不变。', tags: '', assets: [], assetOrder: [], revision: 1, status: 'draft', createdAt: Date.now() });
      t.store.put('video-workflow', 'live-flow', { id: 'live-flow', draftId: 'live-draft', transcriptionId: 'live', autoCorrect: false, createdAt: Date.now() });
      t.store.flush();
      t.playbackTraffic = [];
      session.defaultSession.webRequest.onCompleted(details => {
        if (details.url.startsWith('fengsha-media:')) t.playbackTraffic.push({ url: details.url, status: details.statusCode, headers: details.responseHeaders });
      });
    }, { origin, clip });
    const raw = await app.evaluate(async ({ net }) => { const r = await net.fetch('fengsha-media://transcript-live/video'); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()).toString('base64') }; });
    assert.deepEqual(Buffer.from(raw.bytes, 'base64'), bytes, 'Electron protocol preserves original MP4 bytes');
    page = await app.firstWindow();
    page.setDefaultTimeout(9000);
    page.on('pageerror', e => result.rendererErrors.push(e.message));
    await page.goto(origin);
    result.realFiles = [];
    async function checkRealFiles() {
    for (const [index, row] of realRows.entries()) {
      const before = fs.statSync(row.sourceFile);
      const codecs = JSON.parse(execFileSync(path.join(root, 'bin/ffmpeg/ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt,width,height:format=duration,format_name,size', '-of', 'json', row.sourceFile], { windowsHide: true, encoding: 'utf8' }));
      await app.evaluate((_, { index, row }) => {
        const t = globalThis.fengshaTest;
        t.store.put('transcription', 'real-' + index, { id: 'real-' + index, sourceFile: row.sourceFile, source: { kind: 'file', file: row.sourceFile } });
      }, { index, row });
      const playback = await page.evaluate(async index => {
        const v = document.createElement('video'); v.setAttribute('data-media-preview', 'off'); v.muted = true; v.preload = 'auto';
        v.src = 'fengsha-media://transcript-real-' + index + '/video'; document.body.append(v);
        const events = []; for (const name of ['loadedmetadata', 'loadeddata', 'playing', 'error', 'seeked']) v.addEventListener(name, () => events.push(name));
        let timer;
        try { await Promise.race([v.play(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Playback timeout')), 9000); })]); }
        catch (e) { events.push(e.message); }
        clearTimeout(timer);
        await new Promise(r => setTimeout(r, 150));
        const state = { src: v.currentSrc, events, metadata: v.readyState >= 1, playing: !v.paused && v.currentTime > 0, width: v.videoWidth, height: v.videoHeight, duration: v.duration, error: v.error && { code: v.error.code, message: v.error.message } };
        v.pause(); v.removeAttribute('src'); v.load(); v.remove(); return state;
      }, index);
      const after = fs.statSync(row.sourceFile);
      assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
      result.realFiles.push({ workflowId: row.id, sourceFile: row.sourceFile, codecs, playback, unchanged: true });
      assert.equal(playback.metadata, true, 'Real file metadata');
      assert.equal(playback.playing, true, 'Real file playing');
      assert.equal(playback.error, null);
    }
    }
    const player = () => page.getByLabel('原视频播放', { exact: true });
    async function playing(label) {
      await player().evaluate(v => { v.muted = true; return v.play(); });
      await page.waitForFunction(() => { const v = document.querySelector('video[aria-label="原视频播放"]'); return v?.readyState >= 2 && v.videoWidth === 320 && !v.paused && v.currentTime > 0; });
      const state = await player().evaluate(v => ({ src: v.currentSrc, width: v.videoWidth, height: v.videoHeight, duration: v.duration, currentTime: v.currentTime, readyState: v.readyState, paused: v.paused, error: v.error?.message || null }));
      result.checks.push({ label, ...state });
    }
    await playing('initial metadata and playing');
    await player().evaluate(v => { window.originalPlayer = v; v.pause(); v.currentTime = 6; });
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !v.seeking && Math.abs(v.currentTime - 6) < .1 && v.readyState >= 2; });
    checked('seek to 6 seconds');
    await page.getByText('切换编辑标签', { exact: true }).click();
    assert.equal(await player().evaluate(v => v === window.originalPlayer && Math.abs(v.currentTime - 6) < .1), true);
    checked('tab and revision rerender preserve same video element and playhead');
    for (const action of ['correct', 'rewrite', 'save']) {
      const before = await app.evaluate(() => globalThis.fengshaTest.videoWorkflow.get('live-flow'));
      const options = action === 'save' ? { body: '用户保存的二创文案。', revision: before.draft.revision, workflowId: 'live-flow', draftId: 'live-draft', transcriptionId: 'live' } : { reference: 'corrected' };
      await app.evaluate(async (_, { action, options }) => globalThis.fengshaTest.videoWorkflow.action('live-flow', action, options), { action, options });
      await poll(() => app.evaluate(() => !globalThis.fengshaTest.videoWorkflow.get('live-flow').busy));
      if (action === 'correct') await app.evaluate(() => globalThis.fengshaTest.videoWorkflow.tick());
      const after = await app.evaluate(() => globalThis.fengshaTest.videoWorkflow.get('live-flow'));
      assert.equal(after.preview, before.preview);
      await page.evaluate(({ src, revision }) => window.renderVideo(src, revision), { src: after.preview, revision: after.draft.revision });
      assert.equal(await player().evaluate(v => v === window.originalPlayer), true);
      await playing(`after real ${action} workflow`);
    }
    // The old handler silently dropped Range and returned the whole file (200).
    for (const range of ['bytes=100-199', 'bytes=100-', 'bytes=65536-', 'bytes=-64', `bytes=${bytes.length}-`, 'bytes=5-2']) {
      const response = await app.evaluate(async ({ net }, range) => { const r = await net.fetch('fengsha-media://transcript-live/video', { headers: { Range: range } }); return { status: r.status, headers: Object.fromEntries(r.headers), bytes: Buffer.from(await r.arrayBuffer()).toString('base64') }; }, range);
      result.protocol.push({ range, status: response.status, headers: response.headers, length: Buffer.from(response.bytes, 'base64').length });
      const invalid = range === `bytes=${bytes.length}-` || range === 'bytes=5-2';
      assert.equal(response.status, invalid ? 416 : 206, `Range ${range}`);
      if (!invalid) {
        const selected = byteRange(range, bytes.length), expected = bytes.subarray(selected.start, selected.end + 1);
        assert.deepEqual(Buffer.from(response.bytes, 'base64'), expected);
      }
    }
    checked('closed/open/suffix ranges and invalid 416 return exact bytes');
    // sourceFile can hold an audio/subtitle, while originalVideoFile still points to MP4.
    await app.evaluate((_, out) => { const t = globalThis.fengshaTest, r = t.store.get('transcription', 'live'); r.sourceFile = out + '/source.vtt'; r.source = { kind: 'url', url: 'https://invalid.local/blocked' }; t.store.put('transcription', r.id, r); t.store.flush(); }, out);
    const fallback = await app.evaluate(async ({ net }) => { const r = await net.fetch('fengsha-media://transcript-live/video'); return { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()).toString('base64') }; });
    assert.equal(fallback.status, 200); assert.match(fallback.type, /^video\/mp4/); assert.deepEqual(Buffer.from(fallback.bytes, 'base64'), bytes);
    await player().evaluate(v => v.load()); await playing('subtitle sourceFile with saved original video fallback');
    checked('video endpoint resolves saved draft original and excludes subtitle/audio');
    assert.ok(hasPlayer, 'VideoPlayer must be available for integration');
    // A missing-file task opens without cached media; retry uses its SAME URL/node.
    await app.evaluate((_, clip) => { const t = globalThis.fengshaTest; t.store.put('transcription', 'missing', { id: 'missing', sourceFile: clip + '.missing', source: { file: clip + '.missing' } }); }, clip);
    await page.evaluate(() => window.renderVideo('fengsha-media://transcript-missing/video'));
    await page.getByRole('alert').filter({ hasText: '文件' }).waitFor();
    const srcBefore = await player().getAttribute('src');
    await player().evaluate(v => { window.retryPlayer = v; window.retryEvents = []; for (const name of ['abort', 'emptied', 'loadstart', 'error', 'loadedmetadata', 'loadeddata']) v.addEventListener(name, () => window.retryEvents.push({ name, src: v.src, error: v.error?.code, state: v.readyState })); });
    await app.evaluate((_, clip) => { const t = globalThis.fengshaTest, r = t.store.get('transcription', 'missing'); r.sourceFile = clip; r.source.file = clip; t.store.put('transcription', r.id, r); }, clip);
    result.restoredSource = await app.evaluate(async ({ net }) => { const r = await net.fetch('fengsha-media://transcript-missing/video', { headers: { Range: 'bytes=0-0' } }); await r.arrayBuffer(); return { status: r.status, record: globalThis.fengshaTest.store.get('transcription', 'missing') }; });
    assert.equal(result.restoredSource.status, 206);
    await page.getByRole('button', { name: '重试加载', exact: true }).click();
    await page.waitForFunction(() => { const v = document.querySelector('video[aria-label="原视频播放"]'); return v?.readyState >= 1 && !v.error; });
    await playing('missing file restored and same-source retry');
    const retrySrc = new URL(await player().getAttribute('src'));
    assert.equal(retrySrc.searchParams.get('__fengsha_retry'), '1'); retrySrc.search = '';
    assert.equal(retrySrc.href, srcBefore);
    assert.equal(await player().evaluate(v => v === window.retryPlayer), true);
    checked('missing file visible alert; explicit retry refreshes only local failed-resource cache without remount/download');
    await page.getByRole('button', { name: '放大视频', exact: true }).click();
    await page.getByRole('dialog', { name: '媒体放大预览' }).locator('video').evaluate(v => { v.muted = true; return v.play(); });
    await page.waitForFunction(() => { const v = document.querySelector('.media-preview-dialog video'); return v?.videoWidth === 320 && !v.paused && v.readyState >= 2; });
    await page.getByRole('button', { name: '关闭媒体预览' }).click();
    await playing('after enlarged preview close');
    checked('global media preview open/close remains compatible');
    await player().evaluate(v => v.pause());
    await checkRealFiles();
    result.boundaries = await app.evaluate(() => globalThis.fengshaTest.playbackFixture);
    assert.equal(result.boundaries.downloads, 0); assert.deepEqual(result.boundaries.external, []); assert.deepEqual(result.rendererErrors, []);
    assert.deepEqual(fs.readFileSync(clip), bytes);
    checked('original MP4 unchanged; no external access or downloads; only local model fixtures');
    result.ok = true;
  } catch (e) {
    result.ok = false; result.error = e.stack;
    if (page) result.videoDiagnostic = await page.locator('video').evaluateAll(vs => vs.map(v => ({ src: v.currentSrc, readyState: v.readyState, time: v.currentTime, error: v.error?.message }))).catch(() => []);
    throw e;
  } finally {
    if (page) result.retryEvents = await page.evaluate(() => window.retryEvents).catch(() => []);
    if (app) result.traffic = await app.evaluate(() => globalThis.fengshaTest?.playbackTraffic).catch(() => []);
    if (page) await page.screenshot({ path: path.join(out, 'final.png') }).catch(() => {});
    await app?.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log('Playback evidence:', path.join(out, 'result.json'));
  }
});
