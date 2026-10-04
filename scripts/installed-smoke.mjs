import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const executablePath = path.resolve(process.argv[2]);
const output = path.resolve('output', `installed-smoke-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let application, page; const errors = [], result = { output, executablePath, ok: false, pages: [], minWindowChecked: false };
try {
  application = await electron.launch({ executablePath, args: [], env, timeout: 45000 });
  page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  const checked = await page.evaluate(async () => await window.fengsha.environment());
  assert.ok(checked.ok); assert.equal(checked.value.length, 4); assert.ok(checked.value.every(e => e.ok)); result.environment = checked.value;
  const initial = await page.evaluate(async () => (await window.fengsha.snapshot()).value);
  result.initialCounts = { accounts: initial.accounts.length, media: initial.media.length, tasks: initial.tasks.length };
  await page.screenshot({ path: path.join(output, '01-安装版新建下载.png') }); result.pages.push('新建下载');
  assert.equal(initial.version, JSON.parse(fs.readFileSync('package.json','utf8')).version); result.version = initial.version;
  const collectorBin=path.join(path.dirname(executablePath),'resources','bin','collector');
  assert.ok(fs.existsSync(path.join(collectorBin,'wx_video_download.exe')));assert.equal(fs.readFileSync(path.join(collectorBin,'collector-system.ps1')).subarray(0,3).toString('hex'),'efbbbf');result.bundledCollector=true;
  assert.equal(await page.getByRole('button', { name: '识别博主', exact: true }).count(), 1);
  if (!process.argv.includes('--ui-only')) {
  await page.getByLabel('视频链接').fill('https://www.bilibili.com/video/BV1gVbx6hExy?p=2'); await page.getByRole('button', { name: '识别视频 / 合集', exact: true }).click();
  await page.locator('.result-row').waitFor({ timeout: 90000 });
  const selectContent = page.getByRole('button', { name: /^(查看内容|选择条目)$/ });
  assert.equal(await selectContent.count(), 1, await page.locator('.result-row').innerText());
  await selectContent.click();
  await page.getByRole('heading', { name: '内容选择', exact: true }).waitFor(); await page.screenshot({ path: path.join(output, '内容选择.png') }); result.pages.push('内容选择'); result.packagedParse = true;
  }
  assert.ok(initial.speechEnvironment.runtime); assert.deepEqual(initial.speechEnvironment.models, ['base', 'small']); result.bundledSpeechEnvironment = true;
  for (const name of ['博主批量下载','任务中心', '媒体库', '转录与摘要', '知识归档', '账号管理']) {
    await page.locator('nav').getByRole('button', { name, exact: true }).click(); await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `${name}.png`) }); result.pages.push(name);
  }
  await page.getByRole('button', { name: '添加账号', exact: true }).first().click(); await page.getByRole('dialog', { name: '添加平台账号' }).waitFor(); await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.sidebar-bottom').getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('heading', { name: '设置', exact: true }).waitFor(); await page.screenshot({ path: path.join(output, '设置.png') }); result.pages.push('设置');
  assert.equal(await page.getByLabel('同时下载上限').locator('option').count(), 100); result.autoAnd99Options = true;
  await page.locator('.sidebar-bottom').getByRole('button', { name: 'AI 模型设置', exact: true }).click();
  await page.getByRole('heading', { name: 'AI 模型设置', exact: true }).waitFor();
  assert.equal(await page.getByLabel('文本服务地址').inputValue(), initial.ai.text.baseUrl);
  assert.ok(await page.getByLabel('本地语音模型').isVisible());
  await page.screenshot({ path: path.join(output, 'AI与采集设置.png') }); result.pages.push('AI 模型设置');
  assert.equal(await page.getByRole('heading',{name:'微信连接准备',exact:true}).count(),0);
  await page.locator('.sidebar-bottom').getByRole('button',{name:'视频号连接',exact:true}).click();await page.getByRole('heading',{name:'视频号连接',exact:true}).waitFor();
  assert.equal(await page.getByLabel('文本 API 密钥').count(),0);await page.screenshot({path:path.join(output,'视频号连接.png')});result.pages.push('视频号连接');
  const prepared=await page.evaluate(()=>window.fengsha.collectorPrepare());assert.ok(prepared.ok,prepared.error);assert.equal(prepared.value.phase,'prepared');result.installedCollectorPrepared=true;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720));
  await page.waitForTimeout(250); await page.screenshot({ path: path.join(output, '最小窗口.png') }); result.minWindowChecked = true;
  const overflow = await page.locator('.main').evaluate(el => el.scrollWidth > el.clientWidth + 2); assert.equal(overflow, false);
  assert.deepEqual(errors, []); result.rendererErrors = errors; result.ok = true;
} catch (error) { result.error = String(error.stack || error); if (page) { result.visibleError = await page.locator('main').innerText().catch(() => ''); await page.screenshot({ path: path.join(output, '失败诊断.png') }).catch(() => {}); } process.exitCode = 1; }
finally { if (application) await application.close().catch(() => {}); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
