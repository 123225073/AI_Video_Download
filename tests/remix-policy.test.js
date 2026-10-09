import test from 'node:test';
import assert from 'node:assert/strict';
import {imageRemixPrompt,normalizeRemixResult,resolveAssetLineage,buildAssetPairs} from '../electron/remix-policy.js';

test('短事实稿不强迫扩写；审阅意见保留独立结果',()=>{
  const result=normalizeRemixResult({title:'下午阅读',body:'下午开放，限六人。',tags:'#阅读',reviewNotes:['需人工审阅'],issues:[{message:'无参考出处'}],notes:'保持人数'});
  assert.equal(result.body,'下午开放，限六人。');assert.deepEqual(result.reviewNotes,['需人工审阅','无参考出处','保持人数']);
});

test('合法限制和待确认日期不能整段剪掉，保留蓝金竖版等合法方向',()=>{
 const body='报名开放。\n未满18岁不可参加，费用200元；具体日期待核实。\n请提前登记。';
 const d=normalizeRemixResult({title:'报名条件',body,tags:'#报名'});assert.equal(d.body,body);
 const p=imageRemixPrompt('不要复制原图水印，采用蓝金配色，画三张竖版信息卡，突出报名限制');assert.match(p,/蓝金/);assert.match(p,/三张竖版信息卡/);assert.match(p,/报名限制/);
});

test('待核实的是日期这种完整事实句不是核查标题，不能截断后文',()=>{
 const body='阅读角报名开放。\n待核实的是活动日期，未满18岁不可参加，报名费200元。\n活动每次限六人，请提前登记。';
 assert.equal(normalizeRemixResult({title:'报名条件',body}).body,body);
});
test('虚构的参考消息署名和核查段落进入审阅结果，不能流入正文',()=>{
  assert.throws(()=>normalizeRemixResult({title:'阅读角',body:'阅读角下午开放，每次限六人。\n据参考消息，费用200元。'}),/正文|不完整/);
  const result=normalizeRemixResult({title:'阅读角',body:'阅读角下午开放，每次限六人。\n\n核查报告：\n据参考消息，这是一项新政策。\n原稿没有具体研究来源。'});
  assert.equal(result.body,'阅读角下午开放，每次限六人。');assert.ok(result.reviewNotes.some(n=>n.includes('据参考消息')));
  assert.throws(()=>normalizeRemixResult({title:'待核实报告',body:'参考材料声称有研究，仍待核实。'}),/可发布|正文/);
});
test('图片策略保留安全偏好，剔除直接复用原摄影和来源标识要求',()=>{
  const prompt=imageRemixPrompt('用蓝色。保留某媒体logo，抹掉水印沿用原摄影。画竖版插画');
  assert.match(prompt,/蓝色/);assert.match(prompt,/竖版/);assert.doesNotMatch(prompt,/保留某媒体logo|抹掉水印沿用原摄影/);
  assert.match(prompt,/不能.*水印/);assert.match(prompt,/不可覆盖/);
});
test('直接父链逐层追溯original/imported，环和断链不能猜原图',()=>{
  const assets=[{id:'o',origin:'original'},{id:'a',origin:'generated',originalAssetId:'o'},{id:'b',origin:'generated',originalAssetId:'a'},
    {id:'c',origin:'generated',originalAssetId:'b'}];
  assert.deepEqual(resolveAssetLineage(assets,'c'),{valid:true,originalAssetId:'o',parentAssetId:'b',lineageAssetIds:['o','a','b','c']});
  assert.equal(resolveAssetLineage([{id:'a',origin:'generated',originalAssetId:'b'},{id:'b',origin:'generated',originalAssetId:'a'}],'a').valid,false);
  assert.equal(resolveAssetLineage([{id:'a',origin:'generated',originalAssetId:'gone'}],'a').originalAssetId,null);
  assert.equal(resolveAssetLineage([{id:'i',origin:'imported'},{id:'g',origin:'generated',originalAssetId:'i'}],'g').originalAssetId,'i');
});
test('pairing按当前排序返回原图/生成图，未生成、断链和文件缺失可区分',()=>{
  const assets=[{id:'o',origin:'original',preview:'original'},{id:'g',origin:'generated',originalAssetId:'o',preview:'generated'},{id:'broken',origin:'generated',originalAssetId:'gone'}];
  const pairs=buildAssetPairs(assets,['g','o','broken','gone'],a=>a.id!=='g');
  assert.deepEqual(pairs.map(p=>p.status),['missing','not-generated','untraceable','missing']);
  assert.equal(pairs[0].original.preview,'original');assert.equal(pairs[0].generated.preview,'generated');assert.equal(pairs[2].original,null);
});
