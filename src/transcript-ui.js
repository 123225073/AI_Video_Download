export const processing = t => ['queued', 'preparing', 'subtitles', 'transcribing', 'correcting', 'summarizing', 'translating'].includes(t?.status);
export const taskLabels = { queued: '排队中', preparing: '准备素材', subtitles: '读取字幕', transcribing: '转录中', correcting: '矫正中', translating: '翻译中', summarizing: '处理中', ready: '已保存', archived: '已保存', 'ai-failed': '可继续', failed: '需重试', interrupted: '已中断', cancelled: '已停止', 'no-speech': '无语音' };
export function folderPath(folder, folders) {
  const parts = []; let current = folder, depth = 0;
  while (current && depth++ < 8) { parts.unshift(current.name); current = folders.find(f => f.id === current.parentId); }
  return parts.join(' / ');
}
