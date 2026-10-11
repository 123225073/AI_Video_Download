import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, safeStorage } from 'electron';
import { platforms } from './core.js';
import { allowedCookie, cookieDetails, parseCookieFile, hasBilibiliLoginCookie, officialUserAgent, xhsLoginState } from './account-session.js';

const websites = { '视频号': 'https://yuanbao.tencent.com/', '抖音': 'https://www.douyin.com/', '小红书': 'https://www.xiaohongshu.com/', 'B站': 'https://www.bilibili.com/', 'YouTube': 'https://www.youtube.com/' };
export class AccountManager {
  constructor(store, directory, changed) { this.store = store; this.directory = directory; this.changed = changed; this.windows = new Map(); this.sessions = new Map(); this.timers = new Map(); this.writes = new Map(); }
  list() { return this.store.list('account').map(a => ({ ...a, active: this.store.get('active-account', a.platform)?.id === a.id })); }
  account(id) { const a = this.store.get('account', id); if (!a) throw new Error('账号记录不存在'); return a; }
  active(platform) { const id = this.store.get('active-account', platform)?.id; return id ? this.store.get('account', id) : null; }
  async bilibiliLoginReady(id) {
    if (this.account(id).platform !== 'B站') return false;
    return hasBilibiliLoginCookie(await this.getSession(id).cookies.get({ url: 'https://api.bilibili.com/', name: 'SESSDATA' }));
  }
  save(a) { this.store.put('account', a.id, a); this.store.flush(); this.changed(); return a; }
  add(platform, name) {
    if (!platforms.includes(platform)) throw new Error('请选择有效的平台');
    const a = { id: randomUUID(), platform, name: String(name || `${platform}账号`).trim().slice(0, 40), status: '未登录', createdAt: Date.now(), lastSync: null };
    this.save(a);
    if (!this.active(platform)) this.select(a.id);
    return a;
  }
  select(id) { const a = this.account(id); this.store.put('active-account', a.platform, { id }); this.store.flush(); this.changed(); }
  getSession(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const s = session.fromPath(path.join(this.directory, 'sessions', id));
    s.setUserAgent(officialUserAgent);
    this.sessions.set(id, s);
    s.cookies.on('changed', () => {
      clearTimeout(this.timers.get(id));
      this.timers.set(id, setTimeout(() => { if (this.account(id).lastSync) void this.persist(id).catch(() => this.save({ ...this.account(id), message: '本机会话保存失败，请检查磁盘或重新登录' })); }, 250));
    });
    return s;
  }
  backupFile(id) { return path.join(this.directory, 'sessions', id, 'session.encrypted'); }
  persist(id) {
    const pending = this.writes.get(id) || Promise.resolve();
    const write = pending.catch(() => {}).then(async () => {
      if (!this.account(id).lastSync) return;
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 登录会话加密暂不可用，请稍后重试');
      const s = this.getSession(id); await s.cookies.flushStore(); s.flushStorageData();
      const cookies = (await s.cookies.get({})).filter(c => allowedCookie(this.account(id).platform, c));
      const file = this.backupFile(id); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, safeStorage.encryptString(JSON.stringify(cookies)), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file);
    });
    this.writes.set(id, write); return write;
  }
  async restore() {
    for (const a of this.list().filter(a => a.status === '登录中')) this.save({ ...a, status: a.lastSync ? '会话已保存' : '未登录' });
    for (const a of this.list().filter(a => a.lastSync)) {
      const file = this.backupFile(a.id); if (!fs.existsSync(file)) continue;
      try {
        const cookies = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
        const s = this.getSession(a.id);
        const valid = cookies.filter(c => allowedCookie(a.platform, c) && (!c.expirationDate || c.expirationDate > Date.now() / 1000));
        const current = (await s.cookies.get({})).filter(c => allowedCookie(a.platform, c));
        const cookieKey = c => JSON.stringify([c.domain,c.path||'/',c.name]);
        const existing = new Set(current.map(cookieKey));
        for (const c of valid) if (!existing.has(cookieKey(c))) await s.cookies.set(cookieDetails(c));
        if (cookies.length && !valid.length && !current.length || a.platform === 'B站' && !await this.bilibiliLoginReady(a.id)) this.markExpired(a.platform, a.id);
      } catch { this.save({ ...a, status: '需要重新登录', message: '本机会话无法恢复，请重新登录' }); }
    }
  }
  async flushAll() { for (const timer of this.timers.values()) clearTimeout(timer); await Promise.all(this.list().filter(a => a.lastSync).map(a => this.persist(a.id).catch(() => {}))); }
  async importCookies(id, file) {
    const a = this.account(id); if (fs.statSync(file).size > 1024 * 1024) throw new Error('Cookie 文件过大，请仅导出选定平台');
    const cookies = parseCookieFile(fs.readFileSync(file, 'utf8'), a.platform); const s = this.getSession(id);
    for (const c of cookies) await s.cookies.set(cookieDetails(c));
    await this.complete(id); return { imported: cookies.length };
  }
  async login(id) {
    const a = this.account(id);
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const s = this.getSession(id);
    s.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    const w = new BrowserWindow({ width: 1080, height: 800, title: `${a.platform}官方登录 · ${a.name}（登录后回到账号管理点击“完成登录”）`, autoHideMenuBar: true, webPreferences: { session: s, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.windows.set(id, w);
    const allowed = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; } };
    w.webContents.setWindowOpenHandler(({ url }) => { if (allowed(url)) void w.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    w.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault(); });
    w.on('closed', () => { this.windows.delete(id); const latest = this.account(id); if (latest.status === '登录中') this.save({ ...latest, status: latest.lastSync ? '会话已保存' : '未登录' }); });
    this.save({ ...a, status: '登录中' });
    try { await w.loadURL(websites[a.platform], { userAgent: officialUserAgent }); } catch { if (!w.isDestroyed()) w.close(); throw new Error('network 官方登录页加载失败，请检查网络后重试'); }
  }
  async complete(id) {
    const a = this.account(id);
    const s = this.getSession(id);
    await s.cookies.flushStore();
    const cookies = await s.cookies.get({});
    if (!cookies.length) throw new Error('尚未获取会话，请先在官方页面完成登录');
    const w = this.windows.get(id);
    let verified = false;
    if (a.platform === '小红书') {
      if (w && !w.isDestroyed()) {
        const state = await w.webContents.executeJavaScript(`(${xhsLoginState.toString()})()`);
        if (!state.loggedIn) { if (state.reason === 'device-limit') this.markExpired(a.platform, id, state.message); throw new Error(state.message || '请先完成小红书登录'); }
        verified = true;
      } else if (!cookies.some(c => allowedCookie(a.platform, c) && c.name === 'web_session' && c.value)) throw new Error('请先在小红书官方页面完成登录，访客会话不能作为登录会话保存');
    }
    if (a.platform === 'B站' && !await this.bilibiliLoginReady(id)) throw new Error('尚未检测到 B站登录会话，请先在官方窗口完成扫码或登录，再回到这里点击“完成登录”');
    this.save({ ...a, status: '会话已保存', lastSync: Date.now(), ...(verified ? { lastVerified: Date.now() } : {}), message: verified ? '已在官方页面确认登录；平台会话过期或设备超限时仍需重新登录' : '已保存本机会话，平台有效性待下次使用验证' });
    await this.persist(id);
    if (w && !w.isDestroyed()) w.close();
    return { saved: true };
  }
  async cookieFile(platform, accountId) {
    const a = accountId ? this.store.get('account', accountId) : this.active(platform);
    if (!a?.lastSync || a.status === '需要重新登录') return null;
    const cookies = await this.getSession(a.id).cookies.get({});
    if (a.platform !== platform) throw new Error('下载账号与平台不一致');
    const lines = cookies.filter(c => allowedCookie(platform, c)).map(c => [c.httpOnly ? `#HttpOnly_${c.domain}` : c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE', Math.floor(c.expirationDate || 0), c.name, c.value].join('\t'));
    if (!lines.length) return null;
    const dir = path.join(this.directory, 'sessions', a.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'download-cookies.txt');
    fs.writeFileSync(file, '# Netscape HTTP Cookie File\n' + lines.join('\n'), { mode: 0o600 });
    return file;
  }
  markExpired(platform, id, message = '平台拒绝当前会话，请重新登录') { const a = id ? this.store.get('account', id) : this.active(platform); if (a) this.save({ ...a, status: '需要重新登录', message }); }
  markVerified(platform, id, message = '仅代表最近一次解析成功，不保证所有内容均可访问') { const a = id ? this.store.get('account', id) : this.active(platform); if (a?.lastSync) this.save({ ...a, status: '最近解析成功', lastVerified: Date.now(), message }); }
  async logout(id) {
    const a = this.account(id);
    const w = this.windows.get(id); if (w && !w.isDestroyed()) w.close();
    this.save({ ...a, status: '未登录', lastSync: null, lastVerified: null, message: '本机保存的会话已退出' });
    clearTimeout(this.timers.get(id)); await this.writes.get(id)?.catch(() => {});
    const s = this.getSession(id); await s.clearStorageData();
    const file = path.join(this.directory, 'sessions', id, 'download-cookies.txt');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(this.backupFile(id))) fs.unlinkSync(this.backupFile(id));
  }
}
