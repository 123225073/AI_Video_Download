import { platformOf } from './core.js';

export function collectorBase(value) {
  let u; try { u = new URL(String(value || 'http://127.0.0.1:2022').trim()); } catch { throw new Error('请填写本机视频号采集服务地址'); }
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['/', ''].includes(u.pathname)) throw new Error('视频号采集服务只允许本机地址，例如 http://127.0.0.1:2022');
  return u.origin;
}
function identity(contact = {}) {
  const id = contact.username || contact.finderUsername || contact.userName;
  return { id: typeof id === 'string' && id.length < 300 && !id.startsWith('shared_author_') ? id : null, name: contact.nickname || '', avatar: contact.headUrl || contact.headImgUrl || contact.headimgurl || '', signature: contact.signature || '' };
}
export function wechatMetadata(feed = {}, parsed = {}) {
  const data = feed.data || feed;
  const object = data.object && !Array.isArray(data.object) ? data.object : null;
  const info = data.feedInfo || data.feedinfo || {};
  const author = identity(object?.contact || data.authorInfo || data.authorinfo || info.contact || {});
  return { ...author, name: author.name || parsed.author || '未知作者', thumbnail: object?.objectDesc?.media?.[0]?.thumbUrl || object?.objectDesc?.media?.[0]?.coverUrl || info.coverUrl || info.coverurl || '', sourceId: typeof object?.id === 'string' ? object.id : null, publishedAt: Number(object?.createtime || info.createTime || info.createtime) ? new Date(Number(object?.createtime || info.createTime || info.createtime) * 1000).toISOString().slice(0, 10).replaceAll('-', '') : null };
}
export class WeChatCreators {
  constructor(store, engine, request = fetch) { this.store = store; this.engine = engine; this.fetch = request; }
  config() { return { enabled: true, automatic:true, baseUrl: 'http://127.0.0.1:2022', ...this.store.get('collector-config', 'wechat') }; }
  save(raw) { const c = { enabled: Boolean(raw.enabled), automatic:raw.automatic !== false, baseUrl: collectorBase(raw.baseUrl) }; if(c.automatic && c.baseUrl!=='http://127.0.0.1:2022') throw new Error('自动连接使用内置本机地址；自定义服务请选择手动连接'); this.store.put('collector-config', 'wechat', c); this.store.flush(); return c; }
  async request(route, params = {}, signal) {
    const c = this.config(); if (!c.enabled) throw new Error('请先在设置中连接本机视频号采集服务');
    const u = new URL(route, collectorBase(c.baseUrl)); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v ?? ''));
    let response; try { response = await this.fetch(u.href, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' }); } catch { if (signal?.aborted) throw new Error('已停止读取'); throw new Error('未连接视频号采集服务，请启动本机服务，并在微信中打开视频号页面后重试'); }
    if (!response.ok) throw new Error(`视频号采集服务未就绪（HTTP ${response.status}），请检查微信页面是否已连接`);
    let text = await response.text(); if (text.length > 8 * 1024 * 1024) throw new Error('视频号列表过大，请缩小范围');
    // Platform IDs exceed JS's integer precision; preserve numeric IDs before JSON parsing.
    text = text.replace(/("(?:id|objectId|objectNonceId|decodeKey)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"');
    let payload; try { payload = JSON.parse(text); } catch { throw new Error('视频号采集服务返回了无效数据，请检查服务版本'); }
    if (payload.code !== undefined) { if (Number(payload.code) !== 0) throw new Error('视频号采集请求未完成，请在微信打开视频号页面后重试'); payload = payload.data; }
    if (payload?.errCode || payload?.data?.BaseResponse?.Ret) throw new Error('微信拒绝了作品读取，请在微信完成登录或验证后重试');
    return payload?.data || payload;
  }
  async test() { const data = await this.request('/api/channels/status'); if (typeof data?.available !== 'boolean') throw new Error('服务未返回微信连接状态，请检查采集服务版本'); return { connected: data.available, detail: data.available ? '微信已连接，可以识别博主和下载作品' : '微信页面未连接；请开始识别以自动准备连接，再在微信进入视频号页面' }; }
  async resolve(item, signal) {
    const data = await this.request('/api/channels/feed/profile', item.acquisition === 'wechat-collector' ? { oid: item.sourceId, nid: item.objectNonceId || '' } : { url: item.url }, signal);
    const object = data.object;
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
    if (item?.creatorId && item.creatorId !== author.id) throw new Error('分享解析与采集服务返回的作者不一致，已停止；请核对原视频后重试');
    return { platform: '视频号', ...author, supported: true, adapter: 'wechat-collector', source, sourceObjectId: objectId || null, reason: '从原视频确认作者，通过本机服务分页读取其发布作品；微信中的视频号页面需要保持打开。平台总数与实际可访问数量可能不同。' };
  }
  async identifyProfile(profile, signal) {
    const data = await this.request('/api/channels/contact/feed/list', { username: profile.id, next_marker: '' }, signal);
    const author = identity(data.contact);
    if (!author.id || author.id !== profile.id) throw new Error('作者主页返回的身份与链接不一致，请核对微信主页后重试');
    return { ...profile, ...author, total: Number.isInteger(data.feedsCount) ? data.feedsCount : null, supported: true, adapter: 'wechat-collector', reason: '已通过原主页作者 ID 确认身份；确认范围后分页读取发布作品。请保持微信视频号页面打开。' };
  }
  async page(creator, count, signal, cursor = null, pending = []) {
    let remaining = [...pending], next = cursor, end = false, total = null, profile = null;
    if (!remaining.length) {
      const data = await this.request('/api/channels/contact/feed/list', { username: creator.id, next_marker: cursor || '' }, signal);
      if (!data || !Array.isArray(data.object)) throw new Error('未取得作品列表，请在微信打开该作者主页后继续读取');
      if (data.contact?.username && data.contact.username !== creator.id) throw new Error('平台返回了其他作者的作品，已停止读取');
      if (data.continueFlag === undefined || ![0, 1, false, true].includes(data.continueFlag)) throw new Error('作品分页状态缺失，不能判断是否读取完整，请检查采集服务版本');
      next = typeof data.lastBuffer === 'string' ? data.lastBuffer : null; end = !data.continueFlag;
      if (!end && (!next || next === cursor)) throw new Error('平台未返回新的分页位置，已保留清单；请稍后继续读取');
      profile = identity(data.contact); total = Number.isInteger(data.feedsCount) && data.feedsCount >= 0 ? data.feedsCount : null;
      for (const raw of data.object) {
        if (raw.contact?.username && raw.contact.username !== creator.id) continue;
        if (Number(raw.objectDesc?.mediaType) !== 4 || !raw.objectDesc?.media?.length) continue;
        if (typeof raw.id !== 'string' || !raw.id) continue;
        remaining.push({ id: raw.id, nonce: raw.objectNonceId || '', title: raw.objectDesc.description || '视频号视频', media: {thumbUrl:raw.objectDesc.media[0].thumbUrl,coverUrl:raw.objectDesc.media[0].coverUrl,videoPlayLen:raw.objectDesc.media[0].videoPlayLen}, createtime: raw.createtime });
      }
    } else { next = cursor?.next ?? null; end = Boolean(cursor?.end); total = cursor?.total ?? null; }
    const selected = remaining.slice(0, count), leftover = remaining.slice(count), items = [];
    for (const raw of selected) {
      const share = await this.request('/api/channels/feed/share_url', { oid: raw.id }, signal);
      const url = share.feedH5Url;
      if (typeof url !== 'string' || platformOf(url) !== '视频号' || new URL(url).protocol !== 'https:') throw new Error('未取得可下载的作品分享链接，清单位置保留，请稍后重试');
      const item = this.engine.item({ id: raw.id, title: raw.title, uploader: creator.name, uploader_id:creator.id, uploader_avatar:creator.avatar, thumbnail: raw.media.thumbUrl || raw.media.coverUrl || '', duration: raw.media.videoPlayLen, timestamp: Number(raw.createtime) || undefined }, url, '视频号'); items.push({...item,acquisition:'wechat-collector',objectNonceId:raw.nonce || ''});
    }
    return { items, next: leftover.length ? { next, end, total } : next, pending: leftover, complete: end && !leftover.length, total, profile };
  }
}
