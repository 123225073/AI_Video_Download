import fs from 'node:fs';
const file = 'src/main.jsx'; let text = fs.readFileSync(file, 'utf8');
function replace(before, after) { if (!text.includes(before)) throw new Error(`缺失修改定位: ${before.slice(0, 100)}`); text = text.replace(before, after); }
replace("(id === 'new' && page === 'selection')", "(id === 'new' && ['selection', 'creator'].includes(page))");
replace('<Button variant="primary" disabled={!text.trim() || parsing} onClick={() => parse()}', '<Button disabled={!text.trim() || parsing || identifying || Boolean(state.creatorProgress)} onClick={identifyCreator}><Users size={18}/>识别博主</Button><Button variant="primary" disabled={!text.trim() || parsing || identifying || Boolean(state.creatorProgress)} onClick={() => parse()}');
replace('识别内容</Button>', '识别视频 / 合集</Button>');
replace('支持从分享文案中提取链接；一批最多 30 个链接', '视频 / 合集：识别当前内容；博主：从视频追溯作者，或直接粘贴主页链接');
replace('<dd>{state.settings.concurrency} 个</dd>', '<dd>{concurrencyLabel(state.settings.concurrency)}</dd>');
replace('<div className="section-title results-head"><h2>本次识别', '<div className="section-title results-head">{resumeCreator && <Button onClick={resumeCreator}><Users size={16}/>继续上次博主清单</Button>}<h2>本次识别');
replace('将按 {state.settings.concurrency} 个并发依次下载。', '采用{concurrencyLabel(state.settings.concurrency)}，根据实际资源依次下载。');
replace('平台请求受限时建议降低并发', '支持自动或 1—99 上限；实际并发按资源和平台调整，超出部分排队');
replace('<select value={draft.concurrency} onChange={e => update(\'concurrency\', Number(e.target.value))}>{[1, 2, 3, 4, 5].map(n => <option value={n} key={n}>{n} 个</option>)}</select>', '<select aria-label="同时下载上限" value={draft.concurrency} onChange={e => update(\'concurrency\', e.target.value === \'auto\' ? \'auto\' : Number(e.target.value))}><option value="auto">自动调度（推荐）</option>{Array.from({ length: 99 }, (_, i) => i + 1).map(n => <option value={n} key={n}>上限 {n} 个</option>)}</select>');
replace('下载进度与失败恢复', '下载进度、自动排队与失败恢复');
replace('/><div className="stats">', '/><div className="scheduler-summary"><span>设置：{concurrencyLabel(state.settings.concurrency)}</span><strong>正在执行 {state.scheduler?.active || 0} 个</strong><span>等待 {state.scheduler?.waiting || 0} 个</span><small>{state.scheduler?.cooldowns?.length ? `平台冷却：${state.scheduler.cooldowns.map(c => c.platform).join(\'、\')}` : state.scheduler?.reason}</small></div><div className="stats">');
fs.writeFileSync(file, text);
for (const file of ['scripts/e2e.mjs', 'scripts/installed-smoke.mjs']) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll("name: '识别内容'", "name: '识别视频 / 合集'"));
const packageFile = 'package.json', p = JSON.parse(fs.readFileSync(packageFile, 'utf8')); p.version = '0.2.0'; fs.writeFileSync(packageFile, JSON.stringify(p, null, 2) + '\n');
