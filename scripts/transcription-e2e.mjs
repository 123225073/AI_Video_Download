import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), root = path.resolve('.');
const output = path.join(root, 'output', `transcription-e2e-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
let fail = false, summaries = 0; const requests = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  requests.push({ route: req.url, authorized: req.headers.authorization === 'Bearer SYNTHETIC-E2E-ONLY', hasBody: Boolean(body) });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'fixture-summary' }, { id: 'fixture-second' }] }));
  if (req.url === '/v1/chat/completions') { if (fail) { res.statusCode = 429; return res.end('{}'); } summaries++; const parsed = JSON.parse(body); return res.end(JSON.stringify({ choices: [{ message: { content: parsed.messages[0].content.includes('文案校对员') ? JSON.parse(parsed.messages[1].content).textToCorrect.replaceAll('整里', '整理').replaceAll('提练', '提炼') : parsed.messages[0].content.includes('忠实的译者') ? 'Translation: ' + JSON.parse(parsed.messages[1].content).textToTranslate : parsed.messages[0].content.includes('只回复') ? '连接成功。' : '## 主题\n视频资料整理\n\n## 关键观点\n1. 先将视频转为文字。\n2. 提炼关键观点。\n3. 审阅后保存到知识库。' }, finish_reason: 'stop' }] })); }
  res.statusCode = 404; res.end('{}');
}); await new Promise(r => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, FENGSHA_TEST_MODE: '1', FENGSHA_TEST_DATA: path.join(output, 'profile'), FENGSHA_TEST_VISIBLE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let application; const errors = []; const result = { output, realLocalSpeech: false, syntheticModelWorkflow: false, archiveExport: false, failureRecovery: false, secretIsolation: false, restart: false, smallWindow: false };
async function launch() { application = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 60000 }); const page = await application.firstWindow(); page.on('pageerror', e => errors.push(e.message)); await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor(); return page; }
try {
  let page = await launch();
  await page.locator('nav').getByRole('button', { name: '转录与摘要', exact: true }).click();
  assert.equal(await page.getByLabel('本次转录语言').inputValue(), 'zh');
  await page.getByRole('button', { name: '本地文件 / 字幕', exact: true }).click();
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(root, 'output/reference/speech-fixture.wav'));
  await page.getByRole('button', { name: '选择文件', exact: true }).click(); await page.getByRole('button', { name: '开始转录', exact: true }).click();
  await page.getByRole('button', { name: 'AI 校正文案', exact: true }).waitFor({ timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('.primary-document button').disabled);
  const t = await application.evaluate(() => { const x = globalThis.fengshaTest; return x.transcriptions.get(x.snapshot().transcriptions[0].id); });
  assert.equal(t.status, 'ready'); assert.match(t.transcript, /文字|观点|知识/); assert.ok(t.segments.length); assert.equal(t.correctedTranscript, ''); assert.equal(t.summary, ''); assert.equal(summaries, 0); result.realLocalSpeech = true; result.noAutomaticAI = true;
  await page.getByRole('button', { name: 'AI 校正文案', exact: true }).click(); await page.getByText('请先在 AI 模型设置配置文本模型与密钥', { exact: true }).waitFor();
  await page.locator('main').getByRole('button', { name: 'AI 模型设置', exact: true }).click();
  await page.getByLabel('文本服务地址').fill(`http://127.0.0.1:${server.address().port}/v1`); await page.getByLabel('文本 API 密钥').fill('SYNTHETIC-E2E-ONLY');
  await page.getByRole('button', { name: '保存并读取模型', exact: true }).click(); await page.getByText(/读取到 2 个模型/).waitFor();
  assert.equal(await page.getByLabel('文本 API 密钥').inputValue(), ''); await page.getByLabel('校正、摘要与翻译模型').fill('fixture-summary');
  await page.getByRole('button', { name: '保存并测试文本连接', exact: true }).click(); await page.getByText(/文本连接成功/).waitFor();
  await page.getByRole('button', { name: '去转录与摘要', exact: true }).click(); await page.getByRole('button', { name: '查看文稿 / 审阅', exact: true }).first().click();
  await page.getByRole('button', { name: 'AI 校正文案', exact: true }).click(); await page.getByLabel('完整校正文案').waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="完整校正文案"]').disabled);
  assert.ok(await page.getByRole('button', { name: '生成所选译文（1）', exact: true }).isDisabled());
  assert.equal(await page.getByLabel('确认后的摘要').inputValue(), ''); result.syntheticModelWorkflow = true;
  const corrected = await page.getByLabel('完整校正文案').inputValue();
  await page.getByLabel('完整校正文案').fill(corrected + ' 人工核对完成888。'); await page.getByRole('button', { name: '确认文案', exact: true }).click();
  await page.getByRole('button', { name: '文案已确认', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: '翻译为日语', exact: true }).check();
  await page.getByRole('button', { name: '生成所选译文（2）', exact: true }).click();
  await page.getByRole('button', { name: '复制日语译文', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="完整校正文案"]').disabled);
  const translated = await application.evaluate((_, id) => globalThis.fengshaTest.transcriptions.get(id), t.id);
  assert.match(translated.translations.en.text, /888/); assert.match(translated.translations.ja.text, /888/); assert.equal(translated.summary, ''); assert.equal(translated.translation, '');
  result.multiLanguage = true;
  await page.screenshot({ path: path.join(output, '01-确认后多语言并排.png'), fullPage: true });
  await page.getByRole('button', { name: '生成摘要', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="确认后的摘要"]').value && !document.querySelector('[aria-label="确认后的摘要"]').disabled);
  await page.getByLabel('完整校正文案').fill(corrected + ' 人工核对新版本999。');
  assert.ok(await page.getByRole('button', { name: '生成所选译文（2）', exact: true }).isDisabled());
  await page.getByRole('button', { name: '确认文案', exact: true }).click(); await page.getByRole('button', { name: '文案已确认', exact: true }).waitFor();
  fail = true; await page.getByRole('button', { name: '生成所选译文（2）', exact: true }).click(); await page.getByRole('button', { name: '继续处理', exact: true }).waitFor();
  const failed = await application.evaluate((_, id) => globalThis.fengshaTest.transcriptions.get(id), t.id); assert.match(failed.translations.en.text, /888/); assert.ok(failed.translations.en.pending);
  fail = false; await page.getByRole('button', { name: '继续处理', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="完整校正文案"]').disabled && document.querySelector('.translation-card .readable-text').innerText.includes('999'));
  result.failureRecovery = true;
  await page.getByLabel('归档标题').fill('已确认多语言文案'); await page.getByLabel('归档标签').fill('读书, 工作流'); await page.getByLabel('我的笔记').fill('全文检索验收词777');
  await page.getByRole('button', { name: '确认归档', exact: true }).click(); await page.getByRole('button', { name: '保存归档修改', exact: true }).waitFor();
  for (const [name, file, expression] of [['导出英语译文','english.txt',/999/], ['导出日语译文','japanese.txt',/999/], ['导出 MD','export.md',/英语译文/]]) {
    await application.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path.join(output, file));
    await page.getByRole('button', { name, exact: true }).click(); await page.waitForTimeout(250); assert.match(fs.readFileSync(path.join(output, file), 'utf8'), expression);
  }
  await page.locator('.reference-disclosure > summary').first().click();
  assert.match(await page.locator('.reference-grid').innerText(), /\[00:/);
  await application.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path.join(output, 'export.srt'));
  await page.getByRole('button', { name: '导出 SRT', exact: true }).click(); await page.waitForTimeout(250); assert.match(fs.readFileSync(path.join(output, 'export.srt'), 'utf8'), /-->/); result.archiveExport = true;
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720)); await page.waitForTimeout(300);
  const width = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth })); assert.ok(width.body <= width.viewport); result.smallWindow = true;
  await page.screenshot({ path: path.join(output, '02-最小窗口.png'), fullPage: true });
  const snapshot = await application.evaluate(() => globalThis.fengshaTest.snapshot()); assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC-E2E-ONLY')); assert.ok(!fs.readFileSync(path.join(output, 'profile/library.sqlite')).includes(Buffer.from('SYNTHETIC-E2E-ONLY'))); result.secretIsolation = true;
  await application.close(); page = await launch(); await page.locator('nav').getByRole('button', { name: '知识归档', exact: true }).click();
  await page.getByLabel('搜索归档').fill('全文检索验收词777'); await page.getByText('1 条已确认归档', { exact: true }).waitFor(); await page.getByRole('button', { name: '查看文稿 / 审阅', exact: true }).click();
  await page.getByRole('button', { name: '文案已确认', exact: true }).waitFor(); assert.match(await page.locator('.translation-card .readable-text').first().innerText(), /999/);
  assert.equal(await page.getByLabel('我的笔记').inputValue(), '全文检索验收词777'); assert.ok(await page.getByRole('checkbox', { name:'翻译为日语', exact:true }).isChecked()); result.restart = true;
  assert.deepEqual(errors, []); assert.ok(requests.every(r => r.authorized)); result.requests = requests; result.modelCalls = summaries; result.rendererErrors = errors; result.ok = true;
} catch (e) { result.ok = false; result.error = String(e.stack || e); process.exitCode = 1; }
finally { if (application) await application.close().catch(() => {}); server.close(); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
