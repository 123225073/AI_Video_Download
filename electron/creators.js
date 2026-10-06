import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { command } from './engine.js';
import { platformOf, validSource, classifyError, safeLog } from './core.js';
import { thumbnailUrl } from './thumbnail.js';

export const missingBiliMetadata = item => item.available !== false && (!item.title || item.title === '待获取标题' || !thumbnailUrl(item.thumbnail) || !item.duration || !item.publishedAt);

export function profileFromUrl(source) {
  const u = new URL(source), platform = platformOf(source);
  if (platform === '视频号' && u.hostname === 'channels.weixin.qq.com' && u.pathname === '/web/pages/profile') {
    const id = u.searchParams.get('username');
    if (id && id.length < 300 && !id.startsWith('shared_author_')) return { platform, id, url: source };
  }
  const match = platform === 'B站' && u.hostname === 'space.bilibili.com' ? u.pathname.match(/^\/(\d+)(?:\/|$)/)
    : platform === '抖音' ? u.pathname.match(/^\/user\/([\w.-]+)\/?$/)
    : platform === '小红书' ? u.pathname.match(/^\/user\/profile\/([a-f\d]{24})\/?$/i)
    : platform === 'YouTube' ? u.pathname.match(/^\/(channel\/UC[\w-]+|@[\w.%-]+|c\/[^/]+|user\/[^/]+)(?:\/(?:videos|shorts|streams))?\/?$/) : null;
  if (!match) return null;
  return { platform, id: match[1], url: platform === 'B站' ? `https://space.bilibili.com/${match[1]}/video` : platform === 'YouTube' ? `https://www.youtube.com/${match[1]}` : `${u.origin}${u.pathname.replace(/\/$/, '')}${u.search}` };
}
export function normalizeFilters(raw = {}, now = Date.now()) {
  const days = ['7', '30', '90'].includes(String(raw.period)) ? Number(raw.period) : null;
  const from = days ? new Date(now - days * 86400000).toISOString().slice(0, 10) : raw.period === 'custom' ? raw.from : null;
  const to = raw.period === 'custom' ? raw.to : null;
  for (const d of [from, to]) if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d)) throw new Error('请输入有效的起止日期');
  if (from && to && from > to) throw new Error('开始日期不能晚于结束日期');
  if (raw.period === 'custom' && (!from || !to)) throw new Error('自定义范围需要开始日期和结束日期');
  return { period: ['7', '30', '90', 'custom'].includes(String(raw.period)) ? String(raw.period) : 'all', from, to, limit: raw.limit === 'all' ? null : Math.max(1, Math.min(100000, Math.floor(Number(raw.limit) || 50))), keyword: String(raw.keyword || '').trim().slice(0, 100), excludeDownloaded: raw.excludeDownloaded !== false, includeUnknown: Boolean(raw.includeUnknown), videoOnly: true };
}
export function filterItem(item, filters, downloaded) {
  if (filters.keyword && !item.title.toLowerCase().includes(filters.keyword.toLowerCase())) return 'keyword';
  if (filters.excludeDownloaded && downloaded(item)) return 'downloaded';
  if (filters.from || filters.to) {
    const d = String(item.publishedAt || '').replaceAll('-', '').slice(0, 8);
    if (!/^\d{8}$/.test(d)) return filters.includeUnknown ? null : 'unknown-date';
    if (filters.from && d < filters.from.replaceAll('-', '') || filters.to && d > filters.to.replaceAll('-', '')) return 'date';
  }
  return null;
}

export class Creators {
  constructor(store, engine, browser, changed, wechatCreators = null) { this.store = store; this.engine = engine; this.browser = browser; this.changed = changed; this.wechatCreators = wechatCreators; this.active = null; }
  async exclusive(fn, label, useWechat = false) {
    if (this.active) throw new Error('正在读取博主，请先停止当前读取');
    const controller = new AbortController(); this.active = { controller, label }; this.changed();
    const promise = (async () => { try { return useWechat && this.connection ? await this.connection.withConnection(controller.signal, () => fn(controller.signal)) : await fn(controller.signal); } finally { this.active = null; this.changed(); } })();
    this.active.promise = promise; return promise;
  }
  progress() { return this.active ? { label: this.active.label } : null; }
  async identityMetadata(source, platform, signal) {
    const u = new URL(source);
    let endpoint, biliProfile;
    if (platform === 'B站') {
      const video = u.pathname.match(/\/video\/(BV[\w]+|av\d+)/i)?.[1];
      biliProfile = profileFromUrl(source);
      if (!video && !biliProfile) return null;
      endpoint = biliProfile ? `https://api.bilibili.com/x/web-interface/card?mid=${biliProfile.id}` : `https://api.bilibili.com/x/web-interface/view?${video.startsWith('av') ? 'aid=' + video.slice(2) : 'bvid=' + video}`;
    } else if (platform === 'YouTube') {
      const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1];
      if (!/^[\w-]{11}$/.test(id || '')) return null;
      endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}&format=json`;
    } else return null;
    try {
      let data;
      if (platform === 'B站' && this.engine.bilibili) data = { code: 0, data: await this.engine.bilibili.json(endpoint.replace('https://api.bilibili.com', ''), this.engine.accounts?.active('B站')?.id, signal) };
      else {
        const response = await fetch(endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), headers: { Referer: platform === 'B站' ? 'https://www.bilibili.com/' : 'https://www.youtube.com/' }, redirect: 'error' });
        if (!response.ok) return null;
        data = await response.json();
      }
      if (platform === 'B站' && biliProfile && data.code === 0 && String(data.data?.card?.mid) === biliProfile.id) return { id: biliProfile.id, name: data.data.card.name, avatar: data.data.card.face, total: Number.isInteger(data.data.archive_count) ? data.data.archive_count : null };
      if (platform === 'B站' && data.code === 0 && data.data?.owner?.mid) return { id: String(data.data.owner.mid), name: data.data.owner.name, avatar: data.data.owner.face };
      if (platform === 'YouTube' && data.author_url && platformOf(data.author_url) === platform && profileFromUrl(data.author_url)) return { url: data.author_url, name: data.author_name };
    } catch (error) { if (signal.aborted) throw error; }
    return null;
  }
  cancel() { this.active?.controller.abort(); this.browser?.close(); }
  async close() { this.cancel(); await this.active?.promise?.catch(() => {}); this.browser?.close(); }
  async flat(url, platform, start, count, signal, accountId) {
    const args = await this.engine.arguments(platform, accountId);
    args.push('--dump-single-json', '--skip-download', '--flat-playlist', '--playlist-start', String(start), '--playlist-end', String(start + count - 1), '--', url);
    return JSON.parse(await command(path.join(this.engine.bin, 'yt-dlp.exe'), args, { signal, timeout: 120000 }));
  }
  async identify(source) {
    validSource(source);
    return this.exclusive(async signal => {
      const platform = platformOf(source); let profile = profileFromUrl(source); const account = this.engine.accounts?.active(platform);
      let creator;
      if (['抖音', '小红书'].includes(platform)) creator = await this.browser.identify(source, platform, account?.id, signal);
      else if (platform === '视频号') {
        let parsed, parseError;
        if (!profile && !(this.connection && this.wechatCreators?.config().enabled)) { try { parsed = await this.engine.parse(source, { limit: 1, signal }); } catch (error) { if (signal.aborted) throw error; parseError = error; } }
        const item = parsed?.items[0];
        creator = { platform, name: item?.author || '未知作者', avatar: item?.creatorAvatar || '', id: item?.creatorId || null, url: null, supported: false, needsCollector: true, reason: '已取得原视频作者资料。读取作者作品还需要本机视频号采集服务，并在微信中打开视频号页面；请连接服务后重新识别。也可返回新建下载，使用批量链接下载所需视频。' };
        if (profile) creator = { ...creator, name: '视频号作者（昵称待读取）', id: profile.id, url: profile.url, reason: '已取得主页作者 ID。请连接本机视频号采集服务，并在微信中打开该作者主页，再重新识别。' };
        if (this.wechatCreators?.config().enabled) {
          try { creator = { ...creator, ...await (profile ? this.wechatCreators.identifyProfile(profile, signal) : this.wechatCreators.identify(source, item, signal)), needsCollector: false }; }
          catch (error) { if (signal.aborted) throw error; if (parseError) throw new Error(`作者资料尚未读取：${error.message}；单视频解析需要有效的元宝登录`); creator.reason = error.message; }
        }
        else if (parseError) throw parseError;
      } else if (['YouTube', 'B站'].includes(platform)) {
        const metadata = profile && platform !== 'B站' ? null : await this.identityMetadata(source, platform, signal);
        if (metadata?.url) profile = profileFromUrl(metadata.url);
        let item, data;
        if (metadata?.id) item = { author: metadata.name, creatorId: metadata.id };
        else if (profile?.platform === 'B站') item = { author: `B站作者 · UID ${profile.id}（昵称待获取）`, creatorId: profile.id };
        else if (profile) {
          data = await this.flat(platform === 'YouTube' ? `${profile.url}/videos` : profile.url, platform, 1, 1, signal, account?.id);
          const first = data.entries?.find(Boolean);
          item = this.engine.item({ ...first, uploader: data.uploader || data.channel || first?.uploader, channel_id: data.channel_id || first?.channel_id, uploader_id: data.uploader_id || first?.uploader_id, channel_url: data.channel_url || first?.channel_url }, first?.url?.startsWith('https://') ? first.url : source, platform);
        } else item = (await this.engine.parse(source, { limit: 1, signal })).items[0];
        const id = platform === 'B站' ? (profile?.id || item?.creatorId) : (item?.creatorId?.startsWith('UC') ? item.creatorId : data?.id?.startsWith('UC') ? data.id : null);
        const url = platform === 'B站' && /^\d+$/.test(id || '') ? `https://space.bilibili.com/${id}/video` : platform === 'YouTube' && id ? `https://www.youtube.com/channel/${id}` : null;
        if (!url) throw new Error('原链接未返回稳定的作者 ID，不能用同名搜索结果代替；请直接粘贴博主主页链接');
        creator = { platform, id, url, name: metadata?.name || item.author, avatar: thumbnailUrl(metadata?.avatar || data?.thumbnails?.find(t => t.id === 'avatar_uncropped')?.url || ''), total: metadata?.total ?? null, supported: true, adapter: platform === 'B站' && this.engine.bilibili ? 'bilibili' : 'yt-dlp', listUrl: platform === 'YouTube' ? `https://www.youtube.com/playlist?list=UU${id.slice(2)}` : url, reason: platform === 'B站' ? '按 B站实际页码读取完整作品资料；遇到平台限制时保留清单，请登录、完成官方验证或等待后继续。' : null };
        if (platform === 'B站' && creator.total === null) { const header = await this.identityMetadata(url, platform, signal); if (header?.id === id) Object.assign(creator, { total: header.total, avatar: header.avatar || creator.avatar, name: header.name || creator.name }); }
        if (platform === 'YouTube' && !creator.avatar) {
          try { const header = await this.flat(`${url}/videos`, platform, 1, 1, signal, account?.id); if (header.channel_id === id || header.id === id) creator.avatar = header.thumbnails?.find(t => t.id === 'avatar_uncropped')?.url || ''; }
          catch (error) { if (signal.aborted) throw error; }
        }
      } else throw new Error('该平台尚未接入博主识别');
      const record = { id: randomUUID(), creator: { ...creator, accountId: account?.id || null }, source, total: creator.total ?? null, items: [], scanned: 0, cursor: 1, seen: [], status: creator.supported ? 'identified' : 'needs-connection', complete: false, skipped: {}, createdAt: Date.now() };
      this.store.put('creator', record.id, record); this.store.put('meta', 'lastCreator', { id: record.id }); this.store.flush(); return record;
    }, '正在从原链接识别博主', platformOf(source) === '视频号');
  }
  last() { const id = this.store.get('meta', 'lastCreator')?.id; const r = id ? this.store.get('creator', id) : null; if (!r) return null; return { ...r, recoveryAvailable: !r.items.length && Boolean(this.previous(r)), ...(r.status === 'reading' ? { status: 'interrupted', message: '上次读取被中断，可继续读取已保存清单' } : {}) }; }
  previous(record) {
    if (record?.creator.platform !== 'B站') return null;
    return this.store.list('creator').filter(old => old.id !== record.id && old.creator?.platform === 'B站' && old.creator.id === record.creator.id && (old.creator.accountId || null) === (record.creator.accountId || null) && old.items?.length).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }
  recover(id) {
    if (this.active) throw new Error('请先停止当前读取');
    const record = this.store.get('creator', id), previous = this.previous(record);
    if (!record || record.items?.length || !previous) throw new Error('没有可恢复的同一作者清单');
    const restored = { ...previous, id: record.id, source: record.source, createdAt: record.createdAt, complete: false, status: 'interrupted', restartRequired: true, recoveryAvailable: false, message: `已恢复同一作者上次保存的 ${previous.items.length} 条清单（历史结果，并非本次新读取）；继续读取将从第一页重读。` };
    this.store.put('creator', id, restored); this.store.flush(); this.changed(); return restored;
  }
  async refresh(id) {
    let record = this.store.get('creator', id);
    if (!record || record.creator.platform !== 'B站' || !this.engine.bilibili) throw new Error('仅支持补全已保存的 B站作品清单');
    return this.exclusive(async signal => {
      let updated = 0, unavailable = 0;
      const accountId = this.engine.accounts?.active('B站')?.id;
      const pending = record.items.filter(missingBiliMetadata).slice(0, 50);
      const save = message => { record = { ...record, metadataMessage: message, metadataPending: record.items.filter(missingBiliMetadata).length }; this.store.put('creator', id, record); this.store.flush(); this.changed(); };
      for (const item of pending) {
        try {
          signal.throwIfAborted();
          this.active.label = `正在补全作品信息 ${updated + 1} / ${pending.length}`; this.changed();
          if (this.engine.accounts?.active('B站')?.id !== accountId) throw new Error('读取期间切换了 B站账号，已保留补全进度，请再次补全');
          const data = await this.engine.bilibili.detail(item.url, accountId, signal);
          if (!data || data.uploader_id !== String(record.creator.id)) throw new Error('B站视频详情与当前博主不一致，未修改清单');
          const metadata = this.engine.item(data, item.url, 'B站', item.collection, item.part);
          const populated = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => value !== null && value !== undefined && value !== '' && !(key === 'title' && value === '待获取标题')));
          record = { ...record, items: record.items.map(old => old.key === item.key ? { ...old, ...populated, height: old.height || metadata.height } : old) };
          updated++; save(`已补全 ${updated} 条作品信息`);
        } catch (error) {
          const classified = classifyError(error.message);
          if (!signal.aborted && ['unavailable', 'restricted'].includes(classified.category)) {
            record = { ...record, items: record.items.map(old => old.key === item.key ? { ...old, available: false, metadataError: classified.message } : old) };
            unavailable++; save(`已补全 ${updated} 条，另有 ${unavailable} 条失效或受限作品`); continue;
          }
          save(signal.aborted ? `已停止补全，已取得的 ${updated} 条信息保留` : `已补全 ${updated} 条；${classified.category === 'unknown' ? safeLog(error.message) : classified.message}`);
          return record;
        }
      }
      save(`已补全 ${updated} 条作品信息${unavailable ? `，${unavailable} 条失效或受限作品已标注` : ''}${record.items.filter(missingBiliMetadata).length ? '，仍有缺失信息，可再次补全' : '，当前可用作品信息完整'}`);
      return record;
    }, '正在补全 B站作品信息');
  }
  async page(id, rawFilters, reset = false, extend = false) {
    const original = this.store.get('creator', id); if (!original) throw new Error('博主清单不存在，请重新识别');
    if (!original.creator.supported) throw new Error(original.creator.reason);
    return this.exclusive(async signal => {
      const restart = !reset && Boolean(original.restartRequired);
      reset = reset || restart;
      let r = reset ? { ...original, items: [], scanned: 0, cursor: 1, seen: [], skipped: {}, complete: false, restartRequired: false, collectorCursor: null, collectorPending: [], usedCollectorCursors: [], filters: normalizeFilters(restart ? original.filters : rawFilters) } : { ...original, filters: original.filters || normalizeFilters(rawFilters) };
      const account = this.engine.accounts?.active(r.creator.platform);
      if (!reset && r.creator.platform === 'B站' && r.scanned > 0 && (r.creator.accountId || null) !== (account?.id || null)) {
        const retained = { ...original, status: 'interrupted', complete: false, restartRequired: true, message: 'B站账号已切换，原清单保留；继续读取将从第一页重新读取，避免混用不同账号的分页。' };
        this.store.put('creator', id, retained); this.store.flush(); return retained;
      }
      r.creator = { ...r.creator, accountId: account?.id || null };
      if (extend && r.filters.limit) r.filters = { ...r.filters, limit: r.filters.limit + 50 };
      if (r.complete) return r;
      const count = Math.min(r.creator.platform === 'B站' && this.engine.bilibili ? 30 : 50, r.filters.limit === null ? 50 : r.filters.limit - r.scanned);
      if (count <= 0) return { ...r, status: 'limited' };
      const checkpoint = { ...r, status: 'reading', message: null }; this.store.put('creator', id, checkpoint); this.store.flush();
      try {
        let entries, final, total = r.total, browserEnd = false, collector, advance;
        if (r.creator.adapter === 'wechat-collector') {
          collector = await this.wechatCreators.page(r.creator, count, signal, r.collectorCursor, r.collectorPending);
          if (!r.collectorPending?.length && !collector.complete && (r.usedCollectorCursors || []).includes(JSON.stringify(collector.next))) throw new Error('平台重复返回旧分页位置，已保留清单；请稍后继续读取');
          entries = collector.items; final = collector.complete; total = collector.total;
          if (collector.profile?.id === r.creator.id) r.creator = { ...r.creator, name: collector.profile.name || r.creator.name, avatar: collector.profile.avatar || r.creator.avatar };
        } else if (r.creator.adapter === 'browser') {
          const data = await this.browser.page(r.creator, count, signal, r.seen); entries = data.items; browserEnd = data.complete; final = false;
        } else {
          if (r.creator.platform === 'B站' && this.engine.bilibili) {
            if (reset) this.engine.bilibili.reset(r.creator);
            const data = await this.engine.bilibili.page(r.creator, r.cursor, count, signal);
            entries = data.entries.map(e => this.engine.item(e, e.webpage_url, 'B站'));
            final = data.complete; total = data.total; advance = data.advance;
          } else {
          const data = await this.flat(r.creator.listUrl, r.creator.platform, r.cursor, count, signal, r.creator.accountId);
          entries = (data.entries || []).filter(Boolean).map(e => this.engine.item({ ...e, uploader: r.creator.name }, e.webpage_url || (e.url?.startsWith('https://') ? e.url : r.creator.platform === 'YouTube' ? `https://www.youtube.com/watch?v=${e.id}` : `https://www.bilibili.com/video/${e.id}`), r.creator.platform));
          total = Number(data.playlist_count || 0) || r.total || null;
          final = entries.length < count || Boolean(total && r.scanned + entries.length >= total);
          }
        }
        const seen = new Set(r.seen), downloaded = item => { const m = this.store.get('media', item.key); return Boolean(m && fs.existsSync(m.filePath)); };
        if (r.creator.platform === 'B站' && entries.some(item => seen.has(item.key))) throw new Error('B站重复返回已读取作品，请重新读取；原清单和位置已保留');
        const items = [...r.items], skipped = { ...r.skipped };
        for (let item of entries) {
          if (seen.has(item.key)) continue;
          seen.add(item.key);
          // Flat lists may lack exact dates. Hydrate one video at a time only when a date filter is requested.
          if ((r.filters.from || r.filters.to) && !item.publishedAt && r.creator.adapter !== 'browser') {
            try { item = { ...item, ...(await this.engine.parse(item.url, { limit: 1, signal })).items[0] }; }
            catch (error) { if (signal.aborted) throw error; const c = classifyError(error.message); if (['auth', 'rate-limit', 'network'].includes(c.category)) throw error; }
          }
          const why = filterItem(item, r.filters, downloaded);
          if (why) skipped[why] = (skipped[why] || 0) + 1; else items.push(item);
        }
        if (signal.aborted) throw new Error('CANCELLED');
        const scanned = r.scanned + (advance ?? entries.length);
        const progressed = collector && (JSON.stringify(collector.next) !== JSON.stringify(r.collectorCursor) || collector.pending.length !== (r.collectorPending?.length || 0));
        if (collector && !r.collectorPending?.length) r.usedCollectorCursors = [...(r.usedCollectorCursors || []), JSON.stringify(collector.next)];
        r = { ...r, items, skipped, scanned, cursor: r.cursor + (advance ?? entries.length), ...(collector ? { collectorCursor: collector.next, collectorPending: collector.pending } : {}), seen: [...seen], total, complete: final, status: browserEnd ? 'browser-end' : final ? 'complete' : r.filters.limit !== null && scanned >= r.filters.limit ? 'limited' : entries.length || advance || progressed ? 'partial' : 'interrupted', message: browserEnd ? '官方页面显示已到末页，当前清单仅包含实际读取到的展示作品；尚不能保证覆盖该账号全部作品。' : !entries.length && !advance && !final && !progressed ? '页面暂未出现新作品，请在官方窗口加载作品后继续读取' : null };
        this.store.put('creator', id, r); this.store.flush(); return r;
      } catch (error) {
        const c = classifyError(error.message);
        if (c.category === 'auth') this.engine.accounts?.markExpired(r.creator.platform, r.creator.accountId);
        const preserve = reset && original.creator.platform === 'B站' && original.items.length ? original : checkpoint;
        r = { ...preserve, complete: false, restartRequired: preserve === original || Boolean(preserve.restartRequired) || /重复返回|读取期间变化/.test(error.message), status: signal.aborted ? 'cancelled' : 'interrupted', message: signal.aborted ? '已停止；已读取清单保留，可继续读取' : (preserve === original ? '重新读取失败，原清单已保留；' : '') + (c.category === 'unknown' ? safeLog(error.message) : c.message) };
        r.recoveryAvailable = !r.items.length && Boolean(this.previous(r));
        this.store.put('creator', id, r); this.store.flush(); return r;
      }
    }, '正在分页读取博主作品', original.creator.platform === '视频号');
  }
}
