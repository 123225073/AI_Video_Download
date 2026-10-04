import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/store.js';
import { AIService, apiBase } from '../electron/ai.js';
import { Transcriptions, transcriptionUrl } from '../electron/transcription.js';
import { parseSubtitles, chunksOf, srtOf } from '../electron/transcript-text.js';
import { simplifiedRecognition, validateCorrection } from '../electron/transcript-correction.js';
import { alignedBatches, alignedReply } from '../electron/transcript-alignment.js';
const vault = { isEncryptionAvailable: () => true, encryptString: t => Buffer.from(t).map(n => n ^ 71), decryptString: b => Buffer.from(b).map(n => n ^ 71).toString() };
async function fixture(request = async () => new Response(JSON.stringify({ choices: [{ message: { content: '## 摘要\n关键观点：整理资料。' }, finish_reason: 'stop' }] }))) {
  const dir = path.resolve('output/unit-ai', randomUUID()); const store = await Store.open(dir, {}); const ai = new AIService(store, dir, vault, () => {}, request);
  ai.save('text', { baseUrl: 'http://127.0.0.1:3456/v1/', model: 'test-model', apiKey: 'synthetic-secret' });
  const service = new Transcriptions(store, { bin: path.resolve('bin') }, ai, path.join(dir, 'results'), () => {}, { testing: true });
  return { dir, store, ai, service };
}
async function settle(service, id) { for (let i = 0; i < 400; i++) { const t = service.get(id); if (!['queued', 'preparing', 'subtitles', 'transcribing', 'correcting', 'summarizing', 'translating'].includes(t.status)) return t; await new Promise(r => setTimeout(r, 10)); } throw new Error('Task did not settle'); }
async function correctAndConfirm(service, ai, id) {
  await settle(service, id); const chat = ai.chat;
  ai.chat = async (_system, body) => JSON.parse(body).textToCorrect;
  await service.action(id, 'correct'); await settle(service, id); ai.chat = chat;
  await service.action(id, 'confirm', { text: service.get(id).correctedTranscript });
}
test('模型密钥加密且不进入快照/数据库；切换域名不会转发旧密钥', async () => {
  const { dir, store, ai, service } = await fixture(); assert.equal(ai.config().hasKey, true); assert.ok(!JSON.stringify(ai.all()).includes('synthetic-secret')); store.flush(); assert.ok(!fs.readFileSync(store.file).includes(Buffer.from('synthetic-secret'))); assert.ok(!fs.readFileSync(path.join(dir, 'ai-text.encrypted')).includes(Buffer.from('synthetic-secret')));
  ai.save('text', { baseUrl: 'https://different.example/v1', model: 'other' }); assert.equal(ai.config().hasKey, false); await assert.rejects(ai.chat('x', 'y'), /密钥/); await service.close(); store.close();
});
test('模型目录支持手动配置，超长与空响应不记为成功，错误不包含服务正文或密钥', async () => {
  const requests = []; const { ai, store, service } = await fixture(async (url, opts) => { requests.push({ url, body: opts.body }); return new Response('SECRET-UPSTREAM-ERROR', { status: 401 }); });
  await assert.rejects(ai.models(), e => e.message.includes('密钥') && !e.message.includes('SECRET')); assert.equal(requests[0].url, 'http://127.0.0.1:3456/v1/models');
  ai.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }] })); assert.deepEqual(await ai.models(), ['a', 'z']);
  ai.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'truncated' } }] })); await assert.rejects(ai.chat('x', 'y'), /长度限制/);
  ai.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })); await assert.rejects(ai.chat('x', 'y'), /有效文字/);
  ai.save('text', { ...ai.config(), protocol: 'responses' }); ai.fetch = async () => new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'Responses 成功' }] }] })); assert.equal(await ai.chat('x', 'y'), 'Responses 成功'); await service.close(); store.close();
});
test('文本到摘要到确认归档到全文搜索与导出形成闭环，原文保留', async () => {
  const { store, service } = await fixture(); const source = '读书先整理观点，再结合实际场景实践。'; const { id } = service.start({ text: source, summarize: true }); await correctAndConfirm(service, service.ai, id); await service.action(id, 'summary'); const t = await settle(service, id); assert.equal(t.status, 'ready'); assert.equal(t.transcript, source); assert.ok(t.summary.includes('关键观点')); assert.equal(service.start({ text: source }).id, id);
  const archived = service.archive(id, { title: '读书实践', summary: '已核对：整理观点', notes: '独特检索词123', tags: '读书, 实践' }); assert.equal(archived.status, 'archived'); assert.deepEqual(service.search('独特检索词123'), [id]); assert.ok(service.exportText(id, 'md').includes('已核对：整理观点')); assert.ok(service.exportText(id, 'txt').includes(source)); assert.throws(() => service.exportText(id, 'srt'), /时间戳/); service.unarchive(id); assert.equal(service.get(id).transcript, source); assert.deepEqual(service.search(''), []); await service.close(); store.close();
});
test('摘要失败后保留原文，仅重试AI；取消中的任务不会被过晚响应标记完成', async () => {
  const { store, ai, service } = await fixture(async () => new Response('{}', { status: 429 })); const { id } = service.start({ text: '材料已经明确说明结论。' }); await correctAndConfirm(service, ai, id); await service.action(id, 'summary'); let t = await settle(service, id); assert.equal(t.status, 'ai-failed'); assert.ok(t.transcript); assert.equal(t.summary, ''); ai.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '重试成功' } }] })); await service.action(id, 'retry'); t = await settle(service, id); assert.equal(t.status, 'ready'); assert.equal(t.summary, '重试成功');
  ai.chat = (_s, _c, signal) => new Promise((r, j) => signal.addEventListener('abort', () => j(new Error('已停止')), { once: true })); const second = service.start({ text: '另一条待处理资料' }).id; await correctAndConfirm(service, ai, second); await service.action(second, 'summary'); await new Promise(r => setTimeout(r, 20)); await service.action(second, 'cancel'); assert.equal(service.get(second).status, 'cancelled'); assert.ok(service.get(second).transcript); await service.close(); store.close();
});
test('无语音阻止AI调用；重启中断任务保留文稿与完整性状态', async () => {
  const { store, service, ai, dir } = await fixture(); let count = 0; ai.chat = async () => { count++; return 'should not call'; }; service.sourceText = async () => ({ text: '', segments: [], method: '测试静音' }); const { id } = service.start({ url: 'https://example.com/audio' }); const t = await settle(service, id); assert.equal(t.status, 'no-speech'); assert.equal(count, 0);
  store.put('transcription', 'partial', { id: 'partial', status: 'transcribing', transcript: '已完成第一段', transcriptPartial: true, segments: [], createdAt: Date.now() }); store.put('transcription', 'full', { id: 'full', status: 'summarizing', transcript: '完整文稿', transcriptPartial: false, createdAt: Date.now() }); await service.close(); const restored = new Transcriptions(store, {}, ai, path.join(dir, 'reopened'), () => {}); assert.equal(restored.get('partial').status, 'interrupted'); assert.equal(restored.get('full').status, 'ai-failed'); assert.throws(() => restored.archive('partial', {}), /完整文稿/); await restored.close(); store.close();
});
test('字幕去重保留时间戳，长文本分块不丢失内容，非法地址被拒绝', () => {
  const parsed = parseSubtitles('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n今天读书\n\n00:00:03.000 --> 00:00:05.000\n今天读书\n\n00:00:05.000 --> 00:00:07.000\n总结要点'); assert.equal(parsed.segments.length, 2); assert.match(srtOf(parsed.segments), /00:00:01,000 --> 00:00:03,000/); assert.equal(chunksOf('a'.repeat(30001), 10000).join('').length, 30001); assert.throws(() => transcriptionUrl('http://localhost/private')); assert.throws(() => apiBase('https://secret:pass@host/v1')); assert.equal(apiBase('https://host/v1/'), 'https://host/v1');
});
test('长摘要分段失败续接，审阅草稿切换页面不丢失', async () => {
  const { store, ai, service } = await fixture(); ai.save('text', { ...ai.config(), chunkChars: 2000 });
  const { id } = service.start({ text: '材料内容。'.repeat(800) }); await correctAndConfirm(service, ai, id);
  let calls = 0; ai.chat = async () => { calls++; if (calls === 2) throw new Error('模型临时失败'); return '简短分段摘要'; };
  await service.action(id, 'summary'); let t = await settle(service, id); assert.equal(t.status, 'ai-failed'); assert.equal(t.summaryCheckpoint.parts.length, 1);
  let retryCalls = 0; ai.chat = async () => { retryCalls++; return '成功后的分段文字'; }; await service.action(id, 'retry'); t = await settle(service, id); assert.equal(t.status, 'ready'); assert.equal(retryCalls, chunksOf(t.correctedTranscript, 2000).length - 1); assert.equal(t.translation, '');
  service.saveDraft(id, { title: '审阅中', summary: '尚未确认', notes: '草稿保留', tags: '草稿' }); assert.equal(service.detail(id).reviewDraft.notes, '草稿保留'); service.archive(id, service.detail(id).reviewDraft); assert.equal(service.detail(id).reviewDraft, null); await service.close(); store.close();
});

test('同一文件复用记录，旧版自动AI选项不再建立重复任务，显式重转录可新建', async () => {
  const { store, service, dir } = await fixture(); const file = path.join(dir, 'text.txt'); fs.writeFileSync(file, '文件重复导入的真实内容'); const first = service.start({ inputId: service.choose(file).id, summarize: false }).id; await settle(service, first); const reused = service.start({ inputId: service.choose(file).id, summarize: false }); assert.equal(reused.id, first); assert.equal(reused.reused, true); const another = service.start({ inputId: service.choose(file).id, summarize: true }); assert.equal(another.id, first); assert.notEqual(service.start({ inputId: service.choose(file).id, force: true }).id, first); await settle(service, another.id); await service.close(); store.close();
});
test('远程语音采用独立配置与上传接口，不把文本密钥当作语音密钥', async () => {
  const { ai, store, service, dir } = await fixture(); const file = path.join(dir, 'audio.wav'); fs.writeFileSync(file, 'fixture'); await assert.rejects(ai.transcribe(file), /语音转录模型/); ai.save('speech', { mode: 'remote', baseUrl: 'http://127.0.0.1:3457/v1', model: 'speech-model', apiKey: 'speech-synthetic' }); let checked = false; ai.fetch = async (url, options) => { assert.equal(url, 'http://127.0.0.1:3457/v1/audio/transcriptions'); assert.equal(options.headers.Authorization, 'Bearer speech-synthetic'); assert.equal(options.body.get('model'), 'speech-model'); assert.equal(options.body.get('file').size, 7); assert.equal(options.redirect, 'error'); checked = true; return new Response(JSON.stringify({ text: '语音文字', segments: [{ start: 0, end: 1, text: '语音文字' }] })); }; const t = await ai.transcribe(file); assert.equal(t.text, '语音文字'); assert.equal(checked, true); await service.close(); store.close();
});

test('默认中文识别、繁转简仅改变字形，时间戳和非中文保持原样', async () => {
  const { ai, service, store } = await fixture(); assert.equal(ai.config('speech').language, 'zh'); assert.equal(ai.config('speech').localModel, 'small');
  const original = { text: '學習視頻，歸檔資料。', language: 'zh', segments: [{ start: 1.23, end: 8.45, text: '學習視頻，歸檔資料。' }] };
  const result = simplifiedRecognition(original); assert.equal(result.text, '学习视频，归档资料。'); assert.equal(result.segments[0].start, 1.23); assert.equal(original.text, '學習視頻，歸檔資料。'); assert.equal(simplifiedRecognition({ ...original, language: 'en' }).text, original.text);
  await service.close(); store.close();
});

test('字幕原文、时间戳和完整AI校正文案分别保存，摘要使用校正后内容', async () => {
  const { dir, ai, service, store } = await fixture(); const file = path.join(dir, 'captions.srt');
  const raw = '今天学习如何整里资料，分成 3 步。\n先保留完整原文，再提练观点，最后归档。';
  fs.writeFileSync(file, '1\n00:00:01,230 --> 00:00:03,450\n' + raw.split('\n')[0] + '\n\n2\n00:00:04,000 --> 00:00:08,900\n' + raw.split('\n')[1]);
  let summarySource = ''; ai.chat = async (system, body) => { if (system.includes('文案校对员')) return JSON.parse(body).textToCorrect.replace('整里', '整理').replace('提练', '提炼'); summarySource = body; return '资料整理：保留原文、提炼观点、归档。'; };
  const id = service.start({ inputId: service.choose(file).id, correct: true }).id; await settle(service, id); assert.equal(service.get(id).correctedTranscript, ''); await service.action(id, 'correct'); await settle(service, id); assert.equal(service.get(id).summary, ''); await service.action(id, 'confirm', { text: service.get(id).correctedTranscript }); await service.action(id, 'summary'); const t = await settle(service, id);
  assert.equal(t.status, 'ready'); assert.equal(t.transcript, raw); assert.match(t.correctedTranscript, /整理/); assert.match(t.correctedTranscript, /提炼/); assert.match(summarySource, /提炼/);
  assert.equal(service.exportText(id, 'txt'), raw); assert.match(service.exportText(id, 'timed-txt'), /\[00:00:01\]/); assert.match(service.exportText(id, 'srt'), /00:00:01,230 --> 00:00:03,450/); assert.equal(service.exportText(id, 'corrected-txt'), t.correctedTranscript);
  const candidate = t.correctedTranscript; service.saveDraft(id, { correctedTranscript: candidate + '\n校对备注888' }); assert.match(service.detail(id).reviewDraft.correctedTranscript, /888/);
  service.archive(id, { correctedTranscript: candidate + '\n手动校对888', summary: t.summary }); assert.equal(service.get(id).correctedTranscript, candidate); assert.equal(service.get(id).transcript, raw); assert.match(service.exportText(id, 'corrected-txt'), /手动校对888/); assert.deepEqual(service.search('手动校对888'), [id]); assert.match(service.exportText(id, 'md'), /纯文本原文/); assert.match(service.exportText(id, 'md'), /带时间戳原文/); assert.match(service.exportText(id, 'md'), /已确认校正文案/);
  await service.close(); store.close();
});

test('模型摘要、无关改写、数字变动和时间戳不能当成完整校正文案', () => {
  const source = '今天学习如何整理资料，首先保留全部原文与视频来源，然后检查识别错误，再提炼关键观点，最后保存完整材料，共 3 步。';
  assert.throws(() => validateCorrection(source, '整理资料需要保留原文。'), /不完整/);
  assert.throws(() => validateCorrection(source, '这里讲的是如何制作烘焙蛋糕，首先准备鸡蛋面粉并称好重量，然后打发奶油混合液体，再放入烤箱等待烘焙，最后装盘上桌，共 3 步。'), /改动过大/);
  assert.throws(() => validateCorrection(source, source.replace('3', '4')), /数字/);
  assert.throws(() => validateCorrection(source, '[00:00:01] ' + source), /格式不符/);
  assert.equal(validateCorrection(source, source), source);
});

test('长文校正分段失败续接，完整文案不缩短、不重复前后文', async () => {
  const { ai, service, store } = await fixture(); ai.save('text', { ...ai.config(), outputTokens: 500 });
  const source = '先保留完整原文，再检查文字识别错误，最后提炼要点归档。'.repeat(24); let calls = 0;
  ai.chat = async (_s, body) => { calls++; if (calls === 2) throw new Error('模型暂时限流'); return JSON.parse(body).textToCorrect; };
  const id = service.start({ text: source, correct: true, summarize: false }).id; await settle(service, id); await service.action(id, 'correct'); let t = await settle(service, id); assert.equal(t.status, 'ai-failed'); assert.equal(t.correctionParts.length, 1); assert.equal(t.correctedTranscript, ''); assert.throws(() => service.exportText(id, 'corrected-txt'), /尚无完整/);
  let resumed = 0; ai.chat = async (_s, body) => { resumed++; const input = JSON.parse(body); assert.ok(input.precedingContext); return input.textToCorrect; }; await service.action(id, 'retry'); t = await settle(service, id); assert.equal(t.status, 'ready'); assert.equal(t.correctedTranscript.replace(/\s/g, ''), source); assert.equal(resumed, chunksOf(source, 200).length - 1); assert.equal(t.transcript, source);
  await service.close(); store.close();
});

test('旧记录可以补做校正而不重新转录，不覆盖原摘要、归档与审阅草稿', async () => {
  const { ai, service, store } = await fixture(); const source = '学习如何整里资料，先保留原文再归档。'; const id = service.start({ text: source, summarize: false }).id; await settle(service, id); service.archive(id, { summary: '用户已确认的摘要', notes: '原有笔记' }); service.saveDraft(id, { title: '草稿标题', notes: '未确认笔记' });
  service.sourceText = async () => { throw new Error('不得重新转录'); }; ai.chat = async (_s, body) => JSON.parse(body).textToCorrect.replace('整里', '整理'); await service.action(id, 'correct'); const t = await settle(service, id);
  assert.equal(t.status, 'archived'); assert.equal(t.transcript, source); assert.match(t.correctedTranscript, /整理/); assert.equal(t.confirmedSummary, '用户已确认的摘要'); assert.equal(t.notes, '原有笔记'); assert.equal(service.detail(id).reviewDraft.notes, '未确认笔记'); assert.equal(t.confirmedCorrectedTranscript, undefined);
  await service.close(); store.close();
});

test('校正期间停止和重启保留原文，不保存迟到结果或伪装完成', async () => {
  const { ai, service, store, dir } = await fixture(); let finish; ai.chat = async (_s, body) => new Promise(resolve => { finish = () => resolve(JSON.parse(body).textToCorrect); });
  const id = service.start({ text: '原文必须完整保留，停止任务后可以恢复。', correct: true, summarize: false }).id;
  await settle(service, id); await service.action(id, 'correct');
  while (!finish) await new Promise(r => setTimeout(r, 10)); const cancel = service.action(id, 'cancel'); finish(); await cancel; assert.equal(service.get(id).status, 'cancelled'); assert.equal(service.get(id).correctedTranscript, ''); assert.ok(service.get(id).transcript);
  store.put('transcription', id, { ...service.get(id), status: 'correcting' }); await service.close(); const reopened = new Transcriptions(store, {}, ai, path.join(dir, 'restarted'), () => {}); assert.equal(reopened.get(id).status, 'ai-failed'); assert.ok(reopened.get(id).transcript); await reopened.close(); store.close();
});

test('转录不自动调用AI，未经校正确认的文案不得翻译或生成摘要', async () => {
  const { ai, service, store } = await fixture(); let calls = 0; ai.chat = async () => { calls++; return '不可调用'; };
  const id = service.start({ text: '真实原文', correct: true, summarize: true, translate: true }).id;
  await settle(service, id); assert.equal(calls, 0);
  await assert.rejects(service.action(id, 'translate', { languages: ['en'] }), /确认文案/);
  await assert.rejects(service.action(id, 'summary'), /确认文案/);
  await assert.rejects(service.action(id, 'confirm', { text: '真实原文' }), /AI 校正/);
  await correctAndConfirm(service, ai, id); assert.equal(calls, 0);
  await assert.rejects(service.action(id, 'translate', { languages: ['invalid'] }), /语言/);
  service.saveDraft(id, { correctedTranscript: '修改的文案' });
  await assert.rejects(service.action(id, 'translate', { languages: ['en'] }), /重新点击/);
  assert.equal(calls, 0); await service.close(); store.close();
});

test('多语言分别保存和续传，翻译使用确认后的编辑稿，旧版本与原文保留', async () => {
  const { ai, service, store } = await fixture();
  const source = '全文内容。'.repeat(90), id = service.start({ text: source }).id;
  await correctAndConfirm(service, ai, id); const edited = source + '人工校对内容。';
  service.saveDraft(id, { correctedTranscript: edited, notes: '既有笔记' }); await service.action(id, 'confirm', { text: edited });
  ai.save('text', { ...ai.config(), outputTokens: 500 }); const inputs = []; let jaCalls = 0;
  ai.chat = async (system, body) => { const language = system.includes('日语') ? 'ja' : 'en'; inputs.push({ language, body: JSON.parse(body).textToTranslate }); if (language === 'ja' && ++jaCalls === 2) throw new Error('模型临时限流'); return `${language} translation: ${JSON.parse(body).textToTranslate}`; };
  await service.action(id, 'translate', { languages: ['en', 'ja', 'en'] }); let t = await settle(service, id);
  assert.equal(t.status, 'ai-failed'); assert.equal(t.translations.en.status, 'ready'); assert.equal(t.translations.ja.pending.parts.length, 1); assert.equal(inputs.filter(x => x.language === 'en').map(x => x.body).join(''), edited);
  const enCalls = inputs.filter(x => x.language === 'en').length, enText = t.translations.en.text;
  await service.action(id, 'retry'); t = await settle(service, id); assert.equal(t.status, 'ready'); assert.equal(inputs.filter(x => x.language === 'en').length, enCalls); assert.equal(t.translations.en.text, enText); assert.match(t.translations.ja.text, /人工校对内容/);
  assert.equal(service.exportText(id, 'translation-txt', 'en'), enText);
  service.saveDraft(id, { correctedTranscript: edited + '新版本。' }); await assert.rejects(service.action(id, 'translate', { languages: ['en'] }), /重新点击/);
  await service.action(id, 'confirm', { text: edited + '新版本。' }); await service.action(id, 'translate', { languages: ['en'] }); t = await settle(service, id);
  assert.equal(t.translations.en.history[0].text, enText); assert.match(t.translations.en.text, /新版本/); assert.notEqual(t.translations.ja.sourceHash, t.reviewedHash);
  service.archive(id, { correctedTranscript: edited + '新版本。', summary: '' }); assert.deepEqual(service.search('translation'), [id]); assert.match(service.exportText(id, 'md'), /英语译文/); assert.match(service.exportText(id, 'md'), /日语译文（旧文案版本）/); assert.match(service.exportText(id, 'md'), /历史版本/); assert.equal(t.transcript, source);
  await service.close(); store.close();
});

test('旧版排队任务不自动处理，归档改稿不能绕过文案确认，翻译中不能修改源文案', async () => {
  const { service, ai, store } = await fixture(); const id = service.start({ text: '保留原文并核对。' }).id;
  await correctAndConfirm(service, ai, id); let finish;
  ai.chat = async (_s, body) => new Promise(r => { finish = () => r(JSON.parse(body).textToTranslate); });
  await service.action(id, 'translate', { languages: ['en'] }); while (!finish) await new Promise(r => setTimeout(r, 10));
  assert.throws(() => service.saveDraft(id, { correctedTranscript: '另一个版本' }), /处理文案/);
  await assert.rejects(service.action(id, 'confirm', { text: '另一个版本' }), /等待处理/);
  const stop = service.action(id, 'cancel'); finish(); await stop; assert.equal(service.get(id).translations.en.text, undefined);
  service.archive(id, { correctedTranscript: '归档中修改的内容。' }); assert.equal(service.get(id).reviewedAt, null);
  await assert.rejects(service.action(id, 'summary'), /确认文案/);
  await service.close(); store.close();
});

test('关闭重启后保留多语言进度，恢复只生成未完成语言；旧队列不再自动翻译原文', async () => {
  const { service, ai, store, dir } = await fixture(); const id = service.start({ text: '重启后保留已确认文案。' }).id;
  await correctAndConfirm(service, ai, id); let waiting = false;
  ai.chat = async (system, body, signal) => { if (system.includes('英语')) return 'English completed'; waiting = true; return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('已停止')), { once: true })); };
  await service.action(id, 'translate', { languages: ['en', 'ja'] }); while (!waiting) await new Promise(r => setTimeout(r, 10)); await service.close();
  let calls = 0; ai.chat = async system => { calls++; assert.match(system, /日语/); return '日本語の文案'; };
  const restored = new Transcriptions(store, {}, ai, path.join(dir, 'restored'), () => {}); await restored.action(id, 'retry'); const t = await settle(restored, id);
  assert.equal(calls, 1); assert.equal(t.translations.en.text, 'English completed'); assert.equal(t.translations.ja.text, '日本語の文案'); assert.deepEqual(t.translationSelection, ['en', 'ja']);
  store.put('transcription', 'legacy', { ...t, id: 'legacy', status: 'queued', textJob: null, mode: { correct: true, summarize: true, translate: true }, correctionOnly: false, correctedTranscript: '', summary: '', translation: '' }); restored.pump(); await settle(restored, 'legacy'); assert.equal(calls, 1); assert.equal(restored.get('legacy').translation, '');
  await restored.close(); store.close();
});

async function captionFixture() {
  const f = await fixture(); const segments = [{ start: 1.234, end: 3.456, text: '今天分享如何整里资料。' }, { start: 4.8, end: 9.33, text: '先保留原始文案，再提练关键观点。' }];
  const id = f.service.start({ text: segments.map(s => s.text).join('\n') }).id; await settle(f.service, id);
  f.store.put('transcription', id, { ...f.service.get(id), segments }); return { ...f, id, segments };
}
test('一次AI矫正同时生成两种格式，字幕段数与毫秒起止时间精确保留', async () => {
  const { service, ai, store, id, segments } = await captionFixture();
  ai.chat = async (_s, body) => JSON.stringify({ segments: JSON.parse(body).segments.map(s => ({ ...s, text: s.text.replace('整里','整理').replace('提练','提炼') })) });
  await service.action(id, 'correct-pair'); const t = await settle(service, id);
  assert.equal(t.status, 'ready'); assert.match(t.correctedTranscript, /整理/); assert.match(t.correctedTranscript, /提炼/);
  assert.equal(t.correctedTranscript, t.correctedSegments.map(s => s.text).join('\n'));
  assert.deepEqual(t.correctedSegments.map(({ start, end }) => ({ start, end })), segments.map(({ start, end }) => ({ start, end })));
  assert.deepEqual(t.segments, segments); assert.match(service.exportText(id, 'corrected-timed-txt'), /\[00:00:01\]/); assert.match(service.exportText(id, 'corrected-srt'), /00:00:01,234 --> 00:00:03,456/);
  assert.equal(service.exportText(id, 'corrected-candidate-txt'), t.correctedTranscript); assert.equal(t.summary, ''); await service.close(); store.close();
});
test('漏段、乱序和重复字幕ID不能保存为完整结果；超长单句拆分后还原原时间', () => {
  const batch = [{ id: 0, index: 0, text: '一段资料' }, { id: 1, index: 1, text: '另一段资料' }];
  assert.throws(() => alignedReply(batch, JSON.stringify({ segments: [{ id: 0, text:'一段资料' }] })), /段落/);
  assert.throws(() => alignedReply(batch, JSON.stringify({ segments: [{ id: 1,text:'另一段' }, { id:0,text:'原段' }] })), /顺序/);
  assert.throws(() => alignedReply(batch, JSON.stringify({ segments: [{ id:0,text:'原段' }, { id:0,text:'另段' }] })), /顺序/);
  assert.throws(() => alignedReply(batch, '完整文案'), /逐段格式/);
  const source = [{ start:0,end:88.2,text:'内容'.repeat(500) }], batches = alignedBatches(source, 120);
  assert.equal(batches.flat().map(s => s.text).join(''), source[0].text); assert.ok(batches.length > 1); assert.ok(batches.flat().every(s => s.index === 0));
});
test('可从原文或矫正文案选两种格式翻译，版本独立保存，时间戳不可被模型修改', async () => {
  const { service, ai, store, id, segments } = await captionFixture();
  ai.chat = async (_s, body) => { const input = JSON.parse(body); return input.segments ? JSON.stringify({ segments: input.segments.map(s => ({ id:s.id, text:`Translated ${s.id}` })) }) : `Translated ${input.textToTranslate}`; };
  for (const format of ['plain','timed']) { const text = format === 'timed' ? service.exportText(id,'timed-txt') : service.get(id).transcript;
    await service.action(id,'translate',{format,sourceKind:'original',languages:['en','ja'],expectedText:text}); assert.equal((await settle(service,id)).status,'ready'); }
  const t = service.get(id); assert.equal(Object.keys(t.translationVariants).length,4); assert.ok(!t.translationVariants['original:plain:en'].text.includes('[00:'));
  assert.match(t.translationVariants['original:timed:en'].text,/\[00:00:01\]/); assert.deepEqual(t.translationVariants['original:timed:ja'].segments.map(({start,end})=>({start,end})),segments.map(({start,end})=>({start,end})));
  assert.match(service.exportText(id,'variant-srt','ja','original:timed:ja'),/00:00:01,234 --> 00:00:03,456/);
  assert.throws(()=>service.exportText(id,'variant-srt','en','original:plain:en'),/时间戳/);
  assert.deepEqual(service.search('Translated',true),[id]); assert.deepEqual(service.search('Translated'),[]);
  await assert.rejects(service.action(id,'translate',{format:'plain',sourceKind:'original',languages:['en'],expectedText:'另一条素材'}),/文案已发生变化/);
  await assert.rejects(service.action(id,'translate',{format:'timed',sourceKind:'corrected',languages:['en'],expectedText:''}),/AI 矫正/);
  assert.equal(t.summary,''); assert.equal(t.notes,undefined); await service.close(); store.close();
});
test('带时间戳翻译失败保留原版本；重试不会重复调用其他已完成语言', async () => {
  const { service, ai, store, id } = await captionFixture(); let fail = true, englishCalls = 0;
  ai.chat = async (system, body) => { if(system.includes('英语')) englishCalls++; if(fail && system.includes('日语')) throw new Error('模型限流'); return JSON.stringify({segments:JSON.parse(body).segments.map(s=>({id:s.id,text:'Language text'}))}); };
  await service.action(id,'translate',{format:'timed',sourceKind:'original',languages:['en','ja'],expectedText:service.exportText(id,'timed-txt')}); let t = await settle(service,id);
  assert.equal(t.status,'ai-failed'); assert.ok(t.translationVariants['original:timed:en'].text); assert.ok(t.translationVariants['original:timed:ja'].pending);
  fail=false; await service.action(id,'retry'); t = await settle(service,id); assert.equal(t.status,'ready'); assert.equal(englishCalls,1); assert.ok(t.translationVariants['original:timed:ja'].text);
  await service.close(); store.close();
});
test('目录与子目录持久保存、同名校验，素材移动不改变原文和旧摘要笔记', async () => {
  const { service, store, ai, dir } = await fixture(); const root=service.folderAction('create',{name:'读书'}), child=service.folderAction('create',{name:'散文',parentId:root.id});
  assert.throws(()=>service.folderAction('create',{name:'散文',parentId:root.id}),/同名/); assert.throws(()=>service.folderAction('create',{name:'a/b'}),/路径符号/);
  assert.throws(()=>service.start({text:'源文案',folderId:'missing'}),/目录不存在/);
  const id=service.start({text:'源文案',folderId:child.id}).id; await settle(service,id); store.put('transcription',id,{...service.get(id),summary:'历史摘要',notes:'历史笔记'});
  await service.action(id,'organize',{folderId:root.id,title:'新标题'}); const t=service.get(id); assert.equal(t.transcript,'源文案'); assert.equal(t.notes,'历史笔记'); assert.equal(t.summary,'历史摘要'); assert.equal(t.folderId,root.id);
  service.folderAction('rename',{id:root.id,name:'文学'}); assert.equal(service.folders().find(f=>f.id===root.id).name,'文学'); await service.close();
  const reopened=new Transcriptions(store,{},ai,path.join(dir,'reopened-folders'),()=>{}); assert.equal(reopened.get(id).folderId,root.id); assert.equal(reopened.folders().find(f=>f.id===child.id).parentId,root.id); await reopened.close(); store.close();
});

test('逐段矫正失败后重启仅补做未完成段，旧候选文案和历史资料保留', async () => {
  const {service,ai,store,id,dir}=await captionFixture();
  const segments=Array.from({length:5},(_,i)=>({start:i*20+0.123,end:i*20+19.456,text:'学习整里资料的方法，先保留原文，再提练关键观点。'.repeat(5)}));
  const original=segments.map(s=>s.text).join('\n');
  store.put('transcription',id,{...service.get(id),transcript:original,segments,correctedTranscript:'旧版完整候选文案',summary:'旧摘要',notes:'旧笔记'});
  ai.save('text',{...ai.config(),outputTokens:500});let calls=0;
  ai.chat=async(_s,body)=>{if(++calls===2)throw Error('模型暂不可用');return JSON.stringify({segments:JSON.parse(body).segments.map(s=>({...s,text:s.text.replaceAll('整里','整理').replaceAll('提练','提炼')}))});};
  await service.action(id,'correct-pair');let t=await settle(service,id);assert.equal(t.status,'ai-failed');assert.equal(t.alignedCorrection.parts.length,1);assert.equal(t.correctedTranscript,'旧版完整候选文案');assert.equal(t.correctedSegments,undefined);
  await service.close();let resumed=0;
  ai.chat=async(_s,body)=>{resumed++;return JSON.stringify({segments:JSON.parse(body).segments.map(s=>({...s,text:s.text.replaceAll('整里','整理').replaceAll('提练','提炼')}))});};
  const restored=new Transcriptions(store,{},ai,path.join(dir,'aligned-restored'),()=>{});await restored.action(id,'retry');t=await settle(restored,id);
  assert.equal(t.status,'ready');assert.equal(resumed,alignedBatches(segments,125).length-1);assert.deepEqual(t.correctedSegments.map(s=>[s.start,s.end]),segments.map(s=>[s.start,s.end]));assert.equal(t.transcript,original);assert.equal(t.summary,'旧摘要');assert.equal(t.notes,'旧笔记');assert.equal(t.correctionHistory[0].text,'旧版完整候选文案');await restored.close();store.close();
});

test('带时间戳多语言翻译关闭重启复用分段，取消后迟到响应不能写成完成', async()=>{
  const {service,ai,store,id,dir}=await captionFixture();let waiting=false;
  ai.chat=async(system,body,signal)=>{if(system.includes('英语'))return JSON.stringify({segments:JSON.parse(body).segments.map(s=>({id:s.id,text:'English source'}))});waiting=true;return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('停止')),{once:true}));};
  await service.action(id,'translate',{sourceKind:'original',format:'timed',languages:['en','ja'],expectedText:service.exportText(id,'timed-txt')});while(!waiting)await new Promise(r=>setTimeout(r,10));await service.close();
  let calls=0;ai.chat=async(system,body)=>{calls++;assert.match(system,/日语/);return JSON.stringify({segments:JSON.parse(body).segments.map(s=>({id:s.id,text:'日本語'}))});};
  const restored=new Transcriptions(store,{},ai,path.join(dir,'variants-restored'),()=>{});await restored.action(id,'retry');let t=await settle(restored,id);assert.equal(t.status,'ready');assert.equal(calls,1);assert.match(t.translationVariants['original:timed:en'].text,/English/);
  let finish;ai.chat=async(_s,body)=>new Promise(r=>{finish=()=>r(JSON.stringify({segments:JSON.parse(body).segments.map(s=>({id:s.id,text:'late result'}))}));});
  await restored.action(id,'translate',{sourceKind:'original',format:'timed',languages:['ko'],expectedText:restored.exportText(id,'timed-txt')});while(!finish)await new Promise(r=>setTimeout(r,10));const stop=restored.action(id,'cancel');finish();await stop;t=restored.get(id);assert.equal(t.status,'cancelled');assert.equal(t.translationVariants['original:timed:ko'].text,undefined);assert.match(t.translationVariants['original:timed:ja'].text,/日本語/);await restored.close();store.close();
});
