import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';
const program = path.resolve(process.argv[2]), output = path.resolve('output', `packaged-search-${Date.now()}`), profile = path.join(output, 'profile'); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env }; delete env.FENGSHA_TEST_MODE; delete env.FENGSHA_TEST_DATA; delete env.ELECTRON_RUN_AS_NODE;
const result = { ok: false, output, mock: false }, errors = []; let app;
try {
  app = await electron.launch({ executablePath: path.join(program, 'FengshaVideoDownloader.exe'), args: ['--agent-data-dir', profile], env, timeout: 45000 }); const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); await page.getByRole('button', { name: '用户搜索', exact: true }).click();
  await page.getByLabel('搜索用户平台').selectOption('B站'); await page.getByLabel('用户搜索关键词').fill('AI'); await page.getByRole('button', { name: '搜索用户', exact: true }).click(); await page.getByRole('dialog', { name: '请先登录 B站账号', exact: true }).waitFor(); await page.getByRole('button', { name: '暂不执行', exact: true }).click();
  const denied = await page.evaluate(() => window.fengsha.userSearch('B站', 'AI')); assert.equal(denied.code, 'BILIBILI_LOGIN_REQUIRED'); result.guiAndNativeLoginGate = true;
  const cli = await new Promise((resolve, reject) => { const c = spawn(path.join(program, 'resources/bin/node/node.exe'), [path.join(program, 'resources/cli/fengsha.mjs'), 'search', 'AI', '--platform', 'B站', '--data-dir', profile], { env, windowsHide: true }); let output = ''; c.stdout.on('data', b => output += b); c.on('error', reject); c.on('exit', code => resolve({ code, response: JSON.parse(output) })); }); assert.equal(cli.code, 1); assert.equal(cli.response.error.code, 'BILIBILI_LOGIN_REQUIRED'); result.bundledCliSearch = true;
  await page.getByLabel('搜索用户平台').selectOption('YouTube'); await page.getByRole('button', { name: '搜索用户', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.user-search-form .primary').disabled, null, { timeout: 60000 });
  const publicResult = (await page.evaluate(() => window.fengsha.userSearchLast())).value; assert.ok(publicResult.users.length); assert.equal(publicResult.status, 'browser'); assert.ok(publicResult.users.every(u => u.platform === 'YouTube' && u.name && u.id && u.url)); assert.equal('accountId' in publicResult, false);
  result.realYouTubeUsers = publicResult.users.length; result.avatarsProvided = publicResult.users.filter(u => u.avatar).length; await page.screenshot({ path: path.join(output, '用户搜索-安装程序.png') });
  assert.deepEqual(errors, []); result.rendererErrors = errors; result.ok = true;
} finally { if (app) await app.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
