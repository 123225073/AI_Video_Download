import { thumbnailUrl } from './thumbnail.js';
import { searchInput, SEARCH_PLATFORMS } from './user-search-data.js';
export { SEARCH_PLATFORMS };
const clean = (v, max = 200000) => typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/\u0000/g, '').trim().slice(0, max) : '';
export function localDate(value = new Date()) {
  const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function contentDefaults(now = new Date()) {
  const d = new Date(now), previous = new Date(d.getFullYear(), d.getMonth(), 0);
  previous.setDate(Math.min(d.getDate(), previous.getDate()));
  return { limit:50, from:localDate(previous), to:localDate(d), includeUnknown:false };
}
export function contentOptions(platform, keyword, raw = {}, now = new Date()) {
  keyword = searchInput(platform, keyword); const defaults = contentDefaults(now);
  const limit = Number(raw.limit ?? defaults.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('采集数量请输入 1–500 的整数');
  const from = raw.from ?? defaults.from, to = raw.to ?? defaults.to;
  const valid = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && localDate(new Date(`${v}T12:00:00`)) === v;
  if (!valid(from) || !valid(to) || from > to || to > localDate(now)) throw new Error('请选择有效的发布日期范围，结束日期不能晚于今天');
  return { platform, keyword, limit, from, to, includeUnknown:raw.includeUnknown === true };
}
export function publishedDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return localDate(new Date(value+'T12:00:00')) === value ? value : null;
  const n = Number(value); if (!Number.isFinite(n) || n < 946684800) return null;
  const d = new Date(n > 1e12 ? n : n*1000); return Number.isFinite(d.getTime()) ? localDate(d) : null;
}
export function contentItem(platform, raw) {
  if (!SEARCH_PLATFORMS.includes(platform) || !raw) return null;
  const id = String(raw.id || '');
  const patterns = { '小红书':/^[a-f\d]{24}$/i, '抖音':/^\d{5,30}$/, 'B站':/^BV\w{10}$/, YouTube:/^[\w-]{11}$/, '视频号':/^[\w=-]{1,280}$/ };
  if (!patterns[platform].test(id) || !clean(raw.title,180)) return null;
  let url; try { url = new URL(raw.url); } catch { return null; }
  const hosts = { '小红书':['www.xiaohongshu.com','xiaohongshu.com'], '抖音':['www.douyin.com'], 'B站':['www.bilibili.com'], YouTube:['www.youtube.com'], '视频号':['channels.weixin.qq.com'] };
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts[platform].includes(url.hostname)) return null;
  const matches = platform === '小红书' ? new RegExp(`^/(?:explore|discovery/item)/${id}/?$`,'i').test(url.pathname)
    : platform === '抖音' ? new RegExp(`^/(?:video|note)/${id}/?$`).test(url.pathname)
    : platform === 'B站' ? url.pathname.replace(/\/$/,'') === `/video/${id}`
    : platform === 'YouTube' ? url.pathname === '/watch' && url.searchParams.get('v') === id
    : url.pathname === '/web/pages/feed' && (url.searchParams.get('eid') === id || raw.acquisition === 'wechat-collector' && url.searchParams.get('oid') === id);
  if (!matches) return null;
  const images = [...new Set((Array.isArray(raw.images) ? raw.images : []).map(thumbnailUrl).filter(Boolean))].slice(0,50);
  return { id, platform, key:`${platform}:${id}`, url:url.href, title:clean(raw.title,180), author:clean(raw.author,200).split(/\n+/).map(s=>s.trim()).filter((s,i,all)=>s&&all.indexOf(s)===i).join(' ').slice(0,100), text:clean(raw.text), images,
    thumbnail:thumbnailUrl(raw.thumbnail) || images[0] || '', publishedAt:publishedDate(raw.publishedAt), type:raw.type === 'image' ? 'image' : 'video',
    likes:typeof raw.likes === 'number' && raw.likes >= 0 ? raw.likes : null, acquisition:raw.acquisition || null, objectNonceId:typeof raw.objectNonceId === 'string' ? raw.objectNonceId : null, bodyComplete:raw.bodyComplete === true };
}
export function xhsContent(raw, token = '') {
  const r = raw?.note_card || raw?.noteCard || raw; if (!r) return null;
  const id = String(raw.id || r.note_id || r.noteId || '');
  const images = (r.image_list || r.imageList || []).map(i => i.info_list?.find(v => v.image_scene === 'WB_DFT')?.url || i.url_default || i.urlDefault || i.url);
  const security = raw.xsec_token || token;
  return contentItem('小红书', { id, url:`https://www.xiaohongshu.com/explore/${id}${security ? '?xsec_token='+encodeURIComponent(security)+'&xsec_source=pc_search' : ''}`, title:r.title || r.display_title || r.desc?.slice(0,80), text:r.desc || '', author:r.user?.nickname, images, thumbnail:r.cover?.url_default || r.cover?.url || images[0], type:r.type === 'normal' ? 'image' : 'video', publishedAt:r.time || r.create_time, likes:Number(r.interact_info?.liked_count), bodyComplete:!!r.desc && !!r.time });
}
export function douyinContent(r) {
  if (!r) return null; const id = String(r.aweme_id || ''), images = (r.images || r.image_post_info?.images || []).map(i=>i.url_list?.[0] || i.display_image?.url_list?.[0]);
  const image = images.length > 0;
  return contentItem('抖音', {id,url:`https://www.douyin.com/${image?'note':'video'}/${id}`, title:r.desc || '抖音作品',text:r.desc,images,type:image?'image':'video',thumbnail:r.video?.cover?.url_list?.[0],author:r.author?.nickname,publishedAt:r.create_time,likes:r.statistics?.digg_count,bodyComplete:true});
}
export function biliContent(r) {
  return contentItem('B站',{id:r.bvid,url:`https://www.bilibili.com/video/${r.bvid}`,title:r.title,text:r.description,author:r.author,thumbnail:r.pic,publishedAt:r.pubdate,likes:r.like,type:'video'});
}
export function wechatContent(r) {
  const m = r?.objectDesc?.media?.[0], id = String(r?.id || '');
  return contentItem('视频号',{id,url:`https://channels.weixin.qq.com/web/pages/feed?oid=${encodeURIComponent(id)}&nid=${encodeURIComponent(String(r.objectNonceId || ''))}`,title:r.objectDesc?.description || '视频号作品',text:r.objectDesc?.description,author:r.contact?.nickname,thumbnail:m?.thumbUrl || m?.coverUrl,publishedAt:r.createtime,type:'video',acquisition:'wechat-collector',objectNonceId:String(r.objectNonceId || ''),bodyComplete:true});
}
export function matchingContent(items, options) {
  return items.filter(i => i.publishedAt ? i.publishedAt >= options.from && i.publishedAt <= options.to : options.includeUnknown).slice(0,options.limit);
}
