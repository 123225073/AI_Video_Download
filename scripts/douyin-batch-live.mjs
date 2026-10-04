import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { command } from '../electron/engine.js';
const require = createRequire(import.meta.url), root = path.resolve('.');
const output = path.resolve('output', `douyin-batch-live-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const installed = process.argv.includes('--installed');
const executablePath = installed ? path.resolve(process.argv[process.argv.indexOf('--installed') + 1]) : require('electron');
const source = process.env.FENGSHA_DOUYIN_SOURCE || 'https://www.douyin.com/video/6961737553342991651';
const env = { ...process.env, ...(installed ? {} : { FENGSHA_TEST_MODE: '1', FENGSHA_TEST_VISIBLE: '1', FENGSHA_TEST_DATA: path.join(output, 'profile') }) }; delete env.ELECTRON_RUN_AS_NODE;
let application, page; const result = { output, realPlatform: true, installed, ok: false }, errors = [];
async function snapshot() { const r = await page.evaluate(() => window.fengsha.snapshot()); assert.ok(r.ok); return r.value; }
async function wait(predicate, timeout = 180000) { const until = Date.now() + timeout; while (Date.now() < until) { const s = await snapshot(); if (await predicate(s)) return s; await new Promise(resolve => setTimeout(resolve, 500)); } throw new Error('抖音真实验收等待超时'); }
try {
  application = await electron.launch({ executablePath, args: installed ? [] : [root], env, timeout: 45000 });
  page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  result.version = (await snapshot()).version;
  if (!installed) await application.evaluate((_, directory) => { const t = globalThis.fengshaTest; t.store.put('settings', 'main', { ...t.store.settings(), savePath: directory, concurrency: 2 }); t.store.flush(); }, path.join(output, 'download'));
  await page.locator('nav').getByRole('button', { name: '博主批量下载', exact: true }).click();
  await page.getByLabel('博主链接').fill(`今天分享的视频 ${source} 复制文案打开抖音`);
  assert.equal(await page.locator('main').getByRole('button', { name: '视频号连接', exact: true }).count(), 0);
  await page.getByRole('button', { name: /^识别(新)?博主$/ }).click();
  await page.waitForTimeout(500); await wait(s => !s.creatorProgress);
  let record = (await page.evaluate(() => window.fengsha.creatorLast())).value;
  assert.equal(record?.source, source, await page.locator('main').innerText());
  assert.equal(record?.creator.name, '杨超越', await page.locator('main').innerText());
  assert.equal(record.creator.id, 'MS4wLjABAAAAEKnfa654JAJ_N5lgZDQluwsxmY0lhfmEYNQBBkwGG98');
  result.author = { name: record.creator.name, id: record.creator.id, avatar: Boolean(record.creator.avatar) };
  await page.getByLabel('作品读取数量').selectOption('custom'); await page.getByLabel('自定义作品条数').fill('10');
  await page.getByRole('button', { name: '确认博主并读取作品', exact: true }).click();
  await page.waitForTimeout(500); await wait(s => !s.creatorProgress);
  record = (await page.evaluate(() => window.fengsha.creatorLast())).value;
  assert.ok(record.items.length >= 2, record.message);
  assert.ok(record.items.every(item => item.creatorId === record.creator.id));
  result.read = { count: record.items.length, withCover: record.items.filter(i => i.thumbnail).length, withDate: record.items.filter(i => i.publishedAt).length, complete: record.complete };
  await page.screenshot({ path: path.join(output, '真实抖音博主作品.png') });
  if (process.argv.includes('--read-only')) {
    assert.deepEqual(errors, []); result.rendererErrors = errors; result.ok = true;
  } else {
  const media = (await snapshot()).media;
  const chosen = record.items.filter(i => i.available && !media.some(m => m.id === i.key && m.exists)).slice(0, 2);
  assert.equal(chosen.length, 2);
  for (const item of chosen) await page.getByLabel(`选择 ${item.title}`, { exact: true }).check();
  await page.getByRole('button', { name: '加入下载队列 (2)', exact: true }).click();
  const finished = await wait(s => {
    for (const item of chosen) { const task = s.tasks.find(t => t.item.key === item.key); if (task?.status === 'failed') throw new Error(JSON.stringify(task.error)); }
    return chosen.every(i => s.media.some(m => m.id === i.key && m.exists));
  }, 240000);
  const binary = installed ? path.join(path.dirname(executablePath), 'resources/bin/ffmpeg/ffmpeg.exe') : path.join(root, 'bin/ffmpeg/ffmpeg.exe');
  result.downloads = [];
  for (const item of chosen) {
    const m = finished.media.find(m => m.id === item.key);
    await command(binary, ['-v', 'error', '-xerror', '-i', m.filePath, '-f', 'null', '-'], { timeout: 120000 });
    result.downloads.push({ id: m.sourceId, filePath: m.filePath, size: m.size, duration: m.duration, fullDecode: true });
  }
  assert.deepEqual(errors, []); result.rendererErrors = errors;
  await page.locator('nav').getByRole('button', { name: '媒体库', exact: true }).click();
  await page.screenshot({ path: path.join(output, '真实下载媒体库.png') }); result.ok = true;
  }
} catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
finally { await page?.screenshot({ path: path.join(output, '最终界面.png') }).catch(() => {}); await application?.close().catch(() => {}); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
