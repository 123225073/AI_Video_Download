import { BrowserWindow } from 'electron';
import {externalBrowserWindow} from './external-browser-window.js';
import { setTimeout as delay } from 'node:timers/promises';
import { searchUrl, renderedSearch, searchUser } from './user-search-data.js';

export class UserSearchBrowser {
  constructor(accounts) { this.accounts = accounts; this.window = null; }
  close() { const w = this.window; this.window = null; if (w && !w.isDestroyed()) w.close(); }
  async read(record, signal, initial = false) {
    if (initial || !this.window || this.window.isDestroyed() || this.recordId !== record.id) {
      this.close(); this.recordId = record.id;
      const s = record.accountId ? this.accounts.getSession(record.accountId) : undefined;
      const window = this.window = this.accounts.usesExternal?.(record.platform,record.accountId)?await externalBrowserWindow(this.accounts.externalBrowser,searchUrl(record.platform,record.keyword),record.platform,{session:s}):new BrowserWindow({ width: 1100, height: 800, autoHideMenuBar: true, title: '用户搜索 · 完成登录或验证后，返回风沙读取官方页面结果', webPreferences: { session: s, partition: s ? undefined : `fengsha-user-search-${record.platform}`, sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'document-user-activation-required' } });
      window.setMenu(null); window.webContents.setAudioMuted(true);
      const origin = new URL(searchUrl(record.platform, record.keyword)).origin;
      const origins = record.platform === '小红书' ? [origin, 'https://xiaohongshu.com'] : [origin];
      const allowed = value => { try { const u = new URL(value); return origins.includes(u.origin) && !u.username && !u.password; } catch { return false; } };
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect']) window.webContents.on(event, (e, url) => { if (!allowed(url)) e.preventDefault(); });
      const abort = () => { if (!window.isDestroyed()) window.close(); };
      signal.addEventListener('abort', abort, { once: true });
      try { signal.throwIfAborted(); await window.webContents.loadURL(searchUrl(record.platform, record.keyword), { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' }); }
      catch (e) {
        if (signal.aborted) { this.close(); throw new Error('已停止搜索'); }
        // Chromium can reject the original navigation after a site's own redirect.
        // Keep an already-rendered official login/risk page available for the user.
        if (!window.isDestroyed() && allowed(window.webContents.getURL()) && /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(e.message)) await delay(500, undefined, { signal });
        else { this.close(); const code = e.message.match(/(?:net::)?(ERR_[A-Z_]+)/)?.[1] || ''; throw new Error(`官方搜索页面无法连接${code ? `（${code}）` : ''}，请检查当前网络或安全连接后重试`); }
      }
      finally { signal.removeEventListener('abort', abort); }
    }
    const window = this.window;
    const abort = () => this.close(); signal.addEventListener('abort', abort, { once: true });
    try {
      let result;
      for (let i = 0; i < (initial ? 6 : 2); i++) {
        signal.throwIfAborted();
        if (window.isDestroyed()) throw new Error('官方窗口已关闭，请重新搜索');
        result = await window.webContents.executeJavaScript(`(${renderedSearch.toString()})(${JSON.stringify(record.platform)},${JSON.stringify(record.keyword)})`);
        if (result.users?.length || result.blocked || result.empty) break;
        await delay(800, undefined, { signal });
      }
      // Names can render before lazy images. Re-read once rather than freezing
      // the first incomplete card snapshot or issuing per-user network requests.
      if (initial && result.users?.length && result.users.some(u => !u.avatar)) {
        await delay(800, undefined, { signal }); signal.throwIfAborted();
        if (window.isDestroyed()) throw new Error('官方窗口已关闭，请重新搜索');
        result = await window.webContents.executeJavaScript(`(${renderedSearch.toString()})(${JSON.stringify(record.platform)},${JSON.stringify(record.keyword)})`);
      }
      const users = (result.users || []).map(r => searchUser(record.platform, r)).filter(Boolean);
      if (!users.length && !result.empty) return { users, next: null, status: 'needs-action', message: result.message, partial: true };
      return { users, next: null, status: result.empty ? 'complete' : 'browser', message: result.empty ? '平台返回没有匹配用户。' : '已读取官方页面当前展示的用户。需要更多结果时，在官方窗口向下滚动，再点击读取；不代表全部匹配用户。' };
    } finally { signal.removeEventListener('abort', abort); }
  }
  show() { if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); } }
}
