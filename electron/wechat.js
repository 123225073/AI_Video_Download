import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cleanName } from './core.js';
import { stopProcess } from './engine.js';
import { wechatMetadata } from './wechat-creators.js';

// Protocol reference: ltaoo/wx_channels_download and the user's prior implementation.
// Only the explicitly selected account's dedicated session is used.
export class WeChat {
  constructor(accounts, bin) { this.accounts = accounts; this.bin = bin; this.resolved=new Map(); }
  async request(id, url, body, authenticated, signal) {
    const response = await this.accounts.getSession(id).fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin, Referer: `${new URL(url).origin}/` }, credentials: authenticated ? 'include' : 'omit', redirect: 'error', body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (response.status === 401 || response.status === 403) throw new Error('WECHAT_LOGIN_REQUIRED');
    if (!response.ok) throw new Error(`WECHAT_SERVICE_HTTP_${response.status}`);
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error('WECHAT_INVALID_RESPONSE');
    return JSON.parse(text);
  }
  async resolve(source, id, signal) {
    const cached=this.resolved.get(id+':'+source);if(cached&&Date.now()-cached.at<5*60*1000){signal?.throwIfAborted();return cached.result;}
    const input = new URL(source);
    if (!((input.hostname === 'weixin.qq.com' && /^\/sph\/[a-zA-Z0-9_-]{1,100}\/?$/.test(input.pathname)) || (input.hostname === 'channels.weixin.qq.com' && input.pathname === '/finder-preview/pages/sph'))) throw new Error('WECHAT_INVALID_LINK');
    const parsed = await this.request(id, 'https://yuanbao.tencent.com/api/weixin/get_parse_result', { type: 'video_channel_url', url: source, scene: 1 }, true, signal);
    if (parsed.code !== 0 || !parsed.data?.playable_url) throw new Error('WECHAT_LINK_UNAVAILABLE');
    const playable = new URL(parsed.data.playable_url);
    if (playable.protocol !== 'https:' || playable.hostname !== 'channels.weixin.qq.com' || playable.username || playable.password || playable.port) throw new Error('WECHAT_INVALID_RESPONSE');
    const token = playable.searchParams.get('token'), eid = playable.searchParams.get('eid');
    if (!token || !eid) throw new Error('WECHAT_LINK_UNAVAILABLE');
    const feed = await this.request(id, 'https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info', { baseReq: { generalToken: token }, exportId: eid }, false, signal);
    if (feed.errCode) throw new Error('WECHAT_LINK_UNAVAILABLE');
    const object = feed.data?.object?.objectDesc, preview = feed.data?.feedInfo;
    const media = object?.media?.[0] || { url: preview?.originVideoUrl || preview?.videoUrl || preview?.h264VideoInfo?.videoUrl || '', decodeKey: preview?.decodeKey, fileSize: preview?.fileSize, videoPlayLen: preview?.videoPlayLen };
    const url = new URL(media.url + (media.urlToken || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'finder.video.qq.com' || url.hostname.endsWith('.finder.video.qq.com'))) throw new Error('WECHAT_NO_DOWNLOADABLE_MEDIA');
    if (typeof media.decodeKey === 'number' && !Number.isSafeInteger(media.decodeKey)) throw new Error('WECHAT_INVALID_RESPONSE');
    const decodeKey = String(media.decodeKey || ''); if (decodeKey && !/^\d{1,20}$/.test(decodeKey)) throw new Error('WECHAT_INVALID_RESPONSE');
    this.accounts.markVerified('视频号', id);
    const author = wechatMetadata(feed, parsed.data);
    const result={ url: url.href, decodeKey, info: { id: author.sourceId || createHash('sha256').update(source).digest('hex').slice(0, 24), title: object?.description || preview?.description || parsed.data.desc || '视频号视频', uploader: author.name, thumbnail: author.thumbnail, uploader_id: author.id || '', uploader_avatar: author.avatar, upload_date: author.publishedAt, duration: media.videoPlayLen } };this.resolved.set(id+':'+source,{at:Date.now(),result});return result;
  }
  async download(task, directory, signal, progress, engine) {
    const collected = task.item.acquisition === 'wechat-collector';
    if (!collected && (!task.item.accountId || !this.accounts.account(task.item.accountId).lastSync)) throw new Error('WECHAT_LOGIN_REQUIRED');
    const media = collected ? await this.collector.resolve(task.item,signal) : await this.resolve(task.item.url, task.item.accountId, signal);
    const file = path.join(directory, `${task.item.key.slice(0, 12)}${task.options.force ? `-${task.id.slice(0, 8)}` : ''}-${cleanName(task.item.title)}.mp4`);
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(this.bin, 'node', 'node.exe'), [path.join(this.bin, 'wechat', 'download-link.cjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let result = null;
      const abort = () => { if (child.connected) child.send({ cancel: true }); stopProcess(child); };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { result = { error: 'WECHAT_DOWNLOAD_TIMEOUT' }; stopProcess(child); }, 30 * 60_000);
      child.once('spawn', () => { if (signal.aborted) abort(); else child.send({ url: media.url, decodeKey: media.decodeKey, destination: file, temporary: `${file}.${task.id}.part`, ffmpeg: path.join(this.bin, 'ffmpeg', 'ffmpeg.exe') }); });
      child.on('message', m => { if (m.progress) progress({ status: m.progress.processing ? 'processing' : 'downloading', bytes: m.progress.total, total: m.progress.expected || null }); if (m.completed || m.error) result = m; });
      child.once('error', error => { result = { error: error.message }; });
      child.once('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); if (signal.aborted) reject(new Error('CANCELLED')); else if (result?.completed) resolve(); else reject(new Error(result?.error || 'WECHAT_DOWNLOAD_FAILED')); });
    });
    return { filePath: file, ...(await engine.verify(file, signal)) };
  }
}
