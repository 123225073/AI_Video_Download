import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = path.resolve('.'), require = createRequire(import.meta.url);
const output = path.join(root, 'output', `cli-e2e-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const directory = path.join(output, 'profile'), fixture = path.join(output, 'CLI中文测试视频.mp4');
const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
execFileSync(path.join(root, 'bin/ffmpeg/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '3', '-c:v', 'mpeg4', fixture], { windowsHide: true });
const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(fixture).size }); fs.createReadStream(fixture).pipe(res); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/video.mp4`, result = { output, ok: false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app;
function cli(args, expected = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'cli/fengsha.mjs'), ...args], { env, cwd: output, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', reject); child.on('close', code => { try { assert.equal(code, expected, `${stdout}\n${stderr}`); const reply = JSON.parse(stdout); resolve(reply); } catch (e) { reject(e); } });
  });
}
try {
  assert.equal((await cli(['version'])).data.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  assert.equal((await cli(['help'])).ok, true); assert.equal((await cli(['download'], 2)).error.code, 'INVALID_ARGUMENT');
  const status = await cli(['service']); assert.equal(status.data.background, true); result.coldStart = true;
  const inspection = await cli(['inspect', url]); assert.equal(inspection.data.items.length, 1); assert.equal(inspection.data.items[0].platform, '测试媒体');
  const manifest = path.join(output, '清单.json'); fs.writeFileSync(manifest, JSON.stringify(inspection));
  const downloaded = await cli(['download', '--list', manifest, '--output', path.join(output, '中文 视频目录'), '--archive', 'flat', '--timeout', '60']);
  assert.equal(downloaded.data.files.length, 1); assert.ok(fs.existsSync(downloaded.data.files[0].filePath)); result.realEngineDownload = true;
  const file = downloaded.data.files[0].filePath;
  execFileSync(path.join(root, 'bin/ffmpeg/ffmpeg.exe'), ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { windowsHide: true }); result.fullDecode = true;
  const probe = await cli(['probe', '--file', file]); assert.ok(probe.data.duration > 0); assert.ok(probe.data.size > 0); result.probe = true;
  assert.equal((await cli(['media'])).data.media.length, 1); assert.equal((await cli(['tasks'])).data.tasks[0].status, 'completed');
  const duplicate = await cli(['download', url]); assert.equal(duplicate.data.skipped.length, 1); assert.equal(duplicate.data.existing[0].filePath, file); result.duplicate = true;
  const batchManifest = path.join(output, '批量.json'); fs.writeFileSync(batchManifest, JSON.stringify([inspection.data.items[0], inspection.data.items[0]]));
  assert.equal((await cli(['download', '--list', batchManifest], 2)).error.code, 'SELECTION_REQUIRED');
  const invalid = await cli(['inspect', 'https://example.com/video'], 1); assert.equal(invalid.ok, false); result.invalidSource = true;
  await cli(['service', 'stop']); await pause(1500);
  app = await electron.launch({ executablePath: require('electron'), args: [root], env: { ...env, FENGSHA_TEST_VISIBLE: '1' }, timeout: 45000 });
  const page = await app.firstWindow(); await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  const desktop = await app.evaluate(() => globalThis.fengshaTest.snapshot()); assert.equal(desktop.media.length, 1); assert.equal(desktop.tasks[0].status, 'completed'); result.sharedDesktopData = true;
  await app.evaluate(() => {
    const t = globalThis.fengshaTest;
    t.store.put('creator', 'cli-fixture-author', { id: 'cli-fixture-author', creator: { id: 'fixture-author', name: '隔离测试作者', platform: 'YouTube', adapter: 'yt-dlp', listUrl: 'https://www.youtube.com/@fixture', supported: true }, items: [], scanned: 0, cursor: 1, seen: [], status: 'identified', complete: false, filters: { limit: 50, period: 'all', excludeDownloaded: false } });
    t.store.put('meta', 'lastCreator', { id: 'cli-fixture-author' });
    t.creators.flat = async (_url, _platform, start, count) => ({ playlist_count: 55, entries: Array.from({ length: Math.min(count, 56 - start) }, (_, i) => ({ id: `fixture${start + i}`, title: `隔离作品 ${start + i}`, webpage_url: `https://www.youtube.com/watch?v=fixture${start + i}` })) });
  });
  const author = await cli(['creator', '--record', 'cli-fixture-author', '--continue']); assert.equal(author.data.items.length, 55); assert.equal(author.data.complete, true); result.creatorPagination = true;
  await page.locator('nav').getByRole('button', { name: '博主批量下载', exact: true }).click();
  await page.getByRole('heading', { name: '博主批量下载', exact: true }).waitFor();
  await page.getByText('隔离测试作者', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, 'creator.png') });
  const service1 = await cli(['service']); const service2 = await cli(['service']); assert.equal(service1.data.pid, service2.data.pid); result.reusedProcess = true;
  const desktopAfter = await app.evaluate(() => globalThis.fengshaTest.snapshot()); assert.equal(desktopAfter.media.length, 1);
  const waiting = await cli(['download', url, '--force', '--no-wait', '--output', path.join(output, '异步下载')]); assert.equal(waiting.data.added.length, 1); result.noWait = true;
  const taskId = waiting.data.added[0];
  await cli(['task', '--id', taskId, '--action', 'pause']); assert.equal((await cli(['tasks', '--id', taskId])).data.tasks[0].status, 'paused');
  await cli(['task', '--id', taskId, '--action', 'resume']);
  for (let i = 0; i < 100; i++) { const tasks = (await cli(['tasks', '--id', taskId])).data.tasks; if (tasks[0].status === 'completed') break; await pause(300); }
  assert.equal((await cli(['tasks', '--id', taskId])).data.tasks[0].status, 'completed'); result.taskResume = true;
  const dataText = JSON.stringify([inspection, downloaded, author, await cli(['accounts']), await cli(['tasks'])]); assert.ok(!dataText.includes('"token"') && !dataText.includes('"cookie"') && !dataText.includes('"logs"')); result.cleanJSON = true;
  fs.writeFileSync(path.join(output, 'inspect-example.json'), JSON.stringify(inspection, null, 2));
  fs.writeFileSync(path.join(output, 'download-example.json'), JSON.stringify(downloaded, null, 2));
  result.ok = true;
} catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
finally { if (app) await app.close(); else await cli(['service', 'stop']).catch(() => {}); server.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
