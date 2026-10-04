import { platformOf, validSource } from './core.js';

export function douyinUrl(source) {
  validSource(source);
  if (platformOf(source) !== '抖音') throw new Error('请使用抖音官方链接');
  const url = new URL(source);
  if (url.port) throw new Error('抖音官方链接不能带自定义端口');
  const video = url.pathname.match(/^\/(?:share\/)?video\/(\d+)\/?$/)?.[1] || url.searchParams.get('modal_id');
  const user = url.pathname.match(/^\/(?:share\/)?user\/([\w.-]+)\/?$/)?.[1];
  if (user) return `https://www.douyin.com/user/${user}`;
  if (video && /^\d+$/.test(video)) return `https://www.douyin.com/video/${video}`;
  return url.href;
}

// Follow official short links within the chosen isolated session, with bounded redirects.
export async function resolveDouyin(source, fetcher, signal) {
  let target = douyinUrl(source);
  const short = new URL(target).hostname === 'v.douyin.com';
  for (let hop = 0; hop < 6; hop++) {
    const url = new URL(target);
    if (url.hostname !== 'v.douyin.com') {
      if (short && !/^\/(?:video\/\d+|user\/[\w.-]+)$/.test(url.pathname)) throw new Error('抖音短链接跳回了首页，未返回原视频；请从抖音重新复制分享文案，或直接粘贴博主主页链接');
      return target;
    }
    const response = await fetcher(target, { redirect: 'manual', signal, headers: { 'Accept': 'text/html' } });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      target = douyinUrl(new URL(location, target).href);
      continue;
    }
    if (!response.ok) throw new Error('抖音短链接暂时无法打开，请重新复制分享链接或使用博主主页链接');
    return target;
  }
  throw new Error('抖音短链接重复跳转，请重新复制分享链接或使用博主主页链接');
}

export function douyinResponse(url) {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://www.douyin.com') return null;
    if (u.pathname === '/aweme/v1/web/aweme/detail/') return { kind: 'detail', id: u.searchParams.get('aweme_id') };
    if (u.pathname === '/aweme/v1/web/aweme/post/') return { kind: 'post', id: u.searchParams.get('sec_user_id') };
  } catch { /* Ignore unrelated requests. */ }
  return null;
}

export function douyinVideo(raw) {
  if (!/^\d+$/.test(raw?.aweme_id || '') || !/^[\w.-]+$/.test(raw.author?.sec_uid || '')) return null;
  const id = String(raw.aweme_id), creatorId = raw.author.sec_uid;
  const isImage = raw.aweme_type === 68 || Boolean(raw.images?.length || raw.image_post_info?.images?.length);
  const restricted = Boolean(raw.is_drm || raw.video?.is_drm || raw.is_paid_video || Number(raw.series_paid_info?.item_price || 0) > 0);
  const video = raw.video || {};
  const publicUrl = value => {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u.href : null; } catch { return null; }
  };
  const formats = [];
  if (!isImage && !restricted && !raw.status?.is_private && !raw.status?.private_status) {
    for (const stream of [{ play_addr: video.play_addr, width: video.width, height: video.height }, ...(video.bit_rate || []).slice(0, 12)]) {
      const address = stream.play_addr;
      const url = address?.url_list?.map(publicUrl).find(Boolean);
      if (url && !formats.some(f => f.url === url)) formats.push({ url, format_id: `web-${formats.length}`, ext: 'mp4', width: Number(address.width || stream.width) || undefined, height: Number(address.height || stream.height) || undefined, tbr: Number(stream.bit_rate) / 1000 || undefined });
    }
  }
  return { id, title: String(raw.desc || '抖音视频').slice(0, 180), uploader: String(raw.author.nickname || '未知作者').slice(0, 100), channel_id: creatorId, channel_url: `https://www.douyin.com/user/${creatorId}`, uploader_avatar: raw.author.avatar_thumb?.url_list?.map(publicUrl).find(Boolean) || '', thumbnail: video.cover?.url_list?.map(publicUrl).find(Boolean) || '', timestamp: Number(raw.create_time) || null, duration: Number(video.duration) / 1000 || null, webpage_url: `https://www.douyin.com/video/${id}`, formats, isImage, availability: raw.status?.is_private || raw.status?.private_status ? 'private' : restricted ? 'restricted' : 'public', http_headers: { Referer: 'https://www.douyin.com/' } };
}

export function douyinPayload(context, data) {
  if (!context?.id || data?.status_code !== 0) return [];
  const entries = context.kind === 'detail' ? [data.aweme_detail] : context.kind === 'post' && Array.isArray(data.aweme_list) ? data.aweme_list.slice(0, 100) : [];
  return entries.map(douyinVideo).filter(v => v && (context.kind === 'detail' ? v.id === context.id : v.channel_id === context.id));
}
