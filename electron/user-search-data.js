import { thumbnailUrl } from './thumbnail.js';

export const SEARCH_PLATFORMS = ['视频号', '抖音', '小红书', 'B站', 'YouTube'];
export function searchInput(platform, keyword) {
  if (!SEARCH_PLATFORMS.includes(platform)) throw new Error('请选择视频号、抖音、小红书、B站或 YouTube');
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.trim().length > 100 || /[\x00-\x1f\x7f]/.test(keyword)) throw new Error('请输入 1–100 字的搜索关键词');
  return keyword.trim();
}
export function searchUrl(platform, keyword) {
  keyword = searchInput(platform, keyword);
  const q = encodeURIComponent(keyword);
  return { '抖音': `https://www.douyin.com/search/${q}?type=user`, '小红书': `https://www.xiaohongshu.com/search_result?keyword=${q}&type=51`, 'B站': `https://search.bilibili.com/upuser?keyword=${q}`, 'YouTube': `https://www.youtube.com/results?search_query=${q}&sp=EgIQAg%253D%253D` }[platform];
}
const text = (v, max) => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, max) : '';
const count = v => (typeof v === 'number' || typeof v === 'string' && /^\d+$/.test(v)) && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
// Only real profile identifiers are admitted. Display names never become IDs.
export function searchUser(platform, raw) {
  if (!SEARCH_PLATFORMS.includes(platform) || !raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'number' && Number.isSafeInteger(raw.id) ? String(raw.id) : typeof raw.id === 'string' ? raw.id : '';
  const valid = { '视频号': /^[\w.-]{1,280}@finder$/, '抖音': /^[\w.-]{6,200}$/, '小红书': /^[a-f\d]{24}$/i, 'B站': /^[1-9]\d{0,19}$/, 'YouTube': /^(?:channel\/UC[\w-]{22}|@[\p{L}\p{N}_.%\-]{1,150})$/u }[platform];
  const name = text(raw.name, 200);
  if (!valid.test(id) || !name || platform === '抖音' && id === 'self') return null;
  const url = { '视频号': `https://channels.weixin.qq.com/web/pages/profile?username=${encodeURIComponent(id)}`, '抖音': `https://www.douyin.com/user/${id}`, '小红书': `https://www.xiaohongshu.com/user/profile/${id}`, 'B站': `https://space.bilibili.com/${id}/video`, 'YouTube': `https://www.youtube.com/${id}` }[platform];
  return { platform, id, name, url, avatar: thumbnailUrl(raw.avatar), description: text(raw.description, 1200), followers: count(raw.followers), videos: count(raw.videos), followersText: text(raw.followersText, 80), videosText: text(raw.videosText, 80), idKind: platform === 'YouTube' && id.startsWith('@') ? 'handle' : platform === '抖音' ? 'sec_uid' : 'platform-id' };
}
export function biliSearchPage(data, page) {
  if (!Array.isArray(data?.result) || Number(data.page) !== page || !Number.isSafeInteger(Number(data.numPages)) || Number(data.numPages) < 0) throw new Error('B站搜索数据不完整，请在官方搜索页面核对后重试');
  const users = data.result.map(r => searchUser('B站', { id: r.mid, name: r.uname, avatar: r.upic, description: r.usign, followers: r.fans, videos: r.videos })).filter(Boolean);
  if (data.result.length && !users.length) throw new Error('B站返回的条目没有有效用户身份，已停止读取');
  return { users, next: page < Number(data.numPages) ? page + 1 : null, status: page < Number(data.numPages) ? 'ready' : 'complete' };
}
export function wechatSearchPage(data, cursor = '') {
  if (!Array.isArray(data?.infoList)) throw new Error('微信未返回用户搜索结果，请保持微信视频号页面打开');
  const users = data.infoList.map(r => searchUser('视频号', { id: r.contact?.username, name: r.contact?.nickname, avatar: r.contact?.headUrl, description: r.contact?.signature })).filter(Boolean);
  if (data.infoList.length && !users.length) throw new Error('微信返回的条目没有稳定用户 ID，请检查本机服务版本');
  const next = typeof data.lastBuff === 'string' ? data.lastBuff : typeof data.lastBuffer === 'string' ? data.lastBuffer : null;
  const more = data.continueFlag ?? data.hasMore;
  if (more !== undefined && ![0, 1, true, false].includes(more)) throw new Error('微信搜索分页状态无效');
  if (more && (!next || next === cursor)) throw new Error('微信没有返回新的搜索位置，已保留当前结果');
  // Older collectors omit the end marker. Never claim all users were fetched.
  return { users, next: more === 0 || more === false ? null : next && next !== cursor ? next : null, status: more === 0 || more === false ? 'complete' : next && next !== cursor ? 'ready' : 'limited', message: more === undefined && !next ? '当前服务只返回本次用户结果，未提供分页位置；不代表全部匹配用户。' : '' };
}

// Executed in a sandboxed official window. No cookies, storage or login tokens.
export function renderedSearch(platform, keyword) {
  const here = new URL(location.href);
  const expected = platform === 'YouTube' ? here.hostname === 'www.youtube.com' && here.pathname === '/results' && here.searchParams.get('search_query') === keyword
    : platform === '抖音' ? here.hostname === 'www.douyin.com' && here.pathname === `/search/${encodeURIComponent(keyword)}` && here.searchParams.get('type') === 'user'
    : ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(here.hostname) && /^\/search_result\/?$/.test(here.pathname) && here.searchParams.get('keyword') === keyword && here.searchParams.get('type') === '51';
  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const body = (document.body?.innerText || '').slice(0, 50000), title = document.title;
  if (/安全限制|验证码中间页|unusual traffic/i.test(title) || here.pathname.startsWith('/website-login/error') || [...document.querySelectorAll('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]')].some(visible)) return { users: [], blocked: true, message: '平台要求验证或限制了当前网络，请在官方窗口完成验证；仍受限时稍后再试。' };
  if (!expected) return { users: [], blocked: true, message: '官方窗口已离开本次用户搜索页面，请重新搜索；登录或验证完成后也需回到原搜索页面。' };
  const selectors = platform === 'YouTube' ? 'ytd-channel-renderer' : platform === '抖音' ? '[data-e2e="search-user-item"], [data-e2e="search-user-container"], [data-e2e="search-user-list"] > li, [data-e2e="search-user"]' : '.user-list .user-item, .user-list-item, .user-card, .user-list .user';
  const cards = [...document.querySelectorAll(selectors)].filter(visible), users = [];
  for (const card of cards.slice(0, 100)) {
    const anchors = [...card.querySelectorAll('a[href]')];
    const a = anchors.find(a => { try { const u = new URL(a.href); return u.origin === here.origin && (platform === 'YouTube' ? /^\/(channel\/UC[\w-]{22}|@[^/]+)\/?$/.test(u.pathname) : platform === '抖音' ? /^\/user\/[\w.-]+\/?$/.test(u.pathname) : /^\/user\/profile\/[a-f\d]{24}\/?$/i.test(u.pathname)); } catch { return false; } });
    if (!a) continue;
    const u = new URL(a.href), id = platform === 'YouTube' ? u.pathname.slice(1).replace(/\/$/, '') : u.pathname.split('/').filter(Boolean).at(-1);
    const pick = selector => { for (const part of selector.split(',')) { const node = card.querySelector(part.trim()); if (node) return (node.innerText || node.textContent || '').trim(); } return ''; };
    const name = platform === 'YouTube' ? pick('#channel-title #text, #channel-title') : pick('[data-e2e="user-title"], .user-name, .name, .nickname') || a.innerText?.trim().split('\n')[0];
    const lines = (card.innerText || '').split('\n').map(s => s.trim());
    users.push({ id, name: name?.replace(/\s+/g, ' '), avatar: card.querySelector('img')?.src || '', description: pick(platform === 'YouTube' ? '#description' : '[data-e2e="user-signature"], .user-desc, .desc, .signature'), followersText: lines.find(s => /粉丝|订阅者|subscribers/i.test(s)) || '', videosText: lines.find(s => /(?:\d|万|亿|K|M)\s*(?:个视频|视频|作品|videos)/i.test(s)) || '' });
  }
  const empty = /没有找到相关用户|未找到相关用户|暂无相关用户|没有搜索结果|No results found|未找到任何结果/.test(body);
  const login = [...document.querySelectorAll('.login-container, .login-modal, [data-e2e="login-dialog"], [role="dialog"]')].some(el => visible(el) && /登录|log in|sign in/i.test(el.innerText || ''));
  return { users, empty: empty && !login && !users.length, blocked: login && !users.length, message: login ? '请在官方窗口完成登录，再点击“读取官方页面结果”。' : '官方页面尚未返回可识别的用户卡片。请确认处于“用户/频道”搜索，完成登录或验证后再读取。' };
}
