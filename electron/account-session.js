const domains = {
  '视频号': ['tencent.com', 'qq.com', 'weixin.qq.com'],
  '抖音': ['douyin.com', 'iesdouyin.com'],
  '小红书': ['xiaohongshu.com', 'xhslink.com'],
  'B站': ['bilibili.com'],
  'YouTube': ['youtube.com', 'google.com']
};
export function allowedCookie(platform, cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return (domains[platform] || []).some(domain => host === domain || host.endsWith(`.${domain}`));
}
export function cookieDetails(cookie) {
  return { url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`, name: cookie.name, value: cookie.value, ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}), path: cookie.path || '/', secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly), ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}), ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}) };
}
export function parseCookieFile(text, platform, now = Date.now() / 1000) {
  if (!text.includes('Netscape HTTP Cookie File') && !text.includes('HTTP Cookie File')) throw new Error('请选择 Netscape 格式的 Cookie 文件');
  const cookies = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const fields = line.replace(/^#HttpOnly_/, '').split('\t');
    if (fields.length !== 7) throw new Error('Cookie 文件格式不正确，请重新导出');
    const [domain, _subdomains, cookiePath, secure, expiry, name, value] = fields;
    const expirationDate = Number(expiry);
    if (!Number.isFinite(expirationDate) || expirationDate < 0 || !name || !/^[.a-zA-Z0-9-]+$/.test(domain) || !cookiePath.startsWith('/')) throw new Error('Cookie 文件存在无效条目');
    const cookie = { domain, path: cookiePath, secure: secure === 'TRUE', httpOnly: line.startsWith('#HttpOnly_'), name, value, ...(expirationDate ? { expirationDate } : {}) };
    if (allowedCookie(platform, cookie) && (!expirationDate || expirationDate > now)) cookies.push(cookie);
  }
  if (!cookies.length) throw new Error('文件中没有此平台的有效会话，请检查平台及有效期');
  if (cookies.length > 1000) throw new Error('Cookie 条目过多，请仅导出选定平台');
  return cookies;
}
