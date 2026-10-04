import test from 'node:test';
import assert from 'node:assert/strict';
import { douyinUrl, resolveDouyin, douyinResponse, douyinPayload, douyinVideo } from '../electron/douyin.js';
import { platformOf } from '../electron/core.js';
import { Engine } from '../electron/engine.js';

const raw = (id = '1234567890123456789', user = 'creatorA') => ({ aweme_id: id, desc: '原视频', author: { sec_uid: user, nickname: '原作者' }, create_time: 1790000000, video: { duration: 15000, width: 1080, height: 1920, play_addr: { url_list: ['https://video.douyinvod.com/fixture.mp4'] } } });
test('抖音官方分享域名与桌面地址转换，拒绝仿冒域名、凭据和自定义端口', () => {
  assert.equal(platformOf('https://www.iesdouyin.com/share/video/123/'), '抖音');
  assert.equal(platformOf('https://iesdouyin.com.evil.example/share/video/123/'), null);
  assert.equal(douyinUrl('https://www.iesdouyin.com/share/user/creatorA/?from=share'), 'https://www.douyin.com/user/creatorA');
  assert.equal(douyinUrl('https://www.iesdouyin.com/share/video/123/'), 'https://www.douyin.com/video/123');
  assert.equal(douyinUrl('https://www.douyin.com/?modal_id=123'), 'https://www.douyin.com/video/123');
  assert.throws(() => douyinUrl('https://user:secret@www.douyin.com/video/123'));
  assert.throws(() => douyinUrl('https://www.douyin.com:444/video/123'));
});
test('短链接按实际官方跳转解析，拒绝跨平台跳转和循环', async () => {
  let calls = 0;
  const resolved = await resolveDouyin('https://v.douyin.com/fixture/', async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://www.iesdouyin.com/share/video/123/' } }); });
  assert.equal(resolved, 'https://www.douyin.com/video/123'); assert.equal(calls, 1);
  await assert.rejects(resolveDouyin('https://v.douyin.com/fixture/', async () => new Response(null, { status: 302, headers: { location: 'https://www.douyin.com/' } })), /跳回了首页/);
  await assert.rejects(resolveDouyin('https://v.douyin.com/fixture/', async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/video/123' } })));
  await assert.rejects(resolveDouyin('https://v.douyin.com/fixture/', async () => new Response(null, { status: 302, headers: { location: 'https://v.douyin.com/fixture/' } })), /重复跳转/);
});
test('只读取发布列表和原视频的响应，不混入推荐、喜欢、其他作者或错误视频', () => {
  assert.equal(douyinResponse('https://www.douyin.com/aweme/v1/web/aweme/favorite/?sec_user_id=creatorA'), null);
  assert.equal(douyinResponse('https://evil.example/aweme/v1/web/aweme/post/?sec_user_id=creatorA'), null);
  const context = douyinResponse('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=creatorA');
  const data = douyinPayload(context, { status_code: 0, aweme_list: [raw(), raw('1234567890123456790', 'wrongAuthor')] });
  assert.equal(data.length, 1); assert.equal(data[0].channel_id, 'creatorA'); assert.equal(data[0].duration, 15);
  assert.equal(douyinPayload({ kind: 'detail', id: '123' }, { status_code: 0, aweme_detail: raw() }).length, 0);
  assert.deepEqual(douyinPayload(context, { status_code: 4, aweme_list: [raw()] }), []);
});
test('图文、私密、付费和DRM不提供可下载格式，资料不携带任意响应字段', () => {
  assert.equal(douyinVideo({ ...raw(), images: [{}] }).formats.length, 0);
  assert.equal(douyinVideo({ ...raw(), status: { is_private: true } }).availability, 'private');
  assert.equal(douyinVideo({ ...raw(), is_paid_video: true }).availability, 'restricted');
  assert.equal(douyinVideo({ ...raw(), is_drm: true }).formats.length, 0);
  assert.ok(!JSON.stringify(douyinVideo({ ...raw(), cookie: 'NEVER_EXPORT', token: 'NEVER_EXPORT' })).includes('NEVER_EXPORT'));
  const invalidAddress = raw(); invalidAddress.video.play_addr.url_list = ['file:///C:/secret', 'https://user:secret@example.com/video', 'http://example.com/video'];
  assert.equal(douyinVideo(invalidAddress).formats.length, 0);
});
test('视频识别固定平台账号，失败也关闭临时官方窗口；公开资料不保存媒体直链', async () => {
  let opened, closed = 0;
  const engine = new Engine('', { active: () => ({ id: 'selected' }), markVerified() {} }, null);
  engine.douyinBrowser = () => ({ videoInfo: async (_url, id) => { opened = id; return douyinVideo(raw()); }, close() { closed++; } });
  const parsed = await engine.parse('https://www.douyin.com/video/1234567890123456789');
  assert.equal(opened, 'selected'); assert.equal(closed, 1); assert.equal(parsed.items[0].creatorId, 'creatorA');
  assert.ok(!JSON.stringify(parsed).includes('fixture.mp4'));
  engine.douyinBrowser = () => ({ videoInfo: async () => { throw new Error('CANCELLED'); }, close() { closed++; } });
  await assert.rejects(engine.parse('https://www.douyin.com/video/1234567890123456789'), /CANCELLED/); assert.equal(closed, 2);
});
