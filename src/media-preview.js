// Pure source policy. A thumbnail is never promoted to a video URL.
export function safeMediaUrl(value, kind = 'image') {
  if (!value || typeof value !== 'string') return '';
  try {
    const u = new URL(value);
    if (u.username || u.password) return '';
    if (['https:', 'fengsha-media:'].includes(u.protocol)) return u.href;
    if (u.protocol === 'blob:') return u.href;
    if (kind === 'image' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(value)) return value;
  } catch { /* Show an explicit error instead of navigating to an unsafe URL. */ }
  return '';
}

export function resolveMedia(input, media = []) {
  const video = input.tag === 'video' || input.type === 'video';
  let source = safeMediaUrl(input.videoSrc, 'video');
  if (input.tag === 'video') source ||= safeMediaUrl(input.src, 'video');
  if (!source && (video || input.cover || input.mediaId)) {
    const matches = media.filter(m => input.mediaId ? m.id === input.mediaId :
      safeMediaUrl(m.thumbnail) === safeMediaUrl(input.src) && !!safeMediaUrl(input.src));
    const m = matches.length === 1 ? matches[0] : null;
    if (m && m.exists !== false && (m.filePath || m.file) && m.id) source = safeMediaUrl(`fengsha-media://${m.id}`, 'video');
  }
  if (source) return { kind: 'video', src: source, poster: safeMediaUrl(input.poster || (input.tag === 'img' ? input.src : '')), title: input.title || '视频预览' };
  const src = safeMediaUrl(input.tag === 'video' ? input.poster : input.src);
  return { kind: 'image', src, title: input.title || (video || input.cover ? '封面预览' : '图片预览'),
    notice: video || input.cover ? '当前仅有封面，尚未取得可播放的视频；下载后可直接放大播放。' : '',
    error: src ? '' : video ? '未提供可用的视频源或封面。' : '图片地址缺失或不受支持，无法加载预览。' };
}

export function zoomLevel(current, action) {
  return action === 'reset' ? 1 : Math.min(4, Math.max(0.25, Math.round((current + (action === '+' ? 0.25 : -0.25)) * 100) / 100));
}
