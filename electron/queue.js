import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { archiveDirectory, classifyError, safeLog, validSource, mediaKey } from './core.js';
import { resourceBudget, resourceSampler } from './scheduler.js';

export class Queue {
  constructor(store, engine, changed, metrics = resourceSampler()) {
    this.store = store; this.engine = engine; this.changed = changed; this.active = new Map(); this.closing = false;
    this.metrics = metrics; this.platformState = new Map(); this.schedule = {};
    for (const t of store.list('task')) if (['downloading', 'processing'].includes(t.status)) this.save({ ...t, status: 'paused', message: '上次程序意外退出，请继续下载；是否续传取决于来源', interrupted: true });
    this.timer = setInterval(() => this.pump(), 1000); this.timer.unref();
  }
  tasks() { return this.store.list('task').sort((a, b) => b.createdAt - a.createdAt); }
  media() { return this.store.list('media').sort((a, b) => b.downloadedAt - a.downloadedAt); }
  save(t) { this.store.put('task', t.id, t); this.changed(); }
  enqueue(items, options = {}) {
    if (!Array.isArray(items) || !items.length || items.length > 1000) throw new Error('每次提交 1–1000 条视频，大批量请分批加入；总队列数量不限');
    const settings = this.store.settings(); const added = [], skipped = [];
    const pendingKeys = new Set(this.tasks().filter(t => !['completed', 'cancelled', 'failed'].includes(t.status)).map(t => t.item.key));
    // Validate the entire bounded IPC batch before writing any task.
    for (const raw of items) validSource(raw.url);
    for (const raw of items) {
      validSource(raw.url);
      const item = { ...raw, key: mediaKey(raw), accountId: this.engine.accounts?.active(raw.platform)?.id || null };
      if (item.available === false) { skipped.push({ title: item.title, reason: '条目不可用' }); continue; }
      const existing = this.store.get('media', item.key);
      const pending = pendingKeys.has(item.key);
      if (pending || (!options.force && settings.skipDuplicates && existing && fs.existsSync(existing.filePath))) { skipped.push({ title: item.title, reason: pending ? '已在任务队列中' : '文件已在媒体库中' }); continue; }
      const task = { id: randomUUID(), item, options: { savePath: options.savePath || settings.savePath, quality: options.quality || settings.quality, archive: options.archive || settings.archive, retries: settings.retries, force: Boolean(options.force) }, status: 'queued', attempts: 0, createdAt: Date.now(), progress: {}, logs: '', message: '等待空闲下载位置' };
      this.save(task); added.push(task.id);
      pendingKeys.add(item.key);
    }
    this.store.flush(); this.pump(); return { added, skipped };
  }
  pump() {
    if (this.closing) return;
    const tasks = this.tasks(), now = Date.now();
    const budget = resourceBudget(this.store.settings(), this.metrics(), tasks.filter(t => t.status === 'processing').length);
    const counts = new Map();
    for (const t of tasks) if (this.active.has(t.id)) counts.set(t.item.platform, (counts.get(t.item.platform) || 0) + 1);
    const waiting = tasks.filter(t => t.status === 'queued' || (t.status === 'retry-wait' && t.retryAt <= now)).sort((a, b) => a.createdAt - b.createdAt);
    const caps = { '视频号': 2, '抖音': 2, '小红书': 2, 'B站': 3, YouTube: 4 };
    for (const task of waiting) {
      if (this.active.size >= budget.resourceLimit) break;
      const p = task.item.platform; let state = this.platformState.get(p);
      if (state && state.until <= now) { this.platformState.delete(p); state = null; }
      if (state?.until > now || (counts.get(p) || 0) >= (state?.cap || caps[p] || 4)) continue;
      counts.set(p, (counts.get(p) || 0) + 1); void this.run(task);
    }
    const next = { ...budget, active: this.active.size, waiting: tasks.filter(t => !this.active.has(t.id) && ['queued', 'retry-wait'].includes(t.status)).length, cooldowns: [...this.platformState.entries()].filter(([, s]) => s.until > now).map(([platform, s]) => ({ platform, until: s.until })) };
    if (JSON.stringify(next) !== JSON.stringify(this.schedule)) { this.schedule = next; this.changed(); }
  }
  scheduler() { return this.schedule; }
  async removeRecords(kind,ids) {
    if(!['task','media'].includes(kind)||!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string'||!id||id.length>200))throw Error('请选择有效的任务或媒体记录，每批最多1000条');
    const unique=[...new Set(ids)],records=unique.map(id=>this.store.get(kind,id)).filter(Boolean);
    if(kind==='media'&&records.some(m=>this.tasks().some(t=>t.item.key===m.id&&(this.active.has(t.id)||['queued','retry-wait'].includes(t.status)))))throw Error('所选视频仍有下载任务，请先暂停或取消对应任务，再删除媒体记录');
    // Mark the entire selection before awaiting aborts, so the pump cannot
    // start another selected queued task between two removals.
    const pending=[];
    if(kind==='task')for(const task of records){const run=this.active.get(task.id);if(run){run.controller.abort();pending.push(run.promise);}if(!['completed','cancelled'].includes(task.status))this.save({...task,status:'cancelled',message:'已停止，准备删除任务记录'});}
    await Promise.all(pending);
    for(const record of records)this.store.remove(kind,record.id);
    this.store.flush();this.changed();this.pump();return {kind,removed:records.length,missing:unique.length-records.length,filesDeleted:0};
  }
  async run(task) {
    const controller = new AbortController();
    const run = { controller, promise: null }; this.active.set(task.id, run);
    task = { ...task, status: 'downloading', attempts: task.attempts + 1, message: '正在下载', error: null, retryAt: null };
    this.save(task);
    run.promise = (async () => {
      try {
        const existing = this.store.get('media', task.item.key);
        if (!task.options.force && this.store.settings().skipDuplicates && existing && fs.existsSync(existing.filePath)) {
          const size = fs.statSync(existing.filePath).size;
          this.save({ ...task, status: 'completed', filePath: existing.filePath, size, duration: existing.duration ?? task.item.duration, height: existing.height ?? task.item.height, progress: { bytes: size, total: size }, message: '复用已有完整文件', completedAt: Date.now() });
          this.store.flush(); return;
        }
        let last = 0;
        const output = await this.engine.download(task, archiveDirectory(task.options, task.item), controller.signal, p => {
          if (controller.signal.aborted) return;
          if (Date.now() - last < 300 && p.status !== 'processing') return;
          last = Date.now(); task = { ...task, status: p.status || task.status, progress: { ...task.progress, ...p }, message: p.status === 'processing' ? '下载完成，正在合并或校验媒体' : '正在下载' }; this.save(task);
        });
        if (controller.signal.aborted) return;
        const media = { ...task.item, ...output, id: task.item.key, downloadedAt: Date.now(), quality: task.options.quality, tags: existing?.tags || [] };
        this.store.put('media', media.id, media);
        this.save({ ...task, ...output, status: 'completed', completedAt: Date.now(), progress: { bytes: output.size, total: output.size }, message: '已保存并通过媒体校验' });
        this.store.flush();
      } catch (error) {
        if (controller.signal.aborted) return;
        const classified = classifyError(error.message);
        if (classified.category === 'rate-limit') this.platformState.set(task.item.platform, { cap: 1, until: Date.now() + 60_000 * Math.min(5, task.attempts) });
        else if (classified.category === 'network') this.platformState.set(task.item.platform, { cap: 1, until: Date.now() + 3000 });
        if (classified.category === 'auth') this.engine.accounts?.markExpired(task.item.platform, task.item.accountId);
        const retry = classified.retryable && task.attempts <= task.options.retries;
        const backoff = classified.category === 'rate-limit' ? 60_000 * task.attempts : Math.min(60_000, 3000 * 2 ** (task.attempts - 1));
        this.save({ ...task, status: retry ? 'retry-wait' : 'failed', error: classified, message: classified.message, retryAt: retry ? Date.now() + backoff : null, logs: safeLog(error.message) });
      } finally { this.active.delete(task.id); queueMicrotask(() => this.pump()); }
    })();
    await run.promise;
  }
  async action(id, action) {
    const task = this.store.get('task', id); if (!task) throw new Error('任务不存在');
    const run = this.active.get(id);
    if (action === 'pause' || action === 'cancel') {
      if (task.status === 'completed') return;
      run?.controller.abort();
      this.save({ ...task, status: action === 'pause' ? 'paused' : 'cancelled', message: action === 'pause' ? (task.item.platform === '视频号' ? '已暂停；继续时将重新下载' : '已暂停；继续时尝试复用下载片段') : '已取消，已完成的视频文件保留' });
      if (run) await run.promise;
    } else if (action === 'resume' || action === 'retry') {
      if (run || task.status === 'completed') return;
      this.save({ ...task, item: { ...task.item, accountId: this.engine.accounts?.active(task.item.platform)?.id || null }, status: 'queued', attempts: 0, retryAt: null, message: '等待下载', error: null });
    } else throw new Error('未知任务操作');
    this.store.flush(); this.pump();
  }
  async close() { this.closing = true; clearInterval(this.timer); await Promise.all([...this.active.keys()].map(id => this.action(id, 'pause'))); this.store.flush(); }
}
