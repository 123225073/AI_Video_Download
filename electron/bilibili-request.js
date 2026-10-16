// Keep authenticated requests in their selected Electron session and retain
// configured proxies. Only anonymous archive reads on a DIRECT connection use
// Node's HTTP stack, avoiding the observed Chromium header incompatibility.
export function bilibiliRequest(accounts, guestSession, nodeFetch = fetch) {
  return async (url, { accountId, ...options }) => {
    const target = new URL(url);
    if (target.origin !== 'https://api.bilibili.com' || target.username || target.password) throw new Error('B站接口地址无效');
    if (accountId && accounts.account(accountId).platform !== 'B站') throw new Error('读取账号与 B站不一致');
    options.signal?.throwIfAborted();
    if(accountId&&accounts.account(accountId).loginBackend==='external-chrome')return accounts.fetch(accountId,url,options);
    const s = accountId ? accounts.getSession(accountId) : guestSession();
    options.signal?.throwIfAborted();
    if (!accountId && target.pathname === '/x/space/wbi/arc/search') {
      const proxy = await s.resolveProxy(url);
      options.signal?.throwIfAborted();
      if (proxy === 'DIRECT') return nodeFetch(url, { ...options, redirect: 'error', credentials: 'omit' });
    }
    const userAgent = s.getUserAgent().replace(/\s(?:Electron|fengsha-video-downloader)\/[^\s]+/g, '');
    return s.fetch(url, { ...options, redirect: 'error', credentials: accountId ? 'include' : 'omit', headers: { ...options.headers, 'User-Agent': userAgent } });
  };
}
