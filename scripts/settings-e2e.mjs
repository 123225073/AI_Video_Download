import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url), root = path.resolve('.');
const output = path.join(root, 'output', `settings-e2e-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const requests = [];
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* Consume synthetic test requests only. */ }
  requests.push(req.url); res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'settings-fixture-model' }] }));
  if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: '连接成功。' }, finish_reason: 'stop' }] }));
  res.statusCode = 404; res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: path.join(output, 'profile'), FENGSHA_TEST_VISIBLE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let application; const errors = [], result = { output, ok: false, pages: [] };
async function launch() {
  application = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 45000 });
  const page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  await application.evaluate(({ ipcMain, dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    // Never change Windows proxy/certificates during this layout/navigation test.
    for (const name of ['collector-status', 'collector-prepare', 'collector-allow', 'collector-restore']) {
      ipcMain.removeHandler(`fengsha:${name}`);
      ipcMain.handle(`fengsha:${name}`, () => ({ ok: true, value: { ready: true, connected: false, phase: 'idle', activeTasks: 0, label: `测试连接：${name}` } }));
    }
  }, path.join(output, 'downloads'));
  return page;
}
async function select(page, title) {
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: new RegExp(`^${title}`) }).click();
  await page.locator('.settings-detail-heading').getByRole('heading', { name: title, exact: true }).waitFor();
}
async function screenshot(page, title, file) {
  await page.locator('.settings-detail-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, file) }); result.pages.push(title);
  const overflow = await page.evaluate(() => [document.documentElement, document.querySelector('.main'), document.querySelector('.settings-detail-scroll')].some(el => el.scrollWidth > el.clientWidth + 1));
  assert.equal(overflow, false, `${title} horizontal overflow`);
}
try {
  let page = await launch();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 940));
  const bottom = page.locator('.sidebar-bottom');
  assert.equal(await bottom.getByRole('button', { name: '设置', exact: true }).count(), 1);
  assert.equal(await bottom.getByRole('button', { name: 'AI 模型设置', exact: true }).count(), 0);
  assert.equal(await bottom.getByRole('button', { name: '视频号连接', exact: true }).count(), 0);
  assert.equal(await bottom.getByRole('button', { name: '帮助与使用说明', exact: true }).count(), 1);
  const before = await application.evaluate(() => globalThis.fengshaTest.snapshot());
  await bottom.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: '设置分类' }).getByRole('button').count(), 4);
  await page.getByLabel('同时下载上限').selectOption('7'); await page.getByLabel('默认画质').selectOption('720');
  await page.getByLabel('自动失败重试').selectOption('2'); await page.getByLabel('下载文件归档规则').selectOption('author');
  await page.getByLabel('跳过重复视频', { exact: true }).uncheck(); await page.getByLabel('选择默认保存目录').click();
  await screenshot(page, '下载与存储', '01-下载与存储.png');
  await select(page, '应用与组件'); await page.getByText('当前版本 · 0.3.8', { exact: true }).waitFor();
  await screenshot(page, '应用与组件', '02-应用与组件.png');
  await select(page, 'AI 模型'); await page.getByLabel('文本服务名称').fill('未保存的模型配置');
  await select(page, '视频号连接'); await page.getByText('组件已准备', { exact: true }).waitFor();
  await screenshot(page, '视频号连接', '03-视频号连接.png');
  await page.getByRole('button', { name: '检查内置组件', exact: true }).click(); await page.getByRole('status').filter({ hasText: '测试连接：collector-prepare' }).waitFor();
  await select(page, 'AI 模型'); assert.equal(await page.getByLabel('文本服务名称').inputValue(), '未保存的模型配置');
  await select(page, '下载与存储'); assert.equal(await page.getByLabel('同时下载上限').inputValue(), '7');
  assert.equal(await page.getByLabel('默认保存目录', { exact: true }).inputValue(), path.join(output, 'downloads'));
  result.unsavedInputsRetained = true;
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('设置已保存，新任务将使用新的下载偏好', { exact: true }).waitFor();
  const saved = await application.evaluate(() => globalThis.fengshaTest.snapshot());
  assert.equal(saved.settings.concurrency, 7); assert.equal(saved.settings.quality, '720'); assert.equal(saved.settings.retries, 2);
  assert.equal(saved.settings.archive, 'author'); assert.equal(saved.settings.skipDuplicates, false); assert.equal(saved.settings.autoStart, before.settings.autoStart);
  assert.deepEqual(saved.tasks, before.tasks); assert.deepEqual(saved.accounts, before.accounts); assert.deepEqual(saved.media, before.media); assert.deepEqual(saved.transcriptions, before.transcriptions);
  result.downloadSettingsSaved = true;
  await select(page, '应用与组件'); await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('应用设置已保存', { exact: true }).waitFor();
  await page.getByRole('button', { name: '检查环境', exact: true }).click(); result.applicationSettingsSaved = true;
  await page.locator('.settings-detail-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await select(page, 'AI 模型'); assert.equal(await page.locator('.settings-detail-scroll').evaluate(el => el.scrollTop), 0); result.sectionStartsAtTop = true;
  await page.getByLabel('文本服务名称').fill('模拟 CPA');
  await page.getByLabel('文本服务地址').fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('文本 API 密钥').fill('SYNTHETIC-SETTINGS-ONLY'); await page.getByLabel('AI 矫正与翻译模型').fill('settings-fixture-model');
  await page.getByRole('button', { name: '保存并读取模型', exact: true }).click(); await page.getByRole('status').filter({ hasText: '读取到 1 个模型' }).waitFor();
  await page.getByRole('button', { name: '保存并测试文本连接', exact: true }).click(); await page.getByRole('status').filter({ hasText: '文本连接成功' }).waitFor();
  assert.equal(await page.getByLabel('文本 API 密钥').inputValue(), '');
  await screenshot(page, 'AI 模型', '04-AI模型.png'); result.modelActionsPassed = true;
  await page.getByRole('button', { name: '去转录与翻译', exact: true }).click(); await page.getByRole('heading', { name: '转录与翻译', exact: true }).waitFor();
  await page.getByRole('button', { name: 'AI 模型设置', exact: true }).click(); await page.locator('.settings-detail-heading h2').filter({ hasText: 'AI 模型' }).waitFor();
  await select(page, '视频号连接'); await page.getByRole('button', { name: '去博主批量下载', exact: true }).click();
  await page.getByLabel('博主链接', { exact: true }).fill('https://weixin.qq.com/sph/SYNTHETICTEST');
  await page.getByRole('button', { name: '视频号连接', exact: true }).click(); await page.locator('.settings-detail-heading h2').filter({ hasText: '视频号连接' }).waitFor();
  await page.locator('.sidebar > nav').getByRole('button', { name: '链接下载', exact: true }).click();
  await page.getByRole('button', { name: '修改设置', exact: true }).click(); await page.locator('.settings-detail-heading h2').filter({ hasText: '下载与存储' }).waitFor();
  result.shortcutsPassed = true;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
  for (const title of ['下载与存储', 'AI 模型', '视频号连接', '应用与组件']) { await select(page, title); await screenshot(page, `${title} · 小窗口`, `小窗口-${title}.png`); }
  await page.locator('.sidebar > nav').getByRole('button', { name: '链接下载', exact: true }).click();
  await bottom.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.settings-detail-heading').getByRole('heading', { name: '应用与组件', exact: true }).waitFor(); result.lastSectionRetained = true;
  await application.close(); application = null; page = await launch();
  await page.locator('.sidebar-bottom').getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByLabel('同时下载上限').inputValue(), '7'); assert.equal(await page.getByLabel('默认画质').inputValue(), '720');
  await select(page, 'AI 模型'); assert.equal(await page.getByLabel('AI 矫正与翻译模型').inputValue(), 'settings-fixture-model');
  assert.equal(await page.getByLabel('文本 API 密钥').inputValue(), '');
  const reloaded = await application.evaluate(() => globalThis.fengshaTest.snapshot()); assert.ok(reloaded.ai.text.hasKey);
  assert.deepEqual(reloaded.tasks, before.tasks); assert.deepEqual(reloaded.accounts, before.accounts); assert.deepEqual(reloaded.media, before.media); assert.deepEqual(reloaded.transcriptions, before.transcriptions);
  result.restartPersisted = true; result.requests = requests; assert.deepEqual(errors, []); result.rendererErrors = errors; result.ok = true;
} catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
finally { if (application) await application.close().catch(() => {}); await new Promise(resolve => server.close(resolve)); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
