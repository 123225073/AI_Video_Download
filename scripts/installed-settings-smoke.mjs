import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const executablePath = path.resolve(process.argv[2]);
const output = path.resolve('output', `installed-settings-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.FENGSHA_TEST_MODE; delete env.FENGSHA_TEST_DATA;
let application; const errors = [], result = { output, ok: false, pages: [] };
try {
  application = await electron.launch({ executablePath, env, timeout: 45000 });
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  const before = await page.evaluate(async () => (await window.fengsha.snapshot()).value);
  assert.equal(before.version, '0.3.8'); result.version = before.version;
  const bottom = page.locator('.sidebar-bottom');
  assert.equal(await bottom.getByRole('button', { name: '设置', exact: true }).count(), 1);
  assert.equal(await bottom.getByRole('button', { name: '帮助与使用说明', exact: true }).count(), 1);
  await bottom.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByLabel('默认保存目录', { exact: true }).inputValue(), before.settings.savePath);
  assert.equal(await page.getByLabel('同时下载上限').inputValue(), String(before.settings.concurrency));
  assert.equal(await page.getByLabel('默认画质').inputValue(), before.settings.quality);
  await page.screenshot({ path: path.join(output, '安装版-下载与存储.png') });
  for (const title of ['AI 模型', '视频号连接', '应用与组件']) {
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: new RegExp(`^${title}`) }).click();
    await page.locator('.settings-detail-heading').getByRole('heading', { name: title, exact: true }).waitFor();
    if (title === 'AI 模型') {
      assert.equal(await page.getByLabel('AI 矫正与翻译模型').inputValue(), before.ai.text.model);
      assert.equal(await page.getByLabel('文本 API 密钥').inputValue(), '');
      result.encryptedKeyAvailable = before.ai.text.hasKey;
    }
    await page.screenshot({ path: path.join(output, `安装版-${title}.png`) }); result.pages.push(title);
  }
  await page.locator('.sidebar > nav').getByRole('button', { name: '转录与翻译', exact: true }).click();
  if (before.transcriptions.length) {
    await page.getByRole('button', { name: /^打开文案：/ }).first().click();
    await page.getByRole('heading', { name: '原文 · 不带时间戳', exact: true }).waitFor();
    assert.ok((await page.locator('.manuscript-text').first().innerText()).length > 10); result.oldManuscriptReadable = true;
  }
  await page.getByRole('button', { name: 'AI 模型设置', exact: true }).click();
  await page.locator('.settings-detail-heading').getByRole('heading', { name: 'AI 模型', exact: true }).waitFor();
  const after = await page.evaluate(async () => (await window.fengsha.snapshot()).value);
  assert.deepEqual(after.settings, before.settings); assert.deepEqual(after.ai, before.ai); assert.deepEqual(after.collector, before.collector);
  assert.deepEqual(after.transcriptions, before.transcriptions); assert.deepEqual(after.media, before.media);
  result.counts = { tasks: after.tasks.length, media: after.media.length, accounts: after.accounts.length, transcriptions: after.transcriptions.length };
  assert.deepEqual(errors, []); result.rendererErrors = errors; result.configurationUnchanged = true; result.ok = true;
} catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
finally { if (application) await application.close().catch(() => {}); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
