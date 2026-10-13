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

export function videoPlaybackError(error, { local = false, status } = {}) {
  if (local && status === 404) return '原视频文件不可用，请确认文件仍在原位置且可读取，再重试加载。';
  if (local && status >= 500) return '本地视频读取失败，请重试加载。';
  if (error?.code === 1) return '视频加载已中止，请重试加载。';
  if (error?.code === 3)
    return '视频文件已读取，但当前播放器无法解码该视频或音轨；请检查编码格式。';
  if (local && error?.code === 4 && [200, 206].includes(status)) return '本地文件可读取，但播放器未能识别视频源；请重试加载，仍失败时请检查编码格式。';
  if (local) return '本地视频未能加载，请重试加载；若仍失败，请检查文件读取或编码格式。';
  if (error?.code === 4) return '当前播放器不支持此视频源或编码格式。';
  return '视频读取中断，请检查连接后重试加载。';
}
