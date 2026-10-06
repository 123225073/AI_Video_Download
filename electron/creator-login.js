export const CREATOR_LOGIN_REQUIRED = 'BILIBILI_LOGIN_REQUIRED';

export function bilibiliCreatorSource(text) {
  try {
    const url = new URL(String(text).match(/https:\/\/[^\s<>"']+/)?.[0]);
    return url.hostname === 'b23.tv' || url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com');
  } catch { return false; }
}

export function creatorLoginPrompt(platform, account) {
  if (platform !== 'B站') return null;
  let message;
  if (!account || account.platform !== 'B站') message = '请先在账号管理添加并登录 B站账号，再设为下载账号。浏览器里的登录不会自动共享到本应用。';
  else if (account.status === '需要重新登录') message = '当前 B站会话已过期，请在账号管理重新登录，完成验证后点击“完成登录”，再执行博主读取。';
  else if (account.status === '登录中' || !Number.isFinite(Number(account.lastSync)) || Number(account.lastSync) <= 0 || account.status === '未登录') message = '请先在 B站官方窗口完成扫码或登录，回到账号管理点击“完成登录”，再执行博主读取。';
  return message ? { code: CREATOR_LOGIN_REQUIRED, title: '请先登录 B站账号', message } : null;
}

export function creatorLoginError(message) {
  return Object.assign(new Error(message), { code: CREATOR_LOGIN_REQUIRED, exitCode: 1 });
}
