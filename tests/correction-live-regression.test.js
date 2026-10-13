import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../electron/store.js';
import { AIService } from '../electron/ai.js';
import { Transcriptions } from '../electron/transcription.js';
import { validateCorrection, correctionVerification, correctionNumbers, correctionStreamText } from '../electron/transcript-correction.js';
import { chunksOf } from '../electron/transcript-text.js';
import { alignedBatches } from '../electron/transcript-alignment.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); }
  throw Error('Expected correction state did not arrive');
}
const frame = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
const finish = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
const encoder = new TextEncoder();
async function fixture(t, request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-correction-test-'));
  const store = await Store.open(dir, {});
  const vault = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const ai = new AIService(store, dir, vault, () => {}, request);
  ai.save('text', { baseUrl: 'http://127.0.0.1:3456/v1', model: 'fixture', apiKey: 'fixture-only' });
  const service = new Transcriptions(store, {}, ai, path.join(dir, 'results'), () => {}, { testing: true });
  t.after(async () => { await service.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, ai, service };
}
async function ready(service, id) { await until(() => !service.active && service.get(id).status !== 'queued'); return service.get(id); }

test('real timed correction chain streams readable persisted preview before completion and preserves source paths', async t => {
  let stream, requested, calls = 0;
  const { store, service, dir } = await fixture(t, async (_url, opts) => {
    calls++; requested = JSON.parse(opts.body);
    const input = JSON.parse(requested.messages[1].content);
    const reply = JSON.stringify({ segments: input.segments.map(s => ({ ...s, text: s.text.replace('整里', '整理') })) });
    const body = new ReadableStream({ start(c) { stream = c; c.enqueue(encoder.encode(frame(reply))); } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const source = '今天整里资料，保留原文共 3 步。';
  const id = service.start({ text: source }).id; await ready(service, id);
  store.put('transcription', id, { ...service.get(id), segments: [{ start: 1.2, end: 9.8, text: source }], sourceFile: 'original.mp4', subtitleFile: 'original.srt', correctedTranscript: '旧有效稿', summary: '旧摘要' });
  await service.action(id, 'correct-pair'); await until(() => stream);
  try {
    assert.equal(requested.stream, true);
    await until(() => service.get(id).correctionPreview?.text);
    const running = service.get(id); assert.equal(running.status, 'correcting');
    assert.equal(running.correctionPreview.text, source.replace('整里', '整理'));
    assert.equal(running.correctionPreview.transcriptionId, id);
    assert.equal(running.correctionPreview.chunk, 1);
    assert.equal(running.correctionPreview.complete, false);
    assert.equal(running.correctionPreview.validation, 'pending');
    assert.equal(running.correctedTranscript, '旧有效稿');
    const snapshot = path.join(dir, 'snapshot'); fs.mkdirSync(snapshot);
    fs.copyFileSync(store.file, path.join(snapshot, 'library.sqlite'));
    const persisted = await Store.open(snapshot, {});
    try { assert.equal(persisted.get('transcription', id).correctionPreview.text, running.correctionPreview.text); } finally { persisted.close(); }
    // A concurrent video lookup saves a newer media path while correction is running.
    service.save({ ...service.get(id), sourceFile: 'new-video.mp4' });
    stream.enqueue(encoder.encode(finish)); stream.close();
    const result = await ready(service, id);
    assert.equal(result.status, 'ready'); assert.equal(calls, 1);
    assert.equal(result.correctedTranscript, source.replace('整里', '整理'));
    assert.equal(result.correctionPreview.complete, true); assert.equal(result.correctionPreview.active, false);
    assert.equal(result.correctionPreview.validation, 'validated');
    assert.equal(result.sourceFile, 'new-video.mp4'); assert.equal(result.subtitleFile, 'original.srt');
    assert.equal(result.transcript, source); assert.equal(result.summary, '旧摘要');
    assert.deepEqual(result.correctedSegments.map(s => [s.start, s.end]), [[1.2, 9.8]]);
    assert.equal(result.correctionHistory[0].text, '旧有效稿');
  } finally { try { stream.close(); } catch {} await service.action(id, 'cancel'); }
});

test('numeric formatting is equivalent and changed quantities or identifiers require review', () => {
  assert.equal(validateCorrection('金额 1,000 元，共 3 项。', '金额 1000 元，共 ３ 项。'), '金额 1000 元，共 ３ 项。');
  assert.equal(correctionVerification('金额 1000 元，共 3 项。', '金额 1001 元，共 3 项。').numbersChanged, true);
  assert.equal(correctionVerification('订单 00123 已完成。', '订单 123 已完成。').numbersChanged, true);
  assert.equal(correctionVerification('金额 1,000 元，共 3 项。', '金额 1000 元，共 ３ 项。').numbersChanged, false);
});

test('spoken Chinese numeric equivalents pass while changed values, order and leading zeros are reviewable', () => {
  for (const [source, reply] of [
    ['遇到意外零点二秒内紧急停手。', '遇到意外 0.2 秒内紧急停手。'],
    ['总共一千一百五十一字，分成三步。', '总共 1151 字，分成 3 步。'],
    ['总共三点五万元，两百人参加。', '总共 35000 元，200 人参加。'],
    ['概率百分之三十，耗时两秒。', '概率百分之30，耗时2秒。'],
    ['WorkBuddy企业版进入大一统时代。', 'WorkBuddy企业版进入大一统时代。'],
  ]) assert.equal(validateCorrection(source, reply), reply);
  for (const [source, reply] of [
    ['零点二秒内紧急停手。', '0.3秒内紧急停手。'], ['三次准备，2次执行。', '2次准备，3次执行。'],
    ['订单零零一二三完成。', '订单123完成。'], ['温度 3 度。', '温度 -3 度。'], ['收益百分之三十。', '收益 31%。'],
    ['一千二元。', '1200元。']
  ]) {
    assert.equal(validateCorrection(source, reply), reply);
    assert.equal(correctionVerification(source, reply).numericStatus, 'requires-review');
  }
  assert.equal(validateCorrection('收益百分之三十。', '收益 30%。'), '收益 30%。');
  assert.equal(validateCorrection('温度负三度，依次三、二、一。', '温度-3度，依次3、2、1。'), '温度-3度，依次3、2、1。');
});

test('plain streaming cancellation clears activity, rejects late callbacks, and retry starts a fresh preview', async t => {
  let stream, calls = 0, cancelled = false;
  const source = '今天整里资料共三步，原文和视频必须保留。';
  const { service, store } = await fixture(t, async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).stream, true); calls++;
    return new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(encoder.encode(frame('今天整理资料共'))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const id = service.start({ text: source }).id; await ready(service, id);
  await service.action(id, 'correct'); await until(() => service.get(id).correctionPreview?.text);
  const startedAt = service.get(id).correctionStartedAt;
  await service.action(id, 'cancel');
  let result = service.get(id);
  assert.equal(cancelled, true); assert.equal(service.active, null); assert.equal(result.progress, 0);
  assert.equal(result.status, 'cancelled'); assert.equal(result.correctionPreview.active, false);
  assert.equal(result.correctionPreview.complete, false); assert.equal(result.correctedTranscript, '');
  assert.equal(result.transcript, source); assert.equal(result.correctionPreview.text, '今天整理资料共');
  assert.throws(() => stream.enqueue(encoder.encode(frame('迟到稿'))));
  service.ai.fetch = async () => new Response(frame(source.replace('整里', '整理').replace('三', '3')) + finish, { headers: { 'content-type': 'text/event-stream' } });
  await service.action(id, 'retry'); result = await ready(service, id);
  assert.equal(result.status, 'ready'); assert.equal(result.correctionPreview.active, false);
  assert.ok(result.correctionStartedAt >= startedAt); assert.equal(calls, 1);
  assert.equal(result.correctedTranscript, source.replace('整里', '整理').replace('三', '3'));
  assert.equal(store.get('transcription', id).transcript, source);
});

test('a complete numeric candidate persists for review without replacing the valid draft', async t => {
  const source = '今天整理资料共3步，原文和视频必须完整保留。';
  const rejected = source.replace('3', '4');
  const { service, store, dir } = await fixture(t, async (_url, opts) => {
    const input = JSON.parse(JSON.parse(opts.body).messages[1].content);
    return new Response(frame(JSON.stringify({ segments: input.segments.map(s => ({ ...s, text: rejected })) })) + finish, { headers: { 'content-type': 'text/event-stream' } });
  });
  const id = service.start({ text: source }).id; await ready(service, id);
  store.put('transcription', id, { ...service.get(id), segments: [{ start: 0, end: 5, text: source }], correctedTranscript: '旧有效稿', sourceFile: 'source.mp4', originalVideoFile: 'source.mp4' });
  await service.action(id, 'correct-pair'); const result = await ready(service, id);
  assert.equal(result.status, 'ready'); assert.equal(result.progress, 100); assert.equal(service.active, null);
  assert.equal(result.correctedTranscript, '旧有效稿'); assert.equal(result.transcript, source);
  assert.equal(result.correctionPreview.text, rejected); assert.equal(result.correctionPreview.validation, 'review-required');
  assert.equal(result.correctionPreview.contentComplete, true); assert.equal(result.correctionPreview.complete, true);
  assert.equal(result.correctionPreview.active, false); assert.equal(result.correctionPreview.requiresReview, true);
  assert.equal(result.correctionCandidate.text, rejected); assert.equal(result.correctionCandidate.requiresReview, true);
  assert.match(result.message, /用户.*核对/); assert.equal(result.originalVideoFile, 'source.mp4');
  await service.close();
  const reopened = new Transcriptions(store, {}, service.ai, path.join(dir, 'reopened'), () => {});
  assert.equal(reopened.get(id).correctionPreview.text, rejected);
  service.ai.fetch = async (_url, opts) => {
    const input = JSON.parse(JSON.parse(opts.body).messages[1].content);
    return new Response(frame(JSON.stringify({ segments: input.segments })) + finish, { headers: { 'content-type': 'text/event-stream' } });
  };
  await reopened.action(id, 'correct-pair', { force: true }); const retried = await ready(reopened, id);
  assert.equal(retried.status, 'ready'); assert.equal(retried.correctedTranscript, source);
  assert.equal(retried.correctionCandidate.text, source);
  await reopened.close();
});

test('a rewrite rejection retains the plain candidate with an explicit unaccepted marker', async t => {
  const source = '今天学习如何整理资料，首先保留全部原文与视频来源，然后检查识别错误，再提炼关键观点，最后保存完整材料，共 3 步。';
  const rejected = '这里讲的是如何制作烘焙蛋糕，首先准备鸡蛋面粉并称好重量，然后打发奶油混合液体，再放入烤箱等待烘焙，最后装盘上桌，共 3 步。';
  const { service } = await fixture(t, async () => new Response(frame(rejected) + finish, { headers: { 'content-type': 'text/event-stream' } }));
  const id = service.start({ text: source }).id; await ready(service, id);
  await service.action(id, 'correct'); const result = await ready(service, id);
  assert.equal(result.status, 'ai-failed'); assert.equal(result.progress, 0); assert.equal(result.correctedTranscript, '');
  assert.equal(result.correctionPreview.text, rejected); assert.equal(result.correctionPreview.validation, 'rejected');
  assert.equal(result.correctionPreview.reason, 'CORRECTION_VALIDATION_FAILED'); assert.match(result.message, /改动过大/);
});

for (const mode of ['sse', 'json']) test(`${mode} response body stall times out after headers and releases correction activity`, async t => {
  let cancelled = false;
  const { service, store, ai } = await fixture(t, async () => new Response(new ReadableStream({ start(c) {
    if (mode === 'sse') c.enqueue(encoder.encode(frame('已经生成的片段')));
  }, cancel() { cancelled = true; } }), { headers: { 'content-type': mode === 'sse' ? 'text/event-stream' : 'application/json' } }));
  store.put('ai-config', 'text', { ...ai.config(), timeout: 0.025 });
  const source = '完整原文必须保留，网络超时允许手工重试。';
  const id = service.start({ text: source }).id; await ready(service, id);
  await service.action(id, 'correct'); const result = await ready(service, id);
  assert.equal(result.status, 'ai-failed'); assert.match(result.message, /超时/);
  assert.equal(result.progress, 0); assert.equal(service.active, null); assert.equal(cancelled, true);
  assert.equal(result.correctionPreview.active, false); assert.equal(result.correctedTranscript, '');
  assert.equal(result.transcript, source);
});

test('timed JSON previews decode partial escaped text and complete objects in either property order', () => {
  const batch = [{ id: 0 }, { id: 1 }];
  assert.equal(correctionStreamText('{"segments":[{"id":0,"text":"正文\\n引号\\"内容\\"\\u4f', batch), '正文\n引号"内容"');
  assert.equal(correctionStreamText('{"segments":[{"text":"正文","id":0},{"text":"下一段","id":1}]}', batch), '正文\n下一段');
  assert.equal(correctionStreamText('{"segments":[{"text":"持续输出的', batch), '持续输出的');
  assert.equal(correctionStreamText('<think>隐私推理', batch), '');
});

for (const mode of ['eof', 'length', 'json-length']) test(`${mode} incomplete output stays visible as unvalidated candidate without being promoted`, async t => {
  const partial = '只返回了部分正文，原稿不能丢失';
  const { service } = await fixture(t, async () => {
    if (mode === 'json-length') return new Response(JSON.stringify({ choices: [{ message: { content: partial }, finish_reason: 'length' }] }));
    const body = mode === 'eof' ? frame(partial) : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: partial }, finish_reason: 'length' }] })}\n\n`;
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const source = '今天整理全部资料，首先保留原始音视频和完整转录，再逐段检查错别字和数字，最后经过人工确认后使用。';
  const id = service.start({ text: source }).id; await ready(service, id);
  await service.action(id, 'correct'); const result = await ready(service, id);
  assert.equal(result.status, 'ai-failed'); assert.equal(result.progress, 0);
  assert.equal(result.correctedTranscript, ''); assert.equal(result.transcript, source);
  assert.equal(result.correctionPreview.validation, 'pending'); assert.equal(result.correctionPreview.contentComplete, false);
  assert.equal(result.correctionCandidate.text, partial); assert.equal(result.correctionCandidate.complete, false);
});

function acceptance(record, text, sourceKind) {
  return { text, transcriptionId: record.id, expectedSourceHash: record.currentSourceHash,
    expectedCandidateHash: sourceKind === 'corrected' ? record.correctedCandidateHash : record.candidateHash,
    ...(sourceKind ? { sourceKind } : {}) };
}

for (const timed of [false, true]) test(`${timed ? 'timed' : 'plain'} numeric change in first chunk collects ALL chunks and saves a reviewable candidate`, async t => {
  const { service, store, ai } = await fixture(t, () => { throw Error('Network must not be used'); });
  ai.save('text', { ...ai.config(), outputTokens: 500 });
  const lines = Array.from({ length: 6 }, (_, i) => `第${i + 1}段材料共3项，今天整里原始资料，逐段保留识别内容和必要上下文，之后检查文字和数字，最后保存全部原话。`.repeat(3));
  const source = lines.join('\n'); const id = service.start({ text: source }).id; await ready(service, id);
  const segments = lines.map((text, i) => ({ start: i * 20 + 0.123, end: i * 20 + 19.456, text }));
  if (timed) store.put('transcription', id, { ...service.get(id), segments });
  let calls = 0;
  ai.chat = async (system, body) => {
    assert.match(system, /ASR 数字也可能识别错误/); calls++;
    const input = JSON.parse(body), correct = s => s.replaceAll('整里', '整理').replaceAll('共3项', '共4项');
    return timed ? JSON.stringify({ segments: input.segments.map(s => ({ ...s, text: correct(s.text) })) }) : correct(input.textToCorrect);
  };
  await service.action(id, timed ? 'correct-pair' : 'correct'); const result = await ready(service, id);
  assert.equal(calls, timed ? alignedBatches(segments, 125).length : chunksOf(source, 200).length);
  assert.ok(calls > 1); assert.equal(result.status, 'ready'); assert.equal(result.correctedTranscript, '');
  assert.equal(result.correctionCandidate.contentComplete, true); assert.equal(result.correctionCandidate.correctionValidated, true);
  assert.equal(result.correctionCandidate.correctionSourceHash, createHash('sha256').update(source).digest('hex'));
  assert.equal(result.correctionCandidate.candidateHash, result.candidateHash);
  assert.match(result.correctionCandidate.text, /第6段/); assert.ok(!result.correctionCandidate.text.includes('共3项'));
  assert.equal(result.correctionCandidate.verification.numericStatus, 'requires-review');
  assert.equal(result.correctionCandidate.verification.factualVerified, false);
  assert.equal(result.transcript, source); if (timed) assert.deepEqual(result.segments, segments);
  await service.action(id, timed ? 'correct-pair' : 'correct'); assert.equal(calls, timed ? alignedBatches(segments, 125).length : chunksOf(source, 200).length);
  const accepted = await service.action(id, 'accept-correction', acceptance(result, result.correctionCandidate.text));
  assert.equal(accepted.correctedTranscript, result.correctionCandidate.text);
  assert.equal(accepted.transcript, source);
});

test('explicit candidate adoption permits edited quantities, preserves milliseconds, history and survives reopening', async t => {
  const { service, store, ai, dir } = await fixture(t, () => { throw Error('Network must not be used'); });
  const source = '今天整里3项资料，保留音视频来源。\n然后检查3处数字，逐段保存完整内容。';
  const id = service.start({ text: source }).id; await ready(service, id);
  const segments = source.split('\n').map((text, i) => ({ start: i * 10 + 0.123, end: i * 10 + 9.456, text }));
  store.put('transcription', id, { ...service.get(id), segments, correctedTranscript: '旧完整校对稿', summary: '旧摘要', notes: '旧笔记' });
  ai.chat = async (_system, body) => JSON.stringify({ segments: JSON.parse(body).segments.map(s => ({ ...s, text: s.text.replace('整里', '整理').replace('3', '4') })) });
  await service.action(id, 'correct-pair'); const candidate = await ready(service, id);
  assert.equal(candidate.correctedTranscript, '旧完整校对稿');
  const edited = candidate.correctionCandidate.text.replaceAll('4', '5');
  const params = acceptance(candidate, edited);
  const result = await service.action(id, 'accept-correction', params);
  assert.equal(result.correctedTranscript, edited); assert.equal(result.confirmedCorrectedTranscript, edited);
  assert.equal(result.manualAccepted, true); assert.equal(result.correctionValidated, true);
  assert.equal(result.correctionVerification.acceptance, 'manual'); assert.equal(result.correctionVerification.factualVerified, false);
  assert.equal(result.transcript, source); assert.deepEqual(result.segments, segments);
  assert.deepEqual(result.correctedSegments.map(s => [s.start, s.end]), segments.map(s => [s.start, s.end]));
  assert.equal(result.correctionHistory.at(-1).text, '旧完整校对稿'); assert.equal(result.summary, '旧摘要'); assert.equal(result.notes, '旧笔记');
  await assert.rejects(service.action(id, 'accept-correction', params), /变化|采用/);
  await service.close(); const reopened = new Transcriptions(store, {}, ai, path.join(dir, 'accepted-reopen'), () => {});
  assert.equal(reopened.get(id).correctedTranscript, edited); assert.equal(reopened.get(id).manualAccepted, true); await reopened.close();
});

test('manual full-source correction works without AI or a candidate and concurrent adoption rejects the loser', async t => {
  const { service, ai } = await fixture(t, () => { throw Error('No model request'); });
  ai.chat = () => { throw Error('No model call'); };
  const source = '今天整里3项资料，原始内容要完整保留。'; const id = service.start({ text: source }).id; await ready(service, id);
  const record = service.get(id), edited = source.replace('整里', '整理').replace('3', '4');
  const params = acceptance(record, edited, 'original');
  const outcomes = await Promise.allSettled([service.action(id, 'accept-correction', params), service.action(id, 'accept-correction', params)]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
  assert.equal(service.get(id).correctedTranscript, edited); assert.equal(service.get(id).transcript, source);
  const accepted = service.get(id);
  await service.action(id, 'accept-correction', acceptance(accepted, edited.replace('4', '5'), 'corrected'));
  assert.equal(service.get(id).correctedTranscript, edited.replace('4', '5'));
});

test('acceptance rejects wrong id, stale source/candidate, empty, partial, omitted or reordered segments', async t => {
  const { service, store, ai } = await fixture(t, () => { throw Error('No network'); });
  const source = '首先完整保留原始音视频来源，再检查3项文字内容。\n然后逐段核对全部识别数据，最后保存完整资料和历史记录。';
  const id = service.start({ text: source }).id; await ready(service, id);
  const segments = source.split('\n').map((text, i) => ({ start: i * 10, end: i * 10 + 9, text }));
  store.put('transcription', id, { ...service.get(id), segments });
  ai.chat = async (_system, body) => JSON.stringify({ segments: JSON.parse(body).segments });
  await service.action(id, 'correct-pair'); let record = await ready(service, id), params = acceptance(record, source);
  for (const patch of [{ transcriptionId: 'other' }, { expectedSourceHash: 'stale' }, { expectedCandidateHash: 'stale' }, { text: '' }, { text: '  ' }, { text: segments[0].text }, { text: segments.map(s => s.text).reverse().join('\n') }]) {
    await assert.rejects(service.action(id, 'accept-correction', { ...params, ...patch }));
    assert.equal(service.get(id).manualAccepted, false);
  }
  store.put('transcription', id, { ...record, transcriptPartial: true });
  await assert.rejects(service.action(id, 'accept-correction', params), /完整原文/);
  store.put('transcription', id, { ...record, status: 'correcting' });
  await assert.rejects(service.action(id, 'accept-correction', params), /正在处理/);
  store.put('transcription', id, { ...record, transcript: source.replace('3', '4') });
  await assert.rejects(service.action(id, 'accept-correction', params), /原文已变化/);
  store.put('transcription', id, { ...record, segments: segments.map(s => ({ ...s, start: s.start + 1 })) });
  await assert.rejects(service.action(id, 'accept-correction', params), /候选/);
});

test('legacy partial candidate cannot be adopted; full original editing is explicitly selectable', async t => {
  const { service, store } = await fixture(t, () => { throw Error('No model request'); });
  const source = '今天先完整保留原始资料，再逐段核对识别文字，最后保存全部结果。';
  const id = service.start({ text: source }).id; await ready(service, id);
  store.put('transcription', id, { ...service.get(id), correctionCandidate: { text: source.slice(0, -2), contentComplete: false }, status: 'ai-failed' });
  const record = service.get(id);
  await assert.rejects(service.action(id, 'accept-correction', acceptance(record, record.correctionCandidate.text)), /完整/);
  const accepted = await service.action(id, 'accept-correction', acceptance(record, source, 'original'));
  assert.equal(accepted.correctedTranscript, source); assert.equal(accepted.manualAccepted, true);
});

test('force restarts a wrong corrected draft, binds fresh hash and permits choosing old corrected text after a rejected new candidate', async t => {
  const { service, ai, store } = await fixture(t, () => { throw Error('No model request'); });
  const source = '今天整里3项资料，完整保留每一项内容与原始来源。';
  const id = service.start({ text: source }).id; await ready(service, id); let calls = 0;
  ai.chat = async (_system, body) => { calls++; return JSON.parse(body).textToCorrect.replace('整里', '整理'); };
  await service.action(id, 'correct'); const first = await ready(service, id);
  assert.equal(first.correctionSourceHash, first.currentSourceHash); assert.equal(first.correctionValidated, true);
  await service.action(id, 'correct'); assert.equal(calls, 1);
  ai.chat = async () => { calls++; return '不完整摘要'; };
  await service.action(id, 'correct', { force: true }); const failed = await ready(service, id);
  assert.equal(calls, 2); assert.equal(failed.status, 'ai-failed'); assert.equal(failed.correctedTranscript, first.correctedTranscript);
  assert.notEqual(failed.correctedCandidateHash, first.correctedCandidateHash);
  const chosen = await service.action(id, 'accept-correction', acceptance(failed, first.correctedTranscript.replace('3', '5'), 'corrected'));
  assert.equal(chosen.correctedTranscript, first.correctedTranscript.replace('3', '5')); assert.equal(chosen.transcript, source);
  assert.equal(store.get('transcription', id).manualAccepted, true);
});

test('plain paragraph correction with many ASR segments accepts full edits without inventing timestamps', async t => {
  const { service, store, ai } = await fixture(t, () => { throw Error('No network request'); });
  const lines = Array.from({ length: 8 }, (_, i) => `第${i + 1}段整里3项资料，完整保留原始来源和每项内容。`);
  const source = lines.join('\n'), id = service.start({ text: source }).id; await ready(service, id);
  const segments = lines.map((text, i) => ({ start: i * 10 + 0.123, end: i * 10 + 9.456, text }));
  store.put('transcription', id, { ...service.get(id), segments,
    correctedTranscript: '旧校对稿', correctedSegments: segments, confirmedCorrectedTranscript: '旧确认稿' });
  ai.chat = async (_system, body) => JSON.parse(body).textToCorrect.replaceAll('整里', '整理').replaceAll('3项', '4项').replaceAll('\n', '');
  await service.action(id, 'correct', { force: true }); const candidate = await ready(service, id);
  assert.equal(candidate.correctionCandidate.phase, 'plain'); assert.equal(candidate.correctionCandidate.contentComplete, true);
  assert.equal(candidate.correctionCandidate.segments.length, 0);
  assert.equal(candidate.correctedTranscript, '旧校对稿');
  const edited = candidate.correctionCandidate.text.replaceAll('4项', '5项');
  const accepted = await service.action(id, 'accept-correction', acceptance(candidate, edited, 'candidate'));
  assert.equal(accepted.correctedTranscript, edited); assert.deepEqual(accepted.correctedSegments, []);
  assert.equal(accepted.confirmedCorrectedTranscript, edited); assert.deepEqual(accepted.segments, segments); assert.equal(accepted.transcript, source);
  await assert.rejects(Promise.resolve().then(() => service.exportText(id, 'corrected-srt')), /尚无带时间戳/);
  const reedited = await service.action(id, 'accept-correction', acceptance(accepted, edited.replaceAll('5项', '6项'), 'corrected'));
  assert.deepEqual(reedited.correctedSegments, []); assert.deepEqual(reedited.segments, segments);
});

for (const timed of [false, true]) test(`${timed ? 'timed' : 'plain'} forced correction cannot roll back manually accepted quantities to ASR numbers`, async t => {
  const { service, ai, store } = await fixture(t, () => { throw Error('No network request'); });
  const source = '今天整里3项资料，完整保留每项内容和原始来源。';
  const id = service.start({ text: source }).id; await ready(service, id);
  if (timed) store.put('transcription', id, { ...service.get(id), segments: [{ start: 0.123, end: 8.456, text: source }] });
  const acceptedText = source.replace('整里', '整理').replace('3项', '4项');
  const accepted = await service.action(id, 'accept-correction', acceptance(service.get(id), acceptedText, 'original'));
  ai.chat = async (_system, body) => {
    const input = JSON.parse(body);
    return timed ? JSON.stringify({ segments: input.segments.map(s => ({ ...s, text: s.text.replace('整里', '整理') })) }) : input.textToCorrect.replace('整里', '整理');
  };
  await service.action(id, timed ? 'correct-pair' : 'correct', { force: true }); const result = await ready(service, id);
  assert.equal(result.correctedTranscript, acceptedText);
  assert.equal(result.confirmedCorrectedTranscript, acceptedText); assert.equal(result.manualAccepted, true);
  assert.deepEqual(result.correctedSegments, accepted.correctedSegments); assert.equal(result.transcript, source);
  const candidate = result.correctionCandidate;
  assert.equal(candidate.text, source.replace('整里', '整理')); assert.equal(candidate.contentComplete, true);
  assert.equal(candidate.validation, 'review-required'); assert.equal(candidate.reason, 'CORRECTION_ACCEPTED_NUMBERS_CHANGED');
  assert.equal(candidate.verification.numbersChanged, true); assert.equal(candidate.verification.sourceNumbersChanged, false);
  assert.equal(candidate.verification.acceptedNumbersChanged, true); assert.deepEqual(candidate.verification.acceptedNumbers, ['4']);
  assert.deepEqual(candidate.verification.acceptedNumericChanges, [{ index: 0, accepted: '4', candidate: '3' }]);
  assert.match(candidate.label, /人工.*数值/); assert.match(result.message, /人工.*数值/);
  const adopted = await service.action(id, 'accept-correction', acceptance(result, candidate.text, 'candidate'));
  assert.equal(adopted.correctedTranscript, candidate.text); assert.equal(adopted.manualAccepted, true);
});

test('single Chinese quantities recognize physical and time units but do not count nonquantity idioms', () => {
  const quantityUnits = ['公里', '米', '秒', '分钟', '小时', '天', '周', '月', '年', '岁', '斤', '公斤', '克', '吨', '升', '毫升'];
  assert.deepEqual(quantityUnits.map(unit => correctionNumbers(`每天记录三${unit}。`)), quantityUnits.map(() => ['3']));
  const check = correctionVerification('每天跑三公里，完整记录运动情况。', '每天跑四公里，完整记录运动情况。');
  assert.equal(check.numbersChanged, true); assert.equal(check.numericStatus, 'requires-review');
  assert.deepEqual(check.numericChanges, [{ index: 0, source: '3', candidate: '4' }]);
  for (const phrase of ['三创内容', '二创作品', '一起出发', '一直前进', '一切顺利', '统一标准', '万物生长']) assert.deepEqual(correctionNumbers(phrase), [], phrase);
});

test('ordinary Chinese classifiers recognize counts including animals and people', () => {
  for (const [source, reply] of [
    ['院子里有一只猫。', '院子里有两只猫。'], ['今天来了三个人。', '今天来了四个人。'],
    ['这里生活着一只动物。', '这里生活着两只动物。'], ['收到三张照片。', '收到四张照片。'],
    ['准备一杯水。', '准备两杯水。'], ['一辆车停在门口。', '两辆车停在门口。'],
    ['书架上有三册书。', '书架上有四册书。'], ['墙上挂着一幅画。', '墙上挂着两幅画。']
  ]) {
    assert.equal(validateCorrection(source, reply), reply);
    assert.equal(correctionVerification(source, reply).numbersChanged, true, source);
    assert.equal(correctionNumbers(source).length, 1, source);
  }
  assert.deepEqual(correctionNumbers('一只猫和三个人一起出发，一直前进，一切顺利，随后做二创。'), ['1', '3']);
});

test('single Chinese kilometre correction persists a candidate instead of silently saving corrected text', async t => {
  const { service, ai } = await fixture(t, () => { throw Error('No network request'); });
  const source = '每天跑三公里，完整记录运动情况和原始数据。';
  const id = service.start({ text: source }).id; await ready(service, id);
  ai.chat = async (_system, body) => JSON.parse(body).textToCorrect.replace('三公里', '四公里');
  await service.action(id, 'correct'); const result = await ready(service, id);
  assert.equal(result.correctedTranscript, ''); assert.equal(result.correctionCandidate.text, source.replace('三公里', '四公里'));
  assert.equal(result.correctionCandidate.validation, 'review-required'); assert.equal(result.correctionCandidate.contentComplete, true);
});
