import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const executablePath = path.resolve(process.argv[2]);
const output = path.resolve('output', `installed-transcription-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let application; const result = { output, ok: false, realProvider: false };
try {
  application = await electron.launch({ executablePath, env, timeout: 45000 }); const page = await application.firstWindow();
  await page.getByRole('heading', { name: '链接下载', exact: true }).waitFor();
  const snapshot = await page.evaluate(async () => (await window.fengsha.snapshot()).value);
  result.version = snapshot.version; result.textKeyAvailable = snapshot.ai.text.hasKey; result.model = snapshot.ai.text.model;
  await page.locator('nav').getByRole('button',{ name:'转录与摘要',exact:true }).click();
  assert.equal(await page.getByLabel('本次转录语言').inputValue(), 'zh'); assert.equal(await page.getByRole('checkbox',{ name:'AI 校正完整文案',exact:true }).count(), 0);
  if (snapshot.transcriptions.length) {
    await page.getByRole('button',{ name:'查看文稿 / 审阅',exact:true }).first().click();
    await page.locator('.reference-disclosure > summary').first().click(); await page.locator('.reference-grid .readable-text').first().waitFor(); result.oldRecordsReadable = true;
  }
  await page.screenshot({ path:path.join(output,'转录与文案.png'),fullPage:true });
  if (!snapshot.ai.text.hasKey) { result.providerLimitation = '安装版当前文本密钥不可用，需要在 AI 模型设置保存有效密钥'; }
  else {
    result.realProvider = true;
    const response = await application.evaluate(async ({ app, safeStorage }, { output, config }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { Store } = load('./electron/store.js'), { AIService } = load('./electron/ai.js'), { Transcriptions } = load('./electron/transcription.js');
      const path = process.getBuiltinModule('path'); const store = await Store.open(path.join(output, 'profile'), {});
      store.put('ai-config','text',config); const ai = new AIService(store,path.join(app.getPath('userData'),'ai'),safeStorage);
      const service = new Transcriptions(store,{bin:path.join(process.resourcesPath,'bin')},ai,path.join(output,'records'),()=>{});
      try {
        const original = '今天我们学习如何整里视频资料，首先把视频转成文字，然后提练关键观点，最后确认摘要并保存到知识库。全过程分成 3 步，原始素材必须保留。';
        const id = service.start({ text: original, title: '合成素材 · 完整文案校正验证', correct:true }).id;
        while (service.active || service.get(id).status === 'queued') await new Promise(r=>setTimeout(r,200));
        const raw = service.get(id); const stagedStart = !raw.correctedTranscript && !raw.summary && !raw.translation;
        await service.action(id, 'correct'); while (service.active || service.get(id).status === 'queued') await new Promise(r=>setTimeout(r,200));
        if (!service.get(id).correctedTranscript) return { status:service.get(id).status, message:service.get(id).message };
        await service.action(id, 'confirm', { text:service.get(id).correctedTranscript });
        await service.action(id, 'translate', { languages:['en','ja'] }); while (service.active || service.get(id).status === 'queued') await new Promise(r=>setTimeout(r,200));
        const t = service.get(id); return { status:t.status,message:t.message,original:t.transcript,corrected:t.correctedTranscript,summary:t.summary, translations:t.translations, stagedStart, reviewedAt:t.reviewedAt };

      } finally { await service.close(); store.close(); }
    }, { output, config:snapshot.ai.text });
    Object.assign(result,response); assert.equal(response.status,'ready',response.message); assert.match(response.original,/整里/); assert.match(response.corrected,/整理/); assert.match(response.corrected,/提炼/); assert.match(response.corrected,/3/); assert.equal(response.summary,''); assert.equal(response.stagedStart,true); assert.ok(response.reviewedAt); assert.ok(response.translations.en.text); assert.ok(response.translations.ja.text); assert.match(response.translations.en.text,/3/); assert.match(response.translations.ja.text,/3/);
  }
  result.ok = true;
} catch (error) { result.error = String(error.message); process.exitCode = 1; }
finally { if(application) await application.close().catch(()=>{}); fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2)); }
