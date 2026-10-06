import { createHash } from 'node:crypto';
import { thumbnailUrl } from './thumbnail.js';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api.bilibili.com';
const keyOrder = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function wbiQuery(params, images, now = Date.now()) {
  const raw = [images?.img_url, images?.sub_url].map(u => String(u || '').split('/').at(-1).split('.')[0]).join('');
  if (raw.length !== 64 || !/^[a-f0-9]+$/i.test(raw)) throw new Error('B站签名资料缺失，请稍后重新读取');
  const key = keyOrder.map(i => raw[i]).join('').slice(0, 32);
  const data = { ...params, wts: Math.floor(now / 1000) };
  const query = Object.keys(data).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(data[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`;
}
export function biliDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(value || '')) return null;
  if (value.split(':').slice(1).some(part => Number(part) > 59)) return null;
  return value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) || null;
}
export function biliEntry(entry, creator) {
  if (entry?.meta?.attribute === 156) return null; // A hidden collection is not a video.
  if (!/^BV[\w]{10}$/.test(entry?.bvid || '') || String(entry.mid) !== String(creator.id)) throw new Error('B站返回了其他作者或无效的视频，清单已保留，请重新识别');
  return { id: entry.bvid, webpage_url: `https://www.bilibili.com/video/${entry.bvid}`, title: entry.title,
    uploader: entry.author || creator.name, uploader_id: String(creator.id), uploader_url: creator.url,
    thumbnail: thumbnailUrl(entry.pic), duration: biliDuration(entry.length), timestamp: Number.isFinite(Number(entry.created)) && Number(entry.created) > 0 ? Number(entry.created) : null,
    availability: entry.is_pay === 1 ? 'premium_only' : 'public' };
}
export class Bilibili {
  constructor(request = fetch, { interval = 1200 } = {}) { this.request = request; this.interval = interval; this.pages = new Map(); this.keys = new Map(); this.cooldowns = new Map(); this.tail = Promise.resolve(); this.lastRequest = 0; }
  async json(endpoint, accountId, signal, referer = 'https://www.bilibili.com/') {
    signal?.throwIfAborted();
    const previous = this.tail; let release; const gate = new Promise(r => release = r); this.tail = previous.then(() => gate);
    try {
      await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('CANCELLED')); };
        signal?.addEventListener('abort', abort, { once: true });
        previous.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      const wait = Math.max(0, this.lastRequest + this.interval - Date.now());
      if (wait) await delay(wait, undefined, { signal: signal || undefined });
      signal?.throwIfAborted(); this.lastRequest = Date.now();
      const origin = new URL(referer).origin;
      if (!['https://www.bilibili.com', 'https://space.bilibili.com'].includes(origin)) throw new Error('B站来源地址无效');
      const response = await this.request(API + endpoint, { accountId, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { Referer: origin + '/', Origin: origin, 'Accept-Language': 'zh-CN,zh;q=0.9', 'User-Agent': 'Mozilla/5.0' } });
      if ([401, 403, 412, 429].includes(response.status)) throw new Error(`BILIBILI_RISK ${response.status}`);
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      let data;
      try { data = await response.json(); } catch (error) { if (signal?.aborted || /Abort|Timeout/i.test(error.name)) throw error; throw new Error('BILIBILI_RESPONSE'); }
      if ([-352, -401, -412, -509, -799].includes(data?.code)) throw new Error(`BILIBILI_RISK ${Math.abs(data.code)}`);
      if (!Number.isInteger(data?.code)) throw new Error('BILIBILI_RESPONSE');
      if (data.code === -101 && !(endpoint === '/x/web-interface/nav' && data.data?.wbi_img)) throw new Error('Login required');
      if (data.code === -404) throw new Error('Video unavailable');
      // nav returns -101 for anonymous viewers but still supplies public WBI keys.
      if (data.code !== 0 && !(endpoint === '/x/web-interface/nav' && data.data?.wbi_img)) throw new Error('B站未返回有效资料，请在官方页面检查访问状态');
      if (!data.data || typeof data.data !== 'object') throw new Error('BILIBILI_RESPONSE');
      return data.data;
    } finally { release(); }
  }
  async detail(url, accountId, signal) {
    const id = new URL(url).pathname.match(/\/video\/(BV[\w]{10}|av\d+)/i)?.[1];
    if (!id) return null;
    const data = await this.json(`/x/web-interface/view?${id.toLowerCase().startsWith('av') ? 'aid=' + id.slice(2) : 'bvid=' + id}`, accountId, signal);
    if (id.startsWith('BV') ? data.bvid !== id : String(data.aid) !== id.slice(2)) throw new Error('B站视频详情与原链接不一致');
    if (!/^BV[\w]{10}$/.test(data.bvid || '') || !/^\d+$/.test(String(data.owner?.mid || ''))) throw new Error('BILIBILI_RESPONSE');
    const part = Number(new URL(url).searchParams.get('p') || 1), page = data.pages?.find(p => p.page === part);
    if (!Number.isSafeInteger(part) || part < 1) throw new Error('B站视频分P无效');
    if (data.pages?.length && !page) throw new Error('B站视频分P不存在，未修改原记录');
    return { id: data.bvid, title: part > 1 ? `${data.title} · ${page?.part || `第${part}P`}` : data.title, uploader: data.owner?.name, uploader_id: String(data.owner?.mid || ''), uploader_url: `https://space.bilibili.com/${data.owner?.mid}/video`, uploader_avatar: thumbnailUrl(data.owner?.face), thumbnail: thumbnailUrl(data.pic), duration: page?.duration || data.duration, timestamp: data.pubdate, pages: data.pages, availability: data.rights?.is_pay ? 'premium_only' : 'public' };
  }
  async page(creator, start, count, signal) {
    signal?.throwIfAborted();
    if (!/^\d+$/.test(creator.id) || !Number.isSafeInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 30) throw new Error('B站分页参数无效');
    const scope = `${creator.accountId || 'guest'}:${creator.id}`;
    if (Date.now() < (this.cooldowns.get(scope) || 0)) throw new Error('BILIBILI_RISK 请求冷却中；请等待一分钟再继续');
    const pn = Math.floor((start - 1) / 30) + 1, offset = (start - 1) % 30, key = `${scope}:${pn}`;
    let cached = this.pages.get(key);
    if (cached && Date.now() - cached.at > 60000) { this.pages.delete(key); cached = null; }
    let data = cached?.data;
    if (!data) {
      try {
        let signature = this.keys.get(creator.accountId || 'guest');
        if (!signature || Date.now() - signature.at > 30000) {
          const nav = await this.json('/x/web-interface/nav', creator.accountId, signal);
          signature = { images: nav.wbi_img, at: Date.now() }; this.keys.set(creator.accountId || 'guest', signature);
        }
        // Keep the current signed upload endpoint; a platform refusal must stop
        // this page rather than rotate endpoints or silently return an empty list.
        data = await this.json('/x/space/wbi/arc/search?' + wbiQuery({ mid: creator.id, pn, ps: 30, keyword: '', order: 'pubdate', order_avoided: 'true', platform: 'web', tid: 0, web_location: '333.1387', special_type: '', index: 0 }, signature.images), creator.accountId, signal, creator.url);
        if (!Array.isArray(data?.list?.vlist) || Number(data.page?.pn) !== pn || Number(data.page?.ps) !== 30 || !Number.isInteger(data.page?.count) || data.page.count < 0) throw new Error('B站分页资料缺失，已保留清单和读取位置');
        if (!data.list.vlist.length && start <= data.page.count) throw new Error('B站未返回预期作品，不能视为已到末页');
        if (data.list.vlist.length !== Math.max(0, Math.min(30, data.page.count - (pn - 1) * 30))) throw new Error('B站分页数量与作品总数不一致，已保留读取位置');
        // Validate the whole response before caching or advancing the checkpoint.
        const ids = new Set();
        for (const entry of data.list.vlist) { const item = biliEntry(entry, creator); if (!item) continue; if (ids.has(item.id)) throw new Error('B站重复返回作品，已保留读取位置'); ids.add(item.id); }
        for (const [otherKey, other] of this.pages) if (otherKey.startsWith(scope + ':') && otherKey !== key) {
          if (other.data.page.count !== data.page.count) throw new Error('B站作品总数在读取期间变化，请重新读取；原清单已保留');
          if (other.data.list.vlist.some(e => ids.has(e.bvid))) throw new Error('B站重复返回旧分页作品，已保留读取位置');
        }
        this.pages.set(key, { data, at: Date.now() }); if (this.pages.size > 12) this.pages.delete(this.pages.keys().next().value);
      } catch (error) { if (/BILIBILI_RISK/.test(error.message)) this.cooldowns.set(scope, Date.now() + 60000); throw error; }
    }
    const raw = data.list.vlist.slice(offset, offset + count);
    return { entries: raw.map(entry => biliEntry(entry, creator)).filter(Boolean), advance: raw.length, total: data.page.count, complete: start - 1 + raw.length >= data.page.count };
  }
  reset(creator) { const scope = `${creator.accountId || 'guest'}:${creator.id}:`; for (const key of this.pages.keys()) if (key.startsWith(scope)) this.pages.delete(key); }
}
