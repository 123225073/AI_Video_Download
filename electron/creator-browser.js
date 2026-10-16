import { BrowserWindow, net } from 'electron';
import {externalBrowserWindow} from './external-browser-window.js';
import { profileFromUrl } from './creators.js';
import { platformOf } from './core.js';
import { resolveDouyin, douyinUrl, douyinResponse, douyinPayload } from './douyin.js';

function shortLinkResponse(session, url, { signal }) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session, redirect: 'manual', useSessionCookies: true });
    let done = false;
    const finish = (error, response) => { if (done) return; done = true; signal.removeEventListener('abort', abort); request.abort(); error ? reject(error) : resolve(response); };
    const abort = () => finish(new Error('CANCELLED'));
    request.on('redirect', (status, _method, target) => finish(null, { status, headers: new Headers({ location: target }) }));
    request.on('response', response => finish(null, { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers: new Headers() }));
    request.on('error', error => finish(error));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else request.end();
  });
}

// Read only whitelisted rendered fields on an official creator page, never cookies or arbitrary page state.
export function renderedCreator(platform, creatorId = null) {
  const profilePattern = platform === '抖音' ? /\/user\/([\w.-]+)\/?$/ : /\/user\/profile\/([a-f\d]{24})\/?$/i;
  const nameSelectors = platform === '抖音' ? '[data-e2e="user-info"] [data-e2e="user-title"], [data-e2e="user-title"]' : '.user-name, .user-info .name';
  const onProfile = profilePattern.test(location.pathname);
  const currentId = onProfile ? location.pathname.match(profilePattern)?.[1] : null;
  const authorRoot = onProfile ? null : document.querySelector(platform === '抖音' ? '[data-e2e="video-author"], [data-e2e="user-info"], [data-e2e="video-player"] [data-e2e="feed-avatar"]' : '.author-container, .note-container .author');
  const profile = authorRoot ? [...authorRoot.querySelectorAll('a[href]')].map(a => ({ href: a.href, name: (a.querySelector('[data-e2e="user-title"]')?.textContent || a.innerText)?.trim().split(/\n|认证徽章/)[0].trim() })).find(a => a.name && profilePattern.test(new URL(a.href).pathname)) : null;
  const name = (onProfile ? document.querySelector(nameSelectors)?.textContent?.trim() : profile?.name) || '';
  const avatar = (authorRoot?.querySelector('img') || document.querySelector(platform === '抖音' ? '[data-e2e="user-avatar"] img' : '.user-avatar img, .avatar-wrapper img'))?.src || '';
  const tab = document.querySelector('.user-page .tabs .active, .user-page .tabs .selected')?.textContent || '';
  const scope = /收藏|点赞/.test(tab) ? null : document.querySelector(platform === '抖音' ? '[data-e2e="user-post-list"]' : '.user-page .feeds-container, .user .feeds-container, .user-page .note-list');
  const cards = scope ? [...scope.querySelectorAll(platform === '抖音' ? 'li' : '.note-item')] : [];
  const items = [];
  for (const card of cards) {
    const a = [...card.querySelectorAll('a[href]')].find(a => platform === '抖音' ? /\/video\/\d+/.test(new URL(a.href).pathname) : /\/(?:explore|discovery\/item)\/[a-f\d]{24}/i.test(new URL(a.href).pathname));
    if (!a) continue;
    const cardAuthor = [...card.querySelectorAll('a[href]')].find(a => profilePattern.test(new URL(a.href).pathname));
    if (cardAuthor && creatorId && new URL(cardAuthor.href).pathname.match(profilePattern)?.[1] !== creatorId) continue;
    // XHS posts may be image notes. A video glyph must be present before admitting a card.
    if (platform === '小红书' && !card.querySelector('.play-icon, .video-icon, [class*="video"], use[href*="video"], use[xlink\\:href*="video"]')) continue;
    const id = new URL(a.href).pathname.match(platform === '抖音' ? /\/video\/(\d+)/ : /\/(?:explore|discovery\/item)\/([a-f\d]{24})/i)?.[1];
    const image = card.querySelector('img'), title = card.querySelector('.title, [data-e2e="video-desc"]')?.textContent?.trim() || image?.alt || a.getAttribute('title') || '待获取标题';
    items.push({ id, url: a.href, title: title.slice(0, 180), thumbnail: image?.src || '', uploader: name, upload_date: null });
  }
  const text = scope?.innerText || '';
  return { name, avatar, currentId, profileUrl: profile?.href, items, complete: Boolean(scope && /没有更多作品|暂无更多作品|全部作品已加载|没有更多了/.test(text)), scopeFound: Boolean(scope) };
}
export class CreatorBrowser {
  constructor(accounts, engine) { this.accounts = accounts; this.engine = engine; this.window = null; this.creatorUrl = null; }
  capture(browser) {
    const pending = new Map();
    this.videos = new Map(); this.postEnds = new Set();
    const debuggerApi = browser.webContents.debugger;
    debuggerApi.attach('1.3');
    debuggerApi.on('message', async (_event, method, params) => {
      if (browser !== this.window || browser.isDestroyed()) return;
      if (method === 'Network.responseReceived') {
        const context = douyinResponse(params.response.url);
        if (context && params.response.status === 200 && pending.size < 20) pending.set(params.requestId, context);
      } else if (method === 'Network.loadingFailed') pending.delete(params.requestId);
      else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
        const context = pending.get(params.requestId); pending.delete(params.requestId);
        if (params.encodedDataLength > 4 * 1024 * 1024) return;
        try {
          const response = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          if (browser !== this.window || response.body.length > 6 * 1024 * 1024) return;
          const data = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
          for (const video of douyinPayload(context, data)) { this.videos.set(video.id, video); if (this.videos.size > 500) this.videos.delete(this.videos.keys().next().value); }
          if (context.kind === 'post' && data.status_code === 0 && Array.isArray(data.aweme_list) && data.aweme_list.every(v => v.author?.sec_uid === context.id) && data.has_more === 0) this.postEnds.add(context.id);
        } catch { /* Page navigation may dispose a finished response; rendered fields remain available. */ }
      }
    });
    void debuggerApi.sendCommand('Network.enable', { maxResourceBufferSize: 4 * 1024 * 1024, maxTotalBufferSize: 8 * 1024 * 1024 }).catch(() => {});
  }
  async open(source, platform, accountId, signal, visible = true) {
    if (this.window && !this.window.isDestroyed() && this.creatorUrl === source && this.accountId === accountId && this.window.webContents.getURL() === this.targetUrl) { if (visible) this.window.show(); return this.window; }
    this.close();
    const session = accountId ? this.accounts.getSession(accountId) : undefined;
    this.window = this.accounts.usesExternal?.(platform,accountId)?await externalBrowserWindow(this.accounts.externalBrowser,source,platform,{session}):new BrowserWindow({ show: visible, width: 1100, height: 850, autoHideMenuBar: true, title: '博主作品 · 在官方页面完成登录或验证后返回风沙继续读取', webPreferences: { session, partition: session ? undefined : `fengsha-creator-guest-${platform}`, sandbox: true, nodeIntegration: false, contextIsolation: true, autoplayPolicy: 'document-user-activation-required' } });
    this.window.setMenu(null);
    this.window.webContents.setAudioMuted(true);
    const allowed = value => { try { const url = new URL(value); return platformOf(value) === platform && url.protocol === 'https:' && !url.username && !url.password && !url.port; } catch { return false; } };
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault(); });
    this.window.webContents.on('will-redirect', (e, url) => { if (!allowed(url)) e.preventDefault(); });
    const browser = this.window;
    const abort = () => { if (!browser.isDestroyed()) browser.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (platform === '抖音') this.capture(browser);
      const target = platform === '抖音' ? await resolveDouyin(source, (url, options) => shortLinkResponse(browser.webContents.session, url, options), AbortSignal.any([signal, AbortSignal.timeout(25000)])) : source;
      if (signal.aborted) throw new Error('CANCELLED');
      await browser.loadURL(target); if (signal.aborted) throw new Error('CANCELLED'); this.creatorUrl = source; this.targetUrl = target; this.accountId = accountId;
    } catch (error) {
      this.close();
      if (signal.aborted) throw new Error('CANCELLED');
      if (/ERR_|fetch failed/i.test(error.message)) throw new Error('抖音/小红书官方页面未能打开，请检查网络后重试，或重新复制博主主页链接；已关闭失败的空白窗口');
      throw error;
    }
    finally { signal.removeEventListener('abort', abort); }
    return browser;
  }
  async read(platform, id, signal) {
    if (signal.aborted || !this.window || this.window.isDestroyed()) throw new Error('官方窗口已关闭；点击继续读取会重新打开主页');
    if (platformOf(this.window.webContents.getURL()) !== platform) throw new Error('请在官方窗口打开对应博主主页');
    const result = await this.window.webContents.executeJavaScript(`(${renderedCreator.toString()})(${JSON.stringify(platform)}, ${JSON.stringify(id)})`);
    if (id && result.currentId !== id) throw new Error('官方窗口已切换到其他页面；请回到当前博主主页后继续读取');
    return result;
  }
  async identify(source, platform, accountId, signal) {
    await this.open(source, platform, accountId, signal);
    if (platform === '抖音') {
      const currentPath = new URL(douyinUrl(this.window.webContents.getURL())).pathname;
      if (!/^\/(?:video\/\d+|user\/[\w.-]+)$/.test(currentPath) || currentPath === '/user/self') throw new Error('当前页面未返回原视频或博主主页，请重新复制分享文案或博主主页链接');
    }
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      result = await this.read(platform, null, signal);
      const id = platform === '抖音' ? new URL(douyinUrl(this.window.webContents.getURL())).pathname.match(/^\/video\/(\d+)/)?.[1] : null;
      const video = id && this.videos?.get(id);
      if (video) result = { ...result, name: video.uploader, avatar: video.uploader_avatar || result.avatar, profileUrl: video.channel_url };
      if (result.name) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (signal.aborted) throw new Error('CANCELLED');
    }
    const currentUrl = this.window.webContents.getURL();
    const current = profileFromUrl(platform === '抖音' ? douyinUrl(currentUrl) : currentUrl);
    const original = profileFromUrl(this.targetUrl || source);
    if (original && current && original.id !== current.id) throw new Error('官方窗口已切换到其他博主，请回到原博主主页后重试');
    if (platform === '抖音' && new URL(this.targetUrl).pathname.startsWith('/video/') && douyinUrl(currentUrl) !== this.targetUrl) throw new Error('官方窗口已离开原视频，请重新识别原链接');
    const profile = current || (result.profileUrl ? profileFromUrl(platform === '抖音' ? douyinUrl(result.profileUrl) : result.profileUrl) : null);
    if (!profile || profile.platform !== platform) throw new Error('官方页面尚未返回作者主页。请在打开的官方窗口完成登录或验证，随后粘贴博主主页链接重新识别');
    if (!result.name) throw new Error('官方页面尚未显示博主资料，请完成登录或验证后重新识别');
    return { ...profile, name: result.name, avatar: result.avatar, supported: true, adapter: 'browser', reason: '实验接入：从官方主页已显示的发布作品读取链接，需要正常登录或手动验证；清单未到末页时不会标记完整。下载仍以实际解析为准。' };
  }
  async page(creator, count, signal, seen = []) {
    await this.open(creator.url, creator.platform, creator.accountId, signal);
    const skip = new Set(seen), found = new Map(); let complete = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const data = await this.read(creator.platform, creator.id, signal);
      if (!data.scopeFound) throw new Error('尚未显示该博主的发布作品列表。请在官方窗口选择“作品/笔记”并完成登录或验证，然后继续读取');
      for (const raw of data.items) {
        if (platformOf(raw.url) !== creator.platform) continue;
        const metadata = creator.platform === '抖音' && this.videos?.get(raw.id);
        if (metadata && (metadata.channel_id !== creator.id || metadata.isImage || !metadata.formats.length)) continue;
        const item = this.engine.item({ ...raw, ...metadata, uploader: creator.name }, raw.url, creator.platform);
        if (!skip.has(item.key)) found.set(item.key, item);
      }
      complete = data.complete || Boolean(this.postEnds?.has(creator.id));
      if (found.size >= count || complete) break;
      await this.window.webContents.executeJavaScript('document.querySelector("[data-e2e=user-post-list], .user-page .feeds-container, .user .feeds-container, .user-page .note-list")?.lastElementChild?.scrollIntoView({ block: "end" }); window.scrollTo(0, document.documentElement.scrollHeight)');
      await new Promise((resolve, reject) => { const timer = setTimeout(finish, 1200); const abort = () => finish(new Error('CANCELLED')); function finish(error) { clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); } signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    }
    const items = [...found.values()].slice(0, count);
    return { items, complete: complete && found.size <= count };
  }
  async videoInfo(source, accountId, signal) {
    await this.open(source, '抖音', accountId, signal, false);
    const url = douyinUrl(this.window.webContents.getURL());
    const id = new URL(url).pathname.match(/^\/video\/(\d+)$/)?.[1];
    if (!id) throw new Error('抖音分享链接未返回原视频，请重新复制分享链接');
    for (let attempt = 0; attempt < 12; attempt++) {
      if (signal.aborted) throw new Error('CANCELLED');
      if (this.window?.isDestroyed()) throw new Error('官方窗口已关闭，请重试');
      const video = this.videos?.get(id);
      if (video?.isImage) throw new Error('这是抖音图文作品，当前仅支持视频下载');
      if (video?.availability === 'private') throw new Error('Private video');
      if (video?.availability === 'restricted') throw new Error('DRM / paid content');
      if (video?.formats.length) return { ...video, http_headers: { ...video.http_headers, 'User-Agent': this.window.webContents.getUserAgent() } };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Fresh cookies / 登录验证：抖音页面尚未返回可下载的视频，请在账号管理完成登录或验证后重试');
  }
  close() { if (this.window && !this.window.isDestroyed()) this.window.close(); this.window = null; this.creatorUrl = null; this.targetUrl = null; this.accountId = null; this.videos = null; this.postEnds = null; }
}
