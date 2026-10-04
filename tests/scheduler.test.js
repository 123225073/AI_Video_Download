import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resourceBudget, concurrencySetting } from '../electron/scheduler.js';
import { Store } from '../electron/store.js';
import { Queue } from '../electron/queue.js';
import { enqueueInChunks } from '../src/batch.js';
const GiB = 1024 ** 3;
const item = n => ({ platform: 'YouTube', sourceId: `large${n}`, title: `大批量 ${n}`, author: '测试', available: true, url: `https://www.youtube.com/watch?v=large${n}` });
test('自动与1—99上限按资源计算，内存不足暂停新任务，处理器繁忙降到1', () => {
  assert.equal(concurrencySetting(999), 99); assert.equal(concurrencySetting('auto'), 'auto');
  assert.equal(resourceBudget({ concurrency: 99 }, { freeMemory: 1.5 * GiB, cores: 8, cpuBusy: 0 }).resourceLimit, 4);
  assert.equal(resourceBudget({ concurrency: 99 }, { freeMemory: 16 * GiB, cores: 8, cpuBusy: 0.95 }).resourceLimit, 1);
  assert.equal(resourceBudget({ concurrency: 'auto' }, { freeMemory: 0.4 * GiB, cores: 8, cpuBusy: 0 }).resourceLimit, 0);
  assert.equal(resourceBudget({ concurrency: 'auto' }, { freeMemory: 32 * GiB, cores: 32, cpuBusy: 0 }).resourceLimit, 16);
});
test('99上限的500个任务实际4个运行，其余自动排队', async () => {
  const dir = path.resolve('output', 'unit', randomUUID());
  const store = await Store.open(dir, { concurrency: 99, retries: 1, savePath: dir, archive: 'flat' });
  const engine = { download: (t, d, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('CANCELLED')))) };
  const queue = new Queue(store, engine, () => {}, () => ({ freeMemory: 1.5 * GiB, cores: 8, cpuBusy: 0 }));
  const r = queue.enqueue(Array.from({ length: 500 }, (_, i) => item(i)));
  assert.equal(r.added.length, 500); assert.equal(queue.active.size, 4); assert.equal(queue.scheduler().waiting, 496);
  await queue.close(); store.close();
});
test('总队列超过1000条仍可持久化，先校验再提交，恢复时保留所有等待任务', async () => {
  const dir = path.resolve('output', 'unit', randomUUID()); const store = await Store.open(dir, { concurrency: 99 });
  const queue = new Queue(store, { download: () => { throw new Error('不应启动'); } }, () => {}, () => ({ freeMemory: 0, cores: 8, cpuBusy: 0 }));
  queue.enqueue(Array.from({ length: 1000 }, (_, i) => item(i))); queue.enqueue(Array.from({ length: 150 }, (_, i) => item(i + 1000)));
  assert.equal(queue.tasks().length, 1150); assert.equal(queue.scheduler().waiting, 1150); assert.equal(queue.active.size, 0);
  assert.throws(() => queue.enqueue([item(2000), { ...item(2001), url: 'https://invalid.example/file' }])); assert.equal(queue.tasks().length, 1150);
  await queue.close(); store.close(); const reopened = await Store.open(dir, {}); assert.equal(reopened.list('task').length, 1150); reopened.close();
});
test('分批提交中断报告已加入数量，重试可以依据去重恢复', async () => {
  let calls = 0;
  const r = await enqueueInChunks(async (name, items) => { calls++; if (calls === 3) throw new Error('提交中断'); return { added: items.map(i => i.sourceId), skipped: [] }; }, Array.from({ length: 501 }, (_, i) => item(i)), {});
  assert.equal(r.added.length, 400); assert.equal(r.submitted, 400); assert.equal(r.error, '提交中断');
});
