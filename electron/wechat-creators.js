import { platformOf, validSource } from './core.js';

export function wechatCreatorId(value) {
  return typeof value === 'string' && value.trim() && value === value.trim() && value.length < 300 && !value.startsWith('shared_author_') ? value : null;
}
export function requireWechatIdentity(creator) {
  const id = wechatCreatorId(creator?.id);
  if (!id || creator.identityStatus === 'pending') throw new Error('尚未确认稳定作者 ID，不能读取作者作品。请在微信打开原视频或粘贴含 username 的作者主页链接后重新识别；不会按昵称匹配作者。');
  return id;
}
// Official jump links encode uint64 IDs; collector/cache APIs use decimal IDs.
export function wechatFeedId(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d+$/.test(value)) return BigInt(value) <= 0xffffffffffffffffn ? value : null;
  if (!/^[A-Za-z0-9_-]{11}=?$/.test(value)) return null;
  const bytes = Buffer.from(value.replace(/=$/, ''), 'base64url');
  return bytes.length === 8 && bytes.toString('base64url') === value.replace(/=$/, '') ? bytes.readBigUInt64BE().toString() : null;
}
export function wechatVideoLocator(url, item) {
  const source = new URL(url);
  if (source.hostname !== 'channels.weixin.qq.com' || source.pathname !== '/web/pages/feed' || item?.acquisition !== 'wechat-collector' || typeof item.sourceId !== 'string' || !/^\d+$/.test(item.sourceId) || !wechatCreatorId(item.creatorId)) return null;
  if (wechatFeedId(source.searchParams.get('oid')) !== item.sourceId || source.searchParams.get('username') && source.searchParams.get('username') !== item.creatorId) throw new Error('作品链接与所选视频或作者不一致，请重新读取作品');
  if (typeof item.objectNonceId === 'number' && !Number.isSafeInteger(item.objectNonceId)) throw new Error('作品标识精度异常，请重新读取作品');
  const nid = wechatFeedId(source.searchParams.get('nid')),nonce = String(item.objectNonceId || nid || '');
  if (nonce.length > 200 || /[^\w-]/.test(nonce)) throw new Error('作品标识无效，请重新读取作品');
  if (nid && /^\d+/.test(nonce) && nonce.split('_')[0] !== nid) throw new Error('作品链接与所选视频标识不一致，请重新读取作品');
  return {url:source.href,platform:'视频号',acquisition:'wechat-collector',sourceId:item.sourceId,objectNonceId:nonce,creatorId:item.creatorId,title:String(item.title || '').slice(0,180)};
}
function feedUrl(raw, username) {
  if (typeof raw.sourceUrl === 'string' && platformOf(raw.sourceUrl) === '视频号') {
    try { return validSource(raw.sourceUrl); } catch { /* Rebuild from the exact object ID below. */ }
  }
  // v260907: model.go BuildJumpURLFromParts + util.go EncodeUint64ToBase64.
  const encode = value => {
    if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) > 0xffffffffffffffffn) return null;
    const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes.toString('base64url');
  };
  const oid = encode(raw.id);
  if (!oid) throw new Error('作品 ID 无效，无法构造准确的作品链接；已保留清单和读取位置，请重新读取');
  const url = new URL('https://channels.weixin.qq.com/web/pages/feed');
  url.searchParams.set('username', username); url.searchParams.set('oid', oid);
  const nid = encode(String(raw.nonce || '').split('_')[0]);
  if (nid) url.searchParams.set('nid', nid);
  return url.href;
}

export function collectorBase(value) {
  let u; try { u = new URL(String(value || 'http://127.0.0.1:2022').trim()); } catch { throw new Error('请填写本机视频号采集服务地址'); }
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['/', ''].includes(u.pathname)) throw new Error('视频号采集服务只允许本机地址，例如 http://127.0.0.1:2022');
  return u.origin;
}
function identity(contact = {}) {
  const id = contact.username || contact.finderUsername || contact.userName;
  return { id: wechatCreatorId(id), name: contact.nickname || '', avatar: contact.headUrl || contact.headImgUrl || contact.headimgurl || '', signature: contact.signature || '' };
}
export function wechatMetadata(feed = {}, parsed = {}) {
  const data = feed.data || feed;
  const object = data.object && !Array.isArray(data.object) ? data.object : null;
  const info = data.feedInfo || data.feedinfo || {};
  const author = identity(object?.contact || data.authorInfo || data.authorinfo || info.contact || {});
  return { ...author, name: author.name || parsed.author || '未知作者', thumbnail: object?.objectDesc?.media?.[0]?.thumbUrl || object?.objectDesc?.media?.[0]?.coverUrl || info.coverUrl || info.coverurl || '', sourceId: typeof object?.id === 'string' ? object.id : null, publishedAt: Number(object?.createtime || info.createTime || info.createtime) ? new Date(Number(object?.createtime || info.createTime || info.createtime) * 1000).toISOString().slice(0, 10).replaceAll('-', '') : null };
}
export class WeChatCreators {
  constructor(store, engine, request = fetch, codec = null) { this.store = store; this.engine = engine; this.fetch = request; this.codec=codec;this.mediaCache=new Map();this.staleMedia=new Set(); }
  config() { return { enabled: true, automatic:true, baseUrl: 'http://127.0.0.1:2022', ...this.store.get('collector-config', 'wechat') }; }
  save(raw) { const c = { enabled: Boolean(raw.enabled), automatic:raw.automatic !== false, baseUrl: collectorBase(raw.baseUrl) }; if(c.automatic && c.baseUrl!=='http://127.0.0.1:2022') throw new Error('自动连接使用内置本机地址；自定义服务请选择手动连接'); this.store.put('collector-config', 'wechat', c); this.store.flush(); return c; }
  async request(route, params = {}, signal) {
    const c = this.config(); if (!c.enabled) throw new Error('请先在设置中连接本机视频号采集服务');
    const u = new URL(route, collectorBase(c.baseUrl)); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v ?? ''));
    let response; try { response = await this.fetch(u.href, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' }); } catch { if (signal?.aborted) throw new Error('已停止读取'); throw new Error('未连接视频号采集服务，请启动本机服务，并在微信中打开视频号页面后重试'); }
    if (!response.ok) throw new Error(`视频号采集服务未就绪（HTTP ${response.status}），请检查微信页面是否已连接`);
    let text = await response.text(); if (text.length > 8 * 1024 * 1024) throw new Error('视频号列表过大，请缩小范围');
    // Platform IDs exceed JS's integer precision; preserve numeric IDs before JSON parsing.
    text = text.replace(/("(?:id|objectId|objectNonceId|decodeKey|commentId|replyCommentId)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"');
    let payload; try { payload = JSON.parse(text); } catch { throw new Error('视频号采集服务返回了无效数据，请检查服务版本'); }
    if (payload.code !== undefined) { if (Number(payload.code) !== 0) throw new Error(`视频号采集请求失败：${String(payload.message || payload.msg || '服务未返回结果').slice(0,240)}`); payload = payload.data; }
    if (payload?.errCode) throw new Error(`微信页面接口未完成：${String(payload.errMsg || '接口调用失败').slice(0,240)}`);
    if (payload?.data?.BaseResponse?.Ret) throw new Error('微信官方接口拒绝了本次请求，请检查官方页面的登录或验证状态');
    return payload?.data || payload;
  }
  async test() { const data = await this.request('/api/channels/status'); if (typeof data?.available !== 'boolean') throw new Error('服务未返回微信连接状态，请检查采集服务版本'); return { connected: data.available, detail: data.available ? '微信页面已连接；搜索和作品读取能力将在实际请求时验证' : '微信页面未连接；请开始识别以自动准备连接，再在微信进入视频号页面' }; }
  async resolve(item, signal) {
    const saved=this.cached(item);if(saved)return saved;
    const data = await this.request('/api/channels/feed/profile', item.acquisition === 'wechat-collector' ? { oid: item.sourceId, nid: item.objectNonceId || '' } : { url: item.url }, signal);
    const result=this.media(data.object,item);this.remember(data.object);return result;
  }
  remember(object){
    try{const selected={acquisition:'wechat-collector',sourceId:object?.id};this.media(object,selected);const m=object.objectDesc.media[0],author=identity(object.contact),record={capturedAt:Date.now(),object:{id:object.id,objectNonceId:object.objectNonceId||'',contact:{username:author.id,nickname:author.name,headUrl:author.avatar},objectDesc:{mediaType:4,description:object.objectDesc.description,media:[{url:m.url,urlToken:m.urlToken||'',decodeKey:m.decodeKey,thumbUrl:m.thumbUrl,coverUrl:m.coverUrl,videoPlayLen:m.videoPlayLen}]}}};this.staleMedia.delete(object.id);this.mediaCache.set(object.id,record);if(this.codec)this.store.put('wechat-media',object.id,{encrypted:this.codec.encode(JSON.stringify(record))});return true;}catch{return false;}
  }
  invalidate(item){const id=item.sourceId||item.id;this.mediaCache.delete(id);this.staleMedia.add(id);}
  cached(item){const id=item.sourceId||item.id;if(!id||this.staleMedia.has(id))return null;let record=this.mediaCache.get(id);if(!record&&this.codec){const saved=this.store.get('wechat-media',id);if(saved?.encrypted)try{record=JSON.parse(this.codec.decode(saved.encrypted));this.mediaCache.set(id,record);}catch{return null;}}return record?this.media(record.object,{...item,acquisition:'wechat-collector',sourceId:id}):null;}
  media(object,item){
    if (!object || !object.id || (item.acquisition === 'wechat-collector' && String(object.id) !== item.sourceId)) throw new Error('返回的视频与所选作品不一致，已停止下载');
    const author = identity(object.contact);
    if (item.creatorId && author.id !== item.creatorId) throw new Error('下载时作者身份不一致，已停止');
    const media = object.objectDesc?.media?.[0]; if (!media || Number(object.objectDesc?.mediaType) !== 4) throw new Error('该条目不是可下载的视频');
    let url; try { url = new URL(String(media.url || '') + String(media.urlToken || '')); } catch { throw new Error('微信尚未返回可下载视频，请在微信打开该视频后重试'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'finder.video.qq.com' || url.hostname.endsWith('.finder.video.qq.com'))) throw new Error('微信返回了不受信任的媒体地址，已停止下载');
    if (typeof media.decodeKey === 'number' && !Number.isSafeInteger(media.decodeKey)) throw new Error('视频解密参数精度异常，请重新读取');
    const decodeKey = String(media.decodeKey || ''); if (decodeKey && !/^\d{1,20}$/.test(decodeKey)) throw new Error('视频解密参数无效');
    return { url:url.href,decodeKey, info:{id:String(object.id),title:object.objectDesc.description || item.title,uploader:author.name,uploader_id:author.id,uploader_avatar:author.avatar,thumbnail:media.thumbUrl || media.coverUrl || '',duration:media.videoPlayLen},objectNonceId:object.objectNonceId || '' };
  }
  async identify(source, item, signal) {
    const data = await this.request('/api/channels/feed/profile', { url: source }, signal);
    const author = identity(data.object?.contact || data.contact || data.authorInfo || data.authorinfo);
    const objectId = data.object?.id;
    if (!author.id) throw new Error('原链接未返回稳定作者 ID，请在微信打开该视频，再重新识别；不会以同名搜索替代');
    if (wechatCreatorId(item?.creatorId) && item.creatorId !== author.id) throw new Error('分享解析与采集服务返回的作者不一致，已停止；请核对原视频后重试');
    return { platform: '视频号', ...author, identityStatus: 'confirmed', supported: true, adapter: 'wechat-collector', source, sourceObjectId: objectId || null, reason: '从原视频确认作者，通过本机服务分页读取其发布作品；微信中的视频号页面需要保持打开。平台总数与实际可访问数量可能不同。' };
  }
  async identifyProfile(profile, signal) {
    requireWechatIdentity(profile);
    const data = await this.request('/api/channels/contact/feed/list', { username: profile.id, next_marker: '' }, signal);
    const author = identity(data.contact);
    if (!author.id || author.id !== profile.id) throw new Error('作者主页返回的身份与链接不一致，请核对微信主页后重试');
    return { ...profile, ...author, identityStatus: 'confirmed', total: Number.isInteger(data.feedsCount) ? data.feedsCount : null, supported: true, adapter: 'wechat-collector', reason: '已通过原主页作者 ID 确认身份；确认范围后分页读取发布作品。请保持微信视频号页面打开。' };
  }
  async page(creator, count, signal, cursor = null, pending = []) {
    requireWechatIdentity(creator);
    let remaining = [...pending], next = cursor, end = false, total = null, profile = null;
    if (!remaining.length) {
      const data = await this.request('/api/channels/contact/feed/list', { username: creator.id, next_marker: cursor || '' }, signal);
      if (!data || !Array.isArray(data.object)) throw new Error('未取得作品列表，请在微信打开该作者主页后继续读取');
      profile = identity(data.contact || {});
      if (profile.id && profile.id !== creator.id) throw new Error('平台返回了其他作者的作品，已停止读取');
      if (data.continueFlag === undefined || ![0, 1, false, true].includes(data.continueFlag)) throw new Error('作品分页状态缺失，不能判断是否读取完整，请检查采集服务版本');
      next = typeof data.lastBuffer === 'string' ? data.lastBuffer : null; end = !data.continueFlag;
      if (!end && (!next || next === cursor)) throw new Error('平台未返回新的分页位置，已保留清单；请稍后继续读取');
      total = Number.isInteger(data.feedsCount) && data.feedsCount >= 0 ? data.feedsCount : null;
      for (const raw of data.object) {
        const author = identity(raw.contact || {});
        if (author.id && author.id !== creator.id) continue;
        if (Number(raw.objectDesc?.mediaType) !== 4 || !raw.objectDesc?.media?.length) continue;
        if (typeof raw.id !== 'string' || !raw.id) continue;
        remaining.push({ id: raw.id, nonce: raw.objectNonceId || '', sourceUrl: raw.source_url || '', title: raw.objectDesc.description || '视频号视频', media: {thumbUrl:raw.objectDesc.media[0].thumbUrl,coverUrl:raw.objectDesc.media[0].coverUrl,videoPlayLen:raw.objectDesc.media[0].videoPlayLen}, createtime: raw.createtime });
      }
    } else { next = cursor?.next ?? null; end = Boolean(cursor?.end); total = cursor?.total ?? null; }
    const selected = remaining.slice(0, count), leftover = remaining.slice(count), items = [];
    for (const raw of selected) {
      signal?.throwIfAborted();
      const url = feedUrl(raw, creator.id);
      const item = this.engine.item({ id: raw.id, title: raw.title, uploader: creator.name, uploader_id:creator.id, uploader_avatar:creator.avatar, thumbnail: raw.media.thumbUrl || raw.media.coverUrl || '', duration: raw.media.videoPlayLen, timestamp: Number(raw.createtime) || undefined }, url, '视频号'); items.push({...item,acquisition:'wechat-collector',objectNonceId:raw.nonce || ''});
    }
    return { items, next: leftover.length ? { next, end, total } : next, pending: leftover, complete: end && !leftover.length, total, profile };
  }
}
