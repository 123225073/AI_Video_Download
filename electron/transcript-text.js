export const translationLanguages = { en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', zh: '简体中文' };
export function chunksOf(text, size = 10000) {
  const result = []; let rest = String(text || '').trim();
  while (rest.length > size) { const candidates = ['\n', '。', '. ', '！', '？'].map(s => rest.lastIndexOf(s, size)).filter(i => i > size / 2); const end = candidates.length ? Math.max(...candidates) + 1 : size; result.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim(); }
  if (rest) result.push(rest); return result;
}
export function clockTime(seconds, srt = false) {
  const n = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')}${srt ? ',' : '.'}${String(n % 1000).padStart(3, '0')}`;
}
export function parseSubtitles(value) {
  const text = String(value).replace(/\r/g, '').replace(/^\uFEFF/, ''); const segments = []; let previous = '';
  const blocks = text.split(/\n\s*\n/); const time = s => { const p = s.replace(',', '.').split(':').map(Number); return p.reduce((a, b) => a * 60 + b, 0); };
  for (const block of blocks) {
    const lines = block.split('\n'), index = lines.findIndex(l => /\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->/.test(l)); if (index < 0) continue;
    const timing = lines[index].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/); if (!timing) continue;
    const body = lines.slice(index + 1).join(' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    if (!body || body === previous) continue;
    // Auto-caption windows repeat their previous sentence. Keep only the new suffix.
    const clean = previous && body.startsWith(previous) ? body.slice(previous.length).trim() : body;
    previous = body;
    if (clean) segments.push({ start: time(timing[1]), end: time(timing[2]), text: clean });
  }
  return { text: segments.map(s => s.text).join('\n'), segments, language: 'auto' };
}
export function srtOf(segments) { return segments.filter(s => s.text?.trim()).map((s, i) => `${i + 1}\n${clockTime(s.start, true)} --> ${clockTime(s.end, true)}\n${s.text.trim()}\n`).join('\n'); }
export function transcriptOf(record) { return record.segments?.length ? record.segments.map(s => `[${clockTime(s.start).slice(0, 8)}] ${s.text}`).join('\n\n') : record.transcript || ''; }
export function documentOf(record) {
  const translations = Object.entries(record.translations || {}).filter(([, v]) => v.text).map(([language, v]) => `\n## ${translationLanguages[language] || language}译文${v.sourceHash === record.reviewedHash ? '' : '（旧文案版本）'}\n\n${v.text}\n${(v.history || []).map(h => `\n### 历史版本 · ${new Date(h.updatedAt).toISOString()}\n\n${h.text}\n`).join('')}`).join('');
  const section = (title, text) => text ? `\n## ${title}\n\n${text}\n` : '';
  const variants = Object.values(record.translationVariants || {}).filter(v => v.text).map(v => section(`${translationLanguages[v.language] || v.language}译文 · ${v.sourceKind === 'corrected' ? 'AI 矫正文案' : '识别原文'} · ${v.format === 'timed' ? '带时间戳' : '不带时间戳'}`, v.text) + (v.history || []).map(h => section(`历史译文 · ${new Date(h.updatedAt).toISOString()}`, h.text)).join('')).join('');
  return `# ${String(record.title).replace(/[\r\n]/g, ' ')}\n\n来源：${record.source?.url || record.source?.title || '本地导入'}\n作者：${record.author || '未提供'}\n转录方式：${record.transcriptMethod || '文本导入'}\n模型：${record.modelUsed || '未调用'}\n保存时间：${new Date(record.updatedAt || record.createdAt || Date.now()).toISOString()}\n` +
    section('纯文本原文 · 不带时间戳', record.transcript) + section('带时间戳原文', record.segments?.length ? transcriptOf(record) : '') +
    section('AI 矫正 · 不带时间戳', record.correctedTranscript) + section('AI 矫正 · 带时间戳', record.correctedSegments?.length ? transcriptOf({ segments: record.correctedSegments }) : '') + variants +
    section('旧版已确认校正文案', record.confirmedCorrectedTranscript && record.confirmedCorrectedTranscript !== record.correctedTranscript ? record.confirmedCorrectedTranscript : '') +
    section('旧版摘要', record.confirmedSummary || record.summary) + section('旧版笔记', record.notes) + section('旧版译文', record.translation) + translations;
}

export function correctedTextOf(record) { return record.confirmedCorrectedTranscript ?? record.correctedTranscript ?? ''; }
