import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVideoArticle } from '../electron/video-article.js';

// All service boundaries are mocks. Only this fixture's temporary directory is written.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWy0AAAAASUVORK5CYII=', 'base64');
const auditOK = JSON.stringify({ faithful: true, issues: [] });
function plan() {
  return { title: '设备检查', pages: [
    { title: '检查方法', text: '先检查设备。', imagePrompt: '暖色手绘，说明检查设备。' },
    { title: '调整方法', text: '根据实际使用调整。', imagePrompt: '暖色手绘，说明合理调整。' },
    { title: '保持习惯', text: '保持合理习惯。', imagePrompt: '暖色手绘，说明日常习惯。' }
  ], styleDescription: '暖色手绘' };
}
function imageResponse() {
  return { ok: true, text: async () => JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) };
}
function fixture(t, article = plan()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-article-fact-preview-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = { directory, article, previews: [], checkpoints: [], chats: [], requests: [], decodes: [] };
  const ai = {
    config(kind) {
      return kind === 'image'
        ? { hasKey: true, model: 'mock-image', baseUrl: 'https://cpa.fengsha.online/v1', timeout: 30 }
        : { model: 'mock-text', protocol: 'chat' };
    },
    secret: () => 'fixture-only-key',
    async chat(system, content, signal, onText) {
      const phase = system.includes('VIDEO_ARTICLE_FACT_AUDIT') ? 'audit' : 'writing';
      f.chats.push({ phase, system, content });
      if (phase === 'audit') return f.audit ? f.audit({ system, content, signal }) : auditOK;
      if (f.write) return f.write({ system, content, signal, onText });
      const reply = JSON.stringify(f.article);
      onText?.(reply);
      return reply;
    },
    fetch() { throw Error('Unexpected unmocked service request'); }
  };
  f.args = { ai, directory,
    source: { title: article.title, text: article.pages.map(p => p.text).join('\n'), file: '' },
    options: { reference: 'corrected', style: '暖色手绘', pageCount: 3, outputLanguage: 'source' },
    samples: () => { throw Error('Unexpected video sampling'); },
    onPreview: snapshot => f.previews.push(structuredClone(snapshot)),
    onCheckpoint: async snapshot => {
      f.checkpoints.push(structuredClone(snapshot));
      await f.checkpoint?.(snapshot);
    },
    fetcher: async (url, init) => {
      f.requests.push({ url, init });
      return f.fetch ? f.fetch({ url, init, number: f.requests.length }) : imageResponse();
    },
    imageDecoder: async bytes => {
      f.decodes.push(bytes);
      return f.decode ? f.decode(bytes, f.decodes.length) : Buffer.from(png);
    }
  };
  return f;
}
function streamingEvents(f) {
  return f.previews.filter(p => p.stage === 'writing' && p.validation.structure === 'pending' && p.pages.length);
}
function streamPrefixes(f, reply, prefixes) {
  // ai.chat's callback receives the cumulative response, never individual deltas.
  f.write = async ({ onText }) => {
    let previous = '';
    for (const prefix of prefixes) {
      assert.ok(prefix.startsWith(previous), 'mock callbacks must contain cumulative prefixes');
      assert.ok(reply.startsWith(prefix), 'mock prefix must belong to the final JSON');
      onText(prefix); previous = prefix;
    }
    if (previous !== reply) onText(reply);
    return reply;
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
function hasLoneSurrogate(text) {
  for (const character of text) {
    if (character.length === 1 && /[\uD800-\uDFFF]/.test(character)) return true;
  }
  return false;
}
function publicSnapshot(snapshot) {
  const { title, text, pages, validated, validation, contentComplete, generatedCount, activePageIndex } = snapshot;
  return { title, text, pages, validated, validation, contentComplete, generatedCount, activePageIndex };
}

test('累计JSON预览接受不同根字段和页字段顺序，页序与定稿id一致', async t => {
  for (const order of ['title-first', 'pages-first', 'metadata-first']) {
    await t.test(order, async t => {
      const a = plan(), pages = a.pages.map(p => ({ imagePrompt: p.imagePrompt, text: p.text, title: p.title }));
      const raw = order === 'title-first' ? { title: a.title, pages, styleDescription: a.styleDescription }
        : order === 'pages-first' ? { pages, styleDescription: a.styleDescription, title: a.title }
        : { metadata: { enabled: true }, styleDescription: a.styleDescription, pages, title: a.title };
      const reply = JSON.stringify(raw), f = fixture(t, a);
      streamPrefixes(f, reply, Array.from({ length: reply.length }, (_, i) => reply.slice(0, i + 1)));
      const result = await createVideoArticle(f.args), live = streamingEvents(f).at(-1);
      assert.ok(live); assert.equal(live.title, a.title); assert.equal(live.validated, false);
      assert.deepEqual(live.pages.map(p => [p.index, p.title, p.text]), a.pages.map((p, i) => [i + 1, p.title, p.text]));
      for (const snapshot of streamingEvents(f)) assert.deepEqual(snapshot.pages.map(p => p.index), snapshot.pages.map((_, i) => i + 1));
      const finalized = f.previews.filter(p => p.validation.structure === 'passed');
      assert.ok(finalized.length);
      for (const snapshot of finalized) assert.deepEqual(snapshot.pages.map(p => p.id), result.pages.map(p => p.id));
      assert.equal(new Set(result.pages.map(p => p.id)).size, 3);
    });
  }
});

test('未知嵌套title/text和imagePrompt内的JSON不会进入可读标题正文', async t => {
  const a = plan(), hidden = 'HIDDEN_NESTED_TITLE', prompt = 'HIDDEN_IMAGE_PROMPT';
  const reply = JSON.stringify({ metadata: { title: hidden, text: hidden }, pages: a.pages.map(p => ({
    metadata: { title: hidden, text: hidden }, imagePrompt: `${prompt} ${JSON.stringify({ title: hidden, text: hidden })}`,
    text: p.text, title: p.title
  })), title: a.title });
  const f = fixture(t, a);
  streamPrefixes(f, reply, Array.from({ length: reply.length }, (_, i) => reply.slice(0, i + 1)));
  await createVideoArticle(f.args);
  for (const snapshot of f.previews) {
    assert.doesNotMatch(snapshot.text, /HIDDEN_|imagePrompt|"pages"/);
    assert.doesNotMatch([snapshot.title, ...snapshot.pages.flatMap(p => [p.title, p.text])].join('\n'), /HIDDEN_/);
  }
  // A finalized page is a complete plan and may retain its imagePrompt property.
  assert.match(f.previews.at(-1).pages[0].imagePrompt, /HIDDEN_IMAGE_PROMPT/);
});

test('合法尾反斜杠在字符串未闭合与闭合后均保留，不丢掉整段正文', async t => {
  const a = plan(); a.pages[0].text = '正文末尾\\';
  const f = fixture(t, a), reply = JSON.stringify(a);
  const marker = JSON.stringify(a.pages[0].text), end = reply.indexOf(marker) + marker.length;
  streamPrefixes(f, reply, [reply.slice(0, end - 1), reply.slice(0, end)]);
  await createVideoArticle(f.args);
  const live = streamingEvents(f);
  assert.equal(live[0].pages[0].text, a.pages[0].text);
  assert.equal(live[1].pages[0].text, a.pages[0].text);
  assert.ok(live[0].text.includes(a.pages[0].text));
});

test('不完整unicode转义保留已解码前缀，完成后恢复中文字符', async t => {
  const a = plan(); a.pages[0].text = '正文生长';
  const f = fixture(t, a), reply = JSON.stringify(a).replace('正文生长', '正文\\u751f长');
  const at = reply.indexOf('\\u751f');
  streamPrefixes(f, reply, [1, 2, 3, 4, 5, 6].map(length => reply.slice(0, at + length)));
  await createVideoArticle(f.args);
  const live = streamingEvents(f);
  for (const snapshot of live.slice(0, 5)) {
    assert.equal(snapshot.pages[0].text, '正文'); assert.doesNotMatch(snapshot.text, /\\u/);
  }
  assert.equal(live[5].pages[0].text, '正文生');
  assert.equal(live.at(-1).pages[0].text, '正文生长');
});

test('emoji代理对跨累计回调切分时不展示半代理，完成后恢复原emoji', async t => {
  for (const encoding of ['escaped', 'literal']) {
    await t.test(encoding, async t => {
      const a = plan(); a.pages[0].text = '正文😀结束';
      const f = fixture(t, a), reply = encoding === 'escaped'
        ? JSON.stringify(a).replace('😀', '\\uD83D\\uDE00') : JSON.stringify(a);
      const at = reply.indexOf(encoding === 'escaped' ? '\\uD83D' : '😀');
      const lengths = encoding === 'escaped' ? [6, 7, 8, 9, 10, 11, 12] : [1, 2];
      streamPrefixes(f, reply, lengths.map(length => reply.slice(0, at + length)));
      await createVideoArticle(f.args);
      const live = streamingEvents(f);
      for (const snapshot of live) {
        assert.equal(hasLoneSurrogate(snapshot.text), false, 'readable preview must not contain lone UTF-16 surrogates');
        for (const page of snapshot.pages) assert.equal(hasLoneSurrogate(page.text), false);
      }
      for (const snapshot of live.slice(0, lengths.length - 1)) assert.equal(snapshot.pages[0].text, '正文');
      assert.equal(live[lengths.length - 1].pages[0].text, '正文😀');
      assert.equal(live.at(-1).pages[0].text, a.pages[0].text);
    });
  }
});

test('根与各页contentComplete按对象闭合独立变化，完整JSON仍未校验', async t => {
  const a = plan(), f = fixture(t, a), reply = JSON.stringify(a);
  const pageEnd = reply.indexOf(JSON.stringify(a.pages[0])) + JSON.stringify(a.pages[0]).length;
  streamPrefixes(f, reply, [reply.slice(0, pageEnd - 1), reply.slice(0, pageEnd), reply.slice(0, -1), reply]);
  await createVideoArticle(f.args);
  const live = streamingEvents(f);
  assert.equal(live[0].contentComplete, false); assert.equal(live[0].pages[0].contentComplete, false);
  assert.equal(live[1].contentComplete, false); assert.equal(live[1].pages[0].contentComplete, true);
  assert.equal(live[2].contentComplete, false); assert.ok(live[2].pages.every(p => p.contentComplete));
  assert.equal(live[3].contentComplete, true); assert.equal(live[3].validated, false);
  assert.deepEqual(live[3].validation, { structure: 'pending', numeric: 'pending', audit: 'pending' });
});

test('流式pages也提供imageStatus，默认关闭为skipped，开启为pending', async t => {
  for (const generateImages of [false, true]) {
    await t.test(String(generateImages), async t => {
      const f = fixture(t); f.args.options.generateImages = generateImages;
      await createVideoArticle(f.args);
      const live = streamingEvents(f).at(-1);
      assert.ok(live.pages.length);
      assert.deepEqual(live.pages.map(p => p.imageStatus), Array(3).fill(generateImages ? 'pending' : 'skipped'));
    });
  }
});

test('校验和配图阶段保留全部标题正文，按页更新生成状态与计数', async t => {
  const f = fixture(t); f.args.options.generateImages = true;
  const result = await createVideoArticle(f.args), expectedText = [result.title, result.body].join('\n\n');
  const snapshots = f.previews.filter(p => p.validation.structure === 'passed');
  assert.ok(snapshots.some(p => p.stage === 'validating'));
  assert.ok(snapshots.some(p => p.stage === 'images')); assert.equal(snapshots.at(-1).stage, 'complete');
  for (const snapshot of snapshots) {
    assert.equal(snapshot.title, result.title); assert.equal(snapshot.text, expectedText);
    assert.deepEqual(snapshot.pages.map(p => p.text), result.pages.map(p => p.text));
    assert.ok(snapshot.contentComplete); assert.ok(snapshot.pages.every(p => p.contentComplete));
    if (snapshot.stage === 'validating') assert.equal(snapshot.validated, false);
    if (['images', 'complete'].includes(snapshot.stage)) {
      assert.equal(snapshot.validated, true);
      assert.deepEqual(snapshot.validation, { structure: 'passed', numeric: 'passed', audit: 'passed' });
    }
  }
  const generating = f.previews.filter(p => p.stage === 'images' && p.activePageIndex);
  assert.deepEqual(generating.map(p => p.activePageIndex), [1, 2, 3]);
  for (const snapshot of generating) assert.deepEqual(snapshot.pages.map(p => p.imageStatus),
    snapshot.pages.map(p => p.index < snapshot.activePageIndex ? 'completed' : p.index === snapshot.activePageIndex ? 'generating' : 'pending'));
  assert.deepEqual(f.checkpoints.map(p => p.generatedCount), [0, 1, 2, 3]);
  assert.deepEqual(f.previews.at(-1).pages.map(p => p.imageStatus), ['completed', 'completed', 'completed']);
});

test('数字失败定位missing/added并返回同形候选快照，禁止checkpoint和复核', async t => {
  const a = plan(); a.pages[0].text = '耗时2秒。';
  const f = fixture(t, a); f.args.source.text = '耗时0.2秒。'; f.args.options.generateImages = true;
  await assert.rejects(createVideoArticle(f.args), e => {
    assert.equal(e.code, 'VIDEO_ARTICLE_FACTS_CHANGED'); assert.equal(e.partial, undefined);
    const missing = e.numericIssues.find(i => i.kind === 'missing' && i.token === '0.2|秒');
    const added = e.numericIssues.find(i => i.kind === 'added' && i.token === '2|秒');
    assert.ok(missing?.excerpt); assert.equal(missing.location, 'source.text'); assert.equal(missing.pageIndex, undefined);
    assert.ok(added?.excerpt); assert.equal(added.pageIndex, 1); assert.equal(added.location, 'article.pages[0].text');
    assert.deepEqual(e.auditIssues, []); assert.equal(e.candidatePreview.validated, false);
    assert.equal(e.candidatePreview.validation.numeric, 'failed'); assert.equal(e.candidatePreview.contentComplete, true);
    assert.deepEqual(publicSnapshot(e.candidatePreview), publicSnapshot(f.previews.at(-1)));
    return true;
  });
  assert.equal(f.checkpoints.length, 0); assert.equal(f.requests.length, 0);
  assert.deepEqual(f.chats.map(c => c.phase), ['writing']); assert.deepEqual(filesUnder(f.directory), []);
});

test('事实拒绝保留auditIssues和完整未经采纳候选，原文不变', async t => {
  const f = fixture(t), source = structuredClone(f.args.source), issues = ['检查顺序被改写成相反结论'];
  f.audit = async () => JSON.stringify({ faithful: false, issues }); f.args.options.generateImages = true;
  await assert.rejects(createVideoArticle(f.args), e => {
    assert.equal(e.code, 'VIDEO_ARTICLE_FACTS_CHANGED'); assert.deepEqual(e.numericIssues, []);
    assert.deepEqual(e.auditIssues, issues); assert.equal(e.partial, undefined);
    assert.equal(e.candidatePreview.validated, false); assert.equal(e.candidatePreview.validation.audit, 'failed');
    assert.deepEqual(e.candidatePreview.pages.map(p => p.text), f.article.pages.map(p => p.text));
    assert.deepEqual(publicSnapshot(e.candidatePreview), publicSnapshot(f.previews.at(-1)));
    return true;
  });
  assert.deepEqual(f.args.source, source); assert.equal(f.checkpoints.length, 0); assert.equal(f.requests.length, 0);
});

test('复核取消后迟到faithful=true不能变成checkpoint或可保存partial', { timeout: 5000 }, async t => {
  const f = fixture(t), controller = new AbortController(), entered = deferred(), release = deferred();
  f.args.signal = controller.signal; f.args.options.generateImages = true;
  f.audit = async () => { entered.resolve(); await release.promise; return auditOK; };
  const pending = createVideoArticle(f.args);
  const rejection = assert.rejects(pending, e => {
    assert.equal(e.name, 'AbortError'); assert.equal(e.partial, undefined);
    assert.equal(e.candidatePreview.validated, false); assert.equal(e.candidatePreview.contentComplete, true);
    assert.equal(e.candidatePreview.validation.audit, 'cancelled'); return true;
  });
  await entered.promise; controller.abort(); const previewCount = f.previews.length;
  release.resolve(); await rejection;
  assert.equal(f.previews.length, previewCount); assert.equal(f.checkpoints.length, 0);
  assert.equal(f.requests.length, 0); assert.deepEqual(filesUnder(f.directory), []);
});

test('取消后迟到图片响应、响应正文或解码成功均不写入迟到图', { timeout: 10000 }, async t => {
  for (const boundary of ['request', 'response-body', 'decoder']) {
    for (const delayedPage of [1, 2]) {
      await t.test(`${boundary}, page ${delayedPage}`, async t => {
        const f = fixture(t), controller = new AbortController(), entered = deferred(), release = deferred();
        f.args.signal = controller.signal; f.args.options.generateImages = true;
        f.fetch = async ({ number }) => {
          if (number !== delayedPage || boundary === 'decoder') return imageResponse();
          if (boundary === 'request') { entered.resolve(); await release.promise; return imageResponse(); }
          return { ok: true, text: async () => { entered.resolve(); await release.promise; return imageResponse().text(); } };
        };
        f.decode = async (bytes, number) => {
          if (boundary === 'decoder' && number === delayedPage) { entered.resolve(); await release.promise; }
          return Buffer.from(png);
        };
        const pending = createVideoArticle(f.args);
        const rejection = assert.rejects(pending, e => {
          assert.equal(e.name, 'AbortError'); assert.equal(e.partial.generatedCount, delayedPage - 1);
          assert.equal(e.partial.pages[delayedPage - 1].imageFile, undefined);
          assert.equal(e.candidatePreview.validated, true);
          assert.equal(e.candidatePreview.pages[delayedPage - 1].imageStatus, 'cancelled');
          for (const page of e.partial.pages.slice(0, delayedPage - 1)) assert.ok(fs.readFileSync(page.imageFile).equals(png));
          return true;
        });
        await entered.promise; controller.abort(); const previewCount = f.previews.length;
        release.resolve(); await rejection;
        assert.equal(f.previews.length, previewCount); assert.equal(f.requests.length, delayedPage);
        assert.deepEqual(f.checkpoints.map(p => p.generatedCount), Array.from({ length: delayedPage }, (_, i) => i));
        const files = filesUnder(f.directory); assert.equal(files.length, delayedPage - 1);
        assert.ok(files.every(file => path.extname(file) === '.png'));
      });
    }
  }
});

test('首次和图片checkpoint异常阻止后续图片请求，partial仅含已校验已落盘内容', async t => {
  for (const failedCount of [0, 1, 2]) {
    for (const asynchronous of [false, true]) {
      await t.test(`checkpoint ${failedCount}, ${asynchronous ? 'async' : 'sync'} rejection`, async t => {
        const f = fixture(t), failure = Object.assign(Error('fixture checkpoint failed'), { code: 'FIXTURE_CHECKPOINT_FAILED' });
        f.args.options.generateImages = true;
        // Exercise onCheckpoint itself as either a synchronous throw or a rejected promise.
        f.args.onCheckpoint = snapshot => {
          f.checkpoints.push(structuredClone(snapshot));
          if (snapshot.generatedCount !== failedCount) return;
          if (asynchronous) return Promise.reject(failure);
          throw failure;
        };
        await assert.rejects(createVideoArticle(f.args), e => {
          assert.equal(e, failure); assert.equal(e.partial.generatedCount, failedCount);
          assert.equal(e.candidatePreview.validated, true); assert.equal(e.candidatePreview.validation.audit, 'passed');
          assert.equal(e.partial.pages.filter(p => p.imageFile).length, failedCount);
          for (const page of e.partial.pages.filter(p => p.imageFile)) assert.ok(fs.readFileSync(page.imageFile).equals(png));
          return true;
        });
        assert.equal(f.requests.length, failedCount);
        assert.deepEqual(f.checkpoints.map(p => p.generatedCount), Array.from({ length: failedCount + 1 }, (_, i) => i));
        assert.equal(filesUnder(f.directory).length, failedCount);
        assert.equal(f.previews.some(p => p.stage === 'complete'), false);
      });
    }
  }
});

test('规划或复核上游异常自带未校验partial时必须清除，候选保持展示用途', async t => {
  for (const phase of ['writing', 'audit']) {
    await t.test(phase, async t => {
      const f = fixture(t), failure = Object.assign(Error('fixture upstream failure'), { partial: {
        title: 'ROGUE_UNVERIFIED', body: 'ROGUE_UNVERIFIED', pages: [{ title: 'ROGUE_UNVERIFIED', text: 'ROGUE_UNVERIFIED' }]
      } });
      f.args.options.generateImages = true;
      if (phase === 'writing') f.write = async ({ onText }) => { onText(JSON.stringify(f.article)); throw failure; };
      else f.audit = async () => { throw failure; };
      await assert.rejects(createVideoArticle(f.args), e => {
        assert.equal(e, failure); assert.equal(e.partial, undefined); assert.equal(Object.hasOwn(e, 'partial'), false);
        assert.equal(e.candidatePreview.validated, false); assert.doesNotMatch(e.candidatePreview.text, /ROGUE_UNVERIFIED/);
        assert.ok(Array.isArray(e.numericIssues)); assert.ok(Array.isArray(e.auditIssues));
        if (phase === 'audit') assert.equal(e.candidatePreview.validation.audit, 'error');
        return true;
      });
      assert.equal(f.checkpoints.length, 0); assert.equal(f.requests.length, 0); assert.deepEqual(filesUnder(f.directory), []);
    });
  }
});

test('outputLanguage chinese/source传递到规划和复核，非法值在调用前拒绝', async t => {
  for (const outputLanguage of ['chinese', 'source']) {
    await t.test(outputLanguage, async t => {
      const f = fixture(t); f.args.options.outputLanguage = outputLanguage;
      await createVideoArticle(f.args);
      assert.deepEqual(f.chats.map(c => c.phase), ['writing', 'audit']);
      for (const call of f.chats) assert.equal(JSON.parse(call.content).outputLanguage, outputLanguage);
      assert.match(f.chats[0].system, outputLanguage === 'chinese' ? /简体中文/ : /源语言/);
      assert.match(f.chats[1].system, outputLanguage === 'chinese' ? /简体中文/ : /源语言/);
    });
  }
  const f = fixture(t); f.args.options.outputLanguage = 'unknown';
  await assert.rejects(createVideoArticle(f.args), /语言/);
  assert.equal(f.chats.length, 0); assert.equal(f.checkpoints.length, 0); assert.equal(f.requests.length, 0);
});
