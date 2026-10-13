import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoArticle } from '../electron/video-article.js';

// All services are in-memory mocks. No directories, media, user data or network.
function fixture(sourceText, candidateText, { audit, reference = 'corrected', outputLanguage = 'chinese', candidateTitle = '图文说明' } = {}) {
  const article = { title: candidateTitle, pages: ['开篇', '事实', '结语'].map((title, i) => ({
    title, text: i === 1 ? candidateText : '请结合原文理解。', imagePrompt: '简洁科普插画。'
  })) };
  const calls = [], previews = [], checkpoints = [];
  const source = { title: '<em>2026</em> 第99期', description: '播放量12345，属于背景元数据。', text: sourceText };
  const originalSource = structuredClone(source);
  const forbidden = () => { assert.fail('本测试不得请求网络、采样媒体或生成图片'); };
  const args = {
    source, options: { reference, outputLanguage, pageCount: 3, generateImages: false },
    ai: {
      config(kind) { assert.equal(kind, 'text'); return { protocol: 'chat', model: 'in-memory-fixture' }; },
      secret: forbidden,
      async chat(system, content, signal, onText) {
        const stage = system.includes('VIDEO_ARTICLE_FACT_AUDIT') ? 'audit' : 'writing';
        calls.push({ stage, system, input: JSON.parse(content) });
        const reply = JSON.stringify(stage === 'audit' ? (audit ?? { faithful: true, issues: [] }) : article);
        onText?.(reply);
        return reply;
      }
    },
    samples: forbidden, fetcher: forbidden, imageDecoder: forbidden,
    onPreview: preview => previews.push(structuredClone(preview)),
    onCheckpoint: checkpoint => checkpoints.push(structuredClone(checkpoint))
  };
  return { args, article, calls, previews, checkpoints, originalSource };
}

function assertCandidate(error, f, validation) {
  assert.equal(error.code, 'VIDEO_ARTICLE_FACTS_CHANGED');
  assert.equal(error.partial, undefined, '未通过事实校验的候选不得成为可保存 partial');
  const candidate = error.candidatePreview;
  assert.equal(candidate.title, f.article.title);
  assert.equal(candidate.validated, false);
  assert.equal(candidate.contentComplete, true);
  assert.deepEqual(candidate.pages.map(({ title, text, imagePrompt }) => ({ title, text, imagePrompt })), f.article.pages);
  assert.equal(candidate.text, [f.article.title, ...f.article.pages.map(p => `${p.title}\n${p.text}`)].join('\n\n'));
  assert.deepEqual(candidate.validation, validation);
  assert.equal(f.checkpoints.length, 0);
  assert.deepEqual(f.args.source, f.originalSource);
}

async function assertAccepted(f) {
  const result = await createVideoArticle(f.args);
  assert.deepEqual(result.pages.map(({ title, text, imagePrompt }) => ({ title, text, imagePrompt })), f.article.pages);
  assert.equal(result.generatedCount, 0);
  assert.deepEqual(f.calls.map(call => call.stage), ['writing', 'audit']);
  assert.equal(f.calls[1].input.source, f.originalSource.text);
  assert.equal(f.calls[1].input.outputLanguage, f.args.options.outputLanguage);
  assert.equal(f.checkpoints.length, 1);
  assert.deepEqual(f.args.source, f.originalSource);
  assert.ok(f.previews.some(p => p.validated && p.validation.numeric === 'passed' && p.validation.audit === 'passed'));
}

const equivalentCases = [
  ['一千克保留为1公斤，单位千不作为1000', '样本重一千克。', '样本重1公斤。'],
  ['3千米保留为3公里', '路线长3千米。', '路线长3公里。'],
  ['一千元里的千确实是数值倍率', '费用为一千元。', '费用为1000元。'],
  ['12年翻译为12 years', '研究经验为12年。', 'The research experience is 12 years.'],
  ['百分之三十翻译为thirty percent', '比例为百分之三十。', 'The proportion is thirty percent.'],
  ['thirty percent翻译为百分之三十', 'The proportion is thirty percent.', '比例为百分之三十。'],
  ['3 per cent翻译为百分之三', 'The proportion is 3 per cent.', '比例为百分之三。'],
  ['one million users翻译为100万用户', 'There are one million users.', '共有100万用户。'],
  ['two kilograms翻译为两公斤', 'The sample weighs two kilograms.', '样本重两公斤。'],
  ['泛指a person翻译为一个人不得假新增', 'A person can understand the explanation.', '一个人可以理解这段解释。'],
  ['真实候选措辞一种压缩方案和一条线索不作为计数', 'Both methods are essentially trying to learn a compression scheme.', '两者本质上都在尝试学习一种压缩方案，这是一条线索。'],
  ['真实候选下一个词和一个比喻不作为计数', 'By predicting the next word, you learn the structure of the data.', '通过预测下一个词，可以学习数据结构；这是一个比喻。'],
  ['negative three degrees翻译为负三度', 'The temperature is negative three degrees.', '温度为负三度。'],
  ['zero point two seconds翻译为零点二秒', 'It stops within zero point two seconds.', '它在零点二秒内停止。']
];
for (const [name, source, candidate] of equivalentCases) {
  test(`数字单位等价：${name}`, async () => {
    await assertAccepted(fixture(source, candidate, { outputLanguage: /years|percent/.test(candidate) ? 'source' : 'chinese' }));
  });
}

// Each marker has a same-value control and a changed-value rejection. This rules
// out implementations that either erase the marker's quantity or reject it all.
const markerCases = [
  ['只有一种方案。', '只有两种方案。'],
  ['只有一条路线。', '只有两条路线。'],
  ['共一个样本。', '共两个样本。'],
  ['总共一种方案。', '总共两种方案。'],
  ['总共一条路线。', '总共两条路线。'],
  ['总共一个样本。', '总共两个样本。'],
  ['数量为一种药物。', '数量为两种药物。'],
  ['数量是一个样本。', '数量是两个样本。']
];
for (const [source, changed] of markerCases) {
  test(`明确量化保留：${source}`, async () => { await assertAccepted(fixture(source, source)); });
  test(`明确量化改值必须拒绝：${source} -> ${changed}`, async () => {
    await assertNumericRejected(fixture(source, changed), [
      { kind: 'missing', token: '1' }, { kind: 'added', token: '2' }
    ]);
  });
}

// Plain concrete counts must stay protected without adding 只有/总共 markers.
// 'source' keeps these same-language cases independent of the Chinese-output
// contract, so a language-option failure cannot hide a counting regression.
const concreteCountCases = [
  ['英文robot', 'One robot performs the task.', 'Two robots perform the task.', 'Robots perform the task.'],
  ['中文机器人', '一个机器人参与任务。', '两个机器人参与任务。', '机器人参与任务。'],
  ['中文猫', '一只猫在休息。', '两只猫在休息。', '猫在休息。'],
  ['中文医生', '一位医生参与会诊。', '两位医生参与会诊。', '医生参与会诊。'],
  ['中文设备', '一台设备正在运行。', '两台设备正在运行。', '设备正在运行。'],
  ['中文书', '一本书放在桌上。', '两本书放在桌上。', '书放在桌上。']
];
for (const [name, source, changed, withoutCount] of concreteCountCases) {
  test(`新增计数边界同值通过：${name}`, async () => {
    await assertAccepted(fixture(source, source, { outputLanguage: 'source' }));
  });
  test(`新增计数边界改值拒绝：${name}`, async () => {
    await assertNumericRejected(fixture(source, changed, { outputLanguage: 'source' }),
      [{ kind: 'missing', token: '1' }, { kind: 'added', token: '2' }]);
  });
  test(`新增计数边界删数拒绝：${name}`, async () => {
    await assertNumericRejected(fixture(source, withoutCount, { outputLanguage: 'source' }),
      [{ kind: 'missing', token: '1' }]);
  });
  test(`新增计数边界添数拒绝：${name}`, async () => {
    await assertNumericRejected(fixture(withoutCount, source, { outputLanguage: 'source' }),
      [{ kind: 'added', token: '1' }]);
  });
}

test('新增计数边界泛指通过：a robot -> 一个机器人', async () => {
  await assertAccepted(fixture('A robot can perform the task.', '一个机器人可以执行任务。'));
});

test('新增计数边界明确英文同值：one robot -> 一个机器人', async () => {
  await assertAccepted(fixture('One robot performs the task.', '一个机器人执行任务。'));
});

test('新增计数边界only one同值：only one robot -> 只有一个机器人', async () => {
  await assertAccepted(fixture('Only one robot performs the task.', '只有一个机器人执行任务。'));
});

test('新增计数边界only one改值：only one robot -> 只有两个机器人', async () => {
  await assertNumericRejected(fixture('Only one robot performs the task.', '只有两个机器人执行任务。'),
    [{ kind: 'missing', token: '1' }, { kind: 'added', token: '2' }]);
});

test('新增计数边界only one删数：only one robot -> 机器人', async () => {
  await assertNumericRejected(fixture('Only one robot performs the task.', '机器人执行任务。'),
    [{ kind: 'missing', token: '1' }]);
});

async function assertNumericRejected(f, expectedIssues) {
  let failure;
  try { await createVideoArticle(f.args); } catch (error) { failure = error; }
  assert.ok(failure, '真实数字变化必须拒绝，不能由mock faithful=true放行');
  assertCandidate(failure, f, { structure: 'passed', numeric: 'failed', audit: 'pending' });
  assert.deepEqual(failure.auditIssues, []);
  assert.ok(failure.numericIssues.length > 0);
  for (const expected of expectedIssues) {
    const issue = failure.numericIssues.find(i => i.kind === expected.kind && i.token === expected.token);
    assert.ok(issue, `缺少诊断 ${JSON.stringify(expected)}；实际 ${JSON.stringify(failure.numericIssues)}`);
    assert.equal(issue.location, expected.kind === 'missing' ? 'source.text' : (expected.location ?? 'article.pages[1].text'));
    assert.equal(typeof issue.excerpt, 'string');
    assert.ok(issue.excerpt.trim());
    if (expected.kind === 'added') {
      if (issue.location === 'article.title') assert.equal(issue.pageIndex, undefined);
      else assert.equal(issue.pageIndex, 2);
    } else assert.equal(issue.pageIndex, undefined);
  }
  assert.deepEqual(f.calls.map(call => call.stage), ['writing'], '数字失败必须在事实audit之前拦截');
  assert.ok(f.previews.some(p => p.validation.numeric === 'failed' && p.numericIssues?.length && !p.validated));
}

const changedCases = [
  ['真实时长被删除', '耗时12秒。', '耗时很短。', [{ kind: 'missing', token: '12|秒' }]],
  ['真实时长被改值', '耗时0.2秒。', '耗时2秒。', [{ kind: 'missing', token: '0.2|秒' }, { kind: 'added', token: '2|秒' }]],
  ['重量单位被改错', '样本重一千克。', '样本重1克。', [{ kind: 'missing', token: '1|千克' }, { kind: 'added', token: '1|克' }]],
  ['距离单位被改错', '路线长3千米。', '路线长3米。', [{ kind: 'missing', token: '3|公里' }, { kind: 'added', token: '3|米' }]],
  ['货币倍率被丢失', '费用为一千元。', '费用为1元。', [{ kind: 'missing', token: '1000|元' }, { kind: 'added', token: '1|元' }]],
  ['英文年被错译为天', 'The experience is 12 years.', '经验为12天。', [{ kind: 'missing', token: '12|年' }, { kind: 'added', token: '12|天' }]],
  ['百分比变成普通数值', '比例为百分之三十。', '比例为30。', [{ kind: 'missing', token: '30%' }, { kind: 'added', token: '30' }]],
  ['英文百万数量被改值', 'There are one million users.', '共有10万用户。', [{ kind: 'missing', token: '1000000' }, { kind: 'added', token: '100000' }]],
  ['原文无数字却新增量化', 'Predict the next word.', '预测下一个词，速度提升2倍。', [{ kind: 'added', token: '2|倍' }]],
  ['中文负号被删除', '温度为负三度。', '温度为三度。', [{ kind: 'missing', token: '-3|度' }, { kind: 'added', token: '3|度' }]],
  ['英文negative负号被删除', 'The temperature is negative three degrees.', '温度为三度。', [{ kind: 'missing', token: '-3|度' }, { kind: 'added', token: '3|度' }]],
  ['英文口述小数被改为整数', 'It takes zero point two seconds.', '耗时两秒。', [{ kind: 'missing', token: '0.2|秒' }, { kind: 'added', token: '2|秒' }]],
  ['明确计数marker及其数量被一起删除', '只有一种方案。', '存在可行方案。', [{ kind: 'missing', token: '1' }]]
];
for (const [name, source, candidate, issues] of changedCases) {
  test(`faithful=true仍拒绝：${name}`, async () => { await assertNumericRejected(fixture(source, candidate), issues); });
}

test('新增数字位于总标题时诊断定位到article.title', async () => {
  await assertNumericRejected(fixture('理解数据结构。', '理解数据结构。', { candidateTitle: '效率提升2倍' }),
    [{ kind: 'added', token: '2|倍', location: 'article.title' }]);
});

for (const reference of ['original', 'corrected', 'current']) {
  test(`source.text唯一事实基准：${reference}的标题及简介数字不要求复述`, async () => {
    await assertAccepted(fixture('样本重一公斤。', '样本重1千克。', { reference }));
  });
}

test('数字单位等价但删去条件：mock audit拒绝，保留定位说明和未经采纳候选', async () => {
  const auditIssue = '第2页删除了仅在安全测试中成立的条件';
  const f = fixture('Only during the safety test, it stops within 0.2 seconds.', '它总能在0.2秒内停止。',
    { audit: { faithful: false, issues: [auditIssue] } });
  let failure;
  try { await createVideoArticle(f.args); } catch (error) { failure = error; }
  assert.ok(failure, '删去成立条件应被mock事实复核拒绝');
  assertCandidate(failure, f, { structure: 'passed', numeric: 'passed', audit: 'failed' });
  assert.deepEqual(failure.numericIssues, []);
  assert.deepEqual(failure.auditIssues, [auditIssue]);
  assert.deepEqual(f.calls.map(call => call.stage), ['writing', 'audit']);
  assert.ok(f.previews.some(p => p.validation.audit === 'failed' && p.auditIssues?.includes(auditIssue) && !p.validated));
});
