import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { platformOf, validSource, cleanName, mediaKey, safeLog, classifyError } from './core.js';
import { thumbnailUrl } from './thumbnail.js';

export function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}
export function command(binary, args, { signal, timeout = 120000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', partial = '', ended = false, timedOut = false;
    const abort = () => stopProcess(child);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stopProcess(child); }, timeout);
    const consume = chunk => {
      const value = chunk.toString('utf8');
      output += value;
      if (output.length > 24 * 1024 * 1024) { stopProcess(child); return; }
      partial += value;
      const lines = partial.split(/\r?\n/); partial = lines.pop();
      for (const line of lines) onLine?.(line);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-12000); onLine?.(chunk.toString('utf8')); });
    const finish = (error, code) => {
      if (ended) return; ended = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (partial) onLine?.(partial);
      if (signal?.aborted) reject(new Error('CANCELLED'));
      else if (error) reject(error);
      else if (timedOut) reject(new Error('Connection timed out'));
      else if (code !== 0) reject(new Error(errors || `下载组件退出：${code}`));
      else if (output.length > 24 * 1024 * 1024) reject(new Error('清单过大，请缩小解析范围'));
      else resolve(output);
    };
    child.once('error', e => finish(e)); child.once('close', code => finish(null, code));
  });
}

export class Engine {
  constructor(bin, accounts, wechat) { this.bin = bin; this.accounts = accounts; this.wechat = wechat; }
  async douyinInfo(url, accountId, signal) {
    const browser = this.douyinBrowser();
    try { return await browser.videoInfo(url, accountId, signal || AbortSignal.timeout(45000)); }
    finally { browser.close(); }
  }
  async arguments(platform, accountId) {
    const args = ['--ignore-config', '--no-warnings', '--no-check-formats', '--socket-timeout', '25', '--ffmpeg-location', path.join(this.bin, 'ffmpeg'), '--js-runtimes', `node:${path.join(this.bin, 'node', 'node.exe')}`];
    if (platform !== '视频号') { const cookie = await this.accounts?.cookieFile(platform, accountId); if (cookie) args.push('--cookies', cookie); }
    return args;
  }
  async parse(url, { limit = 30, signal } = {}) {
    validSource(url);
    const platform = platformOf(url);
    const account = this.accounts?.active(platform);
    if (platform === '抖音' && this.douyinBrowser) {
      const data = await this.douyinInfo(url, account?.id, signal);
      this.accounts?.markVerified(platform, account?.id);
      return { url, platform, title: data.title, total: 1, complete: true, items: [this.item(data, data.webpage_url, platform)], accountId: account?.id || null };
    }
    if (platform === '视频号') {
      if (!account?.lastSync && this.wechat.collector?.config().enabled) {
        const run=async()=>{const result=await this.wechat.collector.resolve({url},signal);return {url,platform,title:result.info.title,total:1,complete:true,items:[{...this.item(result.info,url,platform),acquisition:'wechat-collector',objectNonceId:result.objectNonceId}]};};
        return this.wechat.connection ? this.wechat.connection.withConnection(signal,run) : run();
      }
      if (!account?.lastSync) throw new Error('WECHAT_LOGIN_REQUIRED');
      const result = await this.wechat.resolve(url, account.id, signal);
      return { url, platform, title: result.info.title, total: 1, complete: true, items: [this.item(result.info, url, platform)] };
    }
    const args = await this.arguments(platform, account?.id);
    args.push('--dump-single-json', '--skip-download', '--flat-playlist', '--playlist-end', String(limit), '--', url);
    let data, metadataOnly = false;
    try { data = JSON.parse(await command(path.join(this.bin, 'yt-dlp.exe'), args, { signal })); }
    catch (error) {
      if (signal?.aborted || platform !== 'B站' || !this.bilibili || classifyError(error.message).category === 'restricted') throw error;
      data = await this.bilibili.detail(url, account?.id, signal);
      if (!data) throw error;
      data.webpage_url = url; metadataOnly = true;
      if (data.pages?.length > 1 && !new URL(url).searchParams.has('p')) data.entries = data.pages.slice(0, limit).map(page => ({ ...data, pages: undefined, webpage_url: `https://www.bilibili.com/video/${data.id}?p=${page.page}`, title: `${data.title} · ${page.part}`, duration: page.duration }));
    }
    this.accounts?.markVerified(platform, account?.id);
    const entries = data.entries ? data.entries.filter(Boolean) : [data];
    const source = new URL(url);
    let biliPages = metadataOnly ? data.pages || [] : [];
    if (platform === 'B站' && data.entries) {
      const bvid = source.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
      if (bvid && !biliPages.length) try {
        const apiSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
        const response = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, { signal: apiSignal, headers: { Referer: 'https://www.bilibili.com/' } });
        const metadata = await response.json(); if (metadata.code === 0 && Array.isArray(metadata.data)) biliPages = metadata.data;
      } catch { /* The main extractor result remains usable when optional labels cannot load. */ }
    }
    const items = entries.map((entry, index) => {
      let entryUrl = entry.webpage_url || entry.url;
      let part = null;
      if (platform === 'B站' && source.pathname.includes('/video/') && data.entries) {
        const u = new URL(entryUrl?.startsWith('https://') ? entryUrl : url); part = Number(u.searchParams.get('p') || entry.playlist_index || index + 1); u.searchParams.set('p', String(part)); entryUrl = u.href;
        const page = biliPages.find(p => p.page === part);
        entry = { ...entry, title: entry.title || page?.part || `第 ${part} P · ${data.title || '视频'}`, duration: entry.duration || page?.duration, uploader: entry.uploader || data.uploader, thumbnail: entry.thumbnail || data.thumbnail };
      }
      if (!entryUrl?.startsWith('http')) entryUrl = platform === 'YouTube' ? `https://www.youtube.com/watch?v=${entry.id}` : url;
      return this.item({ ...entry, channel_id: entry.channel_id || data.channel_id, uploader_id: entry.uploader_id || data.uploader_id, channel_url: entry.channel_url || data.channel_url, uploader_url: entry.uploader_url || data.uploader_url }, entryUrl, platform, data.entries ? data.title : null, part);
    });
    const total = Number(biliPages.length || data.playlist_count || data.n_entries || entries.length);
    return { url, platform, title: data.title || '解析结果', total, complete: !data.entries || (Boolean(biliPages.length || data.playlist_count || data.n_entries) && total <= entries.length), items, metadataOnly, accountId: account?.id || null };
  }
  item(data, url, platform, collection = null, part = null) {
    const formats = (data.formats || []).filter(f => !f.has_drm && f.vcodec !== 'none');
    const image = [data.thumbnail, ...(data.thumbnails || []).map(t => t.url).reverse()].map(thumbnailUrl).find(Boolean) || '';
    const timestamp = Number(data.timestamp), date = new Date(timestamp * 1000);
    const duration = Number(data.duration);
    const item = {
      url, platform, sourceId: platform === 'B站' ? new URL(url).pathname.match(/\/video\/((?:BV|av)[\w]+)/i)?.[1] || String(data.id || url) : String(data.id || url), part: part || (platform === 'B站' ? Number(new URL(url).searchParams.get('p') || 1) : null), title: String(data.title || data.description || '待获取标题').slice(0, 180),
      author: String(data.uploader || data.channel || '未知作者'), collection, duration: Number.isFinite(duration) && duration > 0 ? duration : null,
      thumbnail: image,
      height: Math.max(0, ...formats.map(f => f.height || 0)) || null,
      available: !['private', 'premium_only', 'subscriber_only'].includes(data.availability),
      publishedAt: data.upload_date || (timestamp > 0 && timestamp < 253402300800 && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10).replaceAll('-', '') : null),
      creatorId: String(data.channel_id || data.uploader_id || ''), creatorUrl: data.channel_url || data.uploader_url || null, creatorAvatar: data.uploader_avatar || '',
      accountId: this.accounts?.active(platform)?.id || null
    };
    item.key = mediaKey(item); return item;
  }
  async verify(file, signal) {
    const info = JSON.parse(await command(path.join(this.bin, 'ffmpeg', 'ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal }));
    if (!info.streams?.some(s => s.codec_type === 'video') || !fs.statSync(file).size) throw new Error('INVALID_MEDIA ffprobe');
    return { size: fs.statSync(file).size, duration: Number(info.format?.duration || 0), height: info.streams.find(s => s.codec_type === 'video')?.height || null };
  }
  async download(task, directory, signal, progress) {
    fs.mkdirSync(directory, { recursive: true });
    if (task.item.platform === '视频号') {
      const run=()=>this.wechat.download(task,directory,signal,progress,this);
      return task.item.acquisition === 'wechat-collector' && this.wechat.connection ? this.wechat.connection.withConnection(signal,run) : run();
    }
    const args = await this.arguments(task.item.platform, task.item.accountId);
    const cap = task.options.quality === 'best' ? '' : `[height<=${Number(task.options.quality)}]`;
    const filename = `${task.item.key.slice(0, 12)}${task.options.force ? `-${task.id.slice(0, 8)}` : ''}-${task.options.quality}-${cleanName(task.item.title)}.%(ext)s`;
    args.push('--no-playlist', '--no-overwrites', '--continue', '--retries', '1', '--fragment-retries', '1', '--newline', '--progress', '--no-simulate', '--format', `bv*${cap}+ba/b${cap}`, '--merge-output-format', 'mp4/mkv', '--output', path.join(directory, filename), '--progress-template', 'download:__FENGSHA_PROGRESS__:%(progress)j', '--print', 'after_move:__FENGSHA_FILE__:%(filepath)j');
    if (task.item.platform === 'B站' && task.item.part) args.push('--playlist-items', String(task.item.part));
    let infoDirectory;
    if (task.item.platform === '抖音' && this.douyinBrowser) {
      const data = await this.douyinInfo(task.item.url, task.item.accountId, signal);
      if (data.id !== task.item.sourceId || task.item.creatorId && data.channel_id !== task.item.creatorId) throw new Error('原视频或作者身份发生变化，已停止下载，请重新识别');
      infoDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fengsha-douyin-'));
      const infoFile = path.join(infoDirectory, 'video.json');
      fs.writeFileSync(infoFile, JSON.stringify(data), { mode: 0o600 });
      args.push('--load-info-json', infoFile);
    } else args.push('--', task.item.url);
    let finalFile = null;
    try { await command(path.join(this.bin, 'yt-dlp.exe'), args, { signal, timeout: 60 * 60 * 1000, onLine: line => {
      if (line.startsWith('__FENGSHA_PROGRESS__:')) {
        try { const p = JSON.parse(line.slice(21)); progress({ status: p.status === 'finished' ? 'processing' : 'downloading', bytes: p.downloaded_bytes || 0, total: p.total_bytes || p.total_bytes_estimate || null, speed: p.speed || null, eta: p.eta || null }); } catch { /* Non-numeric progress remains indeterminate. */ }
      } else if (line.startsWith('__FENGSHA_FILE__:')) {
        try { finalFile = JSON.parse(line.slice(17)); } catch { /* A missing final path is treated as failure. */ }
      } else if (/Merging|PostProcess/i.test(line)) progress({ status: 'processing' });
    } }); } finally {
      if (infoDirectory) { fs.unlinkSync(path.join(infoDirectory, 'video.json')); fs.rmdirSync(infoDirectory); }
    }
    if (!finalFile) throw new Error('下载结束但未获得完整文件路径');
    const relative = path.relative(directory, finalFile);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(finalFile)) throw new Error('下载文件路径异常');
    progress({ status: 'processing' });
    return { filePath: finalFile, ...(await this.verify(finalFile, signal)) };
  }
  async environment() {
    const components = [['下载引擎', path.join(this.bin, 'yt-dlp.exe'), ['--version']], ['音视频合并工具', path.join(this.bin, 'ffmpeg', 'ffmpeg.exe'), ['-version']], ['媒体校验工具', path.join(this.bin, 'ffmpeg', 'ffprobe.exe'), ['-version']], ['YouTube JS运行环境', path.join(this.bin, 'node', 'node.exe'), ['--version']]];
    return Promise.all(components.map(async ([name, binary, args]) => { try { const output = await command(binary, args, { timeout: 15000 }); return { name, ok: true, version: output.split(/\r?\n/)[0].slice(0, 100) }; } catch (error) { return { name, ok: false, version: safeLog(error.message) }; } }));
  }
}
