import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, safeStorage } from 'electron';
import { platforms } from './core.js';
import { allowedCookie, cookieDetails, parseCookieFile, hasBilibiliLoginCookie, officialUserAgent, xhsLoginState } from './account-session.js';
import {externalLoginState} from './external-login.js';
import {externalApiSpec,externalPageFetch,abortableApi} from './external-account-api.js';

const websites = { '视频号': 'https://yuanbao.tencent.com/', '抖音': 'https://www.douyin.com/', '小红书': 'https://www.xiaohongshu.com/', 'B站': 'https://www.bilibili.com/', 'YouTube': 'https://www.youtube.com/' };
export class AccountManager {
  constructor(store, directory, changed,options={}) { this.store = store; this.directory = directory; this.changed = changed; this.windows = new Map(); this.sessions = new Map(); this.timers = new Map(); this.writes = new Map();this.externalBrowser=options.externalBrowser;this.preferExternalBrowsing=options.preferExternalBrowsing===true;this.externalTabs=new Map(); }
  usesExternal(platform,id){const a=id?this.store.get('account',id):this.active(platform);return !!this.externalBrowser&&platform!=='视频号'&&(this.preferExternalBrowsing||!a||a.loginBackend==='external-chrome'||a.pendingLoginBackend==='external-chrome'&&!a.lastSync);}
  async externalStatus(){return this.externalBrowser?this.externalBrowser.status():{available:false,message:'本机 Chrome 连接尚未配置。'};}
  async openExternalLogin(id){
    const a=this.account(id);if(!this.externalBrowser)throw Error('本机 Chrome 连接尚未配置');
    let tab=this.externalTabs.get(id);
    if(!tab||tab.closed){tab=await this.externalBrowser.open(websites[a.platform],{platform:a.platform});this.externalTabs.set(id,tab);}
    await tab.show();this.save({...a,pendingLoginBackend:'external-chrome',status:'登录中',message:'请在本工具打开的 Chrome 标签中完成登录后返回检测；确认前保留原有内置会话。多个账号备注共用当前 Chrome 登录身份，不能隔离。'});
    return {opened:true,browser:'Chrome',message:'已打开 Chrome 官方页，请完成登录后返回检测。多个账号备注共用当前 Chrome 登录身份，不能隔离；不会拷贝浏览器凭据。'};
  }
  async completeExternal(id){
    const a=this.account(id);if(!this.externalBrowser)throw Error('本机 Chrome 连接尚未配置');let tab=this.externalTabs.get(id);
    if(!tab||tab.closed){tab=await this.externalBrowser.open(websites[a.platform],{platform:a.platform});this.externalTabs.set(id,tab);}
    let state;
    if(a.platform==='B站'){
      const spec=externalApiSpec('B站','https://api.bilibili.com/x/web-interface/nav');
      const response=await tab.evaluate(`(${externalPageFetch.toString()})(${JSON.stringify(spec)})`);
      let data;if(response?.status===200&&typeof response.text==='string'&&Buffer.byteLength(response.text)<=spec.maxBytes){try{data=JSON.parse(response.text);}catch{}}
      state={authenticated:data?.code===0&&data.data?.isLogin===true,message:'Chrome 已接入，但 B站官网接口尚未确认登录；请在本工具打开的 B站官网标签中完成登录后重新检测。'};
    }else state=await tab.evaluate(`(${externalLoginState.toString()})(${JSON.stringify(a.platform)})`);
    const verified=state.authenticated===true;
    const message=verified?'已在 Chrome 官方页面确认登录，后续网页采集使用同一浏览器会话。':state.message||'Chrome 已接入，平台登录尚待实际使用验证。';
    if(verified){
      const internalSession=a.loginBackend!=='external-chrome'&&a.lastSync?{lastSync:a.lastSync,lastVerified:a.lastVerified,status:'会话已保存',message:'原有内置下载会话保留'}:a.internalSession;
      this.save({...a,loginBackend:'external-chrome',pendingLoginBackend:undefined,internalSession,status:'Chrome 登录已确认',lastSync:Date.now(),lastVerified:Date.now(),message});
    }else this.save({...a,pendingLoginBackend:'external-chrome',status:'Chrome 登录待确认',...(a.loginBackend==='external-chrome'?{lastSync:null,lastVerified:null}:{}),message});
    return {saved:true,verified,message};
  }
  list() { return this.store.list('account').map(a => ({ ...a, active: this.store.get('active-account', a.platform)?.id === a.id })); }
  account(id) { const a = this.store.get('account', id); if (!a) throw new Error('账号记录不存在'); return a; }
  active(platform) { const id = this.store.get('active-account', platform)?.id; return id ? this.store.get('account', id) : null; }
  async fetch(id,url,options={}){
    const a=this.account(id);
    if(a.loginBackend!=='external-chrome')return this.getSession(id).fetch(url,options);
    if(!this.externalBrowser||!a.lastSync||a.status==='需要重新登录')throw Error('Chrome 平台登录尚未确认，请先完成登录检测');
    const spec=externalApiSpec(a.platform,url,options),signal=options.signal;signal?.throwIfAborted();
    let tab;
    const close=()=>{if(tab&&!tab.closed)void tab.close().catch(()=>{});};
    try{
      const opening=Promise.resolve(this.externalBrowser.open(spec.pageURL,{platform:a.platform,timeoutMs:10000})).then(created=>{tab=created;if(signal?.aborted){close();signal.throwIfAborted();}return created;});
      await abortableApi(opening,signal,close);signal?.throwIfAborted();
      const current=this.account(id);if(current.loginBackend!=='external-chrome'||current.lastSync!==a.lastSync)throw Error('账号登录状态已变化，请重新读取');
      const value=await abortableApi(tab.evaluate(`(${externalPageFetch.toString()})(${JSON.stringify(spec)})`),signal,close);signal?.throwIfAborted();
      if(!value||!Number.isInteger(value.status)||value.status<100||value.status>599||typeof value.text!=='string'||Buffer.byteLength(value.text)>spec.maxBytes)throw Error('Chrome 未返回有效的平台接口响应');
      return {status:value.status,ok:value.status>=200&&value.status<300,text:async()=>value.text,json:async()=>JSON.parse(value.text)};
    }finally{close();}
  }
  async bilibiliLoginReady(id) {
    const a=this.account(id);if(a.platform!=='B站')return false;
    if(a.loginBackend==='external-chrome'){
      if(!a.lastSync||a.status==='需要重新登录')return false;
      const response=await this.fetch(id,'https://api.bilibili.com/x/web-interface/nav');if(!response.ok)return false;
      const data=await response.json();return data?.code===0&&data.data?.isLogin===true;
    }
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
      this.timers.set(id, setTimeout(() => { if (this.store.get('account', id)?.lastSync) void this.persist(id).catch(() => { const current = this.store.get('account', id); if (current?.lastSync) this.save({ ...current, message: '本机会话保存失败，请检查磁盘或重新登录' }); }); }, 250));
    });
    return s;
  }
  backupFile(id) { return path.join(this.directory, 'sessions', id, 'session.encrypted'); }
  persist(id) {
    if(this.store.get('account',id)?.loginBackend==='external-chrome')return Promise.resolve();
    const pending = this.writes.get(id) || Promise.resolve();
    const write = pending.catch(() => {}).then(async () => {
      if (!this.store.get('account', id)?.lastSync) return;
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
    for (const a of this.list().filter(a => (a.loginBackend==='external-chrome'?a.internalSession?.lastSync:a.lastSync))) {
      const file = this.backupFile(a.id); if (!fs.existsSync(file)) continue;
      try {
        const cookies = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
        const s = this.getSession(a.id);
        const valid = cookies.filter(c => allowedCookie(a.platform, c) && (!c.expirationDate || c.expirationDate > Date.now() / 1000));
        const current = (await s.cookies.get({})).filter(c => allowedCookie(a.platform, c));
        const cookieKey = c => JSON.stringify([c.domain,c.path||'/',c.name]);
        const existing = new Set(current.map(cookieKey));
        for (const c of valid) if (!existing.has(cookieKey(c))) await s.cookies.set(cookieDetails(c));
        if (cookies.length && !valid.length && !current.length || a.platform === 'B站' && !hasBilibiliLoginCookie(current.concat(valid))) {
          if(a.loginBackend==='external-chrome')this.save({...a,internalSession:{...a.internalSession,lastSync:null,lastVerified:null,status:'需要重新登录',message:'原内置下载会话已过期，可在高级兼容入口重新登录'}});
          else this.markExpired(a.platform, a.id);
        }
      } catch { if(a.loginBackend==='external-chrome')this.save({...a,internalSession:{...a.internalSession,lastSync:null,lastVerified:null,status:'需要重新登录',message:'原内置下载会话无法恢复，可在高级兼容入口重新登录'}});else this.save({ ...a, status: '需要重新登录', message: '本机会话无法恢复，请重新登录' }); }
    }
  }
  async flushAll() { for (const timer of this.timers.values()) clearTimeout(timer); await Promise.all(this.list().filter(a => a.lastSync).map(a => this.persist(a.id).catch(() => {}))); }
  async importCookies(id, file) {
    const a = this.account(id); if (fs.statSync(file).size > 1024 * 1024) throw new Error('Cookie 文件过大，请仅导出选定平台');
    const cookies = parseCookieFile(fs.readFileSync(file, 'utf8'), a.platform); const s = this.getSession(id);
    for (const c of cookies) await s.cookies.set(cookieDetails(c));
    if(a.loginBackend==='external-chrome'||a.pendingLoginBackend==='external-chrome')this.save({...a,loginBackend:'embedded',pendingLoginBackend:undefined,lastSync:a.internalSession?.lastSync||null,lastVerified:a.internalSession?.lastVerified||null});
    await this.complete(id); return { imported: cookies.length };
  }
  async login(id) {
    let a = this.account(id);
    if(a.loginBackend==='external-chrome'||a.pendingLoginBackend==='external-chrome'){
      a={...a,loginBackend:'embedded',pendingLoginBackend:undefined,...(a.loginBackend==='external-chrome'?{lastSync:a.internalSession?.lastSync||null,lastVerified:a.internalSession?.lastVerified||null}:{})};this.save(a);
    }
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const s = this.getSession(id);
    s.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    const w = new BrowserWindow({ width: 1080, height: 800, title: `${a.platform}官方登录 · ${a.name}（登录后回到账号管理点击“完成登录”）`, autoHideMenuBar: true, webPreferences: { session: s, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.windows.set(id, w);
    const allowed = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port; } catch { return false; } };
    w.webContents.setWindowOpenHandler(({ url }) => { if (allowed(url)) void w.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    w.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault(); });
    w.on('closed', () => { this.windows.delete(id); const latest = this.store.get('account', id); if (latest?.status === '登录中') this.save({ ...latest, status: latest.lastSync ? '会话已保存' : '未登录' }); });
    this.save({ ...a, status: '登录中' });
    try { await w.loadURL(websites[a.platform], { userAgent: officialUserAgent }); } catch { if (!w.isDestroyed()) w.close(); throw new Error('network 官方登录页加载失败，请检查网络后重试'); }
  }
  async complete(id) {
    const a = this.account(id);
    if(a.loginBackend==='external-chrome'||a.pendingLoginBackend==='external-chrome')return this.completeExternal(id);
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
    const internal=a?.loginBackend==='external-chrome'?a.internalSession:a;
    if (!internal?.lastSync || internal.status === '需要重新登录') return null;
    if (a.platform !== platform) throw new Error('下载账号与平台不一致');
    const cookies = await this.getSession(a.id).cookies.get({});
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
    const tab=this.externalTabs.get(id);if(tab&&!tab.closed)await tab.close();this.externalTabs.delete(id);
    if(a.loginBackend==='external-chrome'||a.pendingLoginBackend==='external-chrome'){
      const internal=a.loginBackend==='external-chrome'?a.internalSession:a;
      this.save({...a,loginBackend:internal?.lastSync?'embedded':undefined,pendingLoginBackend:undefined,status:internal?.lastSync?'会话已保存':'未登录',lastSync:internal?.lastSync||null,lastVerified:internal?.lastVerified||null,message:'已解除本工具的 Chrome 账号绑定；浏览器中的登录保留。'+(internal?.lastSync?'原有内置下载会话保留。':'')});return;
    }
    const w = this.windows.get(id); if (w && !w.isDestroyed()) w.close();
    this.save({ ...a, status: '未登录', lastSync: null, lastVerified: null, message: '本机保存的会话已退出' });
    clearTimeout(this.timers.get(id)); await this.writes.get(id)?.catch(() => {});
    const s = this.getSession(id); await s.clearStorageData();
    const file = path.join(this.directory, 'sessions', id, 'download-cookies.txt');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(this.backupFile(id))) fs.unlinkSync(this.backupFile(id));
  }
  async remove(id) {
    const a = this.account(id);
    await this.logout(id);
    const s = this.getSession(id);
    await s.clearAuthCache(); await s.clearCache();
    const temporary = `${this.backupFile(id)}.tmp`;
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    clearTimeout(this.timers.get(id)); this.timers.delete(id); this.writes.delete(id);
    this.store.db.run('DELETE FROM records WHERE kind=? AND id=?', ['account', id]);
    if (this.store.get('active-account', a.platform)?.id === id) this.store.db.run('DELETE FROM records WHERE kind=? AND id=?', ['active-account', a.platform]);
    this.store.flush(); this.changed();
    return { removed: true };
  }
}
