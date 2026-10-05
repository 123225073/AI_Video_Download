import path from 'node:path';
import { createHash } from 'node:crypto';

export const platforms = ['视频号', '抖音', '小红书', 'B站', 'YouTube'];
export function platformOf(value) {
  try {
    const h = new URL(value).hostname.toLowerCase();
    if (h === 'weixin.qq.com' || h === 'channels.weixin.qq.com') return '视频号';
    if (h === 'douyin.com' || h.endsWith('.douyin.com') || h === 'iesdouyin.com' || h.endsWith('.iesdouyin.com')) return '抖音';
    if (h === 'xiaohongshu.com' || h.endsWith('.xiaohongshu.com') || h === 'xhslink.com') return '小红书';
    if (h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv') return 'B站';
    if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'YouTube';
    if (process.env.FENGSHA_TEST_MODE === '1' && (h === '127.0.0.1' || h === 'localhost')) return '测试媒体';
  } catch { /* The UI reports invalid links separately. */ }
  return null;
}
export function linksFromText(text) {
  const found = String(text).match(/https?:\/\/[^\s<>"'，。；！？）】]+/g) || [];
  return [...new Set(found.map(x => x.replace(/[),.;!\]]+$/, '')))];
}
export function validSource(value) {
  const url = new URL(value);
  if (url.username || url.password || !platformOf(value) || (url.protocol !== 'https:' && process.env.FENGSHA_TEST_MODE !== '1')) throw new Error('请输入五个首批平台的有效 HTTPS 分享链接');
  return value;
}
export function cleanName(value, fallback = '未命名') {
  let name = String(value || fallback).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 70);
  if (!name) name = fallback;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
export function mediaKey(item) {
  const u = new URL(item.url);
  const part = item.part || u.searchParams.get('p') || '1';
  return createHash('sha256').update(`${item.platform}|${item.sourceId || item.url}|${part}`).digest('hex').slice(0, 24);
}
export function archiveDirectory(settings, item) {
  let dir = settings.savePath;
  if (settings.archive !== 'flat') dir = path.join(dir, cleanName(item.platform), cleanName(item.author, '未知作者'));
  if (settings.archive === 'collection' && item.collection) dir = path.join(dir, cleanName(item.collection));
  return dir;
}
export function classifyError(message) {
  const text = String(message);
  if (/BILIBILI_RISK|\[Bilibili[^\]]*\].*(?:\(352\)|\(412\)|\(401\))|Request is (?:rejected|blocked) by server.*\((?:352|412|401)\)/i.test(text)) return { category: 'rate-limit', message: 'B站限制了作品列表请求，已保留当前清单和读取位置。请在账号管理登录或更新 B站会话，完成官方验证后等待至少一分钟，再继续读取；不要连续重复提交。', retryable: true };
  const rules = [
    [/WECHAT_LOGIN|Sign in|Login required|Fresh cookies|cookies.*valid|HTTP Error 401/i, 'auth', '登录状态缺失或已过期，请配置登录后重新识别', false],
    [/DRM|paywall|members.only|Private video|paid content/i, 'restricted', '该内容受访问限制，不能通过此下载器获取', false],
    [/429|Too Many Requests|rate.limit|HTTP Error 412/i, 'rate-limit', '平台请求受限，请稍后重试或更新登录状态', true],
    [/ENOSPC|No space left/i, 'disk', '保存磁盘空间不足，请释放空间或选择其他目录', false],
    [/EACCES|EPERM|Permission denied/i, 'permission', '无法写入保存目录，请选择有写入权限的目录', false],
    [/ENOENT|FENGSHA_BINARY_MISSING/i, 'binary', '下载组件缺失，请在设置中检查环境', false],
    [/404|unavailable|removed|WECHAT_LINK_UNAVAILABLE/i, 'unavailable', '链接已失效或当前不可用，请检查原页面', false],
    [/unsupported|No suitable extractor|Unable to extract|No video formats found/i, 'extractor', '平台解析失败，请更新组件或更换最新分享链接', false],
    [/timed? ?out|ECONN|ETIMEDOUT|socket|network|HTTP Error 5\d\d/i, 'network', '网络连接中断，将按设置重试', true],
    [/ffmpeg|ffprobe|Postprocessing|Conversion failed|INVALID_MEDIA/i, 'merge', '媒体合并或校验失败，可检查组件后重试', false]
  ];
  const rule = rules.find(r => r[0].test(text));
  return rule ? { category: rule[1], message: rule[2], retryable: rule[3] } : { category: 'unknown', message: '下载失败，可查看原因并手动重试', retryable: false };
}
export function safeLog(value) {
  return String(value).replace(/https?:\/\/\S+/g, '[链接已隐藏]').replace(/(cookie|authorization|token|decodeKey)[=: ].*/ig, '$1=[已隐藏]').slice(-3500);
}
