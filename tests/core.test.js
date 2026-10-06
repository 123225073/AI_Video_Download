import test from 'node:test';
import assert from 'node:assert/strict';
import { linksFromText, platformOf, cleanName, mediaKey, classifyError, archiveDirectory, safeLog } from '../electron/core.js';
import { Engine } from '../electron/engine.js';

test('分享文案提取链接并去重，拒绝仿冒平台域名', () => {
  assert.deepEqual(linksFromText('标题 https://v.douyin.com/abc/。 https://v.douyin.com/abc/'), ['https://v.douyin.com/abc/']);
  assert.equal(platformOf('https://youtube.com.evil.example/watch?v=1'), null);
  assert.equal(platformOf('https://www.bilibili.com/video/BV123?p=2'), 'B站');
});
test('B站分P保持独立身份，不因同标题或长标题冲突', () => {
  const base = { platform: 'B站', sourceId: 'BV123', title: '相同标题', url: 'https://www.bilibili.com/video/BV123' };
  assert.notEqual(mediaKey({ ...base, part: 1 }), mediaKey({ ...base, part: 2 }));
  const engine = new Engine('', null, null);
  const direct = engine.item({ id: 'BV123_p2' }, base.url + '?p=2', 'B站');
  const listed = engine.item({ id: base.url + '?p=2' }, base.url + '?p=2', 'B站', '合集', 2);
  assert.equal(direct.key, listed.key);
});
test('Windows文件名和归档路径不允许保留名或目录穿越', () => {
  assert.equal(cleanName('CON'), '_CON');
  assert.equal(cleanName('../../A:B?'), '.._.._A_B_');
  assert.ok(archiveDirectory({ savePath: 'D:\\videos', archive: 'collection' }, { platform: 'B站', author: '../作者', collection: '合集/名称' }).startsWith('D:\\videos'));
});
test('不同失败原因具有不同重试策略，日志去除签名和Cookie', () => {
  assert.equal(classifyError('WECHAT_LOGIN_REQUIRED').retryable, false);
  assert.equal(classifyError('HTTP Error 429').category, 'rate-limit');
  assert.equal(classifyError('ETIMEDOUT').retryable, true);
  assert.equal(classifyError('ENOSPC').retryable, false);
  assert.equal(classifyError('Private video').category, 'restricted');
  assert.equal(classifyError('Fresh cookies (not necessarily logged in) are needed').category, 'auth');
  assert.equal(classifyError('No video formats found!').category, 'extractor');
  assert.ok(!safeLog('Cookie=SECRET https://example.com/?token=SECRET').includes('SECRET'));
});

test('无效或溢出的媒体时间字段不能使整批识别崩溃或输出Infinity', () => {
  const engine=new Engine('',null,null);
  for(const value of [Infinity,NaN,1e300,-1]) {
    const item=engine.item({timestamp:value,duration:value},'https://www.youtube.com/watch?v=test','YouTube');
    assert.equal(item.publishedAt,null);assert.equal(item.duration,value===1e300?1e300:null);
  }
});
