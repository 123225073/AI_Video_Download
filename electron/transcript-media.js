import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const videoFile = file => typeof file === 'string' && /\.(mp4|mkv|mov|webm)$/i.test(file);
const unavailable = (message = '本地媒体文件不可用，请确认原文件仍在原位置且可读取。', status = 404) => new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
function existingFile(file) {
  try { return !!file && fs.statSync(file).isFile(); } catch { return false; }
}

// /video means the original video, not a subtitle/audio stored in sourceFile.
// Resolve saved records on every request: a text revision must not invalidate media.
export function transcriptVideoFile(store, id) {
  const t = store.get('transcription', id);
  if (!t) return null;
  const drafts = store.list('content-draft').filter(d => d.transcriptionId === id);
  const media = t.source?.mediaId ? store.get('media', t.source.mediaId) : null;
  return [...drafts.map(d => d.originalVideoFile), t.sourceFile, t.source?.file, media?.filePath]
    .find(file => videoFile(file) && existingFile(file)) || null;
}

export function byteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || !size || !match[1] && !match[2]) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start >= size || end < start || !match[1] && Number(match[2]) === 0) return false;
  return { start, end };
}

const types = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };

export async function localMediaResponse(request, file, fetchFile) {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  // Open first so a missing/replaced file cannot leave a successful empty stream.
  let handle;
  try { handle = await fs.promises.open(file, 'r'); } catch { return unavailable(); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) { await handle.close(); return unavailable(); }
    const range = byteRange(request.headers.get('range'), stat.size);
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Last-Modified': stat.mtime.toUTCString() };
    if (range === false) { await handle.close(); return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } }); }
    headers['Content-Length'] = String(range ? range.end - range.start + 1 : stat.size);
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    if (request.method === 'HEAD' || !stat.size) { await handle.close(); return new Response(null, { status: range ? 206 : 200, headers }); }
    if (fetchFile) {
      await handle.close();
      // Electron's file loader reads the requested slice but reports 200 without
      // Content-Range. Preserve its native stream and supply correct HTTP framing.
      const native = await fetchFile(pathToFileURL(file).href, { headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {} });
      return new Response(native.body, { status: range ? 206 : 200, headers });
    }
    const stream = handle.createReadStream(range || {});
    return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

export function createMediaProtocolHandler({ store, contentStudio, fetchFile }) {
  return async request => {
    try {
      const u = new URL(request.url), id = u.hostname;
      let file;
      if (id.startsWith('draft-')) {
        try { file = u.pathname === '/audio' ? contentStudio.audioAsset(id.slice(6)) : contentStudio.asset(id.slice(6), u.pathname.slice(1)).file; }
        catch { return unavailable('本地媒体素材不可用。'); }
      } else if (id.startsWith('transcript-')) {
        const tid = id.slice(11), t = store.get('transcription', tid);
        file = u.pathname === '/video' ? transcriptVideoFile(store, tid) : t?.sourceFile || t?.source?.file;
      } else { file = store.get('media', id)?.filePath; }
      if (!file) return unavailable();
      return await localMediaResponse(request, file, fetchFile);
    } catch { return unavailable('本地媒体无法读取，请重试。', 500); }
  };
}
