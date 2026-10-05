import { createHash } from 'node:crypto';
import { thumbnailUrl } from './thumbnail.js';

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
  if (typeof value === 'number') return value > 0 ? value : null;
  if (!/^\d+(?::\d{1,2}){1,2}$/.test(value || '')) return null;
  return value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) || null;
}
export function biliEntry(entry, creator) {
  if (!/^BV[\w]{10}$/.test(entry?.bvid || '') || String(entry.mid) !== String(creator.id)) throw new Error('B站返回了其他作者或无效的视频，清单已保留，请重新识别');
  if (entry.meta?.attribute === 156) return null; // A hidden collection is not a video.
  return { id: entry.bvid, webpage_url: `https://www.bilibili.com/video/${entry.bvid}`, title: entry.title,
    uploader: entry.author || creator.name, uploader_id: String(creator.id), uploader_url: creator.url,
    thumbnail: thumbnailUrl(entry.pic), duration: biliDuration(entry.length), timestamp: Number(entry.created) || null,
    availability: entry.is_pay === 1 ? 'premium_only' : 'public' };
}
export class Bilibili {
  constructor(request = fetch, { interval = 800 } = {}) { this.request = request; this.interval = interval; this.pages = new Map(); this.keys = new Map(); this.cooldowns = new Map(); this.tail = Promise.resolve(); this.lastRequest = 0; }
  async json(endpoint, accountId, signal, referer = 'https://www.bilibili.com/') {
    const previous = this.tail; let release; this.tail = new Promise(r => release = r); await previous;
    try {
      signal?.throwIfAborted();
      const wait = Math.max(0, this.lastRequest + this.interval - Date.now());
      if (wait) await new Promise((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(new Error('CANCELLED')); }; const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, wait); signal?.addEventListener('abort', abort, { once: true }); });
      signal?.throwIfAborted(); this.lastRequest = Date.now();
      const response = await this.request(API + endpoint, { accountId, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' } });
      if ([401, 403, 412, 429].includes(response.status)) throw new Error(`BILIBILI_RISK ${response.status}`);
      if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
      const data = await response.json();
      if ([-352, -401, -412, -509].includes(data.code)) throw new Error(`BILIBILI_RISK ${Math.abs(data.code)}`);
      if (data.code === -101 && !(endpoint === '/x/web-interface/nav' && data.data?.wbi_img)) throw new Error('Login required');
      if (data.code === -404) throw new Error('Video unavailable');
      // nav returns -101 for anonymous viewers but still supplies public WBI keys.
      if (data.code !== 0 && !(endpoint === '/x/web-interface/nav' && data.data?.wbi_img)) throw new Error('B站未返回有效资料，请在官方页面检查访问状态');
      return data.data;
    } finally { release(); }
  }
  async detail(url, accountId, signal) {
    const id = new URL(url).pathname.match(/\/video\/(BV[\w]{10}|av\d+)/i)?.[1];
    if (!id) return null;
    const data = await this.json(`/x/web-interface/view?${id.toLowerCase().startsWith('av') ? 'aid=' + id.slice(2) : 'bvid=' + id}`, accountId, signal);
    if (id.startsWith('BV') && data.bvid !== id) throw new Error('B站视频详情与原链接不一致');
    const part = Number(new URL(url).searchParams.get('p') || 1), page = data.pages?.find(p => p.page === part);
    if (data.pages?.length && !page) throw new Error('B站视频分P不存在，未修改原记录');
    return { id: data.bvid, title: part > 1 ? `${data.title} · ${page?.part || `第${part}P`}` : data.title, uploader: data.owner?.name, uploader_id: String(data.owner?.mid || ''), uploader_url: `https://space.bilibili.com/${data.owner?.mid}/video`, uploader_avatar: thumbnailUrl(data.owner?.face), thumbnail: thumbnailUrl(data.pic), duration: page?.duration || data.duration, timestamp: data.pubdate, pages: data.pages, availability: data.rights?.is_pay ? 'premium_only' : 'public' };
  }
  async page(creator, start, count, signal) {
    const scope = `${creator.accountId || 'guest'}:${creator.id}`;
    if (Date.now() < (this.cooldowns.get(scope) || 0)) throw new Error('BILIBILI_RISK 请求冷却中；请等待一分钟再继续');
    const pn = Math.floor((start - 1) / 30) + 1, offset = (start - 1) % 30, key = `${scope}:${pn}`;
    let data = this.pages.get(key);
    if (!data) {
      try {
        let signature = this.keys.get(creator.accountId || 'guest');
        if (!signature || Date.now() - signature.at > 30000) {
          const nav = await this.json('/x/web-interface/nav', creator.accountId, signal);
          signature = { images: nav.wbi_img, at: Date.now() }; this.keys.set(creator.accountId || 'guest', signature);
        }
        data = await this.json('/x/space/wbi/arc/search?' + wbiQuery({ mid: creator.id, pn, ps: 30, order: 'pubdate', order_avoided: true, platform: 'web', tid: 0, web_location: '333.1387' }, signature.images), creator.accountId, signal, creator.url);
        if (!Array.isArray(data?.list?.vlist) || Number(data.page?.pn) !== pn || Number(data.page?.ps) !== 30 || !Number.isInteger(data.page?.count) || data.page.count < 0) throw new Error('B站分页资料缺失，已保留清单和读取位置');
        if (!data.list.vlist.length && start <= data.page.count) throw new Error('B站未返回预期作品，不能视为已到末页');
        // Validate the whole response before caching or advancing the checkpoint.
        for (const entry of data.list.vlist) biliEntry(entry, creator);
        this.pages.set(key, data); if (this.pages.size > 12) this.pages.delete(this.pages.keys().next().value);
      } catch (error) { if (/BILIBILI_RISK/.test(error.message)) this.cooldowns.set(scope, Date.now() + 60000); throw error; }
    }
    const raw = data.list.vlist.slice(offset, offset + count);
    return { entries: raw.map(entry => biliEntry(entry, creator)).filter(Boolean), advance: raw.length, total: data.page.count, complete: start - 1 + raw.length >= data.page.count };
  }
  reset(creator) { const scope = `${creator.accountId || 'guest'}:${creator.id}:`; for (const key of this.pages.keys()) if (key.startsWith(scope)) this.pages.delete(key); }
}
