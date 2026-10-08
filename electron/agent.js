import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { channelFile, pipePath } from '../cli/protocol.mjs';
import { selectItems } from '../cli/options.mjs';
import { safeLog, validSource, platformOf, mediaKey } from './core.js';

export const publicItem = item => Object.fromEntries(['key', 'url', 'platform', 'sourceId', 'part', 'title', 'author', 'collection', 'duration', 'thumbnail', 'height', 'available', 'publishedAt', 'creatorId', 'creatorUrl', 'acquisition', 'objectNonceId'].filter(k => item[k] !== undefined).map(k => [k, item[k]]));
const publicTask = t => ({ id: t.id, item: publicItem(t.item), status: t.status, progress: t.progress, message: t.message, error: t.error, filePath: t.filePath, size: t.size, duration: t.duration, createdAt: t.createdAt });
function publicRecord(r) { const { accountId, ...creator } = r.creator; return { id: r.id, creator, total: r.total, scanned: r.scanned, status: r.status, complete: r.complete, restartRequired: Boolean(r.restartRequired), message: r.message, filters: r.filters, skipped: r.skipped, items: r.items.map(publicItem) }; }
const failure = (message, code = 'INVALID_ARGUMENT', exitCode = 2) => Object.assign(new Error(message), { code, exitCode });
export function createAgentHandler({ engine, queue, store, accounts, creators, userSearch, parse, identify, busy, status, stop, creatorChanged }) {
  return async ({ command, source, options = {}, items }) => {
    if (command === 'search') { if (busy('parse')) throw failure('正在识别或搜索，请稍后重试', 'BUSY', 1); if (options.record) return userSearch.more(options.record); return userSearch.start(options.platform, source); }
    if (command === 'environment') return { components: await engine.environment() };
    if (command === 'accounts') return { accounts: accounts.list().map(a => ({ id: a.id, platform: a.platform, name: a.name, status: a.status, active: a.active })) };
    if (command === 'tasks') { const tasks = queue.tasks().filter(t => !options.id || t.id === options.id); if (options.id && !tasks.length) throw failure('任务不存在', 'NOT_FOUND'); return { tasks: tasks.map(publicTask), scheduler: queue.scheduler() }; }
    if (command === 'task') { await queue.action(options.id, options.action); return { tasks: queue.tasks().filter(t => t.id === options.id).map(publicTask) }; }
    if (command === 'media') { const media = queue.media().filter(m => !options.id || m.id === options.id); if (options.id && !media.length) throw failure('媒体不存在', 'NOT_FOUND'); return { media: media.map(m => ({ ...publicItem(m), id: m.id, filePath: m.filePath, size: m.size, duration: m.duration, height: m.height, quality: m.quality, exists: fs.existsSync(m.filePath) })) }; }
    if (command === 'probe') return { filePath: options.file, ...(await engine.verify(path.resolve(options.file))) };
    if (command === 'service') { if (source === 'stop') { if (busy()) throw failure('仍有任务或读取操作，后台未停止', 'BUSY', 1); if (!status().background) throw failure('桌面应用正在使用，请通过界面退出', 'GUI_ACTIVE', 1); stop(); return { stopping: true }; } return status(); }
    if (command === 'inspect') {
      const groups = await parse(source, options.limit || 30);
      const errors = groups.filter(g => g.error).map(g => ({ platform: g.platform, category: g.category, message: g.error }));
      const result = { groups: groups.filter(g => !g.error).map(({ accountId, ...g }) => ({ ...g, items: g.items.map(publicItem) })), items: groups.flatMap(g => g.items || []).map(publicItem), errors };
      if (!result.items.length) throw Object.assign(failure(errors[0]?.message || '没有识别到视频', errors[0]?.category || 'EMPTY_LIST', 1), { details: result });
      if (errors.length) result.partial = true;
      return result;
    }
    if (command === 'creator') {
      if (userSearch?.active) throw failure('正在搜索用户，请稍后读取博主', 'BUSY', 1);
      if (busy('parse')) throw failure('正在识别链接，请稍后读取博主', 'BUSY', 1);
      let record = options.record ? store.get('creator', options.record) : await identify(source);
      if (!record) throw failure('博主记录不存在', 'NOT_FOUND');
      if (options.refresh) { record = await creators.refresh(record.id); creatorChanged?.(record); return { ...publicRecord(record), metadataMessage: record.metadataMessage, metadataPending: record.metadataPending, partial: record.metadataPending > 0 }; }
      if (options.record && !options.continue) { creatorChanged?.(record); return publicRecord(record); }
      const filters = { limit: options.limit || 50, period: options.period || 'all', from: options.from, to: options.to, keyword: options.keyword, includeUnknown: options['include-unknown'], excludeDownloaded: !options['include-downloaded'] };
      let first = true;
      while (true) {
        const before = record.scanned;
        record = await creators.page(record.id, filters, !options.record && first, Boolean(options.record && first)); first = false;
        if (record.complete || ['limited', 'interrupted', 'cancelled', 'browser-end'].includes(record.status) || record.scanned === before) break;
      }
      creatorChanged?.(record);
      return { ...publicRecord(record), partial: ['interrupted', 'cancelled'].includes(record.status) };
    }
    if (command === 'download') {
      let list;
      if (options.record) { const r = store.get('creator', options.record); if (!r) throw failure('博主记录不存在', 'NOT_FOUND'); list = r.items; }
      else if (items) list = items;
      else {
        const groups = await parse(source, options.limit || 30);
        if (groups.some(g => g.error)) throw failure('部分链接解析失败；请先 inspect 核对清单再下载', 'PARSE_FAILED', 1);
        list = groups.flatMap(g => g.items || []);
      }
      const selected = selectItems(list, options);
      if (selected.length > 1000) throw failure('一次 CLI 提交最多 1000 条，请分批选择', 'BATCH_LIMIT');
      for (const item of selected) { validSource(item.url); if (platformOf(item.url) !== item.platform) throw failure('清单平台与链接不一致'); }
      if (options.output) { fs.mkdirSync(path.resolve(options.output), { recursive: true }); fs.accessSync(path.resolve(options.output), fs.constants.W_OK); }
      const result = queue.enqueue(selected.map(publicItem), { savePath: options.output && path.resolve(options.output), quality: options.quality, archive: options.archive, force: options.force });
      return { ...result, existing: selected.flatMap(item => { const m = store.get('media', mediaKey(item)); return m && fs.existsSync(m.filePath) ? [{ id: m.id, filePath: m.filePath }] : []; }) };
    }
    throw failure('未知 CLI 命令');
  };
}
export async function startAgentServer(directory, handler) {
  const token = randomBytes(32).toString('hex'), sockets = new Set(); let active = 0, lastUsed = Date.now(), closing = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.setTimeout(10000, () => socket.destroy());
    let body = '', dispatched = false;
    socket.on('data', async data => {
      if (dispatched) return; body += data.toString('utf8');
      if (body.length > 1024 * 1024) { socket.end(JSON.stringify({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '请求过大，请分批提交' }, exitCode: 2 }) + '\n'); dispatched = true; return; }
      if (!body.includes('\n')) return; dispatched = true;
      try {
        const request = JSON.parse(body.slice(0, body.indexOf('\n')));
        if (typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) || !timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) throw failure('本机通道认证失败', 'UNAUTHORIZED', 1);
        socket.setTimeout(0);
        active++; lastUsed = Date.now();
        try { const data = await handler(request); socket.end(JSON.stringify({ ok: !data.partial, command: request.command, data, ...(data.partial ? { exitCode: 4, error: { code: 'PARTIAL_RESULT', message: '部分读取未完成，请查看 errors 或 message' } } : {}) }) + '\n'); }
        finally { active--; lastUsed = Date.now(); }
      } catch (error) { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: { code: error.code || 'COMMAND_FAILED', message: safeLog(error.message), details: error.details }, exitCode: error.exitCode || 1 }) + '\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath(directory), resolve); });
  server.on('error', () => {});
  fs.writeFileSync(channelFile(directory), JSON.stringify({ token }), { mode: 0o600 });
  return { get active() { return active; }, get lastUsed() { return lastUsed; }, close() { if (closing) return; closing = true; for (const socket of sockets) socket.destroy(); server.close(); try { if (JSON.parse(fs.readFileSync(channelFile(directory), 'utf8')).token === token) fs.unlinkSync(channelFile(directory)); } catch {} } };
}
