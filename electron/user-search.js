import { randomUUID } from 'node:crypto';
import { searchInput, biliSearchPage, wechatSearchPage } from './user-search-data.js';

export class UserSearch {
  constructor({ accounts, creators, bilibili, wechat, browser, changed = () => {} }) { Object.assign(this, { accounts, creators, bilibili, wechat, browser, changed }); this.record = null; this.active = null; this.cooldown = 0; }
  view() { if (!this.record) return null; const { accountId, next, ...publicRecord } = this.record; return { ...publicRecord, canContinue: ['ready', 'browser', 'needs-action', 'interrupted'].includes(this.record.status), busy: Boolean(this.active) }; }
  cancel() { this.active?.abort(); this.browser.close(); }
  async close() { this.cancel(); await this.pending?.catch(() => {}); }
  async run(fn, preservePrevious = false) {
    if (this.active || this.creators.progress()) throw new Error('正在搜索或读取博主，请先停止当前操作');
    const previous = this.record; const controller = this.active = new AbortController(); this.changed();
    const pending = this.pending = Promise.resolve().then(() => fn(controller.signal));
    try { const result = await pending; return { ...result, busy: false }; }
    catch (e) { if (this.record && (!preservePrevious || this.record !== previous)) { this.record.status = controller.signal.aborted ? 'cancelled' : 'interrupted'; this.record.message = controller.signal.aborted ? '已停止搜索，当前结果保留。' : e.message; e.details = this.view(); this.changed(); } throw e; }
    finally { this.active = null; this.pending = null; this.changed(); }
  }
  async start(platform, keyword) {
    keyword = searchInput(platform, keyword);
    return this.run(async signal => {
      if (platform === 'B站') { await this.creators.requireLogin(platform, signal); if (Date.now() < this.cooldown) throw new Error('B站搜索请求受限，请等待冷却结束并完成官方验证后再试；不要连续重复提交。'); }
      if (platform === '视频号') { const status = await this.wechat.test(); if (!status.connected) throw new Error('请在设置中连接本机视频号服务，并在已登录的微信中保持视频号页面打开，再搜索用户。'); }
      signal.throwIfAborted(); this.browser.close();
      this.record = { id: randomUUID(), platform, keyword, accountId: this.accounts.active(platform)?.id || null, users: [], next: platform === 'B站' ? 1 : '', status: 'searching', message: '', searchedAt: Date.now() };
      return this.read(signal, true);
    }, true);
  }
  async more(id) {
    if (!this.record || this.record.id !== id) throw new Error('本次搜索已结束或被替换，请重新搜索');
    if (['complete', 'cancelled', 'limited'].includes(this.record.status)) throw new Error('本次搜索没有可继续读取的位置，请重新搜索');
    return this.run(signal => this.read(signal));
  }
  async read(signal, initial = false) {
    const r = this.record;
    const unchanged = () => { signal.throwIfAborted(); if ((this.accounts.active(r.platform)?.id || null) !== r.accountId) throw new Error('搜索使用的账号已切换，请重新搜索，避免混合不同账号可见的结果'); };
    unchanged(); let page;
    if (r.platform === 'B站') {
      await this.creators.requireLogin('B站', signal); unchanged();
      if (Date.now() < this.cooldown) throw new Error('B站搜索仍在冷却，请完成验证并稍后再试');
      try { page = biliSearchPage(await this.bilibili.json(`/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(r.keyword)}&page=${r.next}&page_size=20`, r.accountId, signal), r.next); }
      catch (e) { if (/BILIBILI_RISK/.test(e.message)) { this.cooldown = Date.now() + 60000; throw new Error('B站限制了用户搜索，请在官方页面完成验证，等待至少一分钟再继续；已获取的用户保留。'); } throw e; }
    } else if (r.platform === '视频号') page = wechatSearchPage(await this.wechat.request('/api/channels/contact/search', { keyword: r.keyword, next_marker: encodeURIComponent(r.next) }, signal), r.next);
    else page = await this.browser.read(r, signal, initial);
    unchanged();
    const map = new Map(r.users.map(u => [u.id, u]));
    const before = map.size; for (const u of page.users) map.set(u.id, u);
    if (map.size > 500) { page.status = 'limited'; page.message = '本次最多保留 500 个用户，请缩小关键词范围。'; page.next = null; }
    if (!initial && page.next && map.size === before) throw new Error('平台未返回新的用户，已保留结果和搜索位置，请稍后继续');
    Object.assign(r, { users: [...map.values()].slice(0, 500), next: page.next, status: page.status, message: page.message || (page.status === 'complete' ? '已读取至平台返回的末页。' : '已读取一页用户，可继续加载。'), partial: Boolean(page.partial) });
    this.changed(); return this.view();
  }
}
