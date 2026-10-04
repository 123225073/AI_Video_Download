import os from 'node:os';

export function concurrencySetting(value) {
  if (value === 'auto') return 'auto';
  return Math.max(1, Math.min(99, Math.floor(Number(value) || 2)));
}
export function resourceBudget(settings, metrics, processing = 0) {
  const requested = concurrencySetting(settings.concurrency);
  const upper = requested === 'auto' ? 99 : requested;
  const memory = Math.max(0, Math.floor((metrics.freeMemory - 512 * 1024 ** 2) / (256 * 1024 ** 2)));
  const cpu = Math.max(1, Math.min(99, metrics.cores * 2));
  let limit = Math.min(upper, memory, cpu, requested === 'auto' ? 16 : 99);
  let reason = '按机器资源和平台限制调度';
  if (memory === 0) { limit = 0; reason = '可用内存不足，等待释放资源'; }
  else if (metrics.cpuBusy > 0.9) { limit = Math.min(limit, 1); reason = '处理器繁忙，暂缓增加下载'; }
  else if (processing >= Math.max(1, Math.floor(metrics.cores / 2))) { limit = Math.min(limit, Math.max(1, Math.floor(metrics.cores / 2))); reason = '正在合并或校验视频，降低新任务并发'; }
  return { requested, upper, resourceLimit: limit, reason };
}
export function resourceSampler() {
  let previous, sampledAt = 0, value;
  return () => {
    if (value && Date.now() - sampledAt < 1000) return value;
    const cpus = os.cpus();
    const sums = cpus.reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
    const elapsed = previous ? sums.total - previous.total : 0;
    value = { cores: cpus.length || 1, freeMemory: os.freemem(), cpuBusy: elapsed > 0 ? 1 - (sums.idle - previous.idle) / elapsed : 0 };
    previous = sums; sampledAt = Date.now(); return value;
  };
}
