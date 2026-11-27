import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../electron/store.js';
import { Queue } from '../electron/queue.js';
import { mediaKey } from '../electron/core.js';

const directory = () => path.resolve('output', 'unit', randomUUID());
const item = n => ({ platform: 'YouTube', url: `https://www.youtube.com/watch?v=test${n}`, sourceId: `test${n}`, title: `测试 ${n}`, author: '测试作者', available: true });
const wait = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('等待测试条件超时'); await new Promise(r => setTimeout(r, 15)); } };
async function setup(download, concurrency = 2) { const dir = directory(); fs.mkdirSync(dir, { recursive: true }); const store = await Store.open(dir, { savePath: dir, quality: 'best', retries: 1, archive: 'flat', skipDuplicates: true, concurrency }); const engine = { download, accounts: { active: () => null, markExpired: () => {} } }; return { store, queue: new Queue(store, engine, () => {}, () => ({ freeMemory: 8 * 1024 ** 3, cores: 8, cpuBusy: 0 })), dir }; }

test('SQLite原子保存后重新打开保留设置与任务', async () => {
  const dir = directory(); let store = await Store.open(dir, { concurrency: 2 }); store.put('settings', 'main', { concurrency: 3 }); store.put('task', 'a', { id: 'a', status: 'queued' }); store.close();
  store = await Store.open(dir, { concurrency: 2 }); assert.equal(store.settings().concurrency, 3); assert.equal(store.get('task', 'a').status, 'queued'); store.close();
});
test('并发不超过设置，取消一个任务不会取消其他任务', async () => {
  const signals = new Map();
  const { queue, store } = await setup((task, dir, signal) => new Promise((resolve, reject) => { signals.set(task.id, signal); signal.addEventListener('abort', () => reject(new Error('CANCELLED'))); }));
  const { added } = queue.enqueue([item(1), item(2), item(3)]); await wait(() => signals.size === 2); assert.equal(queue.active.size, 2);
  await queue.action(added[0], 'cancel'); await wait(() => signals.size === 3); assert.equal(store.get('task', added[0]).status, 'cancelled'); assert.equal(signals.get(added[1]).aborted, false); assert.equal(queue.active.size, 2);
  await queue.close(); store.close();
});
test('重复任务与已存在的完整视频跳过，缺失文件可重新下载', async () => {
  const { queue, store, dir } = await setup((t, d, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('CANCELLED')))));
  const video = item(1), key = mediaKey(video), file = path.join(dir, 'existing.mp4'); fs.writeFileSync(file, 'fixture');
  store.put('media', key, { id: key, filePath: file }); assert.equal(queue.enqueue([video]).skipped.length, 1);
  store.put('media', key, { id: key, filePath: path.join(dir, 'missing.mp4') }); assert.equal(queue.enqueue([video]).added.length, 1); assert.equal(queue.enqueue([video]).skipped.length, 1);
  await queue.close(); store.close();
});
test('暂停后不会被迟到进度改回下载中，恢复后重新执行', async () => {
  let runs = 0, lastProgress;
  const { queue, store } = await setup((t, d, signal, progress) => new Promise((_, reject) => { runs++; lastProgress = progress; signal.addEventListener('abort', () => reject(new Error('CANCELLED'))); }));
  const id = queue.enqueue([item(1)]).added[0]; await wait(() => runs === 1); await queue.action(id, 'pause'); lastProgress({ status: 'downloading', bytes: 99 }); assert.equal(store.get('task', id).status, 'paused');
  await queue.action(id, 'resume'); await wait(() => runs === 2); assert.equal(store.get('task', id).status, 'downloading'); await queue.close(); store.close();
});
test('网络故障安排有限重试，登录失败不会盲目自动重试', async () => {
  const { queue, store } = await setup(async t => { throw new Error(t.item.sourceId === 'test1' ? 'ETIMEDOUT' : 'WECHAT_LOGIN_REQUIRED'); });
  const ids = queue.enqueue([item(1), item(2)]).added; await wait(() => queue.active.size === 0);
  assert.equal(store.get('task', ids[0]).status, 'retry-wait'); assert.equal(store.get('task', ids[1]).status, 'failed');
  store.put('task', ids[0], { ...store.get('task', ids[0]), retryAt: 0 }); queue.pump(); await wait(() => store.get('task', ids[0]).attempts === 2 && queue.active.size === 0); assert.equal(store.get('task', ids[0]).status, 'failed'); await queue.close(); store.close();
});
test('重启将中断任务恢复为待用户继续，不假装完成', async () => {
  const { queue, store } = await setup(async () => {}); store.put('task', 'crashed', { id: 'crashed', status: 'processing', item: item(1), createdAt: Date.now() }); await queue.close();
  const recovered = new Queue(store, {}, () => {}); assert.equal(store.get('task', 'crashed').status, 'paused'); assert.equal(store.get('task', 'crashed').interrupted, true); await recovered.close(); store.close();
});

test('排队期间文件恢复后复用媒体，同时保存CLI需要的大小时长和画质', async () => {
  let calls=0;const {queue,store,dir}=await setup(async()=>{calls++;throw Error('不应重新下载');});
  queue.closing=true;const video=item(77),key=mediaKey(video),file=path.join(dir,'restored.mp4');
  store.put('media',key,{id:key,filePath:file,size:7,duration:42,height:1080});
  const id=queue.enqueue([video]).added[0];fs.writeFileSync(file,'fixture');queue.closing=false;queue.pump();await wait(()=>queue.active.size===0);
  const task=store.get('task',id);assert.equal(task.status,'completed');assert.equal(task.size,7);assert.equal(task.duration,42);assert.equal(task.height,1080);assert.equal(calls,0);
  await queue.close();store.close();
});

test('零字节、变短的文件与目录不能复用，重新下载时保留原路径', async t => {
  const downloads = [];
  const { queue, store, dir } = await setup(async task => {
    downloads.push(task);
    const filePath = path.join(dir, task.id + '.mp4');
    fs.writeFileSync(filePath, 'new');
    return { filePath, size: 3 };
  });
  t.after(async () => { await queue.close(); store.close(); });
  for (const [index, original] of ['', 'cut', null].entries()) {
    const video = item(index), key = mediaKey(video), filePath = path.join(dir, 'old' + index + '.mp4');
    if (original === null) fs.mkdirSync(filePath);
    else fs.writeFileSync(filePath, original);
    store.put('media', key, { id: key, filePath, size: 99 });
    const result = queue.enqueue([video]);
    assert.equal(result.added.length, 1);
    await wait(() => store.get('task', result.added[0]).status === 'completed');
    assert.equal(downloads[index].options.force, true);
    assert.notEqual(store.get('media', key).filePath, filePath);
    if (original === null) assert.ok(fs.statSync(filePath).isDirectory());
    else assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  }
});

test('重试旧任务时，不与已重新加入的同一作品并行写入文件', async t => {
  const { queue, store } = await setup((_task, _dir, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Error('CANCELLED')), { once: true });
  }));
  t.after(async () => { await queue.close(); store.close(); });
  const video = item(7);
  const first = queue.enqueue([video]).added[0];
  await queue.action(first, 'cancel');
  const second = queue.enqueue([video]).added[0];
  await queue.action(first, 'retry');
  assert.equal(queue.active.size, 1);
  assert.ok(queue.active.has(second));
  assert.equal(store.get('task', first).status, 'queued');
});
